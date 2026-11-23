import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Camera,
  GripHorizontal,
  Loader2,
  MessageSquareText,
  Mic,
  MicOff,
  Minimize2,
  Minus,
  Pause,
  Play,
  SendHorizontal,
  X,
} from 'lucide-react';
import { api } from '../../services/api';
import { classroomSocket } from '../../services/classroomSocket';
import {
  getAndroidOverlayBridge,
  getDesktopBridge,
  isAndroidPlatform,
  isDesktopShell,
  isInteractiveDragBlocker,
  isMacPlatform,
} from '../../utils/desktopBridge';
import { formatDuration } from '../../utils/format';
import { MarkdownRenderer } from '../ui/MarkdownRenderer';
import { ThinkingDisclosure } from '../ui/ThinkingDisclosure';
import { Tooltip } from '../ui/Tooltip';
import { WindowResizeHandles } from '../ui/WindowResizeHandles';

export interface OverlayChatSummary {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
}

export interface OverlaySyncSnapshot {
  sessionId: string | null;
  sessionTitle: string;
  isRecording: boolean;
  durationSeconds: number;
  micEnabled: boolean;
  recentLines: Array<{ id: string; speaker: string; text: string; time: string }>;
  partialLine: { speaker: string; text: string } | null;
  recentMessages?: OverlayChatSummary[];
}

export type OverlayRemoteCommand =
  | { type: 'request-snapshot'; cmdId?: string }
  | { type: 'toggle-recording'; cmdId?: string }
  | { type: 'toggle-mic'; cmdId?: string }
  | { type: 'capture-screen'; cmdId?: string }
  | { type: 'bookmark-confused'; cmdId?: string }
  | { type: 'chat-updated'; sessionId: string; cmdId?: string };

export const OVERLAY_CHANNEL_NAME = 'zhiling-classroom-sync';

interface MiniChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
  isError?: boolean;
}

export interface MiniOverlayViewProps {
  embeddedPreview?: boolean;
  initialSnap?: OverlaySyncSnapshot;
  onRequestClose?: () => void;
  onPreviewMove?: (dx: number, dy: number) => void;
  onPreviewResize?: (dw: number, dh: number) => void;
  onPreviewCollapseChange?: (collapsed: boolean) => void;
  onPreviewAiExpandChange?: (expanded: boolean) => void;
}

const DEFAULT_SNAPSHOT: OverlaySyncSnapshot = {
  sessionId: null,
  sessionTitle: '等待主窗口进入课堂...',
  isRecording: false,
  durationSeconds: 0,
  micEnabled: true,
  recentLines: [],
  partialLine: null,
  recentMessages: [],
};

