import React, { useEffect, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useViewportLayout } from '../../utils/desktopBridge';
import {
  clampStickyBounds,
  getStickyNoteDisplayTitle,
  PAPER_THEMES,
} from '../../utils/stickyNoteTimestamps';
import { DraggableBottomSheet } from '../ui/DraggableBottomSheet';
import { StickyNoteWindow } from './StickyNoteWindow';

export const StickyNotesLayer: React.FC = React.memo(() => {
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const updateStickyNoteLocal = useAppStore((s) => s.updateStickyNoteLocal);
  const bringStickyNoteToFront = useAppStore((s) => s.bringStickyNoteToFront);
  const setAllStickyNotesOpen = useAppStore((s) => s.setAllStickyNotesOpen);
  const { width: vw, height: vh, isCompactPhoneLayout, isShortLandscape } = useViewportLayout();
  // 仅手机窄屏/矮横屏采用底部抽屉形态；平板（>=768x>520）与桌面端一致，以独立可拖放浮动小窗显示
  const useMobileSheet = isCompactPhoneLayout;

  const openNotes = useMemo(
    () =>
      stickyNotes
        .map((note, idx) => ({ note, displayIndex: idx + 1 }))
        .filter(({ note }) => note.isOpen),
    [stickyNotes]
  );

  // 窗口缩放、平板横竖屏切换或新便签展开时，自动把浮动小窗夹紧回可视区域，防止飘出屏幕外
  useEffect(() => {
    if (useMobileSheet || openNotes.length === 0) return;
    const clampAll = () => {
      const curW = window.innerWidth;
      const curH = window.innerHeight;
      for (const note of useAppStore.getState().stickyNotes) {
        if (!note.isOpen) continue;
        const clamped = clampStickyBounds(note, curW, curH);
        if (
          clamped.posX !== note.posX ||
          clamped.posY !== note.posY ||
          clamped.width !== note.width ||
          clamped.height !== note.height
        ) {
          updateStickyNoteLocal(note.id, clamped);
        }
      }
    };
    clampAll();
    window.addEventListener('resize', clampAll);
    return () => window.removeEventListener('resize', clampAll);
  }, [useMobileSheet, openNotes.length, vw, vh, updateStickyNoteLocal]);

  const activeEntry =
    openNotes.length > 0
      ? openNotes.reduce((best, cur) => (cur.note.zOrder >= best.note.zOrder ? cur : best))
      : null;

  if (useMobileSheet) {
    const activeTheme = activeEntry
      ? PAPER_THEMES[activeEntry.note.paperColor] ?? PAPER_THEMES.cream
      : PAPER_THEMES.cream;
    return (
      <DraggableBottomSheet
        open={Boolean(activeEntry)}
        onClose={() => void setAllStickyNotesOpen(false)}
        ariaLabel="课堂便签"
        zIndexClass="z-50"
        maxWidthClass={isShortLandscape ? 'w-full max-w-2xl' : 'w-full'}
        panelClassName="overflow-hidden flex flex-col max-h-[82vh] border-t"
        panelStyle={{
          backgroundColor: activeTheme.headerBg,
          borderColor: activeTheme.border,
          paddingBottom: 'var(--android-safe-bottom, 0px)',
        }}
        dataAttributes={{ 'data-mobile-sticky-sheet': 'true' }}
        showHandle
      >
        {activeEntry && (
          <div
            style={{ backgroundColor: activeTheme.headerBg }}
            className="flex flex-col min-h-0 flex-1"
          >
            {openNotes.length > 1 && (
              <div className="px-3 pb-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
                {openNotes.map(({ note, displayIndex }) => {
                  const t = PAPER_THEMES[note.paperColor] ?? PAPER_THEMES.cream;
                  const active = note.id === activeEntry.note.id;
                  return (
                    <button
                      key={note.id}
                      type="button"
                      onClick={() => bringStickyNoteToFront(note.id)}
                      style={{
                        backgroundColor: active ? t.bodyBg : '#FFFFFF',
                        borderColor: active ? t.borderStrong : '#DEE0E3',
                      }}
                      className="h-8 px-3 rounded-full border text-[14px] font-medium text-[#1F2329] shrink-0 shadow-xs cursor-pointer"
                    >
                      {getStickyNoteDisplayTitle(note, displayIndex)}
                    </button>
                  );
                })}
              </div>
            )}
            <StickyNoteWindow
              key={activeEntry.note.id}
              note={activeEntry.note}
              displayIndex={activeEntry.displayIndex}
              mobileSheet
            />
          </div>
        )}
      </DraggableBottomSheet>
    );
  }

  if (openNotes.length === 0) return null;

  return (
    <div
      data-floating-sticky-layer="true"
      className="pointer-events-none fixed inset-0 z-50 overflow-hidden"
    >
      {openNotes.map(({ note, displayIndex }) => (
        <StickyNoteWindow key={note.id} note={note} displayIndex={displayIndex} />
      ))}
    </div>
  );
});

StickyNotesLayer.displayName = 'StickyNotesLayer';
