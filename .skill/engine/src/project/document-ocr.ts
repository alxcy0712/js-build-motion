import { Ajv, type Schema } from 'ajv';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { UUID_PATTERN } from './unpack.ts';
import { DOCUMENT_LIMITS_SCHEMA, type DocumentLimits } from './document.ts';
import { DEFAULT_OCR_LIMITS, OCR_SCHEMAS, OCR_REGION_SCHEMA, OCR_LIMITS_SCHEMA, validateOcrArtifacts, type OcrLimits, type OcrEngineIdentity, type OcrRegion, type OcrMap } from './ocr.ts';
import type { ToolRun } from './catalog.ts';

// Frozen opt-in defaults for inspect policy 0.6. Attempt budgets are independent of unit admission.
export const DEFAULT_DOCUMENT_RASTER_LIMITS = Object.freeze({ maxSourceBytes: 33554432, maxUnitsPerSource: 4,
  maxUnitsPerAttempt: 4, maxTotalPixels: 32000000, maxEmbeddedBytesPerUnit: 8388608, maxTotalEmbeddedBytes: 16777216,
  maxPixelsPerUnit: 16000000, maxEdge: 8192, maxRasterBytes: 48000128, maxWorkerPayloadBytes: 67108864,
  maxMapBytes: 4194304, maxPdfDocumentPages: 200, maxPdfObjects: 20000, maxPdfStructureTokens: 200000,
  maxPdfStructureDepth: 64, maxPdfDecodedStreamBytes: 67108864, maxImageOccurrences: 20000, maxCanvasLivePixels: 32000000,
  maxCanvasAllocationPixels: 64000000, maxRuntimeResourceBytes: 16777216, workerOldSpaceMiB: 512,
  workerElapsedMs: 30000, concurrency: 1 });
export type DocumentRasterLimits = { [K in keyof typeof DEFAULT_DOCUMENT_RASTER_LIMITS]: number };
export type DocumentOcrPolicy = DocumentRasterLimits & { enabled: boolean; pdfPages: number[]; docxImages: number[];
  dpi: 72 | 150 | 300; ocr: OcrLimits };
export const INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS = Object.freeze({ enabled: false, pdfPages: [] as number[],
  docxImages: [] as number[], dpi: 300 as const, ...DEFAULT_DOCUMENT_RASTER_LIMITS, ocr: DEFAULT_OCR_LIMITS });
export interface DocumentRasterRuntimeIdentity { id: 'bounded-document-raster'; version: '0.1'; platform: 'darwin'; arch: 'arm64';
  node: { version: string; executable: string; bytes: number; sha256: string; files: { path: string; bytes: number; sha256: string }[] }; files: { path: string; bytes: number; sha256: string }[] }
export interface PdfRasterLocator { kind: 'pdf-page'; page: number; viewBox: number[]; userUnit: number; rotation: 0 | 90 | 180 | 270;
  dpi: 72 | 150 | 300; scale: number; transform: number[]; width: number; height: number }
export interface DocxRasterLocator { kind: 'docx-image'; occurrence: number; mainPart: 'word/document.xml'; structurePath: string;
  relationshipsPart: 'word/_rels/document.xml.rels'; relationshipId: string; embeddedPart: string;
  embeddedBytes: number; embeddedSha256: string; embeddedCrc32: number; format: 'png_pipe' | 'jpeg_pipe'; width: number; height: number }
export type DocumentRasterLocator = PdfRasterLocator | DocxRasterLocator;
export interface DocumentRasterRequest { version: '0.1'; kind: 'document-raster-request'; format: 'pdf' | 'docx';
  sourcePath: string; sourceBytes: number; sourceSha256: string; unit: number; dpi: 72 | 150 | 300;
  limits: DocumentRasterLimits; documentLimits: DocumentLimits; ocrLimits: OcrLimits; runtime: DocumentRasterRuntimeIdentity }
export interface DocumentRasterResult { version: '0.1'; kind: 'document-raster-result'; format: 'pdf' | 'docx';
  source: { bytes: number; sha256: string }; unit: number; totalUnits: number; status: 'complete' | 'failed'; reason: string;
  locator: DocumentRasterLocator | null; payload: { format: 'ppm' | 'png_pipe' | 'jpeg_pipe'; bytes: number; sha256: string; dataBase64: string } | null;
  metrics: { readBytes: number; expandedBytes: number; decodedStreamBytes: number; xmlNodes: number; canvasLivePeakPixels: number;
    canvasAllocationPixels: number; resourceBytes: number }; limitations: string[] }
