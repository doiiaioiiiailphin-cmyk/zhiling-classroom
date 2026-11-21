import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError, OperationalError
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware

from .api import router, ws_router
from .db import Database
from .errors import AppError
from .providers.opencode_bridge import OpenCodeBridge
from .repository import Locks, Repository
from .services.addons import WebRtcAec3AddonManager
from .services.attachments import AttachmentStorage
from .services.audio import AudioStorage
from .services.builtin_asr import BuiltinAsrRuntime
from .services.classroom_ai import ClassroomAI
from .services.stream import ClassroomStreams
from .services.updater import AppUpdaterService
from .services.win_audio import WindowsAudioBackend
from .services.win_desktop import DesktopEventBus
from .settings import SettingsStore

logger = logging.getLogger(__name__)
DEFAULT_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
LOCAL_ORIGINS = (
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:8000", "http://127.0.0.1:8000",
)


def error_response(error: AppError, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"error": error.payload()}, status_code=error.status, headers=headers)


class JsonCors(CORSMiddleware):
    def preflight_response(self, request_headers: Headers):
        response = super().preflight_response(request_headers)
        if response.status_code == 200:
            return response
        headers = {
            name: value for name, value in response.headers.items()
            if name not in ("content-type", "content-length")
        }
        return error_response(AppError(400, "CORS_PREFLIGHT_REJECTED", "跨域预检未通过"), headers)


class LocalOriginGuard:
    def __init__(self, app, origins: tuple[str, ...]):
        self.app, self.origins = app, frozenset(origins)
        self.hosts = {"localhost", "127.0.0.1", "::1", *(urlsplit(origin).hostname for origin in origins)}

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = Headers(scope=scope)
            try:
                host = urlsplit("//" + headers.get("host", "")).hostname
            except ValueError:
                host = None
            origin = headers.get("origin")
            if host not in self.hosts or (origin is not None and origin not in self.origins):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    response = error_response(AppError(403, "ORIGIN_FORBIDDEN", "该来源无权访问本地课堂服务"))
                    await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def _resolve_default_dist_dir() -> Path:
    env_dist = os.getenv("ZHILING_DIST_DIR")
    if env_dist:
        return Path(env_dist).resolve()
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidate = Path(meipass) / "dist"
        if candidate.is_dir():
            return candidate.resolve()
    return (Path(__file__).resolve().parents[2] / "dist").resolve()


