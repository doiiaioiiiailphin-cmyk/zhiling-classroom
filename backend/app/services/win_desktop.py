import asyncio
import ctypes
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


def parse_hotkey_combo(combo: str) -> tuple[int, int] | None:
    if not combo or not combo.strip():
        return None
    parts = [p.strip().upper() for p in combo.split("+") if p.strip()]
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
    """将快捷键字符串解析为 macOS Carbon (modifiers, virtual_keycode)。"""
    if not combo or not combo.strip():
        return None
    parts = [p.strip().upper() for p in combo.split("+") if p.strip()]
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
    """跨平台桌面全局热键管理器（Windows 走 Win32 RegisterHotKey，macOS 走 Carbon RegisterEventHotKey）。"""

    def __init__(self, *, enable_os_hook: bool = False):
        self.enable_os_hook = enable_os_hook and sys.platform in ("win32", "darwin")
        self.clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._hotkeys = DesktopHotkeys()
        self._thread: threading.Thread | None = None
        self._thread_id: int = 0
        self._mac_reload_event = threading.Event()
        self._mac_stop_event = threading.Event()
        self._ready = threading.Event()
        self._lock = threading.Lock()

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
            self._mac_stop_event.clear()
            self._mac_reload_event.clear()
            self._thread = threading.Thread(
                target=self._macos_hotkey_loop, name="zhiling-macos-hotkeys", daemon=True,
            )
            self._thread.start()
            self._ready.wait(timeout=2.0)

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
            self._mac_reload_event.set()

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
                self._mac_stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _macos_hotkey_loop(self):
        """使用 macOS Carbon RegisterEventHotKey（免辅助功能权限）监听全局快捷键。"""
        try:
            carbon = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Carbon.framework/Carbon")
            cf = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        except OSError as exc:
            logger.warning("Unable to load Carbon framework for macOS hotkeys: %s", exc)
            self._ready.set()
            return

        class EventTypeSpec(ctypes.Structure):
            _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]

        class EventHotKeyID(ctypes.Structure):
            _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]

        kEventClassKeyboard = int.from_bytes(b"keyb", "big")
        kEventHotKeyPressed = 5
        kEventParamDirectObject = int.from_bytes(b"----", "big")
        typeEventHotKeyID = int.from_bytes(b"hkid", "big")
        signature = int.from_bytes(b"ZHLG", "big")

        EVENT_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
        carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
        carbon.RegisterEventHotKey.argtypes = [
            ctypes.c_uint32, ctypes.c_uint32, EventHotKeyID, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p),
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
        cf.CFRunLoopRunInMode.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_bool]
        cf.CFRunLoopRunInMode.restype = ctypes.c_int32
        default_mode = ctypes.c_void_p.in_dll(cf, "kCFRunLoopDefaultMode")

        id_to_action: dict[int, str] = {}
        hotkey_refs: list[ctypes.c_void_p] = []

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
                action = id_to_action.get(int(hk_id.id))
                if action and self._loop is not None and not self._loop.is_closed():
                    asyncio.run_coroutine_threadsafe(self.broadcast_action(action), self._loop)
            return 0

        callback = EVENT_HANDLER(on_hotkey)
        spec = EventTypeSpec(kEventClassKeyboard, kEventHotKeyPressed)
        handler_ref = ctypes.c_void_p()
        target = carbon.GetApplicationEventTarget()
        carbon.InstallEventHandler(target, callback, 1, ctypes.byref(spec), None, ctypes.byref(handler_ref))

        def apply_registrations():
            for ref in hotkey_refs:
                carbon.UnregisterEventHotKey(ref)
            hotkey_refs.clear()
            id_to_action.clear()
            with self._lock:
                cfg = self._hotkeys
            if not cfg.enabled:
                return
            for hk_id, attr_name, wire_action in HOTKEY_ACTIONS:
                parsed = parse_macos_hotkey_combo(getattr(cfg, attr_name, ""))
                if parsed is None:
                    continue
                mods, keycode = parsed
                ref = ctypes.c_void_p()
                hk = EventHotKeyID(signature, hk_id)
                if carbon.RegisterEventHotKey(keycode, mods, hk, target, 0, ctypes.byref(ref)) == 0 and ref.value:
                    hotkey_refs.append(ref)
                    id_to_action[hk_id] = wire_action

        apply_registrations()
        self._ready.set()
        try:
            while not self._mac_stop_event.is_set():
                if self._mac_reload_event.is_set():
                    self._mac_reload_event.clear()
                    apply_registrations()
                cf.CFRunLoopRunInMode(default_mode, 0.15, False)
        finally:
            for ref in hotkey_refs:
                carbon.UnregisterEventHotKey(ref)
            if handler_ref.value:
                carbon.RemoveEventHandler(handler_ref)

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

    async def broadcast_action(self, action: str):
        if not self.clients:
            return
        frame = {"type": "hotkey.triggered", "payload": {"action": action}}
        stale: list[WebSocket] = []
        for ws in tuple(self.clients):
            try:
                async with asyncio.timeout(2):
                    await ws.send_json(frame)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)

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
            while True:
                msg = await socket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(socket)
