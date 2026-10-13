/**
 * L4 风格 —— watercolor_storybook（需求 §32）。
 *
 * 风格不是"选个滤镜"，而是对整幅画做一次统一的收尾处理。
 * 这个模块只做**最后一遍**叠加，不参与具体物体绘制，因此：
 *   - 任何场景都能复用它（风格与内容解耦）
 *   - 它只做加法（叠色/颗粒/纸感），不改变构图
 *
 * 为什么需要它：物体一个个画完之后，画面会呈现"每个形状都均匀、边界都清晰"
 * 的矢量感。真实插画里颜料会互相渗透、同一块颜色深浅不一。
 * 这一遍就是用来打散这种均匀性的。
 *
 * 一次真实踩坑（已修）：
 *   初版用 `watercolorBlob` 做大尺度颜料不均。blob 的「边缘加深」是按
 *   `min(rx,ry) * 0.14` 计算描边宽度的——对小色块合适，但放大到 rx≈0.4 屏宽后
 *   就变成一条 30 多像素宽的深色带，整幅画上浮着几条蛇形暗纹。
 *   大尺度色块必须用 `watercolorWash`（逐像素写 alpha、烘焙后可缓存），
 *   它天生没有"边缘"这个概念。
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import { PaperTexture } from '../art/paper.ts';
import { watercolorWash } from '../art/watercolor.ts';
import { alpha, mix, type PaletteColors } from './palette.ts';

export interface StorybookFinishOptions {
  readonly width: number;
  readonly height: number;
  readonly palette: PaletteColors;
  readonly seed: number;
  /** 场景内局部时间（只用于极低频的纸纹呼吸） */
  readonly sceneTime: number;
  /** 叠色强度 0..1，默认 0.5 */
  readonly strength?: number;
}

/**
 * 收尾叠加。必须在大体元素之后、暗角之前调用。
 *
 * 四件事：
 *   1. 大尺度颜料不均（烘焙 wash，平滑无边缘）
 *   2. 冷暖分区（背光侧偏冷、受光侧偏暖）
 *   3. 纸纹（覆盖包括人物在内的所有像素，把画面统一到同一张纸上）
 *   4. 极轻的径向提亮（不是实心椭圆，避免引入硬边）
 */
export function applyStorybookFinish(ctx: CanvasRenderingContext2D, o: StorybookFinishOptions): void {
  const { width: w, height: h, palette, seed, sceneTime, strength = 0.5 } = o;
  if (strength <= 0) return;

  // --- 1. 大尺度颜料不均 ---
  // 用 wash 而不是 blob：wash 是烘焙出来的平滑 alpha 场，
  // 没有边缘描边，也不会因为尺寸放大而退化成暗带。
  watercolorWash(ctx, { x: 0, y: 0, w, h }, {
    seed: (seed + 7001) >>> 0,
    color: palette.glass,
    alpha: 0.16 * strength,
    downscale: 12,
    feather: 0.4,
  });
  watercolorWash(ctx, { x: 0, y: h * 0.28, w: w * 0.72, h: h * 0.72 }, {
    seed: (seed + 7002) >>> 0,
    color: palette.sky,
    alpha: 0.14 * strength,
    downscale: 12,
    feather: 0.45,
  });
  watercolorWash(ctx, { x: w * 0.18, y: h * 0.52, w: w * 0.82, h: h * 0.48 }, {
    seed: (seed + 7003) >>> 0,
    color: palette.lamp,
    alpha: 0.12 * strength,
    downscale: 12,
    feather: 0.45,
  });

  // --- 2. 冷暖分区 ---
  ctx.save();
  ctx.globalAlpha = 0.07 * strength;
  const cool = ctx.createLinearGradient(0, 0, w * 0.9, h);
  cool.addColorStop(0, palette.sky);
  cool.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = cool;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.06 * strength;
  const warm = ctx.createLinearGradient(w, h, w * 0.3, h * 0.4);
  warm.addColorStop(0, palette.lamp);
  warm.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // --- 3. 纸纹：把人物和背景统一到同一张纸上 ---
  PaperTexture.get({ seed: seed + 101, grain: 0.55, fiber: 0.42, tint: null }).draw(ctx, w, h, {
    alpha: 0.4,
    breatheTime: sceneTime,
  });

  // --- 4. 受光侧径向提亮 ---
  // 用径向渐变而不是实心椭圆：后者会在 5% alpha 下也留下可辨的硬边。
  ctx.save();
  ctx.globalAlpha = 0.07 * strength;
  const lift = ctx.createRadialGradient(w * 0.66, h * 0.3, 4, w * 0.66, h * 0.3, Math.max(w, h) * 0.5);
  lift.addColorStop(0, '#ffffff');
  lift.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** 风格预设 → 收尾强度。让不同 preset 有可分辨的观感差异，而不是只有名字不同。 */
export function finishStrengthFor(preset: string): number {
  switch (preset) {
    case 'watercolor_storybook': return 0.7;
    case 'ink': return 0.2;
    case 'pencil': return 0.35;
    case 'paper_cut': return 0.25;
    case 'flat': return 0;
    default: return 0.5;
  }
}

/** 深色暗角。单独导出以便不同场景自定义强度。 */
export function applyVignette(
  ctx: CanvasRenderingContext2D,
  o: { width: number; height: number; palette: PaletteColors; strength?: number; centerY?: number },
): void {
  const { width: w, height: h, palette, strength = 0.6, centerY = 0.48 } = o;
  const vig = ctx.createRadialGradient(
    w / 2, h * centerY, Math.min(w, h) * 0.32,
    w / 2, h * centerY, Math.max(w, h) * 0.74,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, alpha(mix(palette.shadow, '#000000', 0.5), strength));
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
}
