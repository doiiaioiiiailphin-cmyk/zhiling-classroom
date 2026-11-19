import type { AppSettings, ClassroomClientCommand, ClassroomServerEvent } from '../types/domain';
import { useAppStore } from '../store/useAppStore';
import { IS_MOCK_MODE } from './api';
import {
  ClassroomAudio,
  type AudioRuntimeSettings,
  type AudioRuntimeTelemetry,
} from './classroomAudio';

const DEV_WS_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.replace(/\/$/, '')
  : undefined;

export const WS_BASE_URL =
  DEV_WS_BASE_URL ||
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/v1`;

export type ClassroomEventHandler = (event: ClassroomServerEvent) => void;
type RecordIntent = Extract<
  ClassroomClientCommand,
  { type: 'recording.start' | 'recording.resume' }
>;

const IDLE_TELEMETRY: AudioRuntimeTelemetry = {
  micLevel: 0,
  sysLevel: 0,
  aec3Active: false,
  aec3Ready: false,
  activeSysMode: 'none',
};

function resolveRuntimeAudioSettings(settings?: AppSettings | null): AudioRuntimeSettings {
  const source = settings?.audioInputSource ?? 'mixed';
  return {
    audioInputSource: source,
    audioDeviceId: settings?.audioDeviceId || 'default',
    systemAudioDeviceId: settings?.systemAudioDeviceId || 'default',
    micEnabled:
      typeof settings?.micEnabled === 'boolean' ? settings.micEnabled : source !== 'system-only',
    systemAudioEnabled:
      typeof settings?.systemAudioEnabled === 'boolean'
        ? settings.systemAudioEnabled
        : source !== 'mic-only',
    enableWebrtcAec3: Boolean(settings?.enableWebrtcAec3),
  };
}

interface Connection {
  sessionId: string;
  socket: WebSocket;
  onEvent: ClassroomEventHandler;
  intent: RecordIntent | null;
  capture: ClassroomAudio | null;
  opening: AbortController | null;
  recording: boolean;
  backingUp: boolean;
  lastActivitySentAt: number;
}

export type DesktopHotkeyAction =
  | 'toggleRecording'
  | 'toggleMicMute'
  | 'captureScreenshot'
  | 'bookmarkConfused'
  | 'toggleMiniOverlay';

export class ClassroomSocketClient {
  private connection: Connection | null = null;
  private desktopSocket: WebSocket | null = null;
  private desktopReconnectTimer: number | null = null;
  private telemetry: AudioRuntimeTelemetry = IDLE_TELEMETRY;
  private readonly telemetryListeners = new Set<(telemetry: AudioRuntimeTelemetry) => void>();

  getTelemetry(): AudioRuntimeTelemetry {
    return this.telemetry;
  }

  subscribeTelemetry(listener: (telemetry: AudioRuntimeTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    listener(this.telemetry);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }

  private emitTelemetry(next: AudioRuntimeTelemetry): void {
    this.telemetry = next;
    for (const listener of this.telemetryListeners) {
      listener(next);
    }
  }

  connect(sessionId: string, handler: ClassroomEventHandler): void {
    this.disconnect();
    if (IS_MOCK_MODE) return;
    const socket = new WebSocket(`${WS_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/stream`);
    socket.binaryType = 'arraybuffer';
    const connection: Connection = {
      sessionId,
      socket,
      onEvent: handler,
      intent: null,
      capture: null,
      opening: null,
      recording: false,
      backingUp: false,
      lastActivitySentAt: 0,
    };
    this.connection = connection;

    socket.onopen = () => this.activate(connection);
    socket.onmessage = ({ data }) => {
      if (this.connection !== connection || typeof data !== 'string') return;
      let event: ClassroomServerEvent;
      try {
        event = JSON.parse(data) as ClassroomServerEvent;
      } catch {
        return;
      }
      if (event.type === 'error') {
        this.report(connection, event.payload.code, event.payload.message);
      } else {
        connection.onEvent(event);
      }
    };
    socket.onclose = () => {
      if (this.connection !== connection) return;
      const interrupted = connection.recording || connection.intent;
      this.releaseAudio(connection);
      if (interrupted) {
        this.report(connection, 'CLASSROOM_SOCKET_CLOSED', '课堂连接已断开，可暂停后重新开始录音。');
      }
    };
  }

  sendCommand(command: ClassroomClientCommand): void {
    let connection = this.connection;
    if (IS_MOCK_MODE || !connection) return;
    if (command.type === 'recording.start' || command.type === 'recording.resume') {
      if (connection.socket.readyState >= WebSocket.CLOSING) {
        this.connect(connection.sessionId, connection.onEvent);
        connection = this.connection!;
      }
      connection.intent = command;
      if (connection.capture) {
        void connection.capture.reconfigure(
          resolveRuntimeAudioSettings(useAppStore.getState().settings)
        );
        this.activate(connection);
      } else if (!connection.opening) {
        this.openAudio(connection);
      }
      return;
    }

    connection.intent = null;
    connection.capture?.pause();
    connection.recording = false;
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(command));
    }
    if (command.type === 'recording.stop') this.releaseAudio(connection);
  }

  captureSharedVideoFrame(): Promise<Blob | null> {
    const capture = this.connection?.capture;
    if (!capture) return Promise.resolve(null);
    return capture.captureSharedVideoFrame();
  }

  connectDesktopEvents(onAction: (action: DesktopHotkeyAction) => void): () => void {
    if (IS_MOCK_MODE) return () => {};
    let disposed = false;

    const openSocket = () => {
      if (disposed) return;
      const ws = new WebSocket(`${WS_BASE_URL}/desktop/events`);
      this.desktopSocket = ws;
      ws.onmessage = ({ data }) => {
        if (disposed || typeof data !== 'string') return;
        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            payload?: { action?: DesktopHotkeyAction };
          };
          if (parsed.type === 'hotkey.triggered' && parsed.payload?.action) {
            onAction(parsed.payload.action);
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (disposed) return;
        this.desktopReconnectTimer = window.setTimeout(openSocket, 2500);
      };
    };

    openSocket();
    return () => {
      disposed = true;
      if (this.desktopReconnectTimer !== null) {
        window.clearTimeout(this.desktopReconnectTimer);
        this.desktopReconnectTimer = null;
      }
      if (this.desktopSocket) {
        this.desktopSocket.onclose = null;
        this.desktopSocket.close();
        this.desktopSocket = null;
      }
    };
  }

  applyAudioSettings(
    settings: AppSettings,
    options?: { forceRepickSystem?: boolean }
  ): Promise<void> {
    const capture = this.connection?.capture;
    if (!capture) return Promise.resolve();
    return capture.reconfigure(resolveRuntimeAudioSettings(settings), options);
  }

  sendAudioChunk(chunk: ArrayBuffer | Blob): void {
    const connection = this.connection;
    if (
      IS_MOCK_MODE ||
      !connection ||
      !connection.recording ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    if (connection.socket.bufferedAmount > 1024 * 1024) {
      if (!connection.backingUp) {
        this.report(connection, 'AUDIO_BACKPRESSURE', '连接发送缓慢，部分音频帧未送达。');
        connection.backingUp = true;
      }
      return;
    }
    connection.backingUp = false;
    connection.socket.send(chunk);
  }

  disconnect(): void {
    const connection = this.connection;
    if (!connection) return;
    this.releaseAudio(connection);
    this.connection = null;
    connection.socket.onclose = null;
    connection.socket.close();
  }

  private activate(connection: Connection): void {
    if (
      connection !== this.connection ||
      connection.socket.readyState !== WebSocket.OPEN ||
      !connection.intent ||
      !connection.capture ||
      connection.recording
    ) {
      return;
    }
    connection.socket.send(JSON.stringify(connection.intent));
    connection.recording = true;
    connection.capture.start();
  }

  private openAudio(connection: Connection): void {
    const opening = new AbortController();
    connection.opening = opening;
    const settings = resolveRuntimeAudioSettings(useAppStore.getState().settings);
    void ClassroomAudio.open(
      settings,
      opening.signal,
      (chunk) => {
        if (this.connection === connection) this.sendAudioChunk(chunk);
      },
      (code, message) => this.report(connection, code, message),
      () => {
        if (this.connection !== connection) return;
        this.sendCommand({ type: 'recording.pause' });
        this.releaseAudio(connection);
        this.report(
          connection,
          'AUDIO_CAPTURE_ENDED',
          '录音来源已全部结束，重新开始录音时可重新选择来源。'
        );
      },
      (telemetry) => {
        if (this.connection === connection) {
          this.emitTelemetry(telemetry);
          const nowMs = Date.now();
          if (
            connection.recording &&
            connection.socket.readyState === WebSocket.OPEN &&
            nowMs - connection.lastActivitySentAt >= 320
          ) {
            connection.lastActivitySentAt = nowMs;
            const s = useAppStore.getState().settings;
            const dualActive = Boolean(
              s?.micEnabled && s?.systemAudioEnabled && telemetry.activeSysMode !== 'none'
            );
            connection.socket.send(
              JSON.stringify({
                type: 'channel.activity',
                payload: {
                  micRms: Number(Math.min(9.9, telemetry.micLevel).toFixed(4)),
                  sysRms: Number(Math.min(9.9, telemetry.sysLevel).toFixed(4)),
                  dualActive,
                },
              } satisfies ClassroomClientCommand)
            );
          }
        }
      }
    )
      .then((capture) => {
        if (opening.signal.aborted || this.connection !== connection) {
          capture.close();
          return;
        }
        connection.capture = capture;
        this.activate(connection);
      })
      .catch((error: unknown) => {
        if (!opening.signal.aborted) {
          this.report(
            connection,
            'AUDIO_CAPTURE_FAILED',
            error instanceof Error ? error.message : '无法打开录音设备。'
          );
        }
      })
      .finally(() => {
        if (connection.opening === opening) connection.opening = null;
      });
  }

  private releaseAudio(connection: Connection): void {
    connection.capture?.close();
    connection.capture = null;
    connection.opening?.abort();
    connection.opening = null;
    connection.intent = null;
    connection.recording = false;
    this.emitTelemetry(IDLE_TELEMETRY);
  }

  private report(connection: Connection, code: string, message: string): void {
    if (this.connection !== connection) return;
    console.warn(`[知聆课堂] ${code} ${message}`);
    connection.onEvent({ type: 'error', payload: { code, message } });
  }
}

export const classroomSocket = new ClassroomSocketClient();
