/**
 * 提示词契约（brief.json）的校验层（task-4）。
 *
 * 这个文件回答一个问题：**「这份提示词承诺了什么」，能不能被机器判定为自洽？**
 *
 * 按制作契约核对三类检查：
 *
 * 1. **schema 级**：核对字段名、枚举与必填信息，以结构化字段保存提示词形状。
 * 2. **工具级**：提示词里点名的工具，在 `src/project/tool-registry.ts` 里是什么状态？
 *    已否决或未登记的工具在渲染前报告问题，核对实际可调用状态。
 * 3. **声称级**：四项独立声称（轮数 / 纯代码 / 零外部素材 / 人工修改）之间不得自相矛盾。
 *    生成图片、外部素材与纯代码等声明按实际输入和工具逐项对账。
 *
 * 刻意**不做**的判断：不评估提示词写得好不好。那是人的事，
 * 机器只判断"是否自洽、是否可实现、是否可对账"。
 */

import { existsSync, readFileSync } from 'node:fs';

import { Ajv } from 'ajv';

import { EngineError, ERROR_CODES, type ErrorCode } from '../utils/errors.ts';
import { formatSchemaError } from '../utils/json-schema.ts';
import { sha256File } from '../utils/hash.ts';
import type { Issue } from '../spec/repair.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { resolveInsideProject } from './manifest.ts';
import { archetypeIds, archetypesDirExists } from './archetypes.ts';
import {
  BRIEF_SCHEMA,
  type BriefAspect,
  type BriefAssetKind,
  type BriefCaptionMode,
} from './schema.ts';
import { TOOL_REGISTRY, findTool, knownToolIds } from './tool-registry.ts';

// ---------------------------------------------------------------- 类型

export interface BriefAsset {
  readonly path: string;
  readonly kind: BriefAssetKind;
  readonly license: string;
  readonly source?: string;
  readonly sha256?: string;
}

export interface BriefInputItem {
  readonly url?: string;
  readonly note: string;
  readonly license?: string;
}

export interface BriefClaims {
  readonly humanRounds: number | null;
  readonly pureCode: boolean;
  readonly zeroExternalAssets: boolean;
  readonly humanRevision: boolean;
}

export interface ResolvedBrief {
  readonly version: '0.1';
  readonly archetype: string;
  readonly intent: string;
  readonly audience: string | null;
  readonly deliverable: {
    readonly duration: number;
    readonly aspect: BriefAspect;
    readonly fps: number | null;
    readonly captions: BriefCaptionMode;
  };
  readonly inputs: {
    readonly referenceClips: readonly BriefInputItem[];
    readonly documents: readonly BriefInputItem[];
    readonly brandAssets: readonly BriefInputItem[];
    readonly audio: readonly BriefInputItem[];
  };
  readonly assets: readonly BriefAsset[];
  readonly tools: {
    readonly allowed: readonly string[];
    readonly forbidden: readonly string[];
  };
  readonly claims: BriefClaims;
  readonly acceptance: readonly string[];
  readonly notes: string | null;
}

export interface BriefContext {
  /** 用来看 deliverable 是否与 spec 对得上 */
  readonly spec?: ResolvedVideoSpec | null;
  /** 用来解析 assets[].path；为 null 时跳过素材文件检查（例如校验原型模板） */
  readonly projectDir?: string | null;
}

export interface BriefCheckResult {
  readonly ok: boolean;
  readonly brief: ResolvedBrief | null;
  readonly issues: readonly Issue[];
  readonly counts: { readonly safeRepair: number; readonly warning: number; readonly fatal: number };
}

// ---------------------------------------------------------------- 常量

const ASPECT_RATIOS: Record<BriefAspect, number> = {
  '9:16': 9 / 16,
  '16:9': 16 / 9,
  '1:1': 1,
  '4:5': 4 / 5,
  '2:1': 2,
  '21:9': 21 / 9,
};

