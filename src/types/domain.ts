/**
 * 核心业务领域模型与前后端接口契约类型定义
 * 后端实现对应 REST / WebSocket 接口时请严格保持字段一致（详见 docs/BACKEND_DEVELOPMENT_GUIDE.md）
 */

// 底层大模型通信协议：覆盖 OpenAI 原生、Anthropic 原生、Google Gemini 原生及通用兼容协议
export type ApiProtocol = 'openai' | 'anthropic' | 'gemini' | 'openai-compatible';

// 语音转写服务接入协议
export type AsrProtocol =
  | 'builtin-free-asr'
  | 'openai-audio'
  | 'aliyun-tingwu'
  | 'volcengine-asr'
  | 'iflytek-rtasr'
  | 'tencent-asr'
  | 'deepgram'
  | 'assemblyai'
  | 'elevenlabs-scribe'
  | 'custom-asr';

// 可独立分配模型的 5 大 AI 能力模块
export type AIModuleKey =
  | 'chat'               // 课堂实时问答（常驻开启）
  | 'sentenceCorrection' // 逐句错别字与口语智能整理（可开关）
  | 'resegmentation'     // 相似知识点自动重新分段（可开关）
  | 'keyTermHighlight'   // 重点词黄色荧光笔标注与悬浮释义（可开关）
  | 'bubbleExplanation'; // 左侧气泡点击生成知识点详细说明（可开关）

