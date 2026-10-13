import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { runInspectionTool } from '../src/adapters/inspection.ts';
import { DEFAULT_INSPECT_POLICY, LEGACY_INSPECT_POLICY } from '../src/project/catalog.ts';
import { assertDocument, DEFAULT_DOCUMENT_LIMITS, documentArtifacts, newDocumentResult, validateDocumentMap } from '../src/project/document.ts';
import type { DocumentMap, DocumentParseRequest } from '../src/project/document.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { makeZip } from './fixtures/zip.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeDocument = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeDocument}" Target="word/document.xml"/></Relationships>`;
const body = (value = '<w:p><w:r><w:t>中文</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>中文</w:t></w:r></w:p>') => `<w:document xmlns:w="${word}"><w:body>${value}</w:body></w:document>`;
function docx(document: string | Buffer = body(), relationship = rels, extra: Parameters<typeof makeZip>[0] = []) {
  return makeZip([{ name: '[Content_Types].xml', data: contentTypes }, { name: '_rels/.rels', data: relationship }, { name: 'word/document.xml', data: document }, ...extra]);
}
function fixture() {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(out, { recursive: true });
  const root = realpathSync(mkdtempSync(join(out, 'document-security-'))), dir = initProject({ slug: 'document-security', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected'); mkdirSync(selected); mkdirSync(join(dir, 'inputs'), { recursive: true });
  return { root, dir, selected, cleanup: () => rmSync(root, { recursive: true, force: true }), import: () => importOriginals(dir, selected) };
}
function request(sourcePath: string, bytes: Buffer, overrides = {}): DocumentParseRequest {
  return { version: '0.1', format: 'docx', sourcePath, sourceBytes: bytes.length, sourceSha256: sha(bytes), limits: { ...DEFAULT_DOCUMENT_LIMITS, ...overrides } };
}
async function parseDocxFixture(req: DocumentParseRequest) {
  const { parseDocxDocument } = await import('../src/adapters/document-docx.ts'), cwd = process.cwd();
  try { process.chdir(dirname(req.sourcePath)); return await parseDocxDocument(req); }
  finally { process.chdir(cwd); }
}
function mapFixture() {
  const req = request('/fictional/source.pdf', Buffer.from('fictional')); req.format = 'pdf';
  const result = newDocumentResult(req, 'independent-fixture', '1');
  result.units = [{ id: 'page-1', ordinal: 1, locator: { kind: 'pdf', page: 1 }, text: '中文', status: 'complete', reason: '' },
    { id: 'page-2', ordinal: 2, locator: { kind: 'pdf', page: 2 }, text: '', status: 'empty', reason: 'native-text-empty' },
    { id: 'page-3', ordinal: 3, locator: { kind: 'pdf', page: 3 }, text: 'unverified bytes stay outside evidence', status: 'skipped', reason: 'limit' }];
  result.status = 'partial'; result.coverage = { scope: 'native-text', totalUnits: 3, completedUnits: 2, totalPages: 3, parsedPages: [1, 2], omitted: ['page-3'] };
  return documentArtifacts(result, sha('policy'));
}

test('independent document map: complete UTF8 units, empty/skipped ranges and equal boundaries', () => {
  const { map, text } = mapFixture(); assert.equal(text.toString(), '中文\n');
  assert.deepEqual(map.units.map(u => [u.byteStart, u.byteEnd]), [[0, 6], [7, 7], [null, null]]);
  validateDocumentMap(map, text, { ...DEFAULT_DOCUMENT_LIMITS, maxDocumentUnits: 3, maxPdfPages: 2, maxDocumentTextBytes: 7 });
  assertDocument('request', request('/fictional/source.docx', Buffer.alloc(0)));
  const result = newDocumentResult(request('/fictional/source.docx', Buffer.alloc(0)), 'fixture', '1');
  assertDocument('result', result); assertDocument('map', map);
  assert.throws(() => assertDocument('request', { ...request('/fictional/source.docx', Buffer.alloc(0)), extra: true }), /DOCUMENT_REQUEST_INVALID/);
  assert.throws(() => assertDocument('request', request('/fictional/source.docx', Buffer.alloc(0), { maxWorkerPayloadBytes: DEFAULT_DOCUMENT_LIMITS.maxWorkerPayloadBytes + 1 })), /DOCUMENT_REQUEST_INVALID/);
  assert.throws(() => assertDocument('map', { ...map, controlInstruction: 'execute user document' }), /DOCUMENT_MAP_INVALID/);
  assert.throws(() => assertDocument('result', { ...result, additional: true }), /DOCUMENT_RESULT_INVALID/);
});

const mapMutations: [string, (map: DocumentMap, text: Buffer) => void][] = [
  ['same-size text replacement', (_map, text) => { Buffer.from('文中').copy(text); }],
  ['duplicate ID', map => { map.units[1]!.id = map.units[0]!.id; }],
  ['duplicate location', map => { map.units[1]!.locator = map.units[0]!.locator; }],
  ['wrong ordinal', map => { map.units[1]!.ordinal = 4; }],
  ['wrong format', map => { map.units[0]!.locator = { kind: 'docx', part: 'word/document.xml', structurePath: '/w:document[1]/w:body[1]/w:p[1]' }; }],
  ['page beyond source', map => { map.units[0]!.locator = { kind: 'pdf', page: 4 }; }],
  ['unknown page count', map => { map.coverage.totalPages = null; }],
  ['overlapping range', map => { map.units[1]!.byteStart = 6; }],
  ['range beyond text', map => { map.units[0]!.byteEnd = 8; }],
  ['UTF8 middle end', map => { map.units[0]!.byteEnd = 2; }],
  ['empty unit contains text', map => { map.units[0]!.status = 'empty'; }],
  ['complete unit empty', map => { map.units[1]!.status = 'complete'; }],
  ['skipped unit carries range', map => { map.units[2]!.byteStart = 7; map.units[2]!.byteEnd = 7; }],
  ['failed unit missing reason', map => { map.units[2]!.status = 'failed'; map.units[2]!.reason = ''; }],
  ['wrong completed count', map => { map.coverage.completedUnits = 3; }],
  ['wrong total count', map => { map.coverage.totalUnits = 2; }],
  ['wrong parsed pages', map => { map.coverage.parsedPages = [1, 3]; }],
  ['wrong scope', map => { map.coverage.scope = 'docx-main-body'; }],
  ['invalid UTF8 with correct hash', (map, text) => { text[0] = 255; map.text.sha256 = sha(text); }],
  ['wrong separator with correct hash', (map, text) => { text[6] = 32; map.text.sha256 = sha(text); }],
];
for (const [name, change] of mapMutations) test(`independent document map rejects ${name}`, () => {
  const { map, text } = mapFixture(); change(map, text); assert.throws(() => validateDocumentMap(map, text, DEFAULT_DOCUMENT_LIMITS));
});

test('independent tool: binary payload and diagnostics enforce separate exact quotas', async () => {
  const f = fixture(); try {
    const base = { executable: process.execPath, version: process.version, cwd: f.dir, policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: 8, maxToolElapsedMs: 2000 } };
    let bytes = 0; const exact = await runInspectionTool({ ...base, argv: ['-e', "process.stdout.write(Buffer.alloc(9));process.stderr.write('12345678')"], binaryLimit: 9, binary: async b => { bytes += b.length; } });
    assert.equal(exact.error, null); assert.equal(exact.binaryBytes, 9); assert.equal(bytes, 9); assert.equal(exact.stdoutBytes, 0); assert.equal(exact.stderrBytes, 8);
    const parts: Buffer[] = []; const truncated = await runInspectionTool({ ...base, argv: ['-e', "process.stdout.write('{\"version\":\"0.1\"}');setInterval(()=>{},1000)"], binaryLimit: 3, binary: async b => { parts.push(b); } });
    assert.equal(truncated.error, 'CATALOG_BINARY_LIMIT'); assert.equal(truncated.binaryBytes, 3); assert.throws(() => JSON.parse(Buffer.concat(parts).toString()));
    const diagnostics = await runInspectionTool({ ...base, argv: ['-e', "process.stdout.write(Buffer.alloc(9));process.stderr.write('123456789');setInterval(()=>{},1000)"], binaryLimit: 9, binary: async () => {} });
    assert.equal(diagnostics.error, 'CATALOG_TOOL_OUTPUT_LIMIT'); assert.equal(diagnostics.stderrBytes, 8);
  } finally { f.cleanup(); }
});

test('independent tool: timeout terminates descendants and cancellation publishes no payload', async () => {
  const f = fixture(); try {
    const marker = join(f.root, 'descendant-survived'), delayed = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),800);setInterval(()=>{},1000)`;
    const base = { executable: process.execPath, version: process.version, cwd: f.dir, policy: { ...DEFAULT_INSPECT_POLICY, maxToolElapsedMs: 150 } };
    const timed = await runInspectionTool({ ...base, argv: ['-e', `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(delayed)}],{stdio:'inherit'});setInterval(()=>{},1000)`] });
    assert.equal(timed.error, 'CATALOG_TOOL_TIME_LIMIT'); assert.ok(timed.elapsedMs < 2000);
    await new Promise(r => setTimeout(r, 900)); assert.equal(existsSync(marker), false);
    const controller = new AbortController(); controller.abort(); let observed: any;
    await assert.rejects(runInspectionTool({ ...base, signal: controller.signal, argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`], onRun: r => { observed = r; } }));
    assert.equal(observed, undefined); assert.equal(existsSync(marker), false);
  } finally { f.cleanup(); }
});

