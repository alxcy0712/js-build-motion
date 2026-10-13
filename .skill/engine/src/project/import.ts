import { Ajv, type Schema } from 'ajv';
import { collectSchemaErrors } from '../utils/json-schema.ts';

export interface ImportPolicy {
  readonly version: '0.1';
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
}
export const DEFAULT_IMPORT_POLICY: ImportPolicy = Object.freeze({
  version: '0.1', maxFileBytes: 1073741824, maxTotalBytes: 4294967296, maxFiles: 5000, maxDepth: 16,
});
export type ImportItemKind = 'file' | 'directory' | 'symlink' | 'special' | 'unknown';
export interface ImportItem {
  path: string;
  kind: ImportItemKind;
  status: 'pending' | 'received' | 'rejected';
  bytes: number;
  sha256: string | null;
  reason?: string;
}
export interface ImportSource { readonly path: string; readonly kind: 'file' | 'directory' | 'unknown' }
export interface ImportManifest {
  readonly version: '0.1';
  readonly kind: 'import-manifest';
  readonly importId: string;
  readonly attemptId: string;
  readonly createdAt: string;
  readonly source: ImportSource;
  readonly originalsPath: string;
  readonly policy: ImportPolicy;
  readonly policySha256: string;
  readonly totals: { readonly files: number; readonly bytes: number };
  readonly entries: readonly ImportItem[];
}
export type ImportPhase = 'planning' | 'copying' | 'verifying' | 'committing';
export interface ImportReceipt {
  readonly version: '0.1';
  readonly kind: 'import-receipt';
  readonly attemptId: string;
  readonly importId: string;
  readonly source: ImportSource;
  readonly ownerPid: number;
  readonly startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted';
  phase: ImportPhase;
  policy: ImportPolicy | null;
  policySha256: string | null;
  policySourceSha256: string | null;
  counts: { discoveredFiles: number; copiedFiles: number; copiedBytes: number };
  items: ImportItem[];
  readonly tempPath: string;
  manifestPath: string | null;
  manifestSha256: string | null;
  indexCommitted: boolean;
  error: string | null;
}
export interface ImportIndex {
  readonly version: '0.1';
  readonly kind: 'import-index';
  readonly currentImportId: string;
  readonly imports: readonly { readonly importId: string; readonly attemptId: string; readonly manifestSha256: string }[];
}

