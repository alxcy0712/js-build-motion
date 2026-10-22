import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { deflateSync } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { audioInputRuntimeIdentity } from '../workspace.mjs';
import { DEFAULT_AUDIO_INPUT_LIMITS, validateAudioInputFacts, type AudioInputFacts } from '../src/project/audio-input.ts';
import { DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05, adoptInspectPolicy, emptyCatalogCounts } from '../src/project/catalog.ts';
import { DEFAULT_ALIGNMENT_POLICY, ALIGNMENT_POLICY_02 } from '../src/project/alignment.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(join(out, 'audio-input-security-')));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const limits = { ...DEFAULT_AUDIO_INPUT_LIMITS };
const base: AudioInputFacts = { version: '0.1', kind: 'audio-input-facts', format: 'wav', demuxer: 'wav', codec: 'pcm_s16le',
  sampleRate: 16000, channels: 1, bitsPerSample: 16, samples: 3200, sampleDomain: 'complete-decoded-frames',
  codedFrames: null, metadataFrames: 0, payloadBytes: 6400, gapless: null, edit: null };
const facts = (changes: Partial<AudioInputFacts> = {}) => ({ ...structuredClone(base), ...changes });

test('independent audio contract keeps historical defaults and explicit new policy adoption', () => {
  assert.equal(DEFAULT_INSPECT_POLICY.version, '0.4'); assert.equal(DEFAULT_ALIGNMENT_POLICY.version, '0.1');
  assert.equal(ALIGNMENT_POLICY_02.version, '0.2'); assert.equal(INSPECT_POLICY_05.asr.enabled, false);
  assert.deepEqual(adoptInspectPolicy(DEFAULT_INSPECT_POLICY), DEFAULT_INSPECT_POLICY);
  assert.deepEqual(adoptInspectPolicy(DEFAULT_INSPECT_POLICY, '0.5'), INSPECT_POLICY_05);
  assert.throws(() => adoptInspectPolicy(INSPECT_POLICY_05, '0.4'));
});

test('independent facts reject contradictory container codec, timing domain and irrelevant metadata', () => {
  validateAudioInputFacts(base, limits);
  for (const change of [
    { demuxer: 'mov' }, { codec: 'aac' }, { channels: 3 }, { bitsPerSample: null }, { samples: 3199 },
    { codedFrames: 1 }, { metadataFrames: 1 }, { payloadBytes: 6398 }, { sampleDomain: 'presentation' },
    { gapless: { delaySamples: 1, paddingSamples: 0 } }, { edit: { mediaTime: 0, segmentDuration: 1, movieTimescale: 1 } },
    { unlisted: 'external-file' },
  ]) assert.throws(() => validateAudioInputFacts({ ...base, ...change }, limits), JSON.stringify(change));
  const mp3 = facts({ format: 'mp3', demuxer: 'mp3', codec: 'mp3', bitsPerSample: null, samples: 4608, codedFrames: 8, payloadBytes: 1152 });
  validateAudioInputFacts(mp3, limits);
  for (const change of [{ sampleRate: 17000 }, { samples: 4607 }, { metadataFrames: 2 }, { codedFrames: null },
    { gapless: { delaySamples: 1, paddingSamples: 0 } }, { metadataFrames: 1, gapless: { delaySamples: 4096, paddingSamples: 0 } },
    { metadataFrames: 1, gapless: { delaySamples: 4095, paddingSamples: 513 } }])
    assert.throws(() => validateAudioInputFacts({ ...mp3, ...change }, limits), JSON.stringify(change));
  assert.throws(() => validateAudioInputFacts(facts({ format: 'flac', demuxer: 'flac', codec: 'flac', codedFrames: 201 }), limits));
  const aac = facts({ format: 'm4a', demuxer: 'mov', codec: 'aac', bitsPerSample: null, samples: 4096, codedFrames: 4, payloadBytes: 100 });
  validateAudioInputFacts(aac, limits);
  for (const change of [{ samples: 4095 }, { codedFrames: null }, { metadataFrames: 1 }, { gapless: { delaySamples: 1, paddingSamples: 0 } },
    { edit: { mediaTime: 1025, segmentDuration: 1, movieTimescale: 1 } }])
    assert.throws(() => validateAudioInputFacts({ ...aac, ...change }, limits), JSON.stringify(change));
});

