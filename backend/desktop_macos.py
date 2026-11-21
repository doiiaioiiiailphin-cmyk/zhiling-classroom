"""macOS 原生桌面宿主适配层（Cocoa / AppKit / WKWebView）。

仅在 `sys.platform == "darwin"` 时被 `desktop_shell.py` 调用，实现：
1. 无边框真透明四角与 16px 抗锯齿圆角（`NSWindow.setOpaque_(False)` + `clearColor` + `WKWebView drawsBackground=False`）；
2. `WKUIDelegate` 转发代理：自动放行本地 `127.0.0.1` / `localhost` 麦克风采集权限，彻底消除每次录音重复弹窗；
3. 原生 Cocoa 菜单栏（`知聆课堂`、`编辑`、`窗口`），让 `⌘C / ⌘V / ⌘X / ⌘A / ⌘Z / ⇧⌘Z / ⌘M / ⌘W / ⌘Q` 在 `WKWebView` 中全量生效；
4. `NSWindowDidDeminiaturizeNotification` 监听：从 Dock 还原窗口时自动通知前端解除最小化隐藏态；
5. 置顶透明字幕小窗的全空间与全屏悬浮覆盖（`NSFloatingWindowLevel` + `CanJoinAllSpaces | FullScreenAuxiliary`）；
6. 120Hz 原生丝滑拖拽（`performWindowDragWithEvent_` + 鼠标追踪兜底）与 8 方向边缘缩放；
7. 屏幕顶部中央原生不抢焦点置顶警示浮窗（`NSPanel` at `NSScreenSaverWindowLevel`），外力导致录音中断时在全屏网课之上清晰提醒；
8. 标准 macOS 数据目录 `~/Library/Application Support/ZhilingClassroom`。
"""
from __future__ import annotations

import logging
from pathlib import Path
import subprocess
import threading
import time
from typing import Callable

logger = logging.getLogger(__name__)

# 强引用池：防止 Objective-C weak delegate / notification observer / active panel 被 Python GC 提前回收
_RETAINED_OBJECTS: list[object] = []
_ACTIVE_ALERT_PANEL: dict[str, object] = {}
_MENU_INSTALLED = False


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

    if threading.current_thread() is threading.main_thread():
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
    return getattr(win_obj, "native", None)


def _find_wkwebviews(ns_window) -> list[object]:
    found: list[object] = []
    try:
        content_view = ns_window.contentView()
        if content_view is None:
            return found
        queue = [content_view]
        while queue:
            view = queue.pop(0)
            cls_name = type(view).__name__
            if "WKWebView" in cls_name:
                found.append(view)
            try:
                for sub in list(view.subviews() or []):
                    queue.append(sub)
            except Exception:
                pass
    except Exception:
        pass
    return found


