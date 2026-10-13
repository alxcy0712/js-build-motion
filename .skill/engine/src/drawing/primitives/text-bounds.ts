import type { CanvasRenderingContext2D } from 'skia-canvas';
import type { PixelRegion } from './visual-check.ts';

export interface TextDraw {
  text: string; bounds: PixelRegion; sourceClipped: boolean;
}
interface TextSurface { draws: TextDraw[]; reset: () => void }
const surfaces = new WeakMap<object, TextSurface>();

function transformed(bounds: PixelRegion, ctx: CanvasRenderingContext2D): PixelRegion {
  const m = ctx.getTransform();
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]];
  const xs = corners.map(([x, y]) => m.a * x! + m.c * y! + m.e), ys = corners.map(([x, y]) => m.b * x! + m.d * y! + m.f);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
export function textOutside(bounds: PixelRegion, width: number, height: number, tolerance = 0.5): boolean {
  return bounds.x < -tolerance || bounds.y < -tolerance || bounds.x + bounds.width > width + tolerance || bounds.y + bounds.height > height + tolerance;
}

/** Opt-in instrumentation. Measures glyphs and transforms; clip paths and occlusion require raster review. */
export function trackTextBounds(ctx: CanvasRenderingContext2D): TextSurface {
  const existing = surfaces.get(ctx.canvas);
  if (existing) return existing;
  const surface: TextSurface = { draws: [], reset: () => { surface.draws.length = 0; } };
  surfaces.set(ctx.canvas, surface);
  for (const method of ['fillText', 'strokeText'] as const) {
    const original = ctx[method].bind(ctx);
    ctx[method] = (text, x, y, maxWidth) => {
      original(text, x, y, maxWidth);
      if (ctx.globalAlpha <= 0 || !text.trim()) return;
      const metrics = ctx.measureText(text, maxWidth);
      const pad = method === 'strokeText' ? ctx.lineWidth / 2 : 0;
      const bounds = transformed({ x: x - metrics.actualBoundingBoxLeft - pad, y: y - metrics.actualBoundingBoxAscent - pad,
        width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight + 2 * pad, height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 2 * pad }, ctx);
      surface.draws.push({ text, bounds, sourceClipped: false });
    };
  }
  const originalImage = ctx.drawImage.bind(ctx);
  ctx.drawImage = ((image: { width: number; height: number }, ...coords: number[]) => {
    originalImage(image as never, ...coords as [number, number]);
    const source = surfaces.get(image);
    if (!source || ctx.globalAlpha <= 0) return;
    const [sx, sy, sw, sh, dx, dy, dw, dh] = coords.length === 8 ? coords : [0, 0, image.width, image.height, coords[0]!, coords[1]!, coords[2] ?? image.width, coords[3] ?? image.height];
    for (const draw of [...source.draws]) {
      const b = draw.bounds;
      const sourceClipped = draw.sourceClipped || textOutside(b, image.width, image.height) || b.x < sx! || b.y < sy! || b.x + b.width > sx! + sw! || b.y + b.height > sy! + sh!;
      surface.draws.push({ text: draw.text, sourceClipped, bounds: transformed({ x: dx! + (b.x - sx!) * dw! / sw!, y: dy! + (b.y - sy!) * dh! / sh!, width: b.width * dw! / sw!, height: b.height * dh! / sh! }, ctx) });
    }
  }) as CanvasRenderingContext2D['drawImage'];
  return surface;
}
