#!/usr/bin/env node
import { capabilities, cmdDirect, cmdPrompt, cmdQuality, assertDirectorCurrent } from './director.ts';
import { assertProductionCurrent, productionMediaPaths } from '../application/production-compilation.ts';
import { buildProductionAudio } from '../audio/production.ts';
import { createProductionDrawing } from '../pipeline/production-drawing.ts';
import { cmdProduction } from './production.ts';
import { cmdDelivery } from './delivery.ts';
import { assertContained } from '../project/paths.ts';
import { inspectQuality } from '../project/quality.ts';
import { inspectArtifact } from '../project/artifact.ts';
import { cmdDiagnose } from './diagnostics.ts';
/**
 * CLI 入口（需求 §41）。
 *
 * 刻意不引入 commander / yargs：
 * Node 内置的 `node:util` parseArgs 对 5 个子命令 + 少量 flag 完全够用，
 * 而依赖策略（§46）要求不为已有能力装库。见 .skill/references/maintenance.md。
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import {
  PROJECT_ROOT,
  checkEnvironment,
  dependencyVersion,
  listProjectFontFiles,
  resolveFontFamily,
} from '../utils/env.ts';import { sha256File } from '../utils/hash.ts';
import { frameCount, secondsToFrame } from '../timeline/frame.ts';
import { makeFrameContext } from '../renderer/renderer.ts';
import { createSpecRenderer } from '../pipeline/spec-renderer.ts';
import { loadProjectDrawing, projectSourceHashes } from '../project/drawing.ts';
import { promptHistorySnapshot } from '../project/prompt-history.ts';
import { importOriginals, ImportFailure, verifyImport } from '../application/import.ts';
import { IMPORT_MANIFEST_SCHEMA, IMPORT_RECEIPT_SCHEMA, IMPORT_POLICY_SCHEMA } from '../project/import.ts';
import { unpackOriginal, UnpackFailure, verifyUnpack } from '../application/unpack.ts';
import { UNPACK_MANIFEST_SCHEMA, UNPACK_RECEIPT_SCHEMA, UNPACK_POLICY_SCHEMA, UNPACK_INDEX_SCHEMA } from '../project/unpack.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../application/catalog.ts';
import { CATALOG_SCHEMAS } from '../project/catalog.ts';
import { alignAsset, verifyAlignment, recoverAlignmentAttempts, AlignmentFailure } from '../application/alignment.ts';
import { ALIGNMENT_SCHEMAS } from '../project/alignment.ts';
import { DEFAULT_ASSET_PLAN_PATH, prepareAssetPlan, assertAssetPlanSnapshot } from '../application/asset-plan.ts';
import { createAssetPort } from '../adapters/asset-port.ts';
import { ASSET_PLAN_SCHEMAS } from '../project/asset-plan.ts';
import { prepareVideo, verifyVideoPreparation, recoverVideoAttempts } from '../application/video.ts';
import { VIDEO_PREPARATION_SCHEMAS } from '../project/video-preparation.ts';
import type { Issue } from '../spec/repair.ts';
import { loadSpecFile, summarizeIssues, validateSpec } from '../spec/validate.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { buildCaptionTrack, type MeasuredNarration } from '../captions/track.ts';
import { toSrt, toVtt } from '../captions/export.ts';
import { probeMedia, verifyDecodable } from '../ffmpeg/encoder.ts';
import type { VideoEncoderId } from '../ffmpeg/capabilities.ts';
import { renderVideo } from '../pipeline/render-video.ts';
import { buildAudio } from '../audio/build.ts';
import { createAudioLock, loadAudioLock } from '../audio/lock.ts';
import type { TtsProviderId } from '../audio/tts/index.ts';
import { DOUBAO_VOICES } from '../audio/tts/doubao-voices.ts';
import { beginRenderAttempt, loadAttemptDrawing, commitRenderAttempt, failRenderAttempt, type RenderAttempt } from '../project/attempt.ts';
import { readNarrationTimings, verifyVoicePresence } from '../audio/verify.ts';
import type { AudioTrack } from '../audio/types.ts';
import {
  PROJECTS_DIR,
  listProjectSlugs,
  listProjectDirectories,
  loadProject,
  projectDir,
  readProjectManifest,
  resolveInsideProject,
  resolveTarget,
  type ProjectHandle,
  type ResolvedTarget,
} from '../project/manifest.ts';
import {
  briefErrorFromIssues,
  checkBrief,
  loadBriefFile,
  validateBrief,
  type BriefAsset,
} from '../project/brief.ts';
import { listArchetypes } from '../project/archetypes.ts';
import { initProject } from '../project/scaffold.ts';
import {
  auditProjectIsolation,
  describeViolation,
  type IsolationViolation,
} from '../project/isolation.ts';
import { buildDisclosure, writeDisclosure, DISCLOSURE_FILE } from '../project/disclosure.ts';
import {
  RUN_LOG_FILE,
  audioArtifactHashes,
  buildFacts,
  buildMeasured,
  buildRunLog,
  repoRelative,
  runLogPathFor,
  writeRunLog,
} from '../project/run-log.ts';

const COMMANDS = [
  'env',
  'capabilities',
  'voices',
  'direct',
  'prompt',
  'import',
  'unpack',
  'catalog',
  'align',
  'assets',
  'video',
  'production',
  'review',
  'credits',
  'deliver',
  'qa',
  'diagnose',
  'validate',
  'frame',
  'storyboard',
  'render',
  'audio',
  'subtitles',
  'project',
  'brief',
  'disclosure',
  'artifact',
] as const;
type CommandName = (typeof COMMANDS)[number];

const USAGE = `js-build-motion —— 模型无关的程序化视频引擎

用法:
  video <command> [options]

引擎命令:
  capabilities [--schema]        已实现能力 / 导演计划 schema
  voices                        公版配音音色目录（名称、ID、语种、模型及接口）
  direct start <slug> --idea "…" 保存想法，agent 填写导演计划
  direct compile <slug>          导演计划 → VideoSpec + brief
  production <slug> init|next|apply|compile|resume|invalidate|view [options] 权威计划与恢复
  review <slug> --subject | --request <本片 JSON> 核对完整观测、当前编码与审片结论
  credits <slug> --subject | --request <本片 JSON> 核对本地交付权利与逐源署名
  deliver <slug> --request <本片 JSON> | --verify <deliveryId|current> 保存并复查本地交付包
    --schema file|subject|review|credits|request|manifest 输出审片与交付契约
  prompt <slug> [--kind … --text …|--file …] 查看或追加原始 prompt、问题与答案
  unpack <slug> --import <importId> --path <归档相对路径>  显式展开本片已入库 ZIP
    --verify <unpackId>           复查已提交展开版本
    --schema manifest|receipt|policy|index  输出展开契约
  import <slug> --source <路径>    将选定文件或目录复制为本片独立原件并输出回执
    --verify <importId>           校验已提交批次的清单与原件
    --schema manifest|receipt|policy 输出导入契约
  assets <slug> [--plan assets/asset-plan.json] 核对素材需求、版本绑定与待审缺口
    --schema plan|usage           输出素材计划或消费回执契约
  video <slug> --request <本片 JSON> 准备选定整数 PTS 区间的固定帧与静音代理
    --verify <map 路径> | --recover  复查成功发布或恢复已退出的准备
    --schema request|map|limits|receipt|publication 输出视频准备契约
  audio <slug>                   先制作配音与混音，检查逐句时长和信号完整性
  audio lock <slug>              制作并保存可复用的定稿声音包
  qa <slug>                     结构质量与导演计划新鲜度检查
  diagnose <slug> --from 0 --to 2 连续编码帧、运动热图与源文字边界复核线索
  env                            检查运行环境（Node / FFmpeg / 字体 / 输出目录）
  validate <spec.json|项目>      校验 VideoSpec 并报告自动修复内容
  frame <spec.json|项目>         渲染单帧为 PNG（调试用，不是正式管线）
  storyboard <spec.json|项目>   按场景抽取关键帧生成 contact sheet
  render <spec.json|项目>        渲染完整视频（并写出 run.json 实测遥测）
    --asset-plan <本片计划>       冻结素材绑定；默认读取 assets/asset-plan.json
    --audio-lock <本片锁路径>     复用声音，校验内容、排布与实际文件
    --tts-provider file --no-network  使用本片预制配音进行离线制作
  subtitles <spec.json|项目>     导出外挂字幕 .srt / .vtt

项目层命令:
  project list                   列出全部项目与状态
  project init <slug>            新建项目骨架（不覆盖已有目录）
  project archetypes             列出提示词原型库
  project audit <slug|--all>     审计项目隔离（输入是否越界引用别的项目/产物）
  brief validate <项目|json>     校验提示词契约（brief.json）
  disclosure <项目>              声明—实测对账，生成 DISCLOSURE.md
  artifact <项目> [--out evidence/artifact.json] [--review evidence/artifact.json]
                                 核对实际成片、渲染输入与审片身份快照

通用选项:
  -h, --help                     显示帮助
  -v, --verbose                  输出详细日志

示例:
  node .skill/engine/src/cli/index.ts env
  node .skill/engine/src/cli/index.ts project list
  node .skill/engine/src/cli/index.ts project init my-film --title "我的片子"
  node .skill/engine/src/cli/index.ts project audit my-film
  node .skill/engine/src/cli/index.ts validate my-film
  node .skill/engine/src/cli/index.ts brief validate my-film
  node .skill/engine/src/cli/index.ts render my-film
  node .skill/engine/src/cli/index.ts disclosure my-film
  node .skill/engine/src/cli/index.ts render .research/out/probe.json   # 非项目 spec：产物落 .research/out/
`;

function printHelp(): void {
  process.stdout.write(USAGE);
}

// ---------------------------------------------------------------- env

function cmdEnv(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false }, 'out-dir': { type: 'string' } },
    allowPositionals: true,
  });
  const report = checkEnvironment({ checkOutput: true, ...(values['out-dir'] ? { outDir: values['out-dir'] } : {}) });

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }

  const mark = (b: boolean): string => (b ? '\u2713' : '\u2717');
  const line = (label: string, value: string): string => `  ${label.padEnd(22)} ${value}`;
  const out: string[] = ['环境报告', ''];

  out.push(line('Node', `${report.node.version} ${mark(report.node.supported)} (需要 ${report.node.required})`));
  out.push(line('ffmpeg', report.ffmpeg.available ? `${report.ffmpeg.version} ${mark(true)}` : `未找到 ${mark(false)}`));
  out.push(line('ffprobe', report.ffprobe.available ? `${report.ffprobe.version} ${mark(true)}` : `未找到 ${mark(false)}`));

  if (report.ffmpeg.available) {
    const enc = Object.entries(report.ffmpeg.encoders).map(([k, v]) => `${k}${mark(v)}`).join('  ');
    out.push(line('视频编码器', enc));
    const missing = Object.entries(report.ffmpeg.audioFilters).filter(([, v]) => !v).map(([k]) => k);
    out.push(line('音频滤镜', missing.length === 0 ? `全部就绪 ${mark(true)}` : `缺失: ${missing.join(', ')} ${mark(false)}`));
  }

  const f = report.fonts;
  out.push(line('项目字体', `${f.family}`));
  out.push(line('  字体文件', f.fileExists ? `${f.filePath} ${mark(true)}` : `缺失 ${mark(false)}`));
  out.push(line('  注册状态', f.registered ? `已注册 ${mark(true)}` : `未注册 ${mark(false)}`));
  out.push(line('  实际使用', resolveFontFamily(f.registered)));
  const extra = listProjectFontFiles();
  if (extra.length) out.push(line('  assets/fonts', extra.join(', ')));

  // 语音链路：新用户最容易被它坑——缺 python/edge-tts 时渲染"成功"但没真人配音
  const t = report.tts;
  const ttsMark = t.effective === 'edge' ? mark(true) : t.effective === 'file' ? '~' : '!';
  out.push(line('语音 provider', `${t.effective} ${ttsMark}`));
  out.push(
    line(
      '  edge-tts',
      t.edge.available ? `可用（${t.edge.python}）${mark(true)}` : `不可用：${t.edge.reason ?? '未知'} ${mark(false)}`,
    ),
  );
  out.push(line('  预制配音', t.voiceAsset.exists ? `存在 ${mark(true)}` : '不存在（file provider 不可用）'));
  if (t.effective !== 'edge') out.push(line('  修复建议', t.fixHint));

  out.push(line('非项目产物目录', `${report.paths.outDir} ${mark(report.paths.outWritable)}`));

  if (report.warnings.length) {
    out.push('', '警告:');
    for (const w of report.warnings) out.push(`  ! ${w}`);
  }
  if (report.errors.length) {
    out.push('', '错误:');
    for (const e of report.errors) out.push(`  \u2717 ${e}`);
  }

  out.push('', report.ok ? '环境检查通过。' : '环境检查未通过。');
  process.stdout.write(out.join('\n') + '\n');
  return report.ok ? 0 : 1;
}

// ------------------------------------------------------- 尚未实现的命令

async function cmdValidate(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const { specPath } = resolveTarget(requireTarget(positionals, 'validate'));
  const raw = loadSpecFile(specPath);

  if (values.json) {
    try {
      const outcome = validateSpec(raw);
      process.stdout.write(JSON.stringify(serializeOutcome(specPath, outcome), null, 2) + '\n');
      return outcome.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof EngineError) {
        process.stdout.write(
          JSON.stringify(
            { ok: false, spec: specPath, code: err.code, message: err.message, ...err.toJSON() },
            null,
            2,
          ) + '\n',
        );
        return 1;
      }
      throw err;
    }
  }

  process.stdout.write(`校验 ${specPath}\n\n`);

  let outcome;
  try {
    outcome = validateSpec(raw);
  } catch (err) {
    if (err instanceof EngineError) {
      process.stdout.write(err.toLLMString() + '\n');
      return 1;
    }
    throw err;
  }

  printIssues(outcome.issues);

  const spec = outcome.spec;
  if (!spec) return 1;
  const frames = frameCount(spec.video.fps, spec.video.duration);
  const { width, height, fps, duration, seed } = spec.video;
  process.stdout.write(
    [
      `可渲染  ${width}x${height} @${fps}fps  ${duration}s (${frames} 帧)  seed=${seed}`,
      `        ${spec.scenes.length} 个场景  ${spec.characters.length} 个人物  ` +
        `${spec.audio.narration.length} 条旁白  ${spec.audio.sfx.length} 个音效`,
      `        风格 ${spec.style.preset} / ${spec.style.palette} / ${spec.style.paper} / ${spec.style.line}`,
      `        字幕 ${spec.captions.enabled ? `开（${spec.captions.style}, ${spec.captions.mode}）` : '关'}`,
      `\n${summarizeIssues(outcome.issues)}`,
    ].join('\n') + '\n',
  );
  return 0;
}

function serializeOutcome(specPath: string, outcome: ReturnType<typeof validateSpec>): unknown {
  return {
    ok: outcome.ok,
    spec: specPath,
    counts: outcome.counts,
    schemaErrors: outcome.schemaErrors,
    issues: outcome.issues,
    resolved: outcome.spec,
  };
}

/** 按严重度分组打印，并按「是否可自动修复」排序，让弱模型先看到能自己改的那批 */
function printIssues(issues: readonly Issue[]): void {
  if (issues.length === 0) {
    process.stdout.write('Schema 校验通过，无需修复。\n\n');
    return;
  }

  const groups: ReadonlyArray<readonly [string, string]> = [
    ['FATAL', '致命（必须修）'],
    ['WARNING', '警告（已降级处理，建议确认）'],
    ['SAFE_REPAIR', '自动修复（无需理会）'],
  ];

  for (const [severity, label] of groups) {
    const list = issues.filter((i) => i.severity === severity);
    if (list.length === 0) continue;
    process.stdout.write(`${label}  (${list.length})\n`);
    for (const i of list) {
      process.stdout.write(`  ${i.path || '(根)'}  ${i.code}\n`);
      process.stdout.write(`    ${i.message}\n`);
      if (i.allowed?.length) process.stdout.write(`    允许: ${i.allowed.join(' | ')}\n`);
      if (i.hint) process.stdout.write(`    建议: ${i.hint}\n`);
    }
    process.stdout.write('\n');
  }
}

