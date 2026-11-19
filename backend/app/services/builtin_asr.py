import asyncio
import importlib
import logging
import shutil
import sys
import sysconfig
import tarfile
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from tempfile import mkdtemp
from zipfile import BadZipFile, ZipFile

import httpx

from ..errors import AppError
from ..providers.asr.builtin_shell import _use_bundled_opus

logger = logging.getLogger(__name__)

_COMMIT = "267972f815f519fd7c6149f85a8b7cc99daf61a5"
_SOURCE_URL = f"https://codeload.github.com/yangmoling/doubaoime-asr/zip/{_COMMIT}"
# Hash the installed files by name and contents so archive compression can change.
_SOURCE_SHA256 = "dcdb1c2dde80d152dc7dcfd21a022f8ca6b61eb4bab82a6f4b4334b22cd8818d"
_PYPI_ORIGINS = (
    "https://pypi.tuna.tsinghua.edu.cn",
    "https://mirrors.huaweicloud.com/repository/pypi",
    "https://files.pythonhosted.org",
)
_MINIAUDIO = {
    "cpython-311": (
        "89/97/db38e86d733772b5bc07fd2cd2547d571f1568fa5947eb49f7a30866cba7/miniaudio-1.73-cp311-cp311-win_amd64.whl",
        "d5d0caf89aa7088d0af47fa9ce0a0368f9b635beee918f6422421cea42a33687",
    ),
    "cpython-312": (
        "cb/1c/29309e07c90c9dd048f8a1a87f2d7be1ab36a0ebd3123cddb919a1af4155/miniaudio-1.73-cp312-cp312-win_amd64.whl",
        "08d06c1e799e481b1527bbd1f7270135261c18dce48a349068a1bb9c87d79f15",
    ),
    "cpython-313": (
        "ee/b7/7102a3c3da92bab3570222b32f024ccd614dbd674f475aa80c03ff5a4c6b/miniaudio-1.73-cp313-cp313-win_amd64.whl",
        "a83353a80d7e329bc744758674af48ac8082c8aca2d9fe5832e6e9b809dbe74f",
    ),
    "cpython-314": (
        "dc/98/80964b2d7f8b7b1e7733eb344c55df6b4dbd2561de40e9da4a6c2793fc07/miniaudio-1.73-cp314-cp314-win_amd64.whl",
        "0ffd4812e3d80a53ff0b0f336ce455bfe0144dfa72161ce535e867b827cc2bcc",
    ),
}
_OPUSLIB = (
    "46/55/826befabb29fd3902bad6d6d7308790894c7ad4d73f051728a0c53d37cd7/opuslib-3.0.1.tar.gz",
    "2cb045e5b03e7fc50dfefe431e3404dddddbd8f5961c10c51e32dfb69a044c97",
)
# Pydantic, websockets, CFFI, certifi and idna are supplied by the application.
_WHEELS = (
    (
        "55/75/bb9bc917d10e9ee13dee8607eb9ab963b7cf8be607c46e7862c748aa2af7/protobuf-6.33.5-cp310-abi3-win_amd64.whl",
        "3093804752167bcab3998bec9f1048baae6e29505adaf1afd14a37bddede533c",
    ),
    (
        "1e/db/4254e3eabe8020b458f1a747140d32277ec7a271daf1d235b70dc0b4e6e3/requests-2.32.5-py3-none-any.whl",
        "2462f94637a34fd532264295e186976db0f5d453d1cdd31473c85a6a161affb6",
    ),
    (
        "0a/4c/925909008ed5a988ccbb72dcc897407e5d6d3bd72410d69e051fc0c14647/charset_normalizer-3.4.4-py3-none-any.whl",
        "7a32c560861a02ff789ad905a2fe94e3f840803362c84fecf1851cb4cf3dc37f",
    ),
    (
        "39/08/aaaad47bc4e9dc8c725e68f9d04865dbcb2052843ff09c97b08904852d84/urllib3-2.6.3-py3-none-any.whl",
        "bf272323e553dfb2e87d9bfd225ca7b0f467b919d7bbd355436d3fd37cb0acd4",
    ),
)


async def _fetch(client: httpx.AsyncClient, url: str) -> bytes:
    payload = bytearray()
    async with asyncio.timeout(18), client.stream("GET", url, follow_redirects=True) as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes():
            payload.extend(chunk)
            if len(payload) > 2 * 1024 * 1024:
                raise ValueError("unexpected archive size")
    return bytes(payload)


async def _pypi_file(client: httpx.AsyncClient, path: str, digest: str) -> bytes:
    for origin in _PYPI_ORIGINS:
        try:
            data = await _fetch(client, f"{origin}/packages/{path}")
            if sha256(data).hexdigest() != digest:
                raise ValueError("archive checksum mismatch")
        except (httpx.HTTPError, TimeoutError, ValueError) as error:
            logger.warning("ASR dependency %s from %s: %s", Path(path).name, origin, error)
        else:
            logger.info("Downloaded %s from %s", Path(path).name, origin)
            return data
    raise AppError(502, "ASR_ADDON_DOWNLOAD_FAILED", "语音依赖下载失败，请检查网络后重试")


