import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Canvas, FontLibrary } from 'skia-canvas';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { importOriginals } from '../src/application/import.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { assertCatalog, DEFAULT_INSPECT_POLICY, INSPECT_POLICY_06 } from '../src/project/catalog.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { makeZip } from './fixtures/zip.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex'), json = (path: string) => JSON.parse(readFileSync(path, 'utf8')),
  save = (path: string, value: unknown) => writeFileSync(path, importJsonText(value)), evidence = (asset: any, kind: string) => asset.technical.evidence.find((e: any) => e.kind === kind);
function alphaImage() {
  const chunk = (name: string, data: Buffer) => { const header = Buffer.alloc(8), crc = Buffer.alloc(4); header.writeUInt32BE(data.length); header.write(name, 4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name), data]))); return Buffer.concat([header, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0, 90, 30, 80, 128, 7, 8, 9, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function embedded(bytes: Buffer, copies = 1, target = 'media/picture.png') {
  return makeZip([{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>正文</w:t></w:r>${Array.from({ length: copies }, () => '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="picture"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>').join('')}</w:p></w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="picture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>` }, { name: 'word/media/picture.png', data: bytes }]);
}
function policy(dir: string, documentOcr = {}, common = {}) { save(join(dir, 'inputs/inspect-policy.json'), { ...INSPECT_POLICY_06, ...common, documentOcr: { ...INSPECT_POLICY_06.documentOcr, enabled: true, docxImages: [1], ...documentOcr } }); }
function fixture(source = embedded(alphaImage())) {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true }); const root = realpathSync(mkdtempSync(join(output, 'catalog-document-ocr-'))),
    dir = initProject({ slug: 'catalog-document-ocr', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected'); mkdirSync(selected); mkdirSync(join(dir, 'inputs'), { recursive: true });
  cpSync(PROJECT_ROOT, join(dir, '.engine'), { recursive: true, filter: path => !['test', '.research', 'projects', 'assets/asr'].some(prefix => relative(PROJECT_ROOT, path) === prefix || relative(PROJECT_ROOT, path).startsWith(prefix + '/')) });
  writeFileSync(join(selected, 'sample.docx'), source); policy(dir); return { root, dir, selected, source, import: () => importOriginals(dir, selected), cleanup: () => { if (process.env.DOCUMENT_OCR_KEEP_FIXTURES === '1') console.log(`PRESERVED_DOCUMENT_OCR_SCENE:${root}`); else rmSync(root, { recursive: true, force: true }); } };
}
async function failed(dir: string, selection: any, options = {}) { let error; try { await catalogAssets(dir, selection, options); } catch (e) { error = e; } assert.ok(error instanceof CatalogFailure, String(error)); assertCatalog('receipt', error.receipt); assert.equal(error.receipt.indexCommitted, false); return error.receipt; }
function observation(asset: any, map: any, selectionId: string) {
  const r = map.regions[0]; return { version: '0.6', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256,
    method: 'selected document OCR region', locator: { kind: 'document-ocr', evidenceId: map.text.evidenceId, mapEvidenceId: evidence(asset, 'document-ocr-map').id,
      selectionMapEvidenceId: selectionId, rasterEvidenceId: map.raster.evidenceId, unitId: map.unitId, regionId: r.id, byteStart: r.byteStart, byteEnd: r.byteEnd },
    coverage: 'full', coverageScope: 'region-ocr-text', statement: 'The selected region contains fixed OCR text.', basis: 'observed', confidence: 0.5, limitations: ['OCR recognition can contain errors.'],
    evidenceRefs: [map.text.evidenceId, evidence(asset, 'document-ocr-map').id, selectionId, map.raster.evidenceId] };
}

test('document OCR catalog keeps native text, white pixels and closed original invocation', async () => {
  const f = fixture(); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!;
    assert.equal(m.version, '0.6'); assert.equal(a.technical.documentOcr!.status, 'completed'); assert.equal(a.technical.documentOcr!.nativeStatus, 'partial'); assert.equal(a.technical.evidence.length, 7);
    assert.equal(readFileSync(join(f.dir, evidence(a, 'text').path), 'utf8'), '正文'); const selection = json(join(f.dir, evidence(a, 'document-ocr-selection-map').path)), unit = selection.units[0], journal = json(join(f.dir, unit.invocation.path));
    assert.equal(journal.inspectionId, a.inspectionId); assert.equal(journal.unitId, unit.id); assert.equal(journal.request.sourceSha256, a.source.sha256); assert.equal(journal.workerResult.locator.embeddedSha256, sha(alphaImage()));
    assert.deepEqual(readFileSync(join(f.dir, evidence(a, 'document-ocr-raster').path)), Buffer.concat([Buffer.from('P6\n3 1\n255\n'), Buffer.from([255, 255, 255, ...[90, 30, 80].map(c => Math.floor((c * 128 + 255 * 127 + 127) / 255)), 7, 8, 9])]));
    const before = readFileSync(join(f.dir, 'assets/catalog.json')), original = readFileSync(join(f.dir, unit.invocation.path)); journal.request.unit++; save(join(f.dir, unit.invocation.path), journal); await assert.rejects(verifyCatalog(f.dir, r.catalogId), /COMMAND|CHANGED/); writeFileSync(join(f.dir, unit.invocation.path), original); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
  } finally { f.cleanup(); }
});
test('document OCR same source policy changes create versions under the same asset ID and preserve history', async () => {
  const f = fixture(); try {
    save(join(f.dir, 'inputs/inspect-policy.json'), DEFAULT_INSPECT_POLICY); const imported = await f.import(), old = await catalogAssets(f.dir, { importId: imported.importId }), original = await verifyCatalog(f.dir, old.catalogId), frozen = readFileSync(join(f.dir, old.manifestPath!));
    policy(f.dir); const enabled = await catalogAssets(f.dir, { importId: imported.importId }), current = await verifyCatalog(f.dir, enabled.catalogId); assert.equal(current.assets.length, 2); assert.equal(current.assets[0]!.assetId, current.assets[1]!.assetId); assert.notEqual(current.assets[0]!.assetVersion, current.assets[1]!.assetVersion);
    const duplicate = await catalogAssets(f.dir, { importId: imported.importId }); assert.equal(duplicate.assets.length, 0);
    policy(f.dir, { enabled: false }); const disabled = await catalogAssets(f.dir, { importId: imported.importId }), changed = await verifyCatalog(f.dir, disabled.catalogId); assert.equal(changed.assets.length, 3); assert.equal(changed.assets.at(-1)!.technical.documentOcr!.status, 'disabled'); assert.equal(changed.assets.at(-1)!.technical.evidence.length, 2);
    policy(f.dir); const returned = await catalogAssets(f.dir, { importId: imported.importId }); assert.equal(returned.assets.length, 1); assert.equal(returned.assets[0]!.assetId, original.assets[0]!.assetId);
    assert.deepEqual(readFileSync(join(f.dir, old.manifestPath!)), frozen); await verifyCatalog(f.dir, old.catalogId);
  } finally { f.cleanup(); }
});
test('document OCR real bilingual regions use 0.6 locators and preserve native observations', async () => {
  FontLibrary.use('DocumentOcrCatalogTest', [join(PROJECT_ROOT, 'assets/fonts/LXGWWenKai-Regular.ttf')]); const canvas = new Canvas(1001, 301, { gpu: false }), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1001, 301); ctx.fillStyle = 'black'; ctx.font = '72px DocumentOcrCatalogTest'; ctx.fillText('中文 ALPHA 123', 40, 155);
  const f = fixture(embedded(await canvas.toBuffer('png'))); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId }), a = first.assets[0]!, map = json(join(f.dir, evidence(a, 'document-ocr-map').path)), text = readFileSync(join(f.dir, evidence(a, 'document-ocr-text').path)); assert.match(text.toString(), /ALPHA/); assert.match(text.toString().replace(/\s/g, ''), /中文/);
    const record = observation(a, map, a.technical.documentOcr!.mapEvidenceId!); save(join(f.dir, 'inputs/observation.json'), record); const accepted = await catalogAssets(f.dir, { observation: 'inputs/observation.json' }); assert.deepEqual((await verifyCatalog(f.dir, accepted.catalogId)).observations, [record]);
    const before = readFileSync(join(f.dir, 'assets/catalog.json')); for (const changed of [{ regionId: 'missing' }, { selectionMapEvidenceId: record.locator.mapEvidenceId }, { byteEnd: record.locator.byteEnd + 1 }]) { save(join(f.dir, 'inputs/observation.json'), { ...record, id: `observation-${randomUUID()}`, locator: { ...record.locator, ...changed } }); await failed(f.dir, { observation: 'inputs/observation.json' }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before); }
    const nativeMap = json(join(f.dir, evidence(a, 'document-map').path)), unit = nativeMap.units.find((u: any) => u.byteEnd > u.byteStart), native = { ...record, version: '0.2', id: `observation-${randomUUID()}`, locator: { kind: 'document', evidenceId: evidence(a, 'text').id, mapEvidenceId: evidence(a, 'document-map').id, unitId: unit.id, byteStart: unit.byteStart, byteEnd: unit.byteEnd }, coverageScope: 'unit-native-text', evidenceRefs: [evidence(a, 'text').id, evidence(a, 'document-map').id] };
    save(join(f.dir, 'inputs/native.json'), native); const n = await catalogAssets(f.dir, { observation: 'inputs/native.json' }); await verifyCatalog(f.dir, n.catalogId);
  } finally { f.cleanup(); }
});
test('document OCR local source and OCR limits retain native evidence while global quotas roll back index', async () => {
  const f = fixture(embedded(alphaImage(), 2)); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId }); const before = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const options of [{ maxSourceBytes: f.source.length - 1 }, { maxEdge: 2 }, { ocr: { ...INSPECT_POLICY_06.documentOcr.ocr, maxOcrTsvBytes: 1 } }, { ocr: { ...INSPECT_POLICY_06.documentOcr.ocr, maxOcrMapBytes: 1 } }]) {
      policy(f.dir, options); const r = await catalogAssets(f.dir, { importId: imported.importId }), a = r.assets[0]!; assert.equal(a.technical.documentOcr!.status, 'failed', a.technical.reason); assert.equal(a.technical.evidence.length, 3); await verifyCatalog(f.dir, r.catalogId);
    }
    const stable = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const options of [{ docxImages: [1, 2], maxUnitsPerAttempt: 1 }, { docxImages: [1, 2], maxTotalPixels: 5 }, { docxImages: [1, 2], maxTotalEmbeddedBytes: 2 * alphaImage().length - 1 }]) { policy(f.dir, options); await failed(f.dir, { importId: imported.importId }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), stable); }
    assert.ok(before.length); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});
