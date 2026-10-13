import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { UUID_PATTERN, safeUnpackPath } from './unpack.ts';
import { AUDIO_INPUT_SCHEMAS, validateAudioInputRuntime, type AudioInputRuntimeIdentity } from './audio-input.ts';
import type { ToolRun } from './catalog.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

export const VIDEO_PREPARATION_VERSION = 'video-preparation@0.1';
export const DEFAULT_VIDEO_PREPARATION_LIMITS = Object.freeze({ maxSourceBytes: 67108864, maxSourceFrames: 600,
  maxSourcePixels: 8294400, maxDurationMs: 10000, maxProxyEdge: 512, maxProxyFrames: 600,
  maxRgbaBytes: 268435456, maxProxyBytes: 33554432, maxProbeBytes: 8388608, maxMapBytes: 8388608,
  maxStructureEntries: 50000, maxToolElapsedMs: 30000, maxElapsedMs: 120000 });
export type VideoPreparationLimits = { [K in keyof typeof DEFAULT_VIDEO_PREPARATION_LIMITS]: number };
export const PRODUCTION_VIDEO_PREPARATION_VERSION = 'video-preparation@0.2';
export const DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS = Object.freeze({ version: '0.2' as const,
  maxSourceBytes: 8589934592, maxSourcePixels: 40000000, maxProxyEdge: 512, maxRgbaBytes: 8589934592,
  maxProxyBytes: 1073741824, maxAudioBytes: 1073741824, maxMetadataBytes: 33554432, maxProbeBytes: 16777216,
  maxMapBytes: 33554432, maxStructureEntries: 2000000, maxResidentBytes: 268435456, minFreeBytes: 268435456,
  maxToolElapsedMs: 300000, maxElapsedMs: 900000 });
export type ProductionVideoPreparationLimits = { [K in keyof typeof DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS]:
  K extends 'version' ? '0.2' : number };
export type AnyVideoPreparationLimits = VideoPreparationLimits | ProductionVideoPreparationLimits;
export interface LegacyVideoPreparationRequest { version: '0.1'; kind: 'video-preparation-request'; catalogId: string;
  catalogManifestSha256: string; assetId: string; assetVersion: string; byteSha256: string; streamIndex: number;
  fps: 12 | 15 | 24 | 25 | 30 | 60; sourceRange: { timeBase: string; startPts: string; endPts: string } }
export interface ProductionVideoPreparationRequest extends Omit<LegacyVideoPreparationRequest, 'version'> {
  version: '0.2'; output: { width: number | null; height: number | null }; mute: boolean }
export type VideoPreparationRequest = LegacyVideoPreparationRequest | ProductionVideoPreparationRequest;
export interface VideoSourceFrame { pts: string; duration: string | null; rgbaSha256: string }
export interface VideoPreparationReceipt { version: '0.1' | '0.2'; kind: 'video-preparation-receipt'; attemptId: string; videoId: string; ownerPid: number;
  status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted'; startedAt: string; finishedAt: string | null;
  request: VideoPreparationRequest; tempPath: string; map: { path: string; bytes: number; sha256: string } | null; error: string | null;
  limits?: ProductionVideoPreparationLimits }
export interface VideoPublication { version: '0.1' | '0.2'; kind: 'prepared-video-publication'; receipt: { path: string; bytes: number; sha256: string } }
export interface LegacyPreparedVideoMap { version: '0.1'; kind: 'prepared-video-map'; mapperVersion: 'video-preparation@0.1';
  request: LegacyVideoPreparationRequest; limits: VideoPreparationLimits; policySha256: string;
  source: { bytes: number; sha256: string }; runtime: AudioInputRuntimeIdentity;
  sourceVideo: { streamIndex: number; codec: 'h264'; timeBase: string; width: number; height: number;
    pixelFormat: 'yuv420p'; rotation: 0; sourceFrames: VideoSourceFrame[] };
  canonical: { path: string; bytes: number; sha256: string; width: number; height: number; fps: number; frames: number };
  proxy: { path: string; bytes: number; sha256: string };
  frames: { sourceIndex: number; sourcePts: string; rgbaSha256: string }[];
  commands: { probe: ToolRun; decode: ToolRun; encode: ToolRun; proxyProbe: ToolRun }; cwd: string;
  coverage: { scope: 'complete-selected-video-frames'; complete: true; startPts: string; endPts: string; audio: 'muted' } }
