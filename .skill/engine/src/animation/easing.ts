/**
 * 缓动与插值（需求 §7、§44）。
 *
 * 刻意不引入依赖：需求 §46 明确「不要为了一个 lerp() 装库」。
 * 这里的函数都是纯函数且与时间无关，输入是 [0,1] 的归一化进度，
 * 时间来源由调用方从 frameIndex 推导（见 src/timeline/frame.ts）。
 */

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 归一化到 [0,1] 后再 clamp——即把任意输入映射为合法进度 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** 把 value 从 [inMin,inMax] 线性映射到 [outMin,outMax]，超出部分 clamp */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return outMin + (outMax - outMin) * clamp01((value - inMin) / (inMax - inMin));
}

/** 三次平滑：两端一阶导为 0 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** 五次平滑：两端一二阶导均为 0，用于镜头运动比 smoothstep 更「稳」 */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 帧率无关的「往返」波形，返回 [0,1]，常用于呼吸、浮动 */
export function pingPong(t: number): number {
  const cycle = t % 1;
  return cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
}

/** 正弦呼吸，返回 [0,1]（不是 [-1,1]），方便直接当强度用 */
export function breathe(t: number): number {
  return (1 + Math.sin(t * Math.PI * 2)) / 2;
}

export const easing = {
  linear: (t: number): number => t,

  inQuad: (t: number): number => t * t,
  outQuad: (t: number): number => 1 - (1 - t) * (1 - t),
  inOutQuad: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),

  inCubic: (t: number): number => t * t * t,
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  inQuart: (t: number): number => t * t * t * t,
  outQuart: (t: number): number => 1 - Math.pow(1 - t, 4),

  inSine: (t: number): number => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t: number): number => Math.sin((t * Math.PI) / 2),
  inOutSine: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,

  /** 轻微回弹，适合「道具出现」 */
  outBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },

  outElastic: (t: number): number => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
} as const;

export type EasingName = keyof typeof easing;

/** 全部缓动名，顺序即对象定义顺序（供 schema 枚举与能力清单使用，保持确定性） */
export const EASING_NAMES = Object.keys(easing) as EasingName[];

/** 按名字取缓动函数，找不到时回退 linear（DSL 的枚举值会先经 schema 校验，这里只是兜底） */
export function getEasing(name: string | undefined): (t: number) => number {
  if (!name) return easing.linear;
  return (easing as Record<string, (t: number) => number>)[name] ?? easing.linear;
}

/** 在 [from,to] 之间按缓动取值 */
export function tween(from: number, to: number, progress: number, ease: (t: number) => number = easing.linear): number {
  return from + (to - from) * ease(clamp01(progress));
}
