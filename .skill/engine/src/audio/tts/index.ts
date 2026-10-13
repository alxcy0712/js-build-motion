/**
 * TTS provider 注册表（需求 §16、§17）。
 *
 * 配音实现：
 *
 *   mock —— 确定性、零依赖。用于单元测试与黄金帧/黄金音轨：没有网络也能跑，
 *           而且同一 seed 永远得到同一段音频与同一份时间戳。
 *   file —— 挂载预制 voice.wav。**这是"没有可用 TTS 也不阻塞 M0"的兜底**（§16）。
 *   edge —— 实际可用、且能返回词级时间戳（见 edge.ts）。需要网络。
 *   doubao —— 按目录选择公版音色与模型，需要运行时 API Key。
 *
 * 选择顺序刻意是「显式指定 → edge（有网络则最自然）→ file → mock」，
 * 并把回退原因带出去，让"为什么听起来是假人声"这种问题一眼可见。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { SeededRandom } from '../../animation/random.ts';
import { PROJECT_ROOT } from '../../utils/env.ts';
import type { TTSProvider, TTSRequest, TTSResult, AudioAsset } from '../types.ts';
import { estimateSpeechSeconds } from '../../captions/track.ts';
import { createEdgeTtsProvider } from './edge.ts';
import { createDoubaoTtsProvider } from './doubao.ts';
import { probeAudio } from '../probe.ts';

const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------- mock

/**
 * 确定性 mock TTS。
 *
 * 产出的是"听得出是测试信号"的音频（低频正弦 + 轻微包络），而不是静音——
 * 这样在混音验证时能真的观察闪避效果，而不是拿一段无声去做假验证。
 * 时长与 estimateSpeechSeconds 对齐，因此字幕时间轴与真实 TTS 行为一致。
 */
export const mockTtsProvider: TTSProvider = {
  id: 'mock',
  requiresNetwork: false,
  isAvailable: async () => true,
  synthesize: async (req: TTSRequest): Promise<TTSResult> => {
    const seconds = estimateSpeechSeconds(req.text);
    const samples = Math.ceil(seconds * SAMPLE_RATE);
    const rng = new SeededRandom(req.seed);
    // 每个字一个音节，便于生成与文本长度相称的词级时间戳
    const chars = [...req.text];

    const data = Buffer.alloc(44 + samples * 2);
    writeWavHeader(data, samples, SAMPLE_RATE, 1);

    const perChar = seconds / Math.max(1, chars.length);
    let o = 44;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      const charIdx = Math.min(chars.length - 1, Math.floor(t / perChar));
      // 音高由字符决定 → 同一文本永远得到同一段音频
      const local = (t % perChar) / perChar;
      const h = chars[charIdx]?.codePointAt(0) ?? 65;
      const f = 150 + (h % 120);
      // 音节包络：快起 → 保持 → 释放。
      //
      // 上一版用 exp(-local*4.5) 衰减到 2%，信号非常尖锐：
      // 峰值 0.22 但 RMS 只有 0.06，远低于真实语音的"密集"程度。
      // 后果是它作为语音替身在测试里**会掩盖问题**——例如闪避看起来只生效 4dB，
      // 而同一套参数配真实语音能到十几 dB。测试用的替身必须和真实信号可比。
      const attack = Math.min(1, local / 0.1);
      const release = local > 0.72 ? Math.max(0, 1 - (local - 0.72) / 0.28) : 1;
      const env = attack * release;
      const s = Math.sin(2 * Math.PI * f * t) * env * 0.22 + (rng.next() - 0.5) * 0.006 * env;
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), o);
      o += 2;
    }

    mkdirSync(dirname(req.outPath), { recursive: true });
    writeFileSync(req.outPath, data);

    const words = chars.map((ch, i) => ({
      text: ch,
      start: i * perChar,
      end: (i + 1) * perChar,
    }));

    return { path: req.outPath, durationSeconds: seconds, sampleRate: SAMPLE_RATE, words };
  },
};

function writeWavHeader(buf: Buffer, samples: number, sampleRate: number, channels: number): void {
  const dataBytes = samples * channels * 2;
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
}

// ---------------------------------------------------------------- file

/**
 * 预制音频 provider。
 *
 * 用途（§16）：当前环境没有可用 TTS 时，用一段已经录好的 voice.wav
 * 把 M0 全链路跑通，而不是卡在"等 TTS 接好再说"。
 * 时长与采样率来自原文件的完整解码；词级时间保持未知。
 */
