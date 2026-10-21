/**
 * 风格质感：可选镜头微运动、扫光、暗角、颗粒。静镜相机由管线约束。
 * 只作用于 theme_stage 镜头；motion_stage 独立绘制图解背景与图元。
 */
import { Canvas, ImageData, type CanvasRenderingContext2D } from 'skia-canvas';
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
  grainCache.set(key, tiles);
  while (grainCache.size > 8) grainCache.delete(grainCache.keys().next().value!);
  return tiles;
}

/** Renderer-owned, bounded noise masks. Keys include every parameter affecting their pixels. */
export class DitherCache {
  private masks = new Map<string, { image: ImageData; bytes: number }>();
  private bytes = 0;
  readonly maximumBytes = 16 * 1024 * 1024;
  hits = 0;
  mask(width: number, height: number, state: number): ImageData {
    const key = `${width}:${height}:${state >>> 0}`, hit = this.masks.get(key);
    if (hit) { this.hits++; this.masks.delete(key); this.masks.set(key, hit); return hit.image; }
    const image = new ImageData(width, height), pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
    for (let i = 0; i < pixels.length; i++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      pixels[i] = (state >>> 31) === 0 ? 0xffffffff : 0;
    }
    const bytes = width * height * 4;
    while (this.bytes + bytes > this.maximumBytes && this.masks.size) {
      const oldest = this.masks.keys().next().value!; this.bytes -= this.masks.get(oldest)!.bytes; this.masks.delete(oldest);
    }
    if (bytes <= this.maximumBytes) { this.masks.set(key, { image, bytes }); this.bytes += bytes; }
    return image;
  }
  stats() { return { entries: this.masks.size, bytes: this.bytes, maximumBytes: this.maximumBytes, hits: this.hits }; }
  clear() { this.masks.clear(); this.bytes = 0; }
}

/** 在完整场景后、字幕前调用。 */
export function drawTreatments(ctx: CanvasRenderingContext2D, theme: ThemeTokens, time: number, sceneTime: number, width: number, height: number, seed: number, opaqueDither?: DitherCache): void {
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
  if (T.vignette > 0) {
    // 8bit 合成后添加 ±1 级的中性噪声；暗部 overlay 颗粒的振幅随亮度减小，单独覆盖量化色带。
    let state = (seed ^ Math.floor(time * T.grain.fps)) >>> 0;
    if (opaqueDither) {
      // Opaque RGBA8: invert only negative-noise pixels, saturating +1, invert them back.
      // Positive pixels become min(C+1,255); negative pixels become max(C-1,0).
      const mask = opaqueDither.mask(width, height, state);
      ctx.save(); ctx.resetTransform(); ctx.globalAlpha = 1; ctx.filter = 'none';
      ctx.globalCompositeOperation = 'difference'; ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = '#010101'; ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'difference'; ctx.drawImage(mask, 0, 0); ctx.restore();
      return;
    }
    // Preserve the public helper's alpha behavior for callers with transparent intermediate surfaces.
    const image = ctx.getImageData(0, 0, width, height), data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const noise = (state >>> 31) * 2 - 1;
      data[i] = data[i]! + noise;
      data[i + 1] = data[i + 1]! + noise;
      data[i + 2] = data[i + 2]! + noise;
    }
    ctx.putImageData(image, 0, 0);
  }
}
