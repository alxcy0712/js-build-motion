import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, FontLibrary } from 'skia-canvas';
import { parsePdfDocument } from '../src/adapters/document-pdf.ts';
import { assertDocument, DEFAULT_DOCUMENT_LIMITS, documentArtifacts, validateDocumentMap,
  type DocumentLimits, type DocumentParseRequest, type DocumentParseResult } from '../src/project/document.ts';

const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), policyHash = '0'.repeat(64);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function fixture(data: Buffer) {
  const output = resolve(engineRoot, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'pdf-fixture-'))), sourcePath = join(root, 'source.pdf'); writeFileSync(sourcePath, data);
  return { sourcePath, request(limits: Partial<DocumentLimits> = {}): DocumentParseRequest {
    return { version: '0.1', format: 'pdf', sourcePath, sourceBytes: data.length, sourceSha256: hash(data), limits: { ...DEFAULT_DOCUMENT_LIMITS, ...limits } };
  }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
function verified(request: DocumentParseRequest, result: DocumentParseResult) {
  assertDocument('result', result); const artifacts = documentArtifacts(result, policyHash);
  assertDocument('map', artifacts.map); validateDocumentMap(artifacts.map, artifacts.text, request.limits);
  assert.equal(result.sourceBytes, request.sourceBytes); assert.equal(result.sourceSha256, request.sourceSha256);
  assert.deepEqual(result.parser, { id: 'pdfjs-dist', version: '6.4.299' }); return artifacts;
}
function assemble(objects: (string | Buffer)[], trailer = ''): Buffer {
  const pieces = [Buffer.from('%PDF-1.7\n% fictional fixture\n')], offsets = [0]; let offset = pieces[0]!.length;
  for (const [index, body] of objects.entries()) {
    offsets.push(offset); const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    pieces.push(bytes); offset += bytes.length;
  }
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
function pdf(pages: { text?: string; content?: string; rotate?: number }[], action = ''): Buffer {
  const objects: (string | Buffer)[] = [`<< /Type /Catalog /Pages 2 0 R ${action} >>`, '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'], refs: string[] = [];
  for (const page of pages) {
    const content = page.content ?? (page.text ? `BT /F1 18 Tf 20 100 Td (${page.text}) Tj ET` : ''), contentId = objects.length + 1;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    refs.push(`${objects.length + 1} 0 R`); objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Rotate ${page.rotate ?? 0} /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${refs.join(' ')}] >>`; return assemble(objects);
}
const PASSWORD_PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, n) => n); let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % key.length]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!]; }
  const output = Buffer.alloc(data.length); let i = 0; j = 0;
  for (let n = 0; n < data.length; n++) { i = (i + 1) % 256; j = (j + state[i]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!]; output[n] = data[n]! ^ state[(state[i]! + state[j]!) % 256]!; }
  return output;
}
function encryptedPdf(password: string): Buffer {
  const pad = (value: string) => Buffer.concat([Buffer.from(value), PASSWORD_PAD]).subarray(0, 32);
  const md5 = (...buffers: Buffer[]) => { const digest = createHash('md5'); for (const buffer of buffers) digest.update(buffer); return digest.digest(); };
  const owner = rc4(md5(pad('owner')).subarray(0, 5), pad(password)), permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const id = md5(Buffer.from('fictional encrypted fixture')), key = md5(pad(password), owner, permissions, id).subarray(0, 5), user = rc4(key, PASSWORD_PAD);
  return assemble(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << >> >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`], `/Encrypt 4 0 R /ID [<${id.toString('hex')}><${id.toString('hex')}>]`);
}

