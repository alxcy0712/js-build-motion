import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Canvas, FontLibrary } from 'skia-canvas';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { assertCatalog, adoptInspectPolicy, DEFAULT_INSPECT_POLICY, INSPECT_POLICY_02, INSPECT_POLICY_03, LEGACY_INSPECT_POLICY } from '../src/project/catalog.ts';
import { validateOcrMap } from '../src/project/ocr.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, importJsonText(value));
const evidence = (asset: any, kind: string) => asset.technical.evidence.find((e: any) => e.kind === kind);
FontLibrary.use('IndependentCatalogOcr', [join(PROJECT_ROOT, 'assets/fonts/LXGWWenKai-Regular.ttf')]);
async function fixture(text = '中文 ALPHA 123', blank = false) {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'catalog-ocr-'))), dir = initProject({ slug: 'catalog-ocr', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected');
  mkdirSync(selected); mkdirSync(join(dir, 'inputs'), { recursive: true });
  const models = join(dir, '.engine/assets/ocr/tessdata'); mkdirSync(models, { recursive: true });
  for (const name of ['eng', 'chi_sim']) copyFileSync(join(PROJECT_ROOT, 'assets/ocr/tessdata', `${name}.traineddata`), join(models, `${name}.traineddata`));
  const canvas = new Canvas(1001, 301, { gpu: false }), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = 'black'; ctx.font = '72px IndependentCatalogOcr'; if (!blank) ctx.fillText(text, 40, 155);
  const bytes = await canvas.toBuffer('png'); writeFileSync(join(selected, 'renamed.data'), bytes);
  return { root, dir, selected, bytes, import: () => importOriginals(dir, selected), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function policy(dir: string, ocr = {}, common = {}) { save(join(dir, 'inputs/inspect-policy.json'), { ...DEFAULT_INSPECT_POLICY, ...common, ocr: { ...DEFAULT_INSPECT_POLICY.ocr, ...ocr } }); }
async function failed(dir: string, selection: any, options = {}) {
  let error; try { await catalogAssets(dir, selection, options); } catch (e) { error = e; }
  assert.ok(error instanceof CatalogFailure, String(error)); assertCatalog('receipt', error.receipt); assert.equal(error.receipt.indexCommitted, false); return error.receipt;
}
function observation(asset: any, map: any, region = map.regions[0]) {
  const descriptor = asset.technical.ocr;
  return { version: '0.3', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256,
    method: 'independent fixed OCR region', locator: { kind: 'ocr', evidenceId: descriptor.textEvidenceId, mapEvidenceId: descriptor.mapEvidenceId,
      rasterEvidenceId: descriptor.rasterEvidenceId, regionId: region.id, byteStart: region.byteStart, byteEnd: region.byteEnd }, coverage: 'full', coverageScope: 'region-ocr-text',
    statement: 'Only the recorded region text was read.', basis: 'observed', confidence: 0.5, limitations: ['OCR errors remain possible.'],
    evidenceRefs: [descriptor.textEvidenceId, descriptor.mapEvidenceId, descriptor.rasterEvidenceId] };
}

test('independent catalog OCR fixes source/raster/TSV/text/map, default policy and observations', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!, d = a.technical.ocr!;
    assert.equal(m.version, '0.4'); assert.equal(m.policy.version, '0.4'); assert.equal(r.version, '0.4'); assert.equal(a.technical.status, 'supported', a.technical.reason); assert.equal(d.status, 'completed');
    for (const kind of ['preview', 'ocr-raster', 'ocr-tsv', 'text', 'ocr-map']) assert.ok(evidence(a, kind), kind);
    const map = json(join(f.dir, evidence(a, 'ocr-map').path)), text = readFileSync(join(f.dir, evidence(a, 'text').path));
    assert.equal(map.source.sha256, sha(f.bytes)); assert.equal(map.policySha256, a.inspection.policySha256); assert.equal(map.text.sha256, sha(text));
    assert.equal(map.source.width, 1001); assert.equal(map.source.height, 301); assert.equal(map.raster.width, 1001); assert.equal(map.raster.height, 301); assert.equal(map.raster.orientationApplied, false);
    assert.match(text.toString(), /ALPHA/); assert.match(text.toString().replace(/\s/g, ''), /中文/); assert.equal(a.usability.semanticMatch.result, 'unknown'); assert.equal(a.usability.rightsScope.result, 'unknown');
    const record = observation(a, map); save(join(f.dir, 'inputs/ocr-observation.json'), record); const accepted = await catalogAssets(f.dir, { observation: 'inputs/ocr-observation.json' }); assert.deepEqual((await verifyCatalog(f.dir, accepted.catalogId)).observations[0], record);
    const before = readFileSync(join(f.dir, 'assets/catalog.json')), chinese = map.regions.find((region: any) => text.subarray(region.byteStart, region.byteEnd).some((b: number) => b > 127)); assert.ok(chinese);
    for (const change of [{ assetVersion: `asset-version-${randomUUID()}` }, { byteSha256: sha('wrong') }, { confidence: 50 },
      { locator: { ...record.locator, regionId: 'missing' } }, { locator: { ...record.locator, mapEvidenceId: record.locator.evidenceId } },
      { locator: { ...record.locator, rasterEvidenceId: record.locator.evidenceId } }, { evidenceRefs: [record.locator.evidenceId] },
      { locator: { ...record.locator, byteEnd: record.locator.byteEnd + 1 } }, { locator: { ...record.locator, byteEnd: record.locator.byteEnd - 1 } },
      { locator: { ...record.locator, regionId: chinese.id, byteStart: chinese.byteStart + 1, byteEnd: chinese.byteEnd }, coverage: 'partial' }, { coverageScope: 'whole-image' }]) {
      save(join(f.dir, 'inputs/ocr-observation.json'), { ...record, id: `observation-${randomUUID()}`, ...change }); await failed(f.dir, { observation: 'inputs/ocr-observation.json' }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
    const legacy = { ...record, version: '0.1', id: `observation-${randomUUID()}`, locator: { kind: 'text', evidenceId: d.textEvidenceId, byteStart: 0, byteEnd: text.length, lineStart: 1, lineEnd: text.toString().split('\n').length, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null }, evidenceRefs: [d.textEvidenceId] }; delete (legacy as any).coverageScope;
    save(join(f.dir, 'inputs/ocr-observation.json'), legacy); assert.match((await failed(f.dir, { observation: 'inputs/ocr-observation.json' })).error!, /OCR|LOCATOR/);
    const preview = evidence(a, 'preview'), image = { ...legacy, id: `observation-${randomUUID()}`, locator: { ...legacy.locator, kind: 'image', evidenceId: preview.id, byteStart: null, byteEnd: null, lineStart: null, lineEnd: null, x: 0, y: 0, width: preview.width, height: preview.height }, evidenceRefs: [preview.id] };
    save(join(f.dir, 'inputs/ocr-observation.json'), image); const viewed = await catalogAssets(f.dir, { observation: 'inputs/ocr-observation.json' }); await verifyCatalog(f.dir, viewed.catalogId); assert.deepEqual(readFileSync(join(f.dir, a.source.fixedPath)), f.bytes);
  } finally { f.cleanup(); }
});

test('independent catalog OCR no-text and disabled facts retain image previews', async () => {
  const f = await fixture('', true); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!;
    assert.equal(a.technical.ocr!.status, 'no-text'); assert.equal(a.technical.status, 'supported'); assert.equal(evidence(a, 'text').bytes, 0); assert.deepEqual(json(join(f.dir, evidence(a, 'ocr-map').path)).regions, []);
    const record = observation(a, { regions: [{ id: 'ocr-word-1', byteStart: 0, byteEnd: 1 }] }); save(join(f.dir, 'inputs/empty-observation.json'), record); await failed(f.dir, { observation: 'inputs/empty-observation.json' });
    policy(f.dir, { enabled: false }); const fresh = await f.import(), disabled = await catalogAssets(f.dir, { importId: fresh.importId }), m = await verifyCatalog(f.dir, disabled.catalogId), latest = m.assets.at(-1)!;
    assert.equal(latest.technical.status, 'supported'); assert.equal(latest.technical.ocr!.status, 'disabled'); assert.ok(evidence(latest, 'preview')); assert.equal(latest.technical.evidence.some(e => e.kind.startsWith('ocr-')), false); assert.equal(latest.technical.text, null);
    await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});

test('independent catalog OCR rejects tampered/missing/linked/directory/unlisted fixed evidence', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!, before = readFileSync(join(f.dir, 'assets/catalog.json'));
    const targets = [a.source.fixedPath, ...['ocr-raster', 'ocr-tsv', 'text', 'ocr-map'].map(kind => evidence(a, kind).path), `runs/${r.attemptId}/inspect-policy.source.json`, `runs/${r.attemptId}/inspect-policy.adopted.json`];
    for (const relative of targets) {
      const path = join(f.dir, relative), bytes = readFileSync(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; writeFileSync(path, changed);
      await assert.rejects(verifyCatalog(f.dir, r.catalogId)); writeFileSync(path, bytes); await verifyCatalog(f.dir, r.catalogId);
    }
    const path = join(f.dir, evidence(a, 'ocr-map').path), bytes = readFileSync(path);
    for (const kind of ['missing', 'symlink', 'hardlink', 'directory']) {
      unlinkSync(path); if (kind === 'symlink') symlinkSync(join(f.dir, a.source.fixedPath), path); if (kind === 'hardlink') linkSync(join(f.dir, a.source.fixedPath), path); if (kind === 'directory') mkdirSync(path);
      await assert.rejects(verifyCatalog(f.dir, r.catalogId)); await failed(f.dir, { importId: imported.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
      rmSync(path, { recursive: true, force: true }); writeFileSync(path, bytes);
    }
    const extra = join(f.dir, 'assets/derived/inspection', a.inspectionId, 'extra.txt'); writeFileSync(extra, 'extra'); await assert.rejects(verifyCatalog(f.dir, r.catalogId)); unlinkSync(extra); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});

test('independent catalog OCR source revisions preserve original versions and prior observations', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), m = await verifyCatalog(f.dir, r.catalogId), old = m.assets[0]!, frozen = readFileSync(join(f.dir, r.manifestPath!));
    const record = observation(old, json(join(f.dir, evidence(old, 'ocr-map').path))); save(join(f.dir, 'inputs/observed.json'), record); await catalogAssets(f.dir, { observation: 'inputs/observed.json' });
    const duplicate = await catalogAssets(f.dir, { importId: imported.importId }); assert.deepEqual((await verifyCatalog(f.dir, duplicate.catalogId)).assets, m.assets);
    const fresh = await f.import(), revised = await catalogAssets(f.dir, { importId: fresh.importId, path: 'renamed.data', assetId: old.assetId }), latest = await verifyCatalog(f.dir, revised.catalogId), versions = latest.assets.filter(a => a.assetId === old.assetId);
    assert.equal(versions.length, 2); assert.deepEqual(versions[0], old); assert.equal(versions[1]!.source.sha256, old.source.sha256); assert.notEqual(versions[1]!.assetVersion, old.assetVersion); assert.notEqual(versions[1]!.source.importId, old.source.importId);
    assert.deepEqual(latest.observations, [record]); assert.deepEqual(readFileSync(join(f.dir, r.manifestPath!)), frozen); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});

test('independent catalog OCR replays raw TSV after consistent text/map/file hash replacement', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), receipt = await catalogAssets(f.dir, { importId: imported.importId }), manifestPath = join(f.dir, receipt.manifestPath!), indexPath = join(f.dir, 'assets/catalog.json');
    const original = await verifyCatalog(f.dir, receipt.catalogId), asset = original.assets[0]!, mapPath = join(f.dir, evidence(asset, 'ocr-map').path), textPath = join(f.dir, evidence(asset, 'text').path);
    const oldMap = readFileSync(mapPath), oldText = readFileSync(textPath), oldManifest = readFileSync(manifestPath), oldIndex = readFileSync(indexPath);
    for (const change of ['word', 'confidence']) {
      const manifest: any = JSON.parse(oldManifest.toString()), current = manifest.assets[0], map = JSON.parse(oldMap.toString()), text = Buffer.from(oldText);
      if (change === 'word') { const offset = text.indexOf('ALPHA'); assert.ok(offset >= 0); Buffer.from('OMEGA').copy(text, offset); map.text.sha256 = sha(text); }
      else { const region = map.regions.find((r: any) => r.engineConfidence !== null && r.engineConfidence < 100); assert.ok(region); region.engineConfidence = Number(String(region.engineConfidence).replace(/^\d/, (d: string) => d === '1' ? '2' : '1')); }
      validateOcrMap(map, text, readFileSync(join(f.dir, evidence(asset, 'ocr-raster').path)), readFileSync(join(f.dir, evidence(asset, 'ocr-tsv').path)), original.policy.ocr);
      writeFileSync(textPath, text); save(mapPath, map);
      for (const kind of ['text', 'ocr-map']) { const e = evidence(current, kind), bytes = readFileSync(join(f.dir, e.path)); e.bytes = bytes.length; e.sha256 = sha(bytes); }
      current.technical.text.bytes = text.length; manifest.counts.derivedBytes += evidence(current, 'ocr-map').bytes - evidence(asset, 'ocr-map').bytes;
      save(manifestPath, manifest); const index = JSON.parse(oldIndex.toString()); index.catalogs.find((entry: any) => entry.catalogId === receipt.catalogId).manifestSha256 = sha(readFileSync(manifestPath)); save(indexPath, index);
      await assert.rejects(verifyCatalog(f.dir, receipt.catalogId), /OCR|TSV|REPLAY/);
      writeFileSync(mapPath, oldMap); writeFileSync(textPath, oldText); writeFileSync(manifestPath, oldManifest); writeFileSync(indexPath, oldIndex); await verifyCatalog(f.dir, receipt.catalogId);
    }
  } finally { f.cleanup(); }
});

