import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocxDocument } from '../src/adapters/document-docx.ts';
import { ZipArchive } from '../src/adapters/unpack-zip.ts';
import { assertDocument, DEFAULT_DOCUMENT_LIMITS, documentArtifacts, validateDocumentMap,
  type DocumentLimits, type DocumentParseRequest } from '../src/project/document.ts';
import { makeZip, type ZipSpec } from './fixtures/zip.ts';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const types = '<Types xmlns="' + TYPES + '"><Override PartName="/word/document.xml" ContentType="' + MAIN + '"/></Types>';
const relationships = '<Relationships xmlns="' + RELS + '"><Relationship Id="main" Type="' + OFFICE + 'officeDocument" Target="word/document.xml"/></Relationships>';
const doc = (body: string) => '<w:document xmlns:w="' + WORD + '"><w:body>' + body + '</w:body></w:document>';
const p = (text: string) => '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
function parts(body = p('中文正文'), options: { contentTypes?: string | Buffer; rootRelations?: string | Buffer;
  docRelations?: string | Buffer; extra?: ZipSpec[]; document?: string | Buffer; stored?: boolean } = {}): ZipSpec[] {
  return [{ name: '[Content_Types].xml', data: options.contentTypes ?? types, method: options.stored ? 0 : 8 },
    { name: '_rels/.rels', data: options.rootRelations ?? relationships, method: options.stored ? 0 : 8 },
    { name: 'word/document.xml', data: options.document ?? doc(body), method: options.stored ? 0 : 8 },
    ...(options.docRelations === undefined ? [] : [{ name: 'word/_rels/document.xml.rels', data: options.docRelations }]),
    ...(options.extra ?? [])];
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const originalCwd = process.cwd(); let scratch: string, sequence = 0;
before(async () => {
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.research/out');
  await mkdir(output, { recursive: true }); scratch = await mkdtemp(join(output, 'docx-tests-')); process.chdir(scratch);
});
after(async () => { process.chdir(originalCwd); await rm(scratch, { recursive: true, force: true }); });
async function request(data: Buffer, overrides: Partial<DocumentLimits> = {}): Promise<DocumentParseRequest> {
  const sourcePath = join(scratch, 'fictional-' + (++sequence) + '.docx'); await writeFile(sourcePath, data);
  return { version: '0.1', format: 'docx', sourcePath, sourceBytes: data.length, sourceSha256: digest(data),
    limits: { ...DEFAULT_DOCUMENT_LIMITS, ...overrides } };
}
async function inspect(data: Buffer, overrides: Partial<DocumentLimits> = {}) {
  const input = await request(data, overrides), result = await parseDocxDocument(input);
  assertDocument('result', result); const artifacts = documentArtifacts(result, '1'.repeat(64));
  validateDocumentMap(artifacts.map, artifacts.text, input.limits);
  assert.deepEqual(await readFile(input.sourcePath), data);
  assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('docx-parts-')), []);
  if (result.metrics.sourceReadBytes !== null) {
    assert.equal(result.metrics.sourceReadBytes, data.length * 2);
    assert.ok(result.metrics.maxRSSKiB! > 0);
  }
  return { result, ...artifacts };
}
async function rejectPackage(specs: ZipSpec[], reason: RegExp, overrides: Partial<DocumentLimits> = {}) {
  const { result, text } = await inspect(makeZip(specs), overrides);
  assert.equal(result.status, 'failed'); assert.match(result.reason, reason); assert.equal(result.units.length, 0); assert.equal(text.length, 0);
}
function utf16(xml: string, bigEndian: boolean) {
  const data = Buffer.from(xml, 'utf16le'); if (bigEndian) data.swap16();
  return Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), data]);
}

