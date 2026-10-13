import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { checkDocumentNative } from './document-native-check.mjs';
import { checkOfficeNative } from './office-native-check.mjs';
import { checkAssetsNative, checkProductionAssetsNative } from './assets-native-check.mjs';
import { checkAsrNative } from './asr-native-check.mjs';
import { checkAlignmentNative } from './alignment-native-check.mjs';
import { checkAudioInputNative } from './audio-input-native-check.mjs';
import { checkDocumentOcrNative } from './document-ocr-native-check.mjs';
import { checkOcrNative } from './ocr-native-check.mjs';
import { checkCatalogNative } from './catalog-native-check.mjs';
import { checkUnpackNative } from './unpack-native-check.mjs';
import { backups, engine, root, skill, verifyCore } from './core.mjs';
import { digest, fileHashes, json, writeJson } from '../engine/workspace.mjs';

export async function checkNative() {
  const original = verifyCore();
  const output = join(root, '.research/out');
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(output, 'core-check-'));
  const marker = `core-check-${randomBytes(4).toString('hex')}`;
  const slugs = [marker + '-one', marker + '-two'];
  const [a, b] = slugs.map(slug => join(root, 'projects', slug));
  const checks = [];
  const shared = ['engine/src/animation/easing.ts', 'engine/src/spec/graphic.ts', 'engine/src/cli/director.ts', 'engine/test/director.test.ts'];
  const before = shared.map(path => digest(readFileSync(join(skill, path))));
  const run = (cwd, args, expected = 0) => {
    const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, `${args.slice(0, 3).join(' ')}: ${result.stderr}\n${result.stdout}`);
    return result.stdout + (expected ? result.stderr : '');
  };
  const control = (args, expected = 0) => run(root, [join(skill, 'scripts/video.mjs'), ...args], expected);
  const video = (project, args, expected = 0) => control([json(join(project, 'project.json')).slug, ...args], expected);
  const local = (project, args, expected = 0) => run(project, [join(project, 'video.mjs'), ...args], expected);
  const execNode = (project, code, expected = 0) => video(project, ['exec', process.execPath, '-e', code], expected);
  const denied = expression => `try { ${expression}; process.exit(17); } catch (e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; console.log('DENIED:' + e.code); }`;
  const saved = () => readdirSync(backups).filter(name => /^skill-.*\.tar\.gz$/.test(name)).sort();
  const check = async (name, action) => { await action(); checks.push({ name, ok: true }); process.stdout.write(`✓ ${name}\n`); };

  try {
    await check('唯一核心源码与独立生产依赖', () => {
      const require = createRequire(join(engine, 'package.json'));
      assert.deepEqual(original.dependencies, ['agent-base@7.1.4', 'ajv@8.20.0', 'debug@4.4.3', 'detect-libc@2.1.2', 'fast-deep-equal@3.1.3', 'fast-uri@3.1.8', 'follow-redirects@1.16.0', 'https-proxy-agent@7.0.6', 'json-schema-traverse@1.0.0', 'ms@2.1.3', 'parenthesis@3.1.8', 'pdfjs-dist@6.4.299', 'pend@1.2.0', 'require-from-string@2.0.2', 'saxes@6.0.0', 'skia-canvas@3.0.8', 'string-split-by@1.0.0', 'xmlchars@2.2.0', 'yauzl@3.4.0']);
      assert.ok(original.dependencies.includes('yauzl@3.4.0'));
      assert.ok(original.dependencies.includes('pend@1.2.0'));
      for (const dependency of original.dependencies) {
        const name = dependency.slice(0, dependency.lastIndexOf('@'));
        assert.ok(require.resolve(name).startsWith(join(engine, 'node_modules') + '/'));
      }
      assert.ok(original.files.filter(file => file.path.startsWith('src/')).every(file => file.path.endsWith('.ts')));
      assert.equal(existsSync(join(skill, 'assets/components/easing.js')), false);
    });
    await check('根入口创建不同题材的两个独立项目与组件依赖', () => {
      for (const [i, slug] of slugs.entries()) {
        const idea = i ? '制作角色节奏短片' : '  制作太阳能原理讲解。\n保留 `literal`、$(literal) 与原始换行。\n';
        const ideaFile = join(scratch, 'original-prompt.txt');
        if (!i) writeFileSync(ideaFile, idea);
        const result = JSON.parse(control(['start', slug, ...(i ? ['--idea', idea] : ['--idea-file', ideaFile]), '--components', i ? 'particle-assembly' : 'camera,spring,random,contour,visual-check,image-fit,particle-assembly,region-paint,paper,text-bounds']));
        assert.equal(result.project, [a, b][i]);
        assert.equal(result.status, 'needs-intake');
        assert.equal(result.packageId, original.packageId);
        assert.deepEqual(result.components, i ? ['easing', 'particle-assembly', 'random'] : ['camera', 'contour', 'easing', 'image-fit', 'noise', 'paper', 'particle-assembly', 'random', 'region-paint', 'rough', 'spring', 'text-bounds', 'visual-check', 'watercolor']);
        const history = readFileSync(join(result.project, 'prompt-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(history[0].kind, 'prompt');
        assert.equal(history[0].text, idea);
        assert.match(readFileSync(join(result.project, 'evidence/review.md'), 'utf8'), /pending/);
      }
      for (const path of ['src/components/easing.ts', 'src/components/particle-assembly.ts', '.engine/src/cli/index.ts']) assert.notEqual(lstatSync(join(a, path)).ino, lstatSync(join(b, path)).ino);
      assert.notEqual(lstatSync(join(a, 'src/components/easing.ts')).ino, lstatSync(join(engine, 'src/animation/easing.ts')).ino);
      assert.equal(existsSync(join(a, '.engine/test')), false);
    });
    await check('每次根调用生成备份并轮换到最近两份', () => {
      assert.equal(saved().length, 2);
      const old = saved();
      control(['backup']);
      assert.equal(saved().length, 2);
      assert.equal(saved().includes(old[0]), false);
      assert.equal(saved().includes(old[1]), true);
    });
    await check('同时调用备份仍保留两份并全部成功', async () => {
      await Promise.all([0, 1, 2].map(() => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(skill, 'scripts/video.mjs'), 'backup'], { cwd: root });
        let error = '';
        child.stdout.resume();
        child.stderr.on('data', chunk => { error += chunk; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(error)));
      })));
      assert.equal(saved().length, 2);
    });
    await check('重复初始化保留内容，非法组件与路径拒绝', () => {
      writeFileSync(join(a, 'src/preserved.txt'), 'keep');
      assert.match(control(['start', slugs[0], '--idea', 'repeat'], 1), /PROJECT_EXISTS/);
      assert.equal(readFileSync(join(a, 'src/preserved.txt'), 'utf8'), 'keep');
      assert.match(control(['start', marker + '-bad', '--idea', 'bad', '--components', '__proto__'], 1), /COMPONENT_UNKNOWN/);
      assert.match(control(['../outside', 'capabilities'], 1), /PROJECT_SLUG/);
    });
    await check('系统沙箱运行固定 TS 核心及本片组件', () => {
      const capabilities = JSON.parse(video(a, ['capabilities']));
      assert.equal(capabilities.contract, 'DirectorPlan@0.1');
      assert.ok(capabilities.tools.find(tool => tool.id === 'skia-canvas'));
      assert.equal(capabilities.tools.find(tool => tool.id === 'imagegen')?.execution, 'agent');
      assert.equal(capabilities.tools.find(tool => tool.id === 'threejs')?.status, 'candidate');
      execNode(a, "require('node:fs').writeFileSync('src/allowed.txt','ok')");
      execNode(a, "import('./src/components/camera.ts').then(m => { if(typeof m.cameraFor !== 'function' || typeof m.applyCameraPose !== 'function') process.exit(1); })");
      execNode(a, "import('./src/components/spring.ts').then(m => { const keys=[[0,0],[.2,100],[.3,40]], at=m.springTrack(.3,keys); if(Math.abs(m.springTrack(10,keys)-40)>1e-9 || m.springTrack(.3,keys)!==at) process.exit(1); })");
      execNode(a, "import('./src/components/contour.ts').then(m => { const p=m.prepareMorph([[0,0],[10,0],[10,10],[0,10]],[[10,10],[10,0],[0,0],[0,10]],16); if(JSON.stringify(m.morphContour(p,.5))!==JSON.stringify(p.from)) process.exit(1); })");
      execNode(a, "import('./src/components/visual-check.ts').then(m => { if(typeof m.compareMasks !== 'function' || typeof m.colorCoverage !== 'function') process.exit(1); })");
      execNode(a, "Promise.all([import('./src/components/region-paint.ts'),import('./src/components/paper.ts'),import('./src/components/text-bounds.ts'),import('./.engine/node_modules/skia-canvas/lib/index.js')]).then(([paint,paper,text,{Canvas,Path2D}])=>{const c=new Canvas(80,60),ctx=c.getContext('2d'),path=new Path2D();path.rect(10,10,60,40);paper.PaperTexture.get({seed:7,tileSize:64,density:2}).draw(ctx,80,60);paint.paintRegion(ctx,path,{x:10,y:10,w:60,h:40},{seed:7,color:'#347d7a'});const tracked=text.trackTextBounds(ctx);ctx.font='12px sans-serif';ctx.fillText('local',15,35);if(tracked.draws.length!==1 || ctx.getImageData(20,20,1,1).data[3]!==255)process.exit(1);})");
      assert.match(readFileSync(join(a, 'src/components/region-paint.ts'), 'utf8'), /from '\.\/watercolor\.ts'/);
      execNode(a, "import('./src/components/image-fit.ts').then(m => { const r=m.fitImage({x:0,y:0,width:100,height:100},{x:0,y:0,width:150,height:200},'cover'); if(Math.abs(r.destination.width/r.source.width-r.destination.height/r.source.height)>1e-9) process.exit(1); })");
      execNode(b, "import('./src/components/particle-assembly.ts').then(m => { const a=m.prepareParticleAssembly({bounds:{x:0,y:0,width:10,height:10},contains:()=>true,source:{x:-20,y:20,width:10,height:10},bend:[-10,0],approach:[-2,3],count:8,seed:'symbol',duration:1}), before=m.particleAssemblyAt(a,.5);m.particleAssemblyAt(a,2);if(JSON.stringify(before)!==JSON.stringify(m.particleAssemblyAt(a,.5)) || m.particleAssemblyAt(a,2).some((p,i)=>p.x!==a.particles[i].to[0] || p.y!==a.particles[i].to[1])) process.exit(1); })");
    });
    await check('系统沙箱内追加问答与修改，保留原始 prompt 与另一影片记录', () => {
      const originalHistory = readFileSync(join(a, 'prompt-history.jsonl'), 'utf8');
      const otherHistory = readFileSync(join(b, 'prompt-history.jsonl'), 'utf8');
      video(a, ['prompt', '--kind', 'question', '--text', '使用哪一种画幅？']);
      const answer = '16:9。\n保留 `literal` 与 $(literal)。\n';
      const input = join(a, 'evidence/.prompt-input.txt');
      writeFileSync(input, answer);
      video(a, ['prompt', '--kind', 'answer', '--file', 'evidence/.prompt-input.txt']);
      rmSync(input);
      video(a, ['prompt', '--kind', 'prompt', '--text', '延长结论停留。']);
      const entries = JSON.parse(video(a, ['prompt']));
      assert.deepEqual(entries.map(entry => entry.kind), ['prompt', 'question', 'answer', 'prompt']);
      assert.equal(entries[2].text, answer);
      assert.equal(existsSync(input), false);
      assert.ok(readFileSync(join(a, 'prompt-history.jsonl'), 'utf8').startsWith(originalHistory));
      assert.equal(readFileSync(join(b, 'prompt-history.jsonl'), 'utf8'), otherHistory);
      assert.match(video(a, ['prompt', '--kind', 'answer', '--file', '../outside.txt'], 1), /PROJECT_INVALID|PROJECT_ISOLATION/);
    });
    await check('核心、备份及其他项目内容读取拒绝', () => {
      for (const file of [join(b, 'director.json'), join(skill, 'SKILL.md')]) assert.match(execNode(a, denied(`require('node:fs').readFileSync(${JSON.stringify(file)})`)), /DENIED:/);
      assert.match(execNode(a, denied(`require('node:fs').readFileSync(${JSON.stringify(join(backups, saved().at(-1)))})`)), /DENIED:/);
      for (const dir of [root, dirname(a), backups]) assert.match(execNode(a, denied(`require('node:fs').readdirSync(${JSON.stringify(dir)})`)), /DENIED:/);
    });
    await check('四个核心文件、越界与后代进程写访问拒绝', () => {
      for (const file of shared.map(path => join(skill, path))) assert.match(execNode(a, denied(`require('node:fs').closeSync(require('node:fs').openSync(${JSON.stringify(file)},'r+'))`)), /DENIED:/);
      const escaped = join(scratch, 'escape.txt');
      for (const file of [escaped, join(b, 'src/escape.txt'), join(a, '.engine/escape.txt')]) {
        assert.match(execNode(a, denied(`require('node:fs').writeFileSync(${JSON.stringify(file)},'blocked')`)), /DENIED:/);
        assert.equal(existsSync(file), false);
      }
      const child = denied(`require('node:fs').writeFileSync(${JSON.stringify(escaped)},'blocked')`);
      assert.match(execNode(a, `const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status ?? 1);`), /DENIED:/);
    });
    await check('输入、源码与输出的链接阻止执行', () => {
      for (const folder of ['src', 'assets', 'out']) {
        const alias = join(a, folder, 'forbidden-link');
        symlinkSync(join(b, 'director.json'), alias);
        assert.match(local(a, ['capabilities'], 1), /WORKSPACE_LINK/);
        rmSync(alias);
      }
      const alias = join(a, 'src/forbidden-hard-link');
      linkSync(join(b, 'src/components/easing.ts'), alias);
      assert.match(local(a, ['capabilities'], 1), /WORKSPACE_LINK/);
      rmSync(alias);
    });
    const importRoot = join(scratch, 'import workspace');
    const importSkill = join(importRoot, '.skill');
    const importProject = join(importRoot, 'projects/selected-film');
    const importOther = join(importRoot, 'projects/other-film');
    const importSources = join(scratch, 'selected sources');
    const importSource = join(importSources, "notes 'quoted' $(literal).txt");
    const importUnselected = join(importSources, 'unselected.txt');
    const importControl = (args, expected = 0) => run(importRoot, [join(importSkill, 'scripts/video.mjs'), ...args], expected);
    const importExec = (code, source) => {
      const launcher = `const {runBoundCommand}=await import(${JSON.stringify(pathToFileURL(join(importProject, '.engine/workspace.mjs')).href)});process.env.JBM_UNSELECTED_SECRET='fixture';process.exitCode=await runBoundCommand(${JSON.stringify(importProject)},[process.execPath,'-e',${JSON.stringify(code)}],{importOnly:true,readSource:${JSON.stringify(source)}});`;
      return run(importRoot, ['--input-type=module', '-e', launcher]);
    };
    await check('导入统一入口固定新运行时，原件副本与回执均归本片', () => {
      mkdirSync(importRoot, { recursive: true });
      mkdirSync(importSources, { recursive: true });
      cpSync(skill, importSkill, { recursive: true });
      for (const slug of ['selected-film', 'other-film']) {
        const initialized = JSON.parse(importControl(['start', slug, '--idea', '虚构导入验证']));
        assert.equal(initialized.packageId, original.packageId);
      }
      writeFileSync(importSource, '独立原件\nwith literal quotes and dollars\n');
      writeFileSync(importUnselected, 'unselected fixture');
      const sourceBefore = digest(readFileSync(importSource));
      const imported = JSON.parse(importControl(['selected-film', 'import', '--source', "../selected sources/notes 'quoted' $(literal).txt"]));
      assert.equal(imported.status, 'succeeded');
      assert.equal(imported.source.path, importSource);
      assert.equal(imported.indexCommitted, true);
      const verified = JSON.parse(importControl(['selected-film', 'import', '--verify', imported.importId]));
      assert.equal(verified.ok, true);
      assert.equal(verified.manifest.importId, imported.importId);
      const originalFiles = fileHashes(join(importProject, 'inputs/original', imported.importId));
      assert.equal(originalFiles.length, 1);
      assert.equal(originalFiles[0].sha256, sourceBefore);
      assert.equal(digest(readFileSync(importSource)), sourceBefore);
      assert.notEqual(lstatSync(join(importProject, 'inputs/original', imported.importId, originalFiles[0].path)).ino, lstatSync(importSource).ino);
      assert.equal(json(join(importProject, `runs/${imported.attemptId}/receipt.json`)).status, 'succeeded');
      assert.ok(existsSync(join(importProject, 'inputs/import-policy.json')));
      assert.equal(existsSync(join(importOther, 'inputs/import.json')), false);
      for (const contract of ['manifest', 'receipt', 'policy']) assert.equal(JSON.parse(importControl(['selected-film', 'import', '--schema', contract])).$schema, 'http://json-schema.org/draft-07/schema#');
    });
    await check('选定受保护来源仍拒绝读取并保留上一导入索引', () => {
      const previous = readFileSync(join(importProject, 'inputs/import.json'));
      for (const source of [join(importSkill, 'SKILL.md'), join(importOther, 'director.json')]) {
        const rejected = JSON.parse(importControl(['selected-film', 'import', '--source', source], 1));
        assert.equal(rejected.status, 'failed');
        assert.ok(rejected.error);
        assert.deepEqual(readFileSync(join(importProject, 'inputs/import.json')), previous);
        assert.equal(json(join(importProject, `runs/${rejected.attemptId}/receipt.json`)).status, 'failed');
        assert.match(importExec(denied(`require('node:fs').readFileSync(${JSON.stringify(source)})`), source), /DENIED:/);
      }
      const unreadable = join(importSources, 'unreadable.txt');
      writeFileSync(unreadable, 'selected but unreadable fixture');
      chmodSync(unreadable, 0);
      try {
        const rejected = JSON.parse(importControl(['selected-film', 'import', '--source', unreadable], 1));
        assert.equal(rejected.status, 'failed');
        assert.match(rejected.error, /EACCES|EPERM/);
        assert.deepEqual(readFileSync(join(importProject, 'inputs/import.json')), previous);
        assert.match(importExec(denied(`require('node:fs').readFileSync(${JSON.stringify(unreadable)})`), unreadable), /DENIED:/);
      } finally { chmodSync(unreadable, 0o600); }
    });
    await check('统一入口取消导入将信号逐层转发并保留中断回执', async () => {
      const previous = readFileSync(join(importProject, 'inputs/import.json'));
      const runs = join(importProject, 'runs');
      const before = new Set(readdirSync(runs));
      const source = join(importSources, 'interrupt.bin');
      writeFileSync(source, '');
      truncateSync(source, 536870912);
      const child = spawn(process.execPath, [join(importSkill, 'scripts/video.mjs'), 'selected-film', 'import', '--source', source], { cwd: importRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '', cancelled = false;
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const status = await new Promise((resolve, reject) => {
        const cleanup = () => { clearInterval(watch); clearTimeout(timeout); };
        const watch = setInterval(() => {
          for (const attempt of readdirSync(runs).filter(name => !before.has(name))) {
            const path = join(runs, attempt, 'receipt.json');
            if (!existsSync(path)) continue;
            const receipt = json(path);
            if (!cancelled && receipt.status === 'running' && receipt.phase === 'copying' && receipt.counts.copiedBytes > 0) {
              cancelled = true;
              child.kill('SIGTERM');
            }
          }
        }, 10);
        const timeout = setTimeout(() => { cleanup(); process.kill(-child.pid, 'SIGKILL'); reject(new Error('IMPORT_CANCEL_TIMEOUT')); }, 30000);
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', code => { cleanup(); resolve(code); });
      });
      assert.equal(cancelled, true, errors + output);
      assert.equal(status, 1, errors + output);
      const receipt = JSON.parse(output);
      assert.equal(receipt.status, 'interrupted');
      assert.equal(receipt.indexCommitted, false);
      assert.equal(json(join(runs, receipt.attemptId, 'receipt.json')).status, 'interrupted');
      assert.deepEqual(readFileSync(join(importProject, 'inputs/import.json')), previous);
    });
    await check('导入专用沙箱限制选定来源、后代读取写入、网络与环境', async () => {
      const escaped = join(importSources, 'escaped.txt');
      const child = `${denied(`require('node:fs').readFileSync(${JSON.stringify(importUnselected)})`)};${denied(`require('node:fs').writeFileSync(${JSON.stringify(escaped)},'blocked')`)};`;
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const code = `const fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(importSource)},'utf8').length===0)process.exit(1);${child}const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.JBM_UNSELECTED_SECRET||process.env.NODE_OPTIONS||process.env.HOME||process.env.OPENSSL_CONF!=='/dev/null')process.exit(1);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code);});`;
        const result = importExec(code, importSource);
        assert.equal((result.match(/DENIED:/g) ?? []).length, 5);
        assert.match(result, /NETWORK_DENIED:/);
        assert.equal(existsSync(escaped), false);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await checkUnpackNative({ scratch, skill, run, check, denied });
    await checkCatalogNative({ scratch, skill, run, check, denied });
    await checkDocumentNative({ scratch, skill, run, check, denied });
    await checkOfficeNative({ scratch, skill, run, check });
    await checkAssetsNative({ scratch, skill, run, check });
    await checkProductionAssetsNative({ scratch, skill, run, check });
    await checkOcrNative({ scratch, skill, run, check, denied });
    await checkAsrNative({ scratch, skill, run, check, denied });
    await checkAlignmentNative({ scratch, skill, run, check, denied });
    await checkAudioInputNative({ scratch, skill, check });
    await checkDocumentOcrNative({ scratch, skill, check });
    await check('核心或运行时改动阻止调用，失败保留有效备份', () => {
      const extra = join(skill, 'unexpected.txt');
      const old = saved();
      try { writeFileSync(extra, 'changed'); assert.match(control(['backup'], 1), /SKILL_CHANGED/); assert.deepEqual(saved(), old); }
      finally { rmSync(extra, { force: true }); }
      const runtimeExtra = join(a, '.engine/unexpected.txt');
      try { writeFileSync(runtimeExtra, 'changed'); assert.match(local(a, ['capabilities'], 1), /RUNTIME_CHANGED/); }
      finally { rmSync(runtimeExtra, { force: true }); }
      const lockPath = join(a, 'workspace.json');
      const lock = json(lockPath);
      try { writeJson(lockPath, { ...lock, isolationSha256: 'changed' }); assert.match(local(a, ['capabilities'], 1), /RUNTIME_LOCK_CHANGED/); }
      finally { writeJson(lockPath, lock); }
    });
    await check('文字、图像与视频参考留在本片，核心标准保持固定', async () => {
      const require = createRequire(join(engine, 'package.json'));
      const { Canvas } = require('skia-canvas');
      const image = new Canvas(16, 16);
      image.getContext('2d').fillRect(2, 2, 6, 6);
      await image.toFile(join(a, 'assets/reference.png'));
      writeFileSync(join(a, 'assets/reference.txt'), '本片测试文档；按本片意图处理。');
      const clip = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=24:d=0.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(a, 'assets/reference.mp4')], { encoding: 'utf8' });
      assert.equal(clip.status, 0, clip.stderr);
      const brief = json(join(a, 'brief.json'));
      brief.claims.zeroExternalAssets = false;
      brief.claims.pureCode = false;
      brief.tools.allowed.push('imagegen');
      brief.assets = [['reference.txt', 'document'], ['reference.png', 'image'], ['reference.mp4', 'video']].map(([name, kind]) => ({ path: `assets/${name}`, kind, license: 'self-created verification input', sha256: digest(readFileSync(join(a, 'assets', name))) }));
      brief.inputs = { documents: [{ note: '本片测试文档' }], referenceClips: [{ note: '本片测试视频' }] };
      writeJson(join(a, 'brief.json'), brief);
      assert.equal(verifyCore().packageId, original.packageId);
      assert.equal(existsSync(join(b, 'assets/reference.txt')), false);
    });
    await check('本片源码、计划编译、输入审计与分镜', () => {
      for (const project of [a, b]) {
        writeJson(join(project, 'project.json'), { ...json(join(project, 'project.json')), drawing: 'src/draw.mjs' });
        writeJson(join(project, 'director.json'), { version: '0.1', idea: json(join(project, 'director.json')).idea, title: '核心验证', aspect: '16:9', look: 'graphic', bpm: 120, captionLayout: { fontScale: 0.04, translationScale: 0.625, maxWidth: 0.78, bottomInset: 0.11 }, shots: [{ purpose: '验证本片代码', visualIntent: '方块水平移动', beats: 2, title: '测试', backdrop: 'studio', motif: 'none', actors: [], cameraMove: 'static', transition: 'cut' }] });
        writeFileSync(join(project, 'src/components/easing.ts'), readFileSync(join(project, 'src/components/easing.ts'), 'utf8') + '\nexport const testOffset = 0;\n');
        const bitmap = project === a ? "import { loadImage } from '../.engine/node_modules/skia-canvas/lib/index.js';\nconst image = await loadImage(new URL('../assets/reference.png', import.meta.url).pathname);\n" : '';
        writeFileSync(join(project, 'src/draw.mjs'), "import { testOffset } from './components/easing.ts';\n" + bitmap + "export function drawScene({ctx,width,height,progress}) { ctx.fillStyle='#112233';ctx.fillRect(0,0,width,height);" + (bitmap ? "ctx.drawImage(image,80,30,32,32);" : '') + "ctx.fillStyle='#ee7744';ctx.fillRect(20+60*progress+testOffset,20,25,25); }\n");
        for (const args of [['direct', 'compile'], ['brief', 'validate'], ['qa'], ['project', 'audit']]) video(project, args);
        assert.equal(json(join(project, 'spec/main.json')).captions.fontScale, 0.04);
      }
      video(a, ['storyboard', '--per-shot', '--width', '160', '--height', '90', '--json']);
      local(a, ['frame', '--at', '0.5', '--out', join(scratch, 'escaped.png')], 1);
      assert.equal(existsSync(join(scratch, 'escaped.png')), false);
    });
    await check('乱序同帧一致，修改组件只改变本片', () => {
      const frame = (project, at, name) => {
        const out = join(project, 'out', name + '.png');
        local(project, ['frame', '--at', String(at), '--width', '160', '--height', '90', '--out', out]);
        return digest(readFileSync(out));
      };
      const first = frame(a, 0.2, 'first');
      assert.notEqual(frame(a, 0.7, 'later'), first);
      assert.equal(frame(a, 0.2, 'repeat'), first);
      const other = frame(b, 0.2, 'other');
      const beforeOther = fileHashes(join(b, 'src'));
      const component = join(a, 'src/components/easing.ts');
      writeFileSync(component, readFileSync(component, 'utf8').replace('testOffset = 0', 'testOffset = 30'));
      assert.notEqual(frame(a, 0.2, 'edited'), first);
      assert.equal(frame(b, 0.2, 'unchanged'), other);
      assert.deepEqual(fileHashes(join(b, 'src')), beforeOther);
    });
    await check('固定图片素材与代码动作共同进入渲染帧', async () => {
      const require = createRequire(join(engine, 'package.json'));
      const { Canvas, loadImage } = require('skia-canvas');
      const image = await loadImage(join(a, 'out/first.png'));
      const canvas = new Canvas(160, 90);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      assert.deepEqual([...ctx.getImageData(90, 38, 1, 1).data], [0, 0, 0, 255]);
      assert.deepEqual([...ctx.getImageData(40, 25, 1, 1).data], [238, 119, 68, 255]);
      const brief = json(join(a, 'brief.json'));
      assert.equal(brief.claims.pureCode, false);
      assert.ok(brief.tools.allowed.includes('imagegen'));
    });
    await check('真实配音、编码音轨、源码事实与披露完整', () => {
      const plan = json(join(a, 'director.json'));
      plan.shots[0].beats = 4;
      plan.shots[0].narration = '开始。';
      plan.voice = 'female_lively';
      plan.narrationRate = 15;
      plan.shots[0].narrationOffset = 0.1;
      plan.shots[0].sfx = [{ offset: 0.4, preset: 'click', volume: 0.08 }, { offset: 1.1, preset: 'success', volume: 0.08 }];
      writeJson(join(a, 'director.json'), plan);
      for (const args of [['direct', 'compile'], ['env', '--json'], ['audio'], ['render', '--width', '160', '--height', '90', '--preset', 'ultrafast', '--json']]) video(a, args);
      const quality = JSON.parse(video(a, ['qa']));
      assert.ok(quality.narrationPacing.voicedSeconds > 0);
      assert.equal(quality.narrationPacing.meanGapSeconds, 0);
      assert.ok(!quality.issues.some(issue => issue.code === 'NARRATION_TIMING_PENDING'));
      assert.equal(quality.narrationPacing.headSeconds, 0.1);
      const voiceMetadata = json(join(a, 'out/audio/voice-000.wav.words.json'));
      assert.equal(voiceMetadata.rate, '+15%');
      assert.equal(voiceMetadata.voice, 'zh-CN-XiaoyiNeural');
      assert.deepEqual(json(join(a, 'spec/main.json')).audio.sfx, [{ start: 0.4, preset: 'click', volume: 0.08 }, { start: 1.1, preset: 'success', volume: 0.08 }]);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(a, 'out', slugs[0] + '.mp4')], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
      const run = json(join(a, 'run.json'));
      assert.deepEqual(run.facts.promptHistory, { path: 'prompt-history.jsonl', sha256: digest(readFileSync(join(a, 'prompt-history.jsonl'))), entries: 4 });
      assert.equal(run.facts.runtime.packageId, original.packageId);
      assert.deepEqual(run.facts.drawing.sources, fileHashes(join(a, 'src')).map(file => ({ ...file, path: `src/${file.path}` })));
      assert.ok(json(join(a, 'out/audio/encoded-voice-presence.json')).every(item => item.ok));
      video(a, ['disclosure', '--json']);
      assert.ok(existsSync(join(a, 'DISCLOSURE.md')));
    });
    await check('实际编码身份、审片绑定与失败快照保留', () => {
      const args = ['artifact', '--out', 'evidence/artifact.json'];
      const report = JSON.parse(video(a, args));
      assert.equal(report.ok, true);
      assert.equal(report.scope, 'file-identity');
      const output = join(a, report.artifact.path), review = join(a, 'evidence/artifact.json');
      assert.equal(report.artifact.sha256, digest(readFileSync(output)));
      assert.equal(JSON.parse(video(a, ['artifact', '--review', 'evidence/artifact.json'])).ok, true);
      const saved = readFileSync(review), encoded = readFileSync(output);
      const replaced = Buffer.from(encoded); replaced[replaced.length - 1] ^= 1;
      try {
        writeFileSync(output, replaced);
        assert.ok(JSON.parse(video(a, args, 1)).issues.some(issue => issue.code === 'OUTPUT_HASH_MISMATCH'));
        assert.deepEqual(readFileSync(review), saved);
      } finally { writeFileSync(output, encoded); }
      const source = join(a, 'src/draw.mjs'), previous = readFileSync(source);
      try {
        writeFileSync(source, Buffer.concat([previous, Buffer.from('\n')]));
        assert.ok(JSON.parse(video(a, ['artifact'], 1)).issues.some(issue => issue.code === 'DRAWING_MISMATCH'));
      } finally { writeFileSync(source, previous); }
      assert.equal(JSON.parse(video(a, ['artifact', '--review', 'evidence/artifact.json'])).ok, true);
      assert.match(video(a, ['artifact', '--out', 'src/overwrite.json'], 1), /PROJECT_ISOLATION/);
      assert.equal(existsSync(join(a, 'src/overwrite.json')), false);
    });
    await check('连续编码诊断绑定成片与窗口，产物保持本片隔离', () => {
      const report = JSON.parse(video(a, ['diagnose', '--from', '0.25', '--to', '1.5', '--width', '160', '--purpose', 'reading']));
      assert.equal(report.window.firstFrame, 6); assert.equal(report.window.lastFrame, 35);
      assert.equal(report.summary.pairCount, 29);
      assert.equal(report.artifact.sha256, json(join(a, 'evidence/artifact.json')).artifact.sha256);
      const evidence = json(join(a, report.outDir, 'report.json'));
      assert.equal(evidence.text.scope, 'source-glyph-bounds');
      assert.ok(existsSync(join(a, report.outDir, 'frame-strip.png')));
      assert.ok(existsSync(join(a, report.outDir, 'motion-heatmap.png')));
      assert.match(local(a, ['diagnose', '--to', '1', '--out-dir', 'src/diagnostic'], 1), /PROJECT_ISOLATION/);
    });
    await check('统一入口离线定稿与复用声音，独立执行快照和失败保护', () => {
      const previous = json(join(a, 'run.json'));
      const voice = previous.measured.audioArtifacts.find(item => item.role === 'voice');
      assert.ok(voice);
      mkdirSync(join(a, 'assets/audio'), { recursive: true });
      writeFileSync(join(a, 'assets/audio/voice.wav'), readFileSync(join(a, '.engine', voice.path)));
      const locked = JSON.parse(video(a, ['audio', 'lock', '--tts-provider', 'file', '--no-network']));
      assert.match(locked.audioLock.path, /^assets\/derived\/audio\/[a-f0-9]{64}\/audio-lock\.json$/);
      const masterSha256 = digest(readFileSync(locked.master));
      const args = ['render', '--audio-lock', locked.audioLock.path, '--tts-provider', 'mock', '--no-network', '--width', '160', '--height', '90', '--preset', 'ultrafast', '--json'];
      const first = JSON.parse(video(a, args));
      assert.ok(first.attemptId);
      assert.equal(first.providers.tts, '(none)');
      assert.equal(first.audioReuse.sourceProviders.tts, 'file');
      const run = json(join(a, 'run.json'));
      assert.ok(run.measured.audioArtifacts.some(item => item.role === 'master' && item.sha256 === masterSha256));
      assert.ok(run.facts.assets.consumed.some(item => item.role === 'audio-source'));
      assert.equal(run.facts.network.length, 0);
      assert.equal(digest(readFileSync(join(a, `runs/${first.attemptId}/input-snapshot.json`))), run.execution.inputSnapshotSha256);
      assert.ok(JSON.parse(video(a, ['artifact', '--review', 'evidence/artifact.json'], 1)).issues.some(issue => issue.code === 'REVIEW_BINDING_MISMATCH'));
      const source = join(a, 'src/draw.mjs');
      writeFileSync(source, readFileSync(source, 'utf8').replace('#ee7744', '#44aaee'));
      const second = JSON.parse(video(a, args));
      assert.notEqual(first.attemptId, second.attemptId);
      assert.notEqual(digest(readFileSync(first.out)), digest(readFileSync(second.out)));
      assert.equal(digest(readFileSync(locked.master)), masterSha256);
      assert.equal(digest(readFileSync(join(a, 'out', slugs[0] + '.mp4'))), digest(readFileSync(second.out)));
      const current = readFileSync(join(a, 'run.json')), encoded = readFileSync(second.out), alias = readFileSync(second.current), drawing = readFileSync(source);
      try {
        writeFileSync(source, 'export function drawScene() { throw new Error("EXPECTED_RENDER_FAILURE"); }\n');
        assert.match(video(a, args, 1), /RENDER_FAILED/);
        assert.deepEqual(readFileSync(join(a, 'run.json')), current);
        assert.deepEqual(readFileSync(second.out), encoded);
        assert.deepEqual(readFileSync(second.current), alias);
      } finally { writeFileSync(source, drawing); }
      assert.equal(JSON.parse(video(a, ['artifact'])).ok, true);
    });
    await check('两份备份可完整恢复核心，共享文件保持一致', () => {
      assert.equal(saved().length, 2);
      const restored = join(scratch, 'restored/.skill');
      mkdirSync(restored, { recursive: true });
      const extract = spawnSync('tar', ['-xzf', join(backups, saved().at(-1)), '-C', restored], { encoding: 'utf8' });
      assert.equal(extract.status, 0, extract.stderr);
      const id = run(dirname(restored), ['--input-type=module', '-e', `const {verifyCore}=await import(${JSON.stringify(pathToFileURL(join(restored, 'scripts/core.mjs')).href)});process.stdout.write(verifyCore().packageId);`]);
      assert.equal(id, original.packageId);
      assert.deepEqual(shared.map(path => digest(readFileSync(join(skill, path)))), before);
      assert.equal(verifyCore().packageId, original.packageId);
    });
    writeJson(join(output, 'core-verification.json'), { ok: true, packageId: original.packageId, checks });
    process.stdout.write(`通过 ${checks.length} 项核心检查\n`);
  } finally {
    for (const project of [a, b]) rmSync(project, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
