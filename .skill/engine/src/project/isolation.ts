import { physicalPath, assertOutputTree } from './paths.ts';
/**
 * 项目隔离审计（task-10）。
 *
 * 为什么需要它：项目层要支持「同一个提示词、不同模型各做一支」的横向对比。
 * 一旦新项目引用了已生成项目的文件（别人的 spec / out\/*.mp4 / run.json），
 * 对比就不再成立——比出来的不是「谁能做出来」，而是「谁抄得像」。
 *
 * **诚实的能力边界**：代码只能强制「声明层的引用」，不能强制「模型读过什么」。
 * 引擎看得见 brief.json / spec 里写下的路径，看不见模型在编辑器里打开过哪些文件。
 * 所以本模块的结论必须这样表述：
 *   ✅ 「这个项目的输入全部落在自己目录内」
 *   ❌ 「这个项目没有读过别的项目」——后者要靠流程约束（独立目录 + 干净的起始状态），
 *      见 .skill/references/workspace.md §7。
 *
 * 三条规则（对应 AGENTS.md 硬性规则 7）：
 *   1. 不得引用其它项目目录（`projects/<other>/...`，含 `../<other>/...` 这类相对写法）
 *   2. 不得把自己 outDir 里的产物当输入（产物是可再生的；读它会让渲染不可复现）
 *   3. 不得引用项目目录之外的路径（绝对路径、`../` 逃逸）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';

export type IsolationViolationKind =
  /** 引用了另一个项目目录里的文件 */
  | 'cross-project'
  /** 引用了本项目产出目录（outDir）里的文件 */
  | 'own-output'
  /** 引用了项目目录之外的路径 */
  | 'outside-project'
  /** 文件本身读不动（不是合法 JSON）——审计无法给出「干净」的结论 */
  | 'unparsable';

export interface IsolationViolation {
  /** 相对项目目录的文件名 */
  readonly file: string;
  /** 出错位置（JSON 指针，如 `/assets/0/path`） */
  readonly pointer: string;
  /** 写下的原值 */
  readonly value: string;
  readonly kind: IsolationViolationKind;
  /** 指向的项目 slug（cross-project）或解析后的路径 */
  readonly target: string;
  readonly hint: string;
}

export interface ProjectIsolationReport {
  readonly slug: string;
  /** 项目目录（绝对路径） */
  readonly dir: string;
  /** 扫描过的输入文件（相对项目目录） */
  readonly files: readonly string[];
  readonly violations: readonly IsolationViolation[];
  /** violations 为空 */
  readonly isolated: boolean;
}

export interface IsolationScanInput {
  readonly dir: string;
  readonly slug: string;
  /** 成片输出目录（绝对路径） */
  readonly outDir: string;
  /** 被扫描的输入文件（绝对路径） */
  readonly files: readonly string[];
  /** 项目根目录，默认取 dir 的父目录；用于判断「另一个项目」 */
  readonly projectsRoot?: string;
}

/** 不是本地路径的字符串（外链、内联数据、摘要）直接跳过，避免把 URL 误判成越界引用 */
const NON_PATH_SCHEME = /^(https?|data|blob|mailto|urn|sha256|git|npm):/i;

/**
 * 「这看起来是个文件路径吗」——刻意保守：
 * 宁可漏判散文里的路径，也不要把旁白文案里的一个词判成越界。
 */
