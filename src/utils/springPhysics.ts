/**
 * 120Hz 四阶龙格-库塔（RK4）物理弹簧核心引擎、橡皮筋阻尼映射与触觉反馈工具。
 * 全程纯数值计算、零外部依赖、零 React 重渲染开销，供 rAF 驱动器与手势交互复用。
 */

export interface SpringConfig {
  /** 弹簧刚度 k：决定回弹响应速度 */
  stiffness: number;
  /** 阻尼系数 c：决定衰减快慢与是否有自然过冲 */
  damping: number;
  /** 质量 m（默认 1） */
  mass?: number;
  /** 静止位移阈值（px） */
  restDisplacementThreshold?: number;
  /** 静止速度阈值（px/s） */
  restVelocityThreshold?: number;
}

export type SpringPresetName = 'snappy' | 'sheet' | 'page' | 'expressive' | 'overscroll';

export const SPRING_PRESETS: Record<SpringPresetName, Required<SpringConfig>> = {
  /** 开关、滑块、胶囊、按钮等微型即时反馈 */
  snappy: {
    stiffness: 480,
    damping: 36,
    mass: 1,
    restDisplacementThreshold: 0.25,
    restVelocityThreshold: 0.5,
  },
  /** 底部抽屉与浮层弹出：紧凑干脆，保留微弱物理缓冲 */
  sheet: {
    stiffness: 380,
    damping: 32,
    mass: 1,
    restDisplacementThreshold: 0.3,
    restVelocityThreshold: 0.6,
  },
  /** 全屏推入/返回与侧滑退场：接近临界阻尼、无多余回弹晃动 */
  page: {
    stiffness: 420,
    damping: 39,
    mass: 1,
    restDisplacementThreshold: 0.35,
    restVelocityThreshold: 0.8,
  },
  /** 轻快弹窗、卡片翻转与徽章强调：保留轻微弹性灵动感 */
  expressive: {
    stiffness: 340,
    damping: 24,
    mass: 1,
    restDisplacementThreshold: 0.25,
    restVelocityThreshold: 0.5,
  },
  /** 列表顶/底部越界橡皮筋与惯性撞击回弹 */
  overscroll: {
    stiffness: 290,
    damping: 30,
    mass: 1,
    restDisplacementThreshold: 0.25,
    restVelocityThreshold: 0.5,
  },
};

export interface SpringState {
  value: number;
  velocity: number;
  settled: boolean;
}

/** 将弹簧配置补全默认值并支持按预设名解析 */
export function resolveSpringConfig(
  config: SpringPresetName | SpringConfig,
): Required<SpringConfig> {
  if (typeof config === 'string') {
    return SPRING_PRESETS[config];
  }
  return {
    stiffness: config.stiffness,
    damping: config.damping,
    mass: config.mass ?? 1,
    restDisplacementThreshold: config.restDisplacementThreshold ?? 0.25,
    restVelocityThreshold: config.restVelocityThreshold ?? 0.5,
  };
}

/** 单子步 RK4 积分（dt <= 1/120s） */
function rk4Substep(
  x: number,
  v: number,
  target: number,
  dt: number,
  stiffness: number,
  damping: number,
  invMass: number,
): [number, number] {
  const accel = (pos: number, vel: number): number =>
    (-stiffness * (pos - target) - damping * vel) * invMass;

  const k1x = v;
  const k1v = accel(x, v);

  const halfDt = dt * 0.5;
  const x2 = x + k1x * halfDt;
  const v2 = v + k1v * halfDt;
  const k2x = v2;
  const k2v = accel(x2, v2);

  const x3 = x + k2x * halfDt;
  const v3 = v + k2v * halfDt;
  const k3x = v3;
  const k3v = accel(x3, v3);

  const x4 = x + k3x * dt;
  const v4 = v + k3v * dt;
  const k4x = v4;
  const k4v = accel(x4, v4);

  const nextX = x + ((k1x + 2 * k2x + 2 * k3x + k4x) * dt) / 6;
  const nextV = v + ((k1v + 2 * k2v + 2 * k3v + k4v) * dt) / 6;
  return [nextX, nextV];
}

