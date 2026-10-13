/**
 * 确定性测试用的「标准场景」。
 *
 * 刻意同时包含两类元素，以便分别验证两件不同的事：
 *   - 随时间变化的元素（水彩块位置、手绘线）→ 验证动画本身是 frameIndex 的纯函数
 *   - 完全静止的元素（纸纹）→ 验证纹理不逐帧闪烁
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import type { FrameContext } from '../../src/renderer/renderer.ts';
import { PaperTexture } from '../../src/drawing/art/paper.ts';
import { watercolorBlob, watercolorWash } from '../../src/drawing/art/watercolor.ts';
import { roughLine, wobblyCirclePoints, traceSmoothClosed } from '../../src/drawing/art/rough.ts';
import { breathe, pingPong } from '../../src/animation/easing.ts';

export const CANONICAL_WIDTH = 540;
export const CANONICAL_HEIGHT = 960;

/** 纸纹层：必须与 frameIndex 无关 */
export function drawCanonicalPaper(ctx: CanvasRenderingContext2D, _rc: FrameContext): void {
  PaperTexture.get({ seed: 4242, grain: 0.55, fiber: 0.4 }).draw(
    ctx,
    CANONICAL_WIDTH,
    CANONICAL_HEIGHT,
    { alpha: 0.55 },
  );
}

/** 完整场景：包含时间驱动动画 */
export function drawCanonicalScene(ctx: CanvasRenderingContext2D, rc: FrameContext): void {
  const { width: w, height: h, seed } = rc;
  const t = rc.time;

  // --- 背景 wash ---
  watercolorWash(ctx, { x: 0, y: 0, w, h }, { seed: seed + 1, color: '#2a2350', alpha: 0.5 });
  // 非全屏 wash 必须羽化，否则会在 y=35% 处留下一条硬接缝
  watercolorWash(ctx, { x: 0, y: h * 0.35, w, h: h * 0.65 }, { seed: seed + 2, color: '#7b5ea7', alpha: 0.28, feather: 0.3 });

  // --- 三个水彩块，各自按不同频率缓慢移动 ---
  const blobs: ReadonlyArray<readonly [number, number, number, string]> = [
    [0.28, 0.30, 0.10, '#e8a13c'],
    [0.70, 0.42, 0.13, '#c2543f'],
    [0.48, 0.66, 0.16, '#3f7a6a'],
  ];
  blobs.forEach(([fx, fy, fr], i) => {
    const dx = (breathe(t * (0.06 + i * 0.02) + i * 0.3) - 0.5) * w * 0.05;
    const dy = (pingPong(t * (0.04 + i * 0.015) + i * 0.2) - 0.5) * h * 0.04;
    watercolorBlob(ctx, {
      seed: (seed + 1000 + i * 131) >>> 0,
      cx: w * fx + dx,
      cy: h * fy + dy,
      rx: w * fr,
      ry: h * fr * 0.62,
      color: blobs[i]?.[3] ?? '#888888',
      layers: 4,
      alpha: 0.16,
      granulation: 0.4,
    });
  });

  // --- 手绘轮廓 ---
  const outline = wobblyCirclePoints({ seed: seed + 77, cx: w * 0.5, cy: h * 0.5, radius: w * 0.22, wobble: 0.08, points: 34 });
  ctx.save();
  traceSmoothClosed(ctx, outline);
  ctx.strokeStyle = 'rgba(36,27,47,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  roughLine(ctx, w * 0.12, h * 0.82, w * 0.88, h * 0.84, {
    seed: seed + 501,
    wobble: 3.4,
    width: 3.2,
    strokes: 2,
    color: '#241b2f',
    alpha: 0.75,
  });

  // --- 纸纹（静止层，但放在最后以便测试单独对比） ---
  PaperTexture.get({ seed: 4242, grain: 0.55, fiber: 0.4 }).draw(ctx, w, h, { alpha: 0.55 });

  // --- 文本：确认字体路径也参与确定性 ---
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 32px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`f${rc.frameIndex}`, 24, h - 40);
}