test('Chinese main paragraphs, empty paragraphs/cells and table paths preserve UTF8 byte ranges', async () => {
  const body = p('中文&amp;&#x1F600;') + '<w:p/>' +
    '<w:tbl><w:tr><w:tc/>' + '<w:tc><w:p/><w:p><w:r><w:t>表</w:t><w:tab/><w:t>格</w:t><w:br/><w:t>续行</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' + p('尾');
  const { result, text, map } = await inspect(makeZip(parts(body)));
  assert.equal(result.status, 'supported'); assert.deepEqual(result.parser, { id: 'saxes+yauzl', version: 'saxes@6.0.0/yauzl@3.4.0' });
  assert.equal(text.toString(), '中文&😀\n\n\n表\t格\n续行\n尾');
  assert.deepEqual(result.units.map(u => u.status), ['complete', 'empty', 'empty', 'complete', 'complete']);
  assert.deepEqual(result.units.map(u => (u.locator as { structurePath: string }).structurePath), [
    '/w:document[1]/w:body[1]/w:p[1]', '/w:document[1]/w:body[1]/w:p[2]',
    '/w:document[1]/w:body[1]/w:tbl[1]/w:tr[1]/w:tc[2]/w:p[1]',
    '/w:document[1]/w:body[1]/w:tbl[1]/w:tr[1]/w:tc[2]/w:p[2]', '/w:document[1]/w:body[1]/w:p[3]']);
  assert.equal(result.coverage.totalUnits, 5); assert.equal(result.coverage.completedUnits, 5);
  assert.equal(result.coverage.totalPages, null); assert.deepEqual(result.coverage.parsedPages, []);
  assert.equal(map.units[0].byteEnd, Buffer.byteLength('中文&😀'));
});

test('namespace aliases, predefined/numeric entities, UTF8 BOM and UTF16 BOM variants are supported', async () => {
  const xml = doc(p('&lt;&gt;&amp;&apos;&quot;&#65;&#x4E2D;')).replaceAll('w:', 'q:').replace('xmlns:w=', 'xmlns:q=');
  for (const document of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]),
    utf16('<?xml version="1.0" encoding="UTF-16"?>' + xml, false),
    utf16('<?xml version="1.0" encoding="UTF-16BE"?>' + xml, true)]) {
    const { result, text } = await inspect(makeZip(parts('', { document })));
    assert.equal(result.status, 'supported'); assert.equal(text.toString(), '<>&\'"A中');
  }
  const encoded = { contentTypes: utf16('<?xml version="1.0" encoding="UTF-16LE"?>' + types, false),
    rootRelations: utf16('<?xml version="1.0" encoding="UTF-16BE"?>' + relationships, true), document: utf16(doc(p('UTF16三部件')), true) };
  assert.equal((await inspect(makeZip(parts('', encoded)))).result.status, 'supported');
});

test('ZIP64, data descriptors and explicit implicit-parent promotion preserve normal DOCX', async () => {
  const specs = [...parts().map(part => ({ ...part, descriptor: true })), { name: 'word/', directory: true }];
  for (const options of [{}, { zip64: true }]) {
    const { result, text } = await inspect(makeZip(specs, options)); assert.equal(result.status, 'supported'); assert.equal(text.toString(), '中文正文');
  }
});

test('extra parts, revision blocks, compatibility wrappers and nested textboxes lower coverage', async () => {
  const body = p('前') + '<w:ins>' + p('修订') + '</w:ins>' +
    '<w:p><w:r><w:t>段落</w:t><w:drawing><w:txbxContent>' + p('文本框') + '</w:txbxContent></w:drawing></w:r></w:p>' +
    '<m:AlternateContent xmlns:m="http://schemas.openxmlformats.org/markup-compatibility/2006"><m:Choice>' + p('兼容') + '</m:Choice></m:AlternateContent>' + p('后');
  const { result, text } = await inspect(makeZip(parts(body, { extra: [{ name: 'word/header1.xml', data: doc(p('页眉')) }] })));
  assert.equal(result.status, 'partial'); assert.equal(text.toString(), '前\n段落\n后');
  assert.equal(result.coverage.totalUnits, 6); assert.equal(result.coverage.completedUnits, 3);
  assert.ok(result.coverage.omitted.some(x => x.includes('header1.xml')));
  assert.ok(result.coverage.omitted.some(x => x.includes('drawing')));
  assert.ok(result.units.some(u => u.status === 'skipped' && u.reason === 'DOCUMENT_SCOPE_OMITTED'));
});

