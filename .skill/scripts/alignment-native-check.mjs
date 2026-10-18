import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function wave(samples) {
  const b = Buffer.alloc(44 + samples * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40); return b;
}

/** Fictional sources and real CPU token output, tied to the exact sealed candidate. */
export async function checkAlignmentNative({ scratch, skill, check, denied }) {
  const root = join(scratch, 'alignment workspace'), core = join(root, '.skill'), project = join(root, 'projects/alignment-film');
  const selected = join(scratch, 'alignment sources'), records = join(dirname(scratch), 'alignment-native-evidence', randomUUID());
  mkdirSync(records, { recursive: true }); mkdirSync(scratch, { recursive: true }); mkdirSync(selected); mkdirSync(root);
  const manifestBytes = readFileSync(join(skill, 'manifest.json')), packageId = JSON.parse(manifestBytes).packageId;
  const sourceIdentity = ['engine/src/project/alignment.ts', 'engine/src/application/alignment.ts', 'engine/src/adapters/alignment-json.ts',
    'engine/src/adapters/alignment-map.ts', 'engine/src/application/catalog.ts', 'engine/src/adapters/project-lease.ts', 'engine/workspace.mjs',
    'engine/src/cli/index.ts', 'scripts/video.mjs', 'scripts/alignment-native-check.mjs', 'engine/asr-dependencies.lock.json'].map(path => ({ path, sha256: sha(readFileSync(join(skill, path))) }));
  save(join(records, 'identity.json'), { packageId, manifestSha256: sha(manifestBytes), sourceIdentity, host: { platform: process.platform, arch: process.arch, node: process.version },
    runtime: json(join(skill, 'engine/asr-dependencies.lock.json')), claims: { timing: 'provider estimates', listening: 'unverified', recognitionAccuracy: 'not measured', hardRss: 'not claimed' } });
  let ordinal = 0; const groups = [], log = value => appendFileSync(join(records, 'commands.jsonl'), JSON.stringify(value) + '\n');
  const collect = (cwd, executable, argv, expected = 0, timeout = 210000) => {
    const id = `command-${String(++ordinal).padStart(4, '0')}`, began = Date.now(), startedAt = new Date().toISOString();
    const r = spawnSync(executable, argv, { cwd, encoding: 'utf8', timeout, killSignal: 'SIGKILL', detached: true, maxBuffer: 32 * 1024 * 1024 });
    let cleanup = 'no-pid', cleanupError;
    if (r.pid) try { process.kill(-r.pid, 'SIGKILL'); cleanup = 'SIGKILL-sent'; } catch (e) { if (e.code === 'ESRCH') cleanup = 'already-exited'; else { cleanupError = e; cleanup = 'failed'; } }
    const stdout = r.stdout ?? '', stderr = r.stderr ?? ''; writeFileSync(join(records, id + '.stdout.log'), stdout); writeFileSync(join(records, id + '.stderr.log'), stderr);
    const exitAccepted = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
    log({ id, packageId, cwd, executable, argv, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - began, timeoutMs: timeout,
      expectedExitCode: expected, exitCode: r.status, signal: r.signal, stdoutSha256: sha(stdout), stderrSha256: sha(stderr),
      error: r.error?.message ?? cleanupError?.message ?? null, collectorPid: r.pid ?? null, collectorGroupCleanup: cleanup,
      status: r.error || cleanupError || !exitAccepted ? 'failed' : 'passed' });
    if (r.error || cleanupError) throw r.error ?? cleanupError; assert.ok(exitAccepted, `${argv.join(' ')}\n${stderr}\n${stdout}`);
    return stdout + (expected === 1 ? stderr : '');
  };
  const control = (args, expected = 0) => collect(root, process.execPath, [join(core, 'scripts/video.mjs'), ...args], expected);
  const catalog = (args, expected = 0) => JSON.parse(control(['alignment-film', 'catalog', ...args], expected));
  const align = (args, expected = 0) => JSON.parse(control(['alignment-film', 'align', ...args], expected));
  const verify = id => align(['--verify', id]).manifest;
  const gate = async (name, action) => {
    const began = Date.now(); try { await check(name, action); groups.push(name); log({ kind: 'gate', name, packageId, status: 'passed', elapsedMs: Date.now() - began }); }
    catch (error) { log({ kind: 'gate', name, packageId, status: 'failed', elapsedMs: Date.now() - began, error: String(error.stack ?? error) }); throw error; }
  };
  let defaults, makeSubject, policy, imported, catalogManifest, selectedAsset, initialReceipt, initialManifest;
  const scripts = {}, fixtures = [['zh', 'Tingting', '蓝色纸船经过安静的小岛。'], ['en', 'Samantha', 'A blue paper boat passes a quiet island.']];
  const script = (language, text) => {
    const p = `inputs/${language}-script.json`, s = { version: '0.1', kind: 'alignment-script', language, lineId: `${language}-line`, text };
    const approval = readFileSync(join(project, 'inputs/approval.txt')); save(join(project, p), { ...s, approval: { scope: 'word-alignment', basis: 'delegated', decisionId: `fictional-${language}-approval`,
      sourceRef: { path: 'inputs/approval.txt', bytes: approval.length, sha256: sha(approval) }, subjectSha256: makeSubject(s) } }); return p;
  };
  const selection = (a, scriptPath) => ['--catalog', catalogManifest.catalogId, '--asset', a.assetId, '--version', a.assetVersion, '--script', scriptPath];
  try {
    await gate('Alignment 离线声线、独立影片与16k原件准入', async () => {
      cpSync(skill, core, { recursive: true }); const lock = json(join(core, 'engine/asr-dependencies.lock.json'));
      for (const [language, voice, text] of fixtures) {
        const textPath = join(selected, `${language}.txt`), aiff = join(selected, `${language}.aiff`), wav = join(selected, `${language}.wav`); writeFileSync(textPath, text + '\n');
        collect(root, '/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', '/usr/bin/say', '-v', voice, '-f', textPath, '-o', aiff], 0, 60000);
        assert.ok(readFileSync(aiff).length > 0);
        collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', aiff, '-map', '0:a:0', '-vn', '-threads', '1', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', wav], 0, 60000);
        const bytes = readFileSync(wav); log({ kind: 'fixture', language, voice, text, generator: '/usr/bin/say', network: 'deny network*', bytes: bytes.length, sha256: sha(bytes), sourcePath: wav });
      }
      writeFileSync(join(selected, 'long.wav'), wave(1920000)); writeFileSync(join(selected, 'silence.wav'), wave(16000));
      for (const slug of ['alignment-film', 'alignment-other']) control(['start', '--theme', 'minimal', slug, '--idea', '虚构离线词级对齐门禁']);
      mkdirSync(join(project, 'inputs'), { recursive: true });
      const domain = await import(pathToFileURL(join(core, 'engine/src/project/alignment.ts')).href); defaults = domain.DEFAULT_ALIGNMENT_POLICY; makeSubject = domain.alignmentSubjectSha256;
      policy = patch => save(join(project, 'inputs/alignment-policy.json'), { ...defaults, ...patch }); policy({});
      writeFileSync(join(project, 'inputs/approval.txt'), 'Fictional delegated approval for exact alignment subjects.\n');
      for (const [language, , text] of fixtures) scripts[language] = script(language, text);
      imported = JSON.parse(control(['alignment-film', 'import', '--source', selected])); const r = catalog(['--import', imported.importId]); catalogManifest = catalog(['--verify', r.catalogId]).manifest;
      assert.equal(align(['--schema', 'map']).$schema, 'http://json-schema.org/draft-07/schema#');
    });
    await gate('Alignment 真实中英token时间、完整批准稿与原始波形oracle', () => {
      for (const [language] of fixtures) {
        const a = catalogManifest.assets.find(a => a.source.path === `${language}.wav`); assert.ok(a); const r = align(selection(a, scripts[language])); assert.equal(r.status, 'succeeded');
        const m = verify(r.alignmentId), map = json(join(project, m.map.path)), raw = json(join(project, m.raw.path)), original = readFileSync(join(project, a.source.fixedPath));
        assert.ok(raw.transcription.some(s => s.tokens.length > 0)); assert.ok(map.coverage.estimatedUnits > 0); assert.equal(map.coverage.listening, 'unverified');
        assert.equal(map.coverage.submittedSampleEnd, m.audio.samples); assert.equal(map.coverage.scriptBytes, Buffer.byteLength(fixtures.find(f => f[0] === language)[2]));
        assert.deepEqual(readFileSync(join(project, m.audio.path)).subarray(44), original.subarray(m.source.wave.dataOffset, m.source.wave.dataOffset + m.source.wave.dataBytes));
        const pcm = a.technical.evidence.find(e => e.kind === 'audio-pcm'); assert.deepEqual(readFileSync(join(project, pcm.path)), original.subarray(m.source.wave.dataOffset, m.source.wave.dataOffset + m.source.wave.dataBytes));
        assert.equal(m.tool.exitCode, 0); assert.equal(m.tool.binaryBytes, m.raw.bytes); assert.ok(m.tool.argv.includes('-ojf')); assert.equal(m.tool.stdoutBytes, 0);
        log({ kind: 'alignment-smoke', language, alignmentId: r.alignmentId, approvedText: fixtures.find(f => f[0] === language)[2], recognizedText: readFileSync(join(project, m.recognized.path), 'utf8'), coverage: map.coverage, sourceOracle: 'original RIFF data == catalog PCM == canonical payload', mapStatus: map.status });
        if (language === 'en') { selectedAsset = a; initialReceipt = r; initialManifest = m; }
      }
    });
    await gate('Alignment mismatch/blank与静音处理保留明确unknown和旧结果', () => {
      const old = readFileSync(join(project, initialReceipt.manifestPath));
      for (const text of ['quasar quasar quasar', '', '... 🚢\n']) {
        const p = script('en', text), r = align(selection(selectedAsset, p)), m = verify(r.alignmentId), map = json(join(project, m.map.path));
        assert.equal(map.coverage.estimatedUnits, 0); assert.equal(map.status, 'unknown'); assert.ok(map.units.every(u => u.basis === 'unknown' && u.sampleStart === null && u.sampleEnd === null));
      }
      scripts.en = script('en', fixtures[1][2]); assert.deepEqual(readFileSync(join(project, initialReceipt.manifestPath)), old); verify(initialReceipt.alignmentId);
      const a = catalogManifest.assets.find(a => a.source.path === 'silence.wav'), before = readFileSync(join(project, 'assets/alignment.json'));
      const output = collect(root, process.execPath, [join(core, 'scripts/video.mjs'), 'alignment-film', 'align', ...selection(a, scripts.en)], [0, 1]);
      // The collector records the actual exit; semantic silence is an independent known fixture.
      const r = JSON.parse(output); if (r.status === 'succeeded') { const m = verify(r.alignmentId); log({ kind: 'silence', status: r.status, map: json(join(project, m.map.path)), semanticSilence: 'digital-zero fixture', listening: 'unverified' }); }
      else { assert.ok(['failed', 'interrupted'].includes(r.status)); assert.equal(r.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/alignment.json')), before); log({ kind: 'silence', status: r.status, reason: r.error, semanticSilence: 'digital-zero fixture' }); }
    });
    await gate('Alignment 源和七件产物替换、批准subject与配额失败保留索引', () => {
      const index = readFileSync(join(project, 'assets/alignment.json'));
      for (const relative of [selectedAsset.source.fixedPath, initialManifest.audio.path, initialManifest.scriptSnapshot.path, initialManifest.approvalSource.path, initialManifest.raw.path, initialManifest.recognized.path, initialManifest.map.path,
        '.engine/assets/asr/bin/whisper-cli', '.engine/assets/asr/models/ggml-base.bin', '.engine/asr-dependencies.lock.json']) {
        const p = join(project, relative), bytes = readFileSync(p), altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; writeFileSync(p, altered);
        try { assert.match(control(['alignment-film', 'align', '--verify', initialReceipt.alignmentId], 1), /CHANGED|INVALID|Error|INTEGRITY|验证/); } finally { writeFileSync(p, bytes); } verify(initialReceipt.alignmentId);
      }
      for (const patch of [{ maxSourceBytes: 1 }, { maxTokens: 1 }, { maxRawBytes: 1 }, { maxMapBytes: 1 }, { maxSourceReadBytes: 1 }]) {
        policy(patch); const r = align(selection(selectedAsset, scripts.en), 1); assert.equal(r.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/alignment.json')), index);
      }
      policy({}); verify(initialReceipt.alignmentId);
    });
    await gate('Alignment 实际移根复查与旧版本冻结', () => {
      const movedRoot = join(scratch, 'alignment relocated workspace'), moved = join(movedRoot, 'projects/alignment-film'); mkdirSync(join(movedRoot, 'projects'), { recursive: true });
      cpSync(core, join(movedRoot, '.skill'), { recursive: true }); cpSync(project, moved, { recursive: true });
      collect(movedRoot, process.execPath, [join(movedRoot, '.skill/scripts/video.mjs'), 'alignment-film', 'align', '--verify', initialReceipt.alignmentId]); verify(initialReceipt.alignmentId);
    });
    await gate('Alignment 实际最小env、输入/历史证据只读、后代与零网络连接', async () => {
      const outside = join(scratch, 'alignment unselected'), escape = join(scratch, 'alignment escape'); writeFileSync(outside, 'fictional');
      const runPath = join(project, 'runs', initialReceipt.attemptId), attempts = [
        `fs.readFileSync(${JSON.stringify(outside)})`, `fs.readFileSync(${JSON.stringify(join(root, 'projects/alignment-other/director.json'))})`,
        ...[join(project, scripts.en), join(project, 'inputs/approval.txt'), join(project, 'inputs/alignment-policy.json'), join(project, selectedAsset.source.fixedPath),
          ...[initialManifest.audio.path, initialManifest.scriptSnapshot.path, initialManifest.approvalSource.path, initialManifest.raw.path, initialManifest.recognized.path, initialManifest.map.path, initialReceipt.manifestPath].map(p => join(project, p)),
          ...readdirSync(runPath).filter(n => n !== 'receipt.json').map(n => join(runPath, n)), join(project, '.engine/assets/asr/models/ggml-base.bin'), escape, '/dev/zero'].map(p => `fs.writeFileSync(${JSON.stringify(p)},'x')`)];
      const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`; let connections = 0; const server = createServer(s => { connections++; s.destroy(); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
      try {
        const code = `${probe}const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.HOME||process.env.NODE_OPTIONS||process.env.DYLD_LIBRARY_PATH||process.env.GGML_BACKEND_PATH||process.env.JBM_ALIGNMENT_SECRET)process.exit(17);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code)});`;
        const launch = `const{runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_ALIGNMENT_SECRET='fictional';process.env.GGML_BACKEND_PATH='fictional';process.env.DYLD_LIBRARY_PATH='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['align','--verify','id']));`;
        const output = collect(root, process.execPath, ['--input-type=module', '-e', launch]); assert.equal((output.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1);
        await wait(10); assert.equal(connections, 0); assert.equal(existsSync(escape), false); log({ kind: 'network-observation', connections, descendants: true, status: 'passed' });
      } finally { await new Promise(r => server.close(r)); } verify(initialReceipt.alignmentId);
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) await gate(`Alignment 真实统一入口${signal}与耐久恢复`, async () => {
      const a = catalogManifest.assets.find(a => a.source.path === 'long.wav'), before = readFileSync(join(project, 'assets/alignment.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
      const argv = [join(core, 'scripts/video.mjs'), 'alignment-film', 'align', ...selection(a, scripts.en)], began = Date.now(), child = spawn(process.execPath, argv, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); const closed = new Promise(r => child.once('close', (exitCode, exitSignal) => r({ exitCode, exitSignal })));
      let active, lastReceipt;
      try {
        // Startup includes the backup and replay of prior evidence; use the alignment command budget.
        const deadline = Date.now() + 210000; while (!active && Date.now() < deadline) {
          for (const n of readdirSync(runs).filter(n => n.startsWith('alignment-attempt-') && !known.has(n))) try { const r = json(join(runs, n, 'receipt.json')); lastReceipt = r; if (r.phase === 'aligning' && r.status === 'running') active = r; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (child.exitCode !== null || child.signalCode !== null) break;
          if (!active) await wait(10);
        }
        assert.ok(active, JSON.stringify({ elapsedMs: Date.now() - began, lastReceipt, exitCode: child.exitCode, signalCode: child.signalCode }) + stdout + stderr); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal);
        let timer; const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('ALIGNMENT_INTERRUPT_COLLECTOR_TIMEOUT')), 15000); })]).finally(() => clearTimeout(timer));
        writeFileSync(join(records, `interrupt-${signal}.stdout.log`), stdout); writeFileSync(join(records, `interrupt-${signal}.stderr.log`), stderr);
        log({ kind: 'interrupt', packageId, executable: process.execPath, argv, cwd: root, signal, ...result, elapsedMs: Date.now() - began, stdoutSha256: sha(stdout), stderrSha256: sha(stderr), scope: 'unified entry relay and durable recovery' });
        if (signal === 'SIGKILL') assert.equal(result.exitSignal, signal); else { assert.equal(result.exitCode, 1, stderr + stdout); assert.equal(JSON.parse(stdout).status, 'interrupted'); }
        assert.deepEqual(readFileSync(join(project, 'assets/alignment.json')), before);
        const recovery = align(['--recover']); if (signal === 'SIGKILL') assert.ok(recovery.receipts.some(r => r.attemptId === active.attemptId && r.status === 'interrupted'));
        assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'alignment.lock')), false); verify(initialReceipt.alignmentId);
      } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } await closed; }
    });
    save(join(records, 'result.json'), { packageId, status: 'passed', groups, sourceIdentity, timing: 'estimated', listening: 'unverified', accuracy: 'not measured' }); return { groups, records };
  } finally {
    // Capture exact project evidence before the caller deletes its scratch workspace.
    if (existsSync(project)) cpSync(project, join(records, 'project'), { recursive: true, filter: p => !p.startsWith(join(project, '.engine')) });
    cpSync(selected, join(records, 'sources'), { recursive: true });
    save(join(records, 'archive.json'), { packageId, projectEngine: 'Reconstruct from this exact sealed package; .engine is deliberately omitted from the evidence archive.', records });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const { root, skill, verifyCore } = await import('./core.mjs'); verifyCore(); const output = join(root, '.research/out'); mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(output, 'alignment-preflight-')), check = async (name, action) => { await action(); process.stdout.write(`✓ ${name}\n`); };
  const denied = expression => `try{${expression};process.exit(17)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('DENIED:'+e.code)}`;
  try { const result = await checkAlignmentNative({ scratch, skill, check, denied }); process.stdout.write(JSON.stringify(result) + '\n'); } finally { rmSync(scratch, { recursive: true, force: true }); }
}
