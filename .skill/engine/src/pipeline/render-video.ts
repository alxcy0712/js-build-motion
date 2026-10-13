/**
 * 视频渲染编排（需求 §3、§23、§43）。
 *
 * 数据流：
 *   for frameIndex in 0..totalFrames-1:
 *       ctx = makeFrameContext(frameIndex, ...)
 *       buf = renderer.renderFrame(ctx)          // 纯函数
 *       await encoder.writeFrame(buf.data)       // 一次性 rawvideo 管道
 *   await encoder.finish()                       // 等待 ffmpeg 收尾
 *
 * 刻意不做的事：
 *   - 不把帧写到磁盘（没有中间文件，没有清理逻辑）
 *   - 不在这里做并行（§31：先保证正确性与确定性，再谈多进程）
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { VideoEncoder, type VideoEncoderOptions } from '../ffmpeg/encoder.ts';
import { makeFrameContext, type Renderer } from '../renderer/renderer.ts';
import { frameCount } from '../timeline/frame.ts';

export interface RenderVideoOptions {
  readonly renderer: Renderer;
  readonly fps: number;
  /** 二选一：总帧数，或时长（秒） */
  readonly totalFrames?: number;
  readonly durationSeconds?: number;
  readonly seed: number;
  readonly outPath: string;
  readonly audioPath?: string;
  readonly video?: VideoEncoderOptions['video'];
  readonly audio?: VideoEncoderOptions['audio'];
  /** 每渲染完这么多帧回调一次进度 */
  readonly onProgress?: (done: number, total: number) => void;
  /** 进度回调间隔；默认自动取「约 12 次回调」的粒度，避免逐帧刷日志（§43） */
  readonly progressEvery?: number;
  readonly verbose?: boolean;
}

export interface RenderVideoResult {
  readonly outPath: string;
  readonly frames: number;
  readonly totalMs: number;
  readonly msPerFrame: number;
  readonly encodeTailMs: number;
}

export async function renderVideo(options: RenderVideoOptions): Promise<RenderVideoResult> {
  const { renderer, fps, seed, outPath } = options;

  const total = resolveTotalFrames(options, fps);

  mkdirSync(dirname(outPath), { recursive: true });

  const encoder = new VideoEncoder({
    width: renderer.width,
    height: renderer.height,
    fps,
    outPath,
    ...(options.video ? { video: options.video } : {}),
    ...(options.audioPath ? { audioPath: options.audioPath } : {}),
    ...(options.audio ? { audio: options.audio } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });

  const progressEvery = options.progressEvery ?? Math.max(1, Math.floor(total / 12));
  const startedAt = Date.now();

  encoder.start();
  try {
    for (let frameIndex = 0; frameIndex < total; frameIndex++) {
      const rc = makeFrameContext({
        frameIndex,
        totalFrames: total,
        fps,
        width: renderer.width,
        height: renderer.height,
        seed,
      });
      const frame = renderer.renderFrame(rc);
      await encoder.writeFrame(frame.data);

      const done = frameIndex + 1;
      if (done % progressEvery === 0 || done === total) {
        options.onProgress?.(done, total);
      }
    }
  } catch (err) {
    // 渲染中途失败必须杀掉 ffmpeg，否则子进程会悬挂在 stdin 上
    encoder.abort();
    if (err instanceof EngineError) throw err;
    throw new EngineError(ERROR_CODES.RENDER_FAILED, '渲染过程中出现未预期错误', {
      details: { stderr: encoder.stderrTail() },
      cause: err,
    });
  }

  const encodeStartedAt = Date.now();
  const result = await encoder.finish();
  const encodeTailMs = Date.now() - encodeStartedAt;
  const totalMs = Date.now() - startedAt;

  if (result.framesWritten !== total) {
    throw new EngineError(ERROR_CODES.RENDER_FAILED, '写入帧数与预期不符', {
      details: { expected: total, written: result.framesWritten },
    });
  }

  return {
    outPath,
    frames: total,
    totalMs,
    msPerFrame: total > 0 ? totalMs / total : 0,
    encodeTailMs,
  };
}

function resolveTotalFrames(options: RenderVideoOptions, fps: number): number {
  const { totalFrames, durationSeconds } = options;
  if (totalFrames === undefined && durationSeconds === undefined) {
    throw new EngineError(ERROR_CODES.RENDER_FAILED, '必须提供 totalFrames 或 durationSeconds 之一');
  }
  if (totalFrames !== undefined && durationSeconds !== undefined) {
    const derived = frameCount(fps, durationSeconds);
    if (derived !== totalFrames) {
      throw new EngineError(ERROR_CODES.RENDER_FAILED, 'totalFrames 与 durationSeconds 不一致', {
        details: { totalFrames, durationSeconds, fps, derived },
        hint: '只提供一个，或让两者严格一致（durationSeconds * fps === totalFrames）',
      });
    }
  }
  const total = totalFrames ?? frameCount(fps, durationSeconds as number);
  if (total <= 0) {
    throw new EngineError(ERROR_CODES.RENDER_FAILED, `总帧数必须为正，收到 ${total}`, {
      details: { fps, totalFrames, durationSeconds: options.durationSeconds },
    });
  }
  return total;
}
