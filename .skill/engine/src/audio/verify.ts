import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { sha256Text } from '../utils/hash.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import type { AudioTrack } from './types.ts';
import type { MeasuredNarration } from '../captions/track.ts';

export function timingSpecHash(spec: ResolvedVideoSpec): string { return sha256Text(JSON.stringify(spec)); }
/** Only consume engine timing metadata generated for this exact spec. */
export function readNarrationTimings(paths: readonly string[], spec: ResolvedVideoSpec): Map<number, MeasuredNarration> | undefined {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const report = JSON.parse(readFileSync(path, 'utf8'));
    if (report.specHash !== timingSpecHash(spec) || !Array.isArray(report.timings)) continue;
    const timings = new Map<number, MeasuredNarration>(report.timings);
    if (narrationTimingIssues(spec, timings).length === 0) return timings;
  }
  return undefined;
}

/** Continuous narration can span visual cuts; the next spoken line and video end bound it. */
export function narrationTimingIssues(spec: ResolvedVideoSpec, timings: ReadonlyMap<number, MeasuredNarration>): string[] {
  const issues: string[] = [];
  spec.audio.narration.forEach((line, i) => {
    const timing = timings.get(i);
    if (!timing || !Number.isFinite(timing.end) || timing.end <= timing.start) {
      issues.push(`NARRATION_MISSING: narration[${i}] 没有有效实测配音`); return;
    }
    const limit = Math.min(spec.video.duration, spec.audio.narration[i + 1]?.start ?? Infinity);
    if (timing.end > limit + 1 / spec.video.fps) {
      issues.push(`NARRATION_OVERRUN: narration[${i}] 实测结束 ${timing.end.toFixed(3)}s，窗口结束 ${limit.toFixed(3)}s；调整下一句起点或片尾后重新编译`);
    }
  });
  return issues;
}

const RATE = 8000;
function decodeMono(path: string): Float32Array {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-vn', '-ar', String(RATE), '-ac', '1', '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`AUDIO_VERIFY_FAILED: ${path}: ${result.error?.message ?? result.stderr.toString()}`);
  const data = result.stdout;
  const samples = new Float32Array(data.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readFloatLE(i * 4);
  return samples;
}

export interface VoicePresence { index: number; start: number; correlation: number; sourceRms: number; ok: boolean }
/** Waveform correlation checks voice presence in the mix/MP4, even with non-silent BGM.
 * This verifies signal routing, not pronunciation or semantic accuracy. */
export function verifyVoicePresence(path: string, voices: readonly AudioTrack[]): VoicePresence[] {
  if (!voices.length) return [];
  const mixed = decodeMono(path);
  return voices.map((voice, index) => {
    const decoded = decodeMono(voice.path);
    const source = decoded.subarray(Math.round((voice.sourceStartSample ?? 0) * RATE / 48000),
      voice.sourceEndSample === undefined ? decoded.length : Math.round(voice.sourceEndSample * RATE / 48000));
    const length = Math.min(source.length, Math.round(voice.sourceDuration * RATE));
    let energy = 0;
    for (let i = 0; i < length; i++) energy += source[i]! ** 2;
    const sourceRms = Math.sqrt(energy / Math.max(1, length));
    let correlation = 0;
    const start = Math.round(voice.start * RATE);
    // Allow 10 ms encoder/resampler alignment error, while keeping the cue placement fixed.
    for (let lag = -80; lag <= 80; lag += 4) {
      let cross = 0, srcEnergy = 0, mixEnergy = 0;
      for (let i = 0; i < length; i += 4) {
        const x = source[i]!, j = start + lag + i;
        if (Math.abs(x) < sourceRms * 0.25 || j < 0 || j >= mixed.length) continue;
        const y = mixed[j]!;
        cross += x * y; srcEnergy += x * x; mixEnergy += y * y;
      }
      correlation = Math.max(correlation, cross / Math.sqrt(srcEnergy * mixEnergy || 1));
    }
    return { index, start: voice.start, correlation, sourceRms, ok: sourceRms > 0.0001 && correlation >= 0.15 };
  });
}
