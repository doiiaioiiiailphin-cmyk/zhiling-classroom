import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Aec3DownloadModal } from './components/classroom/Aec3DownloadModal';
import { BuiltinAsrDownloadModal } from './components/classroom/BuiltinAsrDownloadModal';
import { ClassroomView } from './components/classroom/ClassroomView';
import { SessionNotesExportModal } from './components/classroom/SessionNotesExportModal';
import { HomeWorkspace } from './components/home/HomeWorkspace';
import { ImportAudioModal } from './components/home/ImportAudioModal';
import {
  MiniOverlayView,
  OVERLAY_CHANNEL_NAME,
  type OverlayRemoteCommand,
  type OverlaySyncSnapshot,
} from './components/overlay/MiniOverlayView';
import { SettingsModal } from './components/settings/SettingsModal';
import { NoticeToast } from './components/ui/NoticeToast';
import { WindowResizeHandles } from './components/ui/WindowResizeHandles';
import { classroomSocket } from './services/classroomSocket';
import { useAppStore } from './store/useAppStore';
import {
  getDesktopBridge,
  isDesktopShell,
  isInteractiveDragBlocker,
} from './utils/desktopBridge';

const IS_MINI_OVERLAY_MODE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('mode') === 'mini';

if (typeof document !== 'undefined' && isDesktopShell() && !IS_MINI_OVERLAY_MODE) {
  document.documentElement.classList.add('desktop-shell-mode');
}

function buildOverlaySnapshot(): OverlaySyncSnapshot {
  const state = useAppStore.getState();
  const recentLines: OverlaySyncSnapshot['recentLines'] = [];
  for (const seg of state.segments) {
    for (const u of seg.utterances) {
      const txt = (u.refinedText || u.rawText).trim();
      if (txt) {
        recentLines.push({
          id: u.id,
          speaker: u.speakerLabel,
          text: txt,
          time: u.timestampText,
        });
      }
    }
  }

  return {
    sessionId: state.activeSession?.id ?? null,
    sessionTitle: state.activeSession?.title ?? '暂未打开课堂',
    isRecording: state.activeSession?.status === 'recording',
    durationSeconds: state.activeSession?.durationSeconds ?? 0,
    micEnabled: state.settings?.micEnabled ?? true,
    recentLines: recentLines.slice(-80),
    partialLine: state.livePartialUtterance
      ? {
          speaker: state.livePartialUtterance.speakerLabel,
          text: state.livePartialUtterance.text,
        }
      : null,
  };
}

