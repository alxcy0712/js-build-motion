import type { CanvasRenderingContext2D, Path2D } from 'skia-canvas';
import { SeededRandom } from '../../animation/random.ts';
import { noise1D } from '../../animation/noise.ts';
import { watercolorWash } from './watercolor.ts';

export interface PressureStrokeOptions {
  seed: number; color: string; width: number;
  /** Relative widths at the start, middle and end, joined with smooth interpolation. */
  pressure?: readonly [number, number, number];
  dryness?: number; alpha?: number;
}

/** A seeded ribbon with pressure and fixed dry gaps, in object-local coordinates. */
export function pressureStroke(ctx: CanvasRenderingContext2D, from: readonly [number, number], to: readonly [number, number], options: PressureStrokeOptions): void {
  const { seed, color, width, pressure = [0.15, 1, 0.1], dryness = 0, alpha = 0.3 } = options;
  const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
  if (!length || width <= 0) return;
  const nx = -dy / length, ny = dx / length, rng = new SeededRandom(seed), segments = 24;
  const edge = (t: number, side: number): readonly [number, number] => {
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2, blend = u * u * (3 - 2 * u);
    const p = t < 0.5 ? pressure[0] + (pressure[1] - pressure[0]) * blend : pressure[1] + (pressure[2] - pressure[1]) * blend;
    const wobble = (noise1D(t * 4 + 0.37, seed) - 0.5) * width * 0.15 * Math.sin(Math.PI * t);
    const offset = wobble + side * Math.max(0, p) * width / 2;
    return [from[0] + dx * t + nx * offset, from[1] + dy * t + ny * offset];
  };
  ctx.save(); ctx.fillStyle = color; ctx.globalAlpha *= alpha;
  let start: number | null = null;
  const fill = (a: number, b: number): void => {
    ctx.beginPath();
    const steps = Math.max(1, Math.ceil((b - a) * segments));
    for (let i = 0; i <= steps; i++) { const p = edge(a + (b - a) * i / steps, 1); if (!i) ctx.moveTo(...p); else ctx.lineTo(...p); }
    for (let i = steps; i >= 0; i--) ctx.lineTo(...edge(a + (b - a) * i / steps, -1));
    ctx.closePath(); ctx.fill();
  };
  for (let i = 0; i <= segments; i++) {
    const present = i < segments && rng.next() >= Math.max(0, Math.min(1, dryness)) * 0.6;
    if (present && start === null) start = i / segments;
    if (!present && start !== null) { fill(start, i / segments); start = null; }
  }
  ctx.restore();
}

export interface RegionPaintOptions {
  seed: number; color: string; angle?: number; spacing?: number; width?: number;
  /** 0: dry directional strokes, 1: continuous strokes over a soft wash. */
  wetness?: number;
  /** Fraction of sampled strokes retained; preserves paper between strokes. */
  coverage?: number; alpha?: number;
}

/** Clip wash and brushwork to an independently designed path. Holes use even-odd fill. */
export function paintRegion(ctx: CanvasRenderingContext2D, path: Path2D, bounds: { x: number; y: number; w: number; h: number }, options: RegionPaintOptions): void {
  const { seed, color, angle = -0.25, spacing = 12, width = 18, wetness = 0.4, coverage = 0.85, alpha = 0.3 } = options;
  if (![spacing, width, bounds.w, bounds.h].every(v => Number.isFinite(v) && v > 0) || ![wetness, coverage, alpha].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('REGION_PAINT_OPTIONS');
  const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2, radius = Math.hypot(bounds.w, bounds.h) / 2;
  const ux = Math.cos(angle), uy = Math.sin(angle), nx = -uy, ny = ux, rng = new SeededRandom(seed);
  ctx.save(); ctx.clip(path, 'evenodd');
  if (wetness > 0) watercolorWash(ctx, bounds, { seed, color, alpha: alpha * wetness * 0.45, feather: 0.08 });
  const count = Math.ceil(2 * radius / spacing);
  for (let i = 0; i <= count; i++) {
    const keep = rng.next(), offset = -radius + i * spacing + rng.range(-0.15, 0.15) * spacing;
    const centerX = cx + nx * offset, centerY = cy + ny * offset;
    if (keep > coverage) continue;
    pressureStroke(ctx, [centerX - ux * radius, centerY - uy * radius], [centerX + ux * radius, centerY + uy * radius], {
      seed: (seed + i * 3571) >>> 0, color, width, dryness: 1 - wetness, alpha,
    });
  }
  ctx.restore();
}
