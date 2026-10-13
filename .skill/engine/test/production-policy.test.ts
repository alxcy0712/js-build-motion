import test from 'node:test';
import assert from 'node:assert/strict';
import { productionBundleFixture } from './fixtures/production.ts';
import { productionHash, scriptSourceHash, shotsSourceHash, type ProductionBundle, type ProductionDecision } from '../src/project/production.ts';
import { applicableDecisions, authorizeProduction, approvalSatisfied, assertProductionRequirements, productionAffected, productionStages } from '../src/project/production-policy.ts';

function decision(kind: ProductionDecision['kind'], target: string, changes: Partial<ProductionDecision> = {}): ProductionDecision {
  const original = productionBundleFixture().decisions[0]!;
  return { ...original, decisionId: 'decision-' + kind, kind, scope: { ...original.scope, action: kind === 'approval' ? 'approve' : 'ask', target }, ...changes };
}
function statuses(b: ProductionBundle) { return Object.fromEntries(productionStages(b).map(s => [s.taskId, s.status])); }
function videoInput(b: ProductionBundle) {
  const uuid = '00000000-0000-4000-8000-000000000001';
  const input = { inputId: 'input-video', role: 'video' as const, text: null, file: { path: 'inputs/original/fictional.mp4', bytes: 8, sha256: '1'.repeat(64) },
    catalog: { catalogId: 'catalog-' + uuid, manifestSha256: '2'.repeat(64), assetId: 'asset-' + uuid, assetVersion: 'asset-version-' + uuid } };
  b.requirements.requested.inputs.push(input); return input;
}

test('local delegation covers the three planning targets and successful outputs remain complete', () => {
  const b = productionBundleFixture(), before = structuredClone(b);
  for (const target of ['requirements', 'script', 'shots']) authorizeProduction(b, 'plan', target);
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'complete' });
  assert.deepEqual(b, before);
  b.script = null; b.shots = null;
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'ready', shots: 'pending' });
  for (const args of [ ['publish', 'delivery', {}], ['plan', 'shots', { provider: 'external' }], ['plan', 'shots', { assetIds: ['input-title'] }], ['plan', 'shots', { cost: 1 }] ] as const) {
    assert.throws(() => authorizeProduction(before, args[0], args[1], args[2] as any), /PRODUCTION_AUTHORIZATION_REQUIRED/);
  }
});

test('external action, target, provider, asset membership and cost cap all constrain a grant', () => {
  const b = productionBundleFixture();
  b.decisions.push(decision('authorization', 'assets', { decisionId: 'authorization-external', scope: {
    action: 'generate', target: 'assets', assetIds: ['input-title', 'input-second'], provider: 'fictional-provider', maxCost: 2 } }));
  const request = { assetIds: ['input-title'], provider: 'fictional-provider', cost: 1 };
  authorizeProduction(b, 'generate', 'assets', request);
  for (const [action, target, details] of [ ['upload', 'assets', request], ['generate', 'delivery', request],
    ['generate', 'assets', { ...request, provider: 'other' }], ['generate', 'assets', { ...request, assetIds: ['unknown'] }],
    ['generate', 'assets', { ...request, cost: 3 }] ] as const) assert.throws(() => authorizeProduction(b, action, target, details as any), /PRODUCTION_AUTHORIZATION_REQUIRED/);
  for (const cost of [-1, NaN, Infinity]) assert.throws(() => authorizeProduction(b, 'generate', 'assets', { ...request, cost }), /PRODUCTION_AUTHORIZATION_REQUEST_INVALID/);
  b.decisions.push(decision('revoke', 'assets', { supersedes: 'authorization-external' }));
  assert.throws(() => authorizeProduction(b, 'generate', 'assets', request), /PRODUCTION_AUTHORIZATION_REQUIRED/);
});

