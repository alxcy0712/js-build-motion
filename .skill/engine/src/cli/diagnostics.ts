import { prepareQualityDrawing } from './layout.ts';
import { inspectLayout, type LayoutIssue } from '../layout/check.ts';
import { frame as layoutFrame } from '../layout/tools.ts';
import { reviewStillness } from '../qa/motion.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { Canvas } from 'skia-canvas';
import { frameDifference, summarizeFramePairs, FRAME_DIAGNOSTIC_DEFAULTS, type FramePair } from '../drawing/primitives/visual-check.ts';
import { textOutside, type TextDraw } from '../drawing/primitives/text-bounds.ts';
import { inspectArtifact } from '../project/artifact.ts';
import { loadProject, resolveInsideProject } from '../project/manifest.ts';
import { assertContained, assertOutputTree } from '../project/paths.ts';
import { createSpecRenderer } from '../pipeline/spec-renderer.ts';
import { makeFrameContext } from '../renderer/renderer.ts';
import { frameCount } from '../timeline/frame.ts';
import { probeMedia } from '../ffmpeg/encoder.ts';
import { loadSpecFile, validateSpec } from '../spec/validate.ts';
import { readNarrationTimings } from '../audio/verify.ts';
import { readRunLog } from '../project/run-log.ts';
import { sha256File } from '../utils/hash.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';

/** Keep one partial raw frame; consume the decoder stream with backpressure. */
async function decodeFrames(input: string, select: string, count: number, width: number, height: number, consume: (rgba: Buffer, index: number) => void): Promise<void> {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-an', '-vf', `select='${select}',scale=${width}:${height}`, '-frames:v', String(count), '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = '', pending = Buffer.alloc(0), index = 0;
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  // Attach immediately, including spawn failures that precede stdout consumption.
  done.catch(() => {});
  child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
  const bytes = width * height * 4;
  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= bytes) { consume(pending.subarray(0, bytes), index++); pending = pending.subarray(bytes); }
    }
    if (await done !== 0) throw new Error(`FRAME_DECODE: ${error}`);
    if (pending.length || index !== count) throw new Error(`FRAME_DECODE_COUNT: expected ${count}, got ${index}`);
  } finally { if (child.exitCode === null) child.kill(); }
}

