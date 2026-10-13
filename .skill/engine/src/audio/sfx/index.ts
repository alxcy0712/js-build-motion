/**
 * 程序化音效（需求 §15、§19）。
 *
 * 与 BGM 同样的理由：零版权、确定性、时长精确。
 * 词汇表里的环境、动作与事件预设都给出实现——
 * 这样 DSL 是稳定的，补素材不需要改 schema，也不会出现
 * "spec 里写了 soft_rain 但引擎不认识"这种失败。
 *
 * 手法：噪声整形 + 包络。不做物理建模，只做"听感上像"。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { SeededRandom } from '../../animation/random.ts';
import type { SfxPreset } from '../../spec/types.ts';
import type { SFXProvider, SFXRequest, AudioAsset } from '../types.ts';

const SAMPLE_RATE = 48000;

/** 一阶低通。用于把白噪声整形成"雨声/风声"这类有频谱倾向的噪声 */
function lowpass(input: Float32Array, cutoffNormalized: number): Float32Array {
  const out = new Float32Array(input.length);
  const alpha = Math.max(0, Math.min(1, cutoffNormalized));
  let prev = 0;
  for (let i = 0; i < input.length; i++) {
    prev = prev + alpha * ((input[i] as number) - prev);
    out[i] = prev;
  }
  return out;
}

function highpass(input: Float32Array, cutoffNormalized: number): Float32Array {
  const out = new Float32Array(input.length);
  const alpha = Math.max(0, Math.min(1, cutoffNormalized));
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i] as number;
    prevOut = alpha * (prevOut + x - prevIn);
    prevIn = x;
    out[i] = prevOut;
  }
  return out;
}

function whiteNoise(n: number, rng: SeededRandom): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

interface StereoBuffer {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/**
 * 生成音效。返回立体声缓冲。
 * 所有预设都保证：首尾有淡入淡出（避免爆音），峰值不超过 0.9。
 */
export function synthSfx(preset: SfxPreset, durationSeconds: number, seed: number): StereoBuffer {
  const n = Math.max(1, Math.ceil(durationSeconds * SAMPLE_RATE));
  const rng = new SeededRandom((seed ^ hashPreset(preset)) >>> 0);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  switch (preset) {
    case 'soft_rain':
    case 'heavy_rain': {
      // 雨 = 高通后的白噪声（沙沙感）+ 偶发水滴（短促衰减脉冲）
      const heavy = preset === 'heavy_rain';
      const base = highpass(lowpass(whiteNoise(n, rng), heavy ? 0.5 : 0.28), heavy ? 0.06 : 0.1);
      const amp = heavy ? 0.42 : 0.26;
      for (let i = 0; i < n; i++) {
        // 缓慢起伏，避免听起来像纯噪声
        const t = i / SAMPLE_RATE;
        const swell = 0.85 + 0.15 * Math.sin(t * 0.23) + 0.08 * Math.sin(t * 0.71);
        left[i] = (base[i] as number) * amp * swell;
        right[i] = (base[i] as number) * amp * swell * 0.92 + (rng.next() - 0.5) * 0.01;
      }
      const drops = Math.round((heavy ? 240 : 90) * durationSeconds);
      for (let d = 0; d < drops; d++) {
        const at = Math.floor(rng.next() * n);
        const f = 900 + rng.next() * 2600;
        const len = Math.floor(0.012 * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) {
          const e = Math.exp(-(i / SAMPLE_RATE) * 190);
          const s = Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE) * e * 0.055;
          left[at + i] = (left[at + i] as number) + s;
          right[at + i] = (right[at + i] as number) + s * 0.8;
        }
      }
      break;
    }

    case 'wind': {
      // 风 = 极低频噪声 + 缓慢的强弱起伏
      const base = lowpass(whiteNoise(n, rng), 0.02);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        const gust = 0.35 + 0.65 * Math.pow(Math.max(0, Math.sin(t * 0.17 + Math.sin(t * 0.07) * 2)), 1.6);
        const s = (base[i] as number) * gust * 2.6;
        left[i] = s;
        right[i] = s * 0.85;
      }
      break;
    }

    case 'footsteps': {
      // 脚步 = 每 0.55 秒一次的宽带脉冲（低通后像踩在木地板上）
      const interval = 0.55;
      const steps = Math.max(1, Math.floor(durationSeconds / interval));
      for (let s = 0; s < steps; s++) {
        const at = Math.floor(s * interval * SAMPLE_RATE + (rng.next() - 0.5) * 0.03 * SAMPLE_RATE);
        const len = Math.floor(0.16 * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) {
          const t = i / SAMPLE_RATE;
          const e = Math.exp(-t * 34) * (1 - Math.exp(-t * 900));
          const body = Math.sin(2 * Math.PI * 78 * t) * 0.5;
          const click = (rng.next() * 2 - 1) * 0.22 * Math.exp(-t * 170);
          const v = (body + click) * e * 0.5;
          left[at + i] = (left[at + i] as number) + v;
          right[at + i] = (right[at + i] as number) + v * 0.9;
        }
      }
      break;
    }

    case 'paper': {
      // 纸张 = 短促的高频噪声簇
      const bursts = Math.max(2, Math.round(durationSeconds * 3));
      for (let b = 0; b < bursts; b++) {
        const at = Math.floor(rng.next() * n * 0.95);
        const len = Math.floor((0.06 + rng.next() * 0.12) * SAMPLE_RATE);
        const shape = highpass(whiteNoise(len, rng), 0.5);
        for (let i = 0; i < len && at + i < n; i++) {
          const t = i / SAMPLE_RATE;
          const e = Math.min(1, t / 0.004) * Math.exp(-t * 26);
          const v = (shape[i] as number) * e * 0.24;
          left[at + i] = (left[at + i] as number) + v;
          right[at + i] = (right[at + i] as number) + v * 0.85;
        }
      }
      break;
    }

