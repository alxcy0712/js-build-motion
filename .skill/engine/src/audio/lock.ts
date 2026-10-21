import { stableStringify as canonical } from '../utils/json.ts';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Ajv } from 'ajv';
import type { BuildAudioResult } from './build.ts';
import { probeAudio } from './probe.ts';
import { DEFAULT_DUCK, type AudioTimeline } from './types.ts';
import { narrationTimingIssues, timingSpecHash } from './verify.ts';
import type { MeasuredNarration } from '../captions/track.ts';
import { resolveInsideProject } from '../project/manifest.ts';
import { assertContained } from '../project/paths.ts';
import { SPEC_DEFAULTS, type ResolvedVideoSpec } from '../spec/types.ts';
import { sha256File, sha256Text } from '../utils/hash.ts';

interface LockedMedia extends Awaited<ReturnType<typeof probeAudio>> { path: string; sha256: string }
interface SourceAsset { path: string; sha256: string }
interface AudioLock {
  version: '0.1';
  contentSha256: string;
  signatures: { content: string; placement: string };
  timeline: AudioTimeline;
  media: LockedMedia[];
  timings: [number, MeasuredNarration][];
  warnings: string[];
  sourceProviders: BuildAudioResult['providerInfo'];
  sourceAssets: SourceAsset[];
  measuredLoudness: BuildAudioResult['measuredLoudness'];
}

const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const seconds = { type: 'number', minimum: 0 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const mediaPath = { type: 'string', pattern: '^(master|track-[0-9]+)\\.wav$' };
const timingSchema = object({ start: seconds, end: seconds, words: { type: 'array', items: object({ text: { type: 'string', minLength: 1 }, start: seconds, end: seconds }) } }, ['start', 'end']);
const validate = new Ajv({ allErrors: true }).compile({ $id: 'js-build-motion/audio-lock@0.1', $schema: 'http://json-schema.org/draft-07/schema#', ...object({
  version: { const: '0.1' }, contentSha256: hash,
  signatures: object({ content: hash, placement: hash }),
  timeline: object({
    tracks: { type: 'array', minItems: 1, items: object({
      kind: { enum: ['voice', 'bgm', 'sfx'] }, path: mediaPath, start: seconds, gain: seconds,
      sourceDuration: { type: 'number', exclusiveMinimum: 0 }, fadeIn: seconds, fadeOut: seconds, duckUnderVoice: { type: 'boolean' },
    }, ['kind', 'path', 'start', 'gain', 'sourceDuration']) },
    durationSeconds: { type: 'number', exclusiveMinimum: 0 }, loudnessLufs: { type: 'number' }, truePeakDb: { type: 'number' },
    masterPath: { const: 'master.wav' }, masterSampleRate: { const: 48000 },
  }),
  media: { type: 'array', minItems: 2, items: object({
    path: mediaPath, sha256: hash, sampleRate: { type: 'integer', minimum: 1 }, durationSamples: { type: 'integer', minimum: 1 },
    durationSeconds: { type: 'number', exclusiveMinimum: 0 }, containerDurationSeconds: { type: 'number', exclusiveMinimum: 0 },
  }) },
  timings: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: [{ type: 'integer', minimum: 0 }, timingSchema], additionalItems: false } },
  warnings: { type: 'array', items: { type: 'string' } },
  sourceProviders: object({ tts: { enum: ['edge', 'doubao', 'file', 'mock', '(none)'] }, bgm: { enum: ['procedural', 'file', '(none)'] }, sfx: { enum: ['procedural', '(none)'] } }),
  sourceAssets: { type: 'array', items: object({ path: { type: 'string', pattern: '^(assets|inputs)/[^\\\\]+$' }, sha256: hash }) },
  measuredLoudness: object(Object.fromEntries(['inputIntegratedLufs', 'inputTruePeakDbtp', 'inputLra', 'targetOffset'].map(key => [key, { type: ['number', 'null'] }]))),
}) });

function fail(message: string): never { throw new Error(`AUDIO_LOCK_INVALID: ${message}`); }
function contentHash(lock: Omit<AudioLock, 'contentSha256'> | AudioLock): string {
  const { contentSha256: _hash, ...content } = lock as AudioLock;
  return sha256Text(canonical(content));
}

