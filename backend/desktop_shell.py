"""
知聆课堂 Windows 无边框自定义圆角桌面应用宿主入口（Edge WebView2 / pywebview）
核心适配特性：
  1. 真透明四角与桌面歌词画布：预先注入 WEBVIEW2_DEFAULT_BACKGROUND_COLOR=0，结合 Win32 WndProc 子类化拦截
     WinForms 默认 #F0F0F0 实心灰底绘制（改填 Alpha=0 零像素）+ DwmExtendFrameIntoClientArea(-1) +
     DwmEnableBlurBehindWindow(空区域) + DwmSetWindowAttribute(去系统圆角/去1px外框/去暗色云母底)，
     让主窗口 16px 抗锯齿圆角外侧四角与置顶实时字幕窗背景 100% 透明穿透桌面；
  2. 原生 500Hz 丝滑顶栏拖拽与八向边缘缩放：基于 Win32 GetCursorPos + GetAsyncKeyState + SetWindowPos 物理像素直驱，
     支持最大化状态下按住顶栏向下拖出自动还原圆角窗口、拖至屏幕顶端松手自动贴边最大化、双击顶栏切换最大化；
  3. 窗口最大化/窗口化平滑尺寸插值动效，配合前端最小化下沉渐隐、任务栏唤醒回弹与关闭缩放消散动画；
  4. 自动放行本地回环麦克风与剪贴板权限，开启 ALLOW_DOWNLOADS 原生「另存为」导出对话框。
"""
import base64
import ctypes
import faulthandler
import io
import json
import multiprocessing
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

if sys.platform == "win32":
    from ctypes import wintypes
    # 必须在 WebView2 初始化前设置默认背景色为全透明 (Alpha=0)，彻底消除启动白屏闪烁与底色遮挡
    os.environ.setdefault("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0")
    # 规避 Edge WebView2 / Chromium 157 上游 Blink 缺陷 (crbug.com/549525849):
    # 流式课堂字幕高频更新文本节点时，Windows UIA/tabtip 触发的 ax_block_flow_iterator.cc::ComputeNeighborOnLine
    # 会命中 CHECK 断言导致渲染进程 STATUS_BREAKPOINT (0x80000003) 崩溃。
    # 必须同时传 --disable-platform-accessibility-integration（阻断系统 UIA/WM_GETOBJECT 动态唤醒）
    # 与 --disable-features=...,UiaProvider + --disable-renderer-accessibility。
    _wv2_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "").strip()
    for _flag in (
        "--disable-platform-accessibility-integration",
        "--disable-renderer-accessibility",
    ):
        if _flag not in _wv2_args:
            _wv2_args = f"{_wv2_args} {_flag}".strip()
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = _wv2_args


def _configure_tls_ca_bundle() -> None:
    """在 macOS / 打包版 Python 环境下绑定 certifi 根证书，避免 OpenSSL 找不到系统 CA 导致 wss:// 与 HTTPS 校验失败。"""
    existing = os.environ.get("SSL_CERT_FILE")
    if existing and Path(existing).is_file():
        return
    try:
        import certifi  # type: ignore

        ca_path = Path(certifi.where())
        if ca_path.is_file():
            os.environ["SSL_CERT_FILE"] = str(ca_path)
            os.environ.setdefault("REQUESTS_CA_BUNDLE", str(ca_path))
    except Exception:
        pass


_configure_tls_ca_bundle()


def _resolve_app_home() -> Path:
    if sys.platform == "darwin":
        from desktop_macos import resolve_macos_app_home
        return resolve_macos_app_home()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    home = Path(base) / "ZhilingClassroom"
    home.mkdir(parents=True, exist_ok=True)
    return home


_CRASH_LOG_FH = None


def _ensure_windowed_stdio(app_home: Path) -> None:
    """PyInstaller --windowed 模式下 sys.stdout / sys.stderr 为 None，同时启用崩溃日志与 SIGPIPE 防护。"""
    global _CRASH_LOG_FH
    if hasattr(signal, "SIGPIPE"):
        try:
            signal.signal(signal.SIGPIPE, signal.SIG_IGN)
        except Exception:
            pass

    log_dir = app_home / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

    # 始终开启原生 faulthandler 与未捕获异常钩子，防止 macOS/Windows 极端崩溃时无任何日志可查
    try:
        crash_path = log_dir / "crash.log"
        if crash_path.exists() and crash_path.stat().st_size > 2 * 1024 * 1024:
            crash_path.write_text("", encoding="utf-8")
        _CRASH_LOG_FH = open(crash_path, "a", encoding="utf-8", buffering=1)
        faulthandler.enable(file=_CRASH_LOG_FH, all_threads=True)

        def _log_unhandled(kind: str, exc_type, exc_value, exc_tb) -> None:
            try:
                ts = time.strftime("%Y-%m-%d %H:%M:%S")
                _CRASH_LOG_FH.write(f"\n[{ts}] UNHANDLED {kind}:\n")
                traceback.print_exception(exc_type, exc_value, exc_tb, file=_CRASH_LOG_FH)
                _CRASH_LOG_FH.flush()
            except Exception:
                pass

        sys.excepthook = lambda t, v, tb: _log_unhandled("MAIN", t, v, tb)
        threading.excepthook = lambda args: _log_unhandled(
            f"THREAD({getattr(args.thread, 'name', '?')})",
            args.exc_type,
            args.exc_value,
            args.exc_traceback,
        )
    except Exception:
        pass

    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        log_path = log_dir / "desktop.log"
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            log_path.write_text("", encoding="utf-8")
        log_fh = open(log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        log_fh = io.StringIO()
    if sys.stdout is None:
        sys.stdout = log_fh
    if sys.stderr is None:
        sys.stderr = log_fh


def _resolve_runtime_paths(app_home: Path) -> tuple[Path, Path, Path | None]:
    frozen = bool(getattr(sys, "frozen", False))
    meipass = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "_MEIPASS", None) else None
    repo_root = Path(__file__).resolve().parent.parent

    if not frozen and str(repo_root / "backend") not in sys.path:
        sys.path.insert(0, str(repo_root / "backend"))

    env_dist = os.environ.get("ZHILING_DIST_DIR")
    if env_dist:
        dist_dir = Path(env_dist).resolve()
    elif meipass and (meipass / "dist" / "index.html").is_file():
        dist_dir = (meipass / "dist").resolve()
    else:
        bundle_dist: Path | None = None
        if frozen:
            contents = Path(sys.executable).resolve().parent.parent
            for sub in ("Frameworks", "Resources", "MacOS"):
                candidate = contents / sub / "dist"
                if (candidate / "index.html").is_file():
                    bundle_dist = candidate.resolve()
                    break
        dist_dir = bundle_dist if bundle_dist is not None else (repo_root / "dist").resolve()

    env_data = os.environ.get("ZHILING_DATA_DIR")
    if env_data:
        data_dir = Path(env_data).resolve()
    elif frozen:
        portable_data = Path(sys.executable).resolve().parent / "data"
        data_dir = portable_data.resolve() if portable_data.is_dir() else (app_home / "data").resolve()
    else:
        data_dir = (repo_root / "backend" / "data").resolve()

    icon_candidates = []
    if meipass:
        icon_candidates.append(meipass / "assets" / "zhiling.ico")
    icon_candidates.append(repo_root / "assets" / "zhiling.ico")
    icon_candidates.append(dist_dir / "favicon.ico")
    icon_path = next((p.resolve() for p in icon_candidates if p.is_file()), None)

    return dist_dir, data_dir, icon_path


