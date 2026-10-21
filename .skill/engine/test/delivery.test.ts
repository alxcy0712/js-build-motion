import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { deliverProject, verifyDelivery, type DeliveryHookState } from '../src/application/delivery.ts';
import { readDeliveryContext } from '../src/application/delivery-context.ts';
import { initializeProduction, applyProduction, readProduction } from '../src/application/production.ts';
import { compileProduction, assertProductionCurrent, productionMediaPaths } from '../src/application/production-compilation.ts';
import { beginRenderAttempt, commitRenderAttempt } from '../src/project/attempt.ts';
import { deliveryApprovalHash, REVIEW_CHECK_IDS, type DeliveryCredits, type DeliveryFile, type DeliveryManifest, type DeliveryRequest, type StructuredReview } from '../src/project/delivery.ts';
import { productionHash, type ProductionDecision } from '../src/project/production.ts';
import { loadProject } from '../src/project/manifest.ts';
import { timelineSourceHash } from '../src/project/production-timeline.ts';
import { buildFacts, buildMeasured, buildRunLog, repoRelative } from '../src/project/run-log.ts';
import { initProject } from '../src/project/scaffold.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { sha256File } from '../src/utils/hash.ts';
import { fixturePrompt, productionInitFixture, productionBundleFixture, productionProposalFixture } from './fixtures/production.ts';

const currentPath = (dir: string) => join(dir, 'out/deliveries/current.json');
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const identity = (dir: string, path: string): DeliveryFile => ({ path, bytes: lstatSync(join(dir, path)).size, sha256: sha256File(join(dir, path)) });

