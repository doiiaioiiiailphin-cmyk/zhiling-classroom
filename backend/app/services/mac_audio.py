"""macOS 原生音频设备枚举与 ScreenCaptureKit 免驱动系统内录服务。

与 Windows WASAPI 保持完全一致的流式输出契约：
- 设备查询返回 `NativeAudioDevices`（macOS 13+ 且内置 `ZhilingAudioCapture` 可用时 `wasapi_supported=True`）
- `/ws/v1/audio/loopback` 推送 `16000 Hz / 16-bit signed little-endian / mono` 裸 PCM，每帧 `640 bytes (20ms)`。
"""
import asyncio
import json
import logging
from pathlib import Path
import platform
import subprocess
import sys

from fastapi import WebSocket, WebSocketDisconnect

from ..schemas import NativeAudioDevices, NativeAudioEndpoint

logger = logging.getLogger(__name__)

LOOPBACK_FRAME_BYTES = 640  # 20ms @ 16kHz mono s16le


def _macos_major_version() -> int:
    if sys.platform != "darwin":
        return 0
    try:
        ver = platform.mac_ver()[0]
        return int(ver.split(".")[0]) if ver else 0
    except (ValueError, IndexError):
        return 0


def find_mac_audio_helper(
    *,
    bundle_dir: Path | None = None,
    repo_root: Path | None = None,
) -> Path | None:
    """定位编译后的 `ZhilingAudioCapture` 原生助手可执行文件。"""
    meipass = bundle_dir if bundle_dir is not None else (
        Path(getattr(sys, "_MEIPASS")) if getattr(sys, "_MEIPASS", None) else None
    )
    root = repo_root if repo_root is not None else Path(__file__).resolve().parents[3]
    candidates: list[Path] = []
    if meipass is not None:
        candidates.append(meipass / "bin" / "ZhilingAudioCapture")
        candidates.append(meipass / "ZhilingAudioCapture")
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        candidates.append(exe_dir / "ZhilingAudioCapture")
        candidates.append(exe_dir / "bin" / "ZhilingAudioCapture")
        contents = exe_dir.parent
        for sub in ("Frameworks", "Resources", "MacOS"):
            candidates.append(contents / sub / "bin" / "ZhilingAudioCapture")
            candidates.append(contents / sub / "ZhilingAudioCapture")
    candidates.append(root / "assets" / "macos" / "ZhilingAudioCapture")
    return next((p for p in candidates if p.is_file()), None)


def parse_helper_devices_json(raw: bytes | str) -> NativeAudioDevices:
    payload = json.loads(raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw)
    return NativeAudioDevices(
        platform=str(payload.get("platform") or "darwin"),
        wasapi_supported=bool(payload.get("wasapiSupported", False)),
        inputs=[
            NativeAudioEndpoint(
                id=str(item.get("id") or "default"),
                raw_id=str(item.get("rawId") or item.get("id") or "default"),
                name=str(item.get("name") or "系统麦克风"),
                is_default=bool(item.get("isDefault", False)),
                is_communications_default=bool(item.get("isCommunicationsDefault", False)),
            )
            for item in (payload.get("inputs") or [])
            if isinstance(item, dict)
        ],
        loopbacks=[
            NativeAudioEndpoint(
                id=str(item.get("id") or "default"),
                raw_id=str(item.get("rawId") or item.get("id") or "default"),
                name=str(item.get("name") or "macOS 系统内录"),
                is_default=bool(item.get("isDefault", False)),
                is_communications_default=bool(item.get("isCommunicationsDefault", False)),
            )
            for item in (payload.get("loopbacks") or [])
            if isinstance(item, dict)
        ],
    )


class MacAudioBackend:
    """macOS ScreenCaptureKit + CoreAudio 音频后端（兼容 WindowsAudioBackend 接口）。"""

    def __init__(self, helper_path: Path | None = None):
        self._helper_override = helper_path

    def _helper(self) -> Path | None:
        return self._helper_override or find_mac_audio_helper()

    async def list_devices(self) -> NativeAudioDevices:
        helper = self._helper()
        if helper is None:
            return NativeAudioDevices(
                platform="darwin",
                wasapi_supported=False,
                inputs=[],
                loopbacks=[],
            )
        try:
            proc = await asyncio.to_thread(
                subprocess.run,
                [str(helper), "--list-devices"],
                capture_output=True,
                timeout=4.0,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                parsed = parse_helper_devices_json(proc.stdout)
                if _macos_major_version() and _macos_major_version() < 13:
                    parsed.wasapi_supported = False
                return parsed
        except Exception as exc:
            logger.warning("macOS audio device enumeration failed: %s", exc)
        return NativeAudioDevices(
            platform="darwin",
            wasapi_supported=False,
            inputs=[],
            loopbacks=[],
        )

    async def serve_loopback(self, websocket: WebSocket, device_id: str = "default"):
        await websocket.accept()
        helper = self._helper()
        if helper is None:
            await websocket.send_json({
                "type": "error",
                "payload": {
                    "code": "MACOS_AUDIO_HELPER_MISSING",
                    "message": "当前版本未内置 macOS 系统内录助手，请使用共享屏幕音频或 BlackHole 虚拟声卡",
                },
            })
            await websocket.close(code=1008)
            return

        proc: asyncio.subprocess.Process | None = None
        stop_event = asyncio.Event()

        try:
            proc = await asyncio.create_subprocess_exec(
                str(helper),
                "--capture",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            async def watch_disconnect():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("type") == "websocket.disconnect":
                            break
                except WebSocketDisconnect:
                    pass
                finally:
                    stop_event.set()
                    if proc is not None and proc.returncode is None:
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass

            watcher = asyncio.create_task(watch_disconnect())
            buf = bytearray()
            try:
                assert proc.stdout is not None
                while not stop_event.is_set():
                    chunk = await proc.stdout.read(LOOPBACK_FRAME_BYTES * 4)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    while len(buf) >= LOOPBACK_FRAME_BYTES:
                        frame = bytes(buf[:LOOPBACK_FRAME_BYTES])
                        del buf[:LOOPBACK_FRAME_BYTES]
                        await websocket.send_bytes(frame)

                if not stop_event.is_set():
                    rc = await proc.wait()
                    err_text = ""
                    if proc.stderr is not None:
                        raw_err = await proc.stderr.read()
                        err_text = raw_err.decode("utf-8", errors="replace").strip()
                    if rc != 0:
                        code = (
                            "MACOS_AUDIO_PERMISSION_REQUIRED"
                            if "MACOS_AUDIO_PERMISSION_REQUIRED" in err_text
                            else "MACOS_LOOPBACK_FAILED"
                        )
                        clean_msg = (
                            err_text.split(":", 1)[1].strip()
                            if ":" in err_text
                            else (err_text or "macOS 系统内录异常中断，请检查屏幕与系统音频录制权限")
                        )
                        await websocket.send_json({
                            "type": "error",
                            "payload": {"code": code, "message": clean_msg},
                        })
            except WebSocketDisconnect:
                pass
            finally:
                stop_event.set()
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)
        finally:
            if proc is not None and proc.returncode is None:
                try:
                    proc.terminate()
                    await asyncio.wait_for(proc.wait(), timeout=1.5)
                except Exception:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
            try:
                await websocket.close()
            except Exception:
                pass
