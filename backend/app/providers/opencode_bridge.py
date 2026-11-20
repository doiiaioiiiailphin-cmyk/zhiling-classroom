import asyncio
import hashlib
import json
import math
import os
import platform
import shutil
import socket
import subprocess
from collections.abc import AsyncIterator, Awaitable, Callable
from http.server import ThreadingHTTPServer
from pathlib import Path
from secrets import token_urlsafe
from tempfile import TemporaryDirectory
from threading import Thread, local
from time import monotonic
from types import ModuleType

import httpx

from ..errors import AppError
from .opencode_runtime import OPENCODE_ARTIFACTS, OPENCODE_VERSION, DownloadProgress, install_cli, matches_cli
from .platform_hooks import resolve_opencode_platform_spec


SOURCE_COMMIT = "cf104aae85607b12d815a61906a0b65c25f8d457"
SOURCE_URL = f"https://raw.githubusercontent.com/prestonw/opencode-free-bridge/{SOURCE_COMMIT}/opencode_bridge.py"
SOURCE_SHA256 = "b887659fd172c4632d9a0143117665a8a77de744dbee1a289787351ac23ba2cf"
CLOUD_CATALOG = "https://opencode.ai/inference/v1/models"
CATALOG_LIFETIME = 300
OPENCODE_CLI_REQUIRED = "OPENCODE_CLI_REQUIRED"


