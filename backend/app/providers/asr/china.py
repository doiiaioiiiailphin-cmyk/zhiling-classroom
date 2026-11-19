import asyncio
import base64
import gzip
import hashlib
import hmac
import io
import json
import secrets
import struct
import time
from collections.abc import AsyncIterator
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from ...errors import AppError
from ..http import UpstreamRejected, invalid_response, require_key, route, with_params
from .base import Recognition, SocketASR, Transcript, as_ms, asr_error, decode_json, speaker_id, split_speakers


class IFlytek(SocketASR):
    def __init__(self, url: str, key: str, app_id: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.app_id, self.recognition = url, key, app_id, recognition
        self.supports_diarization = model != "rtasr-standard-v1"
        self.role: str | None = None
        self.audio_buffer = bytearray()
        self.next_packet_at = 0.0

    @staticmethod
    def check_error(event: dict):
        code = str(event.get("code", "0"))
        if code in {"10105", "10110", "10119"}:
            raise UpstreamRejected(401)
        if code != "0" or event.get("action") == "error":
            raise asr_error(code, event.get("desc"))

    async def start(self):
        timestamp = int(time.time())
        digest = hashlib.md5(f"{self.app_id}{timestamp}".encode(), usedforsecurity=False).hexdigest()
        signature = base64.b64encode(hmac.digest(self.key.encode(), digest.encode(), "sha1")).decode("ascii")
        settings = self.recognition
        params = {"appid": self.app_id, "ts": timestamp, "signa": signature}
        params["lang"] = "en" if settings.language == "en" else "cn"
        if settings.language == "zh":
            params["engLangType"] = 4
        if settings.diarization and self.supports_diarization:
            params["roleType"] = 2
        await self.open(with_params(self.url, params))
        await self.ready(lambda event: event.get("action") == "started", self.check_error)

    async def send_audio(self, pcm: bytes):
        self.audio_buffer.extend(pcm)
        while len(self.audio_buffer) >= 1280:
            loop = asyncio.get_running_loop()
            await asyncio.sleep(max(0, self.next_packet_at - loop.time()))
            await self.send(bytes(self.audio_buffer[:1280]))
            del self.audio_buffer[:1280]
            self.next_packet_at = loop.time() + 0.04

    async def finish(self):
        self.finishing = True
        if self.audio_buffer:
            await self.send(bytes(self.audio_buffer))
            self.audio_buffer.clear()
        await self.send(b'{"end":true}')

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            if event.get("action") != "result" or not event.get("data"):
                continue
            document = decode_json(event["data"]) if isinstance(event["data"], str) else event["data"]
            st = document.get("cn", {}).get("st", {})
            final = str(st.get("type")) == "0"
            start, end = as_ms(st.get("bg")), as_ms(st.get("ed"))
            role = self.role
            words = []
            if str(st.get("rl", "0")) != "0":
                role = speaker_id(st.get("rl")) or role
            for result in st.get("rt", []):
                for word in result.get("ws", []):
                    cw = (word.get("cw") or [{}])[0]
                    source = cw.get("rl", word.get("rl", "0"))
                    if str(source) != "0":
                        role = speaker_id(source) or role
                    word_start, word_end = as_ms(word.get("wb")), as_ms(word.get("we"))
                    words.append(Transcript(
                        cw.get("w", ""), final, role,
                        start + 10 * word_start if start is not None and word_start is not None else None,
                        start + 10 * word_end if start is not None and word_end is not None else None,
                    ))
            text = "".join(word.text for word in words)
            if final:
                self.role = role
            if text.strip():
                full = Transcript(text, final, role, start, end)
                for item in (split_speakers(full, words, word_spacing=False) if final else [full]):
                    yield item
            if document.get("ls") is True and self.finishing:
                return


TENCENT_ALIASES = {"16k_zh_large_diarize": "16k_zh_en", "16k_zh-PY_edu": "16k_zh_edu"}


class Tencent(SocketASR):
    def __init__(self, url: str, key: str, app_id: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.app_id, self.recognition = url, app_id, recognition
        secret_id, colon, secret_key = key.partition(":")
        if not colon or not secret_id or not secret_key:
            raise AppError(400, "PROVIDER_NOT_CONFIGURED", "腾讯云 API 密钥请填写 SecretId:SecretKey")
        self.secret_id, self.secret_key = require_key(secret_id), require_key(secret_key)
        self.engine = TENCENT_ALIASES.get(model, model)

    @staticmethod
    def check_error(event: dict):
        code = str(event.get("code", "0"))
        if code in {"4002", "4003"}:
            raise UpstreamRejected(401)
        if code == "4006":
            raise UpstreamRejected(429)
        if code != "0":
            raise asr_error(code, event.get("message"))

    async def start(self):
        url = self.url
        if not urlsplit(url).path.rstrip("/").endswith(f"/{self.app_id}"):
            url = route(url, quote(self.app_id, safe=""))
        origin = urlsplit(url)
        if origin.query:
            raise AppError(400, "INVALID_PROVIDER_URL", "腾讯云 WebSocket 地址应填写到 /asr/v2")
        timestamp = int(time.time())
        params = {
            "secretid": self.secret_id, "timestamp": timestamp, "expired": timestamp + 3600,
            "engine_model_type": self.engine, "voice_id": uuid4().hex, "voice_format": 1,
            "nonce": secrets.randbelow(1_000_000_000) + 1, "needvad": int(self.recognition.vad),
        }
        query = urlencode(sorted(params.items()))
        canonical = f"{origin.netloc}{origin.path}?{query}"
        signature = base64.b64encode(hmac.digest(self.secret_key.encode(), canonical.encode(), "sha1")).decode("ascii")
        await self.open(urlunsplit(origin._replace(query=f"{query}&signature={quote(signature, safe='')}")))
        await self.ready(lambda event: str(event.get("code")) == "0", self.check_error)

    async def finish(self):
        self.finishing = True
        await self.send_json({"type": "end"})

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            result = event.get("result") or {}
            if result.get("voice_text_str"):
                yield Transcript(
                    result["voice_text_str"], str(result.get("slice_type")) == "2",
                    speaker_id(result.get("speaker_id")), as_ms(result.get("start_time")), as_ms(result.get("end_time")),
                )
            if event.get("final"):
                return


VOLCENGINE_ALIASES = {
    "bigmodel-sauc-diarize-v3": "volc.seedasr.sauc.duration",
    "bigmodel-streaming-asr": "volc.bigasr.sauc.duration",
}


def volc_frame(kind: int, flags: int, serialization: int, content: bytes) -> bytes:
    payload = gzip.compress(content)
    return bytes((0x11, (kind << 4) | flags, (serialization << 4) | 1, 0)) + struct.pack(">I", len(payload)) + payload


def volc_event(message: str | bytes) -> tuple[dict, bool]:
    if isinstance(message, str):
        result = decode_json(message)
        if "code" in result:
            raise asr_error(result["code"], result.get("message"))
        raise invalid_response()
    if len(message) < 8 or message[0] >> 4 != 1:
        raise invalid_response()
    kind, flags = message[1] >> 4, message[1] & 15
    header_size = (message[0] & 15) * 4
    index = header_size + (4 if flags & 1 else 0)
    if kind == 15 and len(message) >= header_size + 4:
        raise asr_error(struct.unpack_from(">I", message, header_size)[0])
    if kind != 9 or header_size < 4 or len(message) < index + 4:
        raise invalid_response()
    length = struct.unpack_from(">I", message, index)[0]
    data = message[index + 4:]
    if len(data) != length:
        raise invalid_response()
    if message[2] & 15 == 1:
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
                data = stream.read(2**21 + 1)
            if len(data) > 2**21:
                raise invalid_response()
        except (OSError, EOFError):
            raise invalid_response() from None
    return decode_json(data), bool(flags & 2)


class Volcengine(SocketASR):
    def __init__(self, url: str, key: str, app_id: str | None, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.app_id, self.recognition = url, key, app_id, recognition
        self.resource = VOLCENGINE_ALIASES.get(model, model)
        self.supports_diarization = recognition.language != "en"
        self.last_end = -1

    async def start(self):
        settings = self.recognition
        url = urlsplit(self.url)
        path = url.path.rstrip("/")
        if path.endswith("/bigmodel") or (path.endswith("/bigmodel_nostream") and settings.language != "en"):
            path = path.rsplit("/", 1)[0] + ("/bigmodel_nostream" if settings.language == "en" else "/bigmodel_async")
        optimized = not path.endswith("_nostream")
        request_id = str(uuid4())
        headers = {
            "X-Api-Resource-Id": require_key(self.resource), "X-Api-Connect-Id": request_id,
            "X-Api-Request-Id": request_id, "X-Api-Sequence": "-1",
        }
        if self.app_id:
            headers.update({"X-Api-App-Key": self.app_id, "X-Api-Access-Key": self.key})
        else:
            headers["X-Api-Key"] = self.key
        await self.open(urlunsplit(url._replace(path=path)), headers)
        audio = {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1}
        if not optimized and settings.language in {"en", "zh"}:
            audio["language"] = "en-US" if settings.language == "en" else "zh-CN"
        request = {"model_name": "bigmodel", "show_utterances": True}
        if optimized:
            request["enable_nonstream"] = True
        if settings.diarization and self.supports_diarization:
            request["enable_speaker_info"] = True
            if self.resource.startswith("volc.seedasr"):
                request["ssd_version"] = "200"
        payload = {"user": {"uid": "zhiling-classroom"}, "audio": audio, "request": request}
        await self.send(volc_frame(1, 0, 1, json.dumps(payload).encode("utf-8")))
        try:
            async with asyncio.timeout(8):
                self.initial = volc_event(await self.socket.recv())
        except TimeoutError:
            raise AppError(502, "ASR_TIMEOUT", "豆包流式识别初始化超时") from None

    async def send_audio(self, pcm: bytes):
        await self.send(volc_frame(2, 0, 0, pcm))

    async def finish(self):
        self.finishing = True
        await self.send(volc_frame(2, 2, 0, b""))

    def transcripts(self, event: dict, done: bool) -> list[Transcript]:
        result = event.get("result") or {}
        utterances = result.get("utterances") or []
        items = []
        for row in utterances:
            start, end = as_ms(row.get("start_time")), as_ms(row.get("end_time"))
            final = row.get("definite") is True or done
            if final and end is not None:
                if end <= self.last_end:
                    continue
                self.last_end = end
            if row.get("text"):
                extra = row.get("additions", {})
                label = row.get("speaker_id")
                if label is None:
                    label = extra.get("speaker_id", extra.get("speaker"))
                items.append(Transcript(row["text"], final, speaker_id(label), start, end))
        if not utterances and result.get("text") and self.last_end < 0:
            items.append(Transcript(result["text"], done))
        return items

    async def results(self) -> AsyncIterator[Transcript]:
        for item in self.transcripts(*self.initial):
            yield item
        async for frame in self.frames():
            event, done = volc_event(frame)
            for item in self.transcripts(event, done):
                yield item
            if done:
                return
