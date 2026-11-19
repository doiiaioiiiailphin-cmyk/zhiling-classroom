from collections.abc import AsyncIterator
from datetime import UTC, datetime
import asyncio
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import tarfile

import httpx

from ..errors import AppError
from ..schemas import Aec3AddonStatus, iso_utc

logger = logging.getLogger(__name__)

AEC3_VERSION = "0.3.0"
AEC3_TARBALL_URLS = (
    "https://mirrors.huaweicloud.com/repository/npm/@ennuicastr/webrtcaec3.js/-/webrtcaec3.js-0.3.0.tgz",
    "https://registry.npmmirror.com/@ennuicastr/webrtcaec3.js/-/webrtcaec3.js-0.3.0.tgz",
    "https://registry.npmjs.org/@ennuicastr/webrtcaec3.js/-/webrtcaec3.js-0.3.0.tgz",
)
EXPECTED_WASM_SHA256 = "a2f432546daf1b366d04b4921e1a1cdf0d097da7722fb1d5fe553bed3cadb756"
EXPECTED_WASM_BYTES = 170_421
EXPECTED_JS_SHA256 = "2e90b0ab542eaff7f235f148fd5ae5df4608580ccba918dc01afe27d2880c4eb"
DEFAULT_TARBALL_BYTES = 309_218
MAX_TARBALL_BYTES = 2 * 1024 * 1024


def build_worklet_esm_wrapper(raw_js: str) -> bytes:
    lines = [line for line in raw_js.splitlines() if not line.startswith("WebRtcAec3Wasm=")]
    stripped = "\n".join(lines)
    wrapped = (
        "(function(process){\n"
        "var WebRtcAec3Wasm;\n"
        f"{stripped}\n"
        "globalThis.WebRtcAec3 = WebRtcAec3;\n"
        "})(undefined);\n"
    )
    return wrapped.encode("utf-8")


def _atomic_write(target: Path, data: bytes):
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


