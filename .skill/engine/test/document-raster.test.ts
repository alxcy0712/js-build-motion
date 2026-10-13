import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { Canvas } from 'skia-canvas';
import { documentRasterRuntimeIdentity } from '../workspace.mjs';
import { extractDocumentRaster } from '../src/adapters/document-raster-source.ts';
import { parsePdfDocument } from '../src/adapters/document-pdf.ts';
import { parseDocxDocument } from '../src/adapters/document-docx.ts';
import { ZipArchive } from '../src/adapters/unpack-zip.ts';
import { DEFAULT_DOCUMENT_RASTER_LIMITS, assertDocumentOcr, type DocumentRasterRequest,
  type DocumentRasterResult, type DocumentRasterLimits, type DocumentRasterRuntimeIdentity } from '../src/project/document-ocr.ts';
import { DEFAULT_DOCUMENT_LIMITS, type DocumentLimits } from '../src/project/document.ts';
import { DEFAULT_OCR_LIMITS } from '../src/project/ocr.ts';
import { makeZip, type ZipSpec } from './fixtures/zip.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const originalCwd = process.cwd(); let scratch: string, sequence = 0, runtime: DocumentRasterRuntimeIdentity;
before(async () => {
  const temporary = join(dirname(fileURLToPath(import.meta.resolve('../workspace.mjs'))), '.research/out');
  await mkdir(temporary, { recursive: true });
  scratch = await mkdtemp(join(temporary, 'raster-tests-')); process.chdir(scratch);
  runtime = documentRasterRuntimeIdentity();
});
after(async () => { process.chdir(originalCwd); if (scratch) await rm(scratch, { recursive: true, force: true }); });
function assemble(objects: (string | Buffer)[], trailer = '', end = 'endobj'): Buffer {
  const pieces = [Buffer.from('%PDF-1.7\n% fictional bounded raster\n')], offsets: number[] = []; let offset = pieces[0]!.length;
  for (const [index, value] of objects.entries()) {
    offsets.push(offset); const body = Buffer.concat([Buffer.from(String(index + 1) + ' 0 obj\n'), typeof value === 'string' ? Buffer.from(value) : value, Buffer.from('\n' + end + '\n')]);
    pieces.push(body); offset += body.length;
  }
  pieces.push(Buffer.from('xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R ' + trailer + ' >>\nstartxref\n' + offset + '\n%%EOF\n'));
  return Buffer.concat(pieces);
}
function stream(data: string | Buffer, dictionary = ''): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from('<< /Length ' + bytes.length + ' ' + dictionary + ' >>\nstream\n'), bytes, Buffer.from('\nendstream')]);
}
function pdf(options: { content?: string | Buffer; contentDictionary?: string; geometry?: string; resource?: string; extra?: (string | Buffer)[]; trailer?: string; catalog?: string; pages?: number } = {}) {
  const objects: (string | Buffer)[] = ['<< /Type /Catalog /Pages 2 0 R ' + (options.catalog ?? '') + ' >>', '', stream(options.content ?? '1 0 0 rg 0 0 8 6 re f', options.contentDictionary)], refs: string[] = [];
  for (let n = 0; n < (options.pages ?? 1); n++) {
    refs.push(String(objects.length + 1) + ' 0 R'); objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 6] ' + (options.geometry ?? '') + ' /Resources << ' + (options.resource ?? '') + ' >> /Contents 3 0 R >>');
  }
  objects[1] = '<< /Type /Pages /Count ' + refs.length + ' /Kids [' + refs.join(' ') + '] >>'; objects.push(...options.extra ?? []);
  return assemble(objects, options.trailer);
}
function ppm(width: number, height: number, color: number[]) {
  return Buffer.concat([Buffer.from('P6\n' + width + ' ' + height + '\n255\n'), Buffer.from(Array.from({ length: width * height }, () => color).flat())]);
}
function png() {
  const chunk = (kind: string, bytes: Buffer) => {
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length); const contents = Buffer.concat([Buffer.from(kind), bytes]), checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(contents));
    return Buffer.concat([header, contents, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture', WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/', RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types', MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const image = png();
const types = '<Types xmlns="' + TYPES + '"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="' + MAIN + '"/></Types>';
const rootRelations = '<Relationships xmlns="' + RELS + '"><Relationship Id="main" Type="' + OFFICE + 'officeDocument" Target="word/document.xml"/></Relationships>';
const imageRelation = (attributes = '') => '<Relationship Id="img" Type="' + OFFICE + 'image" Target="media/pixels.png" ' + attributes + '/>';
const drawing = (blip = 'r:embed="img"') => '<w:drawing><wp:inline><a:graphic><a:graphicData uri="' + PIC + '"><pic:pic><pic:blipFill><a:blip ' + blip + '/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
const paragraph = (value: string) => '<w:p><w:r><w:t>中文 SOURCE</w:t>' + value + '</w:r></w:p>';
function docx(options: { body?: string; types?: string; root?: string; relations?: string; document?: string; extra?: ZipSpec[]; image?: Buffer; omitImage?: boolean } = {}) {
  const specs: ZipSpec[] = [
    { name: '[Content_Types].xml', data: options.types ?? types }, { name: '_rels/.rels', data: options.root ?? rootRelations },
    { name: 'word/document.xml', data: options.document ?? '<w:document xmlns:w="' + WORD + '" xmlns:wp="' + WP + '" xmlns:a="' + DRAWING + '" xmlns:pic="' + PIC + '" xmlns:r="' + OFFICE.slice(0, -1) + '"><w:body>' + (options.body ?? paragraph(drawing())) + '</w:body></w:document>' },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships xmlns="' + RELS + '">' + (options.relations ?? imageRelation()) + '</Relationships>' },
    ...(options.omitImage ? [] : [{ name: 'word/media/pixels.png', data: options.image ?? image }]), ...(options.extra ?? []),
  ];
  return makeZip(specs);
}
async function input(bytes: Buffer, format: 'pdf' | 'docx', limits: Partial<DocumentRasterLimits> = {}, unit = 1, documentLimits: Partial<DocumentLimits> = {}): Promise<DocumentRasterRequest> {
  const sourcePath = join(scratch, 'input-' + (++sequence) + '.' + format); await writeFile(sourcePath, bytes);
  return { version: '0.1', kind: 'document-raster-request', format, sourcePath, sourceBytes: bytes.length, sourceSha256: hash(bytes), unit, dpi: 72,
    limits: { ...DEFAULT_DOCUMENT_RASTER_LIMITS, ...limits }, documentLimits: { ...DEFAULT_DOCUMENT_LIMITS, ...documentLimits }, ocrLimits: { ...DEFAULT_OCR_LIMITS }, runtime };
}
async function inspect(bytes: Buffer, format: 'pdf' | 'docx', limits: Partial<DocumentRasterLimits> = {}, unit = 1, documentLimits: Partial<DocumentLimits> = {}) {
  const request = await input(bytes, format, limits, unit, documentLimits), result = await extractDocumentRaster(request);
  assertDocumentOcr('result', result); assert.deepEqual(result.source, { bytes: bytes.length, sha256: hash(bytes) }); assert.deepEqual(await readFile(request.sourcePath), bytes);
  assert.ok(!(await readdir(scratch)).some(name => name.startsWith('docx-raster-')));
  await writeFile(request.sourcePath + '.result.json', JSON.stringify(result, null, 2) + '\n');
  if (result.payload) { const data = Buffer.from(result.payload.dataBase64, 'base64'); assert.equal(data.length, result.payload.bytes); assert.equal(hash(data), result.payload.sha256); }
  return { request, result };
}
function failed(result: DocumentRasterResult, reason: RegExp) {
  assert.equal(result.status, 'failed'); assert.match(result.reason, reason); assert.equal(result.locator, null); assert.equal(result.payload, null);
}

test('PDF whole P6 pixels, intrinsic rotation, CropBox, UserUnit and DPI are measured', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const { result } = await inspect(pdf({ geometry: '/Rotate ' + rotation }), 'pdf'); assert.equal(result.status, 'complete', result.reason);
    const loc = result.locator; assert.ok(loc?.kind === 'pdf-page'); assert.equal(loc.rotation, rotation); assert.deepEqual(loc.viewBox, [0, 0, 8, 6]);
    const [width, height] = rotation % 180 ? [6, 8] : [8, 6]; assert.deepEqual([loc.width, loc.height], [width, height]);
    assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), ppm(width, height, [255, 0, 0]));
    assert.equal(result.metrics.canvasAllocationPixels, width * height); assert.equal(result.metrics.canvasLivePeakPixels, width * height);
  }
  const request = await input(pdf({ geometry: '/CropBox [1 1 7 5] /Rotate 90 /UserUnit 2' }), 'pdf'); request.dpi = 150;
  const result = await extractDocumentRaster(request); assert.equal(result.status, 'complete', result.reason); assert.ok(result.locator?.kind === 'pdf-page');
  assert.deepEqual([result.locator.width, result.locator.height], [17, 25]); assert.deepEqual(result.locator.viewBox, [1, 1, 7, 5]);
  assert.equal(result.locator.userUnit, 2); assert.equal(result.locator.scale, 150 / 72);
  assert.equal(result.payload!.bytes, Buffer.from('P6\n17 25\n255\n').length + 17 * 25 * 3);
});

