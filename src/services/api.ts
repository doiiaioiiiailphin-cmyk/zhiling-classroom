import type {
  Aec3AddonStatus,
  Aec3DownloadProgress,
  ApiProtocol,
  AppSettings,
  AsrProtocol,
  AudioImportProgress,
  ChatMessage,
  ClassSessionCard,
  FlashcardItem,
  FolderItem,
  NativeAudioDevices,
  OpenCodeDownloadProgress,
  SearchHitItem,
  SegmentDetailedExplanation,
  SessionAttachmentItem,
  SessionExportRequest,
  SessionStudyNote,
  SessionWorkspacePayload,
  StickyNoteCreateInput,
  StickyNoteItem,
  StickyNotePatchInput,
  UpdateApplyResult,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UtteranceItem,
  UtterancePatch,
} from '../types/domain';
import { mockAdapter } from './mockData';

/**
 * 是否使用前端内置轻量演示适配器
 * 默认请求真实后端。设置 VITE_USE_MOCK=true 可打开演示模式。
 */
export const IS_MOCK_MODE = import.meta.env.VITE_USE_MOCK === 'true';
export const API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/api/v1';

export class ApiRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export class AddonDownloadCancelled extends Error {}

async function responseError(response: Response): Promise<ApiRequestError> {
  const body = await response.json().catch(() => null) as {
    error?: { message?: string; code?: string };
  } | null;
  return new ApiRequestError(body?.error?.message || `HTTP ${response.status}`, body?.error?.code);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) throw await responseError(response);

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json()) as { data: T };
  return body.data;
}

type SseServerFrame<T> =
  | { type: 'thinking'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'status'; stage: 'generating' }
  | {
      type: 'progress';
      stage: OpenCodeDownloadProgress['stage'] | AudioImportProgress['stage'];
      downloadedBytes: number;
      totalBytes: number;
      percent: number;
      speedBytesPerSec?: number;
    }
  | { type: 'done'; data: T }
  | { type: 'opencode-required' }
  | { type: 'error'; error?: { code?: string; message?: string } };

async function requestSse<T>(
  path: string,
  body: unknown,
  onFrame: (frame: SseServerFrame<T>) => void
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) throw await responseError(response);

  if (!response.body) {
    throw new Error('当前环境不支持流式响应读取');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let donePayload: T | undefined;

  const consumeFrame = (rawFrame: string) => {
    const dataLines: string[] = [];
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const rawJson = dataLines.join('\n').trim();
    if (!rawJson || rawJson === '[DONE]') return;
    const parsed = JSON.parse(rawJson) as SseServerFrame<T>;
    if (parsed.type === 'error') {
      throw new ApiRequestError(parsed.error?.message || '流式生成请求失败', parsed.error?.code);
    }
    if (parsed.type === 'done') {
      donePayload = parsed.data;
    }
    onFrame(parsed);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('\r')) {
        buffer = buffer.replace(/\r\n/g, '\n');
      }
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeFrame(frame);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      consumeFrame(buffer.replace(/\r\n/g, '\n'));
    }
  } finally {
    reader.releaseLock();
  }

  if (donePayload === undefined) {
    throw new Error('流式响应连接意外中断');
  }

  return donePayload;
}