class OpenCodeBridge:
    """Host the upstream bridge against an isolated, authenticated OpenCode 2 process."""

    def __init__(
        self, directory: Path, network: httpx.AsyncClient, save_catalog: Callable[[list[str]], Awaitable[None]],
        *, runtime_dir: Path | None = None,
    ):
        self.directory = directory
        self.network = network
        self.save_catalog = save_catalog
        self.loopback = httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(100, connect=3))
        self.lock = asyncio.Lock()
        spec = resolve_opencode_platform_spec(runtime_dir or directory, OPENCODE_VERSION)
        self.cli_artifact = OPENCODE_ARTIFACTS.get(spec.npm_package_hint)
        self.managed_executable = spec.managed_binary_path if self.cli_artifact is not None else None
        self._verified_stamp: tuple[int, int, int] | None = None
        self._managed_valid = False
        self.automatic_download_decision = asyncio.Event()
        self.process: subprocess.Popen | None = None
        self.profile: TemporaryDirectory | None = None
        self.server: ThreadingHTTPServer | None = None
        self.token = token_urlsafe(32)
        self.password = token_urlsafe(32)
        self.origin = ""
        self.catalog: tuple[str, ...] = ()
        self.catalog_time = 0.0
        self.retry_at = 0.0

    def _cached_cli(self) -> str | None:
        path = self.managed_executable
        artifact = self.cli_artifact
        if path is None or artifact is None:
            return None
        try:
            info = path.stat()
        except OSError:
            return None
        stamp = (info.st_mtime_ns, info.st_size, info.st_mode)
        if self._verified_stamp != stamp:
            self._managed_valid = os.access(path, os.X_OK) and matches_cli(path, artifact)
            self._verified_stamp = stamp
        return str(path) if self._managed_valid else None

    def executable(self) -> str:
        override = os.getenv("ZHILING_OPENCODE_EXECUTABLE", "").strip()
        pointer = self.directory / "executable.txt"
        if not override and pointer.is_file():
            try:
                override = pointer.read_text(encoding="utf-8-sig").strip()
            except (OSError, UnicodeError):
                raise AppError(503, "OPENCODE_EXECUTABLE_CONFIG", "无法读取本机 OpenCode 程序路径") from None
        local_binary = self.directory / ("opencode.exe" if os.name == "nt" else "opencode")
        resolved = override or (str(local_binary) if local_binary.is_file() else None) or self._cached_cli()
        if not resolved and self.managed_executable is not None:
            raise AppError(409, OPENCODE_CLI_REQUIRED, "请先下载 OpenCode 组件")
        if not resolved:
            resolved = shutil.which("opencode2") or shutil.which("opencode")
        if not resolved or not Path(resolved).is_file():
            raise AppError(503, "OPENCODE_NOT_INSTALLED", "请先安装 OpenCode 2，再刷新免费模型")
        if not override and os.name == "nt" and Path(resolved).suffix.lower() in {".cmd", ".bat"}:
            # npm prints the path of a launcher on Windows. Start its native binary so the reported PID is ours.
            npm_modules = Path(resolved).parent / "node_modules" / "@opencode"
            arch = "arm64" if platform.machine().lower() == "arm64" else "x64"
            candidates = (
                npm_modules / f"cli-windows-{arch}" / "bin" / "opencode.exe",
                npm_modules / "cli" / "bin" / "opencode.exe",
            )
            resolved = next((str(path) for path in candidates if path.is_file()), "")
            if not resolved:
                raise AppError(503, "OPENCODE_EXECUTABLE_CONFIG", "请指定 OpenCode 2 原生程序的绝对路径")
        return str(Path(resolved).resolve())

    def needs_download(self) -> bool:
        try:
            self.executable()
        except AppError as error:
            return error.code == OPENCODE_CLI_REQUIRED
        return False

    async def decide_download(self, confirmed: bool, *, on_progress: DownloadProgress | None = None) -> None:
        size = 0
        if confirmed:
            async with self.lock:
                target, artifact = self.managed_executable, self.cli_artifact
                if target is not None and artifact is not None and self.needs_download():
                    await install_cli(self.network, target, artifact, on_progress=on_progress)
                    self._verified_stamp = None
                    size = artifact.archive_bytes
                if on_progress is not None:
                    await on_progress("starting", size, size, 100 if size else 0)
                await self.start()
        self.automatic_download_decision.set()
        if confirmed and on_progress is not None:
            await on_progress("ready", size, size, 100 if size else 0)

    async def download_stream(self) -> AsyncIterator[dict]:
        queue: asyncio.Queue[dict | Exception | None] = asyncio.Queue()

        async def emit(stage: str, downloaded: int, total: int, percent: int) -> None:
            await queue.put({
                "type": "progress",
                "stage": stage,
                "downloadedBytes": downloaded,
                "totalBytes": total,
                "percent": percent,
            })

        async def worker() -> None:
            try:
                await self.decide_download(True, on_progress=emit)
                await queue.put({"type": "done", "data": True})
            except Exception as exc:
                await queue.put(exc)
            finally:
                await queue.put(None)

        task = asyncio.create_task(worker())
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def await_automatic_download(self) -> None:
        try:
            async with asyncio.timeout(320):
                await self.automatic_download_decision.wait()
        except TimeoutError:
            self.automatic_download_decision.set()

    async def bridge_module(self) -> ModuleType:
        path = self.directory / "upstream_bridge.py"
        source = path.read_bytes() if path.is_file() else b""
        if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
            try:
                response = await self.network.get(SOURCE_URL, timeout=12)
                response.raise_for_status()
                source = response.content
            except httpx.HTTPError:
                raise AppError(503, "OPENCODE_BRIDGE_DOWNLOAD", "无法下载 OpenCode 桥接器，请检查网络后重试") from None
            if hashlib.sha256(source).hexdigest() != SOURCE_SHA256:
                raise AppError(502, "OPENCODE_BRIDGE_INTEGRITY", "OpenCode 桥接器校验失败")
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(source)
            temporary.replace(path)
        module = ModuleType("zhiling_opencode_free_bridge")
        exec(compile(source, str(path), "exec"), module.__dict__)
        return module

    async def start(self):
        if self.process is not None and self.process.poll() is None and self.server is not None:
            return
        await self.stop()
        executable = self.executable()
        self.directory.mkdir(parents=True, exist_ok=True)
        module = await self.bridge_module()
        self.profile = TemporaryDirectory(prefix="profile-", dir=self.directory)
        root = Path(self.profile.name)
        # Keep credentials, plugins and agent permissions from the user's OpenCode installation out of the bridge.
        inherited = {
            "APPDATA", "LOCALAPPDATA", "COMSPEC", "HOME", "PATH", "SYSTEMROOT", "TEMP", "TMP",
            "USERPROFILE", "WINDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE",
        }
        env = {key: value for key, value in os.environ.items() if key.upper() in inherited}
        for name in ("CACHE", "CONFIG", "DATA", "STATE"):
            env[f"XDG_{name}_HOME"] = str(root / name.lower())
        env.update({
            "OPENCODE_SERVER_USERNAME": "opencode",
            "OPENCODE_SERVER_PASSWORD": self.password,
            "OPENCODE_CONFIG_CONTENT": json.dumps({
                "enabled_providers": ["opencode"], "autoupdate": False, "share": "disabled",
                "permission": {"*": "deny"},
            }),
        })
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.origin = f"http://127.0.0.1:{port}"
        try:
            self.process = subprocess.Popen(
                [executable, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            await self.wait_ready()
            self.start_bridge(module)
        except OSError:
            await self.stop()
            raise AppError(503, "OPENCODE_START_FAILED", "本机 OpenCode 服务启动失败") from None
        except BaseException:
            await self.stop()
            raise

    async def wait_ready(self):
        for _ in range(65):
            if self.process.poll() is not None:
                break
            try:
                response = await self.loopback.get(
                    self.origin + "/api/info", auth=("opencode", self.password), timeout=0.5,
                )
                if response.is_success:
                    info = response.json()
                    if isinstance(info, dict) and info.get("pid") == self.process.pid:
                        return
                if response.status_code == 404 or not response.headers.get("content-type", "").startswith("application/json"):
                    raise AppError(503, "OPENCODE_UPDATE_REQUIRED", "OpenCode 免费桥接需要 OpenCode 2")
            except (httpx.TransportError, ValueError):
                pass
            await asyncio.sleep(0.15)
        raise AppError(503, "OPENCODE_START_FAILED", "等待本机 OpenCode 服务就绪超时")

    def start_bridge(self, module: ModuleType):
        owner = self
        loop = asyncio.get_running_loop()
        request_state = local()

        def complete(model, messages):
            future = asyncio.run_coroutine_threadsafe(owner.generate(model, module.build_prompt(messages)), loop)
            try:
                return future.result(timeout=95)
            except AppError as error:
                request_state.error = error
                raise
            except TimeoutError:
                future.cancel()
                request_state.error = AppError(504, "OPENCODE_TIMEOUT", "OpenCode 生成超时")
                raise

        module.BRIDGE_TOKEN = self.token
        module.MODELS = ()
        module.refresh_models = lambda force=False: owner.catalog
        module.opencode_complete = complete

        class Handler(module.Handler):
            def _send(self, document, code=200):
                error = getattr(request_state, "error", None)
                if error is not None:
                    request_state.error = None
                    return super()._send({"error": error.payload()}, error.status)
                document.pop("usage", None)
                return super()._send(document, code)

            def log_message(self, *_args):
                pass

        self.server = module.HealthServer(("127.0.0.1", 0), Handler)
        Thread(target=self.server.serve_forever, name="opencode-free-bridge", daemon=True).start()

    async def native(self, route: str, *, payload: dict | None = None, timeout: float = 12):
        try:
            response = await self.loopback.request(
                "POST" if payload is not None else "GET", self.origin + route,
                json=payload, auth=("opencode", self.password), timeout=timeout,
            )
            document = response.json()
        except httpx.TimeoutException:
            raise AppError(504, "OPENCODE_TIMEOUT", "OpenCode 响应超时") from None
        except (httpx.HTTPError, ValueError):
            raise AppError(502, "OPENCODE_UNREACHABLE", "无法读取本机 OpenCode 服务的响应") from None
        if response.is_success:
            return document
        error = document if isinstance(document, dict) else {}
        if response.status_code == 429 or error.get("status") == 429 or error.get("reason") == "rate_limit":
            retry_after = error.get("retryAfterMs")
            if isinstance(retry_after, int) and retry_after > 0:
                self.retry_at = monotonic() + retry_after / 1000
            raise self.rate_limit_error()
        raise AppError(502, "OPENCODE_UPSTREAM_ERROR", f"OpenCode 返回错误（HTTP {response.status_code}）")

    def rate_limit_error(self) -> AppError:
        wait = self.retry_at - monotonic()
        message = "OpenCode 免费额度暂时受限，请稍后重试"
        if wait > 0:
            message = f"OpenCode 免费额度暂时受限，预计 {math.ceil(wait / 60)} 分钟后可重试"
        return AppError(429, "OPENCODE_FREE_RATE_LIMIT", message)

    async def cloud_ids(self) -> set[str] | None:
        try:
            response = await self.network.get(CLOUD_CATALOG, timeout=5)
            response.raise_for_status()
            rows = response.json()["data"]
            if not isinstance(rows, list):
                return None
            return {row["id"] for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)}
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            return None

    async def models(self, *, refresh: bool = False) -> list[str]:
        async with self.lock:
            await self.start()
            if self.catalog and not refresh and monotonic() - self.catalog_time < CATALOG_LIFETIME:
                return list(self.catalog)
            native, live_ids = await asyncio.gather(self.native("/api/model"), self.cloud_ids())
            rows = native.get("data") if isinstance(native, dict) else None
            if not isinstance(rows, list):
                raise AppError(502, "OPENCODE_INVALID_CATALOG", "OpenCode 返回了无法识别的模型目录")
            names = []
            for row in rows:
                if not isinstance(row, dict) or row.get("providerID") != "opencode" or row.get("type") != "chat":
                    continue
                model_id, prices = row.get("id"), row.get("cost")
                if (
                    isinstance(model_id, str) and model_id and len(model_id) <= 256
                    and row.get("enabled", True) and row.get("status") == "active"
                    and (live_ids is None or model_id in live_ids)
                    and isinstance(prices, list) and prices
                    and all(isinstance(tier, dict) and tier.get("input") == 0 and tier.get("output") == 0 for tier in prices)
                ):
                    names.append(model_id)
            if not names:
                self.catalog = ()
                raise AppError(503, "OPENCODE_NO_FREE_MODELS", "OpenCode 当前目录里没有可用的免费文本模型")
            models = list(dict.fromkeys(names))
            await self.save_catalog(models)
            self.catalog = tuple(models)
            self.catalog_time = monotonic()
            return models

    async def generate(self, model: str, prompt: str) -> str:
        result = await self.native("/api/experimental/generate/text", payload={
            "prompt": prompt, "model": {"providerID": "opencode", "id": model},
        }, timeout=90)
        document = result.get("data", result) if isinstance(result, dict) else result
        text = document.get("text") if isinstance(document, dict) else None
        if isinstance(text, str) and text.strip():
            return text.strip()
        raise AppError(502, "OPENCODE_EMPTY_OUTPUT", "OpenCode 返回的文字为空")

    async def complete(self, model_id: str, messages: list[dict]) -> str:
        if monotonic() < self.retry_at:
            raise self.rate_limit_error()
        models = await self.models()
        model = model_id or models[0]
        if model not in models:
            raise AppError(400, "OPENCODE_MODEL_UNAVAILABLE", "所选免费模型已下线，请刷新列表或改为自动选择")
        try:
            response = await self.loopback.post(
                f"http://127.0.0.1:{self.server.server_port}/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.token}"},
                json={"model": model, "messages": messages},
            )
            document = response.json()
        except httpx.TimeoutException:
            raise AppError(504, "OPENCODE_TIMEOUT", "OpenCode 桥接响应超时") from None
        except (httpx.HTTPError, ValueError):
            raise AppError(502, "OPENCODE_BRIDGE_UNREACHABLE", "无法读取 OpenCode 桥接器的响应") from None
        if not response.is_success:
            error = document.get("error", {}) if isinstance(document, dict) else {}
            if isinstance(error, dict) and str(error.get("code", "")).startswith("OPENCODE_"):
                raise AppError(response.status_code, error["code"], error["message"])
            raise AppError(502, "OPENCODE_BRIDGE_ERROR", "OpenCode 桥接器暂时无法生成文字")
        try:
            text = document["choices"][0]["message"]["content"]
            if isinstance(text, str) and text.strip():
                return text.strip()
        except (IndexError, KeyError, TypeError):
            pass
        raise AppError(502, "OPENCODE_EMPTY_OUTPUT", "OpenCode 返回的文字为空")

    async def stop(self):
        if self.server is not None:
            await asyncio.to_thread(self.server.shutdown)
            self.server.server_close()
            self.server = None
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    await asyncio.to_thread(self.process.wait, 3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    await asyncio.to_thread(self.process.wait)
            self.process = None
        if self.profile is not None:
            await asyncio.to_thread(self.profile.cleanup)
            self.profile = None
        self.catalog = ()

    async def close(self):
        async with self.lock:
            try:
                await self.stop()
            finally:
                await self.loopback.aclose()