def create_app(
    data_dir: Path | None = None,
    *,
    builtin_asr_dir: Path | None = None,
    opencode_cli_dir: Path | None = None,
    dist_dir: Path | None = None,
    http_transport: httpx.AsyncBaseTransport | None = None,
    origins: tuple[str, ...] | None = None,
    enable_os_hotkeys: bool | None = None,
    screen_capturer=None,
    serve_dist: bool | None = None,
) -> FastAPI:
    is_default_data = data_dir is None
    data_dir = Path(data_dir or os.getenv("ZHILING_DATA_DIR") or DEFAULT_DATA_DIR).resolve()
    if enable_os_hotkeys is None:
        enable_os_hotkeys = is_default_data and os.getenv("ZHILING_DISABLE_OS_HOTKEYS") != "1"
    if serve_dist is None:
        serve_dist = os.getenv("ZHILING_SERVE_DIST") == "1"
    if origins is None:
        extra = os.getenv("ZHILING_ALLOWED_ORIGINS", "")
        origins = (*LOCAL_ORIGINS, *(origin.strip() for origin in extra.split(",") if origin.strip()))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = Database(data_dir / "classroom.sqlite3")
        desktop = DesktopEventBus(enable_os_hook=bool(enable_os_hotkeys))
        try:
            await db.initialize()
            repo, locks = Repository(db), Locks()
            settings = SettingsStore(db, data_dir)
            await settings.initialize()
            current_settings = await settings.get()
            desktop.start(asyncio.get_running_loop(), current_settings.desktop_hotkeys)
            audio = AudioStorage(data_dir / "recordings")
            await audio.recover_deletions(repo)
            attachments = AttachmentStorage(data_dir / "attachments", repo, screen_capturer=screen_capturer)
            async with httpx.AsyncClient(
                transport=http_transport, timeout=httpx.Timeout(180, connect=15, pool=15),
                limits=httpx.Limits(max_connections=40, max_keepalive_connections=12),
                headers={"User-Agent": "zhiling-classroom/1.0"},
                follow_redirects=False,
            ) as client:
                opencode = OpenCodeBridge(
                    data_dir / "addons" / "opencode-free", client, settings.save_opencode_catalog,
                    runtime_dir=opencode_cli_dir,
                )
                ai = ClassroomAI(repo, settings, client, locks, attachments=attachments, opencode=opencode)
                builtin_asr = BuiltinAsrRuntime(builtin_asr_dir or data_dir / "addons" / "builtin-free-asr")
                streams = ClassroomStreams(repo, settings, client, locks, audio, ai, builtin_asr)
                addons = WebRtcAec3AddonManager(data_dir / "addons")
                updater = AppUpdaterService(data_dir, client)
                win_audio = WindowsAudioBackend()
                app.state.repo = repo
                app.state.settings = settings
                app.state.http = client
                app.state.opencode = opencode
                app.state.audio = audio
                app.state.attachments = attachments
                app.state.ai = ai
                app.state.streams = streams
                app.state.addons = addons
                app.state.updater = updater
                app.state.builtin_asr = builtin_asr
                app.state.win_audio = win_audio
                app.state.desktop = desktop
                try:
                    yield
                finally:
                    try:
                        await streams.pipeline.shutdown()
                    finally:
                        await opencode.close()
        finally:
            desktop.stop()
            await db.engine.dispose()

    app = FastAPI(
        title="知聆课堂", version="1.0.0", lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False,
    )
    app.add_middleware(
        JsonCors,
        allow_origins=list(origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "Range"],
        expose_headers=["Content-Disposition", "Content-Range", "Accept-Ranges"],
    )
    app.add_middleware(LocalOriginGuard, origins=origins)
    app.include_router(router)
    app.include_router(ws_router)

    resolved_dist = Path(dist_dir).resolve() if dist_dir is not None else _resolve_default_dist_dir()
    if serve_dist and (resolved_dist / "index.html").is_file():
        assets_dir = resolved_dist / "assets"
        if assets_dir.is_dir():
            app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

        favicon_file = resolved_dist / "favicon.ico"
        if favicon_file.is_file():
            @app.get("/favicon.ico")
            async def serve_favicon():
                return FileResponse(favicon_file)

        @app.get("/")
        async def serve_spa_root():
            return FileResponse(resolved_dist / "index.html")

    @app.exception_handler(AppError)
    async def app_error(_: Request, error: AppError):
        return error_response(error)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, error: RequestValidationError):
        issue = error.errors()[0]
        location = ".".join(str(part) for part in issue["loc"] if part not in {"body", "query", "path"})
        message = f"请求参数无效（{location}）" if location else "请求格式无效"
        return error_response(AppError(400, "INVALID_REQUEST", message))

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException):
        errors = {
            404: ("NOT_FOUND", "请求的接口不存在"),
            405: ("METHOD_NOT_ALLOWED", "该接口不支持此请求方法"),
        }
        code, message = errors.get(error.status_code, ("HTTP_ERROR", "请求处理失败"))
        return error_response(AppError(error.status_code, code, message), error.headers)

    @app.exception_handler(IntegrityError)
    async def conflict(_: Request, __: IntegrityError):
        return error_response(AppError(409, "DATA_CONFLICT", "关联数据已变更，请刷新后重试"))

    @app.exception_handler(OperationalError)
    async def database_error(_: Request, error: OperationalError):
        if getattr(error.orig, "sqlite_errorcode", None) in (5, 6):
            return error_response(AppError(503, "DATABASE_BUSY", "课堂数据库繁忙，请稍后重试"))
        logger.error("Classroom database operation failed (%s)", type(error.orig).__name__)
        return error_response(AppError(500, "DATABASE_ERROR", "课堂数据库处理失败"))

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        logger.error("Unexpected failure on %s (%s)", request.method, type(error).__name__)
        return error_response(AppError(500, "INTERNAL_ERROR", "服务内部错误"))

    return app


app = create_app()
