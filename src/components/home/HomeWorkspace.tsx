import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  BookOpenCheck,
  ChevronRight,
  Clock,
  CornerLeftUp,
  FileAudio,
  Folder,
  FolderInput,
  FolderOutput,
  FolderPlus,
  Loader2,
  Mic,
  MoreHorizontal,
  Pencil,
  PictureInPicture2,
  Plus,
  Search,
  Settings,
  Tags,
  Trash2,
  Users,
  Volume2,
} from 'lucide-react';
import { BrandLogoIcon } from '../icons/ProviderIcons';
import { AudioSourceControl } from '../classroom/AudioSourceControl';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { DraggableBottomSheet } from '../ui/DraggableBottomSheet';
import { IconButton } from '../ui/IconButton';
import { Modal } from '../ui/Modal';
import { MoreGridMenu, type GridMenuItem } from '../ui/MoreGridMenu';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from '../ui/WindowControls';
import { useOverscrollSpring } from '../../hooks/useOverscrollSpring';
import { api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import type { ClassSessionCard, FolderItem, SearchHitItem } from '../../types/domain';
import {
  getDesktopBridge,
  isAndroidPlatform,
  isMacPlatform,
  useViewportLayout,
} from '../../utils/desktopBridge';
import { formatDuration, formatShortDate } from '../../utils/format';
import { triggerHaptic } from '../../utils/springPhysics';

const HIT_KIND_LABELS: Record<SearchHitItem['kind'], string> = {
  title: '课堂标题',
  topic: '段落主题',
  utterance: '转写原话',
  highlight: '重点术语',
  note: '个人批注',
  chat: '课堂问答',
  sticky_note: '课堂便签',
};

export const HomeWorkspace: React.FC = () => {
  const folders = useAppStore((s) => s.folders);
  const sessions = useAppStore((s) => s.sessions);
  const currentFolderId = useAppStore((s) => s.currentFolderId);
  const setCurrentFolderId = useAppStore((s) => s.setCurrentFolderId);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const createFolder = useAppStore((s) => s.createFolder);
  const renameFolder = useAppStore((s) => s.renameFolder);
  const updateFolderHotwords = useAppStore((s) => s.updateFolderHotwords);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const startNewClassroom = useAppStore((s) => s.startNewClassroom);
  const openClassroom = useAppStore((s) => s.openClassroom);
  const openSessionAtHit = useAppStore((s) => s.openSessionAtHit);
  const renameSession = useAppStore((s) => s.renameSession);
  const moveSessionToFolder = useAppStore((s) => s.moveSessionToFolder);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const openNotesExportModal = useAppStore((s) => s.openNotesExportModal);
  const setImportAudioModalOpen = useAppStore((s) => s.setImportAudioModalOpen);
  const toggleMiniOverlayWindow = useAppStore((s) => s.toggleMiniOverlayWindow);
  const windowMaximized = useAppStore((s) => s.windowMaximized);
  const setWindowMaximized = useAppStore((s) => s.setWindowMaximized);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHitItem[]>([]);
  const [searchingGlobal, setSearchingGlobal] = useState(false);
  const [hotwordFolder, setHotwordFolder] = useState<FolderItem | null>(null);
  const [hotwordsDraft, setHotwordsDraft] = useState('');
  const viewport = useViewportLayout();
  const isCompactPhoneLayout = viewport.isCompactPhoneLayout;
  const isMobileInteraction = viewport.isMobileTouchLayout;
  const homeOverscroll = useOverscrollSpring({ enabled: isMobileInteraction });

  type HomeMobileActionTarget =
    | { kind: 'folder'; folder: FolderItem }
    | { kind: 'session'; session: ClassSessionCard };

  const [mobileCardAction, setMobileCardAction] = useState<HomeMobileActionTarget | null>(null);
  const [showMoveFolderPicker, setShowMoveFolderPicker] = useState(false);
  const [pressingCardKey, setPressingCardKey] = useState<string | null>(null);
  const cardPressTimerRef = useRef<number | null>(null);
  const cardPressFeedbackTimerRef = useRef<number | null>(null);
  const cardPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressCardClickUntilRef = useRef<number>(0);

  const clearCardPressTimers = () => {
    if (cardPressTimerRef.current !== null) {
      window.clearTimeout(cardPressTimerRef.current);
      cardPressTimerRef.current = null;
    }
    if (cardPressFeedbackTimerRef.current !== null) {
      window.clearTimeout(cardPressFeedbackTimerRef.current);
      cardPressFeedbackTimerRef.current = null;
    }
    cardPressOriginRef.current = null;
    setPressingCardKey(null);
  };

  useEffect(() => clearCardPressTimers, []);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearchingGlobal(false);
      return;
    }
    let cancelled = false;
    setSearchingGlobal(true);
    const timer = window.setTimeout(() => {
      void api
        .searchGlobal(q, currentFolderId)
        .then((hits) => {
          if (!cancelled) setSearchHits(hits);
        })
        .catch(() => {
          if (!cancelled) setSearchHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingGlobal(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, currentFolderId]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  const [menuState, setMenuState] = useState<{
    position: { x: number; y: number } | null;
    items: ContextMenuItem[];
  }>({ position: null, items: [] });

  const activeFolder = useMemo(
    () => folders.find((f) => f.id === currentFolderId) ?? null,
    [folders, currentFolderId]
  );

  const visibleFolders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return folders.filter((f) => {
      const inCurrentDir = f.parentId === currentFolderId;
      if (!inCurrentDir) return false;
      return !q || f.name.toLowerCase().includes(q);
    });
  }, [folders, currentFolderId, searchQuery]);

  const visibleSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sessions.filter((s) => {
      const inCurrentDir = q ? true : s.folderId === currentFolderId;
      if (!inCurrentDir) return false;
      return !q || s.title.toLowerCase().includes(q);
    });
  }, [sessions, currentFolderId, searchQuery]);

  const folderCountsMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      if (s.folderId) {
        map.set(s.folderId, (map.get(s.folderId) ?? 0) + 1);
      }
    }
    return map;
  }, [sessions]);

  const countSessionsInFolder = (folderId: string) => folderCountsMap.get(folderId) ?? 0;

  const handleStartRename = (id: string, initialText: string) => {
    setEditingId(id);
    setEditingValue(initialText);
  };

  const commitRename = async (type: 'folder' | 'session', id: string) => {
    const trimmed = editingValue.trim();
    setEditingId(null);
    if (!trimmed) return;
    if (type === 'folder') {
      await renameFolder(id, trimmed);
    } else {
      await renameSession(id, trimmed);
    }
  };

  const handleCreateFolderAndEdit = async () => {
    const created = await createFolder('新建文件夹');
    setEditingId(created.id);
    setEditingValue(created.name);
  };

  const openCanvasContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isMobileInteraction) return;
    setMenuState({
      position: { x: e.clientX, y: e.clientY },
      items: [
        {
          id: 'new-class',
          label: '开启新课堂',
          icon: Mic,
          onClick: () => void startNewClassroom(),
        },
        {
          id: 'import-audio',
          label: '导入本地音视频创建课堂',
          icon: FileAudio,
          onClick: () => setImportAudioModalOpen(true),
        },
        {
          id: 'new-folder',
          label: '新建文件夹',
          icon: FolderPlus,
          onClick: () => void handleCreateFolderAndEdit(),
        },
      ],
    });
  };

  const openFolderContextMenu = (e: React.MouseEvent, folder: FolderItem) => {
    e.preventDefault();
    e.stopPropagation();
    if (isMobileInteraction) return;
    setMenuState({
      position: { x: e.clientX, y: e.clientY },
      items: [
        {
          id: 'rename-folder',
          label: '重命名文件夹',
          icon: Pencil,
          onClick: () => handleStartRename(folder.id, folder.name),
        },
        {
          id: 'folder-hotwords',
          label: '配置学科专属热词',
          icon: Tags,
          onClick: () => {
            setHotwordFolder(folder);
            setHotwordsDraft((folder.hotwords ?? []).join('\n'));
          },
        },
        {
          id: 'new-folder',
          label: '新建同级文件夹',
          icon: FolderPlus,
          onClick: () => void handleCreateFolderAndEdit(),
        },
        {
          id: 'delete-folder',
          label: '删除文件夹',
          icon: Trash2,
          danger: true,
          onClick: () => void deleteFolder(folder.id),
        },
      ],
    });
  };

  const openSessionContextMenu = (e: React.MouseEvent, session: ClassSessionCard) => {
    e.preventDefault();
    e.stopPropagation();
    if (isMobileInteraction) return;

    const targetFolders = folders.filter((f) => f.id !== session.folderId);
    const moveTargets: NonNullable<ContextMenuItem['children']> = [];

    if (session.folderId !== null) {
      moveTargets.push({
        id: 'move-root',
        label: '移回主界面根目录',
        icon: FolderOutput,
        onClick: () => void moveSessionToFolder(session.id, null),
      });
    }

    for (const f of targetFolders) {
      moveTargets.push({
        id: `move-${f.id}`,
        label: f.name,
        icon: Folder,
        onClick: () => void moveSessionToFolder(session.id, f.id),
      });
    }

    const items: ContextMenuItem[] = [
      {
        id: 'enter-session',
        label: '进入课堂继续录音',
        icon: Mic,
        onClick: () => void openClassroom(session.id),
      },
      {
        id: 'notes-export-session',
        label: '全课精编笔记与导出',
        icon: BookOpenCheck,
        onClick: () => openNotesExportModal(session.id, 'notes'),
      },
      {
        id: 'rename-session',
        label: '重命名课堂',
        icon: Pencil,
        onClick: () => handleStartRename(session.id, session.title),
      },
    ];

    if (moveTargets.length > 0) {
      items.push({
        id: 'move-to-folder',
        label: '移入文件夹',
        icon: FolderInput,
        children: moveTargets,
      });
    }

    items.push(
      {
        id: 'create-folder',
        label: '新建文件夹',
        icon: FolderPlus,
        onClick: () => void handleCreateFolderAndEdit(),
      },
      {
        id: 'delete-session',
        label: '删除课堂',
        icon: Trash2,
        danger: true,
        onClick: () => void deleteSession(session.id),
      }
    );

    setMenuState({
      position: { x: e.clientX, y: e.clientY },
      items,
    });
  };

  const isMac = isMacPlatform();
  const isAndroid = isAndroidPlatform();
  const isShortLandscape = viewport.isShortLandscape;
  // 平板大屏（>=768px 且非矮横屏）与电脑一致，音频设置直接展示在顶栏
  const isCompactMobileChrome = isCompactPhoneLayout;

  const startCardPress = (
    cardKey: string,
    target: HomeMobileActionTarget,
    editing: boolean,
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!isMobileInteraction || editing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (
      e.target instanceof Element &&
      e.target.closest('button, input, textarea, [data-card-more="true"]')
    ) {
      return;
    }
    clearCardPressTimers();
    cardPressOriginRef.current = { x: e.clientX, y: e.clientY };
    cardPressFeedbackTimerRef.current = window.setTimeout(() => {
      setPressingCardKey(cardKey);
    }, 110);
    cardPressTimerRef.current = window.setTimeout(() => {
      suppressCardClickUntilRef.current = performance.now() + 420;
      clearCardPressTimers();
      triggerHaptic('medium');
      setShowMoveFolderPicker(false);
      setMobileCardAction(target);
    }, 420);
  };

  const handleCardPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const origin = cardPressOriginRef.current;
    if (!origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 8) {
      clearCardPressTimers();
    }
  };
  const micEnabled = useAppStore((s) => s.settings?.micEnabled ?? true);
  const systemAudioEnabled = useAppStore((s) => s.settings?.systemAudioEnabled ?? false);
  const previewFloatingOverlayOpen = useAppStore((s) => s.previewFloatingOverlayOpen);

  const homeGridItems = useMemo<GridMenuItem[]>(
    () => [
      {
        id: 'grid-new-class',
        label: '新建课堂',
        icon: Mic,
        onClick: () => void startNewClassroom(),
      },
      {
        id: 'grid-import-audio',
        label: '导入录音',
        icon: FileAudio,
        onClick: () => setImportAudioModalOpen(true),
      },
      {
        id: 'grid-new-folder',
        label: '新建目录',
        icon: FolderPlus,
        onClick: () => void handleCreateFolderAndEdit(),
      },
      ...(isCompactMobileChrome
        ? [
            {
              id: 'grid-audio-settings',
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
        id: 'grid-mini-sub',
        label: isAndroid ? '悬浮小窗' : '实时字幕',
        icon: PictureInPicture2,
        active: isAndroid ? previewFloatingOverlayOpen : undefined,
        onClick: () => void toggleMiniOverlayWindow(),
      },
      {
        id: 'grid-settings',
        label: '系统设置',
        icon: Settings,
        onClick: () => setSettingsOpen(true),
      },
    ],
    [
      isAndroid,
      isCompactMobileChrome,
      previewFloatingOverlayOpen,
      micEnabled,
      systemAudioEnabled,
      startNewClassroom,
      setImportAudioModalOpen,
      toggleMiniOverlayWindow,
      setSettingsOpen,
    ]
  );

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

  return (
    <div
      className="h-full flex flex-col bg-[#F5F6F7] text-[#1F2329] select-none overflow-hidden"
      onContextMenu={openCanvasContextMenu}
    >
      {/* 顶部导航栏：macOS 左置交通灯 / Windows 右置三键 / 手机横竖屏自适应紧凑高度 */}
      <header
        className={`border-b border-[#DEE0E3] flex items-center justify-between gap-2 shrink-0 pywebview-drag-region ${
          isShortLandscape
            ? 'h-12 bg-white px-4'
            : isMac
              ? 'h-14 bg-white/95 backdrop-blur-md pl-4 pr-5'
              : 'h-14 md:h-16 bg-white px-4 md:pl-8 md:pr-4'
        }`}
        onContextMenu={(e) => e.stopPropagation()}
        onDoubleClick={handleHeaderDoubleClick}
      >
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          {isMac && <WindowControls />}
          <button
            type="button"
            onClick={() => setCurrentFolderId(null)}
            className="flex items-center gap-2 md:gap-2.5 cursor-pointer focus:outline-none group shrink-0"
          >
            <BrandLogoIcon className="w-7 h-7" />
            <span className="text-[17px] font-semibold tracking-tight text-[#1F2329] group-hover:text-[#1456F0] transition-colors whitespace-nowrap">
              知聆课堂
            </span>
          </button>

          {activeFolder && (
            <>
              <ChevronRight className="w-4 h-4 text-[#8F959E] shrink-0" strokeWidth={1.8} />
              <span className="text-[15px] md:text-[16px] font-medium text-[#1456F0] truncate">
                {activeFolder.name}
              </span>
              <IconButton
                icon={CornerLeftUp}
                tooltip="返回主目录"
                onClick={() => setCurrentFolderId(activeFolder.parentId)}
                className="ml-0.5 shrink-0"
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-2 md:gap-2.5 app-no-drag shrink-0">
          <div className="hidden md:flex items-center gap-2 h-10 w-72 rounded-lg border border-[#DEE0E3] bg-[#F5F6F7]/70 px-3.5 focus-within:bg-white focus-within:border-[#1456F0] focus-within:ring-2 focus-within:ring-[#1456F0]/15 transition-all">
            <Search className="w-4 h-4 text-[#646A73] shrink-0" strokeWidth={1.8} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="全局搜索标题、转写、术语或问答..."
              className="w-full bg-transparent text-[14px] text-[#1F2329] placeholder-[#646A73] focus:outline-none"
            />
          </div>

          {!isCompactMobileChrome && <AudioSourceControl />}

          <MoreGridMenu
            items={homeGridItems}
            tooltip="更多功能与设置"
            title="工作台导航"
          />

          {!isMac && <WindowControls />}
        </div>
      </header>

      {/* 移动端竖屏专属全局搜索条（桌面端或手机横屏 >= 768px 自动隐藏，直接使用顶栏内嵌搜索） */}
      <div className="md:hidden border-b border-[#ECEEF2] bg-white px-4 py-2 shrink-0">
        <div className="flex items-center gap-2 h-10 w-full rounded-lg border border-[#DEE0E3] bg-[#F5F6F7]/80 px-3 focus-within:bg-white focus-within:border-[#1456F0] focus-within:ring-2 focus-within:ring-[#1456F0]/15 transition-all">
          <Search className="w-4 h-4 text-[#646A73] shrink-0" strokeWidth={1.8} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索课堂标题、转写、便签或问答..."
            className="w-full bg-transparent text-[14px] text-[#1F2329] placeholder-[#646A73] focus:outline-none"
          />
        </div>
      </div>

      {/* 主体卡片工作区：内部独立滚动，外框保持自定义圆角 */}
      <div ref={homeOverscroll.bindScrollRef} className="flex-1 overflow-y-auto overscroll-contain-y">
        <main
          ref={homeOverscroll.contentRef}
          className="max-w-7xl w-full mx-auto px-4 py-5 md:px-8 md:py-8 space-y-5 md:space-y-6"
        >
        {searchQuery.trim().length > 0 && (
          <section className="rounded-xl border border-[#DEE0E3] bg-white p-5 space-y-3 shadow-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[15px] font-semibold text-[#1F2329]">
                <Search className="w-4 h-4 text-[#1456F0]" />
                <span>跨课堂全文检索结果</span>
              </div>
              {searchingGlobal ? (
                <span className="inline-flex items-center gap-1.5 text-[14px] text-[#646A73]">
                  <Loader2 className="w-4 h-4 animate-spin text-[#1456F0]" />
                  <span>正在检索...</span>
                </span>
              ) : (
                <span className="text-[14px] text-[#646A73]">
                  共命中 {searchHits.length} 处课堂内容（点击可直达对应句子）
                </span>
              )}
            </div>

            {searchHits.length > 0 ? (
              <div className="divide-y divide-[#ECEEF2] max-h-72 overflow-y-auto">
                {searchHits.map((hit, i) => (
                  <button
                    key={`${hit.sessionId}-${hit.utteranceId ?? hit.segmentId ?? i}`}
                    type="button"
                    onClick={() => void openSessionAtHit(hit)}
                    className="w-full py-2.5 px-3 -mx-1 rounded-lg hover:bg-[#F0F4FF]/70 text-left flex items-start justify-between gap-4 transition-colors cursor-pointer"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded bg-[#EBF2FF] text-[#1456F0] text-[14px] font-medium">
                          {HIT_KIND_LABELS[hit.kind]}
                        </span>
                        <span className="text-[15px] font-semibold text-[#1F2329] truncate">
                          {hit.sessionTitle}
                        </span>
                        {hit.timestampText && (
                          <span className="text-[14px] font-mono text-[#1456F0] tabular-nums">
                            [{hit.timestampText}]
                          </span>
                        )}
                      </div>
                      <p className="text-[14px] text-[#4E5969] line-clamp-2">{hit.snippet}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[#8F959E] shrink-0 mt-1" />
                  </button>
                ))}
              </div>
            ) : (
              !searchingGlobal && (
                <p className="text-[14px] text-[#646A73]">
                  未在转写正文、重点术语或问答记录中找到匹配项。
                </p>
              )
            )}
          </section>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {/* 首格加号卡片：点击立即开启新课堂 */}
          <Tooltip content="开启新课堂" placement="bottom">
            <button
              type="button"
              onClick={() => void startNewClassroom()}
              onContextMenu={(e) => e.stopPropagation()}
              aria-label="开启新课堂"
              className="min-h-[172px] rounded-xl border-[1.5px] border-dashed border-[#B8C6E3] bg-white hover:border-[#1456F0] hover:bg-[#F0F4FF]/60 hover:shadow-[0_8px_24px_rgba(20,86,240,0.08)] transition-all cursor-pointer flex items-center justify-center group focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1456F0]/30"
            >
              <div className="w-14 h-14 rounded-2xl bg-[#EBF2FF] text-[#1456F0] group-hover:bg-[#1456F0] group-hover:text-white transition-colors flex items-center justify-center">
                <Plus className="w-7 h-7" strokeWidth={2} />
              </div>
            </button>
          </Tooltip>

          {/* 文件夹卡片（位于加号右侧） */}
          {visibleFolders.map((folder) => {
            const isEditing = editingId === folder.id;
            const isDragTarget = dragOverFolderId === folder.id;
            const cardKey = `folder:${folder.id}`;
            const isPressing = pressingCardKey === cardKey;

            return (
              <div
                key={folder.id}
                data-home-folder-id={folder.id}
                onClick={() => {
                  if (performance.now() < suppressCardClickUntilRef.current) return;
                  if (!isEditing) setCurrentFolderId(folder.id);
                }}
                onPointerDown={(e) =>
                  startCardPress(cardKey, { kind: 'folder', folder }, isEditing, e)
                }
                onPointerMove={handleCardPointerMove}
                onPointerUp={clearCardPressTimers}
                onPointerCancel={clearCardPressTimers}
                onPointerLeave={clearCardPressTimers}
                onContextMenu={(e) => openFolderContextMenu(e, folder)}
                onDragOver={
                  isMobileInteraction
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        setDragOverFolderId(folder.id);
                      }
                }
                onDragLeave={isMobileInteraction ? undefined : () => setDragOverFolderId(null)}
                onDrop={
                  isMobileInteraction
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        setDragOverFolderId(null);
                        const sessionId = e.dataTransfer.getData('text/session-id');
                        if (sessionId) {
                          void moveSessionToFolder(sessionId, folder.id);
                        }
                      }
                }
                className={`spring-press-card min-h-[172px] rounded-xl border bg-white p-5 flex flex-col justify-between cursor-pointer transition-transform ${
                  isPressing
                    ? 'scale-[0.98] border-[#1456F0] bg-[#F5F8FF] ring-2 ring-[#1456F0]/25'
                    : isDragTarget
                      ? 'border-[#1456F0] bg-[#EBF2FF]/55 ring-2 ring-[#1456F0]/20'
                      : 'border-[#DEE0E3] hover:border-[#3370FF] hover:shadow-[0_8px_24px_rgba(31,35,41,0.08)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="w-10 h-10 rounded-lg bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                    <Folder
                      className="w-5 h-5 fill-[#1456F0]/15"
                      strokeWidth={1.85}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    {folder.hotwords && folder.hotwords.length > 0 && (
                      <span className="px-2 py-0.5 rounded-md bg-[#F0F4FF] text-[14px] font-medium text-[#1456F0]">
                        热词 {folder.hotwords.length}
                      </span>
                    )}
                    {isMobileInteraction && !isEditing && (
                      <button
                        type="button"
                        data-card-more="true"
                        aria-label={`更多操作：${folder.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowMoveFolderPicker(false);
                          setMobileCardAction({ kind: 'folder', folder });
                        }}
                        className="w-8 h-8 -mr-1.5 -mt-1 rounded-lg hover:bg-[#F2F3F5] active:bg-[#E5E6EB] text-[#646A73] flex items-center justify-center cursor-pointer"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={() => void commitRename('folder', folder.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename('folder', folder.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="w-full h-9 rounded-lg border border-[#1456F0] bg-white px-2.5 text-[15px] font-medium text-[#1F2329] focus:outline-none ring-2 ring-[#1456F0]/15"
                    />
                  ) : (
                    <h3 className="text-[16px] font-medium text-[#1F2329] line-clamp-2">
                      {folder.name}
                    </h3>
                  )}

                  <div className="flex items-center justify-between text-[14px] text-[#4E5969]">
                    <span>{countSessionsInFolder(folder.id)} 节课堂</span>
                    <span>{formatShortDate(folder.updatedAt)}</span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* 已保存课堂卡片（位于加号右侧；桌面端右键管理，移动端长按或点 ··· 管理） */}
          {visibleSessions.map((session, idx) => {
            const isEditing = editingId === session.id;
            const cardKey = `session:${session.id}`;
            const isPressing = pressingCardKey === cardKey;

            return (
              <div
                key={session.id}
                data-home-session-id={session.id}
                draggable={!isEditing && !isMobileInteraction}
                style={
                  idx >= 16
                    ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 176px' }
                    : undefined
                }
                onDragStart={
                  isMobileInteraction
                    ? undefined
                    : (e) => {
                        e.dataTransfer.setData('text/session-id', session.id);
                      }
                }
                onClick={() => {
                  if (performance.now() < suppressCardClickUntilRef.current) return;
                  if (!isEditing) void openClassroom(session.id);
                }}
                onPointerDown={(e) =>
                  startCardPress(cardKey, { kind: 'session', session }, isEditing, e)
                }
                onPointerMove={handleCardPointerMove}
                onPointerUp={clearCardPressTimers}
                onPointerCancel={clearCardPressTimers}
                onPointerLeave={clearCardPressTimers}
                onContextMenu={(e) => openSessionContextMenu(e, session)}
                className={`spring-press-card min-h-[172px] rounded-xl border bg-white p-5 flex flex-col justify-between cursor-pointer group transition-transform ${
                  isPressing
                    ? 'scale-[0.98] border-[#1456F0] bg-[#F5F8FF] ring-2 ring-[#1456F0]/25'
                    : 'border-[#DEE0E3] hover:border-[#3370FF] hover:shadow-[0_8px_24px_rgba(31,35,41,0.08)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="w-10 h-10 rounded-lg bg-[#EBF2FF] text-[#1456F0] group-hover:bg-[#1456F0] group-hover:text-white transition-colors flex items-center justify-center shrink-0">
                    <AudioLines className="w-5 h-5" strokeWidth={1.85} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] text-[#646A73]">
                      {formatShortDate(session.updatedAt)}
                    </span>
                    {isMobileInteraction && !isEditing && (
                      <button
                        type="button"
                        data-card-more="true"
                        aria-label={`更多操作：${session.title}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowMoveFolderPicker(false);
                          setMobileCardAction({ kind: 'session', session });
                        }}
                        className="w-8 h-8 -mr-1.5 -mt-1 rounded-lg hover:bg-[#F2F3F5] active:bg-[#E5E6EB] text-[#646A73] flex items-center justify-center cursor-pointer"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2.5 mt-3">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={() => void commitRename('session', session.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename('session', session.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      className="w-full h-9 rounded-lg border border-[#1456F0] bg-white px-2.5 text-[15px] font-medium text-[#1F2329] focus:outline-none ring-2 ring-[#1456F0]/15"
                    />
                  ) : (
                    <h3 className="text-[16px] font-medium text-[#1F2329] line-clamp-2 leading-snug">
                      {session.title}
                    </h3>
                  )}

                  <div className="flex items-center gap-4 text-[14px] text-[#4E5969]">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-[#646A73]" strokeWidth={1.8} />
                      {formatDuration(session.durationSeconds)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-[#646A73]" strokeWidth={1.8} />
                      {session.speakerCount} 人
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </main>
      </div>

      {!isMobileInteraction && (
        <ContextMenu
          position={menuState.position}
          items={menuState.items}
          onClose={() => setMenuState({ position: null, items: [] })}
        />
      )}

      <DraggableBottomSheet
        open={Boolean(mobileCardAction)}
        onClose={() => {
          setMobileCardAction(null);
          setShowMoveFolderPicker(false);
        }}
        ariaLabel={mobileCardAction?.kind === 'folder' ? '文件夹操作' : '课堂操作'}
        zIndexClass="z-[60]"
        maxWidthClass="w-full max-w-lg"
        panelClassName="bg-white"
        dataAttributes={{ 'data-mobile-home-sheet': 'true' }}
        showHandle
      >
        {mobileCardAction && (
          <div
            style={{ paddingBottom: 'calc(16px + var(--android-safe-bottom, 0px))' }}
            className="px-4 pt-1 space-y-3.5 max-h-[78vh] overflow-y-auto overscroll-contain-y"
          >
            {mobileCardAction.kind === 'folder' ? (
              <>
                <div className="rounded-xl border border-[#ECEEF2] bg-[#F7F8FA] px-3.5 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-lg bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                      <Folder className="w-4 h-4 fill-[#1456F0]/15" strokeWidth={1.9} />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-[#1F2329] truncate">
                        {mobileCardAction.folder.name}
                      </div>
                      <div className="text-[13px] text-[#646A73]">
                        {countSessionsInFolder(mobileCardAction.folder.id)} 节课堂
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-[#ECEEF2] bg-[#F8F9FA] divide-y divide-[#ECEEF2] overflow-hidden">
                  <button
                    type="button"
                    data-home-action="rename-folder"
                    onClick={() => {
                      const f = mobileCardAction.folder;
                      setMobileCardAction(null);
                      handleStartRename(f.id, f.name);
                    }}
                    className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                  >
                    <Pencil className="w-4 h-4 text-[#4E5969] shrink-0" />
                    <span>重命名文件夹</span>
                  </button>
                  <button
                    type="button"
                    data-home-action="folder-hotwords"
                    onClick={() => {
                      const f = mobileCardAction.folder;
                      setMobileCardAction(null);
                      setHotwordFolder(f);
                      setHotwordsDraft((f.hotwords ?? []).join('\n'));
                    }}
                    className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                  >
                    <Tags className="w-4 h-4 text-[#1456F0] shrink-0" />
                    <span>配置学科专属热词</span>
                  </button>
                  <button
                    type="button"
                    data-home-action="new-folder"
                    onClick={() => {
                      setMobileCardAction(null);
                      void handleCreateFolderAndEdit();
                    }}
                    className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                  >
                    <FolderPlus className="w-4 h-4 text-[#4E5969] shrink-0" />
                    <span>新建同级文件夹</span>
                  </button>
                </div>

                <div className="rounded-2xl border border-[#ECEEF2] bg-[#F8F9FA] overflow-hidden">
                  <button
                    type="button"
                    data-home-action="delete-folder"
                    onClick={() => {
                      const fid = mobileCardAction.folder.id;
                      setMobileCardAction(null);
                      void deleteFolder(fid);
                    }}
                    className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#D83931] active:bg-[#FFECE8] cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4 text-[#D83931] shrink-0" />
                    <span>删除文件夹</span>
                  </button>
                </div>
              </>
            ) : (
              (() => {
                const s = mobileCardAction.session;
                const moveTargets = folders.filter((f) => f.id !== s.folderId);
                const canMove = s.folderId !== null || moveTargets.length > 0;
                return (
                  <>
                    <div className="rounded-xl border border-[#ECEEF2] bg-[#F7F8FA] px-3.5 py-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center shrink-0">
                          <AudioLines className="w-4 h-4" strokeWidth={1.9} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[15px] font-semibold text-[#1F2329] truncate">
                            {s.title}
                          </div>
                          <div className="text-[13px] text-[#646A73] flex items-center gap-3">
                            <span>{formatDuration(s.durationSeconds)}</span>
                            <span>{s.speakerCount} 人</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-[#ECEEF2] bg-[#F8F9FA] divide-y divide-[#ECEEF2] overflow-hidden">
                      <button
                        type="button"
                        data-home-action="enter-session"
                        onClick={() => {
                          setMobileCardAction(null);
                          void openClassroom(s.id);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                      >
                        <Mic className="w-4 h-4 text-[#1456F0] shrink-0" />
                        <span>进入课堂继续录音</span>
                      </button>
                      <button
                        type="button"
                        data-home-action="notes-export-session"
                        onClick={() => {
                          setMobileCardAction(null);
                          openNotesExportModal(s.id, 'notes');
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                      >
                        <BookOpenCheck className="w-4 h-4 text-[#1456F0] shrink-0" />
                        <span>全课精编笔记与导出</span>
                      </button>
                      <button
                        type="button"
                        data-home-action="rename-session"
                        onClick={() => {
                          setMobileCardAction(null);
                          handleStartRename(s.id, s.title);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                      >
                        <Pencil className="w-4 h-4 text-[#4E5969] shrink-0" />
                        <span>重命名课堂</span>
                      </button>

                      {canMove && (
                        <div>
                          <button
                            type="button"
                            data-home-action="toggle-move-folder"
                            onClick={() => setShowMoveFolderPicker((v) => !v)}
                            className="w-full min-h-[48px] px-4 py-2.5 flex items-center justify-between gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                          >
                            <span className="inline-flex items-center gap-3">
                              <FolderInput className="w-4 h-4 text-[#4E5969] shrink-0" />
                              <span>移入文件夹</span>
                            </span>
                            <ChevronRight
                              className={`w-4 h-4 text-[#8F959E] transition-transform ${
                                showMoveFolderPicker ? 'rotate-90' : ''
                              }`}
                            />
                          </button>

                          {showMoveFolderPicker && (
                            <div className="bg-white border-t border-[#ECEEF2] divide-y divide-[#F2F3F5]">
                              {s.folderId !== null && (
                                <button
                                  type="button"
                                  data-home-action="move-root"
                                  onClick={() => {
                                    setMobileCardAction(null);
                                    setShowMoveFolderPicker(false);
                                    void moveSessionToFolder(s.id, null);
                                  }}
                                  className="w-full min-h-[44px] pl-11 pr-4 py-2 flex items-center gap-2.5 text-[14px] text-[#4E5969] active:bg-[#EBF2FF] cursor-pointer"
                                >
                                  <FolderOutput className="w-4 h-4 shrink-0" />
                                  <span>移回主界面根目录</span>
                                </button>
                              )}
                              {moveTargets.map((f) => (
                                <button
                                  key={f.id}
                                  type="button"
                                  data-home-action={`move-${f.id}`}
                                  onClick={() => {
                                    setMobileCardAction(null);
                                    setShowMoveFolderPicker(false);
                                    void moveSessionToFolder(s.id, f.id);
                                  }}
                                  className="w-full min-h-[44px] pl-11 pr-4 py-2 flex items-center gap-2.5 text-[14px] text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                                >
                                  <Folder className="w-4 h-4 text-[#1456F0] shrink-0" />
                                  <span className="truncate">{f.name}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      <button
                        type="button"
                        data-home-action="create-folder"
                        onClick={() => {
                          setMobileCardAction(null);
                          void handleCreateFolderAndEdit();
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#1F2329] active:bg-[#EBF2FF] cursor-pointer"
                      >
                        <FolderPlus className="w-4 h-4 text-[#4E5969] shrink-0" />
                        <span>新建文件夹</span>
                      </button>
                    </div>

                    <div className="rounded-2xl border border-[#ECEEF2] bg-[#F8F9FA] overflow-hidden">
                      <button
                        type="button"
                        data-home-action="delete-session"
                        onClick={() => {
                          setMobileCardAction(null);
                          void deleteSession(s.id);
                        }}
                        className="w-full min-h-[48px] px-4 py-2.5 flex items-center gap-3 text-[15px] font-medium text-[#D83931] active:bg-[#FFECE8] cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4 text-[#D83931] shrink-0" />
                        <span>删除课堂</span>
                      </button>
                    </div>
                  </>
                );
              })()
            )}

            <button
              type="button"
              onClick={() => {
                setMobileCardAction(null);
                setShowMoveFolderPicker(false);
              }}
              className="w-full h-11 rounded-xl bg-[#F2F3F5] active:bg-[#E5E6EB] text-[15px] font-medium text-[#1F2329] transition-colors cursor-pointer"
            >
              取消
            </button>
          </div>
        )}
      </DraggableBottomSheet>

      <Modal
        open={Boolean(hotwordFolder)}
        onClose={() => setHotwordFolder(null)}
        title={`配置学科专属热词 · ${hotwordFolder?.name ?? ''}`}
        widthClass="max-w-lg"
      >
        <div className="p-4 sm:p-6 space-y-4">
          <p className="text-[14px] text-[#4E5969] leading-relaxed">
            为该科目文件夹添加专业名词、算法名称或人名（每行或以逗号分隔一个词）。该文件夹下的课堂在语音转写、顺句纠错与重点词标注时将自动注入这些热词，避免同音误识。
          </p>
          <textarea
            rows={6}
            value={hotwordsDraft}
            onChange={(e) => setHotwordsDraft(e.target.value)}
            placeholder={'例如：\nTarjan\n线段树懒标记\n斜率优化\n状态转移方程'}
            className="w-full rounded-xl border border-[#DEE0E3] bg-white p-3.5 text-[15px] text-[#1F2329] focus:outline-none focus:border-[#1456F0]"
          />
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5 sm:gap-3 pt-1">
            <button
              type="button"
              onClick={() => setHotwordFolder(null)}
              className="min-h-10 py-2 px-4 w-full sm:w-auto rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] text-[14px] font-medium text-[#1F2329] inline-flex items-center justify-center whitespace-nowrap cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => {
                if (!hotwordFolder) return;
                const parsed = hotwordsDraft
                  .split(/[\n,，、;；]+/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                void updateFolderHotwords(hotwordFolder.id, parsed);
                setHotwordFolder(null);
              }}
              className="min-h-10 py-2 px-5 w-full sm:w-auto rounded-lg bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium inline-flex items-center justify-center whitespace-nowrap cursor-pointer"
            >
              保存学科热词
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
