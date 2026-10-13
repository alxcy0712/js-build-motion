import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INSPECT_POLICY, emptyCatalogCounts, type Evidence } from '../src/project/catalog.ts';
import { DEFAULT_ASR_LIMITS, type AsrLimits } from '../src/project/asr.ts';
import type { NativeToolIdentity } from '../src/project/ocr.ts';
import type { InspectContext } from '../src/adapters/inspection.ts';
import { decodeAsrAudio, preflightAsrWav } from '../src/adapters/asr-wav.ts';
import { ocrRuntimeIdentity } from '../workspace.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.research/out'); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, 'asr-wav-')); after(() => rmSync(scratch, { recursive: true, force: true }));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const limits = (changes: Partial<AsrLimits> = {}): AsrLimits => ({ ...DEFAULT_ASR_LIMITS, ...changes });
let sequence = 0;
function chunk(id: string, payload: Buffer, pad = 0) {
  const bytes = Buffer.alloc(8 + payload.length + payload.length % 2); bytes.write(id, 0, 'latin1'); bytes.writeUInt32LE(payload.length, 4); payload.copy(bytes, 8);
  if (payload.length % 2) bytes[bytes.length - 1] = pad; return bytes;
}
function fmt(rate = 16000, channels = 1, bits = 16, tag = 1) {
  const bytes = Buffer.alloc(16); bytes.writeUInt16LE(tag); bytes.writeUInt16LE(channels, 2); bytes.writeUInt32LE(rate, 4);
  bytes.writeUInt32LE(rate * channels * bits / 8, 8); bytes.writeUInt16LE(channels * bits / 8, 12); bytes.writeUInt16LE(bits, 14); return bytes;
}
function riff(parts: Buffer[]) {
  const body = Buffer.concat(parts), header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(body.length + 4, 4); header.write('WAVE', 8); return Buffer.concat([header, body]);
}
function payload(frames: number) {
  const bytes = Buffer.alloc(frames * 2); for (let i = 0; i < frames; i++) bytes.writeInt16LE((i * 1987 % 65536) - 32768, i * 2); return bytes;
}
function wave(frames = 3200, rate = 16000, channels = 1) { return riff([chunk('fmt ', fmt(rate, channels)), chunk('data', Buffer.alloc(frames * channels * 2))]); }
function fixture(frames = 3200, rate = 16000, channels = 1, changes: Record<string, any> = {}) {
  const dir = join(scratch, String(++sequence)), cwd = join(dir, 'cwd'); mkdirSync(cwd, { recursive: true });
  const source = join(dir, 'complete original mono.s16le'), bytes = payload(frames); writeFileSync(source, bytes);
  const pcm: Evidence = { id: 'evidence-00000000-0000-4000-8000-000000000001', kind: 'audio-pcm', path: 'fictional/original.s16le', bytes: bytes.length, sha256: hash(bytes),
    width: null, height: null, sourceWidth: null, sourceHeight: null, transform: null, streamIndex: 0, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: rate, samples: frames, coverage: 'full' };
  const controller = new AbortController(), policy = { ...DEFAULT_INSPECT_POLICY, ...changes, asr: { ...DEFAULT_INSPECT_POLICY.asr, enabled: true, ...changes.asr } };
  const context: InspectContext = { projectDir: scratch, temporaryDir: cwd, evidenceDir: dir, publishedDir: 'fictional', policy,
    counts: { ...emptyCatalogCounts(), derivedBytes: bytes.length, decodedAudioBytes: bytes.length }, tools: [], signal: controller.signal, check: () => controller.signal.throwIfAborted() };
  return { source, bytes, pcm, controller, context, facts: preflightAsrWav(wave(frames, rate, channels), limits()) };
}
function fakeTool(code: string): NativeToolIdentity {
  const path = join(scratch, `tool-${++sequence}`), data = Buffer.from(`#!${process.execPath}\n${code}\n`); writeFileSync(path, data, { mode: 0o700 });
  return { executable: path, version: 'fictional-resampler@1', files: [{ path, bytes: data.length, sha256: hash(data) }], aliases: [{ path, realpath: path }] };
}
const exactTool = () => fakeTool('const fs=require("node:fs"),argv=process.argv;process.stdout.write(fs.readFileSync(argv[argv.indexOf("-i")+1]));');
function expectedHeader(samples: number) {
  const bytes = Buffer.from('524946462419000057415645666d74201000000001000100803e0000007d0000020010006461746100190000', 'hex');
  bytes.writeUInt32LE(36 + samples * 2, 4); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}

