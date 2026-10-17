/**
 * 风格逐帧质感：镜头微运动（推镜/视差）、扫光、暗角、颗粒。每帧都执行，保证不出现死帧。
 * 只作用于 theme_stage 镜头；旧环境（rain_window / motion_stage）不经过这里，保持原水彩外观。
 */
import { Canvas, type CanvasRenderingContext2D } from 'skia-canvas';
import { microMotionAt } from '../themes/liveness.ts';
import type { ThemeTokens } from '../themes/types.ts';

/** 在场景绘制前调用：围绕画面中心施加推镜缩放与视差平移（参考像素按画宽缩放）。 */
export function applyMicroMotion(ctx: CanvasRenderingContext2D, theme: ThemeTokens, sceneTime: number, width: number, height: number): void {
  const m = microMotionAt(theme, sceneTime), k = width / 1080;
  ctx.translate(width / 2 + m.offsetX * k, height / 2 + m.offsetY * k);
  ctx.scale(m.scale, m.scale);
  ctx.translate(-width / 2, -height / 2);
}

const grainCache = new Map<string, Canvas[]>();
function grainTiles(seed: number): Canvas[] {
  const key = String(seed);
  const hit = grainCache.get(key); if (hit) return hit;
  const tiles = [0, 1, 2, 3].map((k) => {
    const c = new Canvas(256, 256), g = c.getContext('2d'), img = g.createImageData(256, 256);
    let s = (seed + k * 7919) >>> 0;
    for (let i = 0; i < img.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const v = s >>> 24; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); return c;
  });
  grainCache.set(key, tiles); return tiles;
}

/** 在场景（含字幕）之后调用。 */
export function drawTreatments(ctx: CanvasRenderingContext2D, theme: ThemeTokens, time: number, sceneTime: number, width: number, height: number, seed: number): void {
  const L = theme.liveness, T = theme.treatments;
  const m = microMotionAt(theme, sceneTime);
  if (L.layers.includes('lightSweep') && L.lightSweep) {
    // 斜向柔光带从左上扫到右下，周期循环
    const x = -width * 0.6 + m.sweepPhase * width * 2.2;
    const g = ctx.createLinearGradient(x, 0, x + width * 0.5, height * 0.35);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${L.lightSweep.opacity})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
  if (T.vignette > 0) {
    const v = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) * 0.55);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${T.vignette})`);
    ctx.save(); ctx.fillStyle = v; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
  if (T.grain.opacity > 0) {
    const tiles = grainTiles(seed), idx = Math.floor(time * T.grain.fps) % tiles.length;
    const pattern = ctx.createPattern(tiles[idx]!, 'repeat');
    if (pattern) { ctx.save(); ctx.globalAlpha = T.grain.opacity; ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = pattern; ctx.fillRect(0, 0, width, height); ctx.restore(); }
  }
}
