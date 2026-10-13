import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseOfficeDocument } from '../src/adapters/document-office.ts';
import { ZipArchive } from '../src/adapters/unpack-zip.ts';
import { DEFAULT_DOCUMENT_LIMITS, DEFAULT_OFFICE_LIMITS, documentArtifacts, validateDocumentMap,
  type DocumentLimits, type OfficeLimits, type DocumentParseRequest } from '../src/project/document.ts';
import { makeZip, type ZipSpec } from './fixtures/zip.ts';
import { pptxParts, xlsxParts, relationships, shape, slide, paragraph } from './fixtures/office.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const originalCwd = process.cwd(); let scratch: string, sequence = 0;
before(async () => {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.research/out');
  await mkdir(output, { recursive: true }); scratch = await mkdtemp(join(output, 'office-tests-')); process.chdir(scratch);
});
after(async () => { process.chdir(originalCwd); await rm(scratch, { recursive: true, force: true }); });
async function request(format: 'pptx' | 'xlsx', data: Buffer, limits: Partial<DocumentLimits> = {}, office: Partial<OfficeLimits> = {}): Promise<DocumentParseRequest> {
  const sourcePath = join(scratch, 'fictional-' + (++sequence) + '.' + format); await writeFile(sourcePath, data);
  return { version: '0.2', format, sourcePath, sourceBytes: data.length, sourceSha256: hash(data),
    limits: { ...DEFAULT_DOCUMENT_LIMITS, ...limits }, office: { ...DEFAULT_OFFICE_LIMITS, ...office } };
}
async function inspect(format: 'pptx' | 'xlsx', specs: ZipSpec[], limits: Partial<DocumentLimits> = {}, office: Partial<OfficeLimits> = {}, zip64 = false) {
  const data = makeZip(specs, { zip64 }), input = await request(format, data, limits, office), result = await parseOfficeDocument(input), artifacts = documentArtifacts(result, '1'.repeat(64));
  validateDocumentMap(artifacts.map, artifacts.text, input.limits);
  assert.deepEqual(await readFile(input.sourcePath), data); assert.equal(result.metrics.sourceReadBytes, data.length * 2);
  assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('office-parts-')), []);
  return { input, result, ...artifacts };
}
const replace = (specs: ZipSpec[], name: string, data: string | Buffer) => specs.map(spec => spec.name === name ? { ...spec, data } : spec);
async function rejects(format: 'pptx' | 'xlsx', specs: ZipSpec[], pattern: RegExp, limits: Partial<DocumentLimits> = {}, office: Partial<OfficeLimits> = {}) {
  const { result, text } = await inspect(format, specs, limits, office);
  assert.equal(result.status, 'failed', result.reason); assert.match(result.reason, pattern); assert.equal(result.units.length, 0); assert.equal(text.length, 0);
}

test('PPTX exact Chinese/English slide text and only body-placeholder notes close UTF8 ranges', async () => {
  const { result, text, map } = await inspect('pptx', pptxParts());
  assert.equal(result.status, 'supported'); assert.equal(result.version, '0.2'); assert.equal(map.version, '0.2');
  assert.equal(text.toString(), '中文& English\n讲者笔记');
  assert.deepEqual(result.units.map(u => u.locator), [
    { kind: 'pptx', slide: 1, part: 'ppt/slides/slide1.xml', structurePath: '/p:sld[1]/p:cSld[1]/p:spTree[1]/p:sp[1]/p:txBody[1]/a:p[1]' },
    { kind: 'pptx', slide: 1, part: 'ppt/notesSlides/notesSlide1.xml', structurePath: '/p:notes[1]/p:cSld[1]/p:spTree[1]/p:sp[1]/p:txBody[1]/a:p[1]' }]);
  assert.equal(map.units[0]!.byteEnd, Buffer.byteLength('中文& English')); assert.equal(result.coverage.totalUnits, 2); assert.equal(result.coverage.completedUnits, 2);
});

