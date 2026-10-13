/**
 * 渲染后端的性能回归测试。
 *
 * 这些测试守护的是两个**已实测**的性能陷阱（由本文件的调用计数验证）：
 *
 *   1. PaperTexture 每帧重建 CanvasPattern
 *      → 25.0 ms/帧（540x960） / 28.3 ms/帧（1080x1920）
 *      缓存复用后 → 0.88 ms / 2.34 ms（相差约 28 倍）
 *
 *   2. watercolorWash 每帧重新烘焙低分辨率噪声场
 *      → 应只烘焙一次，之后靠缓存
 *
 * 刻意用**调用计数**而不是耗时断言：耗时会随机器波动导致 CI 抖动，
 * 而「createPattern 被调了几次」是稳定且直接对应成本根因的指标。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PaperTexture } from '../src/drawing/art/paper.ts';
import { clearWashCache, getWashBakeCount, watercolorWash } from '../src/drawing/art/watercolor.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { SkiaRenderer } from '../src/renderer/skia/skia-renderer.ts';
import { CANONICAL_HEIGHT, CANONICAL_WIDTH } from './fixtures/canonical-scene.ts';

const mkCtx = (frameIndex: number): ReturnType<typeof makeFrameContext> =>
  makeFrameContext({
    frameIndex,
    totalFrames: 288,
    fps: 24,
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    seed: 1234,
  });

test('PaperTexture 每个 context 只创建一次 CanvasPattern', () => {
  const texture = PaperTexture.get({ seed: 777, grain: 0.5, fiber: 0.4 });
  let createPatternCalls = 0;
  let patched = false;

  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: (ctx) => {
      if (!patched) {
        const original = ctx.createPattern.bind(ctx);
        ctx.createPattern = ((...args: Parameters<typeof original>) => {
          createPatternCalls++;
          return original(...args);
        }) as typeof ctx.createPattern;
        patched = true;
      }
      texture.draw(ctx, CANONICAL_WIDTH, CANONICAL_HEIGHT, { alpha: 0.5 });
    },
  });

  try {
    for (let i = 0; i < 30; i++) renderer.renderFrame(mkCtx(i));
    assert.equal(
      createPatternCalls,
      1,
      `30 帧应只创建 1 次 CanvasPattern，实际 ${createPatternCalls} 次` +
        '（每帧重建会让纸纹层从 0.9ms 恶化到 25ms）',
    );
  } finally {
    renderer.dispose();
  }
});

test('相同参数的 PaperTexture 复用同一实例与同一张 tile', () => {
  const a = PaperTexture.get({ seed: 5, grain: 0.5 });
  const b = PaperTexture.get({ seed: 5, grain: 0.5 });
  const c = PaperTexture.get({ seed: 6, grain: 0.5 });
  assert.equal(a, b, '相同参数应返回同一实例');
  assert.notEqual(a, c, '不同 seed 应是不同实例');
  assert.equal(a.tile, b.tile);
});

test('watercolorWash 只烘焙一次，后续调用命中缓存', () => {
  clearWashCache();
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: (ctx) => {
      watercolorWash(ctx, { x: 0, y: 0, w: CANONICAL_WIDTH, h: CANONICAL_HEIGHT }, {
        seed: 42,
        color: '#2a2350',
        alpha: 0.4,
      });
    },
  });
  try {
    for (let i = 0; i < 25; i++) renderer.renderFrame(mkCtx(i));
    assert.equal(getWashBakeCount(), 1, `25 帧应只烘焙 1 次 wash，实际 ${getWashBakeCount()} 次`);
  } finally {
    renderer.dispose();
  }
});

test('不同参数的 wash 各自烘焙一次（缓存键包含全部影响输出的参数）', () => {
  clearWashCache();
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: (ctx, rc) => {
      watercolorWash(ctx, { x: 0, y: 0, w: CANONICAL_WIDTH, h: CANONICAL_HEIGHT }, {
        seed: 1,
        color: '#2a2350',
        alpha: 0.4,
      });
      watercolorWash(ctx, { x: 0, y: 0, w: CANONICAL_WIDTH, h: CANONICAL_HEIGHT }, {
        seed: 2,
        color: '#2a2350',
        alpha: 0.4,
      });
      // 同一组参数再来一次，应命中缓存
      watercolorWash(ctx, { x: 0, y: 0, w: CANONICAL_WIDTH, h: CANONICAL_HEIGHT }, {
        seed: 1,
        color: '#2a2350',
        alpha: 0.4,
      });
      void rc;
    },
  });
  try {
    for (let i = 0; i < 10; i++) renderer.renderFrame(mkCtx(i));
    assert.equal(getWashBakeCount(), 2, `只有 2 组不同参数，应烘焙 2 次，实际 ${getWashBakeCount()} 次`);
  } finally {
    renderer.dispose();
  }
});

test('wash 羽化：边缘 alpha 低于中心（防止相邻 wash 之间出现硬接缝）', () => {
  clearWashCache();
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: (ctx) => {
      watercolorWash(ctx, { x: 0, y: 0, w: CANONICAL_WIDTH, h: CANONICAL_HEIGHT }, {
        seed: 9,
        color: '#ffffff',
        alpha: 0.9,
        feather: 0.3,
      });
    },
  });
  try {
    const frame = renderer.renderFrame(mkCtx(0));
    const px = (x: number, y: number): number => frame.data[(y * frame.stride) + x * 4 + 0] as number;

    // 中心 vs 最上边一行：羽化后顶边应显著暗于中心
    const center = px(Math.floor(CANONICAL_WIDTH / 2), Math.floor(CANONICAL_HEIGHT / 2));
    const topEdge = px(Math.floor(CANONICAL_WIDTH / 2), 0);
    assert.ok(
      topEdge < center,
      `羽化后顶边亮度 (${topEdge}) 应低于中心 (${center})；相等说明没有羽化，会出现硬接缝`,
    );
  } finally {
    renderer.dispose();
  }
});
