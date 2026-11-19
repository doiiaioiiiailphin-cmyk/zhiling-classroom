import type { AppSettings } from '../types/domain';
import { API_BASE_URL, IS_MOCK_MODE, api } from './api';

export type AudioRuntimeSettings = Pick<
  AppSettings,
  | 'audioInputSource'
  | 'audioDeviceId'
  | 'systemAudioDeviceId'
  | 'micEnabled'
  | 'systemAudioEnabled'
  | 'enableWebrtcAec3'
>;

export interface AudioRuntimeTelemetry {
  micLevel: number;
  sysLevel: number;
  aec3Active: boolean;
  aec3Ready: boolean;
  activeSysMode: 'wasapi' | 'display-share' | 'input' | 'none';
}

type AudioIssue = (code: string, message: string) => void;
type TelemetryHandler = (telemetry: AudioRuntimeTelemetry) => void;

const FRAME_BYTES = 3200;
const processorUrl = new URL('./pcmCapture.worklet.js?no-inline', import.meta.url).href;

let cachedWasapiSupport: boolean | null = null;

async function checkWasapiSupport(): Promise<boolean> {
  if (IS_MOCK_MODE) return false;
  if (cachedWasapiSupport !== null) return cachedWasapiSupport;
  try {
    const info = await api.getNativeAudioDevices();
    cachedWasapiSupport = Boolean(info.wasapiSupported);
    return cachedWasapiSupport;
  } catch {
    return false;
  }
}

function getWsBaseUrl(): string {
  const devWs = import.meta.env.DEV
    ? (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.replace(/\/$/, '')
    : undefined;
  return (
    devWs ||
    `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/v1`
  );
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

function createContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  } catch {
    return new AudioContext({ latencyHint: 'interactive' });
  }
}

interface MicSlot {
  stream: MediaStream;
  track: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  deviceId: string;
  customAec3Mode: boolean;
}

interface SysSlot {
  mode: 'wasapi' | 'display-share' | 'input';
  deviceId: string;
  stream: MediaStream | null;
  track: MediaStreamTrack | null;
  source: MediaStreamAudioSourceNode | null;
  socket: WebSocket | null;
}

export class ClassroomAudio {
  private running = false;
  private closed = false;
  private pending = new Uint8Array(FRAME_BYTES);
  private length = 0;
  private generation = 0;

  private micSlot: MicSlot | null = null;
  private sysSlot: SysSlot | null = null;
  private currentSettings: AudioRuntimeSettings;

  private aec3ModuleLoaded = false;
  private aec3Ready = false;
  private opChain: Promise<void> = Promise.resolve();

  private telemetry: AudioRuntimeTelemetry = {
    micLevel: 0,
    sysLevel: 0,
    aec3Active: false,
    aec3Ready: false,
    activeSysMode: 'none',
  };

  private constructor(
    private readonly context: AudioContext,
    private readonly clockSource: ConstantSourceNode,
    private readonly processor: AudioWorkletNode,
    initialSettings: AudioRuntimeSettings,
    private readonly onChunk: (chunk: ArrayBuffer) => void,
    private readonly onIssue: AudioIssue,
    private readonly onEnded: () => void,
    private readonly onTelemetry?: TelemetryHandler
  ) {
    this.currentSettings = { ...initialSettings };

    processor.port.onmessage = ({
      data,
    }: MessageEvent<
      | { type?: 'pcm'; generation: number; pcm: ArrayBuffer }
      | { type: 'levels'; micLevel: number; sysLevel: number; aec3Active: boolean }
      | { type: 'aec3-status'; ready: boolean; message?: string }
    >) => {
      if (!data) return;
      if (data.type === 'levels') {
        this.telemetry = {
          ...this.telemetry,
          micLevel: this.running ? data.micLevel : 0,
          sysLevel: this.running ? data.sysLevel : 0,
          aec3Active: this.running && data.aec3Active,
        };
        this.onTelemetry?.(this.telemetry);
        return;
      }
      if (data.type === 'aec3-status') {
        this.aec3Ready = data.ready;
        this.telemetry = { ...this.telemetry, aec3Ready: data.ready };
        this.onTelemetry?.(this.telemetry);
        return;
      }
      if ('pcm' in data && data.generation === this.generation) {
        this.collect(new Uint8Array(data.pcm));
      }
    };
  }

