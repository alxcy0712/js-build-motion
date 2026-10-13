import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { parseOcrTsv } from '../src/adapters/ocr-tsv.ts';
import { preflightOcrImage } from '../src/adapters/ocr-raster.ts';
import { assertOcr, DEFAULT_OCR_LIMITS, validateOcrEngine, validateOcrMap, validateOcrObservation, type OcrMap, type OcrObservation } from '../src/project/ocr.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const evidenceId = () => `evidence-${randomUUID()}`;
const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const row = (...fields: (string | number)[]) => fields.join('\t');
const rows = () => [
  row(1, 1, 0, 0, 0, 0, 0, 0, 64, 48, -1, ''),
  row(2, 1, 1, 0, 0, 0, 0, 0, 64, 48, -1, ''),
  row(3, 1, 1, 1, 0, 0, 0, 0, 64, 48, -1, ''),
  row(4, 1, 1, 1, 1, 0, 0, 0, 64, 10, -1, ''),
  row(5, 1, 1, 1, 1, 1, 1, 1, 10, 8, 95.25, '中文'),
  row(5, 1, 1, 1, 1, 2, 12, 1, 10, 8, 0.125, 'low'),
  row(4, 1, 1, 1, 2, 0, 0, 12, 64, 10, -1, ''),
  row(5, 1, 1, 1, 2, 1, 1, 13, 10, 8, 0, 'same'),
  row(5, 1, 1, 1, 2, 2, 12, 13, 10, 8, -1, 'same'),
];
const tsv = (data = rows()) => Buffer.from([header, ...data].join('\n') + '\n');
function engine() {
  const bytes = readFileSync(new URL('../ocr-dependencies.lock.json', import.meta.url)), lock = JSON.parse(bytes.toString());
  return { id: 'tesseract' as const, version: '5.5.0' as const, lockSha256: sha(bytes), platform: lock.platform, arch: lock.arch,
    tools: lock.tools, models: lock.models, languageSpec: lock.languageSpec, oem: lock.oem, psm: lock.psm, dpi: lock.dpi };
}
function mapFixture() {
  const raw = tsv(), parsed = parseOcrTsv(raw, 64, 48, DEFAULT_OCR_LIMITS), raster = Buffer.concat([Buffer.from('P6\n64 48\n255\n'), Buffer.alloc(64 * 48 * 3, 255)]);
  const map: OcrMap = { version: '0.1', kind: 'ocr-map', format: 'png_pipe', mapperVersion: 'ocr-tsv@0.1', status: parsed.status,
    scope: 'single-image-ocr', policySha256: sha('fictional policy'), source: { bytes: 100, sha256: sha('fictional source'), width: 64, height: 48 },
    raster: { evidenceId: evidenceId(), bytes: raster.length, sha256: sha(raster), width: 64, height: 48, encoding: 'P6/RGB8', background: 'white', transform: 'identity', orientationApplied: false },
    rawTsv: { evidenceId: evidenceId(), bytes: raw.length, sha256: sha(raw) }, text: { evidenceId: evidenceId(), bytes: parsed.text.length, sha256: sha(parsed.text) }, engine: engine(), regions: parsed.regions };
  return { map, text: parsed.text, raster, raw };
}
function observation(map: OcrMap): OcrObservation {
  const region = map.regions[0]!;
  return { version: '0.3', id: `observation-${randomUUID()}`, assetId: `asset-${randomUUID()}`, assetVersion: `asset-version-${randomUUID()}`,
    byteSha256: map.source.sha256, method: 'independent fixed OCR region', locator: { kind: 'ocr', evidenceId: map.text.evidenceId,
      mapEvidenceId: evidenceId(), rasterEvidenceId: map.raster.evidenceId, regionId: region.id, byteStart: region.byteStart, byteEnd: region.byteEnd },
    coverage: 'full', coverageScope: 'region-ocr-text', statement: 'The fixed region contains the recorded OCR bytes.', basis: 'observed', confidence: 0.5,
    limitations: ['OCR confidence measures the engine output.'], evidenceRefs: [] };
}

test('independent OCR canonical words preserve Chinese, low scores, duplicate text and separators', () => {
  const f = mapFixture();
  assert.equal(f.text.toString(), '中文 low\nsame same');
  assert.deepEqual(f.map.regions.map(r => [r.byteStart, r.byteEnd]), [[0, 6], [7, 10], [11, 15], [16, 20]]);
  assert.deepEqual(f.map.regions.map(r => r.engineConfidence), [95.25, 0.125, 0, null]);
  assert.notEqual(f.map.regions[2]!.id, f.map.regions[3]!.id);
  validateOcrMap(f.map, f.text, f.raster, f.raw, DEFAULT_OCR_LIMITS);
});

