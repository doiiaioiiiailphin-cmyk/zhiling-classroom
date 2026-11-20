# 知聆课堂 macOS 语音与免费模型交接

默认免登录语音和 OpenCode 免费模型已经接入现有的 macOS 桌面宿主。两个扩展都在首次使用、用户确认后下载到当前用户的目录，之后复用校验通过的缓存。前端共用 `AddonDownloadModal.tsx`，下载状态用实际传输字节更新。

## 模块入口

| 环节 | 文件 |
| --- | --- |
| Cocoa/WKWebView 启动及用户目录传入 | `backend/desktop_shell.py`、`backend/desktop_macos.py` |
| 运行架构与扩展路径 | `backend/app/providers/platform_hooks.py` |
| 语音安装与依赖锁定 | `backend/app/services/builtin_asr.py`、`backend/app/services/builtin_asr_macos.py` |
| 录音、导入和缺口补转写共用的语音适配器 | `backend/app/providers/asr/builtin_shell.py` |
| OpenCode 下载和本机桥接 | `backend/app/providers/opencode_runtime.py`、`backend/app/providers/opencode_bridge.py` |
| 首次使用确认及下载状态 | `backend/app/api.py`、`src/store/useAppStore.ts`、`src/components/ui/AddonDownloadModal.tsx` |
| 原生 Opus 和应用包 | `scripts/build_opus_macos.sh`、`scripts/build_macos.sh` |

桌面用户目录为 `~/Library/Application Support/ZhilingClassroom/`。安装的语音依赖位于 `addons/builtin-free-asr/`，OpenCode CLI 位于 `addons/opencode-free/`，SQLite 和桥接脚本使用 `data/`，窗口版启动日志位于 `logs/desktop.log`。

## 默认免登录语音

- 保留 `doubaoime-asr` 的 `yangmoling` 副本和提交 `267972f815f519fd7c6149f85a8b7cc99daf61a5`。首次点击录音、导入或补转写时复用现有确认弹窗。安装接口 `POST /api/v1/addons/builtin-free-asr/download` 要求 `{"confirmed":true}`。[源码提交](https://github.com/yangmoling/doubaoime-asr/commit/267972f815f519fd7c6149f85a8b7cc99daf61a5)
- macOS 支持 Apple Silicon `arm64` 和 Intel `x86_64` 上的常规 CPython 3.11 至 3.14。按架构和 ABI 选择 `miniaudio==1.73`，`protobuf==6.33.5` 使用同一份 universal2 wheel。依赖优先走清华和华为云镜像，回退到官方 PyPI。源码与依赖均校验，导入成功后才创建 `.ready`。
- 打包时按当前架构从 Xiph 的固定源码编译 Opus 1.6.1，随 `.app` 附带 `libopus.dylib`、原始 `COPYING` 和 `ORIGIN.txt`。构建脚本会校验架构、签名和许可文件，并实际加载包内 Opus。也可在 `assets/opus/macosx-arm64/` 或 `assets/opus/macosx-x86_64/` 放入同架构的预编译库及其原始 `COPYING`。[Xiph 官方发布](https://opus-codec.org/downloads/) · [Opus 许可证](https://opus-codec.org/license/)
- 源码联调也可从 `build/opus-macos/<arch>/` 或同架构 Homebrew 路径读取 Opus。`ASR_OPUS_UNAVAILABLE` 时先检查动态库架构和包内 `asr/libopus.dylib`。`ASR_ADDON_DOWNLOAD_FAILED` 时查看运行日志中的 GitHub 和 PyPI 请求。

## OpenCode 免费模型

| 架构 | 官方 npm 包 | `addons/opencode-free/` 下的 CLI |
| --- | --- | --- |
| Apple Silicon | `@opencode/cli-darwin-arm64@2.3.2` | `2.3.2-darwin-arm64/opencode` |
| Intel | `@opencode/cli-darwin-x64-baseline@2.3.2` | `2.3.2-darwin-x64/opencode` |

首次使用请求 `POST /api/v1/addons/opencode/download/stream`，携带 `{"confirmed":true}`。依次尝试 npm 国内镜像和官方源。验证压缩包的 SHA-512、程序的 SHA-256，设置执行权限并原子安装。`starting` 阶段启动隔离的回环服务，`ready` 阶段已通过带认证的 `/api/info` 进程检查。设置页刷新仍读取 CLI 和云端的模型目录，生成请求沿用现有桥接，额度限制通过 `OPENCODE_FREE_RATE_LIMIT` 抛回界面。[OpenCode 2.3.2](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)

排查时用上表对应的用户目录内程序运行 `--version`。开发时也可用 `ZHILING_OPENCODE_EXECUTABLE` 指定本机 OpenCode 2 原生程序的绝对路径。

## Mac 构建与验收

在目标架构的 Mac 上使用 Xcode Command Line Tools、Node.js 20+ 和常规 CPython 3.11 至 3.14。

```bash
python3 -m venv build/venv-macos
source build/venv-macos/bin/activate
npm ci
bash scripts/build_macos.sh
python -X utf8 scripts/verify_desktop_addons.py
open release/ZhilingClassroom.app
```

输出位于 `release/ZhilingClassroom.app` 和 `release/ZhilingClassroom-macOS-<arch>.dmg`，构建使用本地 ad hoc 签名。验收脚本在临时用户数据目录用项目后端测试真实下载，调用应用包内的 Opus 编码一帧 PCM，启动下载的 OpenCode，再启动一次后端确认缓存复用。

GitHub Actions 中的 **Build macOS Desktop App** 支持手动选择 `arm64` 或 `x86_64`。勾选 `verify_addons` 会在打包后执行相同的扩展验收。工作流按私有仓库的 Actions 用量计量。[GitHub 托管运行器](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

最后在 `.app` 里完成三项验收。

1. 使用新用户目录首次录一段实际语音。确认只弹一次下载窗口，录音时出现临时字幕，暂停后最后一句定稿，重新打开课堂后仍能读取。再用同一段真实音频验证导入和缺口补转写。
2. 在设置中刷新 OpenCode 模型列表，再用其中一个模型执行一段真实文字整理。若返回 HTTP 429，保留接口原始错误和时间。
3. 退出并重开应用，重新开始语音转写和文字整理，确认两种已安装的组件直接复用。

## 本轮验证

- 已下载并核对两份 OpenCode macOS 发行包和九份 macOS wheel 的哈希与二进制架构，也核对了 Xiph Opus 源码哈希。
- Windows 验收跑通了两种扩展的真实下载、Opus 编码、OpenCode 回环服务启动，以及新进程复用磁盘缓存。
- Windows 实测读取了 10 个免费文本模型。一次文字整理返回 HTTP 429 `OPENCODE_FREE_RATE_LIMIT`。用公开真实录音发起一次语音会话，连接阶段返回 HTTP 502 `ASR_TIMEOUT`。
- Cocoa 启动、Mac 上的应用打包和录音待在目标架构实机运行上面的命令。

