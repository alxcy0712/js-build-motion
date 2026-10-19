import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { segmentCaption } from '../src/captions/segment.ts';
import { buildCaptionTrack } from '../src/captions/track.ts';
import { toSrt, toVtt } from '../src/captions/export.ts';
import { captionGeometry, drawCaptions } from '../src/captions/render.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { getPalette } from '../src/drawing/styles/palette.ts';
import { PROJECT_FONT_FAMILY, registerProjectFonts } from '../src/utils/env.ts';

test('句读为硬边界，显示文本与实测词、SRT、VTT一致', () => {
  const tokens = ['好，', '继续；', '确认！', '数据、算法。'];
  const words = tokens.map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.5 }));
  const cues = segmentCaption({ index: 0, text: tokens.join(''), start: 0, end: 2.4, words }, 24);
  assert.deepEqual(cues.map(c => c.text), ['好', '继续', '确认', '数据、算法']);
  assert.deepEqual(cues.flatMap(c => c.words ?? []).map(w => w.text), cues.map(c => c.text));
  for (const word of words) assert.ok(cues.some(c => c.start <= (word.start + word.end) / 2 && c.end > (word.start + word.end) / 2));
  const vtt = toVtt(cues).replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/gu, '');
  for (const cue of cues) assert.ok(toSrt(cues).includes(cue.text) && vtt.includes(cue.text));
});

test('数值、版本、技术标识和英文词内部符号保全', () => {
  const text = '“样例-R2”使用 v1.4、1,000.50 美元；访问 https://example.com/v1.4?q=2。don’t retry!';
  const cues = segmentCaption({ index: 0, text, start: 0, end: 15 }, 40);
  const display = cues.map(c => c.text).join('');
  for (const token of ['样例-R2', 'v1.4', '1,000.50', 'https://example.com/v1.4?q=2', 'don’t']) assert.ok(display.includes(token), token);
  assert.doesNotMatch(display, /[“”；。!]/u);
});

test('跨句读的供应方词时间标记为估算，短句继续独立', () => {
  const cues = segmentCaption({ index: 0, text: '甲，乙。', start: 0, end: 2,
    words: [{ text: '甲，乙。', start: 0, end: 2 }] }, 24);
  assert.deepEqual(cues.map(c => c.text), ['甲', '乙']);
  assert.ok(cues.every(c => c.timingSource === 'estimated' && c.words === undefined));
});

test('带前缀技术词与数值单位在正文、实测词及 VTT 中保全', () => {
  const tokens = ['使用', '@sample/kernel', '.NET', './src/main.ts', '--dry-run', 'C++', '3.5%'];
  const words = tokens.map((text, i) => ({ text, start: i, end: i + 0.8 }));
  const cues = segmentCaption({ index: 0, text: tokens.join(' ') + '。', start: 0, end: 7, words }, 80);
  assert.deepEqual(cues.flatMap(c => c.words ?? []).map(w => w.text), tokens);
  const vtt = toVtt(cues);
  for (const token of tokens) assert.ok(cues.some(c => c.text.includes(token)) && vtt.includes(token));
});

test('双语字形居中保留原有基线间距', () => {
  registerProjectFonts();
  const ctx = new Canvas(1080, 1920).getContext('2d');
  const draw = ctx.fillText.bind(ctx), baselines: number[] = [];
  ctx.fillText = (text, x, y, ...args) => { baselines.push(y); draw(text, x, y, ...args); };
  drawCaptions({ ctx, cues: [{ index: 0, text: 'Agyp', translation: 'Agyp', start: 0, end: 4 }], time: 2,
    width: 1080, height: 1920, style: 'boxed', mode: 'sentence', palette: getPalette('warm_night'), fontFamily: PROJECT_FONT_FAMILY, seed: 1 });
  // 56px 主字与 35px 译文的既有行框基线差为 85px。
  assert.equal(baselines.at(-1)! - baselines[0]!, 85);
});

test('换音色的新实测词时间重新驱动字幕，原音源词时间独立保留', () => {
  const spec = validateSpec({ video: { duration: 8 }, scenes: [{ start: 0, end: 8 }],
    audio: { narration: [{ start: 0, text: '输入到达，结果就绪。', voice: 'female_calm' }] } }).spec!;
  const words = [{ text: '输入到达', start: 0.1, end: 1.5 }, { text: '结果就绪', start: 2, end: 3.5 }];
  const original = buildCaptionTrack(spec, { measured: new Map([[0, { start: 0, end: 4, words }]]) });
  const changed = buildCaptionTrack(spec, { measured: new Map([[0, { start: 0, end: 7, words: words.map(w => ({ ...w, start: w.start * 1.7, end: w.end * 1.7 })) }]]) });
  assert.deepEqual(changed.map(c => c.text), original.map(c => c.text));
  assert.equal(original[1]!.start, 1.94);
  assert.equal(changed[1]!.start, 3.34);
  assert.equal(changed.at(-1)!.end, 7);
  assert.equal(original.at(-1)!.end, 4);
});

