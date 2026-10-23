import test from 'node:test';
import assert from 'node:assert/strict';
import { productionBundleFixture } from './fixtures/production.ts';
import type { ProductionDecision } from '../src/project/production.ts';
import type { Rights } from '../src/project/catalog.ts';
import { REVIEW_CHECK_IDS, deliveryApprovalHash, type DeliveryContext, type DeliveryCredits, type DeliveryRequest, type StructuredReview } from '../src/project/delivery.ts';
import { assertDeliverable, validateCredits, validateStructuredReview } from '../src/project/review-validation.ts';

const h = (digit: string) => digit.repeat(64);
const file = (path: string, sha256 = h('1')) => ({ path, bytes: 4, sha256 });
function fixture() {
  const asset = file('assets/original/fictional.mp4');
  const evidence = [file('evidence/fictional-observation.json')];
  const context: DeliveryContext = { subject: {
    artifact: { ...file('out/renders/fictional/final.mp4'), runId: 'run-fictional', artifactId: 'artifact-fictional', runtimeId: h('a'),
      runSha256: h('2'), attemptId: 'attempt-fictional', inputSnapshotSha256: h('3') },
    production: { revision: 2, bundle: file('production/revisions/fictional/bundle.json'), projection: file('production-spec.json') },
    renderEvidence: file('out/renders/fictional/production-render.json'),
    audio: { master: file('out/renders/fictional/audio/mix.wav'), sources: [{ file: file('assets/audio/voice.wav'), role: 'narration' }] },
    sources: [
      { sourceId: 'catalog-fictional/asset-fictional', file: asset, roles: ['video', 'original'], catalog: file('assets/catalogs/fictional/manifest.json') },
      { sourceId: 'take:line-one', file: file('assets/audio/voice.wav'), roles: ['narration'], catalog: null },
    ], durationFrames: 720, fps: 24,
  }, bundle: productionBundleFixture(), consumptionCoverage: 'partial', consumptionLimitations: ['Dynamic drawing IO coverage remains partial.'], catalogRights: [] };
  const catalog: Rights = { version: '0.1', id: 'rights-fictional', revision: 1, assetId: 'asset-fictional', assetVersion: 'asset-version-fictional', byteSha256: asset.sha256,
    status: 'documented', thirdPartyRightsStatus: 'documented', sourceRefs: [{ kind: 'license', ...evidence[0]!, statement: 'Fictional local-use license.' }],
    allowedUses: ['local-delivery'], restrictions: ['Local delivery only.'], attribution: 'Fictional footage — Fictional author', affectedStreams: [0, 1] };
  context.catalogRights = [{ sourceId: context.subject.sources[0]!.sourceId, rights: catalog }, { sourceId: 'take:line-one', rights: null }];
  const review: StructuredReview = { version: '0.1', kind: 'structured-review', reviewId: 'review-fictional', subject: structuredClone(context.subject), reviewer: 'Fictional reviewer', observedAt: '2020-01-01T00:00:00.000Z',
    observations: [
      { modality: 'audiovisual', method: 'normal-speed-playback', startFrame: 0, endFrame: 720, tool: 'Fictional observed playback', evidence },
      { modality: 'audio', method: 'actual-listening', startFrame: 0, endFrame: 720, tool: 'Fictional listening witness', evidence },
    ], references: [{ title: 'Fictional reference', url: 'https://example.invalid/reference', file: null, startSeconds: 1, endSeconds: 4,
      method: 'normal-speed-playback', evidence, mechanisms: ['A stable focus bridges a cut.'], appliedShots: ['shot-open'] }],
    checks: REVIEW_CHECK_IDS.map(checkId => ({ checkId, verdict: 'pass', reason: 'Fictional observed conclusion.', evidence })) };
  const credits: DeliveryCredits = { version: '0.1', kind: 'delivery-credits', creditsId: 'credits-fictional', subject: structuredClone(context.subject), scope: 'local-delivery',
    sources: context.subject.sources.map((source, i) => ({ sourceId: source.sourceId, file: structuredClone(source.file), status: i === 0 ? 'documented' : 'user-declared',
      thirdPartyRightsStatus: i === 0 ? 'documented' : 'user-declared', allowedUses: ['local-delivery'], restrictions: i === 0 ? ['Local delivery only.'] : [],
      restrictionAssessment: 'Reviewed for this local delivery.', requiredAttribution: i === 0 ? catalog.attribution : null, evidence })),
    attributionLines: [catalog.attribution!] };
  const request: DeliveryRequest = { version: '0.1', subject: structuredClone(context.subject), review: file('evidence/review.json'), credits: file('evidence/credits.json'), knownLimitations: [...context.consumptionLimitations], approvals: [] };
  return { context, review, credits, request };
}

