import { spawn } from 'node:child_process';
import { probeMedia } from '../ffmpeg/encoder.ts';

export interface ProbedAudio {
  readonly sampleRate: number;
  /** Decoded sample frames in the first audio stream, at its original sample rate. */
  readonly durationSamples: number;
  readonly durationSeconds: number;
  readonly containerDurationSeconds: number;
}

/** Decode without changing the source; container duration does not determine PCM length. */
export async function probeAudio(path: string): Promise<ProbedAudio> {
  try {
    const media = probeMedia(path);
    const sampleRate = media.audio?.sampleRate;
    if (!sampleRate || !Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('缺少有效音轨或采样率');
    const child = spawn('ffmpeg', [
      '-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:a:0', '-vn',
      '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    done.catch(() => {});
    let bytes = 0, error = '';
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    try {
      for await (const chunk of child.stdout) bytes += chunk.length;
      if (await done !== 0 || error.trim()) throw new Error(error.trim() || '音频解码失败');
      const durationSamples = bytes / 2;
      if (!Number.isSafeInteger(durationSamples) || durationSamples <= 0) throw new Error('没有有效的解码样本');
      return { sampleRate, durationSamples, durationSeconds: durationSamples / sampleRate, containerDurationSeconds: media.durationSeconds };
    } finally { if (child.exitCode === null) child.kill(); }
  } catch (error) {
    throw new Error(`AUDIO_PROBE_FAILED: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