test('real embedded Chinese native text, empty, image and mixed pages retain true page identities', async () => {
  FontLibrary.use('DocumentFixture', [join(engineRoot, 'assets/fonts/LXGWWenKai-Regular.ttf')]);
  const canvas = new Canvas(320, 240, { gpu: false }), ctx = canvas.getContext('2d'); ctx.font = '18px DocumentFixture'; ctx.fillText('中文解析 第一页 123', 20, 50);
  canvas.newPage();
  const image = new Canvas(8, 8, { gpu: false }); image.getContext('2d').fillRect(0, 0, 8, 8);
  canvas.newPage().drawImage(image, 0, 0, 64, 64);
  const mixed = canvas.newPage(); mixed.drawImage(image, 0, 0, 64, 64); mixed.font = '18px DocumentFixture'; mixed.fillText('中文混合页', 20, 110);
  const data = await canvas.toBuffer('pdf'), f = fixture(data); try {
    const request = f.request(), result = await parsePdfDocument(request), { text, map } = verified(request, result);
    assert.equal(result.status, 'supported', result.reason); assert.deepEqual(result.coverage.parsedPages, [1, 2, 3, 4]); assert.equal(result.coverage.totalPages, 4);
    assert.deepEqual(result.units.map(u => u.status), ['complete', 'empty', 'empty', 'complete']);
    assert.match(text.toString(), /中文解析 第一页 123/); assert.match(text.toString(), /中文混合页/);
    for (const [index, unit] of map.units.entries()) { assert.deepEqual(unit.locator, { kind: 'pdf', page: index + 1 }); assert.equal(unit.id, `pdf-page-${index + 1}`); assert.equal(unit.ordinal, index + 1); }
    for (const n of [2, 3]) assert.ok(result.coverage.omitted.some(v => v.startsWith(`Page ${n}: native-text-empty`)));
    assert.equal(result.metrics.sourceReadBytes, data.length); assert.equal(result.metrics.maxRSSKiB, null); assert.deepEqual(readFileSync(f.sourcePath), data);
  } finally { f.cleanup(); }
});

test('rotation and drawn column order retain native text with explicit geometric-order limits', async () => {
  const f = fixture(pdf([{ text: 'ROTATED', rotate: 90 }, { content: 'BT /F1 12 Tf 140 150 Td (RIGHT-FIRST) Tj -120 -20 Td (LEFT-SECOND) Tj ET' }])); try {
    const request = f.request(), result = await parsePdfDocument(request); verified(request, result);
    assert.equal(result.status, 'supported', result.reason); assert.match(result.units[0]!.text, /ROTATED/);
    assert.ok(result.units[1]!.text.indexOf('RIGHT-FIRST') < result.units[1]!.text.indexOf('LEFT-SECOND'));
    assert.ok(result.limitations.some(v => v.startsWith('PDFJS_ITEM_ORDER:') && v.includes('unverified')));
  } finally { f.cleanup(); }
});

test('Chinese Type0 text without ToUnicode resolves through fixed local packed CMaps', async () => {
  const content = 'BT /F1 18 Tf 20 100 Td <4E2D658700200041> Tj ET', f = fixture(assemble([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ])); try {
    const request = f.request(), result = await parsePdfDocument(request), { text } = verified(request, result);
    assert.equal(result.status, 'supported', result.reason); assert.equal(text.toString(), '中文 A');
  } finally { f.cleanup(); }
});

test('password requests are unsupported; empty-password encryption reports observed permissions', async () => {
  for (const password of ['secret', '']) { const f = fixture(encryptedPdf(password)); try {
    const request = f.request(), result = await parsePdfDocument(request); verified(request, result);
    assert.equal(result.status, password ? 'unsupported' : 'supported', result.reason);
    if (password) { assert.equal(result.reason, 'DOCUMENT_PASSWORD_REQUIRED'); assert.equal(result.units.length, 0); }
    else { assert.ok(result.limitations.some(v => v.startsWith('PDF_ENCRYPTION: filter=Standard; permissions='))); assert.equal(result.units[0]!.status, 'empty'); }
  } finally { f.cleanup(); } }
});

