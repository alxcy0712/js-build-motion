import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../src/application/catalog.ts';
import { importOriginals } from '../src/application/import.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { assertCatalog, DEFAULT_INSPECT_POLICY, INSPECT_POLICY_03, INSPECT_POLICY_02, LEGACY_INSPECT_POLICY } from '../src/project/catalog.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => fs.writeFileSync(path, importJsonText(value));
const evidence = (asset: any, kind: string) => asset.technical.evidence.find((e: any) => e.kind === kind);
// Handwritten source, independent of the production WAV writer and mapper.
function wave(frames = 3200, rate = 16000, channels = 1) {
  const dataBytes = frames * channels * 2, b = Buffer.alloc(44 + dataBytes); b.write('RIFF'); b.writeUInt32LE(36 + dataBytes, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames * channels; i++) b.writeInt16LE(i % 199 - 99, 44 + i * 2); return b;
}
function providerJson(model: string, language = 'zh', empty = false) {
  return { systeminfo: 'independent synthetic provider', model: { type: 'base', multilingual: true, vocab: 51865,
    audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model, language, translate: false }, result: { language }, transcription: empty ? [] : [
      { timestamps: { from: '00:00:00,000', to: '00:00:00,100' }, offsets: { from: 0, to: 100 }, text: ' 中文' },
      { timestamps: { from: '00:00:00,100', to: '00:00:00,210' }, offsets: { from: 100, to: 210 }, text: '🙂e\u0301' },
    ] };
}
function fixture(bytes = wave()) {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(out, 'catalog-asr-'))), dir = initProject({ slug: 'catalog-asr', projectsRoot: join(root, 'projects') }).dir, selected = join(root, 'selected');
  fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true }); fs.writeFileSync(join(selected, 'renamed.data'), bytes);
  return { root, dir, selected, bytes, import: () => importOriginals(dir, selected), clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function policy(dir: string, asr: object = {}, common: object = {}) { save(join(dir, 'inputs/inspect-policy.json'), { ...DEFAULT_INSPECT_POLICY, ...common, asr: { ...DEFAULT_INSPECT_POLICY.asr, enabled: true, ...asr } }); }
async function synthetic<T>(action: () => Promise<T>, opts: { empty?: boolean; code?: string; change?: (raw: any) => void; beforeProvider?: () => void } = {}) {
  const spawn = childProcess.spawn, calls: any[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: string[], options: any) => {
      if (String(executable).endsWith('/assets/asr/bin/whisper-cli')) {
        const raw = providerJson(argv[argv.indexOf('-m') + 1]!, argv[argv.indexOf('-l') + 1], opts.empty); opts.change?.(raw);
        const audio = argv[argv.indexOf('-f') + 1]!; calls.push({ executable, argv: [...argv], options, audio, wav: fs.readFileSync(audio), cwdFiles: fs.readdirSync(options.cwd) }); opts.beforeProvider?.();
        return spawn(process.execPath, ['-e', opts.code ?? `process.stdout.write(${JSON.stringify(JSON.stringify(raw))})`], options);
      }
      return spawn(executable, argv, options);
    }) as typeof spawn; syncBuiltinESMExports();
    return { result: await action(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
async function failed(dir: string, selection: any, options = {}) {
  let error: any; try { await catalogAssets(dir, selection, options); } catch (e) { error = e; }
  assert.ok(error instanceof CatalogFailure, String(error)); assertCatalog('receipt', error.receipt); assert.equal(error.receipt.indexCommitted, false); return error.receipt;
}
function record(a: any, s: any) {
  const d = a.technical.asr;
  return { version: '0.4', id: `observation-${randomUUID()}`, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256,
    method: 'independent ASR suggestion segment', locator: { kind: 'asr', evidenceId: d.textEvidenceId, mapEvidenceId: d.mapEvidenceId, audioEvidenceId: d.audioEvidenceId,
      segmentId: s.id, byteStart: s.byteStart, byteEnd: s.byteEnd }, coverage: 'full', coverageScope: 'segment-asr-text', statement: 'Only the recorded suggestion segment was read.', basis: 'estimated', confidence: null,
    limitations: ['Provider timing and words require listening confirmation.'], evidenceRefs: [d.textEvidenceId, d.mapEvidenceId, d.audioEvidenceId] };
}
function absent(a: any) {
  assert.ok(['failed', 'skipped', 'disabled'].includes(a.technical.asr.status)); assert.equal(a.technical.asr.segments, 0);
  for (const k of ['audioEvidenceId', 'jsonEvidenceId', 'textEvidenceId', 'mapEvidenceId']) assert.equal(a.technical.asr[k], null, k);
  assert.equal(a.technical.evidence.some((e: any) => ['asr-audio', 'asr-json', 'asr-map', 'text'].includes(e.kind)), false);
}
test('independent catalog ASR publishes one WAV/raw/text/map group with exact sample and UTF8 oracle', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r, calls } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }));
    const m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!, d = a.technical.asr!, map = json(join(f.dir, evidence(a, 'asr-map').path));
    assert.equal(r.version, '0.4'); assert.equal(m.version, '0.4'); assert.equal(d.status, 'completed'); assert.equal(a.technical.status, 'supported', a.technical.reason);
    assert.equal(new Set([d.audioEvidenceId, d.jsonEvidenceId, d.textEvidenceId, d.mapEvidenceId]).size, 4); assert.equal(a.technical.evidence.length, 6);
    assert.deepEqual(fs.readFileSync(join(f.dir, evidence(a, 'audio-pcm').path)), f.bytes.subarray(44));
    assert.deepEqual(fs.readFileSync(join(f.dir, evidence(a, 'asr-audio').path)), f.bytes); assert.equal(map.audio.samples, 3200); assert.equal(map.audio.payloadBytes, 6400);
    assert.deepEqual(map.segments.map((s: any) => [s.rawIndex, s.sampleStart, s.sampleEnd, s.clippedEndSamples, s.byteStart, s.byteEnd]), [[0, 0, 1600, 0, 0, 7], [1, 1600, 3200, 160, 8, 15]]);
    assert.equal(fs.readFileSync(join(f.dir, evidence(a, 'text').path), 'utf8'), ' 中文\n🙂e\u0301'); assert.deepEqual(map.coverage, { scope: 'input-audio-asr', submittedStart: 0, submittedEnd: 3200, complete: true });
    assert.equal(r.counts.decodedAudioBytes, 12800); assert.equal(r.counts.derivedBytes, a.technical.evidence.reduce((n, e) => n + e.bytes, 0)); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].cwdFiles, []); assert.notEqual(calls[0].options.cwd, join(f.dir, evidence(a, 'asr-audio').path)); assert.equal(calls[0].options.env.TMPDIR, calls[0].options.cwd);
    assert.equal(calls[0].options.env.PATH, '/usr/bin:/bin'); assert.deepEqual(calls[0].wav, f.bytes); assert.ok(calls[0].argv.includes('-np')); assert.equal(calls[0].argv[calls[0].argv.indexOf('-of') + 1], '-');
    assert.equal(m.tools.filter(t => t.version === '1.9.5/asr-json@0.1').length, 1); assert.equal(a.usability.semanticMatch.result, 'unknown'); assert.equal(a.usability.rightsScope.result, 'unknown');
    assert.equal(fs.readdirSync(join(f.dir, 'assets/derived/inspection', a.inspectionId)).length, 6);
  } finally { f.clean(); }
});
test('independent ASR segment observation enforces estimated/unknown/null and keeps original PCM listening locator', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!, map = json(join(f.dir, evidence(a, 'asr-map').path));
    const rec = record(a, map.segments[0]), path = join(f.dir, 'inputs/record.json'); save(path, rec); const accepted = await catalogAssets(f.dir, { observation: 'inputs/record.json' }); assert.deepEqual((await verifyCatalog(f.dir, accepted.catalogId)).observations[0], rec);
    const before = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const change of [{ basis: 'observed' }, { confidence: 0.5 }, { coverageScope: 'whole-audio' }, { byteSha256: sha('wrong') }, { evidenceRefs: [rec.locator.evidenceId] },
      { locator: { ...rec.locator, segmentId: 'asr-segment-2000' } }, { locator: { ...rec.locator, mapEvidenceId: rec.locator.evidenceId } }, { locator: { ...rec.locator, audioEvidenceId: rec.locator.evidenceId } },
      { locator: { ...rec.locator, byteEnd: 6 } }, { locator: { ...rec.locator, byteEnd: 15 } }, { coverage: 'partial', locator: { ...rec.locator, byteStart: 2 } }]) {
      save(path, { ...rec, id: `observation-${randomUUID()}`, ...change }); await failed(f.dir, { observation: 'inputs/record.json' }); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
    const unknown = { ...rec, id: `observation-${randomUUID()}`, basis: 'unknown', coverage: 'sample', locator: { ...rec.locator, byteStart: 1, byteEnd: 4 } }; save(path, unknown); await verifyCatalog(f.dir, (await catalogAssets(f.dir, { observation: 'inputs/record.json' })).catalogId);
    const pcm = evidence(a, 'audio-pcm'), legacy: any = { version: '0.1', id: `observation-${randomUUID()}`, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256, method: 'fictional original PCM coverage',
      locator: { kind: 'audio', evidenceId: pcm.id, byteStart: null, byteEnd: null, lineStart: null, lineEnd: null, x: null, y: null, width: null, height: null, streamIndex: pcm.streamIndex, timeBase: null, pts: null, sampleRate: 16000, sampleStart: 0, sampleEnd: 3200 },
      coverage: 'full', statement: 'This fixture locator covers original PCM.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [pcm.id] };
    save(path, legacy); await verifyCatalog(f.dir, (await catalogAssets(f.dir, { observation: 'inputs/record.json' })).catalogId);
    const text = evidence(a, 'text'); save(path, { ...legacy, id: `observation-${randomUUID()}`, locator: { ...legacy.locator, kind: 'text', evidenceId: text.id, byteStart: 0, byteEnd: text.bytes, lineStart: 1, lineEnd: 2, streamIndex: null, sampleRate: null, sampleStart: null, sampleEnd: null }, evidenceRefs: [text.id] }); assert.match((await failed(f.dir, { observation: 'inputs/record.json' })).error!, /ASR|LOCATOR/);
  } finally { f.clean(); }
});
test('independent ASR no-text and disabled descriptors have distinct evidence and inherited invocation facts', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }), { empty: true }); const m = await verifyCatalog(f.dir, r.catalogId), a = m.assets[0]!;
    assert.equal(a.technical.asr!.status, 'no-text'); assert.equal(evidence(a, 'text').bytes, 0); assert.equal(a.technical.evidence.length, 6); assert.deepEqual(json(join(f.dir, evidence(a, 'asr-map').path)).segments, []);
    const dup = await catalogAssets(f.dir, { importId: imp.importId }), inherited = await verifyCatalog(f.dir, dup.catalogId); assert.deepEqual(inherited.assets, m.assets); assert.deepEqual(inherited.tools, []);
    policy(f.dir, { enabled: false }); const next = await f.import(), { result: disabled, calls } = await synthetic(() => catalogAssets(f.dir, { importId: next.importId }));
    const latest = (await verifyCatalog(f.dir, disabled.catalogId)).assets.at(-1)!; assert.equal(latest.technical.asr!.status, 'disabled'); assert.equal(latest.technical.status, 'supported'); absent(latest); assert.equal(calls.length, 0); assert.ok(evidence(latest, 'audio-pcm')); await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('independent ASR immutable node/path/source/policy group rejects mutation, links and extras', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!;
    for (const relative of [a.source.fixedPath, ...a.technical.evidence.map(e => e.path), `runs/${r.attemptId}/inspect-policy.source.json`, `runs/${r.attemptId}/inspect-policy.adopted.json`]) {
      const path = join(f.dir, relative), bytes = fs.readFileSync(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; fs.writeFileSync(path, changed);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId)); } finally { fs.writeFileSync(path, bytes); } await verifyCatalog(f.dir, r.catalogId);
    }
    const target = join(f.dir, evidence(a, 'asr-map').path), bytes = fs.readFileSync(target), before = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const mode of ['missing', 'symlink', 'hardlink', 'directory']) {
      fs.unlinkSync(target); if (mode === 'symlink') fs.symlinkSync(join(f.dir, a.source.fixedPath), target); if (mode === 'hardlink') fs.linkSync(join(f.dir, a.source.fixedPath), target); if (mode === 'directory') fs.mkdirSync(target);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId)); await failed(f.dir, { importId: imp.importId }); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before); }
      finally { fs.rmSync(target, { recursive: true, force: true }); fs.writeFileSync(target, bytes); }
    }
    const extra = join(f.dir, 'assets/derived/inspection', a.inspectionId, 'extra.wav'); fs.writeFileSync(extra, wave()); try { await assert.rejects(verifyCatalog(f.dir, r.catalogId)); } finally { fs.unlinkSync(extra); } await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('independent raw replay rejects coordinated derived audio/text/map/outer-hash replacement', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), original = await verifyCatalog(f.dir, r.catalogId), a = original.assets[0]!;
    const paths = { audio: join(f.dir, evidence(a, 'asr-audio').path), text: join(f.dir, evidence(a, 'text').path), map: join(f.dir, evidence(a, 'asr-map').path), manifest: join(f.dir, r.manifestPath!), index: join(f.dir, 'assets/catalog.json') }, bytes = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, fs.readFileSync(p)]));
    assert.deepEqual(bytes.audio!.subarray(44), fs.readFileSync(join(f.dir, evidence(a, 'audio-pcm').path)));
    for (const mode of ['audio', 'text', 'segment', 'tool', 'tool-executable', 'tool-version', 'tool-budget', 'tool-audio', 'tool-inspection', 'tool-attempt']) {
      const m = JSON.parse(bytes.manifest!.toString()), current = m.assets[0], map = JSON.parse(bytes.map!.toString()), audio = Buffer.from(bytes.audio!), text = Buffer.from(bytes.text!);
      if (mode === 'audio') { audio[44] ^= 1; map.audio.sha256 = sha(audio); assert.notEqual(sha(audio.subarray(44)), evidence(a, 'audio-pcm').sha256); }
      else if (mode === 'text') { Buffer.from(' 文中').copy(text); map.text.sha256 = sha(text); }
      else if (mode === 'segment') { map.segments[0].rawEndMs = 90; map.segments[0].sampleEnd = 1440; }
      else {
        const tool = m.tools.find((t: any) => t.version === '1.9.5/asr-json@0.1'); if (mode === 'tool') tool.argv[0] = '-t-invalid'; if (mode === 'tool-executable') tool.executable = '/fictional/changed-program'; if (mode === 'tool-version') tool.version = '1.9.5/foreign-mapper@0.1'; if (mode === 'tool-budget') tool.elapsedMs = 121001;
        if (mode.startsWith('tool-audio') || mode === 'tool-inspection' || mode === 'tool-attempt') {
          const index = tool.argv.indexOf('-f') + 1, previous = tool.argv[index];
          tool.argv[index] = mode === 'tool-audio' ? '/fictional/other-audio.wav' : mode === 'tool-inspection' ? previous.replace(current.inspectionId, `inspection-${randomUUID()}`) : previous.replace(current.inspection.attemptId, `catalog-attempt-${randomUUID()}`);
          assert.notEqual(tool.argv[index], previous);
        }
      }
      fs.writeFileSync(paths.audio, audio); fs.writeFileSync(paths.text, text); save(paths.map, map);
      for (const kind of ['asr-audio', 'text', 'asr-map']) { const e = evidence(current, kind), data = fs.readFileSync(join(f.dir, e.path)); e.bytes = data.length; e.sha256 = sha(data); }
      m.counts.derivedBytes += evidence(current, 'asr-map').bytes - evidence(a, 'asr-map').bytes; save(paths.manifest, m);
      const idx = JSON.parse(bytes.index!.toString()); idx.catalogs.find((e: any) => e.catalogId === r.catalogId).manifestSha256 = sha(fs.readFileSync(paths.manifest)); save(paths.index, idx);
      try { await assert.rejects(verifyCatalog(f.dir, r.catalogId), /ASR|REPLAY|TOOL|COUNTS/); } finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, bytes[key]!); } await verifyCatalog(f.dir, r.catalogId);
    }
  } finally { f.clean(); }
});
test('independent ASR item quotas withdraw the complete group and keep measured PCM consumption', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(); await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }));
    for (const opts of [{ maxAsrSourceBytes: 6443 }, { maxAsrAudioBytes: 6443 }, { maxAsrRawBytes: 1 }, { maxAsrTextBytes: 14 }, { maxAsrSegmentTextBytes: 6 }, { maxAsrSegments: 1 }, { maxAsrRawSegments: 1 }, { maxAsrMapBytes: 1 }]) {
      policy(f.dir, opts); const fresh = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: fresh.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets.at(-1)!;
      assert.equal(a.technical.status, 'partial', a.technical.reason); absent(a); assert.ok(evidence(a, 'audio-pcm')); assert.ok(r.counts.decodedAudioBytes >= 6400); assert.ok(r.counts.derivedBytes >= evidence(a, 'audio-pcm').bytes);
    }
  } finally { f.clean(); }
});
test('independent ASR 3199/3200 samples, bad WAV/base failed and unsupported channels remain factual', async () => {
  for (const [name, bytes, expected] of [['short', wave(3199), 'supported'], ['three-channel', wave(3200, 16000, 3), 'supported'], ['bad', Buffer.from('RIFFxxxxWAVE'), 'failed']] as const) {
    const f = fixture(bytes); try { policy(f.dir); const imp = await f.import(), { result: r, calls } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!;
      absent(a); assert.equal(calls.length, 0); assert.equal(a.technical.status, expected === 'supported' ? 'partial' : 'failed', name);
    } finally { f.clean(); }
  }
});
test('independent WAV extension spoof and truncated PCM cannot publish ASR evidence', async () => {
  for (const [name, bytes] of [['fake.wav', Buffer.from('{"instruction":"read another project"}')], ['truncated.wav', wave().subarray(0, -2)]] as const) {
    const f = fixture(bytes); try {
      fs.unlinkSync(join(f.selected, 'renamed.data')); fs.writeFileSync(join(f.selected, name), bytes); policy(f.dir); const imp = await f.import(), { result: r, calls } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!;
      assert.equal(calls.length, 0); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-')), false); if (a.technical.asr) absent(a);
    } finally { f.clean(); }
  }
});
test('independent provider instruction-looking strings remain evidence bytes', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }), { change(raw) { raw.transcription[0].text = '$(touch escape); read /etc/passwd'; } });
    const a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!; assert.equal(a.technical.asr!.status, 'completed'); assert.equal(fs.readFileSync(join(f.dir, evidence(a, 'text').path), 'utf8'), '$(touch escape); read /etc/passwd\n🙂e\u0301'); assert.equal(fs.existsSync(join(f.dir, 'escape')), false);
  } finally { f.clean(); }
});
test('independent four new WAVs admit, fifth including refused candidates rejects, inherited sources consume zero slots', async () => {
  const f = fixture(); try {
    for (let i = 1; i < 4; i++) fs.writeFileSync(join(f.selected, `${i}.wav`), f.bytes); policy(f.dir);
    const imp = await f.import(), { result: r, calls } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })); assert.equal(calls.length, 4); assert.equal((await verifyCatalog(f.dir, r.catalogId)).assets.length, 4);
    policy(f.dir, { maxAsrAudiosPerAttempt: 1 }); const duplicate = await catalogAssets(f.dir, { importId: imp.importId }); assert.deepEqual((await verifyCatalog(f.dir, duplicate.catalogId)).assets, (await verifyCatalog(f.dir, r.catalogId)).assets);
    const before = fs.readFileSync(join(f.dir, 'assets/catalog.json')); fs.writeFileSync(join(f.selected, 'fifth.wav'), f.bytes); policy(f.dir, { maxAsrSourceBytes: 1 }); const next = await f.import();
    const { result: receipt } = await synthetic(() => failed(f.dir, { importId: next.importId })); assert.match(receipt.error!, /ASR.*COUNT|COUNT.*ASR/); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
  } finally { f.clean(); }
});
test('independent global source/decoded/derived/catalog/deadline quotas preserve old index', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: first } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), before = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    for (const common of [{ maxSourceBytes: 6443 }, { maxTotalSourceBytes: 6443 }, { maxDecodedAudioBytes: 12799 }, { maxDerivedBytes: 1 }, { maxCatalogBytes: 1 }, { maxElapsedMs: 1 }]) {
      policy(f.dir, {}, common); const fresh = await f.import(); await synthetic(() => failed(f.dir, { importId: fresh.importId })); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
    }
    await verifyCatalog(f.dir, first.catalogId);
  } finally { f.clean(); }
});
test('independent stored normalization binary count uses tightened sample capacity after outer rehash', async () => {
  const f = fixture(); try {
    policy(f.dir, { maxAsrSamples: 3200 }); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })); await verifyCatalog(f.dir, r.catalogId);
    const manifestPath = join(f.dir, r.manifestPath!), indexPath = join(f.dir, 'assets/catalog.json'), originalManifest = fs.readFileSync(manifestPath), originalIndex = fs.readFileSync(indexPath), manifest = JSON.parse(originalManifest.toString());
    const tool = manifest.tools.find((t: any) => t.version.endsWith('/asr-audio@0.1')); assert.ok(tool); assert.equal(tool.binaryBytes, 6400);
    // An even 6402 bypasses alignment-only checks while exceeding the 3200-sample cap.
    tool.binaryBytes = 6402; save(manifestPath, manifest); const idx = JSON.parse(originalIndex.toString()); idx.catalogs.find((e: any) => e.catalogId === r.catalogId).manifestSha256 = sha(fs.readFileSync(manifestPath)); save(indexPath, idx);
    try { await assert.rejects(verifyCatalog(f.dir, r.catalogId), /COUNTS|ASR.*LIMIT/); } finally { fs.writeFileSync(manifestPath, originalManifest); fs.writeFileSync(indexPath, originalIndex); } await verifyCatalog(f.dir, r.catalogId);
  } finally { f.clean(); }
});
test('independent ASR provider exit, JSON disagreement and tightened timeout are local failures with receipts', async () => {
  for (const opts of [{ code: 'process.stdout.write("partial");process.exit(7)' }, { code: 'setInterval(()=>{},1000)' }, { change: (r: any) => { r.params.translate = true; } }, { change: (r: any) => { r.transcription[1].offsets.to = 220; } }]) {
    const f = fixture(); try { policy(f.dir, { maxAsrToolElapsedMs: 200 }); const imp = await f.import(), { result: r } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId }), opts), a = (await verifyCatalog(f.dir, r.catalogId)).assets[0]!;
      assert.equal(a.technical.status, 'partial'); absent(a); assert.ok(r.tools.some(t => t.version === '1.9.5/asr-json@0.1')); assert.ok(r.counts.decodedAudioBytes >= 12800);
    } finally { f.clean(); }
  }
});
test('independent missing model refuses enabled new WAV globally; disabled path consumes no ASR identity', async () => {
  const f = fixture(), lstat = fs.lstatSync;
  try {
    policy(f.dir, { enabled: false }); const imp = await f.import();
    // Inject a filesystem read failure; shared runtime bytes remain read-only.
    fs.lstatSync = ((path: any, ...args: any[]) => { if (String(path).endsWith('/assets/asr/models/ggml-base.bin')) throw Error('ASR_RUNTIME_CHANGED: independent absent model'); return (lstat as any)(path, ...args); }) as typeof lstat; syncBuiltinESMExports();
    const first = await catalogAssets(f.dir, { importId: imp.importId }), before = fs.readFileSync(join(f.dir, 'assets/catalog.json')); assert.equal(first.assets[0]!.technical.asr!.status, 'disabled');
    policy(f.dir); const fresh = await f.import(), { result: r, calls } = await synthetic(() => failed(f.dir, { importId: fresh.importId })); assert.match(r.error!, /ASR_RUNTIME_CHANGED/); assert.equal(calls.length, 0); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); f.clean(); }
});
test('independent model identity read failure after provider prevents a new catalog commit', async () => {
  const f = fixture(), lstat = fs.lstatSync;
  try {
    policy(f.dir); const imp = await f.import(); await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })); const before = fs.readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const { result: r } = await synthetic(() => failed(f.dir, { importId: fresh.importId }), { beforeProvider() {
      fs.lstatSync = ((path: any, ...args: any[]) => { if (String(path).endsWith('/assets/asr/models/ggml-base.bin')) throw Error('ASR_RUNTIME_CHANGED: independent post-call identity failure'); return (lstat as any)(path, ...args); }) as typeof lstat; syncBuiltinESMExports();
    } }); assert.match(r.error!, /ASR_RUNTIME_CHANGED/); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), before);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); f.clean(); }
});
for (const p of [LEGACY_INSPECT_POLICY, INSPECT_POLICY_02, INSPECT_POLICY_03]) test(`independent ASR .4 keeps closed ${p.version} catalog, adopted policy and source bytes`, async () => {
  const f = fixture(); try {
    fs.unlinkSync(join(f.selected, 'renamed.data')); fs.writeFileSync(join(f.selected, 'notes.txt'), 'historical fictional text'); const source = JSON.stringify(p, null, 2); fs.writeFileSync(join(f.dir, 'inputs/inspect-policy.json'), source);
    const imp = await f.import(), r = await catalogAssets(f.dir, { importId: imp.importId }), m = json(join(f.dir, r.manifestPath!)); m.version = p.version; m.policy = p; m.policySha256 = sha(importJsonText(p)); for (const a of m.assets) a.inspection.policySha256 = m.policySha256;
    save(join(f.dir, 'runs', r.attemptId, 'inspect-policy.adopted.json'), p); save(join(f.dir, r.manifestPath!), m); const idx = json(join(f.dir, 'assets/catalog.json')); idx.version = p.version; idx.catalogs[0].manifestSha256 = sha(importJsonText(m)); save(join(f.dir, 'assets/catalog.json'), idx);
    assertCatalog('manifest', m); const frozen = fs.readFileSync(join(f.dir, r.manifestPath!)), old = await verifyCatalog(f.dir, r.catalogId), next = await catalogAssets(f.dir, { importId: imp.importId }), latest = await verifyCatalog(f.dir, next.catalogId);
    assert.equal(latest.version, '0.4'); assert.deepEqual(latest.assets, old.assets); assert.deepEqual(fs.readFileSync(join(f.dir, r.manifestPath!)), frozen); assert.equal(fs.readFileSync(join(f.dir, 'inputs/inspect-policy.json'), 'utf8'), source);
  } finally { f.clean(); }
});
test('independent ASR cancellation, source mutation and before/after-effect rename preserve publication facts', async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: first } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), old = fs.readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const controller = new AbortController(); controller.abort(); assert.equal((await failed(f.dir, { importId: fresh.importId }, { signal: controller.signal })).status, 'interrupted'); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), old);
    const source = join(f.dir, 'inputs/original', fresh.importId, 'renamed.data'); await synthetic(() => failed(f.dir, { importId: fresh.importId }), { beforeProvider() { const changed = Buffer.from(f.bytes); changed[44] ^= 1; fs.writeFileSync(source, changed); } }); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), old); fs.writeFileSync(source, f.bytes);
    const rename = fsPromises.rename; try {
      fsPromises.rename = async (src, dst) => { if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(new Error('independent before-effect EIO'), { code: 'EIO' }); await rename(src, dst); }; syncBuiltinESMExports();
      await synthetic(() => failed(f.dir, { importId: fresh.importId })); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), old);
      fsPromises.rename = async (src, dst) => { await rename(src, dst); if (String(dst) === join(f.dir, 'assets/catalog.json')) throw Object.assign(new Error('independent after-effect EIO'), { code: 'EIO' }); }; syncBuiltinESMExports();
      const { result: receipt } = await synthetic(() => catalogAssets(f.dir, { importId: fresh.importId }).catch((e: any) => e.receipt)); assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.indexCommitted, true); await verifyCatalog(f.dir, receipt.catalogId);
    } finally { fsPromises.rename = rename; syncBuiltinESMExports(); } await verifyCatalog(f.dir, first.catalogId);
  } finally { f.clean(); }
});
for (const phase of ['inspecting', 'committing', 'committed']) test(`independent ASR real SIGKILL at ${phase} recovers durable publication receipt`, async () => {
  const f = fixture(); try {
    policy(f.dir); const imp = await f.import(), { result: first } = await synthetic(() => catalogAssets(f.dir, { importId: imp.importId })), old = fs.readFileSync(join(f.dir, 'assets/catalog.json')), fresh = await f.import();
    const hook = phase === 'committed' ? 'afterIndexCommitted:async()=>process.kill(process.pid,"SIGKILL")' : `onPhase:async r=>{if(r.phase===${JSON.stringify(phase)})process.kill(process.pid,"SIGKILL")}`;
    const template = providerJson('placeholder'), code = `const cp=(await import('node:child_process')).default;const {syncBuiltinESMExports}=await import('node:module');const spawn=cp.spawn;cp.spawn=(e,a,o)=>{if(String(e).endsWith('/assets/asr/bin/whisper-cli')){const r=${JSON.stringify(template)};r.params.model=a[a.indexOf('-m')+1];return spawn(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(r))+')'],o)}return spawn(e,a,o)};syncBuiltinESMExports();const {catalogAssets}=await import(${JSON.stringify(new URL('../src/application/catalog.ts', import.meta.url).href)});await catalogAssets(${JSON.stringify(f.dir)},{importId:${JSON.stringify(fresh.importId)}},{hooks:{${hook}}});`;
    const killed = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000 }); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const pending = fs.readdirSync(join(f.dir, 'runs')).filter(n => /^catalog-attempt-/.test(n)).map(n => json(join(f.dir, 'runs', n, 'receipt.json'))).find(r => ['running', 'prepared'].includes(r.status)); assert.ok(pending);
    if (phase !== 'committed') { assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), old); await assert.rejects(verifyCatalog(f.dir, pending.catalogId), /NOT_COMMITTED/); } else await verifyCatalog(f.dir, pending.catalogId);
    await synthetic(() => catalogAssets(f.dir, { importId: fresh.importId })); const recovered = json(join(f.dir, 'runs', pending.attemptId, 'receipt.json')); assert.equal(recovered.status, phase === 'committed' ? 'succeeded' : 'interrupted'); assert.equal(recovered.indexCommitted, phase === 'committed'); assert.equal(fs.existsSync(join(f.dir, 'runs/catalog.lock')), false); await verifyCatalog(f.dir, first.catalogId);
  } finally { f.clean(); }
});