function looksLikePath(value: string): boolean {
  const t = value.trim();
  if (t.length < 2 || t.length > 500) return false;
  if (NON_PATH_SCHEME.test(t)) return false;
  if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || t.startsWith('~/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/(^|[\\/])projects[\\/]/.test(t)) return true;
  // 带扩展名的相对路径：out/x.mp4、assets/logo.png
  return /[\\/]/.test(t) && /\.[A-Za-z0-9]{1,5}$/.test(t);
}

/** 剥掉 file:// 前缀，让 file:///abs/x.mp4 走同一套绝对路径判定 */
function stripFileUrl(value: string): string {
  return value.replace(/^file:\/\//i, '');
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/** target 落在 projectsRoot/<other>/ 里时返回 other，否则 null */
function otherProjectSlug(target: string, projectsRoot: string): string | null {
  const rel = relative(resolve(projectsRoot), resolve(target));
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0];
  return first && first !== '.' ? first : null;
}

interface ScanContext {
  readonly dir: string;
  readonly slug: string;
  readonly outDir: string;
  readonly outDirName: string;
  readonly projectsRoot: string;
  readonly fileRel: string;
}

function violation(
  ctx: ScanContext,
  pointer: string,
  value: string,
  kind: IsolationViolationKind,
  target: string,
  hint: string,
): IsolationViolation {
  return { file: ctx.fileRel, pointer, value, kind, target, hint };
}

/**
 * 从一段文字里取出候选路径。
 *
 * 先试整串（`out/frame.png` 这种纯路径），再按空白/标点切词（`参考片在 ../../refs/a.mp4`）。
 * 两种都不像路径就放过——宁可漏判散文，也不要把旁白文案判成越界。
 */
function pathCandidates(value: string): string[] {
  const whole = value.trim();
  const out: string[] = [];
  if (looksLikePath(whole)) out.push(whole);
  for (const raw of whole.split(/[\s,;，。；、"'`()（）\[\]<>|]+/)) {
    const token = raw.replace(/^[-–—]+/, '').replace(/[.,;:!?]+$/, '');
    if (token !== whole && looksLikePath(token)) out.push(token);
  }
  return [...new Set(out)];
}

/**
 * 判定单个字符串。三条规则各自独立，同一条字符串可能同时踩中多条
 * （例如 `../other-project/out/x.mp4` 既是跨项目、也逃出了本项目）。
 *
 * 相对路径按**项目目录**解析，与 `brief.assets[].path` 的约定一致（见 brief.ts）。
 */
function classifyString(ctx: ScanContext, raw: string, pointer: string): IsolationViolation[] {
  const found: IsolationViolation[] = [];
  const value = raw.trim();
  if (value.length === 0 || value.length > 2000) return found;

  // 规则 1/2（字面写法）：任何位置出现的 `projects/<slug>[/...]` 都算引用
  for (const m of value.matchAll(/projects[\\/]([a-z0-9][a-z0-9-]{1,47})(?:[\\/]([^\s"'`)\]]*))?/g)) {
    const other = m[1] ?? '';
    const rest = (m[2] ?? '').replace(/[.,;:]+$/, '');
    if (other !== ctx.slug) {
      found.push(
        violation(
          ctx,
          pointer,
          value,
          'cross-project',
          other,
          `删掉对 projects/${other}/ 的引用；要复用素材就把它复制进 projects/${ctx.slug}/assets/`,
        ),
      );
    } else if (rest === ctx.outDirName || rest.startsWith(ctx.outDirName + '/')) {
      found.push(
        violation(
          ctx,
          pointer,
          value,
          'own-output',
          rest,
          `outDir（${ctx.outDirName}/）是产物不是输入：产物每次渲染都会重写，读它等于把渲染结果喂回渲染`,
        ),
      );
    }
  }

  // 规则 3（解析后的真实位置）：相对路径按项目目录解析，绝对路径原样判定
  for (const candidate of pathCandidates(value)) {
    const cleaned = stripFileUrl(candidate).replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(cleaned)) {
      found.push(violation(ctx, pointer, value, 'outside-project', cleaned, '绝对路径需要改成项目内相对路径'));
      continue;
    }
    const target = cleaned.startsWith('~') ? cleaned : physicalPath(resolve(ctx.dir, cleaned));
    if (cleaned.startsWith('~')) {
      found.push(
        violation(ctx, pointer, value, 'outside-project', cleaned, '家目录不是项目目录，项目输入必须自包含'),
      );
    } else if (!isInside(ctx.dir, target)) {
      const other = otherProjectSlug(target, ctx.projectsRoot);
      if (other) {
        found.push(
          violation(
            ctx,
            pointer,
            value,
            'cross-project',
            other,
            `解析后落在 projects/${other}/ 里；项目输入必须自包含`,
          ),
        );
      } else {
        found.push(
          violation(
            ctx,
            pointer,
            value,
            'outside-project',
            target,
            '项目内文件不得引用项目目录之外的路径（AGENTS.md 硬性规则 1）',
          ),
        );
      }
    } else if (isInside(ctx.outDir, target)) {
      found.push(
        violation(
          ctx,
          pointer,
          value,
          'own-output',
          target,
          `引用了本项目产物目录 ${ctx.outDirName}/；产物是可再生的，不能作为输入`,
        ),
      );
    }
  }

  return found;
}

/** 遍历 JSON 里所有字符串值，带上 JSON 指针（转义 ~ 与 /） */
function walkStrings(value: unknown, pointer: string, visit: (s: string, pointer: string) => void): void {
  if (typeof value === 'string') {
    visit(value, pointer);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${pointer}/${i}`, visit));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const escaped = key.replace(/~/g, '~0').replace(/\//g, '~1');
      walkStrings(item, `${pointer}/${escaped}`, visit);
    }
  }
}

function dedupe(violations: readonly IsolationViolation[]): IsolationViolation[] {
  const seen = new Set<string>();
  const out: IsolationViolation[] = [];
  for (const v of violations) {
    const key = `${v.file}|${v.pointer}|${v.kind}|${v.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** 扫描一组输入文件，返回全部越界引用 */
export function collectIsolationViolations(input: IsolationScanInput): IsolationViolation[] {
  const dir = resolve(input.dir);
  const projectsRoot = resolve(input.projectsRoot ?? dirname(dir));
  const outDirName = relative(dir, resolve(input.outDir)) || '.';
  const violations: IsolationViolation[] = [];

  for (const file of input.files) {
    const fileRel = relative(dir, file) || file;
    const ctx: ScanContext = {
      dir,
      slug: input.slug,
      outDir: resolve(input.outDir),
      outDirName,
      projectsRoot,
      fileRel,
    };

    const real = physicalPath(file);
    if (!isInside(physicalPath(dir), real)) {
      violations.push(violation(ctx, '/', fileRel, 'outside-project', real, '输入文件软链接指向项目外'));
      continue;
    }
    if (!existsSync(file)) {
      violations.push(violation(ctx, '/', fileRel, 'unparsable', fileRel, '输入文件缺失，无法确认隔离'));
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      violations.push(
        violation(
          ctx,
          '/',
          '',
          'unparsable',
          fileRel,
          '审计只读 JSON：先跑 `node .skill/engine/src/cli/index.ts validate <项目>` / `node .skill/engine/src/cli/index.ts brief validate <项目>` 修掉语法错误',
        ),
      );
      continue;
    }

    walkStrings(parsed, '', (s, pointer) => {
      violations.push(...classifyString(ctx, s, pointer));
    });
  }

  return dedupe(violations);
}

/**
 * 待审计的输入文件。
 *
 * 范围刻意是「引擎真正会读的东西」：manifest、brief、入口 spec，
 * 以及入口 spec 同目录下的其它 spec（分镜实验也属于输入面）。
 * `NOTES.md` 是人写的散文、`assets/` 里的文件是素材本身，都不在其中——
 * 它们不是「引用」，无法用路径判定，只能靠流程约束。
 */
export function projectInputFiles(dir: string, manifest: { entry: string; brief: string | null; director?: string }): string[] {
  const files: string[] = [join(dir, 'project.json')];
  if (manifest.brief !== null && existsSync(join(dir, manifest.brief))) files.push(join(dir, manifest.brief));
  if (manifest.director) files.push(join(dir, manifest.director));

  const entryAbs = resolve(dir, manifest.entry);
  files.push(entryAbs);

  const entryDir = dirname(entryAbs);
  if (entryDir !== resolve(dir) && existsSync(entryDir) && isInside(physicalPath(dir), physicalPath(entryDir))) {
    for (const name of readdirSync(entryDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const abs = join(entryDir, name);
      if (statSync(abs).isFile()) files.push(abs);
    }
  }

  return [...new Set(files)];
}

/** 审计一个项目目录；只需要 manifest 里与路径有关的三个字段 */
export function auditProjectIsolation(
  dir: string,
  manifest: { slug: string; entry: string; brief: string | null; outDir: string; director?: string },
  options: { projectsRoot?: string } = {},
): ProjectIsolationReport {
  const absDir = resolve(dir);
  const outDir = resolve(absDir, manifest.outDir);
  const files = projectInputFiles(absDir, manifest);
  const violations = collectIsolationViolations({
    dir: absDir,
    slug: manifest.slug,
    outDir,
    files,
    ...(options.projectsRoot !== undefined ? { projectsRoot: options.projectsRoot } : {}),
  });

  try { assertOutputTree(outDir); } catch {
    violations.push({ file: 'project.json', pointer: '/outDir', value: manifest.outDir, kind: 'outside-project', target: outDir, hint: '产物目录内软链接会重定向写入，需移除链接后重试' });
  }
  if (!isInside(physicalPath(absDir), physicalPath(outDir)) || outDir === absDir) {
    violations.push({ file: 'project.json', pointer: '/outDir', value: manifest.outDir, kind: 'outside-project', target: physicalPath(outDir), hint: 'outDir 必须是当前项目独立的产物子目录' });
  }
  return {
    slug: manifest.slug,
    dir: absDir,
    files: files.map((f) => relative(absDir, f)),
    violations,
    isolated: violations.length === 0,
  };
}

const KIND_LABEL: Record<IsolationViolationKind, string> = {
  'cross-project': '引用了另一个项目',
  'own-output': '引用了本项目产物',
  'outside-project': '引用了项目目录之外',
  unparsable: '文件不是合法 JSON',
};

/** 把一条违规渲染成给人/模型看的一行 */
export function describeViolation(v: IsolationViolation): string {
  const where = `${v.file}#${v.pointer || '/'}`;
  const value = v.value ? ` = ${JSON.stringify(v.value)}` : '';
  return `${KIND_LABEL[v.kind]}（${where}${value} → ${v.target}）`;
}

/** 有违规就报错；这是 `loadProject` 用来强制隔离的入口 */
export function assertProjectIsolation(report: ProjectIsolationReport): void {
  if (report.isolated) return;
  throw new EngineError(
    ERROR_CODES.PROJECT_ISOLATION_VIOLATION,
    `项目 ${report.slug} 的输入越界了（模型对比会因此失效）`,
    {
      details: {
        project: report.slug,
        violations: report.violations.map(describeViolation),
      },
      hint:
        `项目输入必须自包含：素材复制进 projects/${report.slug}/assets/，` +
        '不要在 brief.json / spec 里引用其它项目或本项目 out/ 里的文件。' +
        '细则见 .skill/references/workspace.md §7',
    },
  );
}
