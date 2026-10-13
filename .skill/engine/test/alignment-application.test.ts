import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { alignAsset, AlignmentFailure, recoverAlignmentAttempts, verifyAlignment, type AlignmentOptions } from '../src/application/alignment.ts';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, verifyCatalog } from '../src/application/catalog.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { alignmentArguments, alignmentSubjectSha256, assertAlignment, DEFAULT_ALIGNMENT_POLICY, type AlignmentScript, type AlignmentSelection } from '../src/project/alignment.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path: string, value: unknown) => fs.writeFileSync(path, importJsonText(value));
// Independent WAV oracle; fmt/data offsets move when the optional odd-sized JUNK is present.
function wav(frames = 3200, rate = 16000, channels = 1, junk = false) {
  const extra = junk ? 10 : 0, header = Buffer.alloc(44 + extra), data = Buffer.alloc(frames * channels * 2);
  header.write('RIFF'); header.writeUInt32LE(36 + extra + data.length, 4); header.write('WAVE', 8);
  if (junk) { header.write('JUNK', 12); header.writeUInt32LE(1, 16); header[20] = 19; }
  const at = 12 + extra; header.write('fmt ', at); header.writeUInt32LE(16, at + 4); header.writeUInt16LE(1, at + 8);
  header.writeUInt16LE(channels, at + 10); header.writeUInt32LE(rate, at + 12); header.writeUInt32LE(rate * channels * 2, at + 16);
  header.writeUInt16LE(channels * 2, at + 20); header.writeUInt16LE(16, at + 22); header.write('data', at + 24); header.writeUInt32LE(data.length, at + 28);
  for (let i = 0; i < frames * channels; i++) data.writeInt16LE(i % 199 - 99, i * 2); return Buffer.concat([header, data]);
}
function provider(model: string, language = 'zh', empty = false) {
  return { systeminfo: 'independent alignment provider', model: { type: 'base', multilingual: true, vocab: 51865,
    audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model, language, translate: false }, result: { language }, transcription: empty ? [] : [{ timestamps: { from: '00:00:00,000', to: '00:00:00,200' }, offsets: { from: 0, to: 200 }, text: '中文', tokens: [
      { text: '中', id: 64, p: 0.9, t_dtw: -1, timestamps: { from: '00:00:00,000', to: '00:00:00,100' }, offsets: { from: 0, to: 100 } },
      { text: '文', id: 65, p: 0.8, t_dtw: -1, timestamps: { from: '00:00:00,100', to: '00:00:00,200' }, offsets: { from: 100, to: 200 } },
    ] }] };
}
async function fixture(bytes = wav()) {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(out, 'alignment-application-'))), dir = initProject({ slug: 'alignment-fixture', projectsRoot: join(root, 'projects') }).dir;
  const selected = join(root, 'selected'); fs.mkdirSync(selected); fs.writeFileSync(join(selected, 'fictional.wav'), bytes);
  const imported = await importOriginals(dir, selected), catalog = await catalogAssets(dir, { importId: imported.importId });
  const asset = (await verifyCatalog(dir, catalog.catalogId)).assets[0]!;
  const approvalPath = 'inputs/approval.txt', approval = Buffer.from('Fictional approval delegated for this script.'); fs.writeFileSync(join(dir, approvalPath), approval);
  const script: AlignmentScript = { version: '0.1', kind: 'alignment-script', language: 'zh', lineId: 'fictional-line', text: '中文',
    approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'fictional-decision', sourceRef: { path: approvalPath, bytes: approval.length, sha256: sha(approval) }, subjectSha256: '' } };
  script.approval.subjectSha256 = alignmentSubjectSha256(script); save(join(dir, 'inputs/script.json'), script);
  const selection: AlignmentSelection = { catalogId: catalog.catalogId, assetId: asset.assetId, assetVersion: asset.assetVersion, scriptPath: 'inputs/script.json' };
  return { root, dir, asset, bytes, script, selection, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function synthetic<T>(action: () => Promise<T>, options: { empty?: boolean; code?: string; mutate?: (raw: any) => void; before?: () => void } = {}) {
  const spawn = childProcess.spawn, calls: any[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: string[], opts: any) => {
      if (String(executable).endsWith('/assets/asr/bin/whisper-cli')) {
        const raw = provider(argv[argv.indexOf('-m') + 1]!, argv[argv.indexOf('-l') + 1], options.empty); options.mutate?.(raw);
        calls.push({ executable, argv: [...argv], opts, wav: fs.readFileSync(argv[argv.indexOf('-f') + 1]!), cwdFiles: fs.readdirSync(opts.cwd) }); options.before?.();
        return spawn(process.execPath, ['-e', options.code ?? `process.stdout.write(${JSON.stringify(JSON.stringify(raw))})`], opts);
      }
      return spawn(executable, argv, opts);
    }) as typeof spawn; syncBuiltinESMExports(); return { result: await action(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
async function failed(dir: string, selection: AlignmentSelection, options: AlignmentOptions = {}) {
  let error: unknown; try { await alignAsset(dir, selection, options); } catch (cause) { error = cause; }
  assert.ok(error instanceof AlignmentFailure, String(error)); assertAlignment('receipt', error.receipt); return error.receipt;
}
function mutatePublished(dir: string, id: string, change: (manifest: any, prefix: string) => void) {
  const prefix = join(dir, 'assets/derived/alignment', id), manifest = json(join(prefix, 'manifest.json')); change(manifest, prefix);
  save(join(prefix, 'manifest.json'), manifest); const idx = json(join(dir, 'assets/alignment.json'));
  idx.alignments.find((entry: any) => entry.alignmentId === id).manifestSha256 = sha(fs.readFileSync(join(prefix, 'manifest.json'))); save(join(dir, 'assets/alignment.json'), idx);
}
test('alignment application canonical audio follows original RIFF data oracle and publishes seven immutable files', async () => {
  const f = await fixture(wav(3200, 16000, 1, true)); try {
    const originals = fs.readFileSync(join(f.dir, f.asset.source.fixedPath)), catalog = fs.readFileSync(join(f.dir, 'assets/catalog.json'));
    const { result: r, calls } = await synthetic(() => alignAsset(f.dir, f.selection)), m = await verifyAlignment(f.dir, r.alignmentId);
    assert.equal(r.status, 'succeeded'); assert.equal(r.indexCommitted, true); assert.equal(calls.length, 1); assert.deepEqual(calls[0].wav, wav());
    assert.deepEqual(calls[0].cwdFiles, []); assert.equal(calls[0].opts.env.TMPDIR, calls[0].opts.cwd); assert.equal(calls[0].opts.env.PATH, '/usr/bin:/bin');
    const argv = calls[0].argv; assert.deepEqual(argv, alignmentArguments('zh', argv[argv.indexOf('-m') + 1], argv[argv.indexOf('-f') + 1])); assert.ok(argv.includes('-ojf'));
    assert.deepEqual(fs.readFileSync(join(f.dir, m.audio.path)), wav()); assert.equal(m.source.wave.dataOffset, 54); assert.equal(m.audio.samples, 3200);
    const map = json(join(f.dir, m.map.path)); assert.equal(map.status, 'estimated'); assert.equal(map.coverage.estimatedUnits, 2);
    assert.deepEqual(map.units.map((unit: any) => [unit.text, unit.sampleStart, unit.sampleEnd, unit.basis]), [['中', 0, 1600, 'estimated'], ['文', 1600, 3200, 'estimated']]);
    assert.equal(m.tool.binaryBytes, m.raw.bytes); assert.equal(m.counts.derivedBytes, [m.audio, m.scriptSnapshot, m.approvalSource, m.raw, m.recognized, m.map].reduce((n, e) => n + e.bytes, 0));
    assert.deepEqual(fs.readdirSync(join(f.dir, 'assets/derived/alignment', r.alignmentId)).sort(), ['approval-source.txt', 'audio.wav', 'manifest.json', 'map.json', 'raw.json', 'recognized.txt', 'script.json']);
    assert.deepEqual(fs.readFileSync(join(f.dir, f.asset.source.fixedPath)), originals); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/catalog.json')), catalog);
    assert.equal(fs.existsSync(join(f.dir, 'runs/alignment.lock')), false); assert.deepEqual(await recoverAlignmentAttempts(f.dir), []);
  } finally { f.clean(); }
});
test('historical alignment uses script and approval snapshots after working revisions and project relocation', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), frozen = await verifyAlignment(f.dir, first.alignmentId);
    fs.appendFileSync(join(f.dir, 'inputs/approval.txt'), '\nNew working decision.'); f.script.text = '修订'; save(join(f.dir, 'inputs/script.json'), f.script);
    await verifyAlignment(f.dir, first.alignmentId); const relocated = join(f.root, 'relocated-project'); fs.renameSync(f.dir, relocated);
    assert.deepEqual(await verifyAlignment(relocated, first.alignmentId), frozen);
  } finally { f.clean(); }
});
test('caller selection mutation during asynchronous hooks preserves consumed input identity', async () => {
  const f = await fixture(); try {
    const initial = structuredClone(f.selection), { result: r } = await synthetic(() => alignAsset(f.dir, f.selection, { hooks: { afterProvider: async () => {
      f.selection.assetId = 'changed-by-caller'; f.selection.scriptPath = 'inputs/other.json';
    } } }));
    assert.deepEqual(r.selection, initial); const m = await verifyAlignment(f.dir, r.alignmentId); assert.equal(m.source.assetId, initial.assetId);
    assert.deepEqual(json(join(f.dir, 'runs', r.attemptId, 'receipt.json')).selection, initial);
  } finally { f.clean(); }
});
test('no-text output preserves approved text units as explicit unknown timing', async () => {
  const f = await fixture(); try {
    const { result: r } = await synthetic(() => alignAsset(f.dir, f.selection), { empty: true }), m = await verifyAlignment(f.dir, r.alignmentId), map = json(join(f.dir, m.map.path));
    assert.equal(m.recognized.bytes, 0); assert.equal(map.status, 'unknown'); assert.equal(map.coverage.unknownUnits, 2);
    assert.deepEqual(map.units.map((unit: any) => [unit.text, unit.sampleStart, unit.sampleEnd, unit.basis]), [['中', null, null, 'unknown'], ['文', null, null, 'unknown']]);
    assert.equal(json(join(f.dir, m.scriptSnapshot.path)).text, '中文');
  } finally { f.clean(); }
});
test('coordinated catalog PCM and outer hash substitution is rejected against original RIFF bytes', async () => {
  const f = await fixture(); try {
    const pcm = f.asset.technical.evidence.find(entry => entry.kind === 'audio-pcm')!, pcmPath = join(f.dir, pcm.path), original = fs.readFileSync(pcmPath), forged = Buffer.from(original); forged[0] ^= 1;
    fs.writeFileSync(pcmPath, forged); const catalogPath = join(f.dir, 'assets/catalogs', f.selection.catalogId, 'manifest.json'), m = json(catalogPath);
    m.assets[0].technical.evidence.find((entry: any) => entry.id === pcm.id).sha256 = sha(forged); save(catalogPath, m);
    const idx = json(join(f.dir, 'assets/catalog.json')); idx.catalogs[0].manifestSha256 = sha(fs.readFileSync(catalogPath)); save(join(f.dir, 'assets/catalog.json'), idx);
    await verifyCatalog(f.dir, f.selection.catalogId); const { result: r, calls } = await synthetic(() => failed(f.dir, f.selection));
    assert.match(r.error!, /PCM_SOURCE_MISMATCH/); assert.equal(calls.length, 0); assert.equal(fs.existsSync(join(f.dir, 'assets/alignment.json')), false);
  } finally { f.clean(); }
});
test('alignment admits only bounded original mono 16000 Hz PCM16 WAV', async () => {
  for (const bytes of [wav(3199), wav(3200, 8000), wav(3200, 16000, 2), wav(1920001)]) {
    const f = await fixture(bytes); try {
      const { result: r, calls } = await synthetic(() => failed(f.dir, f.selection)); assert.equal(r.indexCommitted, false); assert.equal(calls.length, 0);
      assert.match(r.error!, /SAMPLES_LIMIT|FORMAT_UNSUPPORTED/); assert.equal(fs.existsSync(join(f.dir, 'assets/alignment.json')), false);
    } finally { f.clean(); }
  }
});
test('stored runtime rejects coordinated engine identity edits and unavailable native program model or lock', async () => {
  const f = await fixture(); try {
    const { result: r } = await synthetic(() => alignAsset(f.dir, f.selection)), prefix = join(f.dir, 'assets/derived/alignment', r.alignmentId);
    const manifest = fs.readFileSync(join(prefix, 'manifest.json')), index = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    for (const mode of ['program-hash', 'program-bytes', 'lock-hash']) {
      try { mutatePublished(f.dir, r.alignmentId, m => {
        if (mode === 'program-hash') m.engine.program.sha256 = 'f'.repeat(64);
        if (mode === 'program-bytes') m.engine.program.bytes++;
        if (mode === 'lock-hash') m.engine.lockSha256 = 'f'.repeat(64);
      }); await assert.rejects(verifyAlignment(f.dir, r.alignmentId), /RUNTIME_CHANGED/);
      } finally { fs.writeFileSync(join(prefix, 'manifest.json'), manifest); fs.writeFileSync(join(f.dir, 'assets/alignment.json'), index); }
    }
    const lstat = fs.lstatSync;
    for (const suffix of ['/assets/asr/bin/whisper-cli', '/assets/asr/models/ggml-base.bin', '/asr-dependencies.lock.json']) {
      try { fs.lstatSync = ((path: any, ...args: any[]) => { if (String(path).endsWith(suffix)) throw Error('independent frozen runtime unavailable'); return (lstat as any)(path, ...args); }) as typeof fs.lstatSync;
        syncBuiltinESMExports(); await assert.rejects(verifyAlignment(f.dir, r.alignmentId), /RUNTIME_CHANGED/);
      } finally { fs.lstatSync = lstat; syncBuiltinESMExports(); }
    }
    await verifyAlignment(f.dir, r.alignmentId);
  } finally { f.clean(); }
});
test('replay rejects coordinated map, recognized, audio and recorded invocation substitutions', async () => {
  const f = await fixture(); try {
    const { result: r } = await synthetic(() => alignAsset(f.dir, f.selection)), prefix = join(f.dir, 'assets/derived/alignment', r.alignmentId), run = join(f.dir, 'runs', r.attemptId);
    const paths = [...fs.readdirSync(prefix).map(name => join(prefix, name)), join(f.dir, 'assets/alignment.json'), join(run, 'alignment-command.json')];
    const bytes = paths.map(path => fs.readFileSync(path));
    for (const mode of ['map', 'recognized', 'audio', 'tool-argv', 'tool-version', 'tool-cwd', 'tool-model-root']) {
      try {
        mutatePublished(f.dir, r.alignmentId, (m, directory) => {
          if (mode === 'map') { const map = json(join(directory, 'map.json')); map.units[0].sampleEnd -= 16; save(join(directory, 'map.json'), map); m.map.sha256 = sha(fs.readFileSync(join(directory, 'map.json'))); }
          else if (mode === 'recognized') { fs.writeFileSync(join(directory, 'recognized.txt'), '文中'); m.recognized.sha256 = sha('文中'); }
          else if (mode === 'audio') { const audio = fs.readFileSync(join(directory, 'audio.wav')); audio[44] ^= 1; fs.writeFileSync(join(directory, 'audio.wav'), audio); m.audio.sha256 = sha(audio); }
          else { const cmd = json(join(run, 'alignment-command.json'));
            if (mode === 'tool-argv') m.tool.argv[0] = '-foreign';
            if (mode === 'tool-version') m.tool.version = 'foreign/token-lcs@0.1';
            if (mode === 'tool-cwd') cmd.cwd = cmd.cwd.replace('/provider-', '/other/provider-');
            if (mode === 'tool-model-root') m.tool.argv[m.tool.argv.indexOf('-m') + 1] = '/foreign/assets/asr/models/ggml-base.bin';
            cmd.run = m.tool; save(join(run, 'alignment-command.json'), cmd);
          }
        }); await assert.rejects(verifyAlignment(f.dir, r.alignmentId), /ALIGNMENT/);
      } finally { for (const [i, path] of paths.entries()) fs.writeFileSync(path, bytes[i]!); }
      await verifyAlignment(f.dir, r.alignmentId);
    }
  } finally { f.clean(); }
});
test('script approval, live source mutation and whole evidence allowlist failures preserve prior index', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), old = fs.readFileSync(join(f.dir, 'assets/alignment.json')), script = fs.readFileSync(join(f.dir, f.selection.scriptPath));
    const source = fs.readFileSync(join(f.dir, f.asset.source.fixedPath)), approval = fs.readFileSync(join(f.dir, 'inputs/approval.txt'));
    for (const mode of ['subject', 'approval', 'script-live', 'source-live', 'approval-live', 'cwd-extra']) {
      try {
        if (mode === 'subject') { f.script.text = 'changed'; save(join(f.dir, f.selection.scriptPath), f.script); }
        if (mode === 'approval') fs.appendFileSync(join(f.dir, 'inputs/approval.txt'), ' changed');
        const { result: r } = await synthetic(() => failed(f.dir, f.selection, { hooks: { afterProvider: async () => {
          if (mode === 'script-live') fs.appendFileSync(join(f.dir, f.selection.scriptPath), ' ');
          if (mode === 'source-live') { const changed = Buffer.from(source); changed[44] ^= 1; fs.writeFileSync(join(f.dir, f.asset.source.fixedPath), changed); }
          if (mode === 'approval-live') fs.appendFileSync(join(f.dir, 'inputs/approval.txt'), ' live');
        } } }), mode === 'cwd-extra' ? { code: "require('fs').writeFileSync('extra','x');process.stdout.write('{}')" } : {});
        assert.equal(r.indexCommitted, false); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), old);
      } finally { fs.writeFileSync(join(f.dir, f.selection.scriptPath), script); fs.writeFileSync(join(f.dir, f.asset.source.fixedPath), source); fs.writeFileSync(join(f.dir, 'inputs/approval.txt'), approval); }
    }
    const extra = join(f.dir, 'assets/derived/alignment', first.alignmentId, 'extra.txt'); fs.writeFileSync(extra, 'extra');
    try { await assert.rejects(verifyAlignment(f.dir, first.alignmentId), /UNLISTED/); } finally { fs.unlinkSync(extra); }
    await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});
