import base64
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
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
_ORIGINS = ("https://registry.npmmirror.com", "https://registry.npmjs.org")
DownloadProgress = Callable[[str, int, int, int], Awaitable[None]]

@dataclass(frozen=True)
class OpenCodeArtifact:
    package: str
    executable_name: str
    archive_bytes: int
    archive_sha512: str
    binary_bytes: int
    binary_sha256: str

    @property
    def archive_path(self) -> str:
        return f"/@opencode/{self.package}/-/{self.package}-{OPENCODE_VERSION}.tgz"


# Archive integrity comes from the official npm release. Sizes and executable
# digests were measured from the byte-identical mirrored archives.
OPENCODE_ARTIFACTS = {
    f"@opencode/{artifact.package}": artifact
    for artifact in (
        OpenCodeArtifact(
            "cli-windows-x64-baseline", "opencode.exe", 125_686_170,
            "4hucKWMj31OpFyZUhNZBNU/YqSrZlNP8RaZtcgUuDmmvjfeYv205YEZCBVwKtR2iCkt08KImt7KLN3g3z4cjKQ==",
            259_702_664, "ba343b5c0fd8d7daabc0501bd1c1866c0fd91e8ff7b4404f5524fbc0cc233882",
        ),
        OpenCodeArtifact(
            "cli-darwin-arm64", "opencode", 109_080_331,
            "cYrIzW8CvYc52INFA/cXmw7U2mk+JNWaV+olH7AflYqa/5srSrA/hbLwF7G1N4QTRMtOFrmeTM0LVN81q396sg==",
            225_750_880, "635c523002b6eaf897597facba703729794cb07bdb59044d5e173b07b77ff934",
        ),
        OpenCodeArtifact(
            "cli-darwin-x64-baseline", "opencode", 114_447_318,
            "3jFsRoamhPAzMEzhIDDWteqElOlfW45jnP/5JKKQcQXsCEZ9WDMz8XzDzOaO7xInsCY0XDaUhEF2HrvP5iTIWw==",
            240_468_704, "5d188d68f808570aa1f8826c9d6bd7d9ade18e9bac8961aa3c0079f41e2850e8",
        ),
    )
}


def matches_cli(path: Path, artifact: OpenCodeArtifact) -> bool:
    try:
        if path.stat().st_size != artifact.binary_bytes:
            return False
        with path.open("rb") as file:
            return hashlib.file_digest(file, "sha256").hexdigest() == artifact.binary_sha256
    except OSError:
        return False


def _install_archive(archive_path: Path, target: Path, artifact: OpenCodeArtifact) -> None:
    pending = archive_path.with_name(artifact.executable_name)
    with tarfile.open(archive_path, mode="r|gz") as archive:
        for member in archive:
            if member.name == f"package/bin/{artifact.executable_name}" and member.isfile():
                if member.size != artifact.binary_bytes:
                    raise ValueError("invalid OpenCode executable size")
                with archive.extractfile(member) as source, pending.open("wb") as file:
                    shutil.copyfileobj(source, file, 1024 * 1024)
                break
    if not matches_cli(pending, artifact):
        raise ValueError("invalid OpenCode executable")
    if artifact.executable_name == "opencode":
        pending.chmod(0o755)
    try:
        pending.replace(target)
    except PermissionError:
        # A second instance may already be running the verified executable.
        if not matches_cli(target, artifact):
            raise


async def install_cli(
    client: httpx.AsyncClient,
    target: Path,
    artifact: OpenCodeArtifact,
    *,
    on_progress: DownloadProgress | None = None,
) -> None:
    stream_timeout = httpx.Timeout(connect=15.0, read=45.0, write=20.0, pool=15.0)
    total = artifact.archive_bytes
    expected_digest = base64.b64decode(artifact.archive_sha512)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=target.parent) as temporary:
            archive = Path(temporary) / "package.tgz"
            for origin in _ORIGINS:
                try:
                    if on_progress is not None:
                        await on_progress("connecting", 0, total, 0)
                    size = 0
                    last_emit_pct = -1
                    digest = hashlib.sha512()
                    async with client.stream(
                        "GET", origin + artifact.archive_path, follow_redirects=True, timeout=stream_timeout,
                    ) as response:
                        response.raise_for_status()
                        with archive.open("wb") as file:
                            async for chunk in response.aiter_bytes(262_144):
                                if not chunk:
                                    continue
                                size += len(chunk)
                                if size > total:
                                    raise ValueError("unexpected archive size")
                                digest.update(chunk)
                                file.write(chunk)
                                if on_progress is not None:
                                    pct = size * 100 // total
                                    if pct > last_emit_pct:
                                        last_emit_pct = pct
                                        await on_progress("downloading", size, total, pct)
                    if size != total or digest.digest() != expected_digest:
                        raise ValueError("archive checksum mismatch")
                except (httpx.HTTPError, TimeoutError, ValueError) as error:
                    logger.warning("OpenCode download from %s failed: %s", origin, error)
                    continue
                if on_progress is not None:
                    await on_progress("verifying", size, total, 100)
                await to_thread.run_sync(_install_archive, archive, target, artifact)
                logger.info("Installed OpenCode %s from %s", OPENCODE_VERSION, origin)
                return
    except (OSError, ValueError, tarfile.TarError) as error:
        logger.exception("Could not install OpenCode")
        raise AppError(503, "OPENCODE_CLI_INSTALL_FAILED", "无法安装 OpenCode，请检查用户目录和磁盘空间后重试") from error
    raise AppError(502, "OPENCODE_CLI_DOWNLOAD_FAILED", "下载 OpenCode 失败，请检查网络后重试")