test('PDF raw/Flate Image XObject pixels and native text retain independent evidence', async () => {
  for (const flate of [false, true]) {
    const pixels = Buffer.from([0, 0, 255]), bytes = pdf({ content: 'q 8 0 0 6 0 0 cm /Im Do Q', resource: '/XObject << /Im 5 0 R >>',
      extra: [stream(flate ? deflateSync(pixels) : pixels, '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8' + (flate ? ' /Filter /FlateDecode' : ''))] });
    const { request, result } = await inspect(bytes, 'pdf'); assert.equal(result.status, 'complete', result.reason);
    assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), ppm(8, 6, [0, 0, 255]));
    const native = await parsePdfDocument({ version: '0.1', format: 'pdf', sourcePath: request.sourcePath, sourceBytes: bytes.length, sourceSha256: hash(bytes), limits: request.documentLimits });
    assert.equal(native.units[0]!.text, ''); assert.equal(native.units[0]!.status, 'empty');
  }
});

test('PDF DCT static RGB JPEG produces independent black pixel oracle and closes JPEG geometry', async () => {
  const canvas = new Canvas(2, 2, { gpu: false }); canvas.getContext('2d').fillRect(0, 0, 2, 2);
  const jpeg = await canvas.toBuffer('jpg', { quality: 1 });
  const imagePdf = (bytes: Buffer, width: number) => pdf({ content: 'q 8 0 0 6 0 0 cm /Im Do Q', resource: '/XObject << /Im 5 0 R >>',
    extra: [stream(bytes, '/Type /XObject /Subtype /Image /Width ' + width + ' /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode')] });
  const { result } = await inspect(imagePdf(jpeg, 2), 'pdf'); assert.equal(result.status, 'complete', result.reason);
  assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), ppm(8, 6, [0, 0, 0]));
  failed((await inspect(imagePdf(jpeg, 3), 'pdf')).result, /DCT geometry/);
  failed((await inspect(imagePdf(jpeg.subarray(0, jpeg.length - 2), 2), 'pdf')).result, /JPEG/);
});

