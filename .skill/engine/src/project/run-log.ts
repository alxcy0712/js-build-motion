/**
 * 渲染实测遥测（task-5）。
 *
 * `run.json` 记录本次渲染的可核对事实，包括实际输入、工具、源码与产物。
 * 实测记录支持制作声明和运行证据逐项对账。
 *
 * 硬性结构：**两段分离**
 *
 *   facts     确定性。同输入两次渲染必须逐字节相同，参与声明对账。
 *   measured  非确定性。耗时、体积、产物哈希。只作参考，**不参与对账**。
 *
 * 这条分界如果被破坏（例如把耗时写进 facts），`run.json` 就再也回答不了
 * 「这次和上次是不是同一条产线」——而那正是它唯一的价值。
 *
 * 另外：`runId` 由 `facts` + spec/brief 哈希推导，因此**手改 facts 会让 runId 对不上**。
 * 这把「证据文件不会被悄悄修改」从承诺变成了可校验的性质（见 `verifyRunLog`）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { sha256File, sha256Text, shortHash } from '../utils/hash.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import type { BriefAsset } from './brief.ts';
import { findTool } from './tool-registry.ts';
import type { SourceHash } from './drawing.ts';
import type { PromptHistorySnapshot } from './prompt-history.ts';
import { validateAssetUsage, type AssetUsage } from './asset-plan.ts';

export const RUN_LOG_VERSION = '0.1';
export const RUN_LOG_FILE = 'run.json';

// ---------------------------------------------------------------- 类型

export interface RunLogFacts {
  readonly promptHistory?: PromptHistorySnapshot;
  readonly drawing?: { readonly entry: string; readonly sources: readonly SourceHash[] };
  readonly runtime?: { readonly packageId: string; readonly platform: string; readonly arch: string };
  readonly audioReuse?: {
    readonly lockPath: string;
    readonly lockSha256: string;
    readonly sourceProviders: { readonly tts: string; readonly bgm: string; readonly sfx: string };
  };
  readonly video: {
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly duration: number;
    readonly frames: number;
    readonly seed: number;
  };
  readonly renderer: {
    readonly kind: string;
    /** 映射到的工具注册表 id；映射不到时为 null，并出现在 unmapped 里 */
    readonly toolId: string | null;
    readonly package: string;
    readonly version: string | null;
  };
  readonly encoder: {
    readonly video: string;
    readonly pixelFormat: string;
    readonly audio: string | null;
    readonly crf: number | null;
    readonly preset: string | null;
  };
  readonly ffmpeg: { readonly version: string | null; readonly command: string };
  readonly providers: { readonly tts: string; readonly bgm: string; readonly sfx: string };
  /** 本次实际使用的工具（注册表 id），已排序 */
  readonly tools: readonly string[];
  /** 有观测但映射不到注册表的 id。非空意味着 registry 需要补条目 */
  readonly unmappedTools: readonly string[];
  /** tools 的子集：依赖网络/外部服务的工具 */
  readonly network: readonly string[];
  readonly assets: {
    readonly usage?: Omit<AssetUsage, 'attemptId' | 'inputSnapshotSha256'>;
    /**
     * brief 声明并逐个核验过哈希的外部素材（证据：输入边界）。
     * 它们是**输入**，同输入两次渲染必须一致，所以属于 facts。
     */
    readonly external: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly kind: string;
      readonly license: string;
    }[];
    /** 本次**实测被读取**的素材。声明了但没读到的会在对账时被标出来 */
    readonly consumed: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly role: string;
    }[];
  };
  readonly fonts: readonly {
    readonly family: string;
    readonly path: string;
    readonly sha256: string;
    readonly registered: boolean;
  }[];
  readonly captions: {
    readonly insideFrame: boolean;
    readonly cues: number;
    readonly wordLevel: boolean;
  };
}

