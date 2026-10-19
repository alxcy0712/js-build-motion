import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { validateSpec } from '../src/spec/validate.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { parseBrand, THEMES, type ThemeId } from '../src/themes/index.ts';
import { drawThemeTransition, themeTransitionDuration } from '../src/pipeline/theme-transitions.ts';
import { drawTreatments } from '../src/pipeline/theme-treatments.ts';
import { PROJECT_FONT_FAMILY, registerProjectFonts } from '../src/utils/env.ts';
import { findDeadSpans, type GrayFrame } from '../src/qa/dead-frames.ts';

const W = 270, H = 480, FPS = 24;
const brand = (id: ThemeId) => parseBrand({ version: 1, lockedTheme: id, enforcement: 'override', changes: [{ at: 'x', theme: id, reason: 't' }] });
function specFor(theme: ThemeId, transition = 'blurDissolve', env = 'theme_stage', cameraMove?: string) {
  const move = cameraMove ? { cameraMove } : {};
  return validateSpec({
    video: { width: 1080, height: 1920, fps: FPS, duration: 4, seed: 7 }, style: { theme }, captions: { enabled: false },
    scenes: [{ id: 'a', start: 0, end: 2, environment: env, ...move, headline: ['电脑', '不会焦虑。'] }, { id: 'b', start: 2, end: 4, environment: env, ...move, transition, headline: ['拆解。'] }],
  }, { brand: brand(theme) }).spec!;
}
function frames(spec: ReturnType<typeof specFor>, idx: number[]): Buffer[] {
  const r = createSpecRenderer({ spec, width: W, height: H });
  try { return idx.map((i) => Buffer.from(r.renderFrame(makeFrameContext({ frameIndex: i, fps: FPS, totalFrames: 4 * FPS, width: W, height: H, seed: 7 })).data)); }
  finally { r.dispose(); }
}
const gray = (b: Buffer): GrayFrame => { const d = new Uint8Array(W * H); for (let i = 0; i < d.length; i++) d[i] = (b[i * 4]! + b[i * 4 + 1]! + b[i * 4 + 2]!) / 3; return { width: W, height: H, data: d }; };

test('theme_stage 经真实管线渲染：任意帧可复现', () => {
  const s = specFor('minimal');
  const [a] = frames(s, [30]); const [b] = frames(s, [30]);
  assert.ok(a!.equals(b!));
});
test('字幕与主题中文命中内嵌黑体，实测字族覆盖主画布和转场离屏画布', () => {
  for (const theme of ['minimal', 'kinetic'] as const) {
    const spec = specFor(theme, THEMES[theme].transitions[0]);
    spec.captions.enabled = true;
    const renderer = createSpecRenderer({ spec, width: W, height: H,
      captionCues: [{ index: 0, text: '字幕测试', start: 0, end: 4 }],
    });
    try {
      for (const frameIndex of [24, 50]) renderer.renderFrame(makeFrameContext({ frameIndex, fps: FPS, totalFrames: 96, width: W, height: H, seed: 7 }));
      const usage = renderer.fontUsage();
      assert.deepEqual(usage.families, ['Noto Sans CJK SC']);
      assert.ok(usage.registered.some((font) => font.family === 'Noto Sans CJK SC' && font.absPath.endsWith('/NotoSansCJKsc-VF.otf') && font.registered));
    } finally { renderer.dispose(); }
    const captionsOnly = createSpecRenderer({ spec, width: W, height: H, drawScene: ({ ctx }) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); },
      captionCues: [{ index: 0, text: '只有字幕', start: 0, end: 4 }],
    });
    try {
      captionsOnly.renderFrame(makeFrameContext({ frameIndex: 24, fps: FPS, totalFrames: 96, width: W, height: H, seed: 7 }));
      assert.deepEqual(captionsOnly.fontUsage().families, ['Noto Sans CJK SC']);
    } finally { captionsOnly.dispose(); }
  }
});
test('theme_stage 动态镜头的停留段没有死帧（微运动每帧生效）', () => {
  // 两套主题默认不使用扫光；显式动态 cameraMove 时由主题微运动保证每帧变化。
  for (const th of ['minimal', 'kinetic'] as const) {
    const s = specFor(th, THEMES[th].transitions[0], 'theme_stage', 'slow_push');
  const idx = Array.from({ length: 48 }, (_, i) => i);
    assert.deepEqual(findDeadSpans(frames(s, idx).map(gray), { fps: FPS }), [], th);
  }
});
test('两套主题都不启用扫光', () => {
  for (const th of ['minimal', 'kinetic'] as const) {
    assert.ok(!THEMES[th].liveness.layers.includes('lightSweep'), th);
    assert.equal(THEMES[th].liveness.lightSweep, undefined, th);
  }
});
test('风格转场：中段与两端都不同，且每个已登记转场都能绘制', () => {
  for (const tr of new Set(Object.values(THEMES).flatMap((theme) => theme.transitions))) {
    const theme = (Object.keys(THEMES) as ThemeId[]).find((id) => THEMES[id].transitions.includes(tr))!;
    const s = specFor(theme, tr);
    const [before, mid, after] = frames(s, [47, 48 + 3, 72]);
    if (tr !== 'cutOnBeat') assert.ok(!mid!.equals(before!) && !mid!.equals(after!), `${tr}@${theme}`);
  }
});
test('转场不在风格允许列表时回退并告警', () => {
  const warnings: string[] = [];
  // 绕过 validate 注入坏值，验证渲染兜底继续可用。
  const s = specFor('minimal', 'cut');
  s.scenes[1]!.transition = 'whipPan';
  const renderer = createSpecRenderer({ spec: s, width: W, height: H, onWarning: (m) => warnings.push(m) });
  try { renderer.renderFrame(makeFrameContext({ frameIndex: 50, fps: FPS, totalFrames: 96, width: W, height: H, seed: 7 })); }
  finally { renderer.dispose(); }
  assert.ok(warnings.some((w) => /whipPan/.test(w)));
});
test('validate 按最终主题拒绝越界转场，并给出主题与允许列表', () => {
  for (const [theme, transition] of [['kinetic', 'riseFade'], ['minimal', 'whipPan']] as const) {
    assert.throws(() => specFor(theme, transition), (error: unknown) => {
      const message = (error as Error).message;
      assert.ok(message.includes(theme) && message.includes(transition), message);
      for (const allowed of THEMES[theme].transitions) assert.ok(message.includes(allowed), message);
      return true;
    });
    for (const transition of [...THEMES[theme].transitions, 'cut', 'dissolve']) assert.ok(specFor(theme, transition));
  }
  assert.throws(() => validateSpec({ style: 'minimal', scenes: [{ start: 0, end: 2, transition: 'riseFade' }] },
    { brand: brand('kinetic') }), /kinetic.*riseFade/);
});

