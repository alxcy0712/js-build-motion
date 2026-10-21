import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { initProject, type InitOptions, type InitResult } from '../project/scaffold.ts';
import { loadProjectDrawing } from '../project/drawing.ts';
import { loadProject, resolveInsideProject, type ProjectHandle } from '../project/manifest.ts';
import { compileDirector, DIRECTOR_SCHEMA } from '../project/director.ts';
import { inspectQuality } from '../project/quality.ts';
import { loadSpecFile, validateSpec } from '../spec/validate.ts';
import { IMPLEMENTED_ENVIRONMENTS } from '../drawing/scenes/registry.ts';
import { BACKDROPS, MOTIFS } from '../spec/motion.ts';
import { CAMERA_MOVES, TRANSITIONS, type ResolvedVideoSpec } from '../spec/types.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { TOOL_REGISTRY } from '../project/tool-registry.ts';
import { GRAPHIC_EASINGS, GRAPHIC_KEYFRAME_CHANNELS, GRAPHIC_KINDS } from '../spec/graphic.ts';
import { appendPromptHistory, readPromptHistory, PROMPT_HISTORY_FILE } from '../project/prompt-history.ts';
import { assertProductionCurrent } from '../application/production-compilation.ts';
import { readNarrationTimings } from '../audio/verify.ts';
import { DOUBAO_VOICES } from '../audio/tts/doubao-voices.ts';

