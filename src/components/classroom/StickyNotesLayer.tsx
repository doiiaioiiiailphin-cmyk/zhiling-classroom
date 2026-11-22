import React, { useEffect, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { clampStickyBounds } from '../../utils/stickyNoteTimestamps';
import { StickyNoteWindow } from './StickyNoteWindow';

export const StickyNotesLayer: React.FC = React.memo(() => {
  const stickyNotes = useAppStore((s) => s.stickyNotes);
  const updateStickyNoteLocal = useAppStore((s) => s.updateStickyNoteLocal);

  const openNotes = useMemo(
    () =>
      stickyNotes
        .map((note, idx) => ({ note, displayIndex: idx + 1 }))
        .filter(({ note }) => note.isOpen),
    [stickyNotes]
  );

  // 窗口缩放时自动把展开中的便签夹紧回可视区域，防止便签飘出屏幕外
  useEffect(() => {
    if (openNotes.length === 0) return;
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
  }, [openNotes.length, updateStickyNoteLocal]);

  if (openNotes.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {openNotes.map(({ note, displayIndex }) => (
        <StickyNoteWindow key={note.id} note={note} displayIndex={displayIndex} />
      ))}
    </div>
  );
});

StickyNotesLayer.displayName = 'StickyNotesLayer';
