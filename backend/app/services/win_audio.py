import asyncio
import ctypes
from ctypes import HRESULT, POINTER, Structure, byref, c_int, c_longlong, c_short, c_ubyte, c_ulong, c_ushort, c_void_p
from ctypes.wintypes import DWORD, LPWSTR, UINT, WORD
import logging
import os
import sys
import threading
import time
import uuid

from fastapi import WebSocket, WebSocketDisconnect

from ..schemas import NativeAudioDevices, NativeAudioEndpoint

logger = logging.getLogger(__name__)

LOOPBACK_SAMPLE_RATE = 16_000
LOOPBACK_CHANNELS = 1
LOOPBACK_FRAME_SAMPLES = 320  # 20ms @ 16kHz
LOOPBACK_FRAME_BYTES = LOOPBACK_FRAME_SAMPLES * 2  # 640 bytes


if os.name == "nt":
    _ole32 = ctypes.WinDLL("ole32")

    class _GUID(Structure):
        _fields_ = [
            ("Data1", DWORD),
            ("Data2", WORD),
            ("Data3", WORD),
            ("Data4", c_ubyte * 8),
        ]

        @classmethod
        def from_str(cls, text: str) -> "_GUID":
            parsed = uuid.UUID(text)
            d1, d2, d3 = parsed.fields[:3]
            return cls(d1, d2, d3, (c_ubyte * 8)(*parsed.bytes[8:]))

    class _PROPERTYKEY(Structure):
        _fields_ = [("fmtid", _GUID), ("pid", DWORD)]

    class _PROPVARIANT(Structure):
        _fields_ = [
            ("vt", c_ushort),
            ("wReserved1", c_ushort),
            ("wReserved2", c_ushort),
            ("wReserved3", c_ushort),
            ("pwszVal", LPWSTR),
            ("pad", c_void_p),
        ]

    class _WAVEFORMATEX(Structure):
        _fields_ = [
            ("wFormatTag", WORD),
            ("nChannels", WORD),
            ("nSamplesPerSec", DWORD),
            ("nAvgBytesPerSec", DWORD),
            ("nBlockAlign", WORD),
            ("wBitsPerSample", WORD),
            ("cbSize", WORD),
        ]

    _CLSID_MMDeviceEnumerator = _GUID.from_str("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
    _IID_IMMDeviceEnumerator = _GUID.from_str("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
    _IID_IAudioClient = _GUID.from_str("{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}")
    _IID_IAudioCaptureClient = _GUID.from_str("{C8ADBD64-E71E-48A0-A4DE-185C395CD317}")
    _PKEY_Device_FriendlyName = _PROPERTYKEY(
        _GUID.from_str("{A45C254E-DF1C-4EFD-8020-67D146A850E0}"), 14,
    )

    _COINIT_MULTITHREADED = 0x0
    _CLSCTX_ALL = 0x17
    _E_RENDER = 0
    _E_CAPTURE = 1
    _E_CONSOLE = 0
    _E_COMMUNICATIONS = 2
    _DEVICE_STATE_ACTIVE = 0x00000001
    _STGM_READ = 0
    _AUDCLNT_SHAREMODE_SHARED = 0
    _AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
    _AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
    _AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
    _AUDCLNT_BUFFERFLAGS_SILENT = 0x2
    _WAVE_FORMAT_PCM = 1

    def _vtbl(ptr: c_void_p, index: int, restype, *argtypes):
        table = ctypes.cast(ptr, POINTER(POINTER(c_void_p))).contents
        fn_type = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)
        return fn_type(table[index])

    def _release(ptr: c_void_p):
        if ptr and ptr.value:
            _vtbl(ptr, 2, c_ulong)(ptr)

    def _device_meta(dev: c_void_p) -> tuple[str, str]:
        raw_id_ptr = LPWSTR()
        dev_id = ""
        try:
            if _vtbl(dev, 5, HRESULT, POINTER(LPWSTR))(dev, byref(raw_id_ptr)) == 0 and raw_id_ptr.value:
                dev_id = raw_id_ptr.value
        finally:
            if raw_id_ptr:
                _ole32.CoTaskMemFree(raw_id_ptr)

        friendly_name = dev_id
        store = c_void_p()
        if _vtbl(dev, 4, HRESULT, DWORD, POINTER(c_void_p))(dev, _STGM_READ, byref(store)) == 0:
            try:
                prop = _PROPVARIANT()
                hr = _vtbl(store, 5, HRESULT, POINTER(_PROPERTYKEY), POINTER(_PROPVARIANT))(
                    store, byref(_PKEY_Device_FriendlyName), byref(prop),
                )
                if hr == 0:
                    try:
                        if prop.vt == 31 and prop.pwszVal:
                            friendly_name = prop.pwszVal.strip() or dev_id
                    finally:
                        _ole32.PropVariantClear(byref(prop))
            finally:
                _release(store)
        return dev_id, friendly_name

    def _default_endpoint_id(enum_ptr: c_void_p, flow: int, role: int) -> str:
        dev = c_void_p()
        try:
            hr = _vtbl(enum_ptr, 4, HRESULT, c_int, c_int, POINTER(c_void_p))(
                enum_ptr, flow, role, byref(dev),
            )
            if hr == 0 and dev.value:
                raw_id, _ = _device_meta(dev)
                return raw_id
        except OSError:
            pass
        finally:
            _release(dev)
        return ""

    def _enumerate_windows_devices() -> NativeAudioDevices:
        hr_init = _ole32.CoInitializeEx(None, _COINIT_MULTITHREADED)
        should_uninit = hr_init in (0, 1)
        enum_ptr = c_void_p()
        try:
            hr = _ole32.CoCreateInstance(
                byref(_CLSID_MMDeviceEnumerator),
                None,
                _CLSCTX_ALL,
                byref(_IID_IMMDeviceEnumerator),
                byref(enum_ptr),
            )
            if hr != 0 or not enum_ptr.value:
                return NativeAudioDevices(
                    platform="win32", wasapi_supported=False, inputs=[], loopbacks=[],
                )

            def collect(flow: int, prefix: str) -> list[NativeAudioEndpoint]:
                console_id = _default_endpoint_id(enum_ptr, flow, _E_CONSOLE)
                comm_id = _default_endpoint_id(enum_ptr, flow, _E_COMMUNICATIONS)
                coll = c_void_p()
                results: list[NativeAudioEndpoint] = []
                try:
                    if _vtbl(enum_ptr, 3, HRESULT, c_int, DWORD, POINTER(c_void_p))(
                        enum_ptr, flow, _DEVICE_STATE_ACTIVE, byref(coll),
                    ) != 0:
                        return results
                    count = UINT()
                    if _vtbl(coll, 3, HRESULT, POINTER(UINT))(coll, byref(count)) != 0:
                        return results
                    for idx in range(count.value):
                        dev = c_void_p()
                        try:
                            if _vtbl(coll, 4, HRESULT, UINT, POINTER(c_void_p))(
                                coll, idx, byref(dev),
                            ) == 0 and dev.value:
                                raw_id, name = _device_meta(dev)
                                if raw_id:
                                    results.append(
                                        NativeAudioEndpoint(
                                            id=f"{prefix}{raw_id}" if prefix else raw_id,
                                            raw_id=raw_id,
                                            name=name,
                                            is_default=(raw_id == console_id),
                                            is_communications_default=(raw_id == comm_id),
                                        )
                                    )
                        finally:
                            _release(dev)
                finally:
                    _release(coll)
                results.sort(key=lambda item: (not item.is_default, item.name.lower()))
                return results

            return NativeAudioDevices(
                platform="win32",
                wasapi_supported=True,
                inputs=collect(_E_CAPTURE, ""),
                loopbacks=collect(_E_RENDER, "wasapi:"),
            )
        except Exception as exc:
            logger.warning("WASAPI device enumeration failed: %s", type(exc).__name__)
            return NativeAudioDevices(
                platform="win32", wasapi_supported=False, inputs=[], loopbacks=[],
            )
        finally:
            _release(enum_ptr)
            if should_uninit:
                _ole32.CoUninitialize()

    def _run_wasapi_loopback_worker(
        device_id: str,
        stop_event: threading.Event,
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue[bytes | Exception | None],
    ):
        def push(item: bytes | Exception | None):
            if stop_event.is_set() and isinstance(item, bytes):
                return
            try:
                loop.call_soon_threadsafe(_enqueue_nonblocking, queue, item)
            except RuntimeError:
                pass

        hr_init = _ole32.CoInitializeEx(None, _COINIT_MULTITHREADED)
        should_uninit = hr_init in (0, 1)
        enum_ptr = c_void_p()
        target_dev = c_void_p()
        audio_client = c_void_p()
        capture_client = c_void_p()
        started = False
        try:
            hr = _ole32.CoCreateInstance(
                byref(_CLSID_MMDeviceEnumerator),
                None,
                _CLSCTX_ALL,
                byref(_IID_IMMDeviceEnumerator),
                byref(enum_ptr),
            )
            if hr != 0 or not enum_ptr.value:
                raise RuntimeError("无法初始化 Windows 音频枚举服务")

            normalized = (device_id or "default").strip()
            if normalized.startswith("wasapi:"):
                normalized = normalized[len("wasapi:"):]

            if normalized in ("", "default"):
                hr = _vtbl(enum_ptr, 4, HRESULT, c_int, c_int, POINTER(c_void_p))(
                    enum_ptr, _E_RENDER, _E_CONSOLE, byref(target_dev),
                )
            elif normalized == "communications":
                hr = _vtbl(enum_ptr, 4, HRESULT, c_int, c_int, POINTER(c_void_p))(
                    enum_ptr, _E_RENDER, _E_COMMUNICATIONS, byref(target_dev),
                )
                if hr != 0 or not target_dev.value:
                    hr = _vtbl(enum_ptr, 4, HRESULT, c_int, c_int, POINTER(c_void_p))(
                        enum_ptr, _E_RENDER, _E_CONSOLE, byref(target_dev),
                    )
            else:
                hr = _vtbl(enum_ptr, 5, HRESULT, LPWSTR, POINTER(c_void_p))(
                    enum_ptr, LPWSTR(normalized), byref(target_dev),
                )

            if hr != 0 or not target_dev.value:
                raise RuntimeError("未找到指定的系统播放设备")

            hr = _vtbl(target_dev, 3, HRESULT, POINTER(_GUID), DWORD, c_void_p, POINTER(c_void_p))(
                target_dev, byref(_IID_IAudioClient), _CLSCTX_ALL, None, byref(audio_client),
            )
            if hr != 0 or not audio_client.value:
                raise RuntimeError("无法激活系统音频内录通道")

            wfx = _WAVEFORMATEX(
                _WAVE_FORMAT_PCM,
                LOOPBACK_CHANNELS,
                LOOPBACK_SAMPLE_RATE,
                LOOPBACK_SAMPLE_RATE * 2,
                2,
                16,
                0,
            )
            flags = (
                _AUDCLNT_STREAMFLAGS_LOOPBACK
                | _AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | _AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
            )
            hr = _vtbl(
                audio_client,
                3,
                HRESULT,
                c_int,
                DWORD,
                c_longlong,
                c_longlong,
                POINTER(_WAVEFORMATEX),
                c_void_p,
            )(
                audio_client,
                _AUDCLNT_SHAREMODE_SHARED,
                flags,
                1_000_000,  # 100ms buffer
                0,
                byref(wfx),
                None,
            )
            if hr != 0:
                raise RuntimeError("初始化 16kHz WASAPI 系统内录失败")

            hr = _vtbl(audio_client, 14, HRESULT, POINTER(_GUID), POINTER(c_void_p))(
                audio_client, byref(_IID_IAudioCaptureClient), byref(capture_client),
            )
            if hr != 0 or not capture_client.value:
                raise RuntimeError("获取系统音频捕获客户端失败")

            if _vtbl(audio_client, 10, HRESULT)(audio_client) != 0:
                raise RuntimeError("启动系统音频内录失败")
            started = True

            pending = bytearray()
            silent_frame = b"\x00" * LOOPBACK_FRAME_BYTES
            last_emit_at = time.perf_counter()

            while not stop_event.is_set():
                pkt = UINT()
                if _vtbl(capture_client, 5, HRESULT, POINTER(UINT))(capture_client, byref(pkt)) != 0:
                    raise RuntimeError("系统播放设备已断开")

                got_any = False
                while pkt.value > 0 and not stop_event.is_set():
                    got_any = True
                    data_ptr = c_void_p()
                    num_frames = UINT()
                    buf_flags = DWORD()
                    hr_buf = _vtbl(
                        capture_client,
                        3,
                        HRESULT,
                        POINTER(c_void_p),
                        POINTER(UINT),
                        POINTER(DWORD),
                        c_void_p,
                        c_void_p,
                    )(capture_client, byref(data_ptr), byref(num_frames), byref(buf_flags), None, None)
                    if hr_buf != 0:
                        break
                    byte_len = num_frames.value * 2
                    if byte_len > 0:
                        if (buf_flags.value & _AUDCLNT_BUFFERFLAGS_SILENT) or not data_ptr.value:
                            pending.extend(b"\x00" * byte_len)
                        else:
                            pending.extend(ctypes.string_at(data_ptr.value, byte_len))
                    _vtbl(capture_client, 4, HRESULT, UINT)(capture_client, num_frames.value)
                    if _vtbl(capture_client, 5, HRESULT, POINTER(UINT))(capture_client, byref(pkt)) != 0:
                        break

                now = time.perf_counter()
                if not got_any and (now - last_emit_at) >= 0.020:
                    # WASAPI Loopback emits zero packets during hardware idle; keep 20ms clock steady.
                    elapsed_frames = min(3, max(1, int((now - last_emit_at) / 0.020)))
                    pending.extend(silent_frame * elapsed_frames)

                while len(pending) >= LOOPBACK_FRAME_BYTES:
                    chunk = bytes(pending[:LOOPBACK_FRAME_BYTES])
                    del pending[:LOOPBACK_FRAME_BYTES]
                    push(chunk)
                    last_emit_at = time.perf_counter()

                stop_event.wait(0.008)
        except Exception as exc:
            push(exc)
        finally:
            if started and audio_client.value:
                try:
                    _vtbl(audio_client, 11, HRESULT)(audio_client)
                except OSError:
                    pass
            _release(capture_client)
            _release(audio_client)
            _release(target_dev)
            _release(enum_ptr)
            if should_uninit:
                _ole32.CoUninitialize()
            push(None)


def _enqueue_nonblocking(queue: asyncio.Queue, item: bytes | Exception | None):
    if isinstance(item, bytes) and queue.full():
        try:
            oldest = queue.get_nowait()
            if not isinstance(oldest, bytes):
                queue.put_nowait(oldest)
                return
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        pass


class WindowsAudioBackend:
    async def list_devices(self) -> NativeAudioDevices:
        if os.name != "nt":
            return NativeAudioDevices(
                platform=sys.platform, wasapi_supported=False, inputs=[], loopbacks=[],
            )
        return await asyncio.to_thread(_enumerate_windows_devices)

    async def serve_loopback(self, websocket: WebSocket, device_id: str = "default"):
        await websocket.accept()
        if os.name != "nt":
            await websocket.send_json({
                "type": "error",
                "payload": {"code": "WASAPI_UNSUPPORTED", "message": "当前操作系统不支持 WASAPI 内录"},
            })
            await websocket.close(code=1008)
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes | Exception | None] = asyncio.Queue(maxsize=32)
        stop_event = threading.Event()
        worker = threading.Thread(
            target=_run_wasapi_loopback_worker,
            args=(device_id, stop_event, loop, queue),
            name="zhiling-wasapi-loopback",
            daemon=True,
        )
        worker.start()

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
                _enqueue_nonblocking(queue, None)

        watcher = asyncio.create_task(watch_disconnect())
        try:
            while not stop_event.is_set():
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    await websocket.send_json({
                        "type": "error",
                        "payload": {"code": "WASAPI_CAPTURE_FAILED", "message": str(item)},
                    })
                    break
                await websocket.send_bytes(item)
        except WebSocketDisconnect:
            pass
        finally:
            stop_event.set()
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
            await asyncio.to_thread(worker.join, 1.5)
            try:
                await websocket.close()
            except Exception:
                pass