async function fixture(approvalTasks: ('final' | 'delivery')[] = []) {
  const out = resolve(PROJECT_ROOT, '.research/out'); mkdirSync(out, { recursive: true });
  const root = mkdtempSync(join(out, 'delivery-')), dir = initProject({ slug: 'fictional-delivery', projectsRoot: join(root, 'projects') }).dir;
  try {
    mkdirSync(join(dir, 'inputs'), { recursive: true }); mkdirSync(join(dir, '.engine/assets/fonts'), { recursive: true });
    writeFileSync(join(dir, '.engine/assets/fonts/fictional.ttf'), 'synthetic-font-byte-identity');
    json(join(dir, 'workspace.json'), { version: '0.2', packageId: 'a'.repeat(64) });
    writeFileSync(join(dir, 'prompt-history.jsonl'), JSON.stringify(fixturePrompt) + '\n');
    const init = productionInitFixture(); init.requested.approvalTasks = approvalTasks;
    const initial = await initializeProduction(dir, init), b = productionBundleFixture();
    const planned = await applyProduction(dir, productionProposalFixture(initial.state.revision, initial.bundle, { effective: null, script: b.script, shots: b.shots }));
    b.requirements = planned.bundle.requirements; b.script = planned.bundle.script; b.shots = planned.bundle.shots;
    b.timeline = { version: '0.1', sourceHash: timelineSourceHash(b), durationFrames: 900,
      shots: b.shots!.items.map((s, i) => ({ shotId: s.shotId, startFrame: i * 450, endFrame: (i + 1) * 450,
        camera: 'wide', cameraMove: 'static', transition: 'cut', composition: { backdrop: 'studio', motif: 'none', title: 'Fixture', bpm: 96, elements: [] } })),
      clips: [], takes: [], placements: [], readingGroups: [], captionCues: [],
      events: b.shots!.items.map((s, i) => ({ eventId: s.events[0]!.eventId, shotId: s.shotId, prepareFrame: i * 450,
        visibleFrame: i * 450 + 3, peakFrame: i * 450 + 6, completeFrame: i * 450 + 9, readingEndFrame: (i + 1) * 450 - 1, anchor: null })) };
    await applyProduction(dir, productionProposalFixture(planned.state.revision, planned.bundle, { effective: null, script: null, shots: null, timeline: b.timeline }));
    assert.equal((await compileProduction(dir, 'final')).ok, true);
    const project = loadProject(dir), spec = validateSpec(JSON.parse(readFileSync(project.specPath, 'utf8'))).spec!;
    const compiled = await assertProductionCurrent(dir, spec, 'final'), attempt = beginRenderAttempt(project, { mediaPaths: await productionMediaPaths(dir, compiled.current) });
    // Transaction fixtures bind synthetic byte identities; native and production checks use actual encoded media.
    const output = join(attempt.workDir, 'final.mp4'); writeFileSync(output, 'encoded-A');
    writeFileSync(join(attempt.workDir, project.slug + '.srt'), '1\n00:00:00,000 --> 00:00:01,000\nFixture\n');
    json(join(attempt.workDir, 'production-render.json'), { version: '0.1', kind: 'production-render-evidence', projection: compiled.projection,
      clips: compiled.compiled.clips, audioPlacements: compiled.compiled.audioPlacements, events: compiled.compiled.events,
      captionCues: compiled.compiled.captionCues, durationSamples: compiled.compiled.durationSamples, masterSha256: null, sources: [],
      observed: { encodedFrames: 900, voicePresence: [] } });
    const facts = { ...buildFacts({ video: { width: 1280, height: 720, fps: 30, duration: 30, frames: 900, seed: spec.video.seed },
      rendererKind: 'skia', rendererPackage: 'skia-canvas', rendererVersion: null,
      encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: null, crf: null, preset: null }, ffmpeg: { version: null, command: 'ffmpeg' },
      providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' }, captions: { insideFrame: false, cues: 0, wordLevel: false },
      runtime: { packageId: 'a'.repeat(64), platform: process.platform, arch: process.arch } }),
      fonts: [{ family: 'Fictional', path: 'assets/fonts/fictional.ttf', sha256: sha256File(join(dir, '.engine/assets/fonts/fictional.ttf')), registered: true }] };
    const log = { ...buildRunLog({ project: project.slug, specPath: project.specPath, specSha256: sha256File(attempt.snapshotProject.specPath),
      briefPath: project.briefPath, briefSha256: project.briefPath ? sha256File(attempt.snapshotProject.briefPath!) : null, facts,
      measured: buildMeasured({ renderMs: 1, msPerFrame: 1, encodeTailMs: 0, audioMixMs: null, outputBytes: lstatSync(output).size,
        outputSha256: sha256File(output), outputPath: repoRelative(join(attempt.outputDir, 'final.mp4')) }) }),
      execution: { attemptId: attempt.attemptId, inputSnapshotSha256: attempt.inputSnapshotSha256, coverage: 'partial' as const } };
    commitRenderAttempt(attempt, log, { technicalOk: true });
    const context = await readDeliveryContext(dir);
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'evidence/fixture.txt'), 'Synthetic regression evidence: no actual viewing, listening or rights clearance is claimed.\n');
    const evidence = identity(dir, 'evidence/fixture.txt');
    const review: StructuredReview = { version: '0.1', kind: 'structured-review', reviewId: 'review-fixture', subject: context.subject,
      reviewer: 'synthetic-transaction-fixture', observedAt: '2020-01-01T00:00:00.000Z',
      observations: [{ modality: 'video', method: 'normal-speed-playback', startFrame: 0, endFrame: 900, tool: 'fixture', evidence: [evidence] },
        { modality: 'technical', method: 'signal-analysis', startFrame: 0, endFrame: 900, tool: 'fixture', evidence: [evidence] },
        { modality: 'rights', method: 'document-read', startFrame: 0, endFrame: 900, tool: 'fixture', evidence: [evidence] }],
      references: [{ title: 'Fictional fixture reference', url: null, file: evidence, startSeconds: 0, endSeconds: 1,
        method: 'normal-speed-playback', evidence: [evidence], mechanisms: ['synthetic reference'], appliedShots: [b.shots!.items[0]!.shotId] }],
      checks: REVIEW_CHECK_IDS.map(checkId => ({ checkId, verdict: ['audibility', 'sync'].includes(checkId) ? 'not_applicable' : 'pass',
        reason: 'Identity-only silent transaction fixture.', evidence: [evidence] })) };
    const credits: DeliveryCredits = { version: '0.1', kind: 'delivery-credits', creditsId: 'credits-fixture', subject: context.subject, scope: 'local-delivery',
      sources: context.subject.sources.map(source => ({ sourceId: source.sourceId, file: source.file, status: 'documented', thirdPartyRightsStatus: 'documented',
        allowedUses: ['local-delivery'], restrictions: [], restrictionAssessment: 'Synthetic regression license.', requiredAttribution: 'Fictional font — fixture license', evidence: [evidence] })),
      attributionLines: ['Fictional font — fixture license'] };
    const request: DeliveryRequest = { version: '0.1', subject: context.subject, review: evidence, credits: evidence, knownLimitations: context.consumptionLimitations, approvals: [] };
    const update = () => {
      json(join(dir, 'evidence/review.json'), review); json(join(dir, 'evidence/credits.json'), credits);
      request.review = identity(dir, 'evidence/review.json'); request.credits = identity(dir, 'evidence/credits.json');
    };
    update();
    const decision = (target: 'final' | 'delivery', kind: 'approval' | 'revoke' = 'approval', supersedes: string | null = null): ProductionDecision => {
      const history = readFileSync(join(dir, 'prompt-history.jsonl'), 'utf8').split('\n').filter(Boolean);
      const entry = { timestamp: '2020-01-01T00:01:00.000Z', kind: 'answer', text: `Synthetic transaction fixture ${kind} ${target}.` };
      appendFileSync(join(dir, 'prompt-history.jsonl'), JSON.stringify(entry) + '\n');
      return { decisionId: `${kind}-${target}`, kind, actor: 'user', sourcePrompt: { entry: history.length, sha256: productionHash(entry) }, rawText: entry.text,
        scope: { action: 'approve', target, assetIds: [], provider: null, maxCost: 0 }, subjectHash: deliveryApprovalHash(request, target), supersedes };
    };
    return { root, dir, request, review, credits, context, update, decision, cleanup() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test('local delivery binds current authority, review, rights and independently copied files', async () => {
  const f = await fixture(); try {
    const result = await deliverProject(f.dir, f.request), verified = await verifyDelivery(f.dir);
    assert.equal(result.status, 'succeeded'); assert.equal(verified.deliveryId, result.deliveryId);
    assert.equal((await verifyDelivery(f.dir, result.deliveryId)).ok, true);
    const manifest = JSON.parse(readFileSync(join(f.dir, result.manifest.path), 'utf8')) as DeliveryManifest;
    assert.deepEqual(manifest.subject, f.request.subject); assert.deepEqual(manifest.sourceRights, f.credits.sources);
    assert.ok(manifest.files.some(file => file.path.endsWith('/captions.srt')));
    for (const file of manifest.files) { assert.equal(sha256File(join(f.dir, file.path)), file.sha256); assert.equal(lstatSync(join(f.dir, file.path)).nlink, 1); }
    const receipt = JSON.parse(readFileSync(join(f.dir, result.receipt.path), 'utf8'));
    assert.deepEqual(receipt.request, f.request); assert.equal(receipt.status, 'succeeded');
  } finally { f.cleanup(); }
});

test('final and delivery approval after rendering bind prompt evidence without changing production or encoded bytes', async () => {
  const f = await fixture(['final', 'delivery']); try {
    const paths = [f.request.subject.artifact.path, f.request.subject.production.bundle.path, f.request.subject.production.projection.path, 'run.json'];
    const before = paths.map(path => readFileSync(join(f.dir, path)));
    await assert.rejects(deliverProject(f.dir, f.request), /DELIVERY_CURRENT_APPROVAL_REQUIRED/);
    f.request.approvals = [f.decision('final'), f.decision('delivery')];
    const hash = deliveryApprovalHash(f.request, 'delivery');
    assert.equal(hash, deliveryApprovalHash({ ...f.request, approvals: [] }, 'delivery'));
    const result = await deliverProject(f.dir, f.request);
    assert.equal((await verifyDelivery(f.dir)).deliveryId, result.deliveryId);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, result.receipt.path), 'utf8')).request.approvals, f.request.approvals);
    assert.deepEqual(paths.map(path => readFileSync(join(f.dir, path))), before);
  } finally { f.cleanup(); }
});

