import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { initProject } from '../src/project/scaffold.ts';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, verifyCatalog } from '../src/application/catalog.ts';
import { DEFAULT_INSPECT_POLICY } from '../src/project/catalog.ts';
import { productionHash, scriptSourceHash, shotsSourceHash } from '../src/project/production.ts';
import { initializeProduction, readProduction, productionNext, applyProduction, resumeProduction, invalidateProduction, writeProductionView } from '../src/application/production.ts';
import { fixturePrompt, productionInitFixture, productionBundleFixture, productionProposalFixture } from './fixtures/production.ts';
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(out, { recursive: true });
  const root = realpathSync(mkdtempSync(join(out, 'production-'))), dir = initProject({ slug: 'fictional-production', projectsRoot: join(root, 'projects') }).dir;
  mkdirSync(join(dir, 'inputs'), { recursive: true });
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ version: '0.2', packageId: process.env.JBM_RUNTIME_ID ?? 'a'.repeat(64) }));
  writeFileSync(join(dir, 'prompt-history.jsonl'), JSON.stringify(fixturePrompt) + '\n');
  return { root, dir, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
async function scripted(dir: string) {
  const initial = await initializeProduction(dir, productionInitFixture()), b = productionBundleFixture();
  return await applyProduction(dir, productionProposalFixture(initial.state.revision, initial.bundle, { effective: null, script: b.script, shots: b.shots }));
}
function attempts(dir: string) { return readdirSync(join(dir, 'runs')).filter(n => n.startsWith('production-attempt-')).map(n => json(join(dir, 'runs', n, 'receipt.json'))); }

test('production opt-in, immutable requested, stable references and two old revision CAS', async () => {
  const f = fixture(); try {
    assert.equal(existsSync(join(f.dir, 'production/manifest.json')), false);
    await assert.rejects(readProduction(f.dir), /ENOENT/);
    const initial = await initializeProduction(f.dir, productionInitFixture()), b = productionBundleFixture(), requested = structuredClone(initial.bundle.requirements.requested);
    const first = productionProposalFixture(1, initial.bundle, { effective: null, script: b.script, shots: b.shots });
    const second = structuredClone(first), saved = await applyProduction(f.dir, first);
    assert.deepEqual(saved.bundle.requirements.requested, requested); assert.equal(saved.state.revision, 2);
    assert.equal(saved.bundle.script!.lines[0]!.lineId, 'line-open'); assert.equal(saved.bundle.shots!.items[0]!.events[0]!.lineRef, 'line-open');
    await assert.rejects(applyProduction(f.dir, second), /PRODUCTION_REVISION_CONFLICT/);
    await assert.rejects(applyProduction(f.dir, { ...productionProposalFixture(2, saved.bundle, { effective: null, script: null, shots: null }), requested: {} }), /PRODUCTION_PROPOSAL_INVALID/);
    const old = json(join(f.dir, initial.state.bundle.path)); assert.deepEqual(old, initial.bundle);
    const next = await productionNext(f.dir); assert.equal(next.revision, 2); assert.equal(next.sourceHash, productionHash(saved.bundle));
    assert.equal(next.stages.find(s => s.taskId === 'script')!.status, 'complete');
    assert.equal(attempts(f.dir).filter(a => a.status === 'succeeded').length, 2);
    await assert.rejects(initializeProduction(f.dir, productionInitFixture()), /PRODUCTION_ALREADY_INITIALIZED/);
  } finally { f.cleanup(); }
});

test('production input source, requested hard target, decision origin and complete check identity', async () => {
  const f = fixture(); try {
    const invalid = productionInitFixture(); invalid.requested.rawPrompt += ' edited';
    await assert.rejects(initializeProduction(f.dir, invalid), /PRODUCTION_PROMPT_SOURCE_INVALID/);
    const question = { timestamp: '2020-01-01T00:00:01.000Z', kind: 'question', text: '允许付费外发吗？' };
    writeFileSync(join(f.dir, 'prompt-history.jsonl'), JSON.stringify(fixturePrompt) + '\n' + JSON.stringify(question) + '\n');
    const forged = productionInitFixture(); forged.decisions[0]!.sourcePrompt = { entry: 1, sha256: productionHash(question) }; forged.decisions[0]!.rawText = question.text;
    await assert.rejects(initializeProduction(f.dir, forged), /PRODUCTION_PROMPT_SOURCE_INVALID/);
    const attached = productionInitFixture(); attached.decisions[0]!.sourcePrompt = null;
    await assert.rejects(initializeProduction(f.dir, attached), /PRODUCTION_USER_SOURCE_REQUIRED/);
    const initial = await initializeProduction(f.dir, productionInitFixture()), mismatch = { ...initial.bundle.requirements.effective, durationSeconds: 31 };
    await assert.rejects(applyProduction(f.dir, productionProposalFixture(1, initial.bundle, { effective: mismatch, script: null, shots: null })), /PRODUCTION_REQUESTED|PRODUCTION_REQUIREMENTS|PRODUCTION_HARD_TARGET/);
    assert.equal((await readProduction(f.dir)).state.revision, 1);
    const manifest = json(join(f.dir, 'production/manifest.json')); manifest.requiredChecks.pop(); writeFileSync(join(f.dir, 'production/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(readProduction(f.dir), /PRODUCTION_REQUIRED_CHECK_MISSING/);
    manifest.requiredChecks.push('unknown.check'); writeFileSync(join(f.dir, 'production/manifest.json'), JSON.stringify(manifest));
    await assert.rejects(readProduction(f.dir), /PRODUCTION_UNKNOWN_CHECK/);
  } finally { f.cleanup(); }
});

test('production stale Markdown conflicts and edited raw patch remains in its immutable commit', async () => {
  const f = fixture(); try {
    const saved = await scripted(f.dir), view = join(f.dir, 'production/plan.md'), original = readFileSync(view, 'utf8');
    writeFileSync(view, original.replace('revision=2', 'revision=1'));
    const p = productionProposalFixture(2, saved.bundle, { effective: null, script: null, shots: null });
    await assert.rejects(applyProduction(f.dir, p), /PRODUCTION_VIEW|PRODUCTION_REVISION/);
    await assert.rejects(writeProductionView(f.dir, 1, productionHash(saved.bundle)), /PRODUCTION_REVISION_CONFLICT/);
    await assert.rejects(writeProductionView(f.dir, 2, productionHash(saved.bundle)), /PRODUCTION_VIEW/);
    writeFileSync(view, original); await writeProductionView(f.dir, 2, productionHash(saved.bundle));
    const edited = readFileSync(view, 'utf8') + '\n用户手工修订：开场更慢。\n'; writeFileSync(view, edited);
    await assert.rejects(applyProduction(f.dir, p), /PRODUCTION_VIEW_PATCH_CONFLICT/);
    await assert.rejects(writeProductionView(f.dir, 2, productionHash(saved.bundle)), /PRODUCTION_VIEW_PATCH_CONFLICT/);
    assert.equal(readFileSync(view, 'utf8'), edited);
    p.rawText = '开场更慢。'; p.expectedViewHash = hash(edited);
    const current = await applyProduction(f.dir, p), receipt = json(join(f.dir, current.state.receipt.path));
    assert.equal(receipt.rawText, p.rawText); assert.equal(receipt.viewPatch, edited);
    assert.match(readFileSync(view, 'utf8'), /revision=3/);
  } finally { f.cleanup(); }
});

test('production actual dependency changes leave unaffected outputs and stale consumed outputs explicit', async () => {
  const f = fixture(); try {
    const saved = await scripted(f.dir), effective = { ...saved.bundle.requirements.effective, preview: { width: 640, height: 360 } },
      updated = await applyProduction(f.dir, productionProposalFixture(2, saved.bundle, { effective, script: null, shots: null }));
    assert.equal(updated.bundle.script!.sourceHash, saved.bundle.script!.sourceHash);
    assert.equal(updated.bundle.script!.sourceHash, scriptSourceHash(updated.bundle));
    assert.equal(updated.bundle.shots!.sourceHash, saved.bundle.shots!.sourceHash);
    assert.notEqual(updated.bundle.shots!.sourceHash, shotsSourceHash(updated.bundle));
    assert.equal((await productionNext(f.dir)).stages.find(s => s.taskId === 'script')!.status, 'complete');
    assert.equal((await productionNext(f.dir)).stages.find(s => s.taskId === 'shots')!.status, 'stale');
    const invalidated = await invalidateProduction(f.dir, 3, productionHash(updated.bundle), [{ key: 'line:line-open', reason: '开场旁白待修订' }]);
    assert.deepEqual(invalidated.bundle.invalidations.at(-1), { key: 'line:line-open', reason: '开场旁白待修订' });
    await assert.rejects(invalidateProduction(f.dir, 4, productionHash(invalidated.bundle), [{ key: 'unknown', reason: '未登记' }]), /PRODUCTION_INVALIDATION/);
    const partial = await applyProduction(f.dir, productionProposalFixture(4, invalidated.bundle, { effective: null, script: invalidated.bundle.script, shots: null }));
    assert.equal(partial.bundle.invalidations.length, 1); assert.equal((await productionNext(f.dir)).stages.find(s => s.taskId === 'script')!.status, 'stale');
    const repaired = await applyProduction(f.dir, productionProposalFixture(5, partial.bundle, { effective: null, script: partial.bundle.script, shots: partial.bundle.shots }));
    assert.deepEqual(repaired.bundle.invalidations, []); assert.equal((await productionNext(f.dir)).stages.find(s => s.taskId === 'shots')!.status, 'complete');
    assert.equal(json(join(f.dir, invalidated.state.bundle.path)).invalidations.length, 1);
  } finally { f.cleanup(); }
});

for (const phase of ['afterPrepared', 'afterPublished', 'afterReceipt'] as const) test(`production ${phase} interruption preserves prior success and resume converges once`, async () => {
  const f = fixture(); try {
    const saved = await scripted(f.dir), script = structuredClone(saved.bundle.script!); script.lines[0]!.text += '慢慢走。';
    const p = productionProposalFixture(2, saved.bundle, { effective: null, script, shots: null });
    await assert.rejects(applyProduction(f.dir, p, { hooks: { [phase]: async () => { throw Error('simulated stop'); } } }), /simulated stop/);
    assert.equal((await readProduction(f.dir)).state.revision, 2);
    const before = attempts(f.dir).find(a => a.status === 'prepared')!; assert.ok(before);
    const resumed = await resumeProduction(f.dir), result = resumed.recovered.find(a => a.attemptId === before.attemptId)!;
    assert.equal(result.status, phase === 'afterReceipt' ? 'succeeded' : 'interrupted');
    assert.equal(resumed.current!.state.revision, phase === 'afterReceipt' ? 3 : 2);
    const count = attempts(f.dir).filter(a => a.status === 'succeeded').length;
    assert.deepEqual((await resumeProduction(f.dir)).recovered, []); assert.equal(attempts(f.dir).filter(a => a.status === 'succeeded').length, count);
    assert.deepEqual(json(join(f.dir, saved.state.bundle.path)), saved.bundle);
  } finally { f.cleanup(); }
});

test('production a terminal stale CAS candidate cannot recover over another successful commit', async () => {
  const f = fixture(); try {
    const base = await scripted(f.dir), baseView = readFileSync(join(f.dir, 'production/plan.md')), p = productionProposalFixture(2, base.bundle, { effective: null, script: null, shots: null }),
      concurrent = await applyProduction(f.dir, p), successfulReceipts = attempts(f.dir).filter(a => a.status === 'succeeded').length;
    writeFileSync(join(f.dir, 'production/state.json'), JSON.stringify(base.state)); writeFileSync(join(f.dir, 'production/plan.md'), baseView);
    await assert.rejects(applyProduction(f.dir, p, { hooks: { afterReceipt: async () => {
      writeFileSync(join(f.dir, 'production/state.json'), JSON.stringify(concurrent.state));
    } } }), /PRODUCTION_REVISION_CONFLICT/);
    const failed = attempts(f.dir).find(a => a.status === 'failed')!; assert.ok(failed.result);
    assert.equal((await resumeProduction(f.dir)).current!.state.receipt.sha256, concurrent.state.receipt.sha256);
    assert.equal(attempts(f.dir).filter(a => a.status === 'succeeded').length, successfulReceipts);
  } finally { f.cleanup(); }
});

test('production edited candidate, unlisted outputs, links and dead/live leases protect state', async () => {
  const f = fixture(); try {
    const saved = await scripted(f.dir), p = productionProposalFixture(2, saved.bundle, { effective: null, script: null, shots: null });
    let candidate: any;
    await assert.rejects(applyProduction(f.dir, p, { hooks: { afterReceipt: async a => { candidate = a; throw Error('stop'); } } }), /stop/);
    const path = join(f.dir, candidate.result.bundle.path); writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    const resumed = await resumeProduction(f.dir); assert.equal(resumed.current!.state.revision, 2); assert.equal(resumed.recovered[0]!.status, 'interrupted');
    const unknown = join(f.dir, 'production/unknown.json'); writeFileSync(unknown, '{}');
    await assert.rejects(readProduction(f.dir), /PRODUCTION_OUTPUT_UNLISTED/); rmSync(unknown);
    const currentDir = dirname(join(f.dir, saved.state.bundle.path)); writeFileSync(join(currentDir, 'extra.txt'), 'unlisted');
    await assert.rejects(readProduction(f.dir), /PRODUCTION_COMMIT_CHANGED/); rmSync(join(currentDir, 'extra.txt'));
    const copy = join(f.root, 'linked.json'); linkSync(join(f.dir, saved.state.bundle.path), copy);
    await assert.rejects(readProduction(f.dir), /CATALOG_FILE_INVALID/); rmSync(copy);
    const view = join(f.dir, 'production/plan.md'); rmSync(view); symlinkSync(join(f.dir, saved.state.bundle.path), view);
    await assert.rejects(applyProduction(f.dir, p), /IMPORT_SYMLINK/); rmSync(view);
    const lockPath = join(f.dir, 'runs/production.lock'); mkdirSync(lockPath);
    const owner = { attemptId: `production-attempt-${randomUUID()}`, productionId: `production-${randomUUID()}`, pid: process.ppid };
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner));
    await assert.rejects(resumeProduction(f.dir), /PRODUCTION_BUSY/);
    assert.equal(json(join(lockPath, 'owner.json')).attemptId, owner.attemptId);
    owner.pid = process.pid; writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(owner));
    assert.equal((await resumeProduction(f.dir)).current!.state.revision, 2); assert.equal(existsSync(lockPath), false);
  } finally { f.cleanup(); }
});
test('production four scenarios bind actual imported files and committed catalog tuples', async () => {
  const f = fixture(); try {
    const selected = join(f.root, 'selected'); mkdirSync(selected);
    const run = spawnSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=16x16:r=2:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(selected, 'clip.mp4')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const imageRun = spawnSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-i', join(selected, 'clip.mp4'), '-frames:v', '1', join(selected, 'photo.png')], { encoding: 'utf8' });
    assert.equal(imageRun.status, 0, imageRun.stderr);
    writeFileSync(join(f.dir, 'inputs/inspect-policy.json'), JSON.stringify({ ...DEFAULT_INSPECT_POLICY, ocr: { ...DEFAULT_INSPECT_POLICY.ocr, enabled: false } }));
    const imported = await importOriginals(f.dir, selected), catalogued = await catalogAssets(f.dir, { importId: imported.importId }), catalog = await verifyCatalog(f.dir, catalogued.catalogId);
    const asset = (name: string, role: 'image' | 'video') => {
      const a = catalog.assets.find(a => a.source.path === name)!;
      return { inputId: 'input-' + role, role, text: null, file: { path: a.source.fixedPath, bytes: a.source.bytes, sha256: a.source.sha256 },
        catalog: { catalogId: catalog.catalogId, manifestSha256: catalogued.manifestSha256!, assetId: a.assetId, assetVersion: a.assetVersion } };
    };
    const plan = (input: ReturnType<typeof asset>) => ({ version: '0.2' as const, kind: 'asset-plan' as const,
      needs: [{ needId: 'need-open', shotId: 'shot-open', purpose: '展现真实散步素材', required: true,
        content: { action: null, view: null, identity: null }, constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null }],
      uses: [{ useId: 'use-open', needId: 'need-open', shotId: 'shot-open', role: 'visual' as const, catalogId: input.catalog.catalogId,
        catalogManifestSha256: input.catalog.manifestSha256, assetId: input.catalog.assetId, assetVersion: input.catalog.assetVersion, byteSha256: input.file.sha256,
        selection: { kind: 'source' as const }, sourceRange: null, crop: null, fit: 'contain' as const, mute: false }] });
    const folder = productionInitFixture(); folder.requested.scenario = 'folder-vlog'; folder.requested.inputs = [asset('photo.png', 'image'), asset('clip.mp4', 'video')];
    const tampered = structuredClone(folder); tampered.requested.inputs[0]!.catalog!.manifestSha256 = '0'.repeat(64);
    await assert.rejects(initializeProduction(f.dir, tampered), /PRODUCTION_CATALOG_NOT_COMMITTED/);
    const initialized = await initializeProduction(f.dir, folder); assert.equal(initialized.bundle.requirements.requested.inputs.length, 2);
    const planned = productionBundleFixture(); planned.script!.sourceRefs = ['input-image']; planned.script!.lines.forEach(l => { l.sourceRefs = ['input-image']; });
    planned.shots!.assetPlan = plan(asset('photo.png', 'image'));
    const proposal = productionProposalFixture(1, initialized.bundle, { effective: null, script: planned.script, shots: planned.shots }), complete = await applyProduction(f.dir, proposal);
    assert.equal(complete.bundle.shots!.assetPlan.uses[0]!.assetId, initialized.bundle.requirements.requested.inputs[0]!.catalog!.assetId);
    assert.equal((await productionNext(f.dir)).stages.find(s => s.taskId === 'shots')!.status, 'complete');
    const scenarios = ['copy-video', 'title-video', 'video-script'] as const;
    for (const scenario of scenarios) {
      const other = fixture(); try {
        const init = productionInitFixture(); init.requested.scenario = scenario;
        if (scenario === 'copy-video') init.requested.inputs = [{ inputId: 'input-copy', role: 'copy', text: '正文第一句。', file: null, catalog: null }];
        if (scenario === 'video-script') {
          // Byte-independent copies keep the same committed identity tuple after a project move/copy.
          const copyRun = spawnSync('/bin/cp', ['-R', join(f.dir, 'inputs'), other.dir], { encoding: 'utf8' }); assert.equal(copyRun.status, 0, copyRun.stderr);
          const catalogRun = spawnSync('/bin/cp', ['-R', join(f.dir, 'assets'), other.dir], { encoding: 'utf8' }); assert.equal(catalogRun.status, 0, catalogRun.stderr);
          const runsRun = spawnSync('/bin/cp', ['-R', join(f.dir, 'runs'), other.dir], { encoding: 'utf8' }); assert.equal(runsRun.status, 0, runsRun.stderr);
          init.requested.inputs = [asset('clip.mp4', 'video'), { inputId: 'input-script', role: 'script', text: '这是公园里的蓝色画面。', file: null, catalog: null }];
        }
        const r = await initializeProduction(other.dir, init); assert.equal(r.bundle.requirements.requested.scenario, scenario);
        const docs = productionBundleFixture(), refs = init.requested.inputs.map(i => i.inputId); docs.script!.sourceRefs = refs; docs.script!.lines.forEach(l => { l.sourceRefs = refs; });
        if (scenario === 'video-script') docs.shots!.assetPlan = plan(asset('clip.mp4', 'video'));
        const result = await applyProduction(other.dir, productionProposalFixture(1, r.bundle, { effective: null, script: docs.script, shots: docs.shots }));
        assert.equal(result.bundle.script!.lines[0]!.sourceRefs.includes(refs[0]!), true);
      } finally { other.cleanup(); }
    }
    const source = initialized.bundle.requirements.requested.inputs[0]!.file!, data = readFileSync(join(f.dir, source.path));
    assert.equal(hash(data), source.sha256); writeFileSync(join(f.dir, source.path), data.subarray(1));
    await assert.rejects(readProduction(f.dir), /PRODUCTION_FILE_CHANGED/);
  } finally { f.cleanup(); }
});
