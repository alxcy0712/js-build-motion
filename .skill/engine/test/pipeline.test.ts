/**
 * 最小管线冒烟测试（Phase B）。
 *
 * 这个测试的目的不是「跑通代码」，而是证明四件事：
 *   1. 真的产出了可播放的 MP4（用 ffprobe 读文件本身，而不是相信渲染时的意图）
 *   2. 全片可解码，无错误
 *   3. 编码路径确实是 rawvideo 管道
 *   4. 过程中没有产生任何 PNG 中间文件
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { probeMedia, verifyDecodable, VideoEncoder } from '../src/ffmpeg/encoder.ts';
import { renderVideo } from '../src/pipeline/render-video.ts';
import { SkiaRenderer } from '../src/renderer/skia/skia-renderer.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { frameCount, normalizedProgress } from '../src/timeline/frame.ts';

// 测试产物落 .research/out/（AGENTS.md 硬性规则 1），不污染 out/ 与 projects/*/out/
const OUT_DIR = join(PROJECT_ROOT, '.research', 'out', 'pipeline-tests');
mkdirSync(OUT_DIR, { recursive: true });
const SMOKE_WIDTH = 540;
const SMOKE_HEIGHT = 960;
const SMOKE_FPS = 24;
const SMOKE_SECONDS = 2;
const SMOKE_FRAMES = frameCount(SMOKE_FPS, SMOKE_SECONDS);

/** 简单但真实的绘制：渐变 + 图形 + 文字，确保矢量与文本都经过管道 */
function drawSmokeFrame(ctx: import('skia-canvas').CanvasRenderingContext2D, rc: import('../src/renderer/renderer.ts').FrameContext): void {
  const { width: w, height: h } = rc;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#1d2b64');
  sky.addColorStop(1, '#f7b267');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 一个随时间移动的圆——用于肉眼确认动画确实在动
  const p = normalizedProgress(rc.frameIndex, rc.totalFrames);
  ctx.fillStyle = '#ffd666';
  ctx.beginPath();
  ctx.arc(w * (0.2 + 0.6 * p), h * 0.5, 60, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 40px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(`frame ${rc.frameIndex}`, 40, h - 80);
}

test('最小管线产出可解码的 MP4，且不产生 PNG 中间文件', async () => {
  const outPath = join(OUT_DIR, 'pipeline-smoke.mp4');
  if (existsSync(outPath)) rmSync(outPath);

  const renderer = new SkiaRenderer({ width: SMOKE_WIDTH, height: SMOKE_HEIGHT, draw: drawSmokeFrame });

  const result = await renderVideo({
    renderer,
    fps: SMOKE_FPS,
    durationSeconds: SMOKE_SECONDS,
    seed: 12345,
    outPath,
    video: { codec: 'libx264', crf: 28, preset: 'ultrafast' },
  });

  assert.equal(result.frames, SMOKE_FRAMES, `应渲染 ${SMOKE_FRAMES} 帧`);
  assert.ok(existsSync(outPath), '输出文件应存在');

  // --- 1. 用 ffprobe 校验真实产物 ---
  const info = probeMedia(outPath);
  assert.ok(info.video, '产物应含视频流');
  assert.equal(info.video.width, SMOKE_WIDTH);
  assert.equal(info.video.height, SMOKE_HEIGHT);
  assert.equal(info.video.codec, 'h264');
  assert.ok(Math.abs(info.video.fps - SMOKE_FPS) < 0.01, `fps 应约等于 ${SMOKE_FPS}，实际 ${info.video.fps}`);
  assert.ok(info.video.frameCount === null || info.video.frameCount === SMOKE_FRAMES);
  assert.ok(
    Math.abs(info.durationSeconds - SMOKE_SECONDS) < 0.15,
    `时长应约等于 ${SMOKE_SECONDS}s，实际 ${info.durationSeconds}`,
  );

  // --- 2. 全片可解码 ---
  const decodeError = verifyDecodable(outPath);
  assert.equal(decodeError, null, `解码不应有错误: ${decodeError}`);

  // --- 3. 没有 PNG 中间产物 ---
  const pngs = readdirSync(OUT_DIR).filter((f) => f.toLowerCase().endsWith('.png') && f.startsWith('pipeline-smoke'));
  assert.deepEqual(pngs, [], `不应产生 PNG 中间文件，发现: ${pngs.join(', ')}`);

  renderer.dispose();
});

test('编码器参数使用 rawvideo 管道，且不含任何图片序列格式', () => {
  const enc = new VideoEncoder({
    width: 1080,
    height: 1920,
    fps: 24,
    outPath: join(OUT_DIR, 'args-check.mp4'),
  });
  const args = enc.buildArgs();
  const joined = args.join(' ');

  // 必须是 raw RGBA 管道
  assert.ok(joined.includes('-f rawvideo'), '应使用 rawvideo 输入');
  assert.ok(joined.includes('-pix_fmt rgba'), '应使用 rgba 像素格式');
  assert.ok(joined.includes('-s 1080x1920'), '应携带正确尺寸');
  assert.ok(joined.includes('-i pipe:0'), '应从 stdin 读取');

  // 兼容性默认值
  assert.ok(joined.includes('-c:v libx264'), '默认应为 libx264');
  assert.ok(joined.includes('-pix_fmt yuv420p'), '输出应为 yuv420p');
  assert.ok(joined.includes('-c:a aac') === false, '无音频时不应出现音频参数');

  // 绝不能出现图片序列输入格式
  for (const forbidden of ['image2', 'image2pipe', 'png', 'mjpeg', '%04d']) {
    assert.ok(!joined.includes(forbidden), `参数不应包含 ${forbidden}: ${joined}`);
  }
});

test('非偶数尺寸在构造编码器时立即失败', () => {
  assert.throws(
    () => new VideoEncoder({ width: 1081, height: 1920, fps: 24, outPath: '/dev/null' }),
    /宽高为偶数/,
  );
});

test('帧数据长度不符时 writeFrame 报出期望与实际', async () => {
  const enc = new VideoEncoder({
    width: 64,
    height: 64,
    fps: 24,
    outPath: join(OUT_DIR, 'badframe.mp4'),
  });
  enc.start();
  try {
    await assert.rejects(
      () => enc.writeFrame(Buffer.alloc(10)),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /帧数据长度不正确/);
        return true;
      },
    );
  } finally {
    enc.abort();
  }
});

test('totalFrames 与 durationSeconds 不一致时报错', async () => {
  const renderer = new SkiaRenderer({ width: 64, height: 64, draw: () => {} });
  await assert.rejects(
    () =>
      renderVideo({
        renderer,
        fps: 24,
        totalFrames: 48,
        durationSeconds: 5, // 5*24 = 120 ≠ 48
        seed: 1,
        outPath: join(OUT_DIR, 'inconsistent.mp4'),
      }),
    /不一致/,
  );
});
