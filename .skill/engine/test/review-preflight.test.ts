import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas, FontLibrary } from 'skia-canvas';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createFixtureProject } from './fixtures/project.ts';
import { holdShortCaptionGaps, buildCaptionTrack, type CaptionCue } from '../src/captions/track.ts';
import { captionGeometry, drawCaptions, wrapCaptionText } from '../src/captions/render.ts';
import { trackLayout, withLayout } from '../src/layout/trace.ts';
import { inspectLayout } from '../src/layout/check.ts';
import { frame } from '../src/layout/tools.ts';
import { MotionInspection } from '../src/qa/inspection.ts';
import { inspectQuality } from '../src/project/quality.ts';
import { getTheme } from '../src/themes/registry.ts';
import { registerThemeFonts } from '../src/themes/fonts.ts';
import { textPop, lineReveal, drawTextEntrance } from '../src/motion/text.ts';
import { drawEndCard, spokenWordStart } from '../src/drawing/scenes/end-card.ts';
import { getPalette } from '../src/drawing/styles/palette.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const theme = getTheme('kinetic');
registerThemeFonts(theme, FontLibrary, join(PROJECT_ROOT, 'assets/fonts'));
const fontFamily = 'Noto Sans CJK SC';
const spec = () => validateSpec({ video: { width: 1080, height: 1920, fps: 30, duration: 5 }, style: { theme: 'kinetic' },
  scenes: [{ start: 0, end: 5, environment: 'theme_stage', cameraMove: 'static' }], captions: { enabled: true } }).spec!;

test('1–7 frame gaps hold only cue ends; 8–30 frame and exactly 250ms pauses retain byte-identical data', () => {
  for (const frames of [1, 2, 3, 4, 5, 6, 7, 8, 15, 18, 30]) {
    const cues: CaptionCue[] = [{ index: 0, text: '甲', start: 0, end: 1, words: [{ text: '甲', start: .1, end: .8 }] },
      { index: 1, text: '乙', start: 1 + frames / 30, end: 3 }];
    const before = JSON.stringify(cues), held = holdShortCaptionGaps(cues);
    assert.equal(JSON.stringify(cues), before); assert.equal(held[0]!.words, cues[0]!.words);
    assert.equal(held[0]!.start, cues[0]!.start); assert.equal(held[1], cues[1]);
    assert.equal(held[0]!.end, frames < 8 ? cues[1]!.start : cues[0]!.end);
    if (frames >= 8) assert.equal(JSON.stringify(held), before);
    assert.equal(inspectQuality(spec(), { captionCues: cues }).issues.some(i => i.code === 'CAPTION_SHORT_GAP' && i.severity === 'error'), frames < 8);
    assert.ok(!inspectQuality(spec(), { captionCues: held }).issues.some(i => i.code === 'CAPTION_SHORT_GAP'));
  }
  const boundary = [{ index: 0, text: '甲', start: 0, end: 1 }, { index: 1, text: '乙', start: 1.25, end: 2 }];
  assert.equal(JSON.stringify(holdShortCaptionGaps(boundary)), JSON.stringify(boundary));
  const s = spec(); s.audio.narration = [{ text: '甲', start: 0, voice: 'female_calm', rate: 1 }, { text: '乙', start: 1.1, voice: 'female_calm', rate: 1 }];
  const measured = new Map([[0, { start: 0, end: 1 }], [1, { start: 1.1, end: 2 }]]);
  assert.equal(buildCaptionTrack(s, { measured })[0]!.end, 1.1);
});

