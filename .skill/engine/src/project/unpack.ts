import { Ajv, type Schema } from 'ajv';
import { collectSchemaErrors } from '../utils/json-schema.ts';

export interface UnpackPolicy {
  readonly version: '0.1';
  readonly maxArchiveBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxExpandedNodes: number;
  readonly maxDepth: number;
  readonly maxCompressionRatio: number;
  readonly maxMetadataBytes: number;
  readonly maxElapsedMs: number;
}
export const DEFAULT_UNPACK_POLICY: UnpackPolicy = Object.freeze({ version: '0.1', maxArchiveBytes: 1073741824,
  maxFileBytes: 1073741824, maxTotalBytes: 4294967296, maxArchiveEntries: 5000, maxExpandedNodes: 5000,
  maxDepth: 16, maxCompressionRatio: 200, maxMetadataBytes: 16777216, maxElapsedMs: 300000 });
export const ZIP_PARSER = 'yauzl@3.4.0';
export const UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const unpackIdPattern = new RegExp(`^unpack-${UUID_PATTERN}$`);
export const unpackAttemptPattern = new RegExp(`^unpack-attempt-${UUID_PATTERN}$`);
export const importIdPattern = new RegExp(`^import-${UUID_PATTERN}$`);
export interface UnpackSource { readonly importId: string; readonly path: string; readonly manifestSha256: string; readonly archiveBytes: number; readonly archiveSha256: string }
export interface UnpackItem {
  archiveIndex: number | null;
  rawPath: string | null;
  rawNameHex: string | null;
  path: string;
  kind: 'file' | 'directory' | 'unknown';
  explicit: boolean;
  method: 'stored' | 'deflate' | null;
  declaredBytes: number;
  compressedBytes: number;
  bytes: number;
  crc32: string | null;
  actualCrc32: string | null;
  sha256: string | null;
  status: 'pending' | 'unpacked' | 'rejected';
  reason?: string;
}
export interface UnpackCounts { archiveEntries: number; plannedNodes: number; expandedNodes: number; files: number; expandedBytes: number; compressedBytes: number; metadataBytes: number; elapsedMs: number }
export interface UnpackManifest {
  readonly version: '0.1'; readonly kind: 'unpack-manifest'; readonly unpackId: string; readonly attemptId: string; readonly createdAt: string;
  readonly source: UnpackSource; readonly unpackedPath: string; readonly parser: typeof ZIP_PARSER;
  readonly policy: UnpackPolicy; readonly policySha256: string; readonly policySourceSha256: string;
  readonly counts: UnpackCounts; readonly entries: readonly UnpackItem[];
}
export type UnpackPhase = 'planning' | 'extracting' | 'verifying' | 'committing';
export interface UnpackReceipt {
  readonly version: '0.1'; readonly kind: 'unpack-receipt'; readonly unpackId: string; readonly attemptId: string;
  readonly selection: { readonly importId: string; readonly path: string }; source: UnpackSource | null;
  readonly ownerPid: number; readonly startedAt: string; finishedAt: string | null;
  status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted'; phase: UnpackPhase;
  readonly parser: typeof ZIP_PARSER; policy: UnpackPolicy | null; policySha256: string | null; policySourceSha256: string | null;
  counts: UnpackCounts; items: UnpackItem[]; readonly tempPath: string;
  manifestPath: string | null; manifestSha256: string | null; indexCommitted: boolean; error: string | null;
}
export interface UnpackIndex {
  readonly version: '0.1'; readonly kind: 'unpack-index'; readonly currentUnpackId: string;
  readonly unpacks: readonly { readonly unpackId: string; readonly attemptId: string; readonly manifestSha256: string }[];
}