export interface DocumentOcrInvocationRecord { version: '0.1'; kind: 'document-ocr-command'; inspectionId: string; unitId: string;
  cwd: string; request: DocumentRasterRequest; workerResult: (Omit<DocumentRasterResult, 'payload'> & {
    payload: { format: 'ppm' | 'png_pipe' | 'jpeg_pipe'; bytes: number; sha256: string } | null }) | null;
  commands: { worker: ToolRun | null; decode: ToolRun[]; ocr: ToolRun | null }; reason: string }
export interface DocumentOcrInvocationRef { path: string; bytes: number; sha256: string }
export interface DocumentOcrUnitMap { version: '0.1'; kind: 'document-ocr-map'; format: 'pdf' | 'docx';
  unitId: string; scope: 'selected-pdf-page-pixels' | 'selected-docx-embedded-source-pixels'; mapperVersion: 'ocr-tsv@0.1';
  status: 'text' | 'no-text'; policySha256: string; source: { bytes: number; sha256: string };
  runtime: DocumentRasterRuntimeIdentity; locator: DocumentRasterLocator; raster: OcrMap['raster'];
  rawTsv: OcrMap['rawTsv']; text: OcrMap['text']; engine: OcrEngineIdentity; regions: OcrRegion[];
  commands: { worker: ToolRun; decode: ToolRun[]; ocr: ToolRun }; cwd: string; limitations: string[] }
export interface DocumentOcrUnit { id: string; ordinal: number; status: 'text' | 'no-text' | 'failed'; reason: string;
  locator: DocumentRasterLocator | null; mapEvidenceId: string | null; invocation: DocumentOcrInvocationRef | null }
export interface DocumentOcrSelectionMap { version: '0.1'; kind: 'document-ocr-selection-map'; format: 'pdf' | 'docx';
  scope: 'selected-pdf-page-pixels' | 'selected-docx-embedded-source-pixels'; status: 'completed' | 'partial' | 'failed';
  nativeStatus: 'supported' | 'partial' | 'failed' | 'unsupported'; policySha256: string; source: { bytes: number; sha256: string };
  selection: number[]; totalUnits: number | null; completedUnits: number; runtime: DocumentRasterRuntimeIdentity;
  engine: OcrEngineIdentity; units: DocumentOcrUnit[]; limitations: string[] }
export interface DocumentOcrDescriptor { version: '0.1'; status: 'completed' | 'partial' | 'disabled' | 'skipped' | 'failed'; reason: string;
  nativeStatus: 'supported' | 'partial' | 'failed' | 'unsupported'; scope: 'selected-pdf-page-pixels' | 'selected-docx-embedded-source-pixels';
  selection: number[]; totalUnits: number | null; completedUnits: number; mapEvidenceId: string | null;
  runtime: DocumentRasterRuntimeIdentity | null; engine: OcrEngineIdentity | null }
export interface DocumentOcrObservation { version: '0.6'; id: string; assetId: string; assetVersion: string; byteSha256: string; method: string;
  locator: { kind: 'document-ocr'; evidenceId: string; mapEvidenceId: string; selectionMapEvidenceId: string;
    rasterEvidenceId: string; unitId: string; regionId: string; byteStart: number; byteEnd: number };
  coverage: 'full' | 'partial' | 'sample'; coverageScope: 'region-ocr-text'; statement: string;
  basis: 'observed' | 'estimated' | 'unknown'; confidence: number | null; limitations: string[]; evidenceRefs: string[] }

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items }), nullable = (s: unknown) => ({ anyOf: [s, { type: 'null' }] });
const source = object({ bytes: positive, sha256: hash }), evidenceId = { ...string, pattern: `^evidence-${UUID_PATTERN}$` };
const unitId = { ...string, pattern: '^document-ocr-unit-[1-9][0-9]*$' }, dpi = { enum: [72, 150, 300] };
const path = { ...nonempty, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' };
const numbers = (length: number) => ({ ...array({ type: 'number' }), minItems: length, maxItems: length });
const scope = { enum: ['selected-pdf-page-pixels', 'selected-docx-embedded-source-pixels'] };
const format = { enum: ['pdf', 'docx'] }, nativeStatus = { enum: ['supported', 'partial', 'failed', 'unsupported'] };
const selection = { ...array(positive), uniqueItems: true, maxItems: DEFAULT_DOCUMENT_RASTER_LIMITS.maxUnitsPerSource };
export const DOCUMENT_RASTER_LIMITS_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_DOCUMENT_RASTER_LIMITS).map(([key, maximum]) =>
  [key, key === 'workerOldSpaceMiB' || key === 'concurrency' ? { const: maximum } : { ...integer, minimum: key === 'workerElapsedMs' ? 1 : 0, maximum }])));