function pixels(text: string, translation: string | undefined, width: number, height: number, background: string) {
  const canvas = new Canvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  drawCaptions({ ctx, cues: [{ index: 0, text, ...(translation ? { translation } : {}), start: 0, end: 4 }], time: 2,
    width, height, style: 'boxed', mode: 'sentence', palette: getPalette('warm_night'),
    fontFamily: PROJECT_FONT_FAMILY, seed: 1, layout: { maxWidth: 0.6 } });
  return ctx.getImageData(0, 0, width, height).data;
}

test('真实单行、多行与双语字形上下居中，共用 77.5% 屏高的外框中轴线', () => {
  registerProjectFonts();
  for (const [width, height] of [[1080, 1920], [540, 960], [1920, 1080]]) {
    for (const [text, translation] of [['字形居中 Agyp'], ['持续检查字幕的实际字形并保留足够完整阅读时间'], ['核对结果 Agyp', 'Read the result gyp']]) {
      const plate = pixels(text!, translation, width!, height!, '#ffffff');
      const ink = pixels(text!, translation, width!, height!, '#000000');
      let plateTop = height!, plateBottom = -1, inkTop = height!, inkBottom = -1;
      for (let y = 0; y < height!; y++) for (let x = 0; x < width!; x++) {
        const i = (y * width! + x) * 4;
        if (plate[i]! + plate[i + 1]! + plate[i + 2]! < 420) { plateTop = Math.min(plateTop, y); plateBottom = Math.max(plateBottom, y); }
        if (ink[i]! + ink[i + 1]! + ink[i + 2]! > 450) { inkTop = Math.min(inkTop, y); inkBottom = Math.max(inkBottom, y); }
      }
      assert.ok(inkBottom > inkTop);
      assert.ok(Math.abs((inkTop - plateTop) - (plateBottom - inkBottom)) <= 2, `${width}x${height} ${text}: ink ${inkTop}..${inkBottom}, plate ${plateTop}..${plateBottom}`);
      assert.ok(Math.abs((plateTop + plateBottom + 1) / 2 - height! * 0.775) <= 1, `${text}: frame center at 77.5%`);
    }
  }
});

test('三种字幕样式共用默认中轴线，显式底距保留位置覆盖', () => {
  registerProjectFonts();
  const ctx = new Canvas(1080, 1920).getContext('2d');
  const cue = { index: 0, text: '字幕位置', start: 0, end: 4 };
  for (const style of ['boxed', 'handwritten', 'clean'] as const) {
    const options = { ctx, width: 1080, height: 1920, style, fontFamily: PROJECT_FONT_FAMILY };
    const defaults = captionGeometry(options, cue);
    assert.equal(defaults.outerY + defaults.outerH / 2, 1488);
    const overridden = captionGeometry({ ...options, layout: { bottomInset: 0.25 } }, cue);
    assert.equal(1920 - overridden.outerY - overridden.outerH, 480);
  }
});

for (const theme of ['minimal', 'kinetic'] as const) {
  test(`${theme}: 静镜锚点固定，底部像素跨时间稳定，局部语义动作保留`, () => {
    const spec = validateSpec({ video: { width: 1080, height: 1920, duration: 6, fps: 24, seed: 9 }, style: { theme },
      scenes: [{ start: 0, end: 6, environment: 'theme_stage', cameraMove: 'static' }], captions: { enabled: false } }).spec!;
    const transforms: number[][] = [];
    const renderer = createSpecRenderer({ spec, width: 270, height: 480, drawScene: ({ ctx, sceneTime }) => {
      const m = ctx.getTransform(); transforms.push([m.a, m.b, m.c, m.d, m.e, m.f]);
      ctx.fillStyle = '#46525e'; ctx.fillRect(0, 0, 270, 480);
      ctx.fillStyle = '#ffc712'; ctx.fillRect(50, 120, 20 + sceneTime * 12, 4);
    } });
    try {
      const frames = [1, 2.5, 4].map(time => Buffer.from(renderer.renderFrame(makeFrameContext({ frameIndex: time * 24, totalFrames: 144, fps: 24, width: 270, height: 480, seed: 9 })).data));
      assert.deepEqual(transforms, transforms.map(() => [1, 0, 0, 1, 0, 0]));
      for (const frame of frames.slice(1)) assert.deepEqual(frame.subarray(350 * 270 * 4), frames[0]!.subarray(350 * 270 * 4));
      assert.notDeepEqual(frames[0], frames[2]);
    } finally { renderer.dispose(); }
  });
}