test('paragraphs with inline revision or compatibility content remain skipped units', async () => {
  const body = '<w:p><w:r><w:t>段首</w:t></w:r><w:ins><w:r><w:t>修订</w:t></w:r></w:ins><w:r><w:t>段尾</w:t></w:r></w:p>' +
    '<w:p><m:AlternateContent xmlns:m="http://schemas.openxmlformats.org/markup-compatibility/2006"><m:Choice><w:r><w:t>兼容正文</w:t></w:r></m:Choice></m:AlternateContent></w:p>' + p('完整段');
  const { result, text, map } = await inspect(makeZip(parts(body)));
  assert.equal(result.status, 'partial'); assert.equal(text.toString(), '完整段');
  assert.deepEqual(result.units.map(u => u.status), ['skipped', 'skipped', 'complete']);
  assert.deepEqual(map.units.slice(0, 2).map(u => [u.byteStart, u.byteEnd]), [[null, null], [null, null]]);
});

test('field instructions are omitted and cached field results carry the uncomputed coverage fact', async () => {
  const body = '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>DATE injected-data-only</w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/><w:t>缓存日期</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
    '<w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>12</w:t></w:r></w:fldSimple></w:p>';
  const { result, text } = await inspect(makeZip(parts(body)));
  assert.equal(result.status, 'partial'); assert.equal(text.toString(), '缓存日期\n12');
  assert.ok(result.coverage.omitted.includes('field-cache-uncomputed'));
});

test('external hyperlink facts remain data and external main relationships fail', async () => {
  const uri = 'https://invalid.example/fictional?mode=docx&amp;id=1';
  const docRelations = '<Relationships xmlns="' + RELS + '"><Relationship Id="r1" Type="' + OFFICE + 'hyperlink" Target="' + uri + '" TargetMode="External"/></Relationships>';
  const body = '<w:p><w:hyperlink xmlns:r="' + OFFICE.slice(0, -1) + '" r:id="r1"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>';
  const { result, text } = await inspect(makeZip(parts(body, { docRelations })));
  assert.equal(result.status, 'supported'); assert.equal(text.toString(), '链接');
  assert.ok(result.limitations.some(x => x.includes('invalid.example/fictional?mode=docx&id=1')));
  const unresolved = await inspect(makeZip(parts(body)));
  assert.equal(unresolved.result.status, 'partial'); assert.ok(unresolved.result.coverage.omitted.some(x => x.includes('r1')));
  await rejectPackage(parts('', { rootRelations: relationships.replace('Target="word/document.xml"', 'Target="https://invalid.example/main.xml" TargetMode="External"') }), /DOCUMENT_EXTERNAL_MAIN_RELATIONSHIP_REJECTED/);
});

test('unit and text caps admit equality and preserve only whole paragraph prefixes', async () => {
  const body = p('中') + p('尾'); const bytes = Buffer.byteLength('中\n尾');
  const exact = await inspect(makeZip(parts(body)), { maxDocumentUnits: 2, maxDocumentTextBytes: bytes });
  assert.equal(exact.result.status, 'supported');
  const units = await inspect(makeZip(parts(body)), { maxDocumentUnits: 1 });
  assert.equal(units.result.status, 'partial'); assert.equal(units.result.reason, 'DOCUMENT_UNIT_LIMIT');
  assert.equal(units.text.toString(), '中'); assert.equal(units.result.coverage.totalUnits, 2);
  const text = await inspect(makeZip(parts(body)), { maxDocumentTextBytes: 3 });
  assert.equal(text.result.status, 'partial'); assert.equal(text.result.reason, 'DOCUMENT_TEXT_LIMIT');
  assert.equal(text.text.toString(), '中'); assert.equal(text.result.units[1].status, 'skipped');
  assert.equal(text.map.units[1].byteStart, null); assert.equal(text.map.units[1].byteEnd, null);
  const oversized = await inspect(makeZip(parts(p('整段超过') + p('尾'))), { maxDocumentTextBytes: 1 });
  assert.equal(oversized.result.status, 'partial'); assert.equal(oversized.text.length, 0);
  assert.equal(oversized.result.units.length, 1); assert.equal(oversized.result.coverage.totalUnits, 2);
  const zero = await inspect(makeZip(parts(body)), { maxDocumentUnits: 0, maxDocumentTextBytes: 0 });
  assert.equal(zero.result.status, 'partial'); assert.equal(zero.result.units.length, 0);
});

