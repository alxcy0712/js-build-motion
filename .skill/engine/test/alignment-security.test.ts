import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { parseAlignmentJson } from '../src/adapters/alignment-json.ts';
import { alignScript } from '../src/adapters/alignment-map.ts';
import { alignAsset, verifyAlignment, recoverAlignmentAttempts, AlignmentFailure } from '../src/application/alignment.ts';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, verifyCatalog } from '../src/application/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { alignmentSubjectSha256, assertAlignment, DEFAULT_ALIGNMENT_POLICY, validateAlignmentScript,
  type AlignmentScript, type ParsedAlignment } from '../src/project/alignment.ts';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => fs.writeFileSync(path, importJsonText(value));
const copy = <T>(value: T): T => structuredClone(value);
const modelPath = '/fictional/core/assets/asr/models/ggml-base.bin';

// Enumerate every monotone matching sequence, then intersect all maximal sequences.
// This oracle uses neither the production DP nor its forward/backward criterion.
function commonOptimalPairs(a: string[], b: string[]): Map<number, number> {
  const paths: [number, number][][] = []; let longest = -1;
  function visit(i: number, j: number, pairs: [number, number][]) {
    if (pairs.length > longest) { longest = pairs.length; paths.length = 0; }
    if (pairs.length === longest) paths.push(pairs);
    for (let x = i; x < a.length; x++) for (let y = j; y < b.length; y++)
      if (a[x] === b[y]) visit(x + 1, y + 1, [...pairs, [x, y]]);
  }
  visit(0, 0, []);
  const result = new Map<number, number>();
  for (const [i, j] of paths[0]!) if (paths.every(path => path.some(([x, y]) => x === i && y === j))) result.set(i, j);
  return result;
}
function sequences(max: number): string[][] {
  const out: string[][] = [[]];
  for (let length = 1; length <= max; length++) for (let bits = 0; bits < 2 ** length; bits++)
    out.push(Array.from({ length }, (_, i) => bits & 1 << i ? 'b' : 'a'));
  return out;
}
function parsedWords(words: string[]): ParsedAlignment {
  const text = Buffer.from(words.join(' ')); let byteStart = 0;
  const tokens = words.map((word, i) => {
    const result = { id: `alignment-token-${i}`, ordinal: i, segmentIndex: 0, tokenIndex: i, providerId: i,
      byteStart, byteEnd: byteStart + Buffer.byteLength(word) + (i ? 1 : 0), sampleStart: i * 160, sampleEnd: (i + 1) * 160, reason: '' };
    byteStart = result.byteEnd; return result;
  }); return { text, tokens, rawTokens: tokens.length };
}

test('independent exhaustive LCS oracle preserves exactly the pairs common to every maximal monotone mapping', () => {
  const values = sequences(4); let checked = 0;
  for (const a of values) for (const b of values) {
    const parsed = parsedWords(b), expected = commonOptimalPairs(a, b), map = alignScript(Buffer.from(a.join(' ')), parsed, 3200, DEFAULT_ALIGNMENT_POLICY);
    const units = map.units.filter(unit => unit.kind !== 'nonlexical'); assert.equal(units.length, a.length);
    for (const [i, unit] of units.entries()) {
      const j = expected.get(i), label = JSON.stringify({ a, b, i });
      if (j === undefined) {
        assert.equal(unit.basis, 'unknown', label); assert.equal(unit.sampleStart, null, label); assert.equal(unit.sampleEnd, null, label);
      } else {
        assert.equal(unit.basis, 'estimated', label); assert.equal(unit.recognizedByteStart, j * 2, label);
        assert.equal(unit.recognizedByteEnd, j * 2 + 1, label);
        assert.equal(unit.sampleStart, j * 160, label); assert.equal(unit.sampleEnd, (j + 1) * 160, label);
      }
      assert.equal(unit.confidence, null, label);
    }
    assert.equal(map.coverage.lexicalUnits, a.length); assert.equal(map.coverage.estimatedUnits, expected.size);
    assert.equal(map.coverage.unknownUnits, a.length - expected.size); checked++;
  }
  assert.equal(checked, 961);
});

