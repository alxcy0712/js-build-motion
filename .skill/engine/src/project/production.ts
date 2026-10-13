import { createHash } from 'node:crypto';
import { Ajv, type Schema } from 'ajv';
import { ASSET_PLAN_SCHEMAS, validateAssetPlan, type AssetPlan } from './asset-plan.ts';
import { PRODUCTION_TIMELINE_SCHEMA, type ProductionTimeline } from './production-timeline-schema.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';

const str = { type: 'string', minLength: 1 } as const;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const id = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,127}$' } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const positive = { ...integer, minimum: 1 } as const;
const number = { type: 'number', exclusiveMinimum: 0 } as const;
const path = { ...str, pattern: '^(?!/)(?![\\s\\S]*[\\\\:\\u0000-\\u001f\\u007f])(?![\\s\\S]*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$' } as const;
const obj = <P extends Record<string, unknown>>(properties: P) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties }) as const;
const arr = <S>(items: S) => ({ type: 'array', items, maxItems: 1000 }) as const;
const nullable = <S>(value: S) => ({ anyOf: [value, { type: 'null' }] }) as const;
const choices = <T extends string>(...values: T[]) => ({ enum: values }) as const;
const file = obj({ path, bytes: integer, sha256: hash });
const prompt = obj({ entry: integer, sha256: hash });
const input = obj({ inputId: id, role: choices('title', 'copy', 'script', 'image', 'video'), text: nullable(str), file: nullable(file),
  catalog: nullable(obj({ catalogId: str, manifestSha256: hash, assetId: str, assetVersion: str })) });
const target = choices('requirements', 'script', 'shots', 'timeline', 'assets', 'preview', 'final', 'delivery');
const decision = obj({ decisionId: id, kind: choices('authorization', 'approval', 'choice', 'question', 'answer', 'revoke'),
  actor: choices('user', 'model'), sourcePrompt: nullable(prompt), rawText: str,
  scope: obj({ action: str, target: str, assetIds: arr(id), provider: nullable(str), maxCost: nullable({ type: 'number', minimum: 0 }) }),
  subjectHash: nullable(hash), supersedes: nullable(id) });
const requested = obj({ rawPrompt: str, sourcePrompt: prompt, scenario: choices('folder-vlog', 'copy-video', 'title-video', 'video-script'), inputs: arr(input),
  hardTargets: obj({ durationSeconds: nullable(number), aspect: nullable(choices('16:9', '9:16', '1:1')), fps: nullable({ enum: [12, 15, 24, 25, 30, 60] }),
    minWidth: nullable(positive), minHeight: nullable(positive) }), originalAudio: nullable(choices('preserve', 'mute')), approvalTasks: arr(target) });
const profile = obj({ width: positive, height: positive });
const effective = obj({ goal: str, audience: str, style: str, durationSeconds: number, aspect: choices('16:9', '9:16', '1:1'),
  fps: { enum: [12, 15, 24, 25, 30, 60] }, originalAudio: choices('preserve', 'mute'), preview: profile, delivery: profile, videoLimits: nullable(file) });
const script = obj({ scriptId: id, sourceHash: hash, sourceRefs: { ...arr(id), minItems: 1 }, lines: { ...arr(obj({ lineId: id, text: { type: 'string' }, screenText: { type: 'string' }, sourceRefs: { ...arr(id), minItems: 1 } })), minItems: 1 } });
const shots = obj({ sourceHash: hash, items: { ...arr(obj({ shotId: id, purpose: str, lineRefs: { ...arr(id), minItems: 1 }, composition: str, camera: str, transition: str,
  durationRange: obj({ minSeconds: number, maxSeconds: number }), events: arr(obj({ eventId: id, action: str, lineRef: nullable(id) })) })), minItems: 1 }, assetPlan: ASSET_PLAN_SCHEMAS.plan });
const invalidation = obj({ key: str, reason: str });
const bundleBase = obj({ version: { const: '0.1' }, requirements: obj({ requested, effective }), script: nullable(script), shots: nullable(shots),
  decisions: arr(decision), invalidations: arr(invalidation) });
const bundle = { ...bundleBase, properties: { ...bundleBase.properties, timeline: nullable(PRODUCTION_TIMELINE_SCHEMA) } } as const;
const changesBase = obj({ effective: nullable(effective), script: nullable(script), shots: nullable(shots) });
const changes = { ...changesBase, properties: { ...changesBase.properties, timeline: nullable(PRODUCTION_TIMELINE_SCHEMA) } } as const;
const proposal = obj({ version: { const: '0.1' }, expectedRevision: integer, expectedSourceHash: hash, expectedViewHash: nullable(hash), rawText: str,
  changes, decisions: arr(decision), invalidations: arr(invalidation) });
