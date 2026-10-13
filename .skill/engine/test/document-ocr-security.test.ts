import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { documentRasterRuntimeIdentity } from '../workspace.mjs';
import { DEFAULT_DOCUMENT_LIMITS } from '../src/project/document.ts';
import { DEFAULT_OCR_LIMITS } from '../src/project/ocr.ts';
import { DEFAULT_DOCUMENT_RASTER_LIMITS, type DocumentRasterRequest } from '../src/project/document-ocr.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { DEFAULT_INSPECT_POLICY, INSPECT_POLICY_06, emptyCatalogCounts } from '../src/project/catalog.ts';
import type { InspectContext } from '../src/adapters/inspection.ts';
import { initProject } from '../src/project/scaffold.ts';
import { importOriginals } from '../src/application/import.ts';
import { CatalogFailure, catalogAssets, verifyCatalog } from '../src/application/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { assertDocumentOcr, INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS, validateDocumentOcrObservation,
  validateDocumentOcrSelectionMap, validateDocumentOcrUnitMap, type DocumentOcrPolicy,
  type DocumentOcrSelectionMap, type DocumentOcrUnitMap, type DocumentOcrObservation } from '../src/project/document-ocr.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const id = () => `evidence-${randomUUID()}`;
const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const row = (...cells: (string | number)[]) => cells.join('\t');
function fixture(format: 'pdf' | 'docx' = 'pdf') {
  const lockBytes = readFileSync(new URL('../ocr-dependencies.lock.json', import.meta.url)), lock = JSON.parse(lockBytes.toString());
  const engine = { id: 'tesseract' as const, version: '5.5.0' as const, lockSha256: sha(lockBytes), platform: lock.platform, arch: lock.arch,
    tools: lock.tools, models: lock.models, languageSpec: lock.languageSpec, oem: lock.oem, psm: lock.psm, dpi: lock.dpi };
  const runtime = { id: 'bounded-document-raster' as const, version: '0.1' as const, platform: 'darwin' as const, arch: 'arm64' as const,
    node: { version: 'v24.19.0', executable: '/fictional/node', bytes: 1, sha256: sha('node'), files: [
      { path: '/fictional/libnode.dylib', bytes: 1, sha256: sha('libnode') }, { path: '/fictional/node', bytes: 1, sha256: sha('node') }] }, files: [{ path: 'src/fixed.ts', bytes: 1, sha256: sha('fixed') }] };
  const policy: DocumentOcrPolicy = { ...INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS, enabled: true, dpi: 72, pdfPages: [3], docxImages: [3], ocr: { ...INSPECT_POLICY_06_DOCUMENT_OCR_DEFAULTS.ocr } };
  const text = Buffer.from('中文 same same'), raster = Buffer.concat([Buffer.from('P6\n64 48\n255\n'), Buffer.alloc(64 * 48 * 3, 255)]);
  const rows = [row(1, 1, 0, 0, 0, 0, 0, 0, 64, 48, -1, ''), row(2, 1, 1, 0, 0, 0, 0, 0, 64, 48, -1, ''),
    row(3, 1, 1, 1, 0, 0, 0, 0, 64, 48, -1, ''), row(4, 1, 1, 1, 1, 0, 0, 0, 64, 8, -1, ''),
    row(5, 1, 1, 1, 1, 1, 1, 1, 10, 6, 0, '中文'), row(5, 1, 1, 1, 1, 2, 12, 1, 10, 6, 0.125, 'same'), row(5, 1, 1, 1, 1, 3, 23, 1, 10, 6, -1, 'same')];
  const tsv = Buffer.from([HEADER, ...rows].join('\n') + '\n');
  const tool = { executable: '/fictional/tool', version: 'fictional@1', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 0, error: null };
  const locator = format === 'pdf' ? { kind: 'pdf-page' as const, page: 3, viewBox: [0, 0, 64, 48], userUnit: 1, rotation: 0 as const, dpi: 72 as const, scale: 1, transform: [1, 0, 0, -1, 0, 48], width: 64, height: 48 } :
    { kind: 'docx-image' as const, occurrence: 3, mainPart: 'word/document.xml' as const, structurePath: '/w:document[1]/w:body[1]/w:p[3]/w:r[1]/w:drawing[1]', relationshipsPart: 'word/_rels/document.xml.rels' as const,
      relationshipId: 'image1', embeddedPart: 'word/media/fixed.png', embeddedBytes: 100, embeddedSha256: sha('embedded'), embeddedCrc32: 0, format: 'png_pipe' as const, width: 64, height: 48 };
  const map: DocumentOcrUnitMap = { version: '0.1', kind: 'document-ocr-map', format, unitId: 'document-ocr-unit-3', scope: format === 'pdf' ? 'selected-pdf-page-pixels' : 'selected-docx-embedded-source-pixels', mapperVersion: 'ocr-tsv@0.1',
    status: 'text', policySha256: sha('policy'), source: { bytes: 1000, sha256: sha('source') }, runtime, locator,
    raster: { evidenceId: id(), bytes: raster.length, sha256: sha(raster), width: 64, height: 48, encoding: 'P6/RGB8', background: 'white', transform: 'identity', orientationApplied: false },
    rawTsv: { evidenceId: id(), bytes: tsv.length, sha256: sha(tsv) }, text: { evidenceId: id(), bytes: text.length, sha256: sha(text) }, engine,
    regions: [[1, 1, 0, 6, 0], [2, 12, 7, 11, 0.125], [3, 23, 12, 16, null]].map(([ordinal, x, byteStart, byteEnd, engineConfidence]) =>
      ({ id: `ocr-word-${ordinal}`, ordinal: ordinal!, row: ordinal! + 4, level: 5, page: 1, block: 1, paragraph: 1, line: 1, word: ordinal!, x: x!, y: 1, width: 10, height: 6, byteStart: byteStart!, byteEnd: byteEnd!, engineConfidence })),
    commands: { worker: { ...tool }, decode: [], ocr: { ...tool } }, cwd: '/fictional/project/temporary', limitations: ['Fictional independent contract data.'] };
  const selectionMap: DocumentOcrSelectionMap = { version: '0.1', kind: 'document-ocr-selection-map', format, scope: map.scope, status: 'completed', nativeStatus: 'partial', policySha256: map.policySha256, source: map.source,
    selection: [3], totalUnits: 5, completedUnits: 1, runtime, engine, units: [{ id: map.unitId, ordinal: 3, status: 'text', reason: '', locator, mapEvidenceId: id(),
      invocation: { path: `runs/catalog-attempt-${randomUUID()}/document-ocr-command.json`, bytes: 100, sha256: sha('invocation') } }], limitations: [] };
  return { policy, map, selectionMap, text, raster, tsv };
}
type Fixture = ReturnType<typeof fixture>;