test('source admission cap admits equality and over-cap source returns located admission partial', async () => {
  const data = makeZip(parts());
  assert.equal((await inspect(data, { maxDocumentSourceBytes: data.length })).result.status, 'supported');
  const { result, text } = await inspect(data, { maxDocumentSourceBytes: data.length - 1 });
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'DOCUMENT_SOURCE_LIMIT');
  assert.equal(result.metrics.sourceReadBytes, null); assert.equal(text.length, 0); assert.equal(result.coverage.totalUnits, null);
});

test('empty-paragraph LF separators respect a full text cap and a zero-byte all-empty cap', async () => {
  for (const body of [p('中文') + '<w:p/>', p('中文') + '<w:p/>' + p('中文')]) {
    const { result, text, map } = await inspect(makeZip(parts(body)), { maxDocumentTextBytes: 6 });
    assert.equal(result.status, 'partial'); assert.equal(result.reason, 'DOCUMENT_TEXT_LIMIT');
    assert.equal(text.toString(), '中文'); assert.equal(text.length, 6);
    assert.deepEqual(result.units.map(u => u.status), ['complete', 'skipped']);
    assert.equal(result.units[1].reason, 'DOCUMENT_TEXT_LIMIT');
    assert.equal(map.units[1].byteStart, null); assert.equal(map.units[1].byteEnd, null);
    assert.equal(result.coverage.completedUnits, 1);
  }
  const one = await inspect(makeZip(parts('<w:p/>')), { maxDocumentTextBytes: 0 });
  assert.equal(one.result.status, 'supported'); assert.equal(one.text.length, 0);
  assert.deepEqual(one.result.units.map(u => u.status), ['empty']);
  const all = await inspect(makeZip(parts('<w:p/><w:p/><w:p/>')), { maxDocumentTextBytes: 0 });
  assert.equal(all.result.status, 'partial'); assert.equal(all.result.reason, 'DOCUMENT_TEXT_LIMIT');
  assert.equal(all.text.length, 0); assert.equal(all.result.coverage.totalUnits, 3);
  assert.deepEqual(all.result.units.map(u => u.status), ['empty', 'skipped']);
  assert.equal(all.result.coverage.completedUnits, 1); assert.equal(all.map.units[0].byteEnd, 0);
  assert.equal(all.map.units[1].byteStart, null); assert.equal(all.map.units[1].byteEnd, null);
});

test('CRC, local header, actual size and truncated ZIP declarations fail before publication', async () => {
  for (const override of [{ crc: 0 }, { localName: Buffer.from('word/different.xml') }, { declaredBytes: 1 }]) {
    const specs = parts(); specs[2] = { ...specs[2], ...override };
    await rejectPackage(specs, /UNPACK_|size|CRC|crc|DOCUMENT_PACKAGE_SIZE_INVALID/);
  }
  const data = makeZip(parts()); const { result } = await inspect(data.subarray(0, data.length - 9));
  assert.equal(result.status, 'failed'); assert.equal(result.units.length, 0);
});

test('ZIP traversal, links, duplicate, case/NFC aliases and parent-file collisions fail', async () => {
  const extras: ZipSpec[][] = [
    [{ name: '../outside.xml', data: 'x' }], [{ name: '/absolute.xml', data: 'x' }],
    [{ name: 'word\\outside.xml', data: 'x' }], [{ name: 'word/link', data: 'target', attrs: 0xa1ff0000 }],
    [{ name: 'word/document.xml', data: doc('') }], [{ name: 'WORD/document.xml', data: 'x' }],
    [{ name: 'word/café.xml', data: 'x' }, { name: 'word/cafe\u0301.xml', data: 'y' }],
    [{ name: 'word', data: 'file' }], [{ name: 'a', data: 'file' }, { name: 'a/b.xml', data: 'x' }],
    [{ name: 'word/Document.xml', data: 'x' }], [{ name: 'word/', directory: true }, { name: 'word/', directory: true }],
  ];
  for (const extra of extras) await rejectPackage(parts('', { extra }), /PATH|path|LINK|link|UNPACK_/);
});

