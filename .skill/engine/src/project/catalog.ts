import { INSPECT_POLICY_02_DOCUMENT_LIMITS, DOCUMENT_LIMITS_SCHEMA, DEFAULT_OFFICE_LIMITS, OFFICE_LIMITS_SCHEMA, INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS, DOCUMENT_OCR_POLICY_SCHEMA, validateDocumentOcrPolicy, type OfficeLimits, type DocumentLimits, type DocumentOcrPolicy } from './catalog-legacy-policy.ts';
import { Ajv, type Schema } from 'ajv';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { UUID_PATTERN, safeUnpackPath } from './unpack.ts';
import { INSPECT_POLICY_03_OCR_DEFAULTS, DEFAULT_OCR_LIMITS, OCR_POLICY_SCHEMA, OCR_DESCRIPTOR_SCHEMA, OCR_OBSERVATION_SCHEMA, OCR_SCHEMAS, type OcrPolicy, type OcrLimits, type OcrDescriptor, type OcrObservation } from './ocr.ts';

import { INSPECT_POLICY_04_ASR_DEFAULTS, ASR_POLICY_SCHEMA, ASR_DESCRIPTOR_SCHEMA, ASR_DESCRIPTOR_SCHEMA_02, ASR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA_05, ASR_SCHEMAS, type AsrPolicy, type AsrLimits, type AsrDescriptor, type AsrObservation } from './asr.ts';

import { DEFAULT_AUDIO_INPUT_LIMITS, AUDIO_INPUT_POLICY_SCHEMA, AUDIO_INPUT_DESCRIPTOR_SCHEMA, AUDIO_INPUT_SCHEMAS, type AudioInputLimits, type AudioInputDescriptor } from './audio-input.ts';


export const LEGACY_INSPECT_POLICY = Object.freeze({ version: '0.1' as const, maxSelectedFiles: 5000, maxSourceBytes: 1073741824,
  maxTotalSourceBytes: 4294967296, maxTextBytes: 16777216, maxCatalogBytes: 16777216, maxStreamsPerAsset: 32,
  maxSourcePixels: 40000000, maxToolOutputBytes: 1048576, maxDerivedBytes: 268435456, maxDecodedAudioBytes: 134217728,
  maxVideoSamplesPerAsset: 6, defaultVideoSamplesPerAsset: 3, maxPreviewEdge: 1280, maxToolElapsedMs: 30000, maxElapsedMs: 300000 });
export type LegacyInspectPolicy = { [K in keyof typeof LEGACY_INSPECT_POLICY]: typeof LEGACY_INSPECT_POLICY[K] extends number ? number : '0.1' };
export const INSPECT_POLICY_02 = Object.freeze({ ...LEGACY_INSPECT_POLICY, version: '0.2' as const, document: INSPECT_POLICY_02_DOCUMENT_LIMITS });
export type InspectPolicy = LegacyInspectPolicy | (Omit<LegacyInspectPolicy, 'version'> & { version: '0.2'; document: DocumentLimits }) |
  (Omit<LegacyInspectPolicy, 'version'> & { version: '0.3'; document: DocumentLimits; ocr: OcrPolicy }) | (Omit<LegacyInspectPolicy, 'version'> & { version: '0.4'; document: DocumentLimits; ocr: OcrPolicy; asr: AsrPolicy }) |
  (Omit<LegacyInspectPolicy, 'version'> & { version: '0.5'; document: DocumentLimits; ocr: OcrPolicy; asr: AsrPolicy; audioInput: AudioInputLimits }) |
  (Omit<LegacyInspectPolicy, 'version'> & { version: '0.6'; document: DocumentLimits; ocr: OcrPolicy; asr: AsrPolicy; audioInput: AudioInputLimits; documentOcr: DocumentOcrPolicy }) |
  (Omit<LegacyInspectPolicy, 'version'> & { version: '0.7'; document: DocumentLimits; ocr: OcrPolicy; asr: AsrPolicy; audioInput: AudioInputLimits; documentOcr: DocumentOcrPolicy; office: OfficeLimits });
