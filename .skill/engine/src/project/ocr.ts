import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { UUID_PATTERN } from './unpack.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

// Frozen adoption defaults for inspect policy 0.3.
export const DEFAULT_OCR_LIMITS = Object.freeze({ maxOcrSourceBytes: 33554432, maxOcrImagesPerAttempt: 20,
  maxOcrSourcePixels: 16000000, maxOcrEdge: 8192, maxOcrRasterBytes: 48000128, maxOcrTsvBytes: 8388608,
  maxOcrRows: 100000, maxOcrRegions: 20000, maxOcrTextBytes: 2097152, maxOcrMapBytes: 4194304,
  maxImageStructureEntries: 4096, maxOcrWordBytes: 4096, maxOcrRowBytes: 16384, concurrency: 1 });
export const INSPECT_POLICY_03_OCR_DEFAULTS = Object.freeze({ enabled: true, ...DEFAULT_OCR_LIMITS });
export type OcrLimits = { [K in keyof typeof DEFAULT_OCR_LIMITS]: number };
export type OcrPolicy = OcrLimits & { enabled: boolean };
export interface OcrImageHeader { format: 'png_pipe' | 'jpeg_pipe'; width: number; height: number }
export interface NativeFileIdentity { path: string; bytes: number; sha256: string }
export interface NativeToolIdentity { executable: string; version: string; files: NativeFileIdentity[]; aliases: { path: string; realpath: string }[] }
export interface OcrModelIdentity { code: 'eng' | 'chi_sim'; bytes: number; gitBlobSha1: string; sha256: string; sourceCommit: string; path: string; secondary: string[] }
export interface OcrNativeLock { version: '0.1'; kind: 'ocr-dependencies'; platform: 'darwin'; arch: 'arm64';
  tools: { ffmpeg: NativeToolIdentity; ffprobe: NativeToolIdentity; tesseract: NativeToolIdentity }; models: OcrModelIdentity[];
  languageSpec: 'chi_sim+eng+~chi_sim_vert'; oem: 1; psm: 3; dpi: 300 }
export interface OcrEngineIdentity { id: 'tesseract'; version: '5.5.0'; lockSha256: string; platform: 'darwin'; arch: 'arm64';
  tools: OcrNativeLock['tools']; models: OcrModelIdentity[]; languageSpec: 'chi_sim+eng+~chi_sim_vert'; oem: 1; psm: 3; dpi: 300 }
export interface OcrRegion { id: string; ordinal: number; row: number; level: 5; page: 1; block: number; paragraph: number; line: number; word: number;
  x: number; y: number; width: number; height: number; engineConfidence: number | null; byteStart: number; byteEnd: number }
export interface OcrMap { version: '0.1'; kind: 'ocr-map'; format: 'png_pipe' | 'jpeg_pipe'; mapperVersion: 'ocr-tsv@0.1';
  status: 'text' | 'no-text'; scope: 'single-image-ocr'; policySha256: string; source: { bytes: number; sha256: string; width: number; height: number };
  raster: { evidenceId: string; bytes: number; sha256: string; width: number; height: number; encoding: 'P6/RGB8'; background: 'white'; transform: 'identity'; orientationApplied: false };
  rawTsv: { evidenceId: string; bytes: number; sha256: string }; text: { evidenceId: string; bytes: number; sha256: string };
  engine: OcrEngineIdentity; regions: OcrRegion[] }
export interface OcrDescriptor { version: '0.1'; status: 'completed' | 'no-text' | 'disabled' | 'skipped' | 'failed'; reason: string;
  scope: 'single-image-ocr'; engine: OcrEngineIdentity | null; rasterEvidenceId: string | null; tsvEvidenceId: string | null;
  textEvidenceId: string | null; mapEvidenceId: string | null; regions: number }
export interface OcrObservation { version: '0.3'; id: string; assetId: string; assetVersion: string; byteSha256: string; method: string;
  locator: { kind: 'ocr'; evidenceId: string; mapEvidenceId: string; rasterEvidenceId: string; regionId: string; byteStart: number; byteEnd: number };
  coverage: 'full' | 'partial' | 'sample'; coverageScope: 'region-ocr-text'; statement: string; basis: 'observed' | 'estimated' | 'unknown';
  confidence: number | null; limitations: string[]; evidenceRefs: string[] }

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items }), strings = array(string);
const evidenceId = { ...string, pattern: `^evidence-${UUID_PATTERN}$` };
const nativePath = { ...nonempty, pattern: '^/(?![\\s\\S]*[\\u0000-\\u001f\\u007f])' };
const nativeTool = object({ executable: nativePath, version: nonempty, files: { ...array(object({ path: nativePath, bytes: positive, sha256: hash })), minItems: 1, maxItems: 256 },
  aliases: { ...array(object({ path: nativePath, realpath: nativePath })), minItems: 1, maxItems: 512 } });
const model = object({ code: { enum: ['eng', 'chi_sim'] }, bytes: positive, gitBlobSha1: { ...string, pattern: '^[a-f0-9]{40}$' }, sha256: hash,
  sourceCommit: { const: '65727574dfcd264acbb0c3e07860e4e9e9b22185' }, path: { enum: ['assets/ocr/tessdata/eng.traineddata', 'assets/ocr/tessdata/chi_sim.traineddata'] }, secondary: { ...strings, maxItems: 0 } });
