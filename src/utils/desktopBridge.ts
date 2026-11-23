import { useEffect, useState } from 'react';
import type { DesktopHotkeys } from '../types/domain';

export type DesktopWindowTarget = 'main' | 'mini';
export type DesktopPlatform = 'macos' | 'windows' | 'android' | 'web';

export interface AndroidBridgeRaw {
  getAppVersion?: () => string;
  hasRecordPermission?: () => boolean;
  requestRecordPermission?: (callbackId: string) => void;
  hasSystemAudioPermission?: () => boolean;
  requestSystemAudioPermission?: (callbackId: string) => void;
  hasOverlayPermission?: () => boolean;
  requestOverlayPermission?: (callbackId: string) => void;
  toggleFloatingOverlay?: () => boolean;
  isFloatingOverlayShowing?: () => boolean;
  captureBlackboardPhoto?: (callbackId: string) => void;
  shareExportedFile?: (fileName: string, mimeType: string, contentBase64: string) => boolean;
}

export interface AndroidOverlayBridgeRaw {
  moveBy?: (dxCssPx: number, dyCssPx: number) => void;
  resizeBy?: (dwCssPx: number, dhCssPx: number) => void;
  setCollapsed?: (collapsed: boolean) => void;
  setFocusable?: (focusable: boolean) => void;
  setAiExpanded?: (expanded: boolean) => void;
  closeOverlay?: () => void;
  openMainApp?: () => void;
}

export interface AndroidCameraResult {
  fileName?: string;
  mimeType?: string;
  base64?: string;
  cancelled?: boolean;
  error?: string;
}

const androidCallbacks = new Map<string, (payloadJson: string) => void>();
let androidCallbackSeq = 0;

if (typeof window !== 'undefined') {
  (window as unknown as { __zhilingAndroidResolve?: (id: string, json: string) => void }).__zhilingAndroidResolve = (
    id: string,
    payloadJson: string
  ) => {
    const fn = androidCallbacks.get(id);
    if (fn) {
      androidCallbacks.delete(id);
      fn(payloadJson);
    }
  };
}

function invokeAndroidCallback<T>(trigger: (cbId: string) => void, timeoutMs = 60_000): Promise<T | null> {
  return new Promise((resolve) => {
    const cbId = `acb_${Date.now()}_${++androidCallbackSeq}`;
    const timer = window.setTimeout(() => {
      if (androidCallbacks.delete(cbId)) {
        resolve(null);
      }
    }, timeoutMs);
    androidCallbacks.set(cbId, (rawJson) => {
      window.clearTimeout(timer);
      try {
        resolve(JSON.parse(rawJson) as T);
      } catch {
        resolve(null);
      }
    });
    try {
      trigger(cbId);
    } catch {
      window.clearTimeout(timer);
      androidCallbacks.delete(cbId);
      resolve(null);
    }
  });
}
export type DesktopWindowOpMode =
  | 'move'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se';

export interface MaximizeTransitionPlan {
  nativeHandled: boolean;
  maximized: boolean;
  dxPct?: number;
  dyPct?: number;
  scaleX?: number;
  scaleY?: number;
}

export interface DesktopBridgeApi {
  focus_main_window?: () => Promise<void>;
  minimize_window?: () => Promise<void>;
  toggle_maximize_window?: () => Promise<boolean>;
  prepare_maximize_transition?: () => Promise<MaximizeTransitionPlan>;
  commit_maximize_rect?: () => Promise<boolean>;
  commit_restore_rect?: () => Promise<boolean>;
  zoom_window?: () => Promise<MaximizeTransitionPlan>;
  is_window_maximized?: () => Promise<boolean>;
  close_window?: () => Promise<void>;
  toggle_mini_overlay?: () => Promise<boolean>;
  minimize_mini_overlay?: () => Promise<void>;
  close_mini_overlay?: () => Promise<void>;
  resize_mini_overlay?: (width: number, height: number) => Promise<boolean>;
  start_native_drag?: (target: DesktopWindowTarget) => Promise<boolean>;
  start_native_resize?: (
    target: DesktopWindowTarget,
    mode: Exclude<DesktopWindowOpMode, 'move'>
  ) => Promise<boolean>;
  begin_window_op?: (target: DesktopWindowTarget, mode: DesktopWindowOpMode) => Promise<boolean>;
  step_window_op?: () => Promise<void>;
  end_window_op?: () => Promise<void>;
  show_topmost_alert?: (
    title: string,
    message: string,
    canResume?: boolean
  ) => Promise<boolean>;
  save_exported_file?: (filename: string, contentBase64: string) => Promise<string | null>;
  quit_for_update?: () => Promise<boolean>;
  open_path_in_explorer?: (path: string) => Promise<boolean>;
}