/** Only byte inspection/copying crosses this port; the application owns admission and publication. */
export interface ImportNode {
  readonly kind: ImportItemKind;
  readonly dev: string;
  readonly ino: string;
  readonly nlink: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export interface ImportFilesPort {
  inspect(path: string): Promise<ImportNode>;
  children(path: string): Promise<string[]>;
  copy(source: string, destination: string, expected: ImportNode, onChunk: (bytes: number) => Promise<void>, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }>;
  hash(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }>;
}
export interface ImportLockOwner { readonly attemptId: string; readonly importId: string; readonly pid: number }
export interface ImportStoragePort extends ImportFilesPort {
  assertProject(): Promise<void>;
  projectPath(path: string): string;
  ensureDirectory(path: string): Promise<void>;
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, value: unknown): Promise<void>;
  moveDirectory(from: string, to: string): Promise<void>;
  attemptDirectories(): Promise<string[]>;
  acquireLock(owner: ImportLockOwner, isAlive: (pid: number, attemptId: string) => boolean): Promise<string>;
  releaseLock(path: string, attemptId: string): Promise<void>;
}

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const id = { type: 'string', pattern: '^import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const attemptId = { type: 'string', pattern: '^import-attempt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' };
const relativePath = { type: 'string', pattern: '^(?!/)(?![\\s\\S]*\\\\)(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/\\u0000]+(?:/[^/\\u0000]+)*$' };
const date = { type: 'string', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$' };
const source = { type: 'object', additionalProperties: false, required: ['path', 'kind'], properties: {
  path: { type: 'string', minLength: 1 }, kind: { enum: ['file', 'directory', 'unknown'] },
} };

export const IMPORT_POLICY_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'js-build-motion/import-policy@0.1',
  type: 'object', additionalProperties: false, required: ['version', 'maxFileBytes', 'maxTotalBytes', 'maxFiles', 'maxDepth'],
  properties: { version: { const: '0.1' }, maxFileBytes: integer, maxTotalBytes: integer, maxFiles: integer, maxDepth: integer },
};
const policyBody = { ...IMPORT_POLICY_SCHEMA } as Record<string, unknown>;
delete policyBody.$id; delete policyBody.$schema;
const item = { type: 'object', additionalProperties: false, required: ['path', 'kind', 'status', 'bytes', 'sha256'], properties: {
  path: { type: 'string' }, kind: { enum: ['file', 'directory', 'symlink', 'special', 'unknown'] },
  status: { enum: ['pending', 'received', 'rejected'] }, bytes: integer,
  sha256: { anyOf: [digest, { type: 'null' }] }, reason: { type: 'string', minLength: 1 },
}, allOf: [
  { if: { properties: { status: { const: 'rejected' } } }, then: { required: ['reason'] } },
  { if: { properties: { status: { const: 'received' } } }, then: { properties: { path: { anyOf: [relativePath, { const: '' }] }, kind: { enum: ['file', 'directory'] } } } },
  { if: { properties: { status: { const: 'received' }, kind: { const: 'file' } } }, then: { properties: { sha256: digest } } },
  { if: { properties: { status: { const: 'received' }, kind: { const: 'directory' } } }, then: { properties: { bytes: { const: 0 }, sha256: { type: 'null' } } } },
] };
const receivedItem = { ...item, properties: { ...item.properties, path: relativePath, kind: { enum: ['file', 'directory'] }, status: { const: 'received' } },
  allOf: [{ if: { properties: { kind: { const: 'file' } } }, then: { properties: { sha256: digest } }, else: { properties: { bytes: { const: 0 }, sha256: { type: 'null' } } } }],
};
export const IMPORT_MANIFEST_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'js-build-motion/import-manifest@0.1',
  type: 'object', additionalProperties: false,
  required: ['version', 'kind', 'importId', 'attemptId', 'createdAt', 'source', 'originalsPath', 'policy', 'policySha256', 'totals', 'entries'],
  properties: {
    version: { const: '0.1' }, kind: { const: 'import-manifest' }, importId: id, attemptId, createdAt: date, source: { ...source, properties: { ...source.properties, kind: { enum: ['file', 'directory'] } } },
    originalsPath: relativePath, policy: policyBody, policySha256: digest,
    totals: { type: 'object', additionalProperties: false, required: ['files', 'bytes'], properties: { files: integer, bytes: integer } },
    entries: { type: 'array', items: receivedItem },
  },
};
export const IMPORT_RECEIPT_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'js-build-motion/import-receipt@0.1',
  type: 'object', additionalProperties: false,
  required: ['version', 'kind', 'attemptId', 'importId', 'source', 'ownerPid', 'startedAt', 'finishedAt', 'status', 'phase', 'policy', 'policySha256', 'policySourceSha256', 'counts', 'items', 'tempPath', 'manifestPath', 'manifestSha256', 'indexCommitted', 'error'],
  properties: {
    version: { const: '0.1' }, kind: { const: 'import-receipt' }, attemptId, importId: id, source, ownerPid: { ...integer, minimum: 1 }, startedAt: date,
    finishedAt: { anyOf: [date, { type: 'null' }] }, status: { enum: ['running', 'prepared', 'succeeded', 'failed', 'interrupted'] }, phase: { enum: ['planning', 'copying', 'verifying', 'committing'] },
    policy: { anyOf: [policyBody, { type: 'null' }] }, policySha256: { anyOf: [digest, { type: 'null' }] },
    policySourceSha256: { anyOf: [digest, { type: 'null' }] },
    counts: { type: 'object', additionalProperties: false, required: ['discoveredFiles', 'copiedFiles', 'copiedBytes'], properties: { discoveredFiles: integer, copiedFiles: integer, copiedBytes: integer } },
    items: { type: 'array', items: item }, tempPath: relativePath,
    manifestPath: { anyOf: [relativePath, { type: 'null' }] }, manifestSha256: { anyOf: [digest, { type: 'null' }] }, indexCommitted: { type: 'boolean' },
    error: { type: ['string', 'null'] },
  },
  allOf: [{ if: { properties: { status: { const: 'succeeded' } } }, then: { properties: {
    policy: policyBody, policySha256: digest, policySourceSha256: digest, manifestPath: relativePath, manifestSha256: digest, finishedAt: date,
    indexCommitted: { const: true }, items: { type: 'array', items: { ...item, properties: { ...item.properties, status: { const: 'received' } } } },
  } } }],
};
export const IMPORT_INDEX_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'js-build-motion/import-index@0.1',
  type: 'object', additionalProperties: false, required: ['version', 'kind', 'currentImportId', 'imports'],
  properties: { version: { const: '0.1' }, kind: { const: 'import-index' }, currentImportId: id,
    imports: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['importId', 'attemptId', 'manifestSha256'], properties: { importId: id, attemptId, manifestSha256: digest } } },
  },
};
const ajv = new Ajv({ allErrors: true, strict: false });
const policyValidator = ajv.compile(IMPORT_POLICY_SCHEMA), manifestValidator = ajv.compile(IMPORT_MANIFEST_SCHEMA);
const receiptValidator = ajv.compile(IMPORT_RECEIPT_SCHEMA), indexValidator = ajv.compile(IMPORT_INDEX_SCHEMA);
export function validateImportPolicy(value: unknown): string[] { return collectSchemaErrors(policyValidator, value); }
export function validateImportManifest(value: unknown): string[] { return collectSchemaErrors(manifestValidator, value); }
export function validateImportReceipt(value: unknown): string[] { return collectSchemaErrors(receiptValidator, value); }
export function assertImportPolicy(value: unknown): ImportPolicy { return checked(value, validateImportPolicy, 'IMPORT_POLICY_INVALID'); }
export function assertImportManifest(value: unknown): ImportManifest { return checked(value, validateImportManifest, 'IMPORT_MANIFEST_INVALID'); }
export function assertImportReceipt(value: unknown): ImportReceipt { return checked(value, validateImportReceipt, 'IMPORT_RECEIPT_INVALID'); }
export function assertImportIndex(value: unknown): ImportIndex { return checked(value, data => collectSchemaErrors(indexValidator, data), 'IMPORT_INDEX_INVALID'); }
function checked<T>(value: unknown, validate: (value: unknown) => string[], code: string): T {
  const errors = validate(value);
  if (errors.length) throw new Error(`${code}: ${errors.join('; ')}`);
  return value as T;
}
