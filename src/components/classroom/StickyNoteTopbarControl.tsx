import React, { useMemo, useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import {
  ChevronDown,
  Clock,
  Eye,
  EyeOff,
  Minimize2,
  Plus,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useAppStore } from '../../store/useAppStore';
import { isAndroidPlatform, useViewportLayout } from '../../utils/desktopBridge';
import {
  getStickyNoteDisplayTitle,
  PAPER_THEMES,
} from '../../utils/stickyNoteTimestamps';
import { DraggableBottomSheet } from '../ui/DraggableBottomSheet';
import { Tooltip } from '../ui/Tooltip';

interface StickyBasketPanelProps {
  onClose: () => void;
  showCloseButton?: boolean;
  maxListHeightClass?: string;
}

const StickyBasketPanel: React.FC<StickyBasketPanelProps> = ({
  onClose,
  showCloseButton = false,
  maxListHeightClass = 'max-h-[380px]',
}) => {
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const createStickyNote = useAppStore((s) => s.createStickyNote);
  const setStickyNoteOpen = useAppStore((s) => s.setStickyNoteOpen);
  const setAllStickyNotesOpen = useAppStore((s) => s.setAllStickyNotesOpen);
  const focusStickyNoteTimestamp = useAppStore((s) => s.focusStickyNoteTimestamp);
  const deleteStickyNote = useAppStore((s) => s.deleteStickyNote);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const openCount = useMemo(
    () => stickyNotes.filter((n) => n.isOpen).length,
    [stickyNotes]
  );

  const totalTimestampCount = useMemo(
    () => stickyNotes.reduce((sum, n) => sum + (n.timestamps?.length ?? 0), 0),
    [stickyNotes]
  );

  const sortedForBasket = useMemo(
    () =>
      [...stickyNotes].sort((a, b) => {
        if (a.isOpen !== b.isOpen) return a.isOpen ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      }),
    [stickyNotes]
  );

  const handleQuickCreate = async () => {
    onClose();
    const created = await createStickyNote();
    if (created) {
      focusStickyNoteTimestamp(created.id);
    }
  };

  return (
    <>
      {/* 便签篓头部 */}
      <div className="px-4 py-3 bg-[#F7F0D6]/85 border-b border-[#E5D8A8] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <StickyNote className="w-4 h-4 text-[#6F5414] shrink-0" strokeWidth={2} />
          <span className="text-[15px] font-semibold text-[#1F2329] truncate">
            课堂便签篓
          </span>
          <span className="text-[14px] text-[#6F5414] tabular-nums">
            ({stickyNotes.length})
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {stickyNotes.length > 0 && (
            <button
              type="button"
              onClick={() => void setAllStickyNotesOpen(openCount === 0)}
              className="h-8 px-2.5 rounded-lg border border-[#DFC983] bg-white/85 hover:bg-[#FFFDF2] text-[14px] font-medium text-[#6F5414] inline-flex items-center gap-1 whitespace-nowrap transition-colors cursor-pointer"
            >
              {openCount > 0 ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5 shrink-0" />
                  <span>全部收起</span>
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5 shrink-0" />
                  <span>全部展开</span>
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleQuickCreate()}
            className="h-8 px-2.5 rounded-lg bg-[#1456F0] hover:bg-[#3370FF] text-white text-[14px] font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>新建</span>
          </button>

          {showCloseButton && (
            <button
              type="button"
              aria-label="关闭便签篓"
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-black/6 text-[#5C4E28] flex items-center justify-center transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 便签列表 */}
      <div className={`${maxListHeightClass} overflow-y-auto p-2.5 space-y-2`}>
        {sortedForBasket.length === 0 ? (
          <div className="py-8 px-4 text-center space-y-2.5">
            <div className="w-11 h-11 mx-auto rounded-2xl bg-[#F7F0D6] text-[#6F5414] flex items-center justify-center">
              <StickyNote className="w-5 h-5" />
            </div>
            <div className="text-[15px] font-medium text-[#1F2329]">
              便签篓还是空的
            </div>
            <p className="text-[14px] text-[#646A73] leading-relaxed">
              随手新建一张纸色便签记要点，写入 [03:54] 等时间戳即可在对应转写行亮起纸色渐变并双向跳转。
            </p>
          </div>
        ) : (
          sortedForBasket.map((note, idx) => {
            const theme = PAPER_THEMES[note.paperColor] ?? PAPER_THEMES.cream;
            const displayTitle = getStickyNoteDisplayTitle(note, idx + 1);
            const previewLine =
              note.content
                .split('\n')
                .map((l) => l.trim())
                .find((l) => l && l !== displayTitle) ?? '';
            const isConfirming = confirmDeleteId === note.id;

            return (
              <div
                key={note.id}
                style={{
                  backgroundColor: theme.bodyBg,
                  borderColor: theme.border,
                }}
                className="rounded-xl border overflow-hidden transition-shadow hover:shadow-sm"
              >
                <div className="flex items-stretch">
                  <div
                    style={{ backgroundColor: theme.edgeAccent }}
                    className="w-1.5 shrink-0"
                  />
                  <div className="flex-1 min-w-0 p-2.5 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          focusStickyNoteTimestamp(note.id);
                          onClose();
                        }}
                        className="flex-1 min-w-0 text-left group cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[14px] font-semibold text-[#1F2329] group-hover:text-[#1456F0] truncate transition-colors">
                            {displayTitle}
                          </span>
                          <span
                            className={`shrink-0 px-1.5 py-0.2 rounded text-[14px] ${
                              note.isOpen
                                ? 'bg-[#EBF2FF] text-[#1456F0]'
                                : 'bg-black/5 text-[#646A73]'
                            }`}
                          >
                            {note.isOpen ? '展开中' : '已收起'}
                          </span>
                        </div>
                        {previewLine && (
                          <p className="mt-0.5 text-[14px] text-[#4E5969] truncate">
                            {previewLine}
                          </p>
                        )}
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <Tooltip
                          content={note.isOpen ? '收起到便签篓' : '重新打开便签'}
                          placement="top"
                        >
                          <button
                            type="button"
                            aria-label={note.isOpen ? '收起便签' : '打开便签'}
                            onClick={() => void setStickyNoteOpen(note.id, !note.isOpen)}
                            className="w-7 h-7 rounded-lg hover:bg-black/6 text-[#4E5969] hover:text-[#1F2329] flex items-center justify-center cursor-pointer"
                          >
                            {note.isOpen ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </Tooltip>

                        {isConfirming ? (
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteId(null);
                              void deleteStickyNote(note.id);
                            }}
                            className="h-7 px-2 rounded-lg bg-[#D83931] hover:bg-[#B82D26] text-white text-[14px] font-medium cursor-pointer"
                          >
                            确认删
                          </button>
                        ) : (
                          <Tooltip content="删除便签" placement="top">
                            <button
                              type="button"
                              aria-label="删除便签"
                              onClick={() => setConfirmDeleteId(note.id)}
                              className="w-7 h-7 rounded-lg hover:bg-[#FFECE8] text-[#646A73] hover:text-[#D83931] flex items-center justify-center cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </div>

                    {note.timestamps.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                        {note.timestamps.slice(0, 4).map((ts) => (
                          <button
                            key={ts.id}
                            type="button"
                            style={{
                              backgroundColor: theme.chipBg,
                              borderColor: theme.chipBorder,
                              color: theme.chipText,
                            }}
                            onClick={() => {
                              focusStickyNoteTimestamp(
                                note.id,
                                ts.timestampSec,
                                ts.charOffset
                              );
                              onClose();
                            }}
                            className="px-1.5 py-0.5 rounded-md border text-[14px] font-mono tabular-nums inline-flex items-center gap-1 hover:brightness-95 cursor-pointer"
                          >
                            <Clock className="w-3 h-3 shrink-0" />
                            <span>{ts.timestampText}</span>
                          </button>
                        ))}
                        {note.timestamps.length > 4 && (
                          <span className="text-[14px] text-[#646A73]">
                            +{note.timestamps.length - 4}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部状态条 */}
      {stickyNotes.length > 0 && (
        <div className="px-4 py-2.5 bg-[#FAF5E2]/90 border-t border-[#E5D8A8] flex items-center justify-between gap-3 text-[14px] text-[#6F5414] whitespace-nowrap">
          <span className="tabular-nums">展开 {openCount}/{stickyNotes.length} 张</span>
          <span className="tabular-nums">已锚定 {totalTimestampCount} 个时间戳</span>
        </div>
      )}
    </>
  );
};

interface MobileStickyBasketSheetProps {
  open: boolean;
  onClose: () => void;
}

export const MobileStickyBasketSheet: React.FC<MobileStickyBasketSheetProps> = React.memo(
  ({ open, onClose }) => {
    const isAndroid = isAndroidPlatform();
    const { isShortLandscape } = useViewportLayout();

    return (
      <DraggableBottomSheet
        open={open}
        onClose={onClose}
        ariaLabel="课堂便签篓"
        zIndexClass="z-[55]"
        maxWidthClass={isShortLandscape ? 'w-full max-w-2xl' : 'w-full'}
        panelClassName="border-t border-[#E5D8A8] bg-[#FFFDF8] overflow-hidden"
        panelStyle={
          isAndroid ? { paddingBottom: 'var(--android-safe-bottom, 0px)' } : undefined
        }
        showHandle
      >
        <StickyBasketPanel
          onClose={onClose}
          showCloseButton
          maxListHeightClass="max-h-[56vh]"
        />
      </DraggableBottomSheet>
    );
  }
);

MobileStickyBasketSheet.displayName = 'MobileStickyBasketSheet';

export const StickyNoteTopbarControl: React.FC = React.memo(() => {
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const createStickyNote = useAppStore((s) => s.createStickyNote);
  const focusStickyNoteTimestamp = useAppStore((s) => s.focusStickyNoteTimestamp);

  const [basketOpen, setBasketOpen] = useState(false);
  const { shouldRender, isVisible } = useAnimatedPresence(basketOpen, 150);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: basketOpen,
    onOpenChange: setBasketOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const openCount = useMemo(
    () => stickyNotes.filter((n) => n.isOpen).length,
    [stickyNotes]
  );

  const handleQuickCreate = async () => {
    const created = await createStickyNote();
    if (created) {
      focusStickyNoteTimestamp(created.id);
    }
  };

  return (
    <>
      {/* 紧凑组合按钮：左半区一键新建便签，右半区展开便签篓 */}
      <div
        ref={refs.setReference}
        className={`h-10 rounded-lg border inline-flex items-center overflow-hidden shrink-0 transition-all duration-150 app-no-drag ${
          basketOpen || openCount > 0
            ? 'border-[#DFC983] bg-[#FFFDF2] shadow-xs'
            : 'border-[#DEE0E3] bg-white hover:border-[#DFC983]'
        }`}
      >
        <Tooltip content="新建课堂便签条" placement="bottom">
          <button
            type="button"
            aria-label="新建课堂便签条"
            onClick={() => void handleQuickCreate()}
            className="h-full px-2.5 inline-flex items-center gap-1 text-[#6F5414] hover:bg-[#F7F0D6] active:scale-[0.97] transition-colors cursor-pointer"
          >
            <StickyNote className="w-[17px] h-[17px] shrink-0" strokeWidth={1.9} />
            <Plus className="w-3.5 h-3.5 -ml-0.5 shrink-0" strokeWidth={2.2} />
          </button>
        </Tooltip>

        <div className="w-px h-5 bg-[#E5D8A8]/80 shrink-0" />

        <Tooltip
          content={basketOpen ? null : `打开便签篓（共 ${stickyNotes.length} 张）`}
          placement="bottom"
        >
          <button
            type="button"
            aria-label="打开便签篓"
            {...getReferenceProps()}
            className={`h-full px-2 inline-flex items-center gap-1 text-[14px] font-medium tabular-nums transition-colors cursor-pointer ${
              basketOpen
                ? 'bg-[#F5EBC4] text-[#5B430C]'
                : 'text-[#6F5414] hover:bg-[#F7F0D6]'
            }`}
          >
            {stickyNotes.length > 0 && <span>{stickyNotes.length}</span>}
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform duration-150 ${
                basketOpen ? 'rotate-180' : ''
              }`}
              strokeWidth={2.1}
            />
          </button>
        </Tooltip>
      </div>

      {shouldRender && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{
              ...floatingStyles,
              visibility: isPositioned ? 'visible' : 'hidden',
            }}
            {...getFloatingProps()}
            className="z-[72] focus:outline-none app-no-drag"
          >
            <div
              className={`w-[388px] max-w-[92vw] origin-top-right rounded-2xl border border-[#E5D8A8] bg-[#FFFDF8]/98 backdrop-blur-md shadow-[0_18px_44px_rgba(31,35,41,0.16)] overflow-hidden transition-all duration-180 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                isVisible && isPositioned
                  ? 'opacity-100 scale-100 translate-y-0'
                  : 'opacity-0 scale-[0.94] -translate-y-1.5 pointer-events-none'
              }`}
            >
              <StickyBasketPanel onClose={() => setBasketOpen(false)} />
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
});

StickyNoteTopbarControl.displayName = 'StickyNoteTopbarControl';