test('PPTX relation order differs from ZIP/name order and basic table paragraphs preserve location', async () => {
  const table = '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>' + paragraph('表格') + '</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  const { result, text } = await inspect('pptx', pptxParts({ notes: false, texts: ['First', 'Second'], order: [2, 1], extraBody: table }).reverse());
  assert.equal(text.toString(), 'Second\nFirst\n表格'); assert.equal(result.units[0]!.locator.part, 'ppt/slides/slide2.xml');
  assert.equal(result.units[0]!.locator.kind === 'pptx' && result.units[0]!.locator.slide, 1);
  assert.match(result.units[2]!.locator.structurePath, /\/a:tbl\[1\]\/a:tr\[1\]\/a:tc\[1\]/);
});

test('XLSX plain/rich/inline strings, numeric/boolean/formula caches and table metadata close their sources', async () => {
  const { result, text, map } = await inspect('xlsx', xlsxParts());
  assert.equal(result.status, 'partial'); assert.equal(text.toString(), '名称\n值Value\n文本Text\n42\n1\n84\nFictionalTable\tA1:B3\n名称\t值Value');
  assert.ok(result.coverage.omitted.some(v => v.includes('formula cache uncomputed: xl/worksheets/sheet1.xml#B3')));
  assert.equal(result.units[5]!.text, '84'); assert.equal(result.units[5]!.locator.kind === 'xlsx' && result.units[5]!.locator.cell, 'B3');
  assert.deepEqual(result.units[6]!.locator, { kind: 'xlsx', sheet: 1, sheetName: '数据', part: 'xl/tables/table1.xml', cell: null, range: 'A1:B3', structurePath: '/s:table[1]' });
  assert.equal(map.text.bytes, text.length); assert.equal(map.coverage.totalUnits, 7);
});

test('XLSX worksheet relation order, empty/error/date values and missing formula caches remain explicit', async () => {
  const cells = '<row r="1"><c r="A1"/><c r="B1" t="e"><v>#DIV/0!</v></c><c r="C1" t="d"><v>2026-01-01</v></c><c r="D1"><f>1+1</f></c><c r="E1"><f>1+1</f><v/></c></row>';
  const { result, text } = await inspect('xlsx', xlsxParts({ table: false, sheets: ['First', 'Second'], order: [2, 1], cells }).reverse());
  assert.equal(text.toString(), 'Second\n\n#DIV/0!\n2026-01-01');
  assert.equal(result.units[0]!.locator.kind === 'xlsx' && result.units[0]!.locator.sheetName, 'Second');
  assert.equal(result.units[4]!.status, 'skipped'); assert.equal(result.units[4]!.reason, 'DOCUMENT_FORMULA_CACHE_MISSING');
  assert.equal(result.units[5]!.status, 'skipped'); assert.equal(result.units[5]!.reason, 'DOCUMENT_FORMULA_CACHE_MISSING');
});

test('namespace aliases, UTF16 BOM and ZIP64/descriptors preserve canonical locations', async () => {
  const specs = pptxParts({ notes: false }); const name = 'ppt/slides/slide1.xml';
  const xml = String(specs.find(p => p.name === name)!.data).replaceAll('<p:', '<q:').replaceAll('</p:', '</q:').replace('xmlns:p=', 'xmlns:q=');
  const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + xml, 'utf16le')]);
  for (const zip64 of [false, true]) {
    const { result, text } = await inspect('pptx', replace(specs, name, data).map(spec => ({ ...spec, descriptor: true })), {}, {}, zip64);
    assert.equal(result.status, 'supported', result.reason); assert.equal(text.toString(), '中文& English'); assert.match(result.units[0]!.locator.structurePath, /^\/p:sld\[1\]/);
  }
});

test('full package CRC validates even an unread nonbody part and marks accepted omissions', async () => {
  const extra = { name: 'ppt/media/fictional.bin', data: Buffer.from([1, 2, 3]) };
  const accepted = await inspect('pptx', [...pptxParts(), extra]); assert.equal(accepted.result.status, 'partial');
  assert.ok(accepted.result.coverage.omitted.some(v => v.includes('CRC verified')));
  await rejects('pptx', [...pptxParts(), { ...extra, crc: 1 }], /UNPACK_INTEGRITY_INVALID/);
  await rejects('xlsx', [...xlsxParts(), { name: 'xl/drawings/drawing1.xml', data: 'unused', crc: 1 }], /UNPACK_INTEGRITY_INVALID/);
  const unreadRelationship = 'ppt/notesMasters/_rels/notesMaster1.xml.rels', partial = await inspect('pptx', [...pptxParts(),
    { name: unreadRelationship, data: relationships([{ id: 'external', type: 'hyperlink', target: 'https://example.invalid/unread', mode: 'External' }]) }]);
  assert.equal(partial.result.status, 'partial'); assert.ok(partial.result.coverage.omitted.some(v => v.includes(unreadRelationship)));
  assert.ok(partial.result.limitations.some(v => v.includes('Unread relationship parts')));
});