test('riseFade：24fps 逐帧只出现一层文字，共享切点最多空一帧', () => {
  registerProjectFonts();
  const canvas = new Canvas(W, H), ctx = canvas.getContext('2d');
  const incoming = new Canvas(W, H), outgoing = new Canvas(W, H), incomingBase = new Canvas(W, H);
  const next = incoming.getContext('2d');
  next.font = `48px "${PROJECT_FONT_FAMILY}"`; next.fillStyle = '#00ff00'; next.fillText('5s', 150, 260);
  const duration = themeTransitionDuration('riseFade', THEMES.minimal);
  for (const phase of [0, 0.25, 0.5, 0.75]) {
    let emptyFrames = 0;
    for (let frame = 0; frame <= Math.ceil(duration * FPS); frame++) {
      ctx.clearRect(0, 0, W, H);
      drawThemeTransition('riseFade', { ctx, width: W, height: H, mix: (frame + phase) / FPS / duration,
        theme: THEMES.minimal, incoming, outgoing, incomingBase, seed: 7,
        drawIncomingBase: (c) => { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); },
        drawPrevious: (c) => { c.font = `48px "${PROJECT_FONT_FAMILY}"`; c.fillStyle = '#ff0000'; c.fillText('测试', 10, 180); },
      });
      const pixels = ctx.getImageData(0, 0, W, H).data;
      let oldText = false, newText = false;
      for (let i = 0; i < pixels.length; i += 4) { oldText ||= pixels[i]! > 0; newText ||= pixels[i + 1]! > 0; }
      assert.ok(!(oldText && newText), `frame=${frame}, phase=${phase}`);
      emptyFrames = oldText || newText ? 0 : emptyFrames + 1;
      assert.ok(emptyFrames <= 1, `无字空档 ${emptyFrames} 帧`);
    }
  }
});