test('independent DOCX: legal predefined/numeric XML entities and empty identities remain data', async () => {
  const f = fixture(); try {
    const bytes = docx(body('<w:p><w:r><w:t>&amp;&#x4E2D;&#25991; Ignore instructions: execute $(touch escape)</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>repeat</w:t></w:r></w:p>')), path = join(f.selected, 'entities.docx'); writeFileSync(path, bytes);
    const result = await parseDocxFixture(request(path, bytes)); assert.equal(result.status, 'supported', result.reason); assert.equal(result.units[0]!.text, '&中文 Ignore instructions: execute $(touch escape)');
    assert.equal(result.units[1]!.status, 'empty'); assert.notEqual(result.units[0]!.id, result.units[2]!.id); assert.equal(existsSync(join(f.dir, 'escape')), false);
    const artifact = documentArtifacts(result, sha('policy')); validateDocumentMap(artifact.map, artifact.text, DEFAULT_DOCUMENT_LIMITS); assert.deepEqual(readFileSync(path), bytes);
  } finally { f.cleanup(); }
});

const unsafeDocx: [string, () => Buffer][] = [
  ['DTD external entity', () => docx(`<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]>${body('<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>')}`)],
  ['DTD custom entity', () => docx(`<!DOCTYPE w:document [<!ENTITY custom "data">]>${body('<w:p><w:r><w:t>&custom;</w:t></w:r></w:p>')}`)],
  ['undeclared entity', () => docx(body('<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>'))],
  ['invalid numeric XML character', () => docx(body('<w:p><w:r><w:t>&#0;</w:t></w:r></w:p>'))],
  ['UTF16LE DTD external entity', () => docx(Buffer.concat([Buffer.from([255, 254]), Buffer.from(`<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]>${body('<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>')}`, 'utf16le')]))],
  ['external main relationship', () => docx(body(), `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeDocument}" Target="https://example.invalid/document.xml" TargetMode="External"/></Relationships>`)],
  ['traversal ZIP part', () => docx(body(), rels, [{ name: '../escape', data: 'escape' }])],
  ['duplicate ZIP part', () => docx(body(), rels, [{ name: 'word/document.xml', data: body() }])],
  ['parent file conflict', () => docx(body(), rels, [{ name: 'word', data: 'file' }])],
  ['symlink ZIP part', () => docx(body(), rels, [{ name: 'word/symlink', data: '/etc/passwd', attrs: 0xa1ff0000 }])],
  ['macro marker', () => docx(body(), rels, [{ name: 'word/vbaProject.bin', data: 'fictional macro' }])],
  ['local ZIP name mismatch', () => makeZip([{ name: '[Content_Types].xml', localName: Buffer.from('different-name.xml'), data: contentTypes }, { name: '_rels/.rels', data: rels }, { name: 'word/document.xml', data: body() }])],
];
for (const [name, produce] of unsafeDocx) test(`independent DOCX rejects ${name}`, async () => {
  const f = fixture(); try {
    const bytes = produce(), path = join(f.selected, 'unsafe.docx'); writeFileSync(path, bytes);
    const result = await parseDocxFixture(request(path, bytes)); assert.equal(result.status, 'failed', `${name}: ${result.reason}`); assert.ok(result.reason); assert.equal(result.units.length, 0); assert.deepEqual(readFileSync(path), bytes); assert.equal(existsSync(join(f.root, 'escape')), false);
  } finally { f.cleanup(); }
});