async function cmdFrame(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      frame: { type: 'string' },
      at: { type: 'string' },
      out: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const target = resolveTarget(requireTarget(positionals, 'frame'));
  const specPath = target.specPath;

  if (values.frame === undefined && values.at === undefined) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '需要 --frame <n> 或 --at <秒> 之一', {
      hint: '示例: node .skill/engine/src/cli/index.ts frame <slug> --frame 72',
    });
  }

  const raw = loadSpecFile(specPath);
  const { spec, issues } = validateSpec(raw);
  if (!spec) {
    throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法修复，无法渲染单帧');
  }

  const totalFrames = frameCount(spec.video.fps, spec.video.duration);
  const frameIndex =
    values.frame !== undefined
      ? Number(values.frame)
      : secondsToFrame(Number(values.at), spec.video.fps);

  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= totalFrames) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, `帧号超出范围: ${frameIndex}`, {
      details: { totalFrames, fps: spec.video.fps, duration: spec.video.duration },
      hint: `合法范围 0..${totalFrames - 1}`,
    });
  }

  const width = values.width !== undefined ? Number(values.width) : spec.video.width;
  const height = values.height !== undefined ? Number(values.height) : spec.video.height;

  const warnings: string[] = [];
  const drawScene = await loadProjectDrawing(target.project);
  const renderer = createSpecRenderer({
    spec,
    width,
    height,
    ...(drawScene ? { drawScene } : {}),
    onWarning: (m) => warnings.push(m),
  });

  try {
    const rc = makeFrameContext({
      frameIndex,
      totalFrames,
      fps: spec.video.fps,
      width,
      height,
      seed: spec.video.seed,
    });
    const t0 = performance.now();
    renderer.renderFrame(rc);
    const drawMs = performance.now() - t0;
    const png = renderer.toPng();

    const outPath = values.out ?? join(baseOutDir(target), `frame-${frameIndex}.png`);
    outputPath(target, outPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, png);

    // PNG 导出只用于调试，绝不能进正式管线
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            out: outPath,
            frameIndex,
            time: frameIndex / spec.video.fps,
            width,
            height,
            bytes: png.length,
            drawMs: Number(drawMs.toFixed(2)),
            issues: issues.map((i) => `${i.severity} ${i.code} @ ${i.path}`),
            warnings,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      for (const wmsg of warnings) process.stderr.write(`警告: ${wmsg}\n`);
      process.stdout.write(
        `已导出 ${outPath}\n  帧 ${frameIndex}/${totalFrames - 1}  t=${(frameIndex / spec.video.fps).toFixed(2)}s  ` +
          `${width}x${height}  ${(png.length / 1024).toFixed(0)} KB  绘制 ${drawMs.toFixed(1)}ms\n`,
      );
      if (issues.length) process.stdout.write(`  （spec 修复: ${summarizeIssues(issues)}）\n`);
    }
    return 0;
  } finally {
    renderer.dispose();
  }
}

