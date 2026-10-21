import { assertContained, assertOutputTree } from './paths.ts';
/**
 * 项目层：manifest 读取、校验与解析（task-1）。
 *
 * 分层意图：
 *   - 引擎是**共享**的（src/ 根目录），它不知道任何具体影片；
 *   - 每支影片是 `projects/<slug>/` 里的一个自包含目录，manifest 是它的身份证；
 *   - 引擎只通过 manifest 认识项目，绝不硬编码项目名。
 *
 * 一支影片的**全部**文件都在它自己的目录里：提示词契约、spec、素材、产物、遥测。
 * 仓库根不放任何项目文件（`examples/` 软链与根 `out/` 兼容层已在 task-11 移除）。
 */

import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { Ajv } from 'ajv';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import { auditProjectIsolation, assertProjectIsolation } from './isolation.ts';
import { PROJECT_MANIFEST_SCHEMA, PROJECT_STATUSES, type ProjectStatus } from './schema.ts';

export const PROJECTS_DIR_NAME = 'projects';
export const PROJECTS_DIR = join(PROJECT_ROOT, PROJECTS_DIR_NAME);
export const PROJECT_MANIFEST_FILE = 'project.json';
export const PROJECT_DEFAULT_OUT_DIR = 'out';
export const PROJECT_DEFAULT_BRIEF_FILE = 'brief.json';

export interface ProjectManifest {
  readonly version: '0.1';
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly status: ProjectStatus;
  readonly entry: string;
  readonly director?: string;
  readonly drawing?: string;
  readonly brief: string | null;
  readonly outDir: string;
  readonly tags: readonly string[];
  readonly milestone?: string;
  readonly archetype?: string | null;
}

export interface ProjectHandle {
  readonly slug: string;
  /** 项目目录（绝对路径） */
  readonly dir: string;
  readonly manifestPath: string;
  readonly manifest: ProjectManifest;
  /** 入口 VideoSpec（绝对路径） */
  readonly specPath: string;
  /** 成片输出目录（绝对路径） */
  readonly outDir: string;
  /** 提示词契约（绝对路径）；未配置或文件不存在时为 null */
  readonly briefPath: string | null;
}

const ajv = new Ajv({ allErrors: true, strict: false });

let compiledManifest: ReturnType<typeof ajv.compile> | null = null;
function manifestValidator(): ReturnType<typeof ajv.compile> {
  let v = compiledManifest;
  if (!v) {
    v = ajv.compile(PROJECT_MANIFEST_SCHEMA);
    compiledManifest = v;
  }
  return v;
}

export function listProjectDirectories(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => entry.name).sort();
}
/** 列出 projects/ 下所有含 project.json 的目录名；目录不存在时返回空数组 */
export function listProjectSlugs(): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR)
    .filter((name) => {
      if (name.startsWith('.')) return false;
      const dir = join(PROJECTS_DIR, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, PROJECT_MANIFEST_FILE));
    })
    .sort();
}

export function projectDir(slug: string): string {
  return join(PROJECTS_DIR, slug);
}

/**
 * 把 manifest 里的相对路径解析成绝对路径，并保证不逃出项目目录。
 *
 * 这道检查不是形式主义：`entry: "../../etc/passwd"` 这类值一旦被接受，
 * 「所有产物必须落在本项目目录内」的硬性规则就靠文档维持了，而文档不会强制任何人。
 */
export function resolveInsideProject(dir: string, relPath: string, field: string): string {
  if (isAbsolute(relPath)) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `${field} 必须是相对路径`, {
      details: { got: relPath, projectDir: dir },
      hint: '改为相对项目目录的路径，例如 spec/main.json',
    });
  }
  const abs = resolve(dir, normalize(relPath));
  const root = resolve(dir);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `${field} 逃出了项目目录`, {
      details: { got: relPath, projectDir: root },
      hint: '项目内文件不得引用项目目录之外的路径（AGENTS.md 硬性规则 1）',
    });
  }
  return assertContained(dir, abs);
}

