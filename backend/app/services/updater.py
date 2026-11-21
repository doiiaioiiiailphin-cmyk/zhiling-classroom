"""基于 CNB（cnb.cool）Release 的跨平台软件自动更新服务。

能力特性：
1. 公开 CNB 仓库免 Token 检查更新：请求 `https://cnb.cool/{repo}/-/releases/latest`
   并携带 `Accept: application/vnd.cnb.web+json`，直接获取版本标签、更新说明及每个附件的
   原生 SHA-256 校验值与国内高速 COS 下载直链；
2. 可选私有仓库支持：当环境变量 `ZHILING_CNB_TOKEN` 存在时，走 `https://api.cnb.cool` Bearer 鉴权；
3. 按运行平台与 CPU 架构精准匹配 Windows x64 ZIP、macOS arm64 DMG、macOS x86_64 DMG；
4. 流式下载并通过 SSE 实时回报百分比与网速，同步计算 SHA-256 强校验防篡改；
5. 分离进程跨平台热更新：
   - Windows：PowerShell 等待旧进程退出 -> 自动备份 -> 解压覆盖 -> 失败自动回滚 -> 重启新版；
   - macOS：POSIX sh 等待旧进程退出 -> `hdiutil` 静默挂载 DMG -> `ditto` 原子替换 `.app` ->
     清除 `com.apple.quarantine` 隔离属性 -> 卸载 DMG -> `open -n` 拉起新版。
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import time
from urllib.parse import urljoin, urlsplit

import httpx

from ..errors import AppError
from ..schemas import UpdateApplyResult, UpdateAssetInfo, UpdateCheckResult
from ..version import (
    APP_VERSION,
    CNB_API_BASE,
    CNB_WEB_BASE,
    get_cnb_repo,
    get_cnb_token,
    is_newer_version,
    normalize_version,
)

logger = logging.getLogger(__name__)

_CHECK_CACHE_TTL_S = 300.0
_MAX_UPDATE_BYTES = 512 * 1024 * 1024  # 512 MB 安全上限
_CHUNK_SIZE = 128 * 1024


def _safe_asset_filename(name: str) -> str:
    cleaned = Path((name or "").replace("\\", "/")).name.strip()
    if not cleaned or cleaned in (".", ".."):
        raise AppError(502, "UPDATE_INVALID_ASSET", "远端更新包文件名无效")
    return cleaned


def _detect_platform_arch(
    platform_name: str | None = None,
    arch_name: str | None = None,
) -> tuple[str, str]:
    plat = (platform_name or sys.platform).lower()
    raw_arch = (arch_name or platform.machine() or "x86_64").lower()
    if raw_arch in ("amd64", "x64", "x86_64"):
        arch = "x86_64"
    elif raw_arch in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        arch = raw_arch
    return plat, arch


def select_platform_asset(
    assets: list[dict],
    *,
    platform_name: str,
    arch_name: str,
    web_base: str = CNB_WEB_BASE,
) -> UpdateAssetInfo | None:
    """从 CNB Release 附件列表中匹配当前平台与架构对应的热更新安装包。"""
    candidates: list[tuple[int, dict]] = []
    for item in assets:
        if not isinstance(item, dict):
            continue
        raw_name = str(item.get("name") or "").strip()
        if not raw_name:
            continue
        low = raw_name.lower()
        score = 0
        if platform_name == "win32":
            if low.endswith(".zip") and ("win" in low or "windows" in low):
                score = 100
                if "x86_64" in low or "x64" in low or "amd64" in low:
                    score += 10
        elif platform_name == "darwin":
            if low.endswith(".dmg") and ("mac" in low or "darwin" in low or "osx" in low):
                if arch_name == "arm64" and ("arm64" in low or "aarch64" in low):
                    score = 110
                elif arch_name == "x86_64" and ("x86_64" in low or "x64" in low or "intel" in low):
                    score = 110
                elif "universal" in low:
                    score = 95
        if score > 0:
            candidates.append((score, item))

    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0], reverse=True)
    chosen = candidates[0][1]

    name = _safe_asset_filename(str(chosen.get("name") or ""))
    size_bytes = int(chosen.get("size_in_byte") or chosen.get("size") or 0)
    hash_algo = str(chosen.get("hash_algo") or "").lower().strip()
    hash_value = str(chosen.get("hash_value") or "").lower().strip()
    sha256 = hash_value if hash_algo == "sha256" and len(hash_value) == 64 else ""

    download_url = str(
        chosen.get("browser_download_url")
        or chosen.get("brower_download_url")
        or ""
    ).strip()
    if not download_url:
        rel_path = str(chosen.get("path") or "").strip()
        if rel_path.startswith("http://") or rel_path.startswith("https://"):
            download_url = rel_path
        elif rel_path.startswith("/"):
            download_url = f"{web_base.rstrip('/')}{rel_path}"
    if not download_url:
        return None

    return UpdateAssetInfo(
        name=name,
        size_bytes=max(0, size_bytes),
        sha256=sha256,
        download_url=download_url,
    )


def _ps_single_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_windows_update_script(
    *,
    old_pid: int,
    zip_path: Path,
    install_dir: Path,
    exe_name: str,
    log_path: Path,
) -> str:
    """生成 Windows 分离进程热更新 PowerShell 脚本（含备份自动回滚与日志）。"""
    return f"""$ErrorActionPreference = 'Stop'
