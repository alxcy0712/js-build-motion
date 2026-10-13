import { createFixtureProject } from './fixtures/project.ts';
/**
 * 项目隔离审计测试（task-10）。
 *
 * 这条规则的用途是**模型对比**：同一个提示词、不同模型各做一支，
 * 谁都不许读别人的产物。测试要证明两件事：
 *   1. 越界能被抓到（三种写法：字面 `projects/<other>/`、相对 `../<other>/`、绝对路径）；
 *   2. 干净的项目不被误判——误报会让规则变成噪声，最后没人跑它。
 *
 * 与其它项目层测试一样，夹具建在 `.research/out/` 里（AGENTS.md 硬性规则 1：
 * 产物不落外部路径），跑完即删。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { auditProjectIsolation, type IsolationViolation } from '../src/project/isolation.ts';
import { loadProject, readProjectManifest } from '../src/project/manifest.ts';
import { initProject } from '../src/project/scaffold.ts';

const SCRATCH_ROOT = join(PROJECT_ROOT, '.research', 'out');

interface Fixture {
  /** 沙盒里的 projects/ 根目录 */
  readonly root: string;
  readonly cleanup: () => void;
}

function makeFixture(name: string): Fixture {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_ROOT, `isolation-${name}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 写一个最小项目；`brief` / `spec` 只给审计看，不要求通过 schema */
function writeProject(
  root: string,
  slug: string,
  files: { brief?: unknown; spec?: unknown } = {},
): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, 'spec'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: '0.1',
        slug,
        title: slug,
        status: 'draft',
        entry: 'spec/main.json',
        brief: 'brief.json',
        outDir: 'out',
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'spec', 'main.json'), JSON.stringify(files.spec ?? { version: '0.1' }, null, 2));
  writeFileSync(
    join(dir, 'brief.json'),
    JSON.stringify(files.brief ?? { version: '0.1', intent: '（占位）做一支短片' }, null, 2),
  );
  return dir;
}

function audit(dir: string): readonly IsolationViolation[] {
  const manifest = readProjectManifest(dir);
  return auditProjectIsolation(dir, manifest).violations;
}

function kinds(violations: readonly IsolationViolation[]): string[] {
  return violations.map((v) => v.kind).sort();
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src', 'cli', 'index.ts'), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ------------------------------------------------------------ 不误报

const fixture = createFixtureProject();
after(fixture.cleanup);

test('临时项目 通过隔离审计（规则不能是噪声）', () => {
  const project = fixture;
  const report = auditProjectIsolation(project.dir, project.manifest);
  assert.deepEqual(report.violations, []);
  assert.equal(report.isolated, true);
  assert.ok(report.files.includes('brief.json'), 'brief.json 必须在扫描范围内');
  assert.ok(report.files.includes('spec/main.json'), '入口 spec 必须在扫描范围内');
});

test('project init 生成的骨架通过隔离审计', () => {
  const fx = makeFixture('skeleton');
  try {
    initProject({ slug: 'skeleton-film', projectsRoot: fx.root });
    const dir = join(fx.root, 'skeleton-film');
    // loadProject 内部已经强制审计：这里能跑到下一行就说明骨架是干净的
    const project = loadProject(dir);
    assert.equal(auditProjectIsolation(dir, project.manifest).isolated, true);
  } finally {
    fx.cleanup();
  }
});

test('外链与散文不误报：URL、data URI、不带路径的裸文件名都放过', () => {
  const fx = makeFixture('benign');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      brief: {
        version: '0.1',
        intent: '参考 https://example.com/clips/rain.mp4 的节奏，用 run.json 里的实测数据说明产线',
        notes: 'data:audio/wav;base64,AAAA 是内联样例；素材清单见 brief.json 的 assets 段',
      },
    });
    assert.deepEqual(kinds(audit(dir)), []);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ 越界：三种写法

test('引用另一个项目的产物 → cross-project（字面写法）', () => {
  const fx = makeFixture('literal-cross');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      brief: { version: '0.1', intent: '照抄 projects/other-film/out/other-film.mp4 的节奏' },
    });
    writeProject(fx.root, 'other-film');
    const violations = audit(dir);
    assert.deepEqual(kinds(violations), ['cross-project']);
    assert.equal(violations[0]?.target, 'other-film');
    assert.match(violations[0]?.file ?? '', /brief\.json/);
    assert.ok(violations[0]?.hint, '越界必须给出改法');
  } finally {
    fx.cleanup();
  }
});

test('引用另一个项目的产物 → cross-project（相对路径写法）', () => {
  const fx = makeFixture('relative-cross');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      brief: {
        version: '0.1',
        intent: '把邻居的素材拿过来用',
        assets: [{ path: '../other-film/assets/logo.png', kind: 'image', license: 'unknown' }],
      },
    });
    writeProject(fx.root, 'other-film');
    const violations = audit(dir);
    assert.deepEqual(kinds(violations), ['cross-project']);
    assert.equal(violations[0]?.target, 'other-film');
    assert.match(violations[0]?.pointer ?? '', /assets\/0\/path/);
  } finally {
    fx.cleanup();
  }
});

test('把本项目 out/ 里的产物当输入 → own-output', () => {
  const fx = makeFixture('own-output');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      // 字面写法：显式写出 projects/my-film/out/...
      brief: { version: '0.1', intent: '上一版成片在 projects/my-film/out/my-film.mp4，接着改' },
      // 相对写法：spec 里引用上一帧抽图
      spec: { version: '0.1', scenes: [{ id: 'scene_01', referenceImage: 'out/frame-0001.png' }] },
    });
    const violations = audit(dir);
    assert.deepEqual(kinds(violations), ['own-output', 'own-output']);
    assert.ok(
      violations.some((v) => v.file === 'spec/main.json'),
      'spec 里的产物引用也要抓',
    );
  } finally {
    fx.cleanup();
  }
});

test('绝对路径与 ../ 逃逸 → outside-project', () => {
  const fx = makeFixture('outside');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      brief: {
        version: '0.1',
        intent: '用系统字体',
        notes: '字体取 /System/Library/Fonts/PingFang.ttc，参考片在 ../../refs/rain.mp4',
      },
    });
    const violations = audit(dir);
    assert.deepEqual(kinds(violations), ['outside-project', 'outside-project']);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ 强制点

test('loadProject 在越界时硬失败：PROJECT_ISOLATION_VIOLATION', () => {
  const fx = makeFixture('enforce');
  try {
    const dir = writeProject(fx.root, 'my-film', {
      brief: { version: '0.1', intent: '读别的项目的成片当参考：projects/other-film/out/other-film.mp4' },
    });
    writeProject(fx.root, 'other-film');

    assert.throws(
      () => loadProject(dir),
      (err: unknown) => {
        assert.ok(err instanceof EngineError);
        assert.equal(err.code, ERROR_CODES.PROJECT_ISOLATION_VIOLATION);
        const details = String(err.details?.['violations']);
        assert.match(details, /other-film/, '错误里要点名被引用的项目');
        assert.match(details, /brief\.json/, '错误里要指出是哪个文件');
        assert.ok(err.hint, '错误里要给出改法');
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});

test('文件不是合法 JSON 时审计报 unparsable，而不是谎报干净', () => {
  const fx = makeFixture('unparsable');
  try {
    const dir = writeProject(fx.root, 'my-film');
    writeFileSync(join(dir, 'spec', 'main.json'), '{ not json ');
    const violations = audit(dir);
    assert.deepEqual(kinds(violations), ['unparsable']);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------ 命令行

test('CLI：干净项目退出码 0，越界项目退出码 1 并列出违规', () => {
  const fx = makeFixture('cli');
  try {
    const dirty = writeProject(fx.root, 'dirty-film', {
      brief: { version: '0.1', intent: '读 projects/other-film/out/x.mp4' },
    });
    writeProject(fx.root, 'other-film');

    const okRun = runCli(['project', 'audit', fixture.dir]);
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.match(okRun.stdout, /干净/);

    const dirtyRun = runCli(['project', 'audit', dirty.replace(PROJECT_ROOT + '/', '')]);
    assert.equal(dirtyRun.status, 1);
    assert.match(dirtyRun.stdout + dirtyRun.stderr, /cross-project|另一个项目/);
  } finally {
    fx.cleanup();
  }
});

test('CLI：--json 输出结构化违规，供对比脚本消费', () => {
  const fx = makeFixture('cli-json');
  try {
    const dirty = writeProject(fx.root, 'dirty-film', {
      brief: { version: '0.1', intent: '读 projects/other-film/out/x.mp4' },
    });
    writeProject(fx.root, 'other-film');

    const r = runCli(['project', 'audit', dirty.replace(PROJECT_ROOT + '/', ''), '--json']);
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout) as {
      ok: boolean;
      projects: { slug: string; violations: { kind: string; target: string }[] }[];
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.projects[0]?.slug, 'dirty-film');
    assert.equal(parsed.projects[0]?.violations[0]?.kind, 'cross-project');
    assert.equal(parsed.projects[0]?.violations[0]?.target, 'other-film');
  } finally {
    fx.cleanup();
  }
});

test('CLI：缺少参数时给出用法，而不是默默扫全部', () => {
  const r = runCli(['project', 'audit']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /project audit/);
});