test('14-character actual caption glyphs stay at or left of x=912; 13-character centered layout stays intact', () => {
  for (const style of ['boxed', 'clean', 'handwritten'] as const) {
    const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx);
    for (const count of [13, 14]) {
      trace.reset(1); const cue = { index: 0, text: '字'.repeat(count), start: 0, end: 2 };
      const options = { ctx, width: 1080, height: 1920, style, fontFamily, seed: 9 };
      const geometry = captionGeometry(options, cue);
      if (count === 13) assert.equal(geometry.centerX, 540);
      drawCaptions({ ...options, cues: [cue], time: 1, mode: 'sentence', palette: getPalette('warm_night') });
      const glyphs = trace.draws.filter(d => d.text);
      assert.equal(glyphs.length, count); assert.ok(glyphs.every(d => d.bounds.x >= 72 && d.bounds.x + d.bounds.width <= 912.01));
      assert.equal(geometry.outerY + geometry.outerH / 2, 1488);
    }
  }
});

test('word-aware wrapping repairs 游/戏 while retaining a fitting punctuation/word boundary', () => {
  const text = '它也可能先给你推游戏、球鞋、数码测评';
  assert.deepEqual(wrapCaptionText(text, 829, s => [...s].length * 56), ['它也可能先给你推', '游戏、球鞋、数码测评']);
  assert.deepEqual(wrapCaptionText('游戏、球鞋', 400, s => [...s].length * 56), ['游戏、球鞋']);
});

function motionCurve(curve: (p: number) => number, linearOpacity = false) {
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx), check = new MotionInspection(30, theme, 1920);
  for (let index = 0; index < 60; index++) {
    const time = index / 30, p = Math.min(1, time / .5); trace.reset(time); trace.state.scene = 'synthetic';
    withLayout(ctx, { id: 'title', role: 'text', textMotion: { start: 0, end: .5, easing: 'custom' } }, () => {
      ctx.save(); ctx.font = `56px "${fontFamily}"`; ctx.fillStyle = '#fff';
      ctx.globalAlpha = linearOpacity ? p : 1; ctx.translate(400, 600 + (linearOpacity ? 18 * (1 - p) : 0));
      const scale = linearOpacity ? 1 : curve(p); ctx.scale(scale, scale); ctx.fillText('观察峰值', 0, 0); ctx.restore();
    });
    check.observe(trace, index);
  }
  return check.finish();
}
test('actual widths reject c1=1.70158 and measured 4.59/8/12 percent; c1=0.6 passes the kinetic 4 percent cap', () => {
  const back = (c: number) => (p: number) => 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
  assert.ok(motionCurve(back(1.70158)).some(i => i.code === 'TEXT_OVERSHOOT' && i.severity === 'error'));
  assert.ok(!motionCurve(back(.6)).some(i => i.code === 'TEXT_OVERSHOOT'));
  for (const peak of [1.0459, 671 / 618, 344 / 308]) assert.ok(motionCurve(p => p < .5 ? 2 * p * peak : peak + (1 - peak) * (p - .5) * 2).some(i => i.code === 'TEXT_OVERSHOOT'));
});
test('linear alpha and 18px reveal fail using observed samples even when the declaration says custom', () => {
  assert.ok(motionCurve(p => p, true).some(i => i.code === 'TEXT_LINEAR_ENTRANCE' && i.severity === 'error'));
});
test('theme text pop and staggered ease-out helpers seek deterministically and meet their limits', () => {
  for (const t of [getTheme('minimal'), theme]) for (let i = 0; i < 301; i++) {
    const state = textPop(t, i / 300); assert.ok(state.scale <= 1 + t.textReveal.maxOvershoot);
    assert.deepEqual(textPop(t, i / 300), state);
  }
  assert.deepEqual(lineReveal(.16, { index: 1 }), { opacity: 0, y: 18, scale: 1 });
  assert.deepEqual(lineReveal(.4), { opacity: 1, y: 0, scale: 1 });
  assert.equal(lineReveal(.2).opacity, .875);
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx), check = new MotionInspection(30, theme, 1920);
  for (let index = 0; index < 60; index++) {
    trace.reset(index / 30); drawTextEntrance(ctx, theme, index / 30, { id: 'line', kind: 'line', enterAt: 0, x: 300, y: 600 }, () => {
      ctx.font = `56px "${fontFamily}"`; ctx.fillStyle = '#fff'; ctx.fillText('逐行揭示', 0, 0);
    }); check.observe(trace, index);
  }
  assert.deepEqual(check.finish(), []);
});