test('independent document OCR contracts preserve selected unit, Chinese byte ranges, low scores and duplicate words', () => {
  for (const format of ['pdf', 'docx'] as const) {
    const f = fixture(format); validateDocumentOcrUnitMap(f.map, f.text, f.raster, f.tsv, f.policy); validateDocumentOcrSelectionMap(f.selectionMap, f.policy);
    assert.equal(f.map.unitId, 'document-ocr-unit-3'); assert.deepEqual(f.map.regions.map(r => [r.byteStart, r.byteEnd]), [[0, 6], [7, 11], [12, 16]]);
    assert.deepEqual(f.map.regions.map(r => r.engineConfidence), [0, 0.125, null]); assert.equal(f.selectionMap.nativeStatus, 'partial');
  }
});
const mapChanges: [string, (f: Fixture) => void][] = [
  ['scope', f => { f.map.scope = 'selected-docx-embedded-source-pixels'; }],
  ['cross-format locator', f => { f.map.locator = fixture('docx').map.locator; }],
  ['unit identity', f => { f.map.unitId = 'document-ocr-unit-1'; }],
  ['source admission', f => { f.map.source.bytes = f.policy.maxSourceBytes + 1; }],
  ['DPI policy binding', f => { if (f.map.locator.kind === 'pdf-page') f.map.locator.dpi = 300; }],
  ['scale', f => { if (f.map.locator.kind === 'pdf-page') f.map.locator.scale = 2; }],
  ['zero UserUnit', f => { if (f.map.locator.kind === 'pdf-page') f.map.locator.userUnit = 0; }],
  ['rotation', f => { (f.map.locator as any).rotation = 45; }],
  ['oversized edge', f => { f.policy.maxEdge = 63; }], ['pixel quota', f => { f.policy.maxPixelsPerUnit = 64 * 48 - 1; }],
  ['raster same-size replacement', f => { f.raster[f.raster.length - 1] ^= 1; }],
  ['TSV same-size replacement', f => { f.tsv[f.tsv.length - 2] ^= 1; }],
  ['text same-size replacement', f => { Buffer.from('文中').copy(f.text); }],
  ['duplicate evidence identity', f => { f.map.text.evidenceId = f.map.raster.evidenceId; }],
  ['duplicate region hierarchy', f => { f.map.regions[1]!.word = 1; }],
  ['region bounds', f => { f.map.regions[0]!.x = 63; }],
  ['Chinese UTF8 boundary', f => { f.map.regions[0]!.byteEnd = 5; }],
  ['canonical separator', f => { f.text[6] = 10; f.map.text.sha256 = sha(f.text); }],
  ['status', f => { f.map.status = 'no-text'; }],
  ['native language identity', f => { f.map.engine.models[1]!.sha256 = sha('foreign'); }],
  ['runtime path', f => { f.map.runtime.files[0]!.path = '../source.ts'; }],
  ['runtime duplicate identity', f => { f.map.runtime.files.push({ ...f.map.runtime.files[0]! }); }],
  ['missing physical Node executable', f => { f.map.runtime.node.files.pop(); }],
  ['Node executable bytes binding', f => { f.map.runtime.node.bytes++; }],
  ['duplicate Node dynamic file', f => { f.map.runtime.node.files.unshift({ ...f.map.runtime.node.files[0]! }); }],
  ['nonphysical Node dynamic path', f => { f.map.runtime.node.files[0]!.path = '/fictional/../libnode.dylib'; }],
  ['extra output field', f => { (f.map as any).instructions = 'execute input contents'; }],
];
for (const [name, change] of mapChanges) test(`independent document OCR unit rejects ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => validateDocumentOcrUnitMap(f.map, f.text, f.raster, f.tsv, f.policy));
});
const selectionChanges: [string, (f: Fixture) => void][] = [
  ['cross-format success locator', f => { f.selectionMap.units[0]!.locator = fixture('docx').map.locator; }],
  ['cross-format failed locator', f => { Object.assign(f.selectionMap.units[0]!, { status: 'failed', reason: 'fixture-refusal', mapEvidenceId: null, locator: fixture('docx').map.locator }); f.selectionMap.completedUnits = 0; f.selectionMap.status = 'failed'; }],
  ['changed selection', f => { f.selectionMap.selection = [1]; }], ['wrong ordinal', f => { f.selectionMap.units[0]!.ordinal = 1; }],
  ['missing selected unit', f => { f.selectionMap.units = []; }], ['count', f => { f.selectionMap.completedUnits = 0; }],
  ['failed unit success evidence', f => { f.selectionMap.units[0]!.status = 'failed'; f.selectionMap.units[0]!.reason = 'fixture-refusal'; f.selectionMap.completedUnits = 0; f.selectionMap.status = 'failed'; }],
  ['unknown total with complete unit', f => { f.selectionMap.totalUnits = null; }], ['source quota', f => { f.policy.maxSourceBytes = 999; }],
  ['disabled policy file group', f => { f.policy.enabled = false; }],
  ['missing unit invocation', f => { f.selectionMap.units[0]!.invocation = null; }],
];
for (const [name, change] of selectionChanges) test(`independent document OCR selection rejects ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => validateDocumentOcrSelectionMap(f.selectionMap, f.policy));
});
test('independent selected unit failure preserves location and explicit reason', () => {
  const f = fixture(); Object.assign(f.selectionMap.units[0]!, { status: 'failed', reason: 'DOCUMENT_RASTER_UNIT_REFUSED', mapEvidenceId: null }); f.selectionMap.status = 'failed'; f.selectionMap.completedUnits = 0;
  validateDocumentOcrSelectionMap(f.selectionMap, f.policy); f.selectionMap.units[0]!.reason = ''; assert.throws(() => validateDocumentOcrSelectionMap(f.selectionMap, f.policy));
});
test('independent failed selection records source and unit totals exceeding local admission', () => {
  const f = fixture(); Object.assign(f.selectionMap.units[0]!, { status: 'failed', reason: 'DOCUMENT_RASTER_SOURCE_LIMIT', mapEvidenceId: null, locator: null });
  f.selectionMap.status = 'failed'; f.selectionMap.completedUnits = 0; f.selectionMap.totalUnits = f.policy.maxPdfDocumentPages + 1; f.policy.maxSourceBytes = 0;
  validateDocumentOcrSelectionMap(f.selectionMap, f.policy);
});
test('independent document OCR no-text map retains a complete legal raster/TSV group', () => {
  const f = fixture(), raw = Buffer.from(HEADER + '\n' + row(1, 1, 0, 0, 0, 0, 0, 0, 64, 48, -1, '') + '\n'), text = Buffer.alloc(0);
  f.map.status = 'no-text'; f.map.regions = []; f.map.text.bytes = 0; f.map.text.sha256 = sha(text); f.map.rawTsv.bytes = raw.length; f.map.rawTsv.sha256 = sha(raw);
  validateDocumentOcrUnitMap(f.map, text, f.raster, raw, f.policy); assertDocumentOcr('unit-map', f.map);
});
test('independent OCR observation binds a selected unit, all evidence and complete Chinese region', () => {
  const f = fixture(), selectionMapEvidenceId = id(), mapEvidenceId = f.selectionMap.units[0]!.mapEvidenceId!;
  const record: DocumentOcrObservation = { version: '0.6', id: `observation-${randomUUID()}`, assetId: `asset-${randomUUID()}`, assetVersion: `asset-version-${randomUUID()}`, byteSha256: f.map.source.sha256,
    method: 'fixed region read', locator: { kind: 'document-ocr', evidenceId: f.map.text.evidenceId, mapEvidenceId, selectionMapEvidenceId, rasterEvidenceId: f.map.raster.evidenceId, unitId: f.map.unitId, regionId: 'ocr-word-1', byteStart: 0, byteEnd: 6 },
    coverage: 'full', coverageScope: 'region-ocr-text', statement: 'Fictional selected OCR region only.', basis: 'observed', confidence: 0.5, limitations: [], evidenceRefs: [f.map.text.evidenceId, mapEvidenceId, selectionMapEvidenceId, f.map.raster.evidenceId] };
  validateDocumentOcrObservation(record, f.map, f.text, selectionMapEvidenceId);
  for (const patch of [{ locator: { ...record.locator, unitId: 'document-ocr-unit-1' } }, { locator: { ...record.locator, byteStart: 1 }, coverage: 'partial' },
    { locator: { ...record.locator, byteEnd: 3 } }, { confidence: 50 }, { coverageScope: 'whole-document' }, { evidenceRefs: [mapEvidenceId] },
    { locator: { ...record.locator, selectionMapEvidenceId: id() } }])
    assert.throws(() => validateDocumentOcrObservation({ ...record, ...patch } as DocumentOcrObservation, f.map, f.text, selectionMapEvidenceId));
  validateDocumentOcrObservation({ ...record, locator: { ...record.locator, byteEnd: 3 }, coverage: 'partial' }, f.map, f.text, selectionMapEvidenceId);
});

