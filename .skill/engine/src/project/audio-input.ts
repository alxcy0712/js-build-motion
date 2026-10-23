import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { UUID_PATTERN } from './unpack.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import type { NativeToolIdentity } from './ocr.ts';
import type { ToolRun } from './catalog.ts';

export const AUDIO_INPUT_MAPPER_VERSION = 'audio-input@0.1';
export const DEFAULT_AUDIO_INPUT_LIMITS = Object.freeze({ maxSourceBytes: 67108864, maxRiffChunks: 4096,
  maxStructureEntries: 32768, maxPackets: 12000, minSamples: 3200, maxSamples: 1920000,
  maxPcmBytes: 11520000, maxAudioBytes: 3840044, maxMapBytes: 4194304, maxAudiosPerAttempt: 4,
  maxToolElapsedMs: 30000, concurrency: 1 });
export type AudioInputLimits = { [K in keyof typeof DEFAULT_AUDIO_INPUT_LIMITS]: number };
export interface AudioInputFacts { version: '0.1'; kind: 'audio-input-facts'; format: 'wav' | 'mp3' | 'flac' | 'm4a';
  demuxer: 'wav' | 'mp3' | 'flac' | 'mov'; codec: 'pcm_s16le' | 'mp3' | 'flac' | 'aac'; sampleRate: number;
  channels: 1 | 2; bitsPerSample: 16 | null; samples: number; sampleDomain: 'complete-decoded-frames';
  codedFrames: number | null; metadataFrames: number; payloadBytes: number;
  gapless: { delaySamples: number; paddingSamples: number } | null;
  edit: { mediaTime: number; segmentDuration: number; movieTimescale: number } | null }
export interface AudioInputRuntimeIdentity { id: 'bounded-audio-input'; version: '0.1'; lockSha256: string;
  platform: 'darwin' | 'linux'; arch: 'arm64' | 'x64'; tools: { ffmpeg: NativeToolIdentity; ffprobe: NativeToolIdentity } }
export interface AudioInputEvidenceIdentity { evidenceId: string; bytes: number; sha256: string }
export interface AudioInputMap { version: '0.1'; kind: 'audio-input-map'; mapperVersion: 'audio-input@0.1';
  policySha256: string; source: { bytes: number; sha256: string }; input: AudioInputFacts; runtime: AudioInputRuntimeIdentity;
  probe: AudioInputEvidenceIdentity; sourcePcm: AudioInputEvidenceIdentity & { sampleRate: number; samples: number };
  audio: AudioInputEvidenceIdentity & { payloadBytes: number; sampleRate: 16000; samples: number };
  commands: { probe: ToolRun; decode: ToolRun; normalize: ToolRun }; cwd: string;
  coverage: { scope: 'complete-decoded-frames'; complete: true; start: 0; end: number; presentationMapping: 'unknown' } }
export interface AudioInputDescriptor { version: '0.1'; status: 'completed' | 'skipped' | 'failed'; reason: string;
  scope: 'bounded-input-audio'; probeEvidenceId: string | null; pcmEvidenceId: string | null;
  audioEvidenceId: string | null; mapEvidenceId: string | null; runtime: AudioInputRuntimeIdentity | null }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
const evidenceId = { ...string, pattern: `^evidence-${UUID_PATTERN}$` };
const nativeFile = object({ path: nonempty, bytes: positive, sha256: hash });
const nativeTool = object({ executable: nonempty, version: nonempty, files: { ...array(nativeFile), minItems: 1, maxItems: 256 },
  aliases: { ...array(object({ path: nonempty, realpath: nonempty })), minItems: 1, maxItems: 512 } });
const runtime = object({ id: { const: 'bounded-audio-input' }, version: { const: '0.1' }, lockSha256: hash,
  platform: { enum: ['darwin', 'linux'] }, arch: { enum: ['arm64', 'x64'] }, tools: object({ ffmpeg: nativeTool, ffprobe: nativeTool }) });
export const AUDIO_INPUT_POLICY_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_AUDIO_INPUT_LIMITS).map(([key, maximum]) =>
  [key, key === 'minSamples' || key === 'concurrency' ? { const: maximum } : { ...positive, maximum }])));
const facts = object({ version: { const: '0.1' }, kind: { const: 'audio-input-facts' }, format: { enum: ['wav', 'mp3', 'flac', 'm4a'] },
  demuxer: { enum: ['wav', 'mp3', 'flac', 'mov'] }, codec: { enum: ['pcm_s16le', 'mp3', 'flac', 'aac'] },
  sampleRate: { ...integer, minimum: 8000, maximum: 48000 }, channels: { enum: [1, 2] }, bitsPerSample: nullable({ const: 16 }),
  samples: positive, sampleDomain: { const: 'complete-decoded-frames' }, codedFrames: nullable(positive), metadataFrames: integer,
  payloadBytes: positive, gapless: nullable(object({ delaySamples: integer, paddingSamples: integer })),
  edit: nullable(object({ mediaTime: integer, segmentDuration: positive, movieTimescale: positive })) });
const identity = object({ evidenceId, bytes: integer, sha256: hash });
const tool = object({ executable: nonempty, version: nonempty, argv: array(string), exitCode: nullable({ type: 'integer' }),
  signal: nullable(nonempty), stdout: string, stderr: string, stdoutBytes: integer, stderrBytes: integer, binaryBytes: integer, elapsedMs: integer, error: nullable(nonempty) });
