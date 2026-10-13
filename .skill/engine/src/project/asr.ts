import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { UUID_PATTERN } from './unpack.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { AUDIO_INPUT_SCHEMAS, DEFAULT_AUDIO_INPUT_LIMITS, validateAudioInputFacts, type AudioInputFacts } from './audio-input.ts';
import type { NativeToolIdentity } from './ocr.ts';

export const DEFAULT_ASR_LIMITS = Object.freeze({ maxAsrSourceBytes: 67108864, maxAsrRiffChunks: 4096, minAsrSamples: 3200,
  maxAsrSamples: 1920000, maxAsrAudioBytes: 3840044, maxAsrAudiosPerAttempt: 4, maxAsrRawBytes: 4194304,
  maxAsrTextBytes: 1048576, maxAsrSegmentTextBytes: 16384, maxAsrRawSegments: 2000, maxAsrSegments: 2000,
  maxAsrMapBytes: 4194304, maxAsrToolElapsedMs: 120000, concurrency: 1 });
export type AsrLimits = { [K in keyof typeof DEFAULT_ASR_LIMITS]: number };
export type AsrLanguage = 'zh' | 'en';
export type AsrPolicy = AsrLimits & { enabled: boolean; language: AsrLanguage };
export const INSPECT_POLICY_04_ASR_DEFAULTS = Object.freeze({ enabled: false, language: 'zh' as const, ...DEFAULT_ASR_LIMITS });
export const ASR_ARGUMENTS = ['-t', '4', '-p', '1', '-bs', '1', '-bo', '1', '-tp', '0', '-tpi', '0', '-nf', '-ng', '-nfa', '-mc', '0', '-ml', '0', '-ot', '0', '-on', '0', '-d', '0', '-et', '2.4', '-lpt', '-1', '-nth', '0.6'];
export function asrArguments(language: AsrLanguage, model: string, audio: string): string[] { return [...ASR_ARGUMENTS, '-l', language, '-oj', '-of', '-', '-np', '-m', model, '-f', audio]; }
export interface AsrWaveFacts { format: 'wav'; sampleRate: number; channels: 1 | 2; bitsPerSample: 16; frames: number; dataBytes: number; dataOffset: number }
export interface AsrFileIdentity { path: string; bytes: number; sha256: string }
export interface AsrNativeLock { version: '0.1'; kind: 'asr-dependencies'; platform: 'darwin'; arch: 'arm64';
  providerVersion: '1.9.5'; sourceCommit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037'; mapperVersion: 'asr-json@0.1';
  program: AsrFileIdentity; model: AsrFileIdentity; tools: { ffmpeg: NativeToolIdentity; ffprobe: NativeToolIdentity }; arguments: string[] }
export interface AsrEngineIdentity extends AsrNativeLock { id: 'whisper-cpp-input-asr'; lockSha256: string }
export interface AsrSegment { id: string; ordinal: number; rawIndex: number; rawStartMs: number; rawEndMs: number;
  sampleStart: number; sampleEnd: number; clippedEndSamples: number; byteStart: number; byteEnd: number }
export interface LegacyAsrMap { version: '0.1'; kind: 'asr-map'; format: 'wav'; mapperVersion: 'asr-json@0.1'; status: 'text' | 'no-text';
  scope: 'input-audio-asr'; language: AsrLanguage; policySha256: string; engine: AsrEngineIdentity;
  source: { bytes: number; sha256: string; wave: AsrWaveFacts };
  sourcePcm: { evidenceId: string; bytes: number; sha256: string; sampleRate: number; samples: number };
  audio: { evidenceId: string; bytes: number; sha256: string; payloadBytes: number; sampleRate: 16000; samples: number };
  rawJson: { evidenceId: string; bytes: number; sha256: string }; text: { evidenceId: string; bytes: number; sha256: string };
  coverage: { scope: 'input-audio-asr'; submittedStart: 0; submittedEnd: number; complete: true }; segments: AsrSegment[] }
export type AudioAsrMap = Omit<LegacyAsrMap, 'version' | 'format' | 'source'> & { version: '0.2'; format: AudioInputFacts['format'];
  source: { bytes: number; sha256: string; audioInputMapEvidenceId: string; audioInputMapSha256: string; input: AudioInputFacts } };
export type AsrMap = LegacyAsrMap | AudioAsrMap;
export interface AsrDescriptor { version: '0.1' | '0.2'; status: 'completed' | 'no-text' | 'disabled' | 'skipped' | 'failed'; reason: string;
  scope: 'input-audio-asr'; engine: AsrEngineIdentity | null; audioEvidenceId: string | null; jsonEvidenceId: string | null;
  textEvidenceId: string | null; mapEvidenceId: string | null; segments: number }