const init = obj({ version: { const: '0.1' }, requested, effective, decisions: arr(decision) });
const manifest = obj({ version: { const: '0.1' }, kind: { const: 'production-manifest' }, authority: { const: 'production' },
  workflowVersion: { const: 'p3-mvp-1' }, runtimeId: hash, requiredChecks: arr(str) });
const state = obj({ version: { const: '0.1' }, revision: positive, bundle: file, receipt: file });
export const PRODUCTION_SCHEMAS = { init, bundle, proposal, decision, manifest, state, script, shots, timeline: PRODUCTION_TIMELINE_SCHEMA };

/** New data types derive from the runtime schemas; AssetPlan reuses its existing contract. */
type Data<S> = S extends { const: infer C } ? C : S extends { enum: readonly (infer E)[] } ? E :
  S extends { anyOf: readonly (infer V)[] } ? Data<V> : S extends { type: 'null' } ? null :
  S extends { type: 'object', properties: infer P } ? { [K in keyof P]: Data<P[K]> } :
  S extends { type: 'array', items: infer I } ? Data<I>[] : S extends { type: 'string' } ? string :
  S extends { type: 'integer' | 'number' } ? number : unknown;
export type ProductionInput = Data<typeof input>;
export type ProductionDecision = Data<typeof decision>;
export type ProductionScript = Data<typeof script>;
export type ProductionShots = Omit<Data<typeof shots>, 'assetPlan'> & { assetPlan: AssetPlan };
export type ProductionBundle = Omit<Data<typeof bundle>, 'shots' | 'timeline'> & { shots: ProductionShots | null; timeline?: ProductionTimeline | null };
export type ProductionInit = Data<typeof init>;
export type ProductionProposal = Omit<Data<typeof proposal>, 'changes'> & { changes: { effective: Data<typeof effective> | null; script: ProductionScript | null; shots: ProductionShots | null; timeline?: ProductionTimeline | null } };
export type ProductionManifest = Data<typeof manifest>;
export type ProductionState = Data<typeof state>;
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
const validators = Object.fromEntries(Object.entries(PRODUCTION_SCHEMAS).map(([k, s]) => [k, ajv.compile(s as Schema)]));
export function validateProduction<T>(kind: keyof typeof PRODUCTION_SCHEMAS, value: unknown): T {
  const check = validators[kind];
  if (!check(value)) throw Error(`PRODUCTION_${kind.toUpperCase()}_INVALID: ${collectSchemaErrors(check, value).join('; ')}`);
  return value as T;
}
export function productionHash(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export const PRODUCTION_CHECK_IDS = ['requirements.consistent', 'script.references', 'shots.references', 'assets.identity', 'decisions.applicable'] as const;
export function assertProductionChecks(ids: readonly string[]): void {
  for (const value of ids) if (!(PRODUCTION_CHECK_IDS as readonly string[]).includes(value)) throw Error('PRODUCTION_UNKNOWN_CHECK: ' + value);
  if (new Set(ids).size !== ids.length) throw Error('PRODUCTION_CHECK_DUPLICATE');
  if (ids.length !== PRODUCTION_CHECK_IDS.length) throw Error('PRODUCTION_REQUIRED_CHECK_MISSING');
}
export function scriptSourceHash(b: ProductionBundle): string {
  const refs = b.script?.sourceRefs ?? [];
  const e = b.requirements.effective;
  return productionHash({ requested: { ...b.requirements.requested, inputs: b.requirements.requested.inputs.filter(i => refs.includes(i.inputId)) },
    effective: { goal: e.goal, audience: e.audience, style: e.style, durationSeconds: e.durationSeconds } });
}
export function shotsSourceHash(b: ProductionBundle): string {
  const refs = new Set(b.shots?.items.flatMap(s => s.lineRefs) ?? []);
  return productionHash({ effective: b.requirements.effective, scriptId: b.script?.scriptId,
    lines: b.script?.lines.filter(l => refs.has(l.lineId)), assets: b.shots?.assetPlan });
}
export function validateProductionRelations(b: ProductionBundle): void {
  validateProduction('bundle', b);
  const inputs = new Set(b.requirements.requested.inputs.map(i => i.inputId));
  if (inputs.size !== b.requirements.requested.inputs.length) throw Error('PRODUCTION_INPUT_DUPLICATE');
  const roles = b.requirements.requested.inputs.map(i => i.role), scenario = b.requirements.requested.scenario;
  if (scenario === 'folder-vlog' && !roles.some(r => ['image', 'video'].includes(r)) || scenario === 'copy-video' && !roles.includes('copy') ||
    scenario === 'title-video' && !roles.includes('title') || scenario === 'video-script' && (!roles.includes('video') || !roles.includes('script'))) throw Error('PRODUCTION_SCENARIO_INPUT_REQUIRED');
  for (const i of b.requirements.requested.inputs) {
    if ((i.text === null) === (i.file === null) || ['image', 'video'].includes(i.role) && (!i.file || !i.catalog) || i.file && !/^inputs\/(original|unpacked)\//.test(i.file.path)) throw Error('PRODUCTION_INPUT_IDENTITY_REQUIRED: ' + i.inputId);
  }
  const decisionIds = new Set(b.decisions.map(d => d.decisionId));
  if (decisionIds.size !== b.decisions.length) throw Error('PRODUCTION_DECISION_DUPLICATE');
  for (const [index, d] of b.decisions.entries()) if (d.supersedes && !b.decisions.slice(0, index).some(old => old.decisionId === d.supersedes)) throw Error('PRODUCTION_DECISION_FORWARD_REFERENCE');
  if (!b.script) { if (b.shots) throw Error('PRODUCTION_SCRIPT_REQUIRED'); return; }
  const lines = new Set(b.script.lines.map(l => l.lineId));
  if (lines.size !== b.script.lines.length) throw Error('PRODUCTION_LINE_DUPLICATE');
  for (const ref of [...b.script.sourceRefs, ...b.script.lines.flatMap(l => l.sourceRefs)]) if (!inputs.has(ref)) throw Error('PRODUCTION_INPUT_REFERENCE: ' + ref);
  for (const l of b.script.lines) if (l.sourceRefs.some(ref => !b.script!.sourceRefs.includes(ref))) throw Error('PRODUCTION_SCRIPT_SOURCE_INCOMPLETE');
  const consumedRoles = (refs: string[]) => b.requirements.requested.inputs.filter(i => refs.includes(i.inputId)).map(i => i.role);
  const essential = (roles: string[]) => scenario === 'folder-vlog' ? roles.some(r => ['image', 'video'].includes(r)) :
    scenario === 'video-script' ? roles.includes('video') && roles.includes('script') : roles.includes(scenario === 'copy-video' ? 'copy' : 'title');
  if (!essential(consumedRoles(b.script.lines.flatMap(l => l.sourceRefs)))) throw Error('PRODUCTION_SCENARIO_SOURCE_REQUIRED');
  if (!b.shots) return;
  const ids = new Set(b.shots.items.map(s => s.shotId)), events = new Set<string>();
  if (ids.size !== b.shots.items.length) throw Error('PRODUCTION_SHOT_DUPLICATE');
  for (const s of b.shots.items) {
    if (s.durationRange.minSeconds > s.durationRange.maxSeconds) throw Error('PRODUCTION_DURATION_RANGE');
    for (const ref of s.lineRefs) if (!lines.has(ref)) throw Error('PRODUCTION_LINE_REFERENCE: ' + ref);
    for (const e of s.events) {
      if (events.has(e.eventId)) throw Error('PRODUCTION_EVENT_DUPLICATE'); events.add(e.eventId);
      if (e.lineRef && !s.lineRefs.includes(e.lineRef)) throw Error('PRODUCTION_EVENT_LINE_REFERENCE');
    }
  }
  const consumedLines = new Set(b.shots.items.flatMap(s => s.lineRefs));
  if (!essential(consumedRoles(b.script.lines.filter(l => consumedLines.has(l.lineId)).flatMap(l => l.sourceRefs)))) throw Error('PRODUCTION_SCENARIO_SHOT_SOURCE_REQUIRED');
  if (['folder-vlog', 'video-script'].includes(scenario) && !b.shots.assetPlan.uses.some(u => u.role === 'visual' && b.requirements.requested.inputs.some(i =>
    (scenario === 'folder-vlog' ? ['image', 'video'].includes(i.role) : i.role === 'video') && i.catalog &&
    i.catalog.catalogId === u.catalogId && i.catalog.manifestSha256 === u.catalogManifestSha256 && i.catalog.assetId === u.assetId && i.catalog.assetVersion === u.assetVersion))) throw Error('PRODUCTION_SCENARIO_ASSET_REQUIRED');
  validateAssetPlan(b.shots.assetPlan);
  for (const n of b.shots.assetPlan.needs) if (!ids.has(n.shotId)) throw Error('PRODUCTION_ASSET_SHOT_REFERENCE');
}