test('right-button entry traversal fails on all 13 visible frames, with a compliant settled right edge', () => {
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx);
  const edges = [1079, 1074, 1065, 1056, 1043, 1030, 1016, 1000, 981, 962, 944, 932, 920, 904];
  for (const [i, right] of edges.entries()) {
    trace.reset(115.8 + i / 30); ctx.fillStyle = '#fff';
    withLayout(ctx, { id: 'person', role: 'shape', required: true }, () => ctx.fillRect(right - 100, 922, 100, 185));
    const report = inspectLayout(trace, { frame: 3474 + i, fps: 30, width: 1080, height: 1920, safe: frame(1080, 1920).safe });
    assert.equal(report.issues.some(issue => issue.code === 'BUTTON_ZONE_INTRUSION' && issue.severity === 'error'), i < 13);
  }
});
test('unannotated visible text crossing x=912 fails the same safe-area check', () => {
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx); trace.reset(1);
  ctx.font = `56px "${fontFamily}"`; ctx.fillStyle = '#fff'; ctx.fillText('右侧文字', 900, 700);
  assert.ok(inspectLayout(trace, { frame: 30, fps: 30, width: 1080, height: 1920, safe: frame(1080, 1920).safe }).issues.some(i => i.code === 'TEXT_SAFE_AREA' && i.severity === 'error'));
});
test('unclassified button-column shapes and unobserved text settling remain pending', () => {
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx), check = new MotionInspection(30, theme, 1920);
  trace.reset(1); ctx.fillStyle = '#fff'; ctx.fillRect(944, 922, 100, 185);
  ctx.font = `56px "${fontFamily}"`; ctx.fillText('待分类', 300, 600); check.observe(trace, 30);
  assert.ok(inspectLayout(trace, { frame: 30, fps: 30, width: 1080, height: 1920, safe: frame(1080, 1920).safe }).issues.some(i => i.code === 'BUTTON_ZONE_SEMANTICS_REQUIRED' && i.severity === 'coverage'));
  assert.ok(check.finish().some(i => i.code === 'TEXT_SETTLE_UNOBSERVED' && i.severity === 'coverage'));
});
test('end-card checks reject a 2.1s delay, 116px gap and 6px sine drift; corrected geometry passes', () => {
  for (const broken of [true, false]) {
    const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx), check = new MotionInspection(30, theme, 1920), issues = [];
    for (let index = 0; index < 150; index++) {
      const time = index / 30; trace.reset(time); ctx.fillStyle = '#fff'; ctx.font = `42px "${fontFamily}"`;
      withLayout(ctx, { id: 'slogan', role: 'text', endCard: { part: 'slogan', wordStart: 1, holdStart: 1, holdEnd: 5 } }, () => {
        if (time >= (broken ? 3.1 : 1)) ctx.fillText('用计算机思维想现实', 250, (broken ? 1302 : 1286) - ctx.measureText('用计算机思维想现实').actualBoundingBoxDescent);
      });
      withLayout(ctx, { id: 'avatar', role: 'shape', endCard: { part: 'avatar', holdStart: 1, holdEnd: 5 } }, () => ctx.fillRect(340, 686 + (broken ? Math.sin(time * 1.3) * 6 : 0), 400, 400));
      withLayout(ctx, { id: 'caption', role: 'caption' }, () => ctx.fillRect(200, 1418, 600, 140));
      issues.push(...inspectLayout(trace, { frame: index, fps: 30, width: 1080, height: 1920, safe: frame(1080, 1920).safe }).issues);
      check.observe(trace, index);
    }
    issues.push(...check.finish());
    for (const code of ['ENDCARD_WORD_LATE', 'ENDCARD_CAPTION_GAP', 'ENDCARD_HOLD_MOVED']) assert.equal(issues.some(i => i.code === code && i.severity === 'error'), broken, code);
  }
});
test('end-card helper preserves theme/identity, anchors measured words and fixes the whole hold', () => {
  const words = [{ text: '我是', start: .5, end: .7 }, { text: '澄记', start: .8, end: 1 }, { text: '用', start: 1.4, end: 1.5 },
    { text: '计算机', start: 1.5, end: 1.7 }, { text: '思维想现实', start: 1.7, end: 2 }];
  assert.equal(spokenWordStart(words, '用计算机'), 1.4);
  assert.throws(() => spokenWordStart(words, '缺失'), /ANCHOR_MISSING/);
  const ctx = new Canvas(1080, 1920).getContext('2d'), trace = trackLayout(ctx), check = new MotionInspection(30, theme, 1920), issues = [];
  for (let index = 0; index < 105; index++) {
    trace.reset(index / 30);
    drawEndCard(ctx, theme, index / 30, { id: 'end', width: 1080, height: 1920, start: 0, end: 3.5, words, captionTop: 1419, nameStyle: 'accent',
      avatar: (context, box) => { context.fillStyle = '#fff'; context.fillRect(box.x, box.y, box.width, box.height); } });
    withLayout(ctx, { id: 'caption', role: 'caption' }, () => { ctx.fillStyle = '#fff'; ctx.fillRect(200, 1419, 600, 140); });
    issues.push(...inspectLayout(trace, { frame: index, fps: 30, width: 1080, height: 1920, safe: frame(1080, 1920).safe }).issues);
    check.observe(trace, index);
  }
  issues.push(...check.finish());
  assert.deepEqual(issues.filter(i => i.severity === 'error'), []);
});

