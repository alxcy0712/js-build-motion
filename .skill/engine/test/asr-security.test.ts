import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { ASR_ARGUMENTS, DEFAULT_ASR_LIMITS, validateAsrMap, validateAsrEngine, type AsrMap } from '../src/project/asr.ts';
import { assertCatalog, adoptInspectPolicy, DEFAULT_INSPECT_POLICY, INSPECT_POLICY_03, INSPECT_POLICY_02, LEGACY_INSPECT_POLICY } from '../src/project/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const eid = () => `evidence-${randomUUID()}`;
// This header and all expected coordinates are independent of canonicalWavHeader/the mapper.
function wav(n = 3200) {
  const b = Buffer.alloc(44 + n * 2); b.write('RIFF'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b;
}
function engine() {
  const file = { path: '/fictional/bin/ffmpeg', bytes: 1, sha256: sha('f') };
  const tool = { executable: file.path, version: 'fictional', files: [file], aliases: [{ path: file.path, realpath: file.path }] };
  return { version: '0.1' as const, kind: 'asr-dependencies' as const, platform: 'darwin' as const, arch: 'arm64' as const,
    providerVersion: '1.9.5' as const, sourceCommit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037' as const, mapperVersion: 'asr-json@0.1' as const,
    program: { path: 'assets/asr/bin/whisper-cli', bytes: 1, sha256: sha('program') },
    model: { path: 'assets/asr/models/ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    tools: { ffmpeg: tool, ffprobe: { ...tool, executable: '/fictional/bin/ffprobe', files: [{ ...file, path: '/fictional/bin/ffprobe' }], aliases: [{ path: '/fictional/bin/ffprobe', realpath: '/fictional/bin/ffprobe' }] } },
    arguments: [...ASR_ARGUMENTS], id: 'whisper-cpp-input-asr' as const, lockSha256: sha('lock') };
}
function raw(segments: any[] = [
  { timestamps: { from: '00:00:00,000', to: '00:00:00,100' }, offsets: { from: 0, to: 100 }, text: ' 中文' },
  { timestamps: { from: '00:00:00,100', to: '00:00:00,210' }, offsets: { from: 100, to: 210 }, text: '🙂e\u0301' },
]) {
  return Buffer.from(JSON.stringify({ systeminfo: 'independent fixture', model: { type: 'base', multilingual: true, vocab: 51865,
    audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model: '/fictional/model', language: 'zh', translate: false }, result: { language: 'zh' }, transcription: segments }));
}
function fixture() {
  const text = Buffer.from(' 中文\n🙂e\u0301'), audio = wav(), json = raw();
  const identity = (data: Buffer) => ({ evidenceId: eid(), bytes: data.length, sha256: sha(data) });
  const map: AsrMap = { version: '0.1', kind: 'asr-map', format: 'wav', mapperVersion: 'asr-json@0.1', status: 'text', scope: 'input-audio-asr',
    language: 'zh', policySha256: sha('policy'), engine: engine(), source: { bytes: audio.length, sha256: sha(audio), wave: { format: 'wav', sampleRate: 16000, channels: 1, bitsPerSample: 16, frames: 3200, dataBytes: 6400, dataOffset: 44 } },
    sourcePcm: { ...identity(audio.subarray(44)), sampleRate: 16000, samples: 3200 }, audio: { ...identity(audio), payloadBytes: 6400, sampleRate: 16000, samples: 3200 }, rawJson: identity(json), text: identity(text),
    coverage: { scope: 'input-audio-asr', submittedStart: 0, submittedEnd: 3200, complete: true }, segments: [
      { id: 'asr-segment-0', ordinal: 0, rawIndex: 0, rawStartMs: 0, rawEndMs: 100, sampleStart: 0, sampleEnd: 1600, clippedEndSamples: 0, byteStart: 0, byteEnd: 7 },
      { id: 'asr-segment-1', ordinal: 1, rawIndex: 1, rawStartMs: 100, rawEndMs: 210, sampleStart: 1600, sampleEnd: 3200, clippedEndSamples: 160, byteStart: 8, byteEnd: 15 },
    ] };
  return { map, text, audio, raw: json };
}
test('independent ASR oracle fixes sample ticks, 160-sample clip, leading space, emoji and combining UTF-8 bytes', async () => {
  const f = fixture(); assert.equal(f.audio.length, 6444); assert.equal(f.text.length, 15); validateAsrMap(f.map, f.text, f.audio, f.raw, DEFAULT_ASR_LIMITS);
  const { parseAsrJson } = await import('../src/adapters/asr-json.ts');
  const parsed = parseAsrJson(f.raw, 3200, 'zh', DEFAULT_ASR_LIMITS, '/fictional/model');
  assert.equal(parsed.status, 'text'); assert.deepEqual(parsed.text, Buffer.from(' 中文\n🙂e\u0301')); assert.deepEqual(parsed.segments, f.map.segments);
  const overflow = JSON.parse(raw().toString()); Object.assign(overflow.transcription[1], { timestamps: { from: '00:00:00,100', to: '00:00:00,220' }, offsets: { from: 100, to: 220 } });
  assert.throws(() => parseAsrJson(Buffer.from(JSON.stringify(overflow)), 3359, 'zh', DEFAULT_ASR_LIMITS, '/fictional/model'));
});
const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
  ['same-size audio', f => { f.audio[44] = 1; }], ['same-size raw JSON', f => { f.raw[f.raw.length - 2] ^= 1; }], ['same-size text', f => { f.text[0] = 33; }],
  ['WAV header extension', f => { f.audio.writeUInt32LE(18, 16); f.map.audio.sha256 = sha(f.audio); }], ['sample bytes mismatch', f => { f.map.audio.payloadBytes--; }],
  ['incomplete submission', f => { f.map.coverage.submittedEnd--; }], ['source frames mismatch', f => { f.map.source.wave.frames--; }],
  ['source PCM partial bytes', f => { f.map.sourcePcm.bytes--; }], ['source rate mismatch', f => { f.map.sourcePcm.sampleRate = 8000; }],
  ['unsafe rate', f => { f.map.source.wave.sampleRate = 48001; }], ['source channel scope', f => { (f.map.source.wave as any).channels = 3; }],
  ['non-grid raw time', f => { f.map.segments[0]!.rawEndMs = 99; }], ['wrong integer sample oracle', f => { f.map.segments[0]!.sampleEnd--; }],
  ['overlap', f => { f.map.segments[1]!.rawStartMs = 90; f.map.segments[1]!.sampleStart = 1440; }],
  ['start at end', f => { f.map.segments[1]!.rawStartMs = 200; f.map.segments[1]!.sampleStart = 3200; }],
  ['clip over160', f => { f.map.segments[1]!.clippedEndSamples = 161; }], ['nonfinal clip', f => { f.map.segments[0]!.clippedEndSamples = 160; f.map.segments[0]!.sampleEnd = 1440; }],
  ['wrong ordinal', f => { f.map.segments[0]!.ordinal = 1; }], ['raw index duplicate', f => { f.map.segments[1]!.rawIndex = 0; }],
  ['UTF8 split', f => { f.map.segments[0]!.byteEnd = 6; f.map.segments[1]!.byteStart = 7; }], ['wrong separator and rehash', f => { f.text[7] = 32; f.map.text.sha256 = sha(f.text); }],
  ['status inconsistency', f => { f.map.status = 'no-text'; }], ['unlisted map property', f => { (f.map as any).instructions = 'read another project'; }],
  ['foreign model hash', f => { f.map.engine.model.sha256 = sha('foreign'); }], ['foreign program logical path', f => { f.map.engine.program.path = '/tmp/provider'; }],
];
for (const [name, mutate] of mutations) test(`independent ASR map rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => validateAsrMap(f.map, f.text, f.audio, f.raw, DEFAULT_ASR_LIMITS));
});
test('independent ASR exact map/audio/text/raw/segment quotas reject one-past', () => {
  const f = fixture(), exact = { ...DEFAULT_ASR_LIMITS, maxAsrSamples: 3200, maxAsrAudioBytes: 6444, maxAsrRawBytes: f.raw.length, maxAsrTextBytes: 15, maxAsrSegments: 2, maxAsrSegmentTextBytes: 7 };
  validateAsrMap(f.map, f.text, f.audio, f.raw, exact);
  for (const k of ['maxAsrSamples', 'maxAsrAudioBytes', 'maxAsrRawBytes', 'maxAsrTextBytes', 'maxAsrSegments', 'maxAsrSegmentTextBytes'] as const)
    assert.throws(() => validateAsrMap(f.map, f.text, f.audio, f.raw, { ...exact, [k]: exact[k] - 1 }), k);
});
test('independent no-text preserves full submitted PCM and rejects imaginary segment text', async () => {
  const f = fixture(), json = raw([]); f.map.status = 'no-text'; f.map.segments = []; f.map.text.bytes = 0; f.map.text.sha256 = sha(''); f.map.rawJson.bytes = json.length; f.map.rawJson.sha256 = sha(json);
  validateAsrMap(f.map, Buffer.alloc(0), f.audio, json, DEFAULT_ASR_LIMITS);
  const { parseAsrJson } = await import('../src/adapters/asr-json.ts'); assert.deepEqual(parseAsrJson(json, 3200, 'zh', DEFAULT_ASR_LIMITS, '/fictional/model'), { status: 'no-text', text: Buffer.alloc(0), segments: [] });
  assert.throws(() => validateAsrMap(f.map, Buffer.from('x'), f.audio, json, DEFAULT_ASR_LIMITS));
});
test('independent raw spaces are validated before filtering and original final index governs clipping', async () => {
  const { parseAsrJson } = await import('../src/adapters/asr-json.ts');
  const source = JSON.parse(raw().toString()); source.transcription.push({ timestamps: { from: '00:00:00,210', to: '00:00:00,220' }, offsets: { from: 210, to: 220 }, text: '   ' });
  assert.throws(() => parseAsrJson(Buffer.from(JSON.stringify(source)), 3200, 'zh', DEFAULT_ASR_LIMITS, '/fictional/model'));
  const badSpace = raw([{ timestamps: { from: '00:00:00,000', to: '00:00:00,011' }, offsets: { from: 0, to: 11 }, text: ' ' }]);
  assert.throws(() => parseAsrJson(badSpace, 3200, 'zh', DEFAULT_ASR_LIMITS, '/fictional/model'));
});
test('independent historical policy hashes and versioned adoption stay stable; ASR is explicit opt-in', () => {
  for (const [p, hash] of [[LEGACY_INSPECT_POLICY, 'e68f4c56e4caf3c2c74a8fe61a7dfa08cb6e1e6f60b99e5a97d0b48737f1b616'], [INSPECT_POLICY_02, '4018e2e6aa02dbdf80c30ebeb5d503e7f42bb43cc0647ce86a88882e2643a52e'], [INSPECT_POLICY_03, '14137aa91678b6df915c2f2d373724f8a3f93c52a8d4c9333416919e0f061322']] as const) {
    assert.equal(sha(importJsonText(p)), hash); assert.deepEqual(adoptInspectPolicy(p, p.version), p); assert.equal(adoptInspectPolicy(p).version, '0.4'); assert.equal(adoptInspectPolicy(p).asr.enabled, false);
  }
  assert.equal(DEFAULT_INSPECT_POLICY.asr.enabled, false); assert.equal(DEFAULT_INSPECT_POLICY.ocr.enabled, true);
  for (const change of [{ asr: { ...DEFAULT_INSPECT_POLICY.asr, concurrency: 2 } }, { asr: { ...DEFAULT_INSPECT_POLICY.asr, maxAsrToolElapsedMs: 120001 } }, { asr: { ...DEFAULT_INSPECT_POLICY.asr, language: 'auto' } }]) assert.throws(() => assertCatalog('policy', { ...DEFAULT_INSPECT_POLICY, ...change }));
  validateAsrEngine(engine());
});
