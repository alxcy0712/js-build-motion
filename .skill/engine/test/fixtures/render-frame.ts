#!/usr/bin/env node
/**
 * 单帧渲染夹具 —— 供「跨进程确定性」测试调用。
 *
 * 用法:
 *   node test/fixtures/render-frame.ts <seed> <frameIndex> <totalFrames> [layer]
 *
 * 输出: 一行 JSON { sha256, width, height, bytes }
 *
 * 这个夹具是「同输入同输出」这一承诺的可执行证据：
 * 它是独立进程、独立渲染器实例，且只渲染目标帧——
 * 如果渲染依赖任何前置帧或全局状态，两次调用的哈希就会不同。
 */

import { createHash } from 'node:crypto';

import { makeFrameContext } from '../../src/renderer/renderer.ts';
import { SkiaRenderer } from '../../src/renderer/skia/skia-renderer.ts';
import {
  CANONICAL_HEIGHT,
  CANONICAL_WIDTH,
  drawCanonicalBackdrop,
  drawCanonicalScene,
} from './canonical-scene.ts';

const seed = Number(process.argv[2] ?? 12345);
const frameIndex = Number(process.argv[3] ?? 0);
const totalFrames = Number(process.argv[4] ?? 48);
const layer = process.argv[5] ?? 'full';

if (!Number.isFinite(seed) || !Number.isFinite(frameIndex) || !Number.isFinite(totalFrames)) {
  process.stderr.write('seed / frameIndex / totalFrames 必须是数字\n');
  process.exit(2);
}

const renderer = new SkiaRenderer({
  width: CANONICAL_WIDTH,
  height: CANONICAL_HEIGHT,
  draw: layer === 'backdrop' ? drawCanonicalBackdrop : drawCanonicalScene,
});

const rc = makeFrameContext({
  frameIndex,
  totalFrames,
  fps: 24,
  width: CANONICAL_WIDTH,
  height: CANONICAL_HEIGHT,
  seed,
});

const frame = renderer.renderFrame(rc);
const sha256 = createHash('sha256').update(frame.data).digest('hex');

process.stdout.write(
  JSON.stringify({ sha256, width: frame.width, height: frame.height, bytes: frame.data.length }) + '\n',
);

renderer.dispose();