export interface ProductionPreparedVideoMap extends Omit<LegacyPreparedVideoMap, 'version' | 'mapperVersion' | 'request' | 'limits' | 'sourceVideo' | 'proxy' | 'commands' | 'coverage'> {
  version: '0.2'; mapperVersion: 'video-preparation@0.2'; request: ProductionVideoPreparationRequest; limits: ProductionVideoPreparationLimits;
  sourceVideo: LegacyPreparedVideoMap['sourceVideo'] & { sourceFrameCount: number; startPts: string; endPts: string };
  sourceAudio: { streamIndex: number; codec: 'aac'; timeBase: string; startPts: string; durationPts: string | null; sampleRate: number; channels: number } | null;
  proxy: LegacyPreparedVideoMap['proxy'] & { width: number; height: number };
  audio: { path: string; bytes: number; sha256: string; sampleRate: 48000; channels: 2; samples: number } | null;
  commands: LegacyPreparedVideoMap['commands'] & { audio: ToolRun | null };
  coverage: { scope: 'complete-selected-video-frames'; complete: true; startPts: string; endPts: string; audio: 'preserved' | 'muted' | 'absent' } }
export type PreparedVideoMap = LegacyPreparedVideoMap | ProductionPreparedVideoMap;

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const id = (prefix: string) => ({ ...string, pattern: `^${prefix}-${UUID_PATTERN}$` });
const signed = { ...string, pattern: '^-?(?:0|[1-9][0-9]{0,18})$' }, duration = { ...string, pattern: '^[1-9][0-9]{0,18}$' };
const timeBase = { ...string, pattern: '^[1-9][0-9]{0,8}/[1-9][0-9]{0,8}$' };
const range = object({ timeBase, startPts: signed, endPts: signed });
const limits = object(Object.fromEntries(Object.entries(DEFAULT_VIDEO_PREPARATION_LIMITS).map(([key, maximum]) => [key, { ...positive, maximum }])));
const request = object({ version: { const: '0.1' }, kind: { const: 'video-preparation-request' }, catalogId: id('catalog'),
  catalogManifestSha256: hash, assetId: id('asset'), assetVersion: id('asset-version'), byteSha256: hash,
  streamIndex: integer, fps: { enum: [12, 15, 24, 25, 30, 60] }, sourceRange: range });
const file = object({ path: nonempty, bytes: positive, sha256: hash });
const tool = object({ executable: nonempty, version: nonempty, argv: array(string), exitCode: nullable({ type: 'integer' }),
  signal: nullable(nonempty), stdout: string, stderr: string, stdoutBytes: integer, stderrBytes: integer,
  binaryBytes: integer, elapsedMs: integer, error: nullable(nonempty) });
const map = object({ version: { const: '0.1' }, kind: { const: 'prepared-video-map' }, mapperVersion: { const: VIDEO_PREPARATION_VERSION },
  request, limits, policySha256: hash, source: object({ bytes: positive, sha256: hash }), runtime: AUDIO_INPUT_SCHEMAS.runtime,
  sourceVideo: object({ streamIndex: integer, codec: { const: 'h264' }, timeBase, width: positive, height: positive,
    pixelFormat: { const: 'yuv420p' }, rotation: { const: 0 },
    sourceFrames: { ...array(object({ pts: signed, duration: nullable(duration), rgbaSha256: hash })), minItems: 1, maxItems: 600 } }),
  canonical: object({ ...file.properties, width: positive, height: positive, fps: { enum: [12, 15, 24, 25, 30, 60] }, frames: positive }),
  proxy: file, frames: { ...array(object({ sourceIndex: integer, sourcePts: signed, rgbaSha256: hash })), minItems: 1, maxItems: 600 },
  commands: object({ probe: tool, decode: tool, encode: tool, proxyProbe: tool }), cwd: nonempty,
  coverage: object({ scope: { const: 'complete-selected-video-frames' }, complete: { const: true }, startPts: signed, endPts: signed, audio: { const: 'muted' } }) });