test('current review and exact rights pass without mutating their observations', () => {
  const f = fixture(), before = structuredClone(f);
  assert.deepEqual(assertDeliverable(f.request, f.review, f.credits, f.context), { review: f.review, credits: f.credits });
  assert.deepEqual(f, before);
});

test('same-size replacement and all current subject dependencies invalidate old review and credits', () => {
  const changes = [
    (c: DeliveryContext) => { c.subject.artifact.sha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.artifact.runSha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.artifact.inputSnapshotSha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.production.revision++; },
    (c: DeliveryContext) => { c.subject.production.projection.sha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.production.bundle.sha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.audio.master!.sha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.audio.sources[0]!.file.sha256 = h('b'); },
    (c: DeliveryContext) => { c.subject.sources[1]!.file.sha256 = h('b'); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.context);
    assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_SUBJECT_STALE/);
    assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_SUBJECT_STALE/);
  }
});

test('an old request subject is refused even with current review and credits', () => {
  const f = fixture(); f.request.subject.production.revision--;
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_SUBJECT_STALE/);
});

test('all nine mandatory checks are present exactly once', () => {
  for (const change of [(r: StructuredReview) => r.checks.pop(), (r: StructuredReview) => { r.checks[8] = r.checks[0]!; }]) {
    const f = fixture(); change(f.review); assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_REVIEW_CHECKS_INCOMPLETE/);
  }
});

test('unresolved conclusions can be recorded and remain inadmissible for delivery', () => {
  for (const verdict of ['revise', 'blocked'] as const) {
    const f = fixture(); f.review.checks[1]!.verdict = verdict;
    assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
    assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_REVIEW_INCOMPLETE/);
  }
  const f = fixture(); f.review.checks[1]!.reason = ' ';
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_REVIEW_REASON_REQUIRED/);
});

test('an honestly blocked full-experience review is structurally valid without playback or listening', () => {
  const f = fixture(); f.review.observations = [];
  for (const c of f.review.checks) if (!['technical', 'rights'].includes(c.checkId)) { c.verdict = 'blocked'; c.reason = 'Actual full viewing and listening remain pending.'; }
  assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_REVIEW_INCOMPLETE/);
});

test('frame, signal and document evidence cannot replace normal-speed viewing', () => {
  for (const method of ['frame-inspection', 'signal-analysis', 'document-read'] as const) {
    const f = fixture(); f.review.observations[0]!.method = method;
    assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_FULL_VIEWING_REQUIRED/);
  }
});

test('playback and complete video observation cannot replace actual listening', () => {
  const f = fixture(); f.review.observations.pop();
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_ACTUAL_LISTENING_REQUIRED/);
  f.review.observations.push({ ...f.review.observations[0]!, modality: 'audio', method: 'signal-analysis' });
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_ACTUAL_LISTENING_REQUIRED/);
});

test('complete separate video and audio observations do not establish audiovisual sync', () => {
  const f = fixture(); f.review.observations[0]!.modality = 'video';
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_AUDIOVISUAL_VIEWING_REQUIRED/);
});

test('a one-frame gap in listening or viewing remains incomplete', () => {
  for (const index of [0, 1]) {
    const f = fixture(), o = f.review.observations[index]!;
    o.endFrame = 360; f.review.observations.push({ ...o, startFrame: 361, endFrame: 720 });
    assert.throws(() => validateStructuredReview(f.review, f.context), index === 0 ? /DELIVERY_FULL_VIEWING_REQUIRED/ : /DELIVERY_ACTUAL_LISTENING_REQUIRED/);
  }
});

test('adjacent and overlapping ranges of one modality and method cover the whole film', () => {
  for (const start of [350, 360]) {
    const f = fixture();
    for (const o of [...f.review.observations]) { o.endFrame = 360; f.review.observations.push({ ...o, startFrame: start, endFrame: 720 }); }
    f.review.observations.reverse(); assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  }
});

test('partial observations with different modalities cannot be combined into a full experience', () => {
  const f = fixture(); f.review.observations[0]!.endFrame = 360;
  f.review.observations.push({ ...f.review.observations[0]!, modality: 'video', startFrame: 360, endFrame: 720 });
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_FULL_VIEWING_REQUIRED/);
});

test('out-of-bounds and empty observation ranges are rejected', () => {
  for (const [startFrame, endFrame] of [[720, 720], [0, 721]]) {
    const f = fixture(); Object.assign(f.review.observations[0]!, { startFrame, endFrame });
    assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_OBSERVATION_RANGE_INVALID/);
  }
});

