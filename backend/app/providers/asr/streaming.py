import base64
from collections.abc import AsyncIterator
from urllib.parse import urlsplit
from uuid import uuid4

from ...errors import AppError
from ..http import route, with_params
from .base import (
    Recognition, SocketASR, Transcript, as_ms, asr_error, join_transcript, speaker_id, split_speakers,
)


class DashScope(SocketASR):
    def __init__(self, url: str, key: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model, self.recognition = url, key, model, recognition
        self.task_id = str(uuid4())

    def control(self, action: str, payload: dict) -> dict:
        return {
            "header": {"action": action, "task_id": self.task_id, "streaming": "duplex"},
            "payload": payload,
        }

    @staticmethod
    def check_error(event: dict):
        header = event.get("header", {})
        if header.get("event") == "task-failed":
            raise asr_error(header.get("error_code"), header.get("error_message"))

    async def start(self):
        await self.open(self.url, {"Authorization": f"Bearer {self.key}"})
        gummy = self.model.startswith("gummy-")
        paraformer_v2 = self.model.startswith("paraformer-realtime-v2")
        language = self.recognition.language
        parameters = {"format": "pcm", "sample_rate": 16000}
        if gummy:
            parameters.update(transcription_enabled=True, translation_enabled=False)
            if language in ("zh", "en"):
                parameters["source_language"] = language
        elif paraformer_v2 or self.model.startswith("fun-asr"):
            if language != "auto":
                parameters["language_hints"] = ["zh", "en"] if language == "zh-en" else [language]
        if paraformer_v2:
            parameters["semantic_punctuation_enabled"] = not self.recognition.vad
        await self.send_json(self.control("run-task", {
            "task_group": "audio", "task": "asr", "function": "recognition",
            "model": self.model, "parameters": parameters, "input": {},
        }))
        await self.ready(lambda event: event.get("header", {}).get("event") == "task-started", self.check_error)

    async def finish(self):
        self.finishing = True
        await self.send_json(self.control("finish-task", {"input": {}}))

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            kind = event.get("header", {}).get("event")
            if kind == "task-finished":
                return
            if kind != "result-generated":
                continue
            output = event.get("payload", {}).get("output", {})
            sentence = output.get("sentence") or output.get("transcription") or {}
            if sentence.get("text") and not sentence.get("heartbeat"):
                yield Transcript(
                    sentence["text"], bool(sentence.get("sentence_end")),
                    speaker_id(sentence.get("speaker_id")), as_ms(sentence.get("begin_time")),
                    as_ms(sentence.get("end_time")),
                )


class Deepgram(SocketASR):
    supports_diarization = True

    def __init__(self, url: str, key: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model, self.recognition = url, key, model, recognition
        self.pending: list[Transcript] = []

    async def start(self):
        language = self.recognition.language
        params = {
            "model": self.model, "encoding": "linear16", "sample_rate": 16000, "channels": 1,
            "interim_results": "true", "smart_format": "true",
            "language": "multi" if language in ("auto", "zh-en") else language,
            "endpointing": 500 if self.recognition.vad else 1000, "utterance_end_ms": 1500,
        }
        if self.recognition.diarization:
            params["diarize_model"] = "latest"
        await self.open(with_params(self.url, params), {"Authorization": f"Token {self.key}"})

    async def finish(self):
        self.finishing = True
        await self.send_json({"type": "CloseStream"})

    def append(self, transcript: Transcript):
        if self.pending and self.pending[-1].speaker == transcript.speaker:
            prior = self.pending.pop()
            transcript = Transcript(
                join_transcript(prior.text, transcript.text), True,
                prior.speaker, prior.start_ms, transcript.end_ms,
            )
        self.pending.append(transcript)

    def flush(self) -> list[Transcript]:
        final, self.pending = self.pending, []
        return final

    def process(self, event: dict) -> list[Transcript]:
        kind = event.get("type")
        if kind == "Error" or "err_code" in event:
            raise asr_error(event.get("err_code") or event.get("variant"), event.get("description"))
        if kind == "UtteranceEnd":
            return self.flush()
        if kind != "Results":
            return []
        alternatives = event.get("channel", {}).get("alternatives", [])
        alt = alternatives[0] if alternatives else {}
        text = alt.get("transcript", "")
        is_final = bool(event.get("is_final"))
        words = [
            Transcript(
                w.get("punctuated_word", w.get("word", "")), is_final, speaker_id(w.get("speaker")),
                as_ms(w.get("start"), seconds=True), as_ms(w.get("end"), seconds=True),
            )
            for w in alt.get("words", [])
        ]
        previews = []
        if text.strip():
            start = as_ms(event.get("start"), seconds=True)
            length = as_ms(event.get("duration"), seconds=True)
            end = start + length if start is not None and length is not None else None
            if words:
                start = words[0].start_ms if words[0].start_ms is not None else start
                end = words[-1].end_ms if words[-1].end_ms is not None else end
            full = Transcript(text, is_final, words[-1].speaker if words else None, start, end)
            if is_final:
                for part in split_speakers(full, words):
                    self.append(part)
            else:
                if self.pending and self.pending[-1].speaker == full.speaker:
                    text = join_transcript(self.pending[-1].text, text)
                previews.append(Transcript(text, False, full.speaker))
        if event.get("speech_final") or event.get("from_finalize"):
            return self.flush()
        if self.pending:
            first, last = self.pending[0], self.pending[-1]
            if first.start_ms is not None and last.end_ms is not None and last.end_ms - first.start_ms > 20000:
                return self.flush()
        return previews

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            if event.get("type") == "Metadata" and self.finishing:
                break
            for result in self.process(event):
                yield result
        for result in self.flush():
            yield result


class AssemblyAI(SocketASR):
    supports_diarization = True

    def __init__(self, url: str, key: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model, self.recognition = url, key, model, recognition
        self.last_turn = -1

    @staticmethod
    def check_error(event: dict):
        if event.get("error") or event.get("type") in ("Error", "error"):
            raise asr_error(event.get("code"), event.get("error"))

    async def start(self):
        params = {"sample_rate": 16000, "encoding": "pcm_s16le", "speech_model": self.model}
        if self.recognition.diarization:
            params["speaker_labels"] = "true"
            if self.recognition.speaker_mode == "dual":
                params["max_speakers"] = 2
        await self.open(with_params(self.url, params), {"Authorization": self.key})
        await self.ready(lambda event: event.get("type") == "Begin", self.check_error)

    async def finish(self):
        self.finishing = True
        await self.send_json({"type": "ForceEndpoint"})
        await self.send_json({"type": "Terminate"})

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            if event.get("type") == "Termination":
                return
            if event.get("type") != "Turn" or not event.get("transcript"):
                continue
            final = bool(event.get("end_of_turn"))
            turn = event.get("turn_order")
            if isinstance(turn, int) and turn <= self.last_turn:
                continue
            if final and isinstance(turn, int):
                self.last_turn = turn
            words = [
                Transcript(
                    word.get("text", ""), final, speaker_id(word.get("speaker")),
                    as_ms(word.get("start")), as_ms(word.get("end")),
                ) for word in event.get("words", [])
            ]
            full = Transcript(
                event["transcript"], final, speaker_id(event.get("speaker_label")),
                words[0].start_ms if words else None, words[-1].end_ms if words else None,
            )
            for result in (split_speakers(full, words) if final else [full]):
                yield result


class ElevenLabs(SocketASR):
    def __init__(self, url: str, key: str, model: str, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model, self.recognition = url, key, model, recognition
        self.supports_diarization = model == "scribe_v3_live"
        self.diarize = recognition.diarization and self.supports_diarization
        self.has_audio = False
        self.commits_waiting: set[int] = set()

    @staticmethod
    def check_error(event: dict):
        kind = event.get("message_type", "")
        if kind == "error" or kind.endswith("_error") or kind in {"quota_exceeded", "rate_limited"}:
            raise asr_error(kind, event.get("error"))

    async def start(self):
        params = {
            "model_id": self.model, "audio_format": "pcm_16000", "include_timestamps": "true",
            "commit_strategy": "vad" if self.recognition.vad or not self.supports_diarization else "turn_prediction",
        }
        if self.recognition.language in ("zh", "en"):
            params["language_code"] = self.recognition.language
        elif self.recognition.language == "zh-en" and self.supports_diarization:
            params["multilang_mode"] = "true"
        if self.diarize:
            params["diarize"] = "true"
        url = self.url
        if not urlsplit(url).path.rstrip("/").endswith("/speech-to-text/realtime"):
            url = route(url, "speech-to-text/realtime")
        await self.open(with_params(url, params), {"xi-api-key": self.key})
        await self.ready(lambda event: event.get("message_type") == "session_started", self.check_error)

    async def send_audio(self, pcm: bytes):
        self.has_audio = True
        await self.send_json({
            "message_type": "input_audio_chunk", "audio_base_64": base64.b64encode(pcm).decode("ascii"),
            "sample_rate": 16000, "commit": False,
        })

    async def finish(self):
        self.finishing = True
        if not self.has_audio:
            if self.socket is not None:
                await self.socket.close()
            return
        # Send a small silent tail with the explicit commit used by the Realtime API.
        await self.send_json({
            "message_type": "input_audio_chunk", "audio_base_64": base64.b64encode(bytes(3200)).decode("ascii"),
            "sample_rate": 16000, "commit": True,
        })

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            kind = event.get("message_type")
            index = event.get("segment_index")
            if self.diarize and kind == "committed_transcript":
                if isinstance(index, int):
                    self.commits_waiting.add(index)
                continue
            final_kind = "diarized_transcript" if self.diarize else "committed_transcript_with_timestamps"
            if kind not in ("partial_transcript", final_kind):
                continue
            final = kind == final_kind
            words = [
                Transcript(
                    word.get("text", ""), final, speaker_id(word.get("speaker_id")),
                    as_ms(word.get("start"), seconds=True), as_ms(word.get("end"), seconds=True),
                ) for word in event.get("words", [])
            ]
            text = event.get("text", "")
            if text.strip():
                full = Transcript(
                    text, final, next((w.speaker for w in reversed(words) if w.speaker is not None), None),
                    words[0].start_ms if words else None, words[-1].end_ms if words else None,
                )
                for result in (split_speakers(full, words, word_spacing=False) if final else [full]):
                    yield result
            if final:
                self.commits_waiting.discard(index)
                if self.finishing and not self.commits_waiting:
                    return


class CustomASR(SocketASR):
    supports_diarization = True

    def __init__(self, url: str, key: str, model: str, app_id: str | None, recognition: Recognition):
        super().__init__()
        self.url, self.key, self.model = url, key, model
        self.app_id, self.recognition = app_id, recognition

    @staticmethod
    def check_error(event: dict):
        if event.get("type") == "error":
            raise asr_error(event.get("code"), event.get("message"))

    async def start(self):
        await self.open(self.url, {"Authorization": f"Bearer {self.key}"} if self.key else {})
        request = {
            "type": "start", "model": self.model, "sampleRate": 16000, "channels": 1, "encoding": "pcm_s16le",
            "language": self.recognition.language, "enableSpeakerDiarization": self.recognition.diarization,
            "expectedSpeakerMode": self.recognition.speaker_mode, "vad": self.recognition.vad,
        }
        if self.app_id:
            request["appId"] = self.app_id
        await self.send_json(request)
        await self.ready(lambda event: event.get("type") == "ready", self.check_error)

    async def finish(self):
        self.finishing = True
        await self.send_json({"type": "stop"})

    async def results(self) -> AsyncIterator[Transcript]:
        async for event in self.json_events():
            self.check_error(event)
            kind = event.get("type")
            if kind == "done":
                if not self.finishing:
                    raise AppError(502, "ASR_STREAM_INTERRUPTED", "语音网关提前结束转写")
                return
            if kind in ("partial", "final") and isinstance(event.get("text"), str):
                yield Transcript(
                    event["text"], kind == "final", speaker_id(event.get("speakerId")),
                    as_ms(event.get("startTimeMs")), as_ms(event.get("endTimeMs")),
                )
