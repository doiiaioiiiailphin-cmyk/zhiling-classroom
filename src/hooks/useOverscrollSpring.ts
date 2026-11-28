import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAndroidPlatform } from '../utils/desktopBridge';
import {
  PointerVelocityTracker,
  prefersReducedMotion,
  rubberBandOffset,
  type SpringConfig,
  type SpringPresetName,
} from '../utils/springPhysics';
import { useSpringDriver } from './useSpringDriver';

export interface UseOverscrollSpringOptions {
  /** 是否开启越界橡皮筋回弹（通常仅移动端开启，桌面端保持原生静态） */
  enabled?: boolean;
  /** 临时禁用（例如转写批量拖拽框选或长按拖拽进行中） */
  disabled?: boolean;
  /** 外部传入的滚动容器 ref（可选） */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** 外部传入的内容包装 ref（可选，施加 translate3d 而不更改 scrollTop） */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** 最大单向越界展示位移（px），默认 84 */
  maxStretch?: number;
  config?: SpringPresetName | SpringConfig;
}

export interface UseOverscrollSpringResult {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 用于延迟挂载/Portal 滚动容器的回调 ref，确保 DOM 挂上时立即可绑定监听 */
  bindScrollRef: (node: HTMLDivElement | null) => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
  isOverscrollingRef: React.RefObject<boolean>;
  reset: () => void;
}

function shouldIgnoreTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '[data-batch-checkbox-rail], [data-batch-rail], [data-marquee-ignore], [data-no-overscroll], [data-sheet-drag-handle], input, textarea, select, [contenteditable="true"]',
    ),
  );
}

