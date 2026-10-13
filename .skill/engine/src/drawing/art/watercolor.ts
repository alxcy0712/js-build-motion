/**
 * L1 艺术图元 — 水彩（需求 §9、§32）。
 *
 * 通过四项叠加表现水彩的视觉特征：
 *
 *   1. 多层叠色  — 同一形状反复以低透明度叠加，模拟颜料层层沉积
 *   2. 边缘加深  — 水彩干燥时颜料向边缘聚集，形成深色轮廓（最关键的一项）
 *   3. 颗粒沉淀  — 小颗粒在形状内部随机沉降（granulation）
 *   4. 轮廓不规则 — 形状边界由噪声扰动，绝不是正椭圆
 *
 * 全部由 seed 决定，不含时间项；需要缓慢变化时由调用方显式传入时间参数。
 */

import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';

import { SeededRandom } from '../../animation/random.ts';
import { fbm2D, noise2D } from '../../animation/noise.ts';
import { traceSmoothClosed, wobblyEllipsePoints, roughLine } from './rough.ts';

export interface WatercolorBlobOptions {
  readonly seed: number;
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly rotation?: number;
  /** 基色。叠色与边缘加深都由它派生，保证整体色相一致 */
  readonly color: string;
  /** 叠色层数。3~6 比较自然；过多会让形状糊掉 */
  readonly layers?: number;
  /** 单层透明度。实际观感约等于 alpha × layers */
  readonly alpha?: number;
  /** 边缘加深强度 0..1，0 表示关闭 */
  readonly edgeDarkening?: number;
  /** 颜料颗粒强度 0..1 */
  readonly granulation?: number;
  /** 轮廓扰动强度，0.06 表示 ±6% */
  readonly wobble?: number;
  /** 轮廓采样点数 */
  readonly points?: number;
  /** 整体透明度乘数 */
  readonly opacity?: number;
}