export function capabilities(schema = false): unknown {
  return schema ? DIRECTOR_SCHEMA : {
    contract: 'DirectorPlan@0.1', command: 'node .skill/scripts/video.mjs <slug> capabilities --schema', tools: TOOL_REGISTRY, toolRegistry: '.skill/engine/src/project/tool-registry.ts',
    environments: IMPLEMENTED_ENVIRONMENTS, backdrops: BACKDROPS, motifs: MOTIFS,
     cameraMoves: CAMERA_MOVES, transitions: TRANSITIONS,
    looks: ['graphic'],
    tts: { providers: ['edge', 'doubao', 'file', 'mock'], defaultProvider: 'edge', voicesCommand: 'voices', doubaoVoiceCount: DOUBAO_VOICES.length,
      selection: '默认 edge-tts；用户明确声明使用豆包后，audio/render 显式传入 --tts-provider doubao，voice 匹配对应资源版本与流式接口', apiKeyEnvironment: 'DOUBAO_API_KEY' },
    drawing: { entry: 'project.json.drawing → src/*.mjs|js|ts', export: '同步 drawScene(context, frame)', components: '本片 src/components/ 可编辑副本；easing/random 默认，camera/spring/contour/image-fit/visual-check/text-bounds/region-paint/paper/watercolor/rough 按需选择', guide: process.env.JBM_RUNTIME_ID ? 'guide/workspace.md' : '.skill/references/workspace.md' },
    diagnostics: { command: 'diagnose <项目> --from 0 --to 2 --purpose motion', scope: '当前编码的连续帧差、运动区域、静止帧对比例、跳变候选、帧条与热图；当前源码求值的文字边界', limit: '机器指标提供复核线索；用途、任意裁剪路径、遮挡与正常速度声画判断由当前编码复核' },
    assets: { preparation: 'agent在素材准备阶段核验并调用imagegen；渲染读取本片已保存文件', guide: process.env.JBM_RUNTIME_ID ? 'guide/assets.md' : '.skill/references/assets.md' },
    graphics: { kinds: GRAPHIC_KINDS, keyframes: GRAPHIC_KEYFRAME_CHANNELS, easings: GRAPHIC_EASINGS, time: 'at 为镜头内 0–1 进度', guide: process.env.JBM_RUNTIME_ID ? 'guide/drawing.md' : '.skill/references/drawing.md' },
    creationPolicy: '新片按 guide/intake.md 由模型自主解析一句话需求，推导风格、叙事主轴与记忆点，呈现推荐组合并集中提出关键问题；重要选择有回答或明确委托后制定导演计划。按 guide/direction.md 编排状态与镜头，完整动态粗剪检查全片节奏，正式素材样片验证主体、运镜和转场。技术验收与创作验收分别记录。每片独立设计与记录参考用途；默认 ，指定角色保留辨识依据。全部生成素材、代码、证据与临时文件保存于本片；通用核心保持固定。不同模型与题材使用相同契约。',
    limits: ['共享渲染器使用Canvas 2D；二维与三维候选路径按工具注册表核对，本片使用时先验证依赖和导帧', 'imagegen的当前接口可用性由agent核验，CLI渲染读取固定素材', '音乐为程序化合成', '复杂骨骼、物理仿真、视频生成模型尚未接入'],
  };
}
const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
/** 初始化独立发行包工作区时显式传入 projectsRoot。 */
export function startDirectorProject(options: InitOptions & { readonly idea: string }): InitResult {
  const { slug, idea } = options;
  if (!idea.trim() || idea.length > 5000) throw new EngineError(ERROR_CODES.CLI_USAGE, '--idea 需要 1–5000 个字符');
  const title = options.title ?? slug;
  const result = initProject(options);
  appendPromptHistory(result.dir, 'prompt', idea);
  const manifestPath = join(result.dir, 'project.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.director = 'director.json';
  writeJson(join(result.dir, 'director.json'), { version: '0.1', idea, title, aspect: '16:9', bpm: 96, shots: [] });
  writeJson(manifestPath, manifest);
  const briefPath = join(result.dir, 'brief.json');
  const brief = JSON.parse(readFileSync(briefPath, 'utf8')); brief.intent = idea; writeJson(briefPath, brief);
  writeFileSync(join(result.dir, 'NOTES.md'), `# ${title}\n\n## 原始提示词与问答\n\n原始 prompt、后续修改要求、模型问题与用户答案按时间追加到 ${PROMPT_HISTORY_FILE}，保留原文。director.json 与 brief.json 保存本次制作计划与交付约束。\n\n## 一句话解析与导演推荐\n\n待填写：用户明确要求；模型推断及依据；需要用户决定的缺口；观众应记住的一件事；推荐风格、叙事与理由；备选方向的实际差异；时长、画幅、语气等建议默认值；用户回答或明确委托。解析与问答按guide/intake.md执行。\n\n## 制作约束与参考用途\n\n按 AGENTS.md 自主设计画面；授权参考按本片明确用途登记来源与采用范围，事实依据记录在此。本片生成的输出用于审片，其他项目保持输入隔离。\n\n## 本片视觉设计\n\n待填写：主视觉、叙事主轴与服务核心内容的记忆点；主角轮廓、比例、材质；关键道具与场景构成；动作语言与主题的关系；铺垫、主动作、落定与停留；对应brief.acceptance、全片镜头编排和动态预演结果。默认 ，用 elements 或本片 src/ 原创构图。指定或身份鲜明的角色须记录名称、保留特征与依据；固定吉祥物仅在用户指定该预设时使用。同片保持角色一致。\n\n## 制作状态\n\n先按guide/intake.md用模型解析一句话需求，推荐风格、叙事与记忆点并集中提出关键问题；重要选择有回答或明确委托后再制定剧本与shots。按guide/assets.md核验生图工具并组合素材，按guide/cinematography.md规划运镜；按guide/direction.md先审完整动态粗剪，再审正式素材重点样片；按guide/quality.md分别记录技术与创作验收。生成素材、模型、纹理、依赖副本、预览、日志与临时文件均保存于本片。\n\n## skill 复盘与学习\n\n学习状态：pending。\n\n经明确授权的复盘与适用验证后，登记learned、日期、核心版本、已吸收改进、证据与成片待办，按guide/maintenance.md执行。\n`);
  return result;
}
export function cmdDirect(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, options: { idea: { type: 'string' }, title: { type: 'string' } }, allowPositionals: true });
  const slug = positionals[0];
  if (!slug || !['start', 'compile'].includes(command ?? '')) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: direct start <slug> --idea "想法" 或 direct compile <slug>');
  if (command === 'start') {
    const idea = values.idea;
    if (!idea?.trim() || idea.length > 5000) throw new EngineError(ERROR_CODES.CLI_USAGE, '--idea 需要 1–5000 个字符');
    startDirectorProject({ slug, idea, title: values.title ?? slug });
    process.stdout.write(JSON.stringify({ ok: true, status: 'needs-intake', project: slug, plan: 'director.json', next: 'Agent用模型解析一句话需求，推荐风格、叙事与记忆点，集中提出关键问题；重要选择有回答或明确委托后规划素材、运镜与shots，direct compile、完整动态粗剪、重点样片、qa、render、disclosure与创作验收' }, null, 2) + '\n');
    return 0;
  }
  const project = loadProject(slug);
  assertLegacyAuthority(project);
  if (!project.manifest.director) throw new EngineError(ERROR_CODES.PROJECT_INVALID, 'project.json 需要 director 路径');
  const { plan, spec } = compileDirector(JSON.parse(readFileSync(resolveInsideProject(project.dir, project.manifest.director, 'director'), 'utf8')));
  const quality = inspectQuality(spec);
  if (!quality.ok) throw new EngineError(ERROR_CODES.SPEC_INVALID, '导演计划质量检查失败', { details: { issues: quality.issues } });
  if (!project.briefPath) throw new EngineError(ERROR_CODES.PROJECT_INVALID, '导演项目需要 brief.json');
  const brief = JSON.parse(readFileSync(project.briefPath, 'utf8'));
  // Preserve user-authored tool/asset/claim constraints; update only compiler-owned deliverables.
  brief.intent = plan.idea;
  brief.deliverable = { ...brief.deliverable, duration: spec.video.duration, aspect: plan.aspect, fps: spec.video.fps, captions: spec.captions.enabled ? 'both' : 'none' };
  writeJson(project.specPath, spec);
  writeJson(project.briefPath, brief);
  process.stdout.write(JSON.stringify({ ok: true, duration: spec.video.duration, shots: spec.scenes.length, quality }, null, 2) + '\n');
  return 0;
}
export function cmdPrompt(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options: {
    kind: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' },
  }, allowPositionals: true });
  if (positionals.length !== 1) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: prompt <项目> [--kind prompt|question|answer --text "原文" | --file 本片文件]');
  const project = loadProject(positionals[0]!);
  if (!values.kind && values.text === undefined && values.file === undefined) {
    process.stdout.write(JSON.stringify(readPromptHistory(project.dir), null, 2) + '\n');
    return 0;
  }
  if (!values.kind || (values.text === undefined) === (values.file === undefined)) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '记录须指定 --kind，并从 --text 或 --file 选择一个原文来源');
  }
  const text = values.file !== undefined ? readFileSync(resolveInsideProject(project.dir, values.file, 'prompt input'), 'utf8') : values.text!;
  appendPromptHistory(project.dir, values.kind, text);
  process.stdout.write(JSON.stringify({ ok: true, path: PROMPT_HISTORY_FILE, entries: readPromptHistory(project.dir).length }) + '\n');
  return 0;
}
export async function cmdQuality(target: string): Promise<number> {
  const project = loadProject(target);
  const isProduction = existsSync(join(project.dir, 'production/manifest.json'));
  if (!isProduction) assertLegacyAuthority(project);
  const outcome = validateSpec(loadSpecFile(project.specPath));
  if (!outcome.spec) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'spec 无法解析');
  if (isProduction) {
    const { compiled, projection } = await assertProductionCurrent(project.dir, outcome.spec);
    const report = inspectQuality(outcome.spec, { measuredNarration: compiled.narrationTimings, captionCues: compiled.captionCues, customDrawing: true });
    process.stdout.write(JSON.stringify({ ...report, projection, timelineConflicts: compiled.conflicts, visualReview: 'pending: inspect and listen to the full film' }, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }
  const drawing = await loadProjectDrawing(project);
  const measuredNarration = readNarrationTimings([
    resolveInsideProject(project.dir, join(project.manifest.outDir, 'audio/narration-timing.json'), 'audio timing'),
    resolveInsideProject(project.dir, join(project.manifest.outDir, 'audio-preflight/narration-timing.json'), 'audio timing'),
  ], outcome.spec);
  const report = inspectQuality(outcome.spec, { measuredNarration, customDrawing: Boolean(drawing) });
  const planIssues: string[] = [];
  if (project.manifest.director) {
    const expected = compileDirector(JSON.parse(readFileSync(resolveInsideProject(project.dir, project.manifest.director, 'director'), 'utf8'))).spec;
    if (!isDeepStrictEqual(expected, outcome.spec)) planIssues.push('DIRECTOR_STALE: director.json 已变化，请重新 direct compile');
  }
  const ok = report.ok && outcome.issues.length === 0 && planIssues.length === 0;
  process.stdout.write(JSON.stringify({ ...report, ok, specIssues: outcome.issues, planIssues, visualReview: 'pending: 请检查分镜、转场及完整视频，结构检查不评判审美' }, null, 2) + '\n');
  return ok ? 0 : 1;
}

/** A new idea or changed plan must be compiled before production rendering. */
function assertLegacyAuthority(project: ProjectHandle): void {
  if (existsSync(join(project.dir, 'production/manifest.json'))) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'PRODUCTION_TIMELINE_REQUIRED: 先从当前 production 权威计划生成已验证时间线');
}
export function assertDirectorCurrent(project: ProjectHandle, spec: ResolvedVideoSpec): void {
  assertLegacyAuthority(project);
  if (!project.manifest.director) return;
  const expected = compileDirector(JSON.parse(readFileSync(resolveInsideProject(project.dir, project.manifest.director, 'director'), 'utf8'))).spec;
  if (!isDeepStrictEqual(expected, spec)) throw new EngineError(ERROR_CODES.SPEC_INVALID, 'DIRECTOR_STALE: 请先运行 direct compile');
  const report = inspectQuality(spec);
  if (!report.ok) throw new EngineError(ERROR_CODES.SPEC_INVALID, '导演项目质量检查失败', { details: { issues: report.issues } });
}