export const App: React.FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const isLoadingHome = useAppStore((s) => s.isLoadingHome);
  const windowMaximized = useAppStore((s) => s.windowMaximized);
  const windowMotion = useAppStore((s) => s.windowMotion);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);
  const setWindowMotion = useAppStore((s) => s.setWindowMotion);
  const initialize = useAppStore((s) => s.initialize);

  const [inDesktopShell, setInDesktopShell] = useState<boolean>(() => isDesktopShell());

  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;
    void initialize();
  }, [initialize]);

  // 窗口首次打开轻盈浮入动画
  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;
    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(() => {
        setWindowMotion('idle');
      });
      return () => window.cancelAnimationFrame(raf2);
    });
    return () => window.cancelAnimationFrame(raf1);
  }, [setWindowMotion]);

  // 桌面端原生宿主就绪、最大化状态同步与任务栏还原弹簧动效
  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;

    const syncFromBridge = async () => {
      if (isDesktopShell()) {
        document.documentElement.classList.add('desktop-shell-mode');
        setInDesktopShell(true);
      }
      const bridge = getDesktopBridge();
      if (bridge?.is_window_maximized) {
        try {
          const isMax = await bridge.is_window_maximized();
          setWindowMaximized(Boolean(isMax));
        } catch {
          // ignore
        }
      }
    };

    const onMaximizedEvent = (evt: Event) => {
      const detail = (evt as CustomEvent<boolean>).detail;
      setWindowMaximized(Boolean(detail));
    };

    const restoreSmoothlyIfHidden = () => {
      const cur = useAppStore.getState().windowMotion;
      if (cur === 'minimized-hidden' || cur === 'minimizing') {
        window.requestAnimationFrame(() => {
          setWindowMotion('idle');
        });
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        restoreSmoothlyIfHidden();
      }
    };

    void syncFromBridge();
    window.addEventListener('pywebviewready', syncFromBridge);
    window.addEventListener('zhiling:window-maximized', onMaximizedEvent);
    window.addEventListener('zhiling:window-restored-from-min', restoreSmoothlyIfHidden);
    window.addEventListener('focus', restoreSmoothlyIfHidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pywebviewready', syncFromBridge);
      window.removeEventListener('zhiling:window-maximized', onMaximizedEvent);
      window.removeEventListener('zhiling:window-restored-from-min', restoreSmoothlyIfHidden);
      window.removeEventListener('focus', restoreSmoothlyIfHidden);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [setWindowMaximized, setWindowMotion]);

  // 主窗口与置顶迷你字幕窗实时状态同步总线 + Windows 全局快捷键响应
  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;

    const disconnectDesktop = classroomSocket.connectDesktopEvents((action) => {
      const st = useAppStore.getState();
      switch (action) {
        case 'toggleRecording':
          void st.toggleRecording();
          break;
        case 'toggleMicMute':
          if (st.settings) {
            void st.setMicChannel({ enabled: !st.settings.micEnabled });
          }
          break;
        case 'captureScreenshot':
          void st.captureClassroomScreen();
          break;
        case 'bookmarkConfused':
          void st.markConfusedNow();
          break;
        case 'toggleMiniOverlay':
          void st.toggleMiniOverlayWindow();
          break;
      }
    });

    if (typeof BroadcastChannel === 'undefined') {
      return disconnectDesktop;
    }

    const bc = new BroadcastChannel(OVERLAY_CHANNEL_NAME);
    const publishSnapshot = () => {
      bc.postMessage({ type: 'snapshot', snapshot: buildOverlaySnapshot() });
    };

    bc.onmessage = (evt: MessageEvent<OverlayRemoteCommand>) => {
      const cmd = evt.data;
      if (!cmd?.type) return;
      const st = useAppStore.getState();
      switch (cmd.type) {
        case 'request-snapshot':
          publishSnapshot();
          break;
        case 'toggle-recording':
          void st.toggleRecording();
          break;
        case 'toggle-mic':
          if (st.settings) {
            void st.setMicChannel({ enabled: !st.settings.micEnabled });
          }
          break;
        case 'capture-screen':
          void st.captureClassroomScreen();
          break;
        case 'bookmark-confused':
          void st.markConfusedNow();
          break;
      }
    };

    const unsubStore = useAppStore.subscribe(() => {
      publishSnapshot();
    });
    publishSnapshot();

    return () => {
      unsubStore();
      bc.close();
      disconnectDesktop();
    };
  }, []);

  // 顶栏空白区（.pywebview-drag-region）原生 Win32 500Hz 拖拽移动 & 双击最大化/窗口化还原
  const handleShellMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.detail > 1) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.pywebview-drag-region')) return;
    if (isInteractiveDragBlocker(target)) return;

    const bridge = getDesktopBridge();
    if (bridge?.start_native_drag) {
      e.preventDefault();
      void bridge.start_native_drag('main');
    }
  }, []);

  const handleShellDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.pywebview-drag-region')) return;
      if (isInteractiveDragBlocker(target)) return;

      const bridge = getDesktopBridge();
      if (bridge?.toggle_maximize_window) {
        e.preventDefault();
        setWindowMaximized(!windowMaximized);
        void bridge.toggle_maximize_window().then((nextMax) => {
          setWindowMaximized(Boolean(nextMax));
        });
      }
    },
    [windowMaximized, setWindowMaximized]
  );

  if (IS_MINI_OVERLAY_MODE) {
    return <MiniOverlayView />;
  }

  const motionTransformClass =
    windowMotion === 'minimized-hidden'
      ? 'opacity-0 scale-[0.95] translate-y-4 pointer-events-none transition-none'
      : windowMotion === 'minimizing'
        ? 'opacity-0 scale-[0.95] translate-y-4 pointer-events-none transition-[border-radius,transform,opacity] duration-155 ease-[cubic-bezier(0.4,0,1,1)]'
        : windowMotion === 'closing'
          ? 'opacity-0 scale-[0.95] translate-y-1.5 pointer-events-none transition-[border-radius,transform,opacity] duration-150 ease-[cubic-bezier(0.32,0,0.67,0)]'
          : windowMotion === 'entering'
            ? 'opacity-0 scale-[0.97] translate-y-2 transition-none'
            : 'opacity-100 scale-100 translate-y-0 transition-[border-radius,transform,opacity] duration-210 ease-[cubic-bezier(0.16,1,0.3,1)]';

  return (
    <div
      onMouseDown={handleShellMouseDown}
      onDoubleClick={handleShellDoubleClick}
      className={`h-screen w-screen overflow-hidden transition-[padding] duration-220 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        windowMaximized
          ? 'p-0 bg-transparent'
          : inDesktopShell
            ? 'p-0 bg-transparent'
            : 'p-2 bg-[#E3E6EC]'
      }`}
    >
      {inDesktopShell && (
        <WindowResizeHandles target="main" disabled={windowMaximized} />
      )}

      <div
        className={`h-full w-full overflow-hidden flex flex-col bg-[#F5F6F7] origin-center ${motionTransformClass} ${
          windowMaximized
            ? 'rounded-none border-0'
            : inDesktopShell
              ? 'rounded-[16px] border border-[#CFD4DC]'
              : 'rounded-[16px] border border-[#CFD4DC] shadow-[0_12px_36px_rgba(31,35,41,0.12)]'
        }`}
      >
        {isLoadingHome ? (
          <div className="h-full w-full flex items-center justify-center bg-[#F5F6F7] text-[#4E5969] gap-2.5 text-[15px]">
            <Loader2 className="w-5 h-5 animate-spin text-[#1456F0]" />
            <span>正在载入课堂工作台...</span>
          </div>
        ) : activeView === 'classroom' ? (
          <ClassroomView />
        ) : (
          <HomeWorkspace />
        )}
      </div>

      <SettingsModal />
      <Aec3DownloadModal />
      <SessionNotesExportModal />
      <ImportAudioModal />
      <BuiltinAsrDownloadModal />
      <NoticeToast />
    </div>
  );
};