async function cmdStoryboard(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string' },
      count: { type: 'string' },
      'per-shot': { type: 'boolean', default: false },
      width: { type: 'string' },
      height: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const target = resolveTarget(requireTarget(positionals, 'storyboard'));
  const specPath = target.specPath;
  const { spec } = validateSpec(loadSpecFile(specPath));
  if (!spec) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法修复，无法生成分镜');

  const outDir = outputPath(target, values['out-dir'] ?? join(baseOutDir(target), target.project ? 'storyboard' : `storyboard-${target.label}`));
  mkdirSync(outDir, { recursive: true });
  const width = values.width !== undefined ? Number(values.width) : spec.video.width;
  const height = values.height !== undefined ? Number(values.height) : spec.video.height;
  const count = values.count !== undefined ? Number(values.count) : 6;
  if (!Number.isInteger(count) || count < 1 || count > 480) throw new EngineError(ERROR_CODES.CLI_USAGE, '--count 必须为 1–480 的整数');

  const totalFrames = frameCount(spec.video.fps, spec.video.duration);
  // 均匀抽帧，含首尾
  const frameIndices = values['per-shot'] ? inspectQuality(spec).reviewFrames : Array.from({ length: count }, (_, i) =>
    Math.min(totalFrames - 1, Math.round((i / Math.max(1, count - 1)) * (totalFrames - 1))),
  );

  // 关键：在**同一个进程**里渲染全部抽帧。
  // 冷启动（Skia 初始化 + 烘焙 + 字体）实测 140~300ms；
  // 若每帧都起一个 CLI 进程，光是冷启动就会把 storyboard 变成分钟级操作。
  const warnings: string[] = [];
  const measuredNarration = readNarrationTimings([
    outputPath(target, join(baseOutDir(target), 'audio-preflight/narration-timing.json')),
    outputPath(target, join(baseOutDir(target), target.project ? 'audio/narration-timing.json' : `audio-${target.label}/narration-timing.json`)),
  ], spec);
  if (spec.audio.narration.length && !measuredNarration) warnings.push('字幕时间为估算：先运行 audio 获取当前 spec 的实测配音时间');
  const drawScene = await loadProjectDrawing(target.project);
  const renderer = createSpecRenderer({
    spec,
    width,
    height,
    ...(drawScene ? { drawScene } : {}),
    ...(measuredNarration ? { measuredNarration } : {}),
    onWarning: (m) => warnings.push(m),
  });

  const written: Array<{ frame: number; time: number; path: string; bytes: number }> = [];
  const started = performance.now();
  try {
    for (const frameIndex of frameIndices) {
      const rc = makeFrameContext({
        frameIndex,
        totalFrames,
        fps: spec.video.fps,
        width,
        height,
        seed: spec.video.seed,
      });
      renderer.renderFrame(rc);
      const png = renderer.toPng();
      const p = outputPath(target, join(outDir, `frame-${String(frameIndex).padStart(5, '0')}.png`));
      writeFileSync(p, png);
      written.push({
        frame: frameIndex,
        time: frameIndex / spec.video.fps,
        path: p,
        bytes: png.length,
      });
    }
  } finally {
    renderer.dispose();
  }
  const elapsedMs = performance.now() - started;

  // 接触表：用 ffmpeg 拼成一张图，方便一眼看完整片节奏
  let sheetPath: string | null = null;
  if (written.length > 1) {
    sheetPath = join(outDir, 'contact-sheet.png');
    const { spawnSync } = await import('node:child_process');
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const w of written) args.push('-i', w.path);
    const cols = Math.min(4, written.length);
    const scale = Math.max(160, Math.round(360 / Math.max(1, height / width)));
    const thumbHeight = Math.round(scale * height / width);
    const filters = written.map((_, i) => `[${i}:v]scale=${scale}:${thumbHeight}[v${i}]`).join(';');
    const inputs = written.map((_, i) => `[v${i}]`).join('');
    args.push('-filter_complex', `${filters};${inputs}xstack=inputs=${written.length}:layout=${layout(cols, written.length, scale, thumbHeight)}`, '-frames:v', '1', outputPath(target, sheetPath));
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      warnings.push(`接触表生成失败（不影响单帧文件）: ${(r.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`);
      sheetPath = null;
    }
  }

  if (values.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, outDir, contactSheet: sheetPath, frames: written, elapsedMs, warnings }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(`分镜已输出到 ${outDir}\n`);
    for (const w of written) {
      process.stdout.write(`  帧 ${String(w.frame).padStart(4)}  t=${w.time.toFixed(2)}s  ${(w.bytes / 1024).toFixed(0)} KB  ${w.path.split('/').pop()}\n`);
    }
    if (sheetPath) process.stdout.write(`  接触表 ${sheetPath}\n`);
    process.stdout.write(`  ${written.length} 帧共 ${elapsedMs.toFixed(0)}ms（${(elapsedMs / written.length).toFixed(1)} ms/帧，同进程）\n`);
    for (const w of warnings) process.stdout.write(`警告: ${w}\n`);
  }
  return 0;
}

/** xstack takes pixel offsets, not grid indices. */
function layout(cols: number, count: number, width: number, height: number): string {
  return Array.from({ length: count }, (_, i) => `${(i % cols) * width}_${Math.floor(i / cols) * height}`).join('|');
}

function audioTtsOptions(project: ProjectHandle | null, values: { 'tts-provider'?: string; 'no-network'?: boolean }) {
  const provider = values['tts-provider'];
  if (provider && !['edge', 'doubao', 'file', 'mock'].includes(provider)) throw new EngineError(ERROR_CODES.CLI_USAGE, 'tts-provider 需要 edge、doubao、file 或 mock');
  return {
    ...(provider ? { provider: provider as TtsProviderId } : {}),
    allowNetwork: !values['no-network'],
    ...(project ? { voiceAssetPath: resolveInsideProject(project.dir, 'assets/audio/voice.wav', 'voice asset') } : {}),
  };
}