// Construct the source samples and RIFF bytes without using a production writer.
function wave(samples = 44273, rate = 44100, channels = 1) {
  const b = Buffer.alloc(44 + samples * channels * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * channels * 2, 40);
  for (let i = 0; i < samples; i++) for (let c = 0; c < channels; c++)
    b.writeInt16LE(Math.round((c ? 9000 : 15000) * Math.sin(2 * Math.PI * (c ? 701 : 437) * i / rate)), 44 + (i * channels + c) * 2);
  return b;
}
let native: ReturnType<typeof audioInputRuntimeIdentity> | undefined;
function command(argv: string[]) {
  native ??= audioInputRuntimeIdentity();
  const r = spawnSync(native.tools.ffmpeg.executable, argv, { cwd: scratch, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: scratch },
    timeout: 30000, maxBuffer: 8388608 });
  assert.equal(r.status, 0, `${r.error?.message ?? ''}\n${r.stderr.toString()}`); return r.stdout;
}
let encoded: Record<string, { path: string; data: Buffer }> | undefined;
function media(run = command) {
  if (encoded) return encoded;
  const complete: NonNullable<typeof encoded> = {}, source = join(scratch, 'known.wav'); fs.writeFileSync(source, wave());
  for (const [name, encoder] of [['mp3', ['-c:a', 'libmp3lame', '-b:a', '128k']], ['flac', ['-c:a', 'flac']],
    ['m4a', ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '96k']]] as const) {
    const path = join(scratch, `known.${name}`);
    run(['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-f', 'wav', '-i', source, ...encoder, path]);
    complete[name] = { path, data: fs.readFileSync(path) };
  }
  complete.wav = { path: source, data: fs.readFileSync(source) }; encoded = complete; return encoded;
}
test('media fixture retries the original failure and publishes only a complete cache', () => {
  const previous = encoded, failure = Error('independent fixture encoder failure'); let calls = 0;
  const encode = (argv: string[]) => { calls++; if (argv.at(-1)!.endsWith('.flac')) throw failure; fs.writeFileSync(argv.at(-1)!, 'fixture bytes'); return Buffer.alloc(0); };
  try {
    encoded = undefined;
    assert.throws(() => media(encode), error => error === failure);
    assert.throws(() => media(encode), error => error === failure);
    assert.equal(calls, 4, 'both attempts must initialize again after the partial encode');
    const complete = media(argv => { calls++; fs.writeFileSync(argv.at(-1)!, 'complete fixture'); return Buffer.alloc(0); });
    assert.deepEqual(Object.keys(complete).sort(), ['flac', 'm4a', 'mp3', 'wav']);
    assert.equal(calls, 7); assert.equal(media(() => { throw Error('cache must be complete'); }), complete);
  } finally { encoded = previous; }
});
function reference(name: string, path: string, options: string[] = []) {
  return command(['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-format_whitelist', name === 'm4a' ? 'mov' : name,
    '-f', name === 'm4a' ? 'mov' : name, ...options, '-i', path, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ar', '44100', '-ac', '1',
    '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
}
function context(signal = new AbortController().signal) {
  const temporaryDir = fs.mkdtempSync(join(scratch, 'decoder-'));
  return { projectDir: scratch, temporaryDir, evidenceDir: temporaryDir, publishedDir: '', policy: structuredClone(INSPECT_POLICY_05),
    counts: emptyCatalogCounts(), tools: [], signal, check: () => signal.throwIfAborted() };
}

// This independent box walker locates mutation bytes; it does not parse admitted media facts.
interface Box { start: number; body: number; end: number; type: string }
function boxes(data: Buffer, start = 0, end = data.length): Box[] {
  const found: Box[] = [];
  while (start < end) {
    assert.ok(start + 8 <= end); const size = data.readUInt32BE(start);
    const length = size === 1 ? Number(data.readBigUInt64BE(start + 8)) : size === 0 ? end - start : size;
    const body = start + (size === 1 ? 16 : 8); assert.ok(Number.isSafeInteger(length) && body <= start + length && start + length <= end);
    found.push({ start, body, end: start + length, type: data.toString('latin1', start + 4, start + 8) }); start += length;
  }
  return found;
}
function chain(data: Buffer, names: string[]) {
  const result: Box[] = []; let start = 0, end = data.length;
  for (const name of names) { const b = boxes(data, start, end).find(b => b.type === name); assert.ok(b, names.join('/'));
    result.push(b); start = b.body + (name === 'dref' || name === 'stsd' ? 8 : 0); end = b.end; }
  return result;
}
function externalReference(data: Buffer, target: string) {
  const path = chain(data, ['moov', 'trak', 'mdia', 'minf', 'dinf', 'dref', 'url ']), old = path.at(-1)!;
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from(target + '\0')]), url = Buffer.alloc(8 + body.length);
  url.writeUInt32BE(url.length); url.write('url ', 4); body.copy(url, 8);
  const delta = url.length - (old.end - old.start), changed = Buffer.concat([data.subarray(0, old.start), url, data.subarray(old.end)]);
  for (const b of path.slice(0, -1)) changed.writeUInt32BE(b.end - b.start + delta, b.start); return changed;
}

// RFC 9639 sections 9.2/9.3: direct bit fixtures with independently known decoded samples.
function flacBits(kind: string) {
  const n = 3200, bits: number[] = [], stereo = kind === 'side-stereo';
  const put = (value: number, width: number) => { if (value < 0) value += 2 ** width;
    for (let p = width - 1; p >= 0; p--) bits.push(Math.floor(value / 2 ** p) & 1); };
  const expected = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) expected.writeInt16LE(kind === 'escape16' || kind === 'verbatim' ? i % 199 - 99 : kind === 'wasted' ? 64 : kind === 'escape0' || stereo ? 0 : 77, i * 2);
  if (kind === 'constant' || stereo) { put(0, 8); put(77, 16); if (stereo) { put(0, 8); put(154, 17); } }
  else if (kind === 'wasted') { put(1, 8); put(1, 6); put(1, 10); }
  else if (kind === 'verbatim') { put(2, 8); for (let i = 0; i < n; i++) put(expected.readInt16LE(i * 2), 16); }
  else if (kind === 'escape0' || kind === 'escape16') {
    put(16, 8); put(kind === 'escape0' ? 0 : 1, 2); put(0, 4); put(kind === 'escape0' ? 15 : 31, kind === 'escape0' ? 4 : 5);
    put(kind === 'escape0' ? 0 : 16, 5); if (kind === 'escape16') for (let i = 0; i < n; i++) put(expected.readInt16LE(i * 2), 16);
  } else {
    put(kind === 'fixed1' ? 18 : 64, 8); put(77, 16);
    if (kind === 'lpc1') { put(1, 4); put(0, 5); put(1, 2); }
    put(0, 2); put(0, 4); put(0, 4); for (let i = 1; i < n; i++) put(1, 1);
  }
  const paddingStart = bits.length; while (bits.length % 8) put(0, 1);
  const body = Buffer.alloc(bits.length / 8); for (let i = 0; i < bits.length; i++) body[i >>> 3]! |= bits[i]! << (7 - (i & 7));
  const crc = (bytes: Buffer, width: number, polynomial: number) => { let value = 0, mask = 2 ** width - 1;
    for (const byte of bytes) { value ^= byte << (width - 8); for (let bit = 0; bit < 8; bit++) value = value & 2 ** (width - 1) ? (value * 2 ^ polynomial) & mask : value * 2 & mask; } return value; };
  const header = Buffer.from([255, 248, 117, stereo ? 136 : 8, 0, (n - 1) >>> 8, (n - 1) & 255]);
  const framed = Buffer.concat([header, Buffer.from([crc(header, 8, 7)]), body]), footer = Buffer.alloc(2); footer.writeUInt16BE(crc(framed, 16, 0x8005));
  const info = Buffer.alloc(34); info.writeUInt16BE(n); info.writeUInt16BE(n, 2); info.writeUIntBE(framed.length + 2, 4, 3); info.writeUIntBE(framed.length + 2, 7, 3);
  info.writeBigUInt64BE((16000n << 44n) | (stereo ? 1n << 41n : 0n) | (15n << 36n) | BigInt(n), 10);
  const sourcePcm = stereo ? Buffer.alloc(n * 4) : expected;
  if (stereo) for (let i = 0; i < n; i++) { sourcePcm.writeInt16LE(77, i * 4); sourcePcm.writeInt16LE(-77, i * 4 + 2); }
  createHash('md5').update(sourcePcm).digest().copy(info, 18);
  const data = Buffer.concat([Buffer.from('fLaC'), Buffer.from([128, 0, 0, 34]), info, framed, footer]);
  return { data, expected, paddingOffset: paddingStart % 8 ? 42 + header.length + 1 + Math.floor(paddingStart / 8) : null,
    paddingMask: 1 << (7 - paddingStart % 8), fixCrc: (changed: Buffer) => changed.writeUInt16BE(crc(changed.subarray(42, -2), 16, 0x8005), changed.length - 2) };
}

