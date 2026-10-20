/** 外部后期登记：保留原始 run，通过文件身份绑定处理链与最终交付。 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { probeMedia, type MediaInfo } from '../ffmpeg/encoder.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import { sha256File, sha256Text } from '../utils/hash.ts';
import { collectSchemaErrors } from '../utils/json-schema.ts';
import { assertRecordedAttemptInputs, type AttemptInputSnapshot } from './attempt.ts';
import { assertRecordedAssetUsage } from '../adapters/asset-usage.ts';
import { loadBriefFile, validateBrief, type BriefAsset, type ResolvedBrief } from './brief.ts';
import { resolveInsideProject, type ProjectHandle } from './manifest.ts';
import { assertContained } from './paths.ts';
import { readRunLog, verifyRunLog, type RunLog } from './run-log.ts';
import { BRIEF_ASSET_SCHEMA, PROJECT_RELATIVE_PATH_PATTERN } from './schema.ts';
import { EXTERNAL_TOOL_SCHEMA, type ExternalTool } from './tool-registry.ts';

export const POSTPROCESS_FILE = 'evidence/postprocess.json';
interface FileRef { readonly path: string; readonly sha256: string }
export interface PostprocessRequest {
  readonly version: '0.1';
  /** 归档副本可仅复查现存原件；最终交付文件始终必需。 */
  readonly sourceVerification?: 'complete' | 'records-only';
  readonly evidence?: readonly FileRef[];
  readonly assets: readonly BriefAsset[];
  readonly tools: { readonly allowed: readonly string[]; readonly external?: readonly ExternalTool[] };
  readonly steps: readonly {
    readonly id: string; readonly description: string; readonly tools: readonly string[];
    readonly inputs: readonly FileRef[]; readonly output: FileRef;
  }[];
  readonly final: FileRef;
  /** 烧入像素的字幕由外部步骤声明；文件流信息单独实测。 */
  readonly captions: { readonly insideFrame: boolean; readonly cues: number; readonly wordLevel: boolean };
}
export interface PostprocessRecord extends PostprocessRequest {
  readonly run: { readonly runId: string; readonly sha256: string };
  readonly media: MediaInfo;
  readonly recordId: string;
  readonly unavailable: readonly string[];
}

const text = { type: 'string', minLength: 1 } as const;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const file = { type: 'object', additionalProperties: false, required: ['path', 'sha256'], properties: {
  path: { type: 'string', pattern: PROJECT_RELATIVE_PATH_PATTERN }, sha256: hash,
} } as const;
const tools = { type: 'array', minItems: 1, uniqueItems: true, items: text } as const;
const requestProperties = {
  version: { const: '0.1' }, assets: { type: 'array', maxItems: 50, items: BRIEF_ASSET_SCHEMA },
  sourceVerification: { enum: ['complete', 'records-only'] },
  evidence: { type: 'array', maxItems: 50, items: file },
  tools: { type: 'object', additionalProperties: false, required: ['allowed'], properties: {
    allowed: tools, external: { type: 'array', maxItems: 50, items: EXTERNAL_TOOL_SCHEMA },
  } },
  steps: { type: 'array', minItems: 1, maxItems: 100, items: {
    type: 'object', additionalProperties: false, required: ['id', 'description', 'tools', 'inputs', 'output'], properties: {
      id: text, description: { ...text, maxLength: 1000 }, tools,
      inputs: { type: 'array', minItems: 1, maxItems: 100, items: file }, output: file,
    },
  } },
  final: file,
  captions: { type: 'object', additionalProperties: false, required: ['insideFrame', 'cues', 'wordLevel'], properties: {
    insideFrame: { type: 'boolean' }, cues: { type: 'integer', minimum: 0 }, wordLevel: { type: 'boolean' },
  } },
} as const;
const required = ['version', 'assets', 'tools', 'steps', 'final', 'captions'];
export const POSTPROCESS_SCHEMAS = {
  request: { type: 'object', additionalProperties: false, required, properties: requestProperties },
  record: { type: 'object', additionalProperties: false, required: [...required, 'run', 'media', 'recordId', 'unavailable'], properties: {
    ...requestProperties, run: { type: 'object', additionalProperties: false, required: ['runId', 'sha256'], properties: { runId: text, sha256: hash } },
    // media 的每个字段在复查时与 ffprobe 的完整结果逐项比对。
    media: { type: 'object' }, recordId: hash, unavailable: { type: 'array', uniqueItems: true, items: text },
  } },
} as const;
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = { request: ajv.compile(POSTPROCESS_SCHEMAS.request), record: ajv.compile(POSTPROCESS_SCHEMAS.record) };
function validate<T>(kind: keyof typeof validators, value: unknown): T {
  const check = validators[kind];
  if (!check(value)) throw Error('POSTPROCESS_INVALID: ' + collectSchemaErrors(check, value).join('; '));
  return value as T;
}
function readJson(project: ProjectHandle, path: string): unknown {
  return JSON.parse(readFileSync(resolveInsideProject(project.dir, path, 'postprocess'), 'utf8'));
}