export const INSPECT_POLICY_03 = Object.freeze({ ...INSPECT_POLICY_02, version: '0.3' as const, ocr: INSPECT_POLICY_03_OCR_DEFAULTS });
export const DEFAULT_INSPECT_POLICY = Object.freeze({ ...INSPECT_POLICY_03, version: '0.4' as const, asr: INSPECT_POLICY_04_ASR_DEFAULTS });
export const INSPECT_POLICY_05 = Object.freeze({ ...DEFAULT_INSPECT_POLICY, version: '0.5' as const, audioInput: DEFAULT_AUDIO_INPUT_LIMITS });
export const INSPECT_POLICY_06 = Object.freeze({ ...INSPECT_POLICY_05, version: '0.6' as const, documentOcr: INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS });
export const INSPECT_POLICY_07 = Object.freeze({ ...INSPECT_POLICY_06, version: '0.7' as const, office: DEFAULT_OFFICE_LIMITS });
export const catalogIdPattern = new RegExp(`^catalog-${UUID_PATTERN}$`), catalogAttemptPattern = new RegExp(`^catalog-attempt-${UUID_PATTERN}$`);
export interface CatalogSource { kind: 'import' | 'unpack'; importId: string; importManifestSha256: string; unpackId: string | null; unpackManifestSha256: string | null; path: string; fixedPath: string; bytes: number; sha256: string }
export interface Evidence { id: string; kind: 'text' | 'preview' | 'frame' | 'probe' | 'audio-pcm' | 'ocr-raster' | 'ocr-tsv' | 'ocr-map' | 'asr-audio' | 'asr-json' | 'asr-map' | 'audio-canonical' | 'audio-input-map'; path: string; bytes: number; sha256: string;
  width: number | null; height: number | null; sourceWidth: number | null; sourceHeight: number | null; transform: string | null;
  streamIndex: number | null; timeBase: string | null; pts: string | null; requestedTime: number | null; actualTime: number | null;
  sampleRate: number | null; samples: number | null; coverage: 'full' | 'partial' | 'sample'; }
export interface MediaStream { index: number; type: string; codec: string | null; width: number | null; height: number | null; pixelFormat: string | null;
  sampleRate: number | null; channels: number | null; timeBase: string | null; startPts: string | null; durationTs: string | null;
  startTime: number | null; duration: number | null; avgFrameRate: string | null; rFrameRate: string | null; rotation: number | null; raw: string }
export interface Technical { status: 'supported' | 'partial' | 'failed' | 'unsupported' | 'requires-unpack'; format: string; method: string; reason: string;
  raw: string | null; streams: MediaStream[]; evidence: Evidence[]; text: { bytes: number; lines: number; bom: boolean; lineEndings: string } | null;
  containerDuration: number | null; limitations: string[]; ocr?: OcrDescriptor; asr?: AsrDescriptor; audioInput?: AudioInputDescriptor; }
export interface LegacyObservation { version: '0.1'; id: string; assetId: string; assetVersion: string; byteSha256: string; method: string;
  locator: { kind: 'text' | 'image' | 'video' | 'audio'; evidenceId: string; byteStart: number | null; byteEnd: number | null; lineStart: number | null; lineEnd: number | null;
    x: number | null; y: number | null; width: number | null; height: number | null; streamIndex: number | null; timeBase: string | null; pts: string | null;
    sampleRate: number | null; sampleStart: number | null; sampleEnd: number | null; };
  coverage: 'full' | 'partial' | 'sample'; statement: string; basis: 'observed' | 'estimated' | 'unknown'; confidence: number | null; limitations: string[]; evidenceRefs: string[]; }
export type Observation = LegacyObservation | OcrObservation | AsrObservation;
export interface Rights { version: '0.1'; id: string; revision: number; assetId: string; assetVersion: string; byteSha256: string;
  status: 'unknown' | 'user-declared' | 'documented'; sourceRefs: { kind: 'prompt' | 'license'; path: string; bytes: number; sha256: string; statement: string }[];
  allowedUses: string[]; restrictions: string[]; attribution: string | null; affectedStreams: number[]; thirdPartyRightsStatus: 'unknown' | 'user-declared' | 'documented'; }