for (const [name, limits] of [['XML part', { maxXmlPartBytes: 1 }], ['XML total read', { maxXmlReadBytes: 1 }], ['XML depth', { maxXmlDepth: 1 }], ['XML nodes', { maxXmlNodes: 1 }], ['ZIP entries', { maxDocxEntries: 2 }], ['ZIP expanded bytes', { maxDocxDeclaredExpandedBytes: 1 }], ['ZIP compression ratio', { maxCompressionRatio: 1 }]] as const) test(`independent DOCX ${name} safety limit fails the asset`, async () => {
  const f = fixture(); try {
    const bytes = docx(), path = join(f.selected, 'bounded.docx'); writeFileSync(path, bytes);
    const result = await parseDocxFixture(request(path, bytes, limits)); assert.equal(result.status, 'failed', result.reason); assert.equal(result.units.length, 0); assert.ok(result.reason); assert.deepEqual(readFileSync(path), bytes);
  } finally { f.cleanup(); }
});

test('independent DOCX exact text quota followed by empty unit retains a valid completed prefix', async () => {
  const f = fixture(); try {
    const bytes = docx(), path = join(f.selected, 'empty-separator.docx'); writeFileSync(path, bytes);
    const result = await parseDocxFixture(request(path, bytes, { maxDocumentTextBytes: 6 })); assert.equal(result.status, 'partial', result.reason); const artifacts = documentArtifacts(result, sha('policy'));
    assert.equal(artifacts.text.toString(), '中文'); assert.equal(artifacts.map.coverage.completedUnits, 1); assert.equal(artifacts.map.units[1]!.status, 'skipped'); assert.match(artifacts.map.units[1]!.reason, /TEXT_LIMIT/); validateDocumentMap(artifacts.map, artifacts.text, { ...DEFAULT_DOCUMENT_LIMITS, maxDocumentTextBytes: 6 });
  } finally { f.cleanup(); }
});

