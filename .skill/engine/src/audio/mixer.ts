/**
 * 音频混音（需求 §20、§21）。
 *
 * 三件事：**时间定位 → 闪避 → 响度标准化**。
 *
 * 图结构（有 BGM 且启用闪避时）：
 *
 *   voice 轨 ──┐
 *              ├─ amix ─ [voice] ──────────────┬──────────────┐
 *   bgm 轨 ────┼─ amix ─ [bgm_raw] ─ sidechaincompress ─ [bgm] ─┼─ amix ─ loudnorm ─ [out]
 *   sfx 轨 ────┴─ amix ─ [sfx] ────────────────────────────────┘
 *                          ▲
 *                   [voice] 作为侧链触发
 *
 * 三个刻意的决定：
 *
 * 1. **每个输入都先补齐到总时长再进 amix**。
 *    amix 的 duration=longest 遇到无限长的 apad 会一直等下去；
 *    先把每条轨 `apad,atrim=0:TOTAL` 固定长度，图的行为就是确定的。
 *
 * 2. **amix 必须 normalize=0**。默认会按输入数把音量除下去，
 *    加一轨音效就整体变小，这类 bug 很隐蔽。
 *
 * 3. **闪避只用 voice 做侧链**，不用"所有非 voice"。
 *    否则音效一响 BGM 就往下掉，听感上像在抽气。
 *
 * 每个轨道参数（位置/增益/淡入淡出）都在图里显式写出，
 * 因此 `buildMixArgs()` 可以脱离 ffmpeg 被单元测试断言。
 */

import { spawnSync } from 'node:child_process';

import type { AudioTimeline, AudioTrack, DuckSettings } from './types.ts';
import { DEFAULT_DUCK } from './types.ts';

export interface MixOptions {
  readonly duck?: DuckSettings;
  /** 只输出被闪避后的 BGM 干声（用于验证闪避是否生效），不混入 voice */
  readonly duckedBgmOnly?: boolean;
  readonly verbose?: boolean;
  /** master 编码，默认 pcm_s16le（WAV 中间产物，无损） */
  readonly codec?: string;
}

export interface BuiltMixGraph {
  readonly args: readonly string[];
  readonly filterComplex: string;
}

const TOTAL_PRECISION = 6;

function n(value: number): string {
  return value.toFixed(TOTAL_PRECISION).replace(/0+$/, '').replace(/\.$/, '');
}

