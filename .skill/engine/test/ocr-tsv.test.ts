import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOcrTsv } from '../src/adapters/ocr-tsv.ts';
import { DEFAULT_OCR_LIMITS, type OcrLimits } from '../src/project/ocr.ts';

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const page = '1\t1\t0\t0\t0\t0\t0\t0\t100\t50\t-1\t';
const block = '2\t1\t1\t0\t0\t0\t1\t1\t90\t40\t-1\t';
const paragraph = '3\t1\t1\t1\t0\t0\t1\t1\t90\t40\t-1\t';
const line = '4\t1\t1\t1\t1\t0\t1\t1\t90\t15\t-1\t';
const word = (text = 'token', number = 1, confidence = '96.25', row = 1) => `5\t1\t1\t1\t${row}\t${number}\t${number * 10}\t${row * 10}\t8\t8\t${confidence}\t${text}`;
const buffer = (rows: string[]) => Buffer.from([header, ...rows].join('\n') + '\n');
const full = (text = 'token') => buffer([page, block, paragraph, line, word(text)]);
const parse = (data: Buffer, limits: Partial<OcrLimits> = {}) => parseOcrTsv(data, 100, 50, { ...DEFAULT_OCR_LIMITS, ...limits });

test('native word order, repeated text, Unicode bytes, low scores and unknown confidence remain exact', () => {
  const data = buffer([page, block, paragraph, line, word('same', 1, '0'), word('same', 2, '-1'),
    '4\t1\t1\t1\t2\t0\t1\t20\t90\t15\t-1\t', word('中文e\u0301', 1, '1.5', 2)]);
  const result = parse(data);
  assert.equal(result.text.toString('utf8'), 'same same\n中文e\u0301'); assert.equal(result.status, 'text');
  assert.deepEqual(result.regions.map(r => [r.id, r.row, r.engineConfidence, r.byteStart, r.byteEnd]), [
    ['ocr-word-1', 5, 0, 0, 4], ['ocr-word-2', 6, null, 5, 9], ['ocr-word-3', 8, 1.5, 10, 19],
  ]);
  for (const region of result.regions) assert.equal(result.text.subarray(region.byteStart, region.byteEnd).toString('utf8'), region.ordinal === 3 ? '中文e\u0301' : 'same');
  assert.equal(result.text.includes(13), false); assert.notEqual(result.text.at(-1), 10);
});

test('no-text requires a real page and accepts fully validated empty word rows', () => {
  for (const data of [buffer([page]), full('')]) { const result = parse(data); assert.equal(result.status, 'no-text'); assert.equal(result.text.length, 0); assert.deepEqual(result.regions, []); }
  const zero = parse(buffer([page]), { maxOcrRegions: 0, maxOcrWordBytes: 0, maxOcrTextBytes: 0, maxOcrRows: 1 });
  assert.equal(zero.status, 'no-text');
  assert.equal(parse(full(''), { maxOcrRegions: 0, maxOcrWordBytes: 0, maxOcrTextBytes: 0 }).status, 'no-text');
});

