import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Canvas, FontLibrary } from 'skia-canvas';
import { importOriginals } from '../src/application/import.ts';
import { unpackOriginal } from '../src/application/unpack.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { assertCatalog, adoptInspectPolicy, DEFAULT_INSPECT_POLICY, LEGACY_INSPECT_POLICY } from '../src/project/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { makeZip } from './fixtures/zip.ts';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => writeFileSync(path, importJsonText(value));
const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docx(text = '<w:p><w:r><w:t>中文相同</w:t></w:r></w:p><w:p/><w:tbl><w:tr><w:tc><w:p><w:r><w:t>中文相同</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>') {
  return makeZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="${w}"><w:body>${text}</w:body></w:document>` },
  ]);
}
function fixture() {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'catalog-document-'))), dir = initProject({ slug: 'document-fixture', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected'); mkdirSync(selected); mkdirSync(join(dir, 'inputs'), { recursive: true });
  return { root, dir, selected, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
function policy(dir: string, document = {}, common = {}) { save(join(dir, 'inputs/inspect-policy.json'), { ...DEFAULT_INSPECT_POLICY, ...common, document: { ...DEFAULT_INSPECT_POLICY.document, ...document } }); }
function observation(asset: any, unit: any) { const d = asset.technical.document; return { version: '0.2', id: `observation-${randomUUID()}`, assetId: asset.assetId,
  assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'read fixed unit text/map', locator: { kind: 'document', evidenceId: d.textEvidenceId,
    mapEvidenceId: d.mapEvidenceId, unitId: unit.id, byteStart: unit.byteStart, byteEnd: unit.byteEnd }, coverage: 'full', coverageScope: 'unit-native-text',
  statement: 'Fictional unit contains the recorded native text.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [d.textEvidenceId, d.mapEvidenceId] }; }
async function failure(dir: string, selection: any, options = {}) { await assert.rejects(catalogAssets(dir, selection, options), (e: any) => { assert.ok(e instanceof CatalogFailure); assertCatalog('receipt', e.receipt); assert.equal(e.receipt.indexCommitted, false); return true; }); }
async function pdf(path: string) { FontLibrary.use('DocumentTest', join(PROJECT_ROOT, 'assets/fonts/LXGWWenKai-Regular.ttf')); const canvas = new Canvas(200, 100), ctx = canvas.getContext('2d'); ctx.font = '18px DocumentTest'; ctx.fillText('中文第一页', 10, 30); const next = canvas.newPage(); next.font = '18px DocumentTest'; next.fillText('中文第二页', 10, 30); writeFileSync(path, await canvas.toBuffer('pdf')); }

test('PDF signature and DOCX main body produce source/policy/text/map identities for import and unpack', async () => {
  const f = fixture(); try {
    await pdf(join(f.selected, 'renamed.data')); writeFileSync(join(f.selected, 'BODY.DOCX'), docx()); writeFileSync(join(f.selected, 'wrapped.docx'), Buffer.from('d0cf11e0a1b11ae1', 'hex')); writeFileSync(join(f.selected, 'ordinary.zip'), docx());
    writeFileSync(join(f.selected, 'bundle.zip'), makeZip([{ name: 'inside.docx', data: docx() }]));
    const parent = await importOriginals(f.dir, f.selected), receipt = await catalogAssets(f.dir, { importId: parent.importId }), manifest = await verifyCatalog(f.dir, receipt.catalogId);
    assert.equal(manifest.version, '0.4'); assert.equal(receipt.version, '0.4'); assert.equal(manifest.policy.version, '0.4');
    for (const name of ['renamed.data', 'BODY.DOCX']) { const a = manifest.assets.find(a => a.source.path === name)!, d = a.technical.document!;
      assert.equal(a.technical.status, 'supported', a.technical.reason); assert.equal(a.technical.evidence.length, 2);
      const mapEvidence = a.technical.evidence.find(e => e.id === d.mapEvidenceId)!, textEvidence = a.technical.evidence.find(e => e.id === d.textEvidenceId)!, map = json(join(f.dir, mapEvidence.path));
      assert.equal(map.source.sha256, a.source.sha256); assert.equal(map.policySha256, a.inspection.policySha256); assert.equal(map.text.sha256, textEvidence.sha256);
      assert.equal(hash(readFileSync(join(f.dir, mapEvidence.path))), mapEvidence.sha256); assert.equal(a.usability.semanticMatch.result, 'unknown'); assert.equal(a.usability.rightsScope.result, 'unknown');
      assert.equal(map.coverage.totalPages, name.endsWith('data') ? 2 : null);
    }
    assert.equal(manifest.assets.find(a => a.source.path === 'wrapped.docx')!.technical.status, 'unsupported'); assert.match(manifest.assets.find(a => a.source.path === 'wrapped.docx')!.technical.reason, /DOCUMENT_CFB_UNSUPPORTED/);
    assert.equal(manifest.assets.find(a => a.source.path === 'ordinary.zip')!.technical.status, 'requires-unpack');
    const un = await unpackOriginal(f.dir, parent.importId, 'bundle.zip'), expanded = await catalogAssets(f.dir, { unpackId: un.unpackId });
    assert.equal((await verifyCatalog(f.dir, expanded.catalogId)).assets.at(-1)!.source.unpackManifestSha256, un.manifestSha256);
    assert.ok(receipt.tools.every(t => t.stdoutBytes === 0 && t.binaryBytes > 0 && t.argv[0] === '--max-old-space-size=512'));
  } finally { f.cleanup(); }
});

test('document observations bind real units, UTF8 ranges and complete unit coverage in a partial document', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'body.docx'), docx()); policy(f.dir, { maxDocumentUnits: 2 });
    const imp = await importOriginals(f.dir, f.selected), receipt = await catalogAssets(f.dir, { importId: imp.importId }), manifest = await verifyCatalog(f.dir, receipt.catalogId), asset = manifest.assets[0]!, d = asset.technical.document!, map = json(join(f.dir, asset.technical.evidence.find(e => e.id === d.mapEvidenceId)!.path));
    assert.equal(asset.technical.status, 'partial'); const record = observation(asset, map.units[0]); save(join(f.dir, 'inputs/observed.json'), record);
    const observed = await catalogAssets(f.dir, { observation: 'inputs/observed.json' }); assert.equal((await verifyCatalog(f.dir, observed.catalogId)).observations.length, 1);
    const old = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const change of [{ locator: { ...record.locator, unitId: 'missing' } }, { locator: { ...record.locator, byteStart: 1 } },
      { locator: { ...record.locator, byteEnd: record.locator.byteEnd - 3 } }, { locator: { ...record.locator, byteEnd: record.locator.byteEnd + 1 } },
      { locator: { ...record.locator, mapEvidenceId: record.locator.evidenceId } }, { evidenceRefs: [record.locator.evidenceId] }, { byteSha256: 'f'.repeat(64) }, { coverageScope: 'whole-document' }]) {
      save(join(f.dir, 'inputs/observed.json'), { ...record, id: `observation-${randomUUID()}`, ...change }); await failure(f.dir, { observation: 'inputs/observed.json' }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
    }
    const legacy = { version: '0.1', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'legacy text bypass',
      locator: { kind: 'text', evidenceId: d.textEvidenceId, byteStart: 0, byteEnd: asset.technical.text!.bytes, lineStart: 1, lineEnd: asset.technical.text!.lines, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null },
      coverage: 'full', statement: 'Legacy bypass', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [d.textEvidenceId] };
    save(join(f.dir, 'inputs/observed.json'), legacy); await failure(f.dir, { observation: 'inputs/observed.json' });
    await verifyCatalog(f.dir, observed.catalogId);
  } finally { f.cleanup(); }
});

for (const target of ['source', 'text', 'map']) test(`document verification rejects same-size ${target} replacement`, async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'body.docx'), docx()); const imp = await importOriginals(f.dir, f.selected), receipt = await catalogAssets(f.dir, { importId: imp.importId }), m = await verifyCatalog(f.dir, receipt.catalogId), a = m.assets[0]!;
    const path = join(f.dir, target === 'source' ? a.source.fixedPath : a.technical.evidence.find(e => e.kind === (target === 'map' ? 'document-map' : 'text'))!.path), original = readFileSync(path), changed = Buffer.from(original); changed[changed.length - 1] ^= 1; writeFileSync(path, changed);
    await assert.rejects(verifyCatalog(f.dir, receipt.catalogId)); writeFileSync(path, original); await verifyCatalog(f.dir, receipt.catalogId);
  } finally { f.cleanup(); }
});

test('document item refusal and worker faults retain other items; general/count/derived quotas preserve prior index', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'good.docx'), docx()); writeFileSync(join(f.selected, 'bad.docx'), makeZip([])); writeFileSync(join(f.selected, 'notes.txt'), 'ok');
    const imp = await importOriginals(f.dir, f.selected), initial = await catalogAssets(f.dir, { importId: imp.importId }), m = await verifyCatalog(f.dir, initial.catalogId);
    assert.equal(m.assets.find(a => a.source.path === 'good.docx')!.technical.status, 'supported'); assert.ok(['failed', 'unsupported'].includes(m.assets.find(a => a.source.path === 'bad.docx')!.technical.status));
    for (const [limits, common, reason] of [[{ workerOldSpaceMiB: 1 }, {}, /TOOL_EXIT|OUTPUT_LIMIT/], [{ maxWorkerPayloadBytes: 1 }, {}, /BINARY_LIMIT|TOOL_EXIT/], [{ maxDocumentMapBytes: 1 }, {}, /MAP_LIMIT/], [{}, { maxToolElapsedMs: 1 }, /TOOL_TIME_LIMIT/], [{ maxDocumentSourceBytes: 1 }, {}, /SOURCE_LIMIT/]] as const) {
      policy(f.dir, limits, common); const fresh = await importOriginals(f.dir, f.selected), r = await catalogAssets(f.dir, { importId: fresh.importId, path: 'good.docx' }), a = (await verifyCatalog(f.dir, r.catalogId)).assets.at(-1)!;
      assert.match(a.technical.reason, reason); assert.equal(a.technical.evidence.length, 0);
    }
    const old = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const [limits, common] of [[{ maxDocumentsPerAttempt: 1 }, {}], [{}, { maxDerivedBytes: 1 }], [{}, { maxSourceBytes: 1 }]] as const) {
      policy(f.dir, limits, common); const fresh = await importOriginals(f.dir, f.selected); await failure(f.dir, { importId: fresh.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
    }
    policy(f.dir, { maxDocumentsPerAttempt: 1 }); await failure(f.dir, { importId: imp.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
  } finally { f.cleanup(); }
});

test('0.1 policies/catalogs remain byte-stable, mixed inheritance and external re-import creates an asset revision', async () => {
  const f = fixture(); try {
    const sourcePolicy = JSON.stringify(LEGACY_INSPECT_POLICY); writeFileSync(join(f.dir, 'inputs/inspect-policy.json'), sourcePolicy);
    writeFileSync(join(f.selected, 'body.docx'), docx()); writeFileSync(join(f.selected, 'notes.txt'), 'old'); const imp = await importOriginals(f.dir, f.selected), r = await catalogAssets(f.dir, { importId: imp.importId });
    const m = json(join(f.dir, r.manifestPath!)), legacyHash = hash(importJsonText(LEGACY_INSPECT_POLICY));
    // Fictional closed 0.1 snapshot has the same parent lineage and the historical unsupported DOCX fact.
    m.version = '0.1'; m.policy = LEGACY_INSPECT_POLICY; m.policySha256 = legacyHash; m.tools = []; m.counts.derivedBytes = m.assets.find((a: any) => a.source.path === 'notes.txt').technical.evidence[0].bytes;
    for (const a of m.assets) { a.inspection.policySha256 = legacyHash; if (a.source.path === 'body.docx') { for (const e of a.technical.evidence) rmSync(join(f.dir, e.path)); a.technical = { status: 'unsupported', format: 'zip', method: 'inspection@0.1', reason: 'historical unsupported document', raw: null, streams: [], evidence: [], text: null, containerDuration: null, limitations: [] }; } }
    save(join(f.dir, 'runs', r.attemptId, 'inspect-policy.adopted.json'), LEGACY_INSPECT_POLICY); save(join(f.dir, r.manifestPath!), m); const idx = json(join(f.dir, 'assets/catalog.json')); idx.version = '0.1'; idx.catalogs[0].manifestSha256 = hash(importJsonText(m)); save(join(f.dir, 'assets/catalog.json'), idx);
    const prior = readFileSync(join(f.dir, r.manifestPath!)), oldAsset = m.assets.find((a: any) => a.source.path === 'body.docx'); assertCatalog('manifest', m); await verifyCatalog(f.dir, r.catalogId);
    const repeat = await catalogAssets(f.dir, { importId: imp.importId }), inherited = await verifyCatalog(f.dir, repeat.catalogId); assert.deepEqual(inherited.assets, m.assets); assert.deepEqual(readFileSync(join(f.dir, r.manifestPath!)), prior);
    const fresh = await importOriginals(f.dir, f.selected), updated = await catalogAssets(f.dir, { importId: fresh.importId, path: 'body.docx', assetId: oldAsset.assetId }), final = await verifyCatalog(f.dir, updated.catalogId);
    const versions = final.assets.filter(a => a.assetId === oldAsset.assetId); assert.equal(versions.length, 2); assert.deepEqual(versions[0], oldAsset); assert.equal(versions[1]!.technical.status, 'supported'); assert.notEqual(versions[0]!.assetVersion, versions[1]!.assetVersion);
    assert.equal(readFileSync(join(f.dir, 'inputs/inspect-policy.json'), 'utf8'), sourcePolicy); assert.deepEqual(adoptInspectPolicy(LEGACY_INSPECT_POLICY, '0.1'), LEGACY_INSPECT_POLICY); await verifyCatalog(f.dir, r.catalogId);
    await assert.rejects(importOriginals(f.dir, join(f.dir, oldAsset.source.fixedPath)), /OVERLAP/);
  } finally { f.cleanup(); }
});

test('document cancellation, source change and post-index receipt failure retain verified publication facts', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'body.docx'), docx()); const imp = await importOriginals(f.dir, f.selected), first = await catalogAssets(f.dir, { importId: imp.importId }), old = readFileSync(join(f.dir, 'assets/catalog.json'));
    const fresh = await importOriginals(f.dir, f.selected), controller = new AbortController(); await failure(f.dir, { importId: fresh.importId }, { signal: controller.signal, hooks: { onPhase: async (r: any) => { if (r.phase === 'inspecting') controller.abort(); } } }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old);
    const changed = await importOriginals(f.dir, f.selected), fixed = join(f.dir, 'inputs/original', changed.importId, 'body.docx'), original = readFileSync(fixed);
    await failure(f.dir, { importId: changed.importId }, { hooks: { afterInspection: async () => writeFileSync(fixed, Buffer.alloc(original.length)) } }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), old); writeFileSync(fixed, original);
    const committed = await catalogAssets(f.dir, { importId: changed.importId }, { hooks: { afterIndexCommitted: async () => { throw new Error('fictional postcommit failure'); } } }).catch((e: any) => e.receipt);
    assert.equal(committed.status, 'succeeded'); assert.equal(committed.indexCommitted, true); await verifyCatalog(f.dir, committed.catalogId); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});
