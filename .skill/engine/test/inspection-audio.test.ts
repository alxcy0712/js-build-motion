import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { inspectAudioInput } from '../src/adapters/inspection-audio.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { INSPECT_POLICY_05, emptyCatalogCounts, audioInputLimits } from '../src/project/catalog.ts';
import { validateAudioInputMap } from '../src/project/audio-input.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function wave(samples = 3200, rate = 16000) {
  const b = Buffer.alloc(44 + samples * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 199 - 99, 44 + i * 2); return b;
}
function fixture(bytes = wave(), overrides = {}) {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(join(out, 'inspection-audio-'))), temp = join(dir, 'out/.tmp/run'); fs.mkdirSync(temp, { recursive: true });
  const source = join(dir, 'source.wav'), evidenceDir = join(temp, 'evidence'); fs.writeFileSync(source, bytes);
  const policy = { ...structuredClone(INSPECT_POLICY_05), audioInput: { ...INSPECT_POLICY_05.audioInput, ...overrides } }, counts = emptyCatalogCounts();
  const context = { projectDir: dir, temporaryDir: temp, evidenceDir, publishedDir: 'assets/derived/inspection/fixture', policy,
    counts, tools: [], signal: new AbortController().signal, check() {}, sourceBytes: bytes.length, sourceSha256: hash(bytes), policySha256: hash(Buffer.from(importJsonText(policy))) };
  return { dir, source, bytes, context, clean() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('audio inspection publishes four complete evidence files and disabled ASR without a second WAV', async () => {
  const f = fixture(); try {
    const result = await inspectAudioInput(f.source, 'wav', f.context); assert.equal(result.status, 'supported', result.reason);
    assert.equal(result.audioInput!.status, 'completed'); assert.equal(result.asr!.version, '0.2'); assert.equal(result.asr!.status, 'disabled');
    assert.deepEqual(result.evidence.map(e => e.kind), ['probe', 'audio-pcm', 'audio-canonical', 'audio-input-map']);
    const read = (kind: string) => fs.readFileSync(join(f.context.evidenceDir, basename(result.evidence.find(e => e.kind === kind)!.path)));
    const probe = read('probe'), pcm = read('audio-pcm'), wav = read('audio-canonical'), encoded = read('audio-input-map');
    const map = validateAudioInputMap(JSON.parse(encoded.toString('utf8')), probe, pcm, wav, audioInputLimits(f.context.policy));
    assert.deepEqual(pcm, f.bytes.subarray(44)); assert.deepEqual(wav, f.bytes); assert.equal(map.coverage.presentationMapping, 'unknown');
    assert.equal(map.sourcePcm.samples, 3200); assert.equal(map.audio.samples, 3200);
    assert.equal(f.context.counts.derivedBytes, result.evidence.reduce((n, e) => n + e.bytes, 0)); assert.equal(f.context.counts.decodedAudioBytes, 12800);
    assert.equal(f.context.tools.length, 3); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), ['evidence']);
    assert.deepEqual(fs.readdirSync(f.context.evidenceDir).sort(), result.evidence.map(e => basename(e.path)).sort());
  } finally { f.clean(); }
});
test('original-rate and canonical sample counts remain distinct after complete resampling', async () => {
  const f = fixture(wave(8820, 44100)); try {
    const result = await inspectAudioInput(f.source, 'wav', f.context); assert.equal(result.status, 'supported', result.reason);
    const pcm = result.evidence.find(e => e.kind === 'audio-pcm')!, canonical = result.evidence.find(e => e.kind === 'audio-canonical')!;
    assert.equal(pcm.sampleRate, 44100); assert.equal(pcm.samples, 8820); assert.equal(canonical.sampleRate, 16000); assert.equal(canonical.samples, 3200);
    assert.equal(f.context.counts.decodedAudioBytes, 8820 * 2 + 3200 * 2);
  } finally { f.clean(); }
});
for (const [name, bytes, overrides] of [['short', wave(3199), {}], ['bad extent', wave().subarray(0, -1), {}], ['source bytes', wave(), { maxSourceBytes: 6443 }], ['map bytes', wave(), { maxMapBytes: 1 }]] as const)
  test(`audio inspection ${name} withdraws the whole group and preserves consumed counters`, async () => {
    const f = fixture(bytes, overrides); try {
      const result = await inspectAudioInput(f.source, 'wav', f.context); assert.ok(['skipped', 'failed'].includes(result.audioInput!.status));
      assert.equal(result.evidence.length, 0); assert.equal(result.audioInput!.audioEvidenceId, null); assert.equal(result.asr!.status, 'disabled');
      if (name === 'map bytes') { assert.equal(f.context.counts.decodedAudioBytes, 12800); assert.ok(f.context.counts.derivedBytes >= 12844); }
      assert.equal(fs.existsSync(f.context.evidenceDir) ? fs.readdirSync(f.context.evidenceDir).length : 0, 0);
      assert.deepEqual(fs.readdirSync(f.context.temporaryDir), ['evidence']);
    } finally { f.clean(); }
  });
test('audio inspection cancellation rejects before consuming a source or creating evidence', async () => {
  const f = fixture(); try {
    const controller = new AbortController(); controller.abort(); await assert.rejects(inspectAudioInput(f.source, 'wav', { ...f.context, signal: controller.signal }));
    assert.deepEqual(f.context.counts, emptyCatalogCounts()); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), []);
  } finally { f.clean(); }
});