test('independent UTF8 partition keeps original CRLF, emoji, combining marks and nonlexical text', () => {
  const text = Buffer.from(' A中🙂e\u0301！\r\nB '), parsed = parsedWords(['a', '中', 'e', 'b']);
  const map = alignScript(text, parsed, 3200, DEFAULT_ALIGNMENT_POLICY);
  let end = 0;
  for (const [i, unit] of map.units.entries()) {
    assert.equal(unit.ordinal, i); assert.equal(unit.byteStart, end); assert.ok(unit.byteEnd > end);
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(text.subarray(unit.byteStart, unit.byteEnd)), unit.text);
    if (unit.kind === 'nonlexical') { assert.equal(unit.basis, 'unknown'); assert.equal(unit.sampleStart, null); assert.equal(unit.sampleEnd, null); }
    assert.equal(unit.confidence, null); end = unit.byteEnd;
  }
  assert.equal(end, text.length); assert.equal(map.units.map(unit => unit.text).join(''), text.toString('utf8'));
  assert.equal(map.coverage.scriptBytes, 19); assert.equal(map.coverage.scriptComplete, true); assert.equal(map.coverage.listening, 'unverified');
  assert.equal(map.coverage.lexicalUnits, 4); assert.equal(map.coverage.estimatedUnits, 4);
  for (const source of [Buffer.from([0xff]), Buffer.from('a\u0000b'), Buffer.from('\ufeffa')])
    assert.throws(() => alignScript(source, parsed, 3200, DEFAULT_ALIGNMENT_POLICY));
});

test('independent token sharing, multi-token envelopes and missing timings stay estimated or unknown', () => {
  const shared = alignScript(Buffer.from('中a'), parsedWords(['中a']), 3200, DEFAULT_ALIGNMENT_POLICY);
  assert.deepEqual(shared.units.map(unit => [unit.sampleStart, unit.sampleEnd, unit.basis, unit.confidence]), [[0, 160, 'estimated', null], [0, 160, 'estimated', null]]);
  assert.ok(shared.units.every(unit => unit.reason === 'TOKEN_ESTIMATE_SHARED_RANGE'));
  const parsed: ParsedAlignment = { text: Buffer.from('hello'), rawTokens: 2, tokens: [
    { id: 'alignment-token-0', ordinal: 0, segmentIndex: 0, tokenIndex: 0, providerId: 64, byteStart: 0, byteEnd: 3, sampleStart: 0, sampleEnd: 1000, reason: '' },
    { id: 'alignment-token-1', ordinal: 1, segmentIndex: 0, tokenIndex: 1, providerId: 65, byteStart: 3, byteEnd: 5, sampleStart: 2000, sampleEnd: 3000, reason: '' },
  ] };
  const envelope = alignScript(Buffer.from('hello'), parsed, 3200, DEFAULT_ALIGNMENT_POLICY); assert.equal(envelope.units[0]!.sampleStart, 0); assert.equal(envelope.units[0]!.sampleEnd, 3000);
  parsed.tokens[1]!.sampleStart = null; parsed.tokens[1]!.sampleEnd = null; parsed.tokens[1]!.reason = 'TOKEN_TIMING_MISSING';
  const missing = alignScript(Buffer.from('hello'), parsed, 3200, DEFAULT_ALIGNMENT_POLICY);
  assert.equal(missing.units[0]!.basis, 'unknown'); assert.equal(missing.units[0]!.sampleStart, null); assert.equal(missing.units[0]!.sampleEnd, null);
  assert.equal(missing.coverage.estimatedUnits, 0); assert.equal(missing.coverage.unknownUnits, 1);
  const han = alignScript(Buffer.from('𠮷'), parsedWords(['𠮷']), 3200, DEFAULT_ALIGNMENT_POLICY); assert.equal(han.units[0]!.kind, 'character'); assert.equal(han.units[0]!.byteEnd, 4);
});