export const MiniOverlayView: React.FC<MiniOverlayViewProps> = ({
  embeddedPreview = false,
  initialSnap,
  onRequestClose,
  onPreviewMove,
  onPreviewResize,
  onPreviewCollapseChange,
  onPreviewAiExpandChange,
}) => {
  const isAndroid = isAndroidPlatform();
  const isMobileOverlay = isAndroid || embeddedPreview;
  const overlayBridge = getAndroidOverlayBridge();

  const [snap, setSnap] = useState<OverlaySyncSnapshot>(initialSnap ?? DEFAULT_SNAPSHOT);
  const [minimizedInBrowser, setMinimizedInBrowser] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<MiniChatItem[]>([]);
  const [chatDraft, setChatDraft] = useState('');
  const [isAiStreaming, setIsAiStreaming] = useState(false);
  const [motionState, setMotionState] = useState<
    'entering' | 'idle' | 'minimizing' | 'minimized-hidden' | 'closing'
  >(embeddedPreview ? 'idle' : 'entering');

  const channelRef = useRef<BroadcastChannel | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentStackRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const pinnedBottomRef = useRef<boolean>(true);
  const dragArmRef = useRef<{ startX: number; startY: number; active: boolean } | null>(null);
  const pointerDragRef = useRef<{
    mode: 'move' | 'resize' | 'bubble';
    lastX: number;
    lastY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const savedDesktopHeightRef = useRef<number | null>(null);
  const loadedChatSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (initialSnap) {
      setSnap(initialSnap);
    }
  }, [initialSnap]);

  const snapToBottomIfPinned = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !pinnedBottomRef.current) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }, []);

  const scrollChatToBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }, []);

  useEffect(() => {
    if (embeddedPreview) return;
    document.title = '知聆课堂 · 实时字幕';
    document.documentElement.classList.add('mini-overlay-mode');
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setMotionState('idle');
      });
    });
    const onRestore = () => {
      setMotionState((prev) =>
        prev === 'minimized-hidden' || prev === 'minimizing' ? 'idle' : prev
      );
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        onRestore();
      }
    };
    window.addEventListener('zhiling:window-restored-from-min', onRestore);
    window.addEventListener('focus', onRestore);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('zhiling:window-restored-from-min', onRestore);
      window.removeEventListener('focus', onRestore);
      document.removeEventListener('visibilitychange', onVis);
      document.documentElement.classList.remove('mini-overlay-mode');
    };
  }, [embeddedPreview]);

  useEffect(() => {
    if (embeddedPreview) return;
    const bc =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(OVERLAY_CHANNEL_NAME) : null;
    channelRef.current = bc;

    if (bc) {
      bc.onmessage = (evt: MessageEvent<{ type: 'snapshot'; snapshot: OverlaySyncSnapshot }>) => {
        if (evt.data?.type === 'snapshot' && evt.data.snapshot) {
          setSnap(evt.data.snapshot);
        }
      };
      bc.postMessage({ type: 'request-snapshot' } satisfies OverlayRemoteCommand);
    }

    // 通过 /ws/v1/desktop/events 同步中继，确保 macOS WKWebView 与 Android 独立悬浮窗 WebView 实时收发字幕快照与控制指令
    const disconnectWs = classroomSocket.connectDesktopEvents(() => {}, {
      onOverlaySnapshot: (raw) => {
        if (raw && typeof raw === 'object' && 'recentLines' in raw) {
          setSnap(raw as unknown as OverlaySyncSnapshot);
        }
      },
    });

    const retryTimer = window.setTimeout(() => {
      bc?.postMessage({ type: 'request-snapshot' } satisfies OverlayRemoteCommand);
      classroomSocket.sendOverlayCommand({ type: 'request-snapshot' } satisfies OverlayRemoteCommand);
    }, 350);

    return () => {
      window.clearTimeout(retryTimer);
      disconnectWs();
      bc?.close();
      channelRef.current = null;
    };
  }, [embeddedPreview]);

  // 同步当前课堂历史问答（不覆盖正在流式生成的消息）
  useEffect(() => {
    if (isAiStreaming) return;
    if (!snap.sessionId) {
      setChatMessages([]);
      loadedChatSessionRef.current = null;
      return;
    }
    if (snap.recentMessages && snap.recentMessages.length > 0) {
      loadedChatSessionRef.current = snap.sessionId;
      setChatMessages(
        snap.recentMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          thinking: m.thinking,
        }))
      );
      return;
    }
    if (aiOpen && loadedChatSessionRef.current !== snap.sessionId) {
      loadedChatSessionRef.current = snap.sessionId;
      void api
        .getSessionWorkspace(snap.sessionId)
        .then((ws) => {
          setChatMessages(
            ws.messages.slice(-24).map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              thinking: m.thinking,
            }))
          );
        })
        .catch(() => {});
    }
  }, [snap.sessionId, snap.recentMessages, aiOpen, isAiStreaming]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      snapToBottomIfPinned();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [snap.recentLines, snap.partialLine, minimizedInBrowser, collapsed, aiOpen, snapToBottomIfPinned]);

  useEffect(() => {
    if (!aiOpen) return;
    const raf = window.requestAnimationFrame(() => {
      scrollChatToBottom();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [aiOpen, chatMessages, scrollChatToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const stack = contentStackRef.current;
    if (!container || !stack || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      snapToBottomIfPinned();
    });
    ro.observe(container);
    ro.observe(stack);
    return () => ro.disconnect();
  }, [minimizedInBrowser, collapsed, aiOpen, snapToBottomIfPinned]);

  const sendRemote = useCallback((cmd: OverlayRemoteCommand) => {
    const tagged: OverlayRemoteCommand = {
      ...cmd,
      cmdId: cmd.cmdId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
    if (embeddedPreview) {
      window.dispatchEvent(new CustomEvent('zhiling:preview-overlay-cmd', { detail: tagged }));
      return;
    }
    channelRef.current?.postMessage(tagged);
    classroomSocket.sendOverlayCommand(tagged);
  }, [embeddedPreview]);

  const handleToggleAiChat = useCallback(() => {
    setAiOpen((prev) => {
      const next = !prev;
      if (isMobileOverlay) {
        overlayBridge?.setAiExpanded?.(next);
        if (!next) {
          overlayBridge?.setFocusable?.(false);
        }
        onPreviewAiExpandChange?.(next);
      } else {
        const bridge = getDesktopBridge();
        if (bridge?.resize_mini_overlay) {
          if (next) {
            savedDesktopHeightRef.current = window.innerHeight;
            void bridge.resize_mini_overlay(
              Math.max(window.innerWidth, 560),
              Math.max(window.innerHeight, 480)
            );
          } else if (savedDesktopHeightRef.current) {
            const restoreH = savedDesktopHeightRef.current;
            savedDesktopHeightRef.current = null;
            void bridge.resize_mini_overlay(window.innerWidth, restoreH);
          }
        }
      }
      return next;
    });
  }, [isMobileOverlay, overlayBridge, onPreviewAiExpandChange]);

  const handleToggleCollapse = useCallback(
    (nextCollapsed: boolean) => {
      setCollapsed(nextCollapsed);
      if (nextCollapsed) {
        overlayBridge?.setFocusable?.(false);
      }
      overlayBridge?.setCollapsed?.(nextCollapsed);
      onPreviewCollapseChange?.(nextCollapsed);
    },
    [overlayBridge, onPreviewCollapseChange]
  );

  const handleMinimize = async () => {
    if (isMobileOverlay) {
      handleToggleCollapse(true);
      return;
    }
    const bridge = getDesktopBridge();
    if (bridge?.minimize_mini_overlay) {
      if (isMacPlatform()) {
        void bridge.minimize_mini_overlay();
        return;
      }
      setMotionState('minimizing');
      window.setTimeout(() => {
        setMotionState('minimized-hidden');
        void bridge.minimize_mini_overlay?.();
      }, 200);
      return;
    }
    setMinimizedInBrowser((prev) => !prev);
  };

  const handleClose = async () => {
    if (onRequestClose) {
      onRequestClose();
      return;
    }
    if (overlayBridge?.closeOverlay) {
      overlayBridge.closeOverlay();
      return;
    }
    const bridge = getDesktopBridge();
    if (bridge?.close_mini_overlay) {
      if (isMacPlatform()) {
        void bridge.close_mini_overlay();
        return;
      }
      setMotionState('closing');
      window.setTimeout(() => {
        void bridge.close_mini_overlay?.();
      }, 180);
      return;
    }
    window.close();
  };

  const handleSendMiniChat = async (overrideText?: string) => {
    const trimmed = (overrideText ?? chatDraft).trim();
    const sid = snap.sessionId;
    if (!trimmed || !sid || isAiStreaming) return;

    const userMsgId = `mini-u-${Date.now()}`;
    const aiMsgId = `mini-a-${Date.now() + 1}`;
    setChatDraft('');
    setIsAiStreaming(true);
    setChatMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: trimmed },
      { id: aiMsgId, role: 'assistant', content: '', thinking: '', isStreaming: true },
    ]);

    try {
      const reply = await api.streamChatMessage(sid, trimmed, {
        onThinkingDelta: (delta) => {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === aiMsgId ? { ...m, thinking: `${m.thinking ?? ''}${delta}` } : m
            )
          );
        },
        onContentDelta: (delta) => {
          setChatMessages((prev) =>
            prev.map((m) => (m.id === aiMsgId ? { ...m, content: `${m.content}${delta}` } : m))
          );
        },
      });
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? {
                id: reply.id,
                role: 'assistant',
                content: reply.content || m.content,
                thinking: reply.thinking || m.thinking,
                isStreaming: false,
              }
            : m
        )
      );
      sendRemote({ type: 'chat-updated', sessionId: sid });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'AI 对话失败，请检查模型配置';
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? { ...m, content: errMsg, isStreaming: false, isError: true }
            : m
        )
      );
    } finally {
      setIsAiStreaming(false);
    }
  };

  // 桌面原生拖窗逻辑
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isMobileOverlay || e.button !== 0 || !isDesktopShell()) return;
    if (isInteractiveDragBlocker(e.target)) return;
    dragArmRef.current = { startX: e.clientX, startY: e.clientY, active: false };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isMobileOverlay) return;
    const arm = dragArmRef.current;
    if (!arm || arm.active) return;
    if ((e.buttons & 1) === 0) {
      dragArmRef.current = null;
      return;
    }
    if (Math.hypot(e.clientX - arm.startX, e.clientY - arm.startY) >= 3) {
      arm.active = true;
      void getDesktopBridge()?.start_native_drag?.('mini');
    }
  };

  const handleMouseUp = () => {
    dragArmRef.current = null;
  };

  // 手机端触控拖拽移动 / 缩放 / 悬浮球手势
  const beginPointerOp = (
    mode: 'move' | 'resize' | 'bubble',
    e: React.PointerEvent<HTMLElement>
  ) => {
    if (mode === 'move' && isInteractiveDragBlocker(e.target)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ptX = overlayBridge ? e.screenX : e.clientX;
    const ptY = overlayBridge ? e.screenY : e.clientY;
    pointerDragRef.current = {
      mode,
      lastX: ptX,
      lastY: ptY,
      startX: ptX,
      startY: ptY,
      moved: false,
    };
  };

  const stepPointerOp = (e: React.PointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    if (!state) return;
    const ptX = overlayBridge ? e.screenX : e.clientX;
    const ptY = overlayBridge ? e.screenY : e.clientY;
    const dx = ptX - state.lastX;
    const dy = ptY - state.lastY;
    if (!state.moved && Math.hypot(ptX - state.startX, ptY - state.startY) >= 5) {
      state.moved = true;
    }
    state.lastX = ptX;
    state.lastY = ptY;
    if (dx === 0 && dy === 0) return;

    if (state.mode === 'resize') {
      overlayBridge?.resizeBy?.(dx, dy);
      onPreviewResize?.(dx, dy);
    } else {
      overlayBridge?.moveBy?.(dx, dy);
      onPreviewMove?.(dx, dy);
    }
  };

  const endPointerOp = (e: React.PointerEvent<HTMLElement>) => {
    const state = pointerDragRef.current;
    pointerDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (state?.mode === 'bubble' && !state.moved) {
      handleToggleCollapse(false);
    }
  };

  const latestCaptionLine = snap.partialLine
    ? { speaker: snap.partialLine.speaker, text: snap.partialLine.text, partial: true }
    : snap.recentLines.length > 0
      ? {
          speaker: snap.recentLines[snap.recentLines.length - 1].speaker,
          text: snap.recentLines[snap.recentLines.length - 1].text,
          partial: false,
        }
      : null;

  const motionClass =
    motionState === 'minimized-hidden'
      ? 'opacity-0 scale-[0.92] translate-y-4 transition-none will-change-transform'
      : motionState === 'minimizing'
        ? 'opacity-0 scale-[0.92] translate-y-4 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform'
        : motionState === 'closing'
          ? 'opacity-0 scale-[0.94] translate-y-1.5 transition-[transform,opacity] duration-180 ease-[cubic-bezier(0.32,0,0.67,0)] will-change-transform'
          : motionState === 'entering'
            ? 'opacity-0 scale-[0.96] translate-y-1.5 transition-none'
            : 'opacity-100 scale-100 translate-y-0 transition-[transform,opacity] duration-220 ease-[cubic-bezier(0.16,1,0.3,1)]';

  // ==================== 手机/平板悬浮窗形态（原生触控优化 + 可收起悬浮球 + 快捷 AI 对话） ====================
  if (isMobileOverlay) {
    if (collapsed) {
      return (
        <div
          role="button"
          tabIndex={0}
          aria-label="展开悬浮字幕小窗"
          onPointerDown={(e) => beginPointerOp('bubble', e)}
          onPointerMove={stepPointerOp}
          onPointerUp={endPointerOp}
          onPointerCancel={endPointerOp}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggleCollapse(false);
            }
          }}
          className="h-full w-full rounded-full bg-[#1456F0] hover:bg-[#3370FF] text-white border-2 border-white/90 shadow-[0_8px_24px_rgba(20,86,240,0.36)] flex items-center justify-center gap-1.5 px-3 select-none touch-none cursor-pointer active:scale-95 transition-transform"
        >
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
              snap.isRecording ? 'bg-[#73F5A8] animate-pulse' : 'bg-white/60'
            }`}
          />
          <span className="text-[14px] font-semibold tabular-nums tracking-tight whitespace-nowrap">
            {snap.sessionId ? formatDuration(snap.durationSeconds) : '知聆'}
          </span>
        </div>
      );
    }

    return (
      <div
        className={`relative h-full w-full rounded-2xl border border-[#CFD9EA] bg-white/96 backdrop-blur-md shadow-[0_14px_38px_rgba(20,30,55,0.22)] flex flex-col overflow-hidden select-none ${motionClass}`}
      >
        {/* 手机端悬浮小窗顶栏：整条空白区支持触控拖动，右侧集成录音/静音/标不懂/AI对话/收起/关闭 */}
        <div
          onPointerDown={(e) => beginPointerOp('move', e)}
          onPointerMove={stepPointerOp}
          onPointerUp={endPointerOp}
          onPointerCancel={endPointerOp}
          className="h-11 px-2 border-b border-[#ECEEF2] bg-[#F6F9FF] flex items-center justify-between gap-1 shrink-0 touch-none cursor-grab active:cursor-grabbing"
        >
          <div className="flex items-center gap-1.5 min-w-0 flex-1 pl-0.5">
            <GripHorizontal className="w-4 h-4 text-[#8F959E] shrink-0" />
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${
                snap.isRecording ? 'bg-[#1456F0] animate-pulse' : 'bg-[#BBBFC4]'
              }`}
            />
            <span className="text-[14px] font-semibold text-[#1F2329] tabular-nums shrink-0">
              {snap.sessionId ? formatDuration(snap.durationSeconds) : '未录课'}
            </span>
          </div>

          <div className="flex items-center gap-0.5 shrink-0 app-no-drag">
            <button
              type="button"
              disabled={!snap.sessionId}
              aria-label={snap.isRecording ? '暂停录音' : '继续录音'}
              onClick={() => sendRemote({ type: 'toggle-recording' })}
              className={`w-8 h-8 rounded-lg flex items-center justify-center disabled:opacity-40 active:scale-90 transition-all cursor-pointer ${
                snap.isRecording
                  ? 'bg-[#EBF2FF] text-[#1456F0]'
                  : 'text-[#4E5969] hover:bg-[#ECEEF2]'
              }`}
            >
              {snap.isRecording ? (
                <Pause className="w-4 h-4" strokeWidth={2} />
              ) : (
                <Play className="w-4 h-4" strokeWidth={2} />
              )}
            </button>

            <button
              type="button"
              aria-label={snap.micEnabled ? '静音麦克风' : '开启麦克风'}
              onClick={() => sendRemote({ type: 'toggle-mic' })}
              className={`w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all cursor-pointer ${
                snap.micEnabled
                  ? 'text-[#4E5969] hover:bg-[#ECEEF2]'
                  : 'bg-[#FFF1F0] text-[#D83931]'
              }`}
            >
              {snap.micEnabled ? (
                <Mic className="w-4 h-4" strokeWidth={1.9} />
              ) : (
                <MicOff className="w-4 h-4" strokeWidth={1.9} />
              )}
            </button>

            <button
              type="button"
              disabled={!snap.sessionId}
              aria-label="标记此处没听懂"
              onClick={() => sendRemote({ type: 'bookmark-confused' })}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#D97706] hover:bg-[#FFF4E5] disabled:opacity-40 active:scale-90 transition-all cursor-pointer"
            >
              <BookmarkPlus className="w-4 h-4" strokeWidth={1.9} />
            </button>

            <button
              type="button"
              aria-label={aiOpen ? '关闭小窗 AI 对话' : '开启小窗 AI 对话'}
              onClick={handleToggleAiChat}
              className={`w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all cursor-pointer ${
                aiOpen
                  ? 'bg-[#1456F0] text-white shadow-xs'
                  : 'text-[#1456F0] bg-[#EBF2FF]/70 hover:bg-[#EBF2FF]'
              }`}
            >
              <MessageSquareText className="w-4 h-4" strokeWidth={1.9} />
            </button>

            <button
              type="button"
              aria-label="收起为悬浮球"
              onClick={() => handleToggleCollapse(true)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#4E5969] hover:bg-[#ECEEF2] active:scale-90 transition-all cursor-pointer"
            >
              <Minimize2 className="w-4 h-4" strokeWidth={1.9} />
            </button>

            <button
              type="button"
              aria-label="关闭悬浮小窗"
              onClick={() => void handleClose()}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#646A73] hover:bg-[#FFECE8] hover:text-[#D83931] active:scale-90 transition-all cursor-pointer"
            >
              <X className="w-4 h-4" strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* 主体区域：AI 对话关闭时专注实时字幕；开启时顶部保留实时字幕条 + 下方快捷 AI 对话 */}
        {!aiOpen ? (
          <div
            ref={scrollContainerRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 28;
            }}
            className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 bg-white select-text"
          >
            <div ref={contentStackRef} className="min-h-full flex flex-col justify-end gap-2">
              {!snap.sessionId ? (
                <p className="text-[14px] text-[#646A73] leading-relaxed text-center py-4">
                  进入课堂并开始拾音后，实时转写内容将在此悬浮滚动显示
                </p>
              ) : (
                <>
                  {snap.recentLines.map((line) => (
                    <div key={line.id} className="text-[14px] leading-relaxed break-words text-[#1F2329]">
                      <span className="inline-block mr-1.5 px-1.5 py-0.2 rounded bg-[#F0F5FF] text-[#1456F0] font-medium">
                        {line.speaker}
                      </span>
                      <span>{line.text}</span>
                    </div>
                  ))}
                  {snap.partialLine ? (
                    <div className="text-[15px] font-medium leading-relaxed break-words text-[#1456F0]">
                      <span className="inline-block mr-1.5 px-1.5 py-0.2 rounded bg-[#EBF2FF] text-[#1456F0] font-semibold">
                        {snap.partialLine.speaker}
                      </span>
                      <span>{snap.partialLine.text}</span>
                    </div>
                  ) : (
                    snap.recentLines.length === 0 && (
                      <p className="text-[14px] text-[#646A73] leading-relaxed text-center py-4">
                        {snap.isRecording
                          ? `正在聆听《${snap.sessionTitle}》...`
                          : `《${snap.sessionTitle}》已暂停录音`}
                      </p>
                    )
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col bg-[#F8F9FB]">
            {/* 顶部 1~2 行实时字幕提要条，提问时不漏听 */}
            <div className="px-3 py-1.5 bg-[#F0F5FF] border-b border-[#DCE8FF] text-[14px] text-[#1F2329] shrink-0">
              {latestCaptionLine ? (
                <p className="line-clamp-2 leading-snug">
                  <span className="font-semibold text-[#1456F0] mr-1.5">
                    [{latestCaptionLine.speaker}]
                  </span>
                  <span className={latestCaptionLine.partial ? 'text-[#1456F0]' : 'text-[#1F2329]'}>
                    {latestCaptionLine.text}
                  </span>
                </p>
              ) : (
                <p className="text-[#646A73] truncate">
                  {snap.sessionId ? `当前课堂：${snap.sessionTitle}` : '进入课堂后即可基于课堂内容提问'}
                </p>
              )}
            </div>

            {/* 对话消息流 */}
            <div
              ref={chatScrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 space-y-2.5 select-text"
            >
              {chatMessages.length === 0 ? (
                <div className="py-3 space-y-2 text-center">
                  <p className="text-[14px] text-[#646A73]">
                    {snap.sessionId
                      ? '随时在悬浮窗里向 AI 追问本节课内容，对话自动同步至主界面'
                      : '请先在主界面进入一堂课，再使用快捷 AI 对话'}
                  </p>
                  {snap.sessionId && (
                    <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => void handleSendMiniChat('请通俗解释一下老师刚才讲的核心内容')}
                        className="px-2.5 py-1 rounded-full border border-[#BEDAFF] bg-white text-[14px] text-[#1456F0] active:bg-[#EBF2FF] cursor-pointer"
                      >
                        解释刚才这段
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSendMiniChat('请用 3 条要点帮我梳理目前讲的重点')}
                        className="px-2.5 py-1 rounded-full border border-[#DEE0E3] bg-white text-[14px] text-[#4E5969] active:bg-[#F2F3F5] cursor-pointer"
                      >
                        总结目前要点
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                chatMessages.map((msg) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[86%] rounded-2xl rounded-br-sm bg-[#1456F0] text-white px-3 py-2 text-[14px] leading-relaxed break-words">
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={msg.id}
                      className={`rounded-2xl rounded-bl-sm border px-3 py-2 text-[14px] leading-relaxed break-words ${
                        msg.isError
                          ? 'border-[#FAD2CF] bg-[#FFF5F5] text-[#B42318]'
                          : 'border-[#E5E8EF] bg-white text-[#1F2329]'
                      }`}
                    >
                      {msg.thinking && (
                        <div className="mb-1.5">
                          <ThinkingDisclosure
                            thinking={msg.thinking}
                            isThinking={Boolean(msg.isStreaming && !msg.content)}
                          />
                        </div>
                      )}
                      {msg.content ? (
                        <MarkdownRenderer
                          content={msg.content}
                          variant="compact"
                          isStreaming={Boolean(msg.isStreaming)}
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[#646A73]">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1456F0]" />
                          <span>正在思考...</span>
                        </span>
                      )}
                    </div>
                  )
                )
              )}
            </div>

            {/* 底部快捷输入框 */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMiniChat();
              }}
              className="px-2.5 py-2 border-t border-[#ECEEF2] bg-white flex items-center gap-1.5 shrink-0"
            >
              <input
                ref={chatInputRef}
                type="text"
                value={chatDraft}
                disabled={!snap.sessionId || isAiStreaming}
                onFocus={() => overlayBridge?.setFocusable?.(true)}
                onBlur={() => overlayBridge?.setFocusable?.(false)}
                onChange={(e) => setChatDraft(e.target.value)}
                placeholder={snap.sessionId ? '快速向 AI 提问...' : '等待进入课堂...'}
                className="h-9 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3 text-[14px] text-[#1F2329] placeholder-[#8F959E] focus:outline-none focus:border-[#1456F0]"
              />
              <button
                type="submit"
                disabled={!snap.sessionId || !chatDraft.trim() || isAiStreaming}
                aria-label="发送问题"
                className="w-9 h-9 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-45 text-white flex items-center justify-center shrink-0 cursor-pointer"
              >
                {isAiStreaming ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <SendHorizontal className="w-4 h-4" />
                )}
              </button>
            </form>
          </div>
        )}

        {/* 右下角触控缩放把手 */}
        <div
          aria-label="调整悬浮小窗大小"
          onPointerDown={(e) => beginPointerOp('resize', e)}
          onPointerMove={stepPointerOp}
          onPointerUp={endPointerOp}
          onPointerCancel={endPointerOp}
          className="absolute right-0 bottom-0 w-6 h-6 flex items-end justify-end p-1 touch-none cursor-nwse-resize z-20 text-[#9AA0A8] hover:text-[#1456F0]"
        >
          <svg viewBox="0 0 12 12" className="w-3 h-3" aria-hidden="true">
            <path
              d="M3 11L11 3M7 11L11 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
      </div>
    );
  }

  // ==================== 电脑端悬浮字幕小窗（保留透明歌词质感 + 顶栏一键开启/关闭快捷 AI 对话） ====================
  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className={`relative h-screen w-screen bg-transparent select-none overflow-hidden group flex flex-col ${motionClass}`}
    >
      <WindowResizeHandles target="mini" />

      {/* 顶部悬浮快捷图标组：macOS 左侧红黄双交通灯 / Windows 右侧 — ×，新增 AI 对话开关 */}
      <div
        className={`fixed top-2.5 z-30 flex items-center gap-1 rounded-xl bg-[#181D26]/62 hover:bg-[#181D26]/88 backdrop-blur-md border border-white/15 px-2 py-1 shadow-[0_6px_20px_rgba(0,0,0,0.22)] transition-all app-no-drag ${
          isMacPlatform() ? 'left-2.5' : 'right-2.5'
        }`}
      >
        {isMacPlatform() && (
          <>
            <div className="flex items-center gap-1.5 pl-0.5 pr-1 group/mac">
              <Tooltip content="关闭字幕窗" placement="bottom">
                <button
                  type="button"
                  aria-label="关闭字幕窗"
                  onClick={() => void handleClose()}
                  className="w-3 h-3 rounded-full bg-[#FF5F57] border border-[#E0443E] flex items-center justify-center active:scale-90 transition-transform cursor-pointer"
                >
                  <svg
                    viewBox="0 0 10 10"
                    className="w-1.5 h-1.5 opacity-0 group-hover/mac:opacity-100 transition-opacity"
                    aria-hidden="true"
                  >
                    <path
                      d="M2.4 2.4L7.6 7.6M7.6 2.4L2.4 7.6"
                      stroke="#4D0000"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip content="最小化" placement="bottom">
                <button
                  type="button"
                  aria-label="最小化字幕窗"
                  onClick={() => void handleMinimize()}
                  className="w-3 h-3 rounded-full bg-[#FEBC2E] border border-[#DEA123] flex items-center justify-center active:scale-90 transition-transform cursor-pointer"
                >
                  <svg
                    viewBox="0 0 10 10"
                    className="w-1.5 h-1.5 opacity-0 group-hover/mac:opacity-100 transition-opacity"
                    aria-hidden="true"
                  >
                    <path d="M2 5H8" stroke="#6E4400" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </Tooltip>
            </div>
            <span className="w-px h-4 bg-white/20 mx-0.5" />
          </>
        )}

        <Tooltip content={snap.isRecording ? '暂停录音' : '继续录音'} placement="bottom">
          <button
            type="button"
            disabled={!snap.sessionId}
            aria-label={snap.isRecording ? '暂停录音' : '继续录音'}
            onClick={() => sendRemote({ type: 'toggle-recording' })}
            className="w-8 h-8 rounded-lg hover:bg-white/15 active:scale-90 disabled:opacity-40 flex items-center justify-center text-white transition-all cursor-pointer"
          >
            {snap.isRecording ? (
              <Pause className="w-4 h-4 text-[#69A1FF]" strokeWidth={2} />
            ) : (
              <Play className="w-4 h-4" strokeWidth={2} />
            )}
          </button>
        </Tooltip>

        <Tooltip content={snap.micEnabled ? '静音麦克风' : '开启麦克风'} placement="bottom">
          <button
            type="button"
            aria-label={snap.micEnabled ? '静音麦克风' : '开启麦克风'}
            onClick={() => sendRemote({ type: 'toggle-mic' })}
            className={`w-8 h-8 rounded-lg hover:bg-white/15 active:scale-90 flex items-center justify-center transition-all cursor-pointer ${
              snap.micEnabled ? 'text-white' : 'text-[#FF7875]'
            }`}
          >
            {snap.micEnabled ? (
              <Mic className="w-4 h-4" strokeWidth={1.9} />
            ) : (
              <MicOff className="w-4 h-4" strokeWidth={1.9} />
            )}
          </button>
        </Tooltip>

        <Tooltip content="一键抓拍画面入时间轴" placement="bottom">
          <button
            type="button"
            disabled={!snap.sessionId}
            aria-label="一键抓拍画面"
            onClick={() => sendRemote({ type: 'capture-screen' })}
            className="w-8 h-8 rounded-lg hover:bg-white/15 active:scale-90 disabled:opacity-40 flex items-center justify-center text-white transition-all cursor-pointer"
          >
            <Camera className="w-4 h-4" strokeWidth={1.9} />
          </button>
        </Tooltip>

        <Tooltip content="标记此处没听懂" placement="bottom">
          <button
            type="button"
            disabled={!snap.sessionId}
            aria-label="标记此处没听懂"
            onClick={() => sendRemote({ type: 'bookmark-confused' })}
            className="w-8 h-8 rounded-lg hover:bg-white/15 active:scale-90 disabled:opacity-40 flex items-center justify-center text-[#FFE97A] transition-all cursor-pointer"
          >
            <BookmarkPlus className="w-4 h-4" strokeWidth={1.9} />
          </button>
        </Tooltip>

        <Tooltip content={aiOpen ? '收起快捷 AI 对话' : '开启快捷 AI 对话'} placement="bottom">
          <button
            type="button"
            aria-label={aiOpen ? '收起快捷 AI 对话' : '开启快捷 AI 对话'}
            onClick={handleToggleAiChat}
            className={`w-8 h-8 rounded-lg active:scale-90 flex items-center justify-center transition-all cursor-pointer ${
              aiOpen
                ? 'bg-[#1456F0] text-white shadow-xs'
                : 'text-[#8BB4FF] hover:bg-white/15 hover:text-white'
            }`}
          >
            <MessageSquareText className="w-4 h-4" strokeWidth={1.9} />
          </button>
        </Tooltip>

        {!isMacPlatform() && (
          <>
            <span className="w-px h-4 bg-white/20 mx-0.5" />

            <Tooltip content="最小化" placement="bottom">
              <button
                type="button"
                aria-label="最小化字幕窗"
                onClick={() => void handleMinimize()}
                className="w-8 h-8 rounded-lg hover:bg-white/15 active:scale-90 flex items-center justify-center text-white/90 hover:text-white transition-all cursor-pointer"
              >
                <Minus className="w-4 h-4" strokeWidth={2} />
              </button>
            </Tooltip>

            <Tooltip content="关闭字幕窗" placement="bottom">
              <button
                type="button"
                aria-label="关闭字幕窗"
                onClick={() => void handleClose()}
                className="w-8 h-8 rounded-lg hover:bg-[#F53F3F] active:scale-90 flex items-center justify-center text-white/90 hover:text-white transition-all cursor-pointer"
              >
                <X className="w-4 h-4" strokeWidth={2} />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* 字幕视口：关闭 AI 时占满全窗；开启 AI 时占上方 34% 并保留实时置底滚动 */}
      {!minimizedInBrowser && (
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 28;
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) {
              pinnedBottomRef.current = false;
            }
          }}
          className={`${
            aiOpen ? 'h-[34%] min-h-[88px] shrink-0' : 'flex-1 min-h-0'
          } w-full overflow-y-auto no-scrollbar px-4 pt-12 pb-3 cursor-grab active:cursor-grabbing`}
        >
          <div ref={contentStackRef} className="min-h-full flex flex-col justify-end gap-1.5">
            {!snap.sessionId ? (
              <p className="text-[16px] font-semibold leading-relaxed lyric-muted">
                等待主窗口进入课堂并开启拾音，实时字幕将在此处透明置底滚动...
              </p>
            ) : (
              <>
                {snap.recentLines.map((line) => (
                  <div
                    key={line.id}
                    className="text-[16px] font-semibold leading-relaxed break-words"
                  >
                    <span className="lyric-speaker mr-2">[{line.speaker}]</span>
                    <span className="lyric-text">{line.text}</span>
                  </div>
                ))}

                {snap.partialLine ? (
                  <div className="text-[17px] font-semibold leading-relaxed break-words">
                    <span className="lyric-speaker mr-2">[{snap.partialLine.speaker}]</span>
                    <span className="lyric-partial">{snap.partialLine.text}</span>
                  </div>
                ) : (
                  snap.recentLines.length === 0 && (
                    <p className="text-[16px] font-semibold leading-relaxed lyric-muted">
                      {snap.isRecording
                        ? `正在聆听《${snap.sessionTitle}》...`
                        : `《${snap.sessionTitle}》已暂停录音`}
                    </p>
                  )
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 电脑端小窗内嵌快捷 AI 对话抽屉 */}
      {!minimizedInBrowser && aiOpen && (
        <div className="flex-1 min-h-0 px-3 pb-3 pt-1 flex flex-col app-no-drag">
          <div className="flex-1 min-h-0 rounded-2xl border border-[#DCE3EE] bg-white/95 backdrop-blur-md shadow-[0_12px_32px_rgba(20,30,55,0.22)] flex flex-col overflow-hidden">
            <div className="px-3.5 py-2 border-b border-[#ECEEF2] bg-[#F7F9FC] flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <MessageSquareText className="w-4 h-4 text-[#1456F0] shrink-0" />
                <span className="text-[14px] font-semibold text-[#1F2329] truncate">
                  随堂 AI 快捷问答
                </span>
              </div>
              {snap.sessionId && chatMessages.length === 0 && (
                <button
                  type="button"
                  onClick={() => void handleSendMiniChat('请通俗解释一下老师刚才讲的重点')}
                  className="px-2.5 py-0.5 rounded-full border border-[#BEDAFF] bg-[#EBF2FF] hover:bg-[#DCE8FF] text-[14px] text-[#1456F0] shrink-0 cursor-pointer"
                >
                  解释刚才这段
                </button>
              )}
            </div>

            <div
              ref={chatScrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-3.5 py-2.5 space-y-2.5 select-text"
            >
              {chatMessages.length === 0 ? (
                <p className="text-[14px] text-[#646A73] text-center py-4">
                  {snap.sessionId
                    ? '直接输入问题，AI 将结合本节课转写实时解答并同步到主窗口'
                    : '请先在主窗口打开或创建一节课堂'}
                </p>
              ) : (
                chatMessages.map((msg) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[82%] rounded-2xl rounded-br-sm bg-[#1456F0] text-white px-3 py-2 text-[14px] leading-relaxed break-words">
                        {msg.content}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={msg.id}
                      className={`rounded-2xl rounded-bl-sm border px-3 py-2 text-[14px] leading-relaxed break-words ${
                        msg.isError
                          ? 'border-[#FAD2CF] bg-[#FFF5F5] text-[#B42318]'
                          : 'border-[#E5E8EF] bg-[#F8F9FB] text-[#1F2329]'
                      }`}
                    >
                      {msg.thinking && (
                        <div className="mb-1.5">
                          <ThinkingDisclosure
                            thinking={msg.thinking}
                            isThinking={Boolean(msg.isStreaming && !msg.content)}
                          />
                        </div>
                      )}
                      {msg.content ? (
                        <MarkdownRenderer
                          content={msg.content}
                          variant="compact"
                          isStreaming={Boolean(msg.isStreaming)}
                        />
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[#646A73]">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1456F0]" />
                          <span>正在思考...</span>
                        </span>
                      )}
                    </div>
                  )
                )
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMiniChat();
              }}
              className="px-3 py-2 border-t border-[#ECEEF2] bg-white flex items-center gap-2 shrink-0"
            >
              <input
                ref={chatInputRef}
                type="text"
                value={chatDraft}
                disabled={!snap.sessionId || isAiStreaming}
                onChange={(e) => setChatDraft(e.target.value)}
                placeholder={snap.sessionId ? '输入问题并回车，快速向 AI 提问...' : '等待进入课堂...'}
                className="h-9 min-w-0 flex-1 rounded-xl border border-[#DEE0E3] bg-[#F8F9FA] focus:bg-white px-3 text-[14px] text-[#1F2329] placeholder-[#8F959E] focus:outline-none focus:border-[#1456F0]"
              />
              <button
                type="submit"
                disabled={!snap.sessionId || !chatDraft.trim() || isAiStreaming}
                aria-label="发送问题"
                className="h-9 px-3.5 rounded-xl bg-[#1456F0] hover:bg-[#3370FF] disabled:opacity-45 text-white text-[14px] font-medium inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                {isAiStreaming ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <SendHorizontal className="w-4 h-4" />
                )}
                <span>发送</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
