import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { UUID_PATTERN, safeUnpackPath } from './unpack.ts';
import { ASR_SCHEMAS, asrArguments, type AsrEngineIdentity, type AsrLanguage, type AsrWaveFacts } from './asr.ts';
import { AUDIO_INPUT_SCHEMAS, type AudioInputFacts } from './audio-input.ts';
import type { ToolRun } from './catalog.ts';

export const ALIGNMENT_MAPPER_VERSION = 'token-lcs@0.1';
export const DEFAULT_ALIGNMENT_POLICY = Object.freeze({ version: '0.1' as const, maxSourceBytes: 67108864, maxRiffChunks: 4096,
  minSamples: 3200, maxSamples: 1920000, maxScriptBytes: 32768, maxApprovalBytes: 1048576, maxScriptUnits: 2048,
  maxRecognizedUnits: 2048, maxTokens: 8192, maxTokenTextBytes: 16384, maxRawBytes: 4194304,
  maxRecognizedBytes: 1048576, maxMatrixCells: 4194304, maxMapBytes: 4194304, maxMetadataBytes: 16777216,
  maxDerivedBytes: 16777216, maxSourceReadBytes: 268435456, maxToolOutputBytes: 1048576,
  maxToolElapsedMs: 120000, maxElapsedMs: 180000, concurrency: 1 });
export const ALIGNMENT_POLICY_02 = Object.freeze({ ...DEFAULT_ALIGNMENT_POLICY, version: '0.2' as const });
export type AlignmentPolicy = { [K in keyof typeof DEFAULT_ALIGNMENT_POLICY]: typeof DEFAULT_ALIGNMENT_POLICY[K] extends number ? number : '0.1' | '0.2' };
export type AlignmentLimits = AlignmentPolicy;
export interface AlignmentFileIdentity { path: string; bytes: number; sha256: string }
export interface AlignmentScript { version: '0.1'; kind: 'alignment-script'; language: AsrLanguage; lineId: string; text: string;
  approval: { scope: 'word-alignment'; basis: 'user' | 'delegated'; decisionId: string; sourceRef: AlignmentFileIdentity; subjectSha256: string } }
export interface AlignmentSelection { catalogId: string; assetId: string; assetVersion: string; scriptPath: string }
export interface AlignmentToken { id: string; ordinal: number; segmentIndex: number; tokenIndex: number; providerId: number;
  byteStart: number; byteEnd: number; sampleStart: number | null; sampleEnd: number | null; reason: string }
export interface ParsedAlignment { text: Buffer; tokens: AlignmentToken[]; rawTokens: number }
export interface AlignmentUnit { id: string; ordinal: number; kind: 'word' | 'character' | 'nonlexical'; byteStart: number; byteEnd: number;
  text: string; normalized: string | null; recognizedByteStart: number | null; recognizedByteEnd: number | null; tokenIds: string[];
  sampleStart: number | null; sampleEnd: number | null; basis: 'estimated' | 'unknown'; confidence: null; reason: string }
export interface AlignmentMap { version: '0.1'; kind: 'alignment-map'; mapperVersion: 'token-lcs@0.1'; status: 'estimated' | 'partial' | 'unknown';
  sampleRate: 16000; samples: number; scriptTextSha256: string; recognizedSha256: string; units: AlignmentUnit[];
  coverage: { submittedSampleStart: 0; submittedSampleEnd: number; scriptBytes: number; scriptComplete: true;
    lexicalUnits: number; estimatedUnits: number; unknownUnits: number; listening: 'unverified' }; limitations: string[] }
export interface AlignmentCounts { sourceReadBytes: number; derivedBytes: number; toolOutputBytes: number; elapsedMs: number }
export interface LegacyAlignmentSource { catalogId: string; catalogManifestSha256: string; assetId: string; assetVersion: string;
  fixedPath: string; bytes: number; sha256: string; wave: AsrWaveFacts; pcmEvidenceId: string }
export type AudioAlignmentSource = Omit<LegacyAlignmentSource, 'wave'> & { input: AudioInputFacts; audioEvidenceId: string;
  audioInputMapEvidenceId: string; audioInputMapSha256: string };
export type AlignmentSource = LegacyAlignmentSource | AudioAlignmentSource;
export interface AlignmentManifest { version: '0.1' | '0.2'; kind: 'alignment-manifest'; alignmentId: string; attemptId: string; createdAt: string;
  policy: AlignmentPolicy; policySha256: string; policySourceSha256: string | null; source: AlignmentSource;
  scriptSnapshot: AlignmentFileIdentity; approvalSource: AlignmentFileIdentity; audio: AlignmentFileIdentity & { sampleRate: 16000; samples: number; payloadBytes: number };
  raw: AlignmentFileIdentity; recognized: AlignmentFileIdentity; map: AlignmentFileIdentity; engine: AsrEngineIdentity; tool: ToolRun; counts: AlignmentCounts }
