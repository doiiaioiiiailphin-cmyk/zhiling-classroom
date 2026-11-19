import asyncio
import os
import sys
import sysconfig
from collections.abc import AsyncIterator
from contextlib import aclosing
from functools import cache
from pathlib import Path

from ...errors import AppError
from .base import SAMPLE_RATE, ASRStreamAdapter, Recognition, Transcript, asr_error


def _use_bundled_opus() -> None:
    if sys.platform != "win32":
        return
    bundle = getattr(sys, "_MEIPASS", None)
    directory = (
        Path(bundle) / "asr"
        if bundle
        else Path(__file__).resolve().parents[4] / "assets" / "opus" / sysconfig.get_platform()
    )
    if (directory / "opus.dll").is_file():
        # opuslib uses ctypes.util.find_library, which searches this process's PATH on Windows.
        path = os.environ.get("PATH", "")
        if path.split(os.pathsep, 1)[0] != str(directory):
            os.environ["PATH"] = os.pathsep.join(filter(None, (str(directory), path)))


@cache
def _doubao_config():
    from doubaoime_asr import ASRConfig

    config = ASRConfig(sample_rate=SAMPLE_RATE, channels=1)
    config.ensure_credentials()
    return config


class BuiltinFreeAsrAdapter(ASRStreamAdapter):
    """把 16 kHz 单声道 s16le PCM 送入豆包输入法流式识别。"""

    supports_diarization = False

    def __init__(self, options: Recognition):
        self.options = options
        self._audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        # Bound pending audio while leaving room for the end marker.
        self._audio_slots = asyncio.Semaphore(32)
        self._out_queue: asyncio.Queue[Transcript | Exception | None] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None
        self._has_audio = False
        self._finishing = False
        self._closed = False

    async def start(self) -> None:
        if self._closed or self._worker is not None:
            return
        ready: asyncio.Future[AppError | None] = asyncio.get_running_loop().create_future()

        def end_results(_: asyncio.Task[None]) -> None:
            if not ready.done():
                ready.cancel()
            self._out_queue.put_nowait(None)

        self._worker = asyncio.create_task(self._transcribe(ready))
        self._worker.add_done_callback(end_results)
        try:
            failure = await asyncio.shield(ready)
            if failure is not None:
                raise failure
        except (asyncio.CancelledError, AppError):
            await self.close()
            raise

    async def send_audio(self, pcm: bytes) -> None:
        worker = self._worker
        if not pcm or worker is None or worker.done() or self._finishing or self._closed:
            return
        try:
            async with asyncio.timeout(5):
                await self._audio_slots.acquire()
        except TimeoutError:
            if not worker.done():
                raise AppError(502, "ASR_BACKPRESSURE", "默认免登录语音处理音频超时") from None
            return
        if worker.done() or self._finishing or self._closed:
            self._audio_slots.release()
            return
        self._audio_queue.put_nowait(pcm)
        self._has_audio = True

    async def finish(self) -> None:
        worker = self._worker
        if self._closed or worker is None or worker.done():
            return
        if not self._has_audio:
            await self.close()
            return
        if not self._finishing:
            self._finishing = True
            self._audio_queue.put_nowait(None)
        try:
            async with asyncio.timeout(15):
                await asyncio.shield(worker)
        except TimeoutError:
            if not worker.done():
                self._out_queue.put_nowait(AppError(502, "ASR_DRAIN_TIMEOUT", "默认免登录语音收尾超时"))
                worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)

    async def results(self) -> AsyncIterator[Transcript]:
        while True:
            item = await self._out_queue.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._worker is None:
            self._out_queue.put_nowait(None)
        elif not self._worker.done():
            self._worker.cancel()
            await asyncio.gather(self._worker, return_exceptions=True)

    async def _audio_source(self) -> AsyncIterator[bytes]:
        while (pcm := await self._audio_queue.get()) is not None:
            self._audio_slots.release()
            yield pcm

    async def _transcribe(self, ready: asyncio.Future[AppError | None]) -> None:
        try:
            _use_bundled_opus()
            from doubaoime_asr import DoubaoASR, ResponseType
        except Exception:
            ready.set_result(AppError(
                503, "ASR_DEPENDENCY_UNAVAILABLE", "默认免登录语音需要 doubaoime-asr 和 Opus 运行库",
            ))
            return

        try:
            async with asyncio.timeout(25) as startup:
                # The SDK uses synchronous HTTP to obtain the initial device credentials.
                config = await asyncio.to_thread(_doubao_config)
                async with aclosing(DoubaoASR(config).transcribe_realtime(self._audio_source())) as stream:
                    async for response in stream:
                        if response.type == ResponseType.SESSION_STARTED:
                            startup.reschedule(None)
                            if not ready.done():
                                ready.set_result(None)
                        elif response.type == ResponseType.SESSION_FINISHED:
                            if self._finishing:
                                return
                            break
                        elif response.type == ResponseType.ERROR:
                            if "service discovery failure" in response.error_msg.lower():
                                raise AppError(502, "ASR_UPSTREAM_UNAVAILABLE", "默认语音服务暂时不可用，请稍后重试")
                            raise asr_error(message=response.error_msg)
                        elif response.type in (ResponseType.INTERIM_RESULT, ResponseType.FINAL_RESULT):
                            text = response.text.strip()
                            if text:
                                self._out_queue.put_nowait(Transcript(
                                    text=text, final=response.type == ResponseType.FINAL_RESULT,
                                ))
                    raise AppError(502, "ASR_STREAM_INTERRUPTED", "默认免登录语音连接提前结束")
        except TimeoutError:
            failure = AppError(502, "ASR_TIMEOUT", "默认免登录语音连接超时")
        except Exception as error:
            failure = error if isinstance(error, AppError) else asr_error(message=error)
            if failure.status == 401:
                _doubao_config.cache_clear()

        if ready.done():
            self._out_queue.put_nowait(failure)
        else:
            ready.set_result(failure)
