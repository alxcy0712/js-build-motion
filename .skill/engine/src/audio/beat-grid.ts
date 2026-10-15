/**
 * 节拍网格、切点吸附与切点重音（纯函数，不读写音频文件）。
 *
 * - beatGrid：从原点逐拍「乘法」换算（origin + k·60/BPM），不做逐拍累加，避免累计误差；同时给出整数帧号。
 * - snapCutsToBeats：把切点吸附到网格。默认只在 maxShift 内移动，超出则保留原切点并标 kept——
 *   讲解片的切点由旁白语义决定，节拍只做微调，不拖着旁白走。
 * - addCutAccents：在 SynthResult（procedural.ts）上叠加切点处的软底鼓 + 气声、强调处的拨弦，并在切点后轻度压低铺底，
 *   让转场「落在」音乐上。程序合成，零版权、确定性。
 */
import { mulberry32 } from '../animation/random.ts';
import type { SynthResult } from './bgm/procedural.ts';

export interface Beat { readonly index: number; readonly time: number; readonly frame: number; readonly downbeat: boolean }

export function beatGrid(o: { readonly bpm: number; readonly duration: number; readonly origin?: number; readonly fps?: number; readonly beatsPerBar?: number }): Beat[] {
  if (!(o.bpm > 0) || !(o.duration >= 0)) throw new Error('BEAT_GRID_RANGE: bpm 须 > 0，duration 须 ≥ 0');
  const spb = 60 / o.bpm, origin = o.origin ?? 0, fps = o.fps ?? 60, bar = o.beatsPerBar ?? 4;
  const out: Beat[] = [];
  for (let k = 0; ; k++) {
    const time = origin + k * spb;
    if (time > o.duration + 1e-9) break;
    out.push({ index: k, time: Math.round(time * 1e6) / 1e6, frame: Math.round(time * fps), downbeat: k % bar === 0 });
  }
  return out;
}

export interface SnapOptions {
  /** 最大移动秒数，默认 0.12 */
  readonly maxShift?: number;
  /** nearest（默认）| later：只向后吸附（保证不短于阅读下限） | earlier */
  readonly direction?: 'nearest' | 'later' | 'earlier';
  /** 只吸附到小节重拍 */
  readonly downbeatsOnly?: boolean;
  /** 吸附后相邻切点最短间隔（秒），不满足时后一个保留原值 */
  readonly minGap?: number;
}
export interface SnappedCut { readonly original: number; readonly time: number; readonly shift: number; readonly beat: number | null; readonly kept: boolean }

export function snapCutsToBeats(cuts: readonly number[], grid: readonly Beat[], o: SnapOptions = {}): SnappedCut[] {
  const max = o.maxShift ?? 0.12, dir = o.direction ?? 'nearest', gap = o.minGap ?? 0;
  const beats = o.downbeatsOnly ? grid.filter((b) => b.downbeat) : grid;
  const out: SnappedCut[] = [];
  let prev = -Infinity;
  for (const c of [...cuts].sort((a, b) => a - b)) {
    let best: Beat | null = null, bestD = Infinity;
    for (const b of beats) {
      const d = b.time - c;
      if ((dir === 'later' && d < -1e-9) || (dir === 'earlier' && d > 1e-9)) continue;
      if (Math.abs(d) < Math.abs(bestD)) { best = b; bestD = d; }
    }
    const ok = best !== null && Math.abs(bestD) <= max + 1e-9 && best.time - prev >= gap - 1e-9;
    const time = ok ? best!.time : c;
    out.push({ original: c, time, shift: ok ? bestD : 0, beat: ok ? best!.index : null, kept: !ok });
    prev = time;
  }
  return out;
}

export interface AccentOptions {
  /** 切点秒（底鼓 + 气声 + 铺底压低） */
  readonly cuts?: readonly number[];
  /** 强调落点秒（拨弦），如大字落地 */
  readonly accents?: readonly number[];
  /** 拨弦音高（Hz），默认 880 */
  readonly accentHz?: number;
  /** 整体增益，默认 1 */
  readonly gain?: number;
  /** 切点后铺底压低深度 0–1，默认 0.35，恢复时间常数约 0.14s */
  readonly duck?: number;
  readonly seed?: number;
}

/** 原地叠加到 SynthResult，返回同一对象。 */
export function addCutAccents(bed: SynthResult, o: AccentOptions = {}): SynthResult {
  const { left, right, sampleRate: sr } = bed, n = left.length, g = o.gain ?? 1, rng = mulberry32(o.seed ?? 7);
  const duck = new Float32Array(n).fill(1), depth = o.duck ?? 0.35;
  for (const c of o.cuts ?? []) {
    const n0 = Math.round(c * sr); if (n0 < 0 || n0 >= n) continue;
    for (let i = 0; i < Math.round(0.45 * sr) && n0 + i < n; i++) { const d = 1 - depth * Math.exp(-(i / sr) * 7); if (d < (duck[n0 + i] as number)) duck[n0 + i] = d; }
  }
  for (let i = 0; i < n; i++) { left[i] = (left[i] as number) * (duck[i] as number); right[i] = (right[i] as number) * (duck[i] as number); }
  const add = (n0: number, len: number, f: (t: number) => number, pan = 0.5) => {
    for (let i = 0; i < len && n0 + i < n; i++) { if (n0 + i < 0) continue; const v = f(i / sr) * g; left[n0 + i] = (left[n0 + i] as number) + v * (1 - pan) * 2; right[n0 + i] = (right[n0 + i] as number) + v * pan * 2; }
  };
  for (const c of o.cuts ?? []) {
    const n0 = Math.round(c * sr); let ph = 0;
    add(n0, Math.round(0.6 * sr), (t) => { ph += 2 * Math.PI * (48 + 70 * Math.exp(-t * 28)) / sr; return Math.sin(ph) * Math.exp(-t * 7.5) * Math.min(1, t / 0.004) * 0.25; });
    let last = 0;
    add(n0, Math.round(0.09 * sr), (t) => { const x = rng() * 2 - 1, v = (x - last) * Math.exp(-t * 55) * 0.025; last = x; return v; }, 0.62);
  }
  const hz = o.accentHz ?? 880;
  for (const a of o.accents ?? []) {
    add(Math.round(a * sr), Math.round(1.6 * sr), (t) => (Math.sin(2 * Math.PI * hz * t) + 0.35 * Math.sin(2 * Math.PI * hz * 1.4983 * t) + 0.2 * Math.sin(4 * Math.PI * hz * t)) * Math.exp(-t * 3.2) * Math.min(1, t / 0.006) * 0.06, 0.4 + 0.2 * rng());
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  if (peak > 0.98) { const k = 0.98 / peak; for (let i = 0; i < n; i++) { left[i] = (left[i] as number) * k; right[i] = (right[i] as number) * k; } }
  return bed;
}