/** These signatures cover sound synthesis and placement, independently of visual changes. */
export function audioLockSignatures(spec: ResolvedVideoSpec): AudioLock['signatures'] {
  const { narration, bgm, sfx, loudness } = spec.audio;
  return {
    content: sha256Text(canonical({ seed: spec.video.seed, narration: narration.map(line => ({ text: line.text, voice: line.voice, rate: line.rate ?? SPEC_DEFAULTS.narrationRate })), bgm: { preset: bgm.preset, key: bgm.key ?? 'C', bpm: bgm.bpm }, sfx: sfx.map(cue => cue.preset) })),
    placement: sha256Text(canonical({ duration: spec.video.duration, narration: narration.map(line => line.start), bgm: { volume: bgm.volume, fadeIn: bgm.fadeIn, fadeOut: bgm.fadeOut, duckUnderNarration: bgm.duckUnderNarration }, sfx: sfx.map(cue => ({ start: cue.start, volume: cue.volume })), loudness, duck: DEFAULT_DUCK, masterSampleRate: 48000, truePeakDb: -1.5 })),
  };
}

function independentPath(projectDir: string, path: string, file: boolean): string {
  const abs = isAbsolute(path) ? assertContained(projectDir, path) : resolveInsideProject(projectDir, path, 'audio lock');
  const root = resolve(projectDir);
  const parts = relative(root, abs).split(sep);
  let current = root;
  for (const part of ['', ...parts]) {
    current = part ? join(current, part) : current;
    if (!existsSync(current)) break;
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail('锁包和音频路径禁止软链接');
  }
  if (file) {
    const info = lstatSync(abs);
    if (!info.isFile() || info.nlink !== 1) fail('锁包和音频必须是普通独立文件');
  }
  return abs;
}