const unsafeTsv: [string, (data: string[]) => Buffer][] = [
  ['missing header', data => Buffer.from(data.join('\n'))],
  ['wrong header', data => Buffer.from(['unknown' + header, ...data].join('\n'))],
  ['invalid UTF8', data => Buffer.concat([tsv(data), Buffer.from([255])])],
  ['BOM', data => Buffer.concat([Buffer.from([239, 187, 191]), tsv(data)])],
  ['CRLF', data => Buffer.from(tsv(data).toString().replace(/\n/g, '\r\n'))],
  ['extra empty row', data => Buffer.concat([tsv(data), Buffer.from('\n')])],
  ['NUL token', data => { data[4] += '\0'; return tsv(data); }],
  ['extra column', data => { data[4] += '\textra'; return tsv(data); }],
  ['missing column', data => { data[4] = data[4].split('\t').slice(0, -1).join('\t'); return tsv(data); }],
  ['unknown level', data => { data[4] = data[4].replace(/^5\t/, '6\t'); return tsv(data); }],
  ['second page', data => { data.push(row(1, 2, 0, 0, 0, 0, 0, 0, 64, 48, -1, '')); return tsv(data); }],
  ['page geometry', data => { data[0] = row(1, 1, 0, 0, 0, 0, 0, 0, 63, 48, -1, ''); return tsv(data); }],
  ['orphan word', data => { data.splice(3, 1); return tsv(data); }],
  ['duplicate word identity', data => { data[5] = data[4]; return tsv(data); }],
  ['nonfinite confidence', data => { data[4] = data[4].replace('95.25', 'Infinity'); return tsv(data); }],
  ['NaN confidence', data => { data[4] = data[4].replace('95.25', 'NaN'); return tsv(data); }],
  ['confidence above maximum', data => { data[4] = data[4].replace('95.25', '100.01'); return tsv(data); }],
  ['confidence below sentinel', data => { data[4] = data[4].replace('95.25', '-2'); return tsv(data); }],
  ['negative word x', data => { data[4] = row(5, 1, 1, 1, 1, 1, -1, 1, 10, 8, 95, '中文'); return tsv(data); }],
  ['word outside image', data => { data[4] = row(5, 1, 1, 1, 1, 1, 60, 1, 10, 8, 95, '中文'); return tsv(data); }],
  ['zero width nonempty word', data => { data[4] = row(5, 1, 1, 1, 1, 1, 1, 1, 0, 8, 95, '中文'); return tsv(data); }],
  ['empty word illegal geometry', data => { data[4] = row(5, 1, 1, 1, 1, 1, 65, 1, 0, 0, -1, ''); return tsv(data); }],
  ['structure row text', data => { data[0] += 'instruction'; return tsv(data); }],
  ['structure row confidence', data => { data[0] = data[0].replace('-1', '0'); return tsv(data); }],
  ['stale paragraph parent', data => { data[4] = row(5, 1, 1, 2, 1, 1, 1, 1, 10, 8, 95, '中文'); return tsv(data); }],
];
for (const [name, change] of unsafeTsv) test(`independent OCR TSV rejects ${name}`, () => {
  assert.throws(() => parseOcrTsv(change(rows()), 64, 48, DEFAULT_OCR_LIMITS));
});

test('independent OCR no-text needs a legal whole-image page; empty stdout is rejected', () => {
  const raw = tsv(rows().slice(0, 1)), parsed = parseOcrTsv(raw, 64, 48, DEFAULT_OCR_LIMITS);
  assert.equal(parsed.status, 'no-text'); assert.equal(parsed.text.length, 0); assert.deepEqual(parsed.regions, []);
  assert.throws(() => parseOcrTsv(Buffer.alloc(0), 64, 48, DEFAULT_OCR_LIMITS));
  assert.throws(() => parseOcrTsv(tsv([]), 64, 48, DEFAULT_OCR_LIMITS));
});

