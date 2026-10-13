export interface Pixels { width: number; height: number; data: ArrayLike<number> }
export interface PixelRegion { x: number; y: number; width: number; height: number }

/** Compare registered foreground masks. Empty masks are an invalid reference. */
export function compareMasks(actual: Pixels, reference: Pixels, threshold = 127) {
  if (actual.width !== reference.width || actual.height !== reference.height) throw new Error('MASK_SIZE');
  let intersection = 0, union = 0, actualArea = 0, referenceArea = 0;
  for (let i = 3; i < actual.width * actual.height * 4; i += 4) {
    const a = actual.data[i]! > threshold, b = reference.data[i]! > threshold;
    if (a) actualArea++;
    if (b) referenceArea++;
    if (a && b) intersection++;
    if (a || b) union++;
  }
  if (!referenceArea) throw new Error('MASK_EMPTY_REFERENCE');
  return { iou: intersection / union, intersection, union, actualArea, referenceArea, missing: referenceArea - intersection, extra: actualArea - intersection };
}

/** Probe a visible material or clearance in the final raster, with compression tolerance. */
export function colorCoverage(pixels: Pixels, region: PixelRegion, rgb: readonly [number, number, number], tolerance = 24): number {
  const x0 = Math.floor(region.x), y0 = Math.floor(region.y), x1 = Math.ceil(region.x + region.width), y1 = Math.ceil(region.y + region.height);
  if (x0 < 0 || y0 < 0 || x1 > pixels.width || y1 > pixels.height || x1 <= x0 || y1 <= y0) throw new Error('PIXEL_REGION');
  let matched = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * pixels.width + x) * 4;
    if (pixels.data[i + 3]! > 127 && rgb.every((channel, k) => Math.abs(pixels.data[i + k]! - channel) <= tolerance)) matched++;
  }
  return matched / ((x1 - x0) * (y1 - y0));
}

export interface FrameDifference {
  changedArea: number;
  meanDifference: number;
  bounds: PixelRegion | null;
}

/** RGBA difference in display space: hidden RGB in transparent pixels contributes zero. */
export function frameDifference(previous: Pixels, current: Pixels, pixelThreshold = 8, heat?: Uint32Array): FrameDifference {
  if (previous.width !== current.width || previous.height !== current.height) throw new Error('FRAME_SIZE');
  const { width, height } = current, count = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || previous.data.length !== count * 4 || current.data.length !== count * 4) throw new Error('FRAME_PIXELS');
  if (!Number.isFinite(pixelThreshold) || pixelThreshold < 0 || pixelThreshold > 255 || (heat && heat.length !== count)) throw new Error('FRAME_THRESHOLD');
  let changed = 0, sum = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let p = 0; p < count; p++) {
    const i = p * 4, a = previous.data[i + 3]! / 255, b = current.data[i + 3]! / 255;
    let delta = Math.abs(previous.data[i + 3]! - current.data[i + 3]!);
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(previous.data[i + c]! * a - current.data[i + c]! * b));
    sum += delta;
    if (delta > pixelThreshold) {
      changed++;
      if (heat) heat[p]++;
      const x = p % width, y = Math.floor(p / width);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { changedArea: changed / count, meanDifference: sum / (count * 255),
    bounds: changed ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null };
}

export interface FramePair extends FrameDifference { from: number; to: number }
export interface DiagnosticThresholds {
  pixelThreshold: number; staticArea: number; jumpArea: number; jumpDifference: number; jumpFactor: number;
}
export const FRAME_DIAGNOSTIC_DEFAULTS: DiagnosticThresholds = {
  pixelThreshold: 8, staticArea: 0.001, jumpArea: 0.025, jumpDifference: 0.015, jumpFactor: 6,
};

/** Summaries locate review candidates; shot purpose determines their meaning. */
export function summarizeFramePairs(pairs: readonly FramePair[], fps: number, thresholds: DiagnosticThresholds = FRAME_DIAGNOSTIC_DEFAULTS) {
  if (!Number.isFinite(fps) || fps <= 0 || pairs.some((p, i) => p.to !== p.from + 1 || (i > 0 && p.from !== pairs[i - 1]!.to))) throw new Error('FRAME_SEQUENCE');
  if (!Number.isFinite(thresholds.pixelThreshold) || thresholds.pixelThreshold < 0 || thresholds.pixelThreshold > 255 || [thresholds.staticArea, thresholds.jumpArea, thresholds.jumpDifference].some(v => !Number.isFinite(v) || v < 0 || v > 1) || !Number.isFinite(thresholds.jumpFactor) || thresholds.jumpFactor <= 1) throw new Error('FRAME_THRESHOLD');
  const holds: { from: number; to: number; start: number; end: number; seconds: number }[] = [];
  for (const pair of pairs) {
    if (pair.changedArea > thresholds.staticArea) continue;
    const last = holds.at(-1);
    if (last && last.to === pair.from) { last.to = pair.to; last.end = pair.to / fps; last.seconds = last.end - last.start; }
    else holds.push({ from: pair.from, to: pair.to, start: pair.from / fps, end: pair.to / fps, seconds: 1 / fps });
  }
  const jumps = pairs.flatMap((pair, i) => {
    // Exclude the two sides of a single bad frame from each other's baseline.
    const neighbors = pairs.slice(Math.max(0, i - 6), i + 7).filter(p => Math.abs(p.to - pair.to) > 1).map(p => p.meanDifference).sort((a, b) => a - b);
    if (neighbors.length < 4) return [];
    const middle = Math.floor(neighbors.length / 2);
    const baseline = neighbors.length % 2 ? neighbors[middle]! : (neighbors[middle - 1]! + neighbors[middle]!) / 2;
    return pair.changedArea >= thresholds.jumpArea && pair.meanDifference >= thresholds.jumpDifference && pair.meanDifference > baseline * thresholds.jumpFactor
      ? [{ from: pair.from, to: pair.to, time: pair.to / fps, baseline, meanDifference: pair.meanDifference, changedArea: pair.changedArea, bounds: pair.bounds }] : [];
  });
  return { pairCount: pairs.length, staticRatio: pairs.length ? pairs.filter(p => p.changedArea <= thresholds.staticArea).length / pairs.length : null,
    meanChangedArea: pairs.length ? pairs.reduce((n, p) => n + p.changedArea, 0) / pairs.length : null, holds, jumps };
}