for (const [name, cap] of [['maxSourceBytes', 100], ['maxSourceReadBytes', 10], ['maxApprovalBytes', 1], ['maxRawBytes', 1], ['maxRecognizedBytes', 1], ['maxScriptBytes', 1], ['maxScriptUnits', 1], ['maxMatrixCells', 1], ['maxMapBytes', 1], ['maxDerivedBytes', 1], ['maxMetadataBytes', 1], ['maxToolOutputBytes', 1]] as const)
  test(`alignment ${name} quota preserves old commit and retains a failure receipt`, async () => {
    const f = await fixture(); try {
      const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), old = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
      save(join(f.dir, 'inputs/alignment-policy.json'), { ...DEFAULT_ALIGNMENT_POLICY, [name]: cap });
      const { result: r } = await synthetic(() => failed(f.dir, f.selection), name === 'maxToolOutputBytes' ? { code: "process.stderr.write('too much');process.stdout.write('{}')" } : {});
      assert.equal(r.indexCommitted, false); assert.equal(r.status, 'failed'); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), old); await verifyAlignment(f.dir, first.alignmentId);
    } finally { f.clean(); }
  });
test('custom policy source/adopted identity stays valid after live policy revision', async () => {
  const f = await fixture(); try {
    const supplied = { ...DEFAULT_ALIGNMENT_POLICY, maxSamples: 3200 }; save(join(f.dir, 'inputs/alignment-policy.json'), supplied);
    const { result: r } = await synthetic(() => alignAsset(f.dir, f.selection)), m = await verifyAlignment(f.dir, r.alignmentId);
    assert.equal(m.policySourceSha256, sha(importJsonText(supplied))); save(join(f.dir, 'inputs/alignment-policy.json'), DEFAULT_ALIGNMENT_POLICY);
    await verifyAlignment(f.dir, r.alignmentId); const adopted = join(f.dir, 'runs', r.attemptId, 'alignment-policy.adopted.json'), old = fs.readFileSync(adopted);
    fs.appendFileSync(adopted, ' '); try { await assert.rejects(verifyAlignment(f.dir, r.alignmentId), /POLICY/); } finally { fs.writeFileSync(adopted, old); }
  } finally { f.clean(); }
});
test('before and after effect index EIO follow published reality', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), before = fs.readFileSync(join(f.dir, 'assets/alignment.json')), rename = fsPromises.rename;
    try {
      fsPromises.rename = async (src, dst) => { if (String(dst) === join(f.dir, 'assets/alignment.json')) throw Object.assign(Error('before EIO'), { code: 'EIO' }); return rename(src, dst); }; syncBuiltinESMExports();
      const { result: failedReceipt } = await synthetic(() => failed(f.dir, f.selection)); assert.equal(failedReceipt.indexCommitted, false); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), before);
      fsPromises.rename = async (src, dst) => { await rename(src, dst); if (String(dst) === join(f.dir, 'assets/alignment.json')) throw Object.assign(Error('after EIO'), { code: 'EIO' }); }; syncBuiltinESMExports();
      const { result: succeeded } = await synthetic(() => alignAsset(f.dir, f.selection).catch((error: AlignmentFailure) => error.receipt));
      assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.indexCommitted, true); await verifyAlignment(f.dir, succeeded.alignmentId);
    } finally { fsPromises.rename = rename; syncBuiltinESMExports(); }
    await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});
