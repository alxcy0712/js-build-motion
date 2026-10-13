import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProductionBundle } from '../project/production.ts';
import type { CompiledProductionTimeline } from '../project/production-timeline.ts';
import type { PreparedAssetPlan } from '../application/asset-plan.ts';
import { readAssetFile } from '../application/asset-plan.ts';
import type { AssetFileIdentity } from '../project/asset-plan.ts';
import type { MeasuredNarration } from '../captions/track.ts';
import { probeAudio } from './probe.ts';
import { mixAudio, measureLoudness, type MixResult } from './mixer.ts';
import type { AudioTimeline, AudioTrack } from './types.ts';
import { timingSpecHash } from './verify.ts';

export interface ProductionAudioResult {
  masterPath: string | undefined;
  durationSeconds: number;
  timeline: AudioTimeline;
  captionTimings: Map<number, MeasuredNarration>;
  warnings: string[];
  providerInfo: { tts: string; bgm: string; sfx: string };
  mix: MixResult | undefined;
  measuredLoudness: ReturnType<typeof measureLoudness>;
  sources: (AssetFileIdentity & { role: string })[];
  consumedAssets: { path: string; absPath: string; sha256: string; role: string }[];
}

/** Fixed take content and a single clip placement drive the existing mixer. */
export async function buildProductionAudio(projectDir: string, bundle: ProductionBundle, compiled: CompiledProductionTimeline,
  outDir: string, prepared?: PreparedAssetPlan | null): Promise<ProductionAudioResult> {
  if (!compiled.spec || compiled.conflicts.some(c => c.severity === 'hard')) throw Error('PRODUCTION_AUDIO_TIMELINE_INVALID');
  const tracks: AudioTrack[] = [], sources: ProductionAudioResult['sources'] = [], verified = new Map<string, AssetFileIdentity>();
  const fixed = async (file: AssetFileIdentity, samples: number, role: string) => {
    const key = `${file.path}:${file.bytes}:${file.sha256}:${samples}`;
    if (!verified.has(key)) {
      await readAssetFile(projectDir, file.path, file.bytes, file, { retain: false });
      const measured = await probeAudio(join(projectDir, file.path));
      if (measured.sampleRate !== 48000 || measured.durationSamples !== samples) throw Error('PRODUCTION_AUDIO_SAMPLE_FACT_CHANGED: ' + file.path);
      await readAssetFile(projectDir, file.path, file.bytes, file, { retain: false });
      verified.set(key, file);
    }
    if (!sources.some(source => source.path === file.path && source.role === role)) sources.push({ ...file, role });
    return join(projectDir, file.path);
  };
  for (const placement of compiled.audioPlacements) {
    if (placement.mute || placement.gain === 0) continue;
    const path = await fixed(placement.file, placement.durationSamples, `${placement.kind}-source`);
    tracks.push({ kind: placement.kind, path, start: placement.startSample / 48000, startSample: placement.startSample,
      gain: placement.gain, sourceDuration: (placement.outSample - placement.inSample) / 48000,
      sourceStartSample: placement.inSample, sourceEndSample: placement.outSample, duckUnderVoice: false });
  }
  for (const clip of compiled.clips) {
    const binding = prepared?.bindings.find(binding => binding.use.useId === clip.useId);
    if (!binding) throw Error('PRODUCTION_CLIP_ASSET_UNAVAILABLE: ' + clip.useId);
    if (!binding.video || clip.mute || clip.gain === 0 || binding.use.mute || bundle.requirements.effective.originalAudio === 'mute') continue;
    const map = binding.video;
    if (map.version !== '0.2' || map.coverage.audio === 'muted') throw Error('PRODUCTION_ORIGINAL_AUDIO_UNAVAILABLE: prepare this selected range with video request 0.2 and mute=false.');
    if (!map.audio) continue;
    if (map.canonical.fps !== compiled.spec.video.fps) throw Error('PRODUCTION_CLIP_RATE_INVALID: ' + clip.placementId);
    const samplesPerFrame = 48000 / map.canonical.fps;
    if (clip.sourceEndSample > map.audio.samples && (clip.sourceEndSample !== map.canonical.frames * samplesPerFrame ||
      clip.sourceEndSample - map.audio.samples >= samplesPerFrame)) throw Error('PRODUCTION_ORIGINAL_AUDIO_RANGE_INVALID: ' + clip.placementId);
    const end = Math.min(clip.sourceEndSample, map.audio.samples);
    if (clip.sourceStartSample >= end) throw Error('PRODUCTION_ORIGINAL_AUDIO_RANGE_INVALID: ' + clip.placementId);
    const path = await fixed(map.audio, map.audio.samples, 'original-source');
    tracks.push({ kind: 'original', path, start: clip.startSample / 48000, startSample: clip.startSample,
      gain: clip.gain, sourceDuration: (end - clip.sourceStartSample) / 48000,
      sourceStartSample: clip.sourceStartSample, sourceEndSample: end, duckUnderVoice: false });
  }
  const durationSeconds = compiled.durationSamples / 48000;
  const timeline: AudioTimeline = { tracks, durationSeconds, loudnessLufs: compiled.spec.audio.loudness, truePeakDb: -1.5,
    masterPath: join(outDir, 'master.wav'), masterSampleRate: 48000 };
  mkdirSync(outDir, { recursive: true });
  const captionTimings = new Map(compiled.narrationTimings);
  writeFileSync(join(outDir, 'narration-timing.json'), JSON.stringify({ specHash: timingSpecHash(compiled.spec), timings: [...captionTimings], sourceHash: compiled.identity, issues: [] }, null, 2) + '\n');
  const mix = tracks.length ? mixAudio(timeline) : undefined;
  if (!mix) rmSync(timeline.masterPath, { force: true });
  if (mix) {
    const measured = await probeAudio(timeline.masterPath);
    if (measured.sampleRate !== 48000 || measured.durationSamples !== compiled.durationSamples) throw Error('PRODUCTION_MASTER_SAMPLE_COUNT_INVALID');
  }
  for (const file of verified.values()) await readAssetFile(projectDir, file.path, file.bytes, file, { retain: false });
  return { masterPath: mix ? timeline.masterPath : undefined, durationSeconds, timeline, captionTimings, warnings: [], mix,
    providerInfo: { tts: tracks.some(t => t.kind === 'voice') ? 'file' : '(none)', bgm: tracks.some(t => t.kind === 'bgm') ? 'file' : '(none)', sfx: tracks.some(t => t.kind === 'sfx') ? 'file' : '(none)' },
    measuredLoudness: mix ? measureLoudness(timeline.masterPath, timeline.loudnessLufs) : { inputIntegratedLufs: null, inputTruePeakDbtp: null, inputLra: null, targetOffset: null },
    sources, consumedAssets: sources.map(file => ({ path: file.path, absPath: join(projectDir, file.path), sha256: file.sha256, role: file.role })) };
}