const receipt = object({ version: { const: '0.1' }, kind: { const: 'video-preparation-receipt' }, attemptId: id('video-attempt'), videoId: id('video'),
  ownerPid: positive, status: { enum: ['running', 'prepared', 'succeeded', 'failed', 'interrupted'] }, startedAt: nonempty, finishedAt: nullable(nonempty),
  request, tempPath: nonempty, map: nullable(file), error: nullable(nonempty) });
const publication = object({ version: { const: '0.1' }, kind: { const: 'prepared-video-publication' }, receipt: file });
const productionLimits = object(Object.fromEntries(Object.keys(DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS).map(key =>
  [key, key === 'version' ? { const: '0.2' } : key === 'minFreeBytes' ? integer : key.endsWith('Ms') ? { ...positive, maximum: 2147483647 } : positive])));
const productionRequest = object({ ...request.properties, version: { const: '0.2' },
  output: object({ width: nullable(positive), height: nullable(positive) }), mute: { type: 'boolean', default: false } });
productionRequest.required = productionRequest.required.filter(key => key !== 'mute');
const productionSourceVideo = object({ ...map.properties.sourceVideo.properties, sourceFrameCount: positive, startPts: signed, endPts: signed,
  sourceFrames: { ...array(object({ pts: signed, duration: nullable(duration), rgbaSha256: hash })), minItems: 1 } });
const productionMap = object({ ...map.properties, version: { const: '0.2' }, mapperVersion: { const: PRODUCTION_VIDEO_PREPARATION_VERSION },
  request: { ...productionRequest, required: [...productionRequest.required, 'mute'] }, limits: productionLimits, sourceVideo: productionSourceVideo,
  sourceAudio: nullable(object({ streamIndex: integer, codec: { const: 'aac' }, timeBase, startPts: signed, durationPts: nullable(duration), sampleRate: positive, channels: positive })),
  proxy: object({ ...file.properties, width: positive, height: positive }),
  audio: nullable(object({ ...file.properties, sampleRate: { const: 48000 }, channels: { const: 2 }, samples: positive })),
  frames: { ...array(object({ sourceIndex: integer, sourcePts: signed, rgbaSha256: hash })), minItems: 1 },
  commands: object({ ...map.properties.commands.properties, audio: nullable(tool) }),
  coverage: object({ scope: { const: 'complete-selected-video-frames' }, complete: { const: true }, startPts: signed, endPts: signed,
    audio: { enum: ['preserved', 'muted', 'absent'] } }) });
const productionReceipt = object({ ...receipt.properties, version: { const: '0.2' }, request: { ...productionRequest, required: [...productionRequest.required, 'mute'] }, limits: productionLimits });
const productionPublication = object({ ...publication.properties, version: { const: '0.2' } });
export const VIDEO_PREPARATION_SCHEMAS = { request: { oneOf: [request, productionRequest] }, map: { oneOf: [map, productionMap] },
  limits: { oneOf: [limits, productionLimits] }, receipt: { oneOf: [receipt, productionReceipt] }, publication: { oneOf: [publication, productionPublication] } };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(VIDEO_PREPARATION_SCHEMAS).map(([key, value]) => [key, ajv.compile(value as Schema)]));
