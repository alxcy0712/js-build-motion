import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAlignmentJson } from '../src/adapters/alignment-json.ts';
import { DEFAULT_ALIGNMENT_POLICY, type AlignmentLimits } from '../src/project/alignment.ts';

const modelPath = '/fixture/engine/assets/asr/models/ggml-base.bin';
function stamp(ms: number) { return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }
const token = (text = 'a', from = 0, to = 1000, id = 64) => ({ text, id, p: .9, t_dtw: -1, timestamps: { from: stamp(from), to: stamp(to) }, offsets: { from, to } });
const segment = (text = 'a', tokens: any[] = [token()], from = 0, to = 1000) => ({ text, tokens, timestamps: { from: stamp(from), to: stamp(to) }, offsets: { from, to } });
function fixture(transcription = [segment()]) {
  return { systeminfo: 'fixture CPU', model: { type: 'base', multilingual: true, vocab: 51865, audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model: modelPath, language: 'zh', translate: false }, result: { language: 'zh' }, transcription };
}
const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const parse = (value = fixture(), limits: Partial<AlignmentLimits> = {}, samples = 16000) =>
  parseAlignmentJson(raw(value), samples, 'zh', { ...DEFAULT_ALIGNMENT_POLICY, ...limits }, modelPath);

test('full JSON uses original token order and an independent UTF-8 byte oracle', () => {
  const result = parse(fixture([segment('Hi中𠀀🙂', [token('[_BEG_]', 0, 0, 50364), token('Hi', 0, 200), token('中', 200, 400), token('𠀀', 400, 600), token('🙂', 600, 800)])]));
  assert.deepEqual(result.text, Buffer.from('4869e4b8adf0a08080f09f9982', 'hex')); assert.equal(result.rawTokens, 5);
  assert.deepEqual(result.tokens.map(t => [t.id, t.ordinal, t.segmentIndex, t.tokenIndex, t.byteStart, t.byteEnd, t.sampleStart, t.sampleEnd]),
    [['alignment-token-1', 1, 0, 1, 0, 2, 0, 3200], ['alignment-token-2', 2, 0, 2, 2, 5, 3200, 6400],
      ['alignment-token-3', 3, 0, 3, 5, 9, 6400, 9600], ['alignment-token-4', 4, 0, 4, 9, 13, 9600, 12800]]);
});
test('segment token text is concatenated without invented separators', () => {
  const result = parse(fixture([segment('a', [token('a', 0, 500)], 0, 500), segment('b', [token('b', 500, 1000)], 500, 1000)]));
  assert.equal(result.text.toString(), 'ab'); assert.deepEqual(result.tokens.map(t => [t.segmentIndex, t.tokenIndex, t.byteStart, t.byteEnd]), [[0, 0, 0, 1], [1, 0, 1, 2]]);
});
test('missing, zero, reversed, out-of-domain and non-monotone token intervals retain unknown times', () => {
  const missing: any = token('a'); delete missing.timestamps; delete missing.offsets;
  const result = parse(fixture([segment('abcde', [missing, token('b', 300, 300), token('c', 400, 200), token('d', 0, 1010), token('e', 100, 500)])]));
  assert.deepEqual(result.tokens.map(t => t.reason), ['MISSING_TOKEN_TIME', 'ZERO_TOKEN_RANGE', 'INVALID_TOKEN_TIME', 'INVALID_TOKEN_TIME', 'TOKEN_ESTIMATE']);
  assert.ok(result.tokens.slice(0, 4).every(t => t.sampleStart === null && t.sampleEnd === null));
  const reversedOrder = parse(fixture([segment('ab', [token('a', 500, 900), token('b', 100, 300)])]));
  assert.equal(reversedOrder.tokens[1]!.reason, 'NON_MONOTONE_TOKEN_TIME'); assert.equal(reversedOrder.tokens[1]!.sampleStart, null);
});
test('last segment token estimates preserve the admitted maximum 160-sample tail crop', () => {
  assert.equal(parse(fixture(), {}, 15840).tokens[0]!.sampleEnd, 15840);
  assert.throws(() => parse(fixture(), {}, 15839), /ALIGNMENT_JSON_INVALID.*ASR_JSON_INVALID/);
});
test('raw token quotas and validation precede special and empty-text filtering', () => {
  const value = fixture([segment('', [token('[_BEG_]', 0, 0, 50364), token('', 0, 0, 50256)])]);
  const result = parse(value, { maxTokens: 2 }); assert.equal(result.rawTokens, 2); assert.equal(result.tokens.length, 1); assert.equal(result.text.length, 0);
  assert.throws(() => parse(value, { maxTokens: 1 }), /ALIGNMENT_TOKENS_LIMIT/);
  value.transcription[0]!.tokens[0]!.p = 2; assert.throws(() => parse(value), /ALIGNMENT_JSON_INVALID/);
});
test('recognized bytes and token text bytes include complete whitespace and Unicode', () => {
  const value = fixture([segment(' 中 ', [token(' 中 ')])]);
  assert.equal(parse(value, { maxTokenTextBytes: 5, maxRecognizedBytes: 5 }).text.length, 5);
  assert.throws(() => parse(value, { maxTokenTextBytes: 4 }), /ALIGNMENT_TOKEN_TEXT_LIMIT/);
  assert.throws(() => parse(value, { maxRecognizedBytes: 4 }), /ALIGNMENT_RECOGNIZED_LIMIT/);
});
test('raw byte limit admits exact bytes and refuses one lower; actual samples bound decoding', () => {
  const bytes = raw(fixture()); assert.equal(parseAlignmentJson(bytes, 16000, 'zh', { ...DEFAULT_ALIGNMENT_POLICY, maxRawBytes: bytes.length }, modelPath).rawTokens, 1);
  assert.throws(() => parseAlignmentJson(bytes, 16000, 'zh', { ...DEFAULT_ALIGNMENT_POLICY, maxRawBytes: bytes.length - 1 }, modelPath), /ALIGNMENT_RAW_LIMIT/);
  for (const samples of [0, 3199, 1920001, 1.1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parse(fixture([]), {}, samples), /ALIGNMENT_SAMPLES_LIMIT/);
  assert.equal(parse(fixture([]), {}, 3200).rawTokens, 0);
});

const bad: [string, (value: any) => void][] = [
  ['root extension', v => { v.extra = 1; }], ['model mismatch', v => { v.model.type = 'tiny'; }],
  ['model path', v => { v.params.model += '.other'; }], ['language identity', v => { v.params.language = 'en'; }],
  ['segment extension', v => { v.transcription[0].extra = 1; }], ['tokens omitted', v => { delete v.transcription[0].tokens; }],
  ['tokens shape', v => { v.transcription[0].tokens = {}; }], ['token extension', v => { v.transcription[0].tokens[0].extra = 1; }],
  ['token null', v => { v.transcription[0].tokens[0] = null; }], ['provider id', v => { v.transcription[0].tokens[0].id = 51865; }],
  ['fractional id', v => { v.transcription[0].tokens[0].id = .1; }], ['probability type', v => { v.transcription[0].tokens[0].p = '0.5'; }],
  ['probability range', v => { v.transcription[0].tokens[0].p = -.01; }], ['dtw enabled', v => { v.transcription[0].tokens[0].t_dtw = 10; }],
  ['half timed fields', v => { delete v.transcription[0].tokens[0].timestamps; }], ['offset extension', v => { v.transcription[0].tokens[0].offsets.extra = 1; }],
  ['fractional time', v => { v.transcription[0].tokens[0].offsets.to = 1000.5; }], ['off-grid time', v => { v.transcription[0].tokens[0].offsets.to = 999; }],
  ['stamp mismatch', v => { v.transcription[0].tokens[0].timestamps.to = '00:00:01,001'; }], ['reconstruction mismatch', v => { v.transcription[0].tokens[0].text = 'b'; }],
  ['token control', v => { v.transcription[0].tokens[0].text = 'a\n'; }], ['token BOM', v => { v.transcription[0].tokens[0].text = '\ufeffa'; }],
  ['token surrogate', v => { v.transcription[0].tokens[0].text = '\ud800'; }], ['segment overlap', v => { v.transcription.push(segment('b', [token('b', 500, 1000)], 500, 1000)); }],
];
for (const [name, mutate] of bad) test(`fixed full JSON refuses ${name}`, () => {
  const value = fixture(); mutate(value); assert.throws(() => parse(value), /ALIGNMENT_JSON_INVALID/);
});
for (const [name, bytes] of [['empty stdout', Buffer.alloc(0)], ['malformed UTF8', Buffer.from([255])],
  ['BOM', Buffer.concat([Buffer.from([239, 187, 191]), raw(fixture())])], ['two roots', Buffer.concat([raw(fixture()), raw(fixture())])]] as const)
  test(`raw framing refuses ${name}`, () => assert.throws(() => parseAlignmentJson(bytes, 16000, 'zh', DEFAULT_ALIGNMENT_POLICY, modelPath), /ALIGNMENT_JSON_INVALID/));
