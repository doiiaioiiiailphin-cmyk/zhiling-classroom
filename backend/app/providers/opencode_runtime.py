import asyncio
import base64
import hashlib
import logging
import shutil
import tarfile
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from anyio import to_thread

from ..errors import AppError

logger = logging.getLogger(__name__)

OPENCODE_VERSION = "2.3.2"
_PACKAGE = "cli-windows-x64-baseline"
_ARCHIVE_PATH = f"/@opencode/{_PACKAGE}/-/{_PACKAGE}-{OPENCODE_VERSION}.tgz"
_ORIGINS = ("https://registry.npmmirror.com", "https://registry.npmjs.org")
_ARCHIVE_SHA512 = base64.b64decode(
    "4hucKWMj31OpFyZUhNZBNU/YqSrZlNP8RaZtcgUuDmmvjfeYv205YEZCBVwKtR2iCkt08KImt7KLN3g3z4cjKQ=="
)
_BINARY_SHA256 = "ba343b5c0fd8d7daabc0501bd1c1866c0fd91e8ff7b4404f5524fbc0cc233882"
_BINARY_SIZE = 259_702_664


def matches_cli(path: Path) -> bool:
    try:
        if path.stat().st_size != _BINARY_SIZE:
            return False
        with path.open("rb") as file:
            return hashlib.file_digest(file, "sha256").hexdigest() == _BINARY_SHA256
    except OSError:
        return False


def _install_archive(archive_path: Path, target: Path) -> None:
    pending = archive_path.with_name("opencode.exe")
    with tarfile.open(archive_path, mode="r|gz") as archive:
        for member in archive:
            if member.name == "package/bin/opencode.exe" and member.isfile():
                with archive.extractfile(member) as source, pending.open("wb") as file:
                    shutil.copyfileobj(source, file, 1024 * 1024)
                break
    if not matches_cli(pending):
        raise ValueError("invalid OpenCode executable")
    try:
        pending.replace(target)
    except PermissionError:
        # A second instance may already be running the verified executable.
        if not matches_cli(target):
            raise


async def install_cli(client: httpx.AsyncClient, target: Path) -> None:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=target.parent) as temporary:
            archive = Path(temporary) / "package.tgz"
            for origin in _ORIGINS:
                try:
                    size = 0
                    digest = hashlib.sha512()
                    async with asyncio.timeout(150), client.stream(
                        "GET", origin + _ARCHIVE_PATH, follow_redirects=True, timeout=20,
                    ) as response:
                        response.raise_for_status()
                        with archive.open("wb") as file:
                            async for chunk in response.aiter_bytes(1024 * 1024):
                                size += len(chunk)
                                if size > 150 * 1024 * 1024:
                                    raise ValueError("unexpected archive size")
                                digest.update(chunk)
                                file.write(chunk)
                    if digest.digest() != _ARCHIVE_SHA512:
                        raise ValueError("archive checksum mismatch")
                except (httpx.HTTPError, TimeoutError, ValueError) as error:
                    logger.warning("OpenCode download from %s failed: %s", origin, error)
                    continue
                await to_thread.run_sync(_install_archive, archive, target)
                logger.info("Installed OpenCode %s from %s", OPENCODE_VERSION, origin)
                return
    except (OSError, ValueError, tarfile.TarError) as error:
        logger.exception("Could not install OpenCode")
        raise AppError(503, "OPENCODE_CLI_INSTALL_FAILED", "无法安装 OpenCode，请检查用户目录和磁盘空间后重试") from error
    raise AppError(502, "OPENCODE_CLI_DOWNLOAD_FAILED", "下载 OpenCode 失败，请检查网络后重试")
