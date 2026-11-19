import asyncio
from array import array
import io
import os
import re
import struct
import sys
import wave
from collections.abc import Awaitable, Callable
from pathlib import Path

from ..errors import AppError
from ..providers.asr.base import BYTES_PER_MS, SAMPLE_RATE
from ..repository import Repository

WAV_HEADER = struct.Struct("<4sI4s4sIHHIIHH4sI")
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def wav_header(byte_count: int) -> bytes:
    return WAV_HEADER.pack(
        b"RIFF", 36 + byte_count, b"WAVE", b"fmt ", 16, 1, 1,
        SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16, b"data", byte_count,
    )


class AudioArchive:
    def __init__(self, path: Path):
        self.path = path
        self.file = path.open("r+b") if path.exists() else path.open("x+b")
        try:
            size = self.file.seek(0, os.SEEK_END)
            self.byte_count = max(0, size - WAV_HEADER.size) & ~1
            if size:
                self.file.seek(0)
                header = self.file.read(WAV_HEADER.size)
                if header[:4] != b"RIFF" or header[8:40] != wav_header(0)[8:40]:
                    raise OSError("Unsupported WAV archive")
                self.file.truncate(self.byte_count + WAV_HEADER.size)
            self.checkpoint()
        except BaseException:
            self.file.close()
            raise

    def append(self, data: bytes):
        if self.byte_count + len(data) > 0xFFFFFFFF - 36:
            raise OSError("WAV archive reached RIFF size limit")
        self.file.write(data)
        self.byte_count += len(data)

    def checkpoint(self):
        self.file.seek(0)
        self.file.write(wav_header(self.byte_count))
        self.file.seek(0, os.SEEK_END)
        self.file.flush()

    def close(self):
        try:
            self.checkpoint()
        finally:
            self.file.close()


class AudioStorage:
    def __init__(self, directory: Path):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)

    def path(self, session_id: str) -> Path:
        if not SAFE_ID.fullmatch(session_id):
            raise AppError(400, "INVALID_SESSION_ID", "课堂 ID 无法用于录音文件")
        path = self.directory / f"{session_id}.wav"
        if path.is_symlink():
            raise OSError("Symbolic link at managed recording path")
        return path

    def existing_duration_ms(self, session_id: str) -> int:
        path = self.path(session_id)
        try:
            return max(0, path.stat().st_size - WAV_HEADER.size) // BYTES_PER_MS
        except FileNotFoundError:
            return 0

    def read_wav_slice(
        self, session_id: str, range_header: str | None = None,
    ) -> tuple[bytes, int, dict[str, str]]:
        path = self.path(session_id)
        if not path.is_file():
            raise AppError(404, "AUDIO_NOT_FOUND", "该课堂暂无已保存的本地录音文件")
        file_size = path.stat().st_size
        if file_size <= WAV_HEADER.size:
            raise AppError(404, "AUDIO_NOT_FOUND", "该课堂录音文件尚未写入有效音频采样")
        pcm_bytes = (file_size - WAV_HEADER.size) & ~1
        total_size = WAV_HEADER.size + pcm_bytes
        fresh_header = wav_header(pcm_bytes)

        start = 0
        end = total_size - 1
        status = 200
        if range_header:
            m = RANGE_RE.match(range_header.strip())
            if m:
                s_str, e_str = m.group(1), m.group(2)
                if s_str == "" and e_str != "":
                    suffix_len = int(e_str)
                    start = max(0, total_size - suffix_len)
                elif s_str != "":
                    start = int(s_str)
                    if e_str != "":
                        end = min(total_size - 1, int(e_str))
                if start >= total_size or start > end:
                    return b"", 416, {
                        "Content-Range": f"bytes */{total_size}",
                        "Accept-Ranges": "bytes",
                    }
                status = 206

        # Limit single chunk read to 4 MB so browser <audio> seeks snappily
        if status == 206 and end - start + 1 > 4 * 1024 * 1024:
            end = start + 4 * 1024 * 1024 - 1

        chunks: list[bytes] = []
        if start < WAV_HEADER.size:
            hdr_end = min(WAV_HEADER.size - 1, end)
            chunks.append(fresh_header[start:hdr_end + 1])

        if end >= WAV_HEADER.size:
            file_start = max(WAV_HEADER.size, start)
            read_len = end - file_start + 1
            with path.open("rb") as fp:
                fp.seek(file_start)
                chunks.append(fp.read(read_len))

        body = b"".join(chunks)
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-store",
        }
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{start + len(body) - 1}/{total_size}"
        return body, status, headers

    def read_pcm_window(self, session_id: str, start_ms: int, end_ms: int) -> bytes:
        path = self.path(session_id)
        if not path.is_file():
            raise AppError(404, "AUDIO_NOT_FOUND", "该课堂暂无本地录音文件")
        file_size = path.stat().st_size
        pcm_total = max(0, (file_size - WAV_HEADER.size) & ~1)
        byte_start = min(pcm_total, max(0, start_ms * BYTES_PER_MS) & ~1)
        byte_end = min(pcm_total, max(byte_start, end_ms * BYTES_PER_MS) & ~1)
        if byte_end <= byte_start:
            return b""
        with path.open("rb") as fp:
            fp.seek(WAV_HEADER.size + byte_start)
            return fp.read(byte_end - byte_start)

    async def recover_deletions(self, repo: Repository):
        for pending in self.directory.glob("*.wav.deleting"):
            session_id = pending.name.removesuffix(".wav.deleting")
            if not SAFE_ID.fullmatch(session_id) or pending.is_symlink():
                continue
            try:
                await repo.stream_state(session_id)
            except AppError as error:
                if error.status != 404:
                    raise
                pending.unlink(missing_ok=True)
            else:
                path = self.path(session_id)
                if path.exists():
                    pending.unlink(missing_ok=True)
                else:
                    pending.replace(path)

    async def delete_session(self, repo: Repository, session_id: str):
        # Move the recording out of the way before committing the database cascade.
        path = self.path(session_id)
        pending = path.with_suffix(".wav.deleting")
        moved = False
        if path.exists():
            path.replace(pending)
            moved = True
        try:
            await repo.delete_session(session_id)
        except BaseException:
            if moved:
                pending.replace(path)
            raise
        if moved:
            pending.unlink()