def _install_source(data: bytes, target: Path) -> None:
    prefix = f"doubaoime-asr-{_COMMIT}/"
    with ZipFile(BytesIO(data)) as archive:
        files = {
            entry.filename.removeprefix(prefix): archive.read(entry)
            for entry in archive.infolist()
            if not entry.is_dir()
            and (entry.filename == prefix + "README.md" or entry.filename.startswith(prefix + "doubaoime_asr/"))
        }
    digest = sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode() + b"\0" + sha256(content).digest())
    if digest.hexdigest() != _SOURCE_SHA256:
        raise ValueError("source checksum mismatch")
    for name, content in files.items():
        destination = target / ("doubaoime-asr-README.md" if name == "README.md" else name)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)


def _install_opuslib(data: bytes, target: Path) -> None:
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
        for entry in archive:
            name = entry.name.removeprefix("opuslib-3.0.1/")
            if entry.isfile() and name in {"LICENSE", "LICENSE.txt", "COPYING", "PKG-INFO"}:
                with archive.extractfile(entry) as source:
                    (target / f"opuslib-{name}").write_bytes(source.read())
            elif entry.isfile() and name.startswith("opuslib/"):
                destination = target / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as source:
                    destination.write_bytes(source.read())


class BuiltinAsrRuntime:
    def __init__(self, root: Path):
        tag = sys.implementation.cache_tag
        compatible = sysconfig.get_platform() == "win-amd64" and not sysconfig.get_config_var("Py_GIL_DISABLED")
        self.audio_wheel = _MINIAUDIO.get(tag) if compatible else None
        fingerprint = sha256(repr((_SOURCE_SHA256, self.audio_wheel, _WHEELS, _OPUSLIB)).encode()).hexdigest()[:16]
        self.cache_dir = root / f"{tag}-{fingerprint}"
        self._lock = asyncio.Lock()
        self._active = False

    def ready(self) -> bool:
        if self._active:
            return True
        mark = next(
            (path for path in self.cache_dir.glob("site-*/.ready")
             if (path.parent / "doubaoime_asr" / "__init__.py").is_file()),
            None,
        )
        if mark is None and getattr(sys, "frozen", False):
            return False
        self._active = self._load(mark.parent if mark else None)
        return self._active

    def _load(self, site: Path | None) -> bool:
        path = str(site) if site is not None else None
        added = path is not None and path not in sys.path
        if added:
            sys.path.insert(0, path)
            importlib.invalidate_caches()
        try:
            _use_bundled_opus()
            importlib.import_module("doubaoime_asr")
        except Exception as error:
            if added:
                sys.path.remove(path)
            if site is not None:
                logger.exception("Could not load the installed ASR component")
                raise AppError(503, "ASR_ADDON_LOAD_FAILED", "语音组件加载失败，请重新打开知聆课堂后重试") from error
            return False
        return True

    def require(self) -> None:
        if not self.ready():
            raise AppError(409, "ASR_ADDON_REQUIRED", "请先下载默认语音组件")

    async def install(self, client: httpx.AsyncClient) -> None:
        async with self._lock:
            if self.ready():
                return
            if self.audio_wheel is None:
                raise AppError(400, "ASR_ADDON_UNSUPPORTED", "当前系统需要在 Python 环境中安装语音依赖")

            # Mark a cache as ready only after extraction and a successful import.
            source, opuslib, *wheels = await asyncio.gather(
                _fetch(client, _SOURCE_URL),
                _pypi_file(client, *_OPUSLIB),
                *(_pypi_file(client, *entry) for entry in (*_WHEELS, self.audio_wheel)),
                return_exceptions=True,
            )
            if isinstance(source, BaseException):
                logger.warning("Could not download the ASR source: %s", source)
                raise AppError(502, "ASR_ADDON_DOWNLOAD_FAILED", "语音组件下载失败，请检查 GitHub 连接后重试") from source
            for artifact in (opuslib, *wheels):
                if isinstance(artifact, BaseException):
                    raise artifact
            site = None
            try:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                site = Path(mkdtemp(prefix="site-", dir=self.cache_dir))
                _install_source(source, site)
                _install_opuslib(opuslib, site)
                for wheel in wheels:
                    with ZipFile(BytesIO(wheel)) as archive:
                        archive.extractall(site)
                self._load(site)
                (site / ".ready").touch()
            except (OSError, ValueError, BadZipFile, tarfile.TarError) as error:
                logger.exception("Could not install the ASR component")
                raise AppError(503, "ASR_ADDON_INSTALL_FAILED", "语音组件安装失败，请重试") from error
            finally:
                if site is not None and not (site / ".ready").is_file():
                    shutil.rmtree(site, ignore_errors=True)
            self._active = True
