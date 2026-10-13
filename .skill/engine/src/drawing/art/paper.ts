/**
 * L1 艺术图元 — 纸纹与颗粒（需求 §9、§32）。
 *
 * 核心设计：**离屏渲染一次，之后每帧 blit**。
 *
 * 为什么不用「每帧画 3000 个小点」：
 *   1. 性能：3000 次 fillRect 每帧是实打实的开销
 *   2. 更关键——闪烁：任何在帧循环里重新生成的位置/透明度都会让纸纹逐帧跳动。
 *      视频里的纸纹一旦闪烁，整体质感会立刻崩掉（观众描述为「画面在沸腾」）
 *
 * 把纸纹烘焙成一张 tile 之后，「每帧一致」是结构性保证而不是纪律要求。
 */

import { Canvas, type CanvasPattern, type CanvasRenderingContext2D } from 'skia-canvas';

import { SeededRandom } from '../../animation/random.ts';
import { noise2D } from '../../animation/noise.ts';

export interface PaperTextureOptions {
  readonly seed: number | string;
  /** tile 边长（像素）。必须是 2 的幂，重复拼接时接缝最不明显 */
  readonly tileSize?: number;
  /** 每 1000 平方像素的斑点数量 */
  readonly density?: number;
  /** 颗粒强度 0..1 */
  readonly grain?: number;
  /** 纤维强度 0..1 */
  readonly fiber?: number;
  /** 底色（含纸的微弱暖色）。传 null 表示不铺底色，只留颗粒 */
  readonly tint?: string | null;
}

interface ResolvedPaperOptions {
  seed: number;
  tileSize: number;
  density: number;
  grain: number;
  fiber: number;
  tint: string | null;
}

function resolve(options: PaperTextureOptions): ResolvedPaperOptions {
  const seedNum = typeof options.seed === 'string' ? hashLabel(options.seed) : options.seed >>> 0;
  return {
    seed: seedNum,
    tileSize: options.tileSize ?? 512,
    density: options.density ?? 220,
    grain: options.grain ?? 0.5,
    fiber: options.fiber ?? 0.35,
    tint: options.tint === undefined ? '#f4efe4' : options.tint,
  };
}