test('package entry, declared expansion, path depth and compression-ratio caps are enforced', async () => {
  const specs = parts(), expanded = specs.reduce((sum, item) => sum + Buffer.byteLength(item.data as string), 0);
  assert.equal((await inspect(makeZip(specs), { maxDocxEntries: 3, maxDocxDeclaredExpandedBytes: expanded, maxPackagePathDepth: 1 })).result.status, 'supported');
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:entries/, { maxDocxEntries: 2 });
  for (const zip64 of [false, true]) {
    const { result } = await inspect(makeZip(specs, { zip64 }), { maxDocxEntries: 2 });
    assert.equal(result.reason, 'DOCUMENT_PACKAGE_LIMIT:entries: 3/2');
  }
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:expanded/, { maxDocxDeclaredExpandedBytes: expanded - 1 });
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:path-depth/, { maxPackagePathDepth: 0 });
  await rejectPackage(parts('', { extra: [{ name: 'word/bomb.xml', data: 'A'.repeat(200000) }] }), /DOCUMENT_PACKAGE_LIMIT:ratio/);
  await rejectPackage(parts('', { extra: [{ name: 'word/declared-bomb', data: 'x', declaredBytes: 67108865 }] }), /DOCUMENT_PACKAGE_LIMIT:expanded/);
  await rejectPackage(parts(), /DOCUMENT_PACKAGE_LIMIT:ratio/, { maxCompressionRatio: 1 });
});

test('XML per-part, cumulative-byte, nesting and node caps fail with explicit resources', async () => {
  const specs = parts(), sizes = specs.map(x => Buffer.byteLength(x.data as string)), maximum = Math.max(...sizes), total = sizes.reduce((a, b) => a + b, 0);
  assert.equal((await inspect(makeZip(specs), { maxXmlPartBytes: maximum, maxXmlReadBytes: total, maxXmlDepth: 5, maxXmlNodes: 10 })).result.status, 'supported');
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:part-bytes/, { maxXmlPartBytes: maximum - 1 });
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:xml-bytes/, { maxXmlReadBytes: total - 1 });
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:xml-depth/, { maxXmlDepth: 4 });
  await rejectPackage(specs, /DOCUMENT_PACKAGE_LIMIT:xml-nodes/, { maxXmlNodes: 9 });
  await rejectPackage(parts('<w:p>' + '<w:r>'.repeat(63) + '<w:t>深</w:t>' + '</w:r>'.repeat(63) + '</w:p>'), /DOCUMENT_PACKAGE_LIMIT:xml-depth/);
});

test('DTD, custom/undeclared entities and malformed tails fail even after a retained-prefix limit', async () => {
  const invalid = [
    '<!DOCTYPE w:document [<!ENTITY injected SYSTEM "file:///private/fictional">]>' + doc(p('&injected;')),
    '<!DOCTYPE w:document SYSTEM "https://invalid.example/fictional.dtd">' + doc(p('文本')),
    doc(p('&unknown;')), doc(p('&#0;')), doc(p('合法') + '<w:p><w:r><w:t>坏</w:t></w:p>'),
  ];
  for (const document of invalid) await rejectPackage(parts('', { document }), /DOCUMENT_XML_(?:DTD_REJECTED|INVALID)/, { maxDocumentUnits: 1 });
  await rejectPackage(parts('', { document: doc(p('前') + p('&unknown;')) }), /DOCUMENT_XML_INVALID/, { maxDocumentUnits: 1 });
});

test('invalid encodings fail, declared unavailable encodings and nonordinary wrappers are unsupported', async () => {
  for (const document of [utf16('<?xml version="1.0" encoding="UTF-8"?>' + doc(p('冲突')), false),
    Buffer.concat([Buffer.from(doc(p('x')).slice(0, 20)), Buffer.from([0xff]), Buffer.from('bad')]),
    Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + doc(p('缺BOM')))]) {
    await rejectPackage(parts('', { document }), /DOCUMENT_XML_ENCODING_INVALID/);
  }
  for (const data of [makeZip(parts('', { document: '<?xml version="1.0" encoding="ISO-8859-1"?>' + doc(p('unsupported')) })),
    Buffer.from('d0cf11e0a1b11ae10000', 'hex')]) {
    const { result } = await inspect(data); assert.equal(result.status, 'unsupported'); assert.equal(result.units.length, 0);
  }
  for (const data of [Buffer.from('%PDF-fictional'), makeZip([{ name: 'unrelated.xml', data: 'x' }])]) {
    const { result } = await inspect(data); assert.equal(result.status, 'failed'); assert.equal(result.units.length, 0);
  }
});