test('only authentic-user decision kinds grant, approve, revoke and answer; model records cannot replace grants', () => {
  for (const kind of ['authorization', 'approval', 'revoke', 'answer'] as const) for (const invalid of [{ actor: 'model' as const }, { sourcePrompt: null }]) {
    const b = productionBundleFixture(); b.decisions.push(decision(kind, 'script', invalid));
    assert.throws(() => applicableDecisions(b), /PRODUCTION_DECISION_USER_SOURCE_REQUIRED/);
  }
  const b = productionBundleFixture();
  b.decisions = [decision('choice', 'project', { actor: 'model', sourcePrompt: null, scope: { action: 'plan', target: 'project', assetIds: [], provider: null, maxCost: 0 } })];
  assert.throws(() => authorizeProduction(b, 'plan', 'script'), /PRODUCTION_AUTHORIZATION_REQUIRED/);
  b.decisions = productionBundleFixture().decisions;
  b.decisions.push(decision('question', 'project', { actor: 'model', sourcePrompt: null, supersedes: 'authorization-local' }));
  assert.throws(() => applicableDecisions(b), /PRODUCTION_DECISION_SUPERSESSION_KIND/);
});

test('superseded decisions stay audit history and revoked grants never revive', () => {
  const b = productionBundleFixture(), old = b.decisions[0]!;
  b.decisions.push({ ...old, decisionId: 'authorization-new', supersedes: old.decisionId });
  assert.deepEqual(applicableDecisions(b).map(d => d.decisionId), ['authorization-new']);
  b.decisions.push(decision('revoke', 'project', { supersedes: 'authorization-new' }));
  assert.deepEqual(applicableDecisions(b).map(d => d.decisionId), ['decision-revoke']);
  assert.throws(() => authorizeProduction(b, 'plan', 'script'), /PRODUCTION_AUTHORIZATION_REQUIRED/);
  assert.equal(b.decisions.length, 3);
});

test('specified approval binds the exact current document hash and action', () => {
  const b = productionBundleFixture(); b.requirements.requested.approvalTasks = ['script'];
  b.script!.sourceHash = scriptSourceHash(b); b.shots!.sourceHash = shotsSourceHash(b);
  const hash = productionHash(b.script);
  assert.equal(statuses(b).script, 'waiting_user');
  b.decisions.push(decision('approval', 'script', { subjectHash: hash }));
  assert.equal(approvalSatisfied(b, 'script', hash), true);
  assert.equal(statuses(b).script, 'complete');
  b.script!.lines[0]!.text += '新一句';
  assert.equal(approvalSatisfied(b, 'script', productionHash(b.script)), false);
  assert.equal(statuses(b).script, 'waiting_user');
  b.decisions[1]!.scope.action = 'publish';
  assert.equal(approvalSatisfied(b, 'script', hash), false);
});

test('scoped questions affect their target while unrelated planning can proceed', () => {
  const b = productionBundleFixture();
  b.decisions.push(decision('question', 'shots', { actor: 'model', sourcePrompt: null }));
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'waiting_user' });
  b.decisions.push(decision('answer', 'shots', { supersedes: 'decision-question' }));
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'complete' });
  b.decisions.push(decision('question', 'delivery', { decisionId: 'question-delivery', actor: 'model', sourcePrompt: null }));
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'complete' });
});

test('requested hard targets remain intact and actual effective profiles must satisfy them', () => {
  const cases: ((b: ProductionBundle) => void)[] = [ b => { b.requirements.effective.durationSeconds = 20; },
    b => { b.requirements.requested.hardTargets.aspect = '9:16'; }, b => { b.requirements.requested.hardTargets.fps = 24; },
    b => { b.requirements.requested.hardTargets.minWidth = 1920; }, b => { b.requirements.requested.hardTargets.minHeight = 1080; },
    b => { b.requirements.effective.originalAudio = 'mute'; }, b => { b.requirements.effective.preview.width = 319; } ];
  for (const change of cases) {
    const b = productionBundleFixture(); change(b); const requested = structuredClone(b.requirements.requested);
    assert.throws(() => assertProductionRequirements(b), /PRODUCTION_(HARD_TARGET|ASPECT)_CONFLICT/);
    assert.equal(statuses(b).requirements, 'stale'); assert.deepEqual(b.requirements.requested, requested);
  }
});