test('only absent master audio permits reasoned audio and sync not-applicable conclusions', () => {
  const f = fixture(); f.context.subject.audio.master = null;
  f.review.subject = structuredClone(f.context.subject); f.review.observations = [f.review.observations[0]!];
  for (const c of f.review.checks) if (['audibility', 'sync'].includes(c.checkId)) { c.verdict = 'not_applicable'; c.reason = 'The current film has no master audio.'; }
  assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  f.review.checks[1]!.verdict = 'not_applicable';
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_REVIEW_NOT_APPLICABLE_INVALID/);
  const g = fixture(); g.review.checks.find(c => c.checkId === 'audibility')!.verdict = 'not_applicable';
  assert.throws(() => validateStructuredReview(g.review, g.context), /DELIVERY_REVIEW_NOT_APPLICABLE_INVALID/);
});

test('reference range, actual viewing method, identity and current shot relationships are required', () => {
  const changes = [
    (r: StructuredReview) => { r.references[0]!.endSeconds = 1; },
    (r: StructuredReview) => { r.references[0]!.url = null; },
    (r: StructuredReview) => { r.references[0]!.method = 'player-ended'; },
    (r: StructuredReview) => { r.references[0]!.mechanisms = [' ']; },
    (r: StructuredReview) => { r.references[0]!.appliedShots = ['unknown-shot']; },
  ];
  for (const change of changes) { const f = fixture(); change(f.review); assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_REFERENCE_/); }
});

test('original work allows no external reference while incomplete viewing still blocks delivery', () => {
  const f = fixture(); f.review.references = [];
  f.review.checks.find(c => c.checkId === 'narrative')!.verdict = 'blocked';
  assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_REVIEW_INCOMPLETE/);
  f.review.checks.find(c => c.checkId === 'narrative')!.verdict = 'pass';
  assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  assert.doesNotThrow(() => assertDeliverable(f.request, f.review, f.credits, f.context));
});

test('frame-only reference inspection can be recorded and remains inadmissible for delivery', () => {
  const f = fixture(); f.review.references[0]!.method = 'frame-inspection';
  assert.doesNotThrow(() => validateStructuredReview(f.review, f.context));
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_REFERENCE_PLAYBACK_REQUIRED/);
});

test('missing, duplicate and same-size changed source rights are refused', () => {
  const changes = [
    (c: DeliveryCredits) => { c.sources.pop(); },
    (c: DeliveryCredits) => { c.sources[1] = structuredClone(c.sources[0]!); },
    (c: DeliveryCredits) => { c.sources[1]!.file.sha256 = h('b'); },
  ];
  for (const change of changes) { const f = fixture(); change(f.credits); assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_RIGHTS_SOURCE_/); }
});

test('unknown rights or third-party status, including a new sound, blocks delivery', () => {
  for (const key of ['status', 'thirdPartyRightsStatus'] as const) {
    const f = fixture(); f.credits.sources[1]![key] = 'unknown';
    assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_RIGHTS_UNKNOWN/);
  }
  const f = fixture(); f.context.subject.sources.push({ sourceId: 'take:new-sfx', file: file('assets/audio/new.wav'), roles: ['sfx'], catalog: null });
  f.credits.subject = structuredClone(f.context.subject);
  assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_RIGHTS_SOURCE_SET_INVALID/);
});

test('an allowed local use and a completed restriction assessment are required', () => {
  const f = fixture(); f.credits.sources[1]!.allowedUses = ['preview'];
  assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_RIGHTS_USE_REQUIRED/);
  for (const assessment of [' ', 'unknown', 'pending', 'unverified']) {
    const g = fixture(); g.credits.sources[1]!.restrictionAssessment = assessment;
    assert.throws(() => validateCredits(g.credits, g.context), /DELIVERY_RESTRICTION_ASSESSMENT_REQUIRED/);
  }
});

test('catalog rights are required and exact existing records constrain submitted claims', () => {
  const f = fixture(); f.context.catalogRights[0]!.rights = null;
  assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_CATALOG_RIGHTS_REQUIRED/);
  for (const change of [
    (r: Rights) => { r.byteSha256 = h('b'); },
    (r: Rights) => { r.status = 'user-declared'; },
    (r: Rights) => { r.allowedUses.push('publish'); },
    (r: Rights) => { r.restrictions = []; },
    (r: Rights) => { r.attribution = 'Changed attribution'; },
  ]) { const g = fixture(); change(g.context.catalogRights[0]!.rights!); assert.throws(() => validateCredits(g.credits, g.context), /DELIVERY_CATALOG_RIGHTS_MISMATCH/); }
});

test('attribution retains the required exact line', () => {
  const f = fixture(); f.credits.attributionLines = ['Credit: ' + f.credits.attributionLines[0]];
  assert.throws(() => validateCredits(f.credits, f.context), /DELIVERY_ATTRIBUTION_REQUIRED/);
});

