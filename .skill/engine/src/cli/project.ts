import { assertContained } from '../project/paths.ts';
import { inspectArtifact } from '../project/artifact.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import { loadSpecFile, summarizeIssues, validateSpec } from '../spec/validate.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { PROJECTS_DIR, listProjectSlugs, listProjectDirectories, loadProject, projectDir, readProjectManifest, resolveInsideProject } from '../project/manifest.ts';
import { briefErrorFromIssues, checkBrief, loadBriefFile } from '../project/brief.ts';
import { listArchetypes } from '../project/archetypes.ts';
import { initProject } from '../project/scaffold.ts';
import { auditProjectIsolation, describeViolation, type IsolationViolation } from '../project/isolation.ts';
import { buildDisclosure, writeDisclosure, DISCLOSURE_FILE } from '../project/disclosure.ts';
import { RUN_LOG_FILE } from '../project/run-log.ts';
import { printIssues } from './environment.ts';
import { requireTarget } from './shared.ts';
import { run, main } from './index.ts';

export function cmdProject(argv: string[]): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  switch (sub) {
    case 'list':
      return cmdProjectList(rest);
    case 'init':
      return cmdProjectInit(rest);
    case 'archetypes':
      return cmdProjectArchetypes(rest);
    case 'audit':
      return cmdProjectAudit(rest);
    case undefined:
      throw new EngineError(ERROR_CODES.CLI_USAGE, 'project 需要子命令', {
        allowed: ['list', 'init', 'archetypes', 'audit'],
        hint: '用法: node .skill/engine/src/cli/index.ts project list',
      });
    default:
      throw new EngineError(ERROR_CODES.CLI_USAGE, `未知的 project 子命令: ${sub}`, {
        allowed: ['list', 'init', 'archetypes', 'audit'],
      });
  }
}
interface ProjectRow {
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly milestone: string;
  readonly archetype: string;
  readonly specOk: boolean;
  readonly hasRunLog: boolean;
  readonly hasDisclosure: boolean;
  /** null = 算不出来（manifest 本身坏了）；isolated=false 表示输入越界 */
  readonly isolation: { readonly isolated: boolean; readonly violations: number } | null;
  readonly problem: string | null;
}
function collectProjectRows(): ProjectRow[] {
  return listProjectSlugs().map((slug) => {
    const dir = projectDir(slug);
    try {
      const manifest = readProjectManifest(dir);
      const specPath = resolveInsideProject(dir, manifest.entry, 'entry');
      const report = auditProjectIsolation(dir, manifest);
      return {
        slug,
        title: manifest.title,
        status: manifest.status,
        milestone: manifest.milestone ?? '—',
        archetype: manifest.archetype ?? '—',
        specOk: existsSync(specPath),
        hasRunLog: existsSync(join(dir, RUN_LOG_FILE)),
        hasDisclosure: existsSync(join(dir, DISCLOSURE_FILE)),
        isolation: { isolated: report.isolated, violations: report.violations.length },
        problem: null,
      };
    } catch (err) {
      // 一个坏项目不应让 `project list` 整个挂掉——列表的作用恰恰是发现坏项目
      return {
        slug,
        title: '—',
        status: '?',
        milestone: '—',
        archetype: '—',
        specOk: false,
        hasRunLog: false,
        hasDisclosure: false,
        isolation: null,
        problem: err instanceof EngineError ? `${err.code}: ${err.message}` : String(err),
      };
    }
  });
}
function cmdProjectList(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const rows = collectProjectRows();

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, projectsDir: PROJECTS_DIR, projects: rows }, null, 2) + '\n');
    return 0;
  }

  if (rows.length === 0) {
    process.stdout.write(`projects/ 下还没有任何项目。\n\n创建第一个：\n  node .skill/engine/src/cli/index.ts project init my-film --title "我的片子"\n`);
    return 0;
  }

  const w = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  process.stdout.write(`${rows.length} 个项目（${PROJECTS_DIR.replace(PROJECT_ROOT + '/', '')}/）\n\n`);
  process.stdout.write(
    `  ${w('slug', 20)} ${w('状态', 11)} ${w('里程碑', 8)} ${w('原型', 26)} spec  run 披露 隔离  标题\n`,
  );
  for (const r of rows) {
    const iso = r.isolation === null ? '—' : r.isolation.isolated ? '✓' : `✗${r.isolation.violations}`;
    process.stdout.write(
      `  ${w(r.slug, 20)} ${w(r.status, 11)} ${w(r.milestone, 8)} ${w(r.archetype, 26)} ` +
        `${r.specOk ? ' ✓  ' : ' ✗  '} ${r.hasRunLog ? '✓  ' : '·  '} ${r.hasDisclosure ? '✓  ' : '·  '} ${w(iso, 4)} ${r.title}\n`,
    );
    if (r.problem) process.stdout.write(`      ! ${r.problem}\n`);
  }
  process.stdout.write(
    `\n渲染：node .skill/engine/src/cli/index.ts render <slug>    对账：node .skill/engine/src/cli/index.ts disclosure <slug>    隔离：node .skill/engine/src/cli/index.ts project audit --all\n`,
  );
  return rows.some((r) => r.problem !== null || r.isolation?.isolated === false) ? 1 : 0;
}
function cmdProjectInit(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      title: { type: 'string' },
      archetype: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const slug = positionals[0];
  if (!slug) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, 'project init 缺少参数 <slug>', {
      hint: '用法: node .skill/engine/src/cli/index.ts project init my-film --title "我的片子"',
    });
  }

  const result = initProject({
    slug,
    ...(values.title !== undefined ? { title: values.title } : {}),
    ...(values.archetype !== undefined ? { archetype: values.archetype } : {}),
  });

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(`已创建项目 ${slug}\n  ${result.dir.replace(PROJECT_ROOT + '/', '')}/\n\n`);
  for (const f of result.created) process.stdout.write(`  ${f}\n`);
  if (result.archetypeSource) {
    process.stdout.write(`\n提示词原型：${result.archetypeSource.replace(PROJECT_ROOT + '/', '')}\n`);
  }
  process.stdout.write(
    `\n下一步：\n` +
      `  隔离：只读 projects/${slug}/ 内的文件——其它项目的 spec / out/ / run.json 一律不打开；\n` +
      `        本项目的产物与证据也只写回这个目录（仓库根不放任何项目文件）。\n` +
      `        这是模型对比的前提（细则 .skill/references/workspace.md §7）；自查：node .skill/engine/src/cli/index.ts project audit ${slug}\n` +
      `  1. 把提示词原文粘进 ${slug}/NOTES.md，结构化声明写进 ${slug}/brief.json\n` +
      `  2. 改 ${slug}/spec/main.json（骨架是 3 秒单场景，先渲出画面再扩内容）\n` +
      `  3. node .skill/engine/src/cli/index.ts validate ${slug} && node .skill/engine/src/cli/index.ts brief validate ${slug}\n` +
      `  4. node .skill/engine/src/cli/index.ts render ${slug} && node .skill/engine/src/cli/index.ts disclosure ${slug}\n`,
  );
  return 0;
}
function cmdProjectArchetypes(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const list = listArchetypes();

  // 反向链接：原型 → 正在使用它的项目。
  // 两个方向都要能查，否则「prompt ↔ 项目」只是文件里的一个字符串。
  const users = new Map<string, string[]>();
  for (const row of collectProjectRows()) {
    if (!row.archetype || row.archetype === '—') continue;
    users.set(row.archetype, [...(users.get(row.archetype) ?? []), row.slug]);
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          archetypes: list.map((a) => ({ ...a, usedBy: users.get(a.id) ?? [] })),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  if (list.length === 0) {
    process.stdout.write('提示词原型库为空（prompts/archetypes/ 尚无 *.brief.json）。\n');
    return 0;
  }
  process.stdout.write(`${list.length} 个提示词原型\n\n`);
  for (const a of list) {
    process.stdout.write(`  ${a.id}\n    ${a.title}\n`);
    const used = users.get(a.id) ?? [];
    process.stdout.write(`    使用中的项目: ${used.length ? used.join(', ') : '（无）'}\n`);
  }
  process.stdout.write(
    `\n用法：project.json 与 brief.json 的 archetype 字段填 id。\n` +
      `新建：node .skill/engine/src/cli/index.ts project init <slug> --archetype <id>\n`,
  );
  return 0;
}
interface ProjectAuditRow {
  readonly slug: string;
  readonly dir: string | null;
  readonly files: readonly string[];
  readonly violations: readonly IsolationViolation[];
  readonly problem: string | null;
}

/**
 * 审计一个项目。刻意**不走 loadProject**：
 * loadProject 在越界时直接报错（这是它该做的），而审计的职责恰恰是
 * 「越界了也要把报告跑出来」——否则用户只看到一句报错，不知道共有几处、都在哪。
 */
function auditOneProject(slugOrDir: string): ProjectAuditRow {
  const dir = isAbsolute(slugOrDir)
    ? slugOrDir
    : slugOrDir.includes(sep)
      ? resolve(PROJECT_ROOT, slugOrDir)
      : projectDir(slugOrDir);

  if (!existsSync(dir)) {
    const available = listProjectSlugs();
    throw new EngineError(ERROR_CODES.PROJECT_NOT_FOUND, `找不到项目: ${slugOrDir}`, {
      details: { looked: dir },
      ...(available.length ? { allowed: available } : {}),
      hint: '用 `node .skill/engine/src/cli/index.ts project list` 查看现有项目',
    });
  }

  const manifest = readProjectManifest(dir);
  const report = auditProjectIsolation(dir, manifest);
  return {
    slug: report.slug,
    dir: report.dir.replace(PROJECT_ROOT + '/', ''),
    files: report.files,
    violations: report.violations,
    problem: null,
  };
}
function cmdProjectAudit(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { all: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const target = positionals[0];
  if (!target && !values.all) {
    const slugs = listProjectSlugs();
    throw new EngineError(ERROR_CODES.CLI_USAGE, 'project audit 缺少参数 <slug>', {
      ...(slugs.length ? { allowed: slugs } : {}),
      hint: '用法: node .skill/engine/src/cli/index.ts project audit <slug>  或  node .skill/engine/src/cli/index.ts project audit --all',
    });
  }

  const rows: ProjectAuditRow[] = [];
  for (const slug of values.all ? listProjectDirectories() : [target as string]) {
    try {
      rows.push(auditOneProject(slug));
    } catch (err) {
      // 一个坏项目不应让整个审计挂掉：报告里把坏项目也列出来
      rows.push({
        slug,
        dir: null,
        files: [],
        violations: [],
        problem: err instanceof EngineError ? `${err.code}: ${err.message}` : String(err),
      });
    }
  }

  const dirty = rows.filter((r) => r.problem !== null || r.violations.length > 0);
  const ok = dirty.length === 0;

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok, projects: rows }, null, 2) + '\n');
    return ok ? 0 : 1;
  }

  if (rows.length === 0) {
    process.stdout.write('projects/ 下还没有任何项目。\n');
    return 0;
  }

  process.stdout.write('项目隔离审计：输入是否引用了别的项目、本项目产物或项目外路径\n\n');
  for (const r of rows) {
    if (r.problem) {
      process.stdout.write(`  ${r.slug}  ✗ ${r.problem}\n`);
      continue;
    }
    if (r.violations.length === 0) {
      process.stdout.write(`  ${r.slug}  ✓ 干净（扫描 ${r.files.length} 个文件：${r.files.join(', ')}）\n`);
      continue;
    }
    process.stdout.write(`  ${r.slug}  ✗ ${r.violations.length} 处越界（扫描 ${r.files.length} 个文件）\n`);
    for (const v of r.violations) {
      process.stdout.write(`      ${describeViolation(v)}\n        ↳ ${v.hint}\n`);
    }
  }

  process.stdout.write(
    `\n审计只看 brief.json / spec 里写下的路径，不能证明模型没有读过别的项目。\n` +
      `模型对比请从空目录开始、同一提示词各做一支，规则见 .skill/references/workspace.md §7。\n`,
  );
  return ok ? 0 : 1;
}
export function cmdBrief(argv: string[]): number {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub !== 'validate') {
    throw new EngineError(ERROR_CODES.CLI_USAGE, sub ? `未知的 brief 子命令: ${sub}` : 'brief 需要子命令', {
      allowed: ['validate'],
      hint: '用法: node .skill/engine/src/cli/index.ts brief validate <项目|brief.json>',
    });
  }

  const { values, positionals } = parseArgs({
    args: rest,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const arg = positionals[0];
  if (!arg) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, 'brief validate 缺少参数 <项目|brief.json>', {
      allowed: listProjectSlugs(),
      hint: '也可以直接传一个 brief json 路径（用于校验原型模板）',
    });
  }

  // 直接传 json 路径时不绑定项目：这样原型模板也能被校验
  let briefPath: string;
  let projectDirPath: string | null = null;
  let spec: ResolvedVideoSpec | null = null;
  let label = arg;

  if (arg.endsWith('.json')) {
    briefPath = resolve(PROJECT_ROOT, arg);
  } else {
    const project = loadProject(arg);
    if (!project.briefPath) {
      throw new EngineError(ERROR_CODES.BRIEF_INVALID, `项目 ${project.slug} 没有 brief.json`, {
        details: { projectDir: project.dir },
        hint: '要么加上 brief.json，要么在 project.json 里把 brief 写成 null（表示不做对账）',
      });
    }
    briefPath = project.briefPath;
    projectDirPath = project.dir;
    label = project.slug;
    spec = validateSpec(loadSpecFile(project.specPath)).spec;
  }

  const raw = loadBriefFile(briefPath);
  const result = checkBrief(raw, {
    ...(spec ? { spec } : {}),
    ...(projectDirPath ? { projectDir: projectDirPath } : {}),
  });

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        { ok: result.ok, brief: briefPath.replace(PROJECT_ROOT + '/', ''), counts: result.counts, issues: result.issues },
        null,
        2,
      ) + '\n',
    );
    return result.ok ? 0 : 1;
  }

  process.stdout.write(`校验 ${briefPath.replace(PROJECT_ROOT + '/', '')}\n\n`);
  printIssues(result.issues);

  if (!result.ok || !result.brief) {
    // 先给人看表格，再抛出带错误码/path/allowed/hint 的语义化错误
    throw briefErrorFromIssues(result.issues.filter((i) => i.severity === 'FATAL'));
  }

  const b = result.brief;
  process.stdout.write(
    [
      `契约可对账  ${label}`,
      `  原型      ${b.archetype}`,
      `  交付      ${b.deliverable.duration}s / ${b.deliverable.aspect}` +
        `${b.deliverable.fps !== null ? ` / ${b.deliverable.fps}fps` : ''} / 字幕 ${b.deliverable.captions}`,
      `  工具      允许 ${b.tools.allowed.join(', ')}` +
        `${b.tools.forbidden.length ? `；禁止 ${b.tools.forbidden.join(', ')}` : ''}`,
      `  声称      轮数=${b.claims.humanRounds ?? '未记录'} 纯代码=${b.claims.pureCode} ` +
        `零外部素材=${b.claims.zeroExternalAssets} 人工修改=${b.claims.humanRevision}`,
      `  素材      ${b.assets.length} 项`,
      `\n${summarizeIssues(result.issues)}`,
    ].join('\n') + '\n',
  );
  return 0;
}
export function cmdArtifact(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv, options: { out: { type: 'string' }, review: { type: 'string' } }, allowPositionals: true,
  });
  const project = loadProject(requireTarget(positionals, 'artifact'));
  const evidencePath = (path: string) => {
    const resolved = assertContained(join(project.dir, 'evidence'), resolveInsideProject(project.dir, path, 'artifact evidence'));
    if (!resolved.endsWith('.json')) throw new EngineError(ERROR_CODES.CLI_USAGE, '身份快照保存为 evidence/ 内的 JSON 文件');
    return resolved;
  };
  const out = values.out ? evidencePath(values.out) : null;
  const report = inspectArtifact(project, values.review ? { reviewPath: evidencePath(values.review) } : {});
  const json = JSON.stringify(report, null, 2) + '\n';
  if (report.ok && out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, json, 'utf8'); }
  process.stdout.write(json);
  return report.ok ? 0 : 1;
}
export function cmdDisclosure(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, postprocess: { type: 'string' } },
    allowPositionals: true,
  });
  const arg = positionals[0];
  if (!arg) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, 'disclosure 缺少参数 <项目>', {
      allowed: listProjectSlugs(),
      hint: '用法: node .skill/engine/src/cli/index.ts disclosure <slug>',
    });
  }

  const project = loadProject(arg);
  const result = buildDisclosure(project, values.postprocess ? { postprocessPath: values.postprocess } : {});

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: result.reconcile.ok,
          project: project.slug,
          runId: result.log.runId,
          findings: result.reconcile.findings,
          counts: result.reconcile.counts,
          written: result.reconcile.ok ? result.path.replace(PROJECT_ROOT + '/', '') : null,
          warnings: result.warnings,
        },
        null,
        2,
      ) + '\n',
    );
    if (result.reconcile.ok) writeDisclosure(result.path, result.content);
    return result.reconcile.ok ? 0 : 1;
  }

  process.stdout.write(`对账 ${project.slug}（runId ${result.log.runId}）\n\n`);

  if (result.reconcile.findings.length > 0) {
    for (const f of result.reconcile.findings) {
      const mark = f.severity === 'FATAL' ? '✗' : '!';
      process.stdout.write(`  ${mark} [${f.code}] ${f.field}\n      ${f.message}\n`);
      if (f.hint) process.stdout.write(`      建议: ${f.hint}\n`);
    }
    process.stdout.write('\n');
  }

  if (!result.reconcile.ok) {
    // 失败就**不写**披露文件：一份前后矛盾的披露比没有披露更危险
    process.stdout.write(
      `有 ${result.reconcile.counts.fatal} 个致命冲突，已拒绝生成 ${DISCLOSURE_FILE}。\n` +
        `先修 brief.json 或重新渲染，再跑一次。\n`,
    );
    return 1;
  }

  writeDisclosure(result.path, result.content);
  process.stdout.write(`✓ 声明与实测一致，已写出 ${result.path.replace(PROJECT_ROOT + '/', '')}\n`);
  if (result.reconcile.counts.warning > 0) {
    process.stdout.write(`  （${result.reconcile.counts.warning} 条警告已写入披露文件的对账明细）\n`);
  }
  return 0;
}

// ---------------------------------------------------------------- 路由