def _init_win32_process_identity() -> None:
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Zhiling.Classroom.Desktop.1")
    except Exception:
        pass


def find_free_port(preferred: int = 8000) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(("127.0.0.1", preferred)) != 0:
            return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_server_ready(
    port: int,
    server_thread: threading.Thread | None = None,
    timeout_s: float = 15.0,
) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        if server_thread is not None and not server_thread.is_alive():
            return False
        time.sleep(0.08)
    return False


def _show_error_dialog(message: str) -> None:
    if sys.platform == "darwin":
        from desktop_macos import show_macos_error_dialog
        show_macos_error_dialog(message)
        return
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.user32.MessageBoxW(0, message, "知聆课堂启动异常", 0x00000010)
    except Exception:
        pass


# ==================== Win32 / DWM 逐像素真透明与无边框物理定位支持 ====================

_HOOKED_WNDPROCS: dict[int, object] = {}

if sys.platform == "win32":
    class _MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    class _MARGINS(ctypes.Structure):
        _fields_ = [
            ("cxLeftWidth", ctypes.c_int),
            ("cxRightWidth", ctypes.c_int),
            ("cyTopHeight", ctypes.c_int),
            ("cyBottomHeight", ctypes.c_int),
        ]

    class _DWM_BLURBEHIND(ctypes.Structure):
        _fields_ = [
            ("dwFlags", wintypes.DWORD),
            ("fEnable", wintypes.BOOL),
            ("hRgnBlur", wintypes.HRGN),
            ("fTransitionOnMaximized", wintypes.BOOL),
        ]

    class _PAINTSTRUCT(ctypes.Structure):
        _fields_ = [
            ("hdc", wintypes.HDC),
            ("fErase", wintypes.BOOL),
            ("rcPaint", wintypes.RECT),
            ("fRestore", wintypes.BOOL),
            ("fIncUpdate", wintypes.BOOL),
            ("rgbReserved", ctypes.c_byte * 32),
        ]

    _WNDPROC_TYPE = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    )
    _u32 = ctypes.windll.user32
    _g32 = ctypes.windll.gdi32
    _dwm = ctypes.windll.dwmapi

    _u32.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
    _u32.GetWindowLongPtrW.restype = ctypes.c_void_p
    _u32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    _u32.SetWindowLongPtrW.restype = ctypes.c_void_p
    _u32.CallWindowProcW.argtypes = [
        ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    ]
    _u32.CallWindowProcW.restype = ctypes.c_ssize_t
    _u32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    _u32.GetClientRect.restype = wintypes.BOOL
    _u32.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.HBRUSH]
    _u32.FillRect.restype = ctypes.c_int
    _u32.BeginPaint.argtypes = [wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT)]
    _u32.BeginPaint.restype = wintypes.HDC
    _u32.EndPaint.argtypes = [wintypes.HWND, ctypes.POINTER(_PAINTSTRUCT)]
    _u32.EndPaint.restype = wintypes.BOOL
    _u32.RedrawWindow.argtypes = [
        wintypes.HWND, ctypes.c_void_p, wintypes.HRGN, wintypes.UINT
    ]
    _u32.RedrawWindow.restype = wintypes.BOOL

    _g32.GetStockObject.argtypes = [ctypes.c_int]
    _g32.GetStockObject.restype = wintypes.HBRUSH
    _g32.CreateRectRgn.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    _g32.CreateRectRgn.restype = wintypes.HRGN
    _g32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    _g32.DeleteObject.restype = wintypes.BOOL


def _apply_dwm_alpha_and_frameless(hwnd: int) -> None:
    """
    1. 子类化宿主 Form 的 WndProc，拦截 WinForms 默认 #F0F0F0 不透明背景擦除，改用 GDI BLACK_BRUSH 写入 0x00000000(Alpha=0)；
    2. 通过 DwmExtendFrameIntoClientArea(-1) + DwmEnableBlurBehindWindow(空区域) 开启 DWM 8-bit 逐像素透明合成且不产生毛玻璃模糊；
    3. 关闭系统默认圆角(33=1)、隐藏系统 1px 矩形边框(34=NONE)、禁用暗色模式云母底色(38=1)。
    """
    if sys.platform != "win32" or not hwnd:
        return
    try:
        h_wnd = wintypes.HWND(hwnd)

        if hwnd not in _HOOKED_WNDPROCS:
            black_brush = _g32.GetStockObject(4)  # BLACK_BRUSH -> ARGB 0x00000000 (Alpha=0)
            orig_proc = _u32.GetWindowLongPtrW(h_wnd, -4)  # GWLP_WNDPROC
            if orig_proc:
                def _alpha_wndproc(h, msg, wp, lp):
                    if msg == 0x0014:  # WM_ERASEBKGND
                        rc = wintypes.RECT()
                        _u32.GetClientRect(h, ctypes.byref(rc))
                        _u32.FillRect(wintypes.HDC(wp), ctypes.byref(rc), black_brush)
                        return 1
                    if msg == 0x000F:  # WM_PAINT
                        ps = _PAINTSTRUCT()
                        hdc = _u32.BeginPaint(h, ctypes.byref(ps))
                        _u32.FillRect(hdc, ctypes.byref(ps.rcPaint), black_brush)
                        _u32.EndPaint(h, ctypes.byref(ps))
                        return 0
                    return _u32.CallWindowProcW(orig_proc, h, msg, wp, lp)

                cb = _WNDPROC_TYPE(_alpha_wndproc)
                _HOOKED_WNDPROCS[hwnd] = cb
                _u32.SetWindowLongPtrW(h_wnd, -4, ctypes.cast(cb, ctypes.c_void_p))

        margins = _MARGINS(-1, -1, -1, -1)
        _dwm.DwmExtendFrameIntoClientArea(h_wnd, ctypes.byref(margins))

        empty_rgn = _g32.CreateRectRgn(0, 0, -1, -1)
        try:
            bb = _DWM_BLURBEHIND(0x00000003, True, empty_rgn, False)
            _dwm.DwmEnableBlurBehindWindow(h_wnd, ctypes.byref(bb))
        finally:
            if empty_rgn:
                _g32.DeleteObject(empty_rgn)

        # 3=DWMWA_TRANSITIONS_FORCEDISABLED(禁系统无边框跳变动画), 33=去系统圆角, 34=去1px外框, 38=去云母底色
        for attr, val in ((3, 1), (33, 1), (34, 0xFFFFFFFE), (38, 1)):
            c_val = ctypes.c_uint32(val)
            _dwm.DwmSetWindowAttribute(
                h_wnd,
                ctypes.c_uint32(attr),
                ctypes.byref(c_val),
                ctypes.sizeof(c_val),
            )

        # RDW_INVALIDATE | RDW_ERASE | RDW_FRAME | RDW_ALLCHILDREN
        _u32.RedrawWindow(h_wnd, None, None, 0x0585)
    except Exception:
        pass


def _get_monitor_work_area(hwnd: int) -> tuple[int, int, int, int] | None:
    if sys.platform != "win32" or not hwnd:
        return None
    try:
        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        user32.MonitorFromWindow.restype = wintypes.HMONITOR
        user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(_MONITORINFO)]
        user32.GetMonitorInfoW.restype = wintypes.BOOL

        hmon = user32.MonitorFromWindow(wintypes.HWND(hwnd), 2)
        if not hmon:
            return None
        mi = _MONITORINFO()
        mi.cbSize = ctypes.sizeof(_MONITORINFO)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            return None
        w = mi.rcWork.right - mi.rcWork.left
        h = mi.rcWork.bottom - mi.rcWork.top
        return int(mi.rcWork.left), int(mi.rcWork.top), int(w), int(h)
    except Exception:
        return None