async function cmdAudio(argv: string[]): Promise<number> {
  const lock = argv[0] === 'lock' && Boolean(argv[1] && !argv[1].startsWith('-'));
  const { values, positionals } = parseArgs({ args: lock ? argv.slice(1) : argv, options: {
    'tts-provider': { type: 'string' }, 'no-network': { type: 'boolean', default: false },
  }, allowPositionals: true });
  if (positionals.length !== 1) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: audio [lock] <项目> [--tts-provider file] [--no-network]');
  const target = resolveTarget(requireTarget(positionals, 'audio'));
  if (lock && !target.project) throw new EngineError(ERROR_CODES.CLI_USAGE, '声音锁需要独立影片项目');
  const specSha256 = sha256File(target.specPath);
  const { spec } = validateSpec(loadSpecFile(target.specPath));
  if (!spec) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法解析');
  if (sha256File(target.specPath) !== specSha256) throw new Error('AUDIO_INPUT_CHANGED: 读取规格期间输入发生变化');
  const production = target.project && existsSync(join(target.project.dir, 'production/manifest.json'))
    ? await assertProductionCurrent(target.project.dir, spec) : null;
  if (production && (lock || values['tts-provider'])) throw Error('PRODUCTION_FIXED_TAKES_REQUIRED');
  if (target.project && !production) assertDirectorCurrent(target.project, spec);
  const tts = audioTtsOptions(target.project, values);
  const sourceSha256 = tts.voiceAssetPath && existsSync(tts.voiceAssetPath) ? sha256File(tts.voiceAssetPath) : null;
  const workDir = outputPath(target, join(baseOutDir(target), 'audio-preflight'));
  const audio = production ? await buildProductionAudio(target.project!.dir, production.current.bundle, production.compiled, workDir,
    await prepareAssetPlan(target.project!.dir)) : await buildAudio({ spec, workDir, strictNarration: true, tts });
  if (specSha256 !== sha256File(target.specPath) || (!production && audio.providerInfo.tts === 'file' &&
    (!sourceSha256 || sourceSha256 !== sha256File(tts.voiceAssetPath!)))) throw new Error('AUDIO_INPUT_CHANGED: 声音制作期间输入发生变化，请重新定稿');
  const saved = lock ? await createAudioLock({ projectDir: target.project!.dir, spec, audio,
    sourceAssets: audio.providerInfo.tts === 'file' ? [tts.voiceAssetPath!] : [],
  }) : undefined;
  const locked = saved ? await loadAudioLock({ projectDir: target.project!.dir, path: saved.path, spec }) : undefined;
  process.stdout.write(JSON.stringify({ ok: true, master: locked?.audio.masterPath ?? audio.masterPath,
    timing: join(workDir, 'narration-timing.json'), warnings: audio.warnings, ...(saved ? { audioLock: saved } : {}),
  }, null, 2) + '\n');
  return 0;
}

