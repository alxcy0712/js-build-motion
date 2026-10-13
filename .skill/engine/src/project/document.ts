import { Ajv, type Schema } from 'ajv';
import { createHash } from 'node:crypto';
import { UUID_PATTERN } from './unpack.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

// Frozen policy 0.2 mapping; future defaults must use a new versioned constant.
export const INSPECT_POLICY_02_DOCUMENT_LIMITS = Object.freeze({ maxDocumentSourceBytes: 33554432, maxDocumentsPerAttempt: 20,
  maxPdfPages: 200, maxDocumentUnits: 20000, maxDocumentTextBytes: 8388608, maxDocumentMapBytes: 4194304,
  maxWorkerPayloadBytes: 33554432, maxDocxEntries: 2000, maxDocxDeclaredExpandedBytes: 67108864,
  maxXmlPartBytes: 8388608, maxXmlReadBytes: 33554432, maxPackagePathDepth: 16, maxXmlDepth: 64,
  maxXmlNodes: 200000, maxCompressionRatio: 200, workerOldSpaceMiB: 512, workerConcurrency: 1 });
export const DEFAULT_DOCUMENT_LIMITS = INSPECT_POLICY_02_DOCUMENT_LIMITS;
export type DocumentLimits = { [K in keyof typeof DEFAULT_DOCUMENT_LIMITS]: number };
export const DEFAULT_OFFICE_LIMITS = Object.freeze({ maxSlides: 200, maxWorksheets: 32, maxSharedStrings: 20000, maxTables: 64 });
export type OfficeLimits = { [K in keyof typeof DEFAULT_OFFICE_LIMITS]: number };
export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
export type DocumentLocator = { kind: 'pdf'; page: number } | { kind: 'docx'; part: 'word/document.xml'; structurePath: string } |
  { kind: 'pptx'; slide: number; part: string; structurePath: string } |
  { kind: 'xlsx'; sheet: number; sheetName: string; part: string; cell: string | null; range: string | null; structurePath: string };
export interface DocumentUnit { id: string; ordinal: number; locator: DocumentLocator; text: string;
  status: 'complete' | 'empty' | 'failed' | 'skipped'; reason: string }
export interface DocumentCoverage { scope: 'native-text' | 'docx-main-body' | 'pptx-slides-notes' | 'xlsx-sheets-tables'; totalUnits: number | null; completedUnits: number;
  totalPages: number | null; parsedPages: number[]; omitted: string[] }
export interface DocumentParseRequest { version: '0.1' | '0.2'; format: DocumentFormat; sourcePath: string; sourceBytes: number; sourceSha256: string; limits: DocumentLimits; office?: OfficeLimits }
export interface DocumentParseResult { version: '0.1' | '0.2'; format: DocumentFormat; sourceBytes: number; sourceSha256: string;
  parser: { id: string; version: string }; status: 'supported' | 'partial' | 'failed' | 'unsupported'; reason: string;
  units: DocumentUnit[]; coverage: DocumentCoverage; limitations: string[];
  metrics: { sourceReadBytes: number | null; maxRSSKiB: number | null } }
export interface DocumentMap { version: '0.1' | '0.2'; kind: 'document-map'; format: DocumentFormat;
  source: { bytes: number; sha256: string }; parser: { id: string; version: string }; policySha256: string;
  text: { bytes: number; sha256: string }; units: (Omit<DocumentUnit, 'text'> & { byteStart: number | null; byteEnd: number | null })[];
  coverage: DocumentCoverage; limitations: string[]; metrics: DocumentParseResult['metrics'] }
export interface DocumentDescriptor { version: '0.1' | '0.2'; format: DocumentFormat; parser: DocumentParseResult['parser']; scope: DocumentCoverage['scope'];
  textEvidenceId: string; mapEvidenceId: string; totalUnits: number | null; completedUnits: number }
