import { createFixtureProject } from './fixtures/project.ts';
/**
 * 项目层测试（task-1 / task-2）。
 *
 * 重点同样不在 happy path，而在**分层容易破的地方**：
 *   - manifest 写错字段名（静默忽略是弱模型最难自查的失败模式）
 *   - slug 与目录名不一致（复制目录改项目时的残留）
 *   - entry 用 `..` 逃出项目目录（AGENTS.md 硬性规则 1 必须由代码强制）
 *   - 旧路径（裸 spec）必须继续可用（向后兼容不是口号）
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import { archetypesDirExists } from '../src/project/archetypes.ts';
import { checkBrief, loadBriefFile } from '../src/project/brief.ts';
import { initProject } from '../src/project/scaffold.ts';
import {
  PROJECTS_DIR,
  listProjectSlugs,
  loadProject,
  readProjectManifest,
  resolveInsideProject,
  resolveTarget,
} from '../src/project/manifest.ts';

/** 临时项目目录放进项目内的 .research/（遵守「产物不落外部路径」的规则）
 *
 * 直接用 mkdtemp 生成带随机后缀的目录，不再先建一个固定父目录——
 * 固定父目录会留在磁盘上（每次跑测试都重建一个空目录），属于自己生产的垃圾。
 */
const fixture = createFixtureProject({ projectsRoot: PROJECTS_DIR, slug: 'project-test-fixture' });
after(fixture.cleanup);

const SCRATCH_ROOT = join(PROJECT_ROOT, '.research', 'out');

function scratchRoot(name: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, `${name}-`));
}

/**
 * 建一个临时项目目录，**目录名等于 slug**。
 * 目录名与 slug 一致是 manifest 规范的一部分，因此夹具必须遵守它，
 * 否则测的就不是产品行为，而是夹具自己的错误。
 */
function withScratch<T>(name: string, fn: (dir: string) => T): T {
  const parent = scratchRoot(`project-tests-${name}`);
  const dir = join(parent, 'my-film');
  mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.1',
    slug: 'my-film',
    title: '我的片子',
    status: 'draft',
    entry: 'spec/main.json',
    ...overrides,
  };
}

function writeProject(dir: string, manifest: Record<string, unknown>, spec?: unknown): void {
  mkdirSync(join(dir, 'spec'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2));
  if (spec !== undefined) {
    writeFileSync(join(dir, String(manifest['entry'])), JSON.stringify(spec, null, 2));
  }
}

// ------------------------------------------------------------ happy path

test('projects/ 下的每个项目都能被解析（当前至少 project-test-fixture）', () => {
  const slugs = listProjectSlugs();
  assert.ok(slugs.includes('project-test-fixture'), `应包含 project-test-fixture，实际: ${slugs.join(', ')}`);
  const p = loadProject('project-test-fixture');
  assert.equal(p.manifest.slug, 'project-test-fixture');
  assert.equal(p.manifest.status, 'draft');
  assert.equal(p.specPath, join(PROJECT_ROOT, 'projects', 'project-test-fixture', 'spec', 'main.json'));
  assert.equal(p.outDir, join(PROJECT_ROOT, 'projects', 'project-test-fixture', 'out'));
  assert.ok(p.briefPath === null || p.briefPath.endsWith('brief.json'));
});

test('项目目录必须落在 projects/ 之内（分层边界）', () => {
  assert.equal(PROJECTS_DIR, join(PROJECT_ROOT, 'projects'));
  const p = loadProject('project-test-fixture');
  assert.ok(p.dir.startsWith(PROJECTS_DIR + '/'), p.dir);
});

// ------------------------------------------------------------ 一支影片 = 一个目录

const BARE_SPEC = join(PROJECT_ROOT, '.research', 'out', 'probe.json');

test('项目目录里的 spec 路径 → 自动绑定项目（不散到仓库根）', () => {
  const t = resolveTarget('projects/project-test-fixture/spec/main.json');
  assert.equal(t.project?.slug, 'project-test-fixture', '参数写成路径也得走项目，否则成片会落到仓库根的 out/');
  assert.equal(t.label, 'project-test-fixture', '产物命名跟项目走');
  assert.equal(t.specPath, join(PROJECT_ROOT, 'projects', 'project-test-fixture', 'spec', 'main.json'));
});