export interface AssetVersion { assetId: string; assetVersion: string; inspectionId: string; inspection: { catalogId: string; attemptId: string; policySha256: string; policySourceSha256: string }; source: CatalogSource; technical: Technical;
  usability: { technical: { result: string; reason: string }; semanticMatch: { result: string; reason: string }; compositionFit: { result: string; reason: string }; continuityFit: { result: string; reason: string }; rightsScope: { result: string; reason: string } }; }
export interface ToolRun { executable: string; version: string; argv: string[]; exitCode: number | null; signal: string | null; stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number; binaryBytes: number; elapsedMs: number; error: string | null }
export interface CatalogCounts { selectedFiles: number; sourceBytes: number; sourceReadBytes: number; derivedBytes: number; decodedAudioBytes: number; toolOutputBytes: number; elapsedMs: number }
export interface CatalogManifest { version: '0.1' | '0.2' | '0.3' | '0.4' | '0.5' | '0.6' | '0.7'; kind: 'catalog-manifest'; catalogId: string; attemptId: string; createdAt: string; previousCatalogId: string | null;
  policy: InspectPolicy; policySha256: string; policySourceSha256: string; counts: CatalogCounts; tools: ToolRun[]; assets: AssetVersion[]; observations: Observation[]; rights: Rights[]; recordSnapshot: { path: string; sha256: string; bytes: number } | null; }
export interface CatalogIndex { version: '0.1' | '0.2' | '0.3' | '0.4' | '0.5' | '0.6' | '0.7'; kind: 'catalog-index'; currentCatalogId: string; catalogs: { catalogId: string; attemptId: string; manifestSha256: string }[]; assets: { assetId: string; currentVersion: string }[]; }
export type CatalogSelection = { importId: string; path?: string; assetId?: string } | { unpackId: string; path?: string; assetId?: string } | { observation: string } | { rights: string };
export interface CatalogReceipt { version: '0.1' | '0.2' | '0.3' | '0.4' | '0.5' | '0.6' | '0.7'; kind: 'catalog-receipt'; catalogId: string; attemptId: string; ownerPid: number; startedAt: string; finishedAt: string | null;
  status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted'; phase: 'planning' | 'inspecting' | 'verifying' | 'committing'; selection: string;
  policy: InspectPolicy | null; policySha256: string | null; policySourceSha256: string | null; counts: CatalogCounts; tools: ToolRun[]; assets: AssetVersion[];
  tempPath: string; manifestPath: string | null; manifestSha256: string | null; indexCommitted: boolean; error: string | null; }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 }, string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const nullable = (s: unknown) => ({ anyOf: [s, { type: 'null' }] }), number = { type: 'number' }, strings = { type: 'array', items: string }, integers = { type: 'array', items: integer, uniqueItems: true };