async function cmdRender(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      crf: { type: 'string' },
      preset: { type: 'string' },
      codec: { type: 'string' },
      'no-audio': { type: 'boolean', default: false },
      'no-captions': { type: 'boolean', default: false },
      'no-run-log': { type: 'boolean', default: false },
      'audio-lock': { type: 'string' },
      'asset-plan': { type: 'string' },
      profile: { type: 'string' },
      'tts-provider': { type: 'string' },
      'no-network': { type: 'boolean', default: false },
      srt: { type: 'string' },
      vtt: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const target = resolveTarget(requireTarget(positionals, 'render'));
  const specPath = target.specPath;
  const project = target.project;
  if (values['asset-plan'] && !project) throw Error('ASSET_PLAN_PROJECT_REQUIRED');
  if (values['audio-lock'] && (!project || values['no-audio'])) throw new EngineError(ERROR_CODES.CLI_USAGE, 'audio-lock 需要有声音的独立影片项目');
  const originalTts = audioTtsOptions(project, values);

  // 渲染类命令一律严格检查：缺 ffmpeg / 缺字体都不应该走到 "渲到一半才崩"
  const envReport = checkEnvironment({ strict: true, ...(project ? { outDir: project.outDir } : {}) });

  const specSha256 = sha256File(specPath);
  const validated = validateSpec(loadSpecFile(specPath));
  let spec = validated.spec;
  const issues = validated.issues;
  if (!spec) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法修复，无法渲染');
  if (sha256File(specPath) !== specSha256) throw new Error('RENDER_INPUT_CHANGED: 读取规格期间输入发生变化');

  if (values.profile !== undefined && !['rough', 'final'].includes(values.profile)) throw Error('PRODUCTION_PROFILE_INVALID');
  let production = project && existsSync(join(project.dir, 'production/manifest.json'))
    ? await assertProductionCurrent(project.dir, spec, values.profile as 'rough' | 'final' | undefined) : null;
  if (production && (values['no-audio'] || values['audio-lock'] || values['tts-provider'] || values['asset-plan'])) throw Error('PRODUCTION_TIMELINE_CONTROLS_REQUIRED');
  if (project && !production) assertDirectorCurrent(project, spec);
  let promptHistory = project ? promptHistorySnapshot(project.dir) : undefined;
  const outDir = baseOutDir(target);
  const requestedOutPath = outputPath(target, values.out ?? join(outDir, `${target.label}.mp4`));
  for (const path of [values.srt, values.vtt]) if (path) outputPath(target, path);
  outputPath(target, join(outDir, 'audio'));
  const width = values.width !== undefined ? Number(values.width) : spec.video.width;
  const height = values.height !== undefined ? Number(values.height) : spec.video.height;

  if (production && (width !== spec.video.width || height !== spec.video.height)) throw Error('PRODUCTION_PROFILE_DIMENSIONS_REQUIRED');
  const warnings: string[] = [];

  // brief 是声明层。它不合法**不阻断**渲染（spec 已经能渲），
  // 但会让 run.json 缺少声明素材，所以这里显式告警，不静默忽略。
  let declaredAssets: readonly BriefAsset[] = [];
  let briefSha256: string | null = null;
  if (project?.briefPath) {
    try {
      const readSha256 = sha256File(project.briefPath);
      const checked = validateBrief(loadBriefFile(project.briefPath), { spec, projectDir: project.dir });
      if (sha256File(project.briefPath) !== readSha256) throw new Error('RENDER_INPUT_CHANGED: 读取提示词契约期间输入发生变化');
      declaredAssets = checked.brief.assets;
      briefSha256 = readSha256;
      for (const w of checked.warnings) warnings.push(`brief: ${w.code} @ ${w.path}: ${w.message}`);
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      warnings.push(
        `brief 校验未通过（不影响渲染，但 run.json 不会记录声明素材）: ${err.code} ${err.message}`,
      );
    }
  }

  const locked = values['audio-lock'] ? await loadAudioLock({ projectDir: project!.dir, path: values['audio-lock'], spec }) : undefined;
  const assetPlan = project && (values['asset-plan'] || existsSync(join(project.dir, DEFAULT_ASSET_PLAN_PATH)))
    ? await prepareAssetPlan(project.dir, values['asset-plan'] ?? DEFAULT_ASSET_PLAN_PATH) : null;
  if (!production && assetPlan?.bindings.some(b => b.video?.version === '0.2' && b.video.sourceAudio && !b.use.mute)) {
    throw Error('VIDEO_ORIGINAL_AUDIO_TIMELINE_PENDING: this clip preserves source audio. Render it through the production clip placement and original-audio mix; an explicit mute=true choice enables this visual-only render.');
  }
  let attempt: RenderAttempt | undefined;
  let assets: ReturnType<typeof createAssetPort> | undefined;
  let assetUsageIdentity: { path: string; bytes: number; sha256: string } | undefined;
  const saveAssetUsage = (completeBuiltin = false) => {
    if (!attempt || !assets || assetUsageIdentity) return;
    const data = Buffer.from(JSON.stringify(assets.usage(completeBuiltin), null, 2) + '\n');
    const path = join(attempt.runDir, 'asset-usage.json'); writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
    assetUsageIdentity = { path: `runs/${attempt.attemptId}/asset-usage.json`, bytes: data.length, sha256: sha256File(path) };
  };
  let renderer: ReturnType<typeof createSpecRenderer> | undefined;
  let committed = false;
  try {
    if (project) {
      attempt = beginRenderAttempt(project, { mediaPaths: [
        ...declaredAssets.map(asset => asset.path),
        ...(originalTts.voiceAssetPath && existsSync(originalTts.voiceAssetPath) ? [relative(project.dir, originalTts.voiceAssetPath)] : []),
        ...(locked?.usage.mediaFiles.map(file => relative(project.dir, file.path)) ?? []),
        ...(assetPlan?.mediaPaths ?? []),
        ...(production ? await productionMediaPaths(project.dir, production.current) : []),
      ] });
      if (sha256File(attempt.snapshotProject.specPath) !== specSha256 ||
        (briefSha256 && sha256File(attempt.snapshotProject.briefPath!) !== briefSha256)) throw new Error('RENDER_INPUT_CHANGED: 准备执行快照期间输入发生变化');
      spec = validateSpec(loadSpecFile(attempt.snapshotProject.specPath)).spec!;
      if (production) production = await assertProductionCurrent(attempt.snapshotProject.dir, spec, production.projection.profile);
      else assertDirectorCurrent(attempt.snapshotProject, spec);
      promptHistory = promptHistorySnapshot(attempt.snapshotProject.dir);
      if (assetPlan) await assertAssetPlanSnapshot(attempt.snapshotProject.dir, assetPlan);
      assets = createAssetPort(attempt.snapshotProject.dir, assetPlan, attempt);
    }
    const renderProject = attempt?.snapshotProject ?? project;
    const outPath = attempt ? join(attempt.workDir, 'final.mp4') : requestedOutPath;
    const finalOutPath = attempt ? join(attempt.outputDir, 'final.mp4') : outPath;

    // ---- 1. 先做音频 ----
    // 顺序很重要：字幕需要 TTS 的实测词级时间戳，所以音频必须在渲染之前完成。
    let audioPath: string | undefined;
    let captionTimings: ReadonlyMap<number, MeasuredNarration> | undefined;
    let audioWarnings: string[] = [];
    let providerInfo: { tts: string; bgm: string; sfx: string } | undefined;
    let voiceTracks: readonly AudioTrack[] = [];
    let productionAudio: Awaited<ReturnType<typeof buildProductionAudio>> | undefined;
    // 音频中间产物的目录名要在两个地方用（构建 + 遥测），所以提到外面。
    // 项目音频先进入本次临时区，提交后保存到本次渲染目录并更新便捷副本。
    // 裸 spec 共用同一个产物目录，靠 label 前缀区分。
    const audioWorkDir = attempt ? join(attempt.workDir, 'audio') : join(outDir, target.project ? 'audio' : `audio-${target.label}`);

    if (!values['no-audio']) {
      const frozenLock = locked && attempt ? await loadAudioLock({ projectDir: renderProject!.dir,
        path: values['audio-lock']!, spec,
      }) : locked;
      const audio = production ? (productionAudio = await buildProductionAudio(renderProject!.dir, production.current.bundle, production.compiled, audioWorkDir, assetPlan!))
        : frozenLock ? frozenLock.audio : await buildAudio({
        spec,
        workDir: audioWorkDir,
        strictNarration: true,
        tts: audioTtsOptions(renderProject, values),
      });
      audioPath = audio.masterPath;
      voiceTracks = audio.timeline.tracks.filter(t => t.kind === 'voice');
      captionTimings = audio.captionTimings;
      audioWarnings = audio.warnings;
      providerInfo = audio.providerInfo;
      if (frozenLock) {
        mkdirSync(audioWorkDir, { recursive: true });
        writeFileSync(join(audioWorkDir, 'narration-timing.json'), JSON.stringify(frozenLock.timingReport, null, 2) + '\n');
      }
    }

    // ---- 2. 渲染视频（raw RGBA → ffmpeg 管道，音频在同一次调用里封装） ----
    const drawingSources = project?.manifest.drawing ? (attempt?.drawingSources ?? projectSourceHashes(project.dir)) : undefined;
    const drawScene = production ? await createProductionDrawing(production.compiled, assets!.port, production.projection.profile)
      : attempt ? await loadAttemptDrawing(attempt, assets?.port) : await loadProjectDrawing(project);
    renderer = createSpecRenderer({
      spec,
      width,
      height,
      ...(drawScene ? { drawScene } : {}),
      captions: values['no-captions'] ? false : spec.captions.enabled,
      ...(captionTimings ? { measuredNarration: captionTimings } : {}),
      ...(production ? { captionCues: production.compiled.captionCues } : {}),
      onWarning: (m) => warnings.push(m),
    });

    const result = await renderVideo({
      renderer,
      fps: spec.video.fps,
      durationSeconds: spec.video.duration,
      seed: spec.video.seed,
      outPath,
      ...(audioPath ? { audioPath } : {}),
      video: {
        ...(values.codec ? { codec: values.codec as VideoEncoderId } : {}),
        ...(values.crf ? { crf: Number(values.crf) } : {}),
        ...(values.preset ? { preset: values.preset } : {}),
      },
      onProgress: (done, total) => {
        // 只报少数几次，不要逐帧刷屏
        if (values.json) return;
        if (done === total || done % Math.max(1, Math.floor(total / 4)) === 0) {
          process.stderr.write(`  渲染 ${done}/${total}\n`);
        }
      },
    });

    if (drawingSources && project && JSON.stringify(drawingSources) !== JSON.stringify(projectSourceHashes(project.dir))) {
      throw new EngineError(ERROR_CODES.PROJECT_INVALID, '渲染期间本片源码发生变化，请固定源码后重新渲染');
    }

    // ---- 3. 外挂字幕（可选） ----
    const cues = production ? production.compiled.captionCues : buildCaptionTrack(spec, captionTimings ? { measured: captionTimings } : {});
    const requestedSrt = outputPath(target, values.srt ?? join(outDir, `${target.label}.srt`));
    const requestedVtt = outputPath(target, values.vtt ?? join(outDir, `${target.label}.vtt`));
    const srtPath = attempt ? join(attempt.workDir, `${target.label}.srt`) : requestedSrt;
    const vttPath = attempt ? join(attempt.workDir, `${target.label}.vtt`) : requestedVtt;
    if (cues.length > 0) {
      writeFileSync(srtPath, toSrt(cues), 'utf8');
      writeFileSync(vttPath, toVtt(cues), 'utf8');
    }

    // ---- 4. 用 ffprobe 校验真实产物（不是相信渲染时的意图） ----
    const info = probeMedia(outPath);
    const decodeError = verifyDecodable(outPath);
    const verification = verifyAgainstSpec(info, spec, width, height, decodeError);
    if (attempt && !verification.ok) throw new Error(`RENDER_VERIFICATION_FAILED: ${verification.failures.join('; ')}`);
    const voicePresence = verifyVoicePresence(outPath, voiceTracks);
    if (audioPath) writeFileSync(join(audioWorkDir, 'encoded-voice-presence.json'), JSON.stringify(voicePresence, null, 2) + '\n');
    if (voicePresence.some(p => !p.ok)) throw new Error('NARRATION_INAUDIBLE: 编码成片丢失旁白，拒绝交付；见 encoded-voice-presence.json');

    if (production && attempt) writeFileSync(join(attempt.workDir, 'production-render.json'), JSON.stringify({
      version: '0.1', kind: 'production-render-evidence', projection: production.projection,
      clips: production.compiled.clips, audioPlacements: production.compiled.audioPlacements, events: production.compiled.events,
      captionCues: production.compiled.captionCues, sources: productionAudio?.sources ?? [],
      masterSha256: audioPath ? sha256File(audioPath) : null, durationSamples: production.compiled.durationSamples,
      observed: { encodedFrames: result.frames, media: info, voicePresence },
      fullCreativeReview: 'pending',
    }, null, 2) + '\n', { flag: 'wx' });

    // ---- 5. 写实测遥测 run.json ----
    // 顺序：先渲染、再写遥测。反过来的话，run.json 会描述一支可能并不存在的成片。
    let runLogPath: string | null = null;
    if (attempt || !values['no-run-log']) {
      runLogPath = runLogPathFor(outPath, project?.dir ?? null);
      const fontUsage = renderer.fontUsage();
      const facts = buildFacts({
        ...(assets ? { assetUsage: assets.usage(!project?.manifest.drawing && !assetPlan && !locked && !declaredAssets.length &&
          Object.values(providerInfo ?? {}).every(p => ['(none)', 'none', 'procedural'].includes(p))) } : {}),
        ...(promptHistory ? { promptHistory } : {}),
        ...(project?.manifest.drawing && drawingSources ? { drawing: { entry: project.manifest.drawing, sources: drawingSources } } : {}),
        ...(process.env.JBM_RUNTIME_ID ? { runtime: { packageId: process.env.JBM_RUNTIME_ID, platform: process.platform, arch: process.arch } } : {}),
        ...(locked ? { audioReuse: { lockPath: locked.usage.path, lockSha256: locked.usage.sha256, sourceProviders: locked.provenance.sourceProviders } } : {}),
        ...(productionAudio ? { consumedAssets: productionAudio.consumedAssets } : locked ? { consumedAssets: locked.usage.mediaFiles.filter(file => file.role === 'audio-source').map(file => ({
          path: relative(project!.dir, file.path), absPath: attempt ? join(attempt.snapshotDir, relative(project!.dir, file.path)) : file.path, role: file.role, sha256: file.sha256 })) }
          : providerInfo?.tts === 'file' && originalTts.voiceAssetPath ? { consumedAssets: [{ path: relative(project!.dir, originalTts.voiceAssetPath),
            absPath: attempt ? join(attempt.snapshotDir, relative(project!.dir, originalTts.voiceAssetPath)) : originalTts.voiceAssetPath,
            role: 'voice-source', sha256: attempt?.inputSnapshot.files.find(f => f.path === relative(project!.dir, originalTts.voiceAssetPath!))?.sha256 ?? sha256File(originalTts.voiceAssetPath) }] } : {}),
        video: {
          width,
          height,
          fps: spec.video.fps,
          duration: spec.video.duration,
          frames: result.frames,
          seed: spec.video.seed,
        },
        rendererKind: renderer.kind,
        rendererPackage: 'skia-canvas',
        rendererVersion: dependencyVersion('skia-canvas'),
        encoder: {
          video: info.video?.codec ?? '(未知)',
          pixelFormat: info.video?.pixelFormat ?? '(未知)',
          audio: info.audio?.codec ?? null,
          crf: values.crf !== undefined ? Number(values.crf) : null,
          preset: values.preset ?? null,
        },
        ffmpeg: { version: envReport.ffmpeg.version, command: envReport.ffmpeg.command },
        providers: providerInfo ?? { tts: '(none)', bgm: '(none)', sfx: '(none)' },
        ...(renderProject ? { projectDir: renderProject.dir } : {}),
        declaredAssets,
        fonts: fontUsage.registered,
        fontUsage: fontUsage.families,
        captions: {
          insideFrame: !values['no-captions'] && spec.captions.enabled,
          cues: cues.length,
          wordLevel: cues.some((c) => (c.words?.length ?? 0) > 0),
        },
      });
      saveAssetUsage(facts.assets.usage?.coverage === 'complete');
      const log = buildRunLog({
        project: project?.slug ?? null,
        specPath,
        specSha256,
        briefPath: project?.briefPath ?? null,
        briefSha256,
        facts,
        ...(attempt ? { execution: { attemptId: attempt.attemptId, inputSnapshotSha256: attempt.inputSnapshotSha256, coverage: 'partial' as const,
          ...(assetUsageIdentity ? { assetUsage: assetUsageIdentity } : {}) } } : {}),
        measured: buildMeasured({
          renderMs: result.totalMs,
          msPerFrame: result.msPerFrame,
          encodeTailMs: result.encodeTailMs,
          audioMixMs: null,
          outputBytes: info.sizeBytes,
          outputSha256: sha256File(outPath),
          outputPath: repoRelative(finalOutPath),
          ...(values['no-audio']
            ? {}
            : { audioArtifacts: locked ? locked.usage.mediaFiles.filter(file => file.role === 'audio-master' || file.role === 'audio-track')
                .map(file => ({ role: file.role === 'audio-master' ? 'master' : locked.audio.timeline.tracks.find(track => track.path === file.path)!.kind,
                  path: repoRelative(file.path), sha256: file.sha256 }))
              : audioArtifactHashes(audioArtifactsFor(audioWorkDir)).map(file => ({ ...file,
                path: attempt ? repoRelative(join(attempt.outputDir, 'audio', file.path.split('/').at(-1)!)) : file.path,
              })) }),
        }),
      });
      if (attempt) {
        const copies = [
          { fromName: 'final.mp4', destination: requestedOutPath },
          ...(cues.length ? [{ fromName: `${target.label}.srt`, destination: requestedSrt }, { fromName: `${target.label}.vtt`, destination: requestedVtt }] : []),
          ...(existsSync(audioWorkDir) ? readdirSync(audioWorkDir).map(name => ({ fromName: `audio/${name}`, destination: join(outDir, 'audio', name) })) : []),
        ];
        runLogPath = commitRenderAttempt(attempt, log, { technicalOk: verification.ok, publishRun: !values['no-run-log'], copies });
        committed = true;
        if (values['no-run-log']) runLogPath = null;
      } else writeRunLog(runLogPath, log);
    }

    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: verification.ok,
            out: finalOutPath,
            srt: cues.length ? (attempt ? join(attempt.outputDir, `${target.label}.srt`) : srtPath) : null,
            vtt: cues.length ? (attempt ? join(attempt.outputDir, `${target.label}.vtt`) : vttPath) : null,
            ...(attempt ? { attemptId: attempt.attemptId, current: requestedOutPath } : {}),
            ...(locked ? { audioReuse: { lockPath: locked.usage.path, sourceProviders: locked.provenance.sourceProviders } } : {}),
            frames: result.frames,
            renderMsPerFrame: Number(result.msPerFrame.toFixed(2)),
            totalMs: result.totalMs,
            media: info,
            verification,
            providers: providerInfo ?? null,
            runLog: runLogPath,
            issues: issues.map((i) => `${i.severity} ${i.code} @ ${i.path}`),
            warnings: [...warnings, ...audioWarnings],
          },
          null,
          2,
        ) + '\n',
      );
      return verification.ok ? 0 : 1;
    }

    const line = (k: string, v: string): string => `  ${k.padEnd(14)} ${v}`;
    const out: string[] = [];
    out.push(`已输出 ${finalOutPath}`);
    out.push('');
    out.push(line('分辨率', `${info.video?.width}×${info.video?.height}`));
    out.push(line('帧率', `${info.video?.fps}`));
    out.push(line('时长', `${info.durationSeconds.toFixed(3)}s`));
    out.push(line('帧数', `${info.video?.frameCount ?? result.frames}`));
    out.push(line('视频编码', `${info.video?.codec}`));
    out.push(line('音频编码', info.audio ? `${info.audio.codec} @${info.audio.sampleRate}Hz ×${info.audio.channels}` : '无'));
    out.push(line('体积', `${(info.sizeBytes / 1048576).toFixed(2)} MB`));
    if (locked) out.push(line('声音复用', locked.usage.path));
    else if (providerInfo) out.push(line('音源', `TTS=${providerInfo.tts} BGM=${providerInfo.bgm} SFX=${providerInfo.sfx}`));
    if (cues.length) out.push(line('字幕', `${cues.length} 条 → ${attempt ? join(attempt.outputDir, `${target.label}.srt`) : srtPath} / ${attempt ? join(attempt.outputDir, `${target.label}.vtt`) : vttPath}`));
    if (runLogPath) out.push(line('实测记录', runLogPath.replace(PROJECT_ROOT + '/', '')));
    out.push(line('渲染耗时', `${(result.totalMs / 1000).toFixed(2)}s（${result.msPerFrame.toFixed(1)} ms/帧）`));
    out.push('');
    out.push(verification.ok ? 'ffprobe 校验通过。' : 'ffprobe 校验失败：');
    for (const f of verification.failures) out.push(`  ✗ ${f}`);
    if (issues.length) out.push(`\nspec 修复: ${summarizeIssues(issues)}`);
    for (const w of [...warnings, ...audioWarnings]) out.push(`警告: ${w}`);
    process.stdout.write(out.join('\n') + '\n');
    return verification.ok ? 0 : 1;
  } catch (error) {
    try { saveAssetUsage(); } finally { if (attempt && !committed) failRenderAttempt(attempt, error); }
    throw error;
  } finally {
    renderer?.dispose();
    assets?.close();
  }
}

