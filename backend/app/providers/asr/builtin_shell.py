"""本地离线 SenseVoice-Small (sherpa-onnx) 实时流式语音识别适配器（非阻塞异步推理版）。

将连续的 16kHz / 16-bit signed LE / mono PCM 音频流切分为带前导预缓冲的自然语句：
- `send_audio()` 永不阻塞等待 CPU 推理，杜绝因解码耗时触发 `ASR_BACKPRESSURE` 导致意外暂停；
- 独立后台推理协程优先按序解码 `final` 句，空闲时处理最新单槽 `partial` 预览（自动丢弃过期中间帧）；
- 导入离线录音文件时由于音频块高速灌入，自动跳过多余的 partial 预览，直接全速转写。
"""
from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
import logging
import time

from ...errors import AppError
from ...services.builtin_asr import BuiltinAsrRuntime, active_builtin_asr_runtime
from .base import ASRStreamAdapter, BYTES_PER_MS, Recognition, Transcript, pcm_has_speech

logger = logging.getLogger(__name__)

_PRE_ROLL_CHUNKS = 15           # 15 * 20ms = 300ms 前导缓冲，避免吃掉首字
_MIN_SPEECH_MS = 280            # 忽略极短瞬态噪声
_ENDPOINT_SILENCE_MS = 720      # 句末静音判定阈值
_SOFT_MAX_UTTERANCE_MS = 8_000  # 8 秒以上遇短停顿（>= 240ms）即断句
_SOFT_SILENCE_MS = 240
_HARD_MAX_UTTERANCE_MS = 12_000
_PARTIAL_MIN_AUDIO_MS = 700
_PARTIAL_INTERVAL_WALL_S = 0.95


