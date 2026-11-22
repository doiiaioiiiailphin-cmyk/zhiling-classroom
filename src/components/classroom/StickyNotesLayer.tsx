import React, { useEffect, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useIsMobileViewport } from '../../utils/desktopBridge';
import { clampStickyBounds, getStickyNoteDisplayTitle, PAPER_THEMES } from '../../utils/stickyNoteTimestamps';
import { StickyNoteWindow } from './StickyNoteWindow';

export const StickyNotesLayer: React.FC = React.memo(() => {
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const updateStickyNoteLocal = useAppStore((s) => s.updateStickyNoteLocal);
  const bringStickyNoteToFront = useAppStore((s) => s.bringStickyNoteToFront);
  const setAllStickyNotesOpen = useAppStore((s) => s.setAllStickyNotesOpen);
  const isMobile = useIsMobileViewport();

  const openNotes = useMemo(
    () =>
      stickyNotes
        .map((note, idx) => ({ note, displayIndex: idx + 1 }))
        .filter(({ note }) => note.isOpen),
    [stickyNotes]
  );

  // 窗口缩放时自动把展开中的便签夹紧回可视区域，防止便签飘出屏幕外
  useEffect(() => {
    if (isMobile || openNotes.length === 0) return;
    const handleResize = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const note of useAppStore.getState().stickyNotes) {
        if (!note.isOpen) continue;
        const clamped = clampStickyBounds(note, vw, vh);
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
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobile, openNotes.length, updateStickyNoteLocal]);

  if (openNotes.length === 0) return null;

  if (isMobile) {
    const activeEntry = openNotes.reduce((best, cur) =>
      cur.note.zOrder >= best.note.zOrder ? cur : best
    );
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-end">
        <div
          className="absolute inset-0 bg-[#1F2329]/30 backdrop-blur-[1px]"
          onClick={() => void setAllStickyNotesOpen(false)}
        />
        <div className="relative z-10 flex flex-col max-h-[76vh]">
          {openNotes.length > 1 && (
            <div className="px-3 pb-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {openNotes.map(({ note, displayIndex }) => {
                const t = PAPER_THEMES[note.paperColor] ?? PAPER_THEMES.cream;
                const active = note.id === activeEntry.note.id;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => bringStickyNoteToFront(note.id)}
                    style={{
                      backgroundColor: active ? t.headerBg : '#FFFFFF',
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
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {openNotes.map(({ note, displayIndex }) => (
        <StickyNoteWindow key={note.id} note={note} displayIndex={displayIndex} />
      ))}
    </div>
  );
});

StickyNotesLayer.displayName = 'StickyNotesLayer';