test('forged approval prompt, old subject and an actual sourced revoke block the current request', async () => {
  const f = await fixture(['final', 'delivery']); try {
    f.request.approvals = [f.decision('final'), f.decision('delivery')];
    await deliverProject(f.dir, f.request); const current = readFileSync(currentPath(f.dir));
    const forged = structuredClone(f.request); forged.approvals[0]!.sourcePrompt!.sha256 = 'b'.repeat(64);
    await assert.rejects(deliverProject(f.dir, forged), /DELIVERY_APPROVAL_SOURCE_INVALID/);
    const old = structuredClone(f.request); old.approvals[0]!.subjectHash = 'b'.repeat(64);
    await assert.rejects(deliverProject(f.dir, old), /DELIVERY_CURRENT_APPROVAL_REQUIRED/);
    f.request.approvals.push(f.decision('final', 'revoke', 'approval-final'));
    await assert.rejects(deliverProject(f.dir, f.request), /DELIVERY_CURRENT_APPROVAL_REQUIRED/);
    assert.deepEqual(readFileSync(currentPath(f.dir)), current);
  } finally { f.cleanup(); }
});

test('same-size encoded replacement and stale review reject while preserving prior package and current', async () => {
  const f = await fixture(); try {
    const first = await deliverProject(f.dir, f.request), current = readFileSync(currentPath(f.dir)), artifact = join(f.dir, f.request.subject.artifact.path);
    const original = readFileSync(artifact); writeFileSync(artifact, 'encoded-B');
    await assert.rejects(deliverProject(f.dir, f.request), /DELIVERY_ARTIFACT_INVALID/);
    assert.deepEqual(readFileSync(currentPath(f.dir)), current);
    assert.equal(readFileSync(join(f.dir, first.path, 'artifact.mp4'), 'utf8'), 'encoded-A');
    writeFileSync(artifact, original); f.review.subject = structuredClone(f.review.subject); f.review.subject.artifact.sha256 = 'b'.repeat(64); f.update();
    await assert.rejects(deliverProject(f.dir, f.request), /BINDING|SUBJECT/);
    assert.deepEqual(readFileSync(currentPath(f.dir)), current);
  } finally { f.cleanup(); }
});

