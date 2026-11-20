import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookmarkPlus,
  Camera,
  Mic,
  MicOff,
  Minus,
  Pause,
  Play,
  X,
} from 'lucide-react';
import {
  getDesktopBridge,
  isDesktopShell,
  isInteractiveDragBlocker,
  isMacPlatform,
} from '../../utils/desktopBridge';
import { Tooltip } from '../ui/Tooltip';
import { WindowResizeHandles } from '../ui/WindowResizeHandles';

export interface OverlaySyncSnapshot {
  sessionId: string | null;
  sessionTitle: string;
  isRecording: boolean;
  durationSeconds: number;
  micEnabled: boolean;
  recentLines: Array<{ id: string; speaker: string; text: string; time: string }>;
  partialLine: { speaker: string; text: string } | null;
}

export type OverlayRemoteCommand =
  | { type: 'request-snapshot' }
  | { type: 'toggle-recording' }
  | { type: 'toggle-mic' }
  | { type: 'capture-screen' }
  | { type: 'bookmark-confused' };

export const OVERLAY_CHANNEL_NAME = 'zhiling-classroom-sync';

export const MiniOverlayView: React.FC = () => {
  const [snap, setSnap] = useState<OverlaySyncSnapshot>({
    sessionId: null,
    sessionTitle: '等待主窗口进入课堂...',
    isRecording: false,
    durationSeconds: 0,
    micEnabled: true,
    recentLines: [],
    partialLine: null,
  });
  const [minimizedInBrowser, setMinimizedInBrowser] = useState(false);
  const [motionState, setMotionState] = useState<
    'entering' | 'idle' | 'minimizing' | 'minimized-hidden' | 'closing'
  >('entering');

  const channelRef = useRef<BroadcastChannel | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const contentStackRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottomRef = useRef<boolean>(true);
  const dragArmRef = useRef<{ startX: number; startY: number; active: boolean } | null>(null);

  const snapToBottomIfPinned = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !pinnedBottomRef.current) return;
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  }, []);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel(OVERLAY_CHANNEL_NAME);
    channelRef.current = bc;

    bc.onmessage = (evt: MessageEvent<{ type: 'snapshot'; snapshot: OverlaySyncSnapshot }>) => {
      if (evt.data?.type === 'snapshot' && evt.data.snapshot) {
        setSnap(evt.data.snapshot);
      }
    };

    bc.postMessage({ type: 'request-snapshot' } satisfies OverlayRemoteCommand);
    const retryTimer = window.setTimeout(() => {
      bc.postMessage({ type: 'request-snapshot' } satisfies OverlayRemoteCommand);
    }, 350);

    return () => {
      window.clearTimeout(retryTimer);
      bc.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      snapToBottomIfPinned();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [snap.recentLines, snap.partialLine, minimizedInBrowser, snapToBottomIfPinned]);

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
  }, [minimizedInBrowser, snapToBottomIfPinned]);

  const sendRemote = (cmd: OverlayRemoteCommand) => {
    channelRef.current?.postMessage(cmd);
  };

  const handleMinimize = async () => {
    const bridge = getDesktopBridge();
    if (bridge?.minimize_mini_overlay) {
      setMotionState('minimizing');
      window.setTimeout(() => {
        setMotionState('minimized-hidden');
        void bridge.minimize_mini_overlay?.();
      }, 155);
      return;
    }
    setMinimizedInBrowser((prev) => !prev);
  };

  const handleClose = async () => {
    const bridge = getDesktopBridge();
    if (bridge?.close_mini_overlay) {
      setMotionState('closing');
      window.setTimeout(() => {
        void bridge.close_mini_overlay?.();
      }, 145);
      return;
    }
    window.close();
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !isDesktopShell()) return;
    if (isInteractiveDragBlocker(e.target)) return;
    dragArmRef.current = { startX: e.clientX, startY: e.clientY, active: false };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
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

  const motionClass =
    motionState === 'minimized-hidden'
      ? 'opacity-0 scale-[0.94] translate-y-3 transition-none'
      : motionState === 'minimizing'
        ? 'opacity-0 scale-[0.94] translate-y-3 transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.4,0,1,1)]'
        : motionState === 'closing'
          ? 'opacity-0 scale-[0.94] translate-y-1 transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.32,0,0.67,0)]'
          : motionState === 'entering'
            ? 'opacity-0 scale-[0.96] translate-y-1.5 transition-none'
            : 'opacity-100 scale-100 translate-y-0 transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]';

  return (
    <div
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className={`relative h-screen w-screen bg-transparent select-none overflow-hidden group ${motionClass}`}
    >
      <WindowResizeHandles target="mini" />

      {/* 顶部悬浮快捷图标组：macOS 左侧红黄双交通灯 / Windows 右侧 — ×，无独立顶栏 */}
      <div
        className={`fixed top-2.5 z-30 flex items-center gap-1 rounded-xl bg-[#181D26]/58 hover:bg-[#181D26]/86 backdrop-blur-md border border-white/15 px-2 py-1 shadow-[0_6px_20px_rgba(0,0,0,0.22)] transition-all app-no-drag ${
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
                  <svg viewBox="0 0 10 10" className="w-1.5 h-1.5 opacity-0 group-hover/mac:opacity-100 transition-opacity" aria-hidden="true">
                    <path d="M2.4 2.4L7.6 7.6M7.6 2.4L2.4 7.6" stroke="#4D0000" strokeWidth="1.6" strokeLinecap="round" />
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
                  <svg viewBox="0 0 10 10" className="w-1.5 h-1.5 opacity-0 group-hover/mac:opacity-100 transition-opacity" aria-hidden="true">
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

      {/* 下半部分全透明桌面歌词视口：置底对齐、尽量多显示历史行、滚轮无滚动条顺滑回看，按住任意处亦可拖拽小窗 */}
      {!minimizedInBrowser && (
        <div
          ref={scrollContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight <= 28;
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) {
              pinnedBottomRef.current = false;
            }
          }}
          className="h-screen w-screen overflow-y-auto no-scrollbar px-4 pt-12 pb-3.5 cursor-grab active:cursor-grabbing"
        >
          <div
            ref={contentStackRef}
            className="min-h-full flex flex-col justify-end gap-1.5"
          >
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
                    <span className="lyric-speaker mr-2">
                      [{snap.partialLine.speaker}]
                    </span>
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
    </div>
  );
};