function script(text = ' A 中 B '): AlignmentScript {
  const value: AlignmentScript = { version: '0.1', kind: 'alignment-script', language: 'zh', lineId: 'line-fictional', text,
    approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'decision-fictional',
      sourceRef: { path: 'inputs/approval.txt', bytes: 8, sha256: sha('approved') }, subjectSha256: '' } };
  value.approval.subjectSha256 = alignmentSubjectSha256(value); return value;
}
test('independent approved subject binds exact text, language, line and scoped approval', () => {
  const value = script(); validateAlignmentScript(value);
  for (const mutate of [
    (v: any) => { v.text = ' X 中 B '; }, (v: any) => { v.language = 'en'; }, (v: any) => { v.lineId = 'line-alternate'; },
    (v: any) => { v.approval.scope = 'render'; }, (v: any) => { v.approval.sourceRef.path = 'out/approval.txt'; },
    (v: any) => { v.approval.sourceRef.path = '../approval.txt'; }, (v: any) => { v.text = '\ud800'; },
    (v: any) => { v.approval.approved = true; }, (v: any) => { v.version = '0.2'; },
  ]) { const changed = copy(value); mutate(changed); assert.throws(() => validateAlignmentScript(changed)); }
  assert.equal(value.text, ' A 中 B ');
});