export interface RunLogMeasured {
  readonly renderMs: number;
  readonly msPerFrame: number;
  readonly encodeTailMs: number;
  readonly audioMixMs: number | null;
  readonly outputBytes: number;
  readonly outputSha256: string;
  /**
   * 成片路径（仓库相对）。
   *
   * 必须记：`--out` 可以把产物放到任何地方，而遥测描述的是**那一份**产物。
   * 不记路径的话，`run.json` 里的体积与哈希就不知道指向谁，证据链断在这里。
   */
  readonly outputPath: string;
  /**
   * 音频中间产物（配音/配乐/音效/混音成品）的哈希。
   *
   * 它们在 `measured` 而不是 `facts`，这是刻意的：这些是**产物**，不是配置。
   * `edge-tts` 这类网络 TTS 的输出本就不逐字节可复现，
   * 一旦把它们放进 facts，`run.json` 就再也无法回答"这次和上次是不是同一条产线"——
   * 而那正是 facts 段唯一的价值。
   */
  readonly audioArtifacts: readonly {
    readonly role: string;
    readonly path: string;
    readonly sha256: string;
  }[];
  /**
   * 产物标识：由产物哈希推导，可从文件自身重算。
   * runId 管"配置未被篡改"，artifactId 管"产物记录未被篡改"。
   */
  readonly artifactId: string;
}

export interface RunLog {
  readonly version: string;
  /** 由 facts + spec/brief 哈希推导，可校验未被篡改 */
  readonly runId: string;
  readonly project: string | null;
  readonly spec: { readonly path: string; readonly sha256: string };
  readonly brief: { readonly path: string; readonly sha256: string } | null;
  readonly facts: RunLogFacts;
  readonly measured: RunLogMeasured;
  readonly execution?: {
    readonly attemptId: string;
    readonly inputSnapshotSha256: string;
    readonly coverage: 'partial';
    readonly assetUsage?: { readonly path: string; readonly bytes: number; readonly sha256: string };
  };
}

// ---------------------------------------------------------------- 输入

export interface FactsInput {
  readonly assetUsage?: AssetUsage;
  readonly promptHistory?: PromptHistorySnapshot;
  readonly drawing?: RunLogFacts['drawing'];
  readonly runtime?: RunLogFacts['runtime'];
  readonly audioReuse?: RunLogFacts['audioReuse'];
  readonly video: RunLogFacts['video'];
  readonly rendererKind: string;
  readonly rendererPackage: string;
  readonly rendererVersion: string | null;
  readonly encoder: RunLogFacts['encoder'];
  readonly ffmpeg: RunLogFacts['ffmpeg'];
  readonly providers: RunLogFacts['providers'];
  /** brief 里声明的外部素材（用于核验哈希与授权） */
  readonly declaredAssets?: readonly BriefAsset[];
  /** 项目目录：把素材路径解析成绝对路径；为 null 时只记录路径不算哈希 */
  readonly projectDir?: string | null;
  /** 实测被管线读取的素材（例如 file BGM provider 解析出的音频） */
  readonly consumedAssets?: readonly {
    readonly path: string;
    readonly absPath: string;
    readonly role: string;
    readonly sha256?: string;
  }[];
  /** 音频中间产物（产物，不是配置；进入 measured 段） */
  readonly audioArtifacts?: readonly { readonly role: string; readonly absPath: string }[];
  readonly fonts?: readonly {
    readonly family: string;
    readonly absPath: string;
    readonly registered: boolean;
  }[];
  readonly captions: RunLogFacts['captions'];
}

/** renderer kind → 工具注册表 id。表里没有的 kind 会被记进 unmappedTools */
const RENDERER_TOOL: Record<string, string> = {
  skia: 'skia-canvas',
};

/** provider id → 工具注册表 id（`(none)` 等非工具值不在其中） */
const PROVIDER_TOOL: Record<string, string> = {
  edge: 'edge-tts',
  'edge-tts': 'edge-tts',
  doubao: 'doubao-tts',
  procedural: 'procedural',
  file: 'file',
};

/**
 * provider id 到工具 id 的映射。
 *
 * `procedural` 同时对应配乐与音效两个工具，所以要结合 role 判断；
 * `file` 表示"用户提供的授权素材"，它不是一个工具，因此不映射。
 */
