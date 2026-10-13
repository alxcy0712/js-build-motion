import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { engine, root, skill, verifyCore } from './core.mjs';
import { digest, json, writeJson } from '../engine/workspace.mjs';

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : []);
}
function checkEngine() {
  const temporary = [join(engine, '.research'), join(engine, 'projects')];
  if (temporary.some(existsSync)) throw new Error('CHECK_TEMP_EXISTS: inspect existing engine probe files first');
  mkdirSync(join(engine, '.research/out'), { recursive: true });
  try {
    const result = spawnSync(process.execPath, ['--test', ...files(join(engine, 'test'))], { cwd: engine, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally { temporary.forEach(path => rmSync(path, { recursive: true, force: true })); }
}

function checkStandalone() {
  const original = verifyCore();
  const output = join(root, '.research/out');
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(output, 'standalone-check-'));
  const isolated = join(scratch, 'workspace');
  // The system ps needs its privilege-preserving launch to inspect owned test children.
  const profile = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(join(root, 'projects'))}))(allow process-exec (literal "/bin/ps") (with no-sandbox))`;
  const run = (args, capture = true, coreSandbox = true) => {
    const result = spawnSync(coreSandbox ? '/usr/bin/sandbox-exec' : process.execPath, coreSandbox ? ['-p', profile, process.execPath, ...args] : args, {
      cwd: isolated, stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (!capture) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
    if (result.error || result.status !== 0) throw new Error(`STANDALONE_CHECK_FAILED: ${result.error || result.stderr || result.signal || result.status}`);
    return capture ? JSON.parse(result.stdout) : undefined;
  };
  try {
    mkdirSync(isolated);
    cpSync(skill, join(isolated, '.skill'), { recursive: true, dereference: true });
    if (existsSync(join(isolated, 'projects'))) throw new Error('STANDALONE_PROJECTS_PRESENT');
    const probeCode = `import {readdirSync} from 'node:fs';try {readdirSync(${JSON.stringify(join(root, 'projects'))});process.exit(1);} catch (e) {if(!['EPERM','EACCES','ENOENT'].includes(e.code))throw e;process.stdout.write(JSON.stringify({readable:false,state:e.code==='ENOENT'?'absent':'access-denied'}));}`;
    const probe = run(['--input-type=module', '-e', probeCode]);
    if (probe.readable !== false) throw new Error('STANDALONE_PROJECTS_READABLE');
    run(['.skill/scripts/check.mjs', '--engine'], false);
    if (existsSync(join(isolated, 'projects'))) throw new Error('STANDALONE_ENGINE_CREATED_PROJECTS');
    const cases = [
      ['copy-input', '按文案解释蒸发、凝结与降水之间的关系。'],
      ['title-input', '以“门后的声音”为标题设计短片。'],
      ['folder-input', '依据拍摄素材目录制作旧物修复日志。'],
      ['video-input', '结合视频素材与讲解稿说明一次植物观察。'],
    ];
    for (const [slug, idea] of cases) {
      const result = run(['.skill/scripts/video.mjs', 'start', slug, '--idea', idea]);
      if (result.packageId !== original.packageId || result.status !== 'needs-intake') throw new Error('STANDALONE_INITIALIZATION_INVALID');
    }
    // Project commands apply their own sandbox; include the original root in its protected scope.
    const project = join(isolated, 'projects', cases[0][0]);
    const isolation = { protectedRoots: [isolated, root] };
    writeJson(join(project, '.engine/isolation.json'), isolation);
    const workspace = json(join(project, 'workspace.json'));
    writeJson(join(project, 'workspace.json'), { ...workspace, isolationSha256: digest(JSON.stringify(isolation)) });
    const projectProbe = run(['.skill/scripts/video.mjs', cases[0][0], 'exec', process.execPath, '--input-type=module', '-e', probeCode], true, false);
    if (projectProbe.readable !== false) throw new Error('STANDALONE_PROJECT_PROCESS_READABLE');
    const capabilities = run(['.skill/scripts/video.mjs', cases[0][0], 'capabilities'], true, false);
    const contract = run(['.skill/scripts/video.mjs', cases[0][0], 'production', '--schema', 'init'], true, false);
    if (capabilities.contract !== 'DirectorPlan@0.1' || contract.type !== 'object') throw new Error('STANDALONE_CONTRACT_INVALID');
    process.stdout.write(JSON.stringify({ ok: true, scope: 'standalone-core', packageId: original.packageId,
      existingProjectsReadable: false, existingProjectsState: probe.state, projectProcessReadDenied: true,
      engineChecksPassed: true, initializedInputs: cases.map(([slug]) => slug), contractsQueried: true }) + '\n');
    return 0;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

try {
  const mode = process.argv[2] ?? '--engine';
  if (mode === '--engine') process.exitCode = checkEngine();
  else if (mode === '--standalone') process.exitCode = checkStandalone();
  else if (mode === '--native') await (await import('./native-check.mjs')).checkNative();
  else throw new Error('USAGE: check.mjs --engine | --standalone | --native');
} catch (error) { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; }
