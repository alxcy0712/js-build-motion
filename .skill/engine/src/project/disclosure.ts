/** 对账 brief 声明与 run 实测，生成带证据等级的披露。 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { sha256File } from '../utils/hash.ts';
import { loadSpecFile, validateSpec } from '../spec/validate.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import type { ProjectHandle } from './manifest.ts';
import { loadBriefFile, validateBrief, type ResolvedBrief } from './brief.ts';
import { readRunLog, verifyRunLog, type RunLog } from './run-log.ts';
import { findTool, isCodeRenderer, type ToolEntry } from './tool-registry.ts';
import { assertRecordedAttemptInputs } from './attempt.ts';

export const DISCLOSURE_FILE = 'DISCLOSURE.md';

/** 证据等级的唯一枚举 */
export const EVIDENCE = {
  measured: '【实测】',
  declared: '【声明】',
  inferred: '【推断】',
} as const;

export interface Finding {
  readonly severity: 'FATAL' | 'WARNING';
  readonly code: string;
  /** 出问题的 brief 字段路径，便于直接定位要改哪里 */
  readonly field: string;
  readonly message: string;
  readonly hint?: string;
}

export interface ReconcileResult {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly counts: { readonly fatal: number; readonly warning: number };
}

// ---------------------------------------------------------------- 对账

/**
 * 声明与实测逐条比对。
 *
 * 每一类冲突都对应一个真实会发生的错误，不是形式化检查：
 * 「提示词允许了工具但实际没用」和「实际用了但没声明」是两种完全不同的失实，
 * 前者是浪费自由度，后者是漏报输入。
 */
