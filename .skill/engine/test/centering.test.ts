import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { isCentered, measureContentCenter, withinSafeArea } from '../src/qa/centering.ts';
import { applyCameraPose } from '../src/drawing/primitives/camera.ts';
import { THEMES } from '../src/themes/index.ts';

const theme = THEMES.minimal;
const SIZES = { vertical: [1080, 1920], horizontal: [1920, 1080] } as const;

/** 一帧典型画面：标题 + 强调点 + 颗粒噪声，主体围绕 (focusX, focusY)，相机按 zoom 绕画布中心推镜。 */
function renderFrame(width: number, height: number, { focusX = width / 2, focusY = height * 0.45, zoom = 1 } = {}) {
  const canvas = new Canvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = theme.palette.bg; ctx.fillRect(0, 0, width, height);
  ctx.save();
  applyCameraPose(ctx, { x: width / 2, y: height / 2, zoom }, width, height);
  ctx.fillStyle = theme.palette.accent; ctx.beginPath(); ctx.arc(focusX, focusY - 160, 24, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = theme.palette.text; ctx.fillRect(focusX - 300, focusY - 60, 600, 120); // 标题块
  ctx.restore();
  ctx.globalAlpha = 0.03; ctx.fillStyle = '#ffffff'; // 颗粒级噪声不应影响测量
  for (let i = 0; i < 4000; i++) ctx.fillRect((i * 7919) % width, (i * 104729) % height, 1, 1);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

for (const [name, [w, h]] of Object.entries(SIZES)) {
  test(`${name} ${w}x${h}: 居中主体在推镜前后都判为居中`, () => {
    for (const zoom of [1, 1.15]) {
      const m = measureContentCenter(renderFrame(w, h, { zoom }));
      assert.ok(m, 'should find content');
      assert.ok(isCentered(m, { toleranceX: 0.02 }), `offsetX ${m.offsetX}`);
      const safe = name === 'vertical' ? theme.safeArea.vertical : theme.safeArea.horizontal;
      assert.ok(withinSafeArea(m, w, h, safe), JSON.stringify(m.bbox));
    }
  });
  test(`${name} ${w}x${h}: 偏左上的主体被识别为不居中`, () => {
    const m = measureContentCenter(renderFrame(w, h, { focusX: w * 0.4, focusY: h * 0.35 }));
    assert.ok(m && m.offsetX < -0.05 && m.offsetY < 0);
    assert.equal(isCentered(m), false);
  });
}

test('exclude 排除角落署名；空画面返回 null；尺寸不符报错', () => {
  const frame = renderFrame(1080, 1920);
  const data = Uint8ClampedArray.from(frame.data);
  for (let y = 1380; y < 1400; y++) for (let x = 700; x < 900; x++) data.fill(255, (y * 1080 + x) * 4, (y * 1080 + x) * 4 + 4);
  const noisy = measureContentCenter({ ...frame, data });
  const clean = measureContentCenter({ ...frame, data }, { exclude: [{ x: 680, y: 1360, width: 240, height: 60 }] });
  assert.ok(noisy && clean && clean.bbox.height < noisy.bbox.height);
  assert.ok(isCentered(clean));
  assert.equal(measureContentCenter({ width: 4, height: 4, data: new Uint8Array(16) }), null);
  assert.throws(() => measureContentCenter({ width: 4, height: 4, data: new Uint8Array(5) }), /CENTERING_FRAME_SIZE/);
});

test('浅色底：按与背景的反差测量', () => {
  const data = new Uint8Array(100 * 100).fill(240);
  for (let y = 40; y < 60; y++) for (let x = 45; x < 55; x++) data[y * 100 + x] = 30;
  const m = measureContentCenter({ width: 100, height: 100, data }, { background: 'light' });
  assert.deepEqual(m?.bbox, { x: 45, y: 40, width: 10, height: 20 });
  assert.ok(isCentered(m, { toleranceX: 0.001, toleranceY: 0.001 }));
});