test('unsupported signatures and damaged xref/page trees produce closed per-asset results', async () => {
  for (const data of [Buffer.from('not a PDF'), Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 999 0 R >> endobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer << /Root 1 0 R /Size 2 >>\nstartxref\n999999\n%%EOF\n')]) {
    const f = fixture(data); try { const request = f.request(), result = await parsePdfDocument(request); verified(request, result);
      assert.equal(result.status, data[0] === 37 ? 'failed' : 'unsupported', result.reason); assert.equal(result.units.length, 0); assert.deepEqual(readFileSync(f.sourcePath), data);
    } finally { f.cleanup(); }
  }
});

test('PDF JavaScript and URI actions remain inert input data', async () => {
  const f = fixture(pdf([{ text: 'VISIBLE ONLY' }], '/OpenAction << /S /JavaScript /JS (throw forbidden-action) >> /AA << /WC << /S /URI /URI (https://invalid.example/private) >> >>')); try {
    const request = f.request(), result = await parsePdfDocument(request); const { text } = verified(request, result);
    assert.equal(result.status, 'supported', result.reason); assert.equal(text.toString(), 'VISIBLE ONLY'); assert.ok(result.limitations.some(v => v.includes('JavaScript actions')));
  } finally { f.cleanup(); }
});

test('XFA is reported as omitted while native page text remains verifiable', async () => {
  const content = 'BT /F1 12 Tf 20 100 Td (NATIVE) Tj ET', xfa = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>', f = fixture(assemble([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 7 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    `<< /Length ${Buffer.byteLength(xfa)} >>\nstream\n${xfa}\nendstream`, '<< /Fields [] /XFA 6 0 R >>'
  ])); try {
    const request = f.request(), result = await parsePdfDocument(request), { text } = verified(request, result);
    assert.equal(result.status, 'partial', result.reason); assert.equal(result.reason, 'DOCUMENT_XFA_OMITTED'); assert.equal(text.toString(), 'NATIVE');
    assert.ok(result.coverage.omitted.some(v => v.startsWith('XFA content')));
  } finally { f.cleanup(); }
});

test('source-byte admission permits equality and records bounded no-read partial above it', async () => {
  const data = pdf([{ text: 'ONE' }]), f = fixture(data); try {
    const exact = f.request({ maxDocumentSourceBytes: data.length }), accepted = await parsePdfDocument(exact); verified(exact, accepted); assert.equal(accepted.status, 'supported');
    const low = f.request({ maxDocumentSourceBytes: data.length - 1 }), limited = await parsePdfDocument(low); verified(low, limited); assert.equal(limited.status, 'partial'); assert.match(limited.reason, /^DOCUMENT_SOURCE_LIMIT:/); assert.equal(limited.metrics.sourceReadBytes, 0); assert.equal(limited.coverage.totalPages, null);
  } finally { f.cleanup(); }
});

for (const quota of ['maxPdfPages', 'maxDocumentUnits'] as const) test(`${quota} allows exact count, retains complete prefix and closes zero quota`, async () => {
  const f = fixture(pdf([{ text: 'ONE' }, { text: 'TWO' }, { text: 'THREE' }])); try {
    for (const maximum of [3, 2, 0]) { const request = f.request({ [quota]: maximum }), result = await parsePdfDocument(request); verified(request, result);
      assert.equal(result.status, maximum === 3 ? 'supported' : 'partial', result.reason); assert.equal(result.units.length, maximum);
      assert.deepEqual(result.coverage.parsedPages, Array.from({ length: maximum }, (_, n) => n + 1)); assert.equal(result.coverage.totalPages, 3);
      if (maximum < 3) { assert.equal(result.reason, quota === 'maxPdfPages' ? 'DOCUMENT_PAGE_LIMIT' : 'DOCUMENT_UNIT_LIMIT'); assert.ok(result.coverage.omitted.some(v => v.startsWith(`Pages ${maximum + 1}-3:`))); }
    }
  } finally { f.cleanup(); }
});

test('text-byte equality and one-byte excess preserve whole-page prefix with explicit skipped location', async () => {
  const f = fixture(pdf([{ text: 'FIRST' }, { text: 'SECOND' }])); try {
    const full = await parsePdfDocument(f.request()), textBytes = verified(f.request(), full).text.length;
    for (const maximum of [textBytes, textBytes - 1, 0]) { const request = f.request({ maxDocumentTextBytes: maximum }), result = await parsePdfDocument(request), { text, map } = verified(request, result);
      assert.equal(result.status, maximum === textBytes ? 'supported' : 'partial', result.reason);
      if (maximum < textBytes) { const skipped = result.units.at(-1)!; assert.equal(skipped.status, 'skipped'); assert.equal(skipped.text, ''); assert.match(skipped.reason, /^DOCUMENT_TEXT_LIMIT:/); assert.equal(map.units.at(-1)!.byteStart, null); assert.equal(map.units.at(-1)!.byteEnd, null); assert.equal(text.toString(), maximum ? 'FIRST' : ''); }
    }
  } finally { f.cleanup(); }
});

