/**
 * 运动能力冒烟：关键帧相机 + 焦点钻入（zoomIntoElement）+ 素材片段（推拉摇 / 变速 / 调色）+ 文字→时长。
 * 素材由 ffmpeg 程序化生成（无版权素材），所有产物写入 output/motion-smoke（gitignored）。
 * 用法：node scripts/motion-smoke.ts [outDir] [vertical|horizontal]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateSpec } from '../src/spec/validate.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { renderVideo } from '../src/pipeline/render-video.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { loadBrand } from '../src/themes/index.ts';
import { planShotTimings } from '../src/motion/shot-timing.ts';
import { cameraMove, push } from '../src/motion/camera-path.ts';
import { outputPath } from '../src/utils/output-dir.ts';

const out = process.argv[2] || outputPath('motion-smoke');
const horizontal = process.argv[3] === 'horizontal';
const [W, H] = horizontal ? [1920, 1080] : [1080, 1920];
const FPS = 30;
const assets = join(out, 'assets'); mkdirSync(assets, { recursive: true });
// 程序化素材：6 秒的分形缩放视频（有纹理、自带运动，代替真实素材）
const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `mandelbrot=size=1920x1080:rate=30:start_scale=2.5:end_scale=0.6:outer=normalized_iteration_count,trim=duration=6,hue=h=150:s=0.6`, '-pix_fmt', 'yuv420p', join(assets, 'lake.mp4')]);
if (gen.status !== 0) throw new Error(`ffmpeg 生成素材失败：${gen.stderr}`);

const plan = planShotTimings([['先看全局'], ['再钻进', '一个细节'], ['素材', '也能被推拉摇'], ['ONEINO.澄记']], { beat: 0.5 });
const [a, b, c, d] = plan;
const raw = {
  video: { width: W, height: H, fps: FPS, duration: d!.end, seed: 20261013 },
  captions: { enabled: false },
  scenes: [
    { id: 'push', start: a!.start, end: a!.end, environment: 'theme_stage', headline: [...a!.lines],
      cameraPath: cameraMove('openingPull', a!.end - a!.start), // 开场反向拉 1.2→1.0
      focus: { x: 0.3, y: 0.4, w: 0.4, h: 0.08 } },
    { id: 'detail', start: b!.start, end: b!.end, environment: 'theme_stage', transition: 'zoomIntoElement', headline: [...b!.lines],
      cameraPath: push(1, 1.12, b!.end - b!.start, { x: 0.5, y: 0.47 }) }, // 讲解推镜 1.0→1.12
    { id: 'footage', start: c!.start, end: c!.end, environment: 'footage', transition: 'blurDissolve',
      footage: { src: 'lake.mp4', in: 0.5, speed: 0.75, kenBurns: { from: { x: 0.35, y: 0.5, zoom: 1.15 }, to: { x: 0.6, y: 0.45, zoom: 1.3 } }, color: { exposure: 0.15, contrast: 1.08, saturation: 1.1, temperature: 0.25, vignette: 0.5 } } },
    { id: 'end', start: d!.start, end: d!.end, environment: 'theme_stage', transition: 'blurDissolve', headline: [...d!.lines] },
  ],
};
const { spec, issues } = validateSpec(raw, { brand: loadBrand() });
if (!spec) throw new Error('spec 无效');
const warnings: string[] = [];
const renderer = createSpecRenderer({ spec, assetRoot: assets, onWarning: (m) => warnings.push(m) });
const name = horizontal ? 'motion-horizontal' : 'motion-vertical';
const res = await renderVideo({ renderer, fps: FPS, durationSeconds: spec.video.duration, seed: spec.video.seed, outPath: join(out, `${name}.mp4`) });
const frameAt = (t: number) => { renderer.renderFrame(makeFrameContext({ frameIndex: Math.round(t * FPS), totalFrames: Math.round(spec.video.duration * FPS), fps: FPS, width: W, height: H, seed: spec.video.seed })); return renderer.toPng(); };
const stills = [0, a!.end - 0.3, b!.start + 0.1, b!.start + 0.25, c!.start + 0.4, c!.end - 0.3, d!.start + 0.6];
stills.forEach((t, i) => writeFileSync(join(out, `${name}_${i}_${t.toFixed(2)}s.png`), frameAt(t)));
renderer.dispose();
console.log(JSON.stringify({ out, plan: plan.map((p) => [p.start, p.end]), frames: res.frames, msPerFrame: Math.round(res.msPerFrame), issues: issues.filter((i) => i.severity !== 'SAFE_REPAIR').map((i) => i.code), warnings }));