def ensure_macos_main_menu() -> bool:
    """安装完整原生 Cocoa 菜单栏，使 ⌘C/⌘V/⌘X/⌘A/⌘Z/⇧⌘Z/⌘M/⌘W/⌘Q 在 WKWebView 中原生可用。"""
    global _MENU_INSTALLED
    if _MENU_INSTALLED:
        return True
    try:
        import AppKit  # type: ignore

        app = AppKit.NSApp
        if app is None:
            return False

        main_menu = app.mainMenu()
        if main_menu is None:
            main_menu = AppKit.NSMenu.alloc().initWithTitle_("MainMenu")
            app.setMainMenu_(main_menu)

        existing_titles = {
            str(main_menu.itemAtIndex_(i).title() or "")
            for i in range(main_menu.numberOfItems())
        }

        # 1. 应用菜单（⌘H / ⌘Q）
        if main_menu.numberOfItems() == 0:
            app_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("知聆课堂", None, "")
            app_submenu = AppKit.NSMenu.alloc().initWithTitle_("知聆课堂")
            app_submenu.addItemWithTitle_action_keyEquivalent_("隐藏知聆课堂", "hide:", "h")
            hide_others = app_submenu.addItemWithTitle_action_keyEquivalent_(
                "隐藏其他", "hideOtherApplications:", "h"
            )
            hide_others.setKeyEquivalentModifierMask_(
                AppKit.NSEventModifierFlagCommand | AppKit.NSEventModifierFlagOption
            )
            app_submenu.addItemWithTitle_action_keyEquivalent_("全部显示", "unhideAllApplications:", "")
            app_submenu.addItem_(AppKit.NSMenuItem.separatorItem())
            app_submenu.addItemWithTitle_action_keyEquivalent_("退出知聆课堂", "terminate:", "q")
            app_item.setSubmenu_(app_submenu)
            main_menu.addItem_(app_item)

        # 2. 编辑菜单（⌘Z / ⇧⌘Z / ⌘X / ⌘C / ⌘V / ⌘A）
        if "Edit" not in existing_titles and "编辑" not in existing_titles:
            edit_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("编辑", None, "")
            edit_menu = AppKit.NSMenu.alloc().initWithTitle_("编辑")
            edit_menu.addItemWithTitle_action_keyEquivalent_("撤销", "undo:", "z")
            redo = edit_menu.addItemWithTitle_action_keyEquivalent_("重做", "redo:", "Z")
            redo.setKeyEquivalentModifierMask_(
                AppKit.NSEventModifierFlagCommand | AppKit.NSEventModifierFlagShift
            )
            edit_menu.addItem_(AppKit.NSMenuItem.separatorItem())
            edit_menu.addItemWithTitle_action_keyEquivalent_("剪切", "cut:", "x")
            edit_menu.addItemWithTitle_action_keyEquivalent_("拷贝", "copy:", "c")
            edit_menu.addItemWithTitle_action_keyEquivalent_("粘贴", "paste:", "v")
            edit_menu.addItemWithTitle_action_keyEquivalent_("全选", "selectAll:", "a")
            edit_item.setSubmenu_(edit_menu)
            main_menu.addItem_(edit_item)

        # 3. 窗口菜单（⌘M / ⌘W）
        if "Window" not in existing_titles and "窗口" not in existing_titles:
            win_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("窗口", None, "")
            win_menu = AppKit.NSMenu.alloc().initWithTitle_("窗口")
            win_menu.addItemWithTitle_action_keyEquivalent_("最小化", "performMiniaturize:", "m")
            win_menu.addItemWithTitle_action_keyEquivalent_("关闭窗口", "performClose:", "w")
            win_item.setSubmenu_(win_menu)
            main_menu.addItem_(win_item)

        _MENU_INSTALLED = True
        return True
    except Exception as exc:
        logger.warning("Failed to install macOS main menu: %s", exc)
        return False


_UI_DELEGATE_PROXY_CLS = None


def _get_ui_delegate_proxy_class():
    global _UI_DELEGATE_PROXY_CLS
    if _UI_DELEGATE_PROXY_CLS is not None:
        return _UI_DELEGATE_PROXY_CLS
    import Foundation  # type: ignore
    import WebKit  # noqa: F401  # 确保 WebKit 协议元数据加载进 PyObjC
    import objc  # type: ignore

    try:
        protocols = [objc.protocolNamed("WKUIDelegate")]
    except Exception:
        protocols = []

    class _ZhilingWKUIDelegateProxy(Foundation.NSObject, protocols=protocols):  # type: ignore[misc]
        def initWithTarget_(self, target):
            self = objc.super(_ZhilingWKUIDelegateProxy, self).init()
            if self is None:
                return None
            self._target = target
            return self

        def webView_requestMediaCapturePermissionForOrigin_initiatedByFrame_type_decisionHandler_(
            self, webView, origin, frame, mediaType, decisionHandler
        ):
            # WKPermissionDecisionPrompt = 0, WKPermissionDecisionGrant = 1, WKPermissionDecisionDeny = 2
            host = ""
            try:
                host = str(origin.host() or "").lower()
            except Exception:
                host = ""
            if host in ("127.0.0.1", "localhost", "::1"):
                decisionHandler(1)
            else:
                decisionHandler(0)

        def respondsToSelector_(self, sel):
            if sel in (
                b"webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
                "webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:",
            ):
                return True
            if objc.super(_ZhilingWKUIDelegateProxy, self).respondsToSelector_(sel):
                return True
            target = getattr(self, "_target", None)
            if target is not None and target.respondsToSelector_(sel):
                return True
            return False

        def forwardingTargetForSelector_(self, sel):
            target = getattr(self, "_target", None)
            if target is not None and target.respondsToSelector_(sel):
                return target
            return None

    _UI_DELEGATE_PROXY_CLS = _ZhilingWKUIDelegateProxy
    return _UI_DELEGATE_PROXY_CLS