/** 画幅比值容差：1080×1920 与 9:16 完全相等，但 1080×1921 这类也该放过 */
const ASPECT_TOLERANCE = 0.01;
/** 时长容差（秒）：与 ffprobe 校验用的是同一量级 */
const DURATION_TOLERANCE = 0.05;

const ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
let compiledBrief: ReturnType<typeof ajv.compile> | null = null;
function briefValidator(): ReturnType<typeof ajv.compile> {
  let v = compiledBrief;
  if (!v) {
    v = ajv.compile(BRIEF_SCHEMA);
    compiledBrief = v;
  }
  return v;
}

// ---------------------------------------------------------------- 读取

/** 把 ajv 错误映射成统一 Issue：enum 类错误额外带上 allowed 列表 */
function schemaIssues(validate: ReturnType<typeof ajv.compile>, data: unknown): Issue[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => {
    const params = e.params as Record<string, unknown>;
    const allowed =
      e.keyword === 'enum' && Array.isArray(params['allowedValues'])
        ? (params['allowedValues'] as unknown[]).map(String)
        : undefined;
    return {
      severity: 'FATAL' as const,
      code: 'BRIEF_SCHEMA',
      path: e.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(根)',
      message: formatSchemaError(e),
      ...(allowed ? { allowed } : {}),
      hint: '字段名、类型与枚举都必须严格符合 .skill/references/direction.md',
    };
  });
}

/** 由首个致命问题决定对外错误码：声明冲突类问题单独分类 */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'CLAIM_CONFLICT',
  'TOOL_CONFLICT',
  'DELIVERABLE_MISMATCH',
]);

export function briefErrorCodeFor(issue: Issue): ErrorCode {
  return CONFLICT_CODES.has(issue.code) ? ERROR_CODES.BRIEF_CONFLICT : ERROR_CODES.BRIEF_INVALID;
}

export function loadBriefFile(path: string): unknown {
  if (!existsSync(path)) {
    throw new EngineError(ERROR_CODES.BRIEF_INVALID, `找不到提示词契约文件`, {
      details: { expected: path },
      hint: '在 project.json 里把 brief 指对，或用 `node .skill/engine/src/cli/index.ts project init` 生成骨架',
    });
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new EngineError(ERROR_CODES.BRIEF_INVALID, `brief.json 不是合法 JSON`, {
      details: { path },
      hint: 'JSON 语法错误必须人工修，引擎不会猜',
      cause: err,
    });
  }
}

// ---------------------------------------------------------------- 主体

