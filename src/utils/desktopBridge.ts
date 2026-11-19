export type DesktopWindowTarget = 'main' | 'mini';
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
