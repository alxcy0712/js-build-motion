import { productionHash, scriptSourceHash, shotsSourceHash, validateProduction, validateProductionRelations,
  type ProductionBundle, type ProductionDecision } from './production.ts';

import { compileProductionTimeline } from './production-timeline.ts';
type TaskId = Extract<keyof ProductionBundle, 'requirements' | 'script' | 'shots' | 'timeline'>;
type Request = { assetIds?: string[]; provider?: string | null; cost?: number };
const userKinds = new Set(['authorization', 'approval', 'revoke', 'answer']);
const trusted = (d: ProductionDecision) => d.actor === 'user' && d.sourcePrompt !== null;

export function applicableDecisions(bundle: ProductionBundle): ProductionDecision[] {
  const previous = new Map<string, ProductionDecision>(), superseded = new Set<string>();
  for (const d of bundle.decisions) {
    validateProduction('decision', d);
    if (previous.has(d.decisionId)) throw Error('PRODUCTION_DECISION_DUPLICATE');
    if (userKinds.has(d.kind) && !trusted(d)) throw Error('PRODUCTION_DECISION_USER_SOURCE_REQUIRED: ' + d.decisionId);
    if (d.kind === 'revoke' && !d.supersedes) throw Error('PRODUCTION_REVOKE_SUBJECT_REQUIRED');
    if (d.supersedes) {
      const old = previous.get(d.supersedes);
      if (!old) throw Error('PRODUCTION_DECISION_FORWARD_REFERENCE');
      if (d.kind !== 'revoke' && d.kind !== old.kind && !(d.kind === 'answer' && old.kind === 'question')) throw Error('PRODUCTION_DECISION_SUPERSESSION_KIND');
      if (d.kind === 'answer' && d.scope.target !== old.scope.target) throw Error('PRODUCTION_ANSWER_TARGET_MISMATCH');
      superseded.add(d.supersedes);
    }
    previous.set(d.decisionId, d);
  }
  return bundle.decisions.filter(d => !superseded.has(d.decisionId));
}

function authorized(decisions: ProductionDecision[], action: string, target: string, request: Request): boolean {
  const assets = request.assetIds ?? [], provider = request.provider ?? null, cost = request.cost ?? 0;
  if (!Number.isFinite(cost) || cost < 0 || assets.some(id => typeof id !== 'string' || !id.length) || new Set(assets).size !== assets.length) throw Error('PRODUCTION_AUTHORIZATION_REQUEST_INVALID');
  return decisions.some(d => d.kind === 'authorization' && trusted(d) && d.scope.action === action &&
    (d.scope.target === target || action === 'plan' && ['requirements', 'script', 'shots', 'timeline'].includes(target) && d.scope.target === 'project' && provider === null && cost === 0 && !assets.length) &&
    d.scope.provider === provider && cost <= (d.scope.maxCost ?? 0) && assets.every(id => d.scope.assetIds.includes(id)));
}

export function authorizeProduction(bundle: ProductionBundle, action: string, target: string, request: Request = {}): void {
  if (!authorized(applicableDecisions(bundle), action, target, request)) throw Error(`PRODUCTION_AUTHORIZATION_REQUIRED: ${action}/${target}`);
}

export function approvalSatisfied(bundle: ProductionBundle, target: string, subjectHash: string): boolean {
  return applicableDecisions(bundle).some(d => d.kind === 'approval' && trusted(d) && d.scope.action === 'approve' && d.scope.target === target && d.subjectHash === subjectHash);
}

export function assertProductionRequirements(bundle: ProductionBundle): void {
  const { requested: r, effective: e } = bundle.requirements, h = r.hardTargets;
  for (const key of ['durationSeconds', 'aspect', 'fps'] as const) if (h[key] !== null && h[key] !== e[key]) throw Error('PRODUCTION_HARD_TARGET_CONFLICT: ' + key);
  for (const [key, actual] of [['minWidth', e.delivery.width], ['minHeight', e.delivery.height]] as const) if (h[key] !== null && actual < h[key]!) throw Error('PRODUCTION_HARD_TARGET_CONFLICT: ' + key);
  const [w, height] = e.aspect.split(':').map(BigInt);
  for (const [name, profile] of [['preview', e.preview], ['delivery', e.delivery]] as const) if (BigInt(profile.width) * height! !== BigInt(profile.height) * w!) throw Error('PRODUCTION_ASPECT_CONFLICT: ' + name);
  if (r.originalAudio !== null && e.originalAudio !== r.originalAudio) throw Error('PRODUCTION_HARD_TARGET_CONFLICT: originalAudio');
  if (bundle.timeline?.clips.some(c => c.mute || c.gain === 0) && !applicableDecisions(bundle).some(d => trusted(d) && ['choice', 'answer', 'authorization'].includes(d.kind) && d.scope.action === 'mute' && d.scope.target === 'timeline')) throw Error('PRODUCTION_ORIGINAL_AUDIO_INTENT_REQUIRED');
  if (r.originalAudio === null && r.inputs.some(i => i.role === 'video') && e.originalAudio === 'mute' &&
      !applicableDecisions(bundle).some(d => trusted(d) && ['choice', 'answer', 'authorization'].includes(d.kind) && d.scope.action === 'mute' && d.scope.target === 'requirements')) throw Error('PRODUCTION_ORIGINAL_AUDIO_INTENT_REQUIRED');
}