test('项目 spec 的三条写法都归到同一个项目', () => {
  const bySlug = resolveTarget('project-test-fixture');
  const byDir = resolveTarget('projects/project-test-fixture');
  const bySpec = resolveTarget('projects/project-test-fixture/spec/main.json');
  for (const t of [bySlug, byDir, bySpec]) {
    assert.equal(t.project?.slug, 'project-test-fixture');
    assert.equal(t.project?.outDir, join(PROJECT_ROOT, 'projects', 'project-test-fixture', 'out'));
    assert.equal(t.specPath, bySlug.specPath);
  }
});

test('projects/ 下的非项目路径报错，不退化成裸 spec', () => {
  assert.throws(
    () => resolveTarget('projects/not-a-project/spec/main.json'),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_NOT_FOUND,
    'projects/ 里只放项目；临时 spec 应放 .research/out/',
  );
});

test('非项目 spec 仍按裸 spec 解析（探针/引擎级夹具的通道）', () => {
  const t = resolveTarget('.research/out/probe.json');
  assert.equal(t.project, null, '不在 projects/ 里的 spec 不强行绑定项目');
  assert.equal(t.label, 'probe');
  assert.equal(t.specPath, BARE_SPEC);
});

test('仓库根不存放项目文件：兼容层（examples/ 与根 out/）已移除', () => {
  for (const legacy of ['examples', 'out']) {
    assert.ok(!existsSync(join(PROJECT_ROOT, legacy)), `${legacy}/ 是旧兼容层，应已删除`);
  }
  // projects/ 之外不得出现 manifest / 遥测：一支影片的全部文件都在它自己的目录里
  const strays: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'projects'].includes(entry.name)) continue;
        walk(join(dir, entry.name), child);
      } else if (['project.json', 'run.json', 'DISCLOSURE.md'].includes(entry.name)) {
        strays.push(child);
      }
    }
  };
  walk(PROJECT_ROOT, '');
  assert.deepEqual(strays, [], `项目文件必须落在 projects/<slug>/ 里，发现散落: ${strays.join(', ')}`);
});

// ------------------------------------------------------------ 错误路径

test('未知 slug → PROJECT_NOT_FOUND 且列出可用项目', () => {
  try {
    loadProject('no-such-project');
    assert.fail('应当抛错');
  } catch (err) {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, ERROR_CODES.PROJECT_NOT_FOUND);
    assert.ok(err.allowed?.includes('project-test-fixture'), '错误里应带可用项目列表');
  }
});

test('未知字段被拒绝，而不是静默忽略', () => {
  withScratch('unknown-field', (dir) => {
    writeProject(dir, validManifest({ tille: '打错的字段名' }), { version: '0.1' });
    try {
      readProjectManifest(dir);
      assert.fail('应当抛错');
    } catch (err) {
      assert.ok(err instanceof EngineError);
      assert.equal(err.code, ERROR_CODES.PROJECT_INVALID);
      assert.match(String(err.details?.['errors']), /tille/, '错误里应指出具体字段名');
    }
  });
});

test('slug 与目录名不一致 → 报错并给出改法', () => {
  withScratch('slug-mismatch', (dir) => {
    // 目录名是 my-film，manifest 却写 other-slug
    writeProject(dir, validManifest({ slug: 'other-slug' }), { version: '0.1' });
    try {
      readProjectManifest(dir);
      assert.fail('应当抛错');
    } catch (err) {
      assert.ok(err instanceof EngineError);
      assert.equal(err.code, ERROR_CODES.PROJECT_INVALID);
      assert.equal(err.details?.['slug'], 'other-slug');
      assert.equal(err.details?.['dir'], 'my-film');
      assert.ok(err.hint);
    }
  });
});

test('entry 用 .. 逃出项目目录 → 报错（硬性规则 1 由代码强制）', () => {
  assert.throws(
    () => resolveInsideProject('/tmp/whatever-project', '../../etc/passwd', 'entry'),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_INVALID,
  );
  assert.throws(
    () => resolveInsideProject('/tmp/whatever-project', '/etc/passwd', 'entry'),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_INVALID,
  );
});

test('manifest 不是合法 JSON → PROJECT_INVALID，不猜内容', () => {
  withScratch('bad-json', (dir) => {
    writeFileSync(join(dir, 'project.json'), '{ not json ');
    assert.throws(
      () => readProjectManifest(dir),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_INVALID,
    );
  });
});