/**
 * 以四阶龙格-库塔（RK4）向前积分一个帧步长。
 * 超过 1/120 秒的帧间隔会自动拆分为多个子步，确保 60Hz/90Hz/120Hz 及卡顿恢复时均无数值发散。
 */
export function stepSpring(
  value: number,
  velocity: number,
  target: number,
  dtSeconds: number,
  config: SpringPresetName | SpringConfig = 'sheet',
): SpringState {
  const resolved = resolveSpringConfig(config);
  const clampedDt = Math.min(Math.max(dtSeconds, 0), 0.05);
  if (clampedDt === 0) {
    const isAtRest =
      Math.abs(value - target) <= resolved.restDisplacementThreshold &&
      Math.abs(velocity) <= resolved.restVelocityThreshold;
    return {
      value: isAtRest ? target : value,
      velocity: isAtRest ? 0 : velocity,
      settled: isAtRest,
    };
  }

  const maxStep = 1 / 120;
  const steps = Math.max(1, Math.ceil(clampedDt / maxStep));
  const subDt = clampedDt / steps;
  const invMass = 1 / Math.max(resolved.mass, 0.01);

  let x = value;
  let v = velocity;
  for (let i = 0; i < steps; i += 1) {
    [x, v] = rk4Substep(
      x,
      v,
      target,
      subDt,
      resolved.stiffness,
      resolved.damping,
      invMass,
    );
  }

  if (
    Math.abs(x - target) <= resolved.restDisplacementThreshold &&
    Math.abs(v) <= resolved.restVelocityThreshold
  ) {
    return {
      value: target,
      velocity: 0,
      settled: true,
    };
  }

  return {
    value: x,
    velocity: v,
    settled: false,
  };
}

/**
 * iOS UIScrollView 风格有界双向橡皮筋阻尼曲线：
 * 随着越界拉伸距离增大，有效位移收敛至 dimension，初段斜率为 resistance（默认 0.55）。
 */
export function rubberBandOffset(
  distance: number,
  dimension = 320,
  resistance = 0.55,
): number {
  if (distance === 0 || dimension <= 0) return 0;
  const sign = distance < 0 ? -1 : 1;
  const absD = Math.abs(distance);
  const damped = (absD * resistance * dimension) / (dimension + resistance * absD);
  return sign * damped;
}

interface VelocitySample {
  pos: number;
  timeMs: number;
}

/**
 * 滑动时间窗手势速度追踪器（单位：px/s）。
 * 在松手瞬间为 RK4 弹簧提供真实的初始抛掷速度。
 */
export class PointerVelocityTracker {
  private samples: VelocitySample[] = [];
  private readonly windowMs: number;
  private readonly maxVelocity: number;

  constructor(windowMs = 95, maxVelocity = 4500) {
    this.windowMs = windowMs;
    this.maxVelocity = maxVelocity;
  }

  reset(): void {
    this.samples = [];
  }

  addSample(pos: number, timeMs = performance.now()): void {
    this.samples.push({ pos, timeMs });
    this.prune(timeMs);
  }

  getVelocity(nowMs = performance.now()): number {
    this.prune(nowMs);
    if (this.samples.length < 2) return 0;

    const latest = this.samples[this.samples.length - 1];
    // 超过 90ms 无移动则认为手指在抬起前已悬停静止
    if (nowMs - latest.timeMs > 90) return 0;

    const earliest = this.samples[0];
    const dtMs = latest.timeMs - earliest.timeMs;
    if (dtMs < 1) return 0;

    const velocity = ((latest.pos - earliest.pos) / dtMs) * 1000;
    return Math.max(-this.maxVelocity, Math.min(this.maxVelocity, velocity));
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].timeMs < cutoff) {
      this.samples.shift();
    }
  }
}

/** 检测用户是否在系统层开启了减弱动态效果 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 轻量触觉微震反馈：受系统减弱动态效果与 WebView 安全策略保护，不可用时静默跳过。
 */
export function triggerHaptic(style: 'light' | 'medium' | 'selection' = 'light'): void {
  if (prefersReducedMotion()) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return;
  }
  const duration = style === 'medium' ? 16 : style === 'light' ? 10 : 6;
  try {
    navigator.vibrate(duration);
  } catch {
    // 忽略部分 WebView 或桌面环境未授予用户手势激活时的拒绝异常
  }
}