test('DTD, invalid encoding/XML, unsafe external relationships and macro Office are explicitly refused', async () => {
  await rejects('pptx', replace(pptxParts(), 'ppt/slides/slide1.xml', '<!DOCTYPE sld [<!ENTITY x "secret">]>' + slide(shape('&x;'))), /DOCUMENT_XML_DTD_REJECTED/);
  await rejects('xlsx', replace(xlsxParts(), 'xl/worksheets/sheet1.xml', '<worksheet>'), /DOCUMENT_XML_INVALID/);
  await rejects('pptx', replace(pptxParts(), 'ppt/_rels/presentation.xml.rels', relationships([{ id: 's1', type: 'slide', target: 'https://example.invalid/slide.xml', mode: 'External' }])), /DOCUMENT_EXTERNAL_RELATIONSHIP_REJECTED/);
  await rejects('xlsx', replace(xlsxParts(), 'xl/_rels/workbook.xml.rels', relationships([{ id: 's1', type: 'worksheet', target: '../../../outside.xml' }])), /DOCUMENT_RELATIONSHIP_TARGET_INVALID/);
  await rejects('pptx', [...pptxParts(), { name: 'ppt/vbaProject.bin', data: 'macro' }], /DOCUMENT_MACRO_REJECTED/);
  const macro = xlsxParts().map(spec => spec.name === '[Content_Types].xml' ? { ...spec, data: String(spec.data).replace('spreadsheetml.sheet.main+xml', 'spreadsheetml.sheet.macroEnabled.main+xml') } : spec);
  await rejects('xlsx', macro, /DOCUMENT_MACRO_REJECTED/);
  const cfb = Buffer.from('d0cf11e0a1b11ae100000000', 'hex'), input = await request('pptx', cfb), result = await parseOfficeDocument(input);
  assert.equal(result.status, 'unsupported'); assert.match(result.reason, /DOCUMENT_CFB_UNSUPPORTED/);
});

test('package paths, links and duplicate relationships/cell coordinates are refused', async () => {
  await rejects('pptx', [...pptxParts(), { name: '../escape', data: 'x' }], /UNPACK_/);
  await rejects('pptx', [...pptxParts(), { name: 'ppt/link', data: 'destination', attrs: 0xa1ff0000 }], /UNPACK_/);
  await rejects('pptx', [...pptxParts(), { name: 'PPT/slides/SLIDE1.xml', data: 'collision' }], /DOCUMENT_PACKAGE_PATH_COLLISION/);
  await rejects('pptx', pptxParts({ texts: ['a'], order: [1, 1] }), /DOCUMENT_SLIDE_INVALID/);
  const duplicate = xlsxParts({ table: false, cells: '<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>' });
  await rejects('xlsx', duplicate, /DOCUMENT_CELL_INVALID/);
  await rejects('xlsx', xlsxParts({ table: false, cells: '<row r="1"><c r="XFE1"><v>1</v></c></row>' }), /DOCUMENT_CELL_INVALID/);
  await rejects('xlsx', replace(xlsxParts(), 'xl/worksheets/_rels/sheet1.xml.rels', relationships([{ id: 'other', type: 'table', target: '../tables/table1.xml' }])), /DOCUMENT_RELATIONSHIP_INVALID/);
});