const nativeProperties = { platform: { const: 'darwin' }, arch: { const: 'arm64' }, tools: object({ ffmpeg: nativeTool, ffprobe: nativeTool, tesseract: nativeTool }),
  models: { ...array(model), minItems: 2, maxItems: 2 }, languageSpec: { const: 'chi_sim+eng+~chi_sim_vert' }, oem: { const: 1 }, psm: { const: 3 }, dpi: { const: 300 } };
const engine = object({ id: { const: 'tesseract' }, version: { const: '5.5.0' }, lockSha256: hash, ...nativeProperties });
export const OCR_LIMITS_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_OCR_LIMITS).map(([key, maximum]) =>
  [key, key === 'concurrency' ? { const: 1 } : { ...integer, maximum }])));
export const OCR_POLICY_SCHEMA = object({ enabled: { type: 'boolean' }, ...OCR_LIMITS_SCHEMA.properties });
export const OCR_REGION_SCHEMA = object({ id: { ...string, pattern: '^ocr-word-[1-9][0-9]*$' }, ordinal: positive, row: positive, level: { const: 5 }, page: { const: 1 },
  block: positive, paragraph: positive, line: positive, word: positive, x: integer, y: integer, width: positive, height: positive,
  engineConfidence: nullable({ type: 'number', minimum: 0, maximum: 100 }), byteStart: integer, byteEnd: positive });
const map = object({ version: { const: '0.1' }, kind: { const: 'ocr-map' }, format: { enum: ['png_pipe', 'jpeg_pipe'] }, mapperVersion: { const: 'ocr-tsv@0.1' },
  status: { enum: ['text', 'no-text'] }, scope: { const: 'single-image-ocr' }, policySha256: hash, source: object({ bytes: positive, sha256: hash, width: positive, height: positive }),
  raster: object({ evidenceId, bytes: positive, sha256: hash, width: positive, height: positive, encoding: { const: 'P6/RGB8' }, background: { const: 'white' }, transform: { const: 'identity' }, orientationApplied: { const: false } }),
  rawTsv: object({ evidenceId, bytes: positive, sha256: hash }), text: object({ evidenceId, bytes: integer, sha256: hash }), engine, regions: { ...array(OCR_REGION_SCHEMA), maxItems: DEFAULT_OCR_LIMITS.maxOcrRegions } });
export const OCR_DESCRIPTOR_SCHEMA = object({ version: { const: '0.1' }, status: { enum: ['completed', 'no-text', 'disabled', 'skipped', 'failed'] }, reason: string,
  scope: { const: 'single-image-ocr' }, engine: nullable(engine), rasterEvidenceId: nullable(evidenceId), tsvEvidenceId: nullable(evidenceId),
  textEvidenceId: nullable(evidenceId), mapEvidenceId: nullable(evidenceId), regions: integer });
export const OCR_OBSERVATION_SCHEMA = object({ version: { const: '0.3' }, id: { ...string, pattern: `^observation-${UUID_PATTERN}$` },
  assetId: { ...string, pattern: `^asset-${UUID_PATTERN}$` }, assetVersion: { ...string, pattern: `^asset-version-${UUID_PATTERN}$` }, byteSha256: hash, method: nonempty,
  locator: object({ kind: { const: 'ocr' }, evidenceId, mapEvidenceId: evidenceId, rasterEvidenceId: evidenceId, regionId: nonempty, byteStart: integer, byteEnd: positive }),
  coverage: { enum: ['full', 'partial', 'sample'] }, coverageScope: { const: 'region-ocr-text' }, statement: nonempty,
  basis: { enum: ['observed', 'estimated', 'unknown'] }, confidence: nullable({ type: 'number', minimum: 0, maximum: 1 }), limitations: strings, evidenceRefs: { ...strings, uniqueItems: true } });