/** 读取并校验一个项目目录的 manifest */
export function readProjectManifest(dir: string): ProjectManifest {
  if (lstatSync(dir).isSymbolicLink()) throw new EngineError(ERROR_CODES.PROJECT_ISOLATION_VIOLATION, '项目目录必须独立，不能是软链接');
  const manifestPath = assertContained(dir, join(dir, PROJECT_MANIFEST_FILE));
  if (!existsSync(manifestPath)) {
    throw new EngineError(ERROR_CODES.PROJECT_NOT_FOUND, `找不到 ${PROJECT_MANIFEST_FILE}`, {
      details: { dir, expected: manifestPath },
      hint: '用 `node .skill/engine/src/cli/index.ts project init <slug>` 创建项目骨架',
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `${PROJECT_MANIFEST_FILE} 不是合法 JSON`, {
      details: { path: manifestPath },
      hint: 'JSON 语法错误必须人工修，引擎不会猜',
      cause: err,
    });
  }

  const errors = collectSchemaErrors(manifestValidator(), raw);
  if (errors.length > 0) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `${PROJECT_MANIFEST_FILE} 未通过 schema 校验`, {
      details: { path: manifestPath, errors: errors.join(' ; ') },
      hint: '按 .skill/references/workflow.md 的 manifest 规范修正字段',
    });
  }

  const m = raw as Record<string, unknown>;
  const slug = String(m['slug']);
  const dirSlug = dir.split(sep).pop() ?? '';

  // slug 与目录名不一致几乎总是复制粘贴的残留；放着不管会让「按 slug 找项目」变成猜谜
  if (slug !== dirSlug) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `slug 与目录名不一致`, {
      details: { slug, dir: dirSlug, path: manifestPath },
      hint: `把 slug 改成 "${dirSlug}"，或把目录重命名为 "${slug}"`,
    });
  }

  const entry = String(m['entry']);
  const briefRaw = m['brief'];
  // 未写 brief 字段 → 默认约定 brief.json；显式写 null → 声明「本项目不做对账」
  const brief = briefRaw === undefined ? PROJECT_DEFAULT_BRIEF_FILE : (briefRaw as string | null);

  return {
    version: '0.1',
    slug,
    title: String(m['title']),
    ...(m['summary'] !== undefined ? { summary: String(m['summary']) } : {}),
    status: m['status'] as ProjectStatus,
    entry,
    ...(m['director'] !== undefined ? { director: String(m['director']) } : {}),
    ...(m['drawing'] !== undefined ? { drawing: String(m['drawing']) } : {}),
    brief,
    outDir: m['outDir'] === undefined ? PROJECT_DEFAULT_OUT_DIR : String(m['outDir']),
    tags: Array.isArray(m['tags']) ? (m['tags'] as unknown[]).map(String) : [],
    ...(m['milestone'] !== undefined ? { milestone: String(m['milestone']) } : {}),
    ...(m['archetype'] !== undefined ? { archetype: m['archetype'] as string | null } : {}),
  };
}

