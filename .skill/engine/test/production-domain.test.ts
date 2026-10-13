import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionBundleFixture } from './fixtures/production.ts';
import { PRODUCTION_CHECK_IDS, assertProductionChecks, productionHash, scriptSourceHash, shotsSourceHash, validateProductionRelations, validateProduction } from '../src/project/production.ts';

test('production hashes depend on consumed inputs and lines, retain stable identities', () => {
  const b = productionBundleFixture(), initialScript = scriptSourceHash(b), initialShots = shotsSourceHash(b);
  b.requirements.requested.inputs.push({ inputId: 'unused-title', role: 'title', text: '备用题目', file: null, catalog: null });
  assert.equal(scriptSourceHash(b), initialScript);
  b.requirements.effective.preview.width = 640;
  assert.equal(scriptSourceHash(b), initialScript);
  assert.notEqual(shotsSourceHash(b), initialShots);
  b.script!.lines.push({ lineId: 'unused-line', text: '备用文字', screenText: '', sourceRefs: ['input-title'] });
  const shotHash = shotsSourceHash(b);
  b.script!.lines.at(-1)!.text = '修改备用文字';
  assert.equal(shotsSourceHash(b), shotHash);
  b.script!.lines[0]!.text = '修改已使用文字';
  assert.notEqual(shotsSourceHash(b), shotHash);
  assert.equal(b.shots!.items[0]!.shotId, 'shot-open');
  assert.equal(b.shots!.items[0]!.events[0]!.eventId, 'event-arrive');
});

test('all four production scenarios require their material source roles', () => {
  for (const scenario of ['folder-vlog', 'copy-video', 'title-video', 'video-script'] as const) {
    const b = productionBundleFixture(); b.script = null; b.shots = null; b.requirements.requested.scenario = scenario;
    if (scenario === 'copy-video') b.requirements.requested.inputs[0]!.role = 'copy';
    if (scenario === 'folder-vlog' || scenario === 'video-script') {
      b.requirements.requested.inputs = [{ inputId: 'input-video', role: 'video', text: null,
        file: { path: 'inputs/original/import-fixture/clip.mp4', bytes: 50, sha256: 'a'.repeat(64) },
        catalog: { catalogId: 'catalog-fixture', manifestSha256: 'b'.repeat(64), assetId: 'asset-fixture', assetVersion: 'v1' } }];
      if (scenario === 'video-script') b.requirements.requested.inputs.push({ inputId: 'input-script', role: 'script', text: '说明稿', file: null, catalog: null });
    }
    validateProductionRelations(b);
    b.requirements.requested.inputs = [];
    assert.throws(() => validateProductionRelations(b), /SCENARIO_INPUT_REQUIRED/);
  }
});

test('missing sources and rewritten event relations fail closed', () => {
  const b = productionBundleFixture();
  b.script!.lines[0]!.sourceRefs = ['missing-input'];
  assert.throws(() => validateProductionRelations(b), /INPUT_REFERENCE/);
  b.script!.lines[0]!.sourceRefs = ['input-title'];
  b.shots!.items[0]!.events[0]!.lineRef = 'line-detail';
  assert.throws(() => validateProductionRelations(b), /EVENT_LINE_REFERENCE/);
  b.shots!.items[0]!.events[0]!.lineRef = 'line-open';
  b.shots!.items[1]!.events[0]!.eventId = 'event-arrive';
  assert.throws(() => validateProductionRelations(b), /EVENT_DUPLICATE/);
});

test('input bytes require independent original paths and schema-closed identity', () => {
  const b = productionBundleFixture(), input = b.requirements.requested.inputs[0]!;
  input.text = null; input.file = { path: 'out/preview.mp4', bytes: 50, sha256: 'a'.repeat(64) };
  assert.throws(() => validateProductionRelations(b), /INPUT_IDENTITY_REQUIRED/);
  input.file.path = '../another-project/source.txt';
  assert.throws(() => validateProductionRelations(b), /BUNDLE_INVALID/);
  input.file.path = 'inputs/original/import-fixture/source.txt';
  validateProductionRelations(b);
  assert.throws(() => validateProduction('bundle', { ...b, guessedComplete: true }), /BUNDLE_INVALID/);
});

test('completion cannot select a subset of the fixed checks', () => {
  assertProductionChecks(PRODUCTION_CHECK_IDS);
  assert.throws(() => assertProductionChecks([]), /REQUIRED_CHECK_MISSING/);
  assert.throws(() => assertProductionChecks(PRODUCTION_CHECK_IDS.slice(1)), /REQUIRED_CHECK_MISSING/);
  assert.throws(() => assertProductionChecks([...PRODUCTION_CHECK_IDS, 'unknown']), /UNKNOWN_CHECK/);
  assert.throws(() => assertProductionChecks([...PRODUCTION_CHECK_IDS, PRODUCTION_CHECK_IDS[0]]), /CHECK_DUPLICATE/);
  assert.equal(productionHash({ a: 1, b: 2 }), productionHash({ b: 2, a: 1 }));
});


test('derived script source links cannot be empty or omit the essential scenario role', () => {
  const b = productionBundleFixture();
  b.script!.sourceRefs = [];
  assert.throws(() => validateProductionRelations(b), /BUNDLE_INVALID/);
  b.script!.sourceRefs = ['input-title'];
  b.script!.lines[0]!.sourceRefs = [];
  assert.throws(() => validateProductionRelations(b), /BUNDLE_INVALID/);
  b.script!.lines[0]!.sourceRefs = ['input-title'];
  b.requirements.requested.inputs.push({ inputId: 'input-copy', role: 'copy', text: '文案', file: null, catalog: null });
  b.requirements.requested.scenario = 'copy-video';
  assert.throws(() => validateProductionRelations(b), /SCENARIO_SOURCE_REQUIRED/);
});