function assemblePdf(objects: (string | Buffer)[]): Buffer {
  const pieces = [Buffer.from('%PDF-1.7\n% fictional independent security fixture\n')], offsets = [0]; let size = pieces[0]!.length;
  for (let i = 0; i < objects.length; i++) { const bytes = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(objects[i]!), Buffer.from('\nendobj\n')]); pieces.push(bytes); offsets.push(size); size += bytes.length; }
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
const quadrants = '1 0 0 rg 0 0 6 4 re f\n0 1 0 rg 6 0 6 4 re f\n0 0 1 rg 0 4 6 4 re f\n1 1 0 rg 6 4 6 4 re f';
function pdf(content = quadrants, rotate = 0, crop = '', image: Buffer | null = null): Buffer {
  return assemblePdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 12 8] /Rotate ${rotate} ${crop} /Resources << ${image ? '/XObject << /I1 5 0 R >>' : ''} >> /Contents 4 0 R >>`,
    Buffer.concat([Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n`), Buffer.from(content), Buffer.from('\nendstream')]), ...(image ? [image] : [])]);
}
function ppm(width: number, height: number, pixel: (x: number, y: number) => number[]): Buffer {
  const rgb = Buffer.alloc(3 * width * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(rgb, 3 * (y * width + x));
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]);
}
const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
function quadrantOracle(rotate: number): Buffer {
  const width = rotate % 180 ? 8 : 12, height = rotate % 180 ? 12 : 8;
  return ppm(width, height, (x, y) => { const a = x + .5, b = y + .5; let px: number, py: number;
    if (rotate === 0) [px, py] = [a, 8 - b]; else if (rotate === 90) [px, py] = [b, a];
    else if (rotate === 180) [px, py] = [12 - a, b]; else [px, py] = [12 - b, 8 - a];
    return colors[(px >= 6 ? 1 : 0) + (py >= 4 ? 2 : 0)]!; });
}
function sourceFixture(bytes: Buffer, format: 'pdf' | 'docx') {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'independent-document-raster-'))), sourcePath = join(root, 'selected.' + format); writeFileSync(sourcePath, bytes);
  const request: DocumentRasterRequest = { version: '0.1', kind: 'document-raster-request', format, sourcePath, sourceBytes: bytes.length, sourceSha256: sha(bytes), unit: 1, dpi: 72,
    limits: { ...DEFAULT_DOCUMENT_RASTER_LIMITS }, documentLimits: { ...DEFAULT_DOCUMENT_LIMITS }, ocrLimits: { ...DEFAULT_OCR_LIMITS }, runtime: documentRasterRuntimeIdentity() };
  return { root, sourcePath, request, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
async function extract(f: ReturnType<typeof sourceFixture>) {
  const { extractDocumentRaster } = await import('../src/adapters/document-raster-source.ts'), originalCwd = process.cwd();
  try { process.chdir(f.root); return await extractDocumentRaster(f.request); }
  finally { process.chdir(originalCwd); }
}
test('independent source identity and physical Node dynamic hash changes remain fatal', async () => {
  const bytes = pdf(), f = sourceFixture(bytes, 'pdf'); try {
    const original = f.request.sourceSha256; f.request.sourceSha256 = sha('different source'); await assert.rejects(extract(f), /CATALOG_SOURCE_CHANGED/); f.request.sourceSha256 = original;
    const file = f.request.runtime.node.files.find(file => file.path !== f.request.runtime.node.executable) ?? f.request.runtime.node.files[0]!;
    file.sha256 = sha('different physical Node file'); if (file.path === f.request.runtime.node.executable) f.request.runtime.node.sha256 = file.sha256;
    await assert.rejects(extract(f), /DOCUMENT_RASTER_RUNTIME_CHANGED/); assert.deepEqual(readFileSync(f.sourcePath), bytes);
  } finally { f.cleanup(); }
});
for (const rotate of [0, 90, 180, 270]) test(`independent source PDF Rotate${rotate} matches all mathematical PPM bytes`, async () => {
  const bytes = pdf(quadrants, rotate), f = sourceFixture(bytes, 'pdf'); try {
    const result = await extract(f); assert.equal(result.status, 'complete', result.reason); assert.equal(result.payload!.format, 'ppm');
    assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), quadrantOracle(rotate)); assert.equal(result.totalUnits, 1); assert.deepEqual(readFileSync(f.sourcePath), bytes);
  } finally { f.cleanup(); }
});
test('independent source PDF CropBox matches all mathematical PPM bytes', async () => {
  const f = sourceFixture(pdf(quadrants, 0, '/CropBox [3 2 9 6]'), 'pdf'); try {
    const result = await extract(f); assert.equal(result.status, 'complete', result.reason);
    assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), ppm(6, 4, (x, y) => colors[(x >= 3 ? 1 : 0) + (y < 2 ? 2 : 0)]!));
    assert.deepEqual((result.locator as any).viewBox, [3, 2, 9, 6]);
  } finally { f.cleanup(); }
});
function imageStream(data: Buffer, fields: string): Buffer { return Buffer.concat([Buffer.from(`<< /Length ${data.length} /Type /XObject /Subtype /Image ${fields} >>\nstream\n`), data, Buffer.from('\nendstream')]); }
const pdfRefusals: [string, Buffer][] = [
  ['external image stream', pdf('q /I1 Do Q', 0, '', imageStream(Buffer.from([0, 0, 0]), '/Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /F (file:///fictional/secret)'))],
  ['escaped external stream name', pdf('q /I1 Do Q', 0, '', imageStream(Buffer.from([0, 0, 0]), '/Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /#46 (file:///fictional/secret)'))],
  ['JPX decoding', pdf('q /I1 Do Q', 0, '', imageStream(Buffer.from('0000000c6a5020200d0a870a', 'hex'), '/Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode'))],
  ['truncated raw image', pdf('q /I1 Do Q', 0, '', imageStream(Buffer.from([255]), '/Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8'))],
  ['huge empty image', pdf('q /I1 Do Q', 0, '', imageStream(Buffer.alloc(0), '/Width 2147483647 /Height 2147483647 /ColorSpace /DeviceRGB /BitsPerComponent 8'))],
];
for (const [name, bytes] of pdfRefusals) test(`independent source PDF refuses ${name}`, async () => {
  const f = sourceFixture(bytes, 'pdf'); try { const result = await extract(f); assert.equal(result.status, 'failed', name + ': ' + result.reason); assert.equal(result.payload, null); assert.ok(result.reason); assert.deepEqual(readFileSync(f.sourcePath), bytes); } finally { f.cleanup(); }
});
test('independent source PDF admits exact raster/source/pixel limits and refuses one below', async () => {
  const bytes = pdf(), f = sourceFixture(bytes, 'pdf'); try {
    f.request.limits.maxSourceBytes = bytes.length; f.request.limits.maxPixelsPerUnit = 96; f.request.limits.maxEdge = 12; f.request.limits.maxRasterBytes = quadrantOracle(0).length;
    assert.equal((await extract(f)).status, 'complete');
    for (const key of ['maxSourceBytes', 'maxPixelsPerUnit', 'maxEdge', 'maxRasterBytes'] as const) {
      const old = f.request.limits[key]; f.request.limits[key]--; assert.equal((await extract(f)).status, 'failed', key); f.request.limits[key] = old;
    }
  } finally { f.cleanup(); }
});