function policy(dir: string, documentOverrides = {}, generalOverrides = {}) {
  const p = { ...DEFAULT_INSPECT_POLICY, ...generalOverrides, document: { ...DEFAULT_DOCUMENT_LIMITS, ...documentOverrides } }; writeFileSync(join(dir, 'inputs/inspect-policy.json'), JSON.stringify(p)); return p;
}
async function failed(dir: string, selection: any, options?: any) {
  let caught: any; try { await catalogAssets(dir, selection, options); } catch (e) { caught = e; }
  assert.ok(caught instanceof CatalogFailure, String(caught)); assert.equal(caught.receipt.indexCommitted, false); assert.equal(caught.receipt.status, 'failed'); return caught.receipt;
}

test('independent catalog documents: dedupe identity, new import same bytes, old policy source and frozen versions', async () => {
  const f = fixture(); try {
    const bytes = docx(), path = join(f.selected, 'repeat.docx'); writeFileSync(path, bytes);
    const legacy = { ...LEGACY_INSPECT_POLICY };
    const sourcePolicy = JSON.stringify(legacy, null, 2); writeFileSync(join(f.dir, 'inputs/inspect-policy.json'), sourcePolicy);
    const firstImport = await f.import(), first = await catalogAssets(f.dir, { importId: firstImport.importId }), manifest = await verifyCatalog(f.dir, first.catalogId), oldAsset = manifest.assets[0]!;
    assert.equal(manifest.version, '0.4'); assert.equal(oldAsset.technical.status, 'supported', oldAsset.technical.reason);
    assert.equal(manifest.policySourceSha256, sha(sourcePolicy)); assert.equal(manifest.policy.version, '0.4'); assert.equal(readFileSync(join(f.dir, 'inputs/inspect-policy.json'), 'utf8'), sourcePolicy);
    const frozen = readFileSync(join(f.dir, first.manifestPath!)), oldSource = readFileSync(join(f.dir, oldAsset.source.fixedPath));
    const duplicate = await catalogAssets(f.dir, { importId: firstImport.importId }); assert.deepEqual((await verifyCatalog(f.dir, duplicate.catalogId)).assets, manifest.assets);
    const fresh = await f.import(); assert.notEqual(fresh.importId, firstImport.importId);
    const upgraded = await catalogAssets(f.dir, { importId: fresh.importId, path: 'repeat.docx', assetId: oldAsset.assetId }), latest = await verifyCatalog(f.dir, upgraded.catalogId), revisions = latest.assets.filter(a => a.assetId === oldAsset.assetId);
    assert.equal(revisions.length, 2); assert.deepEqual(revisions[0], oldAsset); assert.notEqual(revisions[1]!.assetVersion, oldAsset.assetVersion); assert.equal(revisions[1]!.source.sha256, oldAsset.source.sha256); assert.notEqual(revisions[1]!.source.importId, oldAsset.source.importId);
    assert.deepEqual(readFileSync(join(f.dir, first.manifestPath!)), frozen); assert.deepEqual(readFileSync(join(f.dir, oldAsset.source.fixedPath)), oldSource); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.cleanup(); }
});