$OldPid = {int(old_pid)}
$ZipPath = {_ps_single_quote(str(zip_path))}
$InstallDir = {_ps_single_quote(str(install_dir))}
$ExeName = {_ps_single_quote(exe_name)}
$LogPath = {_ps_single_quote(str(log_path))}

function Write-UpdateLog([string]$Msg) {{
    try {{
        $dir = Split-Path -Parent $LogPath
        if (-not (Test-Path $dir)) {{ New-Item -ItemType Directory -Path $dir -Force | Out-Null }}
        $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Msg"
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    }} catch {{}}
}}

Write-UpdateLog "Updater started for PID=$OldPid InstallDir=$InstallDir"

# 1. 等待旧主进程完全退出并释放句柄
for ($i = 0; $i -lt 125; $i++) {{
    if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) {{
        break
    }}
    Start-Sleep -Milliseconds 200
}}
Start-Sleep -Milliseconds 900

$WorkRoot = Join-Path (Split-Path -Parent $ZipPath) ("apply_" + [Guid]::NewGuid().ToString("N"))
$ExtractDir = Join-Path $WorkRoot "extracted"
$BackupDir = Join-Path $WorkRoot "backup"

try {{
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $ExtractDir -Force | Out-Null
    Write-UpdateLog "Extracting $ZipPath -> $ExtractDir"
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $ExtractDir)

    $PayloadDir = $ExtractDir
    if (-not (Test-Path (Join-Path $PayloadDir $ExeName))) {{
        $Nested = Get-ChildItem -Path $ExtractDir -Directory | Where-Object {{ Test-Path (Join-Path $_.FullName $ExeName) }} | Select-Object -First 1
        if ($Nested) {{
            $PayloadDir = $Nested.FullName
        }} else {{
            throw "Extracted archive does not contain $ExeName"
        }}
    }}

    # 2. 备份旧版可执行文件与 _internal 目录以便失败回滚
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    foreach ($Entry in @($ExeName, "_internal")) {{
        $OldItem = Join-Path $InstallDir $Entry
        if (Test-Path $OldItem) {{
            Write-UpdateLog "Backing up $OldItem"
            $Moved = $false
            for ($retry = 0; $retry -lt 20; $retry++) {{
                try {{
                    Move-Item -Path $OldItem -Destination (Join-Path $BackupDir $Entry) -Force
                    $Moved = $true
                    break
                }} catch {{
                    Start-Sleep -Milliseconds 300
                }}
            }}
            if (-not $Moved) {{
                throw "Failed to move locked item: $OldItem"
            }}
        }}
    }}

    # 3. 覆盖写入新版文件
    Write-UpdateLog "Copying new payload from $PayloadDir -> $InstallDir"
    Get-ChildItem -Path $PayloadDir -Force | ForEach-Object {{
        Copy-Item -Path $_.FullName -Destination $InstallDir -Recurse -Force
    }}

    $NewExe = Join-Path $InstallDir $ExeName
    if (-not (Test-Path $NewExe)) {{
        throw "New executable missing after copy: $NewExe"
    }}

    Write-UpdateLog "Update installed successfully. Launching $NewExe"
    Start-Process -FilePath $NewExe -WorkingDirectory $InstallDir
    Remove-Item -Path $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $ZipPath -Force -ErrorAction SilentlyContinue
}} catch {{
    Write-UpdateLog "Update FAILED: $($_.Exception.Message)"
    try {{
        if (Test-Path $BackupDir) {{
            Write-UpdateLog "Rolling back previous version from $BackupDir"
            foreach ($Entry in @($ExeName, "_internal")) {{
                $BakItem = Join-Path $BackupDir $Entry
                $DstItem = Join-Path $InstallDir $Entry
                if (Test-Path $BakItem) {{
                    if (Test-Path $DstItem) {{ Remove-Item -Path $DstItem -Recurse -Force -ErrorAction SilentlyContinue }}
                    Move-Item -Path $BakItem -Destination $DstItem -Force -ErrorAction SilentlyContinue
                }}
            }}
        }}
    }} catch {{
        Write-UpdateLog "Rollback error: $($_.Exception.Message)"
    }}
    $OldExe = Join-Path $InstallDir $ExeName
    if (Test-Path $OldExe) {{
        Start-Process -FilePath $OldExe -WorkingDirectory $InstallDir -ErrorAction SilentlyContinue
    }}
}}
"""


def build_macos_update_script(
    *,
    old_pid: int,
    dmg_path: Path,
    target_app: Path,
    log_path: Path,
) -> str:
    """生成 macOS 分离进程热更新 Shell 脚本（静默挂载 DMG + ditto 原子替换 + 清隔离标记 + 重启）。"""
    q_dmg = shlex.quote(str(dmg_path))
    q_target = shlex.quote(str(target_app))
    q_log = shlex.quote(str(log_path))
    return f"""#!/bin/sh