function assertVideo<T>(kind: keyof typeof VIDEO_PREPARATION_SCHEMAS, value: unknown): T {
  const check = validators[kind]; if (!check(value)) throw Error(`VIDEO_PREPARATION_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`);
  return value as T;
}
export function videoPreparationLimits(value: unknown = DEFAULT_VIDEO_PREPARATION_LIMITS): AnyVideoPreparationLimits { return assertVideo('limits', value); }
export function productionVideoPreparationLimits(value: unknown = DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS): ProductionVideoPreparationLimits {
  const result = videoPreparationLimits(value); if (!('version' in result) || result.version !== '0.2') throw Error('VIDEO_PRODUCTION_POLICY_INVALID'); return result;
}
export function validateVideoPreparationRequest(value: unknown): VideoPreparationRequest {
  const r = assertVideo<VideoPreparationRequest>('request', value);
  if (BigInt(r.sourceRange.endPts) <= BigInt(r.sourceRange.startPts)) throw Error('VIDEO_SOURCE_RANGE_INVALID');
  if (r.version === '0.2') {
    if ((r.output.width === null) !== (r.output.height === null) || r.output.width !== null && (r.output.width % 2 || r.output.height! % 2)) throw Error('VIDEO_OUTPUT_SIZE_INVALID');
    return { ...r, output: { ...r.output }, mute: r.mute ?? false };
  }
  return r;
}
export function validateVideoReceipt(value: unknown): VideoPreparationReceipt {
  const result = assertVideo<VideoPreparationReceipt>('receipt', value); validateVideoPreparationRequest(result.request);
  if (result.version === '0.2') productionVideoPreparationLimits(result.limits);
  if (result.version !== result.request.version || result.tempPath !== `out/.tmp/${result.attemptId}` || result.map && result.map.path !== `assets/derived/video/${result.videoId.slice(6)}/map.json` ||
      ['prepared', 'succeeded'].includes(result.status) && !result.map || ['succeeded', 'failed', 'interrupted'].includes(result.status) && !result.finishedAt ||
      ['running', 'prepared'].includes(result.status) && result.finishedAt !== null || result.status === 'running' && result.map !== null ||
      ['failed', 'interrupted'].includes(result.status) && result.error === null ||
      ['running', 'prepared', 'succeeded'].includes(result.status) && result.error !== null) throw Error('VIDEO_RECEIPT_BINDING_INVALID'); return result;
}
export function validateVideoPublication(value: unknown, receiptData: Buffer, mapPath: string, mapData: Buffer): VideoPublication {
  const result = assertVideo<VideoPublication>('publication', value), receipt = validateVideoReceipt(JSON.parse(receiptData.toString('utf8'))),
    prepared = validatePreparedVideoMap(JSON.parse(mapData.toString('utf8'))), hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  if (result.version !== receipt.version || receipt.version !== prepared.version || result.receipt.path !== `runs/${receipt.attemptId}/receipt.json` || result.receipt.bytes !== receiptData.length || result.receipt.sha256 !== hash(receiptData) ||
      receipt.status !== 'succeeded' || !receipt.map || receipt.map.path !== mapPath || receipt.map.bytes !== mapData.length || receipt.map.sha256 !== hash(mapData) ||
      prepared.canonical.path !== mapPath.replace(/map\.json$/, 'frames.rgba') || JSON.stringify(prepared.request) !== JSON.stringify(receipt.request)) throw Error('VIDEO_PUBLICATION_INVALID');
  if (prepared.version === '0.2' && JSON.stringify(prepared.limits) !== JSON.stringify(receipt.limits)) throw Error('VIDEO_PUBLICATION_POLICY_INVALID');
  return result;
}
/** Rational source PTS and a previous-frame hold; every output instant is computed from the original range start. */
export function videoFrameSourceIndices(sourceFrames: readonly VideoSourceFrame[], range: VideoPreparationRequest['sourceRange'], fps: number, maximumFrames = 600, sourceEndPts?: string): number[] {
  const [num, den] = range.timeBase.split('/').map(BigInt), start = BigInt(range.startPts), end = BigInt(range.endPts);
  if (!sourceFrames.length || end <= start || ![12, 15, 24, 25, 30, 60].includes(fps)) throw Error('VIDEO_SOURCE_RANGE_INVALID');
  const pts = sourceFrames.map(frame => BigInt(frame.pts));
  if (sourceFrames.some((frame, i) => frame.duration !== null && BigInt(frame.duration) <= 0n || i > 0 && pts[i]! <= pts[i - 1]!) ||
      start < pts[0]! || end > (sourceEndPts === undefined ? pts.at(-1)! + BigInt(sourceFrames.at(-1)!.duration ?? '0') : BigInt(sourceEndPts))) throw Error('VIDEO_SOURCE_FRAMES_INVALID');
  const count = ((end - start) * num! * BigInt(fps) + den! - 1n) / den!;
  if (!Number.isSafeInteger(maximumFrames) || maximumFrames < 1 || count <= 0n || count > BigInt(maximumFrames)) throw Error('VIDEO_PROXY_FRAME_LIMIT');
  const result: number[] = []; let source = 0;
  for (let i = 0; i < Number(count); i++) {
    const instant = start * num! * BigInt(fps) + BigInt(i) * den!;
    while (source + 1 < pts.length && pts[source + 1]! * num! * BigInt(fps) <= instant) source++;
    result.push(source);
  }
  return result;
}
export function validatePreparedVideoMap(value: unknown, maximum?: AnyVideoPreparationLimits): PreparedVideoMap {
  const result = assertVideo<PreparedVideoMap>('map', value);
  if (result.version === '0.2') return validateProductionMap(result, maximum);
  const r = validateVideoPreparationRequest(result.request), l = videoPreparationLimits(result.limits) as VideoPreparationLimits;
  maximum = maximum ?? DEFAULT_VIDEO_PREPARATION_LIMITS; videoPreparationLimits(maximum);
  if ('version' in maximum) throw Error('VIDEO_LEGACY_POLICY_INVALID'); validateAudioInputRuntime(result.runtime);
  for (const key of Object.keys(l) as (keyof VideoPreparationLimits)[]) if (l[key] > maximum[key]) throw Error('VIDEO_POLICY_LIMIT_INVALID');
  const video = result.sourceVideo, c = result.canonical, [num, den] = video.timeBase.split('/').map(BigInt);
  const indices = videoFrameSourceIndices(video.sourceFrames, r.sourceRange, r.fps);
  const bytes = c.width * c.height * 4 * c.frames;
  if (result.policySha256 !== createHash('sha256').update(JSON.stringify(l)).digest('hex') || result.source.sha256 !== r.byteSha256 ||
      result.source.bytes > l.maxSourceBytes || video.streamIndex !== r.streamIndex || video.timeBase !== r.sourceRange.timeBase ||
      video.width * video.height > l.maxSourcePixels || video.sourceFrames.length > l.maxSourceFrames ||
      (BigInt(video.sourceFrames.at(-1)!.pts) + BigInt(video.sourceFrames.at(-1)!.duration ?? '0') - BigInt(video.sourceFrames[0]!.pts)) * num! * 1000n > BigInt(l.maxDurationMs) * den! ||
      c.width % 2 || c.height % 2 || c.width > l.maxProxyEdge || c.height > l.maxProxyEdge || c.width > video.width || c.height > video.height ||
      !Number.isSafeInteger(bytes) || c.bytes !== bytes || bytes > l.maxRgbaBytes || c.frames !== indices.length || c.frames > l.maxProxyFrames || c.fps !== r.fps ||
      result.proxy.bytes > l.maxProxyBytes || result.frames.length !== indices.length ||
      result.coverage.startPts !== r.sourceRange.startPts || result.coverage.endPts !== r.sourceRange.endPts) throw Error('VIDEO_MAP_BINDING_INVALID');
  const prefix = `assets/derived/video/`;
  if (![c.path, result.proxy.path].every(path => safeUnpackPath(path) && path.startsWith(prefix)) ||
      !new RegExp(`^assets/derived/video/${UUID_PATTERN}/frames\\.rgba$`).test(c.path) || result.proxy.path !== c.path.replace(/frames\.rgba$/, 'proxy.mp4')) throw Error('VIDEO_OUTPUT_PATH_INVALID');
  if (result.frames.some((frame, i) => frame.sourceIndex !== indices[i] || frame.sourcePts !== video.sourceFrames[indices[i]!]!.pts || frame.rgbaSha256 !== video.sourceFrames[indices[i]!]!.rgbaSha256)) throw Error('VIDEO_FRAME_MAPPING_INVALID');
  if (Object.values(result.commands).some(run => run.exitCode !== 0 || run.signal !== null || run.error !== null ||
      run.stdoutBytes !== Buffer.byteLength(run.stdout) || run.stderrBytes !== Buffer.byteLength(run.stderr) || run.elapsedMs > l.maxToolElapsedMs)) throw Error('VIDEO_COMMAND_INVALID');
  if (Buffer.byteLength(JSON.stringify(result)) > l.maxMapBytes) throw Error('VIDEO_MAP_LIMIT');
  return result;
}