export const api = {
  // ---------------- 文件夹管理 ----------------
  listFolders(): Promise<FolderItem[]> {
    if (IS_MOCK_MODE) return mockAdapter.listFolders();
    return requestJson<FolderItem[]>('/folders');
  },

  createFolder(
    name: string,
    parentId: string | null = null,
    hotwords?: string[]
  ): Promise<FolderItem> {
    if (IS_MOCK_MODE) return mockAdapter.createFolder(name, parentId, hotwords);
    return requestJson<FolderItem>('/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId, ...(hotwords ? { hotwords } : {}) }),
    });
  },

  updateFolder(
    id: string,
    patch: { name?: string; hotwords?: string[] }
  ): Promise<FolderItem> {
    if (IS_MOCK_MODE) return mockAdapter.updateFolder(id, patch);
    return requestJson<FolderItem>(`/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deleteFolder(id: string): Promise<void> {
    if (IS_MOCK_MODE) return mockAdapter.deleteFolder(id);
    return requestJson<void>(`/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  // ---------------- 课堂会话管理 ----------------
  listSessions(): Promise<ClassSessionCard[]> {
    if (IS_MOCK_MODE) return mockAdapter.listSessions();
    return requestJson<ClassSessionCard[]>('/sessions');
  },

  createSession(folderId: string | null = null): Promise<SessionWorkspacePayload> {
    if (IS_MOCK_MODE) return mockAdapter.createSession(folderId);
    return requestJson<SessionWorkspacePayload>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ folderId }),
    });
  },

  updateSession(
    id: string,
    patch: Partial<Pick<ClassSessionCard, 'title' | 'folderId' | 'status' | 'durationSeconds'>>
  ): Promise<ClassSessionCard> {
    if (IS_MOCK_MODE) return mockAdapter.updateSession(id, patch);
    return requestJson<ClassSessionCard>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deleteSession(id: string): Promise<void> {
    if (IS_MOCK_MODE) return mockAdapter.deleteSession(id);
    return requestJson<void>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  getSessionWorkspace(id: string): Promise<SessionWorkspacePayload> {
    if (IS_MOCK_MODE) return mockAdapter.getSessionWorkspace(id);
    return requestJson<SessionWorkspacePayload>(`/sessions/${encodeURIComponent(id)}/workspace`);
  },

  renameSpeaker(sessionId: string, speakerId: string, label: string): Promise<void> {
    if (IS_MOCK_MODE) return mockAdapter.renameSpeaker(sessionId, speakerId, label);
    return requestJson<void>(
      `/sessions/${encodeURIComponent(sessionId)}/speakers/${encodeURIComponent(speakerId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }
    );
  },

  // ---------------- 课堂 AI 能力接口 ----------------
  explainSegment(sessionId: string, segmentId: string): Promise<SegmentDetailedExplanation> {
    if (IS_MOCK_MODE) return mockAdapter.explainSegment(sessionId, segmentId);
    return requestJson<SegmentDetailedExplanation>(
      `/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(segmentId)}/explain`,
      { method: 'POST' }
    );
  },

  streamExplainSegment(
    sessionId: string,
    segmentId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onStageChange?: (stage: 'generating') => void;
    }
  ): Promise<SegmentDetailedExplanation> {
    if (IS_MOCK_MODE) {
      return mockAdapter.streamExplainSegment(sessionId, segmentId, callbacks);
    }
    return requestSse<SegmentDetailedExplanation>(
      `/sessions/${encodeURIComponent(sessionId)}/segments/${encodeURIComponent(segmentId)}/explain/stream`,
      undefined,
      (frame) => {
        if (frame.type === 'thinking') {
          callbacks?.onThinkingDelta?.(frame.delta);
        } else if (frame.type === 'status') {
          callbacks?.onStageChange?.(frame.stage);
        }
      }
    );
  },

  sendChatMessage(
    sessionId: string,
    content: string,
    attachmentIds?: string[]
  ): Promise<ChatMessage> {
    if (IS_MOCK_MODE) return mockAdapter.sendChatMessage(sessionId, content);
    return requestJson<ChatMessage>(`/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      }),
    });
  },

  streamChatMessage(
    sessionId: string,
    content: string,
    callbacks?: {
      attachmentIds?: string[];
      onThinkingDelta?: (delta: string) => void;
      onContentDelta?: (delta: string) => void;
    }
  ): Promise<ChatMessage> {
    if (IS_MOCK_MODE) {
      return mockAdapter.streamChatMessage(sessionId, content, callbacks);
    }
    const attachmentIds = callbacks?.attachmentIds;
    return requestSse<ChatMessage>(
      `/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
      {
        content,
        ...(attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {}),
      },
      (frame) => {
        if (frame.type === 'thinking') {
          callbacks?.onThinkingDelta?.(frame.delta);
        } else if (frame.type === 'content') {
          callbacks?.onContentDelta?.(frame.delta);
        }
      }
    );
  },

  streamSessionNotes(
    sessionId: string,
    callbacks?: {
      onThinkingDelta?: (delta: string) => void;
      onContentDelta?: (delta: string) => void;
    }
  ): Promise<SessionStudyNote> {
    if (IS_MOCK_MODE) {
      return mockAdapter.streamSessionNotes(sessionId, callbacks);
    }
    return requestSse<SessionStudyNote>(
      `/sessions/${encodeURIComponent(sessionId)}/notes/stream`,
      undefined,
      (frame) => {
        if (frame.type === 'thinking') {
          callbacks?.onThinkingDelta?.(frame.delta);
        } else if (frame.type === 'content') {
          callbacks?.onContentDelta?.(frame.delta);
        }
      }
    );
  },

  generateFlashcards(sessionId: string): Promise<FlashcardItem[]> {
    if (IS_MOCK_MODE) return mockAdapter.generateFlashcards(sessionId);
    return requestJson<FlashcardItem[]>(
      `/sessions/${encodeURIComponent(sessionId)}/flashcards`,
      { method: 'POST' }
    );
  },

  async exportSessionDocument(
    sessionId: string,
    req: SessionExportRequest,
    fallbackTitle = '课堂笔记'
  ): Promise<{ blob: Blob; filename: string }> {
    if (IS_MOCK_MODE) {
      return mockAdapter.exportSessionDocument(sessionId, req);
    }
    const response = await fetch(
      `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/export`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      }
    );
    if (!response.ok) {
      let detail = `导出失败 (HTTP ${response.status})`;
      try {
        const err = (await response.json()) as { error?: { message?: string } };
        if (err?.error?.message) detail = err.error.message;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    const blob = await response.blob();
    const disp = response.headers.get('Content-Disposition') ?? '';
    const utf8Match = disp.match(/filename\*=UTF-8''([^;\s]+)/i);
    const ext = req.format === 'markdown' ? 'md' : req.format === 'anki' ? 'tsv' : req.format;
    const filename = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : `${fallbackTitle}.${ext}`;
    return { blob, filename };
  },

  getSessionAudioUrl(sessionId: string): string {
    return `${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/audio`;
  },

  retranscribeGap(
    sessionId: string
  ): Promise<{ recoveredCount: number; fromMs: number; toMs: number }> {
    if (IS_MOCK_MODE) {
      return Promise.resolve({ recoveredCount: 0, fromMs: 0, toMs: 0 });
    }
    return requestJson<{ recoveredCount: number; fromMs: number; toMs: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/retranscribe-gap`,
      { method: 'POST' }
    );
  },

  async streamImportAudio(
    file: Blob,
    options: { fileName: string; title?: string; folderId?: string | null },
    onProgress?: (progress: AudioImportProgress) => void,
    onOpenCodeRequired?: () => void
  ): Promise<SessionWorkspacePayload> {
    if (IS_MOCK_MODE) {
      return mockAdapter.streamImportAudio(file, options, onProgress);
    }
    const params = new URLSearchParams({ fileName: options.fileName });
    if (options.title?.trim()) params.set('title', options.title.trim());
    if (options.folderId) params.set('folderId', options.folderId);

    const response = await fetch(
      `${API_BASE_URL}/sessions/import-audio?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          Accept: 'text/event-stream',
        },
        body: file,
      }
    );
    if (!response.ok) {
      let detail = `导入失败 (HTTP ${response.status})`;
      try {
        const err = (await response.json()) as { error?: { message?: string } };
        if (err?.error?.message) detail = err.error.message;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }
    if (!response.body) throw new Error('当前环境不支持流式导入进度读取');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let donePayload: SessionWorkspacePayload | undefined;

    const consume = (rawFrame: string) => {
      const lines = rawFrame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (lines.length === 0) return;
      const parsed = JSON.parse(lines.join('\n')) as SseServerFrame<SessionWorkspacePayload>;
      if (parsed.type === 'error') {
        throw new Error(parsed.error?.message || '音频导入处理失败');
      }
      if (parsed.type === 'progress') {
        onProgress?.({
          stage: parsed.stage as AudioImportProgress['stage'],
          downloadedBytes: parsed.downloadedBytes,
          totalBytes: parsed.totalBytes,
          percent: parsed.percent,
        });
      } else if (parsed.type === 'opencode-required') {
        onOpenCodeRequired?.();
      } else if (parsed.type === 'done') {
        donePayload = parsed.data;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          consume(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf('\n\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
    } finally {
      reader.releaseLock();
    }

    if (!donePayload) throw new Error('音频导入连接提前中断');
    return donePayload;
  },

  patchUtterance(
    sessionId: string,
    utteranceId: string,
    patch: UtterancePatch
  ): Promise<UtteranceItem> {
    if (IS_MOCK_MODE) return mockAdapter.patchUtterance(sessionId, utteranceId, patch);
    return requestJson<UtteranceItem>(
      `/sessions/${encodeURIComponent(sessionId)}/utterances/${encodeURIComponent(utteranceId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }
    );
  },

  bookmarkNow(
    sessionId: string,
    kind: 'confused' | 'important' = 'confused',
    note?: string,
    timestampMs?: number
  ): Promise<{ segmentId: string; utterance: UtteranceItem }> {
    if (IS_MOCK_MODE) return mockAdapter.bookmarkNow(sessionId, kind, note);
    return requestJson<{ segmentId: string; utterance: UtteranceItem }>(
      `/sessions/${encodeURIComponent(sessionId)}/bookmarks/now`,
      {
        method: 'POST',
        body: JSON.stringify({
          kind,
          ...(note ? { note } : {}),
          ...(timestampMs !== undefined ? { timestampMs } : {}),
        }),
      }
    );
  },

  async uploadAttachment(
    sessionId: string,
    file: Blob,
    options: {
      fileName: string;
      kind?: 'screenshot' | 'image' | 'material';
      segmentId?: string;
      timestampMs?: number;
      caption?: string;
    }
  ): Promise<SessionAttachmentItem> {
    if (IS_MOCK_MODE) return mockAdapter.uploadAttachment(sessionId, file, options);
    const params = new URLSearchParams({ fileName: options.fileName });
    if (file.type) params.set('mimeType', file.type);
    if (options.kind) params.set('kind', options.kind);
    if (options.segmentId) params.set('segmentId', options.segmentId);
    if (options.timestampMs !== undefined) params.set('timestampMs', String(options.timestampMs));
    if (options.caption) params.set('caption', options.caption);

    return requestJson<SessionAttachmentItem>(
      `/sessions/${encodeURIComponent(sessionId)}/attachments?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }
    );
  },

  captureScreen(
    sessionId: string,
    options?: { timestampMs?: number; segmentId?: string; caption?: string }
  ): Promise<SessionAttachmentItem> {
    return requestJson<SessionAttachmentItem>(
      `/sessions/${encodeURIComponent(sessionId)}/capture-screen`,
      {
        method: 'POST',
        body: JSON.stringify(options ?? {}),
      }
    );
  },

  deleteAttachment(sessionId: string, attachmentId: string): Promise<void> {
    if (IS_MOCK_MODE) return mockAdapter.deleteAttachment(sessionId, attachmentId);
    return requestJson<void>(
      `/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' }
    );
  },

  // ---------------- 课堂便签条与便签篓 ----------------
  listStickyNotes(sessionId: string): Promise<StickyNoteItem[]> {
    if (IS_MOCK_MODE) return mockAdapter.listStickyNotes(sessionId);
    return requestJson<StickyNoteItem[]>(
      `/sessions/${encodeURIComponent(sessionId)}/sticky-notes`
    );
  },

  createStickyNote(
    sessionId: string,
    payload: StickyNoteCreateInput
  ): Promise<StickyNoteItem> {
    if (IS_MOCK_MODE) return mockAdapter.createStickyNote(sessionId, payload);
    return requestJson<StickyNoteItem>(
      `/sessions/${encodeURIComponent(sessionId)}/sticky-notes`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  },

  updateStickyNote(
    sessionId: string,
    noteId: string,
    patch: StickyNotePatchInput
  ): Promise<StickyNoteItem> {
    if (IS_MOCK_MODE) return mockAdapter.updateStickyNote(sessionId, noteId, patch);
    return requestJson<StickyNoteItem>(
      `/sessions/${encodeURIComponent(sessionId)}/sticky-notes/${encodeURIComponent(noteId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }
    );
  },

  setAllStickyNotesOpen(sessionId: string, isOpen: boolean): Promise<StickyNoteItem[]> {
    if (IS_MOCK_MODE) return mockAdapter.setAllStickyNotesOpen(sessionId, isOpen);
    return requestJson<StickyNoteItem[]>(
      `/sessions/${encodeURIComponent(sessionId)}/sticky-notes`,
      {
        method: 'PATCH',
        body: JSON.stringify({ isOpen }),
      }
    );
  },

  deleteStickyNote(sessionId: string, noteId: string): Promise<void> {
    if (IS_MOCK_MODE) return mockAdapter.deleteStickyNote(sessionId, noteId);
    return requestJson<void>(
      `/sessions/${encodeURIComponent(sessionId)}/sticky-notes/${encodeURIComponent(noteId)}`,
      { method: 'DELETE' }
    );
  },

  searchGlobal(query: string, folderId?: string | null): Promise<SearchHitItem[]> {
    if (IS_MOCK_MODE) return mockAdapter.searchGlobal(query, folderId);
    const params = new URLSearchParams({ q: query });
    if (folderId) params.set('folderId', folderId);
    return requestJson<SearchHitItem[]>(`/search?${params.toString()}`);
  },

  // ---------------- 设置与多协议模型拉取 ----------------
  getSettings(): Promise<AppSettings> {
    if (IS_MOCK_MODE) return mockAdapter.getSettings();
    return requestJson<AppSettings>('/settings');
  },

  updateSettings(settings: AppSettings): Promise<AppSettings> {
    if (IS_MOCK_MODE) return mockAdapter.updateSettings(settings);
    return requestJson<AppSettings>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },

  fetchProviderModels(params: {
    providerId: string;
    protocol: ApiProtocol;
    baseUrl: string;
    apiKey: string;
  }): Promise<string[]> {
    if (IS_MOCK_MODE) return mockAdapter.fetchLlmModels(params.providerId);
    return requestJson<string[]>('/providers/models', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  fetchAsrModels(params: {
    providerId: string;
    protocol: AsrProtocol;
    baseUrl: string;
    apiKey: string;
    appId?: string;
  }): Promise<string[]> {
    if (IS_MOCK_MODE) return mockAdapter.fetchAsrModels(params.providerId);
    return requestJson<string[]>('/asr-providers/models', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  getBuiltinAsrReady(): Promise<boolean> {
    return requestJson<boolean>('/addons/builtin-free-asr', { cache: 'no-store' });
  },

  downloadBuiltinAsr(): Promise<void> {
    return requestJson<void>('/addons/builtin-free-asr/download', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    });
  },

  streamDownloadBuiltinAsr(
    onProgress?: (progress: OpenCodeDownloadProgress) => void
  ): Promise<boolean> {
    return requestSse<boolean>(
      '/addons/builtin-free-asr/download/stream',
      { confirmed: true },
      (frame) => {
        if (frame.type === 'progress') {
          onProgress?.({
            stage: frame.stage as OpenCodeDownloadProgress['stage'],
            downloadedBytes: frame.downloadedBytes,
            totalBytes: frame.totalBytes,
            percent: frame.percent,
          });
        }
      }
    );
  },

  decideOpenCodeDownload(confirmed: boolean): Promise<void> {
    return requestJson<void>('/addons/opencode/download', {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    });
  },

  streamDownloadOpenCode(
    onProgress?: (progress: OpenCodeDownloadProgress) => void
  ): Promise<boolean> {
    return requestSse<boolean>(
      '/addons/opencode/download/stream',
      { confirmed: true },
      (frame) => {
        if (frame.type === 'progress') {
          onProgress?.({
            stage: frame.stage as OpenCodeDownloadProgress['stage'],
            downloadedBytes: frame.downloadedBytes,
            totalBytes: frame.totalBytes,
            percent: frame.percent,
          });
        }
      }
    );
  },

  // ---------------- WebRTC AEC3 组件与系统音频源 ----------------
  getAec3AddonStatus(): Promise<Aec3AddonStatus> {
    if (IS_MOCK_MODE) return mockAdapter.getAec3AddonStatus();
    return requestJson<Aec3AddonStatus>('/addons/webrtc-aec3');
  },

  streamDownloadAec3Addon(
    onProgress?: (progress: Aec3DownloadProgress) => void
  ): Promise<Aec3AddonStatus> {
    if (IS_MOCK_MODE) return mockAdapter.streamDownloadAec3Addon(onProgress);
    return requestSse<Aec3AddonStatus>(
      '/addons/webrtc-aec3/download',
      undefined,
      (frame) => {
        if (frame.type === 'progress') {
          onProgress?.({
            stage: frame.stage as Aec3DownloadProgress['stage'],
            downloadedBytes: frame.downloadedBytes,
            totalBytes: frame.totalBytes,
            percent: frame.percent,
          });
        }
      }
    );
  },

  getNativeAudioDevices(): Promise<NativeAudioDevices> {
    if (IS_MOCK_MODE) return mockAdapter.getNativeAudioDevices();
    return requestJson<NativeAudioDevices>('/audio/devices');
  },

  // ---------------- CNB 自动检查更新与热更新 ----------------
  checkAppUpdates(force = false): Promise<UpdateCheckResult> {
    if (IS_MOCK_MODE) {
      return Promise.resolve({
        currentVersion: '0.1.11',
        latestVersion: '0.1.11',
        hasUpdate: false,
        releaseTitle: '',
        releaseNotes: '',
        releaseUrl: '',
        publishedAt: '',
        platform: 'web',
        arch: 'x86_64',
        repo: '',
        canAutoApply: false,
        stagedReady: false,
        asset: null,
        checkedAt: new Date().toISOString(),
      });
    }
    const qs = force ? '?force=true' : '';
    return requestJson<UpdateCheckResult>(`/updates/check${qs}`, { cache: 'no-store' });
  },

  streamDownloadAppUpdate(
    onProgress?: (progress: UpdateDownloadProgress) => void
  ): Promise<{ version: string; filePath: string; sha256: string }> {
    return requestSse<{ version: string; filePath: string; sha256: string }>(
      '/updates/download/stream',
      undefined,
      (frame) => {
        if (frame.type === 'progress') {
          onProgress?.({
            stage: frame.stage as UpdateDownloadProgress['stage'],
            downloadedBytes: frame.downloadedBytes,
            totalBytes: frame.totalBytes,
            percent: frame.percent,
            speedBytesPerSec: frame.speedBytesPerSec ?? 0,
          });
        }
      }
    );
  },

  applyAppUpdate(): Promise<UpdateApplyResult> {
    return requestJson<UpdateApplyResult>('/updates/apply', { method: 'POST' });
  },
};