class WebRtcAec3AddonManager:
    def __init__(self, addons_root: Path):
        self.dir = addons_root / "webrtc-aec3"
        self.wasm_path = self.dir / "module.wasm"
        self.worklet_js_path = self.dir / "worklet-lib.js"
        self.license_path = self.dir / "license.txt"
        self.manifest_path = self.dir / "manifest.json"
        self._lock = asyncio.Lock()

    def status(self) -> Aec3AddonStatus:
        try:
            if not (self.wasm_path.is_file() and self.worklet_js_path.is_file()):
                return Aec3AddonStatus(
                    installed=False, version=AEC3_VERSION, size_bytes=DEFAULT_TARBALL_BYTES,
                )
            wasm_stat = self.wasm_path.stat()
            js_stat = self.worklet_js_path.stat()
            if wasm_stat.st_size != EXPECTED_WASM_BYTES or js_stat.st_size < 10_000:
                return Aec3AddonStatus(
                    installed=False, version=AEC3_VERSION, size_bytes=DEFAULT_TARBALL_BYTES,
                )
            with self.wasm_path.open("rb") as fh:
                magic = fh.read(4)
            if magic != b"\x00asm":
                return Aec3AddonStatus(
                    installed=False, version=AEC3_VERSION, size_bytes=DEFAULT_TARBALL_BYTES,
                )
            return Aec3AddonStatus(
                installed=True,
                version=AEC3_VERSION,
                size_bytes=wasm_stat.st_size + js_stat.st_size,
            )
        except OSError:
            return Aec3AddonStatus(
                installed=False, version=AEC3_VERSION, size_bytes=DEFAULT_TARBALL_BYTES,
            )

    def read_worklet_js(self) -> bytes:
        if not self.status().installed:
            raise AppError(404, "ADDON_NOT_INSTALLED", "WebRTC AEC3 组件尚未下载安装")
        return self.worklet_js_path.read_bytes()

    def read_wasm(self) -> bytes:
        if not self.status().installed:
            raise AppError(404, "ADDON_NOT_INSTALLED", "WebRTC AEC3 组件尚未下载安装")
        return self.wasm_path.read_bytes()

    async def download_stream(self, http: httpx.AsyncClient) -> AsyncIterator[dict]:
        current = self.status()
        if current.installed:
            yield {
                "type": "progress",
                "stage": "ready",
                "downloadedBytes": current.size_bytes,
                "totalBytes": current.size_bytes,
                "percent": 100,
            }
            yield {"type": "done", "data": current.wire()}
            return

        async with self._lock:
            current = self.status()
            if current.installed:
                yield {"type": "done", "data": current.wire()}
                return

            yield {
                "type": "progress",
                "stage": "connecting",
                "downloadedBytes": 0,
                "totalBytes": DEFAULT_TARBALL_BYTES,
                "percent": 2,
            }

            raw_tarball: bytes | None = None
            last_error = "网络请求未成功"
            timeout = httpx.Timeout(45.0, connect=10.0)

            for url in AEC3_TARBALL_URLS:
                try:
                    async with http.stream("GET", url, follow_redirects=True, timeout=timeout) as resp:
                        if resp.status_code != 200:
                            last_error = f"镜像返回 HTTP {resp.status_code}"
                            continue
                        header_len = resp.headers.get("content-length")
                        total = (
                            int(header_len)
                            if header_len and header_len.isdigit() and int(header_len) > 0
                            else DEFAULT_TARBALL_BYTES
                        )
                        if total > MAX_TARBALL_BYTES:
                            last_error = "远端组件体积异常"
                            continue

                        buf = bytearray()
                        last_percent = 2
                        async for chunk in resp.aiter_bytes(16_384):
                            if not chunk:
                                continue
                            buf.extend(chunk)
                            if len(buf) > MAX_TARBALL_BYTES:
                                raise ValueError("组件体积超出安全上限")
                            pct = min(90, max(5, int(len(buf) * 90 / max(total, 1))))
                            if pct >= last_percent + 4 or len(buf) == total:
                                last_percent = pct
                                yield {
                                    "type": "progress",
                                    "stage": "downloading",
                                    "downloadedBytes": len(buf),
                                    "totalBytes": max(total, len(buf)),
                                    "percent": pct,
                                }
                        raw_tarball = bytes(buf)
                        break
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning("WebRTC AEC3 mirror failed (%s): %s", url, type(exc).__name__)
                    last_error = str(exc) or type(exc).__name__

            if not raw_tarball:
                raise AppError(502, "ADDON_DOWNLOAD_FAILED", f"WebRTC AEC3 下载失败：{last_error}")

            yield {
                "type": "progress",
                "stage": "verifying",
                "downloadedBytes": len(raw_tarball),
                "totalBytes": len(raw_tarball),
                "percent": 95,
            }

            await asyncio.to_thread(self._extract_and_install, raw_tarball)
            final_status = self.status()
            if not final_status.installed:
                raise AppError(500, "ADDON_INSTALL_FAILED", "WebRTC AEC3 组件校验或写入失败")

            yield {
                "type": "progress",
                "stage": "ready",
                "downloadedBytes": len(raw_tarball),
                "totalBytes": len(raw_tarball),
                "percent": 100,
            }
            yield {"type": "done", "data": final_status.wire()}

    def _extract_and_install(self, raw_tarball: bytes):
        try:
            with tarfile.open(fileobj=io.BytesIO(raw_tarball), mode="r:gz") as tf:
                wasm_member = tf.extractfile(f"package/dist/webrtcaec3-{AEC3_VERSION}.wasm")
                js_member = tf.extractfile(f"package/dist/webrtcaec3-{AEC3_VERSION}.js")
                lic_member = tf.extractfile("package/license.js")
                if wasm_member is None or js_member is None:
                    raise AppError(502, "ADDON_INVALID_ARCHIVE", "下载的组件包缺少核心模块文件")
                wasm_bytes = wasm_member.read()
                js_bytes = js_member.read()
                license_bytes = lic_member.read() if lic_member is not None else b""
        except (tarfile.TarError, KeyError, OSError) as exc:
            raise AppError(502, "ADDON_INVALID_ARCHIVE", "下载的 WebRTC AEC3 压缩包损坏") from exc

        wasm_sha = hashlib.sha256(wasm_bytes).hexdigest()
        js_sha = hashlib.sha256(js_bytes).hexdigest()
        if len(wasm_bytes) != EXPECTED_WASM_BYTES or wasm_sha != EXPECTED_WASM_SHA256:
            raise AppError(502, "ADDON_HASH_MISMATCH", "WebRTC AEC3 WASM 模块完整性校验未通过")
        if js_sha != EXPECTED_JS_SHA256:
            raise AppError(502, "ADDON_HASH_MISMATCH", "WebRTC AEC3 脚本模块完整性校验未通过")

        worklet_js_bytes = build_worklet_esm_wrapper(js_bytes.decode("utf-8"))
        self.dir.mkdir(parents=True, exist_ok=True)
        _atomic_write(self.wasm_path, wasm_bytes)
        _atomic_write(self.worklet_js_path, worklet_js_bytes)
        if license_bytes:
            _atomic_write(self.license_path, license_bytes)
        manifest = {
            "version": AEC3_VERSION,
            "installedAt": iso_utc(datetime.now(UTC)),
            "wasmSha256": wasm_sha,
            "jsSha256": js_sha,
            "sizeBytes": len(wasm_bytes) + len(worklet_js_bytes),
        }
        _atomic_write(
            self.manifest_path,
            json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
        )