test('RIFF oracle admits mono/stereo, rate endpoints, reordered chunks and metadata padding', () => {
  for (const rate of [8000, 16000, 44100, 48000]) for (const channels of [1, 2]) {
    const frames = rate / 5, data = wave(frames, rate, channels);
    assert.deepEqual(preflightAsrWav(data, limits()), { format: 'wav', sampleRate: rate, channels, bitsPerSample: 16, frames, dataBytes: frames * channels * 2, dataOffset: 44 });
  }
  const data = riff([chunk('JUNK', Buffer.from([1]), 255), chunk('data', Buffer.alloc(6400)), chunk('LIST', Buffer.from('INFO')), chunk('fmt ', fmt())]);
  assert.deepEqual(preflightAsrWav(data, limits()), { format: 'wav', sampleRate: 16000, channels: 1, bitsPerSample: 16, frames: 3200, dataBytes: 6400, dataOffset: 30 });
});
test('RIFF extent, chunk extents, duplicate fmt/data, missing chunks and frame alignment reject', () => {
  const original = wave(), shortExtent = Buffer.from(original); shortExtent.writeUInt32LE(original.length - 9, 4);
  const hugeChunk = Buffer.from(original); hugeChunk.writeUInt32LE(0xffffffff, 40);
  const wrongRate = fmt(); wrongRate.writeUInt32LE(123, 8); const wrongAlign = fmt(); wrongAlign.writeUInt16LE(4, 12);
  const odd = chunk('JUNK', Buffer.from([1]));
  const cases = [Buffer.alloc(11), shortExtent, Buffer.concat([original, Buffer.from([0])]), hugeChunk,
    riff([chunk('fmt ', fmt()), chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6400))]), riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6400)), chunk('data', Buffer.alloc(0))]),
    riff([chunk('fmt ', fmt())]), riff([chunk('data', Buffer.alloc(6400))]), riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6401))]),
    riff([chunk('fmt ', fmt(16000, 2)), chunk('data', Buffer.alloc(6402))]), riff([chunk('fmt ', wrongRate), chunk('data', Buffer.alloc(6400))]),
    riff([chunk('fmt ', wrongAlign), chunk('data', Buffer.alloc(6400))]), riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6400)), Buffer.alloc(7)]),
    riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6400)), odd.subarray(0, odd.length - 1)]), riff([chunk('fmt ', fmt()), chunk('data', Buffer.alloc(6400)), chunk('LIST', Buffer.alloc(3))])];
  for (const data of cases) assert.throws(() => preflightAsrWav(data, limits()), /ASR_STRUCTURE_INVALID/);
});
test('scope excludes RF64/RIFX, extended/float/compressed PCM, channel/rate/bit variants and wavl', () => {
  const rf64 = wave(); rf64.write('RF64'); const rifx = wave(); rifx.write('RIFX'); const wrongType = wave(); wrongType.write('AVI ', 8);
  const cases = [rf64, rifx, wrongType, riff([chunk('fmt ', Buffer.concat([fmt(), Buffer.alloc(2)])), chunk('data', Buffer.alloc(6400))]),
    ...[3, 6, 0xfffe].map(tag => riff([chunk('fmt ', fmt(16000, 1, 16, tag)), chunk('data', Buffer.alloc(6400))])),
    ...[0, 3].map(channels => riff([chunk('fmt ', fmt(16000, channels)), chunk('data', Buffer.alloc(6400))])),
    ...[7999, 48001].map(rate => riff([chunk('fmt ', fmt(rate)), chunk('data', Buffer.alloc(6400))])),
    ...[8, 24, 32].map(bits => riff([chunk('fmt ', fmt(16000, 1, bits)), chunk('data', Buffer.alloc(6400))])),
    riff([chunk('fmt ', fmt()), chunk('LIST', Buffer.from('wavl')), chunk('data', Buffer.alloc(6400))]), riff([chunk('fmt ', fmt()), chunk('wavl', Buffer.alloc(0)), chunk('data', Buffer.alloc(6400))])];
  for (const data of cases) assert.throws(() => preflightAsrWav(data, limits()), /ASR_FORMAT_UNSUPPORTED/);
});
test('source, chunk and rational sample limits accept exact and reject one-past', () => {
  const data = wave(); assert.equal(preflightAsrWav(data, limits({ maxAsrSourceBytes: data.length, maxAsrRiffChunks: 2, maxAsrSamples: 3200 })).frames, 3200);
  assert.throws(() => preflightAsrWav(data, limits({ maxAsrSourceBytes: data.length - 1 })), /ASR_SOURCE_LIMIT/);
  assert.throws(() => preflightAsrWav(data, limits({ maxAsrRiffChunks: 1 })), /ASR_STRUCTURE_LIMIT/);
  assert.throws(() => preflightAsrWav(wave(3199), limits()), /ASR_SAMPLES_LIMIT/);
  assert.throws(() => preflightAsrWav(wave(3201), limits({ maxAsrSamples: 3200 })), /ASR_SAMPLES_LIMIT/);
  assert.throws(() => preflightAsrWav(wave(8819, 44100), limits()), /ASR_SAMPLES_LIMIT/);
  assert.throws(() => preflightAsrWav(wave(8821, 44100), limits({ maxAsrSamples: 3200 })), /ASR_SAMPLES_LIMIT/);
  assert.equal(preflightAsrWav(wave(1920000), limits()).frames, 1920000);
  assert.throws(() => preflightAsrWav(wave(1920001), limits()), /ASR_SAMPLES_LIMIT/);
  const many = Array.from({ length: 4094 }, () => chunk('JUNK', Buffer.alloc(0))), exact = riff([chunk('fmt ', fmt()), ...many, chunk('data', Buffer.alloc(6400))]);
  assert.equal(preflightAsrWav(exact, limits()).frames, 3200);
  assert.throws(() => preflightAsrWav(riff([chunk('JUNK', Buffer.alloc(0)), ...[exact.subarray(12)]]), limits()), /ASR_STRUCTURE_LIMIT/);
});

