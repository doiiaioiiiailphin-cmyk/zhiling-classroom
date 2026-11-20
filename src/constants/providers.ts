import type { AIModuleKey, ApiProtocol, AsrProtocol } from '../types/domain';

export interface LlmProviderPreset {
  id: string;
  name: string;
  protocol: ApiProtocol;
  defaultBaseUrl: string;
  isCustom?: boolean;
  defaultSampleModels: string[];
}

export interface AsrProviderPreset {
  id: string;
  name: string;
  protocol: AsrProtocol;
  defaultBaseUrl: string;
  requiresAppId?: boolean;
  isLocalFree?: boolean;
  isCustom?: boolean;
  defaultModels: string[];
}

export const API_PROTOCOL_OPTIONS: Array<{ value: ApiProtocol; label: string }> = [
  { value: 'openai', label: 'OpenAI 原生协议 (Responses / Chat)' },
  { value: 'anthropic', label: 'Anthropic 原生协议 (Messages API)' },
  { value: 'gemini', label: 'Google Gemini 原生协议 (v1beta)' },
  { value: 'openai-compatible', label: 'OpenAI 通用兼容协议' },
];

export const OPENCODE_FREE_PROVIDER_ID = 'opencode-free-bridge';

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: OPENCODE_FREE_PROVIDER_ID,
    name: 'OpenCode 免费模型',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'builtin://opencode-free-bridge',
    defaultSampleModels: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultSampleModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultSampleModels: [
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-haiku-20241022',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultSampleModels: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultSampleModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'aliyun',
    name: '阿里云百炼',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultSampleModels: ['qwen-max-latest', 'qwen-plus-latest', 'qwen-turbo-latest'],
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultSampleModels: ['glm-4.5', 'glm-4-air-250414', 'glm-4-flash'],
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    defaultSampleModels: ['kimi-k2-0711-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
  },
  {
    id: 'volcengine',
    name: '火山方舟',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultSampleModels: ['doubao-seed-1.6', 'doubao-1.5-pro-32k', 'doubao-1.5-lite-32k'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultSampleModels: [
      'Qwen/Qwen3-235B-A22B',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-32B-Instruct',
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultSampleModels: [
      'openai/gpt-4.1',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-pro',
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultSampleModels: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'gemma2-9b-it'],
  },
  {
    id: 'custom',
    name: '自定义接口',
    protocol: 'openai-compatible',
    defaultBaseUrl: '',
    isCustom: true,
    defaultSampleModels: ['custom-chat-model', 'custom-fast-model'],
  },
];

export const ASR_PROVIDER_PRESETS: AsrProviderPreset[] = [
  {
    id: 'builtin-free-asr',
    name: '本地离线语音（SenseVoice）',
    protocol: 'builtin-free-asr',
    defaultBaseUrl: 'local://sensevoice',
    isLocalFree: true,
    defaultModels: ['sensevoice-small-int8'],
  },
  {
    id: 'openai-audio',
    name: 'OpenAI 语音',
    protocol: 'openai-audio',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModels: ['gpt-4o-transcribe-diarize', 'gpt-4o-transcribe', 'whisper-1'],
  },
  {
    id: 'aliyun-asr',
    name: '阿里云通义听悟',
    protocol: 'aliyun-tingwu',
    defaultBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    defaultModels: ['paraformer-realtime-v2', 'sensevoice-v1', 'gummy-realtime-v1'],
  },
  {
    id: 'volcengine-asr',
    name: '豆包流式语音',
    protocol: 'volcengine-asr',
    defaultBaseUrl: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    requiresAppId: true,
    defaultModels: ['bigmodel-sauc-diarize-v3', 'bigmodel-streaming-asr'],
  },
  {
    id: 'iflytek-asr',
    name: '科大讯飞转写',
    protocol: 'iflytek-rtasr',
    defaultBaseUrl: 'wss://rtasr.xfyun.cn/v1/ws',
    requiresAppId: true,
    defaultModels: ['rtasr-role-diarization-v2', 'rtasr-standard-v1'],
  },
  {
    id: 'tencent-asr',
    name: '腾讯云语音',
    protocol: 'tencent-asr',
    defaultBaseUrl: 'wss://asr.cloud.tencent.com/asr/v2',
    requiresAppId: true,
    defaultModels: ['16k_zh_large_diarize', '16k_zh-PY_edu'],
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    protocol: 'deepgram',
    defaultBaseUrl: 'wss://api.deepgram.com/v1/listen',
    defaultModels: ['nova-3-general', 'nova-2-meeting'],
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    protocol: 'assemblyai',
    defaultBaseUrl: 'wss://streaming.assemblyai.com/v3/ws',
    defaultModels: ['universal-streaming-diarize', 'slam-1'],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    protocol: 'elevenlabs-scribe',
    defaultBaseUrl: 'https://api.elevenlabs.io/v1',
    defaultModels: ['scribe_v1', 'scribe_v1_experimental'],
  },
  {
    id: 'custom-asr',
    name: '自定义语音',
    protocol: 'custom-asr',
    defaultBaseUrl: '',
    isCustom: true,
    defaultModels: ['custom-streaming-asr-v1'],
  },
];

export interface AIModuleMeta {
  key: AIModuleKey;
  title: string;
  thinkingLabel: string;
  thinkingActive: boolean;
  canToggle: boolean;
}

export const AI_MODULE_META_LIST: AIModuleMeta[] = [
  {
    key: 'chat',
    title: '课堂实时对话问答',
    thinkingLabel: '思考：Max',
    thinkingActive: true,
    canToggle: false,
  },
  {
    key: 'sentenceCorrection',
    title: '逐句错别字与语句智能修正',
    thinkingLabel: '思考：关闭',
    thinkingActive: false,
    canToggle: true,
  },
  {
    key: 'resegmentation',
    title: '相似知识点自动重新分段',
    thinkingLabel: '思考：关闭',
    thinkingActive: false,
    canToggle: true,
  },
  {
    key: 'keyTermHighlight',
    title: '重点词黄色荧光笔标注与悬浮释义',
    thinkingLabel: '思考：关闭',
    thinkingActive: false,
    canToggle: true,
  },
  {
    key: 'bubbleExplanation',
    title: '左侧气泡点击知识点深度解析',
    thinkingLabel: '思考：中等',
    thinkingActive: true,
    canToggle: true,
  },
];