/** 补充登记沿用原 brief 的声称与禁止项；原 brief 字节和 run 保持绑定。 */
export function postprocessBrief(project: ProjectHandle, request: PostprocessRequest): ResolvedBrief {
  if (!project.briefPath) throw Error('POSTPROCESS_BRIEF_REQUIRED');
  const raw = loadBriefFile(project.briefPath) as Record<string, unknown>;
  const context = request.sourceVerification === 'records-only' ? {} : { projectDir: project.dir };
  const base = validateBrief(raw, context).brief;
  const assets = new Map(base.assets.map(a => [a.path, a]));
  const seen = new Set<string>();
  for (const asset of request.assets) {
    if (seen.has(asset.path)) throw Error('POSTPROCESS_ASSET_DUPLICATE: ' + asset.path);
    seen.add(asset.path);
    const previous = assets.get(asset.path);
    if (previous && (previous.kind !== asset.kind || previous.license !== asset.license ||
        previous.source && asset.source && previous.source !== asset.source || previous.sha256 && asset.sha256 && previous.sha256 !== asset.sha256)) throw Error('POSTPROCESS_ASSET_CONFLICT: ' + asset.path);
    const path = resolveInsideProject(project.dir, asset.path, 'postprocess asset');
    const sha256 = existsSync(path) ? sha256File(path) : context.projectDir ? sha256File(path) : asset.sha256 ?? previous?.sha256;
    if (!sha256) throw Error('POSTPROCESS_ASSET_HASH_REQUIRED: ' + asset.path);
    assets.set(asset.path, { ...asset, ...(previous ?? {}), sha256,
      ...(asset.provenance ? { provenance: { tools: [...new Set([...(previous?.provenance?.tools ?? []), ...asset.provenance.tools])] } } : {}) });
    if (asset.sha256 && asset.sha256 !== assets.get(asset.path)!.sha256) throw Error('POSTPROCESS_ASSET_HASH_MISMATCH: ' + asset.path);
  }
  return validateBrief({ ...raw, assets: [...assets.values()], tools: {
    ...base.tools, allowed: [...new Set([...base.tools.allowed, ...request.tools.allowed])],
    external: [...(base.tools.external ?? []), ...(request.tools.external ?? [])],
  } }, context).brief;
}