/** 收集全部问题，不抛异常（测试与 `--json` 用） */
export function checkBrief(raw: unknown, ctx: BriefContext = {}): BriefCheckResult {
  const schemaIssuesFound = schemaIssues(briefValidator(), raw);
  if (schemaIssuesFound.length > 0) {
    const issues = schemaIssuesFound;
    return { ok: false, brief: null, issues, counts: count(issues) };
  }

  const m = raw as Record<string, unknown>;
  const issues: Issue[] = [];

  const deliverableRaw = m['deliverable'] as Record<string, unknown>;
  const assetsRaw = (m['assets'] as Record<string, unknown>[] | undefined) ?? [];
  const inputsRaw = (m['inputs'] as Record<string, unknown> | undefined) ?? {};
  const toolsRaw = m['tools'] as Record<string, unknown>;
  const claimsRaw = m['claims'] as Record<string, unknown>;

  const allowed = (toolsRaw['allowed'] as string[]).slice();
  const forbidden = ((toolsRaw['forbidden'] as string[] | undefined) ?? []).slice();

  const inputs = {
    referenceClips: readInputItems(inputsRaw['referenceClips']),
    documents: readInputItems(inputsRaw['documents']),
    brandAssets: readInputItems(inputsRaw['brandAssets']),
    audio: readInputItems(inputsRaw['audio']),
  };

  const brief: ResolvedBrief = {
    version: '0.1',
    archetype: String(m['archetype']),
    intent: String(m['intent']),
    audience: m['audience'] === undefined ? null : String(m['audience']),
    deliverable: {
      duration: Number(deliverableRaw['duration']),
      aspect: deliverableRaw['aspect'] as BriefAspect,
      fps: deliverableRaw['fps'] === undefined ? null : Number(deliverableRaw['fps']),
      captions: (deliverableRaw['captions'] as BriefCaptionMode | undefined) ?? 'inside_frame',
    },
    inputs,
    assets: assetsRaw.map((a) => ({
      path: String(a['path']),
      kind: a['kind'] as BriefAssetKind,
      license: String(a['license']),
      ...(a['source'] !== undefined ? { source: String(a['source']) } : {}),
      ...(a['sha256'] !== undefined ? { sha256: String(a['sha256']) } : {}),
    })),
    tools: { allowed, forbidden },
    claims: {
      humanRounds: claimsRaw['humanRounds'] === null ? null : Number(claimsRaw['humanRounds']),
      pureCode: Boolean(claimsRaw['pureCode']),
      zeroExternalAssets: Boolean(claimsRaw['zeroExternalAssets']),
      humanRevision: Boolean(claimsRaw['humanRevision']),
    },
    acceptance: ((m['acceptance'] as string[] | undefined) ?? []).slice(),
    notes: m['notes'] === undefined ? null : String(m['notes']),
  };

  checkArchetype(brief, issues);
  checkTools(brief, issues);
  checkClaims(brief, inputs, issues);
  if (ctx.spec) checkDeliverableAgainstSpec(brief, ctx.spec, issues);
  if (ctx.projectDir) checkAssets(brief, ctx.projectDir, issues);
  checkToolRuntimeNotes(brief, issues);

  const counts = count(issues);
  return { ok: counts.fatal === 0, brief, issues, counts };
}

/** 由致命问题列表构造对外错误：声明冲突类问题单独分类 */
export function briefErrorFromIssues(fatal: readonly Issue[]): EngineError {
  // 错误码取**最该先修**的那一条：
  // 声明冲突（例如「纯代码」却允许 Midjourney）不能靠"把工具登记一下"解决，
  // 因此它优先于 TOOL_UNREGISTERED / TOOL_REJECTED 这类登记问题。
  const first = fatal.find((i) => CONFLICT_CODES.has(i.code)) ?? fatal[0];
  if (!first) {
    return new EngineError(ERROR_CODES.BRIEF_INVALID, 'brief 不合法');
  }
  return new EngineError(
    briefErrorCodeFor(first),
    fatal.length === 1
      ? `${first.code}: ${first.message}`
      : `brief.json 存在 ${fatal.length} 个致命问题`,
    {
      details: {
        path: first.path,
        issues: fatal.map((i) => `${i.code} @ ${i.path}: ${i.message}`),
      },
      ...(first.allowed ? { allowed: first.allowed } : {}),
      ...(first.hint ? { hint: first.hint } : {}),
    },
  );
}

/**
 * 校验并在存在 FATAL 问题时抛语义化错误。
 *
 * 抛出的错误一定带 `path` / `allowed` / `hint` 三样（allowed 仅在问题本身有允许值时出现），
 * 理由与 VideoSpec 校验一致：弱模型要能只看错误就改对。
 */
export function validateBrief(raw: unknown, ctx: BriefContext = {}): {
  brief: ResolvedBrief;
  warnings: readonly Issue[];
} {
  const result = checkBrief(raw, ctx);
  const fatal = result.issues.filter((i) => i.severity === 'FATAL');

  if (fatal.length > 0 || !result.brief) {
    throw briefErrorFromIssues(fatal);
  }

  return { brief: result.brief, warnings: result.issues.filter((i) => i.severity !== 'FATAL') };
}

// ---------------------------------------------------------------- 各项检查

/**
 * 原型必须存在于原型库。
 * 原型库尚未建立时降级为警告——否则在 task-8 之前谁都无法提交 brief。
 */