export function productionAffected(bundle: ProductionBundle, keys: readonly string[]): TaskId[] {
  const affected = new Set<TaskId>();
  for (const key of keys) {
    if (key === 'requested' || key === 'effective') { ['requirements', 'script', 'shots'].forEach(id => affected.add(id as TaskId)); continue; }
    if (key === 'timeline' && Object.hasOwn(bundle, 'timeline')) { affected.add('timeline'); continue; }
    const [kind, id, extra] = key.split(':');
    if (!id || extra !== undefined) throw Error('PRODUCTION_INVALIDATION_SELECTOR: ' + key);
    if (kind === 'input') {
      const input = bundle.requirements.requested.inputs.find(i => i.inputId === id);
      if (!input) throw Error('PRODUCTION_INVALIDATION_SELECTOR: ' + key);
      if (bundle.script?.sourceRefs.includes(id)) affected.add('script');
      const lines = bundle.script?.lines.filter(l => l.sourceRefs.includes(id)).map(l => l.lineId) ?? [];
      if (bundle.shots?.items.some(s => s.lineRefs.some(ref => lines.includes(ref))) || input.catalog && bundle.shots?.assetPlan.uses.some(u =>
        u.catalogId === input.catalog!.catalogId && u.catalogManifestSha256 === input.catalog!.manifestSha256 && u.assetId === input.catalog!.assetId && u.assetVersion === input.catalog!.assetVersion)) affected.add('shots');
    } else if (kind === 'line') {
      if (!bundle.script?.lines.some(l => l.lineId === id)) throw Error('PRODUCTION_INVALIDATION_SELECTOR: ' + key);
      affected.add('script');
      if (bundle.shots?.items.some(s => s.lineRefs.includes(id))) affected.add('shots');
    } else if (kind === 'shot') {
      if (!bundle.shots?.items.some(s => s.shotId === id)) throw Error('PRODUCTION_INVALIDATION_SELECTOR: ' + key);
      affected.add('shots');
    } else throw Error('PRODUCTION_INVALIDATION_SELECTOR: ' + key);
  }
  if (Object.hasOwn(bundle, 'timeline') && affected.size) affected.add('timeline');
  return (['requirements', 'script', 'shots', 'timeline'] as const).filter(id => affected.has(id));
}

export function productionStages(bundle: ProductionBundle): { taskId: TaskId; status: 'complete' | 'ready' | 'pending' | 'stale' | 'waiting_user'; reason: string }[] {
  validateProductionRelations(bundle);
  const decisions = applicableDecisions(bundle), invalidated = productionAffected(bundle, bundle.invalidations.map(i => i.key));
  const gate = (taskId: TaskId): string | null => {
    if (decisions.some(d => d.kind === 'question' && (d.scope.target === taskId || d.scope.target === 'project' || taskId === 'shots' && d.scope.target === 'assets'))) return 'scoped question requires a user answer';
    if (!authorized(decisions, 'plan', taskId, {})) return 'scoped planning authorization required';
    const targets = taskId === 'shots' ? ['shots', 'assets'] : [taskId];
    for (const target of targets) if (bundle.requirements.requested.approvalTasks.includes(target as any) && bundle[taskId] !== null) {
      const hash = productionHash(target === 'assets' ? bundle.shots?.assetPlan : bundle[taskId]);
      if (!decisions.some(d => d.kind === 'approval' && trusted(d) && d.scope.action === 'approve' && d.scope.target === target && d.subjectHash === hash)) return 'current ' + target + ' subject approval required';
    }
    return null;
  };
  let conflict: string | null = null;
  try { assertProductionRequirements(bundle); } catch (error) { conflict = (error as Error).message; }
  const reqGate = gate('requirements');
  const requirements = { taskId: 'requirements' as const, status: conflict || invalidated.includes('requirements') ? 'stale' as const : reqGate ? 'waiting_user' as const : 'complete' as const,
    reason: conflict ?? (invalidated.includes('requirements') ? 'requirements invalidated' : reqGate ?? 'requested targets and effective plan consistent') };
  const result: ReturnType<typeof productionStages> = [requirements];
  for (const taskId of ['script', 'shots'] as const) {
    const output = bundle[taskId], waiting = gate(taskId);
    if (output && (invalidated.includes(taskId) || output.sourceHash !== (taskId === 'script' ? scriptSourceHash(bundle) : shotsSourceHash(bundle)))) result.push({ taskId, status: 'stale', reason: 'consumed source changed or output invalidated' });
    else if (waiting) result.push({ taskId, status: 'waiting_user', reason: waiting });
    else if (output) {
      const unbound = taskId === 'shots' && bundle.shots!.assetPlan.needs.some(n => n.required && !bundle.shots!.assetPlan.uses.some(u => u.needId === n.needId));
      result.push({ taskId, status: unbound ? 'ready' : 'complete', reason: unbound ? 'required asset selection missing' : 'current output and consumed references valid' });
    } else {
      const ready = result.every(stage => stage.status === 'complete');
      result.push({ taskId, status: ready ? 'ready' : 'pending', reason: ready ? 'authorized planning output required' : 'required upstream planning output incomplete' });
    }
  }
  if (Object.hasOwn(bundle, 'timeline')) {
    const waiting = gate('timeline'), ready = result.every(s => s.status === 'complete');
    const conflicts = bundle.timeline ? compileProductionTimeline(bundle).conflicts.filter(c => c.severity === 'hard') : [];
    result.push({ taskId: 'timeline', status: invalidated.includes('timeline') || conflicts.length ? 'stale' : waiting ? 'waiting_user' : !ready ? 'pending' : bundle.timeline ? 'complete' : 'ready',
      reason: invalidated.includes('timeline') ? 'timeline invalidated' : conflicts.length ? JSON.stringify(conflicts) : waiting ?? (!ready ? 'required upstream output incomplete' : bundle.timeline ? 'current frame and sample timeline valid' : 'fixed takes and placements required') });
  }
  return result;
}