const id = (prefix: string) => ({ ...string, pattern: `^${prefix}-${UUID_PATTERN}$` });
const path = { ...nonempty, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
const legacyPolicy = object(Object.fromEntries(Object.keys(LEGACY_INSPECT_POLICY).map(key => [key, key === 'version' ? { const: '0.1' } : key.endsWith('Ms') ? { ...positive, maximum: 2147483647 } : integer])));
const documentPolicy = object({ ...legacyPolicy.properties, version: { const: '0.2' }, document: DOCUMENT_LIMITS_SCHEMA });
const ocrPolicy = object({ ...documentPolicy.properties, version: { const: '0.3' }, ocr: OCR_POLICY_SCHEMA });
const asrPolicy = object({ ...ocrPolicy.properties, version: { const: '0.4' }, asr: ASR_POLICY_SCHEMA });
const audioPolicy = object({ ...asrPolicy.properties, version: { const: '0.5' }, audioInput: AUDIO_INPUT_POLICY_SCHEMA });
const documentOcrPolicy = object({ ...audioPolicy.properties, version: { const: '0.6' }, documentOcr: DOCUMENT_OCR_POLICY_SCHEMA });
const officePolicy = object({ ...documentOcrPolicy.properties, version: { const: '0.7' }, office: OFFICE_LIMITS_SCHEMA });
const policy = { anyOf: [legacyPolicy, documentPolicy, ocrPolicy, asrPolicy, audioPolicy, documentOcrPolicy, officePolicy] };
const source = object({ kind: { enum: ['import', 'unpack'] }, importId: id('import'), importManifestSha256: hash, unpackId: nullable(id('unpack')), unpackManifestSha256: nullable(hash), path, fixedPath: path, bytes: integer, sha256: hash });
const signedInteger = { ...string, pattern: '^-?\\d+$' }, rational = { ...string, pattern: '^-?\\d+/[1-9]\\d*$' };
const evidence = object({ id: id('evidence'), kind: { enum: ['text', 'preview', 'frame', 'probe', 'audio-pcm'] }, path, bytes: integer, sha256: hash,
  width: nullable(positive), height: nullable(positive), sourceWidth: nullable(positive), sourceHeight: nullable(positive), transform: nullable(nonempty), streamIndex: nullable(integer), timeBase: nullable(rational), pts: nullable(signedInteger), requestedTime: nullable(number), actualTime: nullable(number), sampleRate: nullable(positive), samples: nullable(integer), coverage: { enum: ['full', 'partial', 'sample'] } });
const stream = object({ index: integer, type: nonempty, codec: nullable(nonempty), width: nullable(positive), height: nullable(positive), pixelFormat: nullable(nonempty), sampleRate: nullable(positive), channels: nullable(positive), timeBase: nullable(rational), startPts: nullable(signedInteger), durationTs: nullable(signedInteger), startTime: nullable(number), duration: nullable(number), avgFrameRate: nullable(string), rFrameRate: nullable(string), rotation: nullable(number), raw: string });
const technical = object({ status: { enum: ['supported', 'partial', 'failed', 'unsupported', 'requires-unpack'] }, format: nonempty, method: nonempty, reason: string, raw: nullable(string), streams: array(stream), evidence: array(evidence), text: nullable(object({ bytes: integer, lines: positive, bom: { type: 'boolean' }, lineEndings: string })), containerDuration: nullable(number), limitations: strings });
const imageEvidence = object({ ...evidence.properties, kind: { enum: ['text', 'preview', 'frame', 'probe', 'audio-pcm'] } });
const ocrEvidence = object({ ...imageEvidence.properties, kind: { enum: ['text', 'preview', 'frame', 'probe', 'audio-pcm', 'ocr-raster', 'ocr-tsv', 'ocr-map'] } });
const ocrTechnical = object({ ...technical.properties, evidence: array(ocrEvidence), ocr: OCR_DESCRIPTOR_SCHEMA });
const asrEvidence = object({ ...ocrEvidence.properties, kind: { enum: ['text', 'preview', 'frame', 'probe', 'audio-pcm', 'ocr-raster', 'ocr-tsv', 'ocr-map', 'asr-audio', 'asr-json', 'asr-map'] } });
const asrTechnical = object({ ...technical.properties, evidence: array(asrEvidence), asr: ASR_DESCRIPTOR_SCHEMA });
const audioEvidence = object({ ...asrEvidence.properties, kind: { enum: [...asrEvidence.properties.kind.enum, 'audio-canonical', 'audio-input-map'] } });
const audioTechnical = object({ ...technical.properties, evidence: array(audioEvidence), asr: ASR_DESCRIPTOR_SCHEMA_02, audioInput: AUDIO_INPUT_DESCRIPTOR_SCHEMA });
const locator = object({ kind: { enum: ['text', 'image', 'video', 'audio'] }, evidenceId: id('evidence'), byteStart: nullable(integer), byteEnd: nullable(integer), lineStart: nullable(positive), lineEnd: nullable(positive), x: nullable(integer), y: nullable(integer), width: nullable(positive), height: nullable(positive), streamIndex: nullable(integer), timeBase: nullable(rational), pts: nullable(signedInteger), sampleRate: nullable(positive), sampleStart: nullable(integer), sampleEnd: nullable(integer) });
const observation = object({ version: { const: '0.1' }, id: id('observation'), assetId: id('asset'), assetVersion: id('asset-version'), byteSha256: hash, method: nonempty, locator,
  coverage: { enum: ['full', 'partial', 'sample'] }, statement: nonempty, basis: { enum: ['observed', 'estimated', 'unknown'] }, confidence: nullable({ ...number, minimum: 0, maximum: 1 }), limitations: strings, evidenceRefs: { ...strings, uniqueItems: true } });
const rights = object({ version: { const: '0.1' }, id: id('rights'), revision: positive, assetId: id('asset'), assetVersion: id('asset-version'), byteSha256: hash, status: { enum: ['unknown', 'user-declared', 'documented'] },
  sourceRefs: array(object({ kind: { enum: ['prompt', 'license'] }, path, bytes: integer, sha256: hash, statement: nonempty })), allowedUses: strings, restrictions: strings, attribution: nullable(string), affectedStreams: integers, thirdPartyRightsStatus: { enum: ['unknown', 'user-declared', 'documented'] } });
const assessment = object({ result: nonempty, reason: nonempty });
const asset = object({ assetId: id('asset'), assetVersion: id('asset-version'), inspectionId: id('inspection'), inspection: object({ catalogId: id('catalog'), attemptId: id('catalog-attempt'), policySha256: hash, policySourceSha256: hash }), source, technical, usability: object({ technical: assessment, semanticMatch: assessment, compositionFit: assessment, continuityFit: assessment, rightsScope: assessment }) });
const documentAsset = object({ ...asset.properties, technical });
const ocrAsset = object({ ...asset.properties, technical: { anyOf: [technical, ocrTechnical] } });
const asrAsset = object({ ...asset.properties, technical: { anyOf: [technical, ocrTechnical, asrTechnical] } });
const audioAsset = object({ ...asset.properties, technical: { anyOf: [technical, ocrTechnical, asrTechnical, audioTechnical] } });
const counts = object({ selectedFiles: integer, sourceBytes: integer, sourceReadBytes: integer, derivedBytes: integer, decodedAudioBytes: integer, toolOutputBytes: integer, elapsedMs: integer });
const tool = object({ executable: nonempty, version: nonempty, argv: strings, exitCode: nullable({ type: 'integer' }), signal: nullable(nonempty), stdout: string, stderr: string, stdoutBytes: integer, stderrBytes: integer, binaryBytes: integer, elapsedMs: integer, error: nullable(nonempty) });
const manifest = object({ version: { const: '0.1' }, kind: { const: 'catalog-manifest' }, catalogId: id('catalog'), attemptId: id('catalog-attempt'), createdAt: nonempty, previousCatalogId: nullable(id('catalog')), policy: legacyPolicy, policySha256: hash, policySourceSha256: hash, counts, tools: array(tool), assets: array(asset), observations: array(observation), rights: array(rights), recordSnapshot: nullable(object({ path, sha256: hash, bytes: integer })) });
const index = object({ version: { const: '0.1' }, kind: { const: 'catalog-index' }, currentCatalogId: id('catalog'), catalogs: array(object({ catalogId: id('catalog'), attemptId: id('catalog-attempt'), manifestSha256: hash })), assets: array(object({ assetId: id('asset'), currentVersion: id('asset-version') })) });
const receipt = object({ version: { const: '0.1' }, kind: { const: 'catalog-receipt' }, catalogId: id('catalog'), attemptId: id('catalog-attempt'), ownerPid: positive, startedAt: nonempty, finishedAt: nullable(nonempty), status: { enum: ['running', 'prepared', 'succeeded', 'failed', 'interrupted'] }, phase: { enum: ['planning', 'inspecting', 'verifying', 'committing'] }, selection: string, policy: nullable(legacyPolicy), policySha256: nullable(hash), policySourceSha256: nullable(hash), counts, tools: array(tool), assets: array(asset), tempPath: path, manifestPath: nullable(path), manifestSha256: nullable(hash), indexCommitted: { type: 'boolean' }, error: nullable(nonempty) });
const manifest02 = object({ ...manifest.properties, version: { const: '0.2' }, policy: documentPolicy, assets: array(documentAsset), observations: array({ anyOf: [observation] }) });
const index02 = object({ ...index.properties, version: { const: '0.2' } });
const receipt02 = object({ ...receipt.properties, version: { const: '0.2' }, policy: nullable(documentPolicy), assets: array(documentAsset) });
const manifest03 = object({ ...manifest.properties, version: { const: '0.3' }, policy: ocrPolicy, assets: array(ocrAsset), observations: array({ anyOf: [observation, OCR_OBSERVATION_SCHEMA] }) });
const index03 = object({ ...index.properties, version: { const: '0.3' } });
const receipt03 = object({ ...receipt.properties, version: { const: '0.3' }, policy: nullable(ocrPolicy), assets: array(ocrAsset) });
const manifest04 = object({ ...manifest.properties, version: { const: '0.4' }, policy: asrPolicy, assets: array(asrAsset), observations: array({ anyOf: [observation, OCR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA] }) });
const index04 = object({ ...index.properties, version: { const: '0.4' } });
const receipt04 = object({ ...receipt.properties, version: { const: '0.4' }, policy: nullable(asrPolicy), assets: array(asrAsset) });
const manifest05 = object({ ...manifest.properties, version: { const: '0.5' }, policy: { anyOf: [asrPolicy, audioPolicy] }, assets: array(audioAsset), observations: array({ anyOf: [observation, OCR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA_05] }) });
const index05 = object({ ...index.properties, version: { const: '0.5' } });
const receipt05 = object({ ...receipt.properties, version: { const: '0.5' }, policy: nullable({ anyOf: [asrPolicy, audioPolicy] }), assets: array(audioAsset) });
const manifest06 = object({ ...manifest.properties, version: { const: '0.6' }, policy: { anyOf: [asrPolicy, audioPolicy, documentOcrPolicy] }, assets: array(audioAsset), observations: array({ anyOf: [observation, OCR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA_05] }) });
const index06 = object({ ...index.properties, version: { const: '0.6' } });
const receipt06 = object({ ...receipt.properties, version: { const: '0.6' }, policy: nullable({ anyOf: [asrPolicy, audioPolicy, documentOcrPolicy] }), assets: array(audioAsset) });
const manifest07 = object({ ...manifest06.properties, version: { const: '0.7' }, policy: { anyOf: [asrPolicy, audioPolicy, documentOcrPolicy, officePolicy] } });
const index07 = object({ ...index.properties, version: { const: '0.7' } });
const receipt07 = object({ ...receipt06.properties, version: { const: '0.7' }, policy: nullable({ anyOf: [asrPolicy, audioPolicy, documentOcrPolicy, officePolicy] }) });
const schema = (name: string, value: object) => ({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `https://js-build-motion.local/catalog/${name}`, ...value });
export const CATALOG_SCHEMAS = { policy: schema('policy', policy), manifest: schema('manifest', { anyOf: [manifest, manifest02, manifest03, manifest04, manifest05, manifest06, manifest07] }), receipt: schema('receipt', { anyOf: [receipt, receipt02, receipt03, receipt04, receipt05, receipt06, receipt07] }), index: schema('index', { anyOf: [index, index02, index03, index04, index05, index06, index07] }), observation: schema('observation', { anyOf: [observation, OCR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA, ASR_OBSERVATION_SCHEMA_05] }), rights: schema('rights', rights), 'ocr-map': schema('ocr-map', OCR_SCHEMAS.map), 'asr-map': schema('asr-map', ASR_SCHEMAS.map), 'audio-input-map': schema('audio-input-map', AUDIO_INPUT_SCHEMAS.map) };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(CATALOG_SCHEMAS).map(([name, value]) => [name, ajv.compile(value as Schema)]));
export function assertCatalog<T>(kind: keyof typeof CATALOG_SCHEMAS, value: unknown): T {
  const validate = validators[kind]; if (!validate(value)) throw new Error(`CATALOG_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(validate, value).join('; ')}`); return value as T;
}
export function assertInspectPolicy(value: unknown): InspectPolicy {
  const result = assertCatalog<InspectPolicy>('policy', value);
  if ((result.version === '0.6' || result.version === '0.7')) validateDocumentOcrPolicy(result.documentOcr);
  if ((result.version === '0.5' || (result.version === '0.6' || result.version === '0.7')) && result.audioInput.minSamples > result.audioInput.maxSamples) throw Error('CATALOG_POLICY_INVALID: audio minimum exceeds maximum');
  if (result.defaultVideoSamplesPerAsset > result.maxVideoSamplesPerAsset) throw new Error('CATALOG_POLICY_INVALID: sample default exceeds maximum'); if ((result.version === '0.4' || (result.version === '0.5' || (result.version === '0.6' || result.version === '0.7'))) && result.asr.minAsrSamples > result.asr.maxAsrSamples) throw new Error('CATALOG_POLICY_INVALID: ASR minimum exceeds maximum'); return result;
}
// Versioned adoption preserves source fields and historical adopted identities.
export function adoptInspectPolicy(value: unknown, version?: '0.1' | '0.2' | '0.3' | '0.4' | '0.5' | '0.6' | '0.7'): InspectPolicy {
  const source = assertInspectPolicy(value); version ??= source.version === '0.7' ? '0.7' : source.version === '0.6' ? '0.6' : source.version === '0.5' ? '0.5' : '0.4';
  if (Number(source.version) > Number(version)) throw new Error('CATALOG_POLICY_VERSION_INVALID');
  if (source.version === version) return source;
  if (version === '0.1') throw new Error('CATALOG_POLICY_VERSION_INVALID');
  const document = source.version === '0.1' ? { ...INSPECT_POLICY_02_DOCUMENT_LIMITS } : source.document;
  if (version === '0.2') return { ...source, version, document };
  const ocr = source.version === '0.3' || source.version === '0.4' || (source.version === '0.5' || (source.version === '0.6' || source.version === '0.7')) ? source.ocr : { ...INSPECT_POLICY_03_OCR_DEFAULTS };
  if (version === '0.3') return { ...source, version, document, ocr };
  const asr = source.version === '0.4' || (source.version === '0.5' || (source.version === '0.6' || source.version === '0.7')) ? source.asr : { ...INSPECT_POLICY_04_ASR_DEFAULTS };
  if (version === '0.4') return { ...source, version, document, ocr, asr };
  const audioInput = source.version === '0.5' || (source.version === '0.6' || source.version === '0.7') ? source.audioInput : { ...DEFAULT_AUDIO_INPUT_LIMITS };
  if (version === '0.5') return { ...source, version, document, ocr, asr, audioInput };
  const documentOcr = source.version === '0.6' || source.version === '0.7' ? source.documentOcr : { ...INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS, pdfPages: [], docxImages: [], ocr: { ...DEFAULT_OCR_LIMITS } };
  return version === '0.6' ? { ...source, version, document, ocr, asr, audioInput, documentOcr } : { ...source, version, document, ocr, asr, audioInput, documentOcr, office: { ...DEFAULT_OFFICE_LIMITS } };
}
export function ocrLimits(policy: InspectPolicy): OcrLimits {
  const { enabled, ...limits } = policy.version === '0.3' || policy.version === '0.4' || (policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) ? policy.ocr : INSPECT_POLICY_03_OCR_DEFAULTS;
  return { ...limits, maxOcrSourceBytes: Math.min(limits.maxOcrSourceBytes, policy.maxSourceBytes),
    maxOcrSourcePixels: Math.min(limits.maxOcrSourcePixels, policy.maxSourcePixels), maxOcrTextBytes: Math.min(limits.maxOcrTextBytes, policy.maxTextBytes) };
}
export function asrLimits(policy: InspectPolicy): AsrLimits {
  const { enabled, language, ...limits } = policy.version === '0.4' || (policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) ? policy.asr : INSPECT_POLICY_04_ASR_DEFAULTS;
  return { ...limits, maxAsrSourceBytes: Math.min(limits.maxAsrSourceBytes, policy.maxSourceBytes), maxAsrTextBytes: Math.min(limits.maxAsrTextBytes, policy.maxTextBytes) };
}
export function audioInputLimits(policy: InspectPolicy): AudioInputLimits {
  const limits = (policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) ? policy.audioInput : DEFAULT_AUDIO_INPUT_LIMITS;
  return { ...limits, maxSourceBytes: Math.min(limits.maxSourceBytes, policy.maxSourceBytes), maxPcmBytes: limits.maxPcmBytes };
}
export function safeCatalogPath(value: string): boolean { return safeUnpackPath(value); }
export function emptyCatalogCounts(): CatalogCounts { return { selectedFiles: 0, sourceBytes: 0, sourceReadBytes: 0, derivedBytes: 0, decodedAudioBytes: 0, toolOutputBytes: 0, elapsedMs: 0 }; }