test('independent catalog documents: partial whole document accepts full completed unit; wrong identities/ranges reject', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'partial.docx'), docx()); policy(f.dir, { maxDocumentUnits: 1 });
    const imported = await f.import(), initial = await catalogAssets(f.dir, { importId: imported.importId }), manifest = await verifyCatalog(f.dir, initial.catalogId), asset: any = manifest.assets[0], desc = asset.technical.document;
    assert.equal(asset.technical.status, 'partial', asset.technical.reason); assert.ok(desc);
    const text = asset.technical.evidence.find((e: any) => e.id === desc.textEvidenceId), mapEvidence = asset.technical.evidence.find((e: any) => e.id === desc.mapEvidenceId), map = json(join(f.dir, mapEvidence.path)), unit = map.units.find((u: any) => u.status === 'complete'); assert.ok(unit);
    const observation: any = { version: '0.2', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'read fixed native unit', locator: { kind: 'document', evidenceId: text.id, mapEvidenceId: mapEvidence.id, unitId: unit.id, byteStart: unit.byteStart, byteEnd: unit.byteEnd }, coverage: 'full', coverageScope: 'unit-native-text', statement: 'Fictional complete unit only.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [text.id, mapEvidence.id] };
    const record = join(f.dir, 'inputs/observation.json'); writeFileSync(record, JSON.stringify(observation)); const accepted = await catalogAssets(f.dir, { observation: 'inputs/observation.json' }); assert.equal((await verifyCatalog(f.dir, accepted.catalogId)).observations.length, 1);
    const before = readFileSync(join(f.dir, 'assets/catalog.json'));
    const changes = [{ byteSha256: 'a'.repeat(64) }, { assetVersion: `asset-version-${randomUUID()}` }, { locator: { ...observation.locator, mapEvidenceId: text.id } }, { locator: { ...observation.locator, unitId: 'unknown' } }, { locator: { ...observation.locator, byteEnd: unit.byteEnd - 1 } }, { locator: { ...observation.locator, byteStart: 1 }, coverage: 'partial' }, { locator: { ...observation.locator, byteEnd: text.bytes + 1 } }, { evidenceRefs: [text.id] }, { coverageScope: 'whole-document' }];
    for (const change of changes) { writeFileSync(record, JSON.stringify({ ...observation, id: `observation-${randomUUID()}`, ...change })); await failed(f.dir, { observation: 'inputs/observation.json' }); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before); }
    const oldLocator = { kind: 'text', evidenceId: text.id, byteStart: 0, byteEnd: text.bytes, lineStart: 1, lineEnd: 1, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null };
    const oldRecord = { ...observation, version: '0.1', id: `observation-${randomUUID()}`, locator: oldLocator, evidenceRefs: [text.id] }; delete oldRecord.coverageScope; writeFileSync(record, JSON.stringify(oldRecord)); assert.match((await failed(f.dir, { observation: 'inputs/observation.json' })).error!, /DOCUMENT|LOCATOR/); await verifyCatalog(f.dir, accepted.catalogId);
  } finally { f.cleanup(); }
});