def _get_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    if sys.platform != "win32" or not hwnd:
        return None
    rect = wintypes.RECT()
    if ctypes.windll.user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return int(rect.left), int(rect.top), int(rect.right - rect.left), int(rect.bottom - rect.top)
    return None


def _set_window_rect(hwnd: int, x: int, y: int, w: int, h: int) -> None:
    if sys.platform != "win32" or not hwnd:
        return
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    ctypes.windll.user32.SetWindowPos(
        wintypes.HWND(hwnd),
        wintypes.HWND(0),
        int(x),
        int(y),
        int(w),
        int(h),
        SWP_NOZORDER | SWP_NOACTIVATE,
    )


def _move_window_only(hwnd: int, x: int, y: int) -> None:
    if sys.platform != "win32" or not hwnd:
        return
    SWP_NOSIZE = 0x0001
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    ctypes.windll.user32.SetWindowPos(
        wintypes.HWND(hwnd),
        wintypes.HWND(0),
        int(x),
        int(y),
        0,
        0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    )


def _set_dwm_transitions_disabled(hwnd: int, disabled: bool) -> None:
    """临时开关 Windows DWM 默认窗口过渡（DWMWA_TRANSITIONS_FORCEDISABLED=3），消除无边框透明窗最小化/关闭时的二次跳变。"""
    if sys.platform != "win32" or not hwnd:
        return
    try:
        c_val = ctypes.c_int(1 if disabled else 0)
        _dwm.DwmSetWindowAttribute(
            wintypes.HWND(hwnd),
            ctypes.c_uint32(3),
            ctypes.byref(c_val),
            ctypes.sizeof(c_val),
        )
    except Exception:
        pass


def _animate_window_rect(
    hwnd: int,
    start_rect: tuple[int, int, int, int],
    end_rect: tuple[int, int, int, int],
    duration_s: float = 0.175,
) -> None:
    """直接一步设置目标窗口矩形，避免 40 次 Win32 Resize 风暴引发 WebView2 先飞左上角再铺满的错位问题。"""
    _ = (start_rect, duration_s)
    if sys.platform != "win32" or not hwnd:
        return
    _set_window_rect(hwnd, *end_rect)


def _get_cursor_pos() -> tuple[int, int]:
    pt = wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def _is_primary_mouse_down() -> bool:
    if sys.platform != "win32":
        return False
    swapped = bool(ctypes.windll.user32.GetSystemMetrics(23))  # SM_SWAPBUTTON
    vk = 0x02 if swapped else 0x01
    return bool(ctypes.windll.user32.GetAsyncKeyState(vk) & 0x8000)


def _get_window_dpi_scale(hwnd: int) -> float:
    if sys.platform != "win32" or not hwnd:
        return 1.0
    try:
        dpi = ctypes.windll.user32.GetDpiForWindow(wintypes.HWND(hwnd))
        return float(dpi) / 96.0 if dpi > 0 else 1.0
    except Exception:
        return 1.0


def launch_edge_app_fallback(url: str) -> bool:
    if sys.platform != "win32":
        return False
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "Microsoft/Edge/Application/msedge.exe",
    ]
    for exe in candidates:
        if exe.is_file():
            subprocess.Popen([str(exe), f"--app={url}", "--window-size=1400,880"])
            return True
    return False