def _install_wkwebview_permission_grant(wk_view) -> bool:
    """为 WKWebView 挂载媒体权限自动放行代理，避免每次 getUserMedia 重复弹 WebKit 权限确认框。"""
    try:
        current = wk_view.UIDelegate()
        if current is not None and type(current).__name__ == "_ZhilingWKUIDelegateProxy":
            return True
        proxy_cls = _get_ui_delegate_proxy_class()
        proxy = proxy_cls.alloc().initWithTarget_(current)
        if proxy is None:
            return False
        wk_view.setUIDelegate_(proxy)
        _RETAINED_OBJECTS.append(proxy)
        if current is not None:
            _RETAINED_OBJECTS.append(current)
        return True
    except Exception as exc:
        logger.warning("Failed to install WKUIDelegate media permission proxy: %s", exc)
        return False


_RESTORE_OBSERVER_CLS = None


def _install_window_restore_observer(ns_win, on_restored: Callable[[], None]) -> bool:
    """监听 Dock 还原与激活事件，及时恢复被前端动画隐藏的主窗口 / 小窗内容。"""
    global _RESTORE_OBSERVER_CLS
    try:
        import AppKit  # type: ignore
        import Foundation  # type: ignore
        import objc  # type: ignore

        if _RESTORE_OBSERVER_CLS is None:
            class _ZhilingWindowObserver(Foundation.NSObject):
                def initWithCallback_(self, cb):
                    self = objc.super(_ZhilingWindowObserver, self).init()
                    if self is None:
                        return None
                    self._cb = cb
                    return self

                def handleRestored_(self, _notif):
                    cb = getattr(self, "_cb", None)
                    if cb is not None:
                        threading.Thread(target=cb, daemon=True).start()

            _RESTORE_OBSERVER_CLS = _ZhilingWindowObserver

        observer = _RESTORE_OBSERVER_CLS.alloc().initWithCallback_(on_restored)
        center = Foundation.NSNotificationCenter.defaultCenter()
        center.addObserver_selector_name_object_(
            observer,
            "handleRestored:",
            AppKit.NSWindowDidDeminiaturizeNotification,
            ns_win,
        )
        center.addObserver_selector_name_object_(
            observer,
            "handleRestored:",
            AppKit.NSWindowDidBecomeKeyNotification,
            ns_win,
        )
        _RETAINED_OBJECTS.append(observer)
        return True
    except Exception as exc:
        logger.warning("Failed to install macOS window restore observer: %s", exc)
        return False


def configure_macos_window(
    win_obj,
    *,
    is_main: bool,
    is_self_test: bool = False,
    on_restored: Callable[[], None] | None = None,
) -> dict[str, object]:
    """在 Cocoa 主线程配置无边框真透明窗口、全屏悬浮层级、WKWebView 透明底色与媒体权限免重复弹窗。"""
    diag: dict[str, object] = {"configured": False, "alphaComposited": False}
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return diag

    def _apply() -> None:
        import AppKit  # type: ignore

        if is_main:
            diag["menuInstalled"] = ensure_macos_main_menu()

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

        wk_views = _find_wkwebviews(ns_win)
        wk_transparent = False
        wk_perm_ok = False
        for wv in wk_views:
            try:
                wv.setValue_forKey_(False, "drawsBackground")
                wk_transparent = True
            except Exception:
                pass
            if _install_wkwebview_permission_grant(wv):
                wk_perm_ok = True

        if on_restored is not None:
            diag["restoreObserver"] = _install_window_restore_observer(ns_win, on_restored)

        diag["alphaComposited"] = True
        diag["wkTransparent"] = wk_transparent
        diag["wkMediaPermissionGranted"] = wk_perm_ok
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
    """优先调用 AppKit 原生 performWindowDragWithEvent_，若跨线程事件已过期则自动无缝回落 120Hz 坐标追踪。"""
    ns_win = _get_ns_window(win_obj)
    if ns_win is None:
        return False

    token = int(windows_state.get("drag_token", 0)) + 1  # type: ignore[arg-type]
    windows_state["drag_token"] = token

    def _try_native_or_snapshot():
        import AppKit  # type: ignore

        if is_main and windows_state.get("maximized"):
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
        if event is not None and event.type() in (
            AppKit.NSEventTypeLeftMouseDown,
            AppKit.NSEventTypeLeftMouseDragged,
        ):
            ns_win.performWindowDragWithEvent_(event)
            return ("native", 0.0, 0.0, 0.0, 0.0)

        loc = AppKit.NSEvent.mouseLocation()
        fr = ns_win.frame()
        return ("fallback", float(loc.x), float(loc.y), float(fr.origin.x), float(fr.origin.y))

    try:
        outcome = _run_on_main_thread(_try_native_or_snapshot, wait=True)
    except Exception:
        return False

    if not isinstance(outcome, tuple) or outcome[0] == "native":
        return True

    _, start_x, start_y, origin_x, origin_y = outcome

    def _drag_loop() -> None:
        import AppKit  # type: ignore

        last_x, last_y = start_x, start_y
        while windows_state.get("drag_token") == token:
            buttons = int(AppKit.NSEvent.pressedMouseButtons())
            if (buttons & 1) == 0:
                break
            loc = AppKit.NSEvent.mouseLocation()
            cx, cy = float(loc.x), float(loc.y)
            if cx != last_x or cy != last_y:
                nx = origin_x + (cx - start_x)
                ny = origin_y + (cy - start_y)

                def _move(x=nx, y=ny):
                    ns_win.setFrameOrigin_(AppKit.NSMakePoint(x, y))

                _run_on_main_thread(_move, wait=False)
                last_x, last_y = cx, cy
            time.sleep(0.008)

    threading.Thread(target=_drag_loop, name="zhiling-macos-drag", daemon=True).start()
    return True


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