  static async open(
    settings: AudioRuntimeSettings,
    signal: AbortSignal,
    onChunk: (chunk: ArrayBuffer) => void,
    onIssue: AudioIssue,
    onEnded: () => void,
    onTelemetry?: TelemetryHandler
  ): Promise<ClassroomAudio> {
    if (typeof AudioContext === 'undefined') {
      throw new Error('当前环境不支持网页音频采集。');
    }
    if (!settings.micEnabled && !settings.systemAudioEnabled) {
      throw new Error('麦克风与系统内录均已禁用，请先在顶部音频源图标中开启至少一路输入。');
    }

    const context = createContext();
    const abortCleanup = () => {
      if (context.state !== 'closed') void context.close().catch(() => {});
    };
    signal.addEventListener('abort', abortCleanup, { once: true });

    try {
      void context.resume().catch(() => {});
      if (!context.audioWorklet) {
        throw new Error('当前浏览器不支持 AudioWorklet 录音。');
      }
      await context.audioWorklet.addModule(processorUrl);
      signal.throwIfAborted();

      const processor = new AudioWorkletNode(context, 'classroom-pcm', {
        channelCount: 1,
        channelCountMode: 'explicit',
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      // Keep AudioWorklet quantum ticking at 128 samples even in WASAPI-only / muted states
      const clockSource = context.createConstantSource();
      clockSource.offset.value = 0;
      const zeroGain = context.createGain();
      zeroGain.gain.value = 0;
      clockSource.connect(zeroGain).connect(processor, 0, 0);
      clockSource.start();

      const sinkMute = context.createGain();
      sinkMute.gain.value = 0;
      processor.connect(sinkMute).connect(context.destination);
      processor.onprocessorerror = onEnded;

      const instance = new ClassroomAudio(
        context,
        clockSource,
        processor,
        settings,
        onChunk,
        onIssue,
        onEnded,
        onTelemetry
      );

      await instance.configureInitialSources(settings, signal);
      signal.throwIfAborted();
      return instance;
    } catch (err) {
      abortCleanup();
      throw err;
    } finally {
      signal.removeEventListener('abort', abortCleanup);
    }
  }

  private async configureInitialSources(
    settings: AudioRuntimeSettings,
    signal: AbortSignal
  ): Promise<void> {
    const wasapiOk = await checkWasapiSupport();
    signal.throwIfAborted();

    const wantsSystem = settings.systemAudioEnabled;
    const wantsMic = settings.micEnabled;
    const useCustomAec3 = Boolean(wantsMic && wantsSystem && settings.enableWebrtcAec3);

    // Trigger display-share synchronously enough if explicit display-share was chosen
    const sysPromise = wantsSystem
      ? this.acquireSystemSlot(settings.systemAudioDeviceId || 'default', wasapiOk, signal)
      : Promise.resolve(null);
    const micPromise = wantsMic
      ? this.acquireMicSlot(settings.audioDeviceId || 'default', useCustomAec3, signal)
      : Promise.resolve(null);
    const aecPromise = settings.enableWebrtcAec3
      ? this.ensureAec3Loaded()
      : Promise.resolve();

    const [sysRes, micRes] = await Promise.allSettled([sysPromise, micPromise, aecPromise]);
    signal.throwIfAborted();

    if (sysRes.status === 'fulfilled' && sysRes.value) {
      this.attachSysSlot(sysRes.value);
    }
    if (micRes.status === 'fulfilled' && micRes.value) {
      this.attachMicSlot(micRes.value);
    }

    const activeCount = (this.micSlot ? 1 : 0) + (this.sysSlot ? 1 : 0);
    if (activeCount === 0) {
      const reason =
        sysRes.status === 'rejected' && sysRes.reason instanceof Error
          ? sysRes.reason.message
          : micRes.status === 'rejected' && micRes.reason instanceof Error
            ? micRes.reason.message
            : '未能打开可用的麦克风或系统音频源，请检查设备与权限。';
      throw new Error(reason);
    }

    if (wantsMic && wantsSystem && activeCount === 1) {
      this.onIssue('AUDIO_SOURCE_UNAVAILABLE', '其中一路音频未就绪，已使用当前可用来源继续录音。');
    }

    this.syncWorkletChannels();
  }

  reconfigure(nextSettings: AudioRuntimeSettings, options?: { forceRepickSystem?: boolean }): Promise<void> {
    this.opChain = this.opChain
      .then(() => this.applyReconfigure(nextSettings, options?.forceRepickSystem ?? false))
      .catch((err: unknown) => {
        if (!this.closed) {
          this.onIssue(
            'AUDIO_RECONFIGURE_FAILED',
            err instanceof Error ? err.message : '切换音频源失败'
          );
        }
      });
    return this.opChain;
  }

  private async applyReconfigure(
    next: AudioRuntimeSettings,
    forceRepickSystem: boolean
  ): Promise<void> {
    if (this.closed) return;
    const prev = this.currentSettings;
    this.currentSettings = { ...next };

    if (next.enableWebrtcAec3 && !this.aec3ModuleLoaded) {
      await this.ensureAec3Loaded();
    }

    const useCustomAec3 = Boolean(
      next.micEnabled && next.systemAudioEnabled && next.enableWebrtcAec3
    );

    // 1. Update Microphone Slot
    if (!next.micEnabled) {
      this.releaseMicSlot();
    } else {
      const nextMicDev = next.audioDeviceId || 'default';
      const needsNewMic =
        !this.micSlot ||
        this.micSlot.track.readyState !== 'live' ||
        this.micSlot.deviceId !== nextMicDev ||
        this.micSlot.customAec3Mode !== useCustomAec3;
      if (needsNewMic) {
        const newMic = await this.acquireMicSlot(nextMicDev, useCustomAec3);
        if (this.closed) {
          stopStream(newMic.stream);
          return;
        }
        this.releaseMicSlot();
        this.attachMicSlot(newMic);
      } else if (this.micSlot) {
        this.micSlot.track.enabled = this.running;
      }
    }

    // 2. Update System Audio Slot
    if (!next.systemAudioEnabled) {
      this.releaseSysSlot();
    } else {
      const nextSysDev = next.systemAudioDeviceId || 'default';
      const wasapiOk = await checkWasapiSupport();
      const needsNewSys =
        forceRepickSystem ||
        !this.sysSlot ||
        this.sysSlot.deviceId !== nextSysDev ||
        (this.sysSlot.track && this.sysSlot.track.readyState !== 'live') ||
        (this.sysSlot.socket && this.sysSlot.socket.readyState >= WebSocket.CLOSING) ||
        prev.systemAudioDeviceId !== nextSysDev;

      if (needsNewSys) {
        const newSys = await this.acquireSystemSlot(nextSysDev, wasapiOk);
        if (this.closed) {
          this.cleanupDetachedSysSlot(newSys);
          return;
        }
        this.releaseSysSlot();
        this.attachSysSlot(newSys);
      } else if (this.sysSlot?.track) {
        this.sysSlot.track.enabled = this.running;
      }
    }

    this.syncWorkletChannels();
  }

  private async ensureAec3Loaded(): Promise<void> {
    if (this.aec3ModuleLoaded || this.closed || IS_MOCK_MODE) return;
    try {
      const jsUrl = `${API_BASE_URL}/addons/webrtc-aec3/worklet-lib.js`;
      const wasmUrl = `${API_BASE_URL}/addons/webrtc-aec3/module.wasm`;
      const [, wasmResp] = await Promise.all([
        this.context.audioWorklet.addModule(jsUrl),
        fetch(wasmUrl),
      ]);
      if (!wasmResp.ok) {
        throw new Error('WebRTC AEC3 模块文件未就绪');
      }
      const wasmBinary = await wasmResp.arrayBuffer();
      if (this.closed) return;
      this.processor.port.postMessage({ type: 'init-aec3', wasmBinary }, [wasmBinary]);
      this.aec3ModuleLoaded = true;
    } catch (err) {
      this.onIssue(
        'AEC3_LOAD_FAILED',
        err instanceof Error ? `回声消除模块加载失败：${err.message}` : '回声消除模块加载失败'
      );
    }
  }

  private async acquireMicSlot(
    deviceId: string,
    useCustomAec3: boolean,
    signal?: AbortSignal
  ): Promise<MicSlot> {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      throw new Error('当前环境不支持麦克风采集。');
    }
    const buildConstraints = (exactDeviceId?: string): MediaStreamConstraints => ({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: !useCustomAec3,
        noiseSuppression: true,
        autoGainControl: true,
        ...(exactDeviceId && exactDeviceId !== 'default'
          ? { deviceId: { exact: exactDeviceId } }
          : {}),
      },
    });

    let stream: MediaStream;
    if (deviceId.startsWith('{0.0.')) {
      // Resolve Windows WASAPI endpoint GUID to matching browser MediaDeviceInfo via FriendlyName
      stream = await media.getUserMedia(buildConstraints(undefined));
      try {
        const [nativeInfo, browserDevs] = await Promise.all([
          api.getNativeAudioDevices(),
          media.enumerateDevices(),
        ]);
        const targetEp = nativeInfo.inputs.find((ep) => ep.id === deviceId || ep.rawId === deviceId);
        if (targetEp) {
          const matched = browserDevs.find(
            (d) =>
              d.kind === 'audioinput' &&
              d.deviceId !== 'default' &&
              d.deviceId !== 'communications' &&
              d.label.trim().toLowerCase().includes(targetEp.name.trim().toLowerCase())
          );
          if (matched) {
            stopStream(stream);
            stream = await media.getUserMedia(buildConstraints(matched.deviceId));
          }
        }
      } catch {
        // Keep unlocked default stream if resolution fails
      }
    } else {
      try {
        stream = await media.getUserMedia(buildConstraints(deviceId));
      } catch (err) {
        if (deviceId && deviceId !== 'default') {
          stream = await media.getUserMedia(buildConstraints(undefined));
          this.onIssue('MIC_FALLBACK_DEFAULT', '所选麦克风不可用，已自动切换至系统默认麦克风。');
        } else {
          throw err instanceof Error ? err : new Error('无法获取麦克风权限或设备。');
        }
      }
    }

    if (signal?.aborted) {
      stopStream(stream);
      throw new DOMException('Aborted', 'AbortError');
    }
    const track = stream.getAudioTracks().find((t) => t.readyState === 'live');
    if (!track) {
      stopStream(stream);
      throw new Error('未检测到有效的麦克风音频轨道。');
    }
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    return { stream, track, source, deviceId, customAec3Mode: useCustomAec3 };
  }