test('unknown source rights and missing required attribution block delivery', async () => {
  for (const cause of ['unknown', 'attribution'] as const) {
    const f = await fixture(); try {
      const original = readFileSync(join(f.dir, f.request.subject.artifact.path));
      if (cause === 'unknown') f.credits.sources[0]!.status = 'unknown'; else f.credits.attributionLines = [];
      f.update(); await assert.rejects(deliverProject(f.dir, f.request), /RIGHTS|ATTRIBUTION/);
      assert.equal(existsSync(currentPath(f.dir)), false); assert.deepEqual(readFileSync(join(f.dir, f.request.subject.artifact.path)), original);
    } finally { f.cleanup(); }
  }
});

test('missing whole-film normal-speed observation cannot pass a declared creative review', async () => {
  const f = await fixture(); try {
    f.review.observations = f.review.observations.filter(o => o.modality !== 'video'); f.update();
    await assert.rejects(deliverProject(f.dir, f.request), /DELIVERY_FULL_VIEWING_REQUIRED/);
    assert.equal(existsSync(currentPath(f.dir)), false);
  } finally { f.cleanup(); }
});

test('current projection changes expire delivery even when earlier copied bytes remain intact', async () => {
  const f = await fixture(); try {
    await deliverProject(f.dir, f.request); const current = readFileSync(currentPath(f.dir));
    const state = await readProduction(f.dir), timeline = structuredClone(state.bundle.timeline!); timeline.shots[0]!.composition.title = 'Changed';
    await applyProduction(f.dir, productionProposalFixture(state.state.revision, state.bundle, { effective: null, script: null, shots: null, timeline }));
    await assert.rejects(verifyDelivery(f.dir), /PRODUCTION_SPEC_STALE/);
    await assert.rejects(deliverProject(f.dir, f.request), /PRODUCTION_SPEC_STALE/);
    assert.deepEqual(readFileSync(currentPath(f.dir)), current);
  } finally { f.cleanup(); }
});