test('independent OCR TSV quotas admit exact bytes, text, words and region count and reject one less', () => {
  const raw = tsv(), parsed = parseOcrTsv(raw, 64, 48, DEFAULT_OCR_LIMITS), wordBytes = 6;
  const cases = [['maxOcrTsvBytes', raw.length], ['maxOcrTextBytes', parsed.text.length], ['maxOcrWordBytes', wordBytes], ['maxOcrRegions', parsed.regions.length],
    ['maxOcrRows', rows().length], ['maxOcrRowBytes', Math.max(...rows().map(value => Buffer.byteLength(value)))]] as const;
  for (const [key, exact] of cases) {
    assert.deepEqual(parseOcrTsv(raw, 64, 48, { ...DEFAULT_OCR_LIMITS, [key]: exact }), parsed);
    assert.throws(() => parseOcrTsv(raw, 64, 48, { ...DEFAULT_OCR_LIMITS, [key]: exact - 1 }), key);
  }
  const malicious = rows(); malicious[4] = row(5, 1, 1, 1, 1, 1, 1, 1, 10, 8, 5, '$(touch escape);read /etc/passwd');
  assert.match(parseOcrTsv(tsv(malicious), 64, 48, DEFAULT_OCR_LIMITS).text.toString(), /\$\(touch escape\)/);
});

const mapMutations: [string, (f: ReturnType<typeof mapFixture>) => void][] = [
  ['text same-size replacement', f => { Buffer.from('文中').copy(f.text); }],
  ['raster same-size replacement', f => { f.raster[f.raster.length - 1] ^= 1; }],
  ['TSV same-size replacement', f => { f.raw[f.raw.length - 2] ^= 1; }],
  ['duplicate evidence ID', f => { f.map.rawTsv.evidenceId = f.map.text.evidenceId; }],
  ['wrong raster width', f => { f.map.raster.width++; }],
  ['wrong row order', f => { f.map.regions[1]!.row = f.map.regions[0]!.row; }],
  ['wrong ordinal', f => { f.map.regions[0]!.ordinal = 2; }],
  ['duplicate hierarchy', f => { Object.assign(f.map.regions[1]!, { word: 1 }); }],
  ['bounds overflow', f => { f.map.regions[0]!.x = 63; }],
  ['UTF8 middle boundary', f => { f.map.regions[0]!.byteEnd = 5; }],
  ['region gap', f => { f.map.regions[1]!.byteStart++; }],
  ['wrong separator with matching hash', f => { f.text[6] = 10; f.map.text.sha256 = sha(f.text); }],
  ['wrong status', f => { f.map.status = 'no-text'; }],
  ['score greater than 100', f => { f.map.regions[0]!.engineConfidence = 100.1; }],
  ['unknown schema property', f => { (f.map as any).instructions = 'read another film'; }],
  ['wrong language identity', f => { f.map.engine.models[1]!.sha256 = sha('foreign model'); }],
  ['duplicate native files', f => { const tool = f.map.engine.tools.tesseract; tool.files.push(tool.files[0]!); }],
  ['alias escapes closure', f => { f.map.engine.tools.tesseract.aliases[0]!.realpath = '/fictional/foreign'; }],
];
for (const [name, change] of mapMutations) test(`independent OCR map rejects ${name}`, () => {
  const f = mapFixture(); change(f); assert.throws(() => validateOcrMap(f.map, f.text, f.raster, f.raw, DEFAULT_OCR_LIMITS));
});

test('independent OCR observation confidence and full region are distinct from engine scores', () => {
  const f = mapFixture(), record = observation(f.map); record.evidenceRefs = [record.locator.evidenceId, record.locator.mapEvidenceId, record.locator.rasterEvidenceId];
  validateOcrObservation(record, f.map, f.text); assert.equal(record.confidence, 0.5); assert.equal(f.map.regions[0]!.engineConfidence, 95.25);
  const changes = [
    { confidence: 95.25 }, { coverageScope: 'whole-image' }, { locator: { ...record.locator, regionId: 'missing' } },
    { locator: { ...record.locator, byteStart: 1 }, coverage: 'partial' }, { locator: { ...record.locator, byteEnd: 3 } },
    { locator: { ...record.locator, byteEnd: f.text.length } }, { evidenceRefs: [record.locator.evidenceId] },
  ];
  for (const change of changes) assert.throws(() => validateOcrObservation({ ...record, ...change } as OcrObservation, f.map, f.text));
  assert.throws(() => assertOcr('map', { ...f.map, raster: { ...f.map.raster, orientationApplied: true } }));
  validateOcrEngine(f.map.engine);
});

