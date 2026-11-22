import React, { useEffect, useMemo, useState } from 'react';
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
  Pencil,
  PictureInPicture2,
  Plus,
  Search,
  Settings,
  Tags,
  Trash2,
  Users,
} from 'lucide-react';
import { BrandLogoIcon } from '../icons/ProviderIcons';
import { AudioSourceControl } from '../classroom/AudioSourceControl';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { IconButton } from '../ui/IconButton';
import { Modal } from '../ui/Modal';
import { MoreGridMenu, type GridMenuItem } from '../ui/MoreGridMenu';
import { Tooltip } from '../ui/Tooltip';
import { WindowControls } from '../ui/WindowControls';
import { api } from '../../services/api';
import { useAppStore } from '../../store/useAppStore';
import type { ClassSessionCard, FolderItem, SearchHitItem } from '../../types/domain';
import { getDesktopBridge, isAndroidPlatform, isMacPlatform } from '../../utils/desktopBridge';
import { formatDuration, formatShortDate } from '../../utils/format';

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
      ...(!isAndroid
        ? [
            {
              id: 'grid-mini-sub',
              label: '实时字幕',
              icon: PictureInPicture2,
              onClick: () => void toggleMiniOverlayWindow(),
            },
          ]
        : []),
      {
        id: 'grid-settings',
        label: '系统设置',
        icon: Settings,
        onClick: () => setSettingsOpen(true),
      },
    ],
    [isAndroid, startNewClassroom, setImportAudioModalOpen, toggleMiniOverlayWindow, setSettingsOpen]
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
      {/* 顶部导航栏：macOS 左置交通灯 / Windows 右置三键 / 移动端自动单行精简并下置搜索栏 */}
      <header
        className={`border-b border-[#DEE0E3] flex items-center justify-between gap-2 shrink-0 pywebview-drag-region ${
          isMac
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
            <span className="text-[17px] font-semibold tracking-tight text-[#1F2329] group-hover:text-[#1456F0] transition-colors">
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

          <AudioSourceControl />

          <MoreGridMenu
            items={homeGridItems}
            tooltip="更多功能与设置"
            title="工作台导航"
          />

          {!isMac && <WindowControls />}
        </div>
      </header>

      {/* 移动端专属全局搜索条（桌面端 >= 768px 自动隐藏） */}
      <div className="md:hidden border-b border-[#ECEEF2] bg-white px-4 py-2.5 shrink-0">
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
      <div className="flex-1 overflow-y-auto">
        <main className="max-w-7xl w-full mx-auto px-4 py-5 md:px-8 md:py-8 space-y-5 md:space-y-6">
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

            return (
              <div
                key={folder.id}
                onClick={() => {
                  if (!isEditing) setCurrentFolderId(folder.id);
                }}
                onContextMenu={(e) => openFolderContextMenu(e, folder)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolderId(folder.id);
                }}
                onDragLeave={() => setDragOverFolderId(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverFolderId(null);
                  const sessionId = e.dataTransfer.getData('text/session-id');
                  if (sessionId) {
                    void moveSessionToFolder(sessionId, folder.id);
                  }
                }}
                className={`min-h-[172px] rounded-xl border bg-white p-5 flex flex-col justify-between transition-all cursor-pointer ${
                  isDragTarget
                    ? 'border-[#1456F0] bg-[#EBF2FF]/55 ring-2 ring-[#1456F0]/20'
                    : 'border-[#DEE0E3] hover:border-[#3370FF] hover:shadow-[0_8px_24px_rgba(31,35,41,0.08)]'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-lg bg-[#EBF2FF] text-[#1456F0] flex items-center justify-center">
                    <Folder
                      className="w-5 h-5 fill-[#1456F0]/15"
                      strokeWidth={1.85}
                    />
                  </div>
                  {folder.hotwords && folder.hotwords.length > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-[#F0F4FF] text-[14px] font-medium text-[#1456F0]">
                      热词 {folder.hotwords.length}
                    </span>
                  )}
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

          {/* 已保存课堂卡片（位于加号右侧，点击进入继续录音，右键管理） */}
          {visibleSessions.map((session, idx) => {
            const isEditing = editingId === session.id;

            return (
              <div
                key={session.id}
                draggable={!isEditing}
                style={
                  idx >= 16
                    ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 176px' }
                    : undefined
                }
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/session-id', session.id);
                }}
                onClick={() => {
                  if (!isEditing) void openClassroom(session.id);
                }}
                onContextMenu={(e) => openSessionContextMenu(e, session)}
                className="min-h-[172px] rounded-xl border border-[#DEE0E3] bg-white p-5 flex flex-col justify-between hover:border-[#3370FF] hover:shadow-[0_8px_24px_rgba(31,35,41,0.08)] transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between">
                  <div className="w-10 h-10 rounded-lg bg-[#EBF2FF] text-[#1456F0] group-hover:bg-[#1456F0] group-hover:text-white transition-colors flex items-center justify-center">
                    <AudioLines className="w-5 h-5" strokeWidth={1.85} />
                  </div>
                  <span className="text-[14px] text-[#646A73]">
                    {formatShortDate(session.updatedAt)}
                  </span>
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

      <ContextMenu
        position={menuState.position}
        items={menuState.items}
        onClose={() => setMenuState({ position: null, items: [] })}
      />

      <Modal
        open={Boolean(hotwordFolder)}
        onClose={() => setHotwordFolder(null)}
        title={`配置学科专属热词 · ${hotwordFolder?.name ?? ''}`}
        widthClass="max-w-lg"
      >
        <div className="p-6 space-y-4">
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
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => setHotwordFolder(null)}
              className="h-10 px-4 rounded-lg border border-[#DEE0E3] bg-white hover:bg-[#F2F3F5] text-[14px] font-medium text-[#1F2329] cursor-pointer"
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
              className="h-10 px-5 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium cursor-pointer"
            >
              保存学科热词
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