test('ordinary qa exits nonzero for unannotated overshoot and linear reveal, and accepts cubic reveal', () => {
  const f = createFixtureProject();
  try {
    writeFileSync(f.specPath, JSON.stringify(validateSpec({ video: { width: 540, height: 960, fps: 30, duration: 1 }, style: { theme: 'kinetic' },
      scenes: [{ start: 0, end: 1, environment: 'theme_stage', cameraMove: 'static' }], audio: { narration: [], bgm: { volume: 0 } }, captions: { enabled: false } }).spec));
    mkdirSync(join(f.dir, 'src')); writeFileSync(join(f.dir, 'project.json'), JSON.stringify({ ...f.manifest, drawing: 'src/draw.mjs' }));
    for (const [kind, code] of [['pop', 'TEXT_OVERSHOOT'], ['linear', 'TEXT_LINEAR_ENTRANCE'], ['scale', 'TEXT_LINEAR_ENTRANCE'], ['cubic', null]] as const) {
      writeFileSync(join(f.dir, 'src/draw.mjs'), `export function drawScene({ctx,time}) {
        const p=Math.min(1,time/.4), kind='${kind}', e=kind==='cubic'?1-(1-p)**3:p;
        ctx.font='28px sans-serif';ctx.fillStyle='#fff';ctx.save();ctx.translate(200,300+18*(1-e));
        if(kind==='pop'){const s=1+2.70158*(p-1)**3+1.70158*(p-1)**2;ctx.scale(s,s);}else if(kind==='scale')ctx.scale(p,p);else ctx.globalAlpha=e;
        ctx.fillText('Title',0,0);ctx.restore();
      }`);
      const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), 'qa', f.dir], { encoding: 'utf8' });
      assert.ok(result.stdout.includes('layoutReport'), result.stderr + result.stdout);
      const report = JSON.parse(readFileSync(join(f.outDir, 'layout-qa/report.json'), 'utf8'));
      assert.equal(result.status, code ? 1 : 0, result.stderr + JSON.stringify(report.issues));
      assert.equal(report.sampling.allFrames, true); assert.equal(report.sampling.frames.length, 30);
      if (code) assert.ok(report.issues.some(i => i.code === code && i.severity === 'error'));
    }
  } finally { f.cleanup(); }
});