export const DOCUMENT_OCR_POLICY_SCHEMA = object({ enabled: { type: 'boolean' }, pdfPages: selection, docxImages: selection, dpi,
  ...DOCUMENT_RASTER_LIMITS_SCHEMA.properties, ocr: OCR_LIMITS_SCHEMA });
const runtime = object({ id: { const: 'bounded-document-raster' }, version: { const: '0.1' }, platform: { const: 'darwin' }, arch: { const: 'arm64' },
  node: object({ version: nonempty, executable: { ...nonempty, pattern: '^/' }, bytes: positive, sha256: hash,
    files: { ...array(object({ path: { ...nonempty, pattern: '^/(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' }, bytes: positive, sha256: hash })), minItems: 1, maxItems: 256 } }),
  files: { ...array(object({ path, bytes: positive, sha256: hash })), minItems: 1, maxItems: 4096 } });
const pdfLocator = object({ kind: { const: 'pdf-page' }, page: positive, viewBox: numbers(4), userUnit: { type: 'number', exclusiveMinimum: 0 },
  rotation: { enum: [0, 90, 180, 270] }, dpi, scale: { type: 'number', exclusiveMinimum: 0 }, transform: numbers(6), width: positive, height: positive });
const docxLocator = object({ kind: { const: 'docx-image' }, occurrence: positive, mainPart: { const: 'word/document.xml' }, structurePath: nonempty,
  relationshipsPart: { const: 'word/_rels/document.xml.rels' }, relationshipId: nonempty, embeddedPart: path, embeddedBytes: positive,
  embeddedSha256: hash, embeddedCrc32: { ...integer, maximum: 4294967295 }, format: { enum: ['png_pipe', 'jpeg_pipe'] }, width: positive, height: positive });
const locator = { anyOf: [pdfLocator, docxLocator] }, engine = OCR_SCHEMAS.engine;
const tool = object({ executable: nonempty, version: nonempty, argv: array(string), exitCode: nullable({ type: 'integer' }), signal: nullable(nonempty),
  stdout: string, stderr: string, stdoutBytes: integer, stderrBytes: integer, binaryBytes: integer, elapsedMs: integer, error: nullable(nonempty) });
const request = object({ version: { const: '0.1' }, kind: { const: 'document-raster-request' }, format, sourcePath: { ...nonempty, pattern: '^/' },
  sourceBytes: positive, sourceSha256: hash, unit: positive, dpi, limits: DOCUMENT_RASTER_LIMITS_SCHEMA,
  documentLimits: DOCUMENT_LIMITS_SCHEMA, ocrLimits: OCR_LIMITS_SCHEMA, runtime });
const result = object({ version: { const: '0.1' }, kind: { const: 'document-raster-result' }, format, source, unit: positive, totalUnits: integer,
  status: { enum: ['complete', 'failed'] }, reason: string, locator: nullable(locator),
  payload: nullable(object({ format: { enum: ['ppm', 'png_pipe', 'jpeg_pipe'] }, bytes: positive, sha256: hash, dataBase64: nonempty })),
  metrics: object({ readBytes: integer, expandedBytes: integer, decodedStreamBytes: integer, xmlNodes: integer, canvasLivePeakPixels: integer, canvasAllocationPixels: integer, resourceBytes: integer }), limitations: array(string) });
const unitMap = object({ version: { const: '0.1' }, kind: { const: 'document-ocr-map' }, format, unitId, scope, mapperVersion: { const: 'ocr-tsv@0.1' },
  status: { enum: ['text', 'no-text'] }, policySha256: hash, source, runtime, locator,
  raster: OCR_SCHEMAS.map.properties.raster, rawTsv: OCR_SCHEMAS.map.properties.rawTsv, text: OCR_SCHEMAS.map.properties.text,
  engine, regions: { ...array(OCR_REGION_SCHEMA), maxItems: DEFAULT_OCR_LIMITS.maxOcrRegions },
  commands: object({ worker: tool, decode: { ...array(tool), maxItems: 2 }, ocr: tool }), cwd: { ...nonempty, pattern: '^/' }, limitations: array(string) });
const invocation = object({ version: { const: '0.1' }, kind: { const: 'document-ocr-command' }, inspectionId: { ...string, pattern: `^inspection-${UUID_PATTERN}$` }, unitId,
  cwd: { ...nonempty, pattern: '^/' }, request, workerResult: nullable(object({ ...result.properties,
    payload: nullable(object({ format: { enum: ['ppm', 'png_pipe', 'jpeg_pipe'] }, bytes: positive, sha256: hash })) })),
  commands: object({ worker: nullable(tool), decode: { ...array(tool), maxItems: 2 }, ocr: nullable(tool) }), reason: string });