function checkArchetype(brief: ResolvedBrief, issues: Issue[]): void {
  if (!archetypesDirExists()) {
    issues.push({
      severity: 'WARNING',
      code: 'ARCHETYPE_UNCHECKED',
      path: 'archetype',
      message: '提示词原型库尚未建立，跳过 archetype 校验',
      hint: '建立 prompts/archetypes/ 后此检查自动生效',
    });
    return;
  }
  const ids = archetypeIds();
  if (!ids.includes(brief.archetype)) {
    issues.push({
      severity: 'FATAL',
      code: 'ARCHETYPE_UNKNOWN',
      path: 'archetype',
      message: `找不到提示词原型 "${brief.archetype}"`,
      allowed: ids,
      hint: '从原型库里选一个；原型决定了提示词的形状，不要凭空造 id',
    });
  }
}

function checkTools(brief: ResolvedBrief, issues: Issue[]): void {
  const known = new Set(knownToolIds());

  for (const id of brief.tools.allowed) {
    if (!known.has(id)) {
      issues.push({
        severity: 'FATAL',
        code: 'TOOL_UNKNOWN',
        path: `tools.allowed[${brief.tools.allowed.indexOf(id)}]`,
        message: `工具 "${id}" 未登记`,
        allowed: knownToolIds(),
        hint: '通过 capabilities 查询工具注册状态；未登记的能力使用独立维护任务接入',
      });
      continue;
    }
    const tool = findTool(id);
    if (!tool) continue;
    if (tool.status === 'rejected') {
      issues.push({
        severity: 'FATAL',
        code: 'TOOL_REJECTED',
        path: `tools.allowed[${brief.tools.allowed.indexOf(id)}]`,
        message: `工具 "${id}"（${tool.label}）已被否决，不能作为允许项`,
        hint: `通过 capabilities 查询 ${tool.id} 的注册状态`,
      });
      continue;
    }
    if (tool.status === 'unregistered') {
      issues.push({
        severity: 'FATAL',
        code: 'TOOL_UNREGISTERED',
        path: `tools.allowed[${brief.tools.allowed.indexOf(id)}]`,
        message: `工具 "${id}"（${tool.label}）在本项目中未登记`,
        hint: '未登记的工具会让成果声明无法对账；先立项登记，再写进 allowed',
      });
      continue;
    }
    if (tool.status === 'candidate') {
      issues.push({
        severity: 'WARNING',
        code: 'TOOL_NOT_IMPLEMENTED',
        path: `tools.allowed[${brief.tools.allowed.indexOf(id)}]`,
        message: `工具 "${id}"（${tool.label}）仍是备选，本次渲染不会真正调用它`,
        hint: '若成片确实没用它，不要写进公开说明',
      });
    }
  }

  for (const id of brief.tools.forbidden) {
    if (!known.has(id)) {
      issues.push({
        severity: 'FATAL',
        code: 'TOOL_UNKNOWN',
        path: `tools.forbidden[${brief.tools.forbidden.indexOf(id)}]`,
        message: `工具 "${id}" 未登记`,
        allowed: knownToolIds(),
        hint: '通过 capabilities 查询工具注册状态',
      });
    }
  }

  const both = brief.tools.allowed.filter((id) => brief.tools.forbidden.includes(id));
  for (const id of both) {
    issues.push({
      severity: 'FATAL',
      code: 'TOOL_CONFLICT',
      path: 'tools',
      message: `工具 "${id}" 同时出现在 allowed 与 forbidden`,
      hint: '删掉其中一处；自相矛盾的工具边界无法对账',
    });
  }
}

