import asyncio
import ctypes
import json
import logging
import sys
import threading

from fastapi import WebSocket, WebSocketDisconnect

from ..schemas import DesktopHotkeys

logger = logging.getLogger(__name__)

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000

# macOS Carbon Event Manager modifier masks
MAC_CMD_KEY = 1 << 8
MAC_SHIFT_KEY = 1 << 9
MAC_OPTION_KEY = 1 << 11
MAC_CONTROL_KEY = 1 << 12

WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
WM_USER_RELOAD = 0x0401

HOTKEY_ACTIONS = (
    (1, "toggle_recording", "toggleRecording"),
    (2, "toggle_mic_mute", "toggleMicMute"),
    (3, "capture_screenshot", "captureScreenshot"),
    (4, "bookmark_confused", "bookmarkConfused"),
    (5, "toggle_mini_overlay", "toggleMiniOverlay"),
)

SPECIAL_VKS: dict[str, int] = {
    "SPACE": 0x20,
    "TAB": 0x09,
    "RETURN": 0x0D,
    "ENTER": 0x0D,
    "ESC": 0x1B,
    "ESCAPE": 0x1B,
    **{f"F{i}": 0x6F + i for i in range(1, 13)},
}

# macOS ANSI virtual keycodes (HIToolbox/Events.h)
MAC_KEYCODES: dict[str, int] = {
    "A": 0x00, "S": 0x01, "D": 0x02, "F": 0x03, "H": 0x04, "G": 0x05, "Z": 0x06,
    "X": 0x07, "C": 0x08, "V": 0x09, "B": 0x0B, "Q": 0x0C, "W": 0x0D, "E": 0x0E,
    "R": 0x0F, "Y": 0x10, "T": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "6": 0x16, "5": 0x17, "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D, "O": 0x1F,
    "U": 0x20, "I": 0x22, "P": 0x23, "L": 0x25, "J": 0x26, "K": 0x28, "N": 0x2D,
    "M": 0x2E, "RETURN": 0x24, "ENTER": 0x24, "TAB": 0x30, "SPACE": 0x31,
    "ESC": 0x35, "ESCAPE": 0x35,
    "F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60, "F6": 0x61,
    "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D, "F11": 0x67, "F12": 0x6F,
}


def _normalize_hotkey_tokens(combo: str) -> list[str]:
    if not combo or not combo.strip():
        return []
    text = (
        combo.replace("⌘", "Cmd+")
        .replace("⌥", "Option+")
        .replace("⇧", "Shift+")
        .replace("⌃", "Ctrl+")
    )
    return [p.strip().upper() for p in text.split("+") if p.strip()]


def parse_hotkey_combo(combo: str) -> tuple[int, int] | None:
    parts = _normalize_hotkey_tokens(combo)
    if not parts:
        return None
    mods = MOD_NOREPEAT
    vk = 0
    for part in parts:
        if part in ("ALT", "OPT", "OPTION"):
            mods |= MOD_ALT
        elif part in ("CTRL", "CONTROL"):
            mods |= MOD_CONTROL
        elif part == "SHIFT":
            mods |= MOD_SHIFT
        elif part in ("WIN", "SUPER", "META", "CMD", "COMMAND"):
            mods |= MOD_WIN
        elif len(part) == 1 and ("A" <= part <= "Z" or "0" <= part <= "9"):
            vk = ord(part)
        elif part in SPECIAL_VKS:
            vk = SPECIAL_VKS[part]
        else:
            return None
    if vk == 0 or (mods & ~MOD_NOREPEAT) == 0:
        return None
    return mods, vk


