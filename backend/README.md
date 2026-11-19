# 知聆课堂后端

接口、数据库字段与实时事件以项目的 [后端开发与接口规范](../docs/BACKEND_DEVELOPMENT_GUIDE.md) 为准。开发代理使用项目根目录的 `.env.local`，前端从 `/api/v1` 访问 REST，并直连 `ws://127.0.0.1:8000/ws/v1`。

## 一键联调

在项目根目录使用 Python 3.11+ 和 Node.js 执行以下命令。前两条只需在首次安装或更新依赖时运行。

```powershell
python -m pip install -r backend/requirements.txt
npm ci
python backend/run.py --with-frontend
```

浏览器打开 [http://localhost:5173](http://localhost:5173)。后端监听 `127.0.0.1:8000`，按 Ctrl+C 结束联调。只启动后端时运行 `python backend/run.py`。如果已有 Vite 进程占用端口，可重启已有进程使它加载 `.env.local`，再单独启动后端。

1. 在设置中填写语音供应商的密钥（及所需 App ID），点击右侧刷新图标即可校验凭据并载入该账号可用的实时语音转写模型列表。
2. 为要使用的 AI 能力填入供应商密钥，点击获取模型后自动载入模型下拉列表并绑定默认模型，也可在「功能模型分配」页为五项能力单独指定模型或开关。初次启动未填密钥时，所有模型列表均为空。
3. 选择输入来源并开启课堂。麦克风模式需要浏览器录音权限。系统内录通过浏览器共享面板选择一个可共享音频的来源，并勾选共享音频。混音模式会调用两项授权，若只有一路可用则继续采集该路。
4. 说话后查看转写，试用暂停、继续、段落详解和课堂问答。点击「保存并返回主菜单」后重新进入课堂，可以读取历史转写与问答。实时语音或权限错误通过 WebSocket `error` 事件和浏览器控制台显示。

浏览器通过 AudioWorklet 发送 100 ms 的 16 kHz 单声道 PCM 帧。WebSocket 协议也接受 `opus_webm`，此格式需要系统 `PATH` 上的 FFmpeg。每次开始或继续 WebM 录音时，第一帧须包含新的 WebM 容器头。

## 供应商接入

文本功能默认走「OpenCode 免费模型」。Windows x64 首次使用时确认下载，应用会获取并校验固定的 OpenCode 2.3.2 CLI，保存在 `%LOCALAPPDATA%\ZhilingClassroom\addons\opencode-free`。下载优先走国内 npm 镜像，后续使用直接加载缓存，并按需启动隔离的本机服务和桥接器。 [OpenCode 2.3.2](https://github.com/anomalyco/opencode/releases/tag/v2.3.2) · [opencode-free-bridge](https://github.com/prestonw/opencode-free-bridge)

在设置中点击刷新可取得当前免费文本模型。也可以把功能模型设为「自动选择免费模型」。长文本一次返回，图片问答可单独选用视觉供应商。

如果系统同时装有多个版本，可在 `ZHILING_OPENCODE_EXECUTABLE` 指定 OpenCode 2 的绝对路径，或在应用数据目录的 `addons/opencode-free/executable.txt` 写入该路径。云端额度限制会在课堂中显示。

文本路由使用原生 OpenAI Chat Completions、Anthropic Messages、Gemini GenerateContent 及 OpenAI 兼容协议。模型列表从供应商读取。结构化结果先由协议支持的 JSON Schema 约束，再经过 Pydantic 校验。兼容网关拒绝 Schema 时会尝试 JSON 模式。长课问答结合 BM25 相关片段和最近五分钟的转写。 [OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [Anthropic](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) · [Gemini](https://ai.google.dev/api/generate-content)

| 语音供应商 | 实时接口与配置 |
| --- | --- |
| OpenAI | Realtime 发送 24 kHz PCM，16 kHz 输入由服务端连续重采样。选择 `gpt-4o-transcribe-diarize` 时按语音窗口调用 Audio Transcriptions SSE，并解析说话人段落。 [Realtime](https://developers.openai.com/api/docs/guides/realtime-transcription) · [Audio Transcriptions](https://developers.openai.com/api/docs/guides/speech-to-text) |
| 阿里云 DashScope | Paraformer、Fun-ASR 与 Gummy 使用 `run-task` / `finish-task` WebSocket。实时端点提供分句转写，DashScope 的 Paraformer 说话人分离由文件转写接口提供。 [模型目录](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/list-models) · [实时协议](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/paraformer-client-events) · [说话人分离](https://www.alibabacloud.com/help/en/model-studio/paraformer-recorded-speech-recognition-restful-api) |
| Deepgram | Listen WebSocket 支持实时识别和词级说话人分离。中文与中英混合可选模型列表中的多语种 Nova-3 型号。 [Listen](https://developers.deepgram.com/reference/speech-to-text/listen-streaming) · [模型目录](https://developers.deepgram.com/guides/fundamentals/model-metadata) |
| 豆包 | 使用 SAUC 二进制协议。新控制台填 API Key，旧控制台填 App ID 和 Access Token。配置所开通的 SAUC 资源 ID，开启分离时解析上游说话人标签。 [SAUC](https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1?lang=zh) · [说话人分离](https://docs.volcengine.com/docs/doubao-voice/speaker-separation?lang=zh) |
| 讯飞 | 实时转写标准版使用 App ID 和转写服务 API Key，支持 `roleType=2`。 [实时转写](https://www.xfyun.cn/doc/asr/rtasr/API.html) |
| 腾讯云 | 填写 App ID，密钥输入框填写 `SecretId:SecretKey`。使用签名 WebSocket 接入标准实时转写服务。 [实时语音识别](https://cloud.tencent.com/document/api/1093/48982) |
| AssemblyAI | 使用 v3 Streaming API 的 Turn 事件和说话人标签。中文课堂可选择 `whisper-rt`。 [实时说话人分离](https://www.assemblyai.com/docs/universal-streaming/multichannel-streams) |
| ElevenLabs | 使用 Realtime Scribe。选择 `scribe_v3_live` 获取多说话人标签。 [实时说话人分离](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/diarization) |
| 自定义 | 使用下述 WebSocket / 模型目录协议。填写 WebSocket 完整地址，密钥可选。 |

开启说话人分离时，服务使用供应商实际返回的角色标签。只提供单路转写的模型会发出 `ASR_DIARIZATION_UNAVAILABLE` 事件并继续识别。每次新建上游语音流时会使用该流的说话人编号，恢复录音后供应商可能分配新的标签。静音自动暂停开启时，连续 30 秒低音量会暂停向供应商发送音频，检测到语音后自动恢复。

未提供 HTTP 模型目录接口的流式语音供应商（豆包、讯飞、腾讯云、AssemblyAI 及 ElevenLabs 实时流），在点击刷新图标时会使用所填凭据向真实上游 WebSocket 发起握手鉴权，仅返回当前账号实际通过鉴权的流式引擎或资源 ID 供下拉框选择。

### 自定义 ASR 网关

- 模型目录使用 `GET /models`。例如 WebSocket 地址 `wss://host/asr/stream` 对应 `https://host/asr/models`。目录接受 `{"data":[{"id":"model-id"}]}` 或字符串数组。
- 网关先接收 `start` 文本帧。字段包括 `model`、`sampleRate`、`channels`、`encoding`、`language`、`enableSpeakerDiarization`、`expectedSpeakerMode`、`vad` 和可选的 `appId`。若填写密钥，HTTP 与 WebSocket 握手均携带 `Authorization: Bearer <key>`。
- 网关返回 `{"type":"ready"}` 后接收 16 kHz 单声道 PCM 二进制帧。它可返回 `{"type":"partial","text":"…","speakerId":"A"}`，定稿使用 `type: "final"` 并携带 `text`、可选的 `speakerId`、`startTimeMs` 和 `endTimeMs`。时间从当前语音流开始计算。
- 收到 `{"type":"stop"}` 后先返回待定稿的结果，再发 `{"type":"done"}`。上游故障可返回 `{"type":"error","code":"…","message":"…"}`。

## 本地数据与验证

SQLite 文件和录音默认保存在 `backend/data/`。`ZHILING_DATA_DIR` 可指定其他数据目录。设置以 AES-GCM 加密存入 SQLite，默认密钥存放在同目录的 `settings.key`。可通过 `ZHILING_SETTINGS_KEY` 提供 Base64 编码的 32 字节密钥。迁移时需保留对应的加密密钥。

定稿转写始终写入 SQLite。「实时自动保存」还控制本地 WAV 归档。删除课堂会清理录音、段落、讲话人和问答。默认配置面向本机单用户，使用一个 Uvicorn worker 支持录音锁与 SQLite 写入。

```powershell
python -m unittest discover -s backend/tests -v
npm run typecheck
npm run build
```

自动化测试使用临时 SQLite、回环 WebSocket 和协议响应样本。FFmpeg 可用时，测试还会生成并解码一段 Opus WebM 音频。真实供应商验收需在设置中填写可用凭据。