export interface DocumentObservation { version: '0.2'; id: string; assetId: string; assetVersion: string; byteSha256: string; method: string;
  locator: { kind: 'document'; evidenceId: string; mapEvidenceId: string; unitId: string; byteStart: number; byteEnd: number };
  coverage: 'full' | 'partial' | 'sample'; coverageScope: 'unit-native-text'; statement: string;
  basis: 'observed' | 'estimated' | 'unknown'; confidence: number | null; limitations: string[]; evidenceRefs: string[] }

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items }), strings = array(string), evidenceId = { ...string, pattern: `^evidence-${UUID_PATTERN}$` };
const parser = object({ id: nonempty, version: nonempty });
const limits = object(Object.fromEntries(Object.entries(INSPECT_POLICY_02_DOCUMENT_LIMITS).map(([key, maximum]) => [key,
  key === 'workerConcurrency' ? { const: 1 } : { ...integer, minimum: key === 'workerOldSpaceMiB' || key === 'maxCompressionRatio' ? 1 : 0, maximum }])));
const structurePath = { ...nonempty, maxLength: 8192, pattern: '^/(?:[A-Za-z]+:)?[A-Za-z]+\\[1\\](?:/(?:[A-Za-z]+:)?[A-Za-z]+\\[[1-9][0-9]*\\])*$' };
const cell = { ...nonempty, maxLength: 16, pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}$' };
const locator = { oneOf: [object({ kind: { const: 'pdf' }, page: positive }), object({ kind: { const: 'docx' }, part: { const: 'word/document.xml' },
  structurePath: { ...nonempty, maxLength: 8192, pattern: '^/w:document\\[1\\]/w:body\\[1\\](?:/w:[A-Za-z]+\\[[1-9][0-9]*\\])+$' } }),
  object({ kind: { const: 'pptx' }, slide: { ...positive, maximum: DEFAULT_OFFICE_LIMITS.maxSlides },
    part: { ...nonempty, pattern: '^ppt/(?:slides/slide|notesSlides/notesSlide)[1-9][0-9]*\\.xml$' }, structurePath }),
  object({ kind: { const: 'xlsx' }, sheet: { ...positive, maximum: DEFAULT_OFFICE_LIMITS.maxWorksheets }, sheetName: { ...nonempty, maxLength: 256 },
    part: { ...nonempty, pattern: '^xl/(?:worksheets/sheet|tables/table)[1-9][0-9]*\\.xml$' }, cell: nullable(cell),
    range: nullable({ ...nonempty, maxLength: 33, pattern: '^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$' }), structurePath })] };
const unitProperties = { id: { ...nonempty, maxLength: 256 }, ordinal: positive, locator, status: { enum: ['complete', 'empty', 'failed', 'skipped'] }, reason: string };
const coverage = object({ scope: { enum: ['native-text', 'docx-main-body', 'pptx-slides-notes', 'xlsx-sheets-tables'] }, totalUnits: nullable(integer), completedUnits: integer,
  totalPages: nullable(integer), parsedPages: { ...array(positive), uniqueItems: true }, omitted: strings });
const metrics = object({ sourceReadBytes: nullable(integer), maxRSSKiB: nullable(integer) });
export const OFFICE_LIMITS_SCHEMA = object(Object.fromEntries(Object.entries(DEFAULT_OFFICE_LIMITS).map(([key, maximum]) => [key, { ...integer, maximum }])));
const request = { oneOf: [object({ version: { const: '0.1' }, format: { enum: ['pdf', 'docx'] }, sourcePath: nonempty, sourceBytes: integer, sourceSha256: hash, limits }),
  object({ version: { const: '0.2' }, format: { enum: ['pptx', 'xlsx'] }, sourcePath: nonempty, sourceBytes: integer, sourceSha256: hash, limits, office: OFFICE_LIMITS_SCHEMA })] };
const formatProperties = { version: { enum: ['0.1', '0.2'] }, format: { enum: ['pdf', 'docx', 'pptx', 'xlsx'] } };
const result = object({ ...formatProperties, sourceBytes: integer, sourceSha256: hash, parser,
  status: { enum: ['supported', 'partial', 'failed', 'unsupported'] }, reason: string, units: array(object({ ...unitProperties, text: string })), coverage, limitations: strings, metrics });
const map = object({ ...formatProperties, kind: { const: 'document-map' }, source: object({ bytes: integer, sha256: hash }),
  parser, policySha256: hash, text: object({ bytes: integer, sha256: hash }), units: array(object({ ...unitProperties, byteStart: nullable(integer), byteEnd: nullable(integer) })), coverage, limitations: strings, metrics });