test('independent inspect policy historical and default adopted hashes remain fixed', () => {
  for (const [policy, hash] of [[LEGACY_INSPECT_POLICY, 'e68f4c56e4caf3c2c74a8fe61a7dfa08cb6e1e6f60b99e5a97d0b48737f1b616'], [INSPECT_POLICY_02, '4018e2e6aa02dbdf80c30ebeb5d503e7f42bb43cc0647ce86a88882e2643a52e'], [INSPECT_POLICY_03, '14137aa91678b6df915c2f2d373724f8a3f93c52a8d4c9333416919e0f061322'], [DEFAULT_INSPECT_POLICY, 'f44261727f0b8c6d6801182ce45e27dd7b4507d23a6754dc943ce88ca0ae74b0']] as const) assert.equal(sha(importJsonText(policy)), hash, policy.version);
  assert.equal(DEFAULT_INSPECT_POLICY.ocr.enabled, true);
});

test('independent catalog OCR item quotas retain previews and global quotas preserve index', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId });
    for (const [ocr, common, pattern] of [[{ maxOcrSourceBytes: f.bytes.length - 1 }, {}, /SOURCE_LIMIT/], [{ maxOcrSourcePixels: 1001 * 301 - 1 }, {}, /PIXEL_LIMIT/],
      [{ maxOcrEdge: 1000 }, {}, /EDGE_LIMIT/], [{ maxOcrRasterBytes: 1 }, {}, /RASTER_LIMIT/], [{ maxOcrTsvBytes: 1 }, {}, /BINARY|TSV_LIMIT|OUTPUT/],
      [{ maxOcrMapBytes: 1 }, {}, /MAP_LIMIT/], [{ maxOcrTextBytes: 1 }, {}, /TEXT_LIMIT/], [{ maxOcrRegions: 0 }, {}, /REGIONS_LIMIT/]] as const) {
      policy(f.dir, ocr, common); const fresh = await f.import(), r = await catalogAssets(f.dir, { importId: fresh.importId }), a = (await verifyCatalog(f.dir, r.catalogId)).assets.at(-1)!;
      assert.equal(a.technical.status, 'partial', a.technical.reason); assert.ok(['failed', 'skipped'].includes(a.technical.ocr!.status)); assert.match(a.technical.ocr!.reason, pattern); assert.ok(evidence(a, 'preview')); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('ocr-')), false); await verifyCatalog(f.dir, first.catalogId);
    }
    const before = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const [ocr, common] of [[{ maxOcrImagesPerAttempt: 0 }, {}], [{}, { maxSourceBytes: 1 }], [{}, { maxDerivedBytes: 1 }], [{}, { maxCatalogBytes: 1 }]] as const) {
      policy(f.dir, ocr, common); const fresh = await f.import(); await failed(f.dir, { importId: fresh.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
  } finally { f.cleanup(); }
});

