import { create } from 'zustand';
import { OPENCODE_FREE_PROVIDER_ID } from '../constants/providers';
import { AddonDownloadCancelled, api, ApiRequestError, IS_MOCK_MODE } from '../services/api';
import { classroomSocket } from '../services/classroomSocket';
import { getDefaultDesktopHotkeys, getDesktopBridge } from '../utils/desktopBridge';
import type {
  Aec3AddonStatus,
  Aec3DownloadProgress,
  AppSettings,
  AudioImportProgress,
  ChatMessage,
  ClassSessionCard,
  ClassroomServerEvent,
  FlashcardItem,
  FolderItem,
  KnowledgeSegment,
  OpenCodeDownloadProgress,
  SearchHitItem,
  SegmentDetailedExplanation,
  SessionAttachmentItem,
  SessionExportRequest,
  SessionStudyNote,
  SpeakerProfile,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UtterancePatch,
} from '../types/domain';

export interface AppUpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'applying'
    | 'up-to-date'
    | 'error';
  popupVisible: boolean;
  dismissedVersion: string | null;
  info: UpdateCheckResult | null;
  progress: UpdateDownloadProgress | null;
  errorMessage: string | null;
  manualDownloadPath: string | null;
}

const IGNORED_UPDATE_VER_KEY = 'zhiling:ignored-update-version';

function readIgnoredUpdateVersion(): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(IGNORED_UPDATE_VER_KEY)
      : null;
  } catch {
    return null;
  }
}

function writeIgnoredUpdateVersion(ver: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (ver) {
      localStorage.setItem(IGNORED_UPDATE_VER_KEY, ver);
    } else {
      localStorage.removeItem(IGNORED_UPDATE_VER_KEY);
    }
  } catch {
    // ignore storage quota errors
  }
}

export interface AppNotice {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

type DownloadAddon = 'asr' | 'opencode';
const OPENCODE_CLI_REQUIRED = 'OPENCODE_CLI_REQUIRED';

export function deriveAudioInputSource(
  micEnabled: boolean,
  systemAudioEnabled: boolean,
  fallback: AppSettings['audioInputSource'] = 'mixed'
): AppSettings['audioInputSource'] {
  if (micEnabled && systemAudioEnabled) return 'mixed';
  if (micEnabled) return 'mic-only';
  if (systemAudioEnabled) return 'system-only';
  return fallback;
}

function normalizeSettings(raw: AppSettings): AppSettings {
  const source = raw.audioInputSource ?? 'mixed';
  const micEnabled =
    typeof raw.micEnabled === 'boolean' ? raw.micEnabled : source !== 'system-only';
  const systemAudioEnabled =
    typeof raw.systemAudioEnabled === 'boolean' ? raw.systemAudioEnabled : source !== 'mic-only';
  return {
    ...raw,
    audioDeviceId: raw.audioDeviceId || 'default',
    systemAudioDeviceId: raw.systemAudioDeviceId || 'default',
    micEnabled,
    systemAudioEnabled,
    audioInputSource: deriveAudioInputSource(micEnabled, systemAudioEnabled, source),
    enableWebrtcAec3: Boolean(raw.enableWebrtcAec3),
    aec3PromptDismissed: Boolean(raw.aec3PromptDismissed),
    enableDualChannelSpeakerSplit:
      typeof raw.enableDualChannelSpeakerSplit === 'boolean'
        ? raw.enableDualChannelSpeakerSplit
        : true,
    globalHotwords: Array.isArray(raw.globalHotwords) ? raw.globalHotwords : [],
    desktopHotkeys: (() => {
      const defaults = getDefaultDesktopHotkeys();
      return {
        enabled: raw.desktopHotkeys?.enabled ?? defaults.enabled,
        toggleRecording: raw.desktopHotkeys?.toggleRecording || defaults.toggleRecording,
        toggleMicMute: raw.desktopHotkeys?.toggleMicMute || defaults.toggleMicMute,
        captureScreenshot: raw.desktopHotkeys?.captureScreenshot || defaults.captureScreenshot,
        bookmarkConfused: raw.desktopHotkeys?.bookmarkConfused || defaults.bookmarkConfused,
        toggleMiniOverlay: raw.desktopHotkeys?.toggleMiniOverlay || defaults.toggleMiniOverlay,
      };
    })(),
  };
}

function hasAudioSettingsChanged(a: AppSettings, b: AppSettings): boolean {
  return (
    a.micEnabled !== b.micEnabled ||
    a.systemAudioEnabled !== b.systemAudioEnabled ||
    a.audioDeviceId !== b.audioDeviceId ||
    a.systemAudioDeviceId !== b.systemAudioDeviceId ||
    a.enableWebrtcAec3 !== b.enableWebrtcAec3 ||
    a.audioInputSource !== b.audioInputSource
  );
}

const FATAL_RECORDING_CODES: ReadonlySet<string> = new Set([
  'AUDIO_CAPTURE_FAILED',
  'AUDIO_CAPTURE_ENDED',
  'ASR_ADAPTER_UNIMPLEMENTED',
  'ASR_NOT_CONFIGURED',
  'ASR_MODEL_REQUIRED',
  'ASR_APP_ID_REQUIRED',
  'ASR_UNSUPPORTED_MODEL',
  'ASR_STREAM_FAILED',
  'ASR_STREAM_INTERRUPTED',
  'ASR_LOCAL_DECODE_FAILED',
  'ASR_DEPENDENCY_UNAVAILABLE',
  'ASR_ADDON_REQUIRED',
  'ASR_UPSTREAM_ERROR',
  'ASR_TIMEOUT',
  'ASR_UNREACHABLE',
  'ASR_REDIRECT',
  'ASR_BACKPRESSURE',
  'MISSING_API_KEY',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_AUTH_FAILED',
  'INVALID_PROVIDER_URL',
  'INVALID_PROVIDER_KEY',
  'STREAM_FAILED',
  'CLASSROOM_SOCKET_CLOSED',
]);

const EXTERNAL_CHANNEL_ALERT_CODES: ReadonlySet<string> = new Set([
  'MIC_SOURCE_ENDED',
  'SYS_SOURCE_ENDED',
  'WASAPI_SOCKET_CLOSED',
  'WASAPI_CAPTURE_FAILED',
  'MACOS_AUDIO_PERMISSION_REQUIRED',
  'MACOS_LOOPBACK_FAILED',
]);

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function notifyScreenTopAlert(title: string, message: string, canResume: boolean): void {
  const bridge = getDesktopBridge();
  if (bridge?.show_topmost_alert) {
    void bridge.show_topmost_alert(title, message, canResume).catch(() => undefined);
    return;
  }
  if (typeof window !== 'undefined' && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, { body: message });
      } catch {
        // ignore browser notification failures
      }
    }
  }
}

const LLM_STAGE_PREFIXES = ['句子修正：', '知识点分段：', '重点词提取：'] as const;

interface AppStoreState {
  // 视图路由状态
  activeView: 'home' | 'classroom';
  currentFolderId: string | null;
  settingsOpen: boolean;
  settingsDefaultTab: 'llm' | 'routing' | 'asr' | 'general';
  notice: AppNotice | null;

  // 主菜单列表数据
  folders: FolderItem[];
  sessions: ClassSessionCard[];
  isLoadingHome: boolean;

  // 当前进入的课堂工作区状态
  activeSession: ClassSessionCard | null;
  speakers: SpeakerProfile[];
  segments: KnowledgeSegment[];
  messages: ChatMessage[];
  studyNote: SessionStudyNote | null;
  flashcards: FlashcardItem[];
  attachments: SessionAttachmentItem[];
  hasAudio: boolean;
  audioDurationMs: number;
  livePartialUtterance: { speakerLabel: string; text: string } | null;
  isSendingChat: boolean;