test('empty-page LF separators obey exact text limit and remain empty unit ranges', async () => {
  const f = fixture(pdf([{}, {}])); try {
    const exact = f.request({ maxDocumentTextBytes: 1 }), result = await parsePdfDocument(exact), artifacts = verified(exact, result);
    assert.equal(result.status, 'supported'); assert.equal(artifacts.text.toString(), '\n'); assert.deepEqual(artifacts.map.units.map(u => [u.byteStart, u.byteEnd]), [[0, 0], [1, 1]]);
    const low = f.request({ maxDocumentTextBytes: 0 }), partial = await parsePdfDocument(low); assert.equal(partial.status, 'partial'); assert.deepEqual(partial.units.map(u => u.status), ['empty', 'skipped']); assert.equal(verified(low, partial).text.length, 0);
  } finally { f.cleanup(); }
});

test('oversized streamed text retains the completed page prefix and no partial current page', async () => {
  const content = `BT /F1 12 Tf ${Array.from({ length: 2000 }, () => '1 0 0 1 20 100 Tm (abcd efgh ijkl mnop) Tj').join(' ')} ET`, f = fixture(pdf([{ text: 'PREFIX' }, { content }, { text: 'AFTER' }])); try {
    const request = f.request({ maxDocumentTextBytes: 1024 }), result = await parsePdfDocument(request), { text } = verified(request, result);
    assert.equal(result.status, 'partial', result.reason); assert.equal(result.reason, 'DOCUMENT_TEXT_LIMIT'); assert.equal(text.toString(), 'PREFIX');
    assert.deepEqual(result.coverage.parsedPages, [1]); assert.deepEqual(result.units.map(u => [u.locator, u.status]), [[{ kind: 'pdf', page: 1 }, 'complete'], [{ kind: 'pdf', page: 2 }, 'skipped']]);
  } finally { f.cleanup(); }
});

test('compact map lower-bound and payload exact limits reject excess and discard unverifiable text', async () => {
  const f = fixture(pdf([{ text: 'BOUNDARY' }])); try {
    const baseRequest = f.request(), base = await parsePdfDocument(baseRequest), artifacts = verified(baseRequest, base);
    const mapBytes = Buffer.byteLength(JSON.stringify(artifacts.map)), payloadBytes = Buffer.byteLength(JSON.stringify(base));
    for (const [quota, maximum, reason] of [['maxDocumentMapBytes', mapBytes, 'DOCUMENT_MAP_LIMIT'], ['maxWorkerPayloadBytes', payloadBytes, 'CATALOG_BINARY_LIMIT']] as const) {
      const exact = f.request({ [quota]: maximum }), accepted = await parsePdfDocument(exact); verified(exact, accepted); assert.equal(accepted.status, 'supported');
      const low = f.request({ [quota]: maximum - 1 }), rejected = await parsePdfDocument(low); verified(low, rejected); assert.equal(rejected.status, 'failed'); assert.equal(rejected.reason, reason); assert.equal(rejected.units.length, 0);
    }
    await assert.rejects(parsePdfDocument(f.request({ maxWorkerPayloadBytes: 0 })), /DOCUMENT_PROTOCOL_INVALID/);
  } finally { f.cleanup(); }
});

test('same-size source replacements, wrong source size and missing source escalate source identity failure', async () => {
  const data = pdf([{ text: 'ORIGINAL' }]), f = fixture(data); try {
    const request = f.request(), replacement = Buffer.from(data); replacement[replacement.indexOf('ORIGINAL')] = 88; writeFileSync(f.sourcePath, replacement);
    await assert.rejects(parsePdfDocument(request), /CATALOG_SOURCE_CHANGED/);
    writeFileSync(f.sourcePath, data); await assert.rejects(parsePdfDocument({ ...request, sourceBytes: data.length - 1 }), /CATALOG_SOURCE_CHANGED/);
    rmSync(f.sourcePath); await assert.rejects(parsePdfDocument(request), /CATALOG_SOURCE_CHANGED/);
  } finally { f.cleanup(); }
});

test('the adapter requires the closed PDF request contract', async () => {
  const f = fixture(pdf([{}])); try {
    await assert.rejects(parsePdfDocument({ ...f.request(), format: 'docx' }), /DOCUMENT_REQUEST_INVALID/);
    await assert.rejects(parsePdfDocument({ ...f.request(), extra: true } as DocumentParseRequest), /DOCUMENT_REQUEST_INVALID/);
  } finally { f.cleanup(); }
});