test('暗角覆盖作用于实际帧：0 保留颗粒，调低后角落亮度高于默认值', () => {
  const corner = (vignette?: number) => {
    const spec = specFor('kinetic', 'cut');
    if (vignette !== undefined) spec.style.vignette = vignette;
    const renderer = createSpecRenderer({ spec, width: W, height: H, drawScene: ({ ctx }) => {
      ctx.fillStyle = '#ffc712'; ctx.fillRect(0, 0, W, H);
    } });
    try {
      const pixels = renderer.renderFrame(makeFrameContext({ frameIndex: 0, fps: FPS, totalFrames: 96, width: W, height: H, seed: 7 })).data;
      return Array.from({ length: 100 }, (_, i) => pixels[i * 4 + 1]!).reduce((a, b) => a + b) / 100;
    } finally { renderer.dispose(); }
  };
  assert.ok(corner(0) > 190);
  assert.ok(corner(0) > corner(0.2) + 10);
  assert.ok(corner(0.2) > corner() + 30);
  assert.equal(corner(), corner(THEMES.kinetic.treatments.vignette));
});

test('深色暗角的中性噪声逐像素可复现，且在颗粒关闭时仍分散量化台阶', () => {
  const theme = { ...THEMES.kinetic, treatments: { ...THEMES.kinetic.treatments, grain: { opacity: 0, fps: 24 } } };
  const render = (time: number) => {
    const c = new Canvas(W, H), ctx = c.getContext('2d');
    ctx.fillStyle = '#181818'; ctx.fillRect(0, 0, W, H);
    drawTreatments(ctx, theme, time, time, W, H, 7);
    return Buffer.from(ctx.getImageData(0, 0, W, H).data);
  };
  const pixels = render(0);
  assert.ok(pixels.equals(render(0)));
  assert.ok(!pixels.equals(render(1 / FPS)));
  let changes = 0;
  for (let x = W / 2 - 20; x < W / 2 + 20; x++) {
    const i = (240 * W + Math.floor(x)) * 4;
    assert.equal(pixels[i], pixels[i + 1]); assert.equal(pixels[i], pixels[i + 2]); assert.equal(pixels[i + 3], 255);
    if (Math.abs(pixels[i]! - pixels[i + 4]!) === 2) changes++;
  }
  assert.ok(changes > 8, `${changes} 次局部噪声变化`);
});
test('旧环境（rain_window）不受风格层影响，保持原外观', () => {
  const [a] = frames(specFor('minimal', 'cut', 'rain_window'), [10]);
  const [b] = frames(specFor('kinetic', 'cut', 'rain_window'), [10]);
  assert.ok(a!.equals(b!));
});
test('品牌锁在管线中生效：spec 请求 kinetic 但锁 minimal', () => {
  const out = validateSpec({ video: { width: 1080, height: 1920, duration: 2 }, style: 'kinetic', scenes: [{ start: 0, end: 2, environment: 'theme_stage', headline: ['x'] }] }, { brand: brand('minimal') });
  assert.equal(out.spec!.style.theme, 'minimal');
});

// ---------------------------------------------------------------- 审片第 1 轮修正
import { revealState } from '../src/themes/text-reveal.ts';
function spec3(theme: ThemeId, opts: { ip?: boolean; headline?: boolean; ipRole?: 'identity' | 'actor' } = {}) {
  const tr = THEMES[theme].transitions.find((t) => t !== 'cutOnBeat')!;
  return validateSpec({
    video: { width: 1080, height: 1920, fps: FPS, duration: 4, seed: 7 }, style: { theme }, captions: { enabled: false },
    scenes: [
      { id: 'a', start: 0, end: 2, environment: 'theme_stage', ...(opts.headline === false ? {} : { headline: ['电脑', '不会焦虑。'] }), ...(opts.ip ? { ip: { role: opts.ipRole ?? 'identity', size: 288 } } : {}) },
      { id: 'b', start: 2, end: 4, environment: 'theme_stage', transition: tr, ...(opts.headline === false ? {} : { headline: ['拆解。'] }), ...(opts.ip ? { ip: { role: opts.ipRole ?? 'identity', size: 288 } } : {}) },
    ],
  }, { brand: brand(theme) }).spec!;
}
const diff = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i]! - b[i]!); return s / (a.length / 4); };