test('independent full decode oracle records MP3 gapless and AAC edit separately from complete coded frames', async () => {
  const { preflightAudioInput } = await import('../src/adapters/audio-input.ts'); const files = media();
  for (const name of ['mp3', 'flac', 'm4a']) {
    const f = preflightAudioInput(files[name]!.data, limits), full = reference(name, files[name]!.path,
      name === 'mp3' ? ['-flags2', '+skip_manual'] : name === 'm4a' ? ['-ignore_editlist', '1'] : []);
    assert.equal(f.sampleDomain, 'complete-decoded-frames'); assert.equal(f.samples, full.length / 2);
    assert.equal(f.sampleRate, 44100); assert.equal(f.channels, 1);
    if (name === 'flac') { assert.equal(f.samples, 44273); assert.deepEqual(full, wave().subarray(44)); }
    else { assert.equal(f.samples, 46080); assert.ok(reference(name, files[name]!.path).length < full.length); }
  }
});

test('independent tail truncation rejects MP3 and M4A despite successful native prefix decoding', async () => {
  const { preflightAudioInput } = await import('../src/adapters/audio-input.ts'); const files = media();
  for (const name of ['mp3', 'm4a']) for (const cut of [1, 10, 100]) {
    const truncated = files[name]!.data.subarray(0, -cut), path = join(scratch, `cut-${cut}.${name}`); fs.writeFileSync(path, truncated);
    assert.deepEqual(reference(name, path), reference(name, files[name]!.path));
    assert.throws(() => preflightAudioInput(truncated, limits), `${name} tail ${cut}`);
  }
  assert.throws(() => preflightAudioInput(Buffer.concat([files.mp3!.data, Buffer.from('unclaimed payload')]), limits));
});

