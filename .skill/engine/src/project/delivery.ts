import { Ajv, type Schema } from 'ajv';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { PRODUCTION_SCHEMAS, productionHash, type ProductionBundle } from './production.ts';
import type { Rights } from './catalog.ts';

const str = { type: 'string', minLength: 1 } as const;
const hash = { ...str, pattern: '^[a-f0-9]{64}$' } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positive = { ...integer, minimum: 1 } as const;
const path = { ...str, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' } as const;
const obj = <P extends Record<string, unknown>>(properties: P) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const arr = <S>(items: S) => ({ type: 'array', items, maxItems: 1000 }) as const;
const nullable = <S>(value: S) => ({ anyOf: [value, { type: 'null' }] }) as const;
const choices = <T extends string>(...values: T[]) => ({ enum: values }) as const;
export const DELIVERY_FILE_SCHEMA = obj({ path, bytes: integer, sha256: hash });
const file = DELIVERY_FILE_SCHEMA;
const source = obj({ sourceId: str, file, roles: { ...arr(str), minItems: 1 }, catalog: nullable(file) });
const subject = obj({
  artifact: obj({ path, sha256: hash, bytes: positive, runId: str, artifactId: nullable(str), runtimeId: hash,
    runSha256: hash, attemptId: str, inputSnapshotSha256: hash }),
  production: obj({ revision: positive, bundle: file, projection: file }),
  renderEvidence: file, audio: obj({ master: nullable(file), sources: arr(obj({ file, role: str })) }),
  sources: arr(source), durationFrames: positive, fps: { enum: [12, 15, 24, 25, 30, 60] },
});
export const REVIEW_CHECK_IDS = ['technical', 'narrative', 'camera', 'rhythm', 'captions', 'audibility', 'sync', 'quality', 'rights'] as const;
const evidence = { ...arr(file), minItems: 1 };
const observation = obj({ modality: choices('video', 'audio', 'audiovisual', 'technical', 'rights'),
  method: choices('normal-speed-playback', 'frame-inspection', 'actual-listening', 'signal-analysis', 'document-read'),
  startFrame: integer, endFrame: positive, tool: str, evidence });
const reference = obj({ title: str, url: nullable(str), file: nullable(file), startSeconds: { type: 'number', minimum: 0 },
  endSeconds: { type: 'number', exclusiveMinimum: 0 }, method: str, evidence, mechanisms: { ...arr(str), minItems: 1 },
  appliedShots: { ...arr(str), minItems: 1 } });
const review = obj({ version: { const: '0.1' }, kind: { const: 'structured-review' }, reviewId: str, subject,
  reviewer: str, observedAt: str, observations: arr(observation), references: arr(reference),
  checks: { ...arr(obj({ checkId: { enum: REVIEW_CHECK_IDS }, verdict: choices('pass', 'revise', 'blocked', 'not_applicable'),
    reason: str, evidence })), minItems: 1 } });
const right = obj({ sourceId: str, file, status: choices('unknown', 'user-declared', 'documented'),
  thirdPartyRightsStatus: choices('unknown', 'user-declared', 'documented'), allowedUses: arr(str),
  restrictions: arr(str), restrictionAssessment: str, requiredAttribution: nullable(str), evidence });
const credits = obj({ version: { const: '0.1' }, kind: { const: 'delivery-credits' }, creditsId: str, subject,
  scope: { const: 'local-delivery' }, sources: arr(right), attributionLines: arr(str) });
const request = obj({ version: { const: '0.1' }, subject, review: file, credits: file, knownLimitations: arr(str), approvals: arr(PRODUCTION_SCHEMAS.decision) });
const manifest = obj({ version: { const: '0.1' }, kind: { const: 'delivery-manifest' }, deliveryId: str,
  createdAt: str, scope: { const: 'local-delivery' }, subject, review: file, credits: file,
  files: { ...arr(file), minItems: 1 }, sourceRights: arr(right), knownLimitations: arr(str) });
export const DELIVERY_SCHEMAS = { file, subject, review, credits, request, manifest };
type Data<S> = S extends { const: infer C } ? C : S extends { enum: readonly (infer E)[] } ? E :
  S extends { anyOf: readonly (infer V)[] } ? Data<V> : S extends { type: 'null' } ? null :
  S extends { type: 'object', properties: infer P } ? { [K in keyof P]: Data<P[K]> } :
  S extends { type: 'array', items: infer I } ? Data<I>[] : S extends { type: 'string' } ? string :
  S extends { type: 'integer' | 'number' } ? number : unknown;
export type DeliverySubject = Data<typeof subject>;
export type StructuredReview = Data<typeof review>;
export type DeliveryCredits = Data<typeof credits>;
export type DeliveryRequest = Data<typeof request>;
export type DeliveryManifest = Data<typeof manifest>;
export type DeliveryFile = Data<typeof file>;
/** Approval records stay outside the reviewed production bundle and their own subject hash. */
export function deliveryApprovalHash(request: DeliveryRequest, target: 'final' | 'delivery'): string {
  if (target === 'final') return productionHash(request.subject);
  const { approvals, ...content } = request;
  return productionHash(content);
}
export interface DeliveryContext {
  subject: DeliverySubject;
  bundle: ProductionBundle;
  catalogRights: { sourceId: string; rights: Rights | null }[];
  consumptionCoverage: 'partial';
  consumptionLimitations: string[];
}
const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(DELIVERY_SCHEMAS).map(([kind, schema]) => [kind, ajv.compile(schema as Schema)]));
export function validateDelivery<T>(kind: keyof typeof DELIVERY_SCHEMAS, value: unknown): T {
  const check = validators[kind];
  if (!check(value)) throw Error('DELIVERY_' + kind.toUpperCase() + '_INVALID: ' + collectSchemaErrors(check, value).join('; '));
  return value as T;
}
