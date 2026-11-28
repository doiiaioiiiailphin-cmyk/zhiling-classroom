import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSpringDriver } from '../../hooks/useSpringDriver';
import { isAndroidPlatform, useViewportLayout } from '../../utils/desktopBridge';
import {
  PointerVelocityTracker,
  prefersReducedMotion,
  rubberBandOffset,
  triggerHaptic,
} from '../../utils/springPhysics';

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

function findScrollableAncestor(
  target: EventTarget | null,
  boundaryEl: HTMLElement,
): HTMLElement | null {
  let node: Element | null = target instanceof Element ? target : null;
  while (node && node !== boundaryEl) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 2) {
      const style = window.getComputedStyle(node);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return node;
      }
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 原生手势级 120Hz RK4 弹簧底部抽屉：
 * - 进场与退场均由 RK4 `sheet` 弹簧驱动，退场可无缝继承拖拽末速度与瞬时位置；
 * - 顶部手柄支持 Pointer 拖拽跟手与向上橡皮筋微阻尼；
 * - 内容主体支持在滚动到顶时无缝接力向下拖出关闭（body handoff）。
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
  const { isCompactPhoneLayout } = useViewportLayout();
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) {
    setRendered(true);
  }
  const [isDraggingUi, setIsDraggingUi] = useState(false);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wasRenderedRef = useRef(false);
  const prevOpenRef = useRef(false);
  const closingViaDragRef = useRef(false);
  const dragModeRef = useRef<'none' | 'handle' | 'body'>('none');
  const velocityTrackerRef = useRef(new PointerVelocityTracker());
  const pointerDragRef = useRef<{
    pointerId: number;
    startY: number;
    baseOffsetY: number;
  } | null>(null);

  const cachedChildrenRef = useRef<React.ReactNode>(children);
  if (open) {
    cachedChildrenRef.current = children;
  }

  const getSheetHeight = useCallback(() => {
    const measured = sheetRef.current?.getBoundingClientRect().height ?? 0;
    return Math.max(measured, 340);
  }, []);

  const applyFrame = useCallback(
    (offsetY: number, settled: boolean, targetY?: number) => {
      const sheetEl = sheetRef.current;
      const backdropEl = backdropRef.current;
      const sheetH = getSheetHeight();
      const progress = Math.max(0, Math.min(1, 1 - Math.max(0, offsetY) / sheetH));

      if (sheetEl) {
        if (settled && Math.abs(offsetY) <= 0.3 && (targetY ?? 0) === 0) {
          sheetEl.style.transform = '';
          sheetEl.style.willChange = '';
        } else {
          sheetEl.style.willChange = 'transform';
          sheetEl.style.transform = `translate3d(0, ${offsetY.toFixed(2)}px, 0)`;
        }
      }
      if (backdropEl) {
        backdropEl.style.opacity = progress.toFixed(3);
      }
    },
    [getSheetHeight],
  );

  const spring = useSpringDriver({
    initialValue: 420,
    config: 'sheet',
    onUpdate: (val, _vel, settled) => {
      applyFrame(val, settled, spring.getState().target);
    },
  });

  useLayoutEffect(() => {
    if (!rendered) {
      wasRenderedRef.current = false;
      prevOpenRef.current = false;
      closingViaDragRef.current = false;
      return;
    }

    const isFreshMount = !wasRenderedRef.current;
    const wasOpen = prevOpenRef.current;
    wasRenderedRef.current = true;
    prevOpenRef.current = open;
    const sheetH = getSheetHeight();

    if (open) {
      closingViaDragRef.current = false;
      if (prefersReducedMotion()) {
        spring.jumpTo(0);
        return;
      }
      if (!wasOpen) {
        const startVal = isFreshMount ? sheetH : spring.getState().value;
        spring.jumpTo(startVal);
        const frame = requestAnimationFrame(() => {
          spring.animateTo(0, {
            from: startVal,
            config: 'sheet',
          });
        });
        return () => cancelAnimationFrame(frame);
      }
      return;
    }

    if (prefersReducedMotion()) {
      spring.jumpTo(sheetH);
      setRendered(false);
      return;
    }

    if (wasOpen && !closingViaDragRef.current) {
      const currentY = spring.getState().value;
      spring.animateTo(sheetH + 24, {
        from: currentY,
        initialVelocity: 0,
        config: 'sheet',
        onComplete: () => {
          setRendered(false);
        },
      });
    }
  }, [getSheetHeight, open, rendered, spring]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const finishDragGesture = useCallback(
    (dragOffsetY: number, velocityPxSec: number) => {
      dragModeRef.current = 'none';
      setIsDraggingUi(false);

      const sheetH = getSheetHeight();
      const dismissThreshold = Math.min(125, Math.max(76, sheetH * 0.28));
      const shouldDismiss =
        dragOffsetY > dismissThreshold || (velocityPxSec > 520 && dragOffsetY > 20);

      if (shouldDismiss) {
        triggerHaptic('light');
        closingViaDragRef.current = true;
        spring.animateTo(sheetH + 24, {
          from: dragOffsetY,
          initialVelocity: Math.max(velocityPxSec, 280),
          config: 'sheet',
          onComplete: () => {
            setRendered(false);
          },
        });
        onCloseRef.current();
      } else {
        spring.animateTo(0, {
          from: dragOffsetY,
          initialVelocity: velocityPxSec,
          config: 'sheet',
        });
      }
    },
    [getSheetHeight, spring],
  );

  // 主体内容区滚动到顶时向下滑接力拖拽关闭
  useEffect(() => {
    if (!rendered || !open) return;
    const sheetEl = sheetRef.current;
    if (!sheetEl) return;

    let touchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let decided: 'pending' | 'scroll' | 'sheet-drag' = 'pending';
    let scrollableEl: HTMLElement | null = null;
    let currentOffsetY = 0;

    const onTouchStart = (e: TouchEvent) => {
      if (dragModeRef.current === 'handle' || e.touches.length !== 1 || prefersReducedMotion()) {
        return;
      }
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-sheet-drag-handle], [data-sheet-no-drag], input[type="range"], textarea',
        )
      ) {
        return;
      }
      const touch = e.touches[0];
      touchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      lastY = touch.clientY;
      decided = 'pending';
      scrollableEl = findScrollableAncestor(target, sheetEl);
      currentOffsetY = Math.max(0, spring.getState().value);
      velocityTrackerRef.current.reset();
      velocityTrackerRef.current.addSample(touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (touchId === null || dragModeRef.current === 'handle') return;
      let touch: Touch | undefined;
      for (let i = 0; i < e.touches.length; i += 1) {
        if (e.touches[i].identifier === touchId) {
          touch = e.touches[i];
          break;
        }
      }
      if (!touch) return;

      const totalDx = touch.clientX - startX;
      const totalDy = touch.clientY - startY;
      const stepDy = touch.clientY - lastY;
      lastY = touch.clientY;
      velocityTrackerRef.current.addSample(touch.clientY);

      if (decided === 'pending') {
        if (Math.hypot(totalDx, totalDy) < 7) return;
        if (Math.abs(totalDx) > Math.abs(totalDy) * 1.1) {
          decided = 'scroll';
          return;
        }
        const atTop = !scrollableEl || scrollableEl.scrollTop <= 1;
        if (totalDy > 0 && atTop) {
          decided = 'sheet-drag';
          dragModeRef.current = 'body';
          spring.stop();
          setIsDraggingUi(true);
        } else {
          decided = 'scroll';
          return;
        }
      }

      if (decided !== 'sheet-drag') return;

      currentOffsetY = Math.max(0, currentOffsetY + stepDy);
      if (currentOffsetY <= 0 && stepDy < 0) {
        // 抽屉回到原点并继续上滑 -> 交还给内部列表滚动
        spring.jumpTo(0);
        decided = 'scroll';
        dragModeRef.current = 'none';
        setIsDraggingUi(false);
        return;
      }

      spring.jumpTo(currentOffsetY);
      if (e.cancelable) {
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      if (touchId === null) return;
      touchId = null;
      if (decided === 'sheet-drag') {
        decided = 'pending';
        const vel = velocityTrackerRef.current.getVelocity();
        finishDragGesture(currentOffsetY, vel);
      } else {
        decided = 'pending';
      }
    };

    sheetEl.addEventListener('touchstart', onTouchStart, { passive: true });
    sheetEl.addEventListener('touchmove', onTouchMove, { passive: false });
    sheetEl.addEventListener('touchend', onTouchEnd, { passive: true });
    sheetEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

    const enableMouseBodySim = isAndroidPlatform();
    let mouseBodyId: number | null = null;
    let mStartX = 0;
    let mStartY = 0;
    let mLastY = 0;
    let mDecided: 'pending' | 'scroll' | 'sheet-drag' = 'pending';
    let mScrollableEl: HTMLElement | null = null;
    let mOffsetY = 0;
    let suppressBodyClickUntil = 0;

    const onMousePointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (dragModeRef.current === 'handle' || prefersReducedMotion()) return;
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-sheet-drag-handle], [data-sheet-no-drag], input, textarea, select, [contenteditable="true"]',
        )
      ) {
        return;
      }
      mouseBodyId = e.pointerId;
      mStartX = e.clientX;
      mStartY = e.clientY;
      mLastY = e.clientY;
      mDecided = 'pending';
      mScrollableEl = findScrollableAncestor(target, sheetEl);
      mOffsetY = Math.max(0, spring.getState().value);
      velocityTrackerRef.current.reset();
      velocityTrackerRef.current.addSample(e.clientY);
    };

    const finishMouseBody = () => {
      if (mouseBodyId === null) return;
      mouseBodyId = null;
      sheetEl.style.userSelect = '';
      if (mDecided === 'sheet-drag') {
        mDecided = 'pending';
        suppressBodyClickUntil = performance.now() + 240;
        const vel = velocityTrackerRef.current.getVelocity();
        finishDragGesture(mOffsetY, vel);
      } else {
        mDecided = 'pending';
      }
    };

    const onMousePointerMove = (e: PointerEvent) => {
      if (mouseBodyId === null || e.pointerId !== mouseBodyId || dragModeRef.current === 'handle') {
        return;
      }
      if ((e.buttons & 1) === 0) {
        finishMouseBody();
        return;
      }

      const totalDx = e.clientX - mStartX;
      const totalDy = e.clientY - mStartY;
      const stepDy = e.clientY - mLastY;
      mLastY = e.clientY;
      velocityTrackerRef.current.addSample(e.clientY);

      if (mDecided === 'pending') {
        if (Math.hypot(totalDx, totalDy) < 7) return;
        if (Math.abs(totalDx) > Math.abs(totalDy) * 1.1) {
          mDecided = 'scroll';
          return;
        }
        const atTop = !mScrollableEl || mScrollableEl.scrollTop <= 1;
        if (totalDy > 0 && atTop) {
          mDecided = 'sheet-drag';
          dragModeRef.current = 'body';
          sheetEl.style.userSelect = 'none';
          try {
            window.getSelection()?.removeAllRanges();
          } catch {
            // ignore
          }
          spring.stop();
          setIsDraggingUi(true);
        } else {
          mDecided = 'scroll';
          return;
        }
      }

      if (mDecided !== 'sheet-drag') return;
      mOffsetY = Math.max(0, mOffsetY + stepDy);
      if (mOffsetY <= 0 && stepDy < 0) {
        spring.jumpTo(0);
        mDecided = 'scroll';
        dragModeRef.current = 'none';
        setIsDraggingUi(false);
        return;
      }
      spring.jumpTo(mOffsetY);
      e.preventDefault();
    };

    const onCaptureClick = (e: MouseEvent) => {
      if (performance.now() < suppressBodyClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    if (enableMouseBodySim) {
      sheetEl.addEventListener('pointerdown', onMousePointerDown);
      sheetEl.addEventListener('click', onCaptureClick, true);
      window.addEventListener('pointermove', onMousePointerMove, { passive: false });
      window.addEventListener('pointerup', finishMouseBody);
      window.addEventListener('pointercancel', finishMouseBody);
    }

    return () => {
      sheetEl.removeEventListener('touchstart', onTouchStart);
      sheetEl.removeEventListener('touchmove', onTouchMove);
      sheetEl.removeEventListener('touchend', onTouchEnd);
      sheetEl.removeEventListener('touchcancel', onTouchEnd);
      if (enableMouseBodySim) {
        sheetEl.style.userSelect = '';
        sheetEl.removeEventListener('pointerdown', onMousePointerDown);
        sheetEl.removeEventListener('click', onCaptureClick, true);
        window.removeEventListener('pointermove', onMousePointerMove);
        window.removeEventListener('pointerup', finishMouseBody);
        window.removeEventListener('pointercancel', finishMouseBody);
      }
    };
  }, [finishDragGesture, open, rendered, spring]);

  if (!rendered) return null;

  const handleDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore pointer capture fallback
    }
    spring.stop();
    dragModeRef.current = 'handle';
    velocityTrackerRef.current.reset();
    velocityTrackerRef.current.addSample(e.clientY);
    pointerDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      baseOffsetY: spring.getState().value,
    };
    setIsDraggingUi(true);
  };

  const handleDragPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    velocityTrackerRef.current.addSample(e.clientY);
    const rawDy = state.baseOffsetY + (e.clientY - state.startY);
    const mapped = rawDy >= 0 ? rawDy : rubberBandOffset(rawDy, 54, 0.42);
    spring.jumpTo(mapped);
  };

  const finishHandleDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = pointerDragRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    pointerDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    const offsetY = spring.getState().value;
    const vel = velocityTrackerRef.current.getVelocity();
    finishDragGesture(offsetY, vel);
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      {...dataAttributes}
      className={`fixed inset-0 ${zIndexClass} flex flex-col justify-end`}
    >
      {/* 外侧遮罩：跟随 120Hz 弹簧位置实时平滑渐变，移动端免重度模糊 */}
      <div
        ref={backdropRef}
        data-sheet-backdrop="true"
        onClick={onClose}
        className={`absolute inset-0 ${
          isCompactPhoneLayout ? 'bg-[#1F2329]/40' : 'bg-[#1F2329]/38 backdrop-blur-[2px]'
        }`}
      />

      {/* 底部弹窗主体 */}
      <div
        ref={sheetRef}
        data-sheet-panel="true"
        style={panelStyle}
        className={`relative z-10 mx-auto rounded-t-[24px] shadow-[0_-14px_40px_rgba(31,35,41,0.18)] ${maxWidthClass} ${panelClassName}`}
      >
        {showHandle && (
          <div
            data-sheet-drag-handle="true"
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={finishHandleDrag}
            onPointerCancel={finishHandleDrag}
            title="向下拖动可关闭"
            className="w-full pt-2.5 pb-2 flex items-center justify-center touch-none cursor-grab active:cursor-grabbing select-none shrink-0"
          >
            <div
              className={`h-1.5 rounded-full transition-all duration-200 ${
                isDraggingUi ? 'w-12 bg-[#8F959E]' : 'w-10 bg-[#D0D5DD]'
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