  // 弹窗、原声回放、转写聚焦与提问预填状态
  notesExportModal: {
    open: boolean;
    sessionId: string | null;
    initialTab: 'notes' | 'flashcards' | 'export';
  };
  importAudioModalOpen: boolean;
  audioPlayback: {
    visible: boolean;
    seekRequestMs: number | null;
    requestSeq: number;
    currentMs: number;
    isPlaying: boolean;
  };
  transcriptFocusRequest: {
    segmentId?: string;
    utteranceId?: string;
    timestampMs?: number;
    seq: number;
  } | null;
  chatDraftPrefill: {
    text: string;
    attachments?: SessionAttachmentItem[];
    seq: number;
  } | null;
  onlyBookmarksFilter: boolean;
  windowMaximized: boolean;
  windowMotion: 'entering' | 'idle' | 'minimizing' | 'minimized-hidden' | 'closing';

  // 全局设置状态与 WebRTC AEC3 组件状态
  settings: AppSettings | null;
  addonDownload: { addon: DownloadAddon; stage: 'closed' | 'confirm' | 'downloading' };
  addonDownloadProgress: OpenCodeDownloadProgress | null;
  aec3Addon: Aec3AddonStatus | null;
  aec3Modal: {
    open: boolean;
    mode: 'dual-talk-start' | 'enable-setting';
  };
  aec3Downloading: boolean;
  aec3DownloadProgress: Aec3DownloadProgress | null;
  appUpdate: AppUpdateState;

  // Actions
  initialize: () => Promise<void>;
  setSettingsOpen: (open: boolean, tab?: 'llm' | 'routing' | 'asr' | 'general') => void;
  setCurrentFolderId: (folderId: string | null) => void;
  showNotice: (kind: 'info' | 'error', message: string) => void;
  clearNotice: () => void;

  ensureBuiltinAsrReady: () => Promise<boolean>;
  confirmAddonDownload: () => Promise<void>;
  closeAddonDownload: () => void;
  refreshAec3AddonStatus: () => Promise<Aec3AddonStatus>;
  requestToggleWebrtcAec3: (enabled: boolean) => Promise<void>;
  confirmDownloadAec3Modal: () => Promise<void>;
  skipAec3ModalAndProceed: () => Promise<void>;
  closeAec3Modal: () => void;

  setMicChannel: (patch: { enabled?: boolean; deviceId?: string }) => Promise<void>;
  setSystemChannel: (patch: {
    enabled?: boolean;
    deviceId?: string;
    forceRepick?: boolean;
  }) => Promise<void>;
  setAudioInputMode: (mode: AppSettings['audioInputSource']) => Promise<void>;

  createFolder: (name?: string) => Promise<FolderItem>;
  renameFolder: (id: string, name: string) => Promise<void>;
  updateFolderHotwords: (id: string, hotwords: string[]) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  startNewClassroom: () => Promise<void>;
  openClassroom: (sessionId: string) => Promise<void>;
  openSessionAtHit: (hit: SearchHitItem) => Promise<void>;
  leaveClassroom: () => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  moveSessionToFolder: (sessionId: string, folderId: string | null) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;

  toggleRecording: () => Promise<void>;
  tickRecordingDuration: () => void;
  renameSpeaker: (speakerId: string, label: string) => Promise<void>;
  fetchSegmentExplanation: (
    segmentId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onStageChange?: (stage: 'generating') => void;
    }
  ) => Promise<SegmentDetailedExplanation>;
  sendChatQuestion: (
    content: string,
    attachments?: SessionAttachmentItem[]
  ) => Promise<void>;

  openNotesExportModal: (
    sessionId?: string,
    initialTab?: 'notes' | 'flashcards' | 'export'
  ) => void;
  closeNotesExportModal: () => void;
  streamGenerateStudyNote: (
    sessionId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onContentDelta?: (delta: string) => void;
    }
  ) => Promise<SessionStudyNote>;
  generateSessionFlashcards: (sessionId: string) => Promise<FlashcardItem[]>;
  exportSessionDocument: (
    sessionId: string,
    req: SessionExportRequest
  ) => Promise<void>;

  seekAudioPlayback: (ms: number) => void;
  toggleAudioPlaybackBar: () => void;
  updateAudioPlaybackState: (patch: { currentMs?: number; isPlaying?: boolean }) => void;
  closeAudioPlayback: () => void;
  setOnlyBookmarksFilter: (val: boolean) => void;
  setWindowMaximized: (val: boolean) => void;
  setWindowMotion: (
    motion: 'entering' | 'idle' | 'minimizing' | 'minimized-hidden' | 'closing'
  ) => void;
  retranscribeSessionGap: () => Promise<void>;
  setImportAudioModalOpen: (open: boolean) => void;
  importAudioSession: (
    file: Blob,
    options: { fileName: string; title?: string },
    onProgress?: (progress: AudioImportProgress) => void
  ) => Promise<void>;

  updateUtterance: (utteranceId: string, patch: UtterancePatch) => Promise<void>;
  markConfusedNow: (note?: string) => Promise<void>;
  jumpToTranscript: (target: {
    segmentId?: string;
    utteranceId?: string;
    timestampMs?: number;
  }) => void;
  prefillChatComposer: (text: string, attachments?: SessionAttachmentItem[]) => void;

  uploadSessionAttachment: (
    file: Blob,
    options: {
      fileName: string;
      kind?: 'screenshot' | 'image' | 'material';
      segmentId?: string;
      timestampMs?: number;
      caption?: string;
    }
  ) => Promise<SessionAttachmentItem | null>;
  captureClassroomScreen: (caption?: string) => Promise<SessionAttachmentItem | null>;
  deleteSessionAttachment: (attachmentId: string) => Promise<void>;
  toggleMiniOverlayWindow: () => Promise<void>;

  updateSettings: (updater: (prev: AppSettings) => AppSettings) => Promise<void>;
  fetchModelsForLlmProvider: (providerId: string) => Promise<string[]>;
  fetchModelsForAsrProvider: (providerId: string) => Promise<string[]>;

  checkForAppUpdates: (options?: { silent?: boolean; force?: boolean }) => Promise<void>;
  startOneClickAppUpdate: () => Promise<void>;
  applyReadyAppUpdate: () => Promise<void>;
  dismissUpdatePopup: () => void;
  ignoreAvailableUpdateVersion: () => void;
}