  private async acquireSystemSlot(
    deviceId: string,
    wasapiOk: boolean,
    signal?: AbortSignal
  ): Promise<SysSlot> {
    // 1) Virtual input source (e.g. VB-Cable Output / Stereo Mix)
    if (deviceId.startsWith('input:')) {
      const rawId = deviceId.slice('input:'.length);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: rawId },
          channelCount: { ideal: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (signal?.aborted) {
        stopStream(stream);
        throw new DOMException('Aborted', 'AbortError');
      }
      const track = stream.getAudioTracks().find((t) => t.readyState === 'live');
      if (!track) {
        stopStream(stream);
        throw new Error('所选虚拟内录输入源无可用音频轨道。');
      }
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      return {
        mode: 'input',
        deviceId,
        stream,
        track,
        source,
        socket: null,
      };
    }

    // 2) Windows WASAPI Loopback (default, communications, or specific speaker endpoint)
    const wantsWasapi =
      wasapiOk &&
      (deviceId === 'default' ||
        deviceId === 'communications' ||
        deviceId.startsWith('wasapi:'));

    if (wantsWasapi) {
      try {
        const socket = await this.openWasapiLoopbackSocket(deviceId, signal);
        return {
          mode: 'wasapi',
          deviceId,
          stream: null,
          track: null,
          source: null,
          socket,
        };
      } catch (err) {
        if (deviceId !== 'default') {
          throw err;
        }
        // If WASAPI default failed unexpectedly, fall through to browser display-share
      }
    }

    // 3) Browser / WebView display media system audio share
    const media = navigator.mediaDevices;
    if (!media?.getDisplayMedia) {
      throw new Error('当前环境不支持屏幕或窗口共享内录。');
    }
    const displayOptions: DisplayMediaStreamOptions & { systemAudio: 'include' } = {
      video: true,
      audio: true,
      systemAudio: 'include',
    };
    const stream = await media.getDisplayMedia(displayOptions);
    if (signal?.aborted) {
      stopStream(stream);
      throw new DOMException('Aborted', 'AbortError');
    }
    const track = stream.getAudioTracks().find((t) => t.readyState === 'live');
    if (!track) {
      stopStream(stream);
      throw new Error('未勾选「同时共享系统音频」，请在共享弹窗中开启音频后重试。');
    }
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    return {
      mode: 'display-share',
      deviceId,
      stream,
      track,
      source,
      socket: null,
    };
  }