/** 局部实现，避免为字符串种子引入额外依赖环 */
function hashLabel(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cacheKey(o: ResolvedPaperOptions): string {
  return `${o.seed}|${o.tileSize}|${o.density}|${o.grain}|${o.fiber}|${o.tint ?? 'null'}`;
}

/**
 * 纸纹纹理。实例本身不可变——构造完成后所有像素就固定了，
 * 因此可以安全地跨帧、跨场景复用。
 */
export class PaperTexture {
  private static readonly cache = new Map<string, PaperTexture>();

  readonly options: ResolvedPaperOptions;
  readonly tile: Canvas;

  /**
   * 每个 context 缓存一份 CanvasPattern。
   *
   * 这是一个 28 倍的性能陷阱（调用计数回归见 test/renderer.test.ts）：
   *   createPattern 每帧重建 + fillRect + toBufferSync(raw)
   *     540x960 → 25.0ms   1080x1920 → 28.3ms
   *   pattern 缓存复用 + 同样操作
   *     540x960 →  0.88ms  1080x1920 →  2.34ms
   *
   * 成本与分辨率无关，说明它花在「构造 pattern 对象」上（拷贝 tile 位图 + 建 shader），
   * 而不是花在填充上。tile 在构造后不再变化，因此 pattern 可以安全长期复用。
   *
   * 另外实测：用 drawImage 平铺替代 pattern 更差（540x960 需 92.7ms）。
   */
  private readonly patternCache = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

  private constructor(options: ResolvedPaperOptions) {
    this.options = options;
    this.tile = renderTile(options);
  }

  /** 相同参数返回同一个实例（含已烘焙的 tile） */
  static get(options: PaperTextureOptions): PaperTexture {
    const resolved = resolve(options);
    const key = cacheKey(resolved);
    let hit = PaperTexture.cache.get(key);
    if (!hit) {
      hit = new PaperTexture(resolved);
      PaperTexture.cache.set(key, hit);
    }
    return hit;
  }

  /** 清空缓存（测试用；正常情况下不需要） */
  static clearCache(): void {
    PaperTexture.cache.clear();
  }

  /** 取（并缓存）该 context 对应的 pattern。tile 不可变是这里能缓存的前提。 */
  private patternFor(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    const hit = this.patternCache.get(ctx);
    if (hit) return hit;
    const created = ctx.createPattern(this.tile, 'repeat');
    if (!created) return null;
    this.patternCache.set(ctx, created);
    return created;
  }

  /**
   * 把纸纹铺满指定区域。
   *
   * @param breatheTime 可选。传入缓慢推进的时间量后，纸纹会以极低频「呼吸」，
   *   模拟纸张受潮的微变化。注意这里变化的是**整体透明度**而不是每个斑点的位置——
   *   前者视觉上连续，后者会闪烁。
   */
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    options: { readonly alpha?: number; readonly breatheTime?: number; readonly breatheDepth?: number } = {},
  ): void {
    const { alpha = 1, breatheTime, breatheDepth = 0.06 } = options;

    const pattern = this.patternFor(ctx);
    ctx.save();
    if (pattern) {
      let a = alpha;
      if (breatheTime !== undefined) {
        // 用极低频采样：一整部片子里只走 1~2 个噪声周期
        const n = noise2D(breatheTime * 0.08, 0.37, this.options.seed);
        a = alpha * (1 - breatheDepth + n * breatheDepth * 2);
      }
      ctx.globalAlpha = Math.min(1, Math.max(0, a));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.restore();
  }

  /** 覆盖整个区域的多边形纸纹（用于裁剪区域，例如「窗外」的纸感更冷） */
  drawClipped(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    clip: () => void,
    options: { readonly alpha?: number } = {},
  ): void {
    ctx.save();
    clip();
    ctx.clip();
    this.draw(ctx, width, height, options);
    ctx.restore();
  }
}

/** 烘焙 tile：所有随机只在这一次发生 */
function renderTile(o: ResolvedPaperOptions): Canvas {
  const canvas = new Canvas(o.tileSize, o.tileSize);
  const ctx = canvas.getContext('2d');
  const rng = new SeededRandom(o.seed);

  // --- 底色：纸不是纯白，带极轻微的不均匀 ---
  if (o.tint) {
    ctx.fillStyle = o.tint;
    ctx.fillRect(0, 0, o.tileSize, o.tileSize);

    // 大尺度色斑：用噪声网格做出「纸张厚薄不一」的观感
    const cell = 32;
    for (let y = 0; y < o.tileSize; y += cell) {
      for (let x = 0; x < o.tileSize; x += cell) {
        const n = noise2D(x / 96, y / 96, o.seed);
        if (n < 0.42 || n > 0.58) continue;
        const warm = (n - 0.5) * 2;
        ctx.globalAlpha = 0.05 * Math.abs(warm) * (o.grain + 0.4);
        ctx.fillStyle = warm > 0 ? '#ffffff' : '#b9a98f';
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }

  // --- 斑点颗粒 ---
  const speckles = Math.round((o.density * o.tileSize * o.tileSize) / 1000);
  for (let i = 0; i < speckles; i++) {
    const x = rng.next() * o.tileSize;
    const y = rng.next() * o.tileSize;
    const size = rng.range(0.6, 2.4);
    const dark = rng.next() < 0.55;
    ctx.globalAlpha = rng.range(0.02, 0.09) * o.grain * 2;
    ctx.fillStyle = dark ? '#4a4033' : '#ffffff';
    ctx.fillRect(x, y, size, size);
  }

  // --- 纤维：短促的浅色/深色细线，模拟纸浆纤维 ---
  const fibers = Math.round(o.fiber * 260);
  for (let i = 0; i < fibers; i++) {
    const x = rng.next() * o.tileSize;
    const y = rng.next() * o.tileSize;
    const angle = rng.next() * Math.PI * 2;
    const len = rng.range(4, 22);
    ctx.globalAlpha = rng.range(0.015, 0.05) * o.fiber * 2;
    ctx.strokeStyle = rng.next() < 0.5 ? '#6b5f4d' : '#ffffff';
    ctx.lineWidth = rng.range(0.5, 1.1);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  return canvas;
}

/**
 * 轻量颗粒叠加：需要「局部颗粒」（例如仅人物区域）时用它，
 * 而不是再烘焙一张完整 tile。
 */
export function drawGrainPatch(
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; w: number; h: number },
  options: { seed: number; density?: number; strength?: number; dark?: boolean },
): void {
  const { seed, density = 0.12, strength = 0.05, dark = true } = options;
  const rng = new SeededRandom(seed);
  const count = Math.round(bounds.w * bounds.h * density * 0.01);
  ctx.save();
  ctx.fillStyle = dark ? '#3d3428' : '#ffffff';
  for (let i = 0; i < count; i++) {
    ctx.globalAlpha = rng.range(0, strength);
    ctx.fillRect(
      bounds.x + rng.next() * bounds.w,
      bounds.y + rng.next() * bounds.h,
      rng.range(0.7, 2),
      rng.range(0.7, 2),
    );
  }
  ctx.restore();
}
