"""macOS 原生桌面宿主适配层（Cocoa / AppKit / WKWebView）。

仅在 `sys.platform == "darwin"` 时被 `desktop_shell.py` 调用，实现：
1. 无边框真透明四角与 16px 抗锯齿圆角（`NSWindow.setOpaque_(False)` + `clearColor` + `WKWebView drawsBackground=False`）；
2. 置顶透明字幕小窗的全空间与全屏悬浮覆盖（`NSFloatingWindowLevel` + `CanJoinAllSpaces | FullScreenAuxiliary`）；
3. 120Hz 原生丝滑拖拽（`NSWindow.performWindowDragWithEvent_`）与 8 方向边缘缩放；
4. 自动避让顶部菜单栏与底部 Dock 的平滑工作区最大化 / 还原（基于 `NSScreen.visibleFrame()`）；
5. 标准 macOS 数据目录 `~/Library/Application Support/ZhilingClassroom`。
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import threading
import time
from typing import Callable


def resolve_macos_app_home() -> Path:
    home = Path.home() / "Library" / "Application Support" / "ZhilingClassroom"
    home.mkdir(parents=True, exist_ok=True)
    return home


def show_macos_error_dialog(message: str) -> None:
    safe_msg = message.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    try:
        subprocess.run(
            [
                "osascript",
                "-e",
                f'display dialog "{safe_msg}" with title "知聆课堂启动异常" buttons {{"好"}} default button "好" with icon stop',
            ],
            check=False,
            timeout=10,
        )
    except Exception:
        pass


def _run_on_main_thread(fn: Callable[[], object], *, wait: bool = True) -> object:
    try:
        from PyObjCTools import AppHelper  # type: ignore
    except ImportError:
        return fn()

    if not wait:
        AppHelper.callAfter(fn)
        return None

    done = threading.Event()
    result: dict[str, object] = {"value": None, "error": None}

    def _wrapped() -> None:
        try:
            result["value"] = fn()
        except Exception as exc:
            result["error"] = exc
        finally:
            done.set()

    AppHelper.callAfter(_wrapped)
    done.wait(timeout=3.0)
    if result["error"] is not None:
        raise result["error"]  # type: ignore[misc]
    return result["value"]


def _get_ns_window(win_obj):
    if win_obj is None:
        return None
    native = getattr(win_obj, "native", None)
    if native is not None:
        return native
    return None


def _configure_wkwebview_transparency(ns_window) -> bool:
    try:
        content_view = ns_window.contentView()
        if content_view is None:
            return False
        queue = [content_view]
        found = False
        while queue:
            view = queue.pop(0)
            cls_name = type(view).__name__
            if "WKWebView" in cls_name or hasattr(view, "setValue_forKey_"):
                try:
                    if "WKWebView" in cls_name:
                        view.setValue_forKey_(False, "drawsBackground")
                        found = True
                except Exception:
                    pass
            try:
                for sub in list(view.subviews() or []):
                    queue.append(sub)
            except Exception:
                pass
        return found
    except Exception:
        return False


def configure_macos_window(
    win_obj,
    *,
    is_main: bool,
    is_self_test: bool = False,
    on_restored: Callable[[], None] | None = None,
) -> dict[str, object]:
    """在 Cocoa 主线程配置无边框真透明窗口、全屏悬浮层级与 WKWebView 透明底色。"""
    diag: dict[str, object] = {"configured": False, "alphaComposited": False}
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return diag

    def _apply() -> None:
        import AppKit  # type: ignore

        ns_win.setOpaque_(False)
        ns_win.setBackgroundColor_(AppKit.NSColor.clearColor())
        ns_win.setHasShadow_(is_main)
        ns_win.setMovableByWindowBackground_(False)
        if not is_main:
            ns_win.setLevel_(AppKit.NSFloatingWindowLevel)
            behavior = (
                AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
                | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
            )
            ns_win.setCollectionBehavior_(behavior)
        else:
            ns_win.setCollectionBehavior_(AppKit.NSWindowCollectionBehaviorFullScreenPrimary)

        wk_ok = _configure_wkwebview_transparency(ns_win)
        diag["alphaComposited"] = True
        diag["wkTransparent"] = wk_ok
        diag["configured"] = True

        if not is_self_test:
            ns_win.makeKeyAndOrderFront_(None)
            AppKit.NSApp.activateIgnoringOtherApps_(True)

    try:
        _run_on_main_thread(_apply, wait=True)
    except Exception as exc:
        diag["error"] = str(exc)
    return diag


def focus_macos_window(win_obj) -> None:
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return

    def _focus() -> None:
        import AppKit  # type: ignore

        if ns_win.isMiniaturized():
            ns_win.deminiaturize_(None)
        ns_win.makeKeyAndOrderFront_(None)
        AppKit.NSApp.activateIgnoringOtherApps_(True)

    try:
        _run_on_main_thread(_focus, wait=False)
    except Exception:
        pass


def toggle_macos_zoom(win_obj, windows_state: dict[str, object]) -> bool:
    """在当前屏幕 NSScreen.visibleFrame()（避开菜单栏和 Dock）与原圆角尺寸间平滑切换。"""
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return False

    def _toggle() -> bool:
        import AppKit  # type: ignore

        if windows_state.get("maximized"):
            prev = windows_state.get("normal_rect")
            windows_state["maximized"] = False
            if isinstance(prev, tuple) and len(prev) == 4:
                x, y, w, h = prev
                frame = AppKit.NSMakeRect(float(x), float(y), float(w), float(h))
                ns_win.setFrame_display_animate_(frame, True, True)
            else:
                ns_win.zoom_(None)
        else:
            cur = ns_win.frame()
            windows_state["normal_rect"] = (
                float(cur.origin.x),
                float(cur.origin.y),
                float(cur.size.width),
                float(cur.size.height),
            )
            screen = ns_win.screen() or AppKit.NSScreen.mainScreen()
            windows_state["maximized"] = True
            if screen is not None:
                visible = screen.visibleFrame()
                ns_win.setFrame_display_animate_(visible, True, True)
            else:
                ns_win.zoom_(None)
        return bool(windows_state["maximized"])

    try:
        return bool(_run_on_main_thread(_toggle, wait=True))
    except Exception:
        return bool(windows_state.get("maximized"))


def start_macos_drag(win_obj, windows_state: dict[str, object], *, is_main: bool) -> bool:
    """调用 AppKit 原生 performWindowDragWithEvent_ 实现零延迟 ProMotion 级窗口拖拽。"""
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return False

    def _drag() -> bool:
        import AppKit  # type: ignore

        if is_main and windows_state.get("maximized"):
            # 最大化状态下开始拖拽时先还原为常规圆角窗口
            prev = windows_state.get("normal_rect")
            windows_state["maximized"] = False
            if isinstance(prev, tuple) and len(prev) == 4:
                _, _, nw, nh = prev
                loc = AppKit.NSEvent.mouseLocation()
                nx = float(loc.x) - float(nw) * 0.5
                ny = float(loc.y) - float(nh) + 24.0
                ns_win.setFrame_display_animate_(
                    AppKit.NSMakeRect(nx, ny, float(nw), float(nh)), True, False
                )

        event = AppKit.NSApp.currentEvent()
        if event is not None:
            ns_win.performWindowDragWithEvent_(event)
            return True
        return False

    try:
        return bool(_run_on_main_thread(_drag, wait=False) or True)
    except Exception:
        return False


def start_macos_resize(
    win_obj,
    mode: str,
    windows_state: dict[str, object],
    *,
    min_w: int,
    min_h: int,
) -> bool:
    """使用 Cocoa 坐标系统（原点在左下角）实现八向边缘平滑缩放。"""
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return False

    token = int(windows_state.get("drag_token", 0)) + 1  # type: ignore[arg-type]
    windows_state["drag_token"] = token

    def _capture_start():
        import AppKit  # type: ignore

        loc = AppKit.NSEvent.mouseLocation()
        fr = ns_win.frame()
        return (
            float(loc.x),
            float(loc.y),
            float(fr.origin.x),
            float(fr.origin.y),
            float(fr.size.width),
            float(fr.size.height),
        )

    try:
        start_state = _run_on_main_thread(_capture_start, wait=True)
    except Exception:
        return False
    if not isinstance(start_state, tuple):
        return False
    start_x, start_y, rx, ry, rw, rh = start_state

    def _loop() -> None:
        import AppKit  # type: ignore

        last_x, last_y = start_x, start_y
        while windows_state.get("drag_token") == token:
            buttons = int(AppKit.NSEvent.pressedMouseButtons())
            if (buttons & 1) == 0:
                break
            loc = AppKit.NSEvent.mouseLocation()
            cx, cy = float(loc.x), float(loc.y)
            if cx != last_x or cy != last_y:
                dx = cx - start_x
                dy = cy - start_y  # macOS Y 轴向上为正
                nx, ny, nw, nh = rx, ry, rw, rh
                if "e" in mode:
                    nw = max(float(min_w), rw + dx)
                if "w" in mode:
                    nw = max(float(min_w), rw - dx)
                    nx = rx + (rw - nw)
                if "n" in mode:
                    nh = max(float(min_h), rh + dy)
                if "s" in mode:
                    nh = max(float(min_h), rh - dy)
                    ny = ry + (rh - nh)

                def _apply_frame(x=nx, y=ny, w=nw, h=nh):
                    ns_win.setFrame_display_(AppKit.NSMakeRect(x, y, w, h), True)

                _run_on_main_thread(_apply_frame, wait=False)
                last_x, last_y = cx, cy
            time.sleep(0.008)

    threading.Thread(target=_loop, name="zhiling-macos-resize", daemon=True).start()
    return True
