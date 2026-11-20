"""本地离线 SenseVoice-Small (sherpa-onnx) 实时流式语音识别适配器。

将连续的 16kHz / 16-bit signed LE / mono PCM 音频流切分为带前导预缓冲的自然语句：
- 说话期间每 ~0.95 秒产出一次实时 partial 预览字幕；
- 检测到句末静音（>= 720ms）或单句达到最大时长（12 秒）时产出带标点的 final 转写句；
- 导入离线录音文件时由于音频块高速灌入，自动跳过多余的 partial 预览，直接以 10x–30x 实时速度全速转写。
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

_PRE_ROLL_CHUNKS = 15          # 15 * 20ms = 300ms 前导缓冲，避免吃掉首字
_MIN_SPEECH_MS = 280           # 忽略极短瞬态噪声
_ENDPOINT_SILENCE_MS = 720     # 句末静音判定阈值
_SOFT_MAX_UTTERANCE_MS = 8_000 # 8 秒以上遇短停顿（>= 240ms）即断句
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
        # 确保模型已加载就绪（若此前已预热则直接命中缓存，耗时 < 1ms）
        await asyncio.to_thread(runtime.get_recognizer, self.options.language)
        self._started = True
        self._last_partial_wall = time.monotonic()

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

        # 正在说话状态中
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
            await self._flush_final()
            return

        now = time.monotonic()
        if (
            self._speech_ms >= _PARTIAL_MIN_AUDIO_MS
            and (now - self._last_partial_wall) >= _PARTIAL_INTERVAL_WALL_S
        ):
            self._last_partial_wall = now
            await self._emit_partial()

    async def _emit_partial(self):
        if not self._speech_buf or self._closed:
            return
        runtime = self._resolve_runtime()
        snapshot = bytes(self._speech_buf)
        start_ms = self._segment_start_ms
        end_ms = self._cursor_ms
        try:
            text = await asyncio.to_thread(runtime.decode_pcm, snapshot, self.options.language)
        except Exception as exc:
            logger.warning("Local SenseVoice partial decode error: %s", exc)
            return
        if text and text != self._last_partial_text and not self._closed:
            self._last_partial_text = text
            await self._queue.put(
                Transcript(text=text, final=False, start_ms=start_ms, end_ms=end_ms)
            )

    async def _flush_final(self):
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

        runtime = self._resolve_runtime()
        try:
            text = await asyncio.to_thread(runtime.decode_pcm, pcm_payload, self.options.language)
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

    def _reset_segment(self):
        self._speech_buf.clear()
        self._in_speech = False
        self._speech_ms = 0
        self._silence_ms = 0
        self._last_partial_text = ""

    async def finish(self):
        if self._closed:
            return
        try:
            if self._in_speech and self._speech_buf:
                await self._flush_final()
        finally:
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
        self._reset_segment()
        self._pre_roll.clear()
        await self._queue.put(None)