test('abort and concurrent lease collision preserve previous version', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), old = fs.readFileSync(join(f.dir, 'assets/alignment.json')), controller = new AbortController(); controller.abort();
    assert.equal((await failed(f.dir, f.selection, { signal: controller.signal })).status, 'interrupted');
    await synthetic(() => alignAsset(f.dir, f.selection, { hooks: { afterPrepared: async () => {
      const collision = await failed(f.dir, f.selection); assert.match(collision.error!, /ALIGNMENT_BUSY/); assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), old);
    } } })); await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});
test('native tool timeout and in-flight cancellation persist invocation facts and preserve old commit', async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), old = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    save(join(f.dir, 'inputs/alignment-policy.json'), { ...DEFAULT_ALIGNMENT_POLICY, maxToolElapsedMs: 50 });
    const { result: timeout } = await synthetic(() => failed(f.dir, f.selection), { code: 'setInterval(()=>{},1000)' });
    assert.match(timeout.error!, /TOOL_TIME_LIMIT/); assert.ok(timeout.tool); assert.equal(timeout.indexCommitted, false);
    fs.unlinkSync(join(f.dir, 'inputs/alignment-policy.json')); const controller = new AbortController();
    const { result: aborted } = await synthetic(() => failed(f.dir, f.selection, { signal: controller.signal }), { code: 'setInterval(()=>{},1000)', before: () => { setTimeout(() => controller.abort(), 20); } });
    assert.equal(aborted.status, 'interrupted'); assert.ok(aborted.tool); assert.equal(aborted.indexCommitted, false);
    assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), old); await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});
