import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { digest, json } from '../engine/workspace.mjs';
export async function checkCatalogNative({ scratch, skill, run, check, denied }) {
  const root = join(scratch, 'catalog workspace'), core = join(root, '.skill'), project = join(root, 'projects/catalog-film'), other = join(root, 'projects/other-film'), selected = join(scratch, 'catalog sources'), external = join(scratch, 'catalog-unselected.txt');
  const control = (args, expected = 0) => run(root, [join(core, 'scripts/video.mjs'), ...args], expected);
  let imported, receipt, manifest;
  await check('素材目录真实入口、媒体动态库闭包、格式/版本身份及固定契约', () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected); writeFileSync(external, 'external');
    for (const slug of ['catalog-film', 'other-film']) control(['start', slug, '--idea', '虚构素材目录验收']); writeFileSync(join(selected, 'notes.txt'), 'source data');
    for (const [name, args] of [['image.png', ['-f', 'lavfi', '-i', 'color=s=64x48', '-frames:v', '1']], ['audio.wav', ['-f', 'lavfi', '-i', 'sine=sample_rate=16000:duration=0.5']], ['video.mp4', ['-f', 'lavfi', '-i', 'color=s=64x48:r=2:d=1', '-c:v', 'libx264']]]) { const r = spawnSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', ...args, join(selected, name)], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
    imported = JSON.parse(control(['catalog-film', 'import', '--source', selected])); const prior = readFileSync(join(project, 'inputs/import.json'));
    receipt = JSON.parse(control(['catalog-film', 'catalog', '--import', imported.importId])); assert.equal(receipt.status, 'succeeded'); manifest = JSON.parse(control(['catalog-film', 'catalog', '--verify', receipt.catalogId])).manifest;
    for (const asset of manifest.assets) assert.equal(asset.technical.status, 'supported', asset.technical.reason); assert.equal(manifest.assets.length, 4); assert.equal(manifest.assets.find(a => a.source.path === 'audio.wav').technical.evidence.find(e => e.kind === 'audio-pcm').samples, 8000);
    assert.deepEqual(readFileSync(join(project, 'inputs/import.json')), prior); assert.equal(existsSync(join(other, 'assets/catalog.json')), false);
    for (const schema of ['manifest', 'receipt', 'index', 'policy', 'observation', 'rights']) assert.equal(JSON.parse(control(['catalog-film', 'catalog', '--schema', schema])).$schema, 'http://json-schema.org/draft-07/schema#');
    const again = JSON.parse(run(project, [join(project, 'video.mjs'), 'catalog', '--import', imported.importId])); assert.notEqual(again.catalogId, receipt.catalogId); assert.equal(JSON.parse(control(['catalog-film', 'catalog', '--verify', again.catalogId])).manifest.assets.length, 4);
    assert.equal(readdirSync(join(project, 'out/.tmp')).some(name => name.startsWith('catalog-sandbox-')), false);
    for (const args of [[], ['--path', 'notes.txt'], ['--import', imported.importId, '--unpack', 'x'], ['--verify', receipt.catalogId, '--asset', 'x'], ['--schema', 'x']]) assert.match(control(['catalog-film', 'catalog', ...args], 1), /用法|契约/);
  });
  await check('目录沙箱只读原件/既有证据、后代/跨片读取、网络与最小环境', async () => {
    const original = join(project, manifest.assets[0].source.fixedPath), oldManifest = join(project, receipt.manifestPath), evidence = join(project, manifest.assets.find(a => a.technical.evidence.length).technical.evidence[0].path), escape = join(scratch, 'catalog-escape');
    const attempts = [`fs.readFileSync(${JSON.stringify(external)})`, `fs.readFileSync(${JSON.stringify(join(core, 'SKILL.md'))})`, `fs.readFileSync(${JSON.stringify(join(other, 'director.json'))})`, `fs.writeFileSync(${JSON.stringify(escape)},'x')`, ...[original, oldManifest, evidence, join(project, 'inputs/import.json'), join(project, '.engine/changed')].map(p => `fs.writeFileSync(${JSON.stringify(p)},'x')`), `fs.renameSync(${JSON.stringify(join(project, 'assets/derived/inspection'))},${JSON.stringify(join(project, 'out/moved-inspections'))})`];
    const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`; const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const code = `${probe}if(!fs.readFileSync(${JSON.stringify(original)}).length)process.exit(1);fs.writeFileSync('out/.tmp/catalog-allowed','yes');const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.HOME||process.env.NODE_OPTIONS||process.env.JBM_UNSELECTED_SECRET)process.exit(1);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code);});`;
      const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_UNSELECTED_SECRET='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['catalog','--schema','manifest']));`;
      const result = run(root, ['--input-type=module', '-e', launch]); assert.equal((result.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1); assert.match(result, /NETWORK_DENIED/); assert.equal(existsSync(escape), false);
    } finally { await new Promise(resolve => server.close(resolve)); }
    assert.equal(JSON.parse(control(['catalog-film', 'catalog', '--verify', receipt.catalogId])).ok, true);
  });
  await check('目录实际读写权限故障保留旧索引和失败回执', () => {
    const source = join(project, 'inputs/original', imported.importId, 'notes.txt'), before = readFileSync(join(project, 'assets/catalog.json')), mode = lstatSync(source).mode & 0o777;
    try { chmodSync(source, 0); const r = JSON.parse(control(['catalog-film', 'catalog', '--import', imported.importId], 1)); assert.equal(r.status, 'failed'); assert.match(r.error, /EACCES|EPERM/); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); } finally { chmodSync(source, mode); }
    const destination = join(project, 'assets/catalogs'), destMode = lstatSync(destination).mode & 0o777;
    try { chmodSync(destination, 0o500); const r = JSON.parse(control(['catalog-film', 'catalog', '--import', imported.importId], 1)); assert.equal(r.status, 'failed'); assert.match(r.error, /EACCES|EPERM/); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); } finally { chmodSync(destination, destMode); }
  });
  for (const signal of ['SIGTERM', 'SIGKILL']) await check(`目录统一入口 ${signal}、实测回执和租约恢复`, async () => {
    const large = join(selected, 'large.txt'); writeFileSync(large, 'x'.repeat(8 * 1024 * 1024)); const parent = JSON.parse(control(['catalog-film', 'import', '--source', selected])), previous = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
    const child = spawn(process.execPath, [join(core, 'scripts/video.mjs'), 'catalog-film', 'catalog', '--import', parent.importId], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); const exit = new Promise(resolve => child.once('close', (status, exitSignal) => resolve({ status, exitSignal })));
    try { let active, lastReceipt; const started = Date.now(), deadline = started + 60000;
      while (!active && Date.now() < deadline) { for (const name of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const r = json(join(runs, name, 'receipt.json')); lastReceipt = { phase: r.phase, status: r.status }; if (r.phase === 'inspecting' && r.status === 'running') active = r; } catch(e) { if (e.code !== 'ENOENT') throw e; }
        if (!active && (child.exitCode !== null || child.signalCode !== null)) break;
        if (!active) await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.ok(active, `CATALOG_INTERRUPT_NOT_ACTIVE:${signal}:${JSON.stringify({ elapsedMs: Date.now() - started, lastReceipt: lastReceipt ?? null, exitCode: child.exitCode, signal: child.signalCode })}\n${stdout}${stderr}`); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal); const result = await exit;
      if (signal === 'SIGTERM') { assert.equal(result.status, 1, stdout + stderr); assert.equal(JSON.parse(stdout).status, 'interrupted'); } else assert.equal(result.exitSignal, 'SIGKILL'); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), previous);
      assert.equal(JSON.parse(control(['catalog-film', 'catalog', '--import', parent.importId])).status, 'succeeded'); assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch(e) { if (e.code !== 'ESRCH') throw e; } await exit; }
  });
}