export interface AsrObservation { version: '0.4' | '0.5'; id: string; assetId: string; assetVersion: string; byteSha256: string; method: string;
  locator: { kind: 'asr'; evidenceId: string; mapEvidenceId: string; audioEvidenceId: string; segmentId: string; byteStart: number; byteEnd: number };
  coverageScope: 'segment-asr-text'; coverage: 'full' | 'partial' | 'sample'; statement: string; basis: 'estimated' | 'unknown';
  confidence: null; limitations: string[]; evidenceRefs: string[] }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 }, string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items }), nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const id = (prefix: string) => ({ ...string, pattern: `^${prefix}-${UUID_PATTERN}$` });
const strings = array(string);
export const ASR_POLICY_SCHEMA = object({ enabled: { type: 'boolean' }, language: { enum: ['zh', 'en'] },
  ...Object.fromEntries(Object.entries(DEFAULT_ASR_LIMITS).map(([key, maximum]) => [key, key === 'minAsrSamples' || key === 'concurrency' ? { const: maximum } : { ...positive, maximum }])) });
const nativeFile = object({ path: nonempty, bytes: positive, sha256: hash });
const tool = object({ executable: nonempty, version: nonempty, files: array(nativeFile), aliases: array(object({ path: nonempty, realpath: nonempty })) });
const lock = object({ version: { const: '0.1' }, kind: { const: 'asr-dependencies' }, platform: { const: 'darwin' }, arch: { const: 'arm64' }, providerVersion: { const: '1.9.5' },
  sourceCommit: { const: 'd1be6fde11ac6e0407606b4e42fe72d34add8037' }, mapperVersion: { const: 'asr-json@0.1' },
  program: object({ path: { const: 'assets/asr/bin/whisper-cli' }, bytes: positive, sha256: hash }),
  model: object({ path: { const: 'assets/asr/models/ggml-base.bin' }, bytes: { const: 147951465 }, sha256: { const: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' } }),
  tools: object({ ffmpeg: tool, ffprobe: tool }), arguments: { type: 'array', items: string, const: ASR_ARGUMENTS } });
const engine = object({ ...lock.properties, id: { const: 'whisper-cpp-input-asr' }, lockSha256: hash });
const wave = object({ format: { const: 'wav' }, sampleRate: { ...integer, minimum: 8000, maximum: 48000 }, channels: { enum: [1, 2] }, bitsPerSample: { const: 16 }, frames: integer, dataBytes: integer, dataOffset: integer });
const identity = object({ evidenceId: id('evidence'), bytes: integer, sha256: hash });
const segment = object({ id: { ...string, pattern: '^asr-segment-(?:0|[1-9][0-9]*)$' }, ordinal: integer, rawIndex: integer, rawStartMs: integer, rawEndMs: integer, sampleStart: integer, sampleEnd: integer, clippedEndSamples: { ...integer, maximum: 160 }, byteStart: integer, byteEnd: integer });
const map = object({ version: { const: '0.1' }, kind: { const: 'asr-map' }, format: { const: 'wav' }, mapperVersion: { const: 'asr-json@0.1' }, status: { enum: ['text', 'no-text'] }, scope: { const: 'input-audio-asr' }, language: { enum: ['zh', 'en'] }, policySha256: hash, engine,
  source: object({ bytes: integer, sha256: hash, wave }), sourcePcm: object({ ...identity.properties, sampleRate: positive, samples: integer }),
  audio: object({ ...identity.properties, payloadBytes: integer, sampleRate: { const: 16000 }, samples: integer }), rawJson: identity, text: identity,
  coverage: object({ scope: { const: 'input-audio-asr' }, submittedStart: { const: 0 }, submittedEnd: integer, complete: { const: true } }), segments: array(segment) });
export const ASR_DESCRIPTOR_SCHEMA = object({ version: { const: '0.1' }, status: { enum: ['completed', 'no-text', 'disabled', 'skipped', 'failed'] }, reason: string, scope: { const: 'input-audio-asr' }, engine: nullable(engine),
  audioEvidenceId: nullable(id('evidence')), jsonEvidenceId: nullable(id('evidence')), textEvidenceId: nullable(id('evidence')), mapEvidenceId: nullable(id('evidence')), segments: integer });
export const ASR_OBSERVATION_SCHEMA = object({ version: { const: '0.4' }, id: id('observation'), assetId: id('asset'), assetVersion: id('asset-version'), byteSha256: hash, method: nonempty,
  locator: object({ kind: { const: 'asr' }, evidenceId: id('evidence'), mapEvidenceId: id('evidence'), audioEvidenceId: id('evidence'), segmentId: segment.properties.id, byteStart: integer, byteEnd: integer }),
  coverageScope: { const: 'segment-asr-text' }, coverage: { enum: ['full', 'partial', 'sample'] }, statement: nonempty, basis: { enum: ['estimated', 'unknown'] }, confidence: { type: 'null' }, limitations: strings, evidenceRefs: { ...strings, uniqueItems: true } });
const map02 = object({ ...map.properties, version: { const: '0.2' }, format: { enum: ['wav', 'mp3', 'flac', 'm4a'] },
  source: object({ bytes: integer, sha256: hash, audioInputMapEvidenceId: id('evidence'), audioInputMapSha256: hash, input: AUDIO_INPUT_SCHEMAS.facts }) });
export const ASR_DESCRIPTOR_SCHEMA_02 = object({ ...ASR_DESCRIPTOR_SCHEMA.properties, version: { const: '0.2' } });
export const ASR_OBSERVATION_SCHEMA_05 = object({ ...ASR_OBSERVATION_SCHEMA.properties, version: { const: '0.5' } });
export const ASR_SCHEMAS = { lock, engine, map: { anyOf: [map, map02] } };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(ASR_SCHEMAS).map(([name, value]) => [name, ajv.compile(value as Schema)]));
function validate<T>(kind: keyof typeof ASR_SCHEMAS, value: unknown): T { const check = validators[kind]; if (!check(value)) throw Error(`ASR_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`); return value as T; }
export function validateAsrEngine(value: unknown): AsrEngineIdentity { return validate<AsrEngineIdentity>('engine', value); }
export function validateAsrLock(value: unknown): AsrNativeLock { return validate<AsrNativeLock>('lock', value); }
export function canonicalWavHeader(samples: number): Buffer {
  if (!Number.isSafeInteger(samples) || samples < 0 || samples > DEFAULT_ASR_LIMITS.maxAsrSamples) throw Error('ASR_AUDIO_LIMIT');
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples * 2, 40); return header;
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function validateAsrMap(value: unknown, text: Buffer, wav: Buffer, raw: Buffer, limits: AsrLimits): AsrMap {
  const result = validate<AsrMap>('map', value), n = result.audio.samples;
  if (result.version === '0.2') validateAudioInputFacts(result.source.input, { ...DEFAULT_AUDIO_INPUT_LIMITS,
    maxSourceBytes: limits.maxAsrSourceBytes, minSamples: limits.minAsrSamples, maxSamples: limits.maxAsrSamples });
  if (n < limits.minAsrSamples || n > limits.maxAsrSamples || wav.length > limits.maxAsrAudioBytes || raw.length > limits.maxAsrRawBytes || text.length > limits.maxAsrTextBytes || result.segments.length > limits.maxAsrSegments) throw Error('ASR_MAP_LIMIT');
  if (wav.length !== 44 + n * 2 || !wav.subarray(0, 44).equals(canonicalWavHeader(n)) || result.audio.payloadBytes !== n * 2 || result.coverage.submittedEnd !== n) throw Error('ASR_AUDIO_INVALID');
  for (const [entry, data] of [[result.audio, wav], [result.rawJson, raw], [result.text, text]] as const) if (entry.bytes !== data.length || entry.sha256 !== digest(data)) throw Error('ASR_MAP_IDENTITY_INVALID');
  const frames = result.version === '0.1' ? result.source.wave.frames : result.source.input.samples;
  const rate = result.version === '0.1' ? result.source.wave.sampleRate : result.source.input.sampleRate;
  if (result.sourcePcm.samples !== frames || result.sourcePcm.sampleRate !== rate || result.sourcePcm.bytes !== frames * 2 ||
      result.version === '0.1' && result.source.wave.dataBytes !== frames * result.source.wave.channels * 2 ||
      result.version === '0.2' && result.format !== result.source.input.format || Math.abs(n * rate - frames * 16000) > rate) throw Error('ASR_SOURCE_SAMPLES_INVALID');
  let byteEnd = -1, sampleEnd = 0, rawIndex = -1;
  for (const [index, s] of result.segments.entries()) {
    if (s.id !== `asr-segment-${index}` || s.ordinal !== index || s.rawIndex <= rawIndex || s.rawStartMs % 10 || s.rawEndMs % 10 || s.sampleStart !== s.rawStartMs * 16 || s.sampleEnd !== s.rawEndMs * 16 - s.clippedEndSamples || s.sampleStart < sampleEnd || s.sampleStart >= s.sampleEnd || s.sampleEnd > n || s.clippedEndSamples && index !== result.segments.length - 1 || s.byteStart !== byteEnd + 1 || s.byteStart >= s.byteEnd || s.byteEnd > text.length || s.byteEnd - s.byteStart > limits.maxAsrSegmentTextBytes) throw Error('ASR_SEGMENT_INVALID');
    new TextDecoder('utf-8', { fatal: true }).decode(text.subarray(s.byteStart, s.byteEnd));
    if (index && text[s.byteStart - 1] !== 10) throw Error('ASR_TEXT_INVALID');
    byteEnd = s.byteEnd; sampleEnd = s.sampleEnd; rawIndex = s.rawIndex;
  }
  if ((result.status === 'text') !== (result.segments.length > 0) || (result.segments.length ? byteEnd !== text.length : text.length !== 0)) throw Error('ASR_TEXT_INVALID');
  return result;
}