export const DOCUMENT_DESCRIPTOR_SCHEMA = object({ ...formatProperties, parser, scope: { enum: ['native-text', 'docx-main-body', 'pptx-slides-notes', 'xlsx-sheets-tables'] },
  textEvidenceId: evidenceId, mapEvidenceId: evidenceId, totalUnits: nullable(integer), completedUnits: integer });
export const DOCUMENT_OBSERVATION_SCHEMA = object({ version: { const: '0.2' }, id: { ...string, pattern: `^observation-${UUID_PATTERN}$` },
  assetId: { ...string, pattern: `^asset-${UUID_PATTERN}$` }, assetVersion: { ...string, pattern: `^asset-version-${UUID_PATTERN}$` }, byteSha256: hash, method: nonempty,
  locator: object({ kind: { const: 'document' }, evidenceId, mapEvidenceId: evidenceId, unitId: nonempty, byteStart: integer, byteEnd: integer }),
  coverage: { enum: ['full', 'partial', 'sample'] }, coverageScope: { const: 'unit-native-text' }, statement: nonempty,
  basis: { enum: ['observed', 'estimated', 'unknown'] }, confidence: nullable({ type: 'number', minimum: 0, maximum: 1 }), limitations: strings,
  evidenceRefs: { ...strings, uniqueItems: true } });
