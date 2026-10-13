import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { fitImage, type ImageRect } from '../src/drawing/primitives/image-fit.ts';

const crop = { x: 498.2, y: 192.92, width: 498.2, height: 593.6 };
const target = { x: 20, y: 30, width: 761, height: 969 };

test('contain and cover preserve uniform scale for unequal source and target aspects', () => {
  for (const mode of ['contain', 'cover'] as const) {
    const { source: s, destination: d } = fitImage(crop, target, mode);
    assert.ok(Math.abs(d.width / s.width - d.height / s.height) < 1e-12);
    assert.ok(s.x >= crop.x && s.y >= crop.y);
    assert.ok(s.x + s.width <= crop.x + crop.width + 1e-9);
    assert.ok(s.y + s.height <= crop.y + crop.height + 1e-9);
    assert.ok(d.x >= target.x && d.y >= target.y);
    assert.ok(d.x + d.width <= target.x + target.width + 1e-9);
    assert.ok(d.y + d.height <= target.y + target.height + 1e-9);
    if (mode === 'contain') assert.deepEqual(s, crop);
    else assert.deepEqual(d, target);
  }
});

test('equal aspect uses the complete source and destination without changing inputs', () => {
  const source = { x: 7, y: 9, width: 80, height: 40 }, destination = { x: 4, y: 5, width: 160, height: 80 };
  assert.deepEqual(fitImage(source, destination, 'cover'), { source, destination });
  assert.deepEqual(fitImage(source, destination, 'contain'), { source, destination });
});

test('invalid crop dimensions and unknown fit modes fail before drawing', () => {
  for (const width of [0, -1, NaN, Infinity]) assert.throws(() => fitImage({ ...crop, width }, target, 'contain'), /INVALID_RECT/);
  assert.throws(() => fitImage(crop, target, 'stretch' as 'contain'), /INVALID_MODE/);
});

test('an independent circle stays round in raster output while stretched control becomes oval', () => {
  const input = new Canvas(100, 100), ctx = input.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(50, 50, 24, 0, Math.PI * 2); ctx.fill();
  const source = { x: 0, y: 0, width: 100, height: 100 }, destination = { x: 0, y: 0, width: 150, height: 200 };
  const bounds = (s: ImageRect, d: ImageRect) => {
    const canvas = new Canvas(150, 200), context = canvas.getContext('2d');
    context.drawImage(input, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
    const pixels = context.getImageData(0, 0, 150, 200).data;
    let minX = 150, minY = 200, maxX = -1, maxY = -1;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 150; x++) if (pixels[(y * 150 + x) * 4 + 3]! > 128) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1 };
  };
  for (const mode of ['contain', 'cover'] as const) {
    const fitted = fitImage(source, destination, mode), measured = bounds(fitted.source, fitted.destination);
    assert.ok(Math.abs(measured.width - measured.height) <= 1, mode);
  }
  const stretched = bounds(source, destination);
  assert.ok(stretched.height / stretched.width > 1.25);
});
