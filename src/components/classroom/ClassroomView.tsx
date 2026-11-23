import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignLeft,
  ArrowLeft,
  Bookmark,
  BookmarkPlus,
  Camera,
  FileText,
  FileUp,
  Headphones,
  MessageSquareText,
  Mic,
  Pause,
  PictureInPicture2,
  Settings,
  StickyNote,
  Volume2,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import {
  getDesktopBridge,
  isAndroidPlatform,
  isMacPlatform,
  useViewportLayout,
} from '../../utils/desktopBridge';
import { formatDuration } from '../../utils/format';
import { IconButton } from '../ui/IconButton';
import { MoreGridMenu, type GridMenuItem } from '../ui/MoreGridMenu';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from '../ui/WindowControls';
import { AudioSourceControl } from './AudioSourceControl';
import { ChatPanel } from './ChatPanel';
import { StickyNotesLayer } from './StickyNotesLayer';
import { MobileStickyBasketSheet, StickyNoteTopbarControl } from './StickyNoteTopbarControl';
import { TranscriptPanel } from './TranscriptPanel';

const RecordingTimerButton: React.FC = React.memo(() => {
  const isRecording = useAppStore((s) => s.activeSession?.status === 'recording');
  const durationSeconds = useAppStore((s) => s.activeSession?.durationSeconds ?? 0);
  const tickRecordingDuration = useAppStore((s) => s.tickRecordingDuration);
  const toggleRecording = useAppStore((s) => s.toggleRecording);

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(() => {
      tickRecordingDuration();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecording, tickRecordingDuration]);

  return (
    <Tooltip content={isRecording ? '暂停课堂录音' : '继续课堂录音'} placement="bottom">
      <button
        type="button"
        aria-label={isRecording ? '暂停课堂录音' : '继续课堂录音'}
        onClick={() => void toggleRecording()}
        className={`h-10 px-3.5 rounded-lg border flex items-center gap-2 text-[14px] font-medium select-none transition-all cursor-pointer shrink-0 app-no-drag active:scale-[0.98] ${
          isRecording
            ? 'border-[#BEDAFF] bg-[#EBF2FF] hover:bg-[#DCE8FF] text-[#1456F0]'
            : 'border-transparent bg-[#1456F0] hover:bg-[#3370FF] active:bg-[#0E42C2] text-white shadow-xs'
        }`}
      >
        {isRecording ? (
          <Pause className="w-[17px] h-[17px] shrink-0" strokeWidth={2} />
        ) : (
          <Mic className="w-[17px] h-[17px] shrink-0" strokeWidth={1.95} />
        )}
        <span className="tabular-nums tracking-tight">{formatDuration(durationSeconds)}</span>
      </button>
    </Tooltip>
  );
});

RecordingTimerButton.displayName = 'RecordingTimerButton';

