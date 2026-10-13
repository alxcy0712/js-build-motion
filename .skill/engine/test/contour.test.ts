import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boilContour, morphContour, prepareMorph, resampleContour, type Point } from '../src/drawing/primitives/contour.ts';

const square: Point[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
test('closed contour samples cover equal perimeter distances and preserve the anchor', () => {
  assert.deepEqual(resampleContour(square, 8), [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50]]);
  assert.deepEqual(resampleContour([...square, square[0]!], 8), resampleContour(square, 8));
  assert.throws(() => resampleContour([[1, 1], [1, 1], [1, 1]]), /DEGENERATE/);
});
test('a reversed, rotated contour stays stationary at every morph stage', () => {
  const pair = prepareMorph(square, [[100, 100], [100, 0], [0, 0], [0, 100]], 32);
  for (const t of [0, .25, .5, .75, 1]) assert.deepEqual(morphContour(pair, t), pair.from);
});
test('different silhouettes retain prepared endpoints with finite intermediate geometry', () => {
  const circle: Point[] = Array.from({ length: 64 }, (_, i) => [50 + 50 * Math.cos(i * Math.PI / 32), 50 + 50 * Math.sin(i * Math.PI / 32)]);
  const pair = prepareMorph(square, circle, 64);
  assert.deepEqual(morphContour(pair, 0), pair.from);
  assert.deepEqual(morphContour(pair, 1), pair.to);
  assert.ok(morphContour(pair, .5).every(p => p.every(Number.isFinite)));
});
test('line boil is bounded, frame-order independent, and held at its drawing cadence', () => {
  const base = resampleContour(square, 64), options = { seed: 17, amount: 1.4, rate: 12 };
  const first = boilContour(base, 1.01, options);
  boilContour(base, 7.1, options);
  assert.deepEqual(first, boilContour(base, 1.01, options));
  assert.deepEqual(first, boilContour(base, 1.02, options));
  assert.notDeepEqual(first, boilContour(base, 1.1, options));
  assert.ok(first.every((p, i) => Math.hypot(p[0] - base[i]![0], p[1] - base[i]![1]) <= 1.4 + 1e-9));
  assert.deepEqual(square, [[0, 0], [100, 0], [100, 100], [0, 100]]);
});