test('macro parts, malformed relationships, unsafe main targets and absent body fail', async () => {
  await rejectPackage(parts('', { extra: [{ name: 'word/vbaProject.bin', data: 'fictional' }] }), /DOCUMENT_MACRO_REJECTED/);
  await rejectPackage(parts('', { contentTypes: types.replace(MAIN, 'application/vnd.ms-word.document.macroEnabled.main+xml') }), /DOCUMENT_MACRO_REJECTED/);
  await rejectPackage(parts('', { rootRelations: relationships.replace('Target="word/document.xml"', 'Target="../word/document.xml"') }), /DOCUMENT_MAIN_RELATIONSHIP_INVALID/);
  await rejectPackage(parts('', { docRelations: '<Relationships xmlns="' + RELS + '"><Relationship Id="x" Type="t" Target="a"/><Relationship Id="x" Type="t" Target="b"/></Relationships>' }), /DOCUMENT_RELATIONSHIP_INVALID/);
  await rejectPackage(parts('', { document: '<w:document xmlns:w="' + WORD + '"/>' }), /DOCUMENT_BODY_INVALID/);
  await rejectPackage(parts('', { document: '<w:document xmlns:w="' + WORD + '"><w:body/><w:body/></w:document>' }), /DOCUMENT_BODY_INVALID/);
  const wrong = await inspect(makeZip(parts('', { document: '<document xmlns="urn:fictional"><body/></document>' })));
  assert.equal(wrong.result.status, 'unsupported'); assert.match(wrong.result.reason, /DOCUMENT_WORD_NAMESPACE_UNSUPPORTED/);
});

test('conventional OPC nested/text entries and malformed paragraph/table placement fail', async () => {
  await rejectPackage(parts('', { contentTypes: types.replace('/></Types>', '><Default/></Override></Types>') }), /DOCUMENT_OPC_INVALID/);
  await rejectPackage(parts('', { rootRelations: relationships.replace('/></Relationships>', '>text</Relationship></Relationships>') }), /DOCUMENT_RELATIONSHIP_INVALID/);
  for (const body of ['<w:tbl>' + p('错误') + '</w:tbl>', '<w:tr><w:tc>' + p('错误') + '</w:tc></w:tr>',
    '<w:p><w:t>错误</w:t></w:p>', '<w:r><w:t>错误</w:t></w:r>', '<w:body>' + p('错误') + '</w:body>']) {
    await rejectPackage(parts(body), /DOCUMENT_BODY_INVALID/);
  }
});

test('source identity, symlink/hardlink admission and format mismatch fail without source overwrite', async () => {
  const data = makeZip(parts()), input = await request(data);
  await assert.rejects(parseDocxDocument({ ...input, sourceSha256: '0'.repeat(64) }), /CATALOG_SOURCE_CHANGED/);
  await assert.rejects(parseDocxDocument({ ...input, sourceBytes: input.sourceBytes + 1 }), /CATALOG_SOURCE_CHANGED/);
  await assert.rejects(parseDocxDocument({ ...input, format: 'pdf' }), /DOCUMENT_REQUEST_INVALID/);
  const sym = join(scratch, 'symbolic.docx'); await symlink(input.sourcePath, sym);
  await assert.rejects(parseDocxDocument({ ...input, sourcePath: sym }), /CATALOG_SOURCE_CHANGED/);
  const hard = join(scratch, 'hard.docx'); await link(input.sourcePath, hard);
  await assert.rejects(parseDocxDocument(input), /CATALOG_SOURCE_CHANGED/); await rm(hard);
  assert.deepEqual(await readFile(input.sourcePath), data);
});

test('source mutation during extraction aborts with batch-failure source identity reason and cleans parts', async () => {
  const data = makeZip(parts()), input = await request(data), original = ZipArchive.prototype.extract; let changed = false;
  ZipArchive.prototype.extract = async function (...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (!changed) { changed = true; await writeFile(input.sourcePath, Buffer.concat([data, Buffer.from('changed')])); }
    return result;
  };
  try { await assert.rejects(parseDocxDocument(input), /CATALOG_SOURCE_CHANGED/); }
  finally { ZipArchive.prototype.extract = original; }
  assert.ok(changed); assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('docx-parts-')), []);
});
