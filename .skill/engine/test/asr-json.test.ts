import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAsrJson } from '../src/adapters/asr-json.ts';
import { DEFAULT_ASR_LIMITS, type AsrLimits } from '../src/project/asr.ts';

const modelPath = '/fixture/engine/assets/asr/models/ggml-base.bin';
function stamp(ms: number) { return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }
const segment = (from = 0, to = 1000, text = ' 测试') => ({ timestamps: { from: stamp(from), to: stamp(to) }, offsets: { from, to }, text });
function fixture(transcription = [segment()]) {
  return { systeminfo: 'fixture CPU', model: { type: 'base', multilingual: true, vocab: 51865, audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model: modelPath, language: 'zh', translate: false }, result: { language: 'zh' }, transcription };
}
const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const parse = (data: Buffer, limits: Partial<AsrLimits> = {}, samples = 16000) => parseAsrJson(data, samples, 'zh', { ...DEFAULT_ASR_LIMITS, ...limits }, modelPath);

test('Unicode strings, gaps, raw indices and LF byte ranges match an independent byte oracle', () => {
  const data = raw(fixture([segment(0, 100, ' '), segment(100, 600, ' 中🙂e\u0301  '), segment(600, 800, '   '), segment(800, 1000, 'ABC')]));
  const result = parse(data), oracle = Buffer.from('20e4b8adf09f998265cc8120200a414243', 'hex');
  assert.equal(result.status, 'text'); assert.deepEqual(result.text, oracle);
  assert.deepEqual(result.segments, [
    { id: 'asr-segment-0', ordinal: 0, rawIndex: 1, rawStartMs: 100, rawEndMs: 600, sampleStart: 1600, sampleEnd: 9600, clippedEndSamples: 0, byteStart: 0, byteEnd: 13 },
    { id: 'asr-segment-1', ordinal: 1, rawIndex: 3, rawStartMs: 800, rawEndMs: 1000, sampleStart: 12800, sampleEnd: 16000, clippedEndSamples: 0, byteStart: 14, byteEnd: 17 },
  ]);
  assert.deepEqual(result.text.subarray(0, 13), Buffer.from('20e4b8adf09f998265cc812020', 'hex'));
  assert.deepEqual(result.text.subarray(14, 17), Buffer.from([65, 66, 67]));
  assert.equal(result.text.at(-1), 67);
});
test('empty arrays and validated empty/space-only segments are no-text; NBSP is preserved', () => {
  for (const entries of [[], [segment(0, 500, ''), segment(500, 1000, '   ')]]) {
    const result = parse(raw(fixture(entries))); assert.equal(result.status, 'no-text'); assert.deepEqual(result.segments, []); assert.equal(result.text.length, 0);
  }
  assert.deepEqual(parse(raw(fixture([segment(0, 1000, '\u00a0')]))).text, Buffer.from([0xc2, 0xa0]));
});
test('only the last original segment permits an explicit 1..160-sample end crop', () => {
  for (const excess of [1, 159, 160]) {
    const result = parse(raw(fixture([segment()])), {}, 16000 - excess);
    assert.equal(result.segments[0]!.rawEndMs, 1000); assert.equal(result.segments[0]!.sampleEnd, 16000 - excess); assert.equal(result.segments[0]!.clippedEndSamples, excess);
  }
  assert.throws(() => parse(raw(fixture([segment()])), {}, 15839), /ASR_JSON_INVALID/);
  const earlier = fixture([segment(0, 1000, 'a'), segment(1000, 1010, ' ')]);
  assert.throws(() => parse(raw(earlier), {}, 15999), /ASR_JSON_INVALID/);
  const lastBlank = parse(raw(fixture([segment(0, 500, 'a'), segment(500, 1000, ' ')])), {}, 15999);
  assert.equal(lastBlank.segments.length, 1); assert.equal(lastBlank.segments[0]!.clippedEndSamples, 0);
});
test('observed CPU silence output at 0..10000 ms is refused against 1-second actual PCM', () => {
  const value = fixture([segment(0, 10000, ' [BLANK_AUDIO]')]);
  assert.throws(() => parse(raw(value)), /ASR_JSON_INVALID: segment range/);
});
test('language and model path are original invocation facts', () => {
  const value = fixture(); value.params.language = value.result.language = 'en';
  assert.equal(parseAsrJson(raw(value), 16000, 'en', DEFAULT_ASR_LIMITS, modelPath).status, 'text');
  assert.throws(() => parse(raw(value)), /ASR_JSON_INVALID/);
  assert.throws(() => parseAsrJson(raw(fixture()), 16000, 'zh', DEFAULT_ASR_LIMITS, '/relocated/model'), /ASR_JSON_INVALID/);
});

