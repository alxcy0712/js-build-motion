import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas, FontLibrary } from 'skia-canvas';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { registerThemeFonts, trackFontUsage } from '../src/themes/fonts.ts';
import {
  THEME_IDS, THEMES, getTheme, isThemeId, listThemes, validateTheme, revealState, springOvershoot,
  cubicBezier, exceedsScreenBudget, assertThemeFonts, detectFallback, NO_OVERSHOOT_EPSILON,
} from '../src/themes/index.ts';
import { SPEC_DEFAULTS } from '../src/spec/types.ts';

test('每个登记的风格都能加载且 token 合法', () => {
  assert.deepEqual(Object.keys(THEMES).sort(), [...THEME_IDS].sort());
  for (const id of THEME_IDS) {
    assert.deepEqual(validateTheme(THEMES[id]), [], id);
    assert.equal(getTheme(id).id, id);
  }
  assert.equal(listThemes().length, THEME_IDS.length);
  assert.deepEqual([...THEME_IDS], ['minimal', 'kinetic']);
  for (const removed of ['crayon', 'terminal', 'storybook', 'watercolor_storybook']) { assert.equal(isThemeId(removed), false, removed); assert.throws(() => getTheme(removed), /THEME_UNKNOWN/); }
});

test('默认风格为 minimal，水彩风格已移除', () => {
  assert.equal(SPEC_DEFAULTS.style.theme, 'minimal');
  assert.equal(isThemeId('storybook'), false);
  assert.equal(isThemeId('watercolor_storybook'), false);
  assert.throws(() => getTheme('neon_vapor'), /THEME_UNKNOWN/);
});

test('校验器能拦下文字回弹、线性缓动与坏色值', () => {
  const bad = { ...THEMES.minimal, palette: { ...THEMES.minimal.palette, accent: 'orange' },
    easings: { ...THEMES.minimal.easings, standard: [0, 0, 1, 1] as const },
    textReveal: { ...THEMES.minimal.textReveal, positionSpring: { stiffness: 200, damping: 8 } } };
  const problems = validateTheme(bad).join('\n');
  assert.match(problems, /palette.accent/);
  assert.match(problems, /线性/);
  assert.match(problems, /过冲/);
});

test('禁止过冲的风格：文字位移进度单调且不超过终值', () => {
  for (const id of THEME_IDS) {
    const th = THEMES[id];
    if (th.textReveal.allowOvershoot) {
      assert.ok(springOvershoot(th.textReveal.positionSpring) <= th.textReveal.maxOvershoot + 1e-9, id);
      continue;
    }
    let prev = Infinity;
    for (let f = 0; f <= 120; f++) {
      const s = revealState(th, f / 60, { enterAt: 0 });
      assert.ok(s.dy <= prev + 1e-9, `${id} 第 ${f} 帧回弹`);
      assert.ok(s.dy >= -1e-9, `${id} 第 ${f} 帧越过终点`);
      prev = s.dy;
    }
    assert.ok(springOvershoot(th.springs.text) <= NO_OVERSHOOT_EPSILON, id);
  }
});

test('文字进退场是纯时间函数（乱序求值结果一致）', () => {
  const th = THEMES.kinetic; const times = [0.9, 0.1, 2.5, 0.4];
  const a = times.map((t) => revealState(th, t, { enterAt: 0, exitAt: 2 }));
  const b = [...times].reverse().map((t) => revealState(th, t, { enterAt: 0, exitAt: 2 })).reverse();
  assert.deepEqual(a, b);
  assert.equal(revealState(th, 5, { enterAt: 0, exitAt: 2 }).visible, false);
});

test('cubicBezier 端点与单调性', () => {
  const e = cubicBezier(THEMES.minimal.easings.camera);
  assert.equal(e(0), 0); assert.equal(e(1), 1);
  for (let i = 1; i <= 100; i++) assert.ok(e(i / 100) >= e((i - 1) / 100) - 1e-9);
});

test('每屏字数预算', () => {
  assert.equal(exceedsScreenBudget(THEMES.minimal, ['电脑', '不会焦虑。']), false);
  assert.equal(exceedsScreenBudget(THEMES.minimal, ['这一屏塞了太多太多太多的中文字']), true);
});

test('字体注册与回退检测（本机字体可用时）', () => {
  const ctx = new Canvas(10, 10).getContext('2d');
  assert.equal(detectFallback(ctx, '__definitely_missing__', '电脑'), true);
  for (const id of THEME_IDS) {
    const report = assertThemeFonts(THEMES[id], FontLibrary, ctx, '/nonexistent-bundle', { strict: false });
    assert.equal(report.length, THEMES[id].fonts.faces.length);
  }
});

test('主题只从内嵌文件注册，覆盖系统同名字族并缓存相同文件', () => {
  const uses: string[] = [];
  const lib = { families: THEMES.minimal.fonts.faces.map((face) => face.family), use: (family: string) => uses.push(family) };
  const dir = join(PROJECT_ROOT, 'assets/fonts');
  const first = registerThemeFonts(THEMES.minimal, lib, dir);
  assert.ok(first.every((font) => font.registered && font.file?.startsWith(dir + '/')));
  assert.deepEqual(uses, lib.families);
  registerThemeFonts(THEMES.minimal, lib, dir);
  assert.equal(uses.length, first.length);
  assert.ok(registerThemeFonts(THEMES.minimal, lib, '/nonexistent-bundle').every((font) => !font.registered));
});

test('字体实测读取 glyph runs 的实际字族，保持原有文字绘制', () => {
  registerThemeFonts(THEMES.minimal, FontLibrary, join(PROJECT_ROOT, 'assets/fonts'));
  const ctx = new Canvas(320, 80).getContext('2d'), families = new Set<string>();
  trackFontUsage(ctx, families);
  ctx.font = '32px "Inter", "Noto Sans CJK SC"';
  ctx.fillText('中文 ABC', 0, 40);
  ctx.strokeText('中文', 0, 75);
  ctx.fillText(42 as unknown as string, 150, 75);
  assert.deepEqual([...families].sort(), ['Inter', 'Noto Sans CJK SC']);
  assert.ok(ctx.getImageData(0, 0, 320, 80).data.some((value) => value > 0));
});
