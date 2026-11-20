import asyncio
import base64
import ctypes
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
from uuid import uuid4
import zlib

from ..errors import AppError
from ..repository import Repository
from ..schemas import CaptureScreenRequest, SessionAttachmentItem

SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
ALLOWED_IMAGE_MIMES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
TEXT_EXTENSIONS = {".md", ".txt", ".csv", ".json", ".py", ".cpp", ".c", ".h", ".hpp", ".java", ".ts", ".js", ".tex"}


def parse_image_dimensions(data: bytes, mime_type: str) -> tuple[int | None, int | None]:
    try:
        if mime_type == "image/png" and len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", data[16:24])
            return int(w), int(h)
        if mime_type == "image/gif" and len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", data[6:10])
            return int(w), int(h)
        if mime_type == "image/jpeg" and len(data) > 4 and data[:2] == b"\xff\xd8":
            idx = 2
            while idx + 9 < len(data):
                if data[idx] != 0xFF:
                    idx += 1
                    continue
                marker = data[idx + 1]
                if marker == 0xFF:
                    idx += 1
                    continue
                if marker in (0xD8, 0xD9):
                    idx += 2
                    continue
                seg_len = struct.unpack(">H", data[idx + 2:idx + 4])[0]
                if seg_len < 2:
                    break
                if marker in (0xC0, 0xC1, 0xC2, 0xC3) and idx + 9 <= len(data):
                    h, w = struct.unpack(">HH", data[idx + 5:idx + 9])
                    return int(w), int(h)
                idx += 2 + seg_len
        if mime_type == "image/webp" and len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8X" and len(data) >= 30:
                w = 1 + int.from_bytes(data[24:27], "little")
                h = 1 + int.from_bytes(data[27:30], "little")
                return w, h
    except (struct.error, ValueError):
        pass
    return None, None


def encode_rgb_to_png(rgb_bytes: bytes, width: int, height: int) -> bytes:
    """Fast pure-Python PNG encoder for 24-bit RGB scanlines."""
    stride = width * 3
    raw = bytearray((stride + 1) * height)
    mv_src = memoryview(rgb_bytes)
    mv_dst = memoryview(raw)
    out_pos = 0
    for y in range(height):
        raw[out_pos] = 0  # Filter type 0 (None)
        src_start = y * stride
        mv_dst[out_pos + 1:out_pos + 1 + stride] = mv_src[src_start:src_start + stride]
        out_pos += 1 + stride

    def png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(chunk_type)
        crc = zlib.crc32(payload, crc) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    compressed = zlib.compress(bytes(raw), level=3)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", compressed) + png_chunk(b"IEND", b"")


def _extract_pdf_text_fallback(data: bytes, max_chars: int = 24000) -> str:
    """Lightweight pure-stdlib PDF text literal extractor for courseware slides."""
    pieces: list[str] = []
    total = 0

    def harvest_stream(buf: bytes):
        nonlocal total
        for match in re.finditer(rb"\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj", buf):
            raw_str = match.group(1)
            text = raw_str.decode("utf-8", errors="ignore").strip()
            if text:
                pieces.append(text)
                total += len(text)
                if total >= max_chars:
                    return

    harvest_stream(data)
    for stream_match in re.finditer(rb"stream\r?\n([\s\S]{1,524288}?)\r?\nendstream", data):
        if total >= max_chars:
            break
        blob = stream_match.group(1)
        try:
            inflated = zlib.decompress(blob)
            harvest_stream(inflated)
        except zlib.error:
            continue
    return "\n".join(pieces)[:max_chars].strip()


def extract_material_text(file_name: str, mime_type: str, data: bytes) -> str:
    suffix = Path(file_name).suffix.lower()
    if suffix == ".pdf" or mime_type == "application/pdf":
        text = _extract_pdf_text_fallback(data)
        return text or f"（已挂载 PDF 讲义文件：{file_name}）"
    if suffix in TEXT_EXTENSIONS or mime_type.startswith("text/"):
        for enc in ("utf-8", "utf-8-sig", "gb18030"):
            try:
                return data.decode(enc)[:24000].strip()
            except UnicodeDecodeError:
                continue
    raise AppError(400, "UNSUPPORTED_ATTACHMENT", "仅支持上传 PNG/JPG/WebP 图片，或 MD/TXT/PDF/代码讲义文件")


