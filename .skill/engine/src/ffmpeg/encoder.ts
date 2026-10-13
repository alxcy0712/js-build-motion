/**
 * FFmpeg 编码器：把逐帧 RGBA 通过 **一次性管道** 送进 FFmpeg。
 *
 * 这是项目最关键的性能决策（需求 §3、§23）：
 *
 *   renderFrame → RGBA Buffer → ffmpeg stdin        ✅ 默认路径
 *   renderFrame → frame001.png → 磁盘 → ffmpeg      ❌ 禁止（PNG 编码 ~133ms/帧）
 *
 * PNG 序列路径不只是慢，还引入了「中间文件残留 / 磁盘占满 / 清理逻辑」三类额外故障面。
 * 调试用的单帧 PNG 导出走 CLI 的 `frame` 子命令，与正式管线完全分离。
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { assertEvenDimensions } from '../renderer/renderer.ts';
import { assertEncoderAvailable, type VideoEncoderId } from './capabilities.ts';

export interface VideoEncoderOptions {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly outPath: string;

  readonly video?: {
    /** 默认 libx264（兼容性优先，§22） */
    readonly codec?: VideoEncoderId;
    readonly crf?: number;
    readonly preset?: string;
    readonly pixelFormat?: string;
    /** 供硬件编码器或定码率场景使用；设置后会替代 crf */
    readonly bitrate?: string;
    /** moov 前置，便于网页边下边播 */
    readonly faststart?: boolean;
  };

  /** 若提供，则把该音频文件混入输出 */
  readonly audioPath?: string;
  readonly audio?: {
    readonly codec?: string;
    readonly bitrate?: string;
  };

  /** true 时把 ffmpeg 的 warning 级别日志也打出来 */
  readonly verbose?: boolean;
}

export interface EncodeResult {
  readonly outPath: string;
  readonly framesWritten: number;
  readonly elapsedMs: number;
  /** ffmpeg stderr 的尾部若干行，出错时用于诊断 */
  readonly stderrTail: readonly string[];
}

/** 保留的 stderr 行数上限——避免长时间渲染把内存吃满 */
const STDERR_TAIL_LIMIT = 40;

export class VideoEncoder {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly outPath: string;

  private readonly options: VideoEncoderOptions;
  /** stdio 为 ['pipe','ignore','pipe']，因此 stdout 为 null */
  private proc: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private stderrLines: string[] = [];
  private stderrPartial = '';
  private framesWritten = 0;
  private startedAt = 0;
  private finished = false;
  private exitError: Error | null = null;
  private exitPromise: Promise<void> | null = null;
  /** 首个写入错误。一旦出现就停止继续喂帧，避免把 ENOSPC 之类的错误刷屏 */
  private writeError: Error | null = null;

  constructor(options: VideoEncoderOptions) {
    this.options = options;
    this.width = options.width;
    this.height = options.height;
    this.fps = options.fps;
    this.outPath = options.outPath;
    assertEvenDimensions(options.width, options.height);
  }