/** Portable names are compared per node, including implicit parents. Hidden members are retained. */
export function safeUnpackPath(path: string): boolean {
  return !!path && !/^[a-z]:/i.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' &&
    !/[\\:\x00-\x1f\x7f]/.test(part) && !/[ .]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function canonicalUnpackPath(path: string): string { return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC'); }
export function emptyUnpackCounts(): UnpackCounts { return { archiveEntries: 0, plannedNodes: 0, expandedNodes: 0, files: 0, expandedBytes: 0, compressedBytes: 0, metadataBytes: 0, elapsedMs: 0 }; }
export function emptyUnpackItem(path: string): UnpackItem { return { archiveIndex: null, rawPath: null, rawNameHex: null, path, kind: 'unknown', explicit: false,
  method: null, declaredBytes: 0, compressedBytes: 0, bytes: 0, crc32: null, actualCrc32: null, sha256: null, status: 'pending' }; }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...integer, minimum: 1 };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const crc = { type: 'string', pattern: '^[a-f0-9]{8}$' };
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const id = { type: 'string', pattern: unpackIdPattern.source }, attemptId = { type: 'string', pattern: unpackAttemptPattern.source };
const importId = { type: 'string', pattern: importIdPattern.source };
const date = { type: 'string', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' };
const relativePath = { type: 'string', minLength: 1, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' };
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const policyProperties = { version: { const: '0.1' }, maxArchiveBytes: integer, maxFileBytes: integer, maxTotalBytes: integer,
  maxArchiveEntries: integer, maxExpandedNodes: integer, maxDepth: integer, maxCompressionRatio: positive, maxMetadataBytes: integer, maxElapsedMs: { ...positive, maximum: 2147483647 } };
const policy = object(policyProperties);
const source = object({ importId, path: relativePath, manifestSha256: digest, archiveBytes: integer, archiveSha256: digest });
const counts = object({ archiveEntries: integer, plannedNodes: integer, expandedNodes: integer, files: integer, expandedBytes: integer, compressedBytes: integer, metadataBytes: integer, elapsedMs: integer });
const itemProperties = { archiveIndex: nullable(integer), rawPath: nullable({ type: 'string' }), rawNameHex: nullable({ type: 'string', pattern: '^(?:[a-f0-9]{2})+$' }),
  path: { type: 'string' }, kind: { enum: ['file', 'directory', 'unknown'] }, explicit: { type: 'boolean' }, method: { enum: ['stored', 'deflate', null] },
  declaredBytes: integer, compressedBytes: integer, bytes: integer, crc32: nullable(crc), actualCrc32: nullable(crc), sha256: nullable(digest), status: { enum: ['pending', 'unpacked', 'rejected'] } };
const item = { ...object(itemProperties), properties: { ...itemProperties, reason: { type: 'string', minLength: 1 } }, allOf: [
  { if: { properties: { status: { const: 'rejected' } } }, then: { required: ['reason'] } },
  { if: { properties: { status: { const: 'unpacked' }, kind: { const: 'file' } } }, then: { properties: { sha256: digest, crc32: crc, actualCrc32: crc, method: { enum: ['stored', 'deflate'] }, explicit: { const: true } } } },
  { if: { properties: { status: { const: 'unpacked' }, kind: { const: 'directory' } } }, then: { properties: { bytes: { const: 0 }, sha256: { type: 'null' } } } },
] };
const storedItem = { ...item, properties: { ...item.properties, path: relativePath, status: { const: 'unpacked' }, kind: { enum: ['file', 'directory'] } } };
const schema = (name: string, body: unknown): Schema => ({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `js-build-motion/unpack-${name}@0.1`, ...(body as object) });
export const UNPACK_POLICY_SCHEMA = schema('policy', policy);
export const UNPACK_MANIFEST_SCHEMA = schema('manifest', object({ version: { const: '0.1' }, kind: { const: 'unpack-manifest' }, unpackId: id, attemptId, createdAt: date,
  source, unpackedPath: relativePath, parser: { const: ZIP_PARSER }, policy, policySha256: digest, policySourceSha256: digest, counts, entries: { type: 'array', items: storedItem } }));
export const UNPACK_RECEIPT_SCHEMA = schema('receipt', { ...object({ version: { const: '0.1' }, kind: { const: 'unpack-receipt' }, unpackId: id, attemptId,
  selection: object({ importId: { type: 'string' }, path: { type: 'string' } }), source: nullable(source), ownerPid: positive, startedAt: date, finishedAt: nullable(date),
  status: { enum: ['running', 'prepared', 'succeeded', 'failed', 'interrupted'] }, phase: { enum: ['planning', 'extracting', 'verifying', 'committing'] }, parser: { const: ZIP_PARSER },
  policy: nullable(policy), policySha256: nullable(digest), policySourceSha256: nullable(digest), counts, items: { type: 'array', items: item }, tempPath: relativePath,
  manifestPath: nullable(relativePath), manifestSha256: nullable(digest), indexCommitted: { type: 'boolean' }, error: { type: ['string', 'null'] } }),
  allOf: [{ if: { properties: { status: { const: 'succeeded' } } }, then: { properties: { source, policy, policySha256: digest, policySourceSha256: digest,
    finishedAt: date, manifestPath: relativePath, manifestSha256: digest, indexCommitted: { const: true }, items: { type: 'array', items: storedItem } } } }] });
export const UNPACK_INDEX_SCHEMA = schema('index', object({ version: { const: '0.1' }, kind: { const: 'unpack-index' }, currentUnpackId: id,
  unpacks: { type: 'array', minItems: 1, items: object({ unpackId: id, attemptId, manifestSha256: digest }) } }));
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = { policy: ajv.compile(UNPACK_POLICY_SCHEMA), manifest: ajv.compile(UNPACK_MANIFEST_SCHEMA), receipt: ajv.compile(UNPACK_RECEIPT_SCHEMA), index: ajv.compile(UNPACK_INDEX_SCHEMA) };
export const validateUnpackPolicy = (value: unknown): string[] => collectSchemaErrors(validators.policy, value);
export const validateUnpackManifest = (value: unknown): string[] => collectSchemaErrors(validators.manifest, value);
export const validateUnpackReceipt = (value: unknown): string[] => collectSchemaErrors(validators.receipt, value);
function checked<T>(value: unknown, name: keyof typeof validators): T { const errors = collectSchemaErrors(validators[name], value); if (errors.length) throw new Error(`UNPACK_${name.toUpperCase()}_INVALID: ${errors.join('; ')}`); return value as T; }
export const assertUnpackPolicy = (value: unknown): UnpackPolicy => checked(value, 'policy');
export const assertUnpackManifest = (value: unknown): UnpackManifest => checked(value, 'manifest');
export const assertUnpackReceipt = (value: unknown): UnpackReceipt => checked(value, 'receipt');
export const assertUnpackIndex = (value: unknown): UnpackIndex => checked(value, 'index');
