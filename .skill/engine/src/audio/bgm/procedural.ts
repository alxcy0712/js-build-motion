/**
 * 程序化 BGM 合成器（需求 §19，默认 BGM provider）。
 *
 * 为什么默认用它，而不是神经音乐模型：
 *   - **零版权风险**：每个采样都是本进程算出来的，不存在训练数据污染
 *   - **确定性**：同一 (preset, key, seed, duration) 必然得到同一段音频，
 *     可以进黄金帧/黄金音轨回归
 *   - **时长精确**：视频多长就合成多长，不需要裁剪或循环拼接
 *   - **可卡点**：和弦进行按小节走，容易对齐到镜头切换
 *   - **够快**：实测约 46x 实时，3 分钟 BGM 只需数秒，且不依赖 GPU/网络
 *
 * 天花板也很明确：做不出真实管弦、人声与复杂编曲。
 * 需要那种质感时由 BGMProvider 换成 file / AI provider，调用方无感。
 *
 * 全程只用整数运算的 PRNG 与纯函数包络，因此跨机器逐样本一致。
 */

import { SeededRandom } from '../../animation/random.ts';
import type { BgmKey, BgmPreset } from '../../spec/types.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SAMPLE_RATE = 48000;

interface MoodProfile {
  /** 和弦进行，大写=大调色彩，小写=小调色彩 */
  readonly progression: readonly string[];
  /** 力度分配 */
  readonly arp: number;
  readonly pad: number;
  readonly perc: number;
  /** 亮度：影响谐波含量 */
  readonly bright: number;
  /** 铺底起音（秒）。钢琴类要更短更清脆 */
  readonly padAttack: number;
  /** 是否用"钢琴式"衰减包络而不是持续铺底 */
  readonly plucked: boolean;
}

/** 和弦名 → 相对主音的半音集合（含扩展音） */
const CHORDS: Readonly<Record<string, readonly number[]>> = {
  I: [0, 4, 7], ii: [2, 5, 9], iii: [4, 7, 11], IV: [5, 9, 12], V: [7, 11, 14], vi: [9, 12, 16],
  i: [0, 3, 7], iv: [5, 8, 12], v: [7, 10, 14], VI: [8, 12, 15], VII: [10, 14, 17], III: [3, 7, 10],
};

export const MOODS: Readonly<Record<BgmPreset, MoodProfile>> = {
  quiet_piano: {
    progression: ['I', 'vi', 'IV', 'V'], arp: 0.85, pad: 0.7, perc: 0, bright: 0.45,
    padAttack: 0.006, plucked: true,
  },
  warm_uplift: {
    progression: ['I', 'V', 'vi', 'IV'], arp: 0.9, pad: 0.55, perc: 0.7, bright: 0.65,
    padAttack: 0.9, plucked: false,
  },
  curious: {
    progression: ['i', 'VI', 'III', 'VII'], arp: 0.7, pad: 0.7, perc: 0.4, bright: 0.45,
    padAttack: 0.9, plucked: false,
  },
  tender: {
    progression: ['I', 'vi', 'IV', 'V'], arp: 0.5, pad: 0.8, perc: 0.25, bright: 0.55,
    padAttack: 1.1, plucked: false,
  },
  tense: {
    progression: ['i', 'iv', 'v', 'i'], arp: 0.8, pad: 0.6, perc: 0.9, bright: 0.3,
    padAttack: 0.5, plucked: false,
  },
  playful: {
    progression: ['I', 'IV', 'V', 'I'], arp: 1.0, pad: 0.4, perc: 0.85, bright: 0.8,
    padAttack: 0.5, plucked: false,
  },
};

const NOTE_SEMITONE: Readonly<Record<BgmKey, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9 };

/** 半音数 → 频率。A4 = 440Hz，A 对应 9 */
function frequency(key: BgmKey, semitoneOffset: number): number {
  return 440 * Math.pow(2, (NOTE_SEMITONE[key] + semitoneOffset - 9) / 12);
}

