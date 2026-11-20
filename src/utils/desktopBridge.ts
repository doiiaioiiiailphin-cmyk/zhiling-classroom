export type DesktopWindowTarget = 'main' | 'mini';
export type DesktopPlatform = 'macos' | 'windows' | 'web';
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

export interface DesktopBridgeApi {
  focus_main_window?: () => Promise<void>;
  minimize_window?: () => Promise<void>;
  toggle_maximize_window?: () => Promise<boolean>;
  is_window_maximized?: () => Promise<boolean>;
  close_window?: () => Promise<void>;
  toggle_mini_overlay?: () => Promise<boolean>;
  minimize_mini_overlay?: () => Promise<void>;
  close_mini_overlay?: () => Promise<void>;
  start_native_drag?: (target: DesktopWindowTarget) => Promise<boolean>;
  start_native_resize?: (
    target: DesktopWindowTarget,
    mode: Exclude<DesktopWindowOpMode, 'move'>
  ) => Promise<boolean>;
  begin_window_op?: (target: DesktopWindowTarget, mode: DesktopWindowOpMode) => Promise<boolean>;
  step_window_op?: () => Promise<void>;
  end_window_op?: () => Promise<void>;
}

export const IS_DESKTOP_SHELL_PARAM =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('shell') === 'desktop';

export function getDesktopPlatform(): DesktopPlatform {
  if (typeof window === 'undefined') return 'web';
  const param = new URLSearchParams(window.location.search).get('platform')?.toLowerCase();
  if (param === 'macos' || param === 'mac' || param === 'darwin') return 'macos';
  if (param === 'windows' || param === 'win' || param === 'win32') return 'windows';

  const nav = window.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const uaPlatform = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  if (uaPlatform.includes('mac')) return 'macos';
  if (uaPlatform.includes('win')) return 'windows';
  return 'web';
}

export function isMacPlatform(): boolean {
  return getDesktopPlatform() === 'macos';
}

export function formatShortcutLabel(combo: string): string {
  if (!isMacPlatform()) return combo;
  return combo
    .replace(/\bAlt\+/gi, '⌥')
    .replace(/\bOption\+/gi, '⌥')
    .replace(/\bShift\+/gi, '⇧')
    .replace(/\bCtrl\+/gi, '⌃')
    .replace(/\bControl\+/gi, '⌃')
    .replace(/\b(Cmd|Command|Meta|Win)\+/gi, '⌘');
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
