import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { applyCameraPose } from '../src/drawing/primitives/camera.ts';
import { springTrack } from '../src/animation/spring.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';

test('focus lands at the viewport center at several zooms, angles and aspect ratios', () => {
  for (const [width, height] of [[320, 180], [180, 320], [240, 240]]) {
    for (const zoom of [0.5, 1, 3]) for (const rotation of [0, 0.3, -1]) {
      const context = new Canvas(width!, height!).getContext('2d');
      const pose = { x: 210, y: 75, zoom, rotation };
      applyCameraPose(context, pose, width!, height!);
      const m = context.getTransform();
      // Skia exposes a float32 transform; require subpixel focus accuracy.
      assert.ok(Math.abs(m.a * pose.x + m.c * pose.y + m.e - width! / 2) < 0.001);
      assert.ok(Math.abs(m.b * pose.x + m.d * pose.y + m.f - height! / 2) < 0.001);
    }
  }
});

test('foreground displacement exceeds distant-layer displacement and screen overlays stay fixed', () => {
  const displacements = [0, 0.25, 1, 1.3].map(parallax => {
    const context = new Canvas(320, 180).getContext('2d');
    applyCameraPose(context, { x: 210, y: 90, zoom: 1 }, 320, 180, parallax);
    return context.getTransform().e;
  });
  assert.deepEqual(displacements, [0, -12.5, -50, -65]);
  const context = new Canvas(320, 180).getContext('2d');
  applyCameraPose(context, { x: 300, y: 30, zoom: 3, rotation: 0.6 }, 320, 180, 0);
  const m = context.getTransform();
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [1, 0, 0, 1, 0, 0]);
});

test('spring-driven camera renders identical pixels on reverse seek and keeps captions outside the camera', () => {
  const canvas = new Canvas(160, 90), ctx = canvas.getContext('2d');
  const render = (frame: number) => {
    ctx.clearRect(0, 0, 160, 90);
    const time = frame / 30;
    ctx.save();
    applyCameraPose(ctx, { x: springTrack(time, [[0, 80], [0.2, 110], [0.5, 55]]), y: 45, zoom: 1.5 }, 160, 90);
    ctx.fillStyle = '#ff0000'; ctx.fillRect(105, 40, 10, 10);
    ctx.restore();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(10, 78, 140, 5);
    return Buffer.from(ctx.getImageData(0, 0, 160, 90).data);
  };
  const times = [0, 6, 12, 15, 24, 60];
  const samples = times.map(render);
  for (let index = times.length - 1; index >= 0; index--) assert.deepEqual(render(times[index]!), samples[index]);
  assert.notDeepEqual(samples[0], samples[4]);
  for (const pixels of samples) assert.equal(pixels[(80 * 160 + 30) * 4], 255);
});

test('invalid camera dimensions and layer zoom fail before canvas transforms', () => {
  const context = new Canvas(160, 90).getContext('2d');
  for (const zoom of [0, -1, NaN, Infinity]) {
    assert.throws(() => applyCameraPose(context, { x: 80, y: 45, zoom }, 160, 90), /CAMERA_POSE/);
  }
  assert.throws(() => applyCameraPose(context, { x: 80, y: 45, zoom: 0.1 }, 160, 90, 2), /CAMERA_POSE/);
});

test('splitting a continuous world into two shots preserves the absolute clock and rendered geometry', () => {
  const renderers = [false, true].map(split => createSpecRenderer({
    spec: validateSpec({ video: { width: 1080, height: 1920, duration: 2, fps: 30, seed: 1 },
      captions: { enabled: false }, scenes: (split ? [[0, 1], [1, 2]] : [[0, 2]]).map(([start, end], i) =>
        ({ id: `shot${i}`, start, end, environment: 'theme_stage', cameraMove: 'static', transition: 'cut' })) }).spec!,
    width: 160, height: 90,
    drawScene: ({ ctx, time }) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 160, 90);
      ctx.save(); applyCameraPose(ctx, {
        x: springTrack(time, [[0, 80], [0.8, 120], [1.04, 60]]), y: 45, zoom: 1.25,
      }, 160, 90);
      ctx.fillStyle = '#ffc712'; ctx.fillRect(85, 25, 20, 20); ctx.restore();
      ctx.fillStyle = '#fff'; ctx.fillRect(10, 78, 140, 5);
    },
  }));
  try {
    for (const frameIndex of [24, 29, 30, 31, 32, 36, 29, 24]) {
      const frame = makeFrameContext({ frameIndex, totalFrames: 60, fps: 30, width: 160, height: 90, seed: 1 });
      const a = Buffer.from(renderers[0]!.renderFrame(frame).data), b = Buffer.from(renderers[1]!.renderFrame(frame).data);
      assert.deepEqual(a, b, `frame=${frameIndex}`);
    }
  } finally { renderers.forEach(renderer => renderer.dispose()); }
});