export function createFileTtsProvider(
  resolvePath: (req: TTSRequest) => string | null,
): TTSProvider {
  return {
    id: 'file',
    requiresNetwork: false,
    isAvailable: async () => true,
    synthesize: async (req: TTSRequest): Promise<TTSResult> => {
      const src = resolvePath(req);
      if (!src || !existsSync(src)) {
        throw new Error(`AUDIO_ASSET_NOT_FOUND: 找不到预制配音 ${src ?? '(未配置)'}`);
      }
      const source = statSync(src);
      const destination = existsSync(req.outPath) ? statSync(req.outPath) : null;
      if (resolve(src) === resolve(req.outPath) || (destination && source.dev === destination.dev && source.ino === destination.ino)) {
        throw new Error('AUDIO_SOURCE_OVERWRITE: 预制配音的输出必须与源文件分开');
      }
      const measured = await probeAudio(src);
      mkdirSync(dirname(req.outPath), { recursive: true });
      writeFileSync(req.outPath, readFileSync(src));
      return { path: req.outPath, durationSeconds: measured.durationSeconds, sampleRate: measured.sampleRate };
    },
  };
}

/** 默认的预制音频查找路径：assets/audio/voice.wav */
export function defaultVoiceAssetPath(): string {
  return join(PROJECT_ROOT, 'assets', 'audio', 'voice.wav');
}

// ------------------------------------------------------------ 选择逻辑

export type TtsProviderId = 'edge' | 'doubao' | 'file' | 'mock';

export interface TtsProviderSelection {
  readonly provider: TTSProvider;
  /** 若非首选 provider，说明回退原因——必须让使用者看得见 */
  readonly fallbackReason?: string;
}

export interface ResolveTtsOptions {
  readonly preferred?: TtsProviderId;
  /** 允许联网。false 时跳过 edge */
  readonly allowNetwork?: boolean;
  /** 预制音频路径覆盖 */
  readonly voiceAssetPath?: string;
}

/** 依序尝试，返回第一个可用的 provider */
export async function resolveTtsProvider(options: ResolveTtsOptions = {}): Promise<TtsProviderSelection> {
  const allowNetwork = options.allowNetwork ?? true;
  const reasons: string[] = [];

  if (options.preferred === 'doubao') {
    if (!allowNetwork) throw new Error('TTS_PROVIDER_UNAVAILABLE: doubao 需要联网');
    const provider = createDoubaoTtsProvider();
    if (!await provider.isAvailable()) throw new Error('TTS_PROVIDER_UNAVAILABLE: 请提供 DOUBAO_API_KEY，并安装 Python/websockets>=14');
    return { provider };
  }

  const candidates: ReadonlyArray<readonly [TtsProviderId, TTSProvider]> = [
    ['edge', createEdgeTtsProvider()],
    ['file', createFileTtsProvider(() => options.voiceAssetPath ?? defaultVoiceAssetPath())],
    ['mock', mockTtsProvider],
  ];

  const ordered = options.preferred
    ? [
        ...candidates.filter(([id]) => id === options.preferred),
        ...candidates.filter(([id]) => id !== options.preferred),
      ]
    : candidates;

  for (const [id, provider] of ordered) {
    if (id === 'edge' && !allowNetwork) {
      reasons.push('edge: 已禁用联网');
      continue;
    }
    if (id === 'file') {
      const p = options.voiceAssetPath ?? defaultVoiceAssetPath();
      if (!existsSync(p)) {
        reasons.push(`file: 预制音频不存在 (${p})`);
        continue;
      }
    }
    try {
      if (await provider.isAvailable()) {
        if (id !== (options.preferred ?? 'edge')) {
          return {
            provider,
            fallbackReason: reasons.join('；') || `已回退到 ${id}`,
          };
        }
        return { provider };
      }
      reasons.push(`${id}: isAvailable() 返回 false`);
    } catch (err) {
      reasons.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // mock 永远可用，走不到这里；保留兜底以免未来改动引入静默失败
  throw new Error(`TTS_PROVIDER_UNAVAILABLE: 没有可用的 TTS provider。尝试记录：${reasons.join('；')}`);
}

export { createEdgeTtsProvider } from './edge.ts';
export type { AudioAsset };