test('independent source and resample byte oracles cover every sample in all four admitted formats', async () => {
  const { preflightAudioInput, decodeAudioInput } = await import('../src/adapters/audio-input.ts'); const files = media();
  for (const name of ['wav', 'mp3', 'flac', 'm4a']) {
    const f = preflightAudioInput(files[name]!.data, limits), pcm = reference(name, files[name]!.path,
      name === 'mp3' ? ['-flags2', '+skip_manual'] : name === 'm4a' ? ['-ignore_editlist', '1'] : []);
    const pcmPath = join(scratch, `oracle-${name}.s16le`); fs.writeFileSync(pcmPath, pcm);
    const normalized = command(['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 's16le', '-ar', '44100', '-ac', '1',
      '-i', pcmPath, '-filter_threads', '1', '-af', 'aresample=16000:resampler=swr:dither_method=none:async=0', '-ar', '16000', '-ac', '1',
      '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
    const result = await decodeAudioInput(files[name]!.path, f, context(), native ??= audioInputRuntimeIdentity());
    assert.deepEqual(result.pcm, pcm, name); assert.deepEqual(result.wav.subarray(44), normalized, name);
    assert.equal(result.samples, normalized.length / 2); assert.equal(result.payloadBytes, normalized.length);
    assert.equal(result.facts.samples, pcm.length / 2); assert.equal(sha(fs.readFileSync(files[name]!.path)), sha(files[name]!.data));
    for (const run of Object.values(result.commands)) {
      assert.equal(run.exitCode, 0); assert.equal(run.signal, null); assert.equal(run.error, null);
      assert.ok(!run.argv.some(value => ['-ss', '-sseof', '-t', '-to', '-frames:a', '-aframes'].includes(value)));
    }
    const cancelled = new AbortController(); cancelled.abort(); const stopped = context(cancelled.signal);
    await assert.rejects(decodeAudioInput(files[name]!.path, f, stopped, native!)); assert.equal(stopped.tools.length, 0);
  }
});

test('independent M4A structural closure rejects external URL/file references, extra tracks, encrypted entries and edits', async () => {
  const { preflightAudioInput } = await import('../src/adapters/audio-input.ts'); const source = media().m4a!.data;
  for (const target of ['https://example.invalid/remote.aac', 'file:///outside/source.aac', '../relative.aac'])
    assert.throws(() => preflightAudioInput(externalReference(source, target), limits), target);
  const moov = chain(source, ['moov'])[0]!, trak = chain(source, ['moov', 'trak'])[1]!;
  const double = Buffer.concat([source.subarray(0, moov.end), source.subarray(trak.start, trak.end), source.subarray(moov.end)]);
  double.writeUInt32BE(moov.end - moov.start + trak.end - trak.start, moov.start);
  assert.throws(() => preflightAudioInput(double, limits));
  const encrypted = Buffer.from(source), entry = chain(source, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']).at(-1)!;
  encrypted.write('enca', entry.start + 4); assert.throws(() => preflightAudioInput(encrypted, limits));
  const ancestors = chain(source, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'mp4a']), sinf = Buffer.alloc(8);
  sinf.writeUInt32BE(8); sinf.write('sinf', 4);
  const protectedEntry = Buffer.concat([source.subarray(0, entry.end), sinf, source.subarray(entry.end)]);
  for (const box of ancestors) protectedEntry.writeUInt32BE(box.end - box.start + 8, box.start);
  assert.throws(() => preflightAudioInput(protectedEntry, limits));
  const foreignDescription = Buffer.from(source); foreignDescription.writeUInt16BE(2, entry.body + 6);
  assert.throws(() => preflightAudioInput(foreignDescription, limits));
  const foreignChunk = Buffer.from(source), chunk = chain(source, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']).at(-1)!;
  foreignChunk.writeUInt32BE(0, chunk.body + 8); assert.throws(() => preflightAudioInput(foreignChunk, limits));
  const foreignSize = Buffer.from(source), size = chain(source, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']).at(-1)!;
  assert.equal(foreignSize.readUInt32BE(size.body + 4), 0); foreignSize.writeUInt32BE(source.length, size.body + 12);
  assert.throws(() => preflightAudioInput(foreignSize, limits));
  const badEdit = Buffer.from(source), edit = chain(source, ['moov', 'trak', 'edts', 'elst']).at(-1)!;
  badEdit.writeInt16BE(2, edit.body + 16); assert.throws(() => preflightAudioInput(badEdit, limits));
});

test('independent complete decoder rejects corrupted FLAC CRC and exact quota one-past', async () => {
  const { preflightAudioInput, decodeAudioInput } = await import('../src/adapters/audio-input.ts'); const source = media().flac!.data;
  for (const zeros of [1, 2, 3, 8]) assert.throws(() => preflightAudioInput(Buffer.concat([source, Buffer.alloc(zeros)]), limits), `FLAC zero tail ${zeros}`);
  const damaged = Buffer.from(source); damaged[damaged.length - 1]! ^= 1;
  const path = join(scratch, 'crc.flac'); fs.writeFileSync(path, damaged);
  let f: AudioInputFacts | undefined;
  try { f = preflightAudioInput(damaged, limits); } catch (error) { assert.match(String(error), /AUDIO_INPUT/); }
  if (f) await assert.rejects(decodeAudioInput(path, f, context(), native ??= audioInputRuntimeIdentity()));
  const wrongTotal = Buffer.from(source), info = wrongTotal.readBigUInt64BE(18), mask = (1n << 36n) - 1n;
  wrongTotal.writeBigUInt64BE((info & ~mask) | ((info & mask) + 1n), 18);
  const wrongPath = join(scratch, 'wrong-total.flac'); fs.writeFileSync(wrongPath, wrongTotal); f = undefined;
  try { f = preflightAudioInput(wrongTotal, limits); } catch (error) { assert.match(String(error), /AUDIO_INPUT/); }
  if (f) await assert.rejects(decodeAudioInput(wrongPath, f, context(), native!));
  const complete = preflightAudioInput(source, limits);
  assert.throws(() => preflightAudioInput(source, { ...limits, maxSourceBytes: source.length - 1 }));
  assert.throws(() => preflightAudioInput(source, { ...limits, maxPcmBytes: complete.samples * 2 - 1 }));
  assert.equal(sha(fs.readFileSync(media().flac!.path)), sha(source));
});

test('independent FLAC bit fixtures fix constant verbatim wasted side-channel Rice escape fixed LPC and footer boundaries', async () => {
  const { preflightAudioInput, decodeAudioInput } = await import('../src/adapters/audio-input.ts');
  for (const kind of ['constant', 'verbatim', 'wasted', 'side-stereo', 'escape0', 'escape16', 'fixed1', 'lpc1']) {
    const f = flacBits(kind), path = join(scratch, `bits-${kind}.flac`); fs.writeFileSync(path, f.data);
    const facts = preflightAudioInput(f.data, limits); assert.equal(facts.samples, 3200); assert.equal(facts.codedFrames, 1);
    const decoded = await decodeAudioInput(path, facts, context(), native ??= audioInputRuntimeIdentity());
    assert.deepEqual(decoded.pcm, f.expected, kind); assert.deepEqual(decoded.wav.subarray(44), f.expected, kind);
    for (const count of [1, 2, 3, 8]) assert.throws(() => preflightAudioInput(Buffer.concat([f.data, Buffer.alloc(count)]), limits), `${kind} zero tail ${count}`);
    const short = f.data.subarray(0, -1); assert.throws(() => preflightAudioInput(short, limits), `${kind} truncated CRC`);
    if (f.paddingOffset !== null) {
      const padding = Buffer.from(f.data); padding[f.paddingOffset]! |= f.paddingMask; f.fixCrc(padding);
      assert.throws(() => preflightAudioInput(padding, limits), `${kind} nonzero alignment with repaired CRC`);
    }
  }
  const reserved = flacBits('constant'), changed = Buffer.from(reserved.data); changed[50] = 4; reserved.fixCrc(changed);
  assert.throws(() => preflightAudioInput(changed, limits), 'reserved subframe with repaired CRC');
});

test('independent catalog source oracle rejects coordinated PCM canonical maps runtime probe and command replacement', async () => {
  const { initProject } = await import('../src/project/scaffold.ts'), { importOriginals } = await import('../src/application/import.ts');
  const { catalogAssets, verifyCatalog } = await import('../src/application/catalog.ts');
  const root = fs.mkdtempSync(join(scratch, 'catalog-')), selected = join(root, 'selected'); fs.mkdirSync(selected);
  const dir = initProject({ slug: 'audio-security', projectsRoot: join(root, 'projects') }).dir;
  fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
  const source = wave(16007, 16000), sourcePath = join(root, 'independent.wav'); fs.writeFileSync(sourcePath, source);
  command(['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-f', 'wav', '-i', sourcePath, '-c:a', 'flac', '-f', 'flac', join(selected, 'renamed.data')]);
  const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(join(dir, 'inputs/inspect-policy.json'), bytes({ ...INSPECT_POLICY_05, asr: { ...INSPECT_POLICY_05.asr, enabled: true } }));
  const imported = await importOriginals(dir, selected), receipt = await catalogAssets(dir, { importId: imported.importId });
  const original = await verifyCatalog(dir, receipt.catalogId), asset = original.assets[0]!, descriptor = asset.technical.audioInput!;
  assert.equal(asset.technical.status, 'supported', asset.technical.reason); assert.equal(descriptor.status, 'completed');
  assert.equal(asset.technical.asr!.version, '0.2'); assert.ok(['completed', 'no-text'].includes(asset.technical.asr!.status));
  assert.equal(descriptor.audioEvidenceId, asset.technical.asr!.audioEvidenceId); assert.equal(asset.technical.evidence.length, 7);
  const entry = (value: any, kind: string) => value.technical.evidence.find((e: any) => e.kind === kind);
  assert.deepEqual(fs.readFileSync(join(dir, entry(asset, 'audio-pcm').path)), source.subarray(44));
  assert.deepEqual(fs.readFileSync(join(dir, entry(asset, 'audio-canonical').path)), source);
  const manifestPath = join(dir, receipt.manifestPath!), indexPath = join(dir, 'assets/catalog.json'), receiptPath = join(dir, 'runs', receipt.attemptId, 'receipt.json');
  const paths: Record<string, string> = Object.fromEntries(asset.technical.evidence.map(e => [e.kind, join(dir, e.path)]));
  Object.assign(paths, { manifest: manifestPath, index: indexPath, receipt: receiptPath });
  const frozen = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)]));
  const commonOriginal = JSON.parse(frozen['audio-input-map']!.toString()), asrOriginal = JSON.parse(frozen['asr-map']!.toString());
  const rejections: { mutation: string; error: string }[] = [];
  for (const mode of ['pcm-first', 'pcm-middle', 'pcm-last', 'probe-filename', 'input-payload', 'input-frame-count',
    'map-policy', 'map-extra-field', 'map-coverage', 'runtime-lock', 'runtime-file', 'command-seek', 'command-source',
    'command-attempt', 'command-time', 'cwd-relative', 'descriptor-audio', 'asr-shared-audio', 'asr-input-fact', 'asr-derived-text']) {
    const m = JSON.parse(frozen.manifest!.toString()), current = m.assets[0], map = structuredClone(commonOriginal), asr = structuredClone(asrOriginal);
    const data: Record<string, Buffer> = Object.fromEntries(asset.technical.evidence.map(e => [e.kind, Buffer.from(frozen[e.kind]!)]));
    if (mode.startsWith('pcm-')) {
      const position = mode === 'pcm-first' ? 0 : mode === 'pcm-last' ? data['audio-pcm']!.length - 2 : Math.floor(data['audio-pcm']!.length / 4) * 2;
      data['audio-pcm']![position]! ^= 1; data['audio-canonical']![44 + position]! ^= 1;
      assert.deepEqual(data['audio-pcm'], data['audio-canonical']!.subarray(44)); assert.notDeepEqual(data['audio-pcm'], source.subarray(44));
    }
    if (mode === 'probe-filename') {
      const probe = JSON.parse(data.probe!.toString()); probe.format.filename = join(dir, asset.source.fixedPath); data.probe = bytes(probe);
      current.technical.raw = data.probe.toString('utf8'); map.commands.probe.stdout = current.technical.raw; map.commands.probe.stdoutBytes = data.probe.length;
    }
    if (mode === 'input-payload') map.input.payloadBytes--;
    if (mode === 'input-frame-count') map.input.codedFrames++;
    if (mode === 'map-policy') map.policySha256 = sha('foreign policy');
    if (mode === 'map-extra-field') map.external = 'https://example.invalid/audio';
    if (mode === 'map-coverage') map.coverage.complete = false;
    if (mode === 'runtime-lock') map.runtime.lockSha256 = sha('foreign lock');
    if (mode === 'runtime-file') map.runtime.tools.ffmpeg.files[0].sha256 = sha('foreign native file');
    if (mode === 'command-seek') map.commands.decode.argv.splice(map.commands.decode.argv.indexOf('-i'), 0, '-ss', '0');
    if (mode === 'command-source') map.commands.decode.argv[map.commands.decode.argv.indexOf('-i') + 1] = join(dir, 'assets/originals/foreign.flac');
    if (mode === 'command-attempt') {
      const foreign = 'catalog-attempt-11111111-1111-4111-8111-111111111111';
      map.cwd = map.cwd.replace(receipt.attemptId, foreign);
      map.commands.normalize.argv = map.commands.normalize.argv.map((value: string) => value.replace(receipt.attemptId, foreign));
    }
    if (mode === 'command-time') map.commands.decode.elapsedMs = INSPECT_POLICY_05.audioInput.maxToolElapsedMs + 1001;
    if (mode === 'cwd-relative') map.cwd = 'out/.tmp/catalog-relative/audio-input-11111111-1111-4111-8111-111111111111';
    for (const [key, kind] of [['probe', 'probe'], ['sourcePcm', 'audio-pcm'], ['audio', 'audio-canonical']]) {
      map[key].bytes = data[kind]!.length; map[key].sha256 = sha(data[kind]!);
    }
    current.technical.audioInput.runtime = structuredClone(map.runtime);
    if (mode === 'descriptor-audio') current.technical.audioInput.audioEvidenceId = current.technical.audioInput.pcmEvidenceId;
    data['audio-input-map'] = bytes(map);
    asr.source.audioInputMapSha256 = sha(data['audio-input-map']); asr.source.input = structuredClone(map.input);
    asr.sourcePcm = structuredClone(map.sourcePcm); asr.audio = structuredClone(map.audio);
    asr.engine.lockSha256 = map.runtime.lockSha256; asr.engine.tools = structuredClone(map.runtime.tools);
    current.technical.asr.engine = structuredClone(asr.engine);
    if (mode === 'asr-shared-audio') { asr.audio.evidenceId = map.sourcePcm.evidenceId; current.technical.asr.audioEvidenceId = map.sourcePcm.evidenceId; }
    if (mode === 'asr-input-fact') asr.source.input.payloadBytes--;
    if (mode === 'asr-derived-text') {
      data.text = Buffer.from('independent forged suggestion'); asr.status = 'text';
      asr.text.bytes = data.text.length; asr.text.sha256 = sha(data.text);
      asr.segments = [{ id: 'asr-segment-0', ordinal: 0, rawIndex: 0, rawStartMs: 0, rawEndMs: 100,
        sampleStart: 0, sampleEnd: 1600, clippedEndSamples: 0, byteStart: 0, byteEnd: data.text.length }];
      current.technical.asr.status = 'completed'; current.technical.asr.segments = 1;
      current.technical.text = { bytes: data.text.length, lines: 1, bom: false, lineEndings: 'none' };
    }
    data['asr-map'] = bytes(asr);
    for (const e of current.technical.evidence) { e.bytes = data[e.kind]!.length; e.sha256 = sha(data[e.kind]!); }
    m.counts.derivedBytes += current.technical.evidence.reduce((total: number, e: any) => total + e.bytes - entry(asset, e.kind).bytes, 0);
    for (const role of ['probe', 'decode', 'normalize']) {
      const at = m.tools.findIndex((run: any) => JSON.stringify(run) === JSON.stringify(commonOriginal.commands[role])); assert.ok(at >= 0);
      m.tools[at] = structuredClone(map.commands[role]);
    }
    for (const [kind, value] of Object.entries(data)) fs.writeFileSync(paths[kind]!, value);
    fs.writeFileSync(manifestPath, bytes(m)); const index = JSON.parse(frozen.index!.toString());
    index.catalogs.find((value: any) => value.catalogId === receipt.catalogId).manifestSha256 = sha(fs.readFileSync(manifestPath)); fs.writeFileSync(indexPath, bytes(index));
    const runReceipt = JSON.parse(frozen.receipt!.toString()); Object.assign(runReceipt, { assets: m.assets, tools: m.tools, counts: m.counts, manifestSha256: sha(fs.readFileSync(manifestPath)) }); fs.writeFileSync(receiptPath, bytes(runReceipt));
    try {
      let error: unknown; try { await verifyCatalog(dir, receipt.catalogId); } catch (value) { error = value; }
      assert.ok(error, `coordinated replacement accepted: ${mode}`); assert.match(String(error), /AUDIO|ASR|MAP|COUNTS/, mode);
      if (mode.startsWith('pcm-') || mode === 'probe-filename') assert.match(String(error), /CATALOG_AUDIO_REPLAY_INVALID/, mode);
      if (mode === 'asr-derived-text') assert.match(String(error), /CATALOG_ASR_REPLAY_INVALID/, mode);
      rejections.push({ mutation: mode, error: String(error) });
    } finally { for (const [kind, path] of Object.entries(paths)) fs.writeFileSync(path, frozen[kind]!); }
    await verifyCatalog(dir, receipt.catalogId);
  }
  assert.equal(sha(fs.readFileSync(join(dir, asset.source.fixedPath))), asset.source.sha256);
  console.log(JSON.stringify({ kind: 'independent-coordinated-source-oracle', sourceSamples: 16007, format: 'flac', asrStatus: asset.technical.asr!.status,
    commonAudioEvidenceId: descriptor.audioEvidenceId, asrAudioEvidenceId: asset.technical.asr!.audioEvidenceId, rejections }));
});