/** 解析成可直接使用的项目句柄；任何路径问题都在这里一次性报清 */
export function loadProject(slugOrDir: string): ProjectHandle {
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
      hint: available.length
        ? '用 `node .skill/engine/src/cli/index.ts project list` 查看现有项目'
        : 'projects/ 下还没有任何项目，用 `node .skill/engine/src/cli/index.ts project init <slug>` 创建',
    });
  }

  const manifest = readProjectManifest(dir);
  const specPath = resolveInsideProject(dir, manifest.entry, 'entry');

  if (!existsSync(specPath)) {
    throw new EngineError(ERROR_CODES.PROJECT_NOT_FOUND, `manifest 指向的 spec 不存在`, {
      details: { entry: manifest.entry, expected: specPath },
      hint: '修正 project.json 的 entry，或把 VideoSpec 放到该路径',
    });
  }

  const outDir = resolveInsideProject(dir, manifest.outDir, 'outDir');
  if (outDir === resolve(dir)) throw new EngineError(ERROR_CODES.PROJECT_INVALID, 'outDir 必须是独立的产物子目录');

  let briefPath: string | null = null;
  if (manifest.brief !== null) {
    const candidate = resolveInsideProject(dir, manifest.brief, 'brief');
    if (existsSync(candidate)) briefPath = candidate;
  }

  // 隔离审计：项目的输入必须自包含（AGENTS.md 硬性规则 7）。
  // 放在这里而不是只放在某条命令里，是因为「读别人的产物」这件事
  // 一旦被允许，任何一条命令都可能成为污染入口（render / frame / storyboard 都算）。
  assertProjectIsolation(auditProjectIsolation(dir, manifest));
  assertOutputTree(outDir);
  for (const file of ['run.json', 'DISCLOSURE.md']) assertContained(dir, join(dir, file));

  return {
    slug: manifest.slug,
    dir: resolve(dir),
    manifestPath: join(resolve(dir), PROJECT_MANIFEST_FILE),
    manifest,
    specPath,
    outDir,
    briefPath,
  };
}

export interface ResolvedTarget {
  /** 真正的 VideoSpec 文件路径 */
  readonly specPath: string;
  /** 项目上下文；裸 spec 渲染时为 null（此时引擎行为与分层前一致） */
  readonly project: ProjectHandle | null;
  /** 标识符：项目渲染为 slug，裸 spec 渲染为文件名（不含扩展名） */
  readonly label: string;
}

/**
 * 把 CLI 的位置参数解析成渲染目标。
 *
 * 只有一条判定原则：**项目文件永远走项目**。
 *   1. 落在 `projects/<slug>/` 里的 spec → 绑定该项目。
 *      没有这条，`render projects/my-film/spec/main.json` 会把成片写到仓库根的 `out/`、
 *      把 `run.json` 写到 spec 旁边——一支影片的文件就散到项目目录外面去了。
 *   2. 其它 `.json` → 裸 spec（探针 / 引擎级夹具），产物落 `.research/out/`。
 *   3. 其余 → 项目 slug 或项目目录路径。
 *
 * `projects/` 下的路径一律不允许退化成裸 spec：那是「项目文件必须在项目目录里」
 * 的硬性规则，不是靠命名习惯维持的。
 */
export function resolveTarget(arg: string): ResolvedTarget {
  const abs = resolve(PROJECT_ROOT, arg);
  const rel = relative(PROJECTS_DIR, abs);
  const underProjects = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);

  if (underProjects) {
    const slug = rel.split(sep)[0] ?? '';
    if (existsSync(join(PROJECTS_DIR, slug, PROJECT_MANIFEST_FILE))) {
      const project = loadProject(slug);
      return { specPath: project.specPath, project, label: project.slug };
    }
    throw new EngineError(ERROR_CODES.PROJECT_NOT_FOUND, `projects/ 下没有项目 ${slug}`, {
      details: { got: arg, expected: join(PROJECTS_DIR, slug, PROJECT_MANIFEST_FILE) },
      ...(listProjectSlugs().length ? { allowed: listProjectSlugs() } : {}),
      hint:
        'projects/ 里只放项目：一支影片一个目录，目录里必须有 project.json。' +
        '临时 spec / 探针放 .research/out/，用 `node .skill/engine/src/cli/index.ts project init <slug>` 新建项目',
    });
  }

  if (arg.endsWith('.json')) {
    return {
      specPath: abs,
      project: null,
      label: abs.split(sep).pop()?.replace(/\.[^.]+$/, '') ?? 'video',
    };
  }

  const project = loadProject(arg);
  return { specPath: project.specPath, project, label: project.slug };
}

export { PROJECT_STATUSES };
export type { ProjectStatus };
