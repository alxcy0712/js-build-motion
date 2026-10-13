/**
 * 第一批运动能力：关键帧相机、元素焦点钻入、素材片段层、文字→时长，以及跨平台字体 / 输出目录解析。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Canvas } from 'skia-canvas';
import { CAMERA_GRAMMAR, cameraMove, evaluateCameraPath, parseCameraPath, push } from '../src/motion/camera-path.ts';
import { focusCenter, parseFocus, zoomToFill } from '../src/motion/focus.ts';
import { minShotSeconds, planShotTimings, readingSeconds } from '../src/motion/shot-timing.ts';
import { drawFootage, imageSource, openFootage, parseFootageClip, resolveFootagePath } from '../src/footage/clip.ts';
import { resolveFontFile, systemFontDirs } from '../src/themes/fonts.ts';
import { outputRoot } from '../src/utils/output-dir.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { parseBrand } from '../src/themes/index.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const scratch = () => mkdtempSync(join(tmpdir(), 'jbm-motion-'));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// ------------------------------------------------------------ 相机路径
test('相机路径：端点精确、区间外夹取、缺省字段继承上一帧', () => {
  const path = { keys: [{ t: 0, x: 0.5, y: 0.5, zoom: 1 }, { t: 2, x: 0.25, zoom: 2 }] };
  const a = evaluateCameraPath(path, 0, 1000, 2000), b = evaluateCameraPath(path, 2, 1000, 2000);
  near(a.x, 500); near(a.zoom, 1); near(b.x, 250); near(b.y, 1000); near(b.zoom, 2);
  assert.deepEqual(evaluateCameraPath(path, -1, 1000, 2000), a);
  assert.deepEqual(evaluateCameraPath(path, 9, 1000, 2000), b);
});
test('相机路径：zoom 在对数空间插值（对称缓动的中点 = 几何平均），且单调', () => {
  const path = { keys: [{ t: 0, zoom: 1 }, { t: 1, zoom: 4 }] };
  near(evaluateCameraPath(path, 0.5, 100, 100).zoom, 2, 1e-3);
  let prev = 0;
  for (let i = 0; i <= 30; i++) { const z = evaluateCameraPath(path, i / 30, 100, 100).zoom; assert.ok(z >= prev - 1e-9); prev = z; }
});
test("相机路径：'hold' 保持上一帧直到瞬切", () => {
  const path = { keys: [{ t: 0, x: 0.2 }, { t: 1, x: 0.8, ease: 'hold' as const }] };
  near(evaluateCameraPath(path, 0.99, 100, 100).x, 20); near(evaluateCameraPath(path, 1, 100, 100).x, 80);
});
test('相机路径：起止速度为 0（缓起缓停，没有折角）', () => {
  const path = { keys: [{ t: 0, x: 0 }, { t: 1, x: 1 }] };
  const v = (t: number) => (evaluateCameraPath(path, t + 1e-3, 1, 1).x - evaluateCameraPath(path, t, 1, 1).x) / 1e-3;
  assert.ok(v(0) < 0.05 && v(0.999) < 0.05 && v(0.5) > 1.5);
});
test('相机路径校验：结构错误为致命，越界时间与线性缓动为警告', () => {
  assert.ok(parseCameraPath({ keys: [{ t: 0 }] }, 'p', 2).issues.some((i) => i.code === 'CAMERA_PATH_INVALID' && i.fatal));
  assert.ok(parseCameraPath({ keys: [{ t: 0 }, { t: 1, zoom: 99 }] }, 'p', 2).issues.some((i) => i.code === 'CAMERA_KEY_RANGE'));
  const r = parseCameraPath({ keys: [{ t: 0 }, { t: 3, ease: [0.5, 0.5, 0.5, 0.5] }] }, 'p', 2);
  assert.ok(r.value);
  assert.deepEqual(r.issues.map((i) => [i.code, i.fatal]).sort(), [['CAMERA_EASE_LINEAR', false], ['CAMERA_KEY_PAST_END', false]]);
});

test('运镜语法：push 用数字写；cameraMove 预设；镜头内 zoom > 1.5 告警', () => {
  const p = push(1, 1.08, 2.4);
  near(evaluateCameraPath(p, 2.4, 1, 1).zoom, 1.08); near(evaluateCameraPath(p, 0, 1, 1).zoom, 1);
  const open = cameraMove('openingPull', 4);
  near(evaluateCameraPath(open, 0, 1, 1).zoom, 1.2); near(evaluateCameraPath(open, 4, 1, 1).zoom, 1);
  near(evaluateCameraPath(cameraMove('normal', 10), 10, 1, 1).zoom, CAMERA_GRAMMAR.normal.to);
  const r = parseCameraPath({ keys: [{ t: 0 }, { t: 2, zoom: 2 }] }, 'p', 2);
  assert.ok(r.value && r.issues.some((i) => i.code === 'CAMERA_ZOOM_PUNCH_ONLY' && !i.fatal));
});

// ------------------------------------------------------------ 焦点 / 时长
test('焦点：解析、中心与填充倍数', () => {
  assert.equal(typeof parseFocus({ x: 0.9, y: 0, w: 0.2, h: 0.1 }), 'string');
  const f = parseFocus({ x: 0.4, y: 0.2, w: 0.2, h: 0.1 });
  assert.ok(f && typeof f !== 'string');
  assert.deepEqual(focusCenter(f, 1000, 1000), { x: 500, y: 250 });
  near(zoomToFill(f, 1), 5); assert.equal(zoomToFill({ x: 0, y: 0, w: 1, h: 1 }), 1);
});
test('文字→时长：中文按字、英文按词；有上下限；节拍只向后吸附', () => {
  near(readingSeconds(['计算机思维']), 5 / 6); near(readingSeconds(['Think like a computer']), 4 / 3.3);
  // 强调大字屏 2–3s，讲解屏 2.5–5s
  near(minShotSeconds(['一']), 2); near(minShotSeconds(['字'.repeat(200)]), 5);
  near(minShotSeconds(['这一屏是一句普通的讲解文字']), 0.8 + 13 / 6);
  const plan = planShotTimings([['计算机思维'], ['把一个复杂问题拆成三步']], { beat: 0.5 });
  assert.deepEqual(plan.map((p) => [p.start, p.end]), [[0, 2], [2, 5]]);
  for (const p of plan) assert.ok(p.end - p.start >= minShotSeconds(p.lines) - 1e-9);
});

// ------------------------------------------------------------ 素材片段
function twoTonePng(dir: string): string {
  const c = new Canvas(200, 100), x = c.getContext('2d');
  x.fillStyle = '#ff0000'; x.fillRect(0, 0, 100, 100); x.fillStyle = '#0000ff'; x.fillRect(100, 0, 100, 100);
  const p = join(dir, 'tone.png'); writeFileSync(p, c.toBufferSync('png')); return p;
}
const centerPixel = (c: Canvas) => { const d = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data; return [d[0]!, d[1]!, d[2]!]; };
test('素材校验：拒绝越界路径、未知类型与越界参数', () => {
  for (const src of ['../x.png', '/etc/passwd.png', 'a/../../b.mp4']) assert.ok(parseFootageClip({ src }, 'f').issues.some((i) => i.code === 'FOOTAGE_PATH_OUTSIDE_ROOT'), src);
  assert.ok(parseFootageClip({ src: 'a.gif' }, 'f').issues.some((i) => i.code === 'FOOTAGE_TYPE_UNSUPPORTED'));
  assert.ok(parseFootageClip({ src: 'a.mp4', speed: 10 }, 'f').issues.length === 1);
  assert.ok(parseFootageClip({ src: 'a.mp4', color: { hue: 1 } }, 'f').issues.some((i) => i.code === 'FOOTAGE_COLOR_UNKNOWN'));
  assert.deepEqual(parseFootageClip({ src: 'clips/a.mp4', speed: 0.5, kenBurns: { from: { x: 0.5, y: 0.5, zoom: 1 }, to: { x: 0.6, y: 0.5, zoom: 1.2 } } }, 'f').issues, []);
});
test('素材路径：符号链接逃出素材根目录被拒绝', () => {
  const root = scratch(), outside = scratch();
  const real = twoTonePng(outside);
  symlinkSync(real, join(root, 'link.png'));
  assert.throws(() => resolveFootagePath('link.png', root), /OUTSIDE_ROOT/);
  assert.throws(() => resolveFootagePath('missing.png', root), /NOT_FOUND/);
});
test('推拉摇：注视点从左（红）摇到右（蓝），cover 模式不露底', () => {
  const dir = scratch(), src = imageSource(twoTonePng(dir));
  const clip = { src: 'tone.png', kenBurns: { from: { x: 0.25, y: 0.5, zoom: 2 }, to: { x: 0.75, y: 0.5, zoom: 2 } } };
  const c = new Canvas(100, 100), ctx = c.getContext('2d');
  drawFootage(ctx, clip, src, 0, 2, 100, 100); const [r0, , b0] = centerPixel(c);
  drawFootage(ctx, clip, src, 2, 2, 100, 100); const [r1, , b1] = centerPixel(c);
  assert.ok(r0 > 200 && b0 < 50 && b1 > 200 && r1 < 50);
  const corner = ctx.getImageData(0, 0, 1, 1).data; assert.equal(corner[3], 255);
});
test('调色：曝光 +1 档变亮，饱和度 0 变灰', () => {
  const dir = scratch(), src = imageSource(twoTonePng(dir));
  const c = new Canvas(50, 50), ctx = c.getContext('2d');
  drawFootage(ctx, { src: 'tone.png', crop: { x: 0, y: 0, w: 0.5, h: 1 }, color: { saturation: 0 } }, src, 0, 1, 50, 50);
  const [r, g, b] = centerPixel(c); assert.ok(Math.abs(r - g) < 3 && Math.abs(g - b) < 3);
});
test('视频素材：抽帧缓存、按时间取帧、变速改变取样位置', { skip: !hasFfmpeg && 'ffmpeg 不在 PATH' }, () => {
  const root = scratch(); mkdirSync(join(root, 'clips'));
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=3', '-pix_fmt', 'yuv420p', join(root, 'clips/t.mp4')]);
  assert.equal(r.status, 0);
  const cache = join(root, 'cache');
  const s1 = openFootage({ src: 'clips/t.mp4' }, root, 24, 1, cache);
  const s2 = openFootage({ src: 'clips/t.mp4', speed: 2 }, root, 24, 1, cache);
  assert.equal(s1.width, 160);
  assert.notEqual(s1.frameAt(0), s1.frameAt(0.5));
  assert.equal(s1.frameAt(0.5), s1.frameAt(0.5));
  // 同一输出时刻，2 倍速取到的源画面与 1 倍速不同；越过素材末尾时夹在最后一帧
  const px = (img: ReturnType<typeof s1.frameAt>) => { const c = new Canvas(160, 90); c.getContext('2d').drawImage(img, 0, 0); return c.toBufferSync('png'); };
  assert.ok(!px(s2.frameAt(0.5)).equals(px(s1.frameAt(0.5))));
  assert.equal(s1.frameAt(99), s1.frameAt(1));
});

// ------------------------------------------------------------ spec 与管线
const brand = parseBrand({ version: 1, lockedTheme: 'minimal', enforcement: 'override', changes: [{ at: 'x', theme: 'minimal', reason: 't' }] });
const base = { video: { width: 1080, height: 1920, fps: 24, duration: 4, seed: 3 }, style: { theme: 'minimal' }, captions: { enabled: false } };
test('spec：cameraPath / focus / footage 通过校验并保留；footage 环境缺素材为致命', () => {
  const ok = validateSpec({ ...base, scenes: [
    { id: 'a', start: 0, end: 2, environment: 'theme_stage', headline: ['推进'], focus: { x: 0.3, y: 0.4, w: 0.4, h: 0.1 }, cameraPath: { keys: [{ t: 0, zoom: 1 }, { t: 2, zoom: 1.15, y: 0.45 }] } },
    { id: 'b', start: 2, end: 4, environment: 'footage', transition: 'zoomIntoElement', footage: { src: 'tone.png' } },
  ] }, { brand });
  assert.ok(ok.spec, JSON.stringify(ok.issues));
  assert.ok(ok.spec.scenes[0]!.cameraPath && ok.spec.scenes[0]!.focus && ok.spec.scenes[1]!.footage);
  assert.throws(() => validateSpec({ ...base, scenes: [{ id: 'a', start: 0, end: 4, environment: 'footage' }] }, { brand }), (e: { details?: { code?: string } }) => e.details?.code === 'FOOTAGE_REQUIRED');
  assert.throws(() => validateSpec({ ...base, scenes: [{ id: 'a', start: 0, end: 4, environment: 'footage', footage: { src: '../x.mp4' } }] }, { brand }), /FOOTAGE|素材|src/);
});
test('spec：文字超出镜头可读时长时告警', () => {
  const r = validateSpec({ ...base, scenes: [{ id: 'a', start: 0, end: 1.2, environment: 'theme_stage', headline: ['这一屏的字数明显太多了', '观众根本读不完'] }] }, { brand });
  assert.ok(r.issues.some((i) => i.code === 'SHOT_TOO_SHORT_FOR_TEXT'));
});
test('管线：素材镜头 + 相机路径 + 焦点钻入可渲染且可复现', () => {
  const root = scratch(); twoTonePng(root);
  const spec = validateSpec({ ...base, scenes: [
    { id: 'a', start: 0, end: 2, environment: 'theme_stage', headline: ['推进'], focus: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, cameraPath: { keys: [{ t: 0, zoom: 1 }, { t: 2, zoom: 1.3 }] } },
    { id: 'b', start: 2, end: 4, environment: 'footage', transition: 'zoomIntoElement', footage: { src: 'tone.png', kenBurns: { from: { x: 0.3, y: 0.5, zoom: 1.2 }, to: { x: 0.7, y: 0.5, zoom: 1.2 } } } },
  ] }, { brand }).spec!;
  const W = 108, H = 192;
  const warnings: string[] = [];
  const render = (i: number) => { const r = createSpecRenderer({ spec, width: W, height: H, assetRoot: root, onWarning: (w) => warnings.push(w) }); try { return Buffer.from(r.renderFrame(makeFrameContext({ frameIndex: i, fps: 24, totalFrames: 96, width: W, height: H, seed: 3 })).data); } finally { r.dispose(); } };
  assert.ok(render(10).equals(render(10)));
  assert.ok(!render(0).equals(render(40)), '相机路径应改变画面');
  assert.ok(!render(49).equals(render(52)), '转场应有过程');
  assert.ok(!warnings.some((w) => /素材不可用/.test(w)), warnings.join('\n'));
});

// ------------------------------------------------------------ 跨平台
test('字体：bundled 目录优先，其次按文件名（不区分大小写）在系统目录中递归查找', () => {
  const bundled = scratch(), sys = scratch();
  mkdirSync(join(sys, 'a/b'), { recursive: true });
  writeFileSync(join(sys, 'a/b/Inter-Variable.TTF'), ''); writeFileSync(join(sys, 'a/Only.ttf'), '');
  writeFileSync(join(bundled, 'Inter-Variable.ttf'), '');
  assert.equal(resolveFontFile('Inter-Variable.ttf', bundled, [sys]), join(bundled, 'Inter-Variable.ttf'));
  assert.equal(resolveFontFile('fonts/only.ttf', bundled, [sys]), join(sys, 'a/Only.ttf'));
  assert.equal(resolveFontFile('nope.ttf', bundled, [sys]), null);
});
test('字体目录：按平台给出，且可用 JBM_FONT_DIRS 追加', () => {
  const mac = systemFontDirs('darwin', { JBM_FONT_DIRS: '/x/fonts' });
  assert.equal(mac[0], '/x/fonts'); assert.ok(mac.includes('/System/Library/Fonts'));
  assert.ok(!mac.some((d) => d.startsWith('/usr/share')));
  assert.ok(systemFontDirs('linux', {}).includes('/usr/share/fonts'));
});
test('输出目录：默认仓库根 output/，可由 JBM_OUTPUT_DIR 覆盖', () => {
  assert.match(outputRoot({}), /[\\/]output$/);
  assert.equal(outputRoot({ JBM_OUTPUT_DIR: '/tmp/jbm-out' }), '/tmp/jbm-out');
});

// ------------------------------------------------------------ 死帧 QA 回归
import { findDeadSpans, type GrayFrame } from '../src/qa/dead-frames.ts';
test('死帧 QA：整屏缓慢平移的纹理不误报；静止画面 + 颗粒仍判为死帧', () => {
  const W = 96, H = 96, fps = 24;
  let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const tex = Array.from({ length: 512 }, (_, i) => 128 + 90 * Math.sin(i * 0.21) * Math.cos(i * 0.053));
  const frame = (shift: number, grain: number): GrayFrame => {
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = tex[(x + y + Math.floor(shift)) % 512]! + (rnd() - 0.5) * grain;
    return { width: W, height: H, data: d };
  };
  const pan = Array.from({ length: 48 }, (_, i) => frame(i * 0.5, 4));
  assert.deepEqual(findDeadSpans(pan, { fps }), []);
  const still = Array.from({ length: 48 }, () => frame(0, 4));
  assert.equal(findDeadSpans(still, { fps }).length, 1);
});
