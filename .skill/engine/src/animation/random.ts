/**
 * 种子化随机（需求 §7）。
 *
 * 铁律：**渲染核心禁止使用 `Math.random()`**。
 *
 * 原因不是「风格问题」，而是三件具体的坏结果：
 *   1. 同一帧两次渲染结果不同 → 无法做黄金帧回归，无法断点续渲
 *   2. 每帧重新随机 → 纸纹/发丝/衣服纹理逐帧闪烁，视频看起来在「沸腾」
 *   3. 无法并行渲染 → 每个 worker 都要按顺序跑完整条时间轴
 *
 * 因此随机性的唯一来源是 seed，且必须是 frameIndex 的函数而非调用次数的函数。
 */

/** 一个返回 [0,1) 的纯函数式随机源 */
export type Rng = () => number;

/**
 * mulberry32：32 位状态的小型 PRNG。
 * 选它的理由：实现 10 行、无依赖、分布足够好、跨平台逐位一致（全整数运算）。
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串映射为 32 位种子（FNV-1a），便于用 "girl/rain" 这类语义标签派生子流 */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 带派生能力的随机源。
 *
 * `fork(label)` 的价值：让「头发」「雨」「纸纹」各自拥有独立的随机流。
 * 这样调整雨的密度不会把头发的位置也一起改变——
 * 否则任何参数微调都会让整帧重排，调试和版本对比会变得不可用。
 */
export class SeededRandom {
  readonly seed: number;
  private rng: Rng;

  constructor(seed: number | string) {
    this.seed = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    this.rng = mulberry32(this.seed);
  }

  next(): number {
    return this.rng();
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  /** [min, max] 整数 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.rng() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() 收到空数组');
    return items[Math.floor(this.rng() * items.length)] as T;
  }

  /** 子流：相同 label 永远得到相同子随机源，与父流的消耗进度无关 */
  fork(label: string): SeededRandom {
    return new SeededRandom((this.seed ^ hashString(label)) >>> 0);
  }
}

/**
 * 一次性求值辅助：把「按 seed 生成 N 个值」的常见模式收敛到一个函数。
 * 注意返回的是**预先算好的数组**——这正是避免逐帧闪烁的关键手法：
 * 位置只在初始化时算一次，之后每帧复用。
 */
export function seededArray<T>(seed: number | string, count: number, make: (rng: SeededRandom, index: number) => T): T[] {
  const rng = new SeededRandom(seed);
  const out: T[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = make(rng, i);
  return out;
}