def capture_macos_desktop_png() -> tuple[bytes, int, int]:
    """使用 macOS 内置 screencapture 静默抓拍主屏为 PNG（支持 Retina 高分屏）。"""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        proc = subprocess.run(
            ["/usr/sbin/screencapture", "-x", "-t", "png", str(tmp_path)],
            capture_output=True,
            timeout=10.0,
            check=False,
        )
        if proc.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size == 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace").strip()
            raise AppError(
                403,
                "MACOS_SCREEN_PERMISSION_REQUIRED",
                "桌面抓拍失败：请在「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」中授权知聆课堂"
                + (f"（{err_msg}）" if err_msg else ""),
            )
        data = tmp_path.read_bytes()
        width, height = parse_image_dimensions(data, "image/png")
        if not width or not height:
            raise AppError(500, "SCREEN_CAPTURE_FAILED", "无法解析 macOS 截图尺寸")
        return data, width, height
    except FileNotFoundError:
        raise AppError(500, "SCREEN_CAPTURE_UNSUPPORTED", "未找到 macOS 系统 screencapture 工具") from None
    except subprocess.TimeoutExpired:
        raise AppError(504, "SCREEN_CAPTURE_TIMEOUT", "macOS 桌面抓拍超时，请检查屏幕录制权限弹窗") from None
    finally:
        tmp_path.unlink(missing_ok=True)


def capture_desktop_png() -> tuple[bytes, int, int]:
    if sys.platform == "darwin":
        return capture_macos_desktop_png()
    if sys.platform == "win32":
        return capture_windows_desktop_png()
    raise AppError(400, "SCREEN_CAPTURE_UNSUPPORTED", "当前操作系统不支持原生桌面抓屏，请使用浏览器画面抓拍或粘贴截图")


def capture_windows_desktop_png() -> tuple[bytes, int, int]:
    if sys.platform != "win32":
        raise AppError(400, "SCREEN_CAPTURE_UNSUPPORTED", "当前操作系统不支持原生桌面抓屏，请使用浏览器画面抓拍或粘贴截图")
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    user32.GetSystemMetrics.restype = ctypes.c_int
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.ReleaseDC.restype = ctypes.c_int

    gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.DeleteDC.argtypes = [wintypes.HDC]
    gdi32.DeleteDC.restype = wintypes.BOOL
    gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
    gdi32.SelectObject.restype = wintypes.HGDIOBJ
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    gdi32.BitBlt.argtypes = [
        wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD,
    ]
    gdi32.BitBlt.restype = wintypes.BOOL
    gdi32.GetDIBits.argtypes = [
        wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT,
    ]
    gdi32.GetDIBits.restype = ctypes.c_int

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

    SM_XVIRTUALSCREEN = 76
    SM_YVIRTUALSCREEN = 77
    SM_CXVIRTUALSCREEN = 78
    SM_CYVIRTUALSCREEN = 79
    SRCCOPY = 0x00CC0020
    DIB_RGB_COLORS = 0

    left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN) or user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN) or user32.GetSystemMetrics(1)
    if width <= 0 or height <= 0:
        raise AppError(500, "SCREEN_CAPTURE_FAILED", "无法获取当前屏幕分辨率")

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    hdc_screen = user32.GetDC(0)
    if not hdc_screen:
        raise AppError(500, "SCREEN_CAPTURE_FAILED", "无法访问桌面显示上下文")
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    old_obj = gdi32.SelectObject(hdc_mem, hbmp)
    try:
        if not gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, left, top, SRCCOPY):
            raise AppError(500, "SCREEN_CAPTURE_FAILED", "桌面画面复制失败")
        bmi = BITMAPINFOHEADER()
        bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        bmi.biWidth = width
        bmi.biHeight = -height  # Top-down scanlines
        bmi.biPlanes = 1
        bmi.biBitCount = 32
        bmi.biCompression = 0

        bgra = ctypes.create_string_buffer(width * height * 4)
        rows = gdi32.GetDIBits(hdc_mem, hbmp, 0, height, bgra, ctypes.byref(bmi), DIB_RGB_COLORS)
        if rows != height:
            raise AppError(500, "SCREEN_CAPTURE_FAILED", "读取屏幕像素缓冲区失败")

        raw_bgra = memoryview(bgra.raw)
        rgb = bytearray(width * height * 3)
        rgb[0::3] = raw_bgra[2::4]
        rgb[1::3] = raw_bgra[1::4]
        rgb[2::3] = raw_bgra[0::4]
        return encode_rgb_to_png(bytes(rgb), width, height), width, height
    finally:
        if old_obj:
            gdi32.SelectObject(hdc_mem, old_obj)
        if hbmp:
            gdi32.DeleteObject(hbmp)
        if hdc_mem:
            gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(0, hdc_screen)


