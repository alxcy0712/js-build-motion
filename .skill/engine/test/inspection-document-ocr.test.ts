import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { inspectDocumentOcr, effectiveDocumentOcrPolicy } from '../src/adapters/inspection-document-ocr.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { INSPECT_POLICY_06, emptyCatalogCounts, type Technical } from '../src/project/catalog.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { makeZip } from './fixtures/zip.ts';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function image() {
  const chunk = (name: string, bytes: Buffer) => { const kind = Buffer.from(name), result = Buffer.alloc(12 + bytes.length); result.writeUInt32BE(bytes.length); kind.copy(result, 4); bytes.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([kind, bytes])), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(3); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 250, 40, 30, 0, 10, 150, 90, 128, 4, 5, 6, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function docx(bytes: Buffer, occurrences = 1, target = 'media/image1.png') {
  return makeZip([{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p>${Array.from({ length: occurrences }, () => '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>').join('')}</w:p></w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>` }, { name: 'word/media/image1.png', data: bytes }]);
}
function fixture(sourceBytes = docx(image()), documentOcr: Record<string, unknown> = {}) {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(output, 'document-ocr-adapter-'))), policy = { ...INSPECT_POLICY_06, documentOcr: { ...INSPECT_POLICY_06.documentOcr, enabled: true, docxImages: [1], ...documentOcr } },
    inspectionId = `inspection-${randomUUID()}`, evidenceDir = join(dir, 'out/.tmp', inspectionId), source = join(dir, 'source.docx'), tools: any[] = [], counts = emptyCatalogCounts();
  mkdirSync(evidenceDir, { recursive: true }); writeFileSync(source, sourceBytes);
  cpSync(PROJECT_ROOT, join(dir, '.engine'), { recursive: true, filter: path => !['test', '.research', 'projects', 'assets/asr'].some(prefix => relative(PROJECT_ROOT, path) === prefix || relative(PROJECT_ROOT, path).startsWith(prefix + '/')) });
  const journals: any[] = [];
  const context = { projectDir: dir, temporaryDir: join(dir, 'out/.tmp'), evidenceDir, publishedDir: `assets/derived/inspection/${inspectionId}`, policy, counts, tools,
    signal: new AbortController().signal, check() {}, sourceBytes: sourceBytes.length, sourceSha256: sha(sourceBytes), policySha256: sha(importJsonText(policy)),
    documentOcrBudget: { units: 0, pixels: 0, embeddedBytes: 0 }, recordDocumentOcrInvocation: async (value: any) => {
      journals.push(value); const path = `runs/document-ocr-command-${randomUUID()}.json`, data = Buffer.from(importJsonText(value)); mkdirSync(join(dir, 'runs'), { recursive: true }); writeFileSync(join(dir, path), data); return { path, bytes: data.length, sha256: sha(data) };
    } };
  const result: Technical = { status: 'partial', format: 'docx', method: 'fixture-native', reason: 'native fixture', raw: null, streams: [], evidence: [], text: null, containerDuration: null, limitations: [] };
  return { dir, source, context, result, journals, data: (kind: string) => readFileSync(join(evidenceDir, result.evidence.find(e => e.kind === kind)!.path.split('/').at(-1)!)), cleanup: () => { if (process.env.DOCUMENT_OCR_KEEP_FIXTURES === '1') console.log(`PRESERVED_DOCUMENT_OCR_SCENE:${dir}`); else rmSync(dir, { recursive: true, force: true }); } };
}

test('document OCR disabled and empty selection produce explicit descriptors without tools or files', async () => {
  for (const options of [{ enabled: false }, { docxImages: [] }]) {
    const f = fixture(undefined, options); try { await inspectDocumentOcr(f.source, 'docx', f.result, f.context); assert.equal(f.result.documentOcr!.status, options.enabled === false ? 'disabled' : 'skipped'); assert.equal(f.context.tools.length, 0); assert.equal(f.result.evidence.length, 0); assert.equal(f.journals.length, 0); } finally { f.cleanup(); }
  }
});
test('document OCR DOCX occurrence preserves independent white alpha pixels and source identity', async () => {
  const bytes = image(), f = fixture(docx(bytes, 2), { docxImages: [1, 2] }); try {
    await inspectDocumentOcr(f.source, 'docx', f.result, f.context); assert.equal(f.result.documentOcr!.status, 'completed', f.result.documentOcr!.reason);
    assert.equal(f.result.evidence.length, 9); assert.equal(f.journals.length, 2); assert.equal(f.context.documentOcrBudget.units, 2); assert.equal(f.context.documentOcrBudget.pixels, 6); assert.equal(f.context.documentOcrBudget.embeddedBytes, 2 * bytes.length);
    const expected = Buffer.concat([Buffer.from('P6\n3 1\n255\n'), Buffer.from([255, 255, 255, Math.floor((10 * 128 + 255 * 127 + 127) / 255), Math.floor((150 * 128 + 255 * 127 + 127) / 255), Math.floor((90 * 128 + 255 * 127 + 127) / 255), 4, 5, 6])]);
    assert.deepEqual(f.data('document-ocr-raster'), expected);
    const overall = JSON.parse(f.data('document-ocr-selection-map').toString()); assert.equal(overall.units[0].locator.embeddedSha256, sha(bytes)); assert.equal(overall.units[0].locator.embeddedPart, 'word/media/image1.png');
    assert.notEqual(overall.units[0].locator.structurePath, overall.units[1].locator.structurePath); assert.equal(overall.units[0].locator.occurrence, 1); assert.equal(overall.units[1].locator.occurrence, 2);
    assert.equal(overall.source.sha256, f.context.sourceSha256); assert.equal(overall.units.every((u: any) => u.invocation?.sha256), true); assert.equal(f.result.text, null);
  } finally { f.cleanup(); }
});
test('document OCR local missing relationship target publishes failed selection with closed journal', async () => {
  const f = fixture(docx(image(), 1, 'media/missing.png')); try {
    await inspectDocumentOcr(f.source, 'docx', f.result, f.context); assert.equal(f.result.documentOcr!.status, 'failed'); assert.equal(f.result.evidence.length, 1); assert.equal(f.journals.length, 1);
    const map = JSON.parse(f.data('document-ocr-selection-map').toString()); assert.equal(map.units[0].status, 'failed'); assert.match(map.units[0].reason, /PART|MISSING|ZIP/i); assert.equal(map.units[0].mapEvidenceId, null); assert.equal(f.journals[0].reason, map.units[0].reason); assert.equal(f.journals[0].workerResult.status, 'failed');
  } finally { f.cleanup(); }
});
test('document OCR shared attempt quota rolls back published unit files', async () => {
  const f = fixture(docx(image(), 2), { docxImages: [1, 2], maxUnitsPerAttempt: 1 }); try {
    await assert.rejects(inspectDocumentOcr(f.source, 'docx', f.result, f.context), /UNIT_COUNT_LIMIT/); assert.equal(f.result.evidence.length, 0); assert.equal(f.context.documentOcrBudget.units, 2);
  } finally { f.cleanup(); }
});
test('document OCR effective limits retain independent aggregate and per-unit quotas', () => {
  const policy = { ...INSPECT_POLICY_06, maxSourceBytes: 100, maxSourcePixels: 100, maxTextBytes: 100 };
  const value = effectiveDocumentOcrPolicy(policy); assert.equal(value.maxSourceBytes, 100); assert.equal(value.maxPixelsPerUnit, 100); assert.equal(value.ocr.maxOcrTextBytes, 100);
  assert.equal(value.maxTotalPixels, INSPECT_POLICY_06.documentOcr.maxTotalPixels); assert.equal(value.maxTotalEmbeddedBytes, INSPECT_POLICY_06.documentOcr.maxTotalEmbeddedBytes);
});