for (const oldPolicy of [LEGACY_INSPECT_POLICY, INSPECT_POLICY_02]) test(`independent closed ${oldPolicy.version} catalogs retain adopted hashes and records in 0.4`, async () => {
  const f = await fixture(); try {
    unlinkSync(join(f.selected, 'renamed.data')); writeFileSync(join(f.selected, 'notes.txt'), 'Fictional old text');
    const source = JSON.stringify(oldPolicy, null, 2); writeFileSync(join(f.dir, 'inputs/inspect-policy.json'), source); const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId });
    const m: any = json(join(f.dir, r.manifestPath!)), adoptedHash = sha(importJsonText(oldPolicy)); m.version = oldPolicy.version; m.policy = oldPolicy; m.policySha256 = adoptedHash;
    for (const a of m.assets) {
      a.inspection.policySha256 = adoptedHash;
    }
    save(join(f.dir, 'runs', r.attemptId, 'inspect-policy.adopted.json'), oldPolicy);
    const a = m.assets[0], text = evidence(a, 'text');
    m.observations = [{ version: '0.1', id: `observation-${randomUUID()}`, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256, method: 'historical text', locator: { kind: 'text', evidenceId: text.id, byteStart: 0, byteEnd: text.bytes, lineStart: 1, lineEnd: 1, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null }, coverage: 'full', statement: 'Old fixed text.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [text.id] }];
    m.rights = [{ version: '0.1', id: `rights-${randomUUID()}`, revision: 1, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256, status: 'unknown', sourceRefs: [], allowedUses: [], restrictions: [], attribution: null, affectedStreams: [], thirdPartyRightsStatus: 'unknown' }];
    assertCatalog('manifest', m); save(join(f.dir, r.manifestPath!), m); const idx = json(join(f.dir, 'assets/catalog.json')); idx.version = oldPolicy.version; idx.catalogs[0].manifestSha256 = sha(importJsonText(m)); save(join(f.dir, 'assets/catalog.json'), idx);
    const frozen = readFileSync(join(f.dir, r.manifestPath!)), old = await verifyCatalog(f.dir, r.catalogId); assert.deepEqual(adoptInspectPolicy(oldPolicy, oldPolicy.version), oldPolicy);
    const next = await catalogAssets(f.dir, { importId: imported.importId }), latest = await verifyCatalog(f.dir, next.catalogId); assert.equal(latest.version, '0.4'); assert.deepEqual(latest.assets, old.assets); assert.deepEqual(latest.observations, old.observations); assert.deepEqual(latest.rights, old.rights);
    assert.equal(readFileSync(join(f.dir, 'inputs/inspect-policy.json'), 'utf8'), source); assert.deepEqual(readFileSync(join(f.dir, r.manifestPath!)), frozen); assert.equal(json(join(f.dir, 'runs', r.attemptId, 'inspect-policy.adopted.json')).version, oldPolicy.version); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});

test('independent OCR cancellation, source mutation and index rename before/after failures preserve publication facts', async () => {
  const f = await fixture(); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId }), old = readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const controller = new AbortController(); await failed(f.dir, { importId: fresh.importId }, { signal: controller.signal, hooks: { onPhase: async (r: any) => { if (r.phase === 'inspecting') controller.abort(); } } }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
    const fixed = join(f.dir, 'inputs/original', fresh.importId, 'renamed.data'); await failed(f.dir, { importId: fresh.importId }, { hooks: { afterInspection: async () => { const changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1; writeFileSync(fixed, changed); } } }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old); writeFileSync(fixed, f.bytes);
    const rename = fsPromises.rename;
    try {
      fsPromises.rename = async (src, dst) => { if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(new Error('fictional before-effect EIO'), { code: 'EIO' }); await rename(src, dst); }; syncBuiltinESMExports();
      await failed(f.dir, { importId: fresh.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
      fsPromises.rename = async (src, dst) => { await rename(src, dst); if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(new Error('fictional after-effect EIO'), { code: 'EIO' }); }; syncBuiltinESMExports();
      const result = await catalogAssets(f.dir, { importId: fresh.importId }).catch((e: any) => e.receipt); assert.equal(result.status, 'succeeded'); assert.equal(result.indexCommitted, true); await verifyCatalog(f.dir, result.catalogId);
    } finally { fsPromises.rename = rename; syncBuiltinESMExports(); }
    await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});

for (const phase of ['inspecting', 'committing', 'committed']) test(`independent OCR real SIGKILL at ${phase} recovers the durable receipt`, async () => {
  const f = await fixture(); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId }), old = readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const hook = phase === 'committed' ? 'afterIndexCommitted:async()=>process.kill(process.pid,"SIGKILL")' : `onPhase:async r=>{if(r.phase===${JSON.stringify(phase)})process.kill(process.pid,"SIGKILL")}`;
    const code = `const {catalogAssets}=await import(${JSON.stringify(new URL('../src/application/catalog.ts', import.meta.url).href)});await catalogAssets(${JSON.stringify(f.dir)},{importId:${JSON.stringify(fresh.importId)}},{hooks:{${hook}}});`;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000 }); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const attempts = (await fsPromises.readdir(join(f.dir, 'runs'))).filter(name => /^catalog-attempt-/.test(name)); const pending = attempts.map(name => json(join(f.dir, 'runs', name, 'receipt.json'))).find(r => ['running', 'prepared'].includes(r.status)); assert.ok(pending);
    if (phase !== 'committed') { assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old); await assert.rejects(verifyCatalog(f.dir, pending.catalogId), /NOT_COMMITTED/); }
    else await verifyCatalog(f.dir, pending.catalogId);
    await catalogAssets(f.dir, { importId: fresh.importId }); const recovered = json(join(f.dir, 'runs', pending.attemptId, 'receipt.json')); assert.equal(recovered.status, phase === 'committed' ? 'succeeded' : 'interrupted'); assert.equal(recovered.indexCommitted, phase === 'committed'); assert.equal(existsSync(join(f.dir, 'runs/catalog.lock')), false); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});