function pngChunk(kind: string, data: Buffer): Buffer {
  const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4); return b;
}
const rgba = Buffer.from([0, 0, 0, 0, 128, 64, 32, 128, 20, 40, 60, 255]);
function alphaPng(pixels = rgba): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), pixels]))), pngChunk('IEND', Buffer.alloc(0))]);
}
type Member = [string, Buffer | string, boolean?];
function storedZip(entries: Member[]): Buffer {
  const pieces: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, raw, badCrc] of entries) {
    const n = Buffer.from(name), data = Buffer.from(raw), checksum = (crc32(data) ^ (badCrc ? 1 : 0)) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt32LE(checksum, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    pieces.push(h, n, data); const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt32LE(checksum, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(0x81a40000, 38); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += h.length + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...pieces, cd, end]);
}
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main', PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture', WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const relationship = (target = 'media/fixed.png', mode = '', type = 'image') => `<Relationship Id="image1" Type="${OFFICE}/${type}" Target="${target}" ${mode}/>`;
const rels = (rows: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`;
const drawing = (attributes = 'r:embed="image1"') => `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:blipFill><a:blip ${attributes}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
function docx({ body = drawing(), relationships = relationship(), imageType = 'image/png', image = alphaPng(), badCrc = false, extra = [] as Member[] } = {}): Buffer {
  return storedZip([['[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="${imageType}"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ['_rels/.rels', rels(`<Relationship Id="main" Type="${OFFICE}/officeDocument" Target="word/document.xml"/>`)],
    ['word/document.xml', `<w:document xmlns:w="${WORD}" xmlns:r="${OFFICE}" xmlns:a="${DRAW}" xmlns:pic="${PIC}" xmlns:wp="${WP}"><w:body>${body}</w:body></w:document>`],
    ['word/_rels/document.xml.rels', rels(relationships)], ['word/media/fixed.png', image, badCrc], ...extra]);
}
test('independent DOCX cooperative content change is fatal after original bytes are restored', async () => {
  const original = docx(), alternative = docx({ image: alphaPng(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])) });
  assert.notEqual(sha(original), sha(alternative)); const f = sourceFixture(original, 'docx');
  const { ZipArchive } = await import('../src/adapters/unpack-zip.ts'), open = ZipArchive.open; let switched = false, restored = false;
  ZipArchive.open = async (...args) => {
    if (args[0] === f.sourcePath) { writeFileSync(f.sourcePath, alternative); switched = true; }
    const archive = await open(...args), close = archive.close;
    archive.close = async () => { await close.call(archive); if (args[0] === f.sourcePath) { writeFileSync(f.sourcePath, original); restored = true; } };
    return archive;
  };
  try {
    await assert.rejects(extract(f), /CATALOG_SOURCE_CHANGED/); assert.equal(switched, true); assert.equal(restored, true); assert.deepEqual(readFileSync(f.sourcePath), original);
  } finally { ZipArchive.open = open; f.cleanup(); }
});
test('independent DOCX three occurrences retain exact embedded bytes and distinct source locations', async () => {
  const bytes = docx({ body: drawing() + drawing() + drawing() }), f = sourceFixture(bytes, 'docx'); try {
    const locations: string[] = [];
    for (const unit of [1, 2, 3]) { f.request.unit = unit; const result = await extract(f); assert.equal(result.status, 'complete', result.reason); assert.equal(result.totalUnits, 3);
      assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), alphaPng()); const loc = result.locator!; assert.equal(loc.kind, 'docx-image');
      if (loc.kind === 'docx-image') { assert.equal(loc.occurrence, unit); assert.equal(loc.embeddedPart, 'word/media/fixed.png'); assert.equal(loc.embeddedBytes, alphaPng().length); assert.equal(loc.embeddedSha256, sha(alphaPng())); assert.equal(loc.embeddedCrc32, crc32(alphaPng())); locations.push(loc.structurePath); }
    }
    assert.equal(new Set(locations).size, 3); assert.deepEqual(readFileSync(f.sourcePath), bytes);
  } finally { f.cleanup(); }
});
test('independent DOCX encoded alpha pixels match full mathematical white-background PPM', async () => {
  const f = sourceFixture(docx(), 'docx'); try {
    const result = await extract(f); assert.equal(result.status, 'complete', result.reason);
    const context: InspectContext = { projectDir: f.root, temporaryDir: f.root, evidenceDir: f.root, publishedDir: '', policy: INSPECT_POLICY_06,
      counts: emptyCatalogCounts(), tools: [], signal: new AbortController().signal, check() {} };
    const { documentRasterPixels } = await import('../src/adapters/inspection-document-ocr.ts');
    const actual = await documentRasterPixels(result, context, fixture().map.engine, f.root);
    const expected = ppm(3, 1, x => Array.from({ length: 3 }, (_, c) => Math.floor((rgba[4 * x + c]! * rgba[4 * x + 3]! + 255 * (255 - rgba[4 * x + 3]!) + 127) / 255)));
    assert.deepEqual(actual, expected);
  } finally { f.cleanup(); }
});
const docxRefusals: [string, Parameters<typeof docx>[0]][] = [
  ['external image', { relationships: relationship('https://example.invalid/image.png', 'TargetMode="External"') }],
  ['implicit external URI', { relationships: relationship('file:///fictional/secret') }],
  ['linked image', { body: drawing('r:link="image1"') }], ['ambiguous link/embed', { body: drawing('r:link="image1" r:embed="image1"') }],
  ['unknown embed', { body: drawing('r:embed="missing"') }], ['wrong relationship type', { relationships: relationship('media/fixed.png', '', 'hyperlink') }],
  ['duplicate relationship ID', { relationships: relationship() + relationship() }], ['percent target', { relationships: relationship('media/%66ixed.png') }],
  ['traversal target', { relationships: relationship('../../fictional/secret') }], ['fragment target', { relationships: relationship('media/fixed.png#fragment') }],
  ['query target', { relationships: relationship('media/fixed.png?query') }], ['selected CRC', { badCrc: true }],
  ['unselected CRC', { extra: [['word/media/unused.png', alphaPng(), true]] }], ['content type spoof', { imageType: 'image/svg+xml' }],
  ['case part collision', { extra: [['word/media/FIXED.png', alphaPng()]] }],
];
for (const [name, options] of docxRefusals) test(`independent source DOCX refuses ${name}`, async () => {
  const bytes = docx(options), f = sourceFixture(bytes, 'docx'); try {
    const result = await extract(f); assert.equal(result.status, 'failed', name + ': ' + result.reason); assert.equal(result.payload, null); assert.ok(result.reason); assert.deepEqual(readFileSync(f.sourcePath), bytes);
  } finally { f.cleanup(); }
});