export interface FolderItem {
  id: string;
  name: string;
  parentId: string | null;
  hotwords?: string[];
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'idle' | 'recording' | 'paused';

export interface ClassSessionCard {
  id: string;
  folderId: string | null;
  title: string;
  status: SessionStatus;
  durationSeconds: number;
  speakerCount: number;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpeakerProfile {
  id: string;
  label: string; // 例如："陈教授"、"提问学生 A"
  roleTag?: string;
}

export interface HighlightedTerm {
  id: string;
  term: string;
  explanation: string; // 鼠标悬浮 Tooltip 显示的术语解释
}

export interface UtteranceItem {
  id: string;
  speakerId: string;
  speakerLabel: string;
  timestampText: string; // 例如 "04:12"
  startTimeMs: number;
  endTimeMs: number;
  rawText: string;       // 语音识别原始文本
  refinedText: string;   // AI 修复错别字与顺句后的文本
  isRefined: boolean;
  isBookmarked?: boolean;
  bookmarkKind?: 'confused' | 'important' | null;
  userNote?: string | null;
  isManualEdited?: boolean;
}

export interface UtterancePatch {
  refinedText?: string;
  isBookmarked?: boolean;
  bookmarkKind?: 'confused' | 'important' | null;
  userNote?: string | null;
}

export interface SegmentDetailedExplanation {
  title: string;
  corePoints: string[];
  elaboration: string;
  thinking?: string;
  thinkingSeconds?: number;
}

export interface KnowledgeSegment {
  id: string;
  sessionId: string;
  orderIndex: number;
  topicTitle: string;
  utterances: UtteranceItem[];
  highlights: HighlightedTerm[];
  detailedExplanation?: SegmentDetailedExplanation;
}

export interface UtteranceDeleteResult {
  deletedIds: string[];
  deletedCount: number;
  segments: KnowledgeSegment[];
}

export interface SessionAttachmentItem {
  id: string;
  sessionId: string;
  segmentId?: string | null;
  kind: 'screenshot' | 'image' | 'material';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  timestampMs?: number;
  timestampText?: string;
  caption?: string;
  extractedPreview?: string;
  url: string;
  createdAt: string;
}

export interface SessionStudyNote {
  contentMarkdown: string;
  thinking?: string;
  updatedAt: string;
}

export interface FlashcardItem {
  id: string;
  front: string;
  back: string;
  tag: string;
}

export interface SessionExportRequest {
  format: 'markdown' | 'docx' | 'txt' | 'anki';
  includeStudyNote?: boolean;
  includeHighlights?: boolean;
  includeChat?: boolean;
  includeTranscript?: boolean;
  includeStickyNotes?: boolean;
}

export type PaperColor = 'cream' | 'butter' | 'sage' | 'blush';

export interface StickyNoteTimestampItem {
  id: string;
  noteId: string;
  timestampSec: number;
  timestampText: string;
  charOffset: number;
  createdAt: string;
}

export interface StickyNoteTimestampConflict {
  timestampSec: number;
  timestampText: string;
  ownerNoteId: string;
  ownerNoteTitle: string;
}

export interface StickyNoteItem {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  paperColor: PaperColor;
  posX: number;
  posY: number;
  width: number;
  height: number;
  isOpen: boolean;
  zOrder: number;
  isTranslucent: boolean;
  timestamps: StickyNoteTimestampItem[];
  conflicts: StickyNoteTimestampConflict[];
  createdAt: string;
  updatedAt: string;
}

export interface StickyNoteCreateInput {
  title?: string;
  content?: string;
  paperColor?: PaperColor;
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
  isOpen?: boolean;
  zOrder?: number;
  isTranslucent?: boolean;
}

export interface StickyNotePatchInput {
  title?: string;
  content?: string;
  paperColor?: PaperColor;
  posX?: number;
  posY?: number;
  width?: number;
  height?: number;
  isOpen?: boolean;
  zOrder?: number;
  isTranslucent?: boolean;
}

export interface SearchHitItem {
  sessionId: string;
  sessionTitle: string;
  folderId?: string | null;
  kind: 'title' | 'topic' | 'utterance' | 'highlight' | 'note' | 'chat' | 'sticky_note';
  segmentId?: string;
  utteranceId?: string;
  stickyNoteId?: string;
  timestampMs?: number;
  timestampText?: string;
  snippet: string;
  updatedAt: string;
}

export interface AudioImportProgress {
  stage: 'decoding' | 'transcribing' | 'refining';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface ChatMessage {
  id: string;
  clientKey?: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  thinkingSeconds?: number;
  isStreaming?: boolean;
  isThinking?: boolean;
  referencedSegmentCount?: number;
  attachments?: SessionAttachmentItem[];
  createdAt: string;
}

export interface SessionWorkspacePayload {
  session: ClassSessionCard;
  speakers: SpeakerProfile[];
  segments: KnowledgeSegment[];
  messages: ChatMessage[];
  studyNote?: SessionStudyNote;
  flashcards?: FlashcardItem[];
  attachments?: SessionAttachmentItem[];
  stickyNotes?: StickyNoteItem[];
  hasAudio?: boolean;
  audioDurationMs?: number;
}

// 单个 LLM 供应商配置项
export interface LLMProviderConfig {
  providerId: string;
  name: string;
  isCustom?: boolean;
  protocol: ApiProtocol;
  baseUrl: string;         // 预设供应商自动填充并隐藏，自定义供应商由用户填写
  apiKey: string;
  availableModels: string[]; // 点击获取模型按钮后拉取到的模型 ID 列表
  lastFetchedAt?: string;
}

// 单个 AI 模块的模型绑定与启停状态
export interface FeatureModelBinding {
  enabled: boolean;
  providerId: string;
  modelId: string;
}

// 语音转写（ASR）配置项
export interface AsrProviderConfig {
  providerId: string;
  name: string;
  isCustom?: boolean;
  protocol: AsrProtocol;
  baseUrl: string;
  apiKey: string;
  appId?: string;
  availableModels: string[];
  selectedModelId: string;
}

export interface Aec3AddonStatus {
  installed: boolean;
  version: string;
  sizeBytes: number;
}

export interface Aec3DownloadProgress {
  stage: 'connecting' | 'downloading' | 'verifying' | 'ready';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export type OpenCodeDownloadProgress = Omit<Aec3DownloadProgress, 'stage'> & {
  stage: Aec3DownloadProgress['stage'] | 'starting';
};

export interface UpdateAssetInfo {
  name: string;
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseTitle: string;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  platform: string;
  arch: string;
  repo: string;
  canAutoApply: boolean;
  stagedReady: boolean;
  asset: UpdateAssetInfo | null;
  checkedAt: string;
}

export interface UpdateDownloadProgress {
  stage: 'connecting' | 'downloading' | 'verifying' | 'ready';
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
}

export interface UpdateApplyResult {
  scheduled: boolean;
  mode: 'auto-replace' | 'dev-manual';
  version: string;
  downloadPath: string;
  message: string;
}

export interface NativeAudioEndpoint {
  id: string;
  rawId: string;
  name: string;
  isDefault: boolean;
  isCommunicationsDefault: boolean;
}

export interface NativeAudioDevices {
  platform: string;
  wasapiSupported: boolean;
  inputs: NativeAudioEndpoint[];
  loopbacks: NativeAudioEndpoint[];
}

export interface DesktopHotkeys {
  enabled: boolean;
  toggleRecording: string;
  toggleMicMute: string;
  captureScreenshot: string;
  bookmarkConfused: string;
  toggleMiniOverlay: string;
}

export interface AppSettings {
  // 当前在设置页选中的正在编辑的 LLM 供应商 ID
  selectedLlmProviderId: string;
  llmProviders: Record<string, LLMProviderConfig>;

