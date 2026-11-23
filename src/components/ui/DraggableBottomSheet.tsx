import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence';

export interface DraggableBottomSheetProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  zIndexClass?: string;
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  dataAttributes?: Record<string, string | undefined>;
  showHandle?: boolean;
  /** 可选：限制最大宽度（默认手机全宽，横屏大窗适度收口） */
  maxWidthClass?: string;
  children: React.ReactNode;
}

const EXIT_DURATION_MS = 250;

/**
 * 原生手势级底部抽屉：
 * - 进场/退场均带弹簧滑入与平滑收回动效（点击外侧遮罩、取消、返回键均平滑收回，不生硬消失）；
 * - 顶部手柄支持真实 Pointer/Touch 拖拽跟手（向下拖可实时淡化遮罩并甩手关闭，向上拉带阻尼橡皮筋回弹）。
 */
export const DraggableBottomSheet: React.FC<DraggableBottomSheetProps> = ({
  open,
  onClose,
  ariaLabel,
  zIndexClass = 'z-[60]',
  panelClassName = 'bg-white',
  panelStyle,
  dataAttributes,
  showHandle = true,
  maxWidthClass = 'w-full',
  children,
}) => {
  const { shouldRender, isVisible } = useAnimatedPresence(open, EXIT_DURATION_MS);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startY: number;
    startTime: number;
    latestDy: number;
  } | null>(null);
  const cachedChildrenRef = useRef<React.ReactNode>(children);
  if (open) {
    cachedChildrenRef.current = children;
  }

  useEffect(() => {
    if (open) {
      setDragOffsetY(0);
      setIsDragging(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!shouldRender) return null;

  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore pointer capture fallback
    }
    dragStateRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startTime: performance.now(),
      latestDy: 0,
    };
    setIsDragging(true);
  };

  const handleDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const rawDy = e.clientY - state.startY;
    state.latestDy = rawDy;
    if (rawDy >= 0) {
      setDragOffsetY(rawDy);
    } else {
      // 向上拉动时提供轻柔的橡皮筋阻尼感
      const resisted = -Math.min(18, Math.pow(-rawDy, 0.68));
      setDragOffsetY(resisted);
    }
  };

  const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const elapsedMs = Math.max(16, performance.now() - state.startTime);
    const dy = state.latestDy;
    const velocity = dy / elapsedMs; // px/ms
    const sheetH = sheetRef.current?.getBoundingClientRect().height ?? 320;
    const dismissThreshold = Math.min(115, Math.max(72, sheetH * 0.28));

    setIsDragging(false);
    if (dy > dismissThreshold || (velocity > 0.42 && dy > 24)) {
      onClose();
    } else {
      setDragOffsetY(0);
    }
  };

  const sheetHeight = sheetRef.current?.getBoundingClientRect().height ?? 320;
  const dragRatio = isDragging
    ? Math.max(0.08, Math.min(1, 1 - Math.max(0, dragOffsetY) / Math.max(220, sheetHeight)))
    : 1;

  const backdropOpacity = isVisible ? dragRatio : 0;
  const sheetTransform = !isVisible
    ? 'translate3d(0, 100%, 0)'
    : `translate3d(0, ${dragOffsetY}px, 0)`;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      {...dataAttributes}
      className={`fixed inset-0 ${zIndexClass} flex flex-col justify-end`}
    >
      {/* 外侧遮罩：跟随拖拽实时变淡，点击平滑淡出收回 */}
      <div
        data-sheet-backdrop="true"
        onClick={onClose}
        style={{
          opacity: backdropOpacity,
          transition: isDragging ? 'none' : 'opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        className="absolute inset-0 bg-[#1F2329]/38 backdrop-blur-[2px]"
      />

      {/* 底部弹窗主体 */}
      <div
        ref={sheetRef}
        data-sheet-panel="true"
        style={{
          ...panelStyle,
          transform: sheetTransform,
          transition: isDragging
            ? 'none'
            : isVisible
              ? 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)'
              : 'transform 240ms cubic-bezier(0.32, 0.72, 0, 1)',
        }}
        className={`relative z-10 mx-auto rounded-t-[24px] shadow-[0_-14px_40px_rgba(31,35,41,0.18)] will-change-transform ${maxWidthClass} ${panelClassName}`}
      >
        {showHandle && (
          <div
            data-sheet-drag-handle="true"
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            title="向下拖动可关闭"
            className="w-full pt-2.5 pb-2 flex items-center justify-center touch-none cursor-grab active:cursor-grabbing select-none shrink-0"
          >
            <div
              className={`h-1.5 rounded-full transition-all duration-150 ${
                isDragging ? 'w-12 bg-[#8F959E]' : 'w-10 bg-[#D0D5DD]'
              }`}
            />
          </div>
        )}
        {open ? children : cachedChildrenRef.current}
      </div>
    </div>,
    document.body
  );
};