def parse_macos_hotkey_combo(combo: str) -> tuple[int, int] | None:
    """将快捷键字符串（支持 Option+Shift+R / ⌥⇧R / Alt+Shift+R / Cmd+Shift+S）解析为 macOS Carbon (modifiers, virtual_keycode)。"""
    parts = _normalize_hotkey_tokens(combo)
    if not parts:
        return None
    mods = 0
    keycode: int | None = None
    for part in parts:
        if part in ("ALT", "OPT", "OPTION"):
            mods |= MAC_OPTION_KEY
        elif part in ("CMD", "COMMAND", "META", "SUPER", "WIN"):
            mods |= MAC_CMD_KEY
        elif part in ("CTRL", "CONTROL"):
            mods |= MAC_CONTROL_KEY
        elif part == "SHIFT":
            mods |= MAC_SHIFT_KEY
        elif part in MAC_KEYCODES:
            keycode = MAC_KEYCODES[part]
        else:
            return None
    if keycode is None or mods == 0:
        return None
    return mods, keycode


class DesktopEventBus:
    """跨平台桌面全局热键管理器与多窗口实时同步中继（Windows Win32 / macOS Cocoa 主线程 Carbon 热键）。"""

    def __init__(self, *, enable_os_hook: bool = False):
        self.enable_os_hook = enable_os_hook and sys.platform in ("win32", "darwin")
        self.clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._hotkeys = DesktopHotkeys()
        self._thread: threading.Thread | None = None
        self._thread_id: int = 0
        self._ready = threading.Event()
        self._lock = threading.Lock()
        self._last_overlay_snapshot: dict | None = None

        # macOS Carbon 主线程句柄强引用（避免回调被 GC）
        self._mac_carbon = None
        self._mac_callback = None
        self._mac_handler_ref: ctypes.c_void_p | None = None
        self._mac_hotkey_refs: list[ctypes.c_void_p] = []
        self._mac_id_to_action: dict[int, str] = {}
        self._mac_target = None
        self._mac_signature = int.from_bytes(b"ZHLG", "big")
        self._mac_use_main_thread = False

    def start(self, loop: asyncio.AbstractEventLoop, initial_hotkeys: DesktopHotkeys):
        self._loop = loop
        self._hotkeys = initial_hotkeys
        if not self.enable_os_hook:
            return
        self._ready.clear()
        if sys.platform == "win32":
            self._thread = threading.Thread(
                target=self._win32_hotkey_loop, name="zhiling-win32-hotkeys", daemon=True,
            )
            self._thread.start()
            self._ready.wait(timeout=2.0)
        elif sys.platform == "darwin":
            self._start_macos_hotkeys()

    def update_hotkeys(self, next_hotkeys: DesktopHotkeys):
        with self._lock:
            self._hotkeys = next_hotkeys
            tid = self._thread_id
        if not self.enable_os_hook:
            return
        if sys.platform == "win32" and tid:
            try:
                ctypes.windll.user32.PostThreadMessageW(tid, WM_USER_RELOAD, 0, 0)
            except Exception:
                pass
        elif sys.platform == "darwin":
            self._dispatch_macos_main(self._macos_apply_registrations)

    def stop(self):
        with self._lock:
            tid = self._thread_id
            self._thread_id = 0
        if self.enable_os_hook:
            if sys.platform == "win32" and tid:
                try:
                    ctypes.windll.user32.PostThreadMessageW(tid, WM_QUIT, 0, 0)
                except Exception:
                    pass
            elif sys.platform == "darwin":
                self._dispatch_macos_main(self._macos_teardown)
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _dispatch_macos_main(self, fn):
        if self._mac_use_main_thread:
            try:
                from PyObjCTools import AppHelper  # type: ignore

                AppHelper.callAfter(fn)
                return
            except Exception:
                pass
        try:
            fn()
        except Exception as exc:
            logger.warning("macOS hotkey action failed: %s", exc)

    def _start_macos_hotkeys(self):
        """在 macOS Cocoa 主线程安装 Carbon RegisterEventHotKey，确保后台应用也能稳定收到全局热键事件。"""
        try:
            from PyObjCTools import AppHelper  # type: ignore  # noqa: F401
            self._mac_use_main_thread = True
        except ImportError:
            self._mac_use_main_thread = False

        self._dispatch_macos_main(self._macos_install_and_apply)

    def _macos_install_and_apply(self):
        try:
            carbon = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Carbon.framework/Carbon")
        except OSError as exc:
            logger.warning("Unable to load Carbon framework for macOS hotkeys: %s", exc)
            self._ready.set()
            return

        class EventTypeSpec(ctypes.Structure):
            _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]

        class EventHotKeyID(ctypes.Structure):
            _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]

        self._mac_event_hotkey_id_cls = EventHotKeyID
        kEventClassKeyboard = int.from_bytes(b"keyb", "big")
        kEventHotKeyPressed = 5
        kEventParamDirectObject = int.from_bytes(b"----", "big")
        typeEventHotKeyID = int.from_bytes(b"hkid", "big")

        EVENT_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
        carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
        carbon.RegisterEventHotKey.argtypes = [
            ctypes.c_uint32, ctypes.c_uint32, EventHotKeyID, ctypes.c_void_p,
            ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p),
        ]
        carbon.RegisterEventHotKey.restype = ctypes.c_int32
        carbon.UnregisterEventHotKey.argtypes = [ctypes.c_void_p]
        carbon.UnregisterEventHotKey.restype = ctypes.c_int32
        carbon.InstallEventHandler.argtypes = [
            ctypes.c_void_p, EVENT_HANDLER, ctypes.c_uint32, ctypes.POINTER(EventTypeSpec),
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
        ]
        carbon.InstallEventHandler.restype = ctypes.c_int32
        carbon.RemoveEventHandler.argtypes = [ctypes.c_void_p]
        carbon.GetEventParameter.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
            ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p,
        ]
        carbon.GetEventParameter.restype = ctypes.c_int32

        def on_hotkey(_next_handler, event_ref, _user_data):
            hk_id = EventHotKeyID()
            status = carbon.GetEventParameter(
                event_ref,
                kEventParamDirectObject,
                typeEventHotKeyID,
                None,
                ctypes.sizeof(EventHotKeyID),
                None,
                ctypes.byref(hk_id),
            )
            if status == 0:
                action = self._mac_id_to_action.get(int(hk_id.id))
                if action and self._loop is not None and not self._loop.is_closed():
                    asyncio.run_coroutine_threadsafe(self.broadcast_action(action), self._loop)
            return 0

        self._mac_carbon = carbon
        self._mac_callback = EVENT_HANDLER(on_hotkey)
        spec = EventTypeSpec(kEventClassKeyboard, kEventHotKeyPressed)
        handler_ref = ctypes.c_void_p()
        target = carbon.GetApplicationEventTarget()
        self._mac_target = target
        carbon.InstallEventHandler(
            target, self._mac_callback, 1, ctypes.byref(spec), None, ctypes.byref(handler_ref)
        )
        self._mac_handler_ref = handler_ref
        self._macos_apply_registrations()
        self._ready.set()

    def _macos_apply_registrations(self):
        carbon = self._mac_carbon
        target = self._mac_target
        if carbon is None or target is None:
            return
        for ref in self._mac_hotkey_refs:
            try:
                carbon.UnregisterEventHotKey(ref)
            except Exception:
                pass
        self._mac_hotkey_refs.clear()
        self._mac_id_to_action.clear()
        with self._lock:
            cfg = self._hotkeys
        if not cfg.enabled:
            return
        hk_cls = self._mac_event_hotkey_id_cls
        for hk_id, attr_name, wire_action in HOTKEY_ACTIONS:
            parsed = parse_macos_hotkey_combo(getattr(cfg, attr_name, ""))
            if parsed is None:
                continue
            mods, keycode = parsed
            ref = ctypes.c_void_p()
            hk = hk_cls(self._mac_signature, hk_id)
            if carbon.RegisterEventHotKey(keycode, mods, hk, target, 0, ctypes.byref(ref)) == 0 and ref.value:
                self._mac_hotkey_refs.append(ref)
                self._mac_id_to_action[hk_id] = wire_action

    def _macos_teardown(self):
        carbon = self._mac_carbon
        if carbon is None:
            return
        for ref in self._mac_hotkey_refs:
            try:
                carbon.UnregisterEventHotKey(ref)
            except Exception:
                pass
        self._mac_hotkey_refs.clear()
        self._mac_id_to_action.clear()
        if self._mac_handler_ref is not None and self._mac_handler_ref.value:
            try:
                carbon.RemoveEventHandler(self._mac_handler_ref)
            except Exception:
                pass
            self._mac_handler_ref = None

    def _win32_hotkey_loop(self):
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        tid = kernel32.GetCurrentThreadId()
        msg = wintypes.MSG()
        # Force message queue creation before signaling readiness
        user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 0)
        with self._lock:
            self._thread_id = tid
        registered_ids: set[int] = set()
        id_to_action: dict[int, str] = {}

        def apply_registrations():
            for hk_id in list(registered_ids):
                user32.UnregisterHotKey(None, hk_id)
            registered_ids.clear()
            id_to_action.clear()
            with self._lock:
                cfg = self._hotkeys
            if not cfg.enabled:
                return
            for hk_id, attr_name, wire_action in HOTKEY_ACTIONS:
                parsed = parse_hotkey_combo(getattr(cfg, attr_name, ""))
                if parsed is None:
                    continue
                mods, vk = parsed
                if user32.RegisterHotKey(None, hk_id, mods, vk):
                    registered_ids.add(hk_id)
                    id_to_action[hk_id] = wire_action

        apply_registrations()
        self._ready.set()
        try:
            while True:
                res = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
                if res <= 0:
                    break
                if msg.message == WM_USER_RELOAD:
                    apply_registrations()
                elif msg.message == WM_HOTKEY:
                    action = id_to_action.get(int(msg.wParam))
                    if action and self._loop is not None and not self._loop.is_closed():
                        asyncio.run_coroutine_threadsafe(self.broadcast_action(action), self._loop)
        finally:
            for hk_id in list(registered_ids):
                user32.UnregisterHotKey(None, hk_id)

    async def broadcast_frame(self, frame: dict, *, exclude: WebSocket | None = None):
        if not self.clients:
            return
        stale: list[WebSocket] = []
        for ws in tuple(self.clients):
            if ws is exclude:
                continue
            try:
                async with asyncio.timeout(2):
                    await ws.send_json(frame)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)

    async def broadcast_action(self, action: str):
        await self.broadcast_frame({"type": "hotkey.triggered", "payload": {"action": action}})

    async def serve(self, socket: WebSocket):
        await socket.accept()
        self.clients.add(socket)
        try:
            await socket.send_json({
                "type": "desktop.ready",
                "payload": {
                    "osHookActive": self.enable_os_hook,
                    "hotkeys": self._hotkeys.wire(),
                },
            })
            if self._last_overlay_snapshot is not None:
                await socket.send_json({
                    "type": "overlay.snapshot",
                    "payload": self._last_overlay_snapshot,
                })
            while True:
                msg = await socket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                text = msg.get("text")
                if not text:
                    continue
                try:
                    parsed = json.loads(text)
                except ValueError:
                    continue
                if not isinstance(parsed, dict):
                    continue
                evt_type = parsed.get("type")
                payload = parsed.get("payload")
                if evt_type == "overlay.snapshot" and isinstance(payload, dict):
                    self._last_overlay_snapshot = payload
                    await self.broadcast_frame(
                        {"type": "overlay.snapshot", "payload": payload},
                        exclude=socket,
                    )
                elif evt_type == "overlay.command" and isinstance(payload, dict):
                    await self.broadcast_frame(
                        {"type": "overlay.command", "payload": payload},
                        exclude=socket,
                    )
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(socket)