  /** 组装 ffmpeg 参数。抽成独立方法便于测试直接断言参数形态。 */
  buildArgs(): string[] {
    const o = this.options;
    const v = o.video ?? {};
    const a = o.audio ?? {};
    const codec = v.codec ?? 'libx264';

    const args: string[] = [
      '-hide_banner',
      '-loglevel', o.verbose ? 'warning' : 'error',
      '-y',
      // ---- 输入 0：raw RGBA 逐帧管道 ----
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${o.width}x${o.height}`,
      '-r', String(o.fps),
      '-i', 'pipe:0',
    ];

    if (o.audioPath) {
      args.push('-i', o.audioPath);
    }

    // ---- 视频编码 ----
    args.push('-c:v', codec);
    if (v.bitrate) {
      args.push('-b:v', v.bitrate);
    } else {
      args.push('-crf', String(v.crf ?? 20));
    }
    if (codec === 'libx264' || codec === 'libx265') {
      args.push('-preset', v.preset ?? 'medium');
    }
    args.push('-pix_fmt', v.pixelFormat ?? 'yuv420p');

    // ---- 音频编码 ----
    if (o.audioPath) {
      args.push('-c:a', a.codec ?? 'aac', '-b:a', a.bitrate ?? '192k', '-shortest');
    }

    if (v.faststart !== false) args.push('-movflags', '+faststart');

    args.push(this.outPath);
    return args;
  }

  /** 启动 ffmpeg 子进程 */
  start(): void {
    if (this.proc) throw new Error('VideoEncoder 已启动');
    const codec = this.options.video?.codec ?? 'libx264';
    assertEncoderAvailable(codec);

    this.startedAt = Date.now();
    // 用局部常量，避免可变的 this.proc 让 TS 的类型收窄失效
    const proc = spawn('ffmpeg', this.buildArgs(), {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.proc = proc;

    proc.on('error', (err) => {
      this.exitError = new EngineError(ERROR_CODES.FFMPEG_NOT_FOUND, '无法启动 ffmpeg', {
        cause: err,
        hint: '确认 ffmpeg 已安装且在 PATH 中',
      });
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.collectStderr(chunk));

    this.exitPromise = new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
    });
  }

  private collectStderr(chunk: string): void {
    this.stderrPartial += chunk;
    const lines = this.stderrPartial.split('\n');
    this.stderrPartial = lines.pop() ?? '';
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      this.stderrLines.push(t);
      if (this.stderrLines.length > STDERR_TAIL_LIMIT) this.stderrLines.shift();
    }
  }

  /**
   * 写入一帧。必须按帧序调用。
   * 处理背压：1080p RGBA 单帧 8.3MB，不做背压会把 Node 内存打爆。
   */
  async writeFrame(rgba: Buffer): Promise<void> {
    if (this.writeError) throw this.writeError;
    if (this.finished) throw new Error('VideoEncoder 已结束，不能再写入');
    if (!this.proc) throw new Error('VideoEncoder 尚未 start()');

    const expected = this.width * this.height * 4;
    if (rgba.length !== expected) {
      const err = new EngineError(ERROR_CODES.RENDER_FAILED, '帧数据长度不正确', {
        details: { expected, actual: rgba.length, width: this.width, height: this.height },
        hint: '渲染器必须输出 width*height*4 字节的 RGBA 数据',
      });
      this.writeError = err;
      throw err;
    }

    try {
      if (!this.proc.stdin.write(rgba)) {
        await once(this.proc.stdin, 'drain');
      }
    } catch (err) {
      // 典型场景：ffmpeg 提前退出（编码器参数不合法）导致 EPIPE
      const e = new EngineError(ERROR_CODES.RENDER_FAILED, '向 ffmpeg 管道写入帧失败', {
        details: { frameIndex: this.framesWritten, stderr: this.stderrTail() },
        cause: err,
      });
      this.writeError = e;
      throw e;
    }
    this.framesWritten++;
  }

  /** 关闭管道并等待 ffmpeg 收尾 */
  async finish(): Promise<EncodeResult> {
    if (this.finished) throw new Error('VideoEncoder 已结束');
    if (!this.proc) throw new Error('VideoEncoder 尚未 start()');
    this.finished = true;

    this.proc.stdin.end();
    await this.exitPromise;

    if (this.exitError) throw this.exitError;

    const code = this.proc.exitCode;
    if (code !== 0) {
      throw new EngineError(ERROR_CODES.RENDER_FAILED, `ffmpeg 退出码 ${code}`, {
        details: {
          framesWritten: this.framesWritten,
          args: this.proc.spawnargs.slice(1),
          stderr: this.stderrTail(),
        },
        hint: '查看 stderr 尾部定位编码参数问题',
      });
    }

    return {
      outPath: this.outPath,
      framesWritten: this.framesWritten,
      elapsedMs: Date.now() - this.startedAt,
      stderrTail: this.stderrTail(),
    };
  }

  /** 出错时强制终止，避免子进程悬挂 */
  abort(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.stdin.destroy();
      this.proc.kill('SIGKILL');
    }
    this.finished = true;
  }

  stderrTail(): readonly string[] {
    const tail = [...this.stderrLines];
    if (this.stderrPartial.trim()) tail.push(this.stderrPartial.trim());
    return tail;
  }
}

// ---------------------------------------------------------------- ffprobe

export interface MediaInfo {
  readonly video: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly frameCount: number | null;
    readonly pixelFormat: string | null;
  } | null;
  readonly audio: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channels: number;
  } | null;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
}

/** 用 ffprobe 读取真实产物信息——验收必须基于文件本身，而不是渲染时的意图 */
export function probeMedia(path: string): MediaInfo {
  const r = spawnSyncProbe([
    '-v', 'error',
    '-show_entries', 'format=duration,size',
    '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,sample_rate,channels,pix_fmt',
    '-of', 'json',
    path,
  ]);

  const raw = JSON.parse(r) as {
    format?: { duration?: string; size?: string };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s['codec_type'] === 'video');
  const a = streams.find((s) => s['codec_type'] === 'audio');

  return {
    video: v
      ? {
          codec: String(v['codec_name']),
          width: Number(v['width']),
          height: Number(v['height']),
          fps: parseRational(String(v['r_frame_rate'])),
          frameCount: v['nb_frames'] ? Number(v['nb_frames']) : null,
          pixelFormat: v['pix_fmt'] ? String(v['pix_fmt']) : null,
        }
      : null,
    audio: a
      ? {
          codec: String(a['codec_name']),
          sampleRate: Number(a['sample_rate']),
          channels: Number(a['channels']),
        }
      : null,
    durationSeconds: Number(raw.format?.duration ?? 0),
    sizeBytes: Number(raw.format?.size ?? 0),
  };
}

function spawnSyncProbe(args: string[]): string {
  const r = spawnSync('ffprobe', args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new EngineError(ERROR_CODES.FFPROBE_NOT_FOUND, 'ffprobe 执行失败', {
      details: { args, stderr: (r.stderr ?? '').trim() },
      cause: r.error,
    });
  }
  return r.stdout ?? '';
}

/** "24/1" → 24; "30000/1001" → 29.97002997... */
function parseRational(s: string): number {
  const [n, d] = s.split('/');
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/** 全片解码校验：返回 null 表示无错误 */
export function verifyDecodable(path: string): string | null {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  const err = (r.stderr ?? '').trim();
  return err.length > 0 ? err : null;
}
