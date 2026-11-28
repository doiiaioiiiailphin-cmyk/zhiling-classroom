import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  prefersReducedMotion,
  resolveSpringConfig,
  stepSpring,
  type SpringConfig,
  type SpringPresetName,
} from '../utils/springPhysics';

export interface SpringAnimateOptions {
  /** 覆盖起始值（不传则无缝继承当前实时位移） */
  from?: number;
  /** 注入初始速度 px/s（不传则继承当前速度，保证手势松手无顿挫） */
  initialVelocity?: number;
  /** 覆盖本次动画的弹簧预设或参数 */
  config?: SpringPresetName | SpringConfig;
  /** 到达静止阈值并收尾后的回调 */
  onComplete?: () => void;
}

export interface SpringDriverOptions {
  initialValue?: number;
  config?: SpringPresetName | SpringConfig;
  /** 每帧物理步进后的 DOM 直写回调（不触发 React 重渲染） */
  onUpdate: (value: number, velocity: number, settled: boolean) => void;
  onSettle?: (value: number) => void;
}

export interface SpringDriverHandle {
  animateTo: (target: number, opts?: SpringAnimateOptions) => void;
  jumpTo: (value: number) => void;
  stop: () => void;
  getState: () => {
    value: number;
    target: number;
    velocity: number;
    animating: boolean;
  };
}

/**
 * 120Hz 原生 rAF RK4 弹簧驱动 Hook：
 * 物理步进直接驱动真实 DOM 样式（transform/opacity），动画期间零 React 重渲染。
 */
export function useSpringDriver(options: SpringDriverOptions): SpringDriverHandle {
  const initialValue = options.initialValue ?? 0;
  const valueRef = useRef<number>(initialValue);
  const velocityRef = useRef<number>(0);
  const targetRef = useRef<number>(initialValue);
  const animatingRef = useRef<boolean>(false);
  const rafIdRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);

  const defaultConfigRef = useRef<Required<SpringConfig>>(
    resolveSpringConfig(options.config ?? 'sheet'),
  );
  const activeConfigRef = useRef<Required<SpringConfig>>(defaultConfigRef.current);
  const onUpdateRef = useRef(options.onUpdate);
  const onSettleRef = useRef(options.onSettle);
  const onCompleteRef = useRef<(() => void) | undefined>(undefined);

  defaultConfigRef.current = resolveSpringConfig(options.config ?? 'sheet');
  onUpdateRef.current = options.onUpdate;
  onSettleRef.current = options.onSettle;

  const cancelFrame = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    animatingRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelFrame();
    };
  }, [cancelFrame]);

  const stop = useCallback(() => {
    onCompleteRef.current = undefined;
    cancelFrame();
  }, [cancelFrame]);

  const jumpTo = useCallback(
    (nextValue: number) => {
      onCompleteRef.current = undefined;
      cancelFrame();
      valueRef.current = nextValue;
      targetRef.current = nextValue;
      velocityRef.current = 0;
      onUpdateRef.current(nextValue, 0, true);
    },
    [cancelFrame],
  );

  const tick = useCallback((now: number) => {
    if (!mountedRef.current) return;
    const prevTime = lastTimeRef.current || now;
    lastTimeRef.current = now;
    const dtSeconds = Math.min(Math.max((now - prevTime) / 1000, 0.001), 0.05);

    const next = stepSpring(
      valueRef.current,
      velocityRef.current,
      targetRef.current,
      dtSeconds,
      activeConfigRef.current,
    );

    valueRef.current = next.value;
    velocityRef.current = next.velocity;
    onUpdateRef.current(next.value, next.velocity, next.settled);

    if (next.settled) {
      rafIdRef.current = null;
      animatingRef.current = false;
      const done = onCompleteRef.current;
      onCompleteRef.current = undefined;
      done?.();
      onSettleRef.current?.(next.value);
      return;
    }

    rafIdRef.current = requestAnimationFrame(tick);
  }, []);

  const animateTo = useCallback(
    (target: number, opts?: SpringAnimateOptions) => {
      if (opts?.from !== undefined) {
        valueRef.current = opts.from;
      }
      if (opts?.initialVelocity !== undefined) {
        velocityRef.current = opts.initialVelocity;
      }
      targetRef.current = target;
      activeConfigRef.current = opts?.config
        ? resolveSpringConfig(opts.config)
        : defaultConfigRef.current;
      onCompleteRef.current = opts?.onComplete;

      if (prefersReducedMotion()) {
        cancelFrame();
        valueRef.current = target;
        velocityRef.current = 0;
        onUpdateRef.current(target, 0, true);
        const done = onCompleteRef.current;
        onCompleteRef.current = undefined;
        done?.();
        onSettleRef.current?.(target);
        return;
      }

      if (
        Math.abs(valueRef.current - target) <= activeConfigRef.current.restDisplacementThreshold &&
        Math.abs(velocityRef.current) <= activeConfigRef.current.restVelocityThreshold
      ) {
        cancelFrame();
        valueRef.current = target;
        velocityRef.current = 0;
        onUpdateRef.current(target, 0, true);
        const done = onCompleteRef.current;
        onCompleteRef.current = undefined;
        done?.();
        onSettleRef.current?.(target);
        return;
      }

      if (!animatingRef.current) {
        animatingRef.current = true;
        lastTimeRef.current = performance.now();
        rafIdRef.current = requestAnimationFrame(tick);
      }
    },
    [cancelFrame, tick],
  );

  const getState = useCallback(
    () => ({
      value: valueRef.current,
      target: targetRef.current,
      velocity: velocityRef.current,
      animating: animatingRef.current,
    }),
    [],
  );

  return useMemo(
    () => ({ animateTo, jumpTo, stop, getState }),
    [animateTo, jumpTo, stop, getState],
  );
}