export const useAppStore = create<AppStoreState>((set, get) => {
  let checkingBuiltinAsr = false;
  let pendingDownload: {
    addon: DownloadAddon;
    notifyBackendOnCancel: boolean;
    promise: Promise<boolean>;
    settle: (ready: boolean) => void;
  } | null = null;
  let pendingDualTalkContinuation: (() => Promise<void>) | null = null;

  const askToDownload = (
    addon: DownloadAddon,
    notifyBackendOnCancel = false
  ): Promise<boolean> => {
    if (pendingDownload) {
      if (pendingDownload.addon === addon) {
        if (notifyBackendOnCancel) {
          pendingDownload.notifyBackendOnCancel = true;
        }
        return pendingDownload.promise;
      }
      return pendingDownload.promise.then(() =>
        askToDownload(addon, notifyBackendOnCancel)
      );
    }
    let settle!: (ready: boolean) => void;
    const promise = new Promise<boolean>((resolve) => { settle = resolve; });
    pendingDownload = { addon, notifyBackendOnCancel, promise, settle };
    set({
      addonDownload: { addon, stage: 'confirm' },
      addonDownloadProgress: null,
    });
    void getDesktopBridge()?.focus_main_window?.().catch(() => undefined);
    return promise;
  };

  const finishDownloadPrompt = (ready: boolean) => {
    const pending = pendingDownload;
    pendingDownload = null;
    set((state) => ({
      addonDownload: { ...state.addonDownload, stage: 'closed' },
      addonDownloadProgress: null,
    }));
    pending?.settle(ready);
  };

  const withOpenCodeDownload = async <T,>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.code !== OPENCODE_CLI_REQUIRED) throw err;
      if (!(await askToDownload('opencode'))) throw new AddonDownloadCancelled();
      return request();
    }
  };

  const showNotice = (kind: 'info' | 'error', message: string) => {
    set({ notice: { id: Date.now(), kind, message } });
  };

  const guardFirstDualTalk = async (
    willBeDualTalk: boolean,
    continuation: () => Promise<void>
  ): Promise<void> => {
    const { settings, aec3Addon } = get();
    if (willBeDualTalk && settings && !aec3Addon?.installed && !settings.aec3PromptDismissed) {
      try {
        const fresh = await api.getAec3AddonStatus();
        set({ aec3Addon: fresh });
        if (fresh.installed) {
          if (!settings.enableWebrtcAec3) {
            await get().updateSettings((prev) => ({ ...prev, enableWebrtcAec3: true }));
          }
          await continuation();
          return;
        }
      } catch {
        // Proceed to show download prompt if status check failed or uninstalled
      }
      pendingDualTalkContinuation = continuation;
      set({ aec3Modal: { open: true, mode: 'dual-talk-start' } });
      return;
    }
    await continuation();
  };

  const handleServerEvent = (event: ClassroomServerEvent) => {
    switch (event.type) {
      case 'utterance.partial':
        set({
          livePartialUtterance: {
            speakerLabel: event.payload.speakerLabel,
            text: event.payload.text,
          },
        });
        break;

      case 'utterance.final':
        set((state) => {
          const exists = state.segments.some((s) => s.id === event.payload.segmentId);
          const nextSegments: KnowledgeSegment[] = exists
            ? state.segments.map((seg) =>
                seg.id === event.payload.segmentId
                  ? {
                      ...seg,
                      utterances: [...seg.utterances, event.payload.utterance],
                      detailedExplanation: undefined,
                    }
                  : seg
              )
            : [
                ...state.segments,
                {
                  id: event.payload.segmentId,
                  sessionId: state.activeSession?.id ?? '',
                  orderIndex: state.segments.length + 1,
                  topicTitle: '课堂转写',
                  utterances: [event.payload.utterance],
                  highlights: [],
                },
              ];

          return {
            livePartialUtterance: null,
            segments: nextSegments,
            hasAudio: state.settings?.autoSaveSession ? true : state.hasAudio,
          };
        });
        break;

      case 'utterance.updated':
        set((state) => ({
          segments: state.segments.map((seg) =>
            seg.id === event.payload.segmentId
              ? {
                  ...seg,
                  utterances: seg.utterances.map((u) =>
                    u.id === event.payload.utterance.id ? event.payload.utterance : u
                  ),
                }
              : seg
          ),
        }));
        break;

      case 'attachment.created':
        set((state) => {
          const exists = state.attachments.some((a) => a.id === event.payload.attachment.id);
          return exists
            ? {}
            : { attachments: [...state.attachments, event.payload.attachment] };
        });
        break;

      case 'attachment.deleted':
        set((state) => ({
          attachments: state.attachments.filter((a) => a.id !== event.payload.attachmentId),
        }));
        break;

      case 'utterance.corrected':
        set((state) => ({
          segments: state.segments.map((seg) =>
            seg.id === event.payload.segmentId
              ? {
                  ...seg,
                  utterances: seg.utterances.map((u) =>
                    u.id === event.payload.utteranceId
                      ? { ...u, refinedText: event.payload.refinedText, isRefined: true }
                      : u
                  ),
                }
              : seg
          ),
        }));
        break;

      case 'segments.regrouped':
        set({ segments: event.payload.segments });
        break;

      case 'highlights.updated':
        set((state) => ({
          segments: state.segments.map((seg) =>
            seg.id === event.payload.segmentId
              ? { ...seg, highlights: event.payload.highlights }
              : seg
          ),
        }));
        break;

      case 'session.duration':
        set((state) =>
          state.activeSession
            ? {
                activeSession: {
                  ...state.activeSession,
                  durationSeconds: Math.max(
                    state.activeSession.durationSeconds,
                    event.payload.durationSeconds
                  ),
                },
              }
            : {}
        );
        break;

      case 'error': {
        if (event.payload.code === OPENCODE_CLI_REQUIRED) {
          void askToDownload('opencode', true);
          break;
        }
        showNotice('error', event.payload.message);
        const isLlmStageWarning = LLM_STAGE_PREFIXES.some((prefix) =>
          event.payload.message.startsWith(prefix)
        );
        if (!isLlmStageWarning && FATAL_RECORDING_CODES.has(event.payload.code)) {
          const current = get().activeSession;
          if (current && current.status === 'recording') {
            classroomSocket.sendCommand({ type: 'recording.pause' });
            set((state) => ({
              livePartialUtterance: null,
              activeSession: state.activeSession
                ? { ...state.activeSession, status: 'paused' }
                : null,
              sessions: state.sessions.map((s) =>
                s.id === current.id ? { ...s, status: 'paused' } : s
              ),
            }));
            void api
              .updateSession(current.id, {
                status: 'paused',
                durationSeconds: current.durationSeconds,
              })
              .catch(() => {});
            // 外力导致录音意外暂停时，在 Windows 与 macOS 屏幕最顶层弹出不抢焦点警示浮窗
            notifyScreenTopAlert(
              '知聆课堂 · 录音已意外暂停',
              event.payload.message,
              true
            );
          }
        } else if (
          !isLlmStageWarning &&
          EXTERNAL_CHANNEL_ALERT_CODES.has(event.payload.code) &&
          get().activeSession?.status === 'recording'
        ) {
          notifyScreenTopAlert(
            '知聆课堂 · 音频输入源发生中断',
            event.payload.message,
            false
          );
        }
        break;
      }

      default:
        break;
    }
  };

  return {
    activeView: 'home',
    currentFolderId: null,
    settingsOpen: false,
    settingsDefaultTab: 'llm',
    notice: null,

    folders: [],
    sessions: [],
    isLoadingHome: true,

    activeSession: null,
    speakers: [],
    segments: [],
    messages: [],
    studyNote: null,
    flashcards: [],
    attachments: [],
    hasAudio: false,
    audioDurationMs: 0,
    livePartialUtterance: null,
    isSendingChat: false,

    notesExportModal: { open: false, sessionId: null, initialTab: 'notes' },
    importAudioModalOpen: false,
    audioPlayback: {
      visible: false,
      seekRequestMs: null,
      requestSeq: 0,
      currentMs: 0,
      isPlaying: false,
    },
    transcriptFocusRequest: null,
    chatDraftPrefill: null,
    onlyBookmarksFilter: false,
    windowMaximized: false,
    windowMotion: 'entering',

    settings: null,
    aec3Addon: null,
    addonDownload: { addon: 'asr', stage: 'closed' },
    addonDownloadProgress: null,
    aec3Modal: { open: false, mode: 'enable-setting' },
    aec3Downloading: false,
    aec3DownloadProgress: null,
    appUpdate: {
      status: 'idle',
      popupVisible: false,
      dismissedVersion: readIgnoredUpdateVersion(),
      info: null,
      progress: null,
      errorMessage: null,
      manualDownloadPath: null,
    },

    initialize: async () => {
      set({ isLoadingHome: true });
      try {
        const [folders, sessions, rawSettings, aec3Addon] = await Promise.all([
          api.listFolders(),
          api.listSessions(),
          api.getSettings(),
          api
            .getAec3AddonStatus()
            .catch((): Aec3AddonStatus => ({ installed: false, version: '0.3.0', sizeBytes: 309218 })),
        ]);
        const settings = normalizeSettings(rawSettings);
        set({ folders, sessions, settings, aec3Addon, isLoadingHome: false });
      } catch (err) {
        set({ isLoadingHome: false });
        showNotice(
          'error',
          err instanceof Error
            ? `连接后端服务失败：${err.message}`
            : '连接后端服务失败，请确认后端已启动'
        );
      }
    },

    setSettingsOpen: (open, tab) =>
      set((state) => ({
        settingsOpen: open,
        settingsDefaultTab: tab ?? (open ? 'llm' : state.settingsDefaultTab),
      })),
    setCurrentFolderId: (folderId) => set({ currentFolderId: folderId }),
    showNotice,
    clearNotice: () => set({ notice: null }),

    refreshAec3AddonStatus: async () => {
      const status = await api.getAec3AddonStatus();
      set({ aec3Addon: status });
      return status;
    },

    requestToggleWebrtcAec3: async (enabled) => {
      if (!enabled) {
        await get().updateSettings((prev) => ({
          ...prev,
          enableWebrtcAec3: false,
        }));
        return;
      }
      let installed = Boolean(get().aec3Addon?.installed);
      if (!installed) {
        try {
          const fresh = await get().refreshAec3AddonStatus();
          installed = fresh.installed;
        } catch {
          installed = false;
        }
      }
      if (installed) {
        await get().updateSettings((prev) => ({
          ...prev,
          enableWebrtcAec3: true,
        }));
      } else {
        pendingDualTalkContinuation = null;
        set({ aec3Modal: { open: true, mode: 'enable-setting' } });
      }
    },

    ensureBuiltinAsrReady: async () => {
      const { settings } = get();
      const provider = settings?.asrProviders[settings.selectedAsrProviderId];
      if (IS_MOCK_MODE || provider?.protocol !== 'builtin-free-asr') return true;
      if (checkingBuiltinAsr) return false;
      checkingBuiltinAsr = true;
      try {
        if (await api.getBuiltinAsrReady()) return true;
        return await askToDownload('asr');
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '无法检查默认语音组件，请重试');
        return false;
      } finally {
        checkingBuiltinAsr = false;
      }
    },

    confirmAddonDownload: async () => {
      const { addon, stage } = get().addonDownload;
      if (stage !== 'confirm') return;
      set({
        addonDownload: { addon, stage: 'downloading' },
        addonDownloadProgress: null,
      });
      try {
        if (addon === 'opencode') {
          await api.streamDownloadOpenCode((progress) => {
            set({ addonDownloadProgress: progress });
          });
        } else {
          await api.streamDownloadBuiltinAsr((progress) => {
            set({ addonDownloadProgress: progress });
          });
        }
        finishDownloadPrompt(true);
      } catch (err) {
        set({
          addonDownload: { addon, stage: 'confirm' },
          addonDownloadProgress: null,
        });
        showNotice(
          'error',
          err instanceof Error
            ? err.message
            : addon === 'opencode'
              ? '组件下载失败，请重试'
              : '本地语音模型下载失败，请重试'
        );
      }
    },

    closeAddonDownload: () => {
      const { addon, stage } = get().addonDownload;
      if (stage !== 'confirm') return;
      const shouldNotifyBackend = Boolean(
        addon === 'opencode' && pendingDownload?.notifyBackendOnCancel
      );
      if (shouldNotifyBackend) {
        void api.decideOpenCodeDownload(false).catch(() => undefined);
      }
      finishDownloadPrompt(false);
    },

    confirmDownloadAec3Modal: async () => {
      if (get().aec3Downloading) return;
      set({
        aec3Downloading: true,
        aec3DownloadProgress: {
          stage: 'connecting',
          downloadedBytes: 0,
          totalBytes: 309218,
          percent: 2,
        },
      });
      try {
        const status = await api.streamDownloadAec3Addon((progress) => {
          set({ aec3DownloadProgress: progress });
        });
        const continuation = pendingDualTalkContinuation;
        pendingDualTalkContinuation = null;
        set({
          aec3Addon: status,
          aec3Downloading: false,
          aec3DownloadProgress: null,
          aec3Modal: { open: false, mode: 'enable-setting' },
        });
        await get().updateSettings((prev) => ({
          ...prev,
          enableWebrtcAec3: true,
          aec3PromptDismissed: true,
        }));
        showNotice('info', 'WebRTC AEC3 回声消除组件已下载并启用');
        if (continuation) {
          await continuation();
        }
      } catch (err) {
        set({ aec3Downloading: false, aec3DownloadProgress: null });
        showNotice(
          'error',
          err instanceof Error ? err.message : '下载 WebRTC AEC3 组件失败'
        );
      }
    },

    skipAec3ModalAndProceed: async () => {
      if (get().aec3Downloading) return;
      const continuation = pendingDualTalkContinuation;
      pendingDualTalkContinuation = null;
      set({
        aec3Modal: { open: false, mode: 'enable-setting' },
        aec3DownloadProgress: null,
      });
      await get().updateSettings((prev) => ({
        ...prev,
        enableWebrtcAec3: false,
        aec3PromptDismissed: true,
      }));
      if (continuation) {
        await continuation();
      }
    },

    closeAec3Modal: () => {
      if (get().aec3Downloading) return;
      pendingDualTalkContinuation = null;
      set({
        aec3Modal: { open: false, mode: 'enable-setting' },
        aec3DownloadProgress: null,
      });
    },

    setMicChannel: async (patch) => {
      const current = get().settings;
      if (!current) return;
      const nextEnabled = patch.enabled ?? current.micEnabled;
      const nextDeviceId = patch.deviceId ?? current.audioDeviceId;
      const enteringDualTalk =
        !current.micEnabled && nextEnabled && current.systemAudioEnabled;

      await guardFirstDualTalk(enteringDualTalk, async () => {
        await get().updateSettings((prev) => ({
          ...prev,
          micEnabled: nextEnabled,
          audioDeviceId: nextDeviceId,
          audioInputSource: deriveAudioInputSource(
            nextEnabled,
            prev.systemAudioEnabled,
            prev.audioInputSource
          ),
        }));
      });
    },

    setSystemChannel: async (patch) => {
      const current = get().settings;
      if (!current) return;
      const nextEnabled = patch.enabled ?? current.systemAudioEnabled;
      const nextDeviceId = patch.deviceId ?? current.systemAudioDeviceId;
      const enteringDualTalk =
        !current.systemAudioEnabled && nextEnabled && current.micEnabled;

      await guardFirstDualTalk(enteringDualTalk, async () => {
        await get().updateSettings((prev) => ({
          ...prev,
          systemAudioEnabled: nextEnabled,
          systemAudioDeviceId: nextDeviceId,
          audioInputSource: deriveAudioInputSource(
            prev.micEnabled,
            nextEnabled,
            prev.audioInputSource
          ),
        }));
        const latest = get().settings;
        if (patch.forceRepick && latest) {
          await classroomSocket.applyAudioSettings(latest, { forceRepickSystem: true });
        }
      });
    },

    setAudioInputMode: async (mode) => {
      const current = get().settings;
      if (!current) return;
      const enteringDualTalk =
        mode === 'mixed' && !(current.micEnabled && current.systemAudioEnabled);

      await guardFirstDualTalk(enteringDualTalk, async () => {
        await get().updateSettings((prev) => ({
          ...prev,
          audioInputSource: mode,
          micEnabled: mode !== 'system-only',
          systemAudioEnabled: mode !== 'mic-only',
        }));
      });
    },

    createFolder: async (name = '新建文件夹') => {
      const folder = await api.createFolder(name, get().currentFolderId);
      set((state) => ({ folders: [folder, ...state.folders] }));
      return folder;
    },

    renameFolder: async (id, name) => {
      const updated = await api.updateFolder(id, { name });
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? updated : f)),
      }));
    },

    updateFolderHotwords: async (id, hotwords) => {
      const updated = await api.updateFolder(id, { hotwords });
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? updated : f)),
      }));
      showNotice(
        'info',
        `已保存「${updated.name}」的 ${updated.hotwords?.length ?? 0} 个学科热词`
      );
    },

    deleteFolder: async (id) => {
      await api.deleteFolder(id);
      set((state) => ({
        folders: state.folders.filter((f) => f.id !== id),
        sessions: state.sessions.map((s) =>
          s.folderId === id ? { ...s, folderId: null } : s
        ),
        currentFolderId: state.currentFolderId === id ? null : state.currentFolderId,
      }));
    },

    startNewClassroom: async () => {
      if (!(await get().ensureBuiltinAsrReady())) return;
      const settings = get().settings;
      const isDualTalk = Boolean(settings ? settings.micEnabled && settings.systemAudioEnabled : true);
      await guardFirstDualTalk(isDualTalk, async () => {
        try {
          const payload = await api.createSession(get().currentFolderId);
          classroomSocket.connect(payload.session.id, handleServerEvent);
          classroomSocket.sendCommand({
            type: 'recording.start',
            payload: { sampleRate: 16000, channels: 1, encoding: 'pcm_s16le' },
          });
          set((state) => ({
            sessions: [payload.session, ...state.sessions],
            activeSession: payload.session,
            speakers: payload.speakers,
            segments: payload.segments,
            messages: payload.messages,
            studyNote: payload.studyNote ?? null,
            flashcards: payload.flashcards ?? [],
            attachments: payload.attachments ?? [],
            hasAudio: Boolean(payload.hasAudio),
            audioDurationMs: payload.audioDurationMs ?? 0,
            audioPlayback: {
              visible: false,
              seekRequestMs: null,
              requestSeq: 0,
              currentMs: 0,
              isPlaying: false,
            },
            livePartialUtterance: null,
            onlyBookmarksFilter: false,
            activeView: 'classroom',
          }));
        } catch (err) {
          showNotice('error', err instanceof Error ? err.message : '开启新课堂失败');
        }
      });
    },

    openClassroom: async (sessionId) => {
      try {
        const payload = await api.getSessionWorkspace(sessionId);
        // 打开历史课堂默认进入暂停就绪态，用户点击顶部麦克风图标后继续录音
        const normalizedSession: ClassSessionCard =
          payload.session.status === 'recording'
            ? { ...payload.session, status: 'paused' }
            : payload.session;
        classroomSocket.connect(sessionId, handleServerEvent);
        set({
          activeSession: normalizedSession,
          speakers: payload.speakers,
          segments: payload.segments,
          messages: payload.messages,
          studyNote: payload.studyNote ?? null,
          flashcards: payload.flashcards ?? [],
          attachments: payload.attachments ?? [],
          hasAudio: Boolean(payload.hasAudio),
          audioDurationMs: payload.audioDurationMs ?? 0,
          audioPlayback: {
            visible: false,
            seekRequestMs: null,
            requestSeq: 0,
            currentMs: 0,
            isPlaying: false,
          },
          livePartialUtterance: null,
          onlyBookmarksFilter: false,
          activeView: 'classroom',
        });
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '加载课堂内容失败');
      }
    },

    openSessionAtHit: async (hit) => {
      await get().openClassroom(hit.sessionId);
      if (hit.segmentId || hit.utteranceId || hit.timestampMs !== undefined) {
        window.setTimeout(() => {
          get().jumpToTranscript({
            segmentId: hit.segmentId,
            utteranceId: hit.utteranceId,
            timestampMs: hit.timestampMs,
          });
        }, 120);
      }
    },

    leaveClassroom: async () => {
      const current = get().activeSession;
      if (current) {
        classroomSocket.sendCommand({ type: 'recording.stop' });
        classroomSocket.disconnect();
        try {
          const [saved, freshList] = await Promise.all([
            api.updateSession(current.id, {
              status: 'paused',
              durationSeconds: current.durationSeconds,
              title: current.title,
            }),
            api.listSessions(),
          ]);
          set({
            sessions: freshList.map((s) => (s.id === saved.id ? saved : s)),
            activeSession: null,
            studyNote: null,
            flashcards: [],
            attachments: [],
            audioPlayback: {
              visible: false,
              seekRequestMs: null,
              requestSeq: 0,
              currentMs: 0,
              isPlaying: false,
            },
            livePartialUtterance: null,
            activeView: 'home',
          });
        } catch {
          set({
            activeSession: null,
            studyNote: null,
            flashcards: [],
            attachments: [],
            livePartialUtterance: null,
            activeView: 'home',
          });
        }
      } else {
        set({ activeView: 'home' });
      }
    },

    renameSession: async (id, title) => {
      const updated = await api.updateSession(id, { title });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === id ? updated : s)),
        activeSession:
          state.activeSession?.id === id ? updated : state.activeSession,
      }));
    },

    moveSessionToFolder: async (sessionId, folderId) => {
      const updated = await api.updateSession(sessionId, { folderId });
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === sessionId ? updated : s)),
      }));
    },

    deleteSession: async (id) => {
      try {
        await api.deleteSession(id);
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
        }));
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '删除课堂失败');
      }
    },

    toggleRecording: async () => {
      const current = get().activeSession;
      if (!current) return;
      const nextStatus = current.status === 'recording' ? 'paused' : 'recording';

      if (nextStatus === 'recording') {
        const cfg = get().settings;
        if (cfg && !cfg.micEnabled && !cfg.systemAudioEnabled) {
          showNotice('error', '麦克风与系统内录均已禁用，请先点击顶部音频源图标开启至少一路输入');
          return;
        }
        if (!(await get().ensureBuiltinAsrReady())) return;
      }

      const executeToggle = async () => {
        const latestSession = get().activeSession;
        if (latestSession?.id !== current.id || latestSession.status !== current.status) return;
        classroomSocket.sendCommand({ type: nextStatus === 'recording' ? 'recording.resume' : 'recording.pause' });
        const updated = await api.updateSession(latestSession.id, {
          status: nextStatus,
          durationSeconds: latestSession.durationSeconds,
        });
        set((state) => ({
          activeSession: updated,
          livePartialUtterance: nextStatus === 'paused' ? null : state.livePartialUtterance,
          sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s)),
        }));
      };

      if (nextStatus === 'recording') {
        const cfg = get().settings;
        const isDualTalk = Boolean(cfg ? cfg.micEnabled && cfg.systemAudioEnabled : false);
        await guardFirstDualTalk(isDualTalk, executeToggle);
      } else {
        await executeToggle();
      }
    },

    tickRecordingDuration: () => {
      set((state) => {
        if (!state.activeSession || state.activeSession.status !== 'recording') {
          return {};
        }
        const nextDuration = state.activeSession.durationSeconds + 1;
        return {
          activeSession: {
            ...state.activeSession,
            durationSeconds: nextDuration,
          },
        };
      });
    },

    renameSpeaker: async (speakerId, label) => {
      const session = get().activeSession;
      if (!session) return;
      await api.renameSpeaker(session.id, speakerId, label);
      const trimmed = label.trim();
      if (!trimmed) return;
      set((state) => ({
        speakers: state.speakers.map((spk) =>
          spk.id === speakerId ? { ...spk, label: trimmed } : spk
        ),
        segments: state.segments.map((seg) => ({
          ...seg,
          utterances: seg.utterances.map((u) =>
            u.speakerId === speakerId ? { ...u, speakerLabel: trimmed } : u
          ),
        })),
      }));
    },

    fetchSegmentExplanation: async (segmentId, callbacks) => {
      const session = get().activeSession;
      if (!session) throw new Error('无活动课堂');
      const startedAt = performance.now();
      let thinkingFinishedAt: number | null = null;
      const detail = await withOpenCodeDownload(() => api.streamExplainSegment(session.id, segmentId, {
        onThinkingDelta: (delta) => {
          callbacks?.onThinkingDelta?.(delta);
        },
        onStageChange: (stage) => {
          if (thinkingFinishedAt === null) {
            thinkingFinishedAt = performance.now();
          }
          callbacks?.onStageChange?.(stage);
        },
      }));
      const enrichedDetail: SegmentDetailedExplanation = detail.thinking
        ? {
            ...detail,
            thinkingSeconds: Math.max(
              1,
              Math.round(((thinkingFinishedAt ?? performance.now()) - startedAt) / 1000)
            ),
          }
        : detail;
      set((state) => {
        if (state.activeSession?.id !== session.id) return {};
        return {
          segments: state.segments.map((seg) =>
            seg.id === segmentId ? { ...seg, detailedExplanation: enrichedDetail } : seg
          ),
        };
      });
      return enrichedDetail;
    },

    sendChatQuestion: async (content, attachments) => {
      const session = get().activeSession;
      const trimmed = content.trim();
      if (!session || !trimmed || get().isSendingChat) return;

      const nowIso = new Date().toISOString();
      const startedAt = performance.now();
      let thinkingFinishedAt: number | null = null;
      const tempUserId = `temp-user-${Date.now()}`;
      const tempAiId = `temp-ai-${Date.now()}`;
      const attachmentIds = attachments?.map((a) => a.id);
      const optimisticUserMsg: ChatMessage = {
        id: tempUserId,
        clientKey: tempUserId,
        sessionId: session.id,
        role: 'user',
        content: trimmed,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        createdAt: nowIso,
      };
      const streamingAiMsg: ChatMessage = {
        id: tempAiId,
        clientKey: tempAiId,
        sessionId: session.id,
        role: 'assistant',
        content: '',
        thinking: '',
        isStreaming: true,
        isThinking: true,
        createdAt: nowIso,
      };

      set((state) => ({
        messages: [...state.messages, optimisticUserMsg, streamingAiMsg],
        isSendingChat: true,
      }));

      let streamedThinking = '';

      try {
        const aiReply = await withOpenCodeDownload(() => api.streamChatMessage(session.id, trimmed, {
          attachmentIds,
          onThinkingDelta: (delta) => {
            streamedThinking += delta;
            set((state) => {
              if (state.activeSession?.id !== session.id) return {};
              return {
                messages: state.messages.map((m) =>
                  m.id === tempAiId
                    ? {
                        ...m,
                        thinking: (m.thinking ?? '') + delta,
                        isThinking: true,
                      }
                    : m
                ),
              };
            });
          },
          onContentDelta: (delta) => {
            let computedThinkingSec: number | undefined;
            if (thinkingFinishedAt === null) {
              thinkingFinishedAt = performance.now();
              computedThinkingSec = Math.max(
                1,
                Math.round((thinkingFinishedAt - startedAt) / 1000)
              );
            }
            set((state) => {
              if (state.activeSession?.id !== session.id) return {};
              return {
                messages: state.messages.map((m) =>
                  m.id === tempAiId
                    ? {
                        ...m,
                        content: m.content + delta,
                        isThinking: false,
                        thinkingSeconds: computedThinkingSec ?? m.thinkingSeconds,
                      }
                    : m
                ),
              };
            });
          },
        }));

        const finalThinking = aiReply.thinking ?? (streamedThinking.trim() || undefined);
        const finalThinkingSec = finalThinking
          ? Math.max(
              1,
              Math.round(((thinkingFinishedAt ?? performance.now()) - startedAt) / 1000)
            )
          : undefined;

        set((state) => {
          if (state.activeSession?.id !== session.id) {
            return { isSendingChat: false };
          }
          const finalReply: ChatMessage = {
            ...aiReply,
            clientKey: tempAiId,
            thinking: finalThinking,
            thinkingSeconds: finalThinkingSec,
            isStreaming: false,
            isThinking: false,
          };
          return {
            messages: state.messages.map((m) => (m.id === tempAiId ? finalReply : m)),
            isSendingChat: false,
          };
        });
      } catch (err) {
        set((state) => ({
          messages: state.messages.filter(
            (m) => m.id !== tempUserId && m.id !== tempAiId
          ),
          isSendingChat: false,
        }));
        if (!(err instanceof AddonDownloadCancelled)) {
          showNotice('error', err instanceof Error ? err.message : '问答请求失败');
        }
        throw err;
      }
    },

    updateSettings: async (updater) => {
      const prev = get().settings;
      if (!prev) return;
      const next = normalizeSettings(updater(prev));
      set({ settings: next });
      if (hasAudioSettingsChanged(prev, next)) {
        void classroomSocket.applyAudioSettings(next);
      }
      try {
        await api.updateSettings(next);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '保存设置失败');
      }
    },

    fetchModelsForLlmProvider: async (providerId) => {
      const settings = get().settings;
      const cfg = settings?.llmProviders[providerId];
      if (!settings || !cfg) return [];
      try {
        const models = await withOpenCodeDownload(() => api.fetchProviderModels({
          providerId,
          protocol: cfg.protocol,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
        }));
        if (providerId === OPENCODE_FREE_PROVIDER_ID) {
          set((state) => {
            if (!state.settings) return state;
            const current = state.settings;
            const routing = { ...current.featureRouting };
            for (const key of Object.keys(routing) as Array<keyof typeof routing>) {
              const binding = routing[key];
              if (binding.providerId === providerId && !models.includes(binding.modelId)) {
                routing[key] = { ...binding, modelId: '' };
              }
            }
            return {
              settings: {
                ...current,
                featureRouting: routing,
                llmProviders: {
                  ...current.llmProviders,
                  [providerId]: {
                    ...current.llmProviders[providerId],
                    availableModels: models,
                    lastFetchedAt: new Date().toISOString(),
                  },
                },
              },
            };
          });
          showNotice('info', `已获取 ${models.length} 个 OpenCode 免费模型`);
          return models;
        }
        await get().updateSettings((prev) => {
          const firstModel = models[0] ?? '';
          const nextRouting = { ...prev.featureRouting };
          if (firstModel) {
            for (const key of Object.keys(nextRouting) as Array<keyof typeof nextRouting>) {
              const binding = nextRouting[key];
              const assignedProvider = prev.llmProviders[binding.providerId];
              const assignedUnconfigured =
                binding.providerId !== OPENCODE_FREE_PROVIDER_ID &&
                !binding.modelId &&
                !assignedProvider?.apiKey.trim() &&
                (assignedProvider?.availableModels.length ?? 0) === 0;
              if (binding.providerId === providerId) {
                if (!binding.modelId || !models.includes(binding.modelId)) {
                  nextRouting[key] = { ...binding, modelId: firstModel };
                }
              } else if (assignedUnconfigured) {
                nextRouting[key] = {
                  ...binding,
                  providerId,
                  modelId: firstModel,
                };
              }
            }
          }
          return {
            ...prev,
            llmProviders: {
              ...prev.llmProviders,
              [providerId]: {
                ...prev.llmProviders[providerId],
                availableModels: models,
                lastFetchedAt: new Date().toISOString(),
              },
            },
            featureRouting: nextRouting,
          };
        });
        showNotice('info', `已成功获取 ${models.length} 个可用模型`);
        return models;
      } catch (err) {
        if (!(err instanceof AddonDownloadCancelled)) {
          showNotice('error', err instanceof Error ? err.message : '拉取模型列表失败');
        }
        return [];
      }
    },

    fetchModelsForAsrProvider: async (providerId) => {
      const settings = get().settings;
      const cfg = settings?.asrProviders[providerId];
      if (!settings || !cfg) return [];
      try {
        const models = await api.fetchAsrModels({
          providerId,
          protocol: cfg.protocol,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          appId: cfg.appId,
        });
        await get().updateSettings((prev) => ({
          ...prev,
          asrProviders: {
            ...prev.asrProviders,
            [providerId]: {
              ...prev.asrProviders[providerId],
              availableModels: models,
              selectedModelId: models.includes(
                prev.asrProviders[providerId].selectedModelId
              )
                ? prev.asrProviders[providerId].selectedModelId
                : models[0] ?? '',
            },
          },
        }));
        showNotice('info', `已刷新 ${models.length} 个语音识别模型`);
        return models;
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '拉取语音模型失败');
        return [];
      }
    },

    openNotesExportModal: (sessionId, initialTab = 'notes') => {
      const resolvedId = sessionId ?? get().activeSession?.id ?? null;
      if (!resolvedId) return;
      set({
        notesExportModal: {
          open: true,
          sessionId: resolvedId,
          initialTab,
        },
      });
    },

    closeNotesExportModal: () => {
      set((state) => ({
        notesExportModal: { ...state.notesExportModal, open: false },
      }));
    },

    streamGenerateStudyNote: async (sessionId, callbacks) => {
      const note = await withOpenCodeDownload(() => api.streamSessionNotes(sessionId, callbacks));
      if (get().activeSession?.id === sessionId) {
        set({ studyNote: note });
      }
      return note;
    },

    generateSessionFlashcards: async (sessionId) => {
      const cards = await withOpenCodeDownload(() => api.generateFlashcards(sessionId));
      if (get().activeSession?.id === sessionId) {
        set({ flashcards: cards });
      }
      return cards;
    },

    exportSessionDocument: async (sessionId, req) => {
      const title =
        get().sessions.find((s) => s.id === sessionId)?.title ??
        get().activeSession?.title ??
        '课堂笔记';
      try {
        const { blob, filename } = await api.exportSessionDocument(sessionId, req, title);
        const bridge = getDesktopBridge();
        if (bridge?.save_exported_file) {
          const b64 = await blobToBase64(blob);
          const savedPath = await bridge.save_exported_file(filename, b64);
          if (savedPath === '') {
            // 用户在原生保存面板点击取消
            return;
          }
          if (savedPath) {
            showNotice('info', `已成功导出 ${filename}`);
            return;
          }
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 4000);
        showNotice('info', `已成功导出 ${filename}`);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '导出文档失败');
        throw err;
      }
    },

    seekAudioPlayback: (ms) => {
      set((state) => ({
        audioPlayback: {
          ...state.audioPlayback,
          visible: true,
          seekRequestMs: Math.max(0, ms),
          requestSeq: state.audioPlayback.requestSeq + 1,
          currentMs: Math.max(0, ms),
          isPlaying: true,
        },
      }));
    },

    toggleAudioPlaybackBar: () => {
      set((state) => ({
        audioPlayback: {
          ...state.audioPlayback,
          visible: !state.audioPlayback.visible,
          isPlaying: state.audioPlayback.visible ? false : state.audioPlayback.isPlaying,
        },
      }));
    },

    setOnlyBookmarksFilter: (val) => set({ onlyBookmarksFilter: val }),

    setWindowMaximized: (val) => set({ windowMaximized: val }),

    setWindowMotion: (motion) => set({ windowMotion: motion }),

    updateAudioPlaybackState: (patch) => {
      set((state) => ({
        audioPlayback: {
          ...state.audioPlayback,
          ...(patch.currentMs !== undefined ? { currentMs: patch.currentMs } : {}),
          ...(patch.isPlaying !== undefined ? { isPlaying: patch.isPlaying } : {}),
        },
      }));
    },

    closeAudioPlayback: () => {
      set((state) => ({
        audioPlayback: {
          ...state.audioPlayback,
          visible: false,
          isPlaying: false,
        },
      }));
    },

    retranscribeSessionGap: async () => {
      const session = get().activeSession;
      if (!session) return;
      try {
        let res;
        try {
          res = await api.retranscribeGap(session.id);
        } catch (err) {
          if (!(err instanceof ApiRequestError) || err.code !== 'ASR_ADDON_REQUIRED') throw err;
          if (!(await get().ensureBuiltinAsrReady()) || get().activeSession?.id !== session.id) return;
          res = await api.retranscribeGap(session.id);
        }
        if (res.recoveredCount > 0) {
          const freshWs = await api.getSessionWorkspace(session.id);
          set({
            segments: freshWs.segments,
            speakers: freshWs.speakers,
            hasAudio: Boolean(freshWs.hasAudio),
            audioDurationMs: freshWs.audioDurationMs ?? 0,
          });
          showNotice('info', `已从本地原声补转写 ${res.recoveredCount} 条缺失语句`);
        } else {
          showNotice('info', '本地录音与当前转写已完整对齐，无需补转写');
        }
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '补转写处理失败');
      }
    },

    setImportAudioModalOpen: (open) => set({ importAudioModalOpen: open }),

    importAudioSession: async (file, options, onProgress) => {
      const payload = await api.streamImportAudio(
        file,
        {
          fileName: options.fileName,
          title: options.title,
          folderId: get().currentFolderId,
        },
        onProgress,
        () => { void askToDownload('opencode', true); }
      );
      classroomSocket.connect(payload.session.id, handleServerEvent);
      set((state) => ({
        importAudioModalOpen: false,
        sessions: [
          payload.session,
          ...state.sessions.filter((s) => s.id !== payload.session.id),
        ],
        activeSession: payload.session,
        speakers: payload.speakers,
        segments: payload.segments,
        messages: payload.messages,
        studyNote: payload.studyNote ?? null,
        flashcards: payload.flashcards ?? [],
        attachments: payload.attachments ?? [],
        hasAudio: Boolean(payload.hasAudio),
        audioDurationMs: payload.audioDurationMs ?? 0,
        livePartialUtterance: null,
        activeView: 'classroom',
      }));
      showNotice('info', `已导入音频并完成「${payload.session.title}」转写分段`);
    },

    updateUtterance: async (utteranceId, patch) => {
      const session = get().activeSession;
      if (!session) return;
      try {
        const updated = await api.patchUtterance(session.id, utteranceId, patch);
        set((state) => ({
          segments: state.segments.map((seg) => ({
            ...seg,
            utterances: seg.utterances.map((u) => (u.id === utteranceId ? updated : u)),
          })),
        }));
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '更新转写内容失败');
      }
    },

    markConfusedNow: async (note) => {
      const session = get().activeSession;
      if (!session) return;
      try {
        const res = await api.bookmarkNow(
          session.id,
          'confused',
          note,
          session.durationSeconds * 1000
        );
        set((state) => {
          const hasSeg = state.segments.some((s) => s.id === res.segmentId);
          if (!hasSeg) {
            return {
              segments: [
                ...state.segments,
                {
                  id: res.segmentId,
                  sessionId: session.id,
                  orderIndex: state.segments.length + 1,
                  topicTitle: '课堂重点书签',
                  utterances: [res.utterance],
                  highlights: [],
                },
              ],
            };
          }
          return {
            segments: state.segments.map((seg) => {
              if (seg.id !== res.segmentId) return seg;
              const exists = seg.utterances.some((u) => u.id === res.utterance.id);
              return {
                ...seg,
                utterances: exists
                  ? seg.utterances.map((u) =>
                      u.id === res.utterance.id ? res.utterance : u
                    )
                  : [...seg.utterances, res.utterance],
              };
            }),
          };
        });
        showNotice('info', `已在 [${res.utterance.timestampText}] 标记「此处没听懂」`);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '添加课堂书签失败');
      }
    },

    jumpToTranscript: (target) => {
      set((state) => ({
        transcriptFocusRequest: {
          ...target,
          seq: (state.transcriptFocusRequest?.seq ?? 0) + 1,
        },
      }));
    },

    prefillChatComposer: (text, attachments) => {
      set((state) => ({
        chatDraftPrefill: {
          text,
          attachments,
          seq: (state.chatDraftPrefill?.seq ?? 0) + 1,
        },
      }));
    },

    uploadSessionAttachment: async (file, options) => {
      const session = get().activeSession;
      if (!session) return null;
      try {
        const created = await api.uploadAttachment(session.id, file, {
          ...options,
          timestampMs: options.timestampMs ?? session.durationSeconds * 1000,
        });
        set((state) => ({
          attachments: state.attachments.some((a) => a.id === created.id)
            ? state.attachments
            : [...state.attachments, created],
        }));
        return created;
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '上传课堂附件失败');
        return null;
      }
    },

    captureClassroomScreen: async (caption) => {
      const session = get().activeSession;
      if (!session) return null;
      const latestSegId = get().segments[get().segments.length - 1]?.id;
      const timestampMs = session.durationSeconds * 1000;
      try {
        const sharedBlob = await classroomSocket.captureSharedVideoFrame();
        let created: SessionAttachmentItem;
        if (sharedBlob) {
          created = await api.uploadAttachment(session.id, sharedBlob, {
            fileName: `screen_${Date.now()}.png`,
            kind: 'screenshot',
            segmentId: latestSegId,
            timestampMs,
            caption,
          });
        } else {
          created = await api.captureScreen(session.id, {
            timestampMs,
            segmentId: latestSegId,
            caption,
          });
        }
        set((state) => ({
          attachments: state.attachments.some((a) => a.id === created.id)
            ? state.attachments
            : [...state.attachments, created],
        }));
        showNotice('info', `已抓拍课堂画面并锚定至 [${created.timestampText ?? '00:00'}]`);
        return created;
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '抓拍课堂画面失败');
        return null;
      }
    },

    deleteSessionAttachment: async (attachmentId) => {
      const session = get().activeSession;
      if (!session) return;
      try {
        await api.deleteAttachment(session.id, attachmentId);
        set((state) => ({
          attachments: state.attachments.filter((a) => a.id !== attachmentId),
        }));
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '删除附件失败');
      }
    },

    toggleMiniOverlayWindow: async () => {
      const winAny = window as unknown as {
        pywebview?: { api?: { toggle_mini_overlay?: () => Promise<boolean> } };
      };
      if (winAny.pywebview?.api?.toggle_mini_overlay) {
        await winAny.pywebview.api.toggle_mini_overlay();
        return;
      }
      const popup = window.open(
        `${window.location.origin}${window.location.pathname}?mode=mini`,
        'zhiling-mini-overlay',
        'popup=yes,width=580,height=260,left=80,top=80'
      );
      if (!popup) {
        showNotice('error', '浏览器拦截了悬浮小窗，请允许当前站点弹出窗口');
      }
    },

    checkForAppUpdates: async (options) => {
      const silent = options?.silent ?? false;
      const force = options?.force ?? false;
      const cur = get().appUpdate;
      if (
        cur.status === 'checking' ||
        cur.status === 'downloading' ||
        cur.status === 'verifying' ||
        cur.status === 'applying'
      ) {
        return;
      }

      set((state) => ({
        appUpdate: {
          ...state.appUpdate,
          status: 'checking',
          errorMessage: null,
        },
      }));

      try {
        const info = await api.checkAppUpdates(force);
        const ignored = get().appUpdate.dismissedVersion;
        if (info.hasUpdate) {
          const shouldShowPopup = !silent || ignored !== info.latestVersion;
          set((state) => ({
            appUpdate: {
              ...state.appUpdate,
              status: info.stagedReady ? 'ready' : 'available',
              info,
              popupVisible: shouldShowPopup,
              errorMessage: null,
              manualDownloadPath: null,
            },
          }));
        } else {
          set((state) => ({
            appUpdate: {
              ...state.appUpdate,
              status: 'up-to-date',
              info,
              popupVisible: false,
              errorMessage: null,
            },
          }));
          if (!silent) {
            showNotice('info', `当前已是最新版本 v${info.currentVersion}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '检查软件更新失败';
        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            status: silent ? 'idle' : 'error',
            errorMessage: silent ? null : msg,
          },
        }));
        if (!silent) {
          showNotice('error', msg);
        }
      }
    },

    startOneClickAppUpdate: async () => {
      const cur = get().appUpdate;
      if (cur.status === 'downloading' || cur.status === 'verifying' || cur.status === 'applying') {
        return;
      }

      set((state) => ({
        appUpdate: {
          ...state.appUpdate,
          status: 'downloading',
          popupVisible: true,
          errorMessage: null,
          manualDownloadPath: null,
          progress: {
            stage: 'connecting',
            downloadedBytes: 0,
            totalBytes: state.appUpdate.info?.asset?.sizeBytes ?? 0,
            percent: 0,
            speedBytesPerSec: 0,
          },
        },
      }));

      try {
        await api.streamDownloadAppUpdate((progress) => {
          set((state) => ({
            appUpdate: {
              ...state.appUpdate,
              status: progress.stage === 'verifying' ? 'verifying' : 'downloading',
              popupVisible: true,
              progress,
            },
          }));
        });

        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            status: 'ready',
            popupVisible: true,
            progress: {
              stage: 'ready',
              downloadedBytes: state.appUpdate.progress?.totalBytes ?? 0,
              totalBytes: state.appUpdate.progress?.totalBytes ?? 0,
              percent: 100,
              speedBytesPerSec: 0,
            },
          },
        }));

        // 若当前没有正在进行的课堂录音，校验完成后直接自动执行替换并重启
        if (get().activeSession?.status !== 'recording') {
          await get().applyReadyAppUpdate();
        } else {
          showNotice('info', '新版本已下载校验完成，请暂停当前录音后在右下角点击「立即重启安装」');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '下载更新包失败，请重试';
        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            status: 'error',
            popupVisible: true,
            errorMessage: msg,
          },
        }));
      }
    },

    applyReadyAppUpdate: async () => {
      if (get().activeSession?.status === 'recording') {
        showNotice('error', '请先暂停当前课堂录音，再执行重启安装');
        return;
      }
      set((state) => ({
        appUpdate: {
          ...state.appUpdate,
          status: 'applying',
          popupVisible: true,
          errorMessage: null,
        },
      }));

      try {
        const res = await api.applyAppUpdate();
        if (res.scheduled) {
          const bridge = getDesktopBridge();
          if (bridge?.quit_for_update) {
            void bridge.quit_for_update();
          } else if (bridge?.close_window) {
            void bridge.close_window();
          }
          return;
        }
        // 源码开发运行态：不覆盖源码目录，保留就绪状态并允许打开安装包目录
        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            status: 'ready',
            popupVisible: true,
            manualDownloadPath: res.downloadPath,
          },
        }));
        showNotice('info', res.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '启动自动更新程序失败';
        set((state) => ({
          appUpdate: {
            ...state.appUpdate,
            status: 'error',
            popupVisible: true,
            errorMessage: msg,
          },
        }));
      }
    },

    dismissUpdatePopup: () => {
      set((state) => ({
        appUpdate: {
          ...state.appUpdate,
          popupVisible: false,
        },
      }));
    },

    ignoreAvailableUpdateVersion: () => {
      const ver = get().appUpdate.info?.latestVersion ?? null;
      if (ver) {
        writeIgnoredUpdateVersion(ver);
      }
      set((state) => ({
        appUpdate: {
          ...state.appUpdate,
          dismissedVersion: ver,
          popupVisible: false,
        },
      }));
    },
  };
});