const bad: [string, (value: any) => void][] = [
  ['root extra key', v => { v.extra = 1; }], ['root missing key', v => { delete v.systeminfo; }], ['empty systeminfo', v => { v.systeminfo = ''; }],
  ['model extra key', v => { v.model.extra = 1; }], ['model missing field', v => { delete v.model.mels; }], ['wrong model type', v => { v.model.type = 'base.en'; }],
  ['monolingual model', v => { v.model.multilingual = false; }], ['wrong vocabulary', v => { v.model.vocab = 51864; }], ['wrong mel count', v => { v.model.mels = 128; }],
  ['wrong quantization', v => { v.model.ftype = 2; }], ['audio extra key', v => { v.model.audio.extra = 1; }], ['wrong audio dimensions', v => { v.model.audio.state = 384; }],
  ['wrong text dimensions', v => { v.model.text.ctx = 447; }], ['params extra key', v => { v.params.extra = 1; }], ['different model path', v => { v.params.model += '.other'; }],
  ['translation enabled', v => { v.params.translate = true; }], ['auto language', v => { v.params.language = 'auto'; }], ['result extra key', v => { v.result.extra = 1; }],
  ['result language mismatch', v => { v.result.language = 'en'; }], ['transcription object', v => { v.transcription = {}; }], ['null segment', v => { v.transcription[0] = null; }],
  ['full JSON tokens', v => { v.transcription[0].tokens = []; }], ['speaker field', v => { v.transcription[0].speaker = '0'; }],
  ['offsets extra key', v => { v.transcription[0].offsets.extra = 1; }], ['timestamp mismatch', v => { v.transcription[0].timestamps.to = '00:00:01,001'; }],
  ['timestamp period', v => { v.transcription[0].timestamps.from = '00:00:00.000'; }], ['timestamp extra key', v => { v.transcription[0].timestamps.extra = 1; }],
  ['negative time', v => { v.transcription[0].offsets.from = -10; }], ['fractional time', v => { v.transcription[0].offsets.to = 999.5; }],
  ['off-grid time', v => { v.transcription[0].offsets.to = 999; }], ['string time', v => { v.transcription[0].offsets.to = '1000'; }],
  ['unsafe integer', v => { v.transcription[0].offsets.to = 9007199254740992; }], ['unsafe sample product', v => { v.transcription[0].offsets.to = 9007199254740990; }],
  ['zero extent', v => { v.transcription[0] = segment(0, 0, ''); }], ['reversed extent', v => { v.transcription[0] = segment(1000, 0); }],
  ['start at end', v => { v.transcription[0] = segment(1000, 1010); }], ['overlap', v => { v.transcription = [segment(0, 600), segment(500, 1000)]; }],
  ['out of order', v => { v.transcription = [segment(500, 1000), segment(0, 500)]; }], ['space overlap', v => { v.transcription = [segment(0, 600, ' '), segment(500, 1000)]; }],
  ['space invalid time', v => { v.transcription = [segment(0, 0, ' ')]; }], ['blank oversized extent', v => { v.transcription = [segment(0, 1020, ' ')]; }],
  ['nonstring text', v => { v.transcription[0].text = 1; }], ['NUL text', v => { v.transcription[0].text = 'a\x00b'; }], ['LF text', v => { v.transcription[0].text = 'a\nb'; }],
  ['TAB text', v => { v.transcription[0].text = 'a\tb'; }], ['CR text', v => { v.transcription[0].text = 'a\rb'; }], ['DEL text', v => { v.transcription[0].text = 'a\x7fb'; }],
  ['BOM anywhere', v => { v.transcription[0].text = 'a\ufeffb'; }], ['lone high surrogate', v => { v.transcription[0].text = '\ud800'; }], ['lone low surrogate', v => { v.transcription[0].text = '\udc00'; }],
];
for (const [name, mutate] of bad) test(`strict fixed JSON rejects ${name}`, () => {
  const value = fixture(); mutate(value); assert.throws(() => parse(raw(value)), /ASR_JSON_INVALID/);
});
for (const [name, data] of [['zero stdout', Buffer.alloc(0)], ['bad UTF8', Buffer.concat([raw(fixture()), Buffer.from([255])])],
  ['UTF8 BOM', Buffer.concat([Buffer.from([239, 187, 191]), raw(fixture())])], ['two JSON outputs', Buffer.concat([raw(fixture()), raw(fixture())])],
  ['root array', Buffer.from('[]')], ['garbage', Buffer.from('native text before JSON')]] as const) test(`raw framing rejects ${name}`, () => assert.throws(() => parse(data), /ASR_JSON_INVALID/));

const capped = raw(fixture([segment(0, 500, '中文'), segment(500, 1000, 'end')]));
const caps: [keyof AsrLimits, number, RegExp][] = [['maxAsrRawBytes', capped.length, /ASR_RAW_LIMIT/], ['maxAsrRawSegments', 2, /ASR_RAW_SEGMENTS_LIMIT/],
  ['maxAsrSegments', 2, /ASR_SEGMENTS_LIMIT/], ['maxAsrSegmentTextBytes', 6, /ASR_SEGMENT_TEXT_LIMIT/], ['maxAsrTextBytes', 10, /ASR_TEXT_LIMIT/]];
for (const [key, exact, error] of caps) test(`${key} accepts exact and rejects one less`, () => {
  assert.equal(parse(capped, { [key]: exact }).status, 'text'); assert.throws(() => parse(capped, { [key]: exact - 1 }), error);
});
test('space rows consume raw segment and segment-text quotas before filtering', () => {
  const data = raw(fixture([segment(0, 500, '    '), segment(500, 1000, '')]));
  assert.equal(parse(data, { maxAsrRawSegments: 2, maxAsrSegmentTextBytes: 4, maxAsrSegments: 0, maxAsrTextBytes: 0 }).status, 'no-text');
  assert.throws(() => parse(data, { maxAsrRawSegments: 1 }), /ASR_RAW_SEGMENTS_LIMIT/);
  assert.throws(() => parse(data, { maxAsrSegmentTextBytes: 3 }), /ASR_SEGMENT_TEXT_LIMIT/);
});
test('actual PCM bounds are enforced independently of raw segment times', () => {
  for (const samples of [0, 3199, 1920001]) assert.throws(() => parse(raw(fixture([])), {}, samples), /ASR_SAMPLES_LIMIT/);
  for (const samples of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parse(raw(fixture([])), {}, samples), /ASR_JSON_INVALID/);
  assert.equal(parse(raw(fixture([])), {}, 3200).status, 'no-text'); assert.equal(parse(raw(fixture([])), {}, 1920000).status, 'no-text');
});
