import asyncio
import logging
from collections import deque
from collections.abc import AsyncIterator
from hashlib import sha256
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import httpx
from anyio import CancelScope
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import Field, TypeAdapter, ValidationError

from ..errors import AppError
from ..providers.asr import build_adapter, recognition_options
from ..providers.asr.base import BYTES_PER_MS, Transcript, pcm_has_speech
from ..repository import Locks, Repository
from ..schemas import (
    ASRProvider, AppSettings, ChannelActivityCommand, PartialEvent, RecordingControl, RecordingStart,
    SessionPatch, StreamFormat,
)
from ..settings import SettingsStore
from .audio import AudioArchive, AudioStorage, WebmDecoder, decode_media_to_pcm16k
from .builtin_asr import BuiltinAsrRuntime
from .classroom_ai import ClassroomAI, TranscriptPipeline

logger = logging.getLogger(__name__)
COMMAND = TypeAdapter(
    Annotated[RecordingStart | RecordingControl | ChannelActivityCommand, Field(discriminator="type")]
)
MAX_AUDIO_FRAME = 128 * 1024
PCM_FRAME = 6400
SILENCE_PAUSE_MS = 30_000


class SocketSink:
    def __init__(self, socket: WebSocket):
        self.socket = socket
        self.connected = True
        self.lock = asyncio.Lock()

    async def send(self, kind: str, payload: dict):
        if not self.connected:
            return
        async with self.lock:
            if not self.connected:
                return
            try:
                async with asyncio.timeout(3):
                    await self.socket.send_json({"type": kind, "payload": payload})
            except (TimeoutError, WebSocketDisconnect, RuntimeError, OSError):
                self.connected = False

    async def error(self, error: AppError):
        await self.send("error", error.payload())