export const IS_DESKTOP_SHELL_PARAM =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('shell') === 'desktop';

export function getDesktopPlatform(): DesktopPlatform {
  if (typeof window === 'undefined') return 'web';
  const param = new URLSearchParams(window.location.search).get('platform')?.toLowerCase();
  if (param === 'android') return 'android';
  if (param === 'macos' || param === 'mac' || param === 'darwin') return 'macos';
  if (param === 'windows' || param === 'win' || param === 'win32') return 'windows';

  if (getAndroidBridge()) return 'android';

  const nav = window.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const uaPlatform = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  if (uaPlatform.includes('android')) return 'android';
  if (uaPlatform.includes('mac')) return 'macos';
  if (uaPlatform.includes('win')) return 'windows';
  return 'web';
}

export function isMacPlatform(): boolean {
  return getDesktopPlatform() === 'macos';
}

export function isAndroidPlatform(): boolean {
  return getDesktopPlatform() === 'android';
}

export function getAndroidBridge(): AndroidBridgeRaw | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { ZhilingAndroid?: AndroidBridgeRaw };
  return win.ZhilingAndroid ?? null;
}

export function getAndroidOverlayBridge(): AndroidOverlayBridgeRaw | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { ZhilingOverlay?: AndroidOverlayBridgeRaw };
  return win.ZhilingOverlay ?? null;
}

export async function requestAndroidRecordPermission(): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (!bridge) return true;
  if (bridge.hasRecordPermission?.()) return true;
  if (!bridge.requestRecordPermission) return true;
  const res = await invokeAndroidCallback<{ granted?: boolean }>((cbId) =>
    bridge.requestRecordPermission?.(cbId)
  );
  return Boolean(res?.granted);
}

export async function requestAndroidSystemAudioPermission(): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (!bridge) return true;
  if (bridge.hasSystemAudioPermission?.()) return true;
  if (!bridge.requestSystemAudioPermission) return false;
  const res = await invokeAndroidCallback<{ granted?: boolean }>((cbId) =>
    bridge.requestSystemAudioPermission?.(cbId)
  );
  return Boolean(res?.granted);
}

export async function requestAndroidOverlayPermission(): Promise<boolean> {
  const bridge = getAndroidBridge();
  if (!bridge) return true;
  if (bridge.hasOverlayPermission?.()) return true;
  if (!bridge.requestOverlayPermission) return false;
  const res = await invokeAndroidCallback<{ granted?: boolean }>(
    (cbId) => bridge.requestOverlayPermission?.(cbId),
    120_000
  );
  return Boolean(res?.granted);
}

export async function captureAndroidBlackboardPhoto(): Promise<AndroidCameraResult | null> {
  const bridge = getAndroidBridge();
  if (!bridge?.captureBlackboardPhoto) return null;
  return invokeAndroidCallback<AndroidCameraResult>(
    (cbId) => bridge.captureBlackboardPhoto?.(cbId),
    120_000
  );
}

export interface ViewportLayoutState {
  width: number;
  height: number;
  isCompactWidth: boolean;
  isLandscape: boolean;
  isShortLandscape: boolean;
  /** 仅针对手机/窄屏/矮横屏的紧凑布局（平板 >=768px 且高度 >520px 按类桌面端体验处理） */
  isCompactPhoneLayout: boolean;
  /** Android 平板大屏（>=768px 且非矮横屏） */
  isTabletLayout: boolean;
  isMobileTouchLayout: boolean;
}

