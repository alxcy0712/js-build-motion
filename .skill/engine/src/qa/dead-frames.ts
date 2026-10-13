/**
 * 死帧检测：找出画面在 ≥ minSeconds 内“看起来没动”的区间。
 * - 比较 frame[i] 与 frame[i + window]（window = minSeconds），而非相邻帧：慢推镜每帧只动 0.04px，相邻帧比较会误报。
 * - 先做 block 均值降采样抹掉颗粒（颗粒是逐像素独立噪声，块平均后幅度按 1/block 衰减）。
 * - 指标取块差的高分位（默认 p99.9）减去 5×噪声底，对“大面积黑底+少量文字”的画面也敏感，不被均值稀释。
 * - 噪声底取**相邻帧**差的中位数：颗粒逐帧独立，相邻帧与隔 0.5s 的帧噪声幅度相同；而真实运动在相邻帧之间只有窗口的
 *   1/15 左右（窗口两端各取一对，取较小者，避免硬切抬高噪声底）。早期版本用窗口差自身的中位数，整屏运动（素材推拉、全屏摇镜）会把中位数抬高到与高分位相当，被误判为死帧。
 */
export interface GrayFrame { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray | Float32Array }
export interface DeadFrameOptions {
  readonly fps: number;
  readonly minSeconds?: number;   // 默认 0.5
  readonly threshold?: number;    // 0–255 灰度单位，默认 1.5
  readonly block?: number;        // 默认 4
  readonly percentile?: number;   // 默认 0.999
  readonly noiseK?: number;       // 噪声底倍数，默认 5
}
export interface DeadSpan { readonly startFrame: number; readonly endFrame: number; readonly startSec: number; readonly endSec: number; readonly maxScore: number }

export function blockAverage(f: GrayFrame, block: number): GrayFrame {
  const w = Math.floor(f.width / block), h = Math.floor(f.height / block), out = new Float32Array(w * h), n = block * block;
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
    let s = 0;
    for (let y = 0; y < block; y++) { const row = (by * block + y) * f.width + bx * block; for (let x = 0; x < block; x++) s += f.data[row + x]!; }
    out[by * w + bx] = s / n;
  }
  return { width: w, height: h, data: out };
}
function median(a: GrayFrame, b: GrayFrame): number {
  const d = new Float32Array(a.data.length);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(a.data[i]! - b.data[i]!);
  d.sort(); return d[Math.floor(d.length / 2)]!;
}
/**
 * @param noiseFloor 噪声底；缺省时用 a/b 差值的中位数（只适合整体静止、仅含颗粒的画面）
 */
export function frameScore(a: GrayFrame, b: GrayFrame, percentile = 0.999, noiseK = 5, noiseFloor?: number): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('DEAD_FRAME_SIZE: 帧尺寸不一致');
  const d = new Float32Array(a.data.length);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(a.data[i]! - b.data[i]!);
  d.sort();
  // 颗粒是空间白噪声，会抬高所有块的差值；用中位数估计噪声底并扣除（|N(0,σ)| 的 p99.9≈3.3σ，中位数≈0.67σ，5×中位数≈3.4σ）
  const hi = d[Math.min(d.length - 1, Math.floor(percentile * d.length))]!;
  const floor = noiseFloor ?? d[Math.floor(d.length / 2)]!;
  return Math.max(0, hi - noiseK * floor);
}
/** 返回每个起点 i 的窗口分数（frame i 对 frame i+window）。 */
export function windowScores(frames: readonly GrayFrame[], o: DeadFrameOptions): number[] {
  const win = Math.max(1, Math.round((o.minSeconds ?? 0.5) * o.fps));
  const small = frames.map((f) => blockAverage(f, o.block ?? 4));
  // 窗口两端各取一个相邻帧对，取较小者：硬切恰好落在一端时，另一端仍给出真实的颗粒噪声底
  const adj = small.slice(0, -1).map((f, i) => median(f, small[i + 1]!));
  const scores: number[] = [];
  for (let i = 0; i + win < small.length; i++) scores.push(frameScore(small[i]!, small[i + win]!, o.percentile, o.noiseK, Math.min(adj[i]!, adj[i + win - 1]!)));
  return scores;
}
export function findDeadSpans(frames: readonly GrayFrame[], o: DeadFrameOptions): DeadSpan[] {
  const win = Math.max(1, Math.round((o.minSeconds ?? 0.5) * o.fps)), th = o.threshold ?? 1.5;
  const scores = windowScores(frames, o), spans: DeadSpan[] = [];
  let start = -1, peak = 0;
  const close = (endIdx: number) => {
    const endFrame = endIdx + win; // 最后一个“静止窗口”的终点帧
    spans.push({ startFrame: start, endFrame, startSec: start / o.fps, endSec: endFrame / o.fps, maxScore: peak });
    start = -1; peak = 0;
  };
  scores.forEach((s, i) => {
    if (s < th) { if (start < 0) start = i; peak = Math.max(peak, s); }
    else if (start >= 0) close(i - 1);
  });
  if (start >= 0) close(scores.length - 1);
  return spans;
}