const invocationRef = object({ path, bytes: positive, sha256: hash });
const unit = object({ id: unitId, ordinal: positive, status: { enum: ['text', 'no-text', 'failed'] }, reason: string, locator: nullable(locator), mapEvidenceId: nullable(evidenceId), invocation: nullable(invocationRef) });
const selectionMap = object({ version: { const: '0.1' }, kind: { const: 'document-ocr-selection-map' }, format, scope,
  status: { enum: ['completed', 'partial', 'failed'] }, nativeStatus, policySha256: hash, source, selection, totalUnits: nullable(integer),
  completedUnits: integer, runtime, engine, units: { ...array(unit), maxItems: DEFAULT_DOCUMENT_RASTER_LIMITS.maxUnitsPerSource }, limitations: array(string) });
export const DOCUMENT_OCR_DESCRIPTOR_SCHEMA = object({ version: { const: '0.1' }, status: { enum: ['completed', 'partial', 'disabled', 'skipped', 'failed'] },
  reason: string, nativeStatus, scope, selection, totalUnits: nullable(integer), completedUnits: integer, mapEvidenceId: nullable(evidenceId), runtime: nullable(runtime), engine: nullable(engine) });
export const DOCUMENT_OCR_OBSERVATION_SCHEMA = object({ version: { const: '0.6' }, id: { ...string, pattern: `^observation-${UUID_PATTERN}$` },
  assetId: { ...string, pattern: `^asset-${UUID_PATTERN}$` }, assetVersion: { ...string, pattern: `^asset-version-${UUID_PATTERN}$` }, byteSha256: hash, method: nonempty,
  locator: object({ kind: { const: 'document-ocr' }, evidenceId, mapEvidenceId: evidenceId, selectionMapEvidenceId: evidenceId,
    rasterEvidenceId: evidenceId, unitId, regionId: nonempty, byteStart: integer, byteEnd: positive }), coverage: { enum: ['full', 'partial', 'sample'] },
  coverageScope: { const: 'region-ocr-text' }, statement: nonempty, basis: { enum: ['observed', 'estimated', 'unknown'] },
  confidence: nullable({ type: 'number', minimum: 0, maximum: 1 }), limitations: array(string), evidenceRefs: { ...array(string), uniqueItems: true } });
export const DOCUMENT_OCR_SCHEMAS = { request, result, runtime, invocation, 'unit-map': unitMap, 'selection-map': selectionMap,
  descriptor: DOCUMENT_OCR_DESCRIPTOR_SCHEMA, observation: DOCUMENT_OCR_OBSERVATION_SCHEMA };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(DOCUMENT_OCR_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema as Schema)]));