export function reconcile(brief: ResolvedBrief, log: RunLog): ReconcileResult {
  const findings: Finding[] = [];
  const usage = log.facts.assets.usage;
  const usedAssets = [...log.facts.assets.consumed.map(a => ({ ...a, path: log.project && a.path.startsWith(`projects/${log.project}/`)
    ? a.path.slice(`projects/${log.project}/`.length) : a.path })),
    ...new Map((usage?.receipts ?? []).map(r => [r.useId, { path: r.source.path, sha256: r.byteSha256, role: r.role }])).values()];
  const allowed = new Set(brief.tools.allowed);
  const forbidden = new Set(brief.tools.forbidden);

  // ---- 1. 工具边界 ----
  for (const id of log.facts.tools) {
    if (forbidden.has(id)) {
      findings.push({
        severity: 'FATAL',
        code: 'USED_FORBIDDEN_TOOL',
        field: 'tools.forbidden',
        message: `明确禁止的工具被实际调用: ${id}`,
        hint: '要么改 brief（并说明原因），要么改渲染链路把该工具去掉',
      });
      continue;
    }
    if (!allowed.has(id)) {
      findings.push({
        severity: 'FATAL',
        code: 'USED_UNDECLARED_TOOL',
        field: 'tools.allowed',
        message: `实际调用了未声明的工具: ${id}`,
        hint: '把该工具写进 brief.tools.allowed，或把这次调用从链路里去掉',
      });
    }
  }

  for (const raw of log.facts.unmappedTools) {
    findings.push({
      severity: 'WARNING',
      code: 'TOOL_NOT_IN_REGISTRY',
      field: 'tools.allowed',
      message: `观测到未登记的工具/提供方: ${raw}`,
      hint: '给它补一个工具注册表条目，否则它无法被声明，也无法出现在披露的工具链里',
    });
  }

  // ---- 2. 四项独立声称 ----
  const rendererTool = log.facts.renderer.toolId ? findTool(log.facts.renderer.toolId) : undefined;

  if (brief.claims.pureCode) {
    const ok = rendererTool !== undefined && isCodeRenderer(rendererTool);
    if (!ok) {
      findings.push({
        severity: 'FATAL',
        code: 'PURE_CODE_VIOLATED',
        field: 'claims.pureCode',
        message: `声称纯代码，但实际渲染器是 ${rendererTool?.label ?? log.facts.renderer.kind}`,
        hint: '把 pureCode 改成 false，并说明像素由什么产生',
      });
    }
  }

  if (brief.claims.zeroExternalAssets) {
    const external = log.facts.assets.external;
    if (external.length > 0) {
      findings.push({
        severity: 'FATAL',
        code: 'ZERO_ASSETS_VIOLATED',
        field: 'claims.zeroExternalAssets',
        message: `声称零外部素材，但渲染时核验了 ${external.length} 项外部素材`,
        hint: '把 zeroExternalAssets 改成 false，并把这些素材写进披露的输入边界',
      });
    }
    if (usedAssets.length > 0) {
      findings.push({
        severity: 'FATAL',
        code: 'ZERO_ASSETS_VIOLATED',
        field: 'claims.zeroExternalAssets',
        message: `声称零外部素材，但管线实际读取了 ${usedAssets.length} 个素材文件`,
        hint: '输入边界与实际读取的文件不一致，属于漏报输入',
      });
    }
    if (usage?.coverage !== 'complete') findings.push({ severity: 'WARNING', code: 'ASSET_COVERAGE_PARTIAL', field: 'claims.zeroExternalAssets',
      message: '素材消费覆盖为 partial；零外部素材声明的完整证据待核验。' });
  }

  // ---- 3. 素材：用了没声明 / 声明了没用 ----
  const declaredPaths = new Set(log.facts.assets.external.map((a) => a.path));
  for (const used of usedAssets) {
    const declared = declaredPaths.has(used.path);
    if (!declared) {
      findings.push({
        severity: 'FATAL',
        code: 'USED_UNDECLARED_ASSET',
        field: 'assets',
        message: `管线读取了未声明的素材: ${used.path}（角色 ${used.role}）`,
        hint: '把该素材写进 brief.assets 并填授权，否则输入边界不完整',
      });
    }
    const match = log.facts.assets.external.find(a => a.path === used.path);
    if (match && match.sha256 !== used.sha256) findings.push({ severity: 'FATAL', code: 'ASSET_DECLARATION_HASH_MISMATCH', field: 'assets',
      message: `声明与实际读取的 SHA-256 不一致: ${used.path}` });
  }
  for (const declared of log.facts.assets.external) {
    const used = usedAssets.some(c => c.path === declared.path && c.sha256 === declared.sha256);
    if (!used) {
      findings.push({
        severity: 'WARNING',
        code: usage?.coverage === 'complete' ? 'DECLARED_ASSET_UNUSED' : 'DECLARED_ASSET_UNOBSERVED',
        field: 'assets',
        message: usage?.coverage === 'complete' ? `完整观测范围内该素材消费次数为零: ${declared.path}` : `当前 partial 观测范围中该素材消费待核验: ${declared.path}`,
      });
    }
    if (declared.license.trim().toLowerCase() === 'unknown') {
      findings.push({
        severity: 'WARNING',
        code: 'ASSET_LICENSE_UNKNOWN',
        field: 'assets',
        message: `素材授权未知: ${declared.path}`,
        hint: '授权未知的素材不得对外发布；披露会把它单独标出',
      });
    }
  }

  // ---- 4. 交付规格（双保险：brief 校验已查过一次，这里再对产物查一次） ----
  if (Math.abs(brief.deliverable.duration - log.facts.video.duration) > 0.05) {
    findings.push({
      severity: 'FATAL',
      code: 'DELIVERABLE_DRIFT',
      field: 'deliverable.duration',
      message: `声明时长 ${brief.deliverable.duration}s，实测 ${log.facts.video.duration}s`,
      hint: 'brief 与产物必须描述同一支片子',
    });
  }

  const fatal = findings.filter((f) => f.severity === 'FATAL').length;
  const warning = findings.length - fatal;
  return { ok: fatal === 0, findings, counts: { fatal, warning } };
}

// ---------------------------------------------------------------- 编排

export interface DisclosureResult {
  readonly path: string;
  readonly content: string;
  readonly reconcile: ReconcileResult;
  readonly log: RunLog;
  readonly brief: ResolvedBrief;
  readonly warnings: readonly string[];
}

