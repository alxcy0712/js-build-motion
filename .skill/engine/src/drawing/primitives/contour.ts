export type Point = readonly [number, number];
export interface ContourPair { from: Point[]; to: Point[] }

/** Closed outer contours only. Holes and disconnected parts need their own correspondence. */
export function resampleContour(points: readonly Point[], count = 96): Point[] {
  if (points.length < 3 || !Number.isInteger(count) || count < 3 || points.some(p => !p.every(Number.isFinite))) throw new Error('CONTOUR_INPUT');
  const lengths = points.map((p, i) => {
    const next = points[(i + 1) % points.length]!;
    return Math.hypot(next[0] - p[0], next[1] - p[1]);
  });
  const perimeter = lengths.reduce((a, b) => a + b, 0);
  if (perimeter === 0) throw new Error('CONTOUR_DEGENERATE');
  let segment = 0, consumed = 0;
  return Array.from({ length: count }, (_, i): Point => {
    const distance = perimeter * i / count;
    while (segment < points.length - 1 && consumed + lengths[segment]! <= distance) consumed += lengths[segment++]!;
    const a = points[segment]!, b = points[(segment + 1) % points.length]!;
    const t = lengths[segment] ? (distance - consumed) / lengths[segment]! : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  });
}

function signedArea(points: readonly Point[]): number {
  return points.reduce((area, p, i) => {
    const q = points[(i + 1) % points.length]!;
    return area + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
}

/** Prepare once in a shared coordinate space; match winding and cyclic start before interpolation. */
export function prepareMorph(from: readonly Point[], to: readonly Point[], count = 96): ContourPair {
  const a = resampleContour(from, count);
  const b = resampleContour(signedArea(from) * signedArea(to) < 0 ? [...to].reverse() : to, count);
  let best = 0, bestDistance = Infinity;
  for (let shift = 0; shift < count; shift++) {
    const distance = a.reduce((sum, p, i) => {
      const q = b[(i + shift) % count]!;
      return sum + (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
    }, 0);
    if (distance < bestDistance) { bestDistance = distance; best = shift; }
  }
  return { from: a, to: a.map((_, i) => b[(i + best) % count]!) };
}

export function morphContour(pair: ContourPair, progress: number): Point[] {
  const t = Math.max(0, Math.min(1, progress));
  if (t === 0) return pair.from.map(p => [...p] as Point);
  if (t === 1) return pair.to.map(p => [...p] as Point);
  return pair.from.map((p, i): Point => {
    const q = pair.to[i]!;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  });
}

/** Bounded normal displacement from the base contour, held at a drawing cadence. */
export function boilContour(points: readonly Point[], time: number, options: { seed: number; amount: number; rate?: number }): Point[] {
  const tick = Math.floor(time * (options.rate ?? 12));
  return points.map((p, i): Point => {
    const prev = points[(i + points.length - 1) % points.length]!, next = points[(i + 1) % points.length]!;
    const dx = next[0] - prev[0], dy = next[1] - prev[1], length = Math.hypot(dx, dy) || 1;
    const phase = i / points.length * Math.PI * 2;
    const offset = options.amount * (Math.sin(phase * 3 + tick * 1.7 + options.seed) + Math.sin(phase * 7 - tick * 0.9 + options.seed * 0.37)) / 2;
    return [p[0] - dy / length * offset, p[1] + dx / length * offset];
  });
}
