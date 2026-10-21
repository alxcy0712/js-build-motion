import { nativeCollector } from './native-runner.mjs';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const evidence = (a, kind) => a.technical.evidence.find(e => e.kind === kind);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function wave(n, rate = 16000, channels = 1) {
  const bytes = n * channels * 2, b = Buffer.alloc(44 + bytes); b.write('RIFF'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
function observation(a, s) {
  const d = a.technical.asr;
  return { version: '0.4', id: `observation-${randomUUID()}`, assetId: a.assetId, assetVersion: a.assetVersion, byteSha256: a.source.sha256,
    method: 'fictional native ASR suggestion review', locator: { kind: 'asr', evidenceId: d.textEvidenceId, mapEvidenceId: d.mapEvidenceId, audioEvidenceId: d.audioEvidenceId, segmentId: s.id, byteStart: s.byteStart, byteEnd: s.byteEnd },
    coverage: 'full', coverageScope: 'segment-asr-text', statement: 'The recorded provider suggestion segment was read.', basis: 'estimated', confidence: null,
    limitations: ['Timing and wording are provider estimates. Human listening and recognition quality are separate evidence.'], evidenceRefs: [d.textEvidenceId, d.mapEvidenceId, d.audioEvidenceId] };
}

/** Independent fictional audio. Core/manifest writers remain with the main agent. */
export async function checkAsrNative({ scratch, skill, run, check, denied }) {
  const groups = [], root = join(scratch, 'asr workspace'), core = join(root, '.skill'), project = join(root, 'projects/asr-film'), other = join(root, 'projects/asr-other');
  const selected = join(scratch, 'asr sources'), records = join(scratch, 'asr evidence'); mkdirSync(records, { recursive: true });
  const manifestBytes = readFileSync(join(skill, 'manifest.json')), packageId = JSON.parse(manifestBytes).packageId;
  const sourceIdentity = ['engine/src/project/asr.ts', 'engine/src/project/catalog.ts', 'engine/src/application/catalog.ts', 'engine/src/adapters/asr-wav.ts', 'engine/src/adapters/asr-json.ts', 'engine/src/adapters/inspection-asr.ts', 'engine/workspace.mjs', 'engine/asr-dependencies.lock.json', 'scripts/asr-native-check.mjs', 'engine/test/catalog-asr.test.ts', 'engine/test/asr-security.test.ts'].map(path => ({ path, sha256: sha(readFileSync(join(skill, path))) }));
  save(join(records, 'identity.json'), { packageId, manifestSha256: sha(manifestBytes), sourceIdentity, runtime: json(join(skill, 'engine/asr-dependencies.lock.json')), stdoutPatchSha256: sha(readFileSync(join(skill, 'engine/assets/asr/stdout-stream.patch'))), host: { platform: process.platform, arch: process.arch, node: process.version }, recognitionAccuracy: 'not measured', humanListening: 'not performed' });
  const log = value => appendFileSync(join(records, 'commands.jsonl'), JSON.stringify(value) + '\n');
  // Catalog alone has a 330s outer collector; unrelated calls keep their existing 60s default.
  const collect = nativeCollector({ records, packageId, timeoutMs: 60000, stderrMode: 'truthy', cleanupErrorCode: 'ASR_COLLECTOR_GROUP_TERMINATION_FAILED' });
  const control = (args, expected = 0, timeout = args[1] === 'catalog' ? 330000 : 60000) => collect(root, process.execPath, [join(core, 'scripts/video.mjs'), ...args], expected, timeout);
  const catalog = (args, expected = 0) => JSON.parse(control(['asr-film', 'catalog', ...args], expected));
  const verify = id => catalog(['--verify', id]).manifest;
  const imported = source => JSON.parse(control(['asr-film', 'import', '--source', source]));
  let initialPolicy, initialReceipt, initialManifest, initialAsset, initialImport, lock;
  const policy = (asr = {}, general = {}) => {
    mkdirSync(join(project, 'inputs'), { recursive: true });
    save(join(project, 'inputs/inspect-policy.json'), { ...initialPolicy, ...general, asr: { ...initialPolicy.asr, enabled: true, ...asr } });
  };
  const gate = async (name, action) => {
    const start = Date.now(); try { await check(name, action); groups.push(name); log({ kind: 'gate', name, packageId, status: 'passed', elapsedMs: Date.now() - start }); }
    catch (error) { log({ kind: 'gate', name, packageId, status: error.code === 'ASR_FIXTURE_DEPENDENCY' ? 'blocked' : 'failed', error: String(error.stack ?? error), elapsedMs: Date.now() - start }); throw error; }
  };
  await gate('ASR 本地中英文声线 network-deny preflight 与虚构音频来源', async () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected); lock = json(join(core, 'engine/asr-dependencies.lock.json'));
    const fixtures = [['zh', 'Tingting', '这是一段虚构测试。蓝色纸船经过安静的小岛。', 16000, 1], ['en', 'Samantha', 'An imaginary amber boat passes a quiet island.', 44100, 2]];
    const offline = '(version 1) (allow default) (deny network*)';
    for (const [language, voice, text, rate, channels] of fixtures) {
      const script = join(selected, `${language}-script.txt`), aiff = join(selected, `${language}.aiff`), wav = join(selected, `${language}.wav`); writeFileSync(script, text + '\n');
      try { collect(root, '/usr/bin/sandbox-exec', ['-p', offline, '/usr/bin/say', '-v', voice, '-f', script, '-o', aiff]); }
      catch (error) { throw Object.assign(new Error(`ASR_FIXTURE_DEPENDENCY: offline ${voice} failed; existing enumeration supplies no voice-byte proof`, { cause: error }), { code: 'ASR_FIXTURE_DEPENDENCY' }); }
      assert.ok(existsSync(aiff) && readFileSync(aiff).length > 0);
      collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', aiff, '-map', '0:a:0', '-vn', '-threads', '1', '-ar', String(rate), '-ac', String(channels), '-c:a', 'pcm_s16le', '-f', 'wav', wav]);
      log({ kind: 'fixture', language, voice, text, generator: '/usr/bin/say', networkPolicy: 'deny network*', aiffSha256: sha(readFileSync(aiff)), sourcePath: wav, sourceBytes: readFileSync(wav).length, sourceSha256: sha(readFileSync(wav)), rate, channels, status: 'passed' });
    }
    writeFileSync(join(selected, 'silence.wav'), wave(16000));
    for (const slug of ['asr-film', 'asr-other']) control(['start', '--theme', 'minimal', slug, '--idea', '虚构离线 ASR 门禁']);
    const { DEFAULT_INSPECT_POLICY } = await import(pathToFileURL(join(core, 'engine/src/project/catalog.ts')).href); initialPolicy = DEFAULT_INSPECT_POLICY; assert.equal(initialPolicy.version, '0.4'); assert.equal(initialPolicy.asr.enabled, false);
    policy(); initialImport = imported(selected);
  });
  await gate('ASR 真实JSON stdout管道、中英/静音完整四证据与段级定位', () => {
    const assets = [];
    for (const language of ['zh', 'en']) {
      policy({ language }); const r = catalog(['--import', initialImport.importId, '--path', `${language}.wav`]), m = verify(r.catalogId), a = m.assets.at(-1); assets.push(a);
      assert.equal(a.technical.status, 'supported', a.technical.reason); assert.equal(a.technical.asr.status, 'completed', a.technical.asr.reason); assert.ok(evidence(a, 'text').bytes > 0);
      validateGroup(project, a, r); log({ kind: 'recognition-smoke', language, sourceSha256: a.source.sha256, text: readFileSync(join(project, evidence(a, 'text').path), 'utf8'), transcriptQuality: 'script difference recorded; accuracy not certified', status: 'passed' });
      if (language === 'zh') { initialReceipt = r; initialAsset = a; }
    }
    policy(); const silent = catalog(['--import', initialImport.importId, '--path', 'silence.wav']), a = verify(silent.catalogId).assets.at(-1);
    if (['completed', 'no-text'].includes(a.technical.asr.status)) {
      validateGroup(project, a, silent); const map = json(join(project, evidence(a, 'asr-map').path)); assert.equal(a.technical.asr.status === 'no-text', map.segments.length === 0); assert.equal(map.status === 'no-text', evidence(a, 'text').bytes === 0);
    } else { assert.equal(a.technical.status, 'partial'); assert.equal(a.technical.asr.status, 'failed'); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-') || e.kind === 'text'), false); assert.ok(silent.tools.some(t => t.version === '1.9.5/asr-json@0.1' && t.binaryBytes > 0)); }
    // Preserve a separately identified raw audit when the failed four-file group was withdrawn.
    const auditAudio = join(project, 'out/.tmp/silence-audit.wav'), auditCwd = join(project, 'out/.tmp/silence-audit-cwd'); writeFileSync(auditAudio, wave(16000)); mkdirSync(auditCwd);
    const audit = `const {runInspectionTool}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/src/adapters/inspection.ts')).href)});const {asrArguments}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/src/project/asr.ts')).href)});const {asrRuntimePaths}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});const {program,model}=asrRuntimePaths();const chunks=[];const r=await runInspectionTool({executable:'/usr/bin/time',version:'Darwin-time-l/asr-native-audit',argv:['-l',program,...asrArguments('zh',model,${JSON.stringify(auditAudio)})],cwd:${JSON.stringify(auditCwd)},policy:${JSON.stringify({ ...initialPolicy, maxToolElapsedMs: 120000 })},binaryLimit:4194304,binary:async b=>chunks.push(Buffer.from(b))});console.log(JSON.stringify({run:r,raw:Buffer.concat(chunks).toString('base64')}));`;
    const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'--input-type=module','-e',${JSON.stringify(audit)}],importCommandOptions(['catalog','--schema','asr-map']));`;
    const rawAudit = JSON.parse(collect(root, process.execPath, ['--input-type=module', '-e', launch], 0, 330000)), rawBytes = Buffer.from(rawAudit.raw, 'base64'); writeFileSync(join(records, 'silence.raw.json'), rawBytes); assert.equal(rawAudit.run.exitCode, 0); assert.equal(rawAudit.run.error, null); assert.equal(rawAudit.run.binaryBytes, rawBytes.length);
    const peak = /(?:^|\n)\s*(\d+)\s+maximum resident set size/.exec(rawAudit.run.stderr); assert.ok(peak, rawAudit.run.stderr); log({ kind: 'resource-observation', peakRssBytes: Number(peak[1]), measurement: '/usr/bin/time -l Darwin maximum resident set size for this one native invocation', hardLimit: 'none claimed', inputSamples: 16000, tool: rawAudit.run, sourceIdentity, status: 'passed' });
    log({ kind: 'silence-smoke', sourceSha256: a.source.sha256, providerStatus: a.technical.asr.status, reason: a.technical.asr.reason, text: evidence(a, 'text') ? readFileSync(join(project, evidence(a, 'text').path), 'utf8') : null, rawAuditSha256: sha(rawBytes), rawAudit: JSON.parse(rawBytes.toString()), rawAuditScope: 'separate explicitly identified native invocation; catalog result is recorded independently in providerStatus', semanticSilence: 'known digital fixture', recognitionAccuracy: 'not inferred', status: 'passed' });
    initialManifest = verify(silent.catalogId); assert.equal(catalog(['--schema', 'asr-map']).$schema, 'http://json-schema.org/draft-07/schema#');
  });
  await gate('ASR 建议稿estimated/unknown/null观察与原audio定位', () => {
    const map = json(join(project, evidence(initialAsset, 'asr-map').path)), rec = observation(initialAsset, map.segments[0]), path = join(project, 'inputs/asr-record.json'); save(path, rec);
    assert.deepEqual(verify(catalog(['--observation', 'inputs/asr-record.json']).catalogId).observations.at(-1), rec); const before = readFileSync(join(project, 'assets/catalog.json'));
    for (const change of [{ basis: 'observed' }, { confidence: 0.9 }, { locator: { ...rec.locator, segmentId: 'asr-segment-999999' } }, { evidenceRefs: [rec.locator.evidenceId] }]) {
      save(path, { ...rec, id: `observation-${randomUUID()}`, ...change }); assert.equal(catalog(['--observation', 'inputs/asr-record.json'], 1).indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
    }
    const pcm = evidence(initialAsset, 'audio-pcm'), audio = { version: '0.1', id: `observation-${randomUUID()}`, assetId: initialAsset.assetId, assetVersion: initialAsset.assetVersion, byteSha256: initialAsset.source.sha256, method: 'fixture source PCM locator validation',
      locator: { kind: 'audio', evidenceId: pcm.id, byteStart: null, byteEnd: null, lineStart: null, lineEnd: null, x: null, y: null, width: null, height: null, streamIndex: pcm.streamIndex, timeBase: null, pts: null, sampleRate: pcm.sampleRate, sampleStart: 0, sampleEnd: pcm.samples },
      coverage: 'full', statement: 'This record validates the original PCM locator for the fictional source.', basis: 'observed', confidence: null, limitations: ['Human listening was not performed by this helper.'], evidenceRefs: [pcm.id] };
    save(path, audio); verify(catalog(['--observation', 'inputs/asr-record.json']).catalogId);
  });
  await gate('ASR 同源继承、原ToolRun、disabled与真实移根复查', () => {
    const frozen = readFileSync(join(project, initialReceipt.manifestPath)), before = verify(initialManifest.catalogId), duplicate = catalog(['--import', initialImport.importId, '--path', 'zh.wav']); assert.deepEqual(verify(duplicate.catalogId).assets, before.assets); assert.deepEqual(verify(duplicate.catalogId).tools, []);
    policy({ enabled: false }); const fresh = imported(join(selected, 'zh.wav')), r = catalog(['--import', fresh.importId]), a = verify(r.catalogId).assets.at(-1); assert.equal(a.technical.asr.status, 'disabled'); assert.ok(evidence(a, 'audio-pcm')); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-')), false); assert.deepEqual(readFileSync(join(project, initialReceipt.manifestPath)), frozen);
    const movedRoot = join(scratch, 'asr relocated workspace'), movedCore = join(movedRoot, '.skill'), moved = join(movedRoot, 'projects/asr-film');
    mkdirSync(join(movedRoot, 'projects'), { recursive: true }); cpSync(core, movedCore, { recursive: true }); cpSync(project, moved, { recursive: true });
    collect(movedRoot, process.execPath, [join(movedCore, 'scripts/video.mjs'), 'asr-film', 'catalog', '--verify', initialReceipt.catalogId], 0, 330000); policy();
  });
  await gate('ASR 源/PCM/四证据同长替换、runtime model和锁拒绝', () => {
    for (const relative of [initialAsset.source.fixedPath, ...initialAsset.technical.evidence.map(e => e.path), '.engine/assets/asr/models/ggml-base.bin', '.engine/asr-dependencies.lock.json']) {
      const path = join(project, relative), bytes = readFileSync(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; writeFileSync(path, changed);
      try { assert.match(control(['asr-film', 'catalog', '--verify', initialReceipt.catalogId], 1), /CHANGED|INVALID|Error|验证/); } finally { writeFileSync(path, bytes); } verify(initialReceipt.catalogId);
    }
  });
  await gate('ASR 局部额度保留PCM、五个被范围拒绝新WAV全批拒绝', () => {
    for (const limits of [{ maxAsrSourceBytes: 1 }, { maxAsrRawBytes: 1 }, { maxAsrMapBytes: 1 }]) {
      policy(limits); const imp = imported(join(selected, 'zh.wav')), r = catalog(['--import', imp.importId]), a = verify(r.catalogId).assets.at(-1);
      assert.equal(a.technical.status, 'partial', a.technical.reason); assert.ok(['failed', 'skipped'].includes(a.technical.asr.status)); assert.ok(evidence(a, 'audio-pcm')); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-')), false);
    }
    const five = join(scratch, 'asr five sources'); mkdirSync(five); for (let i = 0; i < 5; i++) writeFileSync(join(five, `${i}.wav`), wave(3200)); const imp = imported(five), before = readFileSync(join(project, 'assets/catalog.json')); policy({ maxAsrSourceBytes: 1 });
    assert.equal(catalog(['--import', imp.importId], 1).indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); policy();
  });
  await gate('ASR 各source rate/mono-stereo、小尾完整实测与极短skipped', () => {
    const sources = join(scratch, 'asr sample sources'); mkdirSync(sources);
    for (const [rate, channels, frames] of [[8000, 1, 4001], [22050, 2, 11029], [48000, 1, 24001], [16000, 1, 3199]]) {
      const name = `${rate}-${channels}-${frames}.wav`; writeFileSync(join(sources, name), wave(frames, rate, channels)); const imp = imported(join(sources, name)), r = catalog(['--import', imp.importId]), a = verify(r.catalogId).assets.at(-1), pcm = evidence(a, 'audio-pcm'); assert.equal(pcm.samples, frames); assert.equal(pcm.sampleRate, rate);
      if (frames === 3199) { assert.equal(a.technical.asr.status, 'skipped'); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-')), false); }
      else {
        const normalizedSamples = (r.counts.decodedAudioBytes - pcm.bytes) / 2; assert.ok(Number.isSafeInteger(normalizedSamples)); assert.ok(Math.abs(normalizedSamples * rate - frames * 16000) <= rate);
        if (['completed', 'no-text'].includes(a.technical.asr.status)) validateGroup(project, a, r);
        else { assert.equal(a.technical.asr.status, 'failed'); assert.equal(a.technical.status, 'partial'); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('asr-') || e.kind === 'text'), false); }
        log({ kind: 'resample-count', rate, channels, frames, normalizedSamples, normalizedExpectedNumerator: frames * 16000, sourceSha256: a.source.sha256, providerStatus: a.technical.asr.status, providerReason: a.technical.asr.reason, status: 'passed' });
      }
    }
  });
  await gate('ASR 实际最小env/backend/模型/旧证据/另一片/设备写与后代边界、网络连接零', async () => {
    const unselected = join(scratch, 'asr-unselected.txt'), escape = join(scratch, 'asr-escape'); writeFileSync(unselected, 'fictional');
    const attempts = [`fs.readFileSync(${JSON.stringify(unselected)})`, `fs.readFileSync(${JSON.stringify(join(other, 'director.json'))})`, `fs.readFileSync(${JSON.stringify(join(core, 'SKILL.md'))})`,
      ...[join(project, initialAsset.source.fixedPath), join(project, initialReceipt.manifestPath), ...initialAsset.technical.evidence.map(e => join(project, e.path)), join(project, '.engine/assets/asr/models/ggml-base.bin'), join(project, '.engine/assets/asr/bin/backend-injection'), escape, '/dev/zero'].map(path => `fs.writeFileSync(${JSON.stringify(path)},'x')`)];
    const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`; let connections = 0; const server = createServer(socket => { connections++; socket.destroy(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const code = `${probe}const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.HOME||process.env.NODE_OPTIONS||process.env.DYLD_LIBRARY_PATH||process.env.GGML_BACKEND_PATH||process.env.JBM_ASR_SECRET)process.exit(17);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code)});`;
      const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_ASR_SECRET='fictional';process.env.GGML_BACKEND_PATH='fictional';process.env.DYLD_LIBRARY_PATH='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['catalog','--schema','asr-map']));`;
      const output = collect(root, process.execPath, ['--input-type=module', '-e', launch]); assert.equal((output.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1); assert.match(output, /NETWORK_DENIED/); assert.equal(connections, 0); assert.equal(existsSync(escape), false); log({ kind: 'network-observation', connections, nativeEnvironment: 'minimal catalog sandbox plus descendants', status: 'passed' });
    } finally { await new Promise(resolve => server.close(resolve)); } verify(initialReceipt.catalogId);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) await gate(`ASR 真实统一入口${signal}与耐久receipt恢复`, async () => {
    policy(); const sources = join(scratch, `asr interrupt ${signal}`); mkdirSync(sources); for (let i = 0; i < 4; i++) writeFileSync(join(sources, `${i}.wav`), wave(16000 * 120));
    const imp = imported(sources), before = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs)), argv = [join(core, 'scripts/video.mjs'), 'asr-film', 'catalog', '--import', imp.importId];
    const child = spawn(process.execPath, argv, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); const closed = new Promise(resolve => child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal })));
    const start = Date.now(); let active, lastReceipt;
    try {
      // Startup includes the backup and replay of prior evidence; use the catalog command budget.
      const deadline = Date.now() + 330000; while (!active && Date.now() < deadline) {
        for (const name of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const r = json(join(runs, name, 'receipt.json')); lastReceipt = r; if (r.phase === 'inspecting' && r.status === 'running') active = r; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (child.exitCode !== null || child.signalCode !== null) break;
        if (!active) await wait(10);
      }
      assert.ok(active, JSON.stringify({ elapsedMs: Date.now() - start, lastReceipt, exitCode: child.exitCode, signalCode: child.signalCode }) + stdout + stderr); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal);
      let cancellationTimer; const result = await Promise.race([closed, new Promise((_, reject) => { cancellationTimer = setTimeout(() => reject(Error(`ASR_INTERRUPT_COLLECTOR_TIMEOUT:${signal}`)), 15000); })]).finally(() => clearTimeout(cancellationTimer));
      writeFileSync(join(records, `interrupt-${signal}.stdout.log`), stdout); writeFileSync(join(records, `interrupt-${signal}.stderr.log`), stderr); log({ kind: 'interrupt', executable: process.execPath, argv, cwd: root, packageId, startedAt: new Date(start).toISOString(), finishedAt: new Date().toISOString(), signal, ...result, stdoutSha256: sha(stdout), stderrSha256: sha(stderr), elapsedMs: Date.now() - start, scope: 'unified CLI interruption/publication recovery; detached native survival after parent SIGKILL is separate', status: 'passed' });
      if (signal === 'SIGKILL') assert.equal(result.exitSignal, signal); else { assert.equal(result.exitCode, 1, stdout + stderr); assert.equal(JSON.parse(stdout).status, 'interrupted'); }
      assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); policy({ enabled: false }); assert.equal(catalog(['--import', imp.importId, '--path', '0.wav']).status, 'succeeded'); assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false); verify(initialReceipt.catalogId);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await closed; policy(); }
  });
  save(join(records, 'result.json'), { packageId, status: 'passed', groups, humanListening: 'not performed', recognitionAccuracy: 'not measured', sourceIdentity }); return groups;
}
function validateGroup(project, a, receipt) {
  assert.ok(['completed', 'no-text'].includes(a.technical.asr.status), `${a.source.path}: ${a.technical.asr.reason}`); const d = a.technical.asr, map = json(join(project, evidence(a, 'asr-map').path));
  assert.equal(new Set([d.audioEvidenceId, d.jsonEvidenceId, d.textEvidenceId, d.mapEvidenceId]).size, 4); assert.equal(map.coverage.complete, true); assert.equal(map.coverage.submittedStart, 0); assert.equal(map.coverage.submittedEnd, map.audio.samples);
  for (const [kind, field] of [['asr-audio', 'audio'], ['asr-json', 'rawJson'], ['text', 'text']]) { const e = evidence(a, kind), b = readFileSync(join(project, e.path)); assert.equal(map[field].evidenceId, e.id); assert.equal(map[field].bytes, b.length); assert.equal(map[field].sha256, sha(b)); }
  const audio = readFileSync(join(project, evidence(a, 'asr-audio').path)), pcm = evidence(a, 'audio-pcm'); assert.equal(audio.length, 44 + map.audio.samples * 2); assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.readUInt32LE(4), audio.length - 8); assert.equal(audio.toString('ascii', 8, 16), 'WAVEfmt '); assert.equal(audio.readUInt32LE(16), 16); assert.equal(audio.readUInt16LE(20), 1); assert.equal(audio.readUInt16LE(22), 1); assert.equal(audio.readUInt32LE(24), 16000); assert.equal(audio.readUInt32LE(28), 32000); assert.equal(audio.readUInt16LE(32), 2); assert.equal(audio.readUInt16LE(34), 16); assert.equal(audio.toString('ascii', 36, 40), 'data'); assert.equal(audio.readUInt32LE(40), audio.length - 44);
  assert.equal(map.sourcePcm.samples, pcm.samples); assert.equal(map.sourcePcm.sampleRate, pcm.sampleRate); assert.equal(map.sourcePcm.evidenceId, pcm.id); assert.equal(pcm.coverage, 'full');
  if (map.source.wave.sampleRate === 16000 && map.source.wave.channels === 1) assert.deepEqual(audio.subarray(44), readFileSync(join(project, pcm.path)));
  const tool = receipt.tools.find(t => t.version === '1.9.5/asr-json@0.1'); assert.ok(tool); assert.equal(tool.exitCode, 0); assert.equal(tool.error, null); assert.equal(tool.stdoutBytes, 0); assert.equal(tool.binaryBytes, map.rawJson.bytes); assert.equal(tool.argv[tool.argv.indexOf('-of') + 1], '-'); assert.ok(tool.argv.includes('-np'));
  for (const s of map.segments) { assert.equal(s.sampleStart, s.rawStartMs * 16); assert.equal(s.sampleEnd, s.rawEndMs * 16 - s.clippedEndSamples); assert.ok(s.sampleStart < s.sampleEnd && s.sampleEnd <= map.audio.samples); assert.ok(s.clippedEndSamples >= 0 && s.clippedEndSamples <= 160); }
}
