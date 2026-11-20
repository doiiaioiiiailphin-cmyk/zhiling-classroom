"""跨平台运行环境与可选扩展模块路径契约（Windows / macOS 通用）。

本模块为以下两个由维护者按平台独立演进的模块提供标准化路径与架构识别接口：
1. 默认免登录语音模块（`builtin-free-asr`）：
   - 实现文件：`backend/app/services/builtin_asr.py`、`backend/app/providers/asr/builtin_shell.py`
   - 原生动态库目录约定：`assets/opus/<platform_arch_tag()>/`（Windows 为 `opus.dll`，macOS 为 `libopus.dylib`）
2. OpenCode 免费模型模块（`opencode-free-bridge`）：
   - 实现文件：`backend/app/providers/opencode_runtime.py`、`backend/app/providers/opencode_bridge.py`
   - 托管二进制目录约定：`<runtime_dir>/<version>-<os>-<arch>/opencode[.exe]`

打包与验收见 `docs/MACOS_PORT_HANDOFF.md`。
"""
from dataclasses import dataclass
from pathlib import Path
import platform
import sys
import sysconfig


@dataclass(frozen=True)
class BuiltinAsrPlatformSpec:
    """默认免登录语音模块在当前平台所需的本地原生库与扩展位置说明。"""

    platform_tag: str
    opus_library_name: str
    opus_search_dirs: tuple[Path, ...]
    resolved_opus_file: Path | None
    addon_cache_dirname: str = "builtin-free-asr"


@dataclass(frozen=True)
class OpenCodePlatformSpec:
    """OpenCode 免费模型模块在当前平台对应的托管目录与 npm 包名约定。"""

    platform_tag: str
    executable_name: str
    npm_package_hint: str
    managed_subdir: str
    managed_binary_path: Path | None


def normalized_machine(machine: str | None = None) -> str:
    raw = (machine if machine is not None else platform.machine()).strip().lower()
    if raw in {"arm64", "aarch64"}:
        return "arm64"
    if raw in {"x86_64", "amd64", "x64"}:
        return "x86_64"
    return raw or "unknown"


def platform_arch_tag(
    *,
    plat: str | None = None,
    machine: str | None = None,
) -> str:
    """返回稳定的平台架构标签：win-amd64 / macosx-arm64 / macosx-x86_64。"""
    target = plat if plat is not None else sys.platform
    arch = normalized_machine(machine)
    if target == "win32":
        if machine is None and sys.platform == "win32":
            return sysconfig.get_platform()
        return {"arm64": "win-arm64", "x86_64": "win-amd64"}.get(arch, f"win-{arch}")
    if target == "darwin":
        return f"macosx-{arch}"
    return sysconfig.get_platform()


def opus_library_filename(*, plat: str | None = None) -> str:
    target = plat if plat is not None else sys.platform
    if target == "win32":
        return "opus.dll"
    if target == "darwin":
        return "libopus.dylib"
    return "libopus.so"


def resolve_opus_library_path(
    *,
    plat: str | None = None,
    machine: str | None = None,
    bundle_dir: Path | None = None,
    repo_root: Path | None = None,
) -> BuiltinAsrPlatformSpec:
    """按当前运行模式（PyInstaller 冻结包 / 源码目录 / Homebrew）解析 Opus 动态库位置。"""
    target = plat if plat is not None else sys.platform
    tag = platform_arch_tag(plat=target, machine=machine)
    lib_name = opus_library_filename(plat=target)

    meipass = bundle_dir if bundle_dir is not None else (
        Path(getattr(sys, "_MEIPASS")) if getattr(sys, "_MEIPASS", None) else None
    )
    root = repo_root if repo_root is not None else Path(__file__).resolve().parents[3]

    candidates: list[Path] = []
    if meipass is not None:
        candidates.append(meipass / "asr")
        if target == "darwin" and meipass.parent.name == "Contents":
            candidates.extend(meipass.parent / name / "asr" for name in ("Frameworks", "Resources", "MacOS"))
    else:
        candidates.append(root / "assets" / "opus" / tag)
    if target == "darwin":
        if meipass is None:
            candidates.append(root / "build" / "opus-macos" / tag.removeprefix("macosx-"))
        homebrew = "/opt/homebrew" if tag == "macosx-arm64" else "/usr/local"
        candidates.append(Path(homebrew) / "opt" / "opus" / "lib")

    resolved = next(((d / lib_name) for d in candidates if (d / lib_name).is_file()), None)
    return BuiltinAsrPlatformSpec(
        platform_tag=tag,
        opus_library_name=lib_name,
        opus_search_dirs=tuple(candidates),
        resolved_opus_file=resolved,
    )


def resolve_opencode_platform_spec(
    runtime_dir: Path | None,
    version: str = "2.3.2",
    *,
    plat: str | None = None,
    machine: str | None = None,
) -> OpenCodePlatformSpec:
    """返回当前平台对应的 OpenCode 托管二进制路径与官方 npm 包名提示。"""
    target = plat if plat is not None else sys.platform
    tag = platform_arch_tag(plat=target, machine=machine)
    arch = normalized_machine(machine)

    if target == "win32":
        exe_name = "opencode.exe"
        npm_pkg = {
            "win-arm64": "@opencode/cli-windows-arm64",
            "win-amd64": "@opencode/cli-windows-x64-baseline",
        }.get(tag, "")
        subdir = f"{version}-windows-{'x64' if tag == 'win-amd64' else tag.removeprefix('win-')}"
    elif target == "darwin":
        exe_name = "opencode"
        npm_pkg = {
            "arm64": "@opencode/cli-darwin-arm64",
            "x86_64": "@opencode/cli-darwin-x64-baseline",
        }.get(arch, "")
        subdir = f"{version}-darwin-{'x64' if arch == 'x86_64' else arch}"
    else:
        exe_name = "opencode"
        npm_pkg = f"@opencode/cli-linux-{arch}"
        subdir = f"{version}-linux-{arch}"

    managed_path = (runtime_dir / subdir / exe_name) if runtime_dir is not None and npm_pkg else None
    return OpenCodePlatformSpec(
        platform_tag=tag,
        executable_name=exe_name,
        npm_package_hint=npm_pkg,
        managed_subdir=subdir,
        managed_binary_path=managed_path,
    )