  // 5 大 AI 能力各自的开关与模型分配
  featureRouting: Record<AIModuleKey, FeatureModelBinding>;

  // 语音转写与说话人分离配置
  selectedAsrProviderId: string;
  asrProviders: Record<string, AsrProviderConfig>;
  enableSpeakerDiarization: boolean;
  expectedSpeakerMode: 'auto' | 'dual' | 'multi';
  recognitionLanguage: 'zh-en' | 'zh' | 'en' | 'auto';

  // 音频输入与常规偏好
  audioInputSource: 'mixed' | 'mic-only' | 'system-only';
  audioDeviceId: string;
  systemAudioDeviceId: string;
  micEnabled: boolean;
  systemAudioEnabled: boolean;
  enableWebrtcAec3: boolean;
  aec3PromptDismissed: boolean;
  enableDualChannelSpeakerSplit: boolean;
  globalHotwords: string[];
  desktopHotkeys: DesktopHotkeys;
  enableVadAutoPause: boolean;
  autoSaveSession: boolean;
  defaultExportFormat: 'markdown' | 'docx' | 'txt';
}

// WebSocket 实时事件消息定义（后端推送给前端）
export type ClassroomServerEvent =
  | {
      type: 'utterance.partial';
      payload: {
        speakerId: string;
        speakerLabel: string;
        text: string;
      };
    }
  | {
      type: 'utterance.final';
      payload: {
        segmentId: string;
        utterance: UtteranceItem;
      };
    }
  | {
      type: 'utterance.corrected';
      payload: {
        segmentId: string;
        utteranceId: string;
        refinedText: string;
      };
    }
  | {
      type: 'segments.regrouped';
      payload: {
        segments: KnowledgeSegment[];
      };
    }
  | {
      type: 'highlights.updated';
      payload: {
        segmentId: string;
        highlights: HighlightedTerm[];
      };
    }
  | {
      type: 'utterance.updated';
      payload: {
        segmentId: string;
        utterance: UtteranceItem;
      };
    }
  | {
      type: 'attachment.created';
      payload: {
        attachment: SessionAttachmentItem;
      };
    }
  | {
      type: 'attachment.deleted';
      payload: {
        attachmentId: string;
      };
    }
  | {
      type: 'session.duration';
      payload: {
        durationSeconds: number;
      };
    }
  | {
      type: 'error';
      payload: {
        code: string;
        message: string;
      };
    };

// WebSocket 客户端控制指令（前端发送给后端）
export type ClassroomClientCommand =
  | {
      type: 'recording.start';
      payload: {
        sampleRate: number;
        channels: number;
        encoding: 'pcm_s16le' | 'opus_webm';
      };
    }
  | { type: 'recording.pause' }
  | { type: 'recording.resume' }
  | { type: 'recording.stop' }
  | {
      type: 'channel.activity';
      payload: {
        micRms: number;
        sysRms: number;
        dualActive: boolean;
      };
    };