const cases: [string, Buffer][] = [
  ['zero stdout', Buffer.alloc(0)], ['header only', Buffer.from(header)], ['wrong header', Buffer.from(full().toString().replace('page_num', 'pages'))],
  ['BOM header', Buffer.concat([Buffer.from('efbbbf', 'hex'), full()])], ['bad UTF8', Buffer.concat([full(), Buffer.from([0xff])])],
  ['CRLF', Buffer.from(full().toString().replaceAll('\n', '\r\n'))], ['extra column', full('a\tb')], ['extra blank row', Buffer.concat([full(), Buffer.from('\n')])],
  ['wrong page geometry', buffer([page.replace('\t100\t50\t', '\t99\t50\t')])], ['second page', buffer([page, page.replace('1\t1\t', '1\t2\t')])],
  ['duplicate page', buffer([page, page])], ['missing page', buffer([block, paragraph, line, word()])],
  ['missing block', buffer([page, paragraph, line, word()])], ['missing paragraph', buffer([page, block, line, word()])],
  ['missing line', buffer([page, block, paragraph, word()])], ['wrong parent', buffer([page, block, paragraph, line, word().replace('5\t1\t1\t1\t1', '5\t1\t2\t1\t1')])],
  ['duplicate word', buffer([page, block, paragraph, line, word(), word()])], ['duplicate empty word', buffer([page, block, paragraph, line, word(''), word('')])],
  ['bad empty-word parent', buffer([page, block, paragraph, word('')])], ['empty-word NaN', buffer([page, block, paragraph, line, word('', 1, 'NaN')])],
  ['word NaN', buffer([page, block, paragraph, line, word('x', 1, 'NaN')])], ['word Infinity', buffer([page, block, paragraph, line, word('x', 1, 'Infinity')])],
  ['confidence above 100', buffer([page, block, paragraph, line, word('x', 1, '100.1')])], ['confidence below sentinel', buffer([page, block, paragraph, line, word('x', 1, '-2')])],
  ['structural confidence', buffer([page.replace('\t-1\t', '\t90\t')])], ['structural text', buffer([page + 'text'])],
  ['zero box', buffer([page, block, paragraph, line, word().replace('\t8\t8\t', '\t0\t8\t')])],
  ['empty-word zero box', buffer([page, block, paragraph, line, word('').replace('\t8\t8\t', '\t0\t8\t')])],
  ['outside box', buffer([page, block, paragraph, line, word().replace('\t10\t10\t', '\t99\t10\t')])],
  ['unsafe integer', buffer([page, block, paragraph, line, word().replace('\t10\t10\t', '\t9007199254740992\t10\t')])],
  ['negative coordinate', buffer([page, block, paragraph, line, word().replace('\t10\t10\t', '\t-1\t10\t')])],
  ['NUL word', full('a\x00b')], ['text BOM', full('\ufeffword')], ['unknown level', buffer([page, block.replace(/^2/, '6')])],
];
for (const [name, data] of cases) test(`strict TSV rejects ${name}`, () => assert.throws(() => parse(data), /OCR_TSV_INVALID/));

test('page extent and data row index have exact geometric boundaries', () => {
  const data = buffer([page, block, paragraph, line, word().replace('\t10\t10\t', '\t92\t42\t')]);
  assert.equal(parse(data).regions[0]!.row, 5);
  assert.throws(() => parseOcrTsv(data, 0, 50, DEFAULT_OCR_LIMITS), /OCR_TSV_INVALID/);
});

const capped = buffer([page, block, paragraph, line, word('中文'), word('end', 2)]);
const quotaCases: [keyof OcrLimits, number, RegExp][] = [
  ['maxOcrTsvBytes', capped.length, /OCR_TSV_LIMIT/], ['maxOcrRows', 6, /OCR_ROWS_LIMIT/],
  ['maxOcrRowBytes', Math.max(...capped.toString('utf8').split('\n').slice(1, -1).map(row => Buffer.byteLength(row))), /OCR_ROW_LIMIT/],
  ['maxOcrRegions', 2, /OCR_REGIONS_LIMIT/], ['maxOcrWordBytes', 6, /OCR_WORD_LIMIT/], ['maxOcrTextBytes', 10, /OCR_TEXT_LIMIT/],
];
for (const [field, exact, error] of quotaCases) test(`${field} accepts exact and rejects one byte/row/region over`, () => {
  assert.equal(parse(capped, { [field]: exact }).status, 'text');
  assert.throws(() => parse(capped, { [field]: exact - 1 }), error);
});

test('canonical separators participate in text byte quotas', () => {
  const data = buffer([page, block, paragraph, line, word('中'), word('文', 2)]);
  assert.equal(parse(data, { maxOcrTextBytes: 7 }).text.toString('utf8'), '中 文');
  assert.throws(() => parse(data, { maxOcrTextBytes: 6 }), /OCR_TEXT_LIMIT/);
});