function checkClaims(
  brief: ResolvedBrief,
  inputs: ResolvedBrief['inputs'],
  issues: Issue[],
): void {
  const allowedTools = brief.tools.allowed.map((id) => findTool(id)).filter((t) => t !== undefined);
  const externalVisual = allowedTools.filter((t) => t.kind === 'external-visual');

  if (brief.claims.pureCode) {
    if (externalVisual.length > 0) {
      issues.push({
        severity: 'FATAL',
        code: 'CLAIM_CONFLICT',
        path: 'claims.pureCode',
        message:
          `声称纯代码（pureCode=true），却允许外部视觉模型: ` +
          externalVisual.map((t) => t.id).join(', '),
        hint: '要么把这些工具移出 allowed，要么把 pureCode 改成 false',
      });
    }
    if (!allowedTools.some((t) => t.kind === 'renderer')) {
      issues.push({
        severity: 'FATAL',
        code: 'CLAIM_CONFLICT',
        path: 'claims.pureCode',
        message: '声称纯代码（pureCode=true），但 allowed 里没有任何渲染器',
        allowed: TOOL_REGISTRY.filter((t) => t.kind === 'renderer').map((t) => t.id),
        hint: '画面由谁画必须写清楚；纯代码声称对应的是代码渲染器',
      });
    }
  }

  const inputCount =
    inputs.referenceClips.length + inputs.documents.length + inputs.brandAssets.length + inputs.audio.length;

  if (brief.claims.zeroExternalAssets) {
    if (brief.assets.length > 0) {
      issues.push({
        severity: 'FATAL',
        code: 'CLAIM_CONFLICT',
        path: 'claims.zeroExternalAssets',
        message: `声称零外部素材，但 assets 里列了 ${brief.assets.length} 项外部素材`,
        hint: '素材清单是输入边界的证据；两者只能有一个是真的',
      });
    }
    if (inputCount > 0) {
      issues.push({
        severity: 'FATAL',
        code: 'CLAIM_CONFLICT',
        path: 'claims.zeroExternalAssets',
        message: `声称零外部素材，但 inputs 里列了 ${inputCount} 项输入（参考片/资料/品牌资产/音频）`,
        hint: '参考片和资料也属于外部输入；声称零素材就不能有它们',
      });
    }
  }

  if (brief.claims.humanRounds === null) {
    issues.push({
      severity: 'WARNING',
      code: 'HUMAN_ROUNDS_UNRECORDED',
      path: 'claims.humanRounds',
      message: '人类指令轮数未记录',
      hint: '披露里会写成"轮数未记录"，因此不得对外声称 one prompt',
    });
  }
}

function checkDeliverableAgainstSpec(
  brief: ResolvedBrief,
  spec: ResolvedVideoSpec,
  issues: Issue[],
): void {
  const d = brief.deliverable;
  if (Math.abs(d.duration - spec.video.duration) > DURATION_TOLERANCE) {
    issues.push({
      severity: 'FATAL',
      code: 'DELIVERABLE_MISMATCH',
      path: 'deliverable.duration',
      message: `声明时长 ${d.duration}s 与 spec 的 ${spec.video.duration}s 不一致`,
      hint: '声明与 spec 必须描述同一支片子，改一处就要改另一处',
    });
  }

  const actualRatio = spec.video.width / spec.video.height;
  const declared = ASPECT_RATIOS[d.aspect];
  if (Math.abs(actualRatio - declared) / declared > ASPECT_TOLERANCE) {
    issues.push({
      severity: 'FATAL',
      code: 'DELIVERABLE_MISMATCH',
      path: 'deliverable.aspect',
      message:
        `声明画幅 ${d.aspect} 与 spec 的 ${spec.video.width}×${spec.video.height}` +
        `（比值 ${actualRatio.toFixed(4)}）不一致`,
      hint: '画幅写错会让平台方按错误的规格转码',
    });
  }

  if (d.fps !== null && d.fps !== spec.video.fps) {
    issues.push({
      severity: 'FATAL',
      code: 'DELIVERABLE_MISMATCH',
      path: 'deliverable.fps',
      message: `声明帧率 ${d.fps} 与 spec 的 ${spec.video.fps} 不一致`,
      hint: '删掉 fps 字段表示"以 spec 为准"',
    });
  }

  if (d.captions === 'none' && spec.captions.enabled) {
    issues.push({
      severity: 'WARNING',
      code: 'CAPTIONS_MISMATCH',
      path: 'deliverable.captions',
      message: '声明不做画面内字幕，但 spec 的 captions.enabled 为 true',
      hint: '渲染时可用 --no-captions，或把声明改成 inside_frame',
    });
  }
}