class BuiltinFreeAsrAdapter(ASRStreamAdapter):
    supports_diarization = False

    def __init__(
        self,
        options: Recognition,
        runtime: BuiltinAsrRuntime | None = None,
    ):
        self.options = options
        self._runtime = runtime
        self._queue: asyncio.Queue[Transcript | BaseException | None] = asyncio.Queue()
        self._final_jobs: deque[tuple[bytes, int, int]] = deque()
        self._pending_partial: tuple[bytes, int, int] | None = None
        self._work_event = asyncio.Event()
        self._worker_task: asyncio.Task | None = None
        self._eof = False

        self._pre_roll: deque[bytes] = deque(maxlen=_PRE_ROLL_CHUNKS)
        self._speech_buf = bytearray()
        self._in_speech = False
        self._cursor_ms = 0
        self._segment_start_ms = 0
        self._speech_ms = 0
        self._silence_ms = 0
        self._last_partial_wall = 0.0
        self._last_partial_text = ""
        self._closed = False
        self._started = False

    def _resolve_runtime(self) -> BuiltinAsrRuntime:
        runtime = self._runtime or active_builtin_asr_runtime()
        if runtime is None:
            raise AppError(
                503,
                "ASR_DEPENDENCY_UNAVAILABLE",
                "本地语音识别运行时未初始化",
            )
        return runtime

    async def start(self):
        runtime = self._resolve_runtime()
        runtime.require()
        await asyncio.to_thread(runtime.get_recognizer, self.options.language)
        self._started = True
        self._eof = False
        self._last_partial_wall = time.monotonic()
        self._worker_task = asyncio.create_task(self._decode_worker())

    async def _decode_worker(self):
        runtime = self._resolve_runtime()
        try:
            while not self._closed:
                if self._final_jobs:
                    pcm_payload, start_ms, end_ms = self._final_jobs.popleft()
                    try:
                        text = await asyncio.to_thread(
                            runtime.decode_pcm, pcm_payload, self.options.language
                        )
                    except Exception as exc:
                        logger.warning("Local SenseVoice final decode error: %s", exc)
                        await self._queue.put(
                            AppError(500, "ASR_LOCAL_DECODE_FAILED", "本地语音识别推理异常，请重试")
                        )
                        return
                    if text and not self._closed:
                        await self._queue.put(
                            Transcript(text=text, final=True, start_ms=start_ms, end_ms=end_ms)
                        )
                    continue

                if self._pending_partial is not None and not self._eof:
                    snapshot, start_ms, end_ms = self._pending_partial
                    self._pending_partial = None
                    try:
                        text = await asyncio.to_thread(
                            runtime.decode_pcm, snapshot, self.options.language
                        )
                    except Exception as exc:
                        logger.warning("Local SenseVoice partial decode error: %s", exc)
                        continue
                    # 若解码期间已有新的 final 入队，则放弃过期 partial
                    if (
                        text
                        and text != self._last_partial_text
                        and not self._closed
                        and not self._final_jobs
                        and not self._eof
                    ):
                        self._last_partial_text = text
                        await self._queue.put(
                            Transcript(text=text, final=False, start_ms=start_ms, end_ms=end_ms)
                        )
                    continue

                if self._eof:
                    return

                self._work_event.clear()
                if not self._final_jobs and self._pending_partial is None and not self._eof:
                    await self._work_event.wait()
        finally:
            await self._queue.put(None)

    async def send_audio(self, pcm: bytes):
        if self._closed or not pcm:
            return
        chunk_ms = max(1, len(pcm) // BYTES_PER_MS)
        has_voice = pcm_has_speech(pcm)

        if not self._in_speech:
            if has_voice:
                self._in_speech = True
                pre_bytes = b"".join(self._pre_roll)
                self._pre_roll.clear()
                pre_ms = len(pre_bytes) // BYTES_PER_MS
                self._segment_start_ms = max(0, self._cursor_ms - pre_ms)
                self._speech_buf.clear()
                self._speech_buf.extend(pre_bytes)
                self._speech_buf.extend(pcm)
                self._speech_ms = chunk_ms
                self._silence_ms = 0
                self._last_partial_text = ""
                self._last_partial_wall = time.monotonic()
            else:
                self._pre_roll.append(pcm)
            self._cursor_ms += chunk_ms
            return

        self._speech_buf.extend(pcm)
        self._cursor_ms += chunk_ms
        if has_voice:
            self._speech_ms += chunk_ms
            self._silence_ms = 0
        else:
            self._silence_ms += chunk_ms

        utterance_ms = len(self._speech_buf) // BYTES_PER_MS
        should_finalize = (
            self._silence_ms >= _ENDPOINT_SILENCE_MS
            or utterance_ms >= _HARD_MAX_UTTERANCE_MS
            or (utterance_ms >= _SOFT_MAX_UTTERANCE_MS and self._silence_ms >= _SOFT_SILENCE_MS)
        )

        if should_finalize:
            self._enqueue_final()
            return

        now = time.monotonic()
        if (
            self._speech_ms >= _PARTIAL_MIN_AUDIO_MS
            and not self._final_jobs
            and (now - self._last_partial_wall) >= _PARTIAL_INTERVAL_WALL_S
        ):
            self._last_partial_wall = now
            self._pending_partial = (bytes(self._speech_buf), self._segment_start_ms, self._cursor_ms)
            self._work_event.set()

    def _enqueue_final(self):
        if not self._speech_buf:
            self._reset_segment()
            return
        speech_ms = self._speech_ms
        start_ms = self._segment_start_ms
        end_ms = max(start_ms, self._cursor_ms - min(self._silence_ms, _ENDPOINT_SILENCE_MS))
        pcm_payload = bytes(self._speech_buf)
        self._reset_segment()

        if speech_ms < _MIN_SPEECH_MS:
            return
        self._pending_partial = None
        self._final_jobs.append((pcm_payload, start_ms, end_ms))
        self._work_event.set()

    def _reset_segment(self):
        self._speech_buf.clear()
        self._in_speech = False
        self._speech_ms = 0
        self._silence_ms = 0
        self._last_partial_text = ""

    async def finish(self):
        if self._closed:
            return
        if self._in_speech and self._speech_buf:
            self._enqueue_final()
        self._pending_partial = None
        self._eof = True
        self._work_event.set()
        if self._worker_task is not None:
            await self._worker_task
        else:
            await self._queue.put(None)

    async def results(self) -> AsyncIterator[Transcript]:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            if isinstance(item, BaseException):
                raise item
            yield item

    async def close(self):
        if self._closed:
            return
        self._closed = True
        self._eof = True
        self._reset_segment()
        self._pre_roll.clear()
        self._final_jobs.clear()
        self._pending_partial = None
        self._work_event.set()
        if self._worker_task is not None:
            if not self._worker_task.done():
                self._worker_task.cancel()
            await asyncio.gather(self._worker_task, return_exceptions=True)
            self._worker_task = None
        await self._queue.put(None)