test('document OCR coordinated raster and locator changes fail against rebuilt original pixels', async () => {
  const f = fixture(); try {
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), a = r.assets[0]!, rasterFile = evidence(a, 'document-ocr-raster'), mapFile = evidence(a, 'document-ocr-map'), manifestPath = join(f.dir, r.manifestPath!), indexPath = join(f.dir, 'assets/catalog.json'), receiptPath = join(f.dir, 'runs', r.attemptId, 'receipt.json');
    const paths = [join(f.dir, rasterFile.path), join(f.dir, mapFile.path), manifestPath, indexPath, receiptPath], originals = paths.map(path => readFileSync(path));
    const manifest = JSON.parse(originals[2]!.toString()), receipt = JSON.parse(originals[4]!.toString()), map = JSON.parse(originals[1]!.toString()), raster = Buffer.from(originals[0]!); raster[raster.length - 1] ^= 1; writeFileSync(paths[0]!, raster); map.raster.sha256 = sha(raster); save(paths[1]!, map);
    for (const version of [manifest.assets[0], receipt.assets[0]]) for (const kind of ['document-ocr-raster', 'document-ocr-map']) { const e = evidence(version, kind), bytes = readFileSync(join(f.dir, e.path)); e.bytes = bytes.length; e.sha256 = sha(bytes); }
    save(manifestPath, manifest); save(receiptPath, receipt); const idx = JSON.parse(originals[3]!.toString()); idx.catalogs[0].manifestSha256 = sha(readFileSync(manifestPath)); save(indexPath, idx); await assert.rejects(verifyCatalog(f.dir, r.catalogId), /DOCUMENT_OCR.*REPLAY/);
    paths.forEach((path, i) => writeFileSync(path, originals[i]!)); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});