function catalogFixture() {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'independent-document-ocr-catalog-'))), selected = join(root, 'selected'); mkdirSync(selected);
  const dir = initProject({ slug: 'independent-ocr', projectsRoot: join(root, 'projects') }).dir; mkdirSync(join(dir, 'inputs'), { recursive: true });
  const excluded = new Set(['test', '.research', 'projects', 'assets/asr']);
  cpSync(PROJECT_ROOT, join(dir, '.engine'), { recursive: true, dereference: true, filter: path => !excluded.has(path.slice(PROJECT_ROOT.length + 1)) });
  writeFileSync(join(selected, 'source.pdf'), pdf()); writeFileSync(join(selected, 'source.docx'), docx());
  const policy = structuredClone(INSPECT_POLICY_06); policy.documentOcr.enabled = true; policy.documentOcr.pdfPages = [1]; policy.documentOcr.docxImages = [1]; policy.documentOcr.dpi = 72;
  writeFileSync(join(dir, 'inputs/inspect-policy.json'), importJsonText(policy));
  return { root, dir, selected, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, importJsonText(value));
test('independent catalog source replay rejects coordinated raster, locator, command and journal hashes', async t => {
  const f = catalogFixture(); try {
    const imported = await importOriginals(f.dir, f.selected), receipt = await catalogAssets(f.dir, { importId: imported.importId }), manifest = await verifyCatalog(f.dir, receipt.catalogId!);
    const manifestPath = join(f.dir, receipt.manifestPath!), indexPath = join(f.dir, 'assets/catalog.json'), receiptPath = join(f.dir, 'runs', receipt.attemptId, 'receipt.json');
    const files = new Map<string, Buffer>();
    for (const path of [manifestPath, indexPath, receiptPath]) files.set(path, readFileSync(path));
    for (const asset of manifest.assets) {
      for (const evidence of asset.technical.evidence) files.set(join(f.dir, evidence.path), readFileSync(join(f.dir, evidence.path)));
      const summary = json(join(f.dir, asset.technical.evidence.find(e => e.id === asset.technical.documentOcr!.mapEvidenceId)!.path));
      for (const unit of summary.units) { assert.ok(unit.invocation); const path = join(f.dir, unit.invocation.path); files.set(path, readFileSync(path)); }
    }
    const restore = () => { for (const [path, bytes] of files) writeFileSync(path, bytes); };
    function persist(m: any) {
      writeJson(manifestPath, m); const hash = sha(readFileSync(manifestPath)), savedReceipt = json(receiptPath), index = json(indexPath);
      savedReceipt.assets = m.assets; savedReceipt.tools = m.tools; savedReceipt.manifestSha256 = hash; writeJson(receiptPath, savedReceipt);
      index.catalogs.find((entry: any) => entry.catalogId === m.catalogId).manifestSha256 = hash; writeJson(indexPath, index);
    }
    function store(evidence: any, data: Buffer) { writeFileSync(join(f.dir, evidence.path), data); evidence.bytes = data.length; evidence.sha256 = sha(data); }
    const pdfAsset = manifest.assets.find(a => a.technical.format === 'pdf')!;
    assert.equal(pdfAsset.technical.documentOcr!.status, 'completed');
    assert.deepEqual(readFileSync(join(f.dir, pdfAsset.technical.evidence.find(e => e.kind === 'document-ocr-raster')!.path)), quadrantOracle(0));
    await t.test('actual worker source identity change remains a fatal source error', async () => {
      const cwd = join(f.dir, 'out/.tmp', `independent-source-fatal-${randomUUID()}`); mkdirSync(cwd);
      try {
        const { documentRasterRequest, runDocumentRaster } = await import('../src/adapters/inspection-document-ocr.ts');
        const context: InspectContext = { projectDir: f.dir, temporaryDir: cwd, evidenceDir: cwd, publishedDir: '', policy: json(join(f.dir, 'inputs/inspect-policy.json')),
          counts: emptyCatalogCounts(), tools: [], signal: new AbortController().signal, check() {} };
        const request = documentRasterRequest(join(f.dir, pdfAsset.source.fixedPath), 'pdf', 1, pdfAsset.source.bytes, sha('different source'), context.policy, documentRasterRuntimeIdentity());
        await assert.rejects(runDocumentRaster(request, context, cwd), /CATALOG_SOURCE_CHANGED/);
        assert.equal(context.tools.length, 1); assert.equal(context.tools[0]!.exitCode, 1); assert.match(context.tools[0]!.stderr, /CATALOG_SOURCE_CHANGED/);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
    for (const name of ['raster', 'locator', 'command', 'journal']) await t.test(`coordinated ${name} mutation preserves outer identities and is refused`, async () => {
      restore(); const m = json(manifestPath), a = m.assets.find((a: any) => a.technical.format === 'pdf'), items = a.technical.evidence;
      const mapEvidence = items.find((e: any) => e.kind === 'document-ocr-map'), map = json(join(f.dir, mapEvidence.path));
      const summaryEvidence = items.find((e: any) => e.id === a.technical.documentOcr.mapEvidenceId), summary = json(join(f.dir, summaryEvidence.path));
      const ref = summary.units[0].invocation, journal = json(join(f.dir, ref.path));
      if (name === 'raster') {
        const evidence = items.find((e: any) => e.kind === 'document-ocr-raster'), bytes = readFileSync(join(f.dir, evidence.path)); bytes[bytes.length - 1] ^= 1; store(evidence, bytes); map.raster.sha256 = evidence.sha256;
      } else if (name === 'locator') {
        map.locator.viewBox[0] = 1; summary.units[0].locator = structuredClone(map.locator); if (journal.workerResult?.locator) journal.workerResult.locator = structuredClone(map.locator);
      } else if (name === 'command') {
        const before = sha(importJsonText(map.commands.ocr)), position = map.commands.ocr.argv.indexOf('--psm'); assert.ok(position >= 0); map.commands.ocr.argv[position + 1] = '6';
        journal.commands.ocr = structuredClone(map.commands.ocr); const found = m.tools.findIndex((tool: any) => sha(importJsonText(tool)) === before); assert.ok(found >= 0); m.tools[found] = structuredClone(map.commands.ocr);
      } else journal.reason = 'DOCUMENT_RASTER_SOURCE_LIMIT: forged failure reason';
      store(mapEvidence, Buffer.from(importJsonText(map))); writeJson(join(f.dir, ref.path), journal); const journalBytes = readFileSync(join(f.dir, ref.path)); ref.bytes = journalBytes.length; ref.sha256 = sha(journalBytes);
      store(summaryEvidence, Buffer.from(importJsonText(summary))); persist(m);
      await assert.rejects(verifyCatalog(f.dir, receipt.catalogId!), /DOCUMENT|OCR|RASTER|SOURCE|INVOCATION|COMMAND|BINDING/);
      restore(); await verifyCatalog(f.dir, receipt.catalogId!);
    });
    restore();
  } finally { f.cleanup(); }
});

async function catalogFailure(dir: string, importId: string, options: Parameters<typeof catalogAssets>[2] = {}) {
  try { await catalogAssets(dir, { importId }, options); assert.fail('independent refusal expected'); }
  catch (error) { assert.ok(error instanceof CatalogFailure, String(error)); assert.equal(error.receipt.indexCommitted, false); return error.receipt; }
}
test('independent shared unit, pixel and embedded quotas preserve the prior committed catalog', async t => {
  const f = catalogFixture(); try {
    const firstImport = await importOriginals(f.dir, f.selected), first = await catalogAssets(f.dir, { importId: firstImport.importId });
    const indexPath = join(f.dir, 'assets/catalog.json'), before = readFileSync(indexPath), defaultPolicy = json(join(f.dir, 'inputs/inspect-policy.json'));
    writeFileSync(join(f.selected, 'second.docx'), docx({ body: drawing() + '<w:p/>' }));
    const fresh = await importOriginals(f.dir, f.selected);
    for (const [name, patch, pattern] of [
      ['units', { maxUnitsPerAttempt: 1 }, /DOCUMENT_OCR_UNIT_COUNT_LIMIT/],
      ['pixels', { maxTotalPixels: 98 }, /DOCUMENT_OCR_PIXEL_COUNT_LIMIT/],
      ['embedded', { maxTotalEmbeddedBytes: alphaPng().length }, /DOCUMENT_OCR_EMBEDDED_COUNT_LIMIT/],
    ] as const) await t.test(`cumulative ${name} quota rolls back the whole attempt`, async () => {
      const policy = structuredClone(defaultPolicy); Object.assign(policy.documentOcr, patch); writeJson(join(f.dir, 'inputs/inspect-policy.json'), policy);
      const failed = await catalogFailure(f.dir, fresh.importId); assert.match(failed.error!, pattern); assert.equal(failed.status, 'failed');
      assert.deepEqual(readFileSync(indexPath), before); await verifyCatalog(f.dir, first.catalogId!);
    });
    await t.test('per-unit map capacity refusals retain source facts and replay a closed failed selection', async () => {
      const policy = structuredClone(defaultPolicy); policy.documentOcr.ocr.maxOcrMapBytes = 0; writeJson(join(f.dir, 'inputs/inspect-policy.json'), policy);
      const receipt = await catalogAssets(f.dir, { importId: fresh.importId }), manifest = await verifyCatalog(f.dir, receipt.catalogId!);
      const added = manifest.assets.filter(asset => asset.inspection.catalogId === receipt.catalogId); assert.equal(added.length, 3);
      for (const asset of added) {
        assert.equal(asset.technical.documentOcr!.status, 'failed'); assert.equal(asset.technical.documentOcr!.completedUnits, 0); assert.equal(asset.technical.status, 'partial');
        const group = asset.technical.evidence.filter(e => e.kind.startsWith('document-ocr-')); assert.equal(group.length, 1);
        assert.equal(group[0]!.kind, 'document-ocr-selection-map'); const map = json(join(f.dir, group[0]!.path));
        assert.equal(map.totalUnits, 1); assert.equal(map.units[0].status, 'failed'); assert.equal(map.units[0].reason, 'DOCUMENT_OCR_MAP_LIMIT');
        assert.equal(map.units[0].mapEvidenceId, null); assert.ok(map.units[0].invocation); assert.ok(map.units[0].locator);
      }
    });
  } finally { f.cleanup(); }
});
test('independent selected OCR cancellation and committed recovery preserve closed original journals', async () => {
  const f = catalogFixture(); try {
    const imported = await importOriginals(f.dir, f.selected), first = await catalogAssets(f.dir, { importId: imported.importId }), before = readFileSync(join(f.dir, 'assets/catalog.json'));
    const fresh = await importOriginals(f.dir, f.selected), controller = new AbortController(); let inspected = 0;
    const cancelled = await catalogFailure(f.dir, fresh.importId, { signal: controller.signal, hooks: { afterInspection: async asset => {
      assert.equal(asset.technical.documentOcr!.status, 'completed'); inspected++; controller.abort();
    } } });
    assert.equal(inspected, 1); assert.equal(cancelled.status, 'interrupted'); assert.deepEqual(readFileSync(join(f.dir, 'assets/catalog.json')), before);
    await verifyCatalog(f.dir, first.catalogId!);
    const committedPath = join(f.dir, 'runs', first.attemptId, 'receipt.json'), held = json(committedPath); held.status = 'prepared'; held.ownerPid = 2147483647; writeJson(committedPath, held);
    await catalogAssets(f.dir, { importId: imported.importId }); assert.equal(json(committedPath).status, 'succeeded');
    await verifyCatalog(f.dir, first.catalogId!);
  } finally { f.cleanup(); }
});
test('independent historical native policy and same-source OCR revisions retain their original adopted scope', async () => {
  const f = catalogFixture(); try {
    const path = join(f.dir, 'inputs/inspect-policy.json'), enabled = json(path); writeJson(path, DEFAULT_INSPECT_POLICY);
    const imported = await importOriginals(f.dir, f.selected), native = await catalogAssets(f.dir, { importId: imported.importId }), nativeManifest = await verifyCatalog(f.dir, native.catalogId!);
    assert.ok(nativeManifest.assets.every(asset => asset.technical.documentOcr === undefined));
    writeJson(path, enabled); const current = await catalogAssets(f.dir, { importId: imported.importId }), currentManifest = await verifyCatalog(f.dir, current.catalogId!);
    assert.equal(currentManifest.assets.length, 4);
    for (const original of nativeManifest.assets) {
      const versions = currentManifest.assets.filter(asset => asset.assetId === original.assetId); assert.equal(versions.length, 2);
      assert.ok(versions.some(asset => asset.assetVersion === original.assetVersion)); assert.ok(versions.some(asset => asset.technical.documentOcr?.status === 'completed'));
    }
    for (const disabled of [true, false]) {
      const policy = structuredClone(enabled); policy.documentOcr.enabled = !disabled; if (!disabled) { policy.documentOcr.pdfPages = []; policy.documentOcr.docxImages = []; }
      writeJson(path, policy); const next = await catalogAssets(f.dir, { importId: imported.importId }), nextManifest = await verifyCatalog(f.dir, next.catalogId!);
      const added = nextManifest.assets.filter(asset => asset.inspection.catalogId === next.catalogId); assert.equal(added.length, 2);
      for (const asset of added) { assert.equal(asset.technical.documentOcr!.status, disabled ? 'disabled' : 'skipped'); assert.equal(asset.technical.documentOcr!.mapEvidenceId, null);
        assert.ok(asset.technical.evidence.every(evidence => !evidence.kind.startsWith('document-ocr-'))); }
    }
    await verifyCatalog(f.dir, native.catalogId!); await verifyCatalog(f.dir, current.catalogId!);
  } finally { f.cleanup(); }
});
