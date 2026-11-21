"""本地离线语音识别模型管理与 SenseVoice-Small (sherpa-onnx) 推理运行时。

特性：
- 推理引擎 `sherpa-onnx` 随桌面端一起打包（Windows x64 / macOS arm64 & x86_64 均免动态签名风险）；
- 模型文件（SenseVoice-Small int8，约 239 MB，支持中/英/日/韩/粤语 + 自动标点与 ITN）在首次使用时按需下载，
  通过 SSE 实时上报真实字节进度，并自动在国内外镜像间容灾切换；
- 下载完成后永久缓存在用户应用目录，后续完全离线运行、零网络延迟、零 API Key / 额度限制。
"""
from __future__ import annotations

from array import array
import asyncio
from collections.abc import AsyncIterator
import hashlib
import importlib.util
import logging
import os
from pathlib import Path
import re
import sys
import threading
import time

import httpx

from ..errors import AppError

logger = logging.getLogger(__name__)

MODEL_DIRNAME = "sense-voice-small-int8"
MODEL_FILENAME = "model.int8.onnx"
TOKENS_FILENAME = "tokens.txt"
READY_MARKER = ".ready"
MODEL_EXPECTED_BYTES = 239_233_841
MODEL_SHA256 = "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"
TOKENS_SHA256 = "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"
CHUNK_BYTES = 131_072
CHUNK_TIMEOUT_SECONDS = 30.0
PROGRESS_INTERVAL_SECONDS = 0.12

MODEL_MIRRORS: tuple[str, ...] = (
    "https://www.modelscope.cn/models/poloniumrock/SenseVoiceSmallOnnx/resolve/master",
    "https://www.modelscope.cn/models/gomodels/sherpa-small/resolve/master/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main",
)

_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|>]+\|>")
_ACTIVE_RUNTIME: BuiltinAsrRuntime | None = None


def active_builtin_asr_runtime() -> BuiltinAsrRuntime | None:
    return _ACTIVE_RUNTIME


def _sherpa_available() -> bool:
    return importlib.util.find_spec("sherpa_onnx") is not None


def _normalize_sensevoice_language(language: str) -> str:
    value = (language or "auto").strip().lower()
    if value in {"zh", "en", "ja", "ko", "yue"}:
        return value
    return "auto"


def clean_sensevoice_text(text: str) -> str:
    cleaned = _SENSEVOICE_TAG_RE.sub("", text or "")
    return re.sub(r"\s+", " ", cleaned).strip()


try:
    import numpy as _np  # type: ignore
except ImportError:  # pragma: no cover
    _np = None


def pcm16le_to_floats(pcm: bytes):
    usable = len(pcm) - (len(pcm) % 2)
    if usable <= 0:
        return []
    if _np is not None:
        return _np.frombuffer(pcm[:usable], dtype="<i2").astype(_np.float32) * (1.0 / 32768.0)
    samples = array("h")
    samples.frombytes(pcm[:usable])
    if sys.byteorder == "big":
        samples.byteswap()
    inv = 1.0 / 32768.0
    return [sample * inv for sample in samples]