test('document OCR cancellation, changed source and competing index preserve publication identity', async () => {
  const f = fixture(); try {
    const imported = await f.import(), first = await catalogAssets(f.dir, { importId: imported.importId }), before = readFileSync(join(f.dir, 'assets/catalog.json')); policy(f.dir, { dpi: 150 });
    const controller = new AbortController(); const interrupted = await failed(f.dir, { importId: imported.importId }, { signal: controller.signal, hooks: { afterInspection: async () => controller.abort() } }); assert.equal(interrupted.status, 'interrupted'); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
    const path = join(f.dir, first.assets[0]!.source.fixedPath); await failed(f.dir, { importId: imported.importId }, { hooks: { afterInspection: async () => { const bytes = Buffer.from(f.source); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes); } } }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before); writeFileSync(path, f.source);
    const competing = Buffer.concat([before, Buffer.from('\n')]); const conflict = await failed(f.dir, { importId: imported.importId }, { hooks: { onPhase: async (r: any) => { if (r.phase === 'committing') writeFileSync(join(f.dir, 'assets/catalog.json'), competing); } } });
    assert.match(conflict.error!, /INDEX_CHANGED/); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), competing); writeFileSync(join(f.dir, 'assets/catalog.json'), before);
    const result = await catalogAssets(f.dir, { importId: imported.importId }); await verifyCatalog(f.dir, result.catalogId); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});
