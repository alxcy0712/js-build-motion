import { Ajv, type Schema } from 'ajv';
import { UUID_PATTERN } from './unpack.ts';
import type { VideoPreparationRequest } from './video-preparation.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

export interface AssetNeed { needId: string; shotId: string; purpose: string; required: boolean;
  content: { action: string | null; view: string | null; identity: string | null };
  constraints: { durationSeconds: number | null; minWidth: number | null; minHeight: number | null;
    aspectRatio: number | null; transparent: boolean | null; rightsUse: string | null };
  alternative: string | null }
export interface AssetFileIdentity { path: string; bytes: number; sha256: string }
export interface AssetUse { useId: string; needId: string; shotId: string; role: 'visual' | 'audio' | 'reference';
  catalogId: string; catalogManifestSha256: string; assetId: string; assetVersion: string; byteSha256: string;
  selection: { kind: 'source' } | { kind: 'video'; map: AssetFileIdentity };
  sourceRange: VideoPreparationRequest['sourceRange'] | null;
  crop: { x: number; y: number; width: number; height: number } | null; fit: 'contain' | 'cover'; mute: boolean }
export interface AssetPlan { version: '0.1' | '0.2'; kind: 'asset-plan'; needs: AssetNeed[]; uses: AssetUse[] }
export interface AssetGap { needId: string; shotId: string; useId: string | null;
  code: 'unbound' | 'technical' | 'duration' | 'dimensions' | 'aspect' | 'alpha' | 'rights' | 'semantic' | 'composition' | 'continuity'; reason: string }
export interface AssetConsumptionReceipt { useId: string; needId: string; shotId: string; role: AssetUse['role'];
  catalogId: string; catalogManifestSha256: string; assetId: string; assetVersion: string; byteSha256: string;
  source: AssetFileIdentity; selected: AssetFileIdentity; derivedMap: AssetFileIdentity | null;
  operation: 'prepared-read' | 'image-draw' | 'frame-access' | 'video-draw'; frame: number | null; sourcePts: string | null }
export interface AssetUsage { version: '0.1'; kind: 'asset-usage'; attemptId: string; inputSnapshotSha256: string;
  plan: AssetFileIdentity | null; coverage: 'partial' | 'complete'; scope: string[]; unknownRemainder: string[];
  receipts: AssetConsumptionReceipt[]; gaps: AssetGap[] }

