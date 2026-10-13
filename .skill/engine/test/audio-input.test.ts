import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { INSPECT_POLICY_05, emptyCatalogCounts } from '../src/project/catalog.ts';
import { DEFAULT_AUDIO_INPUT_LIMITS, type AudioInputRuntimeIdentity } from '../src/project/audio-input.ts';
import { audioInputProbeArguments, audioInputDecodeArguments, audioInputNormalizeArguments, preflightAudioInput, decodeAudioInput } from '../src/adapters/audio-input.ts';
import type { InspectContext } from '../src/adapters/inspection.ts';
import { audioInputRuntimeIdentity } from '../workspace.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.research/out'); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, 'audio-input-')); after(() => rmSync(scratch, { recursive: true, force: true }));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
let sequence = 0;
function wave(samples = 3200, rate = 16000, channels = 1) {
  const b = Buffer.alloc(44 + samples * channels * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * channels * 2, 40);
  for (let i = 0; i < samples; i++) for (let ch = 0; ch < channels; ch++) b.writeInt16LE(Math.round(9000 * Math.sin(i * 2 * Math.PI * 437 / rate)) * (ch ? -1 : 1), 44 + (i * channels + ch) * 2);
  return b;
}
function mp3(frames = 10, header = 0xfffb90c0) {
  const rateIndex = header >>> 10 & 3, version = header >>> 19 & 3, rate = [44100, 48000, 32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const index = header >>> 12 & 15, bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[index]!;
  const b = Buffer.alloc(Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + (header >>> 9 & 1)); b.writeUInt32BE(header);
  return Buffer.concat(Array.from({ length: frames }, () => b));
}
function crc(data: Buffer, bits: number, polynomial: number) {
  let value = 0; for (const b of data) { value ^= b << (bits - 8); for (let i = 0; i < 8; i++) value = (value & 2 ** (bits - 1) ? value << 1 ^ polynomial : value << 1) & (2 ** bits - 1); } return value;
}
function flac(samples = 3200) {
  const info = Buffer.alloc(34); info.writeUInt16BE(16); info.writeUInt16BE(samples, 2);
  info.writeBigUInt64BE(16000n << 44n | 15n << 36n | BigInt(samples), 10);
  const metadata = Buffer.alloc(4); metadata[0] = 128; metadata.writeUIntBE(34, 1, 3);
  const header = Buffer.from([255, 248, 112, 8, 0, (samples - 1) >>> 8, (samples - 1) & 255, 0]); header[7] = crc(header.subarray(0, 7), 8, 7);
  const body = Buffer.concat([header, Buffer.alloc(3)]), tail = Buffer.alloc(2); tail.writeUInt16BE(crc(body, 16, 0x8005));
  return Buffer.concat([Buffer.from('fLaC'), metadata, info, body, tail]);
}
function fixture(changes: Record<string, any> = {}, probeCode = '', decodeCode = '', normalizeCode = '') {
  const dir = join(scratch, String(++sequence)), cwd = join(dir, 'cwd'); mkdirSync(cwd, { recursive: true });
  const bytes = wave(), source = join(dir, 'selected source.wav'); writeFileSync(source, bytes);
  const controller = new AbortController(), policy = { ...INSPECT_POLICY_05, ...changes, audioInput: { ...INSPECT_POLICY_05.audioInput, ...changes.audioInput } };
  const context: InspectContext = { projectDir: dir, temporaryDir: cwd, evidenceDir: cwd, publishedDir: 'fictional', policy, counts: emptyCatalogCounts(), tools: [],
    signal: controller.signal, check: () => controller.signal.throwIfAborted(), sourceBytes: bytes.length, sourceSha256: hash(bytes) };
  function tool(name: string, code: string) {
    const path = join(dir, name), bytes = Buffer.from('#!' + process.execPath + '\n' + code + '\n'); writeFileSync(path, bytes, { mode: 0o700 });
    return { executable: path, version: 'fictional-tool@1', files: [{ path, bytes: bytes.length, sha256: hash(bytes) }], aliases: [{ path, realpath: path }] };
  }
  const ffprobe = tool('probe', probeCode || 'process.stdout.write(JSON.stringify({streams:[{index:0,codec_type:"audio",codec_name:"pcm_s16le",sample_rate:"16000",channels:1}],packets:[{stream_index:0,pos:"44",size:"6400"}]}));');
  const ffmpeg = tool('decode', 'const fs=require("node:fs"),argv=process.argv,source=argv[argv.indexOf("-i")+1];if(source.endsWith(".s16le")){' +
    (normalizeCode || 'process.stdout.write(fs.readFileSync(source));') + '}else{' + (decodeCode || 'process.stdout.write(fs.readFileSync(source).subarray(44));') + '}');
  const runtime: AudioInputRuntimeIdentity = { id: 'bounded-audio-input', version: '0.1', lockSha256: hash(Buffer.from('fictional-lock')), platform: 'darwin', arch: 'arm64', tools: { ffprobe, ffmpeg } };
  return { dir, source, bytes, controller, context, runtime, facts: preflightAudioInput(bytes, policy.audioInput) };
}

test('WAV independent data oracle fixes source-rate/channel endpoints and exact sample quotas', () => {
  for (const rate of [8000, 16000, 44100, 48000]) for (const channels of [1, 2]) {
    const bytes = wave(rate / 5, rate, channels), facts = preflightAudioInput(bytes, DEFAULT_AUDIO_INPUT_LIMITS);
    assert.equal(facts.samples, rate / 5); assert.equal(facts.payloadBytes, rate / 5 * channels * 2); assert.equal(facts.codedFrames, null); assert.equal(facts.metadataFrames, 0);
  }
  assert.throws(() => preflightAudioInput(wave(3199), DEFAULT_AUDIO_INPUT_LIMITS), /SAMPLES_LIMIT/);
  assert.throws(() => preflightAudioInput(wave(3201), { ...DEFAULT_AUDIO_INPUT_LIMITS, maxSamples: 3200 }), /SAMPLES_LIMIT/);
  assert.throws(() => preflightAudioInput(wave(), { ...DEFAULT_AUDIO_INPUT_LIMITS, maxSourceBytes: 6443 }), /SOURCE_LIMIT/);
  assert.throws(() => preflightAudioInput(wave(), { ...DEFAULT_AUDIO_INPUT_LIMITS, maxPcmBytes: 6399 }), /FACTS_LIMIT/);
  assert.throws(() => preflightAudioInput(wave(), { ...DEFAULT_AUDIO_INPUT_LIMITS, maxStructureEntries: 1 }), /STRUCTURE_LIMIT/);
});
test('MP3 oracle independently counts physical MPEG1/2/2.5 frames and excludes a first Xing frame', () => {
  for (const [header, samples, rate] of [[0xfffb90c0, 11520, 44100], [0xfff388c0, 5760, 16000], [0xffe388c0, 5760, 8000]]) {
    const facts = preflightAudioInput(mp3(10, header!), DEFAULT_AUDIO_INPUT_LIMITS);
    assert.equal(facts.samples, samples); assert.equal(facts.sampleRate, rate); assert.equal(facts.codedFrames, 10);
  }
  const body = mp3(10), metadata = mp3(1), xing = 21; metadata.write('Xing', xing); metadata.writeUInt32BE(3, xing + 4);
  metadata.writeUInt32BE(10, xing + 8); metadata.writeUInt32BE(body.length + metadata.length, xing + 12);
  const all = Buffer.concat([metadata, body]), facts = preflightAudioInput(all, DEFAULT_AUDIO_INPUT_LIMITS);
  assert.equal(facts.samples, 11520); assert.equal(facts.metadataFrames, 1); assert.equal(facts.payloadBytes, all.length);
  metadata.writeUInt32BE(11, xing + 8); assert.throws(() => preflightAudioInput(Buffer.concat([metadata, body]), DEFAULT_AUDIO_INPUT_LIMITS), /Xing frame\/byte count/);
});
test('MP3 tail extents, changed rate/channel, noninitial Xing, reserved/free format and tags reject', () => {
  const valid = mp3(); for (const cut of [1, 10, 100]) assert.throws(() => preflightAudioInput(valid.subarray(0, -cut), DEFAULT_AUDIO_INPUT_LIMITS), /frame extent/);
  const wrong = Buffer.from(valid); wrong.writeUInt32BE(0xfffb94c0, 417); assert.throws(() => preflightAudioInput(wrong, DEFAULT_AUDIO_INPUT_LIMITS));
  const changedChannels = Buffer.from(valid); changedChannels.writeUInt32BE(0xfffb9000, 417); assert.throws(() => preflightAudioInput(changedChannels, DEFAULT_AUDIO_INPUT_LIMITS), /change/);
  const noninitial = Buffer.from(valid); noninitial.write('Xing', 417 + 21); assert.throws(() => preflightAudioInput(noninitial, DEFAULT_AUDIO_INPUT_LIMITS), /noninitial/);
  const free = Buffer.from(valid); free.writeUInt32BE(0xfffb00c0); assert.throws(() => preflightAudioInput(free, DEFAULT_AUDIO_INPUT_LIMITS), /FORMAT_UNSUPPORTED/);
  assert.throws(() => preflightAudioInput(Buffer.concat([valid, Buffer.from('APETAGEX')]), DEFAULT_AUDIO_INPUT_LIMITS));
  const id3 = Buffer.from([73,68,51,4,0,0,0,0,0,2,0,0]); assert.equal(preflightAudioInput(Buffer.concat([id3, valid]), DEFAULT_AUDIO_INPUT_LIMITS).samples, 11520);
  id3[5] = 128; assert.throws(() => preflightAudioInput(Buffer.concat([id3, valid]), DEFAULT_AUDIO_INPUT_LIMITS), /plain ID3/);
  assert.throws(() => preflightAudioInput(valid, { ...DEFAULT_AUDIO_INPUT_LIMITS, maxPackets: 9 }), /PACKET_LIMIT/);
  assert.throws(() => preflightAudioInput(valid, { ...DEFAULT_AUDIO_INPUT_LIMITS, maxStructureEntries: 9 }), /STRUCTURE_LIMIT/);
});
test('FLAC independent STREAMINFO, header CRC8, frame CRC16 and exact EOF sample closure', () => {
  const data = flac(), facts = preflightAudioInput(data, DEFAULT_AUDIO_INPUT_LIMITS); assert.equal(facts.samples, 3200); assert.equal(facts.codedFrames, 1);
  for (const cut of [1, 2, 10]) assert.throws(() => preflightAudioInput(data.subarray(0, -cut), DEFAULT_AUDIO_INPUT_LIMITS), /STRUCTURE_INVALID/);
  for (const offset of [42, 49, data.length - 1]) { const bad = Buffer.from(data); bad[offset] ^= 1; assert.throws(() => preflightAudioInput(bad, DEFAULT_AUDIO_INPUT_LIMITS), /STRUCTURE_INVALID/); }
  const badSamples = Buffer.from(data); badSamples[25] ^= 1; assert.throws(() => preflightAudioInput(badSamples, DEFAULT_AUDIO_INPUT_LIMITS), /STRUCTURE_INVALID/);
  const picture = Buffer.from(data); picture[4] = 134; assert.throws(() => preflightAudioInput(picture, DEFAULT_AUDIO_INPUT_LIMITS), /FORMAT_UNSUPPORTED/);
  assert.throws(() => preflightAudioInput(Buffer.concat([data, Buffer.from([0])]), DEFAULT_AUDIO_INPUT_LIMITS), /STRUCTURE_INVALID/);
});
test('fixed argv restricts one local format/audio track and preserves explicit frame-domain options', () => {
  for (const data of [wave(), mp3(), flac()]) {
    const facts = preflightAudioInput(data, DEFAULT_AUDIO_INPUT_LIMITS), probe = audioInputProbeArguments(facts, '/fictional/source'), decode = audioInputDecodeArguments(facts, '/fictional/source');
    for (const argv of [probe, decode]) { assert.equal(argv[argv.indexOf('-protocol_whitelist') + 1], 'file'); assert.equal(argv[argv.indexOf('-format_whitelist') + 1], facts.demuxer); assert.equal(argv[argv.indexOf('-max_streams') + 1], '1'); }
    assert.equal(decode[decode.indexOf('-map') + 1], '0:a:0'); assert.equal(decode.at(-1), 'pipe:1');
    if (facts.format === 'mp3') assert.equal(decode[decode.indexOf('-flags2') + 1], '+skip_manual');
    const normalize = audioInputNormalizeArguments(facts, '/fictional/private/source.s16le'); assert.equal(normalize[normalize.indexOf('-i') + 1], '/fictional/private/source.s16le');
    assert.equal(normalize[normalize.indexOf('-af') + 1], 'aresample=16000:resampler=swr:dither_method=none:async=0');
  }
});
test('three complete tool runs retain actual argv, identity, exact PCM and consumption counts', async () => {
  const f = fixture(), result = await decodeAudioInput(f.source, f.facts, f.context, f.runtime);
  assert.deepEqual(result.pcm, f.bytes.subarray(44)); assert.deepEqual(result.wav, f.bytes); assert.equal(result.samples, 3200);
  assert.equal(f.context.counts.derivedBytes, 12844); assert.equal(f.context.counts.decodedAudioBytes, 12800); assert.equal(f.context.tools.length, 3);
  assert.deepEqual(result.commands.probe.argv, audioInputProbeArguments(f.facts, f.source)); assert.deepEqual(result.commands.decode.argv, audioInputDecodeArguments(f.facts, f.source));
  assert.deepEqual(result.commands.normalize.argv, audioInputNormalizeArguments(f.facts, join(f.context.temporaryDir, 'source.s16le')));
  assert.deepEqual(readdirSync(f.context.temporaryDir), []); assert.deepEqual(readFileSync(f.source), f.bytes);
});
test('complete probe closure rejects extra/missing streams, skipped or outside packets before decoding', async () => {
  const valid = { streams: [{ index: 0, codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '16000', channels: 1 }], packets: [{ stream_index: 0, pos: '44', size: '6400' }] };
  for (const mutate of [(p: any) => p.streams.push({ ...p.streams[0], index: 1 }), (p: any) => p.streams = [], (p: any) => p.packets[0].pos = '45',
    (p: any) => p.packets[0].size = '6398', (p: any) => p.packets[0].size = '6402', (p: any) => p.packets[0].stream_index = 1, (p: any) => p.packets = []]) {
    const p = structuredClone(valid); mutate(p); const f = fixture({}, 'process.stdout.write(' + JSON.stringify(JSON.stringify(p)) + ');');
    await assert.rejects(decodeAudioInput(f.source, f.facts, f.context, f.runtime), /AUDIO_INPUT_PROBE_INVALID/); assert.equal(f.context.tools.length, 1); assert.equal(f.context.counts.decodedAudioBytes, 0);
  }
  const p = structuredClone(valid); p.packets = [{ stream_index: 0, pos: '44', size: '3200' }, { stream_index: 0, pos: '3244', size: '3200' }];
  const limited = fixture({ audioInput: { maxPackets: 1 } }, 'process.stdout.write(' + JSON.stringify(JSON.stringify(p)) + ');');
  await assert.rejects(decodeAudioInput(limited.source, limited.facts, limited.context, limited.runtime), /AUDIO_INPUT_PACKET_LIMIT/); assert.equal(limited.context.tools.length, 1);
});
test('decoder short/odd/one-past sample output and normalization corruption reject complete claims', async () => {
  for (const bytes of [0, 6398, 6399, 6401, 6402]) {
    const f = fixture({}, '', 'process.stdout.write(Buffer.alloc(' + bytes + '));');
    await assert.rejects(decodeAudioInput(f.source, f.facts, f.context, f.runtime), /AUDIO_INPUT_PCM_INVALID/);
    assert.equal(f.context.tools.length, 2); assert.equal(f.context.counts.decodedAudioBytes, Math.min(bytes, 6400));
  }
  const corrupt = fixture({}, '', '', 'process.stdout.write(Buffer.alloc(6400));'); await assert.rejects(decodeAudioInput(corrupt.source, corrupt.facts, corrupt.context, corrupt.runtime), /16k passthrough/);
  assert.deepEqual(readdirSync(corrupt.context.temporaryDir), []);
});
test('derived/decoded quota failures preserve accepted counts and remove private PCM', async () => {
  for (const [changes, reason] of [[{ maxDerivedBytes: 12843 }, /CATALOG_DERIVED_LIMIT/], [{ maxDecodedAudioBytes: 12799 }, /CATALOG_DECODED_AUDIO_LIMIT/]] as const) {
    const f = fixture(changes); await assert.rejects(decodeAudioInput(f.source, f.facts, f.context, f.runtime), reason);
    assert.equal(f.context.counts.derivedBytes, 6444); assert.equal(f.context.counts.decodedAudioBytes, 6400); assert.deepEqual(readdirSync(f.context.temporaryDir), []);
  }
  const f = fixture({ audioInput: { maxAudioBytes: 6443 } }); await assert.rejects(decodeAudioInput(f.source, f.facts, f.context, f.runtime), /AUDIO_INPUT_AUDIO_LIMIT/); assert.deepEqual(readdirSync(f.context.temporaryDir), []);
});
test('source replacement, fixed native mutation, tool timeout/output limit and abort retain refusal scope', async () => {
  const changed = fixture(); writeFileSync(changed.source, Buffer.alloc(changed.bytes.length)); await assert.rejects(decodeAudioInput(changed.source, changed.facts, changed.context, changed.runtime), /SOURCE_CHANGED|FORMAT_UNSUPPORTED/);
  const runtime = fixture(); writeFileSync(runtime.runtime.tools.ffmpeg.executable, 'changed bytes'); await assert.rejects(decodeAudioInput(runtime.source, runtime.facts, runtime.context, runtime.runtime), /CATALOG_AUDIO_INPUT_RUNTIME_CHANGED/); assert.equal(runtime.context.tools.length, 0);
  const timeout = fixture({ maxToolElapsedMs: 20 }, 'setInterval(()=>{},1000);'); await assert.rejects(decodeAudioInput(timeout.source, timeout.facts, timeout.context, timeout.runtime), /AUDIO_INPUT_TOOL_FAILED.*TIME_LIMIT/); assert.equal(timeout.context.tools[0]!.signal, 'SIGKILL');
  const output = fixture({ maxToolOutputBytes: 32 }); await assert.rejects(decodeAudioInput(output.source, output.facts, output.context, output.runtime), /AUDIO_INPUT_TOOL_FAILED.*OUTPUT_LIMIT/); assert.equal(output.context.counts.toolOutputBytes, 32);
  const before = fixture(); before.controller.abort(); await assert.rejects(decodeAudioInput(before.source, before.facts, before.context, before.runtime), { name: 'AbortError' }); assert.equal(before.context.tools.length, 0);
  const during = fixture({}, 'setInterval(()=>{},1000);'), timer = setTimeout(() => during.controller.abort(), 50);
  try { await assert.rejects(decodeAudioInput(during.source, during.facts, during.context, during.runtime), { name: 'AbortError' }); } finally { clearTimeout(timer); }
  assert.equal(during.context.tools[0]!.signal, 'SIGKILL');
});
test('actual locked four-format oracle covers known samples, priming, rates, stereo and truncation', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async t => {
  const runtime = audioInputRuntimeIdentity();
  for (const [rate, channels, count] of [[44100, 1, 44273], [8000, 1, 8003], [16000, 2, 16017], [48000, 2, 48007]]) {
    const dir = join(scratch, 'native-' + rate), source = join(dir, 'known.wav'); mkdirSync(dir); const original = wave(count!, rate!, channels!); writeFileSync(source, original);
    for (const [suffix, encoder] of [['wav', []], ['mp3', ['-c:a', 'libmp3lame', '-b:a', '128k']], ['flac', ['-c:a', 'flac']], ['m4a', ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k']]] as const) {
      const path = join(dir, 'known.' + suffix);
      if (suffix !== 'wav') { const argv = ['-nostdin', '-hide_banner', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'wav', '-i', source, ...encoder, path], run = spawnSync(runtime.tools.ffmpeg.executable, argv, { cwd: dir, env: { PATH: '/usr/bin:/bin', TMPDIR: dir }, encoding: 'utf8', timeout: 30000 }); assert.equal(run.status, 0, run.stderr); t.diagnostic(JSON.stringify({ kind: 'fixture-encode', argv, cwd: dir, executable: runtime.tools.ffmpeg.executable, exitCode: run.status })); }
      const bytes = readFileSync(path), facts = preflightAudioInput(bytes, DEFAULT_AUDIO_INPUT_LIMITS), cwd = join(dir, suffix + '-cwd'); mkdirSync(cwd);
      const context: InspectContext = { projectDir: dir, temporaryDir: cwd, evidenceDir: cwd, publishedDir: 'fictional', policy: INSPECT_POLICY_05, counts: emptyCatalogCounts(), tools: [], signal: new AbortController().signal, check: () => {}, sourceBytes: bytes.length, sourceSha256: hash(bytes) };
      const result = await decodeAudioInput(path, facts, context, runtime);
      assert.equal(result.pcm.length, facts.samples * 2); assert.equal(result.wav.length, 44 + result.samples * 2); assert.deepEqual(readFileSync(path), bytes); assert.deepEqual(readdirSync(cwd), []);
      if (suffix === 'wav' || suffix === 'flac') assert.equal(facts.samples, count);
      if (rate === 44100 && suffix === 'mp3') { assert.equal(facts.samples, 46080); assert.equal(facts.codedFrames, 40); assert.equal(facts.metadataFrames, 1); assert.deepEqual(facts.gapless, { delaySamples: 576, paddingSamples: 1231 }); }
      if (rate === 44100 && suffix === 'm4a') { assert.equal(facts.samples, 46080); assert.equal(facts.codedFrames, 45); assert.deepEqual(facts.edit, { mediaTime: 1024, segmentDuration: 1004, movieTimescale: 1000 }); }
      for (const cut of [1, 10, 100]) assert.throws(() => preflightAudioInput(bytes.subarray(0, -cut), DEFAULT_AUDIO_INPUT_LIMITS));
      if (suffix === 'm4a') {
        const dref = bytes.indexOf('url '), external = Buffer.from(bytes); external.writeUInt32BE(0, dref + 4); assert.throws(() => preflightAudioInput(external, DEFAULT_AUDIO_INPUT_LIMITS), /self-contained/);
        const edit = bytes.indexOf('elst'), reversed = Buffer.from(bytes); reversed.writeInt32BE(-1, edit + 16); assert.throws(() => preflightAudioInput(reversed, DEFAULT_AUDIO_INPUT_LIMITS), /forward/);
        const offset = bytes.indexOf('stco'), outside = Buffer.from(bytes); outside.writeUInt32BE(bytes.length, offset + 12); assert.throws(() => preflightAudioInput(outside, DEFAULT_AUDIO_INPUT_LIMITS), /chunk coverage/);
        const sampleStart = bytes.indexOf('mp4a') - 4, sampleEnd = sampleStart + bytes.readUInt32BE(sampleStart), sinf = Buffer.from([0,0,0,8,115,105,110,102]);
        const encrypted = Buffer.concat([bytes.subarray(0, sampleEnd), sinf, bytes.subarray(sampleEnd)]);
        for (const name of ['mp4a', 'stsd', 'stbl', 'minf', 'mdia', 'trak', 'moov']) { const p = bytes.indexOf(name) - 4; encrypted.writeUInt32BE(bytes.readUInt32BE(p) + sinf.length, p); }
        assert.throws(() => preflightAudioInput(encrypted, DEFAULT_AUDIO_INPUT_LIMITS), /M4A box combination/);
      }
      t.diagnostic(JSON.stringify({ format: suffix, rate, channels, originalSamples: count, facts, canonicalSamples: result.samples, pcmSha256: hash(result.pcm), wavSha256: hash(result.wav), tools: context.tools }));
    }
  }
});