export async function cmdDiagnose(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    from: { type: 'string' }, to: { type: 'string' }, width: { type: 'string' }, 'out-dir': { type: 'string' },
    purpose: { type: 'string' }, 'pixel-threshold': { type: 'string' }, 'static-area': { type: 'string' }, 'jump-factor': { type: 'string' },
  }, allowPositionals: true });
  const usage = (message: string): never => { throw new EngineError(ERROR_CODES.CLI_USAGE, message); };
  if (positionals.length !== 1) usage('diagnose <项目> --from 秒 --to 秒 [--purpose motion|hold|step|transition|reading]');
  const project = loadProject(positionals[0]!);
  const identity = inspectArtifact(project);
  if (!identity.ok || !identity.artifact) throw new EngineError(ERROR_CODES.PROJECT_INVALID, '先核对当前成片与 run.json，再运行 diagnose', { details: { issues: identity.issues } });
  const run = readRunLog(join(project.dir, 'run.json'));
  const { spec } = validateSpec(loadSpecFile(project.specPath));
  if (!spec) usage('诊断需要有效的当前规格');
  const input = resolveInsideProject(project.dir, identity.artifact.path, 'encoded artifact');
  const media = probeMedia(input), video = media.video;
  const total = frameCount(spec!.video.fps, spec!.video.duration);
  if (!video || Math.abs(video.fps - spec!.video.fps) > 1e-6 || video.frameCount !== total) usage('诊断当前核心的固定帧率成片：实际 fps 和帧数须与规格一致');
  const fps = video!.fps, from = Number(values.from ?? 0), to = Number(values.to ?? Math.min(total / fps, from + 10));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > total / fps + 1e-6) usage('取样窗口须在编码时长内，采用 [from, to)');
  const first = Math.ceil(from * fps - 1e-8), last = Math.min(total - 1, Math.ceil(to * fps - 1e-8) - 1), count = last - first + 1;
  if (count < 2 || count > 1200) usage('每次连续取样 2–1200 帧；长片分窗口诊断');
  const width = Number(values.width ?? 360), height = Math.round(width * video!.height / video!.width);
  if (!Number.isInteger(width) || width < 32 || width > 1920 || height < 1 || height > 4096) usage('诊断宽度须为 32–1920 整数，按成片比例缩放');
  const purpose = values.purpose ?? 'motion';
  if (!['motion', 'hold', 'step', 'transition', 'reading'].includes(purpose)) usage('purpose: motion|hold|step|transition|reading');
  const thresholds = { ...FRAME_DIAGNOSTIC_DEFAULTS, pixelThreshold: Number(values['pixel-threshold'] ?? FRAME_DIAGNOSTIC_DEFAULTS.pixelThreshold), staticArea: Number(values['static-area'] ?? FRAME_DIAGNOSTIC_DEFAULTS.staticArea), jumpFactor: Number(values['jump-factor'] ?? FRAME_DIAGNOSTIC_DEFAULTS.jumpFactor) };
  // Validate thresholds before any rendering or output.
  summarizeFramePairs([], fps, thresholds);
  const heat = new Uint32Array(width * height), pairs: FramePair[] = [];
  const timingPath = join(project.outDir, 'audio/narration-timing.json');
  const measuredNarration = run.facts.providers.tts === '(none)' ? undefined : readNarrationTimings([timingPath], spec!);
  const timingHash = measuredNarration && existsSync(timingPath) ? sha256File(timingPath) : null;
  const prepared = await prepareQualityDrawing(project, spec!);
  const renderer = createSpecRenderer({ spec: spec!, width: video!.width, height: video!.height, drawScene: prepared.drawScene, captionCues: prepared.captionCues, measuredNarration: prepared.measuredNarration ?? measuredNarration, captions: run.facts.captions.insideFrame, trackText: true, trackLayout: true });
  const layoutIssues: LayoutIssue[] = [], layoutLimits = new Set<string>();
  const layoutPendingFrames: number[] = [];
  const textIssues: { frame: number; time: number; draws: TextDraw[] }[] = [];
  let previous: Buffer | undefined, textDrawCount = 0;
  try {
    await decodeFrames(input, `between(n,${first},${last})`, count, width, height, (data, index) => {
      const frame = first + index;
      if (previous) pairs.push({ from: frame - 1, to: frame, ...frameDifference({ width, height, data: previous }, { width, height, data }, thresholds.pixelThreshold, heat) });
      previous = Buffer.from(data);
      renderer.renderFrame(makeFrameContext({ frameIndex: frame, totalFrames: total, fps, width: video!.width, height: video!.height, seed: spec!.video.seed }));
      const layout = inspectLayout(renderer.layoutTrace()!, { frame, fps, width: video!.width, height: video!.height, safe: layoutFrame(video!.width, video!.height).safe, plan: spec!.layout });
      if (layout.status === 'pending') layoutPendingFrames.push(frame);
      layoutIssues.push(...layout.issues); layout.limitations.forEach(l => layoutLimits.add(l));
      const draws = renderer.textBounds();
      textDrawCount += draws.length;
      const outside = draws.filter(draw => draw.sourceClipped || textOutside(draw.bounds, video!.width, video!.height));
      if (outside.length) textIssues.push({ frame, time: frame / fps, draws: [...outside] });
    });
    await prepared.verify();
  } finally { renderer.dispose(); prepared.close(); }
  const summary = summarizeFramePairs(pairs, fps, thresholds);
  const candidates = [...summary.jumps.flatMap(p => [p.from - 1, p.from, p.to, p.to + 1]), ...textIssues.flatMap(p => [p.frame - 1, p.frame, p.frame + 1]), ...layoutIssues.map(i => i.frame)];
  const selected = [...new Set([first, Math.floor((first + last) / 2), last, ...candidates.filter(f => f >= first && f <= last)])].slice(0, 24).sort((a, b) => a - b);
  const cols = Math.min(4, selected.length), labelHeight = 22, stripWidth = Math.min(width, 360), stripHeight = Math.round(stripWidth * video!.height / video!.width);
  const strip = new Canvas(stripWidth * cols, (stripHeight + labelHeight) * Math.ceil(selected.length / cols)), stripCtx = strip.getContext('2d');
  stripCtx.fillStyle = '#151e25'; stripCtx.fillRect(0, 0, strip.width, strip.height);
  const tile = new Canvas(stripWidth, stripHeight), tileCtx = tile.getContext('2d');
  await decodeFrames(input, selected.map(f => `eq(n,${f})`).join('+'), selected.length, stripWidth, stripHeight, (data, index) => {
    const pixels = tileCtx.createImageData(stripWidth, stripHeight); pixels.data.set(data); tileCtx.putImageData(pixels, 0, 0);
    const x = (index % cols) * stripWidth, y = Math.floor(index / cols) * (stripHeight + labelHeight);
    stripCtx.drawImage(tile, x, y + labelHeight);
    stripCtx.font = '12px sans-serif'; stripCtx.fillStyle = '#ffffff'; stripCtx.fillText(`frame ${selected[index]} | ${(selected[index]! / fps).toFixed(3)}s`, x + 6, y + 15);
  });
  const heatmap = new Canvas(width, height), heatCtx = heatmap.getContext('2d'), heatPixels = heatCtx.createImageData(width, height);
  let peak = 0;
  for (const value of heat) peak = Math.max(peak, value);
  for (let p = 0; p < heat.length; p++) { const v = heat[p]! / Math.max(1, peak), i = p * 4; heatPixels.data.set([20 + 235 * v, 28 + 62 * v, 35, 255], i); }
  heatCtx.putImageData(heatPixels, 0, 0);
  const after = inspectArtifact(project);
  if (!after.ok || JSON.stringify(after.artifact) !== JSON.stringify(identity.artifact) || (timingHash && sha256File(timingPath) !== timingHash)) throw new Error('DIAGNOSTIC_INPUT_CHANGED');
  const outDir = assertContained(project.outDir, resolveInsideProject(project.dir, values['out-dir'] ?? join(project.manifest.outDir, `diagnostics/${first}-${last}`), 'diagnostic output'));
  assertOutputTree(outDir); mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'frame-strip.png'), strip.toBufferSync('png'));
  writeFileSync(join(outDir, 'motion-heatmap.png'), heatmap.toBufferSync('png'));
  const layoutOk = !layoutIssues.some(i => i.severity === 'error');
  const report = { ok: layoutOk, layout: { ok: layoutOk, status: !layoutOk ? 'error' : layoutPendingFrames.length ? 'pending' : 'pass', pendingFrames: layoutPendingFrames, issues: layoutIssues, limitations: [...layoutLimits] }, stillness: reviewStillness(summary.holds.map(h => ({ start: h.start, end: h.end })), spec!.layout?.holds ?? (purpose === 'hold' || purpose === 'reading' ? [{start: from, end: to, purpose, reason: 'diagnose purpose'}] : [])), scope: 'review-candidates', artifact: identity.artifact, purpose,
    window: { requestedFrom: from, requestedTo: to, firstFrame: first, lastFrame: last, firstTime: first / fps, lastTime: last / fps, fps, sampledFrames: count, width, height, sourceWidth: video!.width, sourceHeight: video!.height },
    thresholds, summary, pairs, text: { scope: 'source-glyph-bounds', frames: count, drawCount: textDrawCount, issues: textIssues,
      captionsInsideFrame: run.facts.captions.insideFrame, timing: { scope: 'current-spec-cache', path: timingHash ? relative(project.dir, timingPath) : null, sha256: timingHash, measured: Boolean(measuredNarration) },
      coverage: 'fillText/strokeText on main canvas and pipeline incoming canvas; current camera and drawImage transforms, glyph metrics and explicit source rectangles',
      limits: 'clip paths, occlusion, shadows, filters, bitmap/path text and untracked custom offscreen canvases require raster review; transformed boxes are conservative; current timing cache has a separate identity from encoded audio' },
    evidence: { strip: 'frame-strip.png', stripWidth, stripHeight, stripFrames: selected, omittedCandidateFrames: new Set(candidates.filter(f => f >= first && f <= last && !selected.includes(f))).size, heatmap: 'motion-heatmap.png', heatPeakPairs: peak, heatNormalization: 'changed pair count / peak per pixel' },
    interpretation: 'Motion area includes subject, camera, captions and texture. Review holds by shot purpose; steps, cuts, intentional flashes and reading may explain jumps or stillness. Source text bounds and encoded pixels have separate scopes.',
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ok: layoutOk, layoutIssueFrames: new Set(layoutIssues.map(i => i.frame)).size, scope: report.scope, outDir: relative(project.dir, outDir), artifact: identity.artifact, window: report.window, summary, textIssueFrames: textIssues.length, evidence: report.evidence }, null, 2) + '\n');
  return layoutOk ? 0 : 1;
}