test('same-size delivered copy replacement and original review evidence changes fail reverification', async () => {
  for (const cause of ['copy', 'evidence', 'subtitle'] as const) {
    const f = await fixture(); try {
      const result = await deliverProject(f.dir, f.request);
      if (cause === 'copy') writeFileSync(join(f.dir, result.path, 'artifact.mp4'), 'encoded-B');
      else if (cause === 'evidence') writeFileSync(join(f.dir, 'evidence/fixture.txt'), 'Changed source evidence.');
      else writeFileSync(join(f.dir, f.request.subject.artifact.path.replace('final.mp4', 'fictional-delivery.srt')), 'Changed subtitle.');
      await assert.rejects(verifyDelivery(f.dir), /DELIVERY_FILE_CHANGED/);
    } finally { f.cleanup(); }
  }
});

test('copy, prepare and post-publication faults preserve old success and reject orphan versions', async () => {
  for (const stage of ['afterCopy', 'beforePublish', 'afterPublish'] as const) {
    const f = await fixture(); try {
      const first = await deliverProject(f.dir, f.request), current = readFileSync(currentPath(f.dir));
      let failed: DeliveryHookState | null = null;
      await assert.rejects(deliverProject(f.dir, f.request, { hooks: { [stage]: async state => { failed = state; throw Error('injected-' + stage); } } }), /injected/);
      assert.ok(failed); assert.deepEqual(readFileSync(currentPath(f.dir)), current);
      assert.equal((await verifyDelivery(f.dir)).deliveryId, first.deliveryId);
      await assert.rejects(verifyDelivery(f.dir, failed!.deliveryId), /DELIVERY_NOT_COMMITTED/);
      const receipt = JSON.parse(readFileSync(join(f.dir, 'runs', failed!.attemptId, 'receipt.json'), 'utf8'));
      assert.equal(receipt.status, 'failed'); assert.equal(receipt.error, 'injected-' + stage);
      assert.equal(existsSync(join(f.dir, 'out/deliveries', failed!.deliveryId)), stage === 'afterPublish');
      const next = await deliverProject(f.dir, f.request); assert.notEqual(next.deliveryId, first.deliveryId); assert.notEqual(next.deliveryId, failed!.deliveryId);
      assert.equal((await verifyDelivery(f.dir)).deliveryId, next.deliveryId);
    } finally { f.cleanup(); }
  }
});

test('source or delivery current changes during copying reject instead of replacing intervening bytes', async () => {
  for (const cause of ['source', 'current'] as const) {
    const f = await fixture(); try {
      await deliverProject(f.dir, f.request); const current = readFileSync(currentPath(f.dir));
      await assert.rejects(deliverProject(f.dir, f.request, { hooks: { afterCopy: async () => {
        if (cause === 'source') writeFileSync(join(f.dir, 'evidence/fixture.txt'), 'Changed during copying.');
        else writeFileSync(currentPath(f.dir), Buffer.concat([current, Buffer.from('\n')]));
      } } }), /DELIVERY_FILE_CHANGED|DELIVERY_CURRENT_CHANGED/);
      assert.deepEqual(readFileSync(currentPath(f.dir)), cause === 'source' ? current : Buffer.concat([current, Buffer.from('\n')]));
    } finally { f.cleanup(); }
  }
});