    case 'heartbeat': {
      // 心跳 = 每 0.9 秒一组"咚-哒"（第二下更轻）
      const period = 0.9;
      const beats = Math.max(1, Math.floor(durationSeconds / period));
      for (let b = 0; b < beats; b++) {
        for (const [offset, amp] of [[0, 1], [0.16, 0.62]] as const) {
          const at = Math.floor((b * period + offset) * SAMPLE_RATE);
          const len = Math.floor(0.22 * SAMPLE_RATE);
          for (let i = 0; i < len && at + i < n; i++) {
            const t = i / SAMPLE_RATE;
            const e = Math.exp(-t * 17) * (1 - Math.exp(-t * 260));
            const s = Math.sin(2 * Math.PI * 52 * t) * e * 0.62 * amp;
            left[at + i] = (left[at + i] as number) + s;
            right[at + i] = (right[at + i] as number) + s;
          }
        }
      }
      break;
    }

    case 'clock': {
      // 钟表 = 每秒一次的"嗒"，奇偶音高不同
      for (let s = 0; s < Math.floor(durationSeconds); s++) {
        const at = Math.floor(s * SAMPLE_RATE);
        const f = s % 2 === 0 ? 2100 : 1750;
        const len = Math.floor(0.05 * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) {
          const t = i / SAMPLE_RATE;
          const e = Math.exp(-t * 120) * (1 - Math.exp(-t * 3000));
          const v = Math.sin(2 * Math.PI * f * t) * e * 0.16;
          left[at + i] = (left[at + i] as number) + v;
          right[at + i] = (right[at + i] as number) + v * 0.7;
        }
      }
      break;
    }

    case 'click': {
      // 单次点击，触发后立即发声并在 70ms 内衰减。
      const len = Math.min(n, Math.ceil(0.07 * SAMPLE_RATE));
      for (let i = 0; i < len; i++) {
        const t = i / SAMPLE_RATE;
        const e = Math.exp(-t * 80) * (1 - Math.exp(-t * 3000)) * Math.max(0, 1 - t / 0.07);
        const v = (Math.sin(2 * Math.PI * 2400 * t) * 0.24 + (rng.next() * 2 - 1) * 0.08) * e;
        left[i] = v;
        right[i] = v;
      }
      break;
    }

    case 'success': {
      // 完成提示，两声上行短音，总长 390ms。
      for (const [offset, frequency] of [[0, 660], [0.15, 990]]) {
        const at = Math.round(offset * SAMPLE_RATE);
        const len = Math.ceil(0.24 * SAMPLE_RATE);
        for (let i = 0; i < len && at + i < n; i++) {
          const t = i / SAMPLE_RATE;
          const e = (1 - Math.exp(-t * 300)) * Math.exp(-t * 14) * Math.max(0, 1 - t / 0.24);
          const v = Math.sin(2 * Math.PI * frequency * t) * e * 0.3;
          left[at + i] = (left[at + i] as number) + v;
          right[at + i] = (right[at + i] as number) + v;
        }
      }
      break;
    }

    case 'whoosh': {
      // 呼啸 = 带通噪声，中心频率由低扫到高再回落
      const noise = lowpass(whiteNoise(n, rng), 0.35);
      for (let i = 0; i < n; i++) {
        const t = i / SAMPLE_RATE;
        const p = t / Math.max(0.001, durationSeconds);
        // 钟形包络：中间最强
        const env = Math.sin(Math.PI * Math.min(1, p)) ** 2;
        const sweep = 0.2 + 0.8 * Math.sin(Math.PI * Math.min(1, p));
        const s = (noise[i] as number) * env * sweep * 0.7;
        left[i] = s;
        right[i] = s * (0.4 + 0.6 * p); // 声像由左扫到右
      }
      break;
    }
  }

  applySafetyEnvelope(left, right, durationSeconds);
  return { left, right };
}

/** 首尾淡入淡出 + 峰值归一，确保拼进混音时不会爆音 */
function applySafetyEnvelope(left: Float32Array, right: Float32Array, durationSeconds: number): void {
  const n = left.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  }
  const gain = peak > 0 ? 0.9 / peak : 1;
  const fade = Math.min(0.02, durationSeconds * 0.1) * SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < fade) env = i / fade;
    else if (i > n - fade) env = Math.max(0, (n - i) / fade);
    left[i] = (left[i] as number) * gain * env;
    right[i] = (right[i] as number) * gain * env;
  }
}

function hashPreset(preset: string): number {
  let h = 2166136261;
  for (let i = 0; i < preset.length; i++) {
    h ^= preset.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function encodeWav16Stereo(buf: StereoBuffer, sampleRate: number): Buffer {
  const n = buf.left.length;
  const dataBytes = n * 2 * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((buf.left[i] as number) * 32767))), o);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((buf.right[i] as number) * 32767))), o + 2);
    o += 4;
  }
  return out;
}

export const proceduralSfxProvider: SFXProvider = {
  id: 'procedural',
  isAvailable: async () => true,
  render: async (req: SFXRequest): Promise<AudioAsset> => {
    mkdirSync(dirname(req.outPath), { recursive: true });
    const buf = synthSfx(req.preset, req.durationSeconds, req.seed);
    writeFileSync(req.outPath, encodeWav16Stereo(buf, SAMPLE_RATE));
    return { path: req.outPath, durationSeconds: req.durationSeconds, sampleRate: SAMPLE_RATE };
  },
};

export { SAMPLE_RATE as SFX_SAMPLE_RATE };
