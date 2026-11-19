# 知聆课堂

**把正在讲的课，变成课后能搜、能问、能复习的笔记。**

知聆课堂是一个面向 Windows 的 AI 听课工作台。从双路录音、流式字幕到知识点整理，整堂课的录音、转写和复习材料都能在一个课堂里找到。

- **上课跟得住**。采集麦克风和系统声音，实时显示字幕，随时标记重点或疑问。
- **复习找得快**。按关键词搜转写，跳到录音原处回听，围绕课堂内容提问或展开段落详解。
- **课后整理得清楚**。导入现成音视频，按知识点组织转写，生成笔记和闪卡。

## 下载 Windows 版

从 [Releases](../../releases) 下载 Windows x64 压缩包，完整解压后运行 `ZhilingClassroom.exe`。

默认免登录语音在首次使用时会弹窗确认下载。文字功能默认使用「OpenCode 免费模型」，需要本机有 OpenCode 2 CLI，应用会在后台启动它。语音和文字供应商均可在设置中切换。 [供应商配置](backend/README.md#供应商接入) · [Windows 打包](docs/WINDOWS_PACKAGING_LICENSES.md)

## 前端开发预览

```bash
# 安装依赖
npm install

# 启动本地开发预览服务器
npm run dev

# 类型检查与生产构建
npm run typecheck
npm run build
```

联调和真实转写需要启动后端。 [本地联调说明](backend/README.md#一键联调)

## 目录结构

- `src/components/home/`：主菜单工作台（首格 `+` 开启新课堂、已保存课堂卡片继续录音、右键菜单与文件夹管理）
- `src/components/classroom/`：可拖拽双栏课堂界面（左侧实时上下文 AI 问答、右侧讲话人识别转写、黄色荧光笔重点词悬浮 Tooltip、自动重分段与左侧气泡点击详情弹出框）
- `src/components/settings/`：系统设置中心与带矢量图标的方格供应商选择弹窗（覆盖 OpenAI / Anthropic / Google Gemini 原生协议及主流 LLM 与语音转写预设）
- `src/services/`：前后端零耦合通信层（`api.ts`、`classroomSocket.ts`、`mockData.ts`）
- `docs/BACKEND_DEVELOPMENT_GUIDE.md`：**完整后端开发与接口规范手册**
