import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { initProject } from '../src/project/scaffold.ts';
import { initializeProduction, applyProduction, readProduction } from '../src/application/production.ts';
import { compileProduction, assertProductionCurrent, productionMediaPaths, PRODUCTION_PROJECTION_PATH } from '../src/application/production-compilation.ts';
import { timelineSourceHash } from '../src/project/production-timeline.ts';
import { loadProject } from '../src/project/manifest.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { productionHash } from '../src/project/production.ts';
import { fixturePrompt, productionInitFixture, productionBundleFixture, productionProposalFixture } from './fixtures/production.ts';

async function fixture() {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(out, { recursive: true });
  const root = realpathSync(mkdtempSync(join(out, 'production-compile-')));
  const dir = initProject({ slug: 'fictional-timeline', projectsRoot: join(root, 'projects') }).dir;
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ version: '0.2', packageId: process.env.JBM_RUNTIME_ID ?? 'a'.repeat(64) }));
  writeFileSync(join(dir, 'prompt-history.jsonl'), JSON.stringify(fixturePrompt) + '\n');
  const init = productionInitFixture(), policy = Buffer.from('{}\n');
  writeFileSync(join(dir, 'production-video-limits.json'), policy);
  init.effective.videoLimits = { path: 'production-video-limits.json', bytes: policy.length, sha256: (await import('node:crypto')).createHash('sha256').update(policy).digest('hex') };
  const initial = await initializeProduction(dir, init), b = productionBundleFixture();
  const planned = await applyProduction(dir, productionProposalFixture(initial.state.revision, initial.bundle, { effective: null, script: b.script, shots: b.shots }));
  b.requirements = planned.bundle.requirements; b.script = planned.bundle.script; b.shots = planned.bundle.shots;
  b.timeline = { version: '0.1', sourceHash: timelineSourceHash(b), durationFrames: 900,
    shots: b.shots!.items.map((s, i) => ({ shotId: s.shotId, startFrame: i * 450, endFrame: (i + 1) * 450,
      camera: 'wide', cameraMove: 'static', transition: 'cut', composition: { backdrop: 'studio', motif: 'none', title: 'Walking', bpm: 96, elements: [{ id: s.events[0]!.eventId, kind: 'rect', x: .5, y: .4, width: .2, height: .2, fill: '#448c88' }] } })),
    clips: [], takes: [], placements: [], readingGroups: [], captionCues: [],
    events: b.shots!.items.map((s, i) => ({ eventId: s.events[0]!.eventId, shotId: s.shotId, prepareFrame: i * 450,
      visibleFrame: i * 450 + 3, peakFrame: i * 450 + 6, completeFrame: i * 450 + 9, readingEndFrame: (i + 1) * 450 - 1, anchor: null })) };
  const saved = await applyProduction(dir, productionProposalFixture(planned.state.revision, planned.bundle, { effective: null, script: null, shots: null, timeline: b.timeline }));
  return { root, dir, saved, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('projection binds exact production revision/profile/spec/plan; tampering and authority edits block', async () => {
  const f = await fixture(); try {
    const result = await compileProduction(f.dir, 'rough'); assert.equal(result.ok, true);
    const project = loadProject(f.dir), spec = validateSpec(JSON.parse(readFileSync(project.specPath, 'utf8'))).spec!;
    const current = await assertProductionCurrent(f.dir, spec, 'rough'); assert.equal(current.current.state.revision, 3);
    assert.ok((await productionMediaPaths(f.dir, current.current)).includes('production-video-limits.json'));
    await assert.rejects(assertProductionCurrent(f.dir, spec, 'final'), /PRODUCTION_SPEC_STALE/);
    const saved = readFileSync(project.specPath), changed = structuredClone(spec); changed.video.seed++;
    writeFileSync(project.specPath, JSON.stringify(changed)); await assert.rejects(assertProductionCurrent(f.dir, spec), /ASSET_FILE_CHANGED/);
    writeFileSync(project.specPath, saved);
    const timeline = structuredClone(f.saved.bundle.timeline!); timeline.shots[0]!.composition.title = 'Changed';
    await applyProduction(f.dir, productionProposalFixture(3, f.saved.bundle, { effective: null, script: null, shots: null, timeline }));
    await assert.rejects(assertProductionCurrent(f.dir, spec), /PRODUCTION_SPEC_STALE/);
    assert.equal((await readProduction(f.dir)).state.revision, 4);
    assert.equal(await compileProduction(f.dir, 'final').then(r => r.ok), true);
  } finally { f.cleanup(); }
});

test('hard conflicts remain in committed authority and report while previous projection bytes remain', async () => {
  const f = await fixture(); try {
    assert.equal((await compileProduction(f.dir)).ok, true);
    const project = loadProject(f.dir), specBytes = readFileSync(project.specPath), projectionBytes = readFileSync(join(f.dir, PRODUCTION_PROJECTION_PATH));
    const invalid = structuredClone(f.saved.bundle.timeline!); invalid.events[0]!.readingEndFrame = 901;
    const stored = await applyProduction(f.dir, productionProposalFixture(3, f.saved.bundle, { effective: null, script: null, shots: null, timeline: invalid }));
    assert.equal(productionHash(stored.bundle.timeline), productionHash(invalid));
    const compiled = await compileProduction(f.dir); assert.equal(compiled.ok, false);
    assert.ok(compiled.conflicts.some(c => c.code === 'EVENT_RANGE' && c.severity === 'hard'));
    assert.deepEqual(readFileSync(project.specPath), specBytes); assert.deepEqual(readFileSync(join(f.dir, PRODUCTION_PROJECTION_PATH)), projectionBytes);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'out/production-compile.json'), 'utf8')).revision, 4);
    await assert.rejects(assertProductionCurrent(f.dir, validateSpec(JSON.parse(specBytes.toString())).spec!), /PRODUCTION_SPEC_STALE/);
  } finally { f.cleanup(); }
});
