import asyncio
import base64
import io
import sys
import wave
from array import array
from collections import deque
from collections.abc import AsyncIterator
from urllib.parse import urlsplit

import httpx

from ...errors import AppError
from ..http import UpstreamRejected, change_scheme, invalid_response, route, with_params
from .base import (
    BYTES_PER_MS, ASRStreamAdapter, Recognition, SocketASR, Transcript,
    as_ms, asr_error, decode_json, pcm_has_speech, pcm_samples,
)

DIARIZE_MODEL = "gpt-4o-transcribe-diarize"


def is_transcription_model(model: str) -> bool:
    return model == "whisper-1" or model.startswith("gpt-realtime-whisper") or (
        model.startswith("gpt-") and "transcribe" in model.split("-")
    )


def wav_bytes(pcm: bytes) -> bytes:
    file = io.BytesIO()
    with wave.open(file, "wb") as wav:
        wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)
    return file.getvalue()


class UpsampleTo24k:
    def __init__(self):
        self.position = 0
        self.next_output = 0
        self.previous = 0

    def convert(self, pcm: bytes) -> bytes:
        output = array("h")
        for sample in pcm_samples(pcm):
            while self.next_output <= self.position:
                back = self.position - self.next_output
                output.append((back * self.previous + (3 - back) * sample) // 3)
                self.next_output += 2
            self.previous = sample
            self.position += 3
        if sys.byteorder == "big":
            output.byteswap()
        return output.tobytes()


class SpeechWindow:
    def __init__(self, silence_ms: int):
        self.silence_ms = silence_ms
        self.bytes = 0
        self.quiet_bytes = 0
        self.has_voice = False

    def advance(self, pcm: bytes) -> bool:
        self.bytes += len(pcm)
        if pcm_has_speech(pcm):
            self.has_voice = True
            self.quiet_bytes = 0
        else:
            self.quiet_bytes += len(pcm)
        return self.quiet_bytes >= self.silence_ms * BYTES_PER_MS

    def clear(self):
        self.bytes = self.quiet_bytes = 0
        self.has_voice = False


class OpenAIRealtime(SocketASR):
    def __init__(self, url: str, key: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model, self.recognition = url, key, model, recognition
        self.resampler = UpsampleTo24k()
        self.window = SpeechWindow(650 if recognition.vad else 1100)
        self.offset_bytes = 0
        self.commits: deque[tuple[int, int, int]] = deque()
        self.ranges: dict[str, tuple[int, int, int]] = {}
        self.deltas: dict[str, str] = {}
        self.completed: dict[int, Transcript] = {}
        self.commit_number = self.next_final = 0

    @staticmethod
    def check_error(event: dict):
        if event.get("type") in ("error", "conversation.item.input_audio_transcription.failed"):
            problem = event.get("error", {})
            raise asr_error(problem.get("code") or problem.get("type"), problem.get("message"))

    async def start(self):
        url = change_scheme(self.url, websocket=True)
        if not urlsplit(url).path.rstrip("/").endswith("/realtime"):
            url = route(url, "realtime")
        await self.open(with_params(url, {"intent": "transcription"}), {"Authorization": f"Bearer {self.key}"})
        transcription = {"model": self.model}
        if self.model == "gpt-live-transcribe":
            if self.recognition.language != "auto":
                transcription["languages"] = (
                    ["zh", "en"] if self.recognition.language == "zh-en" else [self.recognition.language]
                )
        elif self.recognition.language in ("zh", "en"):
            transcription["language"] = self.recognition.language
        if self.recognition.hotwords:
            transcription["prompt"] = "专业术语：" + "、".join(self.recognition.hotwords[:40])
        await self.send_json({
            "type": "session.update",
            "session": {"type": "transcription", "audio": {"input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": transcription, "turn_detection": None,
            }}},
        })
        await self.ready(
            lambda event: event.get("type") in ("session.updated", "transcription_session.updated"),
            self.check_error,
        )

    async def append(self, pcm: bytes):
        upsampled = self.resampler.convert(pcm)
        if upsampled:
            await self.send_json({
                "type": "input_audio_buffer.append", "audio": base64.b64encode(upsampled).decode("ascii"),
            })

    async def bind_turn(self, *, force: bool = False):
        size = self.window.bytes
        if not size:
            return
        if self.window.has_voice:
            minimum = 110 * BYTES_PER_MS
            if size < minimum and not force:
                return
            if size < minimum:
                await self.append(bytes(minimum - size))
            end = self.offset_bytes + size
            self.commits.append((self.commit_number, self.offset_bytes // BYTES_PER_MS, end // BYTES_PER_MS))
            self.commit_number += 1
            await self.send_json({"type": "input_audio_buffer.commit"})
        else:
            await self.send_json({"type": "input_audio_buffer.clear"})
        self.offset_bytes += size
        self.window.clear()

    async def send_audio(self, pcm: bytes):
        await self.append(pcm)
        quiet = self.window.advance(pcm)
        if (self.window.has_voice and quiet) or self.window.bytes >= 12_000 * BYTES_PER_MS or (
            not self.window.has_voice and self.window.bytes >= 1200 * BYTES_PER_MS
        ):
            await self.bind_turn()

    async def finish(self):
        await self.bind_turn(force=True)
        self.finishing = True
        if self.next_final == self.commit_number:
            await self.socket.close()

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            kind = event.get("type")
            item = event.get("item_id")
            if kind == "input_audio_buffer.committed" and self.commits:
                self.ranges[item] = self.commits.popleft()
            elif kind == "conversation.item.input_audio_transcription.delta" and item in self.ranges:
                self.deltas[item] = self.deltas.get(item, "") + event.get("delta", "")
                if self.ranges[item][0] == self.next_final:
                    yield Transcript(self.deltas[item], False)
            elif kind == "conversation.item.input_audio_transcription.completed" and item in self.ranges:
                number, start, end = self.ranges.pop(item)
                self.deltas.pop(item, None)
                self.completed[number] = Transcript(event.get("transcript", ""), True, None, start, end)
                while self.next_final in self.completed:
                    result = self.completed.pop(self.next_final)
                    self.next_final += 1
                    if result.text:
                        yield result
                if self.finishing and self.next_final == self.commit_number:
                    return


async def sse_messages(response: httpx.Response) -> AsyncIterator[dict]:
    lines = []
    async for line in response.aiter_lines():
        if line.startswith("data:"):
            lines.append(line[5:].lstrip(" "))
        elif not line and lines:
            data = "\n".join(lines)
            lines.clear()
            if data == "[DONE]":
                return
            yield decode_json(data)
    if lines and lines != ["[DONE]"]:
        yield decode_json("\n".join(lines))


class OpenAIDiarized(ASRStreamAdapter):
    supports_diarization = True

    def __init__(self, client: httpx.AsyncClient, url: str, key: str, recognition: Recognition):
        self.client, self.url, self.key, self.recognition = client, url, key, recognition
        self.window = SpeechWindow(800 if recognition.vad else 1400)
        self.buffer = bytearray()
        self.offset_bytes = 0
        self.windows: asyncio.Queue[tuple[int, bytes] | None] = asyncio.Queue(maxsize=6)
        self.references: dict[str, str] = {}

    async def start(self):
        # The first transcription window opens the HTTP stream.
        return

    def queue_window(self):
        if self.window.has_voice:
            try:
                self.windows.put_nowait((self.offset_bytes // BYTES_PER_MS, bytes(self.buffer)))
            except asyncio.QueueFull:
                raise AppError(502, "ASR_BACKPRESSURE", "语音供应商处理速度过慢") from None
        self.offset_bytes += len(self.buffer)
        self.buffer.clear()
        self.window.clear()

    async def send_audio(self, pcm: bytes):
        self.buffer.extend(pcm)
        quiet = self.window.advance(pcm)
        if len(self.buffer) >= BYTES_PER_MS * (3500 if quiet else 12000):
            self.queue_window()

    async def finish(self):
        self.queue_window()
        await self.windows.put(None)

    def map_speaker(
        self, label: str | None, pcm: bytes, offset_ms: int,
        start_ms: int | None, end_ms: int | None, local: dict[str, str],
    ) -> str | None:
        if not self.recognition.diarization or not label:
            return None
        if label in self.references:
            return label
        if label in local:
            return local[label]
        speaker = f"{offset_ms}:{label}"
        local[label] = speaker
        if start_ms is not None and end_ms is not None and len(self.references) < 4:
            clip = pcm[start_ms * BYTES_PER_MS:min(end_ms, start_ms + 8000) * BYTES_PER_MS]
            if len(clip) >= 2000 * BYTES_PER_MS:
                self.references[speaker] = "data:audio/wav;base64," + base64.b64encode(wav_bytes(clip)).decode("ascii")
        return speaker

    async def transcribe(self, offset_ms: int, pcm: bytes) -> AsyncIterator[Transcript]:
        form = {"model": DIARIZE_MODEL, "response_format": "diarized_json", "chunking_strategy": "auto", "stream": "true"}
        if self.recognition.language in ("zh", "en"):
            form["language"] = self.recognition.language
        if self.references:
            form["known_speaker_names[]"] = list(self.references)
            form["known_speaker_references[]"] = list(self.references.values())
        partials: dict[str, str] = {}
        seen: set[str] = set()
        local: dict[str, str] = {}
        try:
            async with self.client.stream(
                "POST", route(self.url, "audio/transcriptions"), headers={"Authorization": f"Bearer {self.key}"},
                data=form, files={"file": ("speech.wav", wav_bytes(pcm), "audio/wav")},
            ) as response:
                if not response.is_success:
                    raise UpstreamRejected(response.status_code)
                async for event in sse_messages(response):
                    kind = event.get("type")
                    segment = event.get("segment") or event
                    ident = segment.get("id") or event.get("segment_id")
                    if kind == "error":
                        error = event.get("error", {})
                        raise asr_error(error.get("code"), error.get("message"))
                    if kind == "transcript.text.delta":
                        partials[ident] = partials.get(ident, "") + event.get("delta", "")
                        if partials[ident]:
                            yield Transcript(partials[ident], False)
                    elif kind in ("transcript.text.segment", "transcript.text.done"):
                        entries = event.get("segments", []) if kind.endswith(".done") else [segment]
                        for row in entries:
                            row_id = row.get("id") or ident
                            if row_id is not None and row_id in seen:
                                continue
                            if row_id is not None:
                                seen.add(row_id)
                            start = as_ms(row.get("start"), seconds=True)
                            end = as_ms(row.get("end"), seconds=True)
                            label = self.map_speaker(row.get("speaker"), pcm, offset_ms, start, end, local)
                            if row.get("text"):
                                yield Transcript(
                                    row["text"], True, label, offset_ms + (start or 0),
                                    offset_ms + (end if end is not None else len(pcm) // BYTES_PER_MS),
                                )
                        if kind.endswith(".done"):
                            if not entries and not seen and event.get("text"):
                                yield Transcript(
                                    event["text"], True, None, offset_ms, offset_ms + len(pcm) // BYTES_PER_MS,
                                )
                            return
        except httpx.TimeoutException:
            raise AppError(502, "ASR_TIMEOUT", "OpenAI 语音转写响应超时") from None
        except httpx.HTTPError:
            raise AppError(502, "ASR_STREAM_INTERRUPTED", "OpenAI 语音转写连接已中断") from None
        raise invalid_response()

    async def results(self) -> AsyncIterator[Transcript]:
        while (window := await self.windows.get()) is not None:
            async for result in self.transcribe(*window):
                yield result

    async def close(self):
        self.references.clear()
