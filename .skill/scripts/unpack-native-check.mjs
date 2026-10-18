import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { makeZip } from '../engine/test/fixtures/zip.ts';
import { digest, importCommandOptions, json } from '../engine/workspace.mjs';

export async function checkUnpackNative({ scratch, skill, run, check, denied }) {
  const root = join(scratch, 'unpack workspace'), core = join(root, '.skill'), project = join(root, 'projects/selected-film'), other = join(root, 'projects/other-film');
  const selected = join(scratch, 'selected archive.zip'), external = join(scratch, 'unselected-unpack.txt');
  const control = (args, expected = 0) => run(root, [join(core, 'scripts/video.mjs'), ...args], expected);
  let imported, unpacked;
  await check('显式 ZIP 统一入口、编码/字节身份、独立版本、复查与冻结依赖', () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true });
    for (const slug of ['selected-film', 'other-film']) control(['start', '--theme', 'minimal', slug, '--idea', '虚构归档展开验收']);
    const archive = makeZip([{ name: "folder/notes 'quoted' $(literal).txt", data: 'literal member bytes', method: 0 }, { name: '目录/中文.txt', data: '示例', descriptor: true }, { name: 'empty/', directory: true }], { zip64: true });
    writeFileSync(selected, archive); writeFileSync(external, 'unselected source');
    imported = JSON.parse(control(['selected-film', 'import', '--source', selected]));
    const originalIndex = readFileSync(join(project, 'inputs/import.json'));
    unpacked = JSON.parse(control(['selected-film', 'unpack', '--import', imported.importId, '--path', 'selected archive.zip']));
    assert.equal(unpacked.status, 'succeeded'); assert.equal(unpacked.indexCommitted, true);
    const verified = JSON.parse(control(['selected-film', 'unpack', '--verify', unpacked.unpackId])); assert.equal(verified.ok, true);
    assert.equal(verified.manifest.source.archiveSha256, digest(archive)); assert.equal(verified.manifest.source.manifestSha256, imported.manifestSha256);
    assert.equal(readFileSync(join(project, 'inputs/unpacked', unpacked.unpackId, "folder/notes 'quoted' $(literal).txt"), 'utf8'), 'literal member bytes');
    assert.deepEqual(readFileSync(join(project, 'inputs/import.json')), originalIndex); assert.deepEqual(readFileSync(selected), archive);
    assert.ok(json(join(project, '.engine/engine-manifest.json')).dependencies.includes('yauzl@3.4.0'));
    assert.ok(json(join(project, '.engine/engine-manifest.json')).dependencies.includes('pend@1.2.0'));
    assert.equal(existsSync(join(other, 'inputs/unpack.json')), false);
    for (const contract of ['manifest', 'receipt', 'policy', 'index']) assert.equal(JSON.parse(control(['selected-film', 'unpack', '--schema', contract])).$schema, 'http://json-schema.org/draft-07/schema#');
    const second = JSON.parse(run(project, [join(project, 'video.mjs'), 'unpack', '--import', imported.importId, '--path', 'selected archive.zip'])); assert.notEqual(second.unpackId, unpacked.unpackId);
    assert.equal(json(join(project, 'inputs/unpack.json')).unpacks.length, 2);
  });
  await check('展开参数与非法归档拒绝保留接收原件、旧索引和可追溯回执', () => {
    const before = readFileSync(join(project, 'inputs/unpack.json'));
    for (const args of [['--import', imported.importId], ['--path', 'selected archive.zip'], ['--source', selected], ['--verify', unpacked.unpackId, '--path', 'a'], ['--schema', 'invalid']]) assert.match(control(['selected-film', 'unpack', ...args], 1), /用法|展开契约|Unknown option/);
    const selection = JSON.parse(control(['selected-film', 'unpack', '--import', imported.importId, '--path', '../escape'], 1)); assert.match(selection.error, /SELECTION_INVALID/);
    writeFileSync(selected, makeZip([{ name: '../unsafe', data: 'outside' }])); const invalid = JSON.parse(control(['selected-film', 'import', '--source', selected]));
    const failure = JSON.parse(control(['selected-film', 'unpack', '--import', invalid.importId, '--path', 'selected archive.zip'], 1));
    assert.equal(failure.status, 'failed'); assert.equal(json(join(project, 'runs', failure.attemptId, 'receipt.json')).status, 'failed'); assert.deepEqual(readFileSync(join(project, 'inputs/unpack.json')), before);
    assert.equal(JSON.parse(control(['selected-film', 'import', '--verify', invalid.importId])).ok, true);
  });
  await check('真实本片 ZIP 读取和展开发布权限故障保留旧索引与回执', () => {
    const before = readFileSync(join(project, 'inputs/unpack.json'));
    const original = join(project, 'inputs/original', imported.importId, 'selected archive.zip'), parent = join(project, 'inputs/unpacked');
    const modes = [lstatSync(original).mode & 0o777, lstatSync(parent).mode & 0o777];
    try {
      chmodSync(original, 0o000);
      const read = JSON.parse(control(['selected-film', 'unpack', '--import', imported.importId, '--path', 'selected archive.zip'], 1));
      assert.equal(read.status, 'failed'); assert.match(read.error, /EACCES|EPERM/); assert.deepEqual(readFileSync(join(project, 'inputs/unpack.json')), before);
      assert.equal(json(join(project, 'runs', read.attemptId, 'receipt.json')).status, 'failed');
      chmodSync(original, modes[0]); chmodSync(parent, 0o500);
      const write = JSON.parse(control(['selected-film', 'unpack', '--import', imported.importId, '--path', 'selected archive.zip'], 1));
      assert.equal(write.status, 'failed'); assert.match(write.error, /EACCES|EPERM/); assert.ok(write.counts.expandedBytes > 0); assert.deepEqual(readFileSync(join(project, 'inputs/unpack.json')), before);
      assert.equal(json(join(project, 'runs', write.attemptId, 'receipt.json')).indexCommitted, false);
    } finally { chmodSync(original, modes[0]); chmodSync(parent, modes[1]); }
    assert.equal(JSON.parse(control(['selected-film', 'unpack', '--verify', unpacked.unpackId])).ok, true);
  });
  await check('展开沙箱的原件只读、项目与后代边界、网络和最小环境', async () => {
    const immutable = join(project, 'inputs/original', imported.importId, 'selected archive.zip'), escape = join(scratch, 'unpack-escape.txt');
    const attempts = [
      `fs.readFileSync(${JSON.stringify(external)})`, `fs.readFileSync(${JSON.stringify(selected)})`, `fs.readFileSync(${JSON.stringify(join(core, 'SKILL.md'))})`,
      `fs.readFileSync(${JSON.stringify(join(other, 'director.json'))})`, `fs.writeFileSync(${JSON.stringify(escape)},'blocked')`, `fs.writeFileSync(${JSON.stringify(immutable)},'blocked')`,
      `fs.writeFileSync(${JSON.stringify(join(project, 'inputs/import.json'))},'blocked')`, `fs.renameSync(${JSON.stringify(join(project, 'inputs'))},${JSON.stringify(join(project, 'out/moved-inputs'))})`,
      `fs.writeFileSync(${JSON.stringify(join(project, '.engine/changed.txt'))},'blocked')`,
    ];
    const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`;
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const code = `${probe}if(fs.readFileSync(${JSON.stringify(immutable)}).length===0)process.exit(1);fs.writeFileSync('out/.tmp/allowed-unpack.txt','allowed');const child=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(child.status!==0)throw Error(child.stderr);process.stdout.write(child.stdout);if(process.env.JBM_UNSELECTED_SECRET||process.env.HOME||process.env.NODE_OPTIONS||process.env.OPENSSL_CONF!=='/dev/null')process.exit(1);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code);});`;
      const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_UNSELECTED_SECRET='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['unpack','--import',${JSON.stringify(imported.importId)},'--path','selected archive.zip']));`;
      const result = run(root, ['--input-type=module', '-e', launch]); assert.equal((result.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1); assert.match(result, /NETWORK_DENIED/);
      assert.equal(existsSync(escape), false); assert.equal(readFileSync(join(project, 'out/.tmp/allowed-unpack.txt'), 'utf8'), 'allowed');
    } finally { await new Promise(resolve => server.close(resolve)); }
    assert.deepEqual(importCommandOptions(['unpack', '--schema', 'manifest']), { importOnly: true, unpackOnly: true });
  });
  for (const signal of ['SIGTERM', 'SIGKILL']) await check(`真实统一展开入口 ${signal}、信号传递和下一次回执恢复`, async () => {
    writeFileSync(selected, makeZip([{ name: 'stream.bin', data: Buffer.alloc(16 * 1024 * 1024, 5), method: 0 }]));
    const source = JSON.parse(control(['selected-film', 'import', '--source', selected])), previous = readFileSync(join(project, 'inputs/unpack.json'));
    const runs = join(project, 'runs'), known = new Set(readdirSync(runs));
    const child = spawn(process.execPath, [join(core, 'scripts/video.mjs'), 'selected-film', 'unpack', '--import', source.importId, '--path', 'selected archive.zip'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('close', (status, exitSignal) => resolve({ status, exitSignal })));
    let active, lastReceipt;
    try {
      const started = Date.now(), deadline = started + 60000;
      while (Date.now() < deadline && !active) {
        for (const name of readdirSync(runs).filter(name => name.startsWith('unpack-attempt-') && !known.has(name))) {
          try { const receipt = json(join(runs, name, 'receipt.json')); lastReceipt = { phase: receipt.phase, status: receipt.status }; if (receipt.phase === 'extracting' && receipt.counts.expandedBytes > 0 && receipt.status === 'running') active = receipt; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!active && (child.exitCode !== null || child.signalCode !== null)) break;
        if (!active) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(active, `UNPACK_INTERRUPT_NOT_ACTIVE:${signal}:${JSON.stringify({ elapsedMs: Date.now() - started, lastReceipt: lastReceipt ?? null, exitCode: child.exitCode, signal: child.signalCode })}\n${stdout}${stderr}`);
      if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal);
      const result = await exited;
      if (signal === 'SIGTERM') { assert.equal(result.status, 1, stderr + stdout); assert.equal(JSON.parse(stdout).status, 'interrupted'); }
      else assert.equal(result.exitSignal, 'SIGKILL');
      assert.deepEqual(readFileSync(join(project, 'inputs/unpack.json')), previous);
      const next = JSON.parse(control(['selected-film', 'unpack', '--import', source.importId, '--path', 'selected archive.zip'])); assert.equal(next.status, 'succeeded');
      const receipt = json(join(runs, active.attemptId, 'receipt.json')); assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.indexCommitted, false); assert.ok(receipt.counts.expandedBytes > 0);
      assert.equal(existsSync(join(runs, 'unpack.lock')), false);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exited; }
  });
}