/** 检测手指起点是否落在可横向滚动子元素（如代码块、公式块）内部且仍有横向可滚空间 */
function hasScrollableHorizontalAncestor(
  target: EventTarget | null,
  boundaryEl: HTMLElement,
): boolean {
  let node: Element | null = target instanceof Element ? target : null;
  while (node && node !== boundaryEl) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 4) {
      const style = window.getComputedStyle(node);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * 移动端列表顶/底部物理橡皮筋回弹 + 惯性触底撞击弹簧 Hook：
 * 1. 手指拽到顶部继续下拉或拽到底部继续上推时，按 UIScrollView 阻尼公式平滑拉伸内容区；
 * 2. 快速甩动列表自然撞击顶/底部边界时，触发基于真实末速度的 RK4 缓冲压缩并回弹；
 * 3. 回弹静止后彻底清除 inline transform，保证虚拟列表测量、position:sticky 与文字锐度零副作用。
 */
export function useOverscrollSpring(
  options: UseOverscrollSpringOptions = {},
): UseOverscrollSpringResult {
  const {
    enabled = true,
    disabled = false,
    maxStretch = 84,
    config = 'overscroll',
  } = options;

  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const internalContentRef = useRef<HTMLDivElement | null>(null);
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
  const externalScrollRef = options.scrollRef;
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const contentRef = options.contentRef ?? internalContentRef;

  const bindScrollRef = useCallback((node: HTMLDivElement | null) => {
    internalScrollRef.current = node;
    setScrollNode(node);
  }, []);

  const active = enabled && !disabled;
  const isOverscrollingRef = useRef<boolean>(false);
  const rawOverdragRef = useRef<number>(0);
  const springModeRef = useRef<'drag' | 'impact'>('drag');
  const velocityTrackerRef = useRef(new PointerVelocityTracker());

  const applyTransform = useCallback(
    (offsetPx: number, settled: boolean) => {
      const el = contentRef.current;
      if (!el) return;
      if (settled && Math.abs(offsetPx) <= 0.25) {
        el.style.transform = '';
        el.style.willChange = '';
        isOverscrollingRef.current = false;
        rawOverdragRef.current = 0;
        return;
      }
      el.style.willChange = 'transform';
      el.style.transform = `translate3d(0, ${offsetPx.toFixed(2)}px, 0)`;
    },
    [contentRef],
  );

  const spring = useSpringDriver({
    initialValue: 0,
    config,
    onUpdate: (val, _vel, settled) => {
      const displayVal =
        springModeRef.current === 'impact'
          ? rubberBandOffset(val, Math.min(44, maxStretch * 0.55), 0.72)
          : val;
      applyTransform(displayVal, settled);
    },
  });

  const reset = useCallback(() => {
    springModeRef.current = 'drag';
    rawOverdragRef.current = 0;
    isOverscrollingRef.current = false;
    spring.jumpTo(0);
    const el = contentRef.current;
    if (el) {
      el.style.transform = '';
      el.style.willChange = '';
    }
  }, [contentRef, spring]);

  useEffect(() => {
    if (!active) {
      reset();
    }
  }, [active, reset]);

  useEffect(() => {
    const scrollEl = externalScrollRef ? externalScrollRef.current : scrollNode;
    if (!active || !scrollEl) return;

    let touchId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let axisLocked: 'pending' | 'vertical' | 'horizontal' = 'pending';
    let allowHorizontalCheck = false;

    // 惯性撞击追踪状态
    let prevScrollTop = scrollEl.scrollTop;
    let prevScrollTime = performance.now();
    let smoothedScrollSpeed = 0;
    let lastImpactAt = 0;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      if (shouldIgnoreTarget(e.target) || prefersReducedMotion()) return;
      if (!contentRef.current) return;

      const touch = e.touches[0];
      touchId = touch.identifier;
      startX = touch.clientX;
      startY = touch.clientY;
      lastY = touch.clientY;
      axisLocked = 'pending';
      allowHorizontalCheck = hasScrollableHorizontalAncestor(e.target, scrollEl);

      // 若仍在回弹动画中，接管当前位移继续跟手
      spring.stop();
      springModeRef.current = 'drag';
      velocityTrackerRef.current.reset();
      velocityTrackerRef.current.addSample(touch.clientY);

      const currentState = spring.getState();
      if (Math.abs(currentState.value) > 0.5) {
        isOverscrollingRef.current = true;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (touchId === null || !contentRef.current) return;
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
      const dy = touch.clientY - lastY;
      lastY = touch.clientY;
      velocityTrackerRef.current.addSample(touch.clientY);

      if (axisLocked === 'pending') {
        if (Math.hypot(totalDx, totalDy) < 5) return;
        const horizontalThreshold = allowHorizontalCheck ? 0.95 : 1.25;
        if (Math.abs(totalDx) > Math.abs(totalDy) * horizontalThreshold) {
          axisLocked = 'horizontal';
          return;
        }
        axisLocked = 'vertical';
      }

      if (axisLocked !== 'vertical') return;

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const top = scrollEl.scrollTop;
      const atTop = top <= 1;
      const atBottom = maxScroll <= 1 || top >= maxScroll - 1.5;

      const prevOverdrag = rawOverdragRef.current;
      let nextOverdrag = prevOverdrag;

      if (prevOverdrag > 0) {
        // 顶部越界下拉状态：继续下拉增加，向上推回先消减越界量
        nextOverdrag = Math.max(0, prevOverdrag + dy);
      } else if (prevOverdrag < 0) {
        // 底部越界上拉状态：继续上拉减少（更负），向下推回先消减至 0
        nextOverdrag = Math.min(0, prevOverdrag + dy);
      } else if (dy > 0 && atTop) {
        nextOverdrag = dy;
      } else if (dy < 0 && atBottom) {
        nextOverdrag = dy;
      }

      if (nextOverdrag !== 0 || prevOverdrag !== 0) {
        rawOverdragRef.current = nextOverdrag;
        isOverscrollingRef.current = nextOverdrag !== 0;

        const damped = rubberBandOffset(
          nextOverdrag,
          Math.max(120, Math.min(280, maxStretch * 2.4)),
          0.55,
        );
        const clampedDisplay = Math.max(-maxStretch, Math.min(maxStretch, damped));
        spring.jumpTo(clampedDisplay);

        if (nextOverdrag !== 0 && e.cancelable) {
          e.preventDefault();
        }
      }
    };

    const finishTouch = () => {
      if (touchId === null) return;
      touchId = null;
      const currentDisplay = spring.getState().value;
      const rawOverdrag = rawOverdragRef.current;
      rawOverdragRef.current = 0;

      if (Math.abs(currentDisplay) > 0.5 || Math.abs(rawOverdrag) > 0.5) {
        const releaseVel = velocityTrackerRef.current.getVelocity() * 0.35;
        springModeRef.current = 'drag';
        isOverscrollingRef.current = true;
        spring.animateTo(0, {
          from: currentDisplay,
          initialVelocity: releaseVel,
          config,
        });
      } else {
        isOverscrollingRef.current = false;
      }
      prevScrollTop = scrollEl.scrollTop;
      prevScrollTime = performance.now();
      smoothedScrollSpeed = 0;
    };

    const handleScroll = () => {
      const now = performance.now();
      const curTop = scrollEl.scrollTop;
      const deltaTop = curTop - prevScrollTop;
      const dtSec = Math.max((now - prevScrollTime) / 1000, 0.008);
      const prevTopSnapshot = prevScrollTop;

      prevScrollTop = curTop;
      prevScrollTime = now;

      // 忽略虚拟列表锚点瞬移 / 跳句滚动 / 搜索定位等程序性大跳变
      if (Math.abs(deltaTop) > 360) {
        smoothedScrollSpeed = 0;
        return;
      }

      // 仅在松手后的惯性滑行期检测触顶/触底撞击
      if (touchId !== null || isOverscrollingRef.current || prefersReducedMotion()) {
        return;
      }

      const instantSpeed = deltaTop / dtSec; // 正值代表向下滚（趋向底部），负值代表向上滚（趋向顶部）
      smoothedScrollSpeed = smoothedScrollSpeed * 0.35 + instantSpeed * 0.65;

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      if (maxScroll <= 16) return;
      if (now - lastImpactAt < 260) return;

      const hitTop = curTop <= 0.5 && prevTopSnapshot > 1.5 && smoothedScrollSpeed < -180;
      const hitBottom =
        curTop >= maxScroll - 1.5 &&
        prevTopSnapshot < maxScroll - 2.5 &&
        smoothedScrollSpeed > 180;

      if (hitTop || hitBottom) {
        lastImpactAt = now;
        const speedMagnitude = Math.min(2400, Math.abs(smoothedScrollSpeed));
        // 撞击顶部 -> 内容向下短暂冲量(+velocity)；撞击底部 -> 内容向上短暂压缩(-velocity)
        const impulseVelocity = (hitTop ? 1 : -1) * speedMagnitude * 0.38;
        smoothedScrollSpeed = 0;
        springModeRef.current = 'impact';
        isOverscrollingRef.current = true;
        spring.animateTo(0, {
          from: 0,
          initialVelocity: impulseVelocity,
          config,
        });
      }
    };

    scrollEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    scrollEl.addEventListener('touchend', finishTouch, { passive: true });
    scrollEl.addEventListener('touchcancel', finishTouch, { passive: true });
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });

    // Android 桌面浏览器预览模式：让鼠标左键拖动同步模拟单指上下滑屏、惯性甩动与越界 RK4 橡皮筋
    const enableMouseTouchSim = isAndroidPlatform();
    let mousePointerId: number | null = null;
    let mouseStartX = 0;
    let mouseStartY = 0;
    let mouseLastY = 0;
    let mouseAxisLocked: 'pending' | 'vertical' | 'horizontal' = 'pending';
    let mouseDidScroll = false;
    let mouseAllowHorizontalCheck = false;
    let suppressClickUntil = 0;
    let momentumRafId: number | null = null;

    const stopMomentum = () => {
      if (momentumRafId !== null) {
        window.cancelAnimationFrame(momentumRafId);
        momentumRafId = null;
      }
    };

    const handleMousePointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (shouldIgnoreTarget(e.target) || prefersReducedMotion()) return;
      if (!contentRef.current) return;
      if (e.clientX <= 36 && scrollEl.closest('[data-mobile-spring-page="true"]')) return;
      const rect = scrollEl.getBoundingClientRect();
      if (e.clientX > rect.left + scrollEl.clientWidth) return;

      stopMomentum();
      mousePointerId = e.pointerId;
      mouseStartX = e.clientX;
      mouseStartY = e.clientY;
      mouseLastY = e.clientY;
      mouseAxisLocked = 'pending';
      mouseDidScroll = false;
      mouseAllowHorizontalCheck = hasScrollableHorizontalAncestor(e.target, scrollEl);

      spring.stop();
      springModeRef.current = 'drag';
      velocityTrackerRef.current.reset();
      velocityTrackerRef.current.addSample(e.clientY);

      const currentState = spring.getState();
      if (Math.abs(currentState.value) > 0.5) {
        isOverscrollingRef.current = true;
      }
    };

    const finishMouseDrag = () => {
      if (mousePointerId === null) return;
      mousePointerId = null;
      scrollEl.style.userSelect = '';

      if (mouseDidScroll) {
        suppressClickUntil = performance.now() + 260;
      }

      const currentDisplay = spring.getState().value;
      const rawOverdrag = rawOverdragRef.current;
      rawOverdragRef.current = 0;
      const releaseVel = velocityTrackerRef.current.getVelocity();

      if (Math.abs(currentDisplay) > 0.5 || Math.abs(rawOverdrag) > 0.5) {
        springModeRef.current = 'drag';
        isOverscrollingRef.current = true;
        spring.animateTo(0, {
          from: currentDisplay,
          initialVelocity: releaseVel * 0.35,
          config,
        });
      } else {
        isOverscrollingRef.current = false;
        if (mouseDidScroll && Math.abs(releaseVel) > 120) {
          let scrollVel = -releaseVel;
          let lastTs = performance.now();
          const stepMomentum = (now: number) => {
            const dt = Math.min(0.032, Math.max(0.001, (now - lastTs) / 1000));
            lastTs = now;
            scrollVel *= Math.exp(-3.4 * dt);
            if (Math.abs(scrollVel) < 28) {
              momentumRafId = null;
              return;
            }
            const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
            const prevTop = scrollEl.scrollTop;
            const nextTop = prevTop + scrollVel * dt;

            if (nextTop <= 0) {
              scrollEl.scrollTop = 0;
              momentumRafId = null;
              if (maxScroll > 16 && prevTop > 1 && scrollVel < -140) {
                const impulseVelocity = Math.min(2400, Math.abs(scrollVel)) * 0.38;
                springModeRef.current = 'impact';
                isOverscrollingRef.current = true;
                spring.animateTo(0, { from: 0, initialVelocity: impulseVelocity, config });
              }
              return;
            }
            if (nextTop >= maxScroll) {
              scrollEl.scrollTop = maxScroll;
              momentumRafId = null;
              if (maxScroll > 16 && prevTop < maxScroll - 1 && scrollVel > 140) {
                const impulseVelocity = -Math.min(2400, Math.abs(scrollVel)) * 0.38;
                springModeRef.current = 'impact';
                isOverscrollingRef.current = true;
                spring.animateTo(0, { from: 0, initialVelocity: impulseVelocity, config });
              }
              return;
            }

            scrollEl.scrollTop = nextTop;
            prevScrollTop = nextTop;
            prevScrollTime = now;
            momentumRafId = window.requestAnimationFrame(stepMomentum);
          };
          momentumRafId = window.requestAnimationFrame(stepMomentum);
        }
      }

      mouseDidScroll = false;
      prevScrollTop = scrollEl.scrollTop;
      prevScrollTime = performance.now();
      smoothedScrollSpeed = 0;
    };

    const handleMousePointerMove = (e: PointerEvent) => {
      if (mousePointerId === null || e.pointerId !== mousePointerId || !contentRef.current) return;
      if ((e.buttons & 1) === 0) {
        finishMouseDrag();
        return;
      }

      const totalDx = e.clientX - mouseStartX;
      const totalDy = e.clientY - mouseStartY;
      const dy = e.clientY - mouseLastY;
      mouseLastY = e.clientY;
      velocityTrackerRef.current.addSample(e.clientY);

      if (mouseAxisLocked === 'pending') {
        if (Math.hypot(totalDx, totalDy) < 6) return;
        const horizontalThreshold = mouseAllowHorizontalCheck ? 0.95 : 1.25;
        if (Math.abs(totalDx) > Math.abs(totalDy) * horizontalThreshold) {
          mouseAxisLocked = 'horizontal';
          mousePointerId = null;
          return;
        }
        mouseAxisLocked = 'vertical';
        mouseDidScroll = true;
        scrollEl.style.userSelect = 'none';
        try {
          window.getSelection()?.removeAllRanges();
        } catch {
          // ignore
        }
      }

      if (mouseAxisLocked !== 'vertical') return;
      e.preventDefault();

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const prevOverdrag = rawOverdragRef.current;
      let nextOverdrag = prevOverdrag;

      if (prevOverdrag > 0) {
        const candidate = prevOverdrag + dy;
        if (candidate >= 0) {
          nextOverdrag = candidate;
        } else {
          nextOverdrag = 0;
          scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, scrollEl.scrollTop - candidate));
        }
      } else if (prevOverdrag < 0) {
        const candidate = prevOverdrag + dy;
        if (candidate <= 0) {
          nextOverdrag = candidate;
        } else {
          nextOverdrag = 0;
          scrollEl.scrollTop = Math.max(0, Math.min(maxScroll, scrollEl.scrollTop - candidate));
        }
      } else if (dy !== 0) {
        const targetTop = scrollEl.scrollTop - dy;
        if (targetTop < 0) {
          scrollEl.scrollTop = 0;
          nextOverdrag = -targetTop;
        } else if (targetTop > maxScroll) {
          scrollEl.scrollTop = maxScroll;
          nextOverdrag = maxScroll - targetTop;
        } else {
          scrollEl.scrollTop = targetTop;
        }
      }

      prevScrollTop = scrollEl.scrollTop;
      prevScrollTime = performance.now();

      if (nextOverdrag !== 0 || prevOverdrag !== 0) {
        rawOverdragRef.current = nextOverdrag;
        isOverscrollingRef.current = nextOverdrag !== 0;

        if (nextOverdrag !== 0) {
          const damped = rubberBandOffset(
            nextOverdrag,
            Math.max(120, Math.min(280, maxStretch * 2.4)),
            0.55,
          );
          const clampedDisplay = Math.max(-maxStretch, Math.min(maxStretch, damped));
          spring.jumpTo(clampedDisplay);
        } else {
          spring.jumpTo(0);
        }
      }
    };

    const handleCaptureClick = (e: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    if (enableMouseTouchSim) {
      scrollEl.addEventListener('pointerdown', handleMousePointerDown);
      scrollEl.addEventListener('click', handleCaptureClick, true);
      window.addEventListener('pointermove', handleMousePointerMove, { passive: false });
      window.addEventListener('pointerup', finishMouseDrag);
      window.addEventListener('pointercancel', finishMouseDrag);
    }

    return () => {
      scrollEl.removeEventListener('touchstart', handleTouchStart);
      scrollEl.removeEventListener('touchmove', handleTouchMove);
      scrollEl.removeEventListener('touchend', finishTouch);
      scrollEl.removeEventListener('touchcancel', finishTouch);
      scrollEl.removeEventListener('scroll', handleScroll);
      if (enableMouseTouchSim) {
        stopMomentum();
        scrollEl.style.userSelect = '';
        scrollEl.removeEventListener('pointerdown', handleMousePointerDown);
        scrollEl.removeEventListener('click', handleCaptureClick, true);
        window.removeEventListener('pointermove', handleMousePointerMove);
        window.removeEventListener('pointerup', finishMouseDrag);
        window.removeEventListener('pointercancel', finishMouseDrag);
      }
    };
  }, [active, config, contentRef, externalScrollRef, maxStretch, scrollNode, spring]);

  return useMemo(
    () => ({
      scrollRef,
      bindScrollRef,
      contentRef,
      isOverscrollingRef,
      reset,
    }),
    [scrollRef, bindScrollRef, contentRef, reset],
  );
}
