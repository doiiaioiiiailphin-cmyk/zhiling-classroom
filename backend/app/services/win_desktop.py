import asyncio
import ctypes
from ctypes import wintypes
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


def parse_hotkey_combo(combo: str) -> tuple[int, int] | None:
    if not combo or not combo.strip():
        return None
    parts = [p.strip().upper() for p in combo.split("+") if p.strip()]
    if not parts:
        return None
    mods = MOD_NOREPEAT
    vk = 0
    for part in parts:
        if part == "ALT":
            mods |= MOD_ALT
        elif part in ("CTRL", "CONTROL"):
            mods |= MOD_CONTROL
        elif part == "SHIFT":
            mods |= MOD_SHIFT
        elif part in ("WIN", "SUPER", "META"):
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


class DesktopEventBus:
    """Manages Windows global hotkeys (Win32 RegisterHotKey) and broadcasts desktop events over WS."""

    def __init__(self, *, enable_os_hook: bool = False):
        self.enable_os_hook = enable_os_hook and sys.platform == "win32"
        self.clients: set[WebSocket] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._hotkeys = DesktopHotkeys()
        self._thread: threading.Thread | None = None
        self._thread_id: int = 0
        self._ready = threading.Event()
        self._lock = threading.Lock()

    def start(self, loop: asyncio.AbstractEventLoop, initial_hotkeys: DesktopHotkeys):
        self._loop = loop
        self._hotkeys = initial_hotkeys
        if not self.enable_os_hook:
            return
        self._ready.clear()
        self._thread = threading.Thread(
            target=self._win32_hotkey_loop, name="zhiling-win32-hotkeys", daemon=True,
        )
        self._thread.start()
        self._ready.wait(timeout=2.0)

    def update_hotkeys(self, next_hotkeys: DesktopHotkeys):
        with self._lock:
            self._hotkeys = next_hotkeys
            tid = self._thread_id
        if self.enable_os_hook and tid:
            try:
                ctypes.windll.user32.PostThreadMessageW(tid, WM_USER_RELOAD, 0, 0)
            except Exception:
                pass

    def stop(self):
        with self._lock:
            tid = self._thread_id
            self._thread_id = 0
        if self.enable_os_hook and tid:
            try:
                ctypes.windll.user32.PostThreadMessageW(tid, WM_QUIT, 0, 0)
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _win32_hotkey_loop(self):
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