test('video defaults to original audio and a sourced explicit mute decision permits a mute choice', () => {
  const b = productionBundleFixture(); videoInput(b); b.requirements.requested.originalAudio = null;
  assert.doesNotThrow(() => assertProductionRequirements(b));
  b.requirements.effective.originalAudio = 'mute';
  assert.throws(() => assertProductionRequirements(b), /PRODUCTION_ORIGINAL_AUDIO_INTENT_REQUIRED/);
  b.decisions.push(decision('choice', 'requirements', { sourcePrompt: { entry: 1, sha256: productionHash({ text: '明确静音' }) }, rawText: '明确静音',
    scope: { action: 'mute', target: 'requirements', assetIds: [], provider: null, maxCost: 0 } }));
  assert.doesNotThrow(() => assertProductionRequirements(b));
  b.requirements.requested.originalAudio = 'preserve';
  assert.throws(() => assertProductionRequirements(b), /PRODUCTION_HARD_TARGET_CONFLICT: originalAudio/);
});

test('invalidation follows only actual input, line and shot consumers and rejects unknown selectors', () => {
  const b = productionBundleFixture(); b.requirements.requested.inputs.push({ inputId: 'input-unused', role: 'title', text: '未使用备选', file: null, catalog: null });
  assert.deepEqual(productionAffected(b, ['input:input-unused']), []);
  b.invalidations.push({ key: 'input:input-unused', reason: '复查未使用输入' });
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'complete' });
  assert.deepEqual(productionAffected(b, ['input:input-title']), ['script', 'shots']);
  assert.deepEqual(productionAffected(b, ['shot:shot-open']), ['shots']);
  b.shots!.items = [b.shots!.items[0]!]; b.shots!.sourceHash = shotsSourceHash(b);
  assert.deepEqual(productionAffected(b, ['line:line-detail']), ['script']);
  b.invalidations.push({ key: 'line:line-detail', reason: '改写未被镜头消费的行' });
  assert.equal(statuses(b).script, 'stale'); assert.equal(statuses(b).shots, 'complete');
  for (const key of ['unknown', 'input:missing', 'line:missing', 'shot:missing', 'shot:shot-open:extra', 'input:']) assert.throws(() => productionAffected(b, [key]), /PRODUCTION_INVALIDATION_SELECTOR/);
});

test('asset consumption alone invalidates shots and required unbound asset needs keep the task ready', () => {
  const b = productionBundleFixture(), input = videoInput(b), c = input.catalog;
  b.shots!.assetPlan.needs.push({ needId: 'need-video', shotId: 'shot-open', purpose: '展示路径', required: true,
    content: { action: null, view: null, identity: null }, constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null });
  b.shots!.sourceHash = shotsSourceHash(b);
  assert.equal(statuses(b).shots, 'ready');
  b.shots!.assetPlan.uses.push({ useId: 'use-video', needId: 'need-video', shotId: 'shot-open', role: 'visual', catalogId: c.catalogId,
    catalogManifestSha256: c.manifestSha256, assetId: c.assetId, assetVersion: c.assetVersion, byteSha256: input.file.sha256,
    selection: { kind: 'source' }, sourceRange: null, crop: null, fit: 'contain', mute: false });
  b.shots!.sourceHash = shotsSourceHash(b);
  assert.deepEqual(productionAffected(b, ['input:input-video']), ['shots']); assert.equal(statuses(b).shots, 'complete');
});

test('source freshness detects changed consumed configuration and current markers require atomic repair', () => {
  const b = productionBundleFixture(); b.requirements.effective.style = '温暖手绘';
  assert.equal(statuses(b).script, 'stale'); assert.equal(statuses(b).shots, 'stale');
  b.script!.sourceHash = scriptSourceHash(b); b.shots!.sourceHash = shotsSourceHash(b);
  b.invalidations.push({ key: 'line:line-open', reason: '重新确认解释' });
  const history = structuredClone(b);
  b.script!.sourceHash = scriptSourceHash(b);
  assert.equal(statuses(b).script, 'stale'); assert.equal(statuses(b).shots, 'stale');
  b.invalidations = [];
  assert.deepEqual(statuses(b), { requirements: 'complete', script: 'complete', shots: 'complete' });
  assert.equal(history.invalidations.length, 1);
});