export function videoAudioSamples(range: VideoPreparationRequest['sourceRange']): number {
  const [num, den] = range.timeBase.split('/').map(BigInt), span = BigInt(range.endPts) - BigInt(range.startPts);
  const samples = (span * num! * 48000n * 2n + den!) / (den! * 2n);
  if (span <= 0n || samples < 1n || samples > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('VIDEO_AUDIO_SAMPLE_RANGE_INVALID');
  return Number(samples);
}

function validateProductionMap(result: ProductionPreparedVideoMap, maximum?: AnyVideoPreparationLimits): ProductionPreparedVideoMap {
  const r = validateVideoPreparationRequest(result.request) as ProductionVideoPreparationRequest, l = productionVideoPreparationLimits(result.limits);
  validateAudioInputRuntime(result.runtime);
  if (maximum) {
    const maximumPolicy = productionVideoPreparationLimits(maximum);
    for (const key of Object.keys(l) as (keyof ProductionVideoPreparationLimits)[]) {
      if (key !== 'version' && key !== 'minFreeBytes' && l[key] > maximumPolicy[key]) throw Error('VIDEO_POLICY_LIMIT_INVALID');
    }
    if (l.minFreeBytes < maximumPolicy.minFreeBytes) throw Error('VIDEO_POLICY_LIMIT_INVALID');
  }
  const v = result.sourceVideo, c = result.canonical, frameBytes = c.width * c.height * 4,
    [num, den] = r.sourceRange.timeBase.split('/').map(BigInt),
    expectedFrames = ((BigInt(r.sourceRange.endPts) - BigInt(r.sourceRange.startPts)) * num! * BigInt(r.fps) + den! - 1n) / den!;
  if (expectedFrames > BigInt(Number.MAX_SAFE_INTEGER) || c.frames !== Number(expectedFrames) || result.frames.length !== c.frames ||
      Buffer.byteLength(JSON.stringify(result)) > l.maxMapBytes) throw Error('VIDEO_MAP_BINDING_INVALID');
  const indices = videoFrameSourceIndices(v.sourceFrames, r.sourceRange, r.fps, Math.floor(l.maxRgbaBytes / frameBytes), v.endPts);
  const scale = Math.min(1, l.maxProxyEdge / Math.max(c.width, c.height)), proxyWidth = Math.floor(c.width * scale / 2) * 2,
    proxyHeight = Math.floor(c.height * scale / 2) * 2;
  if (result.policySha256 !== createHash('sha256').update(JSON.stringify(l)).digest('hex') || result.source.sha256 !== r.byteSha256 ||
      result.source.bytes > l.maxSourceBytes || v.streamIndex !== r.streamIndex || v.timeBase !== r.sourceRange.timeBase ||
      v.width * v.height > l.maxSourcePixels || v.sourceFrameCount < v.sourceFrames.length ||
      BigInt(v.startPts) > BigInt(v.sourceFrames[0]!.pts) || BigInt(v.endPts) < BigInt(v.sourceFrames.at(-1)!.pts) + BigInt(v.sourceFrames.at(-1)!.duration ?? '0') ||
      BigInt(r.sourceRange.startPts) < BigInt(v.startPts) || BigInt(r.sourceRange.endPts) > BigInt(v.endPts) ||
      c.width !== (r.output.width ?? v.width) || c.height !== (r.output.height ?? v.height) || c.width > v.width || c.height > v.height ||
      c.width % 2 || c.height % 2 || c.width * v.height !== c.height * v.width ||
      !Number.isSafeInteger(frameBytes) || frameBytes * 2 > l.maxResidentBytes || !Number.isSafeInteger(frameBytes * c.frames) ||
      c.bytes !== frameBytes * c.frames || c.bytes > l.maxRgbaBytes || c.frames !== indices.length || c.fps !== r.fps ||
      result.frames.length !== indices.length || result.proxy.width !== proxyWidth || result.proxy.height !== proxyHeight ||
      !proxyWidth || !proxyHeight || result.proxy.bytes > l.maxProxyBytes ||
      result.coverage.startPts !== r.sourceRange.startPts || result.coverage.endPts !== r.sourceRange.endPts) throw Error('VIDEO_MAP_BINDING_INVALID');
  if (!new RegExp(`^assets/derived/video/${UUID_PATTERN}/frames\\.rgba$`).test(c.path) || !safeUnpackPath(c.path) ||
      result.proxy.path !== c.path.replace(/frames\.rgba$/, 'proxy.mp4')) throw Error('VIDEO_OUTPUT_PATH_INVALID');
  if (result.frames.some((frame, i) => frame.sourceIndex !== indices[i] || frame.sourcePts !== v.sourceFrames[indices[i]!]!.pts ||
      frame.rgbaSha256 !== v.sourceFrames[indices[i]!]!.rgbaSha256)) throw Error('VIDEO_FRAME_MAPPING_INVALID');
  const expectedAudio = !result.sourceAudio ? 'absent' : r.mute ? 'muted' : 'preserved';
  if (result.sourceAudio?.streamIndex === r.streamIndex || result.coverage.audio !== expectedAudio ||
      (expectedAudio === 'preserved') !== (result.audio !== null && result.commands.audio !== null) ||
      expectedAudio !== 'preserved' && (result.audio !== null || result.commands.audio !== null)) throw Error('VIDEO_AUDIO_BINDING_INVALID');
  if (result.audio && (result.audio.path !== c.path.replace(/frames\.rgba$/, 'source-audio.wav') ||
      result.audio.samples !== videoAudioSamples(r.sourceRange) || result.audio.bytes !== 44 + result.audio.samples * 4 ||
      result.audio.bytes > l.maxAudioBytes || result.audio.bytes - 8 > 4294967295 || result.commands.audio!.binaryBytes !== result.audio.samples * 4)) throw Error('VIDEO_AUDIO_BINDING_INVALID');
  if (Object.values(result.commands).some(run => run && (run.exitCode !== 0 || run.signal !== null || run.error !== null ||
      run.stdoutBytes !== Buffer.byteLength(run.stdout) || run.stderrBytes !== Buffer.byteLength(run.stderr) || run.elapsedMs > l.maxToolElapsedMs))) throw Error('VIDEO_COMMAND_INVALID');
  if (Buffer.byteLength(JSON.stringify(result)) > l.maxMapBytes) throw Error('VIDEO_MAP_LIMIT');
  return result;
}