function chunk(type: string, data = Buffer.alloc(0)) {
  const tag = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); tag.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([tag, data])), result.length - 4); return result;
}
function png(width = 3, height = 1, depth = 8, type = 6, extras: Buffer[] = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = depth; ihdr[9] = type;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...extras, chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0, 128, 64, 32, 128, 255, 255, 255, 255]))), chunk('IEND')]);
}
test('independent PNG preflight has exact source/pixel/edge/structure/raster admission', () => {
  const bytes = png(), exact = { ...DEFAULT_OCR_LIMITS, maxOcrSourceBytes: bytes.length, maxOcrSourcePixels: 3, maxOcrEdge: 3, maxImageStructureEntries: 3, maxOcrRasterBytes: Buffer.byteLength('P6\n3 1\n255\n') + 9 };
  assert.deepEqual(preflightOcrImage(bytes, 'png_pipe', exact), { format: 'png_pipe', width: 3, height: 1 });
  for (const key of ['maxOcrSourceBytes', 'maxOcrSourcePixels', 'maxOcrEdge', 'maxImageStructureEntries', 'maxOcrRasterBytes'] as const) assert.throws(() => preflightOcrImage(bytes, 'png_pipe', { ...exact, [key]: exact[key] - 1 }), key);
});
for (const [name, produce] of [
  ['APNG', () => { const a = Buffer.alloc(8); a.writeUInt32BE(2); return png(3, 1, 8, 6, [chunk('acTL', a)]); }],
  ['16bit', () => png(3, 1, 16)], ['huge source', () => png(0xffffffff, 0xffffffff)],
  ['CRC change', () => { const b = png(); b[29] ^= 1; return b; }], ['truncated chunk', () => png().subarray(0, -2)],
  ['trailing source', () => Buffer.concat([png(), Buffer.from('source tail')])],
] as [string, () => Buffer][]) test(`independent PNG rejects ${name} before OCR allocation`, () => { assert.throws(() => preflightOcrImage(produce(), 'png_pipe', DEFAULT_OCR_LIMITS)); });

function jpeg({ frame = 0xc0, components = 1, width = 32, height = 32, table = true, extra = Buffer.alloc(0), quantizer = 1 } = {}) {
  const segment = (marker: number, payload: Buffer) => { const tag = Buffer.from([255, marker, 0, 0]); tag.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([tag, payload]); };
  const ids = Array.from({ length: components }, (_, n) => n + 1), sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, components, ...ids.flatMap(id => [id, 0x11, 0])]);
  const codes = [1, ...Array(15).fill(0)], huffman = Buffer.from([0, ...codes, 0, 0x10, ...codes, 0]);
  const sos = Buffer.from([components, ...ids.flatMap(id => [id, 0]), 0, 63, 0]);
  return Buffer.concat([Buffer.from([255, 216]), extra, segment(0xdb, Buffer.from([0, ...Array(64).fill(quantizer)])), segment(frame, sof), ...(table ? [segment(0xc4, huffman)] : []), segment(0xda, sos), Buffer.alloc(16 * components / 4), Buffer.from([255, 217])]);
}
test('independent JPEG preflight has exact source/pixel/edge/structure/raster admission', () => {
  const bytes = jpeg(), exact = { ...DEFAULT_OCR_LIMITS, maxOcrSourceBytes: bytes.length, maxOcrSourcePixels: 1024, maxOcrEdge: 32, maxImageStructureEntries: 6, maxOcrRasterBytes: Buffer.byteLength('P6\n32 32\n255\n') + 3072 };
  assert.deepEqual(preflightOcrImage(bytes, 'jpeg_pipe', exact), { format: 'jpeg_pipe', width: 32, height: 32 });
  for (const key of ['maxOcrSourceBytes', 'maxOcrSourcePixels', 'maxOcrEdge', 'maxImageStructureEntries', 'maxOcrRasterBytes'] as const) assert.throws(() => preflightOcrImage(bytes, 'jpeg_pipe', { ...exact, [key]: exact[key] - 1 }), key);
});
for (const [name, produce] of [
  ['CMYK', () => jpeg({ components: 4 })], ['unsupported SOF', () => jpeg({ frame: 0xc1 })], ['missing Huffman table', () => jpeg({ table: false })],
  ['zero quantizer', () => jpeg({ quantizer: 0 })], ['zero width', () => jpeg({ width: 0 })], ['oversize dimensions', () => jpeg({ width: 65535, height: 65535 })],
  ['MPF', () => jpeg({ extra: Buffer.from([255, 226, 0, 6, 77, 80, 70, 0]) })], ['nested SOI', () => jpeg({ extra: Buffer.from([255, 216]) })],
  ['truncated EOI', () => jpeg().subarray(0, -1)], ['concatenated images', () => Buffer.concat([jpeg(), jpeg()])], ['trailing data', () => Buffer.concat([jpeg(), Buffer.from('tail')])],
] as [string, () => Buffer][]) test(`independent JPEG rejects ${name} before OCR allocation`, () => { assert.throws(() => preflightOcrImage(produce(), 'jpeg_pipe', DEFAULT_OCR_LIMITS)); });