const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, positive = { ...integer, minimum: 1 };
const string = { type: 'string' }, nonempty = { ...string, minLength: 1 }, hash = { ...string, pattern: '^[a-f0-9]{64}$' };
const stable = { ...string, pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' }, nullable = (value: unknown) => ({ anyOf: [value, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
const id = (prefix: string) => ({ ...string, pattern: `^${prefix}-${UUID_PATTERN}$` });
const path = { ...nonempty, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' };
const file = object({ path, bytes: integer, sha256: hash });
const need = object({ needId: stable, shotId: stable, purpose: { ...nonempty, maxLength: 4096 }, required: { type: 'boolean' },
  content: object({ action: nullable(nonempty), view: nullable(nonempty), identity: nullable(nonempty) }),
  constraints: object({ durationSeconds: nullable({ type: 'number', exclusiveMinimum: 0 }), minWidth: nullable(positive), minHeight: nullable(positive),
    aspectRatio: nullable({ type: 'number', exclusiveMinimum: 0 }), transparent: nullable({ type: 'boolean' }), rightsUse: nullable(nonempty) }), alternative: nullable(nonempty) });
const tuple = { catalogId: id('catalog'), catalogManifestSha256: hash, assetId: id('asset'), assetVersion: id('asset-version'), byteSha256: hash };
const sourceRange = object({ timeBase: { ...string, pattern: '^[1-9][0-9]{0,8}/[1-9][0-9]{0,8}$' },
  startPts: { ...string, pattern: '^-?(?:0|[1-9][0-9]{0,18})$' }, endPts: { ...string, pattern: '^-?(?:0|[1-9][0-9]{0,18})$' } });
const crop = object({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
  width: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1 } });
const role = { enum: ['visual', 'audio', 'reference'] };
const use = object({ useId: stable, needId: stable, shotId: stable, role, ...tuple,
  selection: { oneOf: [object({ kind: { const: 'source' } }), object({ kind: { const: 'video' }, map: file })] },
  sourceRange: nullable(sourceRange), crop: nullable(crop), fit: { enum: ['contain', 'cover'] }, mute: { type: 'boolean' } });
const gap = object({ needId: stable, shotId: stable, useId: nullable(stable),
  code: { enum: ['unbound', 'technical', 'duration', 'dimensions', 'aspect', 'alpha', 'rights', 'semantic', 'composition', 'continuity'] }, reason: nonempty });
const receipt = object({ useId: stable, needId: stable, shotId: stable, role, ...tuple, source: file, selected: file, derivedMap: nullable(file),
  operation: { enum: ['prepared-read', 'image-draw', 'frame-access', 'video-draw'] }, frame: nullable(integer),
  sourcePts: nullable({ ...string, pattern: '^-?(?:0|[1-9][0-9]{0,18})$' }) });
const plan = object({ version: { const: '0.1' }, kind: { const: 'asset-plan' }, needs: { ...array(need), maxItems: 1000 }, uses: { ...array(use), maxItems: 1000 } });
const usage = object({ version: { const: '0.1' }, kind: { const: 'asset-usage' }, attemptId: { ...string, pattern: `^${UUID_PATTERN}$` },
  inputSnapshotSha256: hash, plan: nullable(file), coverage: { enum: ['partial', 'complete'] }, scope: { ...array(nonempty), minItems: 1, uniqueItems: true }, unknownRemainder: array(nonempty),
  receipts: { ...array(receipt), maxItems: 100000 }, gaps: array(gap) });
const productionUse = { ...use, required: use.required.filter(key => key !== 'mute'),
  properties: { ...use.properties, mute: { type: 'boolean', default: false } } };
const productionPlan = object({ ...plan.properties, version: { const: '0.2' }, uses: { ...array(productionUse), maxItems: 1000 } });
export const ASSET_PLAN_SCHEMAS = { plan: { oneOf: [plan, productionPlan] }, usage };
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(ASSET_PLAN_SCHEMAS).map(([key, value]) => [key, ajv.compile(value as Schema)]));
function assertAsset<T>(kind: keyof typeof ASSET_PLAN_SCHEMAS, value: unknown): T {
  const check = validators[kind]; if (!check(value)) throw Error(`ASSET_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`); return value as T;
}
export function validateAssetPlan(value: unknown): AssetPlan {
  const original = assertAsset<AssetPlan>('plan', value), result = original.version === '0.2'
    ? { ...original, uses: original.uses.map(use => ({ ...use, mute: use.mute ?? false })) } : original,
    needs = new Map(result.needs.map(n => [n.needId, n])), uses = new Set<string>();
  if (needs.size !== result.needs.length) throw Error('ASSET_NEED_DUPLICATE');
  for (const use of result.uses) {
    if (uses.has(use.useId)) throw Error('ASSET_USE_DUPLICATE'); uses.add(use.useId);
    if (needs.get(use.needId)?.shotId !== use.shotId) throw Error('ASSET_USE_NEED_MISMATCH');
    if (use.crop && (use.crop.x + use.crop.width > 1 || use.crop.y + use.crop.height > 1)) throw Error('ASSET_CROP_INVALID');
    if (use.selection.kind === 'video' && (result.version === '0.1' && !use.mute || use.role !== 'visual' || !use.sourceRange || !new RegExp(`^assets/derived/video/${UUID_PATTERN}/map\\.json$`).test(use.selection.map.path)) ||
        use.selection.kind === 'source' && use.sourceRange !== null || use.sourceRange && BigInt(use.sourceRange.endPts) <= BigInt(use.sourceRange.startPts)) throw Error('ASSET_SELECTION_INVALID');
  }
  return result;
}
export function validateAssetUsage(value: unknown): AssetUsage {
  const result = assertAsset<AssetUsage>('usage', value);
  if (result.coverage === 'complete' && result.unknownRemainder.length || result.coverage === 'partial' && !result.unknownRemainder.length) throw Error('ASSET_COVERAGE_INVALID');
  for (const r of result.receipts) {
    if (r.source.sha256 !== r.byteSha256) throw Error('ASSET_RECEIPT_SOURCE_INVALID');
    if (['frame-access', 'video-draw'].includes(r.operation) ? !r.derivedMap || r.role !== 'visual' || r.frame === null || r.sourcePts === null : r.frame !== null || r.sourcePts !== null) throw Error('ASSET_RECEIPT_OPERATION_INVALID');
    if (r.operation === 'image-draw' && (r.derivedMap !== null || r.role !== 'visual')) throw Error('ASSET_RECEIPT_OPERATION_INVALID');
  }
  if (result.plan === null && result.receipts.length) throw Error('ASSET_RECEIPT_PLAN_REQUIRED');
  return result;
}