test('PDF byte closure rejects external/escaped streams, JPX, inline, huge empty images and unindexed extents', async () => {
  const cases: [Buffer, RegExp][] = [
    [pdf({ contentDictionary: '/F (file:///tmp/source)' }), /external file stream/],
    [pdf({ contentDictionary: '/#46 (https://example.invalid/source)' }), /external file stream/],
    [pdf({ contentDictionary: '/Filter /JPXDecode' }), /JPXDecode/],
    [pdf({ content: 'BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI' }), /inline image/],
    [pdf({ extra: [stream('', '/Subtype /Image /Width 2147483647 /Height 2147483647')] }), /Image dimensions/],
    [pdf({ extra: [stream('x', '/Subtype /Image /Width 0 /Height 1')] }), /Image dimensions/],
    [pdf({ contentDictionary: '/Filter /LZWDecode' }), /stream filter/], [pdf({ trailer: '/Encrypt 1 0 R' }), /trailer Encrypt/],
    [pdf({ trailer: '/Prev 0' }), /trailer Prev/], [pdf({ extra: ['<< /Type /ObjStm >>'] }), /ObjStm/],
    [pdf({ catalog: '/OpenAction 1 0 R' }), /OpenAction/], [pdf({ resource: '/XObject << /Missing 99 0 R >>' }), /dangling reference/],
    [Buffer.concat([pdf(), Buffer.from('trailing')]), /startxref\/EOF/],
    [assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 6] >>'], '', '/endobj'), /expected endobj/],
  ];
  for (const [bytes, reason] of cases) failed((await inspect(bytes, 'pdf')).result, reason);
  const { result } = await inspect(pdf({ content: '/BI BMC 1 0 0 rg 0 0 8 6 re f EMC' }), 'pdf'); assert.equal(result.status, 'complete', result.reason);
});

