import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { INSPECT_POLICY_05, DEFAULT_INSPECT_POLICY, assertCatalog } from '../src/project/catalog.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => fs.writeFileSync(path, importJsonText(value));
const evidence = (asset: any, kind: string) => asset.technical.evidence.find((e: any) => e.kind === kind);
function wave(samples = 3200, rate = 16000) {
  const b = Buffer.alloc(44 + samples * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(i % 199 - 99, 44 + i * 2); return b;
}
function onePixelPng() {
  const chunk = (kind: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(kind, 4); data.copy(b, 8);
    let crc = -1; for (const byte of b.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1; }
    b.writeUInt32BE((crc ^ -1) >>> 0, b.length - 4); return b;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 17, 61, 103, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(out, 'catalog-audio-'))), dir = initProject({ slug: 'bounded-audio', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected');
  fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true }); fs.writeFileSync(join(selected, 'source.wav'), wave());
  policy(dir); return { root, dir, selected, import() { return importOriginals(this.dir, this.selected); }, clean() { fs.rmSync(this.root, { recursive: true, force: true }); } };
}
function policy(dir: string, audioInput = {}, asr = {}, common = {}) { save(join(dir, 'inputs/inspect-policy.json'), { ...structuredClone(INSPECT_POLICY_05), ...common,
  audioInput: { ...INSPECT_POLICY_05.audioInput, ...audioInput }, asr: { ...INSPECT_POLICY_05.asr, ...asr } }); }
