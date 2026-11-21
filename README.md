# 知聆课堂 (Zhiling Classroom)

**把正在讲的课，变成课后能搜、能问、能复习的笔记。**

知聆课堂是一款面向 **Windows 与 macOS** 的本地优先 AI 听课工作台。集双路免驱动拾音、本地离线语音转写、实时上下文 AI 助教、知识点分段高亮、闪卡/笔记导出与自动更新于一体，整堂课的录音、转写与复习资料完全保存在本地设备中。

## 核心特性

- **双平台免驱动双路拾音**：
  - **Windows**：原生 WASAPI 系统内录 + 麦克风双通道采集，支持一键按需下载 WebRTC AEC3 双讲回声消除。
  - **macOS**：macOS 14.2+ 原生 CoreAudio Process Tap 纯系统音频内录（免虚拟声卡、免录屏反复弹窗，macOS 13.x 自动回退 ScreenCaptureKit），原生左置红黄绿交通灯与全局快捷键。
- **开箱即用本地离线语音识别**：内置 `sherpa-onnx` SenseVoice-Small（int8）推理引擎，首次使用从魔搭（ModelScope）高速下载模型并做 SHA-256 校验，断网也能实时转写；同时也支持接入 OpenAI、阿里云听悟、火山引擎、讯飞、腾讯云、Deepgram、AssemblyAI、ElevenLabs 等云端语音供应商。
- **多协议 AI 课堂助教与知识整理**：原生支持 OpenAI / Anthropic / Google Gemini / OpenAI-Compatible 协议与主流大模型供应商预设，以及开箱即用的 OpenCode 免费模型；支持课堂实时上下文问答（支持粘贴板书截图 / 全局快捷键抓屏）、黄色荧光笔重点术语解析、AI 自动重分段、结构化复习笔记、闪卡生成与 Markdown / Word / TXT / Anki 导出。
- **置顶迷你字幕窗与外力暂停系统置顶告警**：看网课或全屏写代码时可开启透明置顶迷你字幕窗；录音因外部设备断开或异常意外暂停时，在 Windows / macOS 屏幕顶部弹出 OS 级不抢焦点告警卡片，一键恢复录音。
- **国内高速全自动热更新**：每次启动静默通过 CNB 公开仓库检测新版，右下角弹窗一键下载（流式 SHA-256 校验）并自动替换重启，零数据丢失。
- **本地优先与隐私加密**：课堂记录保存在本机 SQLite，所有 API Key 均采用本机密钥 AES-GCM 加密存储，不上传任何个人课堂数据。

## 下载安装包

可从 [GitHub Releases](../../releases) 或国内高速镜像 [CNB Releases](https://cnb.cool/dolphin114/zhiling-classroom/-/releases) 下载最新正式版：

| 平台与架构 | 安装包 | 说明 |
| --- | --- | --- |
| **Windows (x64) 安装向导** | `ZhilingClassroom-Setup-<version>-x86_64.exe` | 推荐，图形化向导，默认免管理员安装，自动创建桌面/开始菜单快捷方式并支持自动热更新 |
| **Windows (x64) 便携版** | `ZhilingClassroom-Windows-x86_64.zip` | 解压即用（同时为客户端自动热更新下载包） |
| **macOS Apple Silicon (M 系列)** | `ZhilingClassroom-macOS-arm64.dmg` | 适用于 M1 / M2 / M3 / M4 芯片 Mac，打开拖入「应用程序」即可 |
| **macOS Intel** | `ZhilingClassroom-macOS-x86_64.dmg` | 适用于 Intel 芯片 Mac |

## 本地开发与自行打包

### 1. 前端开发与构建

```bash
npm install
npm run dev        # 启动前端开发服务器 (http://localhost:5173)
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建生产静态资源 (dist/)
```

### 2. 后端服务与单元测试

```bash
python -m pip install -r backend/requirements-runtime.txt
python backend/run.py                                      # 启动本地 FastAPI 服务 (http://127.0.0.1:8000)
python -X utf8 -m unittest discover -s backend/tests -v    # 运行全部单元测试
```

### 3. 桌面端打包

- **Windows（产出独立目录 + 热更新 ZIP + NSIS 安装程序）**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/build_windows.ps1
  ```
- **macOS（需在对应架构 macOS 上执行，产出 `.app` 与 `.dmg`）**：
  ```bash
  bash scripts/build_macos.sh
  ```

## 目录结构

- `src/`：React 19 + TypeScript + Tailwind CSS v4 前端工作台（`home/`、`classroom/`、`overlay/`、`settings/`、`services/`）
- `backend/`：FastAPI + SQLite + AES-GCM + `sherpa-onnx` 本地服务，以及 Windows / macOS `pywebview` 原生桌面宿主（`desktop_shell.py`、`desktop_macos.py`）
- `scripts/`：图标生成、macOS Swift 系统内录助手（`mac_audio_helper/`）、Windows NSIS 安装脚本（`installer_windows.nsi`）、打包与 CNB Release 发布脚本
- `docs/`：后端接口规范与开源许可证说明

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