function sourceAsset(projectDir: string, path: string): SourceAsset {
  if (!isAbsolute(path) && (path.includes('\\') || path.split('/').includes('..'))) fail('源素材路径必须规范化');
  const abs = independentPath(projectDir, path, true);
  const rel = relative(resolve(projectDir), abs).split(sep).join('/');
  if (!/^(assets|inputs)\//.test(rel) || rel.split('/').includes('..')) fail('源素材必须位于本片 assets/ 或 inputs/');
  return { path: rel, sha256: sha256File(abs) };
}

function validateRelations(lock: AudioLock, spec: ResolvedVideoSpec): Map<number, MeasuredNarration> {
  if (!validate(lock)) fail(`锁包 schema 不合法：${JSON.stringify(validate.errors)}`);
  const expected = audioLockSignatures(spec);
  if (lock.signatures.content !== expected.content || lock.signatures.placement !== expected.placement) fail('声音内容或排布已变化，请重新定稿声音');
  const timeline = lock.timeline;
  if (timeline.durationSeconds !== spec.video.duration || timeline.loudnessLufs !== spec.audio.loudness || timeline.truePeakDb !== -1.5) fail('混音参数与当前声音规格不一致');
  const files = new Map(lock.media.map(item => [item.path, item]));
  const paths = [timeline.masterPath, ...timeline.tracks.map(track => track.path)];
  if (files.size !== lock.media.length || new Set(paths).size !== paths.length || files.size !== paths.length || paths.some(path => !files.has(path))) fail('媒体引用必须完整且唯一');
  for (const track of timeline.tracks) if (track.sourceDuration > files.get(track.path)!.durationSeconds + 0.05) fail('音轨超出实际文件时长');
  const voices = timeline.tracks.filter(track => track.kind === 'voice');
  if (voices.length !== spec.audio.narration.length) fail('旁白音轨与脚本条数不一致');
  if (voices.length && ['mock', '(none)'].includes(lock.sourceProviders.tts)) fail('正式声音锁需要真实配音来源');
  if (lock.sourceProviders.tts === 'file' && voices.length > 1) fail('file 正式制作仅支持单条预制旁白');
  if (lock.sourceProviders.tts === 'file') for (const voice of voices) {
    const media = files.get(voice.path)!;
    if (Math.abs(voice.sourceDuration - media.durationSeconds) > 1 / media.sampleRate + 1e-9) fail('file 旁白实测时长必须覆盖完整解码样本');
  }
  if ((lock.sourceProviders.tts === 'file' || lock.sourceProviders.bgm === 'file') && !lock.sourceAssets.length) fail('文件提供方需要原始素材 hash');
  const sourceHashes = new Set(lock.sourceAssets.map(source => source.sha256));
  for (const track of timeline.tracks) {
    if (((track.kind === 'voice' && lock.sourceProviders.tts === 'file') || (track.kind === 'bgm' && lock.sourceProviders.bgm === 'file')) && !sourceHashes.has(files.get(track.path)!.sha256)) fail('文件声轨字节未匹配已登记的原始素材 hash');
  }
  const bgm = timeline.tracks.filter(track => track.kind === 'bgm');
  if (bgm.length !== (spec.audio.bgm.volume > 0 ? 1 : 0)) fail('音乐音轨与声音规格不一致');
  if (bgm.some(track => track.start !== 0 || track.gain !== spec.audio.bgm.volume || track.fadeIn !== spec.audio.bgm.fadeIn || track.fadeOut !== spec.audio.bgm.fadeOut || track.duckUnderVoice !== spec.audio.bgm.duckUnderNarration)) fail('音乐混音排布不一致');
  const sfx = timeline.tracks.filter(track => track.kind === 'sfx');
  const cues = spec.audio.sfx.filter(cue => cue.volume > 0 && spec.video.duration - cue.start > 0.05);
  if (sfx.length !== cues.length || sfx.some((track, i) => track.start !== cues[i]!.start || track.gain !== cues[i]!.volume)) fail('音效音轨与声音规格不一致');
  const timings = new Map(lock.timings);
  if (timings.size !== lock.timings.length || timings.size !== voices.length) fail('旁白 timing 引用不完整或重复');
  spec.audio.narration.forEach((line, i) => {
    const timing = timings.get(i), voice = voices[i]!;
    if (!timing || voice.start !== line.start || voice.gain !== 1 || timing.start !== line.start || Math.abs(timing.end - timing.start - voice.sourceDuration) > 0.001) fail(`旁白 ${i} 的放置或实测 timing 不一致`);
    for (const word of timing.words ?? []) if (word.start < timing.start || word.end <= word.start || word.end > timing.end + 0.001) fail(`旁白 ${i} 的词时超出范围`);
  });
  const issues = narrationTimingIssues(spec, timings);
  if (issues.length) fail(issues.join('\n'));
  const master = files.get('master.wav')!;
  if (master.sampleRate !== 48000 || Math.abs(master.durationSeconds - spec.video.duration) > 1 / 48000) fail('混音 master 实测片长或采样率不一致');
  return timings;
}

export interface AudioLockUsage {
  path: string;
  sha256: string;
  /** Absolute paths are returned only to the local caller for input snapshots. */
  mediaFiles: { path: string; sha256: string; role: string }[];
}
export interface LoadedAudioLock {
  audio: BuildAudioResult;
  timingReport: { specHash: string; timings: [number, MeasuredNarration][]; issues: string[] };
  provenance: { sourceProviders: BuildAudioResult['providerInfo']; sourceAssets: readonly SourceAsset[] };
  usage: AudioLockUsage;
}

/** Promote verified work files into a content-addressed input package. */
export async function createAudioLock(options: { projectDir: string; spec: ResolvedVideoSpec; audio: BuildAudioResult; sourceAssets?: readonly string[] }): Promise<{ path: string; lockId: string; sha256: string }> {
  const { projectDir, spec, audio } = options;
  if (audio.masterPath !== audio.timeline.masterPath || audio.durationSeconds !== spec.video.duration) fail('声音结果的 master 或片长不一致');
  const targetRoot = independentPath(projectDir, 'assets/derived/audio', false);
  const temporary = independentPath(projectDir, join('out/.tmp', `audio-lock-${randomUUID()}`), false);
  const sourceAssets = (options.sourceAssets ?? []).map(path => sourceAsset(projectDir, path));
  mkdirSync(temporary, { recursive: true });
  try {
    const media: LockedMedia[] = [];
    const sourcePaths = [audio.masterPath, ...audio.timeline.tracks.map(track => track.path)];
    for (let i = 0; i < sourcePaths.length; i++) {
      const source = independentPath(projectDir, sourcePaths[i]!, true);
      const name = i === 0 ? 'master.wav' : `track-${i - 1}.wav`;
      const sha256 = sha256File(source);
      const destination = join(temporary, name);
      copyFileSync(source, destination);
      if (sha256File(destination) !== sha256) fail('音频复制后的 hash 不一致');
      media.push({ path: name, sha256, ...await probeAudio(destination) });
      if (sha256File(source) !== sha256 || sha256File(destination) !== sha256) fail('音频在定稿过程中变化');
    }
    const content: Omit<AudioLock, 'contentSha256'> = {
      version: '0.1', signatures: audioLockSignatures(spec),
      timeline: { ...audio.timeline, masterPath: 'master.wav', tracks: audio.timeline.tracks.map((track, i) => ({ ...track, path: `track-${i}.wav` })) },
      media, timings: [...audio.captionTimings], warnings: audio.warnings.map(warning => warning.replaceAll(resolve(projectDir), '.')),
      sourceProviders: audio.providerInfo, sourceAssets, measuredLoudness: audio.measuredLoudness,
    };
    const lock: AudioLock = { ...content, contentSha256: contentHash(content) };
    validateRelations(lock, spec);
    for (const source of sourceAssets) if (sourceAsset(projectDir, source.path).sha256 !== source.sha256) fail('源素材在定稿过程中变化');
    writeFileSync(join(temporary, 'audio-lock.json'), canonical(lock) + '\n');
    const destination = join(targetRoot, lock.contentSha256);
    const path = relative(resolve(projectDir), join(destination, 'audio-lock.json')).split(sep).join('/');
    mkdirSync(targetRoot, { recursive: true });
    if (existsSync(destination)) await loadAudioLock({ projectDir, path, spec });
    else renameSync(temporary, destination);
    return { path, lockId: lock.contentSha256, sha256: sha256File(join(destination, 'audio-lock.json')) };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Verify stored files, then rebind their timings to the current visual spec. */
export async function loadAudioLock(options: { projectDir: string; path: string; spec: ResolvedVideoSpec }): Promise<LoadedAudioLock> {
  const { projectDir, path, spec } = options;
  if (!/^assets\/derived\/audio\/[a-f0-9]{64}\/audio-lock\.json$/.test(path)) fail('请使用本片 assets/derived/audio 下的声音锁相对路径');
  const manifest = independentPath(projectDir, path, true);
  const manifestHash = sha256File(manifest);
  const manifestText = readFileSync(manifest, 'utf8');
  const lock = JSON.parse(manifestText) as AudioLock;
  const timings = validateRelations(lock, spec);
  if (contentHash(lock) !== lock.contentSha256 || basename(dirname(manifest)) !== lock.contentSha256 || manifestText !== canonical(lock) + '\n') fail('锁包 metadata 的内容身份已变化');
  const mediaFiles: AudioLockUsage['mediaFiles'] = [{ path: manifest, sha256: manifestHash, role: 'audio-lock' }];
  for (const item of lock.media) {
    const file = independentPath(projectDir, join(dirname(manifest), item.path), true);
    if (sha256File(file) !== item.sha256) fail(`锁包音频 hash 已变化：${item.path}`);
    const measured = await probeAudio(file);
    if (measured.sampleRate !== item.sampleRate || measured.durationSamples !== item.durationSamples || measured.durationSeconds !== item.durationSeconds || measured.containerDurationSeconds !== item.containerDurationSeconds) fail(`锁包实测音频属性已变化：${item.path}`);
    if (sha256File(file) !== item.sha256) fail('音频在验证过程中变化');
    mediaFiles.push({ path: file, sha256: item.sha256, role: item.path === 'master.wav' ? 'audio-master' : 'audio-track' });
  }
  for (const item of lock.sourceAssets) {
    if (sourceAsset(projectDir, item.path).sha256 !== item.sha256) fail(`原声音素材 hash 已变化：${item.path}`);
    mediaFiles.push({ path: resolveInsideProject(projectDir, item.path, 'audio source'), sha256: item.sha256, role: 'audio-source' });
  }
  if (sha256File(manifest) !== manifestHash) fail('锁包 metadata 在验证过程中变化');
  const timeline: AudioTimeline = { ...lock.timeline, masterPath: join(dirname(manifest), lock.timeline.masterPath), tracks: lock.timeline.tracks.map(track => ({ ...track, path: join(dirname(manifest), track.path) })) };
  return {
    audio: { masterPath: timeline.masterPath, durationSeconds: timeline.durationSeconds, timeline, captionTimings: timings, warnings: lock.warnings, providerInfo: { tts: '(none)', bgm: '(none)', sfx: '(none)' }, mix: { masterPath: timeline.masterPath, durationSeconds: timeline.durationSeconds, elapsedMs: 0, stderrTail: [] }, measuredLoudness: lock.measuredLoudness },
    timingReport: { specHash: timingSpecHash(spec), timings: [...timings], issues: [] },
    provenance: { sourceProviders: lock.sourceProviders, sourceAssets: lock.sourceAssets },
    usage: { path, sha256: manifestHash, mediaFiles },
  };
}
