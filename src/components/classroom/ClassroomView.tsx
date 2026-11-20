import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  BookmarkPlus,
  Camera,
  FileText,
  FileUp,
  Headphones,
  Mic,
  Pause,
  PictureInPicture2,
  Settings,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getDesktopBridge, isMacPlatform } from '../../utils/desktopBridge';
import { formatDuration } from '../../utils/format';
import { IconButton } from '../ui/IconButton';
import { MoreGridMenu, type GridMenuItem } from '../ui/MoreGridMenu';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from '../ui/WindowControls';
import { AudioSourceControl } from './AudioSourceControl';
import { ChatPanel } from './ChatPanel';
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
  const onlyBookmarksFilter = useAppStore((s) => s.onlyBookmarksFilter);
  const audioBarVisible = useAppStore((s) => s.audioPlayback.visible);
  const windowMaximized = useAppStore((s) => s.windowMaximized);

  const leaveClassroom = useAppStore((s) => s.leaveClassroom);
  const renameSession = useAppStore((s) => s.renameSession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const openNotesExportModal = useAppStore((s) => s.openNotesExportModal);
  const markConfusedNow = useAppStore((s) => s.markConfusedNow);
  const captureClassroomScreen = useAppStore((s) => s.captureClassroomScreen);
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const materialInputRef = useRef<HTMLInputElement | null>(null);

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
        label: '实时字幕',
        icon: PictureInPicture2,
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
      sessionId,
      materialCount,
      totalBookmarkCount,
      onlyBookmarksFilter,
      audioBarVisible,
      openNotesExportModal,
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

      {/* 顶部课堂控制栏：macOS 左置红黄绿交通灯 / Windows 右置三键，支持无边框拖拽移动 */}
      <header
        onDoubleClick={handleHeaderDoubleClick}
        className={`border-b border-[#DEE0E3] flex items-center justify-between gap-3 shrink-0 pywebview-drag-region ${
          isMac
            ? 'h-14 bg-white/95 backdrop-blur-md pl-4 pr-5'
            : 'h-15 bg-white pl-5 pr-3.5'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
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
              className="h-9 w-80 max-w-[42vw] rounded-lg border border-[#1456F0] bg-white px-3 text-[16px] font-semibold text-[#1F2329] focus:outline-none ring-2 ring-[#1456F0]/15"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setTitleDraft(sessionTitle);
                setEditingTitle(true);
              }}
              className="truncate rounded-lg px-2.5 py-1.5 text-[16px] font-semibold text-[#1F2329] hover:bg-[#F2F3F5] transition-colors cursor-pointer"
            >
              {sessionTitle}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 app-no-drag">
          <AudioSourceControl />

          <RecordingTimerButton />

          <IconButton
            icon={Camera}
            size="lg"
            variant="outline"
            tooltip="一键抓拍课堂画面锚定至时间轴"
            onClick={() => void captureClassroomScreen()}
          />

          <IconButton
            icon={BookmarkPlus}
            size="lg"
            variant="outline"
            tooltip="标记此处没听懂"
            onClick={() => void markConfusedNow()}
          />

          <MoreGridMenu
            items={gridItems}
            tooltip="更多课堂功能与设置"
            title="课堂百宝箱"
          />

          {!isMac && <WindowControls />}
        </div>
      </header>

      {/* 可拖拽双栏主体：左侧对话问答 + 右侧实时转写与知识点 */}
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
    </div>
  );
};
