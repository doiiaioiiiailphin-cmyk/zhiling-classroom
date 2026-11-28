import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  PointerVelocityTracker,
  prefersReducedMotion,
  rubberBandOffset,
  triggerHaptic,
} from '../../utils/springPhysics';
import { useSpringDriver } from '../../hooks/useSpringDriver';

export interface MobileSpringPageProps {
  open: boolean;
  onClose: () => void;
  /** Tailwind z-index 类或自定义样式类，默认 z-50 */
  zIndexClassName?: string;
  /** 是否开启左边缘右滑返回手势（默认 true） */
  enableSwipeBack?: boolean;
  /** 左边缘触发热区宽度（px，默认 36） */
  edgeWidthPx?: number;
  className?: string;
  children: React.ReactNode;
}

/**
 * 移动端原生级全屏推入/弹出页面栈容器：
 * 1. 打开与关闭全程由 120Hz RK4 `page` 弹簧驱动，挂载/退出不再硬切；
 * 2. 支持左边缘跟手右滑返回，松手瞬间真实继承滑动速度决定提交退出或弹性回位；
 * 3. 静止停靠后立即清空 inline transform，确保内部 sticky 工具栏与浮层坐标完全不受含块污染。
 */
export const MobileSpringPage: React.FC<MobileSpringPageProps> = ({
  open,
  onClose,
  zIndexClassName = 'z-50',
  enableSwipeBack = true,
  edgeWidthPx = 36,
  className = '',
  children,
}) => {
  const [rendered, setRendered] = useState(open);
  if (open && !rendered) {
    setRendered(true);
  }

  const pageRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wasRenderedRef = useRef(false);
  const prevOpenRef = useRef(false);
  const closingViaSwipeRef = useRef(false);
  const velocityTrackerRef = useRef(new PointerVelocityTracker());

  const getViewportWidth = useCallback(
    () => (typeof window !== 'undefined' ? Math.max(window.innerWidth, 320) : 390),
    [],
  );

  const applyFrame = useCallback(
    (offsetX: number, settled: boolean, targetX?: number) => {
      const pageEl = pageRef.current;
      const scrimEl = scrimRef.current;
      const vw = getViewportWidth();
      const progress = Math.max(0, Math.min(1, offsetX / vw));

      if (pageEl) {
        if (settled && offsetX <= 0.35 && (targetX ?? 0) === 0) {
          pageEl.style.transform = '';
          pageEl.style.willChange = '';
        } else {
          pageEl.style.willChange = 'transform';
          pageEl.style.transform = `translate3d(${offsetX.toFixed(2)}px, 0, 0)`;
        }
      }
      if (scrimEl) {
        if (settled && offsetX <= 0.35 && (targetX ?? 0) === 0) {
          scrimEl.style.opacity = '';
        } else {
          scrimEl.style.opacity = String(Math.max(0, (1 - progress) * 0.22));
        }
      }
    },
    [getViewportWidth],
  );

  const spring = useSpringDriver({
    initialValue: getViewportWidth(),
    config: 'page',
    onUpdate: (val, _vel, settled) => {
      applyFrame(val, settled, spring.getState().target);
    },
  });

  useLayoutEffect(() => {
    if (!rendered) {
      wasRenderedRef.current = false;
      prevOpenRef.current = false;
      closingViaSwipeRef.current = false;
      return;
    }

    const vw = getViewportWidth();
    const isFreshMount = !wasRenderedRef.current;
    const wasOpen = prevOpenRef.current;
    wasRenderedRef.current = true;
    prevOpenRef.current = open;

    if (open) {
      closingViaSwipeRef.current = false;
      if (prefersReducedMotion()) {
        spring.jumpTo(0);
        return;
      }
      if (!wasOpen) {
        const startVal = isFreshMount ? vw : spring.getState().value;
        spring.jumpTo(startVal);
        const frame = requestAnimationFrame(() => {
          spring.animateTo(0, { from: startVal, config: 'page' });
        });
        return () => cancelAnimationFrame(frame);
      }
      return;
    }

    if (prefersReducedMotion()) {
      spring.jumpTo(vw);
      setRendered(false);
      return;
    }
    if (wasOpen && !closingViaSwipeRef.current) {
      const startVal = spring.getState().value;
      spring.animateTo(vw, {
        from: startVal,
        config: 'page',
        onComplete: () => {
          setRendered(false);
        },
      });
    }
  }, [getViewportWidth, open, rendered, spring]);

  // 左侧边缘跟手右滑返回手势
  useEffect(() => {
    if (!rendered || !open || !enableSwipeBack) return;
    const el = pageRef.current;
    if (!el) return;

    let tracking = false;
    let decided = false;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let currentDragX = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.clientX > edgeWidthPx) return;
      tracking = true;
      decided = false;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      currentDragX = 0;
      velocityTrackerRef.current.reset();
      velocityTrackerRef.current.addSample(e.clientX);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!tracking || (pointerId !== null && e.pointerId !== pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      velocityTrackerRef.current.addSample(e.clientX);

      if (!decided) {
        if (Math.hypot(dx, dy) < 6) return;
        if (dx <= 0 || Math.abs(dy) > dx * 0.9) {
          tracking = false;
          pointerId = null;
          return;
        }
        decided = true;
        spring.stop();
        triggerHaptic('selection');
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // ignore pointer capture fallback
        }
      }

      const rawX = Math.max(0, dx);
      // 略微加入轻微跟手微阻尼，保持边缘起步质感
      currentDragX = rawX < 0 ? rubberBandOffset(rawX, 120, 0.4) : rawX;
      spring.jumpTo(currentDragX);
    };

    const finishPointer = (e: PointerEvent) => {
      if (!tracking || (pointerId !== null && e.pointerId !== pointerId)) return;
      tracking = false;
      const pid = pointerId;
      pointerId = null;
      if (pid !== null) {
        try {
          if (el.hasPointerCapture(pid)) {
            el.releasePointerCapture(pid);
          }
        } catch {
          // ignore
        }
      }
      if (!decided) return;
      decided = false;

      const vw = getViewportWidth();
      const vx = velocityTrackerRef.current.getVelocity();
      const shouldDismiss = currentDragX > vw * 0.34 || (vx > 480 && currentDragX > 24);

      if (shouldDismiss) {
        triggerHaptic('light');
        closingViaSwipeRef.current = true;
        spring.animateTo(vw, {
          from: currentDragX,
          initialVelocity: Math.max(vx, 320),
          config: 'page',
          onComplete: () => {
            setRendered(false);
          },
        });
        onCloseRef.current();
      } else {
        spring.animateTo(0, {
          from: currentDragX,
          initialVelocity: vx,
          config: 'page',
        });
      }
    };

    el.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
    };
  }, [edgeWidthPx, enableSwipeBack, getViewportWidth, open, rendered, spring]);

  if (!rendered) return null;

  return createPortal(
    <div className={`fixed inset-0 ${zIndexClassName} overflow-hidden pointer-events-none`}>
      {/* 右滑退出与推入过程中的底层浅暗幕布（非 blur，全 GPU 透明度插值） */}
      <div
        ref={scrimRef}
        aria-hidden="true"
        className="absolute inset-0 bg-[#0F172A] opacity-0 pointer-events-none"
      />
      <div
        ref={pageRef}
        data-mobile-spring-page="true"
        style={{ touchAction: 'pan-y' }}
        className={`relative h-full w-full flex flex-col overflow-hidden pointer-events-auto shadow-[-8px_0_28px_rgba(15,23,42,0.12)] ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
};
