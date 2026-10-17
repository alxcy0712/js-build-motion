import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEME_IDS, THEMES, validateTheme, loadBrand, parseBrand, enforceBrand, DEFAULT_BRAND, microMotionAt, minWindowMotion } from '../src/themes/index.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { findDeadSpans, type GrayFrame } from '../src/qa/dead-frames.ts';

const spec = (style?: unknown) => ({ video: { width: 1080, height: 1920, duration: 2 }, ...(style === undefined ? {} : { style }), scenes: [{ duration: 2 }] });
const brand = (lockedTheme: string, enforcement = 'override') => parseBrand({ version: 1, lockedTheme, enforcement, changes: [{ at: '2026-10-13', theme: lockedTheme, reason: 't' }] });

// ---------------------------------------------------------------- 品牌锁
test('仓库 brand.json 可解析，默认锁 minimal', () => {
  const b = loadBrand();
  assert.equal(b.lockedTheme, 'minimal');
  assert.equal(DEFAULT_BRAND.lockedTheme, 'minimal');
  assert.equal(loadBrand('/nonexistent/brand.json').lockedTheme, 'minimal');
});
test('未写 theme 的片子取品牌锁定值', () => {
  const out = validateSpec(spec(), { brand: brand('kinetic') });
  assert.equal(out.spec!.style.theme, 'kinetic');
  assert.ok(!out.issues.some((i) => i.code === 'BRAND_THEME_LOCKED'));
});
test('override 模式：单片换风格被改回并警告', () => {
  for (const style of [{ theme: 'kinetic' }, 'kinetic']) {
    const out = validateSpec(spec(style), { brand: brand('minimal') });
    assert.equal(out.spec!.style.theme, 'minimal');
    const issue = out.issues.find((i) => i.code === 'BRAND_THEME_LOCKED');
    assert.equal(issue?.severity, 'WARNING');
  }
});
test('reject 模式：单片换风格直接失败', () => {
  assert.throws(() => validateSpec(spec({ theme: 'kinetic' }), { brand: brand('minimal', 'reject') }));
  assert.equal(validateSpec(spec({ theme: 'minimal' }), { brand: brand('minimal', 'reject') }).spec!.style.theme, 'minimal');
});
test('品牌级变更：改 brand.json 后同一片子通过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brand-'));
  const p = join(dir, 'brand.json');
  writeFileSync(p, JSON.stringify({ version: 1, lockedTheme: 'storybook', enforcement: 'reject', changes: [{ at: '2026-10-13', theme: 'minimal', reason: 'init' }, { at: '2026-10-14', theme: 'storybook', reason: '用户选定' }] }));
  const out = validateSpec(spec({ theme: 'storybook' }), { brand: loadBrand(p) });
  assert.equal(out.spec!.style.theme, 'storybook');
});
test('brand.json 校验：未登记风格 / 无变更记录的切换被拒', () => {
  assert.throws(() => parseBrand({ version: 1, lockedTheme: 'vapor', enforcement: 'override', changes: [] }), /未登记/);
  for (const removed of ['crayon', 'terminal']) assert.throws(() => parseBrand({ version: 1, lockedTheme: removed, enforcement: 'override', changes: [{ at: '2026-10-17', theme: removed, reason: 't' }] }), /未登记/, removed);
  assert.throws(() => parseBrand({ version: 1, lockedTheme: 'kinetic', enforcement: 'override', changes: [{ at: 'x', theme: 'minimal', reason: '' }] }), /不一致/);
  assert.equal(enforceBrand(undefined, DEFAULT_BRAND).violation, null);
});

// ---------------------------------------------------------------- 风格微运动
test('每个风格都满足防死帧规则（含非颗粒运动层、≤0.5s 窗口有可见位移）', () => {
  for (const id of THEME_IDS) {
    const th = THEMES[id];
    assert.ok(th.liveness.layers.some((l) => l !== 'grain'), id);
    assert.ok(th.liveness.maxStillSeconds <= 0.5, id);
    assert.ok(minWindowMotion(th, 30) >= th.liveness.minMotionPx, id);
  }
});
test('只有颗粒的风格会被校验器拦下', () => {
  const bad = { ...THEMES.minimal, liveness: { ...THEMES.minimal.liveness, layers: ['grain'] as const } };
  assert.match(validateTheme(bad).join('\n'), /非颗粒运动/);
  const weak = { ...THEMES.minimal, treatments: { ...THEMES.minimal.treatments, drift: { scaleTo: 1.0001, seconds: 5 } }, liveness: { ...THEMES.minimal.liveness, parallaxAmplitudePx: 0.01 } };
  assert.match(validateTheme(weak).join('\n'), /微运动不足/);
});
test('微运动是纯时间函数且推镜不会停住', () => {
  const th = THEMES.minimal;
  assert.deepEqual(microMotionAt(th, 7.3), microMotionAt(th, 7.3));
  assert.ok(microMotionAt(th, 60).scale > microMotionAt(th, 59).scale);
});

// ---------------------------------------------------------------- 死帧检测（合成帧）
const W = 270, H = 480, FPS = 30;
function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
/** 黑底 + 一块“文字”白条（左缘可亚像素移动）+ 逐像素颗粒 */
function frame(x0: number, grain: number, seed: number): GrayFrame {
  const r = rng(seed), d = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 8;
    if (y > 200 && y < 260) { const cover = Math.min(1, Math.max(0, x + 1 - x0)) * Math.min(1, Math.max(0, x0 + 140 - x)); v += 230 * cover; }
    d[y * W + x] = v + (r() - 0.5) * 2 * grain;
  }
  return { width: W, height: H, data: d };
}
const seq = (n: number, f: (i: number) => GrayFrame) => Array.from({ length: n }, (_, i) => f(i));

test('静止画面 + 强颗粒：整段判为死帧（颗粒不算运动）', () => {
  const spans = findDeadSpans(seq(90, (i) => frame(60, 12, i + 1)), { fps: FPS });
  assert.equal(spans.length, 1);
  assert.ok(spans[0]!.endSec - spans[0]!.startSec >= 2.9);
});
test('慢推镜级亚像素运动（0.3px/0.5s）不误报', () => {
  const spans = findDeadSpans(seq(90, (i) => frame(60 + (0.3 / 15) * i, 6, i + 1)), { fps: FPS });
  assert.deepEqual(spans, []);
});
test('先静 1.5s 再动：只报告前段', () => {
  const frames = seq(120, (i) => frame(i < 45 ? 60 : 60 + (i - 45) * 0.2, 6, i + 1));
  const spans = findDeadSpans(frames, { fps: FPS });
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.startFrame, 0);
  assert.ok(Math.abs(spans[0]!.endSec - 1.5) <= 0.2, String(spans[0]!.endSec));
});
test('短于 0.5s 的停顿不报告', () => {
  const frames = seq(90, (i) => frame(60 + (i < 30 ? i * 0.3 : i < 42 ? 9 : 9 + (i - 42) * 0.3), 6, i + 1));
  assert.deepEqual(findDeadSpans(frames, { fps: FPS }), []);
});
