; 知聆课堂 Windows 安装向导脚本（NSIS 3.x MUI2 / Unicode / High-DPI）
; 由 scripts/build_windows.ps1 自动调用：
;   makensis /INPUTCHARSET UTF8 /DAPP_VERSION=0.1.2 /DSOURCE_DIR=... /DOUT_FILE=... /DICON_FILE=... scripts/installer_windows.nsi

Unicode True
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.1.2"
!endif
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\release\ZhilingClassroom"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "..\release\ZhilingClassroom-Setup-${APP_VERSION}-x86_64.exe"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "..\assets\zhiling.ico"
!endif

!define APP_NAME "知聆课堂"
!define APP_EN_NAME "ZhilingClassroom"
!define APP_EXE "ZhilingClassroom.exe"
!define APP_PUBLISHER "知聆课堂团队"
!define APP_URL "https://cnb.cool/dolphin114/zhiling-classroom"
!define UNINST_REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_EN_NAME}"
!define APP_REG_KEY "Software\${APP_EN_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_EN_NAME}"
InstallDirRegKey HKCU "${APP_REG_KEY}" "InstallDir"
RequestExecutionLevel user
BrandingText "${APP_NAME} v${APP_VERSION}"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright (C) ${APP_PUBLISHER}"

; MUI2 界面样式配置
!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${APP_NAME} v${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "本向导将在您的计算机上安装「${APP_NAME}」桌面客户端（内置本地语音转写引擎与 CNB 自动热更新）。$\r$\n$\r$\n默认安装至当前用户目录，无需管理员权限，后续版本可自动静默热更新。$\r$\n$\r$\n请点击「下一步」继续。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!define MUI_FINISHPAGE_LINK "访问 CNB 官方发布页"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "知聆课堂核心程序（必选）" SecCore
  SectionIn RO

  ; 若旧版正在运行，先温和结束进程以避免文件占用
  DetailPrint "正在检查并关闭运行中的 ${APP_NAME}..."
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /T /F'
  Sleep 500

  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"

  ; 创建开始菜单快捷方式
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\Uninstall.exe" 0

  ; 生成卸载程序并写入当前用户卸载注册表项
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_REG_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "URLInfoAbout" "${APP_URL}"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
  WriteRegStr HKCU "${UNINST_REG_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_REG_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_REG_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "创建桌面快捷方式" SecDesktop
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "安装「${APP_NAME}」主程序、原生窗口宿主与本地语音识别依赖（必选）。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "在 Windows 桌面创建「${APP_NAME}」快捷启动图标。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  DetailPrint "正在关闭运行中的 ${APP_NAME}..."
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /T /F'
  Sleep 500

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_REG_KEY}"
  DeleteRegKey HKCU "${APP_REG_KEY}"
SectionEnd
