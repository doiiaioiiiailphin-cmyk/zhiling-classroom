import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';
import { useAppStore } from '../../store/useAppStore';
import { triggerHaptic } from '../../utils/springPhysics';
import { IconButton } from './IconButton';

export const NoticeToast: React.FC = () => {
  const { notice, clearNotice } = useAppStore();
  const { shouldRender, isVisible } = useAnimatedPresence(Boolean(notice), 200);
  const cachedNoticeRef = useRef(notice);
  if (notice) {
    cachedNoticeRef.current = notice;
  }

  const [dragY, setDragY] = useState(0);
  const dragStateRef = useRef<{ pointerId: number; startY: number } | null>(null);

  useEffect(() => {
    if (!notice) {
      setDragY(0);
      return;
    }
    const timer = window.setTimeout(() => {
      clearNotice();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  if (!shouldRender || !cachedNoticeRef.current) return null;

  const activeNotice = notice ?? cachedNoticeRef.current;
  const isError = activeNotice.kind === 'error';

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as Element | null)?.closest('button')) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore pointer capture fallback
    }
    dragStateRef.current = { pointerId: e.pointerId, startY: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const dy = e.clientY - state.startY;
    setDragY(dy < 0 ? dy : dy * 0.28);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    if (dragY < -24) {
      triggerHaptic('selection');
      clearNotice();
    } else {
      setDragY(0);
    }
  };

  const isDragging = dragStateRef.current !== null;
  const toastTransform = !isVisible
    ? 'translate3d(0, -18px, 0) scale(0.94)'
    : `translate3d(0, ${dragY.toFixed(1)}px, 0) scale(1)`;

  const toastNode = (
    <div
      style={{ top: 'calc(16px + var(--android-safe-top, 0px))' }}
      className="fixed left-1/2 -translate-x-1/2 z-[90] max-w-lg w-[calc(100vw-2rem)] pointer-events-none"
    >
      <div
        role="status"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          transform: toastTransform,
          opacity: isVisible ? Math.min(1, Math.max(0.2, 1 + dragY / 80)) : 0,
          transition: isDragging
            ? 'none'
            : 'transform 320ms var(--spring-expressive, cubic-bezier(0.22, 1, 0.36, 1)), opacity 200ms ease-out',
        }}
        className={`pointer-events-auto flex items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-[0_12px_32px_rgba(31,35,41,0.14)] bg-white touch-pan-x ${
          isError ? 'border-[#FFBCB3]' : 'border-[#BEDAFF]'
        }`}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {isError ? (
            <AlertCircle className="w-5 h-5 text-[#D83931] shrink-0" strokeWidth={1.9} />
          ) : (
            <CheckCircle2 className="w-5 h-5 text-[#1456F0] shrink-0" strokeWidth={1.9} />
          )}
          <span className="text-[14px] text-[#1F2329] leading-snug break-words">
            {activeNotice.message}
          </span>
        </div>

        <IconButton icon={X} tooltip="关闭提示" onClick={clearNotice} />
      </div>
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(toastNode, document.body);
  }
  return toastNode;
};
