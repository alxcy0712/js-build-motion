import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { colorCoverage, compareMasks } from '../src/drawing/primitives/visual-check.ts';

function image(hole = true, shift = 0) {
  const canvas = new Canvas(100, 100), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4d6bfe'; ctx.fillRect(10 + shift, 10, 80, 80);
  if (hole) ctx.clearRect(40 + shift, 40, 20, 20);
  return ctx.getImageData(0, 0, 100, 100);
}
test('mask comparison detects a lost identity hole and a shifted contour', () => {
  assert.equal(compareMasks(image(), image()).iou, 1);
  assert.equal(compareMasks(image(false), image()).extra, 400);
  assert.ok(compareMasks(image(true, 8), image()).iou < .8);
  assert.throws(() => compareMasks(image(), new Canvas(100, 100).getContext('2d').getImageData(0, 0, 100, 100)), /EMPTY/);
});
test('material probes catch filled clearances and missing material, with raster tolerance', () => {
  const pixels = image();
  assert.equal(colorCoverage(pixels, { x: 15, y: 15, width: 20, height: 20 }, [78, 106, 251]), 1);
  assert.equal(colorCoverage(pixels, { x: 40, y: 40, width: 20, height: 20 }, [77, 107, 254]), 0);
  assert.equal(colorCoverage(image(false), { x: 40, y: 40, width: 20, height: 20 }, [77, 107, 254]), 1);
  assert.throws(() => colorCoverage(pixels, { x: -1, y: 0, width: 5, height: 5 }, [0, 0, 0]), /REGION/);
});