test('current publication failure preserves immutable successful receipt and permits explicit version verification', async () => {
  const f = await fixture(); try {
    const first = await deliverProject(f.dir, f.request), current = readFileSync(currentPath(f.dir));
    let staged: DeliveryHookState | null = null, succeeded: Buffer | null = null;
    await assert.rejects(deliverProject(f.dir, f.request, { hooks: { beforeCurrent: async state => {
      staged = state; succeeded = readFileSync(join(f.dir, 'runs', state.attemptId, 'receipt.json')); throw Error('injected-current-publication');
    } } }), /injected-current-publication/);
    assert.ok(staged); assert.ok(succeeded); assert.deepEqual(readFileSync(currentPath(f.dir)), current);
    assert.deepEqual(readFileSync(join(f.dir, 'runs', staged!.attemptId, 'receipt.json')), succeeded);
    assert.equal(JSON.parse(succeeded!.toString('utf8')).status, 'succeeded');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'runs', staged!.attemptId, 'error.json'), 'utf8')).error, 'injected-current-publication');
    assert.equal((await verifyDelivery(f.dir)).deliveryId, first.deliveryId);
    assert.equal((await verifyDelivery(f.dir, staged!.deliveryId)).deliveryId, staged!.deliveryId);
  } finally { f.cleanup(); }
});

test('post-receipt copy, evidence and run changes block current while retaining the successful receipt bytes', async () => {
  for (const cause of ['copy', 'evidence', 'run'] as const) {
    const f = await fixture(); try {
      const first = await deliverProject(f.dir, f.request), current = readFileSync(currentPath(f.dir));
      let staged: DeliveryHookState | null = null, succeeded: Buffer | null = null;
      const source = cause === 'run' ? join(f.dir, 'run.json') : join(f.dir, 'evidence/fixture.txt'), original = readFileSync(source);
      const rejection = cause === 'run' ? /DELIVERY_SUBJECT_STALE/ : /DELIVERY_FILE_CHANGED/;
      await assert.rejects(deliverProject(f.dir, f.request, { hooks: { beforeCurrent: async state => {
        staged = state; succeeded = readFileSync(join(f.dir, 'runs', state.attemptId, 'receipt.json'));
        if (cause === 'copy') writeFileSync(join(f.dir, 'out/deliveries', state.deliveryId, 'artifact.mp4'), 'encoded-B');
        else if (cause === 'run') writeFileSync(source, Buffer.concat([original, Buffer.from('\n')]));
        else writeFileSync(source, 'Changed final publication evidence.');
      } } }), rejection);
      assert.ok(staged); assert.ok(succeeded); assert.deepEqual(readFileSync(currentPath(f.dir)), current);
      assert.deepEqual(readFileSync(join(f.dir, 'runs', staged!.attemptId, 'receipt.json')), succeeded);
      assert.equal(JSON.parse(succeeded!.toString('utf8')).status, 'succeeded');
      assert.equal(existsSync(join(f.dir, 'runs', staged!.attemptId, 'error.json')), true);
      await assert.rejects(verifyDelivery(f.dir, staged!.deliveryId), rejection);
      if (cause !== 'copy') writeFileSync(source, original);
      assert.equal((await verifyDelivery(f.dir)).deliveryId, first.deliveryId);
    } finally { f.cleanup(); }
  }
});

test('abort retains last success; unsafe refs and symlink outputs fail ordinary-file admission', async () => {
  const f = await fixture(); try {
    await deliverProject(f.dir, f.request); const current = readFileSync(currentPath(f.dir)), controller = new AbortController();
    await assert.rejects(deliverProject(f.dir, f.request, { signal: controller.signal, hooks: { afterCopy: async () => controller.abort(Error('fixture-abort')) } }), /fixture-abort/);
    assert.deepEqual(readFileSync(currentPath(f.dir)), current);
    const invalid = structuredClone(f.request); invalid.review.path = '../outside.json';
    await assert.rejects(deliverProject(f.dir, invalid), /DELIVERY_REQUEST_INVALID/);
    const result = await deliverProject(f.dir, f.request), copy = join(f.dir, result.path, 'artifact.mp4');
    rmSync(copy); symlinkSync(join(f.dir, f.request.subject.artifact.path), copy);
    await assert.rejects(verifyDelivery(f.dir), error => (error as { code?: string }).code === 'PROJECT_ISOLATION_VIOLATION');
    await assert.rejects(verifyDelivery(f.dir, 'delivery-' + randomUUID() + '/escape'), /DELIVERY_ID_INVALID/);
    assert.equal(readdirSync(join(f.dir, 'out/.tmp')).some(name => name.startsWith('delivery-attempt-')), false);
  } finally { f.cleanup(); }
});
