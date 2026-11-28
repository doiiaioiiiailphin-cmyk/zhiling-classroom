#!/usr/bin/env bash
# 知聆课堂 macOS 桌面应用构建脚本（Cocoa WKWebView 无边框圆角 + ScreenCaptureKit 免驱内录 + 本地 SenseVoice）
# 用法：bash scripts/build_macos.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_BIN="${PYTHON_BIN:-python3}"
MAC_ARCH="$("$PYTHON_BIN" - <<'PY'
import platform
import sys
import sysconfig

arch = platform.machine()
if (
    sys.platform != "darwin" or arch not in {"arm64", "x86_64"}
    or sys.implementation.name != "cpython"
    or not (3, 11) <= sys.version_info[:2] <= (3, 14)
    or sysconfig.get_config_var("Py_GIL_DISABLED")
):
    sys.exit("打包需要 Apple Silicon 或 Intel Mac 上的常规 CPython 3.11 至 3.14")
print(arch)
PY
)"
if [[ "$(uname -m)" != "$MAC_ARCH" ]]; then
  echo "请在与 Python 架构相同的终端中打包。" >&2
  exit 1
fi

echo "[1/6] 生成 Windows + macOS 多尺寸高清图标 (assets/zhiling.icns)..."
"$PYTHON_BIN" -X utf8 "$ROOT/scripts/generate_icon.py"

echo "[2/6] 编译 macOS ScreenCaptureKit 原生系统内录助手 (ZhilingAudioCapture)..."
mkdir -p "$ROOT/assets/macos"
HELPER_BIN="$ROOT/assets/macos/ZhilingAudioCapture"
swiftc -O -parse-as-library \
  "$ROOT/scripts/mac_audio_helper/ZhilingAudioCapture.swift" \
  -framework ScreenCaptureKit \
  -framework CoreAudio \
  -framework CoreMedia \
  -framework AVFoundation \
  -framework Foundation \
  -o "$HELPER_BIN"
chmod +x "$HELPER_BIN"

echo "[3/6] 构建前端生产静态资源 (dist/)..."
export VITE_USE_MOCK="false"
export VITE_API_BASE_URL="/api/v1"
npm run build

echo "[4/6] 安装 macOS 桌面宿主与本地语音引擎 (sherpa-onnx) 依赖..."
"$PYTHON_BIN" -m pip install -r "$ROOT/backend/requirements-macos.txt"

echo "[5/6] 使用 PyInstaller 构建 macOS .app 应用包 (release/ZhilingClassroom.app)..."
MAC_DIST="$ROOT/build/pyinstaller-macos/dist"

"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --onedir \
  --name "ZhilingClassroom" \
  --target-architecture "$MAC_ARCH" \
  --osx-bundle-identifier "com.zhiling.classroom.desktop" \
  --icon "$ROOT/assets/zhiling.icns" \
  --distpath "$MAC_DIST" \
  --workpath "$ROOT/build/pyinstaller-macos" \
  --specpath "$ROOT/build/pyinstaller-macos" \
  --paths "$ROOT/backend" \
  --add-data "$ROOT/dist:dist" \
  --add-binary "$HELPER_BIN:bin" \
  --hidden-import "desktop_macos" \
  --hidden-import "greenlet" \
  --hidden-import "aiosqlite" \
  --hidden-import "sqlalchemy.dialects.sqlite.aiosqlite" \
  --hidden-import "uvicorn.logging" \
  --hidden-import "uvicorn.loops.auto" \
  --hidden-import "uvicorn.loops.asyncio" \
  --hidden-import "uvicorn.protocols.http.auto" \
  --hidden-import "uvicorn.protocols.http.h11_impl" \
  --hidden-import "uvicorn.protocols.websockets.auto" \
  --hidden-import "uvicorn.protocols.websockets.websockets_impl" \
  --hidden-import "uvicorn.lifespan.on" \
  --hidden-import "websockets.legacy" \
  --hidden-import "websockets.legacy.server" \
  --hidden-import "websockets.legacy.client" \
  --collect-all "sherpa_onnx" \
  --collect-data "certifi" \
  --collect-data "tzdata" \
  --collect-data "webview" \
  --exclude-module "pygame" \
  --exclude-module "matplotlib" \
  --exclude-module "scipy" \
  --exclude-module "pandas" \
  --exclude-module "torch" \
  --exclude-module "tensorflow" \
  --exclude-module "tkinter" \
  --exclude-module "PyQt5" \
  --exclude-module "PyQt6" \
  --exclude-module "PySide2" \
  --exclude-module "PySide6" \
  --exclude-module "wx" \
  --exclude-module "IPython" \
  --exclude-module "pytest" \
  "$ROOT/backend/desktop_shell.py"