function checkAssets(brief: ResolvedBrief, projectDir: string, issues: Issue[]): void {
  for (const asset of brief.assets) {
    let abs: string;
    try {
      abs = resolveInsideProject(projectDir, asset.path, `assets[${asset.path}].path`);
    } catch (err) {
      issues.push({
        severity: 'FATAL',
        code: 'ASSET_OUTSIDE_PROJECT',
        path: `assets[${asset.path}]`,
        message: `素材路径逃出项目目录: ${asset.path}`,
        hint: err instanceof EngineError && err.hint ? err.hint : '素材必须放在项目目录内',
      });
      continue;
    }

    if (!existsSync(abs)) {
      issues.push({
        severity: 'FATAL',
        code: 'ASSET_MISSING',
        path: `assets[${asset.path}]`,
        message: `声明的素材文件不存在: ${asset.path}`,
        hint: '把文件放进去，或从 assets 里删掉这条声明',
      });
      continue;
    }

    if (asset.sha256) {
      const actual = sha256File(abs);
      if (actual !== asset.sha256) {
        issues.push({
          severity: 'FATAL',
          code: 'ASSET_HASH_MISMATCH',
          path: `assets[${asset.path}].sha256`,
          message: `素材哈希不符（声明 ${asset.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`,
          hint: '哈希是素材未被替换的证据；要么更新声明，要么找回原文件',
        });
      }
    }

    if (asset.license.trim().toLowerCase() === 'unknown') {
      issues.push({
        severity: 'WARNING',
        code: 'LICENSE_UNKNOWN',
        path: `assets[${asset.path}].license`,
        message: `素材 "${asset.path}" 授权未知`,
        hint: '授权未知的素材只能在内部参考，披露里会单独标出',
      });
    }
  }
}

/** 网络服务的可复现性提醒：直接影响"确定性"能说到哪一步 */
function checkToolRuntimeNotes(brief: ResolvedBrief, issues: Issue[]): void {
  const tools = brief.tools.allowed.map((id) => findTool(id)).filter((t) => t !== undefined);
  for (const tool of tools) {
    if (tool.status === 'adopted' && !tool.byteReproducible) {
      issues.push({
        severity: 'WARNING',
        code: 'NONDETERMINISTIC_TOOL',
        path: `tools.allowed[${brief.tools.allowed.indexOf(tool.id)}]`,
        message:
          `工具 "${tool.id}"（${tool.label}）输出不逐字节可复现` +
          `${tool.network ? '（网络服务）' : ''}`,
        hint: '披露里必须把它写成"相同输入 → 相同画面"，同时说明该工具本身的输出不保证一致',
      });
    }
  }
}

// ---------------------------------------------------------------- 辅助

function readInputItems(raw: unknown): BriefInputItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = item as Record<string, unknown>;
    return {
      ...(o['url'] !== undefined ? { url: String(o['url']) } : {}),
      note: String(o['note']),
      ...(o['license'] !== undefined ? { license: String(o['license']) } : {}),
    };
  });
}

function count(issues: readonly Issue[]): { safeRepair: number; warning: number; fatal: number } {
  let safeRepair = 0;
  let warning = 0;
  let fatal = 0;
  for (const i of issues) {
    if (i.severity === 'SAFE_REPAIR') safeRepair++;
    else if (i.severity === 'WARNING') warning++;
    else fatal++;
  }
  return { safeRepair, warning, fatal };
}
