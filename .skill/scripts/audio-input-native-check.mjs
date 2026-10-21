import { nativeCollector } from './native-runner.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function wave(samples, rate = 44100, channels = 2) {
  const data = Buffer.alloc(44 + samples * channels * 2); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * channels * 2, 40);
  for (let i = 0; i < samples; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(Math.round(2000 * Math.sin(i * 2 * Math.PI * (c ? 330 : 440) / rate)), 44 + (i * channels + c) * 2);
  return data;
}

/** Complete original decode, canonical reuse and real provider acceptance on the fixed host. */
export async function checkAudioInputNative({ scratch, skill, check }) {
  const root = join(scratch, 'bounded audio workspace'), core = join(root, '.skill'), project = join(root, 'projects/audio-film'), selected = join(scratch, 'bounded audio sources');
  const records = join(dirname(scratch), 'audio-input-native-evidence', randomUUID()); mkdirSync(records, { recursive: true }); mkdirSync(root); mkdirSync(selected);
  const packageId = json(join(skill, 'manifest.json')).packageId, lock = json(join(skill, 'engine/asr-dependencies.lock.json'));
  const sourceIdentity = ['engine/src/project/audio-input.ts', 'engine/src/adapters/audio-input.ts', 'engine/src/adapters/inspection-audio.ts', 'engine/src/adapters/inspection-asr.ts',
    'engine/src/application/catalog.ts', 'engine/src/application/alignment.ts', 'engine/src/project/asr.ts', 'engine/src/project/alignment.ts', 'engine/workspace.mjs', 'scripts/audio-input-native-check.mjs']
    .map(path => ({ path, sha256: sha(readFileSync(join(skill, path))) }));
  save(join(records, 'identity.json'), { packageId, sourceIdentity, host: { platform: process.platform, arch: process.arch, node: process.version },
    scope: 'complete-decoded-frames', presentationMapping: 'unknown', timing: 'estimated', listening: 'unverified' });
  const groups = [], log = value => appendFileSync(join(records, 'commands.jsonl'), JSON.stringify(value) + '\n');
  const collect = nativeCollector({ records, packageId, timeoutMs: 210000, stderrMode: 'never' });
  const control = (argv, expected = 0) => collect(root, process.execPath, [join(core, 'scripts/video.mjs'), ...argv], expected);
  const catalog = (argv, expected = 0) => JSON.parse(control(['audio-film', 'catalog', ...argv], expected));
  const align = (argv, expected = 0) => JSON.parse(control(['audio-film', 'align', ...argv], expected));
  const gate = async (name, action) => { const start = Date.now(); try { await check(name, action); groups.push(name); log({ kind: 'gate', packageId, name, status: 'passed', elapsedMs: Date.now() - start }); }
    catch (error) { log({ kind: 'gate', packageId, name, status: 'failed', error: String(error.stack ?? error) }); throw error; } };
  let inspectPolicy, alignmentPolicy, subject, imported, first, manifest, asrReceipt, alignmentReceipt;
  const commonMap = asset => json(join(project, asset.technical.evidence.find(e => e.id === asset.technical.audioInput.mapEvidenceId).path));
  const setPolicy = patch => save(join(project, 'inputs/inspect-policy.json'), { ...inspectPolicy, ...patch });
  const selection = asset => ['--catalog', manifest.catalogId, '--asset', asset.assetId, '--version', asset.assetVersion, '--script', 'inputs/script.json'];
  try {
    await gate('Audio input 四容器真实完整编码帧与原始采样oracle', async () => {
      cpSync(skill, core, { recursive: true }); writeFileSync(join(selected, 'known.wav'), wave(44273));
      for (const [name, codec, extra] of [['known.flac', 'flac', []], ['known.mp3', 'libmp3lame', ['-b:a', '128k']], ['known.m4a', 'aac', ['-profile:a', 'aac_low', '-b:a', '128k']]])
        collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', join(selected, 'known.wav'), '-map', '0:a:0', '-threads', '1', '-c:a', codec, ...extra, join(selected, name)]);
      control(['start', '--theme', 'minimal', 'audio-film', '--idea', '虚构有界音频容器验收']); mkdirSync(join(project, 'inputs'));
      const domain = await import(pathToFileURL(join(core, 'engine/src/project/catalog.ts')).href), alignment = await import(pathToFileURL(join(core, 'engine/src/project/alignment.ts')).href);
      inspectPolicy = domain.INSPECT_POLICY_05; alignmentPolicy = alignment.ALIGNMENT_POLICY_02; subject = alignment.alignmentSubjectSha256; setPolicy({});
      imported = JSON.parse(control(['audio-film', 'import', '--source', selected])); first = catalog(['--import', imported.importId]); manifest = catalog(['--verify', first.catalogId]).manifest;
      assert.equal(first.version, '0.5'); assert.equal(manifest.assets.length, 4);
      for (const asset of manifest.assets) {
        assert.equal(asset.technical.audioInput.status, 'completed'); assert.equal(asset.technical.asr.status, 'disabled');
        assert.equal(asset.technical.evidence.length, 4); const map = commonMap(asset), input = map.input, original = join(project, asset.source.fixedPath);
        const encodedFlags = input.format === 'mp3' ? ['-flags2', '+skip_manual'] : input.format === 'm4a' ? ['-ignore_editlist', '1'] : [];
        const oracle = collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-threads', '1', ...encodedFlags,
          '-f', input.demuxer, '-i', original, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(input.sampleRate), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], 0, true);
        const pcmItem = asset.technical.evidence.find(e => e.kind === 'audio-pcm'), audioItem = asset.technical.evidence.find(e => e.kind === 'audio-canonical');
        assert.deepEqual(readFileSync(join(project, pcmItem.path)), oracle); assert.equal(input.samples * 2, oracle.length); assert.equal(map.coverage.end, input.samples);
        if (input.format === 'wav' || input.format === 'flac') assert.equal(input.samples, 44273);
        else {
          const probe = JSON.parse(collect(root, lock.tools.ffprobe.executable, ['-v', 'error', '-protocol_whitelist', 'file', ...(input.format === 'm4a' ? ['-ignore_editlist', '1'] : []), '-count_packets', '-show_streams', '-of', 'json', original]));
          assert.equal(input.codedFrames, Number(probe.streams[0].nb_read_packets)); assert.equal(input.samples, input.codedFrames * (input.format === 'mp3' ? 1152 : 1024));
        }
        const oraclePath = join(records, input.format + '.s16le'); writeFileSync(oraclePath, oracle);
        const canonical = collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-threads', '1', '-f', 's16le', '-ar', String(input.sampleRate), '-ac', '1', '-i', oraclePath,
          '-map', '0:a:0', '-filter_threads', '1', '-af', 'aresample=16000:resampler=swr:dither_method=none:async=0', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], 0, true);
        assert.deepEqual(readFileSync(join(project, audioItem.path)).subarray(44), canonical); assert.equal(audioItem.samples, canonical.length / 2);
        log({ kind: 'source-oracle', format: input.format, sourceBytes: asset.source.bytes, sourceSha256: asset.source.sha256, input, pcmSha256: sha(oracle), canonicalSha256: sha(canonical), decodedFrames: true });
      }
      assert.ok(commonMap(manifest.assets.find(a => a.technical.format === 'mp3')).input.metadataFrames === 1);
      assert.ok(commonMap(manifest.assets.find(a => a.technical.format === 'm4a')).input.edit);
    });
    await gate('Audio input 结构尾损坏明确拒绝与已提交结果保留', () => {
      const broken = join(scratch, 'broken audio'); mkdirSync(broken);
      for (const name of ['known.mp3', 'known.m4a', 'known.flac']) { const bytes = readFileSync(join(selected, name)); writeFileSync(join(broken, name), bytes.subarray(0, bytes.length - 1)); }
      const bad = JSON.parse(control(['audio-film', 'import', '--source', broken])), receipt = catalog(['--import', bad.importId]), checked = catalog(['--verify', receipt.catalogId]).manifest;
      for (const a of checked.assets.filter(a => a.inspection.catalogId === receipt.catalogId)) { assert.ok(['failed', 'unsupported', 'partial'].includes(a.technical.status)); assert.notEqual(a.technical.audioInput.status, 'completed'); assert.equal(a.technical.evidence.length, 0); }
      catalog(['--verify', first.catalogId]);
    });
    await gate('Audio input 真实离线M4A转写复用canonical及ASR关闭的MP3对齐', async () => {
      const speech = join(scratch, 'speech sources'); mkdirSync(speech); const text = 'A blue paper boat passes a quiet island.'; writeFileSync(join(speech, 'speech.txt'), text);
      collect(root, '/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default) (deny network*)', '/usr/bin/say', '-v', 'Samantha', '-f', join(speech, 'speech.txt'), '-o', join(speech, 'speech.aiff')]);
      for (const [name, codec] of [['speech.m4a', 'aac'], ['speech.mp3', 'libmp3lame']]) collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', join(speech, 'speech.aiff'), '-ar', '44100', '-ac', '2', '-threads', '1', '-c:a', codec, '-b:a', '128k', join(speech, name)]);
      const input = JSON.parse(control(['audio-film', 'import', '--source', speech])); setPolicy({ asr: { ...inspectPolicy.asr, enabled: true, language: 'en' } });
      asrReceipt = catalog(['--import', input.importId, '--path', 'speech.m4a']); const transcribed = catalog(['--verify', asrReceipt.catalogId]).manifest;
      const asrAsset = transcribed.assets.find(a => a.inspection.catalogId === asrReceipt.catalogId), descriptor = asrAsset.technical.asr;
      assert.ok(['completed', 'no-text'].includes(descriptor.status)); assert.equal(descriptor.version, '0.2'); assert.equal(asrAsset.technical.evidence.length, 7);
      assert.equal(descriptor.audioEvidenceId, asrAsset.technical.audioInput.audioEvidenceId); assert.equal(asrAsset.technical.evidence.filter(e => e.kind === 'audio-canonical').length, 1);
      const asrMap = json(join(project, asrAsset.technical.evidence.find(e => e.id === descriptor.mapEvidenceId).path)); assert.equal(asrMap.version, '0.2'); assert.equal(asrMap.source.input.format, 'm4a');
      setPolicy({}); const plain = catalog(['--import', input.importId, '--path', 'speech.mp3']); manifest = catalog(['--verify', plain.catalogId]).manifest;
      const asset = manifest.assets.find(a => a.inspection.catalogId === plain.catalogId); assert.equal(asset.technical.asr.status, 'disabled'); save(join(project, 'inputs/alignment-policy.json'), alignmentPolicy);
      const approval = Buffer.from('Fictional delegated word alignment approval.'); writeFileSync(join(project, 'inputs/approval.txt'), approval);
      const s = { version: '0.1', kind: 'alignment-script', language: 'en', lineId: 'fictional-line', text };
      save(join(project, 'inputs/script.json'), { ...s, approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'fixture', sourceRef: { path: 'inputs/approval.txt', bytes: approval.length, sha256: sha(approval) }, subjectSha256: subject(s) } });
      alignmentReceipt = align(selection(asset)); const aligned = align(['--verify', alignmentReceipt.alignmentId]).manifest;
      assert.equal(aligned.version, '0.2'); assert.equal(aligned.source.input.format, 'mp3'); assert.equal(aligned.source.audioEvidenceId, asset.technical.audioInput.audioEvidenceId);
      const canonical = asset.technical.evidence.find(e => e.id === aligned.source.audioEvidenceId); assert.deepEqual(readFileSync(join(project, aligned.audio.path)), readFileSync(join(project, canonical.path)));
      assert.ok(json(join(project, aligned.map.path)).coverage.estimatedUnits > 0); assert.equal(json(join(project, aligned.map.path)).coverage.listening, 'unverified');
      log({ kind: 'provider-smoke', asr: descriptor.status, recognizedText: readFileSync(join(project, asrAsset.technical.evidence.find(e => e.id === descriptor.textEvidenceId).path), 'utf8'), alignment: aligned.alignmentId, map: json(join(project, aligned.map.path)), listening: 'unverified' });
    });
    await gate('Audio input 累计配额失败与固定证据替换保持有效索引', () => {
      const before = readFileSync(join(project, 'assets/catalog.json'));
      let quotaOrdinal = 0;
      for (const patch of [{ audioInput: { ...inspectPolicy.audioInput, maxAudiosPerAttempt: 1 } }, { maxDecodedAudioBytes: 1 }, { maxDerivedBytes: 1 }]) {
        const selectedQuota = join(scratch, `quota-${++quotaOrdinal}`); mkdirSync(selectedQuota);
        for (let i = 0; i < 2; i++) { const bytes = wave(9600, 48000); bytes.writeInt16LE(quotaOrdinal * 10 + i, bytes.length - 2); writeFileSync(join(selectedQuota, `fresh-${i}.wav`), bytes); }
        const fresh = JSON.parse(control(['audio-film', 'import', '--source', selectedQuota]));
        setPolicy(patch); const receipt = catalog(['--import', fresh.importId], 1); assert.equal(receipt.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
      }
      setPolicy({}); const asset = manifest.assets.find(a => a.technical.audioInput?.status === 'completed');
      for (const entry of asset.technical.evidence) { const path = join(project, entry.path), bytes = readFileSync(path), altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; writeFileSync(path, altered);
        try { control(['audio-film', 'catalog', '--verify', manifest.catalogId], 1); } finally { writeFileSync(path, bytes); } catalog(['--verify', manifest.catalogId]); }
    });
    await gate('Audio input 移根重放与历史政策继承', () => {
      const movedRoot = join(scratch, 'audio relocated workspace'); mkdirSync(join(movedRoot, 'projects'), { recursive: true }); cpSync(core, join(movedRoot, '.skill'), { recursive: true }); cpSync(project, join(movedRoot, 'projects/audio-film'), { recursive: true });
      collect(movedRoot, process.execPath, [join(movedRoot, '.skill/scripts/video.mjs'), 'audio-film', 'catalog', '--verify', manifest.catalogId]);
      collect(movedRoot, process.execPath, [join(movedRoot, '.skill/scripts/video.mjs'), 'audio-film', 'align', '--verify', alignmentReceipt.alignmentId]);
      setPolicy({ version: '0.4', audioInput: undefined }); const legacy = catalog(['--import', imported.importId, '--path', 'known.wav']); assert.equal(legacy.version, '0.5');
      const checked = catalog(['--verify', legacy.catalogId]).manifest; assert.equal(checked.policy.version, '0.4'); catalog(['--verify', asrReceipt.catalogId]);
    });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) await gate(`Audio input 统一入口${signal}与耐久恢复`, async () => {
      const interruptSource = join(scratch, `interrupt-${signal}`); mkdirSync(interruptSource);
      collect(root, lock.tools.ffmpeg.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', join(selected, 'known.wav'), '-threads', '1', '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-metadata', `title=${signal}`, join(interruptSource, 'fresh.m4a')]);
      const interruptImport = JSON.parse(control(['audio-film', 'import', '--source', interruptSource]));
      setPolicy({ asr: { ...inspectPolicy.asr, enabled: true, language: 'en' } }); const before = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
      const argv = [join(core, 'scripts/video.mjs'), 'audio-film', 'catalog', '--import', interruptImport.importId, '--path', 'fresh.m4a']; const child = spawn(process.execPath, argv, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); const closed = new Promise(r => child.once('close', (exitCode, exitSignal) => r({ exitCode, exitSignal })));
      let active; try { const deadline = Date.now() + 60000;
        while (!active && Date.now() < deadline) { for (const n of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const value = json(join(runs, n, 'receipt.json')); if (value.status === 'running' && value.phase === 'inspecting') active = value; } catch (e) { if (e.code !== 'ENOENT') throw e; } if (!active) await wait(10); }
        assert.ok(active, stdout + stderr); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal);
        let timer; const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('AUDIO_INPUT_INTERRUPT_TIMEOUT')), 15000); })]).finally(() => clearTimeout(timer));
        writeFileSync(join(records, `interrupt-${signal}.stdout.log`), stdout); writeFileSync(join(records, `interrupt-${signal}.stderr.log`), stderr);
        log({ kind: 'interrupt', packageId, cwd: root, argv, signal, ...result, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) });
        assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); setPolicy({}); const recovery = catalog(['--import', imported.importId, '--path', 'known.wav']); assert.equal(recovery.status, 'succeeded');
        assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false); catalog(['--verify', first.catalogId]);
      } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } await closed; }
    });
    save(join(records, 'result.json'), { packageId, status: 'passed', groups, sourceIdentity, scope: 'complete-decoded-frames', presentationMapping: 'unknown', listening: 'unverified' }); return { records, groups };
  } finally { if (existsSync(project)) cpSync(project, join(records, 'project'), { recursive: true, filter: p => !p.startsWith(join(project, '.engine')) }); cpSync(selected, join(records, 'sources'), { recursive: true });
    save(join(records, 'archive.json'), { packageId, records, projectEngine: 'Reconstruct from exact sealed package.' }); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const { root, skill, verifyCore } = await import('./core.mjs'); verifyCore(); const out = join(root, '.research/out'); mkdirSync(out, { recursive: true }); const scratch = mkdtempSync(join(out, 'audio-input-preflight-'));
  try { const result = await checkAudioInputNative({ scratch, skill, check: async (name, action) => { await action(); process.stdout.write(`✓ ${name}\n`); } }); process.stdout.write(JSON.stringify(result) + '\n'); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