set -u

OLD_PID={int(old_pid)}
DMG_PATH={q_dmg}
TARGET_APP={q_target}
LOG_PATH={q_log}
MNT_DIR="/tmp/zhiling-update-mnt-$$"
BACKUP_APP="${{TARGET_APP}}.zhiling-backup"

log_msg() {{
    mkdir -p "$(dirname "$LOG_PATH")" 2>/dev/null || true
    printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_PATH" 2>/dev/null || true
}}

cleanup_mount() {{
    if [ -d "$MNT_DIR" ]; then
        hdiutil detach "$MNT_DIR" -force >/dev/null 2>&1 || true
        rmdir "$MNT_DIR" >/dev/null 2>&1 || true
    fi
}}

log_msg "macOS updater started for PID=$OLD_PID TARGET_APP=$TARGET_APP"

# 1. 等待旧主进程完全退出
i=0
while [ "$i" -lt 125 ]; do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then
        break
    fi
    sleep 0.2
    i=$((i + 1))
done
sleep 0.6

# 2. 静默只读挂载 DMG
mkdir -p "$MNT_DIR"
if ! hdiutil attach -nobrowse -readonly -mountpoint "$MNT_DIR" "$DMG_PATH" >/dev/null 2>&1; then
    log_msg "ERROR: hdiutil attach failed for $DMG_PATH"
    cleanup_mount
    open -n "$TARGET_APP" >/dev/null 2>&1 || true
    exit 1
fi

SRC_APP="$MNT_DIR/ZhilingClassroom.app"
if [ ! -d "$SRC_APP" ]; then
    SRC_APP="$(find "$MNT_DIR" -maxdepth 2 -name '*.app' -type d | head -n 1)"
fi

if [ -z "$SRC_APP" ] || [ ! -d "$SRC_APP" ]; then
    log_msg "ERROR: No .app bundle found inside mounted DMG"
    cleanup_mount
    open -n "$TARGET_APP" >/dev/null 2>&1 || true
    exit 1
fi

# 3. 备份旧版并用 ditto 无损复制新版（保留代码签名与符号链接）
rm -rf "$BACKUP_APP" 2>/dev/null || true
HAD_OLD=0
if [ -d "$TARGET_APP" ]; then
    if mv "$TARGET_APP" "$BACKUP_APP" 2>/dev/null; then
        HAD_OLD=1
    else
        log_msg "ERROR: Cannot move $TARGET_APP (insufficient permission?)"
        cleanup_mount
        open -n "$TARGET_APP" >/dev/null 2>&1 || true
        exit 1
    fi
fi