class ClassroomStreams:
    def __init__(
        self, repo: Repository, settings: SettingsStore, client: httpx.AsyncClient, locks: Locks,
        audio: AudioStorage, ai: ClassroomAI, builtin_asr: BuiltinAsrRuntime,
    ):
        self.repo, self.settings, self.client, self.locks, self.audio = repo, settings, client, locks, audio
        self.ai = ai
        self.builtin_asr = builtin_asr
        self.sinks: dict[str, SocketSink] = {}
        self.pipeline = TranscriptPipeline(ai, self.publish)

    def active_asr(self, settings: AppSettings) -> ASRProvider:
        config = settings.asr_providers.get(settings.selected_asr_provider_id)
        if config is None:
            raise AppError(400, "ASR_NOT_CONFIGURED", "请在设置中选择语音供应商")
        if config.protocol == "builtin-free-asr":
            self.builtin_asr.require()
        return config

    async def publish(self, session_id: str, kind: str, payload: dict) -> bool:
        sink = self.sinks.get(session_id)
        if sink is not None:
            await sink.send(kind, payload)
            return sink.connected
        return False

    async def delete_session(self, session_id: str):
        lease = self.locks.get("recording:" + session_id)
        try:
            async with asyncio.timeout(8):
                await lease.acquire()
        except TimeoutError:
            raise AppError(409, "SESSION_STREAM_ACTIVE", "请结束当前课堂录音后再删除") from None
        try:
            await self.audio.delete_session(self.repo, session_id)
            if self.ai.attachments is not None:
                await self.ai.attachments.cleanup_session_dir(session_id)
        finally:
            lease.release()

    async def _run_batch_pcm_through_asr(
        self,
        *,
        session_id: str,
        pcm: bytes,
        offset_ms: int,
        settings: AppSettings,
        hotwords: list[str],
        on_chunk_progress=None,
    ) -> list[str]:
        config = self.active_asr(settings)
        options = recognition_options(settings, hotwords)
        adapter = build_adapter(self.client, config, options, builtin_asr=self.builtin_asr)
        run_id = uuid4().hex
        saved_utterance_ids: list[str] = []
        last_final_ms = offset_ms
        sent_bytes = 0
        total_bytes = len(pcm)

        async def read_loop():
            nonlocal last_final_ms
            async for result in adapter.results():
                if not result.final:
                    continue
                text = result.text.strip()[:16_000]
                if not text:
                    continue
                channel = "default"
                if options.diarization and result.speaker is not None:
                    channel = sha256(f"{run_id}:{result.speaker}".encode()).hexdigest()
                end_cap = offset_ms + sent_bytes // BYTES_PER_MS
                start = last_final_ms if result.start_ms is None else offset_ms + result.start_ms
                start = min(start, end_cap)
                end = end_cap if result.end_ms is None else min(end_cap, offset_ms + result.end_ms)
                end = max(start, end)
                last_final_ms = max(last_final_ms, end)
                async with self.locks.get("transcript:" + session_id):
                    final, initial = await self.repo.save_final(session_id, channel, text, start, end)
                    saved_utterance_ids.append(final.utterance.id)
                    if initial is not None:
                        await self.publish(session_id, "segments.regrouped", {"segments": [initial.wire()]})
                    await self.publish(session_id, "utterance.final", final.wire())

        await adapter.start()
        reader = asyncio.create_task(read_loop())
        try:
            step = 16000  # 500ms PCM per chunk
            for pos in range(0, total_bytes, step):
                if reader.done():
                    reader.result()
                chunk = pcm[pos:pos + step]
                sent_bytes += len(chunk)
                await adapter.send_audio(chunk)
                if on_chunk_progress is not None:
                    await on_chunk_progress(sent_bytes, total_bytes)
                await asyncio.sleep(0.01)
            await adapter.finish()
            async with asyncio.timeout(30):
                await reader
        finally:
            if not reader.done():
                reader.cancel()
            with CancelScope(shield=True):
                await asyncio.gather(reader, return_exceptions=True)
                await adapter.close()
        return saved_utterance_ids

    async def retranscribe_gap(self, session_id: str) -> dict:
        lease = self.locks.get("recording:" + session_id)
        try:
            async with asyncio.timeout(3):
                await lease.acquire()
        except TimeoutError:
            raise AppError(409, "SESSION_STREAM_ACTIVE", "请先暂停当前录音后再执行异常缺口补转写") from None
        try:
            audio_ms = self.audio.existing_duration_ms(session_id)
            if audio_ms <= 0:
                raise AppError(404, "AUDIO_NOT_FOUND", "当前课堂暂无本地录音文件可供补转写")
            ws = await self.repo.workspace(session_id, audio_duration_ms=audio_ms)
            last_utt_ms = max(
                (u.end_time_ms for seg in ws.segments for u in seg.utterances),
                default=0,
            )
            if audio_ms - last_utt_ms < 1500:
                return {"recoveredCount": 0, "fromMs": last_utt_ms, "toMs": audio_ms}
            pcm = await asyncio.to_thread(self.audio.read_pcm_window, session_id, last_utt_ms, audio_ms)
            if not pcm:
                return {"recoveredCount": 0, "fromMs": last_utt_ms, "toMs": audio_ms}
            settings = await self.settings.get()
            hotwords = await self.ai.merged_hotwords(session_id, settings)
            utt_ids = await self._run_batch_pcm_through_asr(
                session_id=session_id,
                pcm=pcm,
                offset_ms=last_utt_ms,
                settings=settings,
                hotwords=hotwords,
            )
            for uid in utt_ids:
                self.pipeline.submit(session_id, uid)
            return {"recoveredCount": len(utt_ids), "fromMs": last_utt_ms, "toMs": audio_ms}
        finally:
            lease.release()

    async def import_audio_stream(
        self,
        *,
        folder_id: str | None,
        title: str | None,
        file_name: str,
        raw_media: bytes,
    ) -> AsyncIterator[dict]:
        settings = await self.settings.get()
        self.active_asr(settings)

        async def generator() -> AsyncIterator[dict]:
            yield {
                "type": "progress",
                "stage": "decoding",
                "downloadedBytes": 0,
                "totalBytes": len(raw_media),
                "percent": 8,
            }
            pcm = await decode_media_to_pcm16k(raw_media, file_name)
            duration_ms = len(pcm) // BYTES_PER_MS
            if duration_ms < 200:
                raise AppError(400, "INVALID_AUDIO_FILE", "音频有效时长过短，无法创建课堂")

            created = await self.repo.create_session(folder_id)
            session_id = created.session.id
            clean_title = (title or Path(file_name).stem or created.session.title).strip()[:200]
            await self.repo.patch_session(
                session_id,
                SessionPatch(title=clean_title, status="paused", duration_seconds=max(1, duration_ms // 1000)),
            )

            archive_path = self.audio.path(session_id)

            def _write_archive():
                arc = AudioArchive(archive_path)
                try:
                    arc.append(pcm)
                finally:
                    arc.close()

            await asyncio.to_thread(_write_archive)
            await self.repo.checkpoint(session_id, duration_ms, status="paused", audio_path=str(archive_path))

            hotwords = await self.ai.merged_hotwords(session_id, settings)
            last_pct = 15
            yield {
                "type": "progress",
                "stage": "transcribing",
                "downloadedBytes": 0,
                "totalBytes": len(pcm),
                "percent": last_pct,
            }

            progress_queue: asyncio.Queue[int] = asyncio.Queue()

            async def report_progress(done_b: int, total_b: int):
                nonlocal last_pct
                pct = 15 + int((done_b / max(1, total_b)) * 65)
                if pct >= last_pct + 5:
                    last_pct = pct
                    progress_queue.put_nowait(pct)

            asr_task = asyncio.create_task(
                self._run_batch_pcm_through_asr(
                    session_id=session_id,
                    pcm=pcm,
                    offset_ms=0,
                    settings=settings,
                    hotwords=hotwords,
                    on_chunk_progress=report_progress,
                )
            )
            try:
                while not asr_task.done():
                    try:
                        pct = await asyncio.wait_for(progress_queue.get(), timeout=0.2)
                        yield {
                            "type": "progress",
                            "stage": "transcribing",
                            "downloadedBytes": 0,
                            "totalBytes": len(pcm),
                            "percent": pct,
                        }
                    except TimeoutError:
                        pass
                utt_ids = await asr_task
            finally:
                if not asr_task.done():
                    asr_task.cancel()
                with CancelScope(shield=True):
                    await asyncio.gather(asr_task, return_exceptions=True)

            if utt_ids:
                yield {
                    "type": "progress",
                    "stage": "refining",
                    "downloadedBytes": len(pcm),
                    "totalBytes": len(pcm),
                    "percent": 88,
                }
                substantive = await self.pipeline._filter_fillers(
                    utt_ids, session_id=session_id, settings=settings,
                )
                download_prompt_sent = bool(substantive) and self.pipeline.should_prompt_for_opencode(settings)
                if download_prompt_sent:
                    yield {"type": "opencode-required"}
                for i in range(0, len(substantive), 10):
                    batch = substantive[i:i + 10]
                    await self.pipeline.process_batch(
                        session_id, batch, settings, download_prompt_sent=download_prompt_sent,
                    )

            final_ws = await self.repo.workspace(session_id, audio_duration_ms=duration_ms)
            yield {"type": "done", "data": final_ws.wire()}

        return generator()

    async def serve(self, socket: WebSocket, session_id: str):
        await socket.accept()
        sink = SocketSink(socket)
        lease = self.locks.get("recording:" + session_id)
        stream = None
        claimed = False
        try:
            try:
                async with asyncio.timeout(8):
                    await lease.acquire()
                    claimed = True
            except TimeoutError:
                raise AppError(409, "SESSION_STREAM_ACTIVE", "此课堂已有实时连接") from None
            offset_ms, status = await self.repo.stream_state(session_id)
            offset_ms = max(offset_ms, self.audio.existing_duration_ms(session_id))
            stream = ClassroomConnection(self, session_id, sink, offset_ms, status == "recording")
            async with self.locks.get("transcript:" + session_id):
                self.sinks[session_id] = sink
                segments = await self.repo.segments(session_id)
                if segments:
                    await sink.send("segments.regrouped", {"segments": [segment.wire() for segment in segments]})
            await stream.run()
        except WebSocketDisconnect:
            pass
        except AppError as error:
            await sink.error(error)
            if sink.connected:
                await socket.close(1008)
        except Exception:
            logger.exception("Classroom websocket failed for %s", session_id)
            await sink.error(AppError(500, "STREAM_FAILED", "课堂音频连接出错"))
            if sink.connected:
                await socket.close(1011)
        finally:
            sink.connected = False
            try:
                if stream is not None:
                    with CancelScope(shield=True):
                        await stream.finish()
            finally:
                if self.sinks.get(session_id) is sink:
                    self.sinks.pop(session_id)
                if claimed:
                    lease.release()


class RecognitionRun:
    def __init__(self, connection, settings: AppSettings, offset_ms: int):
        self.connection = connection
        self.settings = settings
        self.options = recognition_options(settings, getattr(connection, "hotwords", ()))
        self.offset_ms = offset_ms
        self.run_id = uuid4().hex
        self.last_final_ms = offset_ms
        self.total_bytes = 0
        self.closing = False
        self.pending: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=512)
        self.task = asyncio.create_task(self.run())

    @property
    def end_ms(self) -> int:
        return self.offset_ms + self.total_bytes // BYTES_PER_MS

    async def read_results(self, adapter):
        async for result in adapter.results():
            await self.persist_result(result)
        if not self.closing:
            raise AppError(502, "ASR_STREAM_INTERRUPTED", "语音供应商提前结束转写")

    async def send_audio(self, adapter):
        while (pcm := await self.pending.get()) is not None:
            await adapter.send_audio(pcm)
        await adapter.finish()

    async def run(self):
        sink = self.connection.sink
        adapter = None
        tasks = []
        try:
            config = self.connection.owner.active_asr(self.settings)
            adapter = build_adapter(
                self.connection.owner.client,
                config,
                self.options,
                builtin_asr=self.connection.owner.builtin_asr,
            )
            await adapter.start()
            has_physical_dual_split = (
                self.settings.enable_dual_channel_speaker_split
                and self.settings.mic_enabled
                and self.settings.system_audio_enabled
            )
            if (
                self.options.diarization
                and not adapter.supports_diarization
                and config.protocol != "builtin-free-asr"
                and not has_physical_dual_split
            ):
                await sink.error(AppError(400, "ASR_DIARIZATION_UNAVAILABLE", "当前语音模型只提供单路转写"))
            sender = asyncio.create_task(self.send_audio(adapter))
            receiver = asyncio.create_task(self.read_results(adapter))
            tasks = [sender, receiver]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if sender in done:
                await receiver
        except AppError as error:
            await sink.error(error)
        except Exception as error:
            logger.error("Unexpected ASR failure (%s)", type(error).__name__)
            await sink.error(AppError(502, "ASR_STREAM_FAILED", "语音处理遇到错误，暂停后可重新连接"))
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if adapter is not None:
                await adapter.close()

    async def enqueue(self, pcm: bytes):
        if self.task.done() or self.task.cancelling():
            return
        try:
            self.pending.put_nowait(pcm)
        except asyncio.QueueFull:
            self.task.cancel()
            await self.connection.sink.error(AppError(502, "ASR_BACKPRESSURE", "语音服务处理速度过慢，已保留本地录音"))

    async def finish(self):
        if self.task.done() or self.task.cancelling():
            await asyncio.gather(self.task, return_exceptions=True)
            return
        self.closing = True
        try:
            async with asyncio.timeout(20):
                await self.pending.put(None)
                await asyncio.shield(self.task)
        except TimeoutError:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            await self.connection.sink.error(AppError(502, "ASR_DRAIN_TIMEOUT", "语音供应商收尾超时，已保存收到的转写"))

    async def persist_result(self, result: Transcript):
        text = result.text.strip()[:16_000]
        if not text:
            return
        session_id = self.connection.id
        owner = self.connection.owner
        if not result.final:
            phys = (
                self.connection.resolve_physical_channel(self.last_final_ms, self.end_ms)
                if self.settings.enable_dual_channel_speaker_split
                else None
            )
            channel = phys or "default"
            if phys is None and self.options.diarization and result.speaker is not None:
                channel = sha256(f"{self.run_id}:{result.speaker}".encode()).hexdigest()
            speaker = await owner.repo.preview_speaker(session_id, channel)
            await self.connection.sink.send("utterance.partial", PartialEvent(
                speaker_id=speaker.id, speaker_label=speaker.label, text=text,
            ).wire())
            return
        start = self.last_final_ms if result.start_ms is None else self.offset_ms + result.start_ms
        start = min(start, self.end_ms)
        end = self.end_ms if result.end_ms is None else min(self.end_ms, self.offset_ms + result.end_ms)
        end = max(start, end)
        self.last_final_ms = max(self.last_final_ms, end)
        phys = (
            self.connection.resolve_physical_channel(start, end)
            if self.settings.enable_dual_channel_speaker_split
            else None
        )
        channel = phys or "default"
        if phys is None and self.options.diarization and result.speaker is not None:
            channel = sha256(f"{self.run_id}:{result.speaker}".encode()).hexdigest()
        async with owner.locks.get("transcript:" + session_id):
            final, initial = await owner.repo.save_final(session_id, channel, text, start, end)
            if initial is not None:
                await owner.publish(session_id, "segments.regrouped", {"segments": [initial.wire()]})
            await owner.publish(session_id, "utterance.final", final.wire())
            if not owner.pipeline.submit(session_id, final.utterance.id):
                await self.connection.sink.error(AppError(
                    502, "AI_QUEUE_FULL", "AI 后处理积压，当前句的原始转写已保存",
                ))


class ClassroomConnection:
    def __init__(self, owner: ClassroomStreams, session_id: str, sink: SocketSink, offset_ms: int, was_recording: bool):
        self.owner, self.id, self.sink = owner, session_id, sink
        self.timeline_ms = offset_ms
        self.persist_seconds = offset_ms // 1000
        self.needs_pause = was_recording
        self.format = StreamFormat(sample_rate=16000, channels=1, encoding="pcm_s16le")
        self.recognition: RecognitionRun | None = None
        self.decoder: WebmDecoder | None = None
        self.archive: AudioArchive | None = None
        self.save_audio = True
        self.silence_bytes = 0
        self.auto_paused = False
        self.silent_since_update = 0
        self.pre_roll: deque[bytes] = deque(maxlen=2)
        self.hotwords: list[str] = []
        self.activity_history: deque[tuple[int, float, float, bool]] = deque(maxlen=180)
        self.latest_activity: tuple[float, float, bool] = (0.0, 0.0, False)

    def resolve_physical_channel(self, start_ms: int, end_ms: int) -> str | None:
        window = [
            (mic_r, sys_r)
            for ts_ms, mic_r, sys_r, dual in self.activity_history
            if dual and (start_ms - 600 <= ts_ms <= end_ms + 300)
        ]
        if not window:
            mic_l, sys_l, dual_l = self.latest_activity
            if not dual_l or max(mic_l, sys_l) < 0.002:
                return None
            return "phys:mic" if mic_l >= sys_l * 1.15 else "phys:sys"
        mic_sum = sum(m for m, _ in window)
        sys_sum = sum(s for _, s in window)
        if max(mic_sum, sys_sum) < 0.002:
            return None
        return "phys:mic" if mic_sum >= sys_sum * 1.15 else "phys:sys"

    async def run(self):
        while self.sink.connected:
            frame = await self.sink.socket.receive()
            if frame["type"] == "websocket.disconnect":
                break
            try:
                if frame.get("text") is not None:
                    await self.command(frame["text"])
                elif frame.get("bytes") is not None:
                    await self.binary(frame["bytes"])
            except AppError as error:
                await self.sink.error(error)

    async def command(self, frame: str):
        try:
            if len(frame) > 4096:
                raise ValueError
            command = COMMAND.validate_json(frame)
        except (ValueError, ValidationError):
            raise AppError(400, "INVALID_RECORDING_COMMAND", "录音指令或音频格式无效") from None
        if isinstance(command, ChannelActivityCommand):
            cur_ms = self.recognition.end_ms if self.recognition is not None else self.timeline_ms
            p = command.payload
            self.latest_activity = (p.mic_rms, p.sys_rms, p.dual_active)
            self.activity_history.append((cur_ms, p.mic_rms, p.sys_rms, p.dual_active))
            return
        if isinstance(command, RecordingStart):
            if self.recognition is not None and self.format != command.payload:
                raise AppError(409, "RECORDING_ACTIVE", "请暂停后再切换录音格式")
            self.format = command.payload
            await self.start()
        elif command.type == "recording.resume":
            await self.start()
        else:
            with CancelScope(shield=True):
                await self.finish()

    async def start(self):
        if self.recognition is not None:
            return
        settings = await self.owner.settings.get()
        self.owner.active_asr(settings)
        self.hotwords = await self.owner.ai.merged_hotwords(self.id, settings)
        self.save_audio = settings.auto_save_session
        if self.format.encoding == "opus_webm":
            decoder = WebmDecoder(self.accept_pcm)
            await decoder.start()
            self.decoder = decoder
        duration = await self.owner.repo.checkpoint(self.id, self.timeline_ms, status="recording")
        self.timeline_ms = max(self.timeline_ms, duration * 1000)
        self.persist_seconds = self.timeline_ms // 1000
        self.needs_pause = True
        self.silence_bytes = self.silent_since_update = 0
        self.auto_paused = False
        self.pre_roll.clear()
        self.recognition = RecognitionRun(self, settings, self.timeline_ms)
        await self.sink.send("session.duration", {"durationSeconds": self.persist_seconds})

    async def binary(self, frame: bytes):
        if not frame or len(frame) > MAX_AUDIO_FRAME:
            raise AppError(400, "INVALID_AUDIO_FRAME", "音频帧为空或超出大小限制")
        if self.recognition is None:
            raise AppError(400, "RECORDING_INACTIVE", "请先开始或继续录音")
        if self.decoder is not None:
            try:
                await self.decoder.send(frame)
            except AppError:
                await self.finish()
                raise
        else:
            if len(frame) % 2:
                raise AppError(400, "INVALID_AUDIO_FRAME", "PCM 音频帧须包含完整的 16 位采样")
            for start in range(0, len(frame), PCM_FRAME):
                await self.accept_pcm(frame[start:start + PCM_FRAME])

    async def accept_pcm(self, pcm: bytes):
        run = self.recognition
        if run is None:
            return
        if run.options.vad:
            if pcm_has_speech(pcm):
                self.silence_bytes = 0
                if self.auto_paused:
                    self.auto_paused = False
                    run = self.recognition = RecognitionRun(self, run.settings, run.end_ms)
                    while self.pre_roll:
                        await self.store_pcm(run, self.pre_roll.popleft())
            else:
                self.silence_bytes += len(pcm)
                if self.silence_bytes > SILENCE_PAUSE_MS * BYTES_PER_MS:
                    await self.skip_silence(run, pcm)
                    return
        await self.store_pcm(run, pcm)

    async def skip_silence(self, run: RecognitionRun, pcm: bytes):
        self.pre_roll.append(pcm)
        if not self.auto_paused:
            self.auto_paused = True
            self.silent_since_update = 0
            await run.finish()
            await self.sink.send("session.duration", {"durationSeconds": self.persist_seconds})
        self.silent_since_update += len(pcm)
        if self.silent_since_update >= 1000 * BYTES_PER_MS:
            self.silent_since_update %= 1000 * BYTES_PER_MS
            await self.sink.send("session.duration", {"durationSeconds": self.persist_seconds})

    async def store_pcm(self, run: RecognitionRun, pcm: bytes):
        if self.save_audio:
            try:
                if self.archive is None:
                    self.archive = AudioArchive(self.owner.audio.path(self.id))
                    await self.owner.repo.checkpoint(self.id, run.end_ms, audio_path=str(self.archive.path))
                self.archive.append(pcm)
            except OSError:
                await self.archive_failed()
        run.total_bytes += len(pcm)
        await run.enqueue(pcm)
        if run.end_ms // 1000 > self.persist_seconds:
            next_sec = run.end_ms // 1000
            if self.archive is not None and (next_sec % 5 == 0 or next_sec - self.persist_seconds >= 5):
                try:
                    await asyncio.to_thread(self.archive.checkpoint)
                except OSError:
                    await self.archive_failed()
            self.persist_seconds = await self.owner.repo.checkpoint(self.id, run.end_ms)
            await self.sink.send("session.duration", {"durationSeconds": self.persist_seconds})

    async def archive_failed(self):
        self.save_audio = False
        if self.archive is not None:
            try:
                self.archive.close()
            except OSError:
                pass
            self.archive = None
        await self.sink.error(AppError(500, "AUDIO_SAVE_FAILED", "本地录音文件写入失败"))

    async def finish(self):
        try:
            if self.decoder is not None:
                try:
                    await self.decoder.finish()
                except AppError as error:
                    await self.sink.error(error)
                finally:
                    self.decoder = None
            if self.recognition is not None:
                try:
                    await self.recognition.finish()
                finally:
                    self.timeline_ms = self.recognition.end_ms
                    self.recognition = None
        finally:
            if self.archive is not None:
                try:
                    self.archive.close()
                except OSError:
                    await self.sink.error(AppError(500, "AUDIO_SAVE_FAILED", "本地录音文件写入失败"))
                finally:
                    self.archive = None
            if self.needs_pause:
                self.persist_seconds = await self.owner.repo.checkpoint(self.id, self.timeline_ms, status="paused")
                self.needs_pause = False
                await self.sink.send("session.duration", {"durationSeconds": self.persist_seconds})