const map = object({ version: { const: '0.1' }, kind: { const: 'audio-input-map' }, mapperVersion: { const: AUDIO_INPUT_MAPPER_VERSION },
  policySha256: hash, source: object({ bytes: positive, sha256: hash }), input: facts, runtime, probe: identity,
  sourcePcm: object({ ...identity.properties, sampleRate: positive, samples: positive }),
  audio: object({ ...identity.properties, payloadBytes: positive, sampleRate: { const: 16000 }, samples: positive }),
  commands: object({ probe: tool, decode: tool, normalize: tool }), cwd: nonempty,
  coverage: object({ scope: { const: 'complete-decoded-frames' }, complete: { const: true }, start: { const: 0 }, end: positive, presentationMapping: { const: 'unknown' } }) });
export const AUDIO_INPUT_DESCRIPTOR_SCHEMA = object({ version: { const: '0.1' }, status: { enum: ['completed', 'skipped', 'failed'] }, reason: string,
  scope: { const: 'bounded-input-audio' }, probeEvidenceId: nullable(evidenceId), pcmEvidenceId: nullable(evidenceId),
  audioEvidenceId: nullable(evidenceId), mapEvidenceId: nullable(evidenceId), runtime: nullable(runtime) });
export const AUDIO_INPUT_SCHEMAS = { facts, runtime, map, policy: AUDIO_INPUT_POLICY_SCHEMA };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(AUDIO_INPUT_SCHEMAS).map(([key, value]) => [key, ajv.compile(value as Schema)]));
export function assertAudioInput<T>(kind: keyof typeof AUDIO_INPUT_SCHEMAS, value: unknown): T {
  const check = validators[kind]; if (!check(value)) throw Error(`AUDIO_INPUT_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`); return value as T;
}
export function validateAudioInputRuntime(value: unknown): AudioInputRuntimeIdentity { return assertAudioInput<AudioInputRuntimeIdentity>('runtime', value); }
export function validateAudioInputFacts(value: unknown, limits: AudioInputLimits): AudioInputFacts {
  const facts = assertAudioInput<AudioInputFacts>('facts', value), pair = { wav: ['wav', 'pcm_s16le'], mp3: ['mp3', 'mp3'], flac: ['flac', 'flac'], m4a: ['mov', 'aac'] }[facts.format];
  if (facts.demuxer !== pair[0] || facts.codec !== pair[1] || facts.bitsPerSample !== (facts.format === 'wav' || facts.format === 'flac' ? 16 : null) ||
      facts.samples * 16000 < limits.minSamples * facts.sampleRate || facts.samples * 16000 > limits.maxSamples * facts.sampleRate ||
      facts.samples * 2 > limits.maxPcmBytes || facts.codedFrames !== null && facts.codedFrames > limits.maxPackets) throw Error('AUDIO_INPUT_FACTS_LIMIT_OR_INVALID');
  if (facts.payloadBytes > limits.maxSourceBytes || facts.format === 'wav' && (facts.codedFrames !== null || facts.metadataFrames !== 0 || facts.gapless !== null || facts.edit !== null || facts.payloadBytes !== facts.samples * facts.channels * 2) ||
      facts.format === 'mp3' && (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(facts.sampleRate) || facts.codedFrames === null || facts.samples !== facts.codedFrames * (facts.sampleRate >= 32000 ? 1152 : 576) || facts.metadataFrames > 1 || facts.edit !== null || facts.gapless !== null && (facts.metadataFrames !== 1 || facts.gapless.delaySamples > 4095 || facts.gapless.paddingSamples > 4095 || facts.gapless.delaySamples + facts.gapless.paddingSamples >= facts.samples)) ||
      facts.format === 'flac' && (facts.codedFrames === null || facts.samples < (facts.codedFrames - 1) * 16 + 1 || facts.samples > facts.codedFrames * 65535 || facts.metadataFrames !== 0 || facts.gapless !== null || facts.edit !== null) ||
      facts.format === 'm4a' && (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(facts.sampleRate) || facts.codedFrames === null || facts.samples !== facts.codedFrames * 1024 || facts.metadataFrames !== 0 || facts.gapless !== null || facts.edit !== null && facts.edit.mediaTime > 1024)) throw Error('AUDIO_INPUT_FACTS_RELATION_INVALID');
  return facts;
}
export function validateAudioInputMap(value: unknown, probe: Buffer, pcm: Buffer, wav: Buffer, limits: AudioInputLimits): AudioInputMap {
  const map = assertAudioInput<AudioInputMap>('map', value); validateAudioInputFacts(map.input, limits);
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  for (const [entry, data] of [[map.probe, probe], [map.sourcePcm, pcm], [map.audio, wav]] as const)
    if (entry.bytes !== data.length || entry.sha256 !== hash(data)) throw Error('AUDIO_INPUT_MAP_IDENTITY_INVALID');
  if (map.source.bytes > limits.maxSourceBytes || map.sourcePcm.sampleRate !== map.input.sampleRate || map.sourcePcm.samples !== map.input.samples ||
      pcm.length !== map.input.samples * 2 || map.coverage.end !== map.input.samples || map.audio.payloadBytes !== map.audio.samples * 2 ||
      wav.length !== 44 + map.audio.payloadBytes || wav.length > limits.maxAudioBytes || map.audio.samples < limits.minSamples || map.audio.samples > limits.maxSamples ||
      Math.abs(map.audio.samples * map.input.sampleRate - map.input.samples * 16000) > map.input.sampleRate) throw Error('AUDIO_INPUT_MAP_SAMPLES_INVALID');
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + map.audio.payloadBytes, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(map.audio.payloadBytes, 40);
  if (!wav.subarray(0, 44).equals(header)) throw Error('AUDIO_INPUT_WAV_INVALID');
  return map;
}