function encode(args: string[]) { const run = childProcess.spawnSync('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr); }
function providerJson(model: string, language: string, empty = false) {
  return { systeminfo: 'bounded synthetic provider', model: { type: 'base', multilingual: true, vocab: 51865, audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model, language, translate: false }, result: { language }, transcription: empty ? [] : [
      { timestamps: { from: '00:00:00,000', to: '00:00:00,100' }, offsets: { from: 0, to: 100 }, text: ' 中文' },
      { timestamps: { from: '00:00:00,100', to: '00:00:00,210' }, offsets: { from: 100, to: 210 }, text: '🙂e\u0301' }] };
}
async function synthetic<T>(action: () => Promise<T>, options: { empty?: boolean; code?: string; before?: () => void } = {}) {
  const spawn = childProcess.spawn, calls: any[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: string[], settings: any) => {
      if (String(executable).endsWith('/assets/asr/bin/whisper-cli')) {
        const raw = providerJson(argv[argv.indexOf('-m') + 1]!, argv[argv.indexOf('-l') + 1]!, options.empty), audio = argv[argv.indexOf('-f') + 1]!;
        calls.push({ argv: [...argv], audio, wav: fs.readFileSync(audio), files: fs.readdirSync(settings.cwd) }); options.before?.();
        return spawn(process.execPath, ['-e', options.code ?? `process.stdout.write(${JSON.stringify(JSON.stringify(raw))})`], settings);
      }
      return spawn(executable, argv, settings);
    }) as typeof spawn; syncBuiltinESMExports(); return { value: await action(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
async function failed(dir: string, selection: any, options = {}) {
  let failure: any; try { await catalogAssets(dir, selection, options); } catch (error) { failure = error; }
  assert.ok(failure instanceof CatalogFailure, String(failure)); assertCatalog('receipt', failure.receipt); return failure.receipt;
}
test('catalog common containers preserve originals and publish complete decoded-frame oracles with ASR disabled', async () => {
  const f = fixture(); try {
    for (const extension of ['mp3', 'flac', 'm4a']) encode(['-i', join(f.selected, 'source.wav'), join(f.selected, `source.${extension}`)]);
    const originals = Object.fromEntries(fs.readdirSync(f.selected).map(name => [name, fs.readFileSync(join(f.selected, name))])), imp = await f.import(), receipt = await catalogAssets(f.dir, { importId: imp.importId });
    const m = await verifyCatalog(f.dir, receipt.catalogId); assert.equal(m.version, '0.5'); assert.equal(m.assets.length, 4); assert.equal(m.tools.length, 12);
    for (const a of m.assets) {
      assert.equal(a.technical.status, 'supported', a.technical.reason); assert.equal(a.technical.asr!.status, 'disabled'); assert.equal(a.technical.audioInput!.status, 'completed');
      assert.equal(a.technical.evidence.length, 4); const map = json(join(f.dir, evidence(a, 'audio-input-map').path));
      assert.equal(map.input.sampleDomain, 'complete-decoded-frames'); assert.equal(map.coverage.end, map.input.samples); assert.equal(map.coverage.presentationMapping, 'unknown');
      assert.equal(evidence(a, 'audio-pcm').bytes, map.input.samples * 2); assert.equal(evidence(a, 'audio-canonical').bytes, 44 + map.audio.samples * 2);
      assert.deepEqual(fs.readFileSync(join(f.dir, a.source.fixedPath)), originals[a.source.path]);
      assert.equal(fs.existsSync(map.cwd), false); assert.equal(map.commands.decode.binaryBytes, map.sourcePcm.bytes); assert.equal(map.commands.normalize.binaryBytes, map.audio.payloadBytes);
      if (a.technical.format === 'wav') assert.deepEqual(fs.readFileSync(join(f.dir, evidence(a, 'audio-pcm').path)), wave().subarray(44));
    }
    assert.equal(receipt.counts.derivedBytes, m.assets.flatMap(a => a.technical.evidence).reduce((n, e) => n + e.bytes, 0));
  } finally { f.clean(); }
});
test('ASR 0.2 reuses the one canonical WAV and binds the common map and raw JSON replay', async () => {
  const f = fixture(); try {
    policy(f.dir, {}, { enabled: true }); const imp = await f.import(), { value: r, calls } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!;
    assert.equal(a.technical.asr!.version, '0.2'); assert.equal(a.technical.asr!.status, 'completed'); assert.equal(calls.length, 1); assert.deepEqual(calls[0].files, []);
    assert.equal(a.technical.evidence.length, 7); assert.equal(a.technical.evidence.filter(e => e.path.endsWith('.wav')).length, 1); assert.equal(a.technical.asr!.audioEvidenceId, a.technical.audioInput!.audioEvidenceId);
    const map = json(join(f.dir, evidence(a, 'asr-map').path)), audioMap = evidence(a, 'audio-input-map');
    assert.equal(map.source.audioInputMapEvidenceId, audioMap.id); assert.equal(map.source.audioInputMapSha256, audioMap.sha256); assert.deepEqual(calls[0].wav, wave());
    assert.equal(r.counts.decodedAudioBytes, 12800); assert.equal(r.counts.derivedBytes, a.technical.evidence.reduce((n, e) => n + e.bytes, 0));
    const paths = { map: join(f.dir, evidence(a, 'asr-map').path), manifest: join(f.dir, r.manifestPath!), index: join(f.dir, 'assets/catalog.json') },
      bytes = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)]));
    for (const mode of ['source', 'map-id', 'map-sha', 'input', 'pcm', 'audio']) {
      const changed = JSON.parse(bytes.map!.toString()), manifest = JSON.parse(bytes.manifest!.toString());
      if (mode === 'source') changed.source.sha256 = hash('foreign original');
      else if (mode === 'map-id') changed.source.audioInputMapEvidenceId = `evidence-${randomUUID()}`;
      else if (mode === 'map-sha') changed.source.audioInputMapSha256 = hash('foreign common map');
      else if (mode === 'input') changed.source.input.sampleRate = 8000;
      else changed[mode === 'pcm' ? 'sourcePcm' : 'audio'].evidenceId = `evidence-${randomUUID()}`;
      save(paths.map, changed); const data = fs.readFileSync(paths.map), entry = evidence(manifest.assets[0], 'asr-map');
      manifest.counts.derivedBytes += data.length - entry.bytes; entry.bytes = data.length; entry.sha256 = hash(data); save(paths.manifest, manifest);
      const idx = JSON.parse(bytes.index!.toString()); idx.catalogs.find((entry: any) => entry.catalogId === r.catalogId).manifestSha256 = hash(fs.readFileSync(paths.manifest)); save(paths.index, idx);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId), /ASR|AUDIO/); } finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, bytes[key]!); }
    }
    await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('ASR 0.5 observations enforce full and partial UTF8 segments and preserve old observations through policy downgrade', async () => {
  const f = fixture(); try {
    policy(f.dir, {}, { enabled: true }); const imp = await f.import(), { value: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!, d = a.technical.asr!;
    const record = { version: '0.5', id: `observation-${randomUUID()}`, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256, method: 'read fixed suggestion segment',
      locator: { kind: 'asr', evidenceId: d.textEvidenceId, mapEvidenceId: d.mapEvidenceId, audioEvidenceId: d.audioEvidenceId, segmentId: 'asr-segment-0', byteStart: 0, byteEnd: 7 },
      coverageScope: 'segment-asr-text', coverage: 'full', statement: 'Only this segment was read.', basis: 'estimated', confidence: null, limitations: ['Listening is pending.'], evidenceRefs: [d.textEvidenceId, d.mapEvidenceId, d.audioEvidenceId] };
    save(join(f.dir, 'inputs/observation.json'), record); const full = await catalogAssets(f.dir, { observation: 'inputs/observation.json' });
    const partial = { ...record, id: `observation-${randomUUID()}`, coverage: 'partial', locator: { ...record.locator, byteStart: 1, byteEnd: 4 } };
    save(join(f.dir, 'inputs/observation.json'), partial); const second = await catalogAssets(f.dir, { observation: 'inputs/observation.json' }), before = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const change of [{ version: '0.4' }, { confidence: 0.7 }, { basis: 'observed' }, { coverage: 'full' }, { locator: { ...partial.locator, byteStart: 2 } }, { locator: { ...partial.locator, audioEvidenceId: partial.locator.evidenceId } }]) {
      save(join(f.dir, 'inputs/observation.json'), { ...partial, id: `observation-${randomUUID()}`, ...change }); await failed(f.dir, { observation: 'inputs/observation.json' }); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
    save(join(f.dir, 'inputs/inspect-policy.json'), DEFAULT_INSPECT_POLICY); const inherited = await catalogAssets(f.dir, { importId: imp.importId }), m = await verifyCatalog(f.dir, inherited.catalogId);
    assert.equal(inherited.version, '0.5'); assert.equal(m.version, '0.5'); assert.equal(m.policy.version, '0.4'); assert.equal(m.observations.length, 2); assert.deepEqual(m.assets, (await verifyCatalog(f.dir, r.catalogId)).assets);
    await verifyCatalog(f.dir, full.catalogId); await verifyCatalog(f.dir, second.catalogId);
  } finally { f.clean(); }
});
for (const empty of [true, false]) test(`ASR ${empty ? 'empty output' : 'provider failure'} retains the complete common audio group`, async () => {
  const f = fixture(); try {
    policy(f.dir, {}, { enabled: true }); const imp = await f.import(), { value: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }), empty ? { empty } : { code: 'process.stdout.write("partial");process.exit(7)' });
    const a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!; assert.equal(a.technical.audioInput!.status, 'completed'); assert.equal(a.technical.asr!.status, empty ? 'no-text' : 'failed');
    assert.equal(a.technical.evidence.length, empty ? 7 : 4); assert.equal(a.technical.evidence.filter(e => e.path.endsWith('.wav')).length, 1);
    assert.ok(r.counts.decodedAudioBytes === 12800); if (!empty) assert.equal(a.technical.asr!.audioEvidenceId, null);
  } finally { f.clean(); }
});
test('disabled ASR common decoding and verification consume no bundled model or program identity', async () => {
  const f = fixture(), lstat = fs.lstatSync; try {
    fs.lstatSync = ((path: any, ...args: any[]) => { if (/\/assets\/asr\/(?:models\/ggml-base.bin|bin\/whisper-cli)$/.test(String(path))) throw Error('fictional absent speech model'); return (lstat as any)(path, ...args); }) as typeof lstat; syncBuiltinESMExports();
    const imp = await f.import(), r = await catalogAssets(f.dir, { importId: imp.importId }), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!; assert.equal(a.technical.audioInput!.status, 'completed'); assert.equal(a.technical.asr!.status, 'disabled');
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); f.clean(); }
});
test('common replay rejects coordinated PCM/canonical/probe/map/runtime/command replacement after outer rehash', async () => {
  const f = fixture(); try {
    const imp = await f.import(), r = await catalogAssets(f.dir, { importId: imp.importId }), m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!;
    const paths = Object.fromEntries(['audio-pcm', 'audio-canonical', 'probe', 'audio-input-map'].map(kind => [kind, join(f.dir, evidence(a, kind).path)]));
    paths.manifest = join(f.dir, r.manifestPath!); paths.index = join(f.dir, 'assets/catalog.json'); const bytes = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)]));
    for (const mode of ['samples', 'probe', 'facts', 'runtime', 'cwd', 'command', 'policy']) {
      const map = JSON.parse(bytes['audio-input-map']!.toString()), manifest = JSON.parse(bytes.manifest!.toString()), current = manifest.assets[0];
      if (mode === 'samples') {
        const pcm = Buffer.from(bytes['audio-pcm']!), wav = Buffer.from(bytes['audio-canonical']!); pcm[0] ^= 1; wav[44] ^= 1;
        fs.writeFileSync(paths['audio-pcm']!, pcm); fs.writeFileSync(paths['audio-canonical']!, wav); map.sourcePcm.sha256 = hash(pcm); map.audio.sha256 = hash(wav);
      } else if (mode === 'probe') {
        const probe = JSON.parse(bytes.probe!.toString()); probe.format.duration = '900.0'; const data = Buffer.from(JSON.stringify(probe, null, 4)); fs.writeFileSync(paths.probe!, data);
        map.probe.bytes = data.length; map.probe.sha256 = hash(data); map.commands.probe.stdout = data.toString('utf8'); map.commands.probe.stdoutBytes = data.length;
        current.technical.containerDuration = 900; current.technical.raw = data.toString('utf8');
      } else if (mode === 'facts') map.input.payloadBytes++;
      else if (mode === 'runtime') { map.runtime.lockSha256 = hash('other lock'); current.technical.audioInput.runtime = map.runtime; }
      else if (mode === 'cwd') map.cwd = map.cwd.replace(/audio-input-[a-f0-9-]+$/, `audio-input-${randomUUID()}`);
      else if (mode === 'command') map.commands.decode.argv[0] = '-foreign-option';
      else map.policySha256 = hash('other policy');
      save(paths['audio-input-map']!, map);
      for (const kind of ['audio-pcm', 'audio-canonical', 'probe', 'audio-input-map']) { const entry = evidence(current, kind), data = fs.readFileSync(paths[kind]!); entry.bytes = data.length; entry.sha256 = hash(data); }
      if (mode === 'probe' || mode === 'command') manifest.tools = manifest.tools.map((run: any) => run.version.endsWith(`/audio-input@0.1/${mode === 'probe' ? 'probe' : 'decode'}`) ? map.commands[mode === 'probe' ? 'probe' : 'decode'] : run);
      save(paths.manifest!, manifest); const idx = JSON.parse(bytes.index!.toString()); idx.catalogs.find((entry: any) => entry.catalogId === r.catalogId).manifestSha256 = hash(fs.readFileSync(paths.manifest!)); save(paths.index!, idx);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId), /AUDIO|COUNTS|EVIDENCE/); } finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, bytes[key]!); }
    }
    await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('completed common groups reject listed legitimate preview and frame images after coordinated outer rehash', async () => {
  const f = fixture(); try {
    const imp = await f.import(), r = await catalogAssets(f.dir, { importId: imp.importId }), m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!;
    const paths = { manifest: join(f.dir, r.manifestPath!), index: join(f.dir, 'assets/catalog.json'), receipt: join(f.dir, 'runs', r.attemptId, 'receipt.json') },
      bytes = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)])), png = onePixelPng(), original = fs.readFileSync(join(f.dir, a.source.fixedPath));
    for (const kind of ['preview', 'frame']) {
      const id = `evidence-${randomUUID()}`, path = `${evidence(a, 'probe').path.slice(0, evidence(a, 'probe').path.lastIndexOf('/'))}/${id}.png`, target = join(f.dir, path);
      fs.writeFileSync(target, png); encode(['-i', target, '-f', 'null', '-']);
      const extra = { ...evidence(a, 'probe'), id, kind, path, bytes: png.length, sha256: hash(png), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, transform: 'Independent unrelated one-pixel PNG' },
        manifest = JSON.parse(bytes.manifest!.toString()), receipt = JSON.parse(bytes.receipt!.toString()), idx = JSON.parse(bytes.index!.toString());
      manifest.assets[0].technical.evidence.push(extra); manifest.counts.derivedBytes += png.length; save(paths.manifest, manifest);
      receipt.assets[0].technical.evidence.push(extra); receipt.counts.derivedBytes += png.length; receipt.manifestSha256 = hash(fs.readFileSync(paths.manifest)); save(paths.receipt, receipt);
      idx.catalogs.find((entry: any) => entry.catalogId === r.catalogId).manifestSha256 = receipt.manifestSha256; save(paths.index, idx);
      assertCatalog('manifest', manifest); assertCatalog('receipt', receipt); assertCatalog('index', idx);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId), /CATALOG_AUDIO_GROUP_INVALID/); }
      finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, bytes[key]!); fs.unlinkSync(target); }
      assert.deepEqual(fs.readFileSync(join(f.dir, a.source.fixedPath)), original);
    }
    await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('common count and aggregate quotas preserve the prior catalog index including refused fifth candidates', async () => {
  const f = fixture(); try {
    const imp = await f.import(), first = await catalogAssets(f.dir, { importId: imp.importId }), before = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const common of [{ maxDerivedBytes: 1 }, { maxDecodedAudioBytes: 1 }, { maxDecodedAudioBytes: 12799 }, { maxCatalogBytes: 1 }, { maxElapsedMs: 1 }]) {
      policy(f.dir, {}, {}, common); const fresh = await f.import(), receipt = await failed(f.dir, { importId: fresh.importId });
      if (common.maxDecodedAudioBytes === 1) { assert.match(receipt.error!, /CATALOG_DECODED_AUDIO_LIMIT/); assert.equal(receipt.indexCommitted, false); }
      assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
    policy(f.dir, { maxSourceBytes: 1 }); for (let i = 1; i < 5; i++) fs.writeFileSync(join(f.selected, `${i}.wav`), wave());
    const fresh = await f.import(), refused = await failed(f.dir, { importId: fresh.importId }); assert.match(refused.error!, /AUDIO_COUNT_LIMIT/); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    policy(f.dir); for (const name of fs.readdirSync(f.selected)) fs.unlinkSync(join(f.selected, name));
    for (let i = 0; i < 5; i++) fs.writeFileSync(join(f.selected, `${i}.m4a`), 'bounded malformed container');
    const bad = await f.import(); assert.match((await failed(f.dir, { importId: bad.importId })).error!, /AUDIO_COUNT_LIMIT/); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    await verifyCatalog(f.dir, first.catalogId);
  } finally { f.clean(); }
});
test('common verification reports every extra decoder source and PCM read through onRead and respects caller quotas', async () => {
  const f = fixture(); try {
    const imp = await f.import(), r = await catalogAssets(f.dir, { importId: imp.importId }); let bytes = 0;
    await verifyCatalog(f.dir, r.catalogId, { onRead(n) { bytes += n; } });
    const baseline = bytes, sourceBytes = wave().length; assert.ok(bytes > sourceBytes * 7 + 6400 * 2, String(bytes));
    let consumed = 0; await assert.rejects(verifyCatalog(f.dir, r.catalogId, { onRead(n) { consumed += n; if (consumed > baseline - sourceBytes * 2) throw Error('fictional read quota'); } }), /fictional read quota/);
    assert.deepEqual(fs.readdirSync(join(f.dir, 'out/.tmp')).filter(name => name.startsWith('audio-verify-')), []);
  } finally { f.clean(); }
});
test('common cancellation and before/after-effect publication faults keep durable index facts', async () => {
  const f = fixture(), rename = fsPromises.rename; try {
    const imp = await f.import(), first = await catalogAssets(f.dir, { importId: imp.importId }), before = fs.readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const controller = new AbortController(); controller.abort(); assert.equal((await failed(f.dir, { importId: fresh.importId }, { signal: controller.signal })).status, 'interrupted'); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    fsPromises.rename = async (src, dst) => { if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(Error('fictional before effect'), { code: 'EIO' }); await rename(src, dst); }; syncBuiltinESMExports();
    await failed(f.dir, { importId: fresh.importId }); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    fsPromises.rename = async (src, dst) => { await rename(src, dst); if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(Error('fictional after effect'), { code: 'EIO' }); }; syncBuiltinESMExports();
    const current = await catalogAssets(f.dir, { importId: fresh.importId }).catch((error: any) => error.receipt); assert.equal(current.status, 'succeeded'); assert.equal(current.indexCommitted, true);
    fsPromises.rename = rename; syncBuiltinESMExports(); await verifyCatalog(f.dir, current.catalogId); await verifyCatalog(f.dir, first.catalogId);
  } finally { fsPromises.rename = rename; syncBuiltinESMExports(); f.clean(); }
});
test('common historical source commands survive relocation and a new attempt uses the moved root', async () => {
  const f = fixture(), moved = f.root + ' moved'; try {
    const imp = await f.import(), first = await catalogAssets(f.dir, { importId: imp.importId }), old = await verifyCatalog(f.dir, first.catalogId);
    fs.renameSync(f.root, moved); f.root = moved; f.dir = join(moved, 'projects/bounded-audio'); f.selected = join(moved, 'selected');
    assert.deepEqual(await verifyCatalog(f.dir, first.catalogId), old); const fresh = await f.import(), next = await catalogAssets(f.dir, { importId: fresh.importId }), m = await verifyCatalog(f.dir, next.catalogId);
    assert.equal(m.assets.length, 2); const map = json(join(f.dir, evidence(m.assets.at(-1), 'audio-input-map').path)); assert.ok(map.cwd.startsWith(moved));
  } finally { f.clean(); }
});