export interface AlignmentIndex { version: '0.1' | '0.2'; kind: 'alignment-index'; currentAlignmentId: string;
  alignments: { alignmentId: string; attemptId: string; manifestSha256: string }[] }
export interface AlignmentReceipt { version: '0.1' | '0.2'; kind: 'alignment-receipt'; alignmentId: string; attemptId: string; ownerPid: number;
  startedAt: string; finishedAt: string | null; status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted';
  phase: 'planning' | 'aligning' | 'verifying' | 'committing'; selection: AlignmentSelection; policy: AlignmentPolicy | null;
  policySha256: string | null; policySourceSha256: string | null; counts: AlignmentCounts; tool: ToolRun | null;
  tempPath: string; manifestPath: string | null; manifestSha256: string | null; indexCommitted: boolean; error: string | null }
export const alignmentIdPattern = new RegExp(`^alignment-${UUID_PATTERN}$`);
export const alignmentAttemptPattern = new RegExp(`^alignment-attempt-${UUID_PATTERN}$`);
export const alignmentArguments = (language: AsrLanguage, model: string, audio: string): string[] =>
  asrArguments(language, model, audio).map(value => value === '-oj' ? '-ojf' : value);
export const alignmentSubjectSha256 = (script: Pick<AlignmentScript, 'version' | 'kind' | 'language' | 'lineId' | 'text'>): string =>
  createHash('sha256').update(JSON.stringify({ version: script.version, kind: script.kind, language: script.language, lineId: script.lineId, text: script.text })).digest('hex');