function readViewportLayout(): ViewportLayoutState {
  if (typeof window === 'undefined') {
    return {
      width: 1280,
      height: 800,
      isCompactWidth: false,
      isLandscape: true,
      isShortLandscape: false,
      isCompactPhoneLayout: false,
      isTabletLayout: false,
      isMobileTouchLayout: false,
    };
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  const isCompactWidth = width < 768;
  const isLandscape = width > height;
  const isShortLandscape = isLandscape && height <= 520;
  const isCompactPhoneLayout = isCompactWidth || isShortLandscape;
  const isTabletLayout = !isCompactPhoneLayout && isAndroidPlatform();
  const isMobileTouchLayout = isCompactPhoneLayout || isAndroidPlatform();
  return {
    width,
    height,
    isCompactWidth,
    isLandscape,
    isShortLandscape,
    isCompactPhoneLayout,
    isTabletLayout,
    isMobileTouchLayout,
  };
}

export function useViewportLayout(): ViewportLayoutState {
  const [layout, setLayout] = useState<ViewportLayoutState>(readViewportLayout);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let rafId: number | null = null;
    const sync = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const next = readViewportLayout();
        setLayout((prev) =>
          prev.width === next.width &&
          prev.height === next.height &&
          prev.isCompactWidth === next.isCompactWidth &&
          prev.isLandscape === next.isLandscape &&
          prev.isShortLandscape === next.isShortLandscape &&
          prev.isMobileTouchLayout === next.isMobileTouchLayout
            ? prev
            : next
        );
      });
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    window.addEventListener('zhiling:orientation-change', sync);
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      window.removeEventListener('zhiling:orientation-change', sync);
    };
  }, []);

  return layout;
}

export function useIsMobileViewport(): boolean {
  const { isCompactWidth } = useViewportLayout();
  return isCompactWidth;
}

export function getPasteShortcutLabel(): string {
  return isMacPlatform() ? '⌘V' : 'Ctrl+V';
}

export function getDefaultDesktopHotkeys(): DesktopHotkeys {
  const prefix = isMacPlatform() ? 'Option+Shift' : 'Alt+Shift';
  return {
    enabled: true,
    toggleRecording: `${prefix}+R`,
    toggleMicMute: `${prefix}+M`,
    captureScreenshot: `${prefix}+S`,
    bookmarkConfused: `${prefix}+B`,
    toggleMiniOverlay: `${prefix}+O`,
  };
}

export function formatShortcutLabel(combo: string): string {
  if (!combo) return '';
  if (!isMacPlatform()) {
    return combo
      .replace(/⌘/g, 'Win+')
      .replace(/⌥/g, 'Alt+')
      .replace(/⇧/g, 'Shift+')
      .replace(/⌃/g, 'Ctrl+')
      .replace(/\b(Option|Opt)\+/gi, 'Alt+')
      .replace(/\b(Cmd|Command)\+/gi, 'Win+');
  }
  return combo
    .replace(/\bAlt\+/gi, '⌥')
    .replace(/\bOpt\+/gi, '⌥')
    .replace(/\bOption\+/gi, '⌥')
    .replace(/\bShift\+/gi, '⇧')
    .replace(/\bCtrl\+/gi, '⌃')
    .replace(/\bControl\+/gi, '⌃')
    .replace(/\b(Cmd|Command|Meta|Win)\+/gi, '⌘')
    .replace(/\+/g, '');
}

/**
 * 将浏览器 KeyboardEvent 转换为后端与双端通用的标准快捷键字符串（需包含至少一个修饰键 + 非修饰主键）。
 */
export function keyboardEventToHotkeyCombo(e: KeyboardEvent): string | null {
  const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'Dead', 'Process']);
  if (modifierKeys.has(e.key)) return null;

  const mac = isMacPlatform();
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push(mac ? 'Option' : 'Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(mac ? 'Cmd' : 'Win');
  if (mods.length === 0) return null;

  // 优先用 e.code 还原物理字母/数字键，避免 macOS Option+R 产生 '®' 特殊字符
  let mainKey = '';
  if (/^Key([A-Z])$/.test(e.code)) {
    mainKey = e.code.slice(3);
  } else if (/^Digit([0-9])$/.test(e.code)) {
    mainKey = e.code.slice(5);
  } else if (/^F([1-9]|1[0-2])$/.test(e.code)) {
    mainKey = e.code;
  } else if (e.code === 'Space') {
    mainKey = 'Space';
  } else if (e.code === 'Tab') {
    mainKey = 'Tab';
  } else if (e.code === 'Enter') {
    mainKey = 'Enter';
  } else if (e.key.length === 1 && /^[a-zA-Z0-9]$/.test(e.key)) {
    mainKey = e.key.toUpperCase();
  }
  if (!mainKey) return null;

  return [...mods, mainKey].join('+');
}

export function isDesktopShell(): boolean {
  if (IS_DESKTOP_SHELL_PARAM) return true;
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { pywebview?: unknown }).pywebview);
}

export function getDesktopBridge(): DesktopBridgeApi | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { pywebview?: { api?: DesktopBridgeApi } };
  return win.pywebview?.api ?? null;
}

export function isInteractiveDragBlocker(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, input, textarea, select, a, [role="button"], [contenteditable="true"], .app-no-drag'
    )
  );
}