export interface SynthBgmOptions {
  readonly preset: BgmPreset;
  readonly key: BgmKey;
  readonly seed: number;
  readonly durationSeconds: number;
  /** 每分钟拍数。默认 96；慢曲可以用 72 */
  readonly bpm?: number;
}

export interface SynthResult {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly sampleRate: number;
  readonly durationSeconds: number;
}

/**
 * 合成立体声 BGM。
 *
 * 结构：和弦铺底 + 琶音 + 低音 + 打击，最后做软限幅与首尾淡入淡出。
 * 所有音符位置来自"小节 × 拍"的整数网格，不累积浮点时间，
 * 因此长曲子也不会漂移。
 */
export function synthBgm(options: SynthBgmOptions): SynthResult {
  const { preset, key, seed, durationSeconds } = options;
  const mood = MOODS[preset];
  const bpm = options.bpm ?? (preset === 'quiet_piano' ? 72 : 96);

  const spb = 60 / bpm; // 秒/拍
  const bar = spb * 4; // 秒/小节（4/4）
  const total = durationSeconds;
  const n = Math.ceil(total * SAMPLE_RATE);
  const left = new Float32Array(n);
  const right = new Float32Array(n);

  const add = (t: number, l: number, r: number): void => {
    const i = Math.round(t * SAMPLE_RATE);
    if (i < 0 || i >= n) return;
    left[i] = (left[i] as number) + l;
    right[i] = (right[i] as number) + r;
  };

  /** 指数衰减包络（拨弦/打击） */
  const decay = (t: number, attack: number, tau: number): number =>
    t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / tau);

  /** 起音 → 保持 → 释放（铺底），段间互相咬合避免"抽气" */
  const sustain = (t: number, hold: number, attack: number, release: number): number => {
    if (t < 0) return 0;
    if (t < attack) return t / attack;
    if (t < hold) return 1;
    return Math.max(0, 1 - (t - hold) / release);
  };

  const bars = Math.max(1, Math.ceil(total / bar));
  const padOverlap = 0.5;

  for (let b = 0; b < bars; b++) {
    const t0 = b * bar;
    const chordName = mood.progression[b % mood.progression.length] as string;
    const tones = CHORDS[chordName] ?? CHORDS['I']!;

    // ---- 1. 和弦铺底 / 钢琴和弦 ----
    for (const semi of tones) {
      const f = frequency(key, semi) / (mood.plucked ? 1 : 2);
      const layers = mood.plucked ? 1 : 2;
      for (let d = 0; d < layers; d++) {
        const detune = layers === 1 ? 1 : 1 + (d === 0 ? -0.0028 : 0.0035);
        const noteDur = mood.plucked ? bar * 1.05 : bar + padOverlap;
        for (let i = 0; i < noteDur * SAMPLE_RATE; i++) {
          const t = i / SAMPLE_RATE;
          const a = mood.plucked
            ? decay(t, mood.padAttack, 1.5) * 0.1 * mood.pad
            : sustain(t, bar, mood.padAttack, 0.55) * 0.055 * mood.pad;
          const ph = 2 * Math.PI * f * detune * t;
          const sine = Math.sin(ph);
          const harm = mood.bright * (Math.sin(ph * 2) * 0.2 + Math.sin(ph * 3) * 0.08);
          const saw = mood.plucked ? 0 : (2 * ((f * detune * t) % 1) - 1) * 0.25;
          const s = (sine * 0.6 + harm + saw) * a;
          const pan = layers === 1 ? 0.5 : d === 0 ? 0.32 : 0.68;
          add(t0 + t, s * (1 - pan * 0.6), s * (0.4 + pan * 0.6));
        }
      }
    }

    // ---- 2. 琶音 / 钢琴高音 ----
    const steps = mood.plucked ? 8 : 8;
    const stepDur = bar / steps;
    const rng = new SeededRandom((seed ^ (b * 7919)) >>> 0);
    for (let s = 0; s < steps; s++) {
      if (rng.next() > mood.arp) continue;
      const semi = (tones[Math.floor(rng.next() * tones.length)] ?? 0) + 12;
      const f = frequency(key, semi);
      const onset = t0 + s * stepDur + (rng.next() - 0.5) * 0.012;
      const dur = stepDur * 1.8;
      const amp = (mood.plucked ? 0.13 : 0.1) * mood.arp;
      const tau = mood.plucked ? 0.5 : 0.32;
      for (let i = 0; i < dur * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const a = decay(t, 0.006, tau) * amp;
        const tri = Math.asin(Math.sin(2 * Math.PI * f * t)) * (2 / Math.PI);
        const s2 = tri * a;
        add(onset + t, s2 * 0.72, s2 * 0.72);
        // 两个回声，营造空间感（不用卷积混响，成本低且确定性好）
        add(onset + t + stepDur * 0.5, s2 * 0.26, s2 * 0.2);
        add(onset + t + stepDur, s2 * 0.1, s2 * 0.12);
      }
    }

    // ---- 3. 低音 ----
    const bassF = frequency(key, (tones[0] ?? 0)) / 4;
    const bassBeats = mood.plucked ? 1 : 2;
    for (let s = 0; s < bassBeats; s++) {
      const onset = t0 + (s * bar) / bassBeats;
      const dur = bar / bassBeats;
      for (let i = 0; i < dur * SAMPLE_RATE; i++) {
        const t = i / SAMPLE_RATE;
        const a = decay(t, 0.02, mood.plucked ? 1.4 : 1.6) * 0.16;
        const s3 = Math.sin(2 * Math.PI * bassF * t) * a;
        add(onset + t, s3, s3);
      }
    }

    // ---- 4. 打击（有 percussion 的预设才有）----
    if (mood.perc > 0) {
      for (const beat of [0, 2]) {
        const onset = t0 + beat * spb;
        for (let i = 0; i < 0.28 * SAMPLE_RATE; i++) {
          const t = i / SAMPLE_RATE;
          const freq = 92 * Math.exp(-t * 22) + 46;
          const a = Math.exp(-t * 11) * 0.2 * mood.perc;
          const s4 = Math.sin(2 * Math.PI * freq * t) * a;
          add(onset + t, s4, s4);
        }
      }
      for (const beat of [0.5, 1.5, 2.5, 3.5]) {
        const onset = t0 + beat * spb;
        for (let i = 0; i < 0.09 * SAMPLE_RATE; i++) {
          const t = i / SAMPLE_RATE;
          const a = Math.exp(-t * 48) * 0.05 * mood.perc;
          const s5 = (rng.next() * 2 - 1) * a;
          add(onset + t, s5 * 1.1, s5 * 0.8);
        }
      }
    }
  }

  // ---- 总线：软限幅 + 首尾淡入淡出 ----
  let peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  }
  const gain = peak > 0 ? 0.82 / peak : 1;
  const fade = Math.min(1.5, total * 0.2);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, t / fade) * Math.min(1, (total - t) / fade);
    // tanh 软限幅：比硬 clamp 自然，不会产生刺耳的削波谐波
    left[i] = Math.tanh((left[i] as number) * gain * 1.15) * env;
    right[i] = Math.tanh((right[i] as number) * gain * 1.15) * env;
  }

  return { left, right, sampleRate: SAMPLE_RATE, durationSeconds: total };
}

/** Float32 立体声 → 16-bit PCM WAV */
export function encodeWav16(result: SynthResult): Buffer {
  const { left, right, sampleRate } = result;
  const frames = left.length;
  const dataBytes = frames * 2 * 2; // 双声道 × 16bit
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // 双声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2 * 2, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  let o = 44;
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-32768, Math.min(32767, Math.round((left[i] as number) * 32767)));
    const r = Math.max(-32768, Math.min(32767, Math.round((right[i] as number) * 32767)));
    buf.writeInt16LE(l, o);
    buf.writeInt16LE(r, o + 2);
    o += 4;
  }
  return buf;
}

/** 合成并写盘 */
export function writeBgmWav(options: SynthBgmOptions, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, encodeWav16(synthBgm(options)));
}