export function buildDisclosure(project: ProjectHandle): DisclosureResult {
  if (project.briefPath === null) {
    throw new EngineError(ERROR_CODES.BRIEF_INVALID, `项目 ${project.slug} 没有 brief.json，无法生成披露`, {
      details: { projectDir: project.dir },
      hint: '没有声明就没有对账对象；先在 project.json 里把 brief 指对',
    });
  }

  const briefPath = project.briefPath;
  const briefRaw = loadBriefFile(briefPath);

  // 顺序是刻意的：先确认"这份 run.json 描述的就是当前输入"，再谈声明是否自洽。
  // 反过来的话，手改 spec 会先撞上"声明时长与 spec 不一致"，
  // 而真正的病因是"没重新渲染"——后者才是可执行的建议。
  const logPath = join(project.dir, 'run.json');
  const log = readRunLog(logPath);
  if (log.execution) assertRecordedAttemptInputs(project, log.execution, log);

  const specSha256 = sha256File(project.specPath);
  const briefSha256 = sha256File(briefPath);

  const integrity = verifyRunLog({ log, specSha256, briefSha256 });
  if (!integrity.ok) {
    throw new EngineError(ERROR_CODES.BRIEF_CONFLICT, `run.json 与当前输入不一致`, {
      details: { runLog: logPath, reason: integrity.reason ?? '未知' },
      hint: '重新渲染一次；对账必须基于同一次渲染的记录',
    });
  }

  const spec = validateSpec(loadSpecFile(project.specPath)).spec;
  const { brief, warnings } = validateBrief(briefRaw, {
    ...(spec ? { spec } : {}),
    projectDir: project.dir,
  });

  const result = reconcile(brief, log);
  const content = renderDisclosure({
    brief,
    briefPath,
    log,
    project,
    reconcile: result,
    briefWarnings: warnings.map((w) => `${w.code} @ ${w.path}: ${w.message}`),
    ...(spec ? { spec } : {}),
  });

  return {
    path: join(project.dir, DISCLOSURE_FILE),
    content,
    reconcile: result,
    log,
    brief,
    warnings: warnings.map((w) => `${w.code} @ ${w.path}: ${w.message}`),
  };
}