function ms(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

/**
 * 构造单个轨道的滤镜链。
 *
 * 顺序有讲究：
 *   aresample/aformat 先统一格式（不同来源的采样率/声道数可能不同）
 *   → volume 增益
 *   → atrim 取素材时长
 *   → afade 在素材自己的时间轴上做淡入淡出（此时还没移位）
 *   → adelay 移到时间轴位置
 *   → apad+atrim 补齐到总长度（这样 amix 的输入长度一致）
 */
function trackChain(track: AudioTrack, index: number, totalSeconds: number): string {
  const parts: string[] = [
    'aresample=48000',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `volume=${n(track.gain)}`,
  ];

  const sampleTrim = track.sourceStartSample !== undefined || track.sourceEndSample !== undefined;
  const sourceStart = track.sourceStartSample ?? 0;
  const sourceEnd = track.sourceEndSample ?? sourceStart + Math.round(track.sourceDuration * 48000);
  if (sampleTrim && (!Number.isSafeInteger(sourceStart) || sourceStart < 0 || !Number.isSafeInteger(sourceEnd) || sourceEnd <= sourceStart)) {
    throw Error('AUDIO_SAMPLE_RANGE_INVALID');
  }
  const srcDur = sampleTrim ? (sourceEnd - sourceStart) / 48000 : Math.max(0.01, track.sourceDuration);
  if (sampleTrim) parts.push(`atrim=start_sample=${sourceStart}:end_sample=${sourceEnd}`, 'asetpts=N/SR/TB');
  else parts.push(`atrim=0:${n(srcDur)}`);

  const fadeIn = track.fadeIn ?? 0;
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${n(Math.min(fadeIn, srcDur))}`);

  const fadeOut = track.fadeOut ?? 0;
  if (fadeOut > 0) {
    const d = Math.min(fadeOut, Math.max(0, srcDur - fadeIn));
    if (d > 0.001) parts.push(`afade=t=out:st=${n(Math.max(0, srcDur - d))}:d=${n(d)}`);
  }

  if (track.startSample !== undefined) {
    if (!Number.isSafeInteger(track.startSample) || track.startSample < 0) throw Error('AUDIO_SAMPLE_PLACEMENT_INVALID');
    if (track.startSample > 0) parts.push(`adelay=${track.startSample}S|${track.startSample}S`);
  } else {
    const delay = ms(track.start);
    if (delay > 0) parts.push(`adelay=${delay}|${delay}`);
  }

  // adelay can emit unset PTS while padding a trimmed source; sample chains use their exact length.
  const totalTrim = sampleTrim || track.startSample !== undefined
    ? `atrim=end_sample=${Math.round(totalSeconds * 48000)}` : `atrim=0:${n(totalSeconds)}`;
  parts.push('apad', totalTrim, 'asetpts=N/SR/TB');

  return `[${index}:a]${parts.join(',')}[t${index}]`;
}

/** 把若干条轨道汇总成一条 bus；只有一条时直接复用其标签，避免无意义的 amix */
function bus(label: string, trackIndices: readonly number[]): { filters: string[]; label: string } | null {
  if (trackIndices.length === 0) return null;
  if (trackIndices.length === 1) return { filters: [], label: `t${trackIndices[0]}` };
  const inputs = trackIndices.map((i) => `[t${i}]`).join('');
  // normalize=0：否则每多一条轨，整体音量就被多除一次
  return {
    filters: [`${inputs}amix=inputs=${trackIndices.length}:normalize=0:duration=longest[${label}]`],
    label,
  };
}

/**
 * 构造完整的 ffmpeg 调用。
 * 纯函数：不碰文件系统、不启动进程，因此可以完整单元测试。
 */
export function buildMixArgs(timeline: AudioTimeline, options: MixOptions = {}): BuiltMixGraph {
  const duck = options.duck ?? DEFAULT_DUCK;
  const total = timeline.durationSeconds;
  const verbose = options.verbose ?? false;

  // duckedBgmOnly 只关心“被压低后的 BGM”：
  //   - 启用闪避时需要有 voice 作为侧链触发
  //   - 未启用闪避时连 voice 都不需要（否则它的链无人消费 → ffmpeg 直接拒绝）
  // 这个边界条件被下面的 assertChainsConsumed 当场抓到过一次，
  // 说明“先裁轨、再建图”比“建完图再补漏”可靠。
  const duckWanted = timeline.tracks.some((t) => t.kind === 'bgm' && t.duckUnderVoice !== false) &&
    timeline.tracks.some((t) => t.kind === 'voice');

  const activeTracks = options.duckedBgmOnly
    ? timeline.tracks.filter((t) => t.kind === 'bgm' || (duckWanted && t.kind === 'voice'))
    : timeline.tracks;

  const voiceIdx: number[] = [];
  const bgmIdx: number[] = [];
  const sfxIdx: number[] = [];
  const originalIdx: number[] = [];
  activeTracks.forEach((t, i) => {
    if (t.kind === 'voice') voiceIdx.push(i);
    else if (t.kind === 'bgm') bgmIdx.push(i);
    else if (t.kind === 'original') originalIdx.push(i);
    else sfxIdx.push(i);
  });

  const filters: string[] = activeTracks.map((t, i) => trackChain(t, i, total));

  const voiceBus = bus('voice', voiceIdx);
  const bgmBus = bus('bgmraw', bgmIdx);
  const sfxBus = bus('sfx', sfxIdx);
  const originalBus = bus('original', originalIdx);
  for (const b of [voiceBus, bgmBus, sfxBus, originalBus]) if (b) filters.push(...b.filters);

  // ---- 闪避 ----
  // 只有「有 BGM」且「有 voice」且「至少一条 BGM 要求闪避」时才建侧链
  const wantsDuck = duckWanted && bgmBus !== null && voiceBus !== null;
  let bgmLabel: string | null = bgmBus?.label ?? null;
  let voiceLabel = voiceBus?.label ?? null;
  if (wantsDuck && bgmBus && voiceBus) {
    // A filter output has one consumer. Explicitly split the voice bus so the
    // sidechain cannot consume it before the audible mix (FFmpeg may rebind it).
    let sidechainLabel = voiceBus.label;
    if (!options.duckedBgmOnly) {
      filters.push(`[${voiceBus.label}]asplit=2[voiceaudible][voicesidechain]`);
      voiceLabel = 'voiceaudible';
      sidechainLabel = 'voicesidechain';
    }
    filters.push(
      `[${bgmBus.label}][${sidechainLabel}]sidechaincompress=` +
        `threshold=${n(duck.threshold)}:ratio=${n(duck.ratio)}:` +
        `attack=${n(duck.attack)}:release=${n(duck.release)}:makeup=1[bgm]`,
    );
    bgmLabel = 'bgm';
  }

  // ---- 汇总 ----
  let outLabel: string;
  if (options.duckedBgmOnly) {
    // 验证模式：只导出被闪避后的 BGM，方便用 volumedetect 直接量它
    outLabel = bgmLabel ?? voiceBus?.label ?? sfxBus?.label ?? 't0';
  } else {
    const mixInputs: string[] = [];
    if (voiceLabel) mixInputs.push(`[${voiceLabel}]`);
    if (bgmLabel) mixInputs.push(`[${bgmLabel}]`);
    if (sfxBus) mixInputs.push(`[${sfxBus.label}]`);
    if (originalBus) mixInputs.push(`[${originalBus.label}]`);

    if (mixInputs.length === 0) {
      throw new Error('没有可混音的音轨');
    }
    if (mixInputs.length === 1) {
      outLabel = mixInputs[0]!.slice(1, -1);
    } else {
      filters.push(
        `${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0:duration=longest[mix]`,
      );
      outLabel = 'mix';
    }
  }

  // ---- 响度标准化 ----
  // linear=true 尽量走"整体线性增益"而不是动态压缩，避免安静段被抬起来；
  // loudnorm 内部工作在 192kHz，所以后面必须 -ar 48000。
  //
  // duckedBgmOnly（验证模式）刻意**不做** loudnorm：
  //   loudnorm 会在整段上算一个统一的线性增益，它会部分抵消闪避造成的电平差，
  //   于是"闪避到底有多深"就量不准了（实测：真实深度十几 dB 被压成 0.2dB）。
  //   验证闪避时必须看未归一化的干声。
  let outputLabel: string;
  if (options.duckedBgmOnly) {
    outputLabel = outLabel;
  } else {
    filters.push(
      `[${outLabel}]loudnorm=I=${n(timeline.loudnessLufs)}:TP=${n(timeline.truePeakDb)}:LRA=11:linear=true[out]`,
    );
    outputLabel = 'out';
  }

  const args: string[] = [
    '-hide_banner',
    '-loglevel', verbose ? 'warning' : 'error',
    '-y',
  ];
  for (const t of activeTracks) args.push('-i', t.path);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', `[${outputLabel}]`,
    '-ar', String(timeline.masterSampleRate),
    '-ac', '2',
    '-c:a', options.codec ?? 'pcm_s16le',
    timeline.masterPath,
  );

  assertChainsConsumed(filters, activeTracks.length, outputLabel);
  return { args, filterComplex: filters.join(';') };
}

/**
 * 防御性校验：每条 `[tN]` 链必须被下游消费，或者是最终的输出标签。
 *
 * 一旦有链悬空，ffmpeg 只会报一句 "Filter ... has an unconnected output"
 * （或 "Output with label 'out' does not exist"）加一个退出码 234，
 * 完全看不出是哪条轨。宁可在构造阶段就把话说清楚。
 *
 * 注意：单轨且无混音时，轨道标签本身就是输出标签，此时它只出现一次是合法的。
 */
function assertChainsConsumed(
  filters: readonly string[],
  trackCount: number,
  outputLabel: string,
): void {
  const text = filters.join(';');
  const dangling: string[] = [];
  for (let i = 0; i < trackCount; i++) {
    const label = `t${i}`;
    if (label === outputLabel) continue;
    const count = text.split(`[${label}]`).length - 1;
    if (count < 2) dangling.push(`[${label}]`);
  }
  if (dangling.length > 0) {
    throw new Error(
      `混音图存在未被消费的音轨链: ${dangling.join(', ')}。` +
        '这会让 ffmpeg 以 "unconnected output" 拒绝整个滤镜图。',
    );
  }
}

export interface MixResult {
  readonly masterPath: string;
  readonly durationSeconds: number;
  readonly elapsedMs: number;
  readonly stderrTail: readonly string[];
}

/** 执行混音 */
export function mixAudio(timeline: AudioTimeline, options: MixOptions = {}): MixResult {
  const { args } = buildMixArgs(timeline, options);
  const started = Date.now();
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.error) {
    throw new Error(`FFMPEG_NOT_FOUND: 无法执行 ffmpeg: ${r.error.message}`);
  }
  if (r.status !== 0) {
    const tail = (r.stderr ?? '').trim().split('\n').slice(-12).join('\n');
    throw new Error(`RENDER_FAILED: 混音失败（ffmpeg 退出码 ${r.status}）\n${tail}`);
  }
  return {
    masterPath: timeline.masterPath,
    durationSeconds: timeline.durationSeconds,
    elapsedMs: Date.now() - started,
    stderrTail: (r.stderr ?? '').trim().split('\n').slice(-6),
  };
}

// ------------------------------------------------------------ 量测工具

export interface LoudnessMeasurement {
  readonly inputIntegratedLufs: number | null;
  readonly inputTruePeakDbtp: number | null;
  readonly inputLra: number | null;
  readonly targetOffset: number | null;
}

/** 用 loudnorm 的测量模式读真实响度。用于验收与两遍标准化的第一遍。 */
export function measureLoudness(path: string, target = -14): LoudnessMeasurement {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', path, '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const text = (r.stderr ?? '') + (r.stdout ?? '');
  const grab = (key: string): number | null => {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"(-?[0-9.]+)"`));
    return m?.[1] !== undefined ? Number(m[1]) : null;
  };
  return {
    inputIntegratedLufs: grab('input_i'),
    inputTruePeakDbtp: grab('input_tp'),
    inputLra: grab('input_lra'),
    targetOffset: grab('target_offset'),
  };
}

export interface MeanVolumeMeasurement {
  readonly meanDb: number | null;
  readonly maxDb: number | null;
}

/**
 * 读某一段的 mean/max 音量（dB）。
 * 这是验证闪避的唯一诚实办法：对**同一段 BGM 干声**分别量"配音说话时"与"配音静默时"。
 * 直接量混音成品是量不到闪避的——那里面还混着人声本身。
 */
export function measureMeanVolume(path: string, startSeconds: number, durationSeconds: number): MeanVolumeMeasurement {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-ss', String(startSeconds), '-t', String(durationSeconds), '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const text = (r.stderr ?? '') + (r.stdout ?? '');
  const grab = (key: string): number | null => {
    const m = text.match(new RegExp(`${key}:\\s*(-?[0-9.]+) dB`));
    return m?.[1] !== undefined ? Number(m[1]) : null;
  };
  return { meanDb: grab('mean_volume'), maxDb: grab('max_volume') };
}