test('independent ASR-disabled MP3 alignment uses full coded-frame canonical audio and survives project relocation', async () => {
  const { initProject } = await import('../src/project/scaffold.ts'), { importOriginals } = await import('../src/application/import.ts');
  const { catalogAssets, verifyCatalog } = await import('../src/application/catalog.ts');
  const { alignAsset, verifyAlignment } = await import('../src/application/alignment.ts');
  const { alignmentSubjectSha256 } = await import('../src/project/alignment.ts');
  const root = fs.mkdtempSync(join(scratch, 'align-')), dir = initProject({ slug: 'compressed-alignment', projectsRoot: join(root, 'projects') }).dir;
  const selected = join(root, 'selected'); fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
  fs.writeFileSync(join(selected, 'complete.mp3'), media().mp3!.data);
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  fs.writeFileSync(join(dir, 'inputs/inspect-policy.json'), json(INSPECT_POLICY_05));
  const imported = await importOriginals(dir, selected), catalogReceipt = await catalogAssets(dir, { importId: imported.importId });
  const catalog = await verifyCatalog(dir, catalogReceipt.catalogId), asset = catalog.assets[0]!, common = asset.technical.audioInput!;
  assert.equal(asset.technical.asr!.status, 'disabled'); assert.equal(common.status, 'completed');
  const pcm = reference('mp3', media().mp3!.path, ['-flags2', '+skip_manual']); assert.equal(pcm.length / 2, 46080);
  const originalPcm = asset.technical.evidence.find(e => e.kind === 'audio-pcm')!, audio = asset.technical.evidence.find(e => e.kind === 'audio-canonical')!;
  assert.deepEqual(fs.readFileSync(join(dir, originalPcm.path)), pcm);
  const pcmPath = join(root, 'reference.s16le'); fs.writeFileSync(pcmPath, pcm);
  const normalized = command(['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 's16le', '-ar', '44100', '-ac', '1', '-i', pcmPath,
    '-filter_threads', '1', '-af', 'aresample=16000:resampler=swr:dither_method=none:async=0', '-ar', '16000', '-ac', '1', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
  const expected = Buffer.concat([wave(normalized.length / 2, 16000).subarray(0, 44), normalized]);
  assert.deepEqual(fs.readFileSync(join(dir, audio.path)), expected);
  const approval = Buffer.from('Independent fictional test authorization for this synthetic tone transcript.'), subject = {
    version: '0.1', kind: 'alignment-script', language: 'en', lineId: 'independent-line', text: 'audio' };
  const subjectSha256 = sha(JSON.stringify(subject));
  fs.writeFileSync(join(dir, 'inputs/approval.txt'), approval); assert.equal(alignmentSubjectSha256(subject as any), subjectSha256);
  fs.writeFileSync(join(dir, 'inputs/script.json'), json({ ...subject, approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'independent-synthetic-fixture',
    subjectSha256, sourceRef: { path: 'inputs/approval.txt', bytes: approval.length, sha256: sha(approval) } } }));
  const selection = { catalogId: catalog.catalogId, assetId: asset.assetId, assetVersion: asset.assetVersion, scriptPath: 'inputs/script.json' };
  await assert.rejects(alignAsset(dir, selection), /ALIGNMENT_FORMAT_UNSUPPORTED/);
  fs.writeFileSync(join(dir, 'inputs/alignment-policy.json'), json(ALIGNMENT_POLICY_02));
  // A bounded synthetic token response exercises reuse independently of recognition of a tone.
  const spawn = childProcess.spawn, submitted: Buffer[] = [];
  let receipt: Awaited<ReturnType<typeof alignAsset>>;
  try {
    childProcess.spawn = ((executable: string, argv: string[], options: any) => {
      if (!String(executable).endsWith('/assets/asr/bin/whisper-cli')) return spawn(executable, argv, options);
      submitted.push(fs.readFileSync(argv[argv.indexOf('-f') + 1]!));
      const stamps = { from: '00:00:00,000', to: '00:00:00,100' }, offsets = { from: 0, to: 100 };
      const raw = { systeminfo: 'C independent bounded token fixture', model: { type: 'base', multilingual: true, vocab: 51865,
        audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
        params: { model: argv[argv.indexOf('-m') + 1], language: 'en', translate: false }, result: { language: 'en' },
        transcription: [{ timestamps: stamps, offsets, text: ' audio', tokens: [{ text: ' audio', id: 100, p: 0.75, t_dtw: -1, timestamps: stamps, offsets }] }] };
      return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(raw))})`], options);
    }) as typeof spawn; syncBuiltinESMExports(); receipt = await alignAsset(dir, selection);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
  assert.equal(submitted.length, 1); assert.deepEqual(submitted[0], expected);
  const alignment = await verifyAlignment(dir, receipt!.alignmentId);
  assert.equal(alignment.version, '0.2'); assert.equal(alignment.audio.samples, normalized.length / 2);
  assert.deepEqual(fs.readFileSync(join(dir, alignment.audio.path)), expected);
  assert.equal((alignment.source as any).input.samples, 46080); assert.equal((alignment.source as any).input.sampleDomain, 'complete-decoded-frames');
  assert.equal((alignment.source as any).audioEvidenceId, common.audioEvidenceId);
  const map = JSON.parse(fs.readFileSync(join(dir, alignment.map.path), 'utf8')); assert.equal(map.coverage.listening, 'unverified');
  const moved = join(root, 'relocated'); fs.renameSync(dir, moved);
  assert.deepEqual(await verifyCatalog(moved, catalog.catalogId), catalog); assert.deepEqual(await verifyAlignment(moved, receipt.alignmentId), alignment);
  fs.writeFileSync(join(moved, 'inputs/inspect-policy.json'), json(DEFAULT_INSPECT_POLICY));
  const inherited = await catalogAssets(moved, { importId: imported.importId }), latest = await verifyCatalog(moved, inherited.catalogId);
  assert.equal(inherited.policy!.version, '0.4'); assert.equal(inherited.version, '0.5'); assert.equal(latest.version, '0.5'); assert.deepEqual(latest.assets, catalog.assets);
  assert.deepEqual(await verifyAlignment(moved, receipt.alignmentId), alignment);
  console.log(JSON.stringify({ kind: 'independent-compressed-alignment-relocation', format: 'mp3', inputSamples: 46080,
    canonicalSamples: normalized.length / 2, asr: 'disabled', alignment: '0.2', tokenProvider: 'independent bounded synthetic fixture',
    currentSourcePolicy: inherited.policy!.version, envelope: inherited.version, listening: 'unverified' }));
});


// Independent complete PNG with its own pixel vector and CRC; evidence identity alone cannot bind it to audio.
function unrelatedPng() {
  const crc = (data: Buffer) => { let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]), bytes = Buffer.alloc(body.length + 8);
    bytes.writeUInt32BE(data.length); body.copy(bytes, 4); bytes.writeUInt32BE(crc(body), bytes.length - 4); return bytes;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 71, 89, 113, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('independent completed audio transaction rejects coordinated listed PNG extras in four and seven evidence groups', async () => {
  const { initProject } = await import('../src/project/scaffold.ts'), { importOriginals } = await import('../src/application/import.ts');
  const { catalogAssets, verifyCatalog } = await import('../src/application/catalog.ts'), { assertCatalog } = await import('../src/project/catalog.ts');
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const observations: { asrEnabled: boolean; kind: string; error: string }[] = [];
  for (const asrEnabled of [false, true]) {
    const root = fs.mkdtempSync(join(scratch, 'group-')), dir = initProject({ slug: 'group-security', projectsRoot: join(root, 'projects') }).dir;
    const selected = join(root, 'selected'); fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
    const source = wave(16007, 16000); fs.writeFileSync(join(selected, 'independent.wav'), source);
    fs.writeFileSync(join(dir, 'inputs/inspect-policy.json'), bytes({ ...INSPECT_POLICY_05, asr: { ...INSPECT_POLICY_05.asr, enabled: asrEnabled } }));
    const imported = await importOriginals(dir, selected), receipt = await catalogAssets(dir, { importId: imported.importId });
    const baseline = await verifyCatalog(dir, receipt.catalogId), asset = baseline.assets[0]!;
    assert.equal(asset.technical.audioInput!.status, 'completed'); assert.equal(asset.technical.evidence.length, asrEnabled ? 7 : 4);
    assert.ok(asrEnabled ? ['completed', 'no-text'].includes(asset.technical.asr!.status) : asset.technical.asr!.status === 'disabled');
    const manifestPath = join(dir, receipt.manifestPath!), indexPath = join(dir, 'assets/catalog.json'), receiptPath = join(dir, 'runs', receipt.attemptId, 'receipt.json');
    const frozen = { manifest: fs.readFileSync(manifestPath), index: fs.readFileSync(indexPath), receipt: fs.readFileSync(receiptPath) };
    for (const kind of ['preview', 'frame'] as const) {
      const manifest = JSON.parse(frozen.manifest.toString()), extra = structuredClone(asset.technical.evidence.find(e => e.kind === 'probe')!);
      Object.assign(extra, { id: `evidence-${randomUUID()}`, kind, width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, transform: 'C independent unrelated synthetic PNG' });
      extra.path = `assets/derived/inspection/${asset.inspectionId}/${extra.id}.png`; const body = unrelatedPng(); extra.bytes = body.length; extra.sha256 = sha(body);
      const extraPath = join(dir, extra.path); fs.writeFileSync(extraPath, body); manifest.assets[0].technical.evidence.push(extra); manifest.counts.derivedBytes += body.length;
      assertCatalog('manifest', manifest); fs.writeFileSync(manifestPath, bytes(manifest));
      const index = JSON.parse(frozen.index.toString()); index.catalogs.find((e: any) => e.catalogId === receipt.catalogId).manifestSha256 = sha(fs.readFileSync(manifestPath)); fs.writeFileSync(indexPath, bytes(index));
      const changedReceipt = JSON.parse(frozen.receipt.toString()); Object.assign(changedReceipt, { assets: manifest.assets, counts: manifest.counts, manifestSha256: sha(fs.readFileSync(manifestPath)) }); fs.writeFileSync(receiptPath, bytes(changedReceipt));
      try {
        let error: unknown; try { await verifyCatalog(dir, receipt.catalogId); } catch (value) { error = value; }
        assert.ok(error, `listed ${kind} accepted in completed ${asrEnabled ? 7 : 4} evidence group`); assert.match(String(error), /CATALOG_(AUDIO|ASR)/);
        observations.push({ asrEnabled, kind, error: String(error) });
      } finally {
        fs.unlinkSync(extraPath); fs.writeFileSync(manifestPath, frozen.manifest); fs.writeFileSync(indexPath, frozen.index); fs.writeFileSync(receiptPath, frozen.receipt);
      }
      assert.deepEqual(await verifyCatalog(dir, receipt.catalogId), baseline); assert.deepEqual(fs.readFileSync(join(dir, asset.source.fixedPath)), source);
    }
  }
  console.log(JSON.stringify({ kind: 'independent-completed-audio-group-closure', png: 'C handwritten complete 1x1 RGBA with CRC', observations }));
});

test('independent one byte aggregate decode budget fails the attempt and preserves the committed catalog index', async () => {
  const { initProject } = await import('../src/project/scaffold.ts'), { importOriginals } = await import('../src/application/import.ts');
  const { catalogAssets, verifyCatalog } = await import('../src/application/catalog.ts'), { assertCatalog } = await import('../src/project/catalog.ts');
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const root = fs.mkdtempSync(join(scratch, 'aggregate-')), dir = initProject({ slug: 'aggregate-security', projectsRoot: join(root, 'projects') }).dir;
  const selected = join(root, 'selected'); fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
  fs.writeFileSync(join(selected, 'first.wav'), wave(6007, 16000)); fs.writeFileSync(join(dir, 'inputs/inspect-policy.json'), bytes(INSPECT_POLICY_05));
  const imported = await importOriginals(dir, selected), receipt = await catalogAssets(dir, { importId: imported.importId }); await verifyCatalog(dir, receipt.catalogId);
  const indexPath = join(dir, 'assets/catalog.json'), before = fs.readFileSync(indexPath), fresh = join(root, 'fresh'); fs.mkdirSync(fresh);
  fs.writeFileSync(join(fresh, 'new.wav'), wave(6011, 16000)); const newImport = await importOriginals(dir, fresh);
  fs.writeFileSync(join(dir, 'inputs/inspect-policy.json'), bytes({ ...INSPECT_POLICY_05, maxDecodedAudioBytes: 1 }));
  let failure: any; try { await catalogAssets(dir, { importId: newImport.importId }); } catch (error) { failure = error; }
  assert.ok(failure); assert.match(String(failure), /CATALOG_DECODED_AUDIO_LIMIT/); const failed = failure.receipt; assertCatalog('receipt', failed);
  assert.equal(failed.indexCommitted, false); assert.equal(failed.status, 'failed'); assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.ok(failed.tools.some((run: any) => run.version.endsWith('/audio-input@0.1/decode') && run.error === 'CATALOG_DECODED_AUDIO_LIMIT'));
  assert.equal(failed.counts.derivedBytes, 0); assert.equal(fs.existsSync(join(dir, 'assets/catalogs', failed.catalogId)), false);
  console.log(JSON.stringify({ kind: 'independent-global-one-byte-audio-quota', error: String(failure), indexCommitted: failed.indexCommitted,
    oldIndexUnchanged: true, tools: failed.tools.map((run: any) => ({ version: run.version, error: run.error, binaryBytes: run.binaryBytes })) }));
});