test('status 只能是四个枚举值之一', () => {
  withScratch('bad-status', (dir) => {
    writeProject(dir, validManifest({ status: 'done' }), { version: '0.1' });
    try {
      readProjectManifest(dir);
      assert.fail('应当抛错');
    } catch (err) {
      assert.ok(err instanceof EngineError);
      assert.match(String(err.details?.['errors']), /draft/, '错误里应列出允许值');
    }
  });
});

test('entry 指向的 spec 不存在 → PROJECT_NOT_FOUND', () => {
  withScratch('missing-entry', (dir) => {
    writeProject(dir, validManifest());
    assert.throws(
      () => loadProject(dir),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_NOT_FOUND,
    );
  });
});

test('brief 显式写 null → 该项目不做声明对账', () => {
  withScratch('no-brief', (dir) => {
    writeProject(dir, validManifest({ brief: null }), { version: '0.1' });
    const m = readProjectManifest(dir);
    assert.equal(m.brief, null);
  });
});

test('未写 brief 字段 → 默认约定 brief.json', () => {
  withScratch('default-brief', (dir) => {
    writeProject(dir, validManifest(), { version: '0.1' });
    assert.equal(readProjectManifest(dir).brief, 'brief.json');
  });
});

test('outDir 默认是 out', () => {
  withScratch('default-out', (dir) => {
    writeProject(dir, validManifest(), { version: '0.1' });
    assert.equal(readProjectManifest(dir).outDir, 'out');
  });
});

// ------------------------------------------------------------ 项目骨架（task-7）

test('project init 生成的骨架可以直接通过 VideoSpec 校验', () => {
  const root = scratchRoot('init-skeleton');
  const dir = join(root, 'skeleton-film');
  try {
    const result = initProject({ slug: 'skeleton-film', title: '骨架片', projectsRoot: root });
    assert.deepEqual(result.created.sort(), ['NOTES.md', 'brief.json', 'out/.gitkeep', 'project.json', 'spec/main.json'].sort());

    const manifest = readProjectManifest(dir);
    assert.equal(manifest.status, 'draft');
    assert.equal(manifest.title, '骨架片');

    // 骨架的价值在于「能跑」：spec 必须零问题通过校验
    const outcome = validateSpec(loadSpecFile(join(dir, 'spec', 'main.json')));
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.issues, []);

    // brief 也必须自洽（原型库存在时 archetype 才需要真实存在）
    const brief = checkBrief(loadBriefFile(join(dir, 'brief.json')));
    assert.equal(
      brief.ok,
      true,
      JSON.stringify(brief.issues.filter((i) => i.severity === 'FATAL')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project init 拒绝覆盖已有目录（init 不是 reset）', () => {
  const root = scratchRoot('init-existing');
  try {
    initProject({ slug: 'dup-film', projectsRoot: root });
    assert.throws(
      () => initProject({ slug: 'dup-film', projectsRoot: root }),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_INVALID,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project init 拒绝非法 slug，并给出模式', () => {
  const root = scratchRoot('init-bad');
  try {
    assert.throws(
      () => initProject({ slug: 'Bad Slug!', projectsRoot: root }),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.CLI_USAGE,
    );
    assert.throws(
      () => initProject({ slug: 'a', projectsRoot: root }),
      (err: unknown) => err instanceof EngineError,
      'slug 太短也应被拒',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project init 在原型库存在时校验 archetype 是否存在', () => {
  if (!archetypesDirExists()) return;
  const root = scratchRoot('init-archetype');
  try {
    assert.throws(
      () =>
        initProject({
          slug: 'bad-archetype-film',
          archetype: 'not-real',
          projectsRoot: root,
        }),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_INVALID,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ 目标解析（task-7）

test('resolveTarget：项目与裸 spec 各走各的，不互相干扰', () => {
  const viaProject = resolveTarget('project-test-fixture');
  assert.equal(viaProject.project?.slug, 'project-test-fixture');
  assert.equal(viaProject.label, 'project-test-fixture', '项目的标识用 slug（产物命名跟项目走）');

  const viaBare = resolveTarget('.research/out/probe.json');
  assert.equal(viaBare.project, null);
  assert.equal(viaBare.label, 'probe', '裸 spec 的标识用文件名');
});

test('resolveTarget：未知 slug 清楚报错而不是当成路径去找', () => {
  assert.throws(
    () => resolveTarget('nope-not-here'),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.PROJECT_NOT_FOUND,
  );
});
