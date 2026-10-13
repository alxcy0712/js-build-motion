/**
 * L1 艺术图元 — 不规则笔画（需求 §9）。
 *
 * 为什么需要这一层：
 *   直接 `ctx.lineTo()` 画出来的线是数学精确的，成片会像工程图而不是插画。
 *   手绘感来自「每一笔都略微偏离理想路径」——而这个偏离必须是**种子化的、静止的**：
 *   同一帧重复渲染必须完全一致，否则线条会逐帧抖动。
 *
 * 所有函数都要求显式传入 seed。时间维度（如果要用）也必须是参数，
 * 不能读系统时钟。
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import { SeededRandom } from '../../animation/random.ts';
import { noise1D, noise2D } from '../../animation/noise.ts';

/**
 * 线帽样式。
 * 刻意不依赖 DOM lib 的 `CanvasLineCap` 全局类型：
 * 本项目不包含 DOM lib（渲染跑在 Node 上），类型应当自持。
 */
export type LineCapStyle = 'butt' | 'round' | 'square';

export interface RoughLineOptions {
  readonly seed: number;
  /** 沿路径采样点数。越多越平滑，越少越「拙」 */
  readonly segments?: number;
  /** 垂直抖动幅度（像素） */
  readonly wobble?: number;
  /** 把直线分成几段独立重画，模拟「笔抬起再落下」 */
  readonly strokes?: number;
  readonly color?: string;
  readonly width?: number;
  readonly alpha?: number;
  readonly lineCap?: LineCapStyle;
}

/**
 * 手绘感直线。
 * 抖动来自 noise1D 而不是 per-stroke 随机数组——这样调整 segments 时
 * 线条的整体形状是「连续变化」的，而不是完全重排。
 */
export function roughLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  options: RoughLineOptions,
): void {
  const {
    seed,
    segments = 16,
    wobble = 1.6,
    strokes = 1,
    color = '#241b2f',
    width = 3,
    alpha = 1,
    lineCap = 'round',
  } = options;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const nx = -dy / len;
  const ny = dx / len;

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = lineCap;

  const rng = new SeededRandom(seed);
  for (let s = 0; s < strokes; s++) {
    // 每一笔有自己的起止位置偏移与相位，形成「复描」感
    const tStart = strokes === 1 ? 0 : rng.range(-0.02, 0.04);
    const tEnd = strokes === 1 ? 1 : rng.range(0.96, 1.02);
    const phase = rng.range(0, 1000);
    const amp = wobble * rng.range(0.6, 1.3);
    const widthScale = rng.range(0.75, 1.1);

    ctx.lineWidth = width * widthScale;
    ctx.globalAlpha = alpha * (strokes === 1 ? 1 : rng.range(0.35, 0.7));

    ctx.beginPath();
    for (let i = 0; i <= segments; i++) {
      const t = tStart + ((tEnd - tStart) * i) / segments;
      // 两端收紧：让线头线尾贴合理想端点，中间才明显偏离
      const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
      const offset = (noise1D(t * 3.5 + phase, seed) - 0.5) * 2 * amp * taper;
      const px = x1 + dx * t + nx * offset;
      const py = y1 + dy * t + ny * offset;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** 手绘感折线/多边形（可闭合） */
export function roughPolyline(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<readonly [number, number]>,
  options: RoughLineOptions & { readonly close?: boolean; readonly fill?: string },
): void {
  const { close = false, fill, seed, color, width, alpha, lineCap } = options;
  if (points.length < 2) return;

  if (fill) {
    // 填充用平滑后的路径，避免抖动造成的毛刺被填成锯齿
    ctx.save();
    ctx.globalAlpha *= alpha ?? 1;
    ctx.fillStyle = fill;
    ctx.beginPath();
    const sub = options.segments ?? 10;
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as readonly [number, number];
      const b = points[(i + 1) % points.length] as readonly [number, number];
      if (i === 0) ctx.moveTo(a[0], a[1]);
      for (let s = 1; s <= sub; s++) {
        const t = s / sub;
        ctx.lineTo(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      }
    }
    if (close) ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (let i = 0; i < points.length - (close ? 0 : 1); i++) {
    const a = points[i] as readonly [number, number];
    const b = points[(i + 1) % points.length] as readonly [number, number];
    roughLine(ctx, a[0], a[1], b[0], b[1], {
      seed: seed + i * 7919,
      ...(color !== undefined ? { color } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(alpha !== undefined ? { alpha } : {}),
      ...(lineCap !== undefined ? { lineCap } : {}),
      ...(options.segments !== undefined ? { segments: Math.max(4, Math.floor(options.segments / 2)) } : {}),
      ...(options.wobble !== undefined ? { wobble: options.wobble } : {}),
    });
  }
}

export interface WobblyCircleOptions {
  readonly seed: number;
  readonly radius: number;
  readonly cx: number;
  readonly cy: number;
  /** 半径相对抖动强度，0.05 表示 ±5% */
  readonly wobble?: number;
  readonly points?: number;
}

/** 生成「不完全圆」的采样点——插画里的圆从来不是正圆 */
export function wobblyCirclePoints(options: WobblyCircleOptions): Array<[number, number]> {
  const { seed, radius, cx, cy, wobble = 0.06, points = 40 } = options;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    // 用周期性采样保证首尾闭合连续：绕一圈后噪声相位回到起点
    const r = radius * (1 + (noise2D(Math.cos(a) * 2.2, Math.sin(a) * 2.2, seed) - 0.5) * 2 * wobble);
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/**
 * 手绘圆 / 椭圆形的填充路径。
 * 返回点集而不直接绘制，方便调用方复用于填充、描边、裁剪。
 */
export function wobblyEllipsePoints(options: {
  seed: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation?: number;
  wobble?: number;
  points?: number;
}): Array<[number, number]> {
  const { seed, cx, cy, rx, ry, rotation = 0, wobble = 0.06, points = 40 } = options;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k = 1 + (noise2D(Math.cos(a) * 2.2, Math.sin(a) * 2.2, seed) - 0.5) * 2 * wobble;
    const lx = Math.cos(a) * rx * k;
    const ly = Math.sin(a) * ry * k;
    out.push([cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
  }
  return out;
}

/** 把点集描成平滑闭合曲线（Catmull-Rom → 贝塞尔），用于有机形状 */
export function traceSmoothClosed(ctx: CanvasRenderingContext2D, points: ReadonlyArray<readonly [number, number]>): void {
  const n = points.length;
  if (n < 3) return;
  ctx.beginPath();
  const first = points[0] as readonly [number, number];
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n] as readonly [number, number];
    const p1 = points[i] as readonly [number, number];
    const p2 = points[(i + 1) % n] as readonly [number, number];
    const p3 = points[(i + 2) % n] as readonly [number, number];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
  }
  ctx.closePath();
}