function stamp(ms: number) { return `00:00:${String(Math.floor(ms / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; }
function token(text: string, id: number, from: number, to: number) {
  return { text, id, p: 0.9, t_dtw: -1, timestamps: { from: stamp(from), to: stamp(to) }, offsets: { from, to } };
}
function provider(model = modelPath, language = 'zh', empty = false) {
  return { systeminfo: 'independent full-token fixture', model: { type: 'base', multilingual: true, vocab: 51865,
    audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model, language, translate: false }, result: { language }, transcription: empty ? [] : [{
      timestamps: { from: stamp(0), to: stamp(200) }, offsets: { from: 0, to: 200 }, text: ' A 中 B ',
      tokens: [token('[_BEG_]', 50364, 0, 0), token(' A', 64, 0, 60), token(' 中', 300, 60, 120), token(' B ', 65, 120, 200)],
    }] };
}
test('independent parser bounds raw bytes, raw special count, token text and recognized bytes before filtering', () => {
  const raw = Buffer.from(JSON.stringify(provider())), parsed = parseAlignmentJson(raw, 3200, 'zh', DEFAULT_ALIGNMENT_POLICY, modelPath);
  assert.equal(parsed.rawTokens, 4); assert.equal(parsed.tokens.length, 3); assert.equal(parsed.text.toString(), ' A 中 B ');
  const exact = { ...DEFAULT_ALIGNMENT_POLICY, maxRawBytes: raw.length, maxTokens: 4, maxTokenTextBytes: 7, maxRecognizedBytes: 9 };
  parseAlignmentJson(raw, 3200, 'zh', exact, modelPath);
  for (const [key, value] of [['maxRawBytes', raw.length - 1], ['maxTokens', 3], ['maxTokenTextBytes', 6], ['maxRecognizedBytes', 8]] as const)
    assert.throws(() => parseAlignmentJson(raw, 3200, 'zh', { ...exact, [key]: value }, modelPath), key);
  const bad = copy(provider()); bad.transcription[0]!.tokens[0]!.t_dtw = 0;
  assert.throws(() => parseAlignmentJson(Buffer.from(JSON.stringify(bad)), 3200, 'zh', DEFAULT_ALIGNMENT_POLICY, modelPath));
});

test('independent mapper bounds whole original bytes, lexical units and full DP capacity', () => {
  const recognized = parsedWords(['中', 'a']), source = Buffer.from('中a');
  const exact = { ...DEFAULT_ALIGNMENT_POLICY, maxScriptBytes: 4, maxScriptUnits: 2, maxRecognizedUnits: 2, maxMatrixCells: 9 };
  alignScript(source, recognized, 3200, exact);
  for (const [key, value] of [['maxScriptBytes', 3], ['maxScriptUnits', 1], ['maxRecognizedUnits', 1], ['maxMatrixCells', 8]] as const)
    assert.throws(() => alignScript(source, recognized, 3200, { ...exact, [key]: value }), key);
  for (const samples of [3199, 1920001]) assert.throws(() => alignScript(source, recognized, samples, DEFAULT_ALIGNMENT_POLICY));
});

// Independent source format and waveform oracle, with a nonzero payload.
function wave(samples = 3200, rate = 16000, channels = 1) {
  const b = Buffer.alloc(44 + samples * channels * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * channels * 2, 40);
  for (let i = 0; i < samples * channels; i++) b.writeInt16LE(i % 173 - 86, 44 + i * 2); return b;
}
async function fixture(bytes = wave()) {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(out, 'alignment-security-'))), dir = initProject({ slug: 'aligned-fixture', projectsRoot: join(root, 'projects') }).dir;
  const selected = join(root, 'selected'); fs.mkdirSync(selected); fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
  fs.writeFileSync(join(selected, 'source.wav'), bytes); fs.writeFileSync(join(dir, 'inputs/approval.txt'), 'approved'); save(join(dir, 'inputs/script.json'), script());
  const imported = await importOriginals(dir, selected), catalog = await catalogAssets(dir, { importId: imported.importId }), manifest = await verifyCatalog(dir, catalog.catalogId), asset = manifest.assets[0]!;
  return { root, dir, bytes, catalog, asset, selection: { catalogId: catalog.catalogId, assetId: asset.assetId, assetVersion: asset.assetVersion, scriptPath: 'inputs/script.json' },
    clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function synthetic<T>(action: () => Promise<T>, options: { empty?: boolean; code?: string; before?: (argv: string[], cwd: string) => void } = {}) {
  const spawn = childProcess.spawn, calls: any[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: string[], settings: any) => {
      if (String(executable).endsWith('/assets/asr/bin/whisper-cli')) {
        const data = provider(argv[argv.indexOf('-m') + 1], argv[argv.indexOf('-l') + 1], options.empty);
        calls.push({ executable, argv: [...argv], cwd: settings.cwd, files: fs.readdirSync(settings.cwd), wav: fs.readFileSync(argv[argv.indexOf('-f') + 1]!), env: settings.env });
        options.before?.(argv, settings.cwd);
        return spawn(process.execPath, ['-e', options.code ?? `process.stdout.write(${JSON.stringify(JSON.stringify(data))})`], settings);
      }
      return spawn(executable, argv, settings);
    }) as typeof spawn; syncBuiltinESMExports(); return { result: await action(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
async function failed(f: Awaited<ReturnType<typeof fixture>>, options = {}) {
  let error: any; try { await alignAsset(f.dir, f.selection, options); } catch (value) { error = value; }
  assert.ok(error instanceof AlignmentFailure, String(error)); assertAlignment('receipt', error.receipt); assert.equal(error.receipt.indexCommitted, false);
  assert.equal(fs.existsSync(join(f.dir, 'runs/alignment.lock')), false); return error.receipt;
}
function rehashAlignment(f: Awaited<ReturnType<typeof fixture>>, alignmentId: string, manifest: any) {
  const path = join(f.dir, 'assets/derived/alignment', alignmentId, 'manifest.json'); save(path, manifest);
  const index = json(join(f.dir, 'assets/alignment.json')); index.alignments.find((v: any) => v.alignmentId === alignmentId).manifestSha256 = sha(fs.readFileSync(path)); save(join(f.dir, 'assets/alignment.json'), index);
}

test('independent application source/script bytes stay fixed and shared token estimates remain explicit', async () => {
  const f = await fixture(); try {
    const before = fs.readFileSync(join(f.dir, f.selection.scriptPath)), source = fs.readFileSync(join(f.dir, f.asset.source.fixedPath));
    const { result: receipt, calls } = await synthetic(() => alignAsset(f.dir, f.selection));
    const manifest = await verifyAlignment(f.dir, receipt.alignmentId), map = json(join(f.dir, manifest.map.path));
    assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.indexCommitted, true); assert.equal(calls.length, 1);
    assert.ok(calls[0].argv.includes('-ojf')); assert.ok(!calls[0].argv.includes('-oj')); assert.ok(!calls[0].argv.includes('--prompt'));
    assert.deepEqual(calls[0].files, []); assert.equal(calls[0].env.PATH, '/usr/bin:/bin'); assert.deepEqual(calls[0].wav, f.bytes);
    assert.deepEqual(fs.readFileSync(join(f.dir, manifest.audio.path)), f.bytes);
    assert.deepEqual(fs.readFileSync(join(f.dir, f.selection.scriptPath)), before); assert.deepEqual(fs.readFileSync(join(f.dir, f.asset.source.fixedPath)), source);
    assert.deepEqual(map.units.filter((u: any) => u.kind !== 'nonlexical').map((u: any) => [u.sampleStart, u.sampleEnd, u.basis, u.confidence]),
      [[0, 960, 'estimated', null], [960, 1920, 'estimated', null], [1920, 3200, 'estimated', null]]);
    assert.equal(map.coverage.listening, 'unverified'); assert.equal(fs.existsSync(join(f.dir, 'runs/alignment.lock')), false);
  } finally { f.clean(); }
});

test('independent caller mutation cannot rewrite the durable selection of an executing attempt', async () => {
  const f = await fixture(); try {
    const supplied = copy(f.selection), initial = copy(supplied);
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, supplied, { hooks: { afterProvider: async () => {
      supplied.assetId = 'asset-11111111-1111-4111-8111-111111111111'; supplied.scriptPath = 'inputs/alternate.json';
    } } }));
    assert.deepEqual(receipt.selection, initial); assert.deepEqual(json(join(f.dir, 'runs', receipt.attemptId, 'receipt.json')).selection, initial);
    const manifest = await verifyAlignment(f.dir, receipt.alignmentId); assert.equal(manifest.source.assetId, initial.assetId);
  } finally { f.clean(); }
});

test('independent valid-looking derived maps and tool identities reject after every outer hash is recomputed', async () => {
  const f = await fixture(); try {
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, f.selection)), original = await verifyAlignment(f.dir, receipt.alignmentId);
    const paths = { map: join(f.dir, original.map.path), manifest: join(f.dir, receipt.manifestPath!), index: join(f.dir, 'assets/alignment.json'),
      command: join(f.dir, 'runs', receipt.attemptId, 'alignment-command.json') };
    const bytes = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)]));
    const mutations: [string, (manifest: any, map: any) => void][] = [
      ['sample', (_, m) => { m.units.find((u: any) => u.basis === 'estimated').sampleEnd--; }],
      ['recognized range', (_, m) => { m.units.find((u: any) => u.basis === 'estimated').recognizedByteStart++; }],
      ['normalized text', (_, m) => { m.units.find((u: any) => u.basis === 'estimated').normalized = 'x'; }],
      ['original partition', (_, m) => { m.units[0].byteEnd++; }],
      ['coverage', (_, m) => { m.coverage.estimatedUnits--; m.coverage.unknownUnits++; }],
      ['limitation', (_, m) => { m.limitations = []; }], ['status', (_, m) => { m.status = 'partial'; }],
      ['observed claim', (_, m) => { m.units[1].basis = 'observed'; }], ['numeric confidence', (_, m) => { m.units[1].confidence = 1; }],
      ['tool args', m => { m.tool.argv[0] = '-changed'; }], ['tool version', m => { m.tool.version = 'foreign'; }],
      ['tool executable', m => { m.tool.executable = '/fictional/foreign-provider'; }],
      ['tool raw count', m => { m.tool.binaryBytes++; }], ['tool elapsed', m => { m.tool.elapsedMs = m.policy.maxToolElapsedMs + 1001; }],
      ['foreign logical engine', m => { m.engine.program.path = 'assets/asr/bin/changed'; }],
      ['program digest', m => { m.engine.program.sha256 = sha('independent foreign program'); }],
      ['program bytes', m => { m.engine.program.bytes++; }],
      ['runtime lock digest', m => { m.engine.lockSha256 = sha('independent foreign lock'); }],
    ];
    for (const [label, mutate] of mutations) {
      const manifest = copy(original), map = JSON.parse(bytes.map!.toString()); mutate(manifest, map); save(paths.map, map);
      const raw = fs.readFileSync(paths.map); manifest.counts.derivedBytes += raw.length - manifest.map.bytes; manifest.map.bytes = raw.length; manifest.map.sha256 = sha(raw);
      const command = JSON.parse(bytes.command!.toString()); command.run = manifest.tool; save(paths.command, command);
      rehashAlignment(f, receipt.alignmentId, manifest);
      try { await assert.rejects(verifyAlignment(f.dir, receipt.alignmentId), undefined, label); }
      finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, bytes[key]!); }
      await verifyAlignment(f.dir, receipt.alignmentId);
    }
  } finally { f.clean(); }
});

test('independent source-PCM and canonical audio coordinated replacement is rejected against unchanged original payload', async () => {
  const f = await fixture(); try {
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, f.selection)), original = await verifyAlignment(f.dir, receipt.alignmentId);
    const pcm = f.asset.technical.evidence.find((e: any) => e.kind === 'audio-pcm')!;
    const paths = { pcm: join(f.dir, pcm.path), audio: join(f.dir, original.audio.path), catalog: join(f.dir, f.catalog.manifestPath!),
      catalogIndex: join(f.dir, 'assets/catalog.json'), manifest: join(f.dir, receipt.manifestPath!), index: join(f.dir, 'assets/alignment.json') };
    const before = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, fs.readFileSync(path)]));
    const changedPcm = Buffer.from(before.pcm!), changedAudio = Buffer.from(before.audio!); changedPcm[0] ^= 1; changedAudio[44] ^= 1;
    fs.writeFileSync(paths.pcm, changedPcm); fs.writeFileSync(paths.audio, changedAudio);
    const catalog = JSON.parse(before.catalog!.toString()); catalog.assets[0].technical.evidence.find((e: any) => e.id === pcm.id).sha256 = sha(changedPcm); save(paths.catalog, catalog);
    const index = JSON.parse(before.catalogIndex!.toString()), catalogHash = sha(fs.readFileSync(paths.catalog)); index.catalogs.find((v: any) => v.catalogId === f.catalog.catalogId).manifestSha256 = catalogHash; save(paths.catalogIndex, index);
    const manifest = copy(original); manifest.source.catalogManifestSha256 = catalogHash; manifest.audio.sha256 = sha(changedAudio); rehashAlignment(f, receipt.alignmentId, manifest);
    try { await assert.rejects(verifyAlignment(f.dir, receipt.alignmentId), /SOURCE|AUDIO|PCM|PAYLOAD|CHANGED/); }
    finally { for (const [key, path] of Object.entries(paths)) fs.writeFileSync(path, before[key]!); }
    await verifyAlignment(f.dir, receipt.alignmentId);
  } finally { f.clean(); }
});

test('independent approval input and frozen approval/script replacements reject while preserving the old current index', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), original = await verifyAlignment(f.dir, first.alignmentId);
    const index = fs.readFileSync(join(f.dir, 'assets/alignment.json')), scriptPath = join(f.dir, f.selection.scriptPath), approvalPath = join(f.dir, 'inputs/approval.txt');
    const beforeScript = fs.readFileSync(scriptPath), beforeApproval = fs.readFileSync(approvalPath);
    const changed = JSON.parse(beforeScript.toString()); changed.text = ' X 中 B '; save(scriptPath, changed);
    await synthetic(() => failed(f)); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index); fs.writeFileSync(scriptPath, beforeScript);
    fs.writeFileSync(approvalPath, 'altered!'); await synthetic(() => failed(f)); fs.writeFileSync(approvalPath, beforeApproval);
    assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    for (const key of ['scriptSnapshot', 'approvalSource'] as const) {
      const identity = original[key], path = join(f.dir, identity.path), before = fs.readFileSync(path), manifestBytes = fs.readFileSync(join(f.dir, first.manifestPath!));
      if (key === 'scriptSnapshot') { const value = JSON.parse(before.toString()); value.text = ' X 中 B '; save(path, value); }
      else fs.writeFileSync(path, 'altered!');
      const manifest = copy(original), data = fs.readFileSync(path); manifest.counts.derivedBytes += data.length - manifest[key].bytes;
      manifest[key].bytes = data.length; manifest[key].sha256 = sha(data); rehashAlignment(f, first.alignmentId, manifest);
      try { await assert.rejects(verifyAlignment(f.dir, first.alignmentId), /APPROVAL|SCRIPT|SUBJECT|CHANGED/); }
      finally { fs.writeFileSync(path, before); fs.writeFileSync(join(f.dir, first.manifestPath!), manifestBytes); fs.writeFileSync(join(f.dir, 'assets/alignment.json'), index); }
    }
    await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});

test('independent empty recognition keeps the full approved partition and timed coverage unknown', async () => {
  const f = await fixture(); try {
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, f.selection), { empty: true }), manifest = await verifyAlignment(f.dir, receipt.alignmentId);
    const map = json(join(f.dir, manifest.map.path)); assert.equal(receipt.status, 'succeeded'); assert.equal(map.status, 'unknown');
    assert.equal(map.units.map((u: any) => u.text).join(''), script().text); assert.equal(map.coverage.submittedSampleEnd, 3200);
    assert.equal(map.coverage.lexicalUnits, 3); assert.equal(map.coverage.estimatedUnits, 0); assert.equal(map.coverage.unknownUnits, 3);
    assert.ok(map.units.every((u: any) => u.sampleStart === null && u.sampleEnd === null && u.basis === 'unknown' && u.confidence === null));
    assert.equal(manifest.recognized.bytes, 0); assert.equal(fs.readFileSync(join(f.dir, manifest.recognized.path)).length, 0);
  } finally { f.clean(); }
});

test('independent application quotas refuse only the new attempt and keep published bytes', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), index = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    const cases = [{ maxScriptBytes: 8 }, { maxApprovalBytes: 7 }, { maxSourceBytes: f.bytes.length - 1 }, { maxDerivedBytes: 1 },
      { maxRawBytes: 1 }, { maxMapBytes: 1 }, { maxMetadataBytes: 1 }, { maxSourceReadBytes: 1 }, { maxScriptUnits: 2 },
      { maxRecognizedUnits: 2 }, { maxTokens: 3 }, { maxMatrixCells: 15 }, { maxElapsedMs: 1 }];
    for (const lower of cases) {
      save(join(f.dir, 'inputs/alignment-policy.json'), { ...DEFAULT_ALIGNMENT_POLICY, ...lower });
      const { result: receipt } = await synthetic(() => failed(f)); assert.equal(receipt.status, 'failed', JSON.stringify(lower));
      assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index, JSON.stringify(lower));
    }
    fs.unlinkSync(join(f.dir, 'inputs/alignment-policy.json')); await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});

test('independent map node links, directories, missing data and unlisted outputs reject', async () => {
  const f = await fixture(); try {
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, f.selection)), manifest = await verifyAlignment(f.dir, receipt.alignmentId);
    const target = join(f.dir, manifest.map.path), bytes = fs.readFileSync(target), outside = join(f.root, 'map-copy.json'); fs.writeFileSync(outside, bytes);
    for (const mode of ['symlink', 'hardlink', 'directory', 'missing']) {
      fs.unlinkSync(target); if (mode === 'symlink') fs.symlinkSync(outside, target); if (mode === 'hardlink') fs.linkSync(outside, target); if (mode === 'directory') fs.mkdirSync(target);
      try { await assert.rejects(verifyAlignment(f.dir, receipt.alignmentId)); }
      finally { fs.rmSync(target, { recursive: true, force: true }); fs.writeFileSync(target, bytes); }
    }
    const extra = join(f.dir, 'assets/derived/alignment', receipt.alignmentId, 'extra.txt'); fs.writeFileSync(extra, 'extra');
    try { await assert.rejects(verifyAlignment(f.dir, receipt.alignmentId)); } finally { fs.unlinkSync(extra); }
    await verifyAlignment(f.dir, receipt.alignmentId);
  } finally { f.clean(); }
});

test('independent cancellation, provider/hook failures and runtime changes retain durable receipts and old current bytes', async () => {
  const f = await fixture(), lstat = fs.lstatSync; try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), index = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    const controller = new AbortController(); controller.abort(); assert.equal((await failed(f, { signal: controller.signal })).status, 'interrupted');
    for (const code of ['process.stdout.write("partial");process.exit(7)', 'process.stdout.write("invalid json")']) {
      const { result: receipt } = await synthetic(() => failed(f), { code }); assert.equal(receipt.status, 'failed'); assert.ok(receipt.tool);
      assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    }
    for (const hook of ['afterProvider', 'afterPrepared'] as const) {
      const { result: receipt } = await synthetic(() => failed(f, { hooks: { [hook]: async () => { throw Error(`independent ${hook} fault`); } } }));
      assert.equal(receipt.status, 'failed'); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    }
    const running = new AbortController();
    const { result: stopped } = await synthetic(() => failed(f, { signal: running.signal }), { code: 'setInterval(()=>{},1000)', before() { setTimeout(() => running.abort(), 100); } });
    assert.equal(stopped.status, 'interrupted'); assert.ok(stopped.tool); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    await synthetic(() => failed(f, { hooks: { afterProvider: async () => {
      fs.lstatSync = ((path: any, ...args: any[]) => { if (String(path).endsWith('/assets/asr/models/ggml-base.bin')) throw Error('independent runtime changed'); return (lstat as any)(path, ...args); }) as typeof lstat;
      syncBuiltinESMExports();
    } } }));
    fs.lstatSync = lstat; syncBuiltinESMExports(); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    await verifyAlignment(f.dir, first.alignmentId);
  } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); f.clean(); }
});

test('independent before-effect and after-effect index rename faults preserve actual publication facts', async () => {
  const f = await fixture(), rename = fsPromises.rename; try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), index = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    fsPromises.rename = async (src, dst) => { if (String(dst) === join(f.dir, 'assets/alignment.json')) throw Object.assign(Error('independent before-effect EIO'), { code: 'EIO' }); return rename(src, dst); }; syncBuiltinESMExports();
    await synthetic(() => failed(f)); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    fsPromises.rename = async (src, dst) => { await rename(src, dst); if (String(dst) === join(f.dir, 'assets/alignment.json')) throw Object.assign(Error('independent after-effect EIO'), { code: 'EIO' }); }; syncBuiltinESMExports();
    const { result: receipt } = await synthetic(() => alignAsset(f.dir, f.selection).catch((e: any) => e.receipt));
    assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.indexCommitted, true);
    fsPromises.rename = rename; syncBuiltinESMExports(); await verifyAlignment(f.dir, receipt.alignmentId); await verifyAlignment(f.dir, first.alignmentId);
  } finally { fsPromises.rename = rename; syncBuiltinESMExports(); f.clean(); }
});

for (const phase of ['afterProvider', 'afterPrepared', 'afterIndexCommitted'] as const) test(`independent actual SIGKILL at ${phase} recovers from durable index publication`, async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), index = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    const code = `const cp=(await import('node:child_process')).default;const {syncBuiltinESMExports}=await import('node:module');const spawn=cp.spawn;cp.spawn=(e,a,o)=>{if(String(e).endsWith('/assets/asr/bin/whisper-cli')){const r=${JSON.stringify(provider())};r.params.model=a[a.indexOf('-m')+1];r.params.language=a[a.indexOf('-l')+1];r.result.language=r.params.language;return spawn(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(r))+')'],o)}return spawn(e,a,o)};syncBuiltinESMExports();const {alignAsset}=await import(${JSON.stringify(new URL('../src/application/alignment.ts', import.meta.url).href)});await alignAsset(${JSON.stringify(f.dir)},${JSON.stringify(f.selection)},{hooks:{${phase}:async()=>process.kill(process.pid,'SIGKILL')}});`;
    const killed = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 }); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const pending = fs.readdirSync(join(f.dir, 'runs')).filter(name => /^alignment-attempt-/.test(name)).map(name => json(join(f.dir, 'runs', name, 'receipt.json'))).find(value => ['running', 'prepared'].includes(value.status));
    assert.ok(pending); const committed = phase === 'afterIndexCommitted';
    if (committed) await verifyAlignment(f.dir, pending.alignmentId); else assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index);
    await recoverAlignmentAttempts(f.dir); const recovered = json(join(f.dir, 'runs', pending.attemptId, 'receipt.json'));
    assert.equal(recovered.status, committed ? 'succeeded' : 'interrupted'); assert.equal(recovered.indexCommitted, committed);
    assert.equal(fs.existsSync(join(f.dir, 'runs/alignment.lock')), false); await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});

test('independent relocation with spaces retains historical invocation evidence and supports a new attempt', async () => {
  const f = await fixture(), before = f.dir, moved = f.root + ' moved'; try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)); fs.renameSync(f.root, moved); f.dir = join(moved, 'projects/aligned-fixture');
    const manifest = await verifyAlignment(f.dir, first.alignmentId); assert.ok(manifest.tool.argv.some(arg => arg.startsWith(before + '/')));
    const { result: next, calls } = await synthetic(() => alignAsset(f.dir, f.selection)); assert.equal(next.status, 'succeeded');
    assert.ok(calls[0].argv.includes(join(f.dir, 'out/.tmp', `alignment-${next.attemptId}`, 'audio.wav')));
    await verifyAlignment(f.dir, next.alignmentId); await verifyAlignment(f.dir, first.alignmentId);
  } finally { if (fs.existsSync(moved)) fs.renameSync(moved, f.root); f.dir = before; f.clean(); }
});