class AttachmentStorage:
    def __init__(self, directory: Path, repo: Repository, screen_capturer=None):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.repo = repo
        self.screen_capturer = screen_capturer or capture_desktop_png

    def _session_dir(self, session_id: str) -> Path:
        if not SAFE_ID.fullmatch(session_id):
            raise AppError(400, "INVALID_SESSION_ID", "课堂 ID 格式无效")
        folder = (self.directory / session_id).resolve()
        if self.directory not in folder.parents:
            raise AppError(400, "INVALID_SESSION_ID", "课堂附件路径越界")
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    async def save_uploaded(
        self,
        *,
        session_id: str,
        file_name: str,
        mime_type: str,
        data: bytes,
        kind: str | None = None,
        segment_id: str | None = None,
        timestamp_ms: int | None = None,
        caption: str | None = None,
    ) -> SessionAttachmentItem:
        if not data:
            raise AppError(400, "EMPTY_ATTACHMENT", "上传的附件内容为空")
        if len(data) > MAX_UPLOAD_BYTES:
            raise AppError(400, "ATTACHMENT_TOO_LARGE", "单个附件不能超过 20 MB")

        normalized_mime = (mime_type or "application/octet-stream").split(";")[0].strip().lower()
        attachment_id = uuid4().hex

        if normalized_mime in ALLOWED_IMAGE_MIMES:
            ext = ALLOWED_IMAGE_MIMES[normalized_mime]
            resolved_kind = kind if kind in ("screenshot", "image") else "image"
            width, height = parse_image_dimensions(data, normalized_mime)
            extracted_text = None
        else:
            ext = Path(file_name).suffix.lower()[:12] or ".txt"
            resolved_kind = "material"
            width, height = None, None
            extracted_text = extract_material_text(file_name, normalized_mime, data)

        dest = self._session_dir(session_id) / f"{attachment_id}{ext}"
        await asyncio.to_thread(dest.write_bytes, data)
        try:
            return await self.repo.create_attachment(
                attachment_id=attachment_id,
                session_id=session_id,
                segment_id=segment_id,
                kind=resolved_kind,
                file_name=file_name or f"attachment{ext}",
                mime_type=normalized_mime,
                file_path=str(dest),
                size_bytes=len(data),
                width=width,
                height=height,
                timestamp_ms=timestamp_ms,
                caption=caption,
                extracted_text=extracted_text,
            )
        except BaseException:
            dest.unlink(missing_ok=True)
            raise

    async def capture_screen(
        self, session_id: str, req: CaptureScreenRequest,
    ) -> SessionAttachmentItem:
        png_bytes, width, height = await asyncio.to_thread(self.screen_capturer)
        attachment_id = uuid4().hex
        dest = self._session_dir(session_id) / f"{attachment_id}.png"
        await asyncio.to_thread(dest.write_bytes, png_bytes)
        try:
            return await self.repo.create_attachment(
                attachment_id=attachment_id,
                session_id=session_id,
                segment_id=req.segment_id,
                kind="screenshot",
                file_name=f"screen_{attachment_id[:8]}.png",
                mime_type="image/png",
                file_path=str(dest),
                size_bytes=len(png_bytes),
                width=width,
                height=height,
                timestamp_ms=req.timestamp_ms,
                caption=req.caption,
            )
        except BaseException:
            dest.unlink(missing_ok=True)
            raise

    async def read_raw(self, session_id: str, attachment_id: str) -> tuple[bytes, str, str]:
        meta, raw_path = await self.repo.get_attachment_row(session_id, attachment_id)
        path = Path(raw_path).resolve()
        if self.directory not in path.parents or not path.is_file():
            raise AppError(404, "NOT_FOUND", "附件文件不存在或已被移除")
        data = await asyncio.to_thread(path.read_bytes)
        return data, meta.mime_type, meta.file_name

    async def load_base64_image(self, raw_path: str) -> str:
        path = Path(raw_path).resolve()
        if self.directory not in path.parents or not path.is_file():
            raise AppError(404, "NOT_FOUND", "所引用的课堂图片不存在")
        data = await asyncio.to_thread(path.read_bytes)
        return base64.b64encode(data).decode("ascii")

    async def remove(self, session_id: str, attachment_id: str):
        raw_path = await self.repo.delete_attachment(session_id, attachment_id)
        path = Path(raw_path).resolve()
        if self.directory in path.parents:
            await asyncio.to_thread(path.unlink, missing_ok=True)

    async def cleanup_session_dir(self, session_id: str):
        if not SAFE_ID.fullmatch(session_id):
            return
        folder = (self.directory / session_id).resolve()
        if self.directory in folder.parents and folder.is_dir():
            def _rm():
                for child in folder.iterdir():
                    if child.is_file():
                        child.unlink(missing_ok=True)
                folder.rmdir()
            try:
                await asyncio.to_thread(_rm)
            except OSError:
                pass