test('partial consumption limitations must be carried into the request', () => {
  const f = fixture(); f.request.knownLimitations = [];
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CONSUMPTION_LIMITATIONS_REQUIRED/);
});

test('final and delivery approvals bind the exact current subjects and inherit revocation', () => {
  const f = fixture(); f.context.bundle.requirements.requested.approvalTasks = ['final', 'delivery'];
  const before = structuredClone(f.context.bundle);
  const base = f.context.bundle.decisions[0]!;
  const approval = (target: 'final' | 'delivery') => ({ ...base, decisionId: 'approval-' + target, kind: 'approval' as const,
    scope: { ...base.scope, action: 'approve', target }, subjectHash: deliveryApprovalHash(f.request, target) });
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: final/);
  const deliveryHash = deliveryApprovalHash(f.request, 'delivery');
  f.request.approvals.push(approval('final'));
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: delivery/);
  f.request.approvals.push(approval('delivery'));
  assert.equal(deliveryApprovalHash(f.request, 'delivery'), deliveryHash);
  assert.doesNotThrow(() => assertDeliverable(f.request, f.review, f.credits, f.context));
  assert.deepEqual(f.context.bundle, before);
  f.request.knownLimitations.push('New limitation.');
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: delivery/);
  f.request.knownLimitations.pop();
  f.request.approvals.push({ ...approval('final'), decisionId: 'revoke-final', kind: 'revoke', subjectHash: null, supersedes: 'approval-final' });
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: final/);
});

test('request approvals retain final and delivery scope with no provider, assets or spending', () => {
  const changes = [
    (d: ProductionDecision) => { d.kind = 'authorization'; },
    (d: ProductionDecision) => { d.actor = 'model'; },
    (d: ProductionDecision) => { d.sourcePrompt = null; },
    (d: ProductionDecision) => { d.scope.action = 'publish'; },
    (d: ProductionDecision) => { d.scope.target = 'publish'; },
    (d: ProductionDecision) => { d.scope.provider = 'external'; },
    (d: ProductionDecision) => { d.scope.maxCost = 1; },
    (d: ProductionDecision) => { d.scope.assetIds = ['external-asset']; },
  ];
  for (const change of changes) {
    const f = fixture(), base = f.context.bundle.decisions[0]!;
    const d: ProductionDecision = { ...structuredClone(base), decisionId: 'approval-final', kind: 'approval', scope: { ...base.scope, action: 'approve', target: 'final' }, subjectHash: deliveryApprovalHash(f.request, 'final') };
    change(d); f.request.approvals = [d];
    assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_APPROVAL_SCOPE_INVALID/);
  }
});

test('changed subject invalidates old independent approvals after review and credits are updated', () => {
  const f = fixture(), base = f.context.bundle.decisions[0]!;
  f.context.bundle.requirements.requested.approvalTasks = ['final'];
  f.request.approvals = [{ ...base, decisionId: 'approval-final', kind: 'approval', scope: { ...base.scope, action: 'approve', target: 'final' }, subjectHash: deliveryApprovalHash(f.request, 'final') }];
  f.context.subject.artifact.sha256 = h('b');
  f.request.subject = structuredClone(f.context.subject); f.review.subject = structuredClone(f.context.subject); f.credits.subject = structuredClone(f.context.subject);
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: final/);
});

test('independent revocation applies to a prior bundle approval and validates supersession', () => {
  const f = fixture(), base = f.context.bundle.decisions[0]!;
  f.context.bundle.requirements.requested.approvalTasks = ['final'];
  const approval: ProductionDecision = { ...base, decisionId: 'approval-final', kind: 'approval', scope: { ...base.scope, action: 'approve', target: 'final' }, subjectHash: deliveryApprovalHash(f.request, 'final') };
  f.context.bundle.decisions.push(approval);
  assert.doesNotThrow(() => assertDeliverable(f.request, f.review, f.credits, f.context));
  f.request.approvals.push({ ...approval, decisionId: 'revoke-final', kind: 'revoke', subjectHash: null, supersedes: 'approval-final' });
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /DELIVERY_CURRENT_APPROVAL_REQUIRED: final/);
  f.request.approvals[0]!.supersedes = 'missing';
  assert.throws(() => assertDeliverable(f.request, f.review, f.credits, f.context), /PRODUCTION_DECISION_FORWARD_REFERENCE/);
});

test('schema rejects undeclared and malformed review fields', () => {
  const f = fixture(); (f.review as any).pass = true;
  assert.throws(() => validateStructuredReview(f.review, f.context), /DELIVERY_REVIEW_INVALID/);
  const g = fixture(); g.review.subject.artifact.sha256 = 'old';
  assert.throws(() => validateStructuredReview(g.review, g.context), /DELIVERY_REVIEW_INVALID/);
});