test('complete mono evidence generates hand-written canonical header and single accounting', async () => {
  const selected = fixture(), result = await decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, exactTool());
  assert.equal(result.samples, 3200); assert.equal(result.payloadBytes, 6400); assert.deepEqual(result.wav.subarray(0, 44), expectedHeader(3200)); assert.deepEqual(result.wav.subarray(44), selected.bytes);
  assert.equal(result.wav.length, 6444); assert.equal(selected.context.counts.derivedBytes, 12844); assert.equal(selected.context.counts.decodedAudioBytes, 12800); assert.equal(selected.context.counts.sourceReadBytes, 12800);
  const run = selected.context.tools[0]!; assert.equal(run.binaryBytes, 6400); assert.equal(run.stdoutBytes, 0); assert.match(run.version, /\/asr-audio@0\.1$/);
  assert.equal(run.argv[run.argv.indexOf('-i') + 1], selected.source); assert.equal(run.argv[run.argv.indexOf('-af') + 1], 'aresample=16000:resampler=swr:dither_method=none:async=0');
  for (const flag of ['-vn', '-sn', '-dn', '-filter_threads', '-protocol_whitelist', '-format_whitelist', '-threads', '-max_alloc']) assert.ok(run.argv.includes(flag));
  for (const flag of ['-t', '-to', '-ss', '-frames:a']) assert.equal(run.argv.includes(flag), false);
});
test('base PCM coverage, sample facts and local capacity are checked before spawning', async () => {
  for (const change of [{ kind: 'probe' }, { coverage: 'partial' }, { sampleRate: 8000 }, { samples: 3199 }, { bytes: 6399 }]) {
    const selected = fixture(); await assert.rejects(decodeAsrAudio(selected.source, selected.facts, { ...selected.pcm, ...change } as Evidence, selected.context, exactTool()), /ASR_AUDIO_INVALID/); assert.equal(selected.context.tools.length, 0);
  }
  const audioLimit = fixture(3200, 16000, 1, { asr: { maxAsrAudioBytes: 6443 } }); await assert.rejects(decodeAsrAudio(audioLimit.source, audioLimit.facts, audioLimit.pcm, audioLimit.context, exactTool()), /ASR_AUDIO_LIMIT/); assert.equal(audioLimit.context.tools.length, 0);
  const samples = fixture(3200, 16000, 1, { asr: { maxAsrSamples: 3199 } }); await assert.rejects(decodeAsrAudio(samples.source, samples.facts, samples.pcm, samples.context, exactTool()), /ASR_SAMPLES_LIMIT/); assert.equal(samples.context.tools.length, 0);
});
test('exact derived/decoded quotas and one-past retain global failure classification', async () => {
  const exact = fixture(3200, 16000, 1, { maxDerivedBytes: 12844, maxDecodedAudioBytes: 12800 }); await decodeAsrAudio(exact.source, exact.facts, exact.pcm, exact.context, exactTool());
  assert.equal(exact.context.counts.derivedBytes, 12844); assert.equal(exact.context.counts.decodedAudioBytes, 12800);
  for (const [policy, pattern] of [[{ maxDerivedBytes: 12843 }, /^Error: CATALOG_DERIVED_LIMIT$/], [{ maxDecodedAudioBytes: 12799 }, /^Error: CATALOG_DECODED_AUDIO_LIMIT$/]] as const) {
    const selected = fixture(3200, 16000, 1, policy); await assert.rejects(decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, exactTool()), pattern);
    assert.equal(selected.context.counts.derivedBytes, 6444); assert.equal(selected.context.counts.decodedAudioBytes, 6400); assert.equal(selected.context.tools[0]!.binaryBytes, 0);
  }
  const header = fixture(3200, 16000, 1, { maxDerivedBytes: 6443 }); await assert.rejects(decodeAsrAudio(header.source, header.facts, header.pcm, header.context, exactTool()), /CATALOG_DERIVED_LIMIT/); assert.equal(header.context.counts.derivedBytes, 6400); assert.equal(header.context.tools.length, 0);
});
test('odd, empty, short, incorrect sample counts and local output overflow preserve consumption', async () => {
  for (const [bytes, pattern] of [[6401, /ASR_AUDIO_INVALID.*alignment/], [0, /ASR_SAMPLES_LIMIT/], [6398, /ASR_SAMPLES_LIMIT/], [6404, /ASR_AUDIO_INVALID.*sample count/]] as const) {
    const selected = fixture(); await assert.rejects(decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, fakeTool(`process.stdout.write(Buffer.alloc(${bytes}));`)), pattern);
    assert.equal(selected.context.counts.derivedBytes, 6444 + bytes); assert.equal(selected.context.counts.decodedAudioBytes, 6400 + bytes);
  }
  const limited = fixture(3200, 16000, 1, { asr: { maxAsrSamples: 3200 } }); await assert.rejects(decodeAsrAudio(limited.source, limited.facts, limited.pcm, limited.context, fakeTool('process.stdout.write(Buffer.alloc(6402));')), /ASR_SAMPLES_LIMIT/);
  assert.equal(limited.context.tools[0]!.binaryBytes, 6400); assert.equal(limited.context.counts.derivedBytes, 12844);
});
test('normalization exit, diagnostics and time failures remain local ASR failures', async () => {
  const failed = fixture(); await assert.rejects(decodeAsrAudio(failed.source, failed.facts, failed.pcm, failed.context, fakeTool('process.stdout.write(Buffer.alloc(6400));process.exitCode=2;')), /ASR_AUDIO_TOOL_FAILED.*TOOL_EXIT/); assert.equal(failed.context.counts.derivedBytes, 12844);
  const diagnostics = fixture(3200, 16000, 1, { maxToolOutputBytes: 32 }); await assert.rejects(decodeAsrAudio(diagnostics.source, diagnostics.facts, diagnostics.pcm, diagnostics.context, fakeTool('process.stderr.write("x".repeat(128));')), /ASR_AUDIO_TOOL_FAILED.*OUTPUT_LIMIT/); assert.equal(diagnostics.context.counts.toolOutputBytes, 32);
  const timeout = fixture(3200, 16000, 1, { maxToolElapsedMs: 10 }); await assert.rejects(decodeAsrAudio(timeout.source, timeout.facts, timeout.pcm, timeout.context, fakeTool('setInterval(()=>{},1000);')), /ASR_AUDIO_TOOL_FAILED.*TIME_LIMIT/); assert.equal(timeout.context.tools[0]!.signal, 'SIGKILL');
});
test('one-shot callback failure returns its original error object', async () => {
  const selected = fixture(), failure = new Error('CATALOG_TIME_LIMIT'); let checks = 0;
  selected.context.check = () => { if (++checks === 3) throw failure; };
  await assert.rejects(decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, exactTool()), error => error === failure);
  assert.equal(selected.context.counts.derivedBytes, 6444); assert.equal(selected.context.tools[0]!.binaryBytes, 0);
});
test('original PCM replacement, source links and during-tool changes remain batch failures', async () => {
  const stale = fixture(); writeFileSync(stale.source, Buffer.alloc(6400)); await assert.rejects(decodeAsrAudio(stale.source, stale.facts, stale.pcm, stale.context, exactTool()), /CATALOG_SOURCE_CHANGED/); assert.equal(stale.context.tools.length, 0);
  for (const link of ['hard', 'symbolic']) {
    const selected = fixture(), alias = `${selected.source}.alias`; if (link === 'hard') linkSync(selected.source, alias); else { writeFileSync(alias, selected.bytes); rmSync(selected.source); symlinkSync(alias, selected.source); }
    await assert.rejects(decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, exactTool()), /CATALOG_SOURCE_CHANGED/); assert.equal(selected.context.tools.length, 0);
  }
  const changed = fixture(), code = `require('node:fs').writeFileSync(${JSON.stringify(changed.source)},Buffer.alloc(6400));process.stdout.write(Buffer.alloc(6400));`;
  await assert.rejects(decodeAsrAudio(changed.source, changed.facts, changed.pcm, changed.context, fakeTool(code)), /CATALOG_SOURCE_CHANGED/); assert.equal(changed.context.counts.derivedBytes, 12844);
  const sameBytes = fixture(), rewrite = `const fs=require('node:fs'),path=${JSON.stringify(sameBytes.source)},bytes=fs.readFileSync(path);fs.writeFileSync(path,bytes);process.stdout.write(bytes);`;
  await assert.rejects(decodeAsrAudio(sameBytes.source, sameBytes.facts, sameBytes.pcm, sameBytes.context, fakeTool(rewrite)), /CATALOG_SOURCE_CHANGED.*node/); assert.equal(sameBytes.context.counts.derivedBytes, 12844);
});
test('abort before spawn and during normalization retains abort identity and process termination', async () => {
  const before = fixture(); before.controller.abort(); await assert.rejects(decodeAsrAudio(before.source, before.facts, before.pcm, before.context, exactTool()), { name: 'AbortError' }); assert.equal(before.context.tools.length, 0);
  const selected = fixture(), timer = setTimeout(() => selected.controller.abort(), 40);
  try { await assert.rejects(decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, fakeTool('setInterval(()=>{},1000);')), { name: 'AbortError' }); }
  finally { clearTimeout(timer); } assert.equal(selected.context.tools[0]!.signal, 'SIGKILL');
});
test('real locked FFmpeg preserves all 16k mono samples and complete noninteger tails', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const tool = ocrRuntimeIdentity().tools.ffmpeg;
  const cases = [[16000, 3200], [16000, 16001], [8000, 1601], [8000, 8003], [44100, 8821], [44100, 44107], [48000, 9601], [48000, 48007]];
  for (const [rate, frames] of cases) {
    const selected = fixture(frames!, rate!), result = await decodeAsrAudio(selected.source, selected.facts, selected.pcm, selected.context, tool);
    assert.ok(Math.abs(result.samples * rate! - frames! * 16000) <= rate!, `${rate}/${frames}: ${result.samples}`);
    assert.deepEqual(result.wav.subarray(0, 44), expectedHeader(result.samples)); assert.equal(result.payloadBytes, result.samples * 2); assert.equal(result.wav.length, 44 + result.samples * 2);
    if (rate === 16000) { assert.equal(result.samples, frames); assert.deepEqual(result.wav.subarray(44), selected.bytes); }
    assert.equal(selected.context.counts.derivedBytes, selected.bytes.length + result.wav.length); assert.equal(selected.context.counts.decodedAudioBytes, selected.bytes.length + result.payloadBytes); assert.deepEqual(readFileSync(selected.source), selected.bytes);
    t.diagnostic(JSON.stringify({rate,sourceFrames:frames,targetSamples:result.samples,errorSamples:Math.abs(result.samples * rate! - frames! * 16000) / rate!,executable:tool.executable,version:tool.version,argv:selected.context.tools[0]!.argv,cwd:selected.context.temporaryDir,exitCode:selected.context.tools[0]!.exitCode}));
  }
});