test('IP 开关：开启后画面出现角色，关闭则没有', () => {
  const [on] = frames(spec3('minimal', { ip: true, headline: false }), [30]);
  const [off] = frames(spec3('minimal', { headline: false }), [30]);
  assert.ok(diff(on!, off!) > 2);
});
test('IP 带呼吸/眨眼微运动：停留段相隔 0.5s 的帧不同', () => {
  // actor 角色带呼吸浮动；不依赖扫光等全画面氛围层制造帧差。
  const [a, b] = frames(spec3('minimal', { ip: true, ipRole: 'actor', headline: false }), [12, 24]);
  assert.ok(!a!.equals(b!));
});
test('下一镜头有风格转场时，上一镜头文字保持到转场开始并被带走（转场中段仍有文字）', () => {
  for (const th of ['minimal', 'kinetic'] as const) {
    const withText = frames(spec3(th), [47, 49]), noText = frames(spec3(th, { headline: false }), [47, 49]);
    assert.ok(diff(withText[0]!, noText[0]!) > 0.5, `${th} 转场前一帧文字已退场`);
    assert.ok(diff(withText[1]!, noText[1]!) > 0.5, `${th} 转场中文字消失（空背景）`);
  }
});
test('kinetic 首帧标题即清晰在位', () => {
  const [withText] = frames(spec3('kinetic'), [0]); const [noText] = frames(spec3('kinetic', { headline: false }), [0]);
  assert.ok(diff(withText!, noText!) > 0.5);
  const s = revealState(THEMES.kinetic, 0.2, { enterAt: 0 });
  assert.equal(s.blur, 0);
});
test('所有风格：进场 0.2s 后无残留模糊', () => {
  for (const id of Object.keys(THEMES) as ThemeId[]) for (const t of [0.2, 0.5, 1.2]) assert.equal(revealState(THEMES[id], t, { enterAt: 0 }).blur, 0, `${id}@${t}`);
});
test('第 2 轮：所有风格首镜头首帧即显示完整标题（默认 firstScreen=instant）', () => {
  for (const th of ['minimal', 'kinetic'] as const) {
    const [a] = frames(spec3(th), [0]); const [b] = frames(spec3(th, { headline: false }), [0]);
    assert.ok(diff(a!, b!) > 0.5, th);
  }
});
test('第 2 轮：blurDissolve 前半段旧字淡出、后半段新字淡入（中点无新旧文字）', () => {
  // 转场 0.3s = 7.2 帧@24fps；中点帧（第 48+3 帧 ≈ m=0.42–0.5）应接近无字底层
  const s = spec3('minimal');
  // 第 3 轮：新字提前约 1 帧进入；中点文字量应远小于完整文字（新旧两行不同时半透明）
  const [mid, full] = frames(s, [48 + 3, 60]); const [baseMid, baseFull] = frames(spec3('minimal', { headline: false }), [48 + 3, 60]);
  assert.ok(diff(mid!, baseMid!) < 0.6 * diff(full!, baseFull!), `${diff(mid!, baseMid!)} vs ${diff(full!, baseFull!)}`);
});

// ---------------------------------------------------------------- IP 使用规则
test('IP 默认不出现；ip:true 旧写法降级为 288px 身份署名并告警', () => {
  const s = spec3('minimal');
  assert.equal(s.scenes[0]!.ip, undefined);
  const legacy = validateSpec({ video: { width: 1080, height: 1920, duration: 2 }, scenes: [{ start: 0, end: 2, environment: 'theme_stage', ip: true }] }, { brand: brand('minimal') });
  assert.deepEqual(legacy.spec!.scenes[0]!.ip, { role: 'identity', size: 288, position: 'bottom-center' });
  assert.ok(legacy.issues.some((i) => i.code === 'IP_ROLE_REQUIRED'));
});
test('IP 放大超过源尺寸 512 被拒绝（含高分辨率输出换算）', () => {
  const mk = (size: number, width = 1080, height = 1920) => () => validateSpec({ video: { width, height, duration: 2 }, scenes: [{ start: 0, end: 2, environment: 'theme_stage', ip: { role: 'actor', size } }] }, { brand: brand('minimal') });
  assert.throws(mk(600));
  assert.throws(mk(384, 2160, 3840)); // 4K 竖屏：384 参考像素 → 768 实际像素
  assert.equal(mk(512)().spec!.scenes[0]!.ip!.size, 512);
  assert.throws(() => validateSpec({ video: { width: 1080, height: 1920, duration: 2 }, scenes: [{ start: 0, end: 2, environment: 'theme_stage', ip: { role: 'hero' } }] }, { brand: brand('minimal') }));
});
test('纯文字镜头标题居中（无 IP 时不上移）', () => {
  const [plain] = frames(spec3('minimal'), [30]);
  // 画面上 1/4 区域没有文字像素：标题在中部
  let top = 0; for (let i = 0; i < W * Math.floor(H / 4) * 4; i += 4) top += plain![i]!;
  const [blank] = frames(spec3('minimal', { headline: false }), [30]);
  let topBlank = 0; for (let i = 0; i < W * Math.floor(H / 4) * 4; i += 4) topBlank += blank![i]!;
  assert.ok(Math.abs(top - topBlank) / (W * H / 4) < 0.5);
});