def main() -> None:
    is_self_test = "--self-test" in sys.argv
    self_test_out: Path | None = None
    for idx, arg in enumerate(sys.argv):
        if arg == "--self-test-out" and idx + 1 < len(sys.argv):
            self_test_out = Path(sys.argv[idx + 1]).resolve()

    app_home = _resolve_app_home()
    _ensure_windowed_stdio(app_home)
    _init_win32_process_identity()

    dist_dir, data_dir, icon_path = _resolve_runtime_paths(app_home)
    if is_self_test:
        data_dir = (app_home / "self_test_data").resolve()

    port = find_free_port(8000 if not is_self_test else 18765)
    allowed_origins = (
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )

    os.environ["ZHILING_DATA_DIR"] = str(data_dir)
    os.environ["ZHILING_DIST_DIR"] = str(dist_dir)
    os.environ["ZHILING_SERVE_DIST"] = "1"
    os.environ["ZHILING_ALLOWED_ORIGINS"] = ",".join(allowed_origins)

    import uvicorn
    from app.main import create_app

    fastapi_app = create_app(
        data_dir=data_dir,
        builtin_asr_dir=(data_dir if is_self_test else app_home) / "addons" / "builtin-free-asr",
        opencode_cli_dir=(data_dir if is_self_test else app_home) / "addons" / "opencode-free",
        dist_dir=dist_dir,
        origins=allowed_origins,
        enable_os_hotkeys=not is_self_test,
        serve_dist=True,
    )

    server_config = uvicorn.Config(
        fastapi_app,
        host="127.0.0.1",
        port=port,
        workers=1,
        ws="websockets",
        ws_max_size=262144,
        ws_max_queue=64,
        ws_ping_interval=30.0,
        ws_ping_timeout=120.0,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(server_config)
    server_thread = threading.Thread(target=server.run, name="zhiling-uvicorn", daemon=True)
    server_thread.start()

    if not wait_server_ready(port, server_thread=server_thread):
        log_hint = app_home / "logs" / "desktop.log"
        msg = f"本地课堂后端服务启动失败，请查看日志：\n{log_hint}"
        if not is_self_test:
            _show_error_dialog(msg)
        sys.exit(msg)

    platform_tag = "macos" if sys.platform == "darwin" else "windows"
    base_url = f"http://127.0.0.1:{port}" if (dist_dir / "index.html").is_file() else "http://localhost:5173"
    main_url = f"{base_url}/?shell=desktop&platform={platform_tag}"
    mini_url = f"{base_url}/?mode=mini&shell=desktop&platform={platform_tag}"

    try:
        import webview  # type: ignore
    except ImportError:
        if not launch_edge_app_fallback(main_url):
            webbrowser.open(base_url)
        try:
            while server_thread.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            server.should_exit = True
            server_thread.join(timeout=8.0)
        return

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.settings["DRAG_REGION_SELECTOR"] = ".zhiling-disabled-legacy-drag"

    if sys.platform == "win32":
        # pywebview EdgeChrome.__init__ 会直接写 CreationProperties.AdditionalBrowserArguments，
        # 导致 WebView2 忽略 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量。
        # 通过 form.ControlAdded（在 line 95 同步触发，位于 CreationProperties 赋值之后、
        # EnsureCoreWebView2Async 启动内核之前）将 --disable-renderer-accessibility 真正注入 WebView2 内核参数，
        # 彻底规避 Edge WebView2 157 crbug.com/549525849 (ax_block_flow_iterator.cc STATUS_BREAKPOINT) 页面崩溃。
        try:
            import webview.platforms.edgechromium as _ec  # type: ignore

            if not getattr(_ec.EdgeChrome, "_zhiling_ax_patched", False):
                _orig_edge_init = _ec.EdgeChrome.__init__

                def _zhiling_edge_init(self, form, window, cache_dir):
                    def _inject_wv2_args(_sender, evt_args) -> None:
                        ctrl = getattr(evt_args, "Control", None)
                        props = getattr(ctrl, "CreationProperties", None)
                        if props is not None:
                            cur = str(getattr(props, "AdditionalBrowserArguments", "") or "")
                            # 将 UiaProvider 合并进已有的 --disable-features= 避免重复开关互相覆盖
                            if "--disable-features=" in cur:
                                if "UiaProvider" not in cur:
                                    cur = cur.replace(
                                        "--disable-features=",
                                        "--disable-features=UiaProvider,",
                                        1,
                                    )
                            else:
                                cur = f"{cur} --disable-features=UiaProvider".strip()
                            for flag in (
                                "--disable-platform-accessibility-integration",
                                "--disable-renderer-accessibility",
                            ):
                                if flag not in cur:
                                    cur = f"{cur} {flag}".strip()
                            props.AdditionalBrowserArguments = cur

                    try:
                        form.ControlAdded += _inject_wv2_args
                    except Exception:
                        pass
                    try:
                        _orig_edge_init(self, form, window, cache_dir)
                    finally:
                        try:
                            form.ControlAdded -= _inject_wv2_args
                        except Exception:
                            pass

                _ec.EdgeChrome.__init__ = _zhiling_edge_init
                _ec.EdgeChrome._zhiling_ax_patched = True
        except Exception:
            pass

    windows: dict[str, object] = {
        "maximized": False,
        "normal_rect": None,
        "op": None,
        "drag_token": 0,
        "was_minimized_main": False,
        "was_minimized_mini": False,
    }

    def get_hwnd(target: str) -> int:
        win_obj = windows.get(target)
        if win_obj is None:
            return 0
        try:
            native = getattr(win_obj, "native", None)
            if native is not None:
                return int(native.Handle.ToInt32())
        except Exception:
            pass
        return 0

    def dispatch_js_event(target: str, event_name: str, detail_json: str = "null") -> None:
        win_obj = windows.get(target)
        if win_obj is None:
            return
        try:
            win_obj.evaluate_js(  # type: ignore[attr-defined]
                f"window.dispatchEvent(new CustomEvent('{event_name}', {{ detail: {detail_json} }}));"
            )
        except Exception:
            pass

    def configure_native_webview(win_obj, *, is_main: bool) -> dict[str, object]:
        """按平台开启原生逐像素真透明合成、无边框圆角保护与权限放行。"""
        target_name = "main" if is_main else "mini"
        if sys.platform == "darwin":
            from desktop_macos import configure_macos_window

            def _on_mac_fs(entered: bool) -> None:
                windows["maximized"] = bool(entered)
                dispatch_js_event(
                    "main", "zhiling:window-maximized", "true" if entered else "false"
                )

            return configure_macos_window(
                win_obj,
                is_main=is_main,
                is_self_test=is_self_test,
                on_restored=lambda t=target_name: dispatch_js_event(
                    t, "zhiling:window-restored-from-min", "true"
                ),
                on_fullscreen_change=_on_mac_fs if is_main else None,
            )

        diag: dict[str, object] = {"configured": False, "alphaComposited": False}
        native = getattr(win_obj, "native", None)
        if native is None:
            return diag
        try:
            from System import Action  # type: ignore
            import System.Windows.Forms as WinForms  # type: ignore
            from Microsoft.Web.WebView2.Core import CoreWebView2PermissionState  # type: ignore

            min_key = "was_minimized_main" if is_main else "was_minimized_mini"
            target_name = "main" if is_main else "mini"

            def _apply_on_ui() -> None:
                hwnd = int(native.Handle.ToInt32())
                _apply_dwm_alpha_and_frameless(hwnd)
                diag["alphaComposited"] = hwnd in _HOOKED_WNDPROCS

                def _on_state_or_activate(*_args) -> None:
                    cur_hwnd = int(native.Handle.ToInt32())
                    if native.WindowState == WinForms.FormWindowState.Minimized:
                        windows[min_key] = True
                        return
                    if windows.get(min_key):
                        windows[min_key] = False
                        _apply_dwm_alpha_and_frameless(cur_hwnd)
                        threading.Thread(
                            target=dispatch_js_event,
                            args=(target_name, "zhiling:window-restored-from-min", "true"),
                            daemon=True,
                        ).start()

                    if is_main and native.WindowState == WinForms.FormWindowState.Maximized:
                        native.WindowState = WinForms.FormWindowState.Normal
                        work = _get_monitor_work_area(cur_hwnd)
                        if work:
                            if not windows.get("maximized"):
                                windows["normal_rect"] = _get_window_rect(cur_hwnd)
                            _set_window_rect(cur_hwnd, *work)
                            windows["maximized"] = True
                            threading.Thread(
                                target=dispatch_js_event,
                                args=("main", "zhiling:window-maximized", "true"),
                                daemon=True,
                            ).start()

                native.Activated += _on_state_or_activate
                native.Resize += _on_state_or_activate

                core = getattr(getattr(native, "webview", None), "CoreWebView2", None)
                if core is not None:
                    settings = core.Settings
                    if hasattr(settings, "IsPinchZoomEnabled"):
                        settings.IsPinchZoomEnabled = False

                    def _on_permission(_sender, args) -> None:
                        uri = str(getattr(args, "Uri", "") or "")
                        if uri.startswith(f"http://127.0.0.1:{port}") or uri.startswith(
                            f"http://localhost:{port}"
                        ):
                            args.State = CoreWebView2PermissionState.Allow

                    core.PermissionRequested += _on_permission

                    last_reload_at = [0.0]

                    def _on_process_failed(_sender, args) -> None:
                        kind = str(getattr(args, "ProcessFailedKind", "unknown"))
                        reason = str(getattr(args, "Reason", ""))
                        print(
                            f"[WebView2] ProcessFailed kind={kind} reason={reason}; auto-reloading",
                            flush=True,
                        )
                        now = time.monotonic()
                        if now - last_reload_at[0] < 3.0:
                            return
                        last_reload_at[0] = now
                        try:
                            core.Reload()
                        except Exception:
                            pass

                    try:
                        core.ProcessFailed += _on_process_failed
                        diag["processFailedHooked"] = True
                    except Exception:
                        diag["processFailedHooked"] = False

                    diag["configured"] = True

                if not is_self_test:
                    if not native.Visible:
                        native.Show()
                    native.Activate()
                    try:
                        _u32.SetForegroundWindow(wintypes.HWND(hwnd))
                    except Exception:
                        pass
                    diag["visible"] = bool(native.Visible)

            if native.InvokeRequired:
                native.Invoke(Action(_apply_on_ui))
            else:
                _apply_on_ui()
        except Exception as exc:
            diag["error"] = str(exc)
        return diag

    class DesktopBridge:
        def focus_main_window(self) -> None:
            if sys.platform == "darwin":
                from desktop_macos import focus_macos_window
                focus_macos_window(windows.get("main"))
                return
            hwnd = get_hwnd("main")
            if hwnd:
                user32 = ctypes.windll.user32
                if user32.IsIconic(hwnd):
                    user32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)

        def minimize_window(self) -> None:
            main_win = windows.get("main")
            if main_win is None:
                return
            windows["was_minimized_main"] = True
            if sys.platform == "darwin":
                from desktop_macos import minimize_macos_window
                minimize_macos_window(main_win)
                return
            hwnd = get_hwnd("main")
            if hwnd:
                # 保持 DWMWA_TRANSITIONS_FORCEDISABLED=1，杜绝无边框透明窗最小化/唤醒时产生二次大小跳变
                _set_dwm_transitions_disabled(hwnd, True)
                _u32.ShowWindow(wintypes.HWND(hwnd), 7)  # SW_SHOWMINNOACTIVE
            else:
                main_win.minimize()  # type: ignore[attr-defined]

        def is_window_maximized(self) -> bool:
            return bool(windows.get("maximized"))

        def prepare_maximize_transition(self) -> dict[str, object]:
            """协调丝滑全屏/最大化过渡：macOS 触发原生全屏 Space；Windows 返回精确比例供前端 120fps GPU FLIP 展开/收起。"""
            if sys.platform == "darwin":
                from desktop_macos import toggle_macos_fullscreen
                next_max = toggle_macos_fullscreen(windows.get("main"), windows)
                return {"nativeHandled": True, "maximized": bool(next_max)}

            hwnd = get_hwnd("main")
            if not hwnd:
                return {"nativeHandled": True, "maximized": bool(windows.get("maximized"))}

            work = _get_monitor_work_area(hwnd)
            cur_rect = _get_window_rect(hwnd)
            if not work or not cur_rect:
                next_max = self.toggle_maximize_window()
                return {"nativeHandled": True, "maximized": bool(next_max)}

            wx, wy, ww, wh = work
            ww = max(1, ww)
            wh = max(1, wh)

            if windows.get("maximized"):
                prev = windows.get("normal_rect")
                if not (isinstance(prev, tuple) and len(prev) == 4):
                    scale = _get_window_dpi_scale(hwnd)
                    pw, ph = min(ww - 40, int(1400 * scale)), min(wh - 40, int(880 * scale))
                    prev = (wx + (ww - pw) // 2, wy + (wh - ph) // 2, pw, ph)
                    windows["normal_rect"] = prev
                nx, ny, nw, nh = prev
                windows["maximized"] = False
                return {
                    "nativeHandled": False,
                    "maximized": False,
                    "dxPct": round((nx - wx) / ww * 100.0, 4),
                    "dyPct": round((ny - wy) / wh * 100.0, 4),
                    "scaleX": round(max(0.2, min(1.0, nw / ww)), 5),
                    "scaleY": round(max(0.2, min(1.0, nh / wh)), 5),
                }

            sx, sy, sw, sh = cur_rect
            windows["normal_rect"] = cur_rect
            windows["pending_max_rect"] = (wx, wy, ww, wh)
            windows["maximized"] = True
            # 暂不立即改变 HWND，交由前端挂载 resize 首帧同步钩子后再调用 commit_maximize_rect()，实现零闪烁 120fps GPU FLIP
            return {
                "nativeHandled": False,
                "maximized": True,
                "dxPct": round((sx - wx) / ww * 100.0, 4),
                "dyPct": round((sy - wy) / wh * 100.0, 4),
                "scaleX": round(max(0.2, min(1.0, sw / ww)), 5),
                "scaleY": round(max(0.2, min(1.0, sh / wh)), 5),
            }

        def commit_maximize_rect(self) -> bool:
            """前端挂好首帧 resize FLIP 钩子后一步原子将透明宿主铺满工作区（杜绝 1 帧左上角闪烁）。"""
            if sys.platform != "win32":
                return True
            hwnd = get_hwnd("main")
            target = windows.pop("pending_max_rect", None)
            if not (isinstance(target, tuple) and len(target) == 4):
                target = _get_monitor_work_area(hwnd) if hwnd else None
            if hwnd and isinstance(target, tuple) and len(target) == 4 and windows.get("maximized"):
                _set_window_rect(hwnd, *target)
                return True
            return False

        def commit_restore_rect(self) -> bool:
            """Windows GPU 还原动效结束后一步原子收回透明宿主至浮动圆角坐标。"""
            if sys.platform != "win32":
                return True
            hwnd = get_hwnd("main")
            prev = windows.get("normal_rect")
            if hwnd and isinstance(prev, tuple) and len(prev) == 4 and not windows.get("maximized"):
                _set_window_rect(hwnd, *prev)
                return True
            return False

        def zoom_window(self) -> dict[str, object]:
            """双击顶栏：macOS 使用 NSAnimationContext 平滑铺满工作区；Windows 复用 GPU FLIP 最大化/还原。"""
            if sys.platform == "darwin":
                from desktop_macos import toggle_macos_zoom
                next_max = toggle_macos_zoom(windows.get("main"), windows)
                return {"nativeHandled": True, "maximized": bool(next_max)}
            return self.prepare_maximize_transition()

        def toggle_maximize_window(self) -> bool:
            if sys.platform == "darwin":
                from desktop_macos import toggle_macos_fullscreen
                return toggle_macos_fullscreen(windows.get("main"), windows)
            hwnd = get_hwnd("main")
            if not hwnd:
                return False
            cur_rect = _get_window_rect(hwnd)
            if windows.get("maximized"):
                prev = windows.get("normal_rect")
                windows["maximized"] = False
                if isinstance(prev, tuple) and len(prev) == 4:
                    _set_window_rect(hwnd, *prev)
                else:
                    main_win = windows.get("main")
                    if main_win is not None:
                        main_win.restore()  # type: ignore[attr-defined]
            else:
                if cur_rect:
                    windows["normal_rect"] = cur_rect
                work = _get_monitor_work_area(hwnd)
                windows["maximized"] = True
                if work:
                    _set_window_rect(hwnd, *work)
                else:
                    main_win = windows.get("main")
                    if main_win is not None:
                        main_win.maximize()  # type: ignore[attr-defined]
            return bool(windows["maximized"])

        def close_window(self) -> None:
            mini_win = windows.pop("mini", None)
            if mini_win is not None:
                try:
                    mini_win.destroy()  # type: ignore[attr-defined]
                except Exception:
                    pass
            main_win = windows.get("main")
            if main_win is None:
                return
            if sys.platform == "darwin":
                from desktop_macos import close_macos_window

                def _destroy_main() -> None:
                    try:
                        main_win.destroy()  # type: ignore[attr-defined]
                    except Exception:
                        pass

                close_macos_window(main_win, destroy_after=_destroy_main)
                return
            hwnd = get_hwnd("main")
            if hwnd:
                _set_dwm_transitions_disabled(hwnd, True)
                try:
                    _u32.ShowWindow(wintypes.HWND(hwnd), 0)  # SW_HIDE
                except Exception:
                    pass
            try:
                main_win.destroy()  # type: ignore[attr-defined]
            except Exception:
                pass

        def start_native_drag(self, target: str) -> bool:
            """启动原生窗口拖拽（Windows 走 500Hz Win32 循环，macOS 走 Cocoa performWindowDragWithEvent_）。"""
            if sys.platform == "darwin":
                from desktop_macos import start_macos_drag
                return start_macos_drag(windows.get(target), windows, is_main=(target == "main"))
            hwnd = get_hwnd(target)
            if not hwnd:
                return False
            rect = _get_window_rect(hwnd)
            if not rect:
                return False

            token = int(windows.get("drag_token", 0)) + 1  # type: ignore[arg-type]
            windows["drag_token"] = token
            start_cx, start_cy = _get_cursor_pos()

            def _drag_loop() -> None:
                nonlocal rect, start_cx, start_cy
                rx, ry, rw, rh = rect
                last_cx, last_cy = start_cx, start_cy
                started_maximized = target == "main" and bool(windows.get("maximized"))

                deadline = time.perf_counter() + 0.12
                while not _is_primary_mouse_down() and time.perf_counter() < deadline:
                    time.sleep(0.002)

                while windows.get("drag_token") == token and _is_primary_mouse_down():
                    cx, cy = _get_cursor_pos()
                    if cx != last_cx or cy != last_cy:
                        if started_maximized:
                            if abs(cx - start_cx) >= 6 or abs(cy - start_cy) >= 6:
                                started_maximized = False
                                windows["maximized"] = False
                                saved = windows.get("normal_rect")
                                if isinstance(saved, tuple) and len(saved) == 4:
                                    _, _, nw, nh = saved
                                else:
                                    scale = _get_window_dpi_scale(hwnd)
                                    nw, nh = int(1400 * scale), int(880 * scale)
                                ratio_x = max(0.12, min(0.88, (cx - rx) / max(1, rw)))
                                rx = int(cx - nw * ratio_x)
                                ry = max(0, int(cy - 22 * _get_window_dpi_scale(hwnd)))
                                rw, rh = nw, nh
                                start_cx, start_cy = cx, cy
                                _set_window_rect(hwnd, rx, ry, rw, rh)
                                dispatch_js_event("main", "zhiling:window-maximized", "false")
                        else:
                            _move_window_only(hwnd, rx + (cx - start_cx), ry + (cy - start_cy))
                        last_cx, last_cy = cx, cy
                    time.sleep(0.002)

                # 主窗口拖到当前显示器最顶端边缘松手时，触发与按钮一致的丝滑 GPU FLIP 贴边最大化
                if target == "main" and not windows.get("maximized") and windows.get("drag_token") == token:
                    end_cx, end_cy = _get_cursor_pos()
                    if abs(end_cx - start_cx) > 8 or abs(end_cy - start_cy) > 8:
                        work = _get_monitor_work_area(hwnd)
                        cur_now = _get_window_rect(hwnd)
                        if work and cur_now and end_cy <= work[1] + 4:
                            dispatch_js_event("main", "zhiling:trigger-maximize", "true")

            threading.Thread(target=_drag_loop, name="zhiling-win32-drag", daemon=True).start()
            return True

        def start_native_resize(self, target: str, mode: str) -> bool:
            """启动原生八向边缘自由缩放。"""
            if target == "main" and windows.get("maximized"):
                return False
            if sys.platform == "darwin":
                from desktop_macos import start_macos_resize
                return start_macos_resize(
                    windows.get(target),
                    mode,
                    windows,
                    min_w=1024 if target == "main" else 360,
                    min_h=680 if target == "main" else 130,
                )
            hwnd = get_hwnd(target)
            if not hwnd:
                return False
            rect = _get_window_rect(hwnd)
            if not rect:
                return False

            token = int(windows.get("drag_token", 0)) + 1  # type: ignore[arg-type]
            windows["drag_token"] = token
            start_cx, start_cy = _get_cursor_pos()
            scale = _get_window_dpi_scale(hwnd)
            min_w = int((1024 if target == "main" else 360) * scale)
            min_h = int((680 if target == "main" else 130) * scale)

            def _resize_loop() -> None:
                rx, ry, rw, rh = rect
                last_cx, last_cy = start_cx, start_cy
                deadline = time.perf_counter() + 0.12
                while not _is_primary_mouse_down() and time.perf_counter() < deadline:
                    time.sleep(0.002)

                while windows.get("drag_token") == token and _is_primary_mouse_down():
                    cx, cy = _get_cursor_pos()
                    if cx != last_cx or cy != last_cy:
                        dx, dy = cx - start_cx, cy - start_cy
                        nx, ny, nw, nh = rx, ry, rw, rh
                        if "e" in mode:
                            nw = max(min_w, rw + dx)
                        if "s" in mode:
                            nh = max(min_h, rh + dy)
                        if "w" in mode:
                            nw = max(min_w, rw - dx)
                            nx = rx + (rw - nw)
                        if "n" in mode:
                            nh = max(min_h, rh - dy)
                            ny = ry + (rh - nh)
                        _set_window_rect(hwnd, nx, ny, nw, nh)
                        last_cx, last_cy = cx, cy
                    time.sleep(0.002)

            threading.Thread(target=_resize_loop, name="zhiling-win32-resize", daemon=True).start()
            return True

        def toggle_mini_overlay(self) -> bool:
            existing = windows.get("mini")
            if existing is not None:
                try:
                    existing.destroy()  # type: ignore[attr-defined]
                    windows.pop("mini", None)
                    return False
                except Exception:
                    windows.pop("mini", None)

            mini_win = webview.create_window(
                "知聆课堂 · 实时字幕",
                mini_url,
                width=580,
                height=260,
                frameless=True,
                transparent=True,
                on_top=True,
                easy_drag=False,
                resizable=True,
                min_size=(360, 130),
                js_api=self,
            )
            windows["mini"] = mini_win

            def _on_mini_shown() -> None:
                hwnd = get_hwnd("mini")
                if hwnd:
                    _apply_dwm_alpha_and_frameless(hwnd)

            def _on_mini_loaded() -> None:
                configure_native_webview(mini_win, is_main=False)

            def _on_mini_closed() -> None:
                h = get_hwnd("mini")
                _HOOKED_WNDPROCS.pop(h, None)
                if windows.get("mini") is mini_win:
                    windows.pop("mini", None)

            mini_win.events.shown += _on_mini_shown
            mini_win.events.loaded += _on_mini_loaded
            mini_win.events.closed += _on_mini_closed
            return True

        def minimize_mini_overlay(self) -> None:
            mini_win = windows.get("mini")
            if mini_win is None:
                return
            windows["was_minimized_mini"] = True
            if sys.platform == "darwin":
                from desktop_macos import minimize_macos_window
                minimize_macos_window(mini_win)
                return
            hwnd = get_hwnd("mini")
            if hwnd:
                _set_dwm_transitions_disabled(hwnd, True)
                _u32.ShowWindow(wintypes.HWND(hwnd), 7)  # SW_SHOWMINNOACTIVE
            else:
                mini_win.minimize()  # type: ignore[attr-defined]

        def close_mini_overlay(self) -> None:
            mini_win = windows.pop("mini", None)
            if mini_win is None:
                return
            if sys.platform == "darwin":
                from desktop_macos import close_macos_window

                def _destroy_mini() -> None:
                    try:
                        mini_win.destroy()  # type: ignore[attr-defined]
                    except Exception:
                        pass

                close_macos_window(mini_win, destroy_after=_destroy_mini, use_order_out=True)
                return
            hwnd = get_hwnd("mini")
            if hwnd:
                _set_dwm_transitions_disabled(hwnd, True)
                try:
                    _u32.ShowWindow(wintypes.HWND(hwnd), 0)
                except Exception:
                    pass
            try:
                mini_win.destroy()  # type: ignore[attr-defined]
            except Exception:
                pass

        def resize_mini_overlay(self, width: int, height: int) -> bool:
            mini_win = windows.get("mini")
            if mini_win is None:
                return False
            try:
                safe_w = max(360, min(920, int(width)))
                safe_h = max(130, min(760, int(height)))
                mini_win.resize(safe_w, safe_h)  # type: ignore[attr-defined]
                return True
            except Exception:
                return False

        def begin_window_op(self, target: str, mode: str) -> bool:
            if mode == "move":
                return self.start_native_drag(target)
            return self.start_native_resize(target, mode)

        def step_window_op(self) -> None:
            return None

        def end_window_op(self) -> None:
            windows["drag_token"] = int(windows.get("drag_token", 0)) + 1  # type: ignore[arg-type]

        def show_topmost_alert(self, title: str, message: str, can_resume: bool = True) -> bool:
            """在系统屏幕顶部中央弹出不抢占焦点的跨平台置顶警示浮窗（用于外力导致录音中断时醒目提醒）。"""
            if is_self_test:
                return True

            def _do_resume() -> None:
                self.focus_main_window()
                dispatch_js_event("main", "zhiling:alert-resume-recording", "true")

            def _do_focus() -> None:
                self.focus_main_window()

            if sys.platform == "darwin":
                from desktop_macos import show_macos_topmost_alert
                return show_macos_topmost_alert(
                    title,
                    message,
                    can_resume=bool(can_resume),
                    on_resume=_do_resume,
                    on_focus_main=_do_focus,
                )

            if sys.platform == "win32":
                main_win = windows.get("main")
                native = getattr(main_win, "native", None)
                if native is None:
                    return False
                try:
                    from System import Action  # type: ignore
                    import System.Drawing as Drawing  # type: ignore
                    import System.Windows.Forms as WinForms  # type: ignore

                    def _show_win_panel() -> None:
                        old_form = windows.pop("alert_form", None)
                        if old_form is not None:
                            try:
                                old_form.Close()  # type: ignore[attr-defined]
                                old_form.Dispose()  # type: ignore[attr-defined]
                            except Exception:
                                pass

                        form = WinForms.Form()
                        form.FormBorderStyle = getattr(WinForms.FormBorderStyle, "None")
                        form.StartPosition = WinForms.FormStartPosition.Manual
                        form.ShowInTaskbar = False
                        form.TopMost = True
                        form.BackColor = Drawing.Color.FromArgb(255, 255, 255)
                        form.Size = Drawing.Size(476, 152)

                        screen_wa = WinForms.Screen.PrimaryScreen.WorkingArea
                        left = int(screen_wa.X + (screen_wa.Width - form.Width) / 2)
                        top = int(screen_wa.Y + 18)
                        form.Location = Drawing.Point(left, top)

                        # 外边框微描边
                        def _on_paint(_s, evt):
                            pen = Drawing.Pen(Drawing.Color.FromArgb(245, 162, 158), 2)
                            evt.Graphics.DrawRectangle(pen, 0, 0, form.Width - 1, form.Height - 1)
                            pen.Dispose()

                        form.Paint += _on_paint

                        strip = WinForms.Panel()
                        strip.BackColor = Drawing.Color.FromArgb(216, 57, 49)
                        strip.Location = Drawing.Point(0, 0)
                        strip.Size = Drawing.Size(5, form.Height)
                        form.Controls.Add(strip)

                        lbl_title = WinForms.Label()
                        lbl_title.Text = title or "知聆课堂 · 录音已意外暂停"
                        lbl_title.Font = Drawing.Font("Microsoft YaHei UI", 10.5, Drawing.FontStyle.Bold)
                        lbl_title.ForeColor = Drawing.Color.FromArgb(216, 57, 49)
                        lbl_title.Location = Drawing.Point(18, 14)
                        lbl_title.Size = Drawing.Size(442, 24)
                        form.Controls.Add(lbl_title)

                        lbl_msg = WinForms.Label()
                        lbl_msg.Text = message or "录音因外部异常中断，请检查设备与连接。"
                        lbl_msg.Font = Drawing.Font("Microsoft YaHei UI", 9.5)
                        lbl_msg.ForeColor = Drawing.Color.FromArgb(31, 35, 41)
                        lbl_msg.Location = Drawing.Point(18, 42)
                        lbl_msg.Size = Drawing.Size(442, 56)
                        form.Controls.Add(lbl_msg)

                        def _close_form() -> None:
                            try:
                                if windows.get("alert_form") is form:
                                    windows.pop("alert_form", None)
                                form.Close()
                                form.Dispose()
                            except Exception:
                                pass

                        def _make_btn(text: str, x: int, w: int, primary: bool, on_click) -> object:
                            btn = WinForms.Button()
                            btn.Text = text
                            btn.FlatStyle = WinForms.FlatStyle.Flat
                            btn.Font = Drawing.Font("Microsoft YaHei UI", 9.0, Drawing.FontStyle.Bold if primary else Drawing.FontStyle.Regular)
                            btn.Size = Drawing.Size(w, 32)
                            btn.Location = Drawing.Point(x, 106)
                            if primary:
                                btn.BackColor = Drawing.Color.FromArgb(20, 86, 240)
                                btn.ForeColor = Drawing.Color.White
                                btn.FlatAppearance.BorderSize = 0
                            else:
                                btn.BackColor = Drawing.Color.FromArgb(245, 246, 247)
                                btn.ForeColor = Drawing.Color.FromArgb(31, 35, 41)
                                btn.FlatAppearance.BorderColor = Drawing.Color.FromArgb(222, 224, 227)
                            btn.Click += lambda _s, _e: on_click()
                            form.Controls.Add(btn)
                            return btn

                        cur_x = form.Width - 16
                        _make_btn("忽略", cur_x - 72, 72, False, _close_form)
                        cur_x -= 80
                        _make_btn(
                            "打开主窗口",
                            cur_x - 102,
                            102,
                            not can_resume,
                            lambda: (_close_form(), threading.Thread(target=_do_focus, daemon=True).start()),
                        )
                        cur_x -= 110
                        if can_resume:
                            _make_btn(
                                "恢复录音",
                                cur_x - 94,
                                94,
                                True,
                                lambda: (_close_form(), threading.Thread(target=_do_resume, daemon=True).start()),
                            )

                        # 创建句柄并应用 Windows 11 原生圆角 + 不抢焦点置顶弹出
                        alert_hwnd = int(form.Handle.ToInt32())
                        try:
                            round_pref = ctypes.c_int(2)  # DWMWCP_ROUND
                            _dwm.DwmSetWindowAttribute(
                                wintypes.HWND(alert_hwnd), 33, ctypes.byref(round_pref), ctypes.sizeof(round_pref)
                            )
                        except Exception:
                            pass
                        # SW_SHOWNOACTIVATE = 4; HWND_TOPMOST = -1; SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW
                        _u32.ShowWindow(ctypes.c_void_p(alert_hwnd), 4)
                        _u32.SetWindowPos(
                            ctypes.c_void_p(alert_hwnd),
                            ctypes.c_void_p(-1),
                            0,
                            0,
                            0,
                            0,
                            0x0010 | 0x0002 | 0x0001 | 0x0040,
                        )
                        windows["alert_form"] = form

                    if native.InvokeRequired:
                        native.Invoke(Action(_show_win_panel))
                    else:
                        _show_win_panel()
                    return True
                except Exception:
                    return False
            return False

        def save_exported_file(self, filename: str, content_base64: str) -> str | None:
            """调用系统原生「存储为」面板保存导出文档，解决 macOS WKWebView 忽略 blob: 下载的问题。"""
            main_win = windows.get("main")
            if main_win is None:
                return None
            safe_name = Path(filename or "课堂笔记.md").name
            try:
                raw = base64.b64decode(content_base64)
            except Exception:
                return None
            try:
                save_dialog = getattr(webview, "FileDialog", None)
                dialog_type = save_dialog.SAVE if save_dialog is not None else getattr(webview, "SAVE_DIALOG", 30)
                result = main_win.create_file_dialog(  # type: ignore[attr-defined]
                    dialog_type,
                    save_filename=safe_name,
                )
                target: str | None = None
                if isinstance(result, str) and result.strip():
                    target = result
                elif isinstance(result, (list, tuple)) and result:
                    target = str(result[0])
                if not target:
                    return ""
                out_path = Path(target)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_bytes(raw)
                return str(out_path)
            except Exception:
                return None

        def quit_for_update(self) -> bool:
            """热更新脚本拉起后极速退出桌面宿主与后端服务，缩短等待时间并确保 100% 释放文件句柄。"""
            def _shutdown() -> None:
                time.sleep(0.12)
                try:
                    server.should_exit = True
                except Exception:
                    pass
                mini_win = windows.pop("mini", None)
                if mini_win is not None:
                    try:
                        mini_win.destroy()  # type: ignore[attr-defined]
                    except Exception:
                        pass
                if sys.platform == "win32":
                    hwnd = get_hwnd("main")
                    if hwnd:
                        try:
                            _u32.ShowWindow(wintypes.HWND(hwnd), 0)  # SW_HIDE 立即反馈退出
                        except Exception:
                            pass
                    # Windows 下直接短暂等待响应回传后极速退出，避免 WinForms destroy + server_thread.join 阻塞 7 秒
                    time.sleep(0.35)
                    os._exit(0)
                main_win = windows.get("main")
                if main_win is not None:
                    try:
                        main_win.destroy()  # type: ignore[attr-defined]
                    except Exception:
                        pass
                time.sleep(1.5)
                os._exit(0)

            threading.Thread(target=_shutdown, name="zhiling-update-quit", daemon=True).start()
            return True

        def open_path_in_explorer(self, path: str) -> bool:
            """在系统资源管理器或访达中打开文件所在目录（源码开发模式降级使用）。"""
            target = Path(path).expanduser()
            if not target.exists():
                return False
            try:
                if sys.platform == "darwin":
                    subprocess.Popen(["open", "-R", str(target)] if target.is_file() else ["open", str(target)])
                elif sys.platform == "win32":
                    if target.is_file():
                        subprocess.Popen(["explorer", "/select,", str(target)])
                    else:
                        subprocess.Popen(["explorer", str(target)])
                else:
                    webbrowser.open(target.as_uri())
                return True
            except Exception:
                return False

    bridge = DesktopBridge()
    main_win = webview.create_window(
        "知聆课堂",
        main_url,
        width=1400,
        height=880,
        min_size=(1024, 680),
        frameless=True,
        transparent=True,
        easy_drag=False,
        hidden=is_self_test,
        js_api=bridge,
    )
    windows["main"] = main_win

    def on_main_shown() -> None:
        hwnd = get_hwnd("main")
        if hwnd:
            _apply_dwm_alpha_and_frameless(hwnd)

    def on_main_loaded() -> None:
        configure_native_webview(main_win, is_main=True)

    def on_main_closed() -> None:
        h = get_hwnd("main")
        _HOOKED_WNDPROCS.pop(h, None)
        mini_win = windows.pop("mini", None)
        if mini_win is not None:
            try:
                mini_win.destroy()  # type: ignore[attr-defined]
            except Exception:
                pass
        server.should_exit = True

    main_win.events.shown += on_main_shown
    main_win.events.loaded += on_main_loaded
    main_win.events.closed += on_main_closed

    def self_test_worker() -> None:
        report: dict[str, object] = {"ok": False, "port": port}
        try:
            main_win.events.loaded.wait(12)
            diag = configure_native_webview(main_win, is_main=True)
            report["webview"] = diag
            time.sleep(0.8)

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as resp:
                html_text = resp.read().decode("utf-8", errors="ignore")
                report["rootHttpStatus"] = resp.status
                report["hasHtmlRoot"] = 'id="root"' in html_text

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/settings", timeout=5) as resp:
                settings_resp = json.loads(resp.read().decode("utf-8"))
                report["settingsOk"] = resp.status == 200 and "data" in settings_resp

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/sessions", timeout=5) as resp:
                sessions_resp = json.loads(resp.read().decode("utf-8"))
                report["sessionsOk"] = resp.status == 200 and "data" in sessions_resp

            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/audio/devices", timeout=5) as resp:
                devs = json.loads(resp.read().decode("utf-8"))
                report["wasapiOk"] = resp.status == 200 and bool(
                    devs.get("data", {}).get("wasapiSupported")
                )

            ui_probe = main_win.evaluate_js(
                """(() => {
                  const root = document.getElementById('root');
                  const shell = root && root.firstElementChild && root.firstElementChild.querySelector('.rounded-\\\\[16px\\\\]');
                  return {
                    domLen: root ? root.innerHTML.length : 0,
                    hasDesktopClass: document.documentElement.classList.contains('desktop-shell-mode'),
                    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
                    bodyBg: getComputedStyle(document.body).backgroundColor,
                    borderRadius: shell ? getComputedStyle(shell).borderRadius : null,
                    hasDragBridge: Boolean(window.pywebview && window.pywebview.api && window.pywebview.api.start_native_drag)
                  };
                })()"""
            )
            report["mainWindowProbe"] = ui_probe

            bridge.toggle_mini_overlay()
            mini_w = windows.get("mini")
            if mini_w is not None:
                mini_w.events.loaded.wait(8)  # type: ignore[attr-defined]
                time.sleep(0.4)
                mini_probe = mini_w.evaluate_js(  # type: ignore[attr-defined]
                    """(() => ({
                      hasMiniClass: document.documentElement.classList.contains('mini-overlay-mode'),
                      bodyBg: getComputedStyle(document.body).backgroundColor,
                      domLen: document.getElementById('root') ? document.getElementById('root').innerHTML.length : 0
                    }))()"""
                )
                report["miniOverlayProbe"] = mini_probe
                bridge.close_mini_overlay()

            report["ok"] = bool(
                report.get("rootHttpStatus") == 200
                and report.get("settingsOk")
                and report.get("sessionsOk")
                and report.get("wasapiOk")
                and diag.get("alphaComposited") is True
                and isinstance(ui_probe, dict)
                and ui_probe.get("domLen", 0) > 100
                and ui_probe.get("hasDesktopClass") is True
                and ui_probe.get("hasDragBridge") is True
                and ui_probe.get("bodyBg") == "rgba(0, 0, 0, 0)"
                and ui_probe.get("borderRadius") == "16px"
                and isinstance(report.get("miniOverlayProbe"), dict)
                and report["miniOverlayProbe"].get("bodyBg") == "rgba(0, 0, 0, 0)"  # type: ignore[index]
            )
        except Exception as exc:
            report["error"] = str(exc)
        finally:
            text = json.dumps(report, ensure_ascii=False, indent=2)
            if self_test_out is not None:
                self_test_out.parent.mkdir(parents=True, exist_ok=True)
                self_test_out.write_text(text, encoding="utf-8")
            print("SELF_TEST_REPORT:", text)
            bridge.close_window()

    if is_self_test:
        webview_storage = app_home / ("wkwebview_selftest" if sys.platform == "darwin" else "webview2_selftest")
    else:
        webview_storage = app_home / ("wkwebview" if sys.platform == "darwin" else "webview2")
    webview_storage.mkdir(parents=True, exist_ok=True)
    gui_backend = "cocoa" if sys.platform == "darwin" else "edgechromium"

    try:
        webview.start(
            self_test_worker if is_self_test else None,
            gui=gui_backend,
            private_mode=False,
            storage_path=str(webview_storage),
            icon=str(icon_path) if (icon_path and sys.platform != "darwin") else None,
        )
    finally:
        server.should_exit = True
        server_thread.join(timeout=8.0)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