function providerToolId(role: 'tts' | 'bgm' | 'sfx', provider: string): string | null {
  if (provider === '(none)' || provider === 'none' || provider === 'file') return null;
  if (role === 'tts') return PROVIDER_TOOL[provider] ?? null;
  if (provider === 'procedural') return role === 'bgm' ? 'procedural-bgm' : 'procedural-sfx';
  if (provider === 'file') return null;
  return PROVIDER_TOOL[provider] ?? null;
}

// ---------------------------------------------------------------- 构建

export function buildFacts(input: FactsInput): RunLogFacts {
  const tools = new Set<string>();
  const unmapped = new Set<string>();

  const rendererToolId = RENDERER_TOOL[input.rendererKind] ?? null;
  if (rendererToolId) tools.add(rendererToolId);
  else unmapped.add(`renderer:${input.rendererKind}`);

  for (const [role, provider] of [
    ['tts', input.providers.tts],
    ['bgm', input.providers.bgm],
    ['sfx', input.providers.sfx],
  ] as const) {
    const id = providerToolId(role, provider);
    if (id) tools.add(id);
    else if (provider !== '(none)' && provider !== 'none' && provider !== 'file') {
      unmapped.add(`${role}:${provider}`);
    }
  }

  // ffmpeg / ffprobe 在渲染与产物校验里都被调用过，属于事实而非推断
  tools.add('ffmpeg');
  tools.add('ffprobe');

  const declared = input.declaredAssets ?? [];
  const assets = declared
    .map((a) => {
      const abs = input.projectDir ? join(input.projectDir, a.path) : null;
      const sha = a.sha256 ?? (abs && existsSync(abs) ? sha256File(abs) : null);
      return {
        path: a.path,
        sha256: sha ?? '',
        kind: a.kind,
        license: a.license,
      };
    })
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  // 只有**真的被读过**的素材才进 consumed。
  // 这条分界很重要：把"声明过"当成"用过"，就等于让 run.json 自己制造证据。
  const consumed = (input.consumedAssets ?? [])
    .map((a) => {
      if (!existsSync(a.absPath)) throw Error('ASSET_CONSUMED_FILE_MISSING: ' + a.path);
      const actual = sha256File(a.absPath);
      if (a.sha256 && a.sha256 !== actual) throw Error('ASSET_CONSUMED_FILE_CHANGED: ' + a.path);
      return { path: a.path, sha256: a.sha256 ?? actual, role: a.role };
    })
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const fonts = (input.fonts ?? [])
    .filter((f) => existsSync(f.absPath))
    .map((f) => ({
      family: f.family,
      path: repoRelative(f.absPath),
      sha256: sha256File(f.absPath),
      registered: f.registered,
    }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const sortedTools = [...tools].sort();
  const network = sortedTools.filter((id) => findTool(id)?.network === true);

  return {
    ...(input.promptHistory ? { promptHistory: input.promptHistory } : {}),
    ...(input.drawing ? { drawing: input.drawing } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.audioReuse ? { audioReuse: input.audioReuse } : {}),
    video: input.video,
    renderer: {
      kind: input.rendererKind,
      toolId: rendererToolId,
      package: input.rendererPackage,
      version: input.rendererVersion,
    },
    encoder: input.encoder,
    ffmpeg: input.ffmpeg,
    providers: input.providers,
    tools: sortedTools,
    unmappedTools: [...unmapped].sort(),
    network,
    assets: { external: assets, consumed, ...(input.assetUsage ? { usage: (() => {
      const { attemptId, inputSnapshotSha256, ...facts } = validateAssetUsage(input.assetUsage); return facts;
    })() } : {}) },
    fonts,
    captions: input.captions,
  };
}

/** 构建 measured 段：把产物哈希收拢在一处，并算出可重算的 artifactId */
export function buildMeasured(input: {
  readonly renderMs: number;
  readonly msPerFrame: number;
  readonly encodeTailMs: number;
  readonly audioMixMs: number | null;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly outputPath: string;
  readonly audioArtifacts?: readonly { readonly role: string; readonly path: string; readonly sha256: string }[];
}): RunLogMeasured {
  const audioArtifacts = [...(input.audioArtifacts ?? [])].sort((x, y) =>
    x.path < y.path ? -1 : x.path > y.path ? 1 : 0,
  );
  return {
    renderMs: input.renderMs,
    msPerFrame: input.msPerFrame,
    encodeTailMs: input.encodeTailMs,
    audioMixMs: input.audioMixMs,
    outputBytes: input.outputBytes,
    outputSha256: input.outputSha256,
    outputPath: input.outputPath,
    audioArtifacts,
    artifactId: computeArtifactId({ outputSha256: input.outputSha256, audioArtifacts }),
  };
}

/**
 * 产物标识：只覆盖**产物哈希**，不覆盖耗时。
 * 这样它既能在两次渲染间不同（产物确实不同也算事实），
 * 又能在读取时从文件自身重算出来，用于发现手改。
 */
export function computeArtifactId(input: {
  readonly outputSha256: string;
  readonly audioArtifacts: readonly { readonly role: string; readonly path: string; readonly sha256: string }[];
}): string {
  return shortHash(
    sha256Text(
      stableStringify({
        outputSha256: input.outputSha256,
        audio: input.audioArtifacts.map((a) => ({ path: a.path, sha256: a.sha256 })),
      }),
    ),
    16,
  );
}

/** 汇总音频产物哈希（辅助：把 CLI 枚举到的文件变成 measured 需要的形状） */
export function audioArtifactHashes(
  files: readonly { readonly role: string; readonly absPath: string }[],
): { role: string; path: string; sha256: string }[] {
  return files
    .filter((f) => existsSync(f.absPath))
    .map((f) => ({ role: f.role, path: repoRelative(f.absPath), sha256: sha256File(f.absPath) }))
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

export interface RunLogInput {
  readonly project: string | null;
  readonly specPath: string;
  readonly specSha256: string;
  readonly briefPath: string | null;
  readonly briefSha256: string | null;
  readonly facts: RunLogFacts;
  readonly measured: RunLogMeasured;
  readonly execution?: RunLog['execution'];
}

export function buildRunLog(input: RunLogInput): RunLog {
  const brief =
    input.briefPath && input.briefSha256
      ? { path: repoRelative(input.briefPath), sha256: input.briefSha256 }
      : null;

  return {
    version: RUN_LOG_VERSION,
    runId: computeRunId(input.specSha256, brief?.sha256 ?? null, input.facts),
    project: input.project,
    spec: { path: repoRelative(input.specPath), sha256: input.specSha256 },
    brief,
    facts: input.facts,
    measured: input.measured,
    ...(input.execution ? { execution: input.execution } : {}),
  };
}

/**
 * runId 的推导规则。
 *
 * 刻意**不含** measured 与产物哈希：产物哈希受外部 TTS 等非确定性环节影响，
 * 一旦纳入，runId 就无法用来回答"这是不是同一次产线配置"。
 */
export function computeRunId(
  specSha256: string,
  briefSha256: string | null,
  facts: RunLogFacts,
): string {
  return shortHash(
    sha256Text(`${specSha256}|${briefSha256 ?? '-'}|${stableStringify(facts)}`),
    16,
  );
}

/** 键顺序固定的 JSON 序列化：对象键排序，确保跨进程逐字节一致 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

// ---------------------------------------------------------------- 读写

/**
 * run.json 的落点。
 *
 * 项目渲染 → 项目根目录：这个路径是**稳定且可提交的**（`projects/<slug>/out/` 在 gitignore 里），
 * 所以克隆仓库后 `disclosure` 仍能拿到当时的实测记录。
 * 裸 spec 渲染 → 产物旁边：遥测描述的是那一份产物，让它跟着产物走，
 * 也不往 spec 所在目录里塞文件。
 */
export function runLogPathFor(outPath: string, projectDir: string | null): string {
  return projectDir ? join(projectDir, RUN_LOG_FILE) : join(dirname(outPath), RUN_LOG_FILE);
}

export function writeRunLog(path: string, log: RunLog): void {
  writeFileSync(path, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

export function readRunLog(path: string): RunLog {
  if (!existsSync(path)) {
    throw new EngineError(ERROR_CODES.RUN_LOG_MISSING, `找不到渲染实测记录 run.json`, {
      details: { expected: path },
      hint: '先跑 `node .skill/engine/src/cli/index.ts render <项目或 spec>`，run.json 由渲染时写出',
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new EngineError(ERROR_CODES.RUN_LOG_MISSING, `run.json 不是合法 JSON`, {
      details: { path },
      cause: err,
    });
  }
  const log = raw as RunLog;
  if (typeof log.runId !== 'string' || typeof log.facts !== 'object' || log.facts === null) {
    throw new EngineError(ERROR_CODES.RUN_LOG_MISSING, `run.json 结构不完整`, {
      details: { path, keys: Object.keys(raw as object) },
      hint: 'run.json 由引擎生成，不要手写；重新渲染即可',
    });
  }
  return log;
}

/**
 * 校验 run.json 未被篡改：重算 runId 并与文件里的比对。
 *
 * 这是「证据文件可信」的最低成本保证：改了 facts 里的任何一个字段
 * （哪怕只是把 tools 里少写一个），runId 就对不上。
 */
export function verifyRunLog(input: {
  readonly log: RunLog;
  readonly specSha256: string | null;
  readonly briefSha256: string | null;
}): { ok: boolean; reason: string | null } {
  const execution = input.log.execution;
  if (input.log.facts.assets.usage) {
    try {
      if (!execution?.assetUsage || !/^runs\/[a-f0-9-]{36}\/asset-usage\.json$/.test(execution.assetUsage.path) ||
          !Number.isSafeInteger(execution.assetUsage.bytes) || execution.assetUsage.bytes < 1 || !/^[a-f0-9]{64}$/.test(execution.assetUsage.sha256)) throw Error('usage identity');
      validateAssetUsage({ ...input.log.facts.assets.usage, attemptId: execution.attemptId, inputSnapshotSha256: execution.inputSnapshotSha256 });
    } catch { return { ok: false, reason: '素材消费记录与执行身份无效；需要重新渲染' }; }
  } else if (execution?.assetUsage) return { ok: false, reason: '素材消费 facts 缺失' };
  if (execution && (typeof execution.attemptId !== 'string' || !execution.attemptId ||
    !/^[a-f0-9]{64}$/.test(execution.inputSnapshotSha256) || execution.coverage !== 'partial')) {
    return { ok: false, reason: '执行快照记录无效；需要重新渲染' };
  }
  if (input.specSha256 !== null && input.specSha256 !== input.log.spec.sha256) {
    return {
      ok: false,
      reason: `spec 已被修改（run.json 记录 ${input.log.spec.sha256.slice(0, 12)}…，当前 ${input.specSha256.slice(0, 12)}…）；需要重新渲染`,
    };
  }
  if (input.briefSha256 !== null && input.log.brief && input.briefSha256 !== input.log.brief.sha256) {
    return {
      ok: false,
      reason: `brief 已被修改（run.json 记录 ${input.log.brief.sha256.slice(0, 12)}…，当前 ${input.briefSha256.slice(0, 12)}…）；需要重新渲染`,
    };
  }
  const expected = computeRunId(input.log.spec.sha256, input.log.brief?.sha256 ?? null, input.log.facts);
  if (expected !== input.log.runId) {
    return { ok: false, reason: `facts 段被修改过（runId 应为 ${expected}，文件里是 ${input.log.runId}）` };
  }
  const measured = input.log.measured;
  if (measured && typeof measured.artifactId === 'string') {
    const expectedArtifact = computeArtifactId({
      outputSha256: measured.outputSha256,
      audioArtifacts: measured.audioArtifacts ?? [],
    });
    if (expectedArtifact !== measured.artifactId) {
      return {
        ok: false,
        reason: `产物记录被修改过（artifactId 应为 ${expectedArtifact}，文件里是 ${measured.artifactId}）`,
      };
    }
  }
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------- 路径

/** 仓库相对路径：让 run.json 可提交、可跨机器阅读，不写绝对路径 */
export function repoRelative(absPath: string): string {
  const rel = relative(PROJECT_ROOT, absPath);
  return rel.split(sep).join('/');
}
