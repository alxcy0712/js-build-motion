import { assertDirectorCurrent } from './director.ts';
import { assertProductionCurrent, productionMediaPaths } from '../application/production-compilation.ts';
import { buildProductionAudio } from '../audio/production.ts';
import { createProductionDrawing } from '../pipeline/production-drawing.ts';
import { inspectQuality } from '../project/quality.ts';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { PROJECT_ROOT, checkEnvironment, dependencyVersion } from '../utils/env.ts';
import { sha256File } from '../utils/hash.ts';
import { frameCount, secondsToFrame } from '../timeline/frame.ts';
import { makeFrameContext } from '../renderer/renderer.ts';
import { createSpecRenderer } from '../pipeline/spec-renderer.ts';
import { loadProjectDrawing, projectSourceHashes } from '../project/drawing.ts';
import { promptHistorySnapshot } from '../project/prompt-history.ts';
import { DEFAULT_ASSET_PLAN_PATH, prepareAssetPlan, assertAssetPlanSnapshot } from '../application/asset-plan.ts';
import { createAssetPort } from '../adapters/asset-port.ts';
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
import { beginRenderAttempt, loadAttemptDrawing, commitRenderAttempt, failRenderAttempt, type RenderAttempt } from '../project/attempt.ts';
import { readNarrationTimings, verifyVoicePresence } from '../audio/verify.ts';
import type { AudioTrack } from '../audio/types.ts';
import { projectDir, resolveInsideProject, resolveTarget, type ProjectHandle } from '../project/manifest.ts';
import { loadBriefFile, validateBrief, type BriefAsset } from '../project/brief.ts';
import { audioArtifactHashes, buildFacts, buildMeasured, buildRunLog, repoRelative, runLogPathFor, writeRunLog } from '../project/run-log.ts';
import { outputPath, baseOutDir, requireTarget } from './shared.ts';
import { run } from './index.ts';

/** Previews consume the same authority, media and project drawing as encoded renders. */
async function preparePreview(project: ProjectHandle | null, spec: ResolvedVideoSpec) {
  const production = project && existsSync(join(project.dir, 'production/manifest.json'))
    ? await assertProductionCurrent(project.dir, spec) : null;
  if (project && !production) assertDirectorCurrent(project, spec);
  const plan = project && existsSync(join(project.dir, DEFAULT_ASSET_PLAN_PATH)) ? await prepareAssetPlan(project.dir) : null;
  const assets = project ? createAssetPort(project.dir, plan, { attemptId: 'preview', inputSnapshotSha256: sha256File(project.specPath) }) : undefined;
  try {
    const drawing = await loadProjectDrawing(project, assets?.port);
    return { drawScene: production ? await createProductionDrawing(production.compiled, assets!.port, production.projection.profile, drawing) : drawing,
      captionCues: production?.compiled.captionCues, assets };
  } catch (error) { assets?.close(); throw error; }
}

export async function cmdFrame(argv: string[]): Promise<number> {
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
  const preview = await preparePreview(target.project, spec);
  const drawScene = preview.drawScene;
  const renderer = createSpecRenderer({
    spec,
    width,
    height,
    ...(drawScene ? { drawScene } : {}),
    ...(preview.captionCues ? { captionCues: preview.captionCues } : {}),
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
    await preview.assets?.verify();

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
    preview.assets?.close();
  }
}
export async function cmdStoryboard(argv: string[]): Promise<number> {
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
  const preview = await preparePreview(target.project, spec);
  const drawScene = preview.drawScene;
  const renderer = createSpecRenderer({
    spec,
    width,
    height,
    ...(drawScene ? { drawScene } : {}),
    ...(preview.captionCues ? { captionCues: preview.captionCues } : {}),
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
    await preview.assets?.verify();
  } finally {
    renderer.dispose();
    preview.assets?.close();
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
export async function cmdAudio(argv: string[]): Promise<number> {
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
export async function cmdRender(argv: string[]): Promise<number> {
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
  if (production && (values['no-audio'] || values['audio-lock'] || values['tts-provider'] || values['asset-plan'] || values['no-captions'])) throw Error('PRODUCTION_TIMELINE_CONTROLS_REQUIRED');
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
    const projectDrawing = attempt ? await loadAttemptDrawing(attempt, assets?.port) : await loadProjectDrawing(project, assets?.port);
    const drawScene = production ? await createProductionDrawing(production.compiled, assets!.port, production.projection.profile, projectDrawing)
      : projectDrawing;
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
    await assets?.verify();
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
export function cmdSubtitles(argv: string[]): number {
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