/** 归档复查始终核验 snapshot / receipt 和现存文件，缺失项逐项返回。 */
function recordedInputs(project: ProjectHandle, log: RunLog): string[] {
  if (!log.execution) return [];
  const execution = log.execution;
  const path = resolveInsideProject(project.dir, `runs/${execution.attemptId}/input-snapshot.json`, 'input snapshot');
  if (sha256File(path) !== execution.inputSnapshotSha256) throw Error('POSTPROCESS_SNAPSHOT_CHANGED');
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as AttemptInputSnapshot;
  if (snapshot.version !== '0.1' || snapshot.coverage !== 'partial' || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.assets)) throw Error('POSTPROCESS_SNAPSHOT_INVALID');
  const unavailable = new Set<string>();
  const check = (root: string, file: { path: string; sha256: string | null; bytes?: number | null }, history = false) => {
    const absolute = resolveInsideProject(root, file.path, 'recorded input');
    if (!existsSync(absolute)) { if (file.sha256) unavailable.add(relative(project.dir, absolute)); return; }
    if (history && file.sha256 === null) return;
    const info = lstatSync(absolute);
    const actual = history && file.bytes !== undefined && file.bytes !== null
      ? sha256Text(readFileSync(absolute).subarray(0, file.bytes).toString('utf8')) : sha256File(absolute);
    if (!info.isFile() || info.nlink !== 1 || actual !== file.sha256 || !history && file.bytes != null && info.size !== file.bytes) throw Error('POSTPROCESS_INPUT_CHANGED: ' + file.path);
  };
  const snapshotDir = join(dirname(path), 'snapshot', project.slug);
  for (const file of snapshot.files) {
    check(project.dir, file, file.path === 'prompt-history.jsonl'); check(snapshotDir, file);
  }
  for (const asset of snapshot.assets) check(project.dir, asset);
  assertRecordedAssetUsage(project.dir, snapshotDir, snapshot, log);
  return [...unavailable];
}

function verifyFiles(project: ProjectHandle, log: RunLog, request: PostprocessRequest, brief: ResolvedBrief): { media: MediaInfo; unavailable: string[] } {
  if (!request.captions.insideFrame && request.captions.cues !== 0) throw Error('POSTPROCESS_CAPTIONS_CONFLICT');
  const recordsOnly = request.sourceVerification === 'records-only';
  const unavailable = new Set(recordsOnly ? recordedInputs(project, log) : []);
  const check = (ref: FileRef, required = false): string => {
    const path = resolveInsideProject(project.dir, ref.path, 'postprocess file');
    if (relative(project.dir, path).split('\\').join('/') !== ref.path) throw Error('POSTPROCESS_PATH_CANONICAL: ' + ref.path);
    if (recordsOnly && !required && !existsSync(path)) { unavailable.add(ref.path); return path; }
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || sha256File(path) !== ref.sha256) throw Error('POSTPROCESS_FILE_MISMATCH: ' + ref.path);
    return path;
  };
  // 以已绑定的 spec 为锚点恢复相对路径，兼容固定 .engine 运行时及项目移根。
  const recordedSpec = resolve(PROJECT_ROOT, log.spec.path);
  const renderPath = assertContained(project.outDir, resolve(dirname(project.specPath),
    relative(dirname(recordedSpec), resolve(PROJECT_ROOT, log.measured.outputPath))));
  const render = { path: relative(project.dir, renderPath).split('\\').join('/'), sha256: log.measured.outputSha256 };
  for (const evidence of request.evidence ?? []) check(evidence, true);
  check(render);
  if (existsSync(renderPath) && lstatSync(renderPath).size !== log.measured.outputBytes) throw Error('POSTPROCESS_RENDER_SIZE_MISMATCH');
  // 输入必须来自已登记素材或先前输出，最终输出必须沿处理链连接到本次渲染。
  const known = new Map<string, { sha256: string; rendered: boolean }>([[render.path, { sha256: render.sha256, rendered: true }]]);
  for (const asset of brief.assets) {
    const path = resolveInsideProject(project.dir, asset.path, 'postprocess asset');
    const sha256 = existsSync(path) ? sha256File(path) : asset.sha256;
    if (!sha256) throw Error('POSTPROCESS_ASSET_HASH_REQUIRED: ' + asset.path);
    if (asset.sha256 && sha256 !== asset.sha256) throw Error('POSTPROCESS_ASSET_HASH_MISMATCH: ' + asset.path);
    if (known.has(asset.path)) throw Error('POSTPROCESS_ASSET_CONFLICT: ' + asset.path);
    check({ path: asset.path, sha256 }); known.set(asset.path, { sha256, rendered: false });
  }
  const ids = new Set<string>();
  for (const step of request.steps) {
    if (ids.has(step.id)) throw Error('POSTPROCESS_STEP_DUPLICATE: ' + step.id);
    ids.add(step.id);
    for (const id of step.tools) if (!brief.tools.allowed.includes(id) || brief.tools.forbidden.includes(id)) throw Error('POSTPROCESS_TOOL_UNDECLARED: ' + id);
    let rendered = false;
    for (const input of step.inputs) {
      check(input);
      const source = known.get(input.path);
      if (!source || source.sha256 !== input.sha256) throw Error('POSTPROCESS_CHAIN_INPUT: ' + input.path);
      rendered ||= source.rendered;
    }
    check(step.output);
    if (known.has(step.output.path)) throw Error('POSTPROCESS_OUTPUT_OVERWRITE: ' + step.output.path);
    known.set(step.output.path, { sha256: step.output.sha256, rendered });
  }
  const final = known.get(request.final.path);
  if (!final?.rendered || final.sha256 !== request.final.sha256 || request.final.path === render.path ||
      request.steps.at(-1)?.output.path !== request.final.path) throw Error('POSTPROCESS_CHAIN_FINAL');
  const path = assertContained(project.outDir, check(request.final, true));
  const media = probeMedia(path);
  if (!media.video || !Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) throw Error('POSTPROCESS_VIDEO_REQUIRED');
  check(request.final, true);
  return { media, unavailable: [...unavailable].sort() };
}