test('PDF stream extents, Flate consumption and tiny source/structure/canvas/payload quotas fail closed', async () => {
  const cases: [Buffer, Partial<DocumentRasterLimits>, RegExp][] = [
    [pdf(), { maxSourceBytes: 1 }, /SOURCE_LIMIT/], [pdf(), { maxPdfObjects: 2 }, /PDF_OBJECTS_LIMIT/],
    [pdf(), { maxPdfStructureTokens: 2 }, /PDF_STRUCTURE_TOKENS_LIMIT/], [pdf(), { maxPdfStructureDepth: 1 }, /PDF_STRUCTURE_DEPTH_LIMIT/],
    [pdf(), { maxPdfDecodedStreamBytes: 2 }, /PDF_DECODED_STREAM_BYTES_LIMIT/], [pdf(), { maxEdge: 4 }, /RASTER_EDGE_LIMIT/],
    [pdf(), { maxPixelsPerUnit: 47 }, /RASTER_PIXELS_LIMIT/], [pdf(), { maxRasterBytes: 1 }, /RASTER_BYTES_LIMIT/],
    [pdf(), { maxCanvasLivePixels: 47 }, /CANVAS_LIVE_PIXELS_LIMIT/], [pdf(), { maxCanvasAllocationPixels: 47 }, /CANVAS_ALLOCATION_PIXELS_LIMIT/],
    [pdf({ content: Buffer.concat([deflateSync(Buffer.from('0 0 8 6 re f')), Buffer.from('suffix')]), contentDictionary: '/Filter /FlateDecode' }), {}, /Flate trailing bytes/],
    [assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 6] /Contents 4 0 R >>', '<< /Length 1 >>\nstream\nabcdef\nendstream']), {}, /expected endstream/],
  ];
  for (const [bytes, limits, reason] of cases) failed((await inspect(bytes, 'pdf', limits)).result, reason);
  const tinyFooter = await input(pdf(), 'pdf', { maxWorkerPayloadBytes: 1000 });
  await assert.rejects(extractDocumentRaster(tinyFooter), /failure footer exceeds worker payload/);
  const { result } = await inspect(pdf({ pages: 3 }), 'pdf', { maxPdfDocumentPages: 2 }); failed(result, /PDF_DOCUMENT_PAGES_LIMIT/); assert.equal(result.totalUnits, 3);
  failed((await inspect(pdf(), 'pdf', {}, 2)).result, /UNIT_OUT_OF_RANGE/);
});

test('DOCX repeated embedded source bytes retain distinct main-body locations and native text', async () => {
  const body = paragraph(drawing() + drawing()) + '<w:tbl><w:tr><w:tc>' + paragraph(drawing()) + '</w:tc></w:tr></w:tbl>' +
    '<w:sdt><w:sdtContent>' + paragraph(drawing()) + '</w:sdtContent></w:sdt>';
  const bytes = docx({ body }), results: DocumentRasterResult[] = [];
  for (let unit = 1; unit <= 3; unit++) {
    const { request, result } = await inspect(bytes, 'docx', {}, unit); results.push(result); assert.equal(result.status, 'complete', result.reason);
    assert.equal(result.totalUnits, 3); assert.ok(result.locator?.kind === 'docx-image'); assert.equal(result.locator.occurrence, unit);
    assert.equal(result.locator.embeddedPart, 'word/media/pixels.png'); assert.equal(result.locator.embeddedSha256, hash(image));
    assert.equal(result.locator.embeddedCrc32, crc32(image)); assert.deepEqual([result.locator.width, result.locator.height], [2, 1]);
    assert.deepEqual(Buffer.from(result.payload!.dataBase64, 'base64'), image); assert.equal(result.metrics.readBytes, bytes.length * 2);
    assert.ok(result.metrics.expandedBytes > image.length); assert.equal(result.metrics.canvasAllocationPixels, 0);
    assert.ok(result.limitations.includes('omitted-main-structure:sdt'));
    if (unit === 1) { const native = await parseDocxDocument({ version: '0.1', format: 'docx', sourcePath: request.sourcePath, sourceBytes: bytes.length, sourceSha256: hash(bytes), limits: request.documentLimits }); assert.match(native.units[0]!.text, /中文 SOURCE/); }
  }
  assert.equal(new Set(results.map(r => (r.locator as { structurePath: string }).structurePath)).size, 3);
});