export function assertDocumentOcr<T>(kind: keyof typeof DOCUMENT_OCR_SCHEMAS, value: unknown): T {
  const validate = validators[kind]; if (!validate(value)) throw Error(`DOCUMENT_OCR_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(validate, value).join('; ')}`); return value as T;
}
export function validateDocumentOcrPolicy(policy: DocumentOcrPolicy): void {
  for (const list of [policy.pdfPages, policy.docxImages]) if (list.length > policy.maxUnitsPerSource || list.some((n, i) => i > 0 && n <= list[i - 1]!)) throw Error('DOCUMENT_OCR_SELECTION_INVALID');
}
export function validateDocumentRasterRuntime(runtime: DocumentRasterRuntimeIdentity): void {
  assertDocumentOcr('runtime', runtime);
  const executable = runtime.node.files.find(file => file.path === runtime.node.executable);
  if (runtime.files.some((file, i) => i > 0 && file.path <= runtime.files[i - 1]!.path) ||
      runtime.node.files.some((file, i) => i > 0 && file.path <= runtime.node.files[i - 1]!.path) ||
      !executable || executable.bytes !== runtime.node.bytes || executable.sha256 !== runtime.node.sha256) throw Error('DOCUMENT_RASTER_RUNTIME_INVALID');
}
export function validateDocumentOcrUnitMap(map: DocumentOcrUnitMap, text: Buffer, raster: Buffer, tsv: Buffer, policy: DocumentOcrPolicy): void {
  assertDocumentOcr('unit-map', map); validateDocumentRasterRuntime(map.runtime);
  const loc = map.locator, pdf = map.format === 'pdf';
  if (map.scope !== (pdf ? 'selected-pdf-page-pixels' : 'selected-docx-embedded-source-pixels') || (loc.kind === 'pdf-page') !== pdf ||
      map.unitId !== `document-ocr-unit-${loc.kind === 'pdf-page' ? loc.page : loc.occurrence}` || loc.width > policy.maxEdge || loc.height > policy.maxEdge ||
      loc.width * loc.height > policy.maxPixelsPerUnit || raster.length > policy.maxRasterBytes || map.source.bytes > policy.maxSourceBytes ||
      loc.kind === 'pdf-page' && (loc.dpi !== policy.dpi || loc.scale !== loc.dpi / 72) ||
      loc.kind === 'docx-image' && loc.embeddedBytes > policy.maxEmbeddedBytesPerUnit) throw Error('DOCUMENT_OCR_UNIT_INVALID');
  validateOcrArtifacts({ ...map, source: { width: loc.width, height: loc.height, bytes: loc.kind === 'docx-image' ? loc.embeddedBytes : map.source.bytes } }, text, raster, tsv, policy.ocr);
}
export function validateDocumentOcrSelectionMap(map: DocumentOcrSelectionMap, policy: DocumentOcrPolicy): void {
  assertDocumentOcr('selection-map', map); validateDocumentRasterRuntime(map.runtime); validateDocumentOcrPolicy(policy);
  const selection = map.format === 'pdf' ? policy.pdfPages : policy.docxImages;
  const completed = map.units.filter(u => u.status !== 'failed').length;
  if (!policy.enabled || !selection.length || completed > 0 && (map.source.bytes > policy.maxSourceBytes ||
      map.totalUnits !== null && map.totalUnits > (map.format === 'pdf' ? policy.maxPdfDocumentPages : policy.maxImageOccurrences)) ||
      JSON.stringify(map.selection) !== JSON.stringify(selection) || map.units.length !== selection.length || map.completedUnits !== completed ||
      map.status !== (completed === selection.length ? 'completed' : completed ? 'partial' : 'failed') ||
      map.scope !== (map.format === 'pdf' ? 'selected-pdf-page-pixels' : 'selected-docx-embedded-source-pixels')) throw Error('DOCUMENT_OCR_SELECTION_MAP_INVALID');
  const maps = new Set<string>();
  for (const [i, u] of map.units.entries()) {
    if (!u.invocation || u.ordinal !== selection[i] || u.id !== `document-ocr-unit-${u.ordinal}` || (u.status === 'failed') !== (u.mapEvidenceId === null) ||
        u.status === 'failed' && !u.reason || u.status !== 'failed' && (!u.locator || map.totalUnits === null || u.ordinal > map.totalUnits) ||
        u.locator && ((u.locator.kind === 'pdf-page') !== (map.format === 'pdf') || u.ordinal !== (u.locator.kind === 'pdf-page' ? u.locator.page : u.locator.occurrence)) ||
        u.mapEvidenceId && maps.has(u.mapEvidenceId)) throw Error('DOCUMENT_OCR_SELECTION_UNIT_INVALID');
    if (u.mapEvidenceId) maps.add(u.mapEvidenceId);
  }
}
export function validateDocumentOcrObservation(record: DocumentOcrObservation, map: DocumentOcrUnitMap, text: Buffer, selectionMapEvidenceId: string): void {
  assertDocumentOcr('observation', record); const loc = record.locator, region = map.regions.find(r => r.id === loc.regionId);
  if (loc.unitId !== map.unitId || loc.evidenceId !== map.text.evidenceId || loc.rasterEvidenceId !== map.raster.evidenceId ||
      loc.selectionMapEvidenceId !== selectionMapEvidenceId || ![loc.evidenceId, loc.mapEvidenceId, loc.rasterEvidenceId, selectionMapEvidenceId].every(id => record.evidenceRefs.includes(id))) throw Error('CATALOG_DOCUMENT_OCR_EVIDENCE_MISMATCH');
  if (!region || loc.byteStart < region.byteStart || loc.byteEnd > region.byteEnd || loc.byteEnd <= loc.byteStart) throw Error('CATALOG_DOCUMENT_OCR_REGION_RANGE_INVALID');
  for (const pos of [loc.byteStart, loc.byteEnd]) if (pos < text.length && (text[pos]! & 0xc0) === 0x80) throw Error('CATALOG_DOCUMENT_OCR_UTF8_BOUNDARY_INVALID');
  if (record.coverage === 'full' && (loc.byteStart !== region.byteStart || loc.byteEnd !== region.byteEnd)) throw Error('CATALOG_DOCUMENT_OCR_COVERAGE_INVALID');
}