class WebmDecoder:
    def __init__(self, on_pcm: Callable[[bytes], Awaitable[None]]):
        self.on_pcm = on_pcm
        self.process: asyncio.subprocess.Process | None = None
        self.reader: asyncio.Task | None = None

    @staticmethod
    def decode_error() -> AppError:
        return AppError(400, "INVALID_WEBM_AUDIO", "无法解码 WebM 音频，请发送包含容器头的 Opus 音频流")

    async def start(self):
        options = {"creationflags": 0x08000000} if os.name == "nt" else {}
        try:
            self.process = await asyncio.create_subprocess_exec(
                "ffmpeg", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "pipe",
                "-f", "matroska", "-probesize", "32768", "-analyzeduration", "0", "-i", "pipe:0",
                "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                **options,
            )
        except (FileNotFoundError, NotImplementedError):
            raise AppError(400, "FFMPEG_REQUIRED", "WebM 音频需要 FFmpeg，请安装 FFmpeg 或发送 PCM") from None
        self.reader = asyncio.create_task(self.read_pcm())

    async def read_pcm(self):
        carry = b""
        while piece := await self.process.stdout.read(6400):
            pcm = carry + piece
            count = len(pcm) & ~1
            if count:
                await self.on_pcm(pcm[:count])
            carry = pcm[count:]
        if (await self.process.wait()) != 0:
            raise self.decode_error()

    async def send(self, payload: bytes):
        if self.reader.done():
            await self.reader
            raise self.decode_error()
        try:
            async with asyncio.timeout(4):
                self.process.stdin.write(payload)
                await self.process.stdin.drain()
        except (ConnectionError, TimeoutError):
            raise self.decode_error() from None

    async def finish(self):
        self.process.stdin.close()
        try:
            async with asyncio.timeout(5):
                await asyncio.shield(self.reader)
        except TimeoutError:
            raise self.decode_error() from None
        finally:
            await self.close()

    async def close(self):
        if self.process is None:
            return
        if self.process.returncode is None:
            try:
                self.process.kill()
            except ProcessLookupError:
                pass
        tasks = (self.reader,) if self.reader is not None else ()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.process.wait()