test('DOCX closes every ZIP CRC and rejects external/aliased/missing/wrong-type/linked images', async () => {
  const cases: [Buffer, RegExp][] = [
    [docx({ relations: imageRelation('TargetMode="External"') }), /EXTERNAL_IMAGE/], [docx({ omitImage: true }), /missing target/],
    [docx({ relations: imageRelation().replace('media/pixels.png', '../word/media/pixels.png') }), /target segments/],
    [docx({ relations: imageRelation().replace('media/pixels.png', 'media/./pixels.png') }), /target segments/],
    [docx({ relations: imageRelation().replace('media/pixels.png', 'media/%70ixels.png') }), /relationship target/],
    [docx({ relations: imageRelation().replace('media/pixels.png', 'media/pixels.png#fragment') }), /relationship target/],
    [docx({ relations: imageRelation().replace(OFFICE + 'image', OFFICE + 'hyperlink') }), /wrong image relationship/],
    [docx({ relations: imageRelation() + imageRelation() }), /relationship attributes/],
    [docx({ body: paragraph(drawing('r:link="img"')) }), /DRAWING_UNSUPPORTED/],
    [docx({ body: paragraph(drawing('r:embed="img" r:link="img"')) }), /DRAWING_UNSUPPORTED/],
    [docx({ extra: [{ name: 'word/unused.bin', data: 'unselected CRC', crc: 0 }] }), /CRC/],
    [docx({ image: Buffer.from('bad image') }), /PNG/], [docx({ types: types.replace('image/png', 'image/tiff') }), /IMAGE_FORMAT_UNSUPPORTED/],
    [docx({ types: types.replace(MAIN, MAIN.replace('document.main', 'macroEnabled.main')) }), /MACRO_REJECTED/],
    [docx({ document: '<!DOCTYPE a><a/>' }), /DTD/], [docx({ body: '<w:tc>' + paragraph(drawing()) + '</w:tc>' }), /basic table placement/],
    [docx({ body: '<w:p>' + paragraph(drawing()) + '</w:p>' }), /paragraph placement/],
  ];
  for (const [bytes, reason] of cases) failed((await inspect(bytes, 'docx')).result, reason);
});

test('DOCX package/XML/image expanded quotas retain exact failed state', async () => {
  for (const [limits, documentLimits, reason] of [
    [{ maxEmbeddedBytesPerUnit: image.length - 1 }, {}, /EMBEDDED_BYTES_LIMIT/], [{ maxPixelsPerUnit: 1 }, {}, /PIXEL_LIMIT/],
    [{ maxEdge: 1 }, {}, /EDGE_LIMIT/], [{ maxImageOccurrences: 0 }, {}, /IMAGE_OCCURRENCES_LIMIT/],
    [{}, { maxDocxEntries: 1 }, /ENTRY_LIMIT/], [{}, { maxDocxDeclaredExpandedBytes: 1 }, /EXPANDED_BYTES_LIMIT/],
    [{}, { maxXmlPartBytes: 1 }, /XML_PART_BYTES_LIMIT/], [{}, { maxXmlReadBytes: 1 }, /XML_READ_BYTES_LIMIT/],
    [{}, { maxXmlNodes: 1 }, /XML_NODES_LIMIT/], [{}, { maxXmlDepth: 1 }, /XML_DEPTH_LIMIT/],
  ] as [Partial<DocumentRasterLimits>, Partial<DocumentLimits>, RegExp][]) failed((await inspect(docx(), 'docx', limits, 1, documentLimits)).result, reason);
  failed((await inspect(docx(), 'docx', {}, 2)).result, /UNIT_OUT_OF_RANGE/);
});