class BuiltinAsrRuntime:
    def __init__(
        self,
        root: Path,
        *,
        mirrors: tuple[str, ...] | None = None,
        verify_sha256: bool = True,
    ):
        global _ACTIVE_RUNTIME
        self.root = root
        self.model_dir = root / MODEL_DIRNAME
        self.mirrors = mirrors or MODEL_MIRRORS
        self.verify_sha256 = verify_sha256
        self._install_lock = asyncio.Lock()
        self._recognizer_lock = threading.Lock()
        self._recognizers: dict[str, object] = {}
        _ACTIVE_RUNTIME = self

    @property
    def model_path(self) -> Path:
        return self.model_dir / MODEL_FILENAME

    @property
    def tokens_path(self) -> Path:
        return self.model_dir / TOKENS_FILENAME

    @property
    def ready_marker(self) -> Path:
        return self.model_dir / READY_MARKER

    def ready(self) -> bool:
        if not _sherpa_available():
            return False
        try:
            return (
                self.ready_marker.is_file()
                and self.model_path.is_file()
                and self.tokens_path.is_file()
                and self.model_path.stat().st_size > 0
                and self.tokens_path.stat().st_size > 0
            )
        except OSError:
            return False

    def require(self) -> None:
        if not _sherpa_available():
            raise AppError(
                503,
                "ASR_DEPENDENCY_UNAVAILABLE",
                "当前运行环境缺少本地语音推理引擎 sherpa-onnx，请重新安装桌面应用",
            )
        if not self.ready():
            raise AppError(409, "ASR_ADDON_REQUIRED", "请先下载本地语音识别模型（SenseVoice）")

    def get_recognizer(self, language: str = "auto"):
        self.require()
        lang_key = _normalize_sensevoice_language(language)
        with self._recognizer_lock:
            cached = self._recognizers.get(lang_key)
            if cached is not None:
                return cached
            import sherpa_onnx  # type: ignore

            num_threads = min(4, max(1, (os.cpu_count() or 2) // 2 or 1))
            recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(self.model_path),
                tokens=str(self.tokens_path),
                num_threads=num_threads,
                sample_rate=16000,
                use_itn=True,
                language=lang_key,
                provider="cpu",
                debug=False,
            )
            self._recognizers[lang_key] = recognizer
            return recognizer

    def decode_pcm(self, pcm: bytes, language: str = "auto") -> str:
        floats = pcm16le_to_floats(pcm)
        if len(floats) == 0:
            return ""
        recognizer = self.get_recognizer(language)
        with self._recognizer_lock:
            stream = recognizer.create_stream()
            try:
                stream.accept_waveform(16000, floats)
                recognizer.decode_stream(stream)
                raw_text = getattr(stream.result, "text", "") or ""
            finally:
                del stream
        return clean_sensevoice_text(raw_text)

    def _warmup(self) -> None:
        self.get_recognizer("auto")

    async def download_stream(self, client: httpx.AsyncClient) -> AsyncIterator[dict]:
        if not _sherpa_available():
            raise AppError(
                503,
                "ASR_DEPENDENCY_UNAVAILABLE",
                "当前运行环境缺少本地语音推理引擎 sherpa-onnx，请重新安装桌面应用",
            )
        if self.ready():
            size = self.model_path.stat().st_size + self.tokens_path.stat().st_size
            yield {
                "type": "progress",
                "stage": "ready",
                "downloadedBytes": size,
                "totalBytes": size,
                "percent": 100,
            }
            yield {"type": "done", "data": True}
            return

        async with self._install_lock:
            if self.ready():
                size = self.model_path.stat().st_size + self.tokens_path.stat().st_size
                yield {
                    "type": "progress",
                    "stage": "ready",
                    "downloadedBytes": size,
                    "totalBytes": size,
                    "percent": 100,
                }
                yield {"type": "done", "data": True}
                return

            self.model_dir.mkdir(parents=True, exist_ok=True)
            tokens_part = self.model_dir / f"{TOKENS_FILENAME}.part"
            model_part = self.model_dir / f"{MODEL_FILENAME}.part"

            yield {
                "type": "progress",
                "stage": "connecting",
                "downloadedBytes": 0,
                "totalBytes": MODEL_EXPECTED_BYTES,
                "percent": 0,
            }

            last_error: Exception | None = None
            downloaded_ok = False
            final_total = MODEL_EXPECTED_BYTES

            for mirror in self.mirrors:
                base = mirror.rstrip("/")
                tokens_part.unlink(missing_ok=True)
                model_part.unlink(missing_ok=True)
                try:
                    # 1. 下载词表 tokens.txt（体积极小，同时可快速探活镜像）
                    tokens_bytes, tokens_digest = await self._download_small_file(
                        client, f"{base}/{TOKENS_FILENAME}", tokens_part
                    )
                    decoded_tokens = tokens_part.read_text(encoding="utf-8")
                    if not decoded_tokens.strip():
                        raise ValueError("tokens.txt is empty")
                    if self.verify_sha256 and tokens_digest != TOKENS_SHA256:
                        raise ValueError(f"tokens.txt checksum mismatch: {tokens_digest}")

                    # 2. 流式下载主模型 model.int8.onnx 并实时推送真实字节进度
                    model_bytes = 0
                    model_hasher = hashlib.sha256()
                    expected_model_bytes = MODEL_EXPECTED_BYTES
                    last_emit = 0.0
                    last_percent = -1

                    timeout = httpx.Timeout(connect=20.0, read=CHUNK_TIMEOUT_SECONDS, write=20.0, pool=20.0)
                    async with client.stream(
                        "GET",
                        f"{base}/{MODEL_FILENAME}",
                        follow_redirects=True,
                        timeout=timeout,
                    ) as response:
                        response.raise_for_status()
                        content_length = response.headers.get("content-length")
                        if content_length and content_length.isdigit() and int(content_length) > 0:
                            expected_model_bytes = int(content_length)
                        final_total = tokens_bytes + expected_model_bytes

                        with model_part.open("wb") as fh:
                            async for chunk in response.aiter_bytes(CHUNK_BYTES):
                                if not chunk:
                                    continue
                                fh.write(chunk)
                                model_hasher.update(chunk)
                                model_bytes += len(chunk)
                                combined = tokens_bytes + model_bytes
                                percent = min(99, int(combined * 100 / max(1, final_total)))
                                now = time.monotonic()
                                if (now - last_emit) >= PROGRESS_INTERVAL_SECONDS or percent > last_percent:
                                    last_emit = now
                                    last_percent = percent
                                    yield {
                                        "type": "progress",
                                        "stage": "downloading",
                                        "downloadedBytes": combined,
                                        "totalBytes": final_total,
                                        "percent": percent,
                                    }

                    if model_bytes <= 0:
                        raise ValueError("downloaded model file is empty")
                    if content_length and content_length.isdigit() and model_bytes != int(content_length):
                        raise ValueError(
                            f"incomplete model download: got {model_bytes}, expected {content_length}"
                        )
                    model_digest = model_hasher.hexdigest()
                    if self.verify_sha256 and model_digest != MODEL_SHA256:
                        raise ValueError(f"model.int8.onnx checksum mismatch: {model_digest}")

                    final_total = tokens_bytes + model_bytes
                    downloaded_ok = True
                    logger.info("Downloaded SenseVoice model (%d bytes) from %s", model_bytes, base)
                    break
                except (httpx.HTTPError, TimeoutError, OSError, ValueError) as exc:
                    last_error = exc
                    logger.warning("SenseVoice download failed from %s: %s", base, exc)
                    tokens_part.unlink(missing_ok=True)
                    model_part.unlink(missing_ok=True)

            if not downloaded_ok:
                raise AppError(
                    502,
                    "ASR_ADDON_DOWNLOAD_FAILED",
                    "本地语音模型下载失败，请检查网络连接后重试",
                ) from last_error

            yield {
                "type": "progress",
                "stage": "verifying",
                "downloadedBytes": final_total,
                "totalBytes": final_total,
                "percent": 99,
            }

            tokens_part.replace(self.tokens_path)
            model_part.replace(self.model_path)
            self.ready_marker.write_text("sense-voice-small-int8\n", encoding="utf-8")
            with self._recognizer_lock:
                self._recognizers.clear()

            yield {
                "type": "progress",
                "stage": "starting",
                "downloadedBytes": final_total,
                "totalBytes": final_total,
                "percent": 100,
            }

            try:
                await asyncio.to_thread(self._warmup)
            except Exception as exc:
                self.ready_marker.unlink(missing_ok=True)
                self.model_path.unlink(missing_ok=True)
                self.tokens_path.unlink(missing_ok=True)
                logger.warning("SenseVoice warmup failed: %s", exc)
                raise AppError(
                    500,
                    "ASR_MODEL_LOAD_FAILED",
                    "本地语音模型加载失败，文件可能已损坏，请重新下载",
                ) from exc

            yield {
                "type": "progress",
                "stage": "ready",
                "downloadedBytes": final_total,
                "totalBytes": final_total,
                "percent": 100,
            }
            yield {"type": "done", "data": True}

    async def _download_small_file(
        self, client: httpx.AsyncClient, url: str, target: Path
    ) -> tuple[int, str]:
        total = 0
        hasher = hashlib.sha256()
        timeout = httpx.Timeout(connect=20.0, read=CHUNK_TIMEOUT_SECONDS, write=20.0, pool=20.0)
        async with client.stream("GET", url, follow_redirects=True, timeout=timeout) as response:
            response.raise_for_status()
            with target.open("wb") as fh:
                async for chunk in response.aiter_bytes(65_536):
                    if chunk:
                        fh.write(chunk)
                        hasher.update(chunk)
                        total += len(chunk)
        return total, hasher.hexdigest()

    async def install(self, client: httpx.AsyncClient) -> None:
        async for _event in self.download_stream(client):
            pass