export function writeDisclosure(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

// ---------------------------------------------------------------- 渲染

interface RenderInput {
  readonly brief: ResolvedBrief;
  readonly briefPath: string;
  readonly log: RunLog;
  readonly project: ProjectHandle;
  readonly reconcile: ReconcileResult;
  readonly briefWarnings: readonly string[];
  /** 当前 spec（已校验）。用于把字幕/双语等实际内容与 run.json 实测对齐 */
  readonly spec?: ResolvedVideoSpec | undefined;
}

/**
 * 生成 DISCLOSURE.md。
 *
 * 按实际输入、运行记录和对账结果说明制作过程与成果声明的证据范围。
 */
export function renderDisclosure(input: RenderInput): string {
  const { brief, log, reconcile: rec } = input;
  const f = log.facts;
  const lines: string[] = [];
  const p = (...s: string[]): void => {
    lines.push(...s);
  };

  p(`# 披露 · ${input.project.manifest.title}`);
  p('');
  p(`> 本文件由 \`node .skill/engine/src/cli/index.ts disclosure ${input.project.slug}\` 生成，**不要手改**。`);
  p(`> 每条结论都标了证据等级：${EVIDENCE.measured} 引擎观测 · ${EVIDENCE.declared} 人写进 brief 且不可验证 · ${EVIDENCE.inferred} 由前两者推出。`);
  p('');
  p(`| 项 | 值 |`);
  p(`|---|---|`);
  p(`| 对账结果 | ${rec.ok ? '通过' : `**未通过**（${rec.counts.fatal} 个致命问题）`} |`);
  p(`| runId | \`${log.runId}\` |`);
  p(`| 输入 spec | \`${log.spec.path}\` \`${log.spec.sha256.slice(0, 16)}…\` |`);
  p(`| 提示词契约 | ${log.brief ? `\`${log.brief.path}\` \`${log.brief.sha256.slice(0, 16)}…\`` : '（未使用）'} |`);
  p(`| 生成命令 | \`node .skill/engine/src/cli/index.ts render ${input.project.slug}\` → \`node .skill/engine/src/cli/index.ts disclosure ${input.project.slug}\` |`);
  p('');

  // ------------------------------------------------------------ 产物
  p(`## 1. 产物 ${EVIDENCE.measured}`);
  p('');
  p(`| 项 | 值 |`);
  p(`|---|---|`);
  p(`| 分辨率 | ${f.video.width}×${f.video.height} |`);
  p(`| 帧率 / 时长 | ${f.video.fps} fps / ${f.video.duration}s（${f.video.frames} 帧） |`);
  p(`| 视频编码 | ${f.encoder.video} / ${f.encoder.pixelFormat}${f.encoder.crf !== null ? ` / crf ${f.encoder.crf}` : ''} |`);
  p(`| 音频编码 | ${f.encoder.audio ?? '无音频流'} |`);
  p(`| 随机种子 | ${f.video.seed} |`);
  p(`| 成片 | \`${log.measured.outputPath}\` |`);
  p(`| 产物体积 | ${(log.measured.outputBytes / 1048576).toFixed(2)} MB |`);
  p(`| 渲染耗时 | ${(log.measured.renderMs / 1000).toFixed(2)}s（${log.measured.msPerFrame.toFixed(1)} ms/帧） |`);
  p('');
  p(`以上全部由引擎在渲染时观测并写入 \`run.json\`；耗时不参与对账，仅作参考。`);
  p('');

  // ------------------------------------------------------------ 画面来源
  p(`## 2. 画面来源`);
  p('');
  p(`| 结论 | 等级 | 依据 |`);
  p(`|---|---|---|`);
  const rendererDesc = `${f.renderer.package}${f.renderer.version ? `@${f.renderer.version}` : ''}（kind=${f.renderer.kind}）`;
  p(`| 画面由代码逐帧绘制，工具为 ${rendererDesc} | ${EVIDENCE.measured} | run.json \`facts.renderer\` |`);
  p(
    `| ${brief.claims.pureCode ? '**未使用任何外部视觉模型或视频模型**' : '使用了代码之外的手段生成画面（见「工具链」）'} | ${
      brief.claims.pureCode ? EVIDENCE.inferred : EVIDENCE.declared
    } | ${brief.claims.pureCode ? '渲染器类型 + 工具链清单' : 'brief.claims.pureCode = false'} |`,
  );
  p(`| 未使用视频生成模型（Seedance / Kling / MiniMax H3 等） | ${EVIDENCE.inferred} | 工具链里不存在 \`external-visual\` 类工具 |`);
  p('');

  // ------------------------------------------------------------ 输入边界
  p(`## 3. 输入边界`);
  p('');
  const external = f.assets.external;
  const consumed = f.assets.consumed;
  const usage = f.assets.usage, preparedReceipts = usage?.receipts ?? [];
  p(`素材消费覆盖：\`${usage?.coverage ?? 'partial'}\`。观测范围：${usage?.scope.join('、') ?? '历史管线文件读取'}。`);
  if (usage?.coverage !== 'complete') p(`待核验范围：${usage?.unknownRemainder.join('；') ?? '历史记录以外的动态 IO 和最终像素可见性'}。`);
  p('');
  if (external.length === 0 && consumed.length === 0 && preparedReceipts.length === 0 && usage?.coverage === 'complete') {
    p(`**零外部素材**：封闭的内置制作路径中，内容素材输入和消费次数均为零。`);
    p('');
    p(`| 结论 | 等级 | 依据 |`);
    p(`|---|---|---|`);
    p(`| 内容素材输入为空 | ${EVIDENCE.measured} | run.json \`facts.assets.usage\` 的 complete 观测范围 |`);
  } else {
    p(`外部素材清单（含哈希，用于证明文件未被替换）：`);
    p('');
    p(`| 素材 | 类型 | 授权 | sha256 |`);
    p(`|---|---|---|---|`);
    for (const a of external) {
      p(`| \`${a.path}\` | ${a.kind} | ${a.license} | \`${a.sha256.slice(0, 16)}…\` |`);
    }
    if (external.length === 0) p(`| （无） | | | |`);
    p('');
  }
  p('');
  if (preparedReceipts.length) {
    p('受控素材消费回执（读取、绘制与帧访问分别记录；最终像素可见性进入审片）：'); p('');
    p('| use / need / shot | assetId / version | 原件 SHA-256 | 原件 / 选定输入 | 操作次数 |'); p('|---|---|---|---|---|');
    for (const useId of new Set(preparedReceipts.map(r => r.useId))) {
      const entries = preparedReceipts.filter(r => r.useId === useId), r = entries[0]!;
      const counts = new Map<string, number>(); for (const entry of entries) counts.set(entry.operation, (counts.get(entry.operation) ?? 0) + 1);
      p(`| ${r.useId} / ${r.needId} / ${r.shotId} | ${r.assetId} / ${r.assetVersion} | ${r.byteSha256} | ${r.source.path} / ${r.selected.path} (${r.selected.sha256}) | ${[...counts].map(([op, n]) => `${op}: ${n}`).join('; ')} |`);
    }
    p(''); p(`完整回执：\`${log.execution?.assetUsage?.path}\`，SHA-256 \`${log.execution?.assetUsage?.sha256}\`。`); p('');
  }
  if (usage?.gaps.length) { p('素材需求缺口：'); p('');
    for (const gap of usage.gaps) p(`- ${gap.needId} / ${gap.shotId} / ${gap.useId ?? 'unbound'}: ${gap.code} — ${gap.reason}`); p(''); }

  const audio = log.measured.audioArtifacts ?? [];
  if (f.audioReuse) {
    p(`声音复用：\`${f.audioReuse.lockPath}\`，锁包 SHA-256 \`${f.audioReuse.lockSha256}\`。原制作来源为 TTS=${f.audioReuse.sourceProviders.tts}、BGM=${f.audioReuse.sourceProviders.bgm}、SFX=${f.audioReuse.sourceProviders.sfx}；本次执行读取已定稿声音并进行编码。`);
    p('');
  }
  if (audio.length > 0) {
    p(`音频中间产物（每个都能单独试听，便于核对配音是否真的进去了）：`);
    p('');
    p(`| 角色 | 文件 | sha256 |`);
    p(`|---|---|---|`);
    for (const a of audio) {
      p(`| ${a.role} | \`${a.path}\` | \`${a.sha256.slice(0, 16)}…\` |`);
    }
    p('');
  }

  if (f.fonts.length > 0) {
    p(`字体（内嵌，不依赖系统字体）：`);
    p('');
    p(`| 字体 | 文件 | 注册 | sha256 |`);
    p(`|---|---|---|---|`);
    for (const font of f.fonts) {
      p(`| ${font.family} | \`${font.path}\` | ${font.registered ? '是' : '否'} | \`${font.sha256.slice(0, 16)}…\` |`);
    }
    p('');
    p(`> 字体属于工具链资产，不计入"内容素材"。模板、参考片、音效采样这类**内容输入**见上表。`);
    p('');
  }

  // ------------------------------------------------------------ 工具链
  p(`## 4. 工具链 ${EVIDENCE.measured}`);
  p('');
  p(`渲染时**实际调用**的工具（不是提示词里允许的工具）：`);
  p('');
  p(`| 工具 | 用途 | 状态 | 属性 |`);
  p(`|---|---|---|---|`);
  for (const id of f.tools) {
    const tool = findTool(id);
    p(
      `| \`${id}\` | ${tool ? toolKindLabel(tool) : '—'} | ${tool ? statusLabel(tool) : '—'} | ${
        tool?.network ? '依赖网络' : '本地'
      }${tool && !tool.byteReproducible ? ' · 输出不逐字节可复现' : ''} |`,
    );
  }
  p('');
  const allowedUnused = brief.tools.allowed.filter((id) => !f.tools.includes(id));
  if (allowedUnused.length > 0) {
    p(`提示词允许但**本次未使用**的工具：${allowedUnused.map((id) => `\`${id}\``).join('、')}。`);
    p('');
    p(`> 公开说明里不要把这些工具写成本片用过的工具——"允许"不等于"使用"。`);
    p('');
  }
  if (f.network.length > 0) {
    p(`其中依赖网络的服务：${f.network.map((id) => `\`${id}\``).join('、')}。`);
    p(`这些服务的调用不产生任何可复用的素材输入，因此不影响"零外部素材"的判定，`);
    p(`但它们本身的输出不保证逐字节可复现（见 §6）。`);
    p('');
  }

  // ------------------------------------------------------------ 字幕与配音
  p(`## 4.1 字幕与配音对账 ${EVIDENCE.measured}`);
  p('');
  const narration = input.spec?.audio.narration ?? [];
  const bilingual = narration.filter((line) => line.translation).length;
  const voiceArtifacts = log.measured.audioArtifacts.filter((a) => a.role === 'voice').length;
  p(`| 项 | 值 |`);
  p(`|---|---|`);
  p(`| 帧内字幕 | ${f.captions.cues} 条（run.json \`facts.captions\`） |`);
  p(`| 词级时间戳 | ${f.captions.wordLevel ? '有（时间轴来自 TTS 实测）' : '无（回退到确定性估算）'} |`);
  p(`| 双语字幕 | ${narration.length === 0 ? '本片无旁白' : `${bilingual}/${narration.length} 条旁白带第二语言行（由渲染层画入帧内，并写入外挂 .srt/.vtt）`} |`);
  p(`| 旁白音轨 | ${f.audioReuse ? `复用声音锁（原来源 ${f.audioReuse.sourceProviders.tts}）` : f.providers.tts}：实测成功 ${voiceArtifacts}/${narration.length} 条${voiceArtifacts < narration.length ? '，**存在回退/缺失**' : '，无回退'} |`);
  p('');
  if (voiceArtifacts < narration.length) {
    p(`> 明确写出：有 ${narration.length - voiceArtifacts} 条旁白未能合成，成片里没有对应人声；字幕时间轴对这些条目只能退回估算。`);
    p('');
  }
  if (bilingual > 0) {
    p(`> 双语字幕的第二行**不参与 TTS**：配音只念主语言文本，译文仅上屏。
> 两行共用同一条 cue 的时间轴，因此不会出现中英各行其是的情况。`);
    p('');
  }

  // ------------------------------------------------------------ 四项独立声称
  p(`## 5. 四项独立声称`);
  p('');
  p('四项声称分别记录，按实际输入、工具与制作过程逐项核对：');
  p('');
  p(`| # | 声称 | brief 里的值 | 等级 | 说明 |`);
  p(`|---|---|---|---|---|`);
  p(
    `| 1 | 人类指令轮数 | ${brief.claims.humanRounds === null ? '未记录' : brief.claims.humanRounds} | ${EVIDENCE.declared} | ` +
      `引擎无法观测人类交互轮数${brief.claims.humanRounds === null ? '；**不得对外声称 "one prompt"**' : ''} |`,
  );
  p(
    `| 2 | 画面纯代码 | ${brief.claims.pureCode ? '是' : '否'} | ${EVIDENCE.inferred} | 由渲染器类型与工具链推出 |`,
  );
  p(
    `| 3 | 零外部素材 | ${brief.claims.zeroExternalAssets ? '是' : '否'} | ${usage?.coverage === 'complete' ? EVIDENCE.measured : EVIDENCE.declared} | 消费覆盖 ${usage?.coverage ?? 'partial'} |`,
  );
  p(
    `| 4 | 无人工修改 | ${brief.claims.humanRevision ? '否（有人工修改）' : '是'} | ${EVIDENCE.declared} | 引擎无法观测评审与返工过程 |`,
  );
  p('');
  p(`### 可以这样描述`);
  p('');
  p(canSaySentence(brief, log));
  p('');
  p(`### 不应这样描述`);
  p('');
  for (const s of cannotSay(brief, log)) p(`- ${s}`);
  p('');

  // ------------------------------------------------------------ 确定性
  p(`## 6. 关于「确定性」`);
  p('');
  p(`本项目对确定性的准确表述是：**相同音频输入 → 逐帧相同的画面**。`);
  const nondet = f.tools.filter((id) => findTool(id)?.byteReproducible === false);
  if (nondet.length > 0) {
    p('');
    p(`本次用到了输出不逐字节可复现的工具：${nondet.map((id) => `\`${id}\``).join('、')}。`);
    p(`因此**不应声称"同一条命令得到逐字节相同的 MP4"**。`);
    p(`run.json 记录这些中间产物的哈希，正是为了让这一点可被事后核对。`);
  }
  p('');

  // ------------------------------------------------------------ 验收
  if (brief.acceptance.length > 0) {
    p(`## 7. 验收清单 ${EVIDENCE.declared}`);
    p('');
    p(`以下条件由人写下、需要人逐条确认，引擎不做判断：`);
    p('');
    for (const a of brief.acceptance) p(`- [ ] ${a}`);
    p('');
  }

  // ------------------------------------------------------------ 对账明细
  p(`## 8. 对账明细`);
  p('');
  if (rec.findings.length === 0) {
    p(`声明与实测无冲突。`);
  } else {
    p(`| 严重度 | 码 | 字段 | 说明 |`);
    p(`|---|---|---|---|`);
    for (const fd of rec.findings) {
      p(`| ${fd.severity === 'FATAL' ? '致命' : '警告'} | \`${fd.code}\` | \`${fd.field}\` | ${fd.message} |`);
    }
  }
  if (input.briefWarnings.length > 0) {
    p('');
    p(`brief 校验阶段的告警（不阻断对账）：`);
    p('');
    for (const w of input.briefWarnings) p(`- ${w}`);
  }
  p('');

  if (brief.notes) {
    p(`## 9. 备注 ${EVIDENCE.declared}`);
    p('');
    p(brief.notes);
    p('');
  }

  p(`---`);
  p('');
  p(`复核方式：\`node .skill/engine/src/cli/index.ts disclosure ${input.project.slug}\` 会重算 runId；`);
  p(`若 \`run.json\` 的 facts 段或 spec/brief 被改动过，命令会失败并指出不一致处。`);
  p('');

  return lines.join('\n');
}