APP_BUNDLE="$MAC_DIST/ZhilingClassroom.app"
PLIST="$APP_BUNDLE/Contents/Info.plist"

echo "[6/6] 写入 macOS 隐私权限声明 (Info.plist) 并封装 .dmg 安装镜像..."
"$PYTHON_BIN" - "$PLIST" "$ROOT/package.json" <<'PYEOF'
import json, plistlib, sys
from pathlib import Path

plist_path = Path(sys.argv[1])
pkg_path = Path(sys.argv[2])
app_version = json.loads(pkg_path.read_text(encoding="utf-8")).get("version", "0.1.2")

with plist_path.open("rb") as fh:
    data = plistlib.load(fh)

data["CFBundleDisplayName"] = "知聆课堂"
data["CFBundleShortVersionString"] = app_version
data["CFBundleVersion"] = app_version
data["LSMinimumSystemVersion"] = "13.0"
data["NSHighResolutionCapable"] = True
data["NSSupportsAutomaticTermination"] = False
data["NSSupportsSuddenTermination"] = False
data["LSMultipleInstancesProhibited"] = True
data["NSAppTransportSecurity"] = {"NSAllowsLocalNetworking": True}
data["NSMicrophoneUsageDescription"] = "知聆课堂需要访问麦克风以进行课堂实时语音转写与双讲拾音。"
data["NSAudioCaptureUsageDescription"] = "知聆课堂需要系统音频录制权限，以实现免虚拟声卡的网课原声内录。"
data["NSScreenCaptureUsageDescription"] = "知聆课堂需要屏幕与系统音频录制权限，以实现网课内录与一键抓拍黑板画面。"

with plist_path.open("wb") as fh:
    plistlib.dump(data, fh)
PYEOF

codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"
"$PYTHON_BIN" - "$APP_BUNDLE" <<'PYEOF'
import sys
from pathlib import Path

contents = Path(sys.argv[1]) / "Contents"
roots = [contents / name for name in ("Frameworks", "Resources", "MacOS")]
dist_index = next((root / "dist/index.html" for root in roots if (root / "dist/index.html").is_file()), None)
audio_helper = next((root / "bin/ZhilingAudioCapture" for root in roots if (root / "bin/ZhilingAudioCapture").is_file()), None)
cacert = next((root / "certifi/cacert.pem" for root in roots if (root / "certifi/cacert.pem").is_file()), None)
sherpa_lib = next(
    (p for root in roots if (root / "sherpa_onnx").is_dir() for p in (root / "sherpa_onnx").rglob("*.dylib")),
    None,
)
if dist_index is None:
    sys.exit("应用包缺少前端静态产物 dist/index.html")
if audio_helper is None:
    sys.exit("应用包缺少 macOS 系统内录助手 bin/ZhilingAudioCapture")
if cacert is None:
    sys.exit("应用包缺少 TLS 根证书 certifi/cacert.pem")
if sherpa_lib is None:
    sys.exit("应用包缺少本地语音识别推理库 sherpa_onnx")
print("应用包自检通过，已包含本地语音推理库：", sherpa_lib.name)
PYEOF

DMG_STAGING="$ROOT/build/dmg-staging"
DMG_OUT="$ROOT/release/ZhilingClassroom-macOS-${MAC_ARCH}.dmg"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING" "$ROOT/release"
ditto "$APP_BUNDLE" "$DMG_STAGING/ZhilingClassroom.app"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create \
  -volname "知聆课堂" \
  -srcfolder "$DMG_STAGING" \
  -ov \
  -format UDZO \
  "$DMG_OUT"

rm -rf "$ROOT/release/ZhilingClassroom.app"
mv "$DMG_STAGING/ZhilingClassroom.app" "$ROOT/release/ZhilingClassroom.app"
rm -rf "$DMG_STAGING"
echo "打包完成：$DMG_OUT"