function currentRun(project: ProjectHandle, recordsOnly = false): RunLog {
  const log = readRunLog(join(project.dir, 'run.json'));
  const verified = verifyRunLog({ log, specSha256: sha256File(project.specPath), briefSha256: project.briefPath ? sha256File(project.briefPath) : null });
  if (!verified.ok) throw Error('POSTPROCESS_RUN_MISMATCH: ' + verified.reason);
  if (log.execution && !recordsOnly) assertRecordedAttemptInputs(project, log.execution, log);
  return log;
}
export function registerPostprocess(project: ProjectHandle, requestPath: string): PostprocessRecord {
  const request = validate<PostprocessRequest>('request', readJson(project, requestPath));
  const runPath = join(project.dir, 'run.json'), runSha256 = sha256File(runPath), log = currentRun(project, request.sourceVerification === 'records-only');
  const brief = postprocessBrief(project, request);
  const assets = request.assets.map(asset => ({ ...asset, sha256: brief.assets.find(a => a.path === asset.path)!.sha256! }));
  const payload = { ...request, assets, run: { runId: log.runId, sha256: runSha256 }, ...verifyFiles(project, log, request, brief) };
  if (sha256File(runPath) !== runSha256) throw Error('POSTPROCESS_RUN_CHANGED');
  const record = { ...payload, recordId: sha256Text(JSON.stringify(payload)) };
  const path = resolveInsideProject(project.dir, POSTPROCESS_FILE, 'postprocess record');
  mkdirSync(dirname(path), { recursive: true });
  const pending = path + '.' + randomUUID() + '.pending';
  try { writeFileSync(pending, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); renameSync(pending, path); }
  finally { rmSync(pending, { force: true }); }
  return record;
}
export function readPostprocess(project: ProjectHandle, log: RunLog, path = POSTPROCESS_FILE): PostprocessRecord | null {
  if (path === POSTPROCESS_FILE && !existsSync(join(project.dir, path))) return null;
  const record = validate<PostprocessRecord>('record', readJson(project, path));
  const { recordId, ...payload } = record;
  if (recordId !== sha256Text(JSON.stringify(payload))) throw Error('POSTPROCESS_RECORD_CHANGED');
  if (record.run.runId !== log.runId || record.run.sha256 !== sha256File(join(project.dir, 'run.json'))) throw Error('POSTPROCESS_RUN_MISMATCH');
  const verified = verifyFiles(project, currentRun(project, record.sourceVerification === 'records-only'), record, postprocessBrief(project, record));
  if (JSON.stringify(verified.media) !== JSON.stringify(record.media)) throw Error('POSTPROCESS_MEDIA_MISMATCH');
  if (JSON.stringify(verified.unavailable) !== JSON.stringify(record.unavailable)) throw Error('POSTPROCESS_AVAILABILITY_CHANGED: 重新登记现存原件范围');
  return record;
}