for (const phase of ['aligning', 'prepared', 'committed'] as const) test(`real SIGKILL at ${phase} recovers the durable alignment publication boundary`, async () => {
  const f = await fixture(); try {
    const { result: first } = await synthetic(() => alignAsset(f.dir, f.selection)), old = fs.readFileSync(join(f.dir, 'assets/alignment.json'));
    const hook = phase === 'aligning' ? "onPhase:async r=>{if(r.phase==='aligning')process.kill(process.pid,'SIGKILL')}" : phase === 'prepared' ? "afterPrepared:async()=>process.kill(process.pid,'SIGKILL')" : "afterIndexCommitted:async()=>process.kill(process.pid,'SIGKILL')";
    const raw = provider('placeholder'), code = `const cp=(await import('node:child_process')).default;const {syncBuiltinESMExports}=await import('node:module');const spawn=cp.spawn;cp.spawn=(e,a,o)=>{if(String(e).endsWith('/assets/asr/bin/whisper-cli')){const r=${JSON.stringify(raw)};r.params.model=a[a.indexOf('-m')+1];return spawn(process.execPath,['-e','process.stdout.write('+JSON.stringify(JSON.stringify(r))+')'],o)}return spawn(e,a,o)};syncBuiltinESMExports();const {alignAsset}=await import(${JSON.stringify(new URL('../src/application/alignment.ts', import.meta.url).href)});await alignAsset(${JSON.stringify(f.dir)},${JSON.stringify(f.selection)},{hooks:{${hook}}});`;
    const killed = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000 }); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const pending = fs.readdirSync(join(f.dir, 'runs')).filter(name => /^alignment-attempt-/.test(name)).map(name => json(join(f.dir, 'runs', name, 'receipt.json'))).find(r => ['running', 'prepared'].includes(r.status)); assert.ok(pending);
    if (phase !== 'committed') { assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), old); await assert.rejects(verifyAlignment(f.dir, pending.alignmentId), /NOT_COMMITTED/); }
    else await verifyAlignment(f.dir, pending.alignmentId);
    const recovered = await recoverAlignmentAttempts(f.dir); assert.equal(recovered.length, 1); assert.equal(recovered[0]!.status, phase === 'committed' ? 'succeeded' : 'interrupted');
    assert.equal(recovered[0]!.indexCommitted, phase === 'committed'); assert.deepEqual(await recoverAlignmentAttempts(f.dir), []);
    assert.equal(fs.existsSync(join(f.dir, 'runs/alignment.lock')), false); await verifyAlignment(f.dir, first.alignmentId);
  } finally { f.clean(); }
});