_ALERT_TARGET_CLS = None


def show_macos_topmost_alert(
    title: str,
    message: str,
    *,
    can_resume: bool = True,
    on_resume: Callable[[], None] | None = None,
    on_focus_main: Callable[[], None] | None = None,
) -> bool:
    """在屏幕顶部中央弹出不抢占焦点的原生置顶警示浮窗（可悬浮于全屏网课/PPT 之上）。"""
    global _ALERT_TARGET_CLS

    def _show() -> bool:
        global _ALERT_TARGET_CLS
        import AppKit  # type: ignore
        import Foundation  # type: ignore
        import objc  # type: ignore

        # 若已有旧警示窗，先平稳关闭避免重叠
        old_panel = _ACTIVE_ALERT_PANEL.pop("panel", None)
        if old_panel is not None:
            try:
                old_panel.orderOut_(None)
            except Exception:
                pass

        if _ALERT_TARGET_CLS is None:
            class _ZhilingAlertActionTarget(Foundation.NSObject):
                def initWithCallbacks_(self, callbacks):
                    self = objc.super(_ZhilingAlertActionTarget, self).init()
                    if self is None:
                        return None
                    self._callbacks = callbacks
                    return self

                def onResume_(self, _sender):
                    cb = self._callbacks.get("resume")
                    panel = self._callbacks.get("panel")
                    if panel is not None:
                        panel.orderOut_(None)
                    if cb is not None:
                        threading.Thread(target=cb, daemon=True).start()

                def onOpenMain_(self, _sender):
                    cb = self._callbacks.get("focus")
                    panel = self._callbacks.get("panel")
                    if panel is not None:
                        panel.orderOut_(None)
                    if cb is not None:
                        threading.Thread(target=cb, daemon=True).start()

                def onDismiss_(self, _sender):
                    panel = self._callbacks.get("panel")
                    if panel is not None:
                        panel.orderOut_(None)

            _ALERT_TARGET_CLS = _ZhilingAlertActionTarget

        width, height = 468.0, 142.0
        screen = AppKit.NSScreen.mainScreen()
        if screen is not None:
            vis = screen.visibleFrame()
            x = float(vis.origin.x) + (float(vis.size.width) - width) * 0.5
            y = float(vis.origin.y) + float(vis.size.height) - height - 18.0
        else:
            x, y = 420.0, 720.0

        style = AppKit.NSWindowStyleMaskBorderless | AppKit.NSWindowStyleMaskNonactivatingPanel
        panel = AppKit.NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            AppKit.NSMakeRect(x, y, width, height),
            style,
            AppKit.NSBackingStoreBuffered,
            False,
        )
        panel.setFloatingPanel_(True)
        panel.setBecomesKeyOnlyIfNeeded_(True)
        panel.setOpaque_(False)
        panel.setBackgroundColor_(AppKit.NSColor.clearColor())
        panel.setHasShadow_(True)
        panel.setLevel_(AppKit.NSScreenSaverWindowLevel)
        panel.setCollectionBehavior_(
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
            | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
            | AppKit.NSWindowCollectionBehaviorStationary
        )

        card = AppKit.NSView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, width, height))
        card.setWantsLayer_(True)
        layer = card.layer()
        if layer is not None:
            layer.setBackgroundColor_(AppKit.NSColor.colorWithCalibratedWhite_alpha_(1.0, 0.98).CGColor())
            layer.setCornerRadius_(14.0)
            layer.setBorderWidth_(1.5)
            layer.setBorderColor_(
                AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.96, 0.29, 0.27, 0.55).CGColor()
            )
            layer.setMasksToBounds_(True)

        # 左侧红色警示色带
        strip = AppKit.NSView.alloc().initWithFrame_(AppKit.NSMakeRect(0, 0, 5.0, height))
        strip.setWantsLayer_(True)
        if strip.layer() is not None:
            strip.layer().setBackgroundColor_(
                AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.85, 0.22, 0.19, 1.0).CGColor()
            )
        card.addSubview_(strip)

        # 标题
        title_field = AppKit.NSTextField.labelWithString_(title or "知聆课堂 · 录音已意外暂停")
        title_field.setFrame_(AppKit.NSMakeRect(20.0, height - 36.0, width - 36.0, 24.0))
        title_field.setFont_(AppKit.NSFont.boldSystemFontOfSize_(15.0))
        title_field.setTextColor_(
            AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.85, 0.22, 0.19, 1.0)
        )
        card.addSubview_(title_field)

        # 原因正文
        msg_field = AppKit.NSTextField.wrappingLabelWithString_(
            message or "录音因外部异常中断，请检查麦克风或系统音频权限。"
        )
        msg_field.setFrame_(AppKit.NSMakeRect(20.0, 50.0, width - 36.0, 48.0))
        msg_field.setFont_(AppKit.NSFont.systemFontOfSize_(14.0))
        msg_field.setTextColor_(
            AppKit.NSColor.colorWithCalibratedRed_green_blue_alpha_(0.12, 0.14, 0.16, 1.0)
        )
        card.addSubview_(msg_field)

        callbacks = {"panel": panel, "resume": on_resume, "focus": on_focus_main}
        target = _ALERT_TARGET_CLS.alloc().initWithCallbacks_(callbacks)

        btn_x = width - 16.0
        dismiss_btn = AppKit.NSButton.buttonWithTitle_target_action_("忽略", target, "onDismiss:")
        dismiss_btn.setBezelStyle_(AppKit.NSBezelStyleRounded)
        dismiss_btn.setFrame_(AppKit.NSMakeRect(btn_x - 74.0, 12.0, 74.0, 30.0))
        card.addSubview_(dismiss_btn)
        btn_x -= 82.0

        open_btn = AppKit.NSButton.buttonWithTitle_target_action_("打开主窗口", target, "onOpenMain:")
        open_btn.setBezelStyle_(AppKit.NSBezelStyleRounded)
        open_btn.setFrame_(AppKit.NSMakeRect(btn_x - 102.0, 12.0, 102.0, 30.0))
        card.addSubview_(open_btn)
        btn_x -= 110.0

        if can_resume:
            resume_btn = AppKit.NSButton.buttonWithTitle_target_action_("恢复录音", target, "onResume:")
            resume_btn.setBezelStyle_(AppKit.NSBezelStyleRounded)
            resume_btn.setKeyEquivalent_("\r")
            resume_btn.setFrame_(AppKit.NSMakeRect(btn_x - 94.0, 12.0, 94.0, 30.0))
            card.addSubview_(resume_btn)

        panel.setContentView_(card)
        panel.orderFrontRegardless()
        _ACTIVE_ALERT_PANEL["panel"] = panel
        _ACTIVE_ALERT_PANEL["target"] = target
        return True

    try:
        return bool(_run_on_main_thread(_show, wait=True))
    except Exception as exc:
        logger.warning("Failed to show macOS topmost alert panel: %s", exc)
        return False