if ditto "$SRC_APP" "$TARGET_APP" >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1 || true
    rm -rf "$BACKUP_APP" 2>/dev/null || true
    cleanup_mount
    rm -f "$DMG_PATH" 2>/dev/null || true
    log_msg "Update succeeded. Launching $TARGET_APP"
    open -n "$TARGET_APP" >/dev/null 2>&1 || true
    exit 0
else
    log_msg "ERROR: ditto failed, rolling back"
    rm -rf "$TARGET_APP" 2>/dev/null || true
    if [ "$HAD_OLD" -eq 1 ] && [ -d "$BACKUP_APP" ]; then
        mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true
    fi
    cleanup_mount
    open -n "$TARGET_APP" >/dev/null 2>&1 || true
    exit 1
fi
"""


def _resolve_macos_app_bundle(executable: Path) -> Path:
    for parent in executable.resolve().parents:
        if parent.suffix == ".app":
            if str(parent).startswith("/Volumes/"):
                return Path("/Applications") / parent.name
            return parent
    return Path("/Applications/ZhilingClassroom.app")


def _can_write_directory(directory: Path) -> bool:
    try:
        probe = directory / f".zhiling_write_probe_{os.getpid()}"
        probe.write_bytes(b"ok")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def _validate_https_url(url: str, *, allow_insecure_localhost: bool = False) -> None:
    parsed = urlsplit(url)
    if parsed.scheme == "https" and parsed.netloc:
        return
    if allow_insecure_localhost and parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost"):
        return
    raise AppError(502, "UPDATE_INSECURE_URL", "更新下载地址必须使用 HTTPS 安全协议")


class AppUpdaterService:
    def __init__(
        self,
        data_dir: Path,
        http: httpx.AsyncClient,
        *,
        cnb_repo: str | None = None,
        cnb_token: str | None = None,
        current_version: str | None = None,
        platform_name: str | None = None,
        arch_name: str | None = None,
        frozen_override: bool | None = None,
        executable_override: Path | None = None,
    ):
        self.data_dir = data_dir
        self.updates_dir = data_dir / "updates"
        self.logs_dir = data_dir / "logs"
        self.http = http
        self._cnb_repo_override = cnb_repo
        self._cnb_token_override = cnb_token
        self.current_version = normalize_version(current_version or APP_VERSION)
        self.platform_name, self.arch_name = _detect_platform_arch(platform_name, arch_name)
        self._frozen_override = frozen_override
        self._executable_override = executable_override
        self._lock = asyncio.Lock()
        self._cached_at = 0.0
        self._cached_result: UpdateCheckResult | None = None

    @property
    def cnb_repo(self) -> str:
        return get_cnb_repo(self._cnb_repo_override)

    @property
    def cnb_token(self) -> str:
        return get_cnb_token(self._cnb_token_override)

    @property
    def is_frozen(self) -> bool:
        if self._frozen_override is not None:
            return self._frozen_override
        return bool(getattr(sys, "frozen", False))

    @property
    def current_executable(self) -> Path:
        if self._executable_override is not None:
            return self._executable_override
        return Path(sys.executable).resolve()

    def _staged_meta_path(self) -> Path:
        return self.updates_dir / "staged.json"

    def _read_staged_meta(self) -> dict | None:
        meta_path = self._staged_meta_path()
        if not meta_path.is_file():
            return None
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
        return None

    async def _fetch_latest_release_raw(self, repo: str) -> dict:
        token = self.cnb_token
        if token:
            url = f"{CNB_API_BASE}/{repo}/-/releases/latest"
            headers = {
                "Accept": "application/vnd.cnb.api+json",
                "Authorization": f"Bearer {token}",
            }
        else:
            url = f"{CNB_WEB_BASE}/{repo}/-/releases/latest"
            headers = {
                "Accept": "application/vnd.cnb.web+json",
            }
        try:
            resp = await self.http.get(url, headers=headers, follow_redirects=True, timeout=15.0)
        except httpx.HTTPError as exc:
            logger.warning("CNB update check failed (%s): %s", type(exc).__name__, exc)
            raise AppError(502, "UPDATE_CHECK_NETWORK_ERROR", "连接 CNB 更新服务器失败，请检查网络后重试") from exc

        if resp.status_code == 404:
            raise AppError(404, "UPDATE_RELEASE_NOT_FOUND", "CNB 仓库尚未发布任何正式版本")
        if resp.status_code in (401, 403):
            raise AppError(502, "UPDATE_AUTH_REQUIRED", "CNB 更新仓库需要访问权限，请确认仓库已设为公开")
        if resp.status_code != 200:
            raise AppError(502, "UPDATE_CHECK_FAILED", f"CNB 更新接口返回异常状态（HTTP {resp.status_code}）")

        try:
            payload = resp.json()
        except ValueError as exc:
            raise AppError(502, "UPDATE_INVALID_RESPONSE", "CNB 更新元数据格式无法解析") from exc
        if not isinstance(payload, dict):
            raise AppError(502, "UPDATE_INVALID_RESPONSE", "CNB 更新元数据格式异常")
        return payload

    async def check_update(self, *, force: bool = False) -> UpdateCheckResult:
        now = time.monotonic()
        if not force and self._cached_result is not None and (now - self._cached_at) < _CHECK_CACHE_TTL_S:
            return self._cached_result

        repo = self.cnb_repo
        checked_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        if not repo:
            result = UpdateCheckResult(
                current_version=self.current_version,
                latest_version=self.current_version,
                has_update=False,
                platform=self.platform_name,
                arch=self.arch_name,
                repo="",
                can_auto_apply=self.is_frozen,
                checked_at=checked_at,
            )
            self._cached_result = result
            self._cached_at = now
            return result

        raw = await self._fetch_latest_release_raw(repo)
        raw_tag = str(raw.get("tag_name") or raw.get("tag_ref") or "").strip()
        latest_version = normalize_version(raw_tag)
        release_title = str(raw.get("title") or raw.get("name") or f"v{latest_version}").strip()
        release_notes = str(raw.get("body") or "").strip()
        published_at = str(raw.get("published_at") or raw.get("created_at") or "").strip()
        is_draft = bool(raw.get("is_draft") or raw.get("draft"))
        is_prerelease = bool(raw.get("is_prerelease") or raw.get("prerelease"))
        assets_raw = raw.get("assets") if isinstance(raw.get("assets"), list) else []

        asset = select_platform_asset(
            assets_raw,
            platform_name=self.platform_name,
            arch_name=self.arch_name,
        )
        tag_slug = raw_tag[len("refs/tags/"):] if raw_tag.startswith("refs/tags/") else raw_tag
        release_url = f"{CNB_WEB_BASE}/{repo}/-/releases/tag/{tag_slug}" if tag_slug else f"{CNB_WEB_BASE}/{repo}/-/releases"

        has_update = (
            not is_draft
            and not is_prerelease
            and bool(latest_version)
            and is_newer_version(latest_version, self.current_version)
            and asset is not None
        )

        # 检查是否已有同版本已校验的本地更新包
        staged_ready = False
        if has_update and asset is not None:
            meta = self._read_staged_meta()
            if (
                meta
                and meta.get("version") == latest_version
                and meta.get("assetName") == asset.name
                and Path(str(meta.get("filePath") or "")).is_file()
            ):
                staged_ready = True

        result = UpdateCheckResult(
            current_version=self.current_version,
            latest_version=latest_version or self.current_version,
            has_update=has_update,
            release_title=release_title,
            release_notes=release_notes,
            release_url=release_url,
            published_at=published_at,
            platform=self.platform_name,
            arch=self.arch_name,
            repo=repo,
            can_auto_apply=self.is_frozen,
            staged_ready=staged_ready,
            asset=asset,
            checked_at=checked_at,
        )
        self._cached_result = result
        self._cached_at = now
        return result

    async def download_update_stream(self) -> AsyncIterator[dict]:
        info = await self.check_update(force=True)
        if not info.has_update or info.asset is None:
            raise AppError(400, "UPDATE_NOT_AVAILABLE", "当前已是最新版本，或未找到适配本机架构的安装包")

        asset = info.asset
        _validate_https_url(asset.download_url)

        target_dir = self.updates_dir / info.latest_version
        target_dir.mkdir(parents=True, exist_ok=True)
        final_path = target_dir / _safe_asset_filename(asset.name)
        part_path = final_path.with_name(f".{final_path.name}.{os.getpid()}.part")

        async with self._lock:
            # 1. 若本地缓存文件存在且 SHA-256 匹配，直接复用
            if final_path.is_file():
                cached_sha = await asyncio.to_thread(self._compute_sha256, final_path)
                cached_size = final_path.stat().st_size
                if (not asset.sha256 or cached_sha == asset.sha256) and cached_size > 0:
                    self._save_staged_meta(info.latest_version, asset, final_path, cached_sha)
                    yield {
                        "type": "progress",
                        "stage": "ready",
                        "downloadedBytes": cached_size,
                        "totalBytes": cached_size,
                        "percent": 100,
                        "speedBytesPerSec": 0,
                    }
                    yield {"type": "done", "data": {"version": info.latest_version, "filePath": str(final_path), "sha256": cached_sha}}
                    return
                final_path.unlink(missing_ok=True)

            yield {
                "type": "progress",
                "stage": "connecting",
                "downloadedBytes": 0,
                "totalBytes": asset.size_bytes,
                "percent": 0,
                "speedBytesPerSec": 0,
            }

            headers = {}
            if self.cnb_token and urlsplit(asset.download_url).hostname in ("cnb.cool", "api.cnb.cool"):
                headers["Authorization"] = f"Bearer {self.cnb_token}"

            hasher = hashlib.sha256()
            downloaded = 0
            total = asset.size_bytes
            t_start = time.monotonic()
            last_emit = 0.0

            try:
                async with self.http.stream(
                    "GET",
                    asset.download_url,
                    headers=headers,
                    follow_redirects=True,
                    timeout=httpx.Timeout(300.0, connect=20.0, read=45.0),
                ) as resp:
                    _validate_https_url(str(resp.url))
                    if resp.status_code != 200:
                        raise AppError(502, "UPDATE_DOWNLOAD_FAILED", f"更新包下载失败（HTTP {resp.status_code}）")
                    header_len = int(resp.headers.get("content-length") or 0)
                    if header_len > 0:
                        total = header_len
                    if total > _MAX_UPDATE_BYTES:
                        raise AppError(502, "UPDATE_PACKAGE_TOO_LARGE", "更新包体积超过安全限制")

                    with part_path.open("wb") as fh:
                        async for chunk in resp.aiter_bytes(_CHUNK_SIZE):
                            if not chunk:
                                continue
                            downloaded += len(chunk)
                            if downloaded > _MAX_UPDATE_BYTES:
                                raise AppError(502, "UPDATE_PACKAGE_TOO_LARGE", "更新包体积超过安全限制")
                            fh.write(chunk)
                            hasher.update(chunk)
                            now = time.monotonic()
                            if now - last_emit >= 0.12 or (total > 0 and downloaded >= total):
                                elapsed = max(0.05, now - t_start)
                                speed = int(downloaded / elapsed)
                                pct = int(min(99, round(downloaded * 100 / total))) if total > 0 else 0
                                last_emit = now
                                yield {
                                    "type": "progress",
                                    "stage": "downloading",
                                    "downloadedBytes": downloaded,
                                    "totalBytes": total,
                                    "percent": pct,
                                    "speedBytesPerSec": speed,
                                }
            except AppError:
                part_path.unlink(missing_ok=True)
                raise
            except httpx.HTTPError as exc:
                part_path.unlink(missing_ok=True)
                raise AppError(502, "UPDATE_DOWNLOAD_FAILED", f"更新包下载中断：{type(exc).__name__}") from exc
            except OSError as exc:
                part_path.unlink(missing_ok=True)
                raise AppError(500, "UPDATE_WRITE_FAILED", f"更新包写入磁盘失败：{exc}") from exc

            yield {
                "type": "progress",
                "stage": "verifying",
                "downloadedBytes": downloaded,
                "totalBytes": total or downloaded,
                "percent": 99,
                "speedBytesPerSec": 0,
            }

            digest = hasher.hexdigest().lower()
            if asset.sha256 and digest != asset.sha256:
                part_path.unlink(missing_ok=True)
                raise AppError(
                    502,
                    "UPDATE_CHECKSUM_MISMATCH",
                    "更新包 SHA-256 完整性校验未通过，已自动丢弃损坏文件，请重试",
                )

            os.replace(part_path, final_path)
            self._save_staged_meta(info.latest_version, asset, final_path, digest)
            # 刷新缓存状态使 staged_ready = True
            self._cached_result = None

            yield {
                "type": "progress",
                "stage": "ready",
                "downloadedBytes": downloaded,
                "totalBytes": total or downloaded,
                "percent": 100,
                "speedBytesPerSec": 0,
            }
            yield {
                "type": "done",
                "data": {
                    "version": info.latest_version,
                    "filePath": str(final_path),
                    "sha256": digest,
                },
            }

    @staticmethod
    def _compute_sha256(path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            while True:
                buf = fh.read(_CHUNK_SIZE)
                if not buf:
                    break
                h.update(buf)
        return h.hexdigest().lower()

    def _save_staged_meta(self, version: str, asset: UpdateAssetInfo, file_path: Path, sha256: str) -> None:
        self.updates_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": version,
            "assetName": asset.name,
            "filePath": str(file_path),
            "sha256": sha256,
            "expectedSha256": asset.sha256,
            "platform": self.platform_name,
            "arch": self.arch_name,
        }
        self._staged_meta_path().write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    async def apply_staged_update(self) -> UpdateApplyResult:
        meta = self._read_staged_meta()
        if not meta:
            raise AppError(400, "UPDATE_NOT_DOWNLOADED", "请先下载新版本安装包")

        file_path = Path(str(meta.get("filePath") or ""))
        if not file_path.is_file():
            raise AppError(400, "UPDATE_FILE_MISSING", "已下载的更新包不存在，请重新下载")

        expected_sha = str(meta.get("expectedSha256") or meta.get("sha256") or "").lower().strip()
        actual_sha = await asyncio.to_thread(self._compute_sha256, file_path)
        if expected_sha and actual_sha != expected_sha:
            file_path.unlink(missing_ok=True)
            raise AppError(502, "UPDATE_CHECKSUM_MISMATCH", "安装前二次校验失败，更新包已损坏，请重新下载")

        version = str(meta.get("version") or "")
        if not self.is_frozen:
            return UpdateApplyResult(
                scheduled=False,
                mode="dev-manual",
                version=version,
                download_path=str(file_path),
                message="当前为源码开发运行模式，已将校验通过的新版安装包保存在本地目录，请手动安装或打包测试。",
            )

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.logs_dir / "updater.log"

        if self.platform_name == "win32":
            install_dir = self.current_executable.parent
            exe_name = self.current_executable.name
            script_path = file_path.parent / "apply_update.ps1"
            script_body = build_windows_update_script(
                old_pid=os.getpid(),
                zip_path=file_path,
                install_dir=install_dir,
                exe_name=exe_name,
                log_path=log_path,
            )
            script_path.write_text(script_body, encoding="utf-8-sig")

            if _can_write_directory(install_dir):
                creationflags = (
                    getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                    | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
                    | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                )
                subprocess.Popen(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
                    close_fds=True,
                    creationflags=creationflags,
                )
            else:
                # 受保护目录（如 Program Files）通过 UAC 提权执行替换脚本
                elev_cmd = (
                    f"Start-Process powershell -Verb RunAs -WindowStyle Hidden "
                    f"-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',{_ps_single_quote(str(script_path))})"
                )
                subprocess.Popen(
                    ["powershell", "-NoProfile", "-Command", elev_cmd],
                    close_fds=True,
                )

            return UpdateApplyResult(
                scheduled=True,
                mode="auto-replace",
                version=version,
                download_path=str(file_path),
                message="更新脚本已就绪，软件即将自动退出、替换新版并重启。",
            )

        if self.platform_name == "darwin":
            target_app = _resolve_macos_app_bundle(self.current_executable)
            script_path = file_path.parent / "apply_update.sh"
            script_body = build_macos_update_script(
                old_pid=os.getpid(),
                dmg_path=file_path,
                target_app=target_app,
                log_path=log_path,
            )
            script_path.write_text(script_body, encoding="utf-8", newline="\n")
            os.chmod(script_path, 0o755)
            subprocess.Popen(
                ["/bin/sh", str(script_path)],
                start_new_session=True,
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return UpdateApplyResult(
                scheduled=True,
                mode="auto-replace",
                version=version,
                download_path=str(file_path),
                message="更新脚本已就绪，应用即将自动退出、替换新版 .app 并重新启动。",
            )

        return UpdateApplyResult(
            scheduled=False,
            mode="dev-manual",
            version=version,
            download_path=str(file_path),
            message="当前系统暂不支持自动替换，已为您下载好最新安装包。",
        )