// ---------------------------------------------------------------- 文案

function toolKindLabel(tool: ToolEntry): string {
  const labels: Record<ToolEntry['kind'], string> = {
    renderer: '画面/渲染',
    tts: '语音合成',
    bgm: '配乐',
    sfx: '音效',
    media: '媒体处理',
    fetcher: '素材获取',
    asr: '语音识别',
    'external-visual': '外部视觉模型',
    editor: '图形/剪辑',
  };
  return labels[tool.kind];
}

function statusLabel(tool: ToolEntry): string {
  const labels: Record<ToolEntry['status'], string> = {
    adopted: '采用',
    candidate: '备选',
    rejected: '否决',
    unregistered: '未登记',
  };
  return labels[tool.status];
}

/** "可以这样描述"：只写能站得住的那部分 */
function canSaySentence(brief: ResolvedBrief, log: RunLog): string {
  const f = log.facts;
  const parts: string[] = [];
  parts.push(
    `${f.video.duration} 秒 / ${f.video.width}×${f.video.height} / ${f.video.fps}fps 的影片，` +
      `画面由 ${f.renderer.package} 逐帧绘制`,
  );
  if (brief.claims.zeroExternalAssets && f.assets.usage?.coverage === 'complete' && !f.assets.external.length && !f.assets.consumed.length && !f.assets.usage.receipts.length) parts.push('封闭制作路径的内容素材消费次数为零');
  if (f.audioReuse) parts.push('声音沿用有哈希的定稿声音包');
  else if (f.providers.tts !== '(none)') {
    // 用注册表里的正式名（"edge" → "edge-tts"）：披露里出现的工具名必须能在登记表查到
    const ttsTool = f.tools.map((id) => findTool(id)).find((t) => t?.kind === 'tts');
    parts.push(`配音由 ${ttsTool?.label ?? f.providers.tts} 生成`);
  }
  if (f.providers.bgm === 'procedural') parts.push('配乐由代码合成');
  if (f.providers.sfx === 'procedural') parts.push('音效由代码合成');  const human =
    brief.claims.humanRounds === null
      ? '人类指令轮数未记录'
      : `人类指令 ${brief.claims.humanRounds} 轮`;
  const revision = brief.claims.humanRevision ? '经过人工修改' : '未见人工修改记录';
  return `> ${parts.join('，')}；${human}，${revision}。`;
}

