# 知聆课堂 Windows 桌面应用构建脚本（Edge WebView2 无边框圆角原生方案）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build_windows.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

python -B -c "import sys, sysconfig; raise SystemExit(not (sys.implementation.name == 'cpython' and (3, 11) <= sys.version_info[:2] <= (3, 14) and not sysconfig.get_config_var('Py_GIL_DISABLED')))"
if ($LASTEXITCODE -ne 0) {
    throw "打包需要常规 CPython 3.11 至 3.14"
}

Write-Host "[1/4] 生成多尺寸高清透明应用图标 (assets/zhiling.ico)..." -ForegroundColor Cyan
python -X utf8 "$Root\scripts\generate_icon.py"
if ($LASTEXITCODE -ne 0) {
    throw "应用图标生成失败"
}

Write-Host "[2/4] 构建前端生产静态资源 (dist/)..." -ForegroundColor Cyan
$env:VITE_USE_MOCK = "false"
$env:VITE_API_BASE_URL = "/api/v1"
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "前端构建失败"
}

Write-Host "[3/4] 准备 Windows 桌面包依赖（含本地 SenseVoice / sherpa-onnx 引擎）..." -ForegroundColor Cyan
python -m pip install -r "$Root\backend\requirements-runtime.txt" pywebview pyinstaller
if ($LASTEXITCODE -ne 0) {
    throw "依赖安装失败"
}

Write-Host "[4/4] 使用 PyInstaller 构建 Windows 独立桌面客户端 (release/ZhilingClassroom)..." -ForegroundColor Cyan
if (Test-Path "$Root\release\ZhilingClassroom") {
    Remove-Item -Recurse -Force "$Root\release\ZhilingClassroom"
}

python -m PyInstaller `
    --noconfirm `
    --clean `
    --windowed `
    --name "ZhilingClassroom" `
    --icon "$Root\assets\zhiling.ico" `
    --distpath "$Root\release" `
    --workpath "$Root\build\pyinstaller" `
    --specpath "$Root\build\pyinstaller" `
    --paths "$Root\backend" `
    --add-data "$Root\dist;dist" `
    --add-data "$Root\assets\zhiling.ico;assets" `
    --hidden-import "greenlet" `
    --hidden-import "aiosqlite" `
    --hidden-import "sqlalchemy.dialects.sqlite.aiosqlite" `
    --hidden-import "uvicorn.logging" `
    --hidden-import "uvicorn.loops.auto" `
    --hidden-import "uvicorn.loops.asyncio" `
    --hidden-import "uvicorn.protocols.http.auto" `
    --hidden-import "uvicorn.protocols.http.h11_impl" `
    --hidden-import "uvicorn.protocols.websockets.auto" `
    --hidden-import "uvicorn.protocols.websockets.websockets_impl" `
    --hidden-import "uvicorn.lifespan.on" `
    --hidden-import "websockets.legacy" `
    --hidden-import "websockets.legacy.server" `
    --hidden-import "websockets.legacy.client" `
    --collect-all "sherpa_onnx" `
    --collect-data "certifi" `
    --collect-data "tzdata" `
    --collect-data "webview" `
    --collect-binaries "webview" `
    --collect-all "pythonnet" `
    --collect-all "clr_loader" `
    --exclude-module "pygame" `
    --exclude-module "matplotlib" `
    --exclude-module "scipy" `
    --exclude-module "pandas" `
    --exclude-module "torch" `
    --exclude-module "tensorflow" `
    --exclude-module "tkinter" `
    --exclude-module "PyQt5" `
    --exclude-module "PyQt6" `
    --exclude-module "PySide2" `
    --exclude-module "PySide6" `
    --exclude-module "wx" `
    --exclude-module "IPython" `
    --exclude-module "pytest" `
    "$Root\backend\desktop_shell.py"

if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller 打包失败"
}

Write-Host "打包完成！可执行文件：$Root\release\ZhilingClassroom\ZhilingClassroom.exe" -ForegroundColor Green