def _decode_wav_to_pcm16k_mono(data: bytes) -> bytes:
    try:
        with wave.open(io.BytesIO(data), "rb") as wf:
            channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            nframes = wf.getnframes()
            if channels < 1 or framerate < 1000:
                raise ValueError("Invalid WAV params")
            if channels == 1 and sampwidth == 2 and framerate == SAMPLE_RATE:
                raw = wf.readframes(nframes)
                return raw[: len(raw) & ~1]

            raw = wf.readframes(nframes)
            mono_samples = array("h")
            frame_stride = channels * sampwidth
            total_frames = len(raw) // frame_stride

            if sampwidth == 2 and channels == 1:
                mono_samples.frombytes(raw[: total_frames * 2])
                if sys.byteorder == "big":
                    mono_samples.byteswap()
            elif sampwidth == 2:
                src = array("h")
                src.frombytes(raw[: total_frames * channels * 2])
                if sys.byteorder == "big":
                    src.byteswap()
                for idx in range(0, len(src), channels):
                    acc = 0
                    for c in range(channels):
                        acc += src[idx + c]
                    mono_samples.append(acc // channels)
            elif sampwidth == 1:
                for idx in range(0, total_frames * channels, channels):
                    acc = 0
                    for c in range(channels):
                        acc += (raw[idx + c] - 128) << 8
                    mono_samples.append(max(-32768, min(32767, acc // channels)))
            elif sampwidth in (3, 4):
                mv = memoryview(raw)
                for f_idx in range(total_frames):
                    acc = 0
                    base = f_idx * frame_stride
                    for c in range(channels):
                        off = base + c * sampwidth
                        if sampwidth == 3:
                            val = int.from_bytes(mv[off:off + 3], "little", signed=True) >> 8
                        else:
                            val = int.from_bytes(mv[off:off + 4], "little", signed=True) >> 16
                        acc += val
                    mono_samples.append(max(-32768, min(32767, acc // channels)))
            else:
                raise ValueError("Unsupported sample width")

            if framerate == SAMPLE_RATE:
                out = mono_samples
            else:
                out_len = max(1, int(len(mono_samples) * SAMPLE_RATE / framerate))
                out = array("h")
                ratio = framerate / SAMPLE_RATE
                max_idx = len(mono_samples) - 1
                for i in range(out_len):
                    pos = i * ratio
                    i0 = int(pos)
                    frac = pos - i0
                    s0 = mono_samples[min(max_idx, i0)]
                    s1 = mono_samples[min(max_idx, i0 + 1)]
                    out.append(int(s0 + (s1 - s0) * frac))

            if sys.byteorder == "big":
                out.byteswap()
            return out.tobytes()
    except (wave.Error, ValueError, EOFError) as err:
        raise AppError(400, "INVALID_AUDIO_FILE", "无法解析该 WAV 音频文件格式") from err


async def decode_media_to_pcm16k(data: bytes, file_name: str = "") -> bytes:
    if not data:
        raise AppError(400, "INVALID_AUDIO_FILE", "导入的音频文件为空")
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return await asyncio.to_thread(_decode_wav_to_pcm16k_mono, data)

    options = {"creationflags": 0x08000000} if os.name == "nt" else {}
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-i", "pipe:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **options,
        )
    except (FileNotFoundError, NotImplementedError):
        raise AppError(
            400,
            "FFMPEG_REQUIRED",
            f"解码 {Path(file_name).suffix or '该格式'} 需要浏览器音频解码或本机安装 FFmpeg",
        ) from None

    stdout, _ = await proc.communicate(data)
    if proc.returncode != 0 or not stdout:
        raise AppError(400, "INVALID_AUDIO_FILE", "无法从所选音视频文件中提取有效音轨")
    return stdout[: len(stdout) & ~1]