test('Office/ZIP/XML/shared-string/table range ceilings reject bounded excess', async () => {
  await rejects('pptx', pptxParts(), /UNPACK_ENTRY_LIMIT/, { maxDocxEntries: 1 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:expanded/, { maxDocxDeclaredExpandedBytes: 10 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:part-bytes/, { maxXmlPartBytes: 10 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:xml-bytes/, { maxXmlReadBytes: 10 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:xml-depth/, { maxXmlDepth: 2 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:xml-nodes/, { maxXmlNodes: 3 });
  await rejects('pptx', pptxParts(), /DOCUMENT_PACKAGE_LIMIT:slides/, {}, { maxSlides: 0 });
  await rejects('xlsx', xlsxParts(), /DOCUMENT_PACKAGE_LIMIT:worksheets/, {}, { maxWorksheets: 0 });
  await rejects('xlsx', xlsxParts(), /DOCUMENT_PACKAGE_LIMIT:shared-strings/, {}, { maxSharedStrings: 1 });
  await rejects('xlsx', xlsxParts(), /DOCUMENT_PACKAGE_LIMIT:tables/, {}, { maxTables: 0 });
  await rejects('xlsx', xlsxParts({ range: 'A1:XFD1048576' }), /DOCUMENT_PACKAGE_LIMIT:table-range-cells/);
  await rejects('xlsx', xlsxParts({ range: 'B3:A1' }), /DOCUMENT_TABLE_RANGE_INVALID/);
});

test('unit/text/source ceilings retain explicit partial native coverage and exact byte maps', async () => {
  const units = await inspect('pptx', pptxParts(), { maxDocumentUnits: 1 });
  assert.equal(units.result.status, 'partial'); assert.equal(units.result.coverage.totalUnits, 2); assert.equal(units.result.coverage.completedUnits, 1);
  const text = await inspect('pptx', pptxParts(), { maxDocumentTextBytes: 0 });
  assert.equal(text.result.status, 'partial'); assert.equal(text.text.length, 0); assert.ok(text.result.units.every(u => u.status === 'skipped'));
  const data = makeZip(pptxParts()), input = await request('pptx', data, { maxDocumentSourceBytes: 1 }), source = await parseOfficeDocument(input);
  assert.equal(source.status, 'partial'); assert.equal(source.reason, 'DOCUMENT_SOURCE_LIMIT'); assert.equal(source.metrics.sourceReadBytes, null);
});

test('source mismatch, source links and change during extraction are detected', async () => {
  const input = await request('pptx', makeZip(pptxParts()));
  await assert.rejects(parseOfficeDocument({ ...input, sourceSha256: '0'.repeat(64) }), /CATALOG_SOURCE_CHANGED/);
  const symbolic = join(scratch, 'symbolic.pptx'); await symlink(input.sourcePath, symbolic);
  await assert.rejects(parseOfficeDocument({ ...input, sourcePath: symbolic }), /CATALOG_SOURCE_CHANGED/);
  const hard = join(scratch, 'hard.pptx'); await link(input.sourcePath, hard);
  await assert.rejects(parseOfficeDocument(input), /CATALOG_SOURCE_CHANGED/); await rm(hard);
  const original = ZipArchive.prototype.extract; let changed = false;
  ZipArchive.prototype.extract = async function (...args: Parameters<typeof original>) {
    const result = await original.apply(this, args); if (!changed) { changed = true; await writeFile(input.sourcePath, Buffer.alloc(input.sourceBytes)); } return result;
  };
  try { await assert.rejects(parseOfficeDocument(input), /CATALOG_SOURCE_CHANGED/); } finally { ZipArchive.prototype.extract = original; }
});

test('actual worker returns the full native protocol and refuses a truncated payload budget', async () => {
  const input = await request('xlsx', makeZip(xlsxParts())), worker = resolve(dirname(fileURLToPath(import.meta.url)), '../src/adapters/document-worker.ts');
  const run = spawnSync(process.execPath, ['--max-old-space-size=512', worker, JSON.stringify(input)], { cwd: scratch, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); const result = JSON.parse(run.stdout); assert.equal(result.units.length, 7); assert.equal(result.format, 'xlsx');
  assert.equal(result.sourceSha256, input.sourceSha256); assert.ok(result.metrics.maxRSSKiB > 0);
  const bounded = spawnSync(process.execPath, ['--max-old-space-size=512', worker, JSON.stringify({ ...input, limits: { ...input.limits, maxWorkerPayloadBytes: 10 } })], { cwd: scratch, encoding: 'utf8' });
  assert.equal(bounded.status, 1); assert.equal(bounded.stdout, ''); assert.match(bounded.stderr, /final payload limit/);
});