/** 把 ffprobe 读到的真实产物与 spec 意图逐项对比 */
function verifyAgainstSpec(
  info: ReturnType<typeof probeMedia>,
  spec: ResolvedVideoSpec,
  width: number,
  height: number,
  decodeError: string | null,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const v = info.video;
  if (!v) failures.push('产物不含视频流');
  else {
    if (v.width !== width) failures.push(`宽度应为 ${width}，实际 ${v.width}`);
    if (v.height !== height) failures.push(`高度应为 ${height}，实际 ${v.height}`);
    if (Math.abs(v.fps - spec.video.fps) > 0.01) failures.push(`帧率应为 ${spec.video.fps}，实际 ${v.fps}`);
    if (v.codec !== 'h264') failures.push(`视频编码应为 h264，实际 ${v.codec}`);
    // 契约明确要求 yuv420p；缺了它很多播放器/平台会拒绝
    if (v.pixelFormat !== 'yuv420p') failures.push(`像素格式应为 yuv420p，实际 ${v.pixelFormat ?? '(未知)'}`);
  }
  if (Math.abs(info.durationSeconds - spec.video.duration) > 0.1) {
    failures.push(`时长应为 ${spec.video.duration}s，实际 ${info.durationSeconds.toFixed(3)}s`);
  }
  // 有旁白/BGM 的 spec 必须真的产出音频流——这是最容易静默失败的一环
  const expectsAudio = spec.audio.narration.length > 0 || spec.audio.bgm.volume > 0 || spec.audio.sfx.length > 0;
  if (expectsAudio && !info.audio) failures.push('spec 有音频内容，但产物不含音频流');
  if (info.audio && info.audio.sampleRate !== 48000) failures.push(`音频采样率应为 48000，实际 ${info.audio.sampleRate}`);
  if (info.audio && info.audio.codec !== 'aac') failures.push(`音频编码应为 aac，实际 ${info.audio.codec}`);
  if (decodeError) failures.push(`全片解码报错: ${decodeError.split('\n')[0]}`);
  return { ok: failures.length === 0, failures };
}

function basenameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.[^.]+$/, '');
}

function cmdSubtitles(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string' },
      srt: { type: 'string' },
      vtt: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const target = resolveTarget(requireTarget(positionals, 'subtitles'));
  const specPath = target.specPath;

  const { spec } = validateSpec(loadSpecFile(specPath));
  if (!spec) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法修复，无法导出字幕');

  const cues = buildCaptionTrack(spec);
  if (cues.length === 0) {
    process.stdout.write('该 spec 没有任何旁白，无字幕可导出。\n');
    return 0;
  }

  const base = target.label;
  const outDir = outputPath(target, values['out-dir'] ?? baseOutDir(target));
  const srtPath = outputPath(target, values.srt ?? join(outDir, `${base}.srt`));
  const vttPath = outputPath(target, values.vtt ?? join(outDir, `${base}.vtt`));

  mkdirSync(dirname(srtPath), { recursive: true });
  mkdirSync(dirname(vttPath), { recursive: true });
  writeFileSync(srtPath, toSrt(cues), 'utf8');
  writeFileSync(vttPath, toVtt(cues), 'utf8');

  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: true, srt: srtPath, vtt: vttPath, cues }, null, 2) + '\n');
  } else {
    process.stdout.write(`已导出外挂字幕\n  ${srtPath}\n  ${vttPath}\n\n`);
    process.stdout.write(`共 ${cues.length} 条\n`);
    for (const c of cues) {
      const hasWords = c.words?.length ? `  词级 ${c.words.length}` : '  句级';
      process.stdout.write(
        `  #${c.index + 1}  ${c.start.toFixed(2)}s → ${c.end.toFixed(2)}s  (${(c.end - c.start).toFixed(2)}s)${hasWords}\n    ${c.text}\n`,
      );
    }
    if (cues.some((c) => !c.words?.length)) {
      process.stdout.write(
        '\n注：无词级时间戳的条目按时长估算（依赖文本，确定性）。' +
          '接入 TTS 后由 provider 返回实测词级时间，画面内即可逐词高亮。\n',
      );
    }
  }
  return 0;
}

// ---------------------------------------------------------------- 项目层

/** 目标对应的默认输出目录：项目走项目自己的 outDir，裸 spec 走根 out/ */
const RESEARCH_OUT_DIR = join(PROJECT_ROOT, '.research', 'out');

function outputPath(target: ResolvedTarget, path: string): string {
  return assertContained(baseOutDir(target), path);
}
function baseOutDir(target: ResolvedTarget): string {
  // 项目 → 项目自己的 outDir；非项目 spec（探针 / 引擎级夹具）→ .research/out/
  // （AGENTS.md 硬性规则 1：产物必须落在本项目目录内；仓库根不放任何产物）
  return target.project ? target.project.outDir : RESEARCH_OUT_DIR;
}

/**
 * 列出音频中间产物及其角色。
 *
 * 这些文件是「配音真的进去了」的唯一直接证据：把它们逐个哈希写进 run.json，
 * 事后才能回答"这一版成片用的是哪段配音"——尤其是当 TTS 是网络服务时。
 */
function audioArtifactsFor(workDir: string): { role: string; absPath: string }[] {
  if (!existsSync(workDir)) return [];
  return readdirSync(workDir)
    .filter((f) => f.endsWith('.wav'))
    .sort()
    .map((f) => ({ role: audioRole(f), absPath: join(workDir, f) }));
}

function audioRole(file: string): string {
  if (file === 'master.wav') return 'master';
  if (file.startsWith('voice')) return 'voice';
  if (file.startsWith('bgm')) return 'bgm';
  if (file.startsWith('sfx')) return 'sfx';
  return 'other';
}

function cmdProject(argv: string[]): number {
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

function cmdBrief(argv: string[]): number {
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

function cmdArtifact(argv: string[]): number {
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

function cmdDisclosure(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
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
  const result = buildDisclosure(project);

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

async function cmdImport(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    source: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' },
  }, allowPositionals: true });
  if (positionals.length !== 1 || [values.source, values.verify, values.schema].filter(value => value !== undefined).length !== 1 || Object.values(values).some(value => value === '')) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: import <项目> --source <路径> | --verify <importId> | --schema manifest|receipt|policy');
  }
  if (values.schema !== undefined) {
    const schemas = { manifest: IMPORT_MANIFEST_SCHEMA, receipt: IMPORT_RECEIPT_SCHEMA, policy: IMPORT_POLICY_SCHEMA };
    if (!Object.hasOwn(schemas, values.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '导入契约须为 manifest、receipt 或 policy');
    process.stdout.write(JSON.stringify(schemas[values.schema as keyof typeof schemas], null, 2) + '\n');
    return 0;
  }
  const project = loadProject(positionals[0]);
  if (values.verify !== undefined) {
    const manifest = await verifyImport(project.dir, values.verify);
    process.stdout.write(JSON.stringify({ ok: true, manifest }, null, 2) + '\n');
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const receipt = await importOriginals(project.dir, resolve(values.source!), { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof ImportFailure)) throw error;
    process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n');
    return error.receipt.status === 'succeeded' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

async function cmdUnpack(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    import: { type: 'string' }, path: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' },
  }, allowPositionals: true });
  const selection = values.import !== undefined || values.path !== undefined;
  if (positionals.length !== 1 || [selection, values.verify !== undefined, values.schema !== undefined].filter(Boolean).length !== 1 ||
      selection && (values.import === undefined || values.path === undefined) || Object.values(values).some(value => value === '')) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: unpack <项目> --import <importId> --path <归档相对路径> | --verify <unpackId> | --schema manifest|receipt|policy|index');
  }
  if (values.schema !== undefined) {
    const schemas = { manifest: UNPACK_MANIFEST_SCHEMA, receipt: UNPACK_RECEIPT_SCHEMA, policy: UNPACK_POLICY_SCHEMA, index: UNPACK_INDEX_SCHEMA };
    if (!Object.hasOwn(schemas, values.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '展开契约须为 manifest、receipt、policy 或 index');
    process.stdout.write(JSON.stringify(schemas[values.schema as keyof typeof schemas], null, 2) + '\n'); return 0;
  }
  const project = loadProject(positionals[0]);
  if (values.verify !== undefined) {
    process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyUnpack(project.dir, values.verify) }, null, 2) + '\n'); return 0;
  }
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const receipt = await unpackOriginal(project.dir, values.import!, values.path!, { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UnpackFailure)) throw error;
    process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