/** 把 hex 颜色按亮度缩放，用于派生「更深的边缘色」 */
function shade(color: string, factor: number): string {
  const m = color.match(/^#?([0-9a-f]{6})$/i);
  if (!m?.[1]) return color;
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^#?([0-9a-f]{6})$/i);
  const a = Math.max(0, Math.min(1, alpha));
  if (!m?.[1]) return color;
  const hex = m[1];
  return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${a})`;
}

/**
 * 水彩块。
 *
 * 绘制顺序刻意是「大 → 小、淡 → 浓」：先铺大面积浅色，再向中心收拢加深，
 * 这样得到的是水彩的自然渐变，而不是均匀色块。
 */
export function watercolorBlob(ctx: CanvasRenderingContext2D, options: WatercolorBlobOptions): void {
  const {
    seed,
    cx,
    cy,
    rx,
    ry,
    rotation = 0,
    color,
    layers = 4,
    alpha = 0.18,
    edgeDarkening = 0.7,
    granulation = 0.35,
    wobble = 0.07,
    points = 44,
    opacity = 1,
  } = options;

  ctx.save();
  ctx.globalAlpha *= opacity;

  // --- 1. 多层叠色 ---
  // 每层用不同 seed 生成独立轮廓（而不是同一个形状等比缩小），
  // 这样边界之间会互相「咬合」，产生颜料流动的观感。
  for (let layer = 0; layer < layers; layer++) {
    const t = layer / Math.max(1, layers - 1); // 0 → 1
    const shrink = 1 - t * 0.28;
    const layerSeed = (seed + layer * 7919) >>> 0;
    const jitterX = (noise2D(layer * 0.7, 0.3, seed) - 0.5) * rx * 0.12;
    const jitterY = (noise2D(0.3, layer * 0.7, seed) - 0.5) * ry * 0.12;

    const pts = wobblyEllipsePoints({
      seed: layerSeed,
      cx: cx + jitterX,
      cy: cy + jitterY,
      rx: rx * shrink,
      ry: ry * shrink,
      rotation,
      wobble,
      points,
    });

    ctx.fillStyle = withAlpha(color, alpha * (1 + t * 0.5));
    traceSmoothClosed(ctx, pts);
    ctx.fill();
  }

  // --- 2. 边缘加深 ---
  // 水彩最容易被识别的特征：深色边缘 + 内部相对浅。
  if (edgeDarkening > 0) {
    const edgeSeed = (seed + 104729) >>> 0;
    const outer = wobblyEllipsePoints({
      seed,
      cx,
      cy,
      rx,
      ry,
      rotation,
      wobble,
      points,
    });

    ctx.save();
    traceSmoothClosed(ctx, outer);
    ctx.clip(); // 只在形状内部画边缘，避免描边跑到外面

    ctx.strokeStyle = withAlpha(shade(color, 0.62), 0.16 * edgeDarkening);
    ctx.lineWidth = Math.max(3, Math.min(rx, ry) * 0.14);
    ctx.lineJoin = 'round';
    traceSmoothClosed(ctx, outer);
    ctx.stroke();

    // 再叠一圈更细更深的，模拟「水痕线」
    ctx.strokeStyle = withAlpha(shade(color, 0.45), 0.12 * edgeDarkening);
    ctx.lineWidth = Math.max(1.2, Math.min(rx, ry) * 0.03);
    traceSmoothClosed(ctx, outer);
    ctx.stroke();
    ctx.restore();

    void edgeSeed;
  }

  // --- 3. 颗粒沉淀 ---
  if (granulation > 0) {
    const rng = new SeededRandom((seed + 15485863) >>> 0);
    const outer = wobblyEllipsePoints({ seed, cx, cy, rx, ry, rotation, wobble, points });

    ctx.save();
    traceSmoothClosed(ctx, outer);
    ctx.clip();

    const count = Math.round(Math.PI * rx * ry * 0.004 * granulation * 6);
    for (let i = 0; i < count; i++) {
      // 在包围盒内均匀取点，靠 clip 裁掉外部
      const x = cx - rx * 1.1 + rng.next() * rx * 2.2;
      const y = cy - ry * 1.1 + rng.next() * ry * 2.2;
      ctx.globalAlpha = rng.range(0.03, 0.14) * granulation;
      ctx.fillStyle = rng.next() < 0.6 ? shade(color, 0.55) : shade(color, 1.25);
      ctx.beginPath();
      ctx.arc(x, y, rng.range(0.6, 2.2), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * 大面积淡淡的底wash。
 * 用于「天空」「墙面」这类占满画面的区域——它不该有明确轮廓，
 * 而是以极低透明度铺开，靠噪声让颜色有厚薄变化。
 *
 * 实现要点（这是一个真实的坑）：
 *   最初的做法是「每格一个 fillRect，透明度由噪声决定」。结果是画面上出现
 *   非常明显的方格网——因为相邻格子相互重叠且都是半透明，
 *   **重叠区域会叠加两次 alpha**，于是每个格子边缘都变成一条深线。
 *   半透明几何体铺满画面时，这类接缝几乎是不可避免的。
 *
 *   正确做法：把 wash 烘焙到一张**低分辨率离屏画布**（每像素直接写 alpha，
 *   不存在重叠问题），再用 drawImage 按双线性插值放大。
 *   结果既没有网格，又因为像素数少了 64 倍而更快，且同样可缓存、可确定复现。
 */
export function watercolorWash(
  ctx: CanvasRenderingContext2D,
  bounds: { x: number; y: number; w: number; h: number },
  options: {
    readonly seed: number;
    readonly color: string;
    readonly alpha?: number;
    /** 烘焙画布的降采样倍数；越大越平滑也越省，但细节越少 */
    readonly downscale?: number;
    /**
     * 边缘羽化：相对短边的比例，0 表示硬边。
     *
     * 非全屏 wash **必须**设置（建议 0.12~0.3）。
     * 否则会看到一条猬利的水平/垂直接缝——本项就是靠肉眼看出 y=35% 处
     * 那条硬边后加的（两张 wash 边界处 alpha 直接跳变）。
     */
    readonly feather?: number;
    readonly opacity?: number;
  },
): void {
  const { seed, color, alpha = 0.1, downscale = 8, feather = 0, opacity = 1 } = options;

  const baked = bakedWash({ seed, color, alpha, w: bounds.w, h: bounds.h, downscale, feather });

  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(baked, bounds.x, bounds.y, bounds.w, bounds.h);
  ctx.restore();
}

const washCache = new Map<string, Canvas>();

/** 统计烘焙次数。仅用于测试与诊断——它是「缓存是否生效」的可观测证据。 */
let washBakeCount = 0;

/** 已烘焙的 wash 数量（缓存命中不会增加） */
export function getWashBakeCount(): number {
  return washBakeCount;
}

function bakeKey(p: {
  seed: number;
  color: string;
  alpha: number;
  w: number;
  h: number;
  downscale: number;
  feather: number;
}): string {
  return `${p.seed}|${p.color}|${p.alpha}|${p.w}|${p.h}|${p.downscale}|${p.feather}`;
}

/** 烘焙（并缓存）一张低分辨率 wash 位图 */
function bakedWash(p: {
  seed: number;
  color: string;
  alpha: number;
  w: number;
  h: number;
  downscale: number;
  feather: number;
}): Canvas {
  const key = bakeKey(p);
  const hit = washCache.get(key);
  if (hit) return hit;

  washBakeCount++;

  const dw = Math.max(2, Math.ceil(p.w / p.downscale));
  const dh = Math.max(2, Math.ceil(p.h / p.downscale));
  const canvas = new Canvas(dw, dh);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(dw, dh);
  const [r, g, b] = parseColor(p.color);

  // 羽化宽度换算到烘焙画布的像素尺度
  const featherPx = p.feather * Math.min(dw, dh);

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      // 两个尺度叠加：大块色斑 + 中等起伏，都取噪声的平滑插值
      const big = fbm2D((x * p.downscale) / 420, (y * p.downscale) / 420, p.seed, { octaves: 3 });
      const mid = fbm2D((x * p.downscale) / 120, (y * p.downscale) / 120, (p.seed + 991) >>> 0, { octaves: 3 });
      let a = p.alpha * (0.45 + big * 0.7 + mid * 0.35);

      if (featherPx > 0) {
        const edgeX = Math.min(x, dw - 1 - x) / featherPx;
        const edgeY = Math.min(y, dh - 1 - y) / featherPx;
        a *= smooth01(edgeX) * smooth01(edgeY);
      }

      const i = (y * dw + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }

  ctx.putImageData(img, 0, 0);
  washCache.set(key, canvas);
  return canvas;
}

/** [0,1] → 平滑过渡，超出范围则钳制 */
function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * 清空 wash 缓存，并把烘焙计数归零。
 *
 * 两者必须一起重置：只清缓存不归零计数，会让「本测试烘了几次」这类断言
 * 被上一个测试的累计值污染（这个 bug 已被 test/renderer.test.ts 捕获）。
 */
export function clearWashCache(): void {
  washCache.clear();
  washBakeCount = 0;
}

/** 解析 #rrggbb / rgb() / rgba() 为 [r,g,b]；无法解析时回退中灰 */
function parseColor(color: string): [number, number, number] {
  const hex = color.match(/^#?([0-9a-f]{6})$/i);
  if (hex?.[1]) {
    const h = hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [128, 128, 128];
}

/**
 * 干笔刷痕迹：一条边缘破碎、内部透底的笔触。
 * 用于给水彩块「加笔」，避免大面积色块显得平板。
 */
export function dryBrushStreak(
  ctx: CanvasRenderingContext2D,
  options: {
    readonly seed: number;
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    readonly width?: number;
    readonly color: string;
    readonly alpha?: number;
    readonly strands?: number;
    readonly opacity?: number;
  },
): void {
  const { seed, x1, y1, x2, y2, width = 26, color, alpha = 0.12, strands = 9, opacity = 1 } = options;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len === 0) return;

  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const rng = new SeededRandom(seed);

  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.lineCap = 'round';

  for (let i = 0; i < strands; i++) {
    const offset = rng.range(-0.5, 0.5) * width;
    const strandAlpha = alpha * rng.range(0.25, 1);
    // 每一束只在局部出现，形成「断续」的干笔感
    const tStart = rng.range(0, 0.45);
    const tEnd = rng.range(0.55, 1);

    ctx.globalAlpha = opacity * strandAlpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = rng.range(0.7, 2.4);

    const ax = x1 + nx * offset;
    const ay = y1 + ny * offset;
    const bx = x2 + nx * offset;
    const by = y2 + ny * offset;
    roughLine(ctx, ax + (bx - ax) * tStart, ay + (by - ay) * tStart, ax + (bx - ax) * tEnd, ay + (by - ay) * tEnd, {
      seed: (seed + i * 3571) >>> 0,
      segments: 10,
      wobble: 1.2,
      color,
      width: rng.range(0.7, 2.4),
      alpha: strandAlpha,
    });
  }
  ctx.restore();
}