test('DOCX valid replacement between hash/read and ZIP reopen remains fatal after original bytes are restored', async () => {
  const original = docx({ body: paragraph(drawing()) + paragraph(drawing()) }), alternate = docx();
  const request = await input(original, 'docx'), open = ZipArchive.open, close = ZipArchive.prototype.close;
  ZipArchive.open = async function(path, policy, signal, onMetadata) {
    await writeFile(request.sourcePath, alternate); return open.call(this, path, policy, signal, onMetadata);
  };
  ZipArchive.prototype.close = async function() {
    try { await close.call(this); } finally { await writeFile(request.sourcePath, original); }
  };
  try { await assert.rejects(extractDocumentRaster(request), /CATALOG_SOURCE_CHANGED/); }
  finally { ZipArchive.open = open; ZipArchive.prototype.close = close; await writeFile(request.sourcePath, original); }
  assert.deepEqual(await readFile(request.sourcePath), original);
});

test('source/runtime identities, request schema and canonical bounded worker stdout remain closed', async () => {
  const request = await input(pdf(), 'pdf');
  await assert.rejects(extractDocumentRaster({ ...request, sourceSha256: '0'.repeat(64) }), /CATALOG_SOURCE_CHANGED/);
  await assert.rejects(extractDocumentRaster({ ...request, runtime: { ...runtime, node: { ...runtime.node, sha256: '0'.repeat(64) } } }), /DOCUMENT_RASTER_RUNTIME_/);
  await assert.rejects(extractDocumentRaster({ ...request, unexpected: true } as DocumentRasterRequest), /REQUEST_INVALID/);
  const path = join(scratch, 'worker-request.json'); await writeFile(path, JSON.stringify(request, null, 2) + '\n');
  const worker = join(dirname(fileURLToPath(import.meta.url)), '../src/adapters/document-raster-worker.ts');
  const child = spawnSync(process.execPath, ['--max-old-space-size=512', worker, path], { cwd: scratch, encoding: 'utf8', timeout: 30000, maxBuffer: request.limits.maxWorkerPayloadBytes });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout); assertDocumentOcr('result', result);
  assert.equal(child.stdout, JSON.stringify(result, null, 2) + '\n'); assert.equal(result.status, 'complete', result.reason);
  await writeFile(join(scratch, 'worker-stdout.log'), child.stdout); await writeFile(join(scratch, 'worker-stderr.log'), child.stderr);
  const wrong = spawnSync(process.execPath, ['--max-old-space-size=512', worker, path, 'unexpected'], { cwd: scratch, encoding: 'utf8', timeout: 30000 });
  assert.equal(wrong.status, 1); assert.equal(wrong.stdout, ''); assert.match(wrong.stderr, /request path argv/);
  for (const [name, bad, prefix] of [
    ['source', { ...request, sourceSha256: '0'.repeat(64) }, 'CATALOG_SOURCE_CHANGED'],
    ['runtime', { ...request, runtime: { ...runtime, node: { ...runtime.node, bytes: runtime.node.bytes + 1 } } }, 'DOCUMENT_RASTER_RUNTIME_'],
  ] as const) {
    const file = join(scratch, 'fatal-' + name + '.json'); await writeFile(file, JSON.stringify(bad, null, 2) + '\n');
    const fatal = spawnSync(process.execPath, ['--max-old-space-size=512', worker, file], { cwd: scratch, encoding: 'utf8', timeout: 30000 });
    assert.equal(fatal.status, 1); assert.equal(fatal.stdout, '');
    const first = fatal.stderr.split('\n')[0]!; assert.ok(first.startsWith('DOCUMENT_RASTER_FATAL:'));
    const wire = JSON.parse(first.slice('DOCUMENT_RASTER_FATAL:'.length)); assert.deepEqual(Object.keys(wire), ['code']); assert.ok(wire.code.startsWith(prefix));
    await writeFile(join(scratch, 'fatal-' + name + '.stderr.log'), fatal.stderr);
  }
});
