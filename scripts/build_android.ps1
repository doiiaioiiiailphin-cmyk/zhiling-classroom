# 知聆课堂 Android 独立版一键构建脚本（Kotlin 前台引擎 + 复用 React 响应式前端 + sherpa-onnx 离线语音）
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/build_android.ps1               # 默认构建 arm64-v8a 正式分发包
#   powershell -ExecutionPolicy Bypass -File scripts/build_android.ps1 -Universal    # 构建 arm64-v8a + x86_64（含模拟器支持）
param(
    [switch]$DebugBuild,
    [switch]$Universal
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 1. 自动定位 JDK 17/21 与 Android SDK
if (-not $env:JAVA_HOME -or -not (Test-Path "$env:JAVA_HOME\bin\javac.exe")) {
    $candidates = @(
        "C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot",
        "C:\Program Files\Android\Android Studio\jbr",
        "C:\Program Files\Eclipse Adoptium\jdk-21*",
        "C:\Program Files\Java\jdk-21*"
    )
    foreach ($pat in $candidates) {
        $found = Get-Item $pat -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found -and (Test-Path "$($found.FullName)\bin\javac.exe")) {
            $env:JAVA_HOME = $found.FullName
            break
        }
    }
}
if (-not $env:JAVA_HOME) {
    throw "未找到 JDK 17/21，请设置 JAVA_HOME。"
}
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"

$SdkDir = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
if (-not (Test-Path $SdkDir)) {
    throw "未找到 Android SDK 目录：$SdkDir"
}
$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir
$escapedSdk = $SdkDir.Replace("\", "\\").Replace(":", "\:")
Set-Content -Path "$Root\android\local.properties" -Value "sdk.dir=$escapedSdk" -Encoding ASCII

Write-Host "[1/4] 构建前端生产静态资源 (dist/)..." -ForegroundColor Cyan
$env:VITE_USE_MOCK = "false"
$env:VITE_API_BASE_URL = "/api/v1"
npm run build
if ($LASTEXITCODE -ne 0) {
    throw "前端生产构建失败"
}

Write-Host "[2/4] 运行 Android Kotlin 单元测试..." -ForegroundColor Cyan
$Abis = if ($Universal) { "arm64-v8a,x86_64" } else { "arm64-v8a" }
$Task = if ($DebugBuild) { "assembleDebug" } else { "assembleRelease" }

Push-Location "$Root\android"
try {
    & .\gradlew.bat testDebugUnitTest --no-daemon "-PzhilingAbis=$Abis"
    if ($LASTEXITCODE -ne 0) {
        throw "Android Kotlin 单元测试失败"
    }

    Write-Host "[3/4] 构建 Android APK ($Task, ABIs=$Abis)..." -ForegroundColor Cyan
    & .\gradlew.bat $Task --no-daemon "-PzhilingAbis=$Abis"
    if ($LASTEXITCODE -ne 0) {
        throw "Android APK 构建失败"
    }
} finally {
    Pop-Location
}

Write-Host "[4/4] 归档构建产物至 release/..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path "$Root\release" | Out-Null
$SourceApk = if ($DebugBuild) {
    "$Root\android\app\build\outputs\apk\debug\app-debug.apk"
} else {
    "$Root\android\app\build\outputs\apk\release\app-release.apk"
}
if (-not (Test-Path $SourceApk)) {
    throw "未找到生成的 APK：$SourceApk"
}

$OutName = if ($Universal) {
    "ZhilingClassroom-Android-universal.apk"
} else {
    "ZhilingClassroom-Android-arm64.apk"
}
$DestApk = "$Root\release\$OutName"
Copy-Item -Force $SourceApk $DestApk
$SizeMb = [math]::Round((Get-Item $DestApk).Length / 1MB, 2)
$Sha256 = (Get-FileHash $DestApk -Algorithm SHA256).Hash.ToLowerInvariant()

$apksigner = Get-ChildItem -Path "$SdkDir\build-tools\*\apksigner.bat" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if ($apksigner) {
    Write-Host "[校验签名] 使用 $($apksigner.FullName) 核验 APK 签名..." -ForegroundColor Cyan
    & $apksigner.FullName verify --verbose --print-certs $DestApk
    if ($LASTEXITCODE -ne 0) {
        throw "APK 签名校验失败"
    }
}

Write-Host "打包完成：$DestApk ($SizeMb MB, sha256=$Sha256)" -ForegroundColor Green
