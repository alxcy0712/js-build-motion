/**
 * FFmpeg 能力探测（需求 §22、§47）。
 *
 * 原则：**默认走兼容性最好的软件编码**，硬件加速只作为「检测到之后可选」的加速项。
 * 不把 VideoToolbox / NVENC / QSV 写成默认值——那会让产物在别的机器上不可复现。
 */

import { spawnSync } from 'node:child_process';

export type VideoEncoderId =
  | 'libx264'
  | 'libx265'
  | 'h264_videotoolbox'
  | 'hevc_videotoolbox';

export interface VideoEncoderInfo {
  readonly id: VideoEncoderId;
  readonly available: boolean;
  readonly kind: 'software' | 'hardware';
  readonly note: string;
}

/** M0 默认视频编码器：兼容性优先（§22） */
export const DEFAULT_VIDEO_ENCODER: VideoEncoderId = 'libx264';

const VIDEO_ENCODER_META: ReadonlyArray<Omit<VideoEncoderInfo, 'available'>> = [
  { id: 'libx264', kind: 'software', note: 'H.264 软件编码，兼容性最好，M0 默认' },
  { id: 'libx265', kind: 'software', note: 'H.265 软件编码，体积更小但更慢' },
  { id: 'h264_videotoolbox', kind: 'hardware', note: 'macOS 硬件 H.264，需显式指定' },
  { id: 'hevc_videotoolbox', kind: 'hardware', note: 'macOS 硬件 H.265，需显式指定' },
];

/** M0 音频混音所需滤镜（§20） */
export const REQUIRED_AUDIO_FILTERS = [
  'sidechaincompress',
  'amix',
  'afade',
  'adelay',
  'aresample',
  'loudnorm',
  'volume',
  'apad',
  'atrim',
  'asplit',
  'amerge',
  'dynaudnorm',
] as const;

/** 解析 `ffmpeg -encoders` 的真实输出（不硬编码假设） */
function listEncoders(): Set<string> {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return new Set();
  const out = new Set<string>();
  for (const line of (r.stdout ?? '').split('\n')) {
    // 形如: " V....D libx264   libx264 H.264 / AVC ..."
    const m = line.match(/^\s*[A-Z.]{6}\s+(\S+)\s/);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/** 解析 `ffmpeg -filters` 的真实输出 */
function listFilters(): Set<string> {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return new Set();
  const out = new Set<string>();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^\s*[A-Z.]{3}\s+(\S+)\s/);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

export interface EncoderCapabilities {
  readonly encoders: readonly VideoEncoderInfo[];
  readonly audioFilters: Readonly<Record<string, boolean>>;
  readonly missingFilters: readonly string[];
  /** 在可用前提下推荐的编码器；libx264 缺失时才退到硬件 */
  readonly recommended: VideoEncoderId | null;
}

let cached: EncoderCapabilities | null = null;

/** 探测结果缓存——每次渲染开头调用一次即可，不要放进帧循环 */
export function detectEncoderCapabilities(options: { refresh?: boolean } = {}): EncoderCapabilities {
  if (cached && !options.refresh) return cached;

  const encoders = listEncoders();
  const filters = listFilters();

  const infos: VideoEncoderInfo[] = VIDEO_ENCODER_META.map((meta) => ({
    ...meta,
    available: encoders.has(meta.id),
  }));

  const audioFilters = Object.fromEntries(
    REQUIRED_AUDIO_FILTERS.map((f) => [f, filters.has(f)]),
  );
  const missingFilters = REQUIRED_AUDIO_FILTERS.filter((f) => !filters.has(f));

  const software = infos.find((e) => e.id === DEFAULT_VIDEO_ENCODER && e.available);
  const fallback = infos.find((e) => e.available);
  const recommended = software?.id ?? fallback?.id ?? null;

  cached = { encoders: infos, audioFilters, missingFilters, recommended };
  return cached;
}

/** 判断某个编码器是否可用，并给出可读的失败原因 */
export function assertEncoderAvailable(id: VideoEncoderId): void {
  const caps = detectEncoderCapabilities();
  const info = caps.encoders.find((e) => e.id === id);
  if (info?.available) return;
  throw new Error(
    `ENCODER_NOT_AVAILABLE: ffmpeg 缺少编码器 ${id}。` +
      ` 可用: ${caps.encoders.filter((e) => e.available).map((e) => e.id).join(', ') || '(无)'}`,
  );
}
