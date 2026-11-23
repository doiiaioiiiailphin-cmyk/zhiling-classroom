import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Aec3DownloadModal } from './components/classroom/Aec3DownloadModal';
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
import { MobilePreviewFloatingOverlay } from './components/overlay/MobilePreviewFloatingOverlay';
import { SettingsModal } from './components/settings/SettingsModal';
import { AddonDownloadModal } from './components/ui/AddonDownloadModal';
import { NoticeToast } from './components/ui/NoticeToast';
import { UpdateCornerPopup } from './components/ui/UpdateCornerPopup';
import { WindowResizeHandles } from './components/ui/WindowResizeHandles';
import { classroomSocket } from './services/classroomSocket';
import { useAppStore } from './store/useAppStore';
import {
  getDesktopBridge,
  isAndroidPlatform,
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
    recentMessages: state.messages.slice(-24).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
    })),
  };
}

export const App: React.FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const isLoadingHome = useAppStore((s) => s.isLoadingHome);
  const windowMaximized = useAppStore((s) => s.windowMaximized);
  const windowMotion = useAppStore((s) => s.windowMotion);
  const previewFloatingOverlayOpen = useAppStore((s) => s.previewFloatingOverlayOpen);
  const setPreviewFloatingOverlayOpen = useAppStore((s) => s.setPreviewFloatingOverlayOpen);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);
  const setWindowMotion = useAppStore((s) => s.setWindowMotion);
  const initialize = useAppStore((s) => s.initialize);
  const checkForAppUpdates = useAppStore((s) => s.checkForAppUpdates);

  const [inDesktopShell, setInDesktopShell] = useState<boolean>(() => isDesktopShell());
  const [isFlipping, setIsFlipping] = useState(false);
  const [previewOverlaySnap, setPreviewOverlaySnap] = useState<OverlaySyncSnapshot>(() =>
    buildOverlaySnapshot()
  );
  const shellRef = useRef<HTMLDivElement | null>(null);
  const flipBusyRef = useRef(false);
  const flipTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;
    void initialize();
    // 启动后延迟 2.5 秒后台静默检查 CNB 最新版本，发现新版本时自动在右下角弹出更新卡片
    const updateTimer = window.setTimeout(() => {
      void checkForAppUpdates({ silent: true });
    }, 2500);
    return () => window.clearTimeout(updateTimer);
  }, [initialize, checkForAppUpdates]);

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

  // 主窗口与置顶迷你字幕窗实时状态同步总线 + 跨平台全局快捷键 & 外力暂停恢复指令响应
  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;

    const seenCmdIds = new Set<string>();
    const handleRemoteOverlayCommand = (cmd: OverlayRemoteCommand) => {
      if (!cmd?.type) return;
      if (cmd.cmdId) {
        if (seenCmdIds.has(cmd.cmdId)) return;
        seenCmdIds.add(cmd.cmdId);
        if (seenCmdIds.size > 120) {
          const oldest = seenCmdIds.values().next().value;
          if (oldest) seenCmdIds.delete(oldest);
        }
      }
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
        case 'chat-updated':
          if (cmd.sessionId) {
            void st.syncSessionMessagesFromRemote(cmd.sessionId);
          }
          break;
      }
    };

    const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(OVERLAY_CHANNEL_NAME) : null;
    let lastSnapSig = '';
    let lastSnapSentAt = 0;
    let snapTimer: number | null = null;

    const getSnapshotSig = () => {
      const s = useAppStore.getState();
      const segCount = s.segments.length;
      const lastSeg = segCount > 0 ? s.segments[segCount - 1] : null;
      const lastUtt = lastSeg && lastSeg.utterances.length > 0
        ? lastSeg.utterances[lastSeg.utterances.length - 1]
        : null;
      const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1] : null;
      return [
        s.activeSession?.id ?? '',
        s.activeSession?.status ?? '',
        s.activeSession?.durationSeconds ?? 0,
        s.settings?.micEnabled ?? true,
        segCount,
        lastUtt?.id ?? '',
        lastUtt?.refinedText?.length ?? 0,
        s.livePartialUtterance?.text ?? '',
        s.messages.length,
        lastMsg?.id ?? '',
        lastMsg?.content?.length ?? 0,
      ].join('|');
    };

    const publishSnapshot = (force = false) => {
      const sig = getSnapshotSig();
      if (!force && sig === lastSnapSig) return;
      const now = Date.now();
      const emit = () => {
        snapTimer = null;
        lastSnapSig = getSnapshotSig();
        lastSnapSentAt = Date.now();
        const snap = buildOverlaySnapshot();
        setPreviewOverlaySnap(snap);
        bc?.postMessage({ type: 'snapshot', snapshot: snap });
        classroomSocket.sendOverlaySnapshot(snap);
      };
      if (force || now - lastSnapSentAt >= 380) {
        if (snapTimer !== null) {
          window.clearTimeout(snapTimer);
          snapTimer = null;
        }
        emit();
      } else if (snapTimer === null) {
        snapTimer = window.setTimeout(emit, 380 - (now - lastSnapSentAt));
      }
    };

    if (bc) {
      bc.onmessage = (evt: MessageEvent<OverlayRemoteCommand>) => {
        if (evt.data?.type === 'request-snapshot') {
          publishSnapshot(true);
          return;
        }
        handleRemoteOverlayCommand(evt.data);
      };
    }

    const disconnectDesktop = classroomSocket.connectDesktopEvents(
      (action) => {
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
      },
      {
        onOverlayCommand: (rawCmd) => {
          const cmd = rawCmd as OverlayRemoteCommand;
          if (cmd?.type === 'request-snapshot') {
            publishSnapshot(true);
            return;
          }
          handleRemoteOverlayCommand(cmd);
        },
      }
    );

    const handleAlertResume = () => {
      const st = useAppStore.getState();
      if (st.activeSession && st.activeSession.status !== 'recording') {
        void st.toggleRecording();
      }
    };
    const handlePreviewOverlayCmd = (evt: Event) => {
      const detail = (evt as CustomEvent<OverlayRemoteCommand>).detail;
      if (detail) handleRemoteOverlayCommand(detail);
    };
    window.addEventListener('zhiling:alert-resume-recording', handleAlertResume);
    window.addEventListener('zhiling:preview-overlay-cmd', handlePreviewOverlayCmd);

    const unsubStore = useAppStore.subscribe(() => {
      publishSnapshot(false);
    });
    publishSnapshot(true);

    return () => {
      if (snapTimer !== null) {
        window.clearTimeout(snapTimer);
        snapTimer = null;
      }
      window.removeEventListener('zhiling:alert-resume-recording', handleAlertResume);
      window.removeEventListener('zhiling:preview-overlay-cmd', handlePreviewOverlayCmd);
      unsubStore();
      bc?.close();
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

  const runSmoothMaximizeOrZoom = useCallback(
    async (mode: 'fullscreen' | 'zoom') => {
      if (flipBusyRef.current) return;
      const bridge = getDesktopBridge();
      if (!bridge) {
        setWindowMaximized(!useAppStore.getState().windowMaximized);
        return;
      }

      const caller =
        mode === 'zoom' && bridge.zoom_window
          ? bridge.zoom_window
          : bridge.prepare_maximize_transition;

      if (!caller) {
        if (bridge.toggle_maximize_window) {
          const nextMax = await bridge.toggle_maximize_window();
          setWindowMaximized(Boolean(nextMax));
        }
        return;
      }

      flipBusyRef.current = true;
      if (flipTimerRef.current !== null) {
        window.clearTimeout(flipTimerRef.current);
        flipTimerRef.current = null;
      }

      try {
        const plan = await caller();
        if (!plan || plan.nativeHandled) {
          setWindowMaximized(Boolean(plan?.maximized));
          flipBusyRef.current = false;
          return;
        }

        const dxPct = plan.dxPct ?? 0;
        const dyPct = plan.dyPct ?? 0;
        const sx = plan.scaleX ?? 0.88;
        const sy = plan.scaleY ?? 0.88;
        const el = shellRef.current;

        const clearInlineFlip = (node: HTMLDivElement | null) => {
          if (!node) return;
          node.style.transition = 'none';
          node.style.transformOrigin = '';
          node.style.transform = '';
          node.style.borderRadius = '';
          node.style.willChange = '';
          void node.offsetWidth;
          node.style.transition = '';
        };

        if (!el) {
          if (plan.maximized) {
            await bridge.commit_maximize_rect?.();
            setWindowMaximized(true);
          } else {
            await bridge.commit_restore_rect?.();
            setWindowMaximized(false);
          }
          flipBusyRef.current = false;
          return;
        }

        setIsFlipping(true);

        if (plan.maximized) {
          // 1. 先挂同步 resize 钩子再扩容透明宿主：Chromium 在新尺寸绘制首帧前触发 resize，
          //    同帧直接把反向 FLIP 矩阵写进 DOM，像素级锁死旧浮动位置（零闪烁、零左上角飞跃！）
          let started = false;
          let fallbackTimer: number | null = null;
          const startExpand = () => {
            if (started) return;
            started = true;
            window.removeEventListener('resize', startExpand);
            if (fallbackTimer !== null) {
              window.clearTimeout(fallbackTimer);
              fallbackTimer = null;
            }
            el.style.transition = 'none';
            el.style.transformOrigin = '0 0';
            el.style.transform = `translate3d(${dxPct}%, ${dyPct}%, 0) scale(${sx}, ${sy})`;
            el.style.borderRadius = '16px';
            el.style.willChange = 'transform, border-radius';
            void el.offsetWidth;
            setWindowMaximized(true);

            window.requestAnimationFrame(() => {
              el.style.transition =
                'transform 250ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 250ms cubic-bezier(0.22, 1, 0.36, 1)';
              el.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
              el.style.borderRadius = '0px';
              flipTimerRef.current = window.setTimeout(() => {
                clearInlineFlip(el);
                setIsFlipping(false);
                flipBusyRef.current = false;
              }, 265);
            });
          };

          window.addEventListener('resize', startExpand, { once: true });
          fallbackTimer = window.setTimeout(startExpand, 80);
          void bridge.commit_maximize_rect?.();
        } else {
          // 还原：透明全屏画布内 GPU 丝滑缩回原浮动圆角坐标，随后挂同步 resize 钩子再原子收回 HWND（零末帧回弹闪烁！）
          el.style.transition = 'none';
          el.style.transformOrigin = '0 0';
          el.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
          el.style.borderRadius = '0px';
          el.style.willChange = 'transform, border-radius';
          void el.offsetWidth;

          window.requestAnimationFrame(() => {
            el.style.transition =
              'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), border-radius 220ms cubic-bezier(0.22, 1, 0.36, 1)';
            el.style.transform = `translate3d(${dxPct}%, ${dyPct}%, 0) scale(${sx}, ${sy})`;
            el.style.borderRadius = '16px';

            flipTimerRef.current = window.setTimeout(() => {
              let finalized = false;
              let fallbackTimer: number | null = null;
              const finalizeRestore = () => {
                if (finalized) return;
                finalized = true;
                window.removeEventListener('resize', finalizeRestore);
                if (fallbackTimer !== null) {
                  window.clearTimeout(fallbackTimer);
                  fallbackTimer = null;
                }
                clearInlineFlip(el);
                setWindowMaximized(false);
                setIsFlipping(false);
                flipBusyRef.current = false;
              };
              window.addEventListener('resize', finalizeRestore, { once: true });
              fallbackTimer = window.setTimeout(finalizeRestore, 80);
              void bridge.commit_restore_rect?.();
            }, 225);
          });
        }
      } catch {
        if (shellRef.current) {
          shellRef.current.style.transition = '';
          shellRef.current.style.transform = '';
          shellRef.current.style.borderRadius = '';
          shellRef.current.style.transformOrigin = '';
          shellRef.current.style.willChange = '';
        }
        setIsFlipping(false);
        flipBusyRef.current = false;
      }
    },
    [setWindowMaximized]
  );

  useEffect(() => {
    if (IS_MINI_OVERLAY_MODE) return;
    const onTriggerMax = (evt: Event) => {
      const detail = (evt as CustomEvent<{ mode?: 'fullscreen' | 'zoom' } | boolean>).detail;
      const mode = typeof detail === 'object' && detail?.mode === 'zoom' ? 'zoom' : 'fullscreen';
      void runSmoothMaximizeOrZoom(mode);
    };
    window.addEventListener('zhiling:trigger-maximize', onTriggerMax);
    return () => {
      window.removeEventListener('zhiling:trigger-maximize', onTriggerMax);
      if (flipTimerRef.current !== null) {
        window.clearTimeout(flipTimerRef.current);
      }
    };
  }, [runSmoothMaximizeOrZoom]);

  const handleShellDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.pywebview-drag-region')) return;
      if (isInteractiveDragBlocker(target)) return;

      const bridge = getDesktopBridge();
      if (bridge?.zoom_window || bridge?.prepare_maximize_transition || bridge?.toggle_maximize_window) {
        e.preventDefault();
        void runSmoothMaximizeOrZoom('zoom');
      }
    },
    [runSmoothMaximizeOrZoom]
  );

  const isAndroid = isAndroidPlatform();

  // Android 物理/手势返回键智能分层接管：弹窗 -> 便签 -> 退出课堂 -> 退出文件夹 -> 后台最小化
  useEffect(() => {
    if (!isAndroid || IS_MINI_OVERLAY_MODE) return;
    const handler = (): boolean => {
      const s = useAppStore.getState();
      if (s.settingsOpen) {
        const settingsBack = (
          window as unknown as { __zhilingHandleSettingsBack?: () => boolean }
        ).__zhilingHandleSettingsBack;
        if (settingsBack?.()) {
          return true;
        }
        s.setSettingsOpen(false);
        return true;
      }
      if (s.notesExportModal.open) {
        s.closeNotesExportModal();
        return true;
      }
      if (s.importAudioModalOpen) {
        s.setImportAudioModalOpen(false);
        return true;
      }
      if (s.activeView === 'classroom') {
        const win = window as unknown as {
          __zhilingHandleUtteranceSheetBack?: () => boolean;
          __zhilingHandleClassroomOverlayBack?: () => boolean;
          __zhilingHandleClassroomChatBack?: () => boolean;
        };
        if (win.__zhilingHandleUtteranceSheetBack?.()) {
          return true;
        }
        if (win.__zhilingHandleClassroomOverlayBack?.()) {
          return true;
        }
        if (s.stickyNotes.some((n) => n.isOpen)) {
          void s.setAllStickyNotesOpen(false);
          return true;
        }
        if (win.__zhilingHandleClassroomChatBack?.()) {
          return true;
        }
        void s.leaveClassroom();
        return true;
      }
      if (s.currentFolderId !== null) {
        const curFolder = s.folders.find((f) => f.id === s.currentFolderId);
        s.setCurrentFolderId(curFolder?.parentId ?? null);
        return true;
      }
      return false;
    };
    (window as unknown as { __zhilingHandleAndroidBack?: () => boolean }).__zhilingHandleAndroidBack = handler;
    return () => {
      delete (window as unknown as { __zhilingHandleAndroidBack?: () => boolean }).__zhilingHandleAndroidBack;
    };
  }, [isAndroid]);

  if (IS_MINI_OVERLAY_MODE) {
    return <MiniOverlayView />;
  }

  const motionTransformClass =
    windowMotion === 'minimized-hidden'
      ? 'opacity-0 scale-[0.92] translate-y-5 pointer-events-none transition-none will-change-transform'
      : windowMotion === 'minimizing'
        ? 'opacity-0 scale-[0.92] translate-y-5 pointer-events-none transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform'
        : windowMotion === 'closing'
          ? 'opacity-0 scale-[0.94] translate-y-1.5 pointer-events-none transition-[transform,opacity] duration-180 ease-[cubic-bezier(0.32,0,0.67,0)] will-change-transform'
          : windowMotion === 'entering'
            ? 'opacity-0 scale-[0.97] translate-y-2 transition-none'
            : 'opacity-100 scale-100 translate-y-0 transition-[transform,opacity] duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]';

  return (
    <div
      onMouseDown={handleShellMouseDown}
      onDoubleClick={handleShellDoubleClick}
      style={
        isAndroid
          ? {
              paddingTop: 'var(--android-safe-top, 0px)',
              paddingBottom: 'var(--android-safe-bottom, 0px)',
            }
          : undefined
      }
      className={`h-screen w-screen overflow-hidden ${
        isAndroid
          ? 'p-0 bg-white'
          : windowMaximized
            ? 'p-0 bg-transparent'
            : inDesktopShell
              ? 'p-0 bg-transparent'
              : 'p-2 bg-[#E3E6EC]'
      }`}
    >
      {inDesktopShell && !isAndroid && (
        <WindowResizeHandles target="main" disabled={windowMaximized} />
      )}

      <div
        ref={shellRef}
        className={`h-full w-full overflow-hidden flex flex-col bg-[#F5F6F7] origin-center ${
          isFlipping ? '' : motionTransformClass
        } ${
          isAndroid || windowMaximized
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
      <AddonDownloadModal />
      <MobilePreviewFloatingOverlay
        open={previewFloatingOverlayOpen}
        snapshot={previewOverlaySnap}
        onClose={() => setPreviewFloatingOverlayOpen(false)}
      />
      <UpdateCornerPopup />
      <NoticeToast />
    </div>
  );
};