export const ClassroomView: React.FC = () => {
  const sessionId = useAppStore((s) => s.activeSession?.id ?? null);
  const sessionTitle = useAppStore((s) => s.activeSession?.title ?? '');
  const segments = useAppStore((s) => s.segments);
  const attachments = useAppStore((s) => s.attachments);
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const micEnabled = useAppStore((s) => s.settings?.micEnabled ?? true);
  const systemAudioEnabled = useAppStore((s) => s.settings?.systemAudioEnabled ?? false);
  const onlyBookmarksFilter = useAppStore((s) => s.onlyBookmarksFilter);
  const audioBarVisible = useAppStore((s) => s.audioPlayback.visible);
  const windowMaximized = useAppStore((s) => s.windowMaximized);

  const leaveClassroom = useAppStore((s) => s.leaveClassroom);
  const renameSession = useAppStore((s) => s.renameSession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const openNotesExportModal = useAppStore((s) => s.openNotesExportModal);
  const markConfusedNow = useAppStore((s) => s.markConfusedNow);
  const captureClassroomScreen = useAppStore((s) => s.captureClassroomScreen);
  const createStickyNote = useAppStore((s) => s.createStickyNote);
  const focusStickyNoteTimestamp = useAppStore((s) => s.focusStickyNoteTimestamp);
  const uploadSessionAttachment = useAppStore((s) => s.uploadSessionAttachment);
  const toggleMiniOverlayWindow = useAppStore((s) => s.toggleMiniOverlayWindow);
  const toggleAudioPlaybackBar = useAppStore((s) => s.toggleAudioPlaybackBar);
  const setOnlyBookmarksFilter = useAppStore((s) => s.setOnlyBookmarksFilter);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);
  const showNotice = useAppStore((s) => s.showNotice);

  const [leftRatio, setLeftRatio] = useState(46);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [mobileTab, setMobileTab] = useState<'transcript' | 'chat'>('transcript');
  const [mobileStickyBasketOpen, setMobileStickyBasketOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const materialInputRef = useRef<HTMLInputElement | null>(null);

  const viewport = useViewportLayout();
  const isMobileViewport = viewport.isCompactWidth;
  const isShortLandscape = viewport.isShortLandscape;
  const isAndroid = isAndroidPlatform();
  // 平板大屏（>=768px 且高度 >520px）采用类电脑端顶栏布局，音频设置与便签直接驻留顶栏而非收纳进百宝箱
  const isCompactMobileChrome = viewport.isCompactPhoneLayout;
  const hideScreenshotBtn = isCompactMobileChrome || isAndroid;
  const previewFloatingOverlayOpen = useAppStore((s) => s.previewFloatingOverlayOpen);
  const openStickyCount = useMemo(
    () => stickyNotes.filter((n) => n.isOpen).length,
    [stickyNotes]
  );

  // Android 返回键优先关闭手机端课堂便签篓抽屉
  useEffect(() => {
    if (!mobileStickyBasketOpen) return;
    const win = window as unknown as {
      __zhilingHandleClassroomOverlayBack?: () => boolean;
    };
    const handler = () => {
      setMobileStickyBasketOpen(false);
      return true;
    };
    win.__zhilingHandleClassroomOverlayBack = handler;
    return () => {
      if (win.__zhilingHandleClassroomOverlayBack === handler) {
        delete win.__zhilingHandleClassroomOverlayBack;
      }
    };
  }, [mobileStickyBasketOpen]);

  // Android 返回键在手机端问答态下优先平滑切回转写记录，而非直接退出课堂
  useEffect(() => {
    if (!isMobileViewport || mobileTab !== 'chat') return;
    const win = window as unknown as {
      __zhilingHandleClassroomChatBack?: () => boolean;
    };
    const handler = () => {
      setMobileTab('transcript');
      return true;
    };
    win.__zhilingHandleClassroomChatBack = handler;
    return () => {
      if (win.__zhilingHandleClassroomChatBack === handler) {
        delete win.__zhilingHandleClassroomChatBack;
      }
    };
  }, [isMobileViewport, mobileTab]);
  const transcriptFocusSeq = useAppStore((s) => s.transcriptFocusRequest?.seq ?? 0);
  const chatPrefillSeq = useAppStore((s) => s.chatDraftPrefill?.seq ?? 0);
  const isAiSending = useAppStore((s) => s.isSendingChat);

  // 手机端智能切页：点击问答时间戳自动切至「转写记录」；点击转写追问自动切至「课堂问答」
  useEffect(() => {
    if (isMobileViewport && transcriptFocusSeq > 0) {
      setMobileTab('transcript');
    }
  }, [isMobileViewport, transcriptFocusSeq]);

  useEffect(() => {
    if (isMobileViewport && chatPrefillSeq > 0) {
      setMobileTab('chat');
    }
  }, [isMobileViewport, chatPrefillSeq]);

  const totalBookmarkCount = useMemo(
    () =>
      segments.reduce(
        (acc, seg) => acc + seg.utterances.filter((u) => u.isBookmarked).length,
        0
      ),
    [segments]
  );

  const materialCount = useMemo(
    () => attachments.filter((a) => a.kind === 'material').length,
    [attachments]
  );

  useEffect(() => {
    if (!isDraggingSplit) return;

    let rafId: number | null = null;
    const handleMouseMove = (e: MouseEvent) => {
      const clientX = e.clientX;
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const rawPercent = ((clientX - rect.left) / rect.width) * 100;
        const clamped = Math.min(70, Math.max(30, rawPercent));
        setLeftRatio(clamped);
      });
    };

    const handleMouseUp = () => {
      setIsDraggingSplit(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingSplit]);

  // 课堂页面级 Ctrl+V 粘贴截图直达时间轴（当焦点不在输入框时生效）
  useEffect(() => {
    if (!sessionId) return;
    const handleGlobalPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (!file) continue;
          e.preventDefault();
          const segs = useAppStore.getState().segments;
          const latestSegId = segs[segs.length - 1]?.id;
          void uploadSessionAttachment(file, {
            fileName: `paste_${Date.now()}.png`,
            kind: 'screenshot',
            segmentId: latestSegId,
          }).then((att) => {
            if (att) {
              showNotice(
                'info',
                `已粘贴课堂截图并锚定至 [${att.timestampText ?? '00:00'}]，可点击「追问此图」向 AI 提问`
              );
            }
          });
          break;
        }
      }
    };
    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [sessionId, uploadSessionAttachment, showNotice]);

  const gridItems = useMemo<GridMenuItem[]>(
    () => [
      {
        id: 'study-summary',
        label: '课堂总结',
        icon: FileText,
        onClick: () => {
          if (sessionId) openNotesExportModal(sessionId, 'notes');
        },
      },
      ...(isCompactMobileChrome
        ? [
            {
              id: 'mobile-sticky-notes',
              label: '课堂便签',
              icon: StickyNote,
              badge: stickyNotes.length > 0 ? stickyNotes.length : undefined,
              active: openStickyCount > 0 || mobileStickyBasketOpen,
              onClick: () => {
                if (stickyNotes.length === 0) {
                  void createStickyNote().then((created) => {
                    if (created) focusStickyNoteTimestamp(created.id);
                  });
                } else {
                  setMobileStickyBasketOpen(true);
                }
              },
            },
            {
              id: 'mobile-audio-settings',
              label: '音频设置',
              icon: Volume2,
              badge:
                !micEnabled && !systemAudioEnabled
                  ? '静音'
                  : micEnabled && systemAudioEnabled
                    ? '双轨'
                    : systemAudioEnabled
                      ? '内录'
                      : undefined,
              onClick: () => setSettingsOpen(true, 'general'),
            },
          ]
        : []),
      {
        id: 'import-material',
        label: '导入讲义',
        icon: FileUp,
        badge: materialCount > 0 ? materialCount : undefined,
        onClick: () => materialInputRef.current?.click(),
      },
      {
        id: 'filter-bookmarks',
        label: '难点书签',
        icon: Bookmark,
        badge: totalBookmarkCount > 0 ? totalBookmarkCount : undefined,
        active: onlyBookmarksFilter,
        onClick: () => setOnlyBookmarksFilter(!onlyBookmarksFilter),
      },
      {
        id: 'mini-subtitles',
        label: isAndroid ? '悬浮小窗' : '实时字幕',
        icon: PictureInPicture2,
        active: isAndroid ? previewFloatingOverlayOpen : undefined,
        onClick: () => void toggleMiniOverlayWindow(),
      },
      {
        id: 'audio-replay',
        label: '原声回放',
        icon: Headphones,
        active: audioBarVisible,
        onClick: () => toggleAudioPlaybackBar(),
      },
      {
        id: 'open-settings',
        label: '系统设置',
        icon: Settings,
        onClick: () => setSettingsOpen(true),
      },
    ],
    [
      isAndroid,
      isCompactMobileChrome,
      previewFloatingOverlayOpen,
      sessionId,
      stickyNotes.length,
      openStickyCount,
      mobileStickyBasketOpen,
      micEnabled,
      systemAudioEnabled,
      materialCount,
      totalBookmarkCount,
      onlyBookmarksFilter,
      audioBarVisible,
      openNotesExportModal,
      createStickyNote,
      focusStickyNoteTimestamp,
      setOnlyBookmarksFilter,
      toggleMiniOverlayWindow,
      toggleAudioPlaybackBar,
      setSettingsOpen,
    ]
  );

  if (!sessionId) return null;

  const isMac = isMacPlatform();

  const handleHeaderDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    const bridge = getDesktopBridge();
    if (bridge?.toggle_maximize_window) {
      void bridge.toggle_maximize_window().then((nextMax) => {
        setWindowMaximized(Boolean(nextMax));
      });
      return;
    }
    setWindowMaximized(!windowMaximized);
  };

  const commitTitle = async () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== sessionTitle) {
      await renameSession(sessionId, trimmed);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#F5F6F7] overflow-hidden">
      <input
        ref={materialInputRef}
        type="file"
        accept=".pdf,.md,.txt,.py,.cpp,.c,.java"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void uploadSessionAttachment(file, {
              fileName: file.name,
              kind: 'material',
            }).then((res) => {
              if (res) {
                showNotice('info', `已挂载参考讲义《${res.fileName}》作为课堂上下文`);
              }
            });
            e.target.value = '';
          }
        }}
      />

      {/* 顶部课堂控制栏：桌面端保持原样；手机竖屏与横屏自动精简高度，给内容与课程名留足空间 */}
      <header
        onDoubleClick={handleHeaderDoubleClick}
        className={`border-b border-[#DEE0E3] flex items-center justify-between gap-1.5 md:gap-3 shrink-0 pywebview-drag-region ${
          isShortLandscape
            ? 'h-12 bg-white px-3'
            : isMac
              ? 'h-14 bg-white/95 backdrop-blur-md pl-4 pr-5'
              : 'h-14 md:h-15 bg-white px-2.5 md:pl-5 md:pr-3.5'
        }`}
      >
        <div className="flex items-center gap-1.5 md:gap-2.5 min-w-0 flex-1">
          {isMac && <WindowControls />}
          <IconButton
            icon={ArrowLeft}
            variant="ghost"
            size="lg"
            tooltip="保存并返回主菜单"
            onClick={() => void leaveClassroom()}
          />

          {editingTitle ? (
            <input
              type="text"
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              className="h-9 flex-1 min-w-0 md:flex-none md:w-80 md:max-w-[42vw] rounded-lg border border-[#1456F0] bg-white px-2.5 text-[15px] md:text-[16px] font-semibold text-[#1F2329] focus:outline-none ring-2 ring-[#1456F0]/15"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setTitleDraft(sessionTitle);
                setEditingTitle(true);
              }}
              className="flex-1 md:flex-none truncate rounded-lg px-2 md:px-2.5 py-1.5 text-[15px] md:text-[16px] font-semibold text-[#1F2329] hover:bg-[#F2F3F5] transition-colors cursor-pointer text-left min-w-0"
            >
              {sessionTitle}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 md:gap-2 shrink-0 app-no-drag">
          {!isCompactMobileChrome && <AudioSourceControl />}

          <RecordingTimerButton />

          {!hideScreenshotBtn && (
            <IconButton
              icon={Camera}
              size="lg"
              variant="outline"
              tooltip="一键抓拍课堂画面锚定至时间轴"
              onClick={() => void captureClassroomScreen()}
            />
          )}

          {!isMobileViewport && (
            <IconButton
              icon={BookmarkPlus}
              size="lg"
              variant="outline"
              tooltip="标记此处没听懂"
              onClick={() => void markConfusedNow()}
            />
          )}

          {!isCompactMobileChrome && <StickyNoteTopbarControl />}

          <MoreGridMenu
            items={gridItems}
            tooltip="更多课堂功能与设置"
            title="课堂百宝箱"
          />

          {!isMac && <WindowControls />}
        </div>
      </header>

      {/* 主体：桌面/平板（>=768px）保持可拖拽双栏；手机端（<768px）转写全屏沉浸 + 底部对话框形态，右下角持久变形按钮丝滑切换 */}
      {isMobileViewport ? (
        <div className="flex-1 relative min-h-0 overflow-hidden bg-[#F5F6F7]">
          {/* 转写记录主层：始终挂载保留滚动位置，切换问答时轻微景深退后 */}
          <div
            aria-hidden={mobileTab !== 'transcript'}
            className={`absolute inset-0 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[transform,opacity] ${
              mobileTab === 'transcript'
                ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto z-10'
                : 'opacity-0 scale-[0.968] -translate-y-2.5 pointer-events-none z-0'
            }`}
          >
            <TranscriptPanel />
          </div>

          {/* 课堂问答层：自带底部对话框底栏，切回转写时整层与底栏一并平滑收起 */}
          <div
            aria-hidden={mobileTab !== 'chat'}
            className={`absolute inset-0 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[transform,opacity] ${
              mobileTab === 'chat'
                ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto z-20'
                : 'opacity-0 translate-y-7 scale-[0.985] pointer-events-none z-0'
            }`}
          >
            <ChatPanel
              mobileDockMode
              mobileDockVisible={mobileTab === 'chat'}
            />
          </div>

          {/* 底栏右下角持久变形切换小按钮：问答态嵌在对话框右下角，转写态仅保留该悬浮小按钮 */}
          <button
            type="button"
            data-mobile-view-toggle={mobileTab}
            aria-label={mobileTab === 'chat' ? '切换至转写记录' : '切换至课堂问答'}
            title={mobileTab === 'chat' ? '切回转写记录' : '打开课堂问答'}
            onClick={() =>
              setMobileTab((prev) => (prev === 'chat' ? 'transcript' : 'chat'))
            }
            className={`absolute right-3 bottom-[calc(12px+env(safe-area-inset-bottom,0px))] z-30 flex items-center justify-center border cursor-pointer select-none transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-90 ${
              mobileTab === 'chat'
                ? 'w-[46px] h-[46px] rounded-2xl border-[#DEE0E3] bg-[#F2F4F7] hover:bg-[#EBF2FF] hover:border-[#BEDAFF] text-[#1F2329] hover:text-[#1456F0] shadow-none translate-x-0 translate-y-0'
                : `w-12 h-12 rounded-2xl border-[#1456F0] bg-[#1456F0] hover:bg-[#3370FF] text-white shadow-[0_8px_24px_rgba(20,86,240,0.32)] -translate-x-0.5 ${
                    audioBarVisible ? '-translate-y-[74px]' : '-translate-y-1'
                  }`
            }`}
          >
            <span className="relative w-5 h-5 flex items-center justify-center">
              <MessageSquareText
                className={`absolute w-[21px] h-[21px] transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                  mobileTab === 'transcript'
                    ? 'opacity-100 scale-100 rotate-0'
                    : 'opacity-0 scale-50 -rotate-45'
                }`}
                strokeWidth={2}
              />
              <AlignLeft
                className={`absolute w-5 h-5 transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
                  mobileTab === 'chat'
                    ? 'opacity-100 scale-100 rotate-0'
                    : 'opacity-0 scale-50 rotate-45'
                }`}
                strokeWidth={2.1}
              />
            </span>
            {mobileTab === 'transcript' && isAiSending && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-white flex items-center justify-center shadow-xs"
              >
                <span className="w-2 h-2 rounded-full bg-[#3370FF] animate-pulse" />
              </span>
            )}
          </button>
        </div>
      ) : (
        <div
          ref={containerRef}
          className={`flex-1 flex min-h-0 ${isDraggingSplit ? 'select-none cursor-col-resize' : ''}`}
        >
          <div style={{ width: `${leftRatio}%` }} className="h-full min-w-0">
            <ChatPanel />
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => setIsDraggingSplit(true)}
            className={`w-1.5 shrink-0 cursor-col-resize transition-colors relative group ${
              isDraggingSplit
                ? 'bg-[#1456F0]'
                : 'bg-[#DEE0E3] hover:bg-[#3370FF]'
            }`}
          />

          <div style={{ width: `${100 - leftRatio}%` }} className="h-full min-w-0">
            <TranscriptPanel />
          </div>
        </div>
      )}

      {/* 浮动纸色课堂便签小窗口层 */}
      <StickyNotesLayer />

      {/* 手机端课堂便签篓底部抽屉（由百宝箱「课堂便签」触发） */}
      <MobileStickyBasketSheet
        open={mobileStickyBasketOpen}
        onClose={() => setMobileStickyBasketOpen(false)}
      />
    </div>
  );
};