async function cmdCatalog(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { import: { type: 'string' }, unpack: { type: 'string' }, path: { type: 'string' }, asset: { type: 'string' }, observation: { type: 'string' }, rights: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' } }, allowPositionals: true });
  const selected = v.import !== undefined || v.unpack !== undefined;
  if (positionals.length !== 1 || [v.import, v.unpack, v.observation, v.rights, v.verify, v.schema].filter(x => x !== undefined).length !== 1 || (v.path !== undefined || v.asset !== undefined) && !selected || v.asset !== undefined && v.path === undefined || Object.values(v).some(x => x === '')) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: catalog <项目> --import <importId> | --unpack <unpackId> [--path <条目> [--asset <assetId>]] | --observation <本片JSON> | --rights <本片JSON> | --verify <catalogId> | --schema manifest|receipt|policy|index|observation|rights|document-map|ocr-map|asr-map|audio-input-map|document-ocr-map|document-ocr-selection-map');
  if (v.schema !== undefined) { if (!Object.hasOwn(CATALOG_SCHEMAS, v.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '素材目录契约须为 manifest、receipt、policy、index、observation、rights、document-map、ocr-map、asr-map、audio-input-map、document-ocr-map 或 document-ocr-selection-map'); process.stdout.write(JSON.stringify(CATALOG_SCHEMAS[v.schema as keyof typeof CATALOG_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]);
  if (v.verify !== undefined) { process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyCatalog(project.dir, v.verify) }, null, 2) + '\n'); return 0; }
  const selection = v.observation !== undefined ? { observation: v.observation } : v.rights !== undefined ? { rights: v.rights } : { ...(v.import !== undefined ? { importId: v.import } : { unpackId: v.unpack! }), ...(v.path !== undefined ? { path: v.path } : {}), ...(v.asset !== undefined ? { assetId: v.asset } : {}) };
  const controller = new AbortController(), interrupt = () => controller.abort(); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try { const receipt = await catalogAssets(project.dir, selection, { signal: controller.signal }); process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1; }
  catch (error) { if (!(error instanceof CatalogFailure)) throw error; process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

async function cmdAlign(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { catalog: { type: 'string' }, asset: { type: 'string' }, version: { type: 'string' }, script: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' } }, allowPositionals: true });
  const selected = v.catalog !== undefined;
  if (positionals.length !== 1 || [selected, v.verify !== undefined, v.recover === true, v.schema !== undefined].filter(Boolean).length !== 1 || Object.values(v).some(value => value === '') || selected && (!v.asset || !v.version || !v.script) || !selected && [v.asset, v.version, v.script].some(value => value !== undefined)) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: align <项目> --catalog <catalogId> --asset <assetId> --version <assetVersion> --script <批准稿JSON> | --verify <alignmentId> | --recover | --schema policy|script|selection|map|manifest|index|receipt');
  if (v.schema !== undefined) { if (!Object.hasOwn(ALIGNMENT_SCHEMAS, v.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '对齐契约名称无效'); process.stdout.write(JSON.stringify(ALIGNMENT_SCHEMAS[v.schema as keyof typeof ALIGNMENT_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (v.verify !== undefined) { process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyAlignment(project.dir, v.verify, { signal: controller.signal }) }, null, 2) + '\n'); return 0; }
    if (v.recover) { process.stdout.write(JSON.stringify({ ok: true, receipts: await recoverAlignmentAttempts(project.dir, { signal: controller.signal }) }, null, 2) + '\n'); return 0; }
    const receipt = await alignAsset(project.dir, { catalogId: v.catalog!, assetId: v.asset!, assetVersion: v.version!, scriptPath: v.script! }, { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) { if (!(error instanceof AlignmentFailure)) throw error; process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

async function cmdAssets(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { plan: { type: 'string' }, schema: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || v.plan !== undefined && v.schema !== undefined || Object.values(v).some(x => x === '')) throw Error('CLI_USAGE: assets <project> [--plan assets/asset-plan.json | --schema plan|usage]');
  if (v.schema) { if (!Object.hasOwn(ASSET_PLAN_SCHEMAS, v.schema)) throw Error('ASSET_SCHEMA_INVALID');
    process.stdout.write(JSON.stringify(ASSET_PLAN_SCHEMAS[v.schema as keyof typeof ASSET_PLAN_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), prepared = await prepareAssetPlan(project.dir, v.plan ?? DEFAULT_ASSET_PLAN_PATH);
  process.stdout.write(JSON.stringify({ plan: prepared.identity, gaps: prepared.gaps, mediaPaths: prepared.mediaPaths }, null, 2) + '\n'); return 0;
}

async function cmdVideo(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { request: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' }, limits: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || [v.request !== undefined, v.verify !== undefined, v.recover === true, v.schema !== undefined].filter(Boolean).length !== 1 ||
      Object.values(v).some(x => x === '') || v.limits && !v.request && !v.verify) throw Error('CLI_USAGE: video <project> --request <project JSON> | --verify <map path> [--limits <project resource-policy JSON>] | --recover | --schema request|map|limits|receipt|publication');
  if (v.schema) { if (!Object.hasOwn(VIDEO_PREPARATION_SCHEMAS, v.schema)) throw Error('VIDEO_SCHEMA_INVALID');
    process.stdout.write(JSON.stringify(VIDEO_PREPARATION_SCHEMAS[v.schema as keyof typeof VIDEO_PREPARATION_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), controller = new AbortController(), interrupt = () => controller.abort();
  const { readAssetFile } = await import('../application/asset-plan.ts');
  const { videoPreparationLimits } = await import('../project/video-preparation.ts');
  const limits = v.limits ? videoPreparationLimits(JSON.parse((await readAssetFile(project.dir, v.limits, 4194304)).data.toString('utf8'))) : undefined;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (v.verify) { process.stdout.write(JSON.stringify({ ok: true, map: await verifyVideoPreparation(project.dir, v.verify, { signal: controller.signal, limits }) }, null, 2) + '\n'); return 0; }
    if (v.recover) { process.stdout.write(JSON.stringify({ ok: true, receipts: await recoverVideoAttempts(project.dir) }, null, 2) + '\n'); return 0; }
    const request = JSON.parse((await readAssetFile(project.dir, v.request!, 4194304)).data.toString('utf8'));
    const receipt = await prepareVideo(project.dir, request, { signal: controller.signal, limits });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

function requireTarget(positionals: string[], cmd: string): string {
  const p = positionals[0];
  if (!p) {
    const slugs = listProjectSlugs();
    throw new EngineError(ERROR_CODES.CLI_USAGE, `${cmd} 缺少参数 <spec.json|项目>`, {
      ...(slugs.length ? { allowed: slugs } : {}),
      hint: `用法: node .skill/engine/src/cli/index.ts ${cmd} <项目 slug>  或  node .skill/engine/src/cli/index.ts ${cmd} <spec.json>`,
    });
  }
  return p;
}

async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === undefined || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printHelp();
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, `未知命令: ${cmd}`, {
      allowed: COMMANDS,
      hint: '运行 `node .skill/engine/src/cli/index.ts --help` 查看全部命令',
    });
  }

  switch (cmd as CommandName) {
    case 'env': return cmdEnv(rest);
    case 'capabilities': process.stdout.write(JSON.stringify(capabilities(rest.includes('--schema')), null, 2) + '\n'); return 0;
    case 'voices': process.stdout.write(JSON.stringify({ provider: 'doubao', count: DOUBAO_VOICES.length, voices: DOUBAO_VOICES }, null, 2) + '\n'); return 0;
    case 'direct': return cmdDirect(rest);
    case 'prompt': return cmdPrompt(rest);
    case 'import': return cmdImport(rest);
    case 'unpack': return cmdUnpack(rest);
    case 'catalog': return cmdCatalog(rest);
    case 'assets': return cmdAssets(rest);
    case 'video': return cmdVideo(rest);
    case 'production': return cmdProduction(rest);
    case 'review': case 'credits': case 'deliver': return cmdDelivery(cmd, rest);
    case 'align': return cmdAlign(rest);
    case 'qa': return cmdQuality(requireTarget(rest, 'qa'));
    case 'diagnose': return cmdDiagnose(rest);
    case 'validate': return await cmdValidate(rest);
    case 'frame': return cmdFrame(rest);
    case 'storyboard': return await cmdStoryboard(rest);
    case 'render': return await cmdRender(rest);
    case 'audio': return await cmdAudio(rest);
    case 'subtitles': return cmdSubtitles(rest);
    case 'project': return cmdProject(rest);
    case 'brief': return cmdBrief(rest);
    case 'disclosure': return cmdDisclosure(rest);
    case 'artifact': return cmdArtifact(rest);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof EngineError) {
      process.stderr.write(err.toLLMString() + '\n');
      process.exitCode = err.code === ERROR_CODES.NOT_IMPLEMENTED ? 2 : 1;
    } else {
      process.stderr.write(`RENDER_FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      if (process.env['VIDEO_DEBUG']) process.stderr.write(String((err as Error)?.stack ?? ''));
      process.exitCode = 1;
    }
  }
}

void main();