export const OCR_SCHEMAS = { map, observation: OCR_OBSERVATION_SCHEMA, lock: object({ version: { const: '0.1' }, kind: { const: 'ocr-dependencies' }, ...nativeProperties }), engine };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(OCR_SCHEMAS).map(([name, value]) => [name, ajv.compile(value as Schema)]));
export function assertOcr<T>(kind: keyof typeof OCR_SCHEMAS, value: unknown): T {
  const validate = validators[kind]; if (!validate(value)) throw new Error(`OCR_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(validate, value).join('; ')}`); return value as T;
}
export function validateOcrEngine(engine: OcrEngineIdentity): void {
  assertOcr('engine', engine);
  for (const tool of Object.values(engine.tools)) {
    const files = new Set(tool.files.map(f => f.path)), aliases = new Set(tool.aliases.map(a => a.path));
    if (files.size !== tool.files.length || aliases.size !== tool.aliases.length || !files.has(tool.executable) || tool.aliases.some(a => !files.has(a.realpath))) throw new Error('OCR_NATIVE_IDENTITY_INVALID');
  }
  if (engine.models.map(m => m.code).join('+') !== 'eng+chi_sim' || engine.models.some(m => m.path !== `assets/ocr/tessdata/${m.code}.traineddata`) ||
      engine.models[0]!.bytes !== 4113088 || engine.models[0]!.sha256 !== '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' ||
      engine.models[0]!.gitBlobSha1 !== 'bbef4675053b5b468cdb477053e28b1c698ba08e' || engine.models[1]!.bytes !== 2469156 ||
      engine.models[1]!.sha256 !== 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730' || engine.models[1]!.gitBlobSha1 !== '388bac276d033d06e5ed5ba7a7ad14ae58f97dab') throw new Error('OCR_MODEL_IDENTITY_INVALID');
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export function validateOcrMap(map: OcrMap, text: Buffer, raster: Buffer, tsv: Buffer, limits: OcrLimits): void {
  assertOcr('map', map); validateOcrArtifacts(map, text, raster, tsv, limits);
}
export function validateOcrArtifacts(map: Pick<OcrMap, 'engine' | 'raster' | 'rawTsv' | 'text' | 'regions' | 'status'> & { source: Pick<OcrMap['source'], 'width' | 'height' | 'bytes'> }, text: Buffer, raster: Buffer, tsv: Buffer, limits: OcrLimits): void {
  validateOcrEngine(map.engine);
  const { width, height } = map.source, header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  if (width > limits.maxOcrEdge || height > limits.maxOcrEdge || width * height > limits.maxOcrSourcePixels || map.source.bytes > limits.maxOcrSourceBytes ||
      raster.length > limits.maxOcrRasterBytes || tsv.length > limits.maxOcrTsvBytes || text.length > limits.maxOcrTextBytes || map.regions.length > limits.maxOcrRegions ||
      map.raster.width !== width || map.raster.height !== height || raster.length !== header.length + 3 * width * height || !raster.subarray(0, header.length).equals(header) ||
      map.raster.bytes !== raster.length || map.raster.sha256 !== digest(raster) || map.rawTsv.bytes !== tsv.length || map.rawTsv.sha256 !== digest(tsv) ||
      map.text.bytes !== text.length || map.text.sha256 !== digest(text) || new Set([map.raster.evidenceId, map.rawTsv.evidenceId, map.text.evidenceId]).size !== 3) throw new Error('OCR_ARTIFACT_INVALID');
  new TextDecoder('utf-8', { fatal: true }).decode(text);
  if (text.subarray(0, 3).equals(Buffer.from('efbbbf', 'hex')) || text.includes(0) || text.includes(13)) throw new Error('OCR_TEXT_INVALID');
  const identities = new Set<string>(); let end = 0, previous: OcrRegion | undefined;
  for (const r of map.regions) {
    const key = [r.page, r.block, r.paragraph, r.line, r.word].join('/'), sameLine = previous && [previous.block, previous.paragraph, previous.line].join('/') === [r.block, r.paragraph, r.line].join('/');
    if (r.ordinal !== identities.size + 1 || r.id !== `ocr-word-${r.ordinal}` || identities.has(key) || r.row > limits.maxOcrRows || previous && r.row <= previous.row ||
        r.x + r.width > width || r.y + r.height > height || r.byteStart !== end + (previous ? 1 : 0) || r.byteEnd <= r.byteStart || r.byteEnd > text.length ||
        r.byteEnd - r.byteStart > limits.maxOcrWordBytes || previous && text[end] !== (sameLine ? 32 : 10) ||
        (text[r.byteStart]! & 0xc0) === 0x80 || r.byteEnd < text.length && (text[r.byteEnd]! & 0xc0) === 0x80) throw new Error('OCR_REGION_INVALID');
    identities.add(key); end = r.byteEnd; previous = r;
  }
  if (end !== text.length || map.status !== (map.regions.length ? 'text' : 'no-text')) throw new Error('OCR_COVERAGE_INVALID');
}
export function validateOcrObservation(record: OcrObservation, map: OcrMap, text: Buffer): void {
  assertOcr('observation', record); const loc = record.locator, region = map.regions.find(r => r.id === loc.regionId);
  if (loc.evidenceId !== map.text.evidenceId || loc.rasterEvidenceId !== map.raster.evidenceId || ![loc.evidenceId, loc.mapEvidenceId, loc.rasterEvidenceId].every(id => record.evidenceRefs.includes(id))) throw new Error('CATALOG_OCR_OBSERVATION_EVIDENCE_MISMATCH');
  if (!region || loc.byteStart < region.byteStart || loc.byteEnd > region.byteEnd || loc.byteEnd <= loc.byteStart) throw new Error('CATALOG_OCR_REGION_RANGE_INVALID');
  for (const pos of [loc.byteStart, loc.byteEnd]) if (pos < text.length && (text[pos]! & 0xc0) === 0x80) throw new Error('CATALOG_OCR_UTF8_BOUNDARY_INVALID');
  if (record.coverage === 'full' && (loc.byteStart !== region.byteStart || loc.byteEnd !== region.byteEnd)) throw new Error('CATALOG_OCR_COVERAGE_INVALID');
}