  private openWasapiLoopbackSocket(
    deviceId: string,
    signal?: AbortSignal
  ): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        `${getWsBaseUrl()}/audio/loopback?deviceId=${encodeURIComponent(deviceId)}`
      );
      ws.binaryType = 'arraybuffer';
      let settled = false;

      const onAbort = () => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(ws);
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('连接系统音频内录服务失败'));
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('系统音频内录通道未能建立'));
        }
      };
    });
  }

  private attachMicSlot(slot: MicSlot): void {
    slot.source.connect(this.processor, 0, 0);
    slot.track.enabled = this.running;
    slot.track.addEventListener(
      'ended',
      () => {
        if (this.closed || this.micSlot !== slot) return;
        this.releaseMicSlot();
        this.syncWorkletChannels();
        if (!this.sysSlot && !this.currentSettings.systemAudioEnabled) {
          this.onEnded();
        } else {
          this.onIssue('MIC_SOURCE_ENDED', '麦克风连接已断开，可在顶部音频源图标重新选择设备。');
        }
      },
      { once: true }
    );
    this.micSlot = slot;
  }

  private releaseMicSlot(): void {
    const slot = this.micSlot;
    if (!slot) return;
    this.micSlot = null;
    try {
      slot.source.disconnect();
    } catch {
      // ignore
    }
    stopStream(slot.stream);
  }

  private attachSysSlot(slot: SysSlot): void {
    if (slot.source) {
      slot.source.connect(this.processor, 0, 1);
    }
    if (slot.track) {
      slot.track.enabled = this.running;
      slot.track.addEventListener(
        'ended',
        () => {
          if (this.closed || this.sysSlot !== slot) return;
          this.releaseSysSlot();
          this.syncWorkletChannels();
          if (!this.micSlot && !this.currentSettings.micEnabled) {
            this.onEnded();
          } else {
            this.onIssue('SYS_SOURCE_ENDED', '系统音频共享已停止，其余音频源继续录制。');
          }
        },
        { once: true }
      );
    }
    if (slot.socket) {
      slot.socket.onmessage = (evt) => {
        if (this.closed || this.sysSlot !== slot || !this.running) return;
        if (evt.data instanceof ArrayBuffer) {
          this.processor.port.postMessage(
            { type: 'sys-pcm', pcm: evt.data },
            [evt.data]
          );
        } else if (typeof evt.data === 'string') {
          try {
            const msg = JSON.parse(evt.data) as {
              type?: string;
              payload?: { message?: string };
            };
            if (msg.type === 'error' && msg.payload?.message) {
              this.onIssue('WASAPI_CAPTURE_FAILED', msg.payload.message);
            }
          } catch {
            // ignore
          }
        }
      };
      slot.socket.onclose = () => {
        if (this.closed || this.sysSlot !== slot) return;
        this.releaseSysSlot();
        this.syncWorkletChannels();
        if (this.running) {
          this.onIssue('WASAPI_SOCKET_CLOSED', '系统播放设备内录连接已断开，可重新选择音频源。');
        }
      };
    }
    this.sysSlot = slot;
  }

  private cleanupDetachedSysSlot(slot: SysSlot): void {
    try {
      slot.source?.disconnect();
    } catch {
      // ignore
    }
    if (slot.socket) {
      slot.socket.onclose = null;
      slot.socket.onmessage = null;
      slot.socket.close();
    }
    stopStream(slot.stream);
  }

  private releaseSysSlot(): void {
    const slot = this.sysSlot;
    if (!slot) return;
    this.sysSlot = null;
    this.cleanupDetachedSysSlot(slot);
  }

  private syncWorkletChannels(): void {
    const micMuted = !this.currentSettings.micEnabled || !this.micSlot;
    const sysMuted = !this.currentSettings.systemAudioEnabled || !this.sysSlot;
    const sysMode: 'wasapi' | 'webaudio' | 'none' = !this.sysSlot
      ? 'none'
      : this.sysSlot.mode === 'wasapi'
        ? 'wasapi'
        : 'webaudio';
    const aec3Enabled = Boolean(
      this.currentSettings.enableWebrtcAec3 && !micMuted && !sysMuted
    );

    this.processor.port.postMessage({
      type: 'channels',
      micMuted,
      sysMuted,
      sysMode,
      aec3Enabled,
    });

    this.telemetry = {
      ...this.telemetry,
      micLevel: micMuted ? 0 : this.telemetry.micLevel,
      sysLevel: sysMuted ? 0 : this.telemetry.sysLevel,
      aec3Active: this.running && aec3Enabled && this.aec3Ready,
      activeSysMode: this.sysSlot ? this.sysSlot.mode : 'none',
    };
    this.onTelemetry?.(this.telemetry);
  }

  start(): void {
    this.running = true;
    if (this.micSlot) this.micSlot.track.enabled = true;
    if (this.sysSlot?.track) this.sysSlot.track.enabled = true;
    this.processor.port.postMessage({
      type: 'control',
      active: true,
      generation: ++this.generation,
    });
    this.syncWorkletChannels();
    void this.context.resume().catch(() => {});
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.micSlot) this.micSlot.track.enabled = false;
    if (this.sysSlot?.track) this.sysSlot.track.enabled = false;
    this.processor.port.postMessage({
      type: 'control',
      active: false,
      generation: ++this.generation,
    });
    if (this.length > 0) {
      this.onChunk(this.pending.buffer.slice(0, this.length));
      this.length = 0;
    }
    this.telemetry = {
      ...this.telemetry,
      micLevel: 0,
      sysLevel: 0,
      aec3Active: false,
    };
    this.onTelemetry?.(this.telemetry);
  }

  async captureSharedVideoFrame(): Promise<Blob | null> {
    const stream = this.sysSlot?.mode === 'display-share' ? this.sysSlot.stream : null;
    if (!stream) return null;
    const videoTrack = stream.getVideoTracks().find((t) => t.readyState === 'live');
    if (!videoTrack) return null;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    try {
      await video.play();
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, w, h);
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      });
    } catch {
      return null;
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pause();
    this.releaseMicSlot();
    this.releaseSysSlot();
    try {
      this.clockSource.stop();
      this.clockSource.disconnect();
    } catch {
      // ignore
    }
    try {
      this.processor.port.postMessage({ type: 'dispose' });
      this.processor.port.close();
    } catch {
      // ignore
    }
    if (this.context.state !== 'closed') {
      void this.context.close().catch(() => {});
    }
  }

  private collect(pcm: Uint8Array): void {
    if (!this.running) return;
    let offset = 0;
    while (offset < pcm.byteLength) {
      const count = Math.min(FRAME_BYTES - this.length, pcm.byteLength - offset);
      this.pending.set(pcm.subarray(offset, offset + count), this.length);
      this.length += count;
      offset += count;
      if (this.length === FRAME_BYTES) {
        this.onChunk(this.pending.buffer);
        this.pending = new Uint8Array(FRAME_BYTES);
        this.length = 0;
      }
    }
  }
}