export const DOCUMENT_LIMITS_SCHEMA = limits;
export const DOCUMENT_SCHEMAS = { request, result, map };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(DOCUMENT_SCHEMAS).map(([name, value]) => [name, ajv.compile(value as Schema)]));
export function assertDocument<T>(kind: keyof typeof DOCUMENT_SCHEMAS, value: unknown): T {
  const validate = validators[kind]; if (!validate(value)) throw new Error(`DOCUMENT_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(validate, value).join('; ')}`);
  const record = value as { version: string; format: DocumentFormat };
  if (record.version !== (['pptx', 'xlsx'].includes(record.format) ? '0.2' : '0.1')) throw Error('DOCUMENT_FORMAT_VERSION_INVALID');
  return value as T;
}
export function documentScope(format: DocumentFormat): DocumentCoverage['scope'] {
  return { pdf: 'native-text', docx: 'docx-main-body', pptx: 'pptx-slides-notes', xlsx: 'xlsx-sheets-tables' }[format] as DocumentCoverage['scope'];
}
export function newDocumentResult(request: DocumentParseRequest, id: string, version: string): DocumentParseResult {
  return { version: request.version, format: request.format, sourceBytes: request.sourceBytes, sourceSha256: request.sourceSha256, parser: { id, version },
    status: 'supported', reason: '', units: [], coverage: { scope: documentScope(request.format), totalUnits: null,
      completedUnits: 0, totalPages: null, parsedPages: [], omitted: [] }, limitations: [], metrics: { sourceReadBytes: null, maxRSSKiB: null } };
}
/** Complete units alone enter the text. Failed/skipped units retain location and reason. */
export function documentArtifacts(result: DocumentParseResult, policySha256: string): { text: Buffer; map: DocumentMap } {
  const pieces: Buffer[] = []; let offset = 0, completed = 0;
  const units = result.units.map(({ text, ...unit }) => {
    if (!['complete', 'empty'].includes(unit.status)) return { ...unit, byteStart: null, byteEnd: null };
    if (completed++) { pieces.push(Buffer.from('\n')); offset++; }
    const data = Buffer.from(text), byteStart = offset; pieces.push(data); offset += data.length;
    return { ...unit, byteStart, byteEnd: offset };
  });
  const text = Buffer.concat(pieces);
  const map: DocumentMap = { version: result.version, kind: 'document-map', format: result.format, source: { bytes: result.sourceBytes, sha256: result.sourceSha256 },
    parser: result.parser, policySha256, text: { bytes: text.length, sha256: createHash('sha256').update(text).digest('hex') },
    units, coverage: result.coverage, limitations: result.limitations, metrics: result.metrics };
  return { text, map };
}
export function validateDocumentMap(map: DocumentMap, text: Buffer, limits: DocumentLimits): void {
  assertDocument('map', map);
  if (map.text.bytes !== text.length || map.text.sha256 !== createHash('sha256').update(text).digest('hex') || text.length > limits.maxDocumentTextBytes || map.units.length > limits.maxDocumentUnits) throw new Error('DOCUMENT_TEXT_OR_UNIT_INVALID');
  const decoder = new TextDecoder('utf-8', { fatal: true }); decoder.decode(text);
  const ids = new Set<string>(), locations = new Set<string>(); let end = 0, completed = 0;
  for (const unit of map.units) {
    const location = JSON.stringify(unit.locator);
    if (ids.has(unit.id) || locations.has(location) || unit.ordinal !== ids.size + 1 || unit.locator.kind !== map.format) throw new Error('DOCUMENT_UNIT_IDENTITY_INVALID'); ids.add(unit.id); locations.add(location);
    if (unit.locator.kind === 'pdf' && (map.coverage.totalPages === null || unit.locator.page > map.coverage.totalPages)) throw new Error('DOCUMENT_PAGE_INVALID');
    if (unit.locator.kind === 'pptx' && !unit.locator.structurePath.startsWith(unit.locator.part.startsWith('ppt/slides/') ? '/p:sld[1]/' : '/p:notes[1]/')) throw Error('DOCUMENT_OFFICE_LOCATOR_INVALID');
    if (unit.locator.kind === 'xlsx') {
      const loc = unit.locator, worksheet = loc.part.startsWith('xl/worksheets/');
      const coordinate = (cell: string): [number, number] => {
        const parts = /^([A-Z]+)([1-9][0-9]*)$/.exec(cell)!;
        const column = [...parts[1]!].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0), row = Number(parts[2]);
        if (column > 16384 || row > 1048576) throw Error('DOCUMENT_OFFICE_LOCATOR_INVALID'); return [column, row];
      };
      if (!(worksheet ? loc.structurePath.startsWith('/s:worksheet[1]/') : loc.structurePath === '/s:table[1]' || loc.structurePath.startsWith('/s:table[1]/')) || worksheet && (!loc.cell || loc.range !== null) || !worksheet && (loc.cell !== null || !loc.range)) throw Error('DOCUMENT_OFFICE_LOCATOR_INVALID');
      if (loc.cell) coordinate(loc.cell);
      if (loc.range) { const parts = loc.range.split(':'), start = coordinate(parts[0]!), end = coordinate(parts[1] ?? parts[0]!);
        if (end[0] < start[0] || end[1] < start[1]) throw Error('DOCUMENT_OFFICE_LOCATOR_INVALID'); }
    }
    if (['complete', 'empty'].includes(unit.status)) {
      const start = unit.byteStart, finish = unit.byteEnd;
      if (start === null || finish === null || start !== end + (completed ? 1 : 0) || finish < start || finish > text.length || completed && text[end] !== 10 || unit.status === 'empty' && finish !== start || unit.status === 'complete' && finish === start) throw new Error('DOCUMENT_UNIT_RANGE_INVALID');
      if (start < text.length && (text[start]! & 0xc0) === 0x80 || finish < text.length && (text[finish]! & 0xc0) === 0x80) throw new Error('DOCUMENT_UTF8_BOUNDARY_INVALID');
      completed++; end = finish;
    } else if (unit.byteStart !== null || unit.byteEnd !== null || !unit.reason) throw new Error('DOCUMENT_UNIT_RANGE_INVALID');
  }
  if (end !== text.length || completed !== map.coverage.completedUnits || map.coverage.totalUnits !== null && map.coverage.totalUnits < map.units.length || map.coverage.scope !== documentScope(map.format) || map.format !== 'pdf' && (map.coverage.totalPages !== null || map.coverage.parsedPages.length) || map.format === 'pdf' && (map.coverage.parsedPages.length > limits.maxPdfPages || map.coverage.parsedPages.some(page => !map.units.some(u => u.locator.kind === 'pdf' && u.locator.page === page && ['complete', 'empty'].includes(u.status))))) throw new Error('DOCUMENT_COVERAGE_INVALID');
  if (map.format === 'pdf' && JSON.stringify(map.coverage.parsedPages) !== JSON.stringify(map.units.filter(u => ['complete', 'empty'].includes(u.status)).map(u => (u.locator as { page: number }).page))) throw new Error('DOCUMENT_COVERAGE_INVALID');
}
