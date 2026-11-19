import asyncio
import json
import math
import re
import sys
from abc import ABC, abstractmethod
from array import array
from collections.abc import AsyncIterator
from dataclasses import dataclass
from itertools import groupby

from websockets.exceptions import ConnectionClosed, ConnectionClosedOK, InvalidStatusCode, WebSocketException
from websockets.legacy.client import Connect, WebSocketClientProtocol

from ...errors import AppError
from ...schemas import Language, SpeakerMode
from ..http import UpstreamRejected, endpoint, invalid_response

SAMPLE_RATE = 16_000
BYTES_PER_MS = SAMPLE_RATE * 2 // 1000


def pcm_samples(pcm: bytes) -> array:
    samples = array("h", pcm)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def pcm_has_speech(pcm: bytes) -> bool:
    samples = pcm_samples(pcm)
    return bool(samples and sum(abs(sample) for sample in samples) >= len(samples) * 150)


@dataclass(frozen=True)
class Recognition:
    language: Language
    diarization: bool
    speaker_mode: SpeakerMode
    vad: bool
    hotwords: tuple[str, ...] = ()


@dataclass(frozen=True)
class Transcript:
    text: str
    final: bool
    speaker: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


class ASRStreamAdapter(ABC):
    supports_diarization = False

    @abstractmethod
    async def start(self):
        ...

    @abstractmethod
    async def send_audio(self, pcm: bytes):
        ...

    @abstractmethod
    async def finish(self):
        ...

    @abstractmethod
    def results(self) -> AsyncIterator[Transcript]:
        ...

    @abstractmethod
    async def close(self):
        ...


class DirectConnect(Connect):
    def handle_redirect(self, uri: str):
        # Preserve the credential boundary between the configured host and any redirect destination.
        raise AppError(502, "ASR_REDIRECT", "供应商返回重定向，请填写最终 WebSocket 地址")


def asr_error(code: object = "", message: object = "") -> AppError:
    description = f"{code} {message}".lower()
    if any(word in description for word in ("auth", "api key", "api_key", "permission", "401", "403", "鉴权")):
        return UpstreamRejected(401)
    if any(word in description for word in ("rate_limit", "too many", "429", "quota", "限流")):
        return UpstreamRejected(429)
    code_text = str(code)
    suffix = f"（{code_text}）" if re.fullmatch(r"[A-Za-z0-9_-]{1,48}", code_text) else ""
    return AppError(502, "ASR_UPSTREAM_ERROR", f"语音供应商返回错误{suffix}，请检查模型与服务配置")


def as_ms(value: object, *, seconds: bool = False) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0 or number > 2_147_483_647:
        return None
    return round(number * (1000 if seconds else 1))


def speaker_id(value: object) -> str | None:
    if isinstance(value, (int, str)) and str(value) and str(value).lower() not in {"unknown", "none"}:
        return str(value)
    return None


def decode_json(message: str | bytes) -> dict:
    try:
        document = json.loads(message)
        if isinstance(document, dict):
            return document
    except (UnicodeError, ValueError, TypeError):
        pass
    raise invalid_response()


def join_transcript(left: str, right: str) -> str:
    separator = (
        " " if left and right and left[-1].isascii() and right[0].isascii()
        and (left[-1].isalnum() or left[-1] in ",.!?:;") and right[0].isalnum()
        else ""
    )
    return left + separator + right


def split_speakers(
    full: Transcript, words: list[Transcript], *, word_spacing: bool = True,
) -> list[Transcript]:
    if not words:
        return [full]
    result = []
    for speaker, consecutive in groupby(words, key=lambda word: word.speaker or full.speaker):
        group = list(consecutive)
        text = ""
        for word in group:
            text = (
                join_transcript(text, word.text) if word_spacing else text + word.text
            )
        if text.strip():
            result.append(Transcript(text.strip(), full.final, speaker, group[0].start_ms, group[-1].end_ms))
    if len(result) == 1:
        return [Transcript(full.text, full.final, result[0].speaker, full.start_ms, full.end_ms)]
    return result or [full]


class SocketASR(ASRStreamAdapter):
    def __init__(self):
        self.socket: WebSocketClientProtocol | None = None
        self.finishing = False

    async def open(self, url: str, headers: dict[str, str] | None = None):
        url = endpoint(url, {"ws", "wss"})
        try:
            self.socket = await DirectConnect(
                url, extra_headers=headers, open_timeout=8, close_timeout=1, max_size=2**20,
                max_queue=32, ping_interval=20, ping_timeout=15,
            )
        except InvalidStatusCode as error:
            raise UpstreamRejected(error.status_code) from None
        except TimeoutError:
            raise AppError(502, "ASR_TIMEOUT", "语音供应商连接超时") from None
        except (OSError, WebSocketException, ValueError):
            raise AppError(502, "ASR_UNREACHABLE", "无法连接语音供应商") from None

    async def send(self, message: str | bytes):
        try:
            async with asyncio.timeout(5):
                await self.socket.send(message)
        except (ConnectionClosed, OSError, TimeoutError):
            raise AppError(502, "ASR_STREAM_INTERRUPTED", "语音供应商连接已中断") from None

    async def send_json(self, message: dict):
        await self.send(json.dumps(message, separators=(",", ":"), ensure_ascii=False))

    async def send_audio(self, pcm: bytes):
        await self.send(pcm)

    async def ready(self, predicate, check_error):
        try:
            async with asyncio.timeout(8):
                async for event in self.json_events():
                    check_error(event)
                    if predicate(event):
                        return
        except TimeoutError:
            raise AppError(502, "ASR_TIMEOUT", "语音供应商初始化超时") from None
        raise asr_error()

    async def frames(self) -> AsyncIterator[str | bytes]:
        try:
            while True:
                yield await self.socket.recv()
        except ConnectionClosedOK:
            if not self.finishing:
                raise AppError(502, "ASR_STREAM_INTERRUPTED", "语音供应商提前关闭连接") from None
        except (ConnectionClosed, OSError):
            raise AppError(502, "ASR_STREAM_INTERRUPTED", "语音供应商连接已中断") from None

    async def json_events(self) -> AsyncIterator[dict]:
        async for frame in self.frames():
            yield decode_json(frame)

    async def close(self):
        if self.socket is not None:
            await self.socket.close()
            self.socket = None