/** "不应这样描述"：把这次渲染不支持的表述逐条列出来 */
function cannotSay(brief: ResolvedBrief, log: RunLog): string[] {
  const out: string[] = [];
  if (brief.claims.humanRounds === null) {
    out.push(`**"one prompt 做出了这支片"**——轮数未记录，这句话无依据。`);
  } else if (brief.claims.humanRounds > 1) {
    out.push(`**"one prompt"**——实际是 ${brief.claims.humanRounds} 轮人类指令。`);
  }
  if (brief.claims.humanRevision) {
    out.push(`**"全自动、零修改"**——brief 已声明存在人工修改。`);
  }
  if (!brief.claims.zeroExternalAssets) {
    out.push(`**"零外部素材"**——brief 声明存在外部输入，详见 §3。`);
  }
  const nondet = log.facts.tools.filter((id) => findTool(id)?.byteReproducible === false);
  if (nondet.length > 0) {
    out.push(
      `**"逐字节可复现"**——${nondet.map((id) => `\`${id}\``).join('、')} 的输出不逐字节一致；` +
        `只能声称"相同音频输入下画面逐帧相同"。`,
    );
  }
  const allowedUnused = brief.tools.allowed.filter((id) => !log.facts.tools.includes(id));
  if (allowedUnused.length > 0) {
    out.push(
      `**把这些工具写成本片用过的工具**：${allowedUnused.map((id) => `\`${id}\``).join('、')} 只是提示词允许，本次并未调用。`,
    );
  }
  out.push(`**"零成本"**——本次未统计费用；订阅额度不等于零成本。`);
  return out;
}
