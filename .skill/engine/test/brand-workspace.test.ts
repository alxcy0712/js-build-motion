import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('账号默认 + 每片选择：快照记录本片风格，账号默认只影响之后的新片，篡改或缺失快照阻止运行', () => {
  const skill = resolve(import.meta.dirname, '../..');
  const output = join(dirname(skill), '.research/out');
  mkdirSync(output, { recursive: true });
  const workspace = mkdtempSync(join(output, 'brand-workspace-'));
  const run = (args: string[], expected = 0): string => {
    const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 60000 });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, result.stderr + result.stdout);
    return expected ? result.stderr : result.stdout;
  };
  /** 账号默认风格：等价于用户要求更换账号默认后改 .skill/brand.json 并重新 seal。 */
  const setAccountDefault = (theme: string, enforcement: string): string => {
    const bytes = JSON.stringify({ version: 2, owner: 'Fixture Studio', theme, defaultTheme: theme, enforcement,
      changes: [{ at: '2000-01-01', theme, reason: '账号默认：虚构测试' }] }, null, 2) + '\n';
    writeFileSync(join(workspace, '.skill/brand.json'), bytes);
    run(['.skill/scripts/seal.mjs']);
    return bytes;
  };
  const inspect = (slug: string, expected = 0): string => run(['--input-type=module', '-e', `
    import { verifyRuntime } from './projects/${slug}/.engine/workspace.mjs';
    import { loadBrand } from './projects/${slug}/.engine/src/themes/brand.ts';
    import { loadSpecFile, validateSpec } from './projects/${slug}/.engine/src/spec/validate.ts';
    const runtime = verifyRuntime('./projects/${slug}');
    const { spec } = validateSpec(loadSpecFile('./projects/${slug}/spec/main.json'));
    process.stdout.write(JSON.stringify({ packageId: runtime.packageId, brand: loadBrand(), theme: spec.style.theme }));
  `], expected);
  const brandOf = (slug: string): Record<string, unknown> => JSON.parse(readFileSync(join(workspace, 'projects', slug, 'brand.json'), 'utf8'));
  const lockOf = (slug: string): Record<string, unknown> => JSON.parse(readFileSync(join(workspace, 'projects', slug, 'workspace.json'), 'utf8'));
  try {
    const temporary = [join(skill, 'engine/.research'), join(skill, 'engine/projects')];
    cpSync(skill, join(workspace, '.skill'), { recursive: true, dereference: true, filter: path => !temporary.includes(path) });
    const accountDefault = setAccountDefault('minimal', 'override');

    // 本片选择 kinetic：写入快照与 workspace 记录，账号默认文件保持不动
    const first = JSON.parse(run(['.skill/scripts/video.mjs', 'start', 'first', '--idea', '虚构产品发布。', '--theme', 'kinetic']));
    const firstProject = join(workspace, 'projects/first');
    const snapshot = join(firstProject, 'brand.json');
    assert.ok(existsSync(snapshot), '新项目必须保存本片风格快照');
    assert.notEqual(lstatSync(snapshot).ino, lstatSync(join(workspace, '.skill/brand.json')).ino);
    assert.equal(readFileSync(join(workspace, '.skill/brand.json'), 'utf8'), accountDefault);
    const selected = brandOf('first');
    assert.equal(selected['theme'], 'kinetic');
    assert.equal(selected['defaultTheme'], 'minimal');
    assert.equal((selected['changes'] as { theme: string }[]).at(-1)!.theme, 'kinetic');
    assert.equal((selected['changes'] as { reason: string }[]).at(-1)!.reason, '初始化显式指定主题 kinetic（账号默认 minimal）');
    const record = lockOf('first')['brand'] as Record<string, string>;
    assert.equal(record['theme'], 'kinetic');
    assert.equal(record['defaultTheme'], 'minimal');
    const observed = JSON.parse(inspect('first'));
    assert.equal(observed.packageId, first.packageId);
    assert.equal(observed.brand.owner, 'Fixture Studio');
    assert.equal(observed.brand.theme, 'kinetic');
    assert.equal(observed.brand.defaultTheme, 'minimal');
    assert.equal(observed.brand.changes[0].theme, 'minimal');
    assert.equal(observed.theme, 'kinetic', '本片 spec 跟着本片选择');

    const pinned = ['brand.json', 'workspace.json', '.engine/engine-manifest.json', 'video.mjs']
      .map(path => readFileSync(join(firstProject, path)));
    const second = JSON.parse(run(['.skill/scripts/video.mjs', 'start', 'second', '--idea', '虚构原理讲解。']));
    assert.equal(second.packageId, first.packageId, '账号默认未变时核心版本相同');
    assert.equal(brandOf('second')['theme'], 'minimal', '未指定风格时沿用账号默认');
    assert.equal(brandOf('second')['defaultTheme'], 'minimal');
    assert.equal((brandOf('second')['changes'] as { reason: string }[]).at(-1)!.reason, '初始化继承账号默认 minimal');
    const secondObserved = inspect('second');
    assert.equal(JSON.parse(secondObserved).theme, 'minimal');

    // 辅助脚本使用固定运行时所属影片的输出区，与调用 cwd 和外部输出变量独立。
    const outputCode = `import { outputRoot } from './projects/first/.engine/src/utils/output-dir.ts';
      process.stdout.write(outputRoot({ JBM_OUTPUT_DIR: '/outside-fixture' }));`;
    assert.equal(run(['--input-type=module', '-e', outputCode]), join(firstProject, 'out'));
    const projectManifest = join(firstProject, 'project.json');
    const originalManifest = readFileSync(projectManifest);
    const metadata = JSON.parse(originalManifest.toString());
    writeFileSync(projectManifest, JSON.stringify({ ...metadata, outDir: 'out/previews' }));
    assert.equal(run(['--input-type=module', '-e', outputCode]), join(firstProject, 'out/previews'));
    writeFileSync(projectManifest, JSON.stringify({ ...metadata, outDir: '../second/out' }));
    assert.match(run(['--input-type=module', '-e', outputCode], 1), /PROJECT_INVALID/);
    writeFileSync(projectManifest, originalManifest);

    // 账号默认改成 kinetic 只影响之后的新片
    const kineticDefault = setAccountDefault('kinetic', 'reject');
    assert.equal(inspect('first'), JSON.stringify(observed));
    assert.equal(inspect('second'), secondObserved);
    assert.deepEqual(['brand.json', 'workspace.json', '.engine/engine-manifest.json', 'video.mjs']
      .map(path => readFileSync(join(firstProject, path))), pinned);
    const third = JSON.parse(run(['.skill/scripts/video.mjs', 'start', 'third', '--idea', '虚构后续影片。']));
    assert.notEqual(third.packageId, first.packageId, '账号默认变更后核心版本更新');
    assert.equal(brandOf('third')['theme'], 'kinetic');
    assert.equal(brandOf('third')['defaultTheme'], 'kinetic');
    assert.equal((brandOf('third')['changes'] as { reason: string }[]).at(-1)!.reason, '初始化继承账号默认 kinetic');
    assert.equal(readFileSync(join(workspace, '.skill/brand.json'), 'utf8'), kineticDefault);

    const legacy = join(workspace, 'projects/legacy');
    mkdirSync(join(legacy, '.engine'), { recursive: true });
    writeFileSync(join(legacy, 'workspace.json'), JSON.stringify({ version: '0.2', packageId: 'legacy-fixture' }));
    writeFileSync(join(legacy, '.engine/release.json'), JSON.stringify({ release: 'legacy-fixture' }));
    writeFileSync(join(legacy, 'video.mjs'), "import {readFileSync} from 'node:fs';process.stdout.write(readFileSync('.engine/release.json','utf8'));\n");
    const legacyPaths = ['workspace.json', 'video.mjs', '.engine/release.json'];
    const legacyBytes = legacyPaths.map(path => readFileSync(join(legacy, path)));
    assert.deepEqual(JSON.parse(run(['.skill/scripts/video.mjs', 'legacy', 'capabilities'])), { release: 'legacy-fixture' });
    assert.equal(existsSync(join(legacy, 'brand.json')), false);
    assert.deepEqual(legacyPaths.map(path => readFileSync(join(legacy, path))), legacyBytes);

    const bytes = readFileSync(snapshot);
    writeFileSync(snapshot, JSON.stringify({ version: 2, theme: 'minimal', defaultTheme: 'minimal', enforcement: 'override', changes: [] }));
    assert.match(inspect('first', 1), /RUNTIME_BRAND_CHANGED/);
    rmSync(snapshot);
    assert.match(inspect('first', 1), /RUNTIME_BRAND_CHANGED/);
    writeFileSync(snapshot, bytes);
    assert.equal(inspect('first'), JSON.stringify(observed));
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