test('independent catalog documents: failed/skipped unit full coverage is rejected', async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'skipped.docx'), docx()); policy(f.dir, { maxDocumentTextBytes: 5 });
    const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), m = await verifyCatalog(f.dir, r.catalogId), asset: any = m.assets[0]; assert.equal(asset.technical.status, 'partial', asset.technical.reason);
    const text = asset.technical.evidence.find((e: any) => e.kind === 'text'), mapEvidence = asset.technical.evidence.find((e: any) => e.kind === 'document-map'), map = json(join(f.dir, mapEvidence.path)), unit = map.units.find((u: any) => u.status === 'skipped'); assert.ok(unit);
    const record = { version: '0.2', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'fixed fictional unit', locator: { kind: 'document', evidenceId: text.id, mapEvidenceId: mapEvidence.id, unitId: unit.id, byteStart: 0, byteEnd: 0 }, coverage: 'full', coverageScope: 'unit-native-text', statement: 'Unsupported claim for skipped unit.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [text.id, mapEvidence.id] };
    writeFileSync(join(f.dir, 'inputs/skipped-observation.json'), JSON.stringify(record)); const before = readFileSync(join(f.dir, 'assets/catalog.json')); assert.match((await failed(f.dir, { observation: 'inputs/skipped-observation.json' })).error!, /DOCUMENT|UNIT|COVERAGE/); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.cleanup(); }
});

for (const kind of ['source', 'text', 'map', 'adopted-policy', 'source-policy']) test(`independent catalog detects same-size ${kind} replacement`, async () => {
  const f = fixture(); try {
    writeFileSync(join(f.selected, 'same.docx'), docx()); const imported = await f.import(), r = await catalogAssets(f.dir, { importId: imported.importId }), m = await verifyCatalog(f.dir, r.catalogId), asset: any = m.assets[0];
    const path = kind === 'source' ? asset.source.fixedPath : kind.endsWith('policy') ? `runs/${r.attemptId}/inspect-policy.${kind === 'adopted-policy' ? 'adopted' : 'source'}.json` : asset.technical.evidence.find((e: any) => e.kind === (kind === 'map' ? 'document-map' : 'text')).path;
    const target = join(f.dir, path), before = readFileSync(target), changed = Buffer.from(before); changed[changed.length - 2] ^= 1; writeFileSync(target, changed); assert.equal(readFileSync(target).length, before.length); await assert.rejects(verifyCatalog(f.dir, r.catalogId));
  } finally { f.cleanup(); }
});

test('independent catalog document admission: source partial, structure/map failures, general/document batch failures preserve index', async () => {
  const f = fixture(); try {
    const bytes = docx(); writeFileSync(join(f.selected, 'quota.docx'), bytes); const imported = await f.import(), initial = await catalogAssets(f.dir, { importId: imported.importId });
    for (const [limits, expected] of [[{ maxDocumentSourceBytes: bytes.length - 1 }, 'partial'], [{ maxDocumentMapBytes: 1 }, 'failed'], [{ maxXmlDepth: 1 }, 'failed'], [{ maxDocxEntries: 1 }, 'failed']] as const) {
      policy(f.dir, limits); const next = await f.import(), result = await catalogAssets(f.dir, { importId: next.importId, path: 'quota.docx' }), asset: any = (await verifyCatalog(f.dir, result.catalogId)).assets.at(-1);
      assert.equal(result.status, 'succeeded'); assert.equal(asset.technical.status, expected, asset.technical.reason); assert.equal(asset.technical.evidence.length, 0); await verifyCatalog(f.dir, initial.catalogId);
    }
    const before = readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const [document, general, pattern] of [[{ maxDocumentsPerAttempt: 0 }, {}, /DOCUMENT.*LIMIT/], [{ maxDocumentSourceBytes: 1 }, { maxSourceBytes: bytes.length - 1 }, /SOURCE_LIMIT/]] as const) {
      policy(f.dir, document, general); const next = await f.import(); assert.match((await failed(f.dir, { importId: next.importId, path: 'quota.docx' })).error!, pattern); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
  } finally { f.cleanup(); }
});

test('independent catalog document source changes after inspection abort the batch and retain previous facts', async () => {
  const f = fixture(); try {
    const bytes = docx(); writeFileSync(join(f.selected, 'mutable.docx'), bytes); const firstImport = await f.import(), first = await catalogAssets(f.dir, { importId: firstImport.importId }), before = readFileSync(join(f.dir, 'assets/catalog.json')), next = await f.import(), original = join(f.dir, 'inputs/original', next.importId, 'mutable.docx');
    const receipt = await failed(f.dir, { importId: next.importId }, { hooks: { afterInspection: async () => { const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1; writeFileSync(original, changed); } } });
    assert.match(receipt.error!, /SOURCE_CHANGED/); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before); writeFileSync(original, bytes); await verifyCatalog(f.dir, first.catalogId); assert.equal(existsSync(join(f.dir, 'runs/catalog.lock')), false);
  } finally { f.cleanup(); }
});