export const safeAlignmentPath = safeUnpackPath;
export function alignmentInputPath(path: string): boolean { return safeAlignmentPath(path) && path !== 'assets/alignment.json' && !path.startsWith('assets/derived/alignment/') &&
  (path === 'prompt-history.jsonl' || /^(inputs|assets|production)\//.test(path)); }
export function emptyAlignmentCounts(): AlignmentCounts { return { sourceReadBytes: 0, derivedBytes: 0, toolOutputBytes: 0, elapsedMs: 0 }; }

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
const id = (prefix: string) => ({ ...string, pattern: `^${prefix}-${UUID_PATTERN}$` });
const path = { ...nonempty, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' };
const file = object({ path, bytes: integer, sha256: hash });
const policy = object(Object.fromEntries(Object.entries(DEFAULT_ALIGNMENT_POLICY).map(([key, maximum]) => [key,
  key === 'version' || key === 'minSamples' || key === 'concurrency' ? { const: maximum } : { ...positive, maximum }])));
const policy02 = object({ ...policy.properties, version: { const: '0.2' } });
const selection = object({ catalogId: id('catalog'), assetId: id('asset'), assetVersion: id('asset-version'), scriptPath: path });
const script = object({ version: { const: '0.1' }, kind: { const: 'alignment-script' }, language: { enum: ['zh', 'en'] }, lineId: nonempty, text: string,
  approval: object({ scope: { const: 'word-alignment' }, basis: { enum: ['user', 'delegated'] }, decisionId: nonempty, sourceRef: file, subjectSha256: hash }) });
const unit = object({ id: nonempty, ordinal: integer, kind: { enum: ['word', 'character', 'nonlexical'] }, byteStart: integer, byteEnd: integer, text: string,
  normalized: nullable(nonempty), recognizedByteStart: nullable(integer), recognizedByteEnd: nullable(integer), tokenIds: array(nonempty),
  sampleStart: nullable(integer), sampleEnd: nullable(integer), basis: { enum: ['estimated', 'unknown'] }, confidence: { type: 'null' }, reason: string });
const map = object({ version: { const: '0.1' }, kind: { const: 'alignment-map' }, mapperVersion: { const: ALIGNMENT_MAPPER_VERSION },
  status: { enum: ['estimated', 'partial', 'unknown'] }, sampleRate: { const: 16000 }, samples: positive, scriptTextSha256: hash, recognizedSha256: hash,
  units: array(unit), coverage: object({ submittedSampleStart: { const: 0 }, submittedSampleEnd: integer, scriptBytes: integer,
    scriptComplete: { const: true }, lexicalUnits: integer, estimatedUnits: integer, unknownUnits: integer, listening: { const: 'unverified' } }), limitations: array(string) });
const wave = object({ format: { const: 'wav' }, sampleRate: { const: 16000 }, channels: { const: 1 }, bitsPerSample: { const: 16 }, frames: positive, dataBytes: positive, dataOffset: integer });
const counts = object({ sourceReadBytes: integer, derivedBytes: integer, toolOutputBytes: integer, elapsedMs: integer });
const tool = object({ executable: nonempty, version: nonempty, argv: array(string), exitCode: nullable({ type: 'integer' }), signal: nullable(nonempty),
  stdout: string, stderr: string, stdoutBytes: integer, stderrBytes: integer, binaryBytes: integer, elapsedMs: integer, error: nullable(nonempty) });
const manifest = object({ version: { const: '0.1' }, kind: { const: 'alignment-manifest' }, alignmentId: id('alignment'), attemptId: id('alignment-attempt'), createdAt: nonempty,
  policy, policySha256: hash, policySourceSha256: nullable(hash),
  source: object({ catalogId: id('catalog'), catalogManifestSha256: hash, assetId: id('asset'), assetVersion: id('asset-version'), fixedPath: path, bytes: positive, sha256: hash, wave, pcmEvidenceId: id('evidence') }),
  scriptSnapshot: file, approvalSource: file, audio: object({ ...file.properties, sampleRate: { const: 16000 }, samples: positive, payloadBytes: positive }),
  raw: file, recognized: file, map: file, engine: ASR_SCHEMAS.engine, tool, counts });
const index = object({ version: { const: '0.1' }, kind: { const: 'alignment-index' }, currentAlignmentId: id('alignment'),
  alignments: array(object({ alignmentId: id('alignment'), attemptId: id('alignment-attempt'), manifestSha256: hash })) });
const receipt = object({ version: { const: '0.1' }, kind: { const: 'alignment-receipt' }, alignmentId: id('alignment'), attemptId: id('alignment-attempt'),
  ownerPid: positive, startedAt: nonempty, finishedAt: nullable(nonempty), status: { enum: ['running', 'prepared', 'succeeded', 'failed', 'interrupted'] },
  phase: { enum: ['planning', 'aligning', 'verifying', 'committing'] }, selection, policy: nullable(policy), policySha256: nullable(hash),
  policySourceSha256: nullable(hash), counts, tool: nullable(tool), tempPath: path, manifestPath: nullable(path), manifestSha256: nullable(hash),
  indexCommitted: { type: 'boolean' }, error: nullable(nonempty) });
const source02 = object({ catalogId: id('catalog'), catalogManifestSha256: hash, assetId: id('asset'), assetVersion: id('asset-version'),
  fixedPath: path, bytes: positive, sha256: hash, input: AUDIO_INPUT_SCHEMAS.facts, pcmEvidenceId: id('evidence'), audioEvidenceId: id('evidence'),
  audioInputMapEvidenceId: id('evidence'), audioInputMapSha256: hash });
const manifest02 = object({ ...manifest.properties, version: { const: '0.2' }, policy: policy02, source: source02 });
const index02 = object({ ...index.properties, version: { const: '0.2' } });
const receipt02 = object({ ...receipt.properties, version: { const: '0.2' }, policy: nullable(policy02) });
const schema = (name: string, value: unknown) => ({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `https://js-build-motion.local/alignment/${name}/0.1`, ...(value as object) });
export const ALIGNMENT_SCHEMAS = { policy: schema('policy', { anyOf: [policy, policy02] }), script: schema('script', script), selection: schema('selection', selection),
  map: schema('map', map), manifest: schema('manifest', { anyOf: [manifest, manifest02] }), index: schema('index', { anyOf: [index, index02] }), receipt: schema('receipt', { anyOf: [receipt, receipt02] }) };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(ALIGNMENT_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema as Schema)]));
export function assertAlignment<T>(kind: keyof typeof ALIGNMENT_SCHEMAS, value: unknown): T {
  const check = validators[kind]; if (!check(value)) throw Error(`ALIGNMENT_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`); return value as T;
}
export function validateAlignmentScript(value: unknown, limits: AlignmentPolicy = DEFAULT_ALIGNMENT_POLICY): AlignmentScript {
  const script = assertAlignment<AlignmentScript>('script', value);
  for (const text of [script.text, script.lineId]) {
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/.test(text)) throw Error('ALIGNMENT_SCRIPT_INVALID: control or BOM');
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error('ALIGNMENT_SCRIPT_INVALID: surrogate'); }
      else if (code >= 0xdc00 && code <= 0xdfff) throw Error('ALIGNMENT_SCRIPT_INVALID: surrogate');
    }
  }
  if (Buffer.byteLength(script.text) > limits.maxScriptBytes) throw Error('ALIGNMENT_SCRIPT_LIMIT');
  if (!alignmentInputPath(script.approval.sourceRef.path) || script.approval.subjectSha256 !== alignmentSubjectSha256(script)) throw Error('ALIGNMENT_APPROVAL_INVALID');
  return script;
}
