import { createFixtureProject } from './fixtures/project.ts';
/**
 * 字幕测试（Phase F）。
 *
 * 契约要求里最容易被敷衍的两条，这里都用**可失败的断言**覆盖：
 *   - 「安全区内不溢出」：断行结果必须逐行不超过给定宽度，且字号会自动缩小
 *   - 「无豆腐块」：用 U+E000 作为 .notdef 参照，逐字比对渲染位图
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Canvas } from 'skia-canvas';

import { formatSrtTime, formatVttTime, toSrt, toVtt } from '../src/captions/export.ts';
import {
  SAFE_INSET,
  drawCaptions,
  layoutCaption,
  safeAreaFor,
  tokenizeForWrap,
  wrapTokens,
} from '../src/captions/render.ts';
import {
  activeCueAt,
  activeWordIndexAt,
  buildCaptionTrack,
  estimateSpeechSeconds,
  type CaptionCue,
  type MeasuredNarration,
} from '../src/captions/track.ts';
import { captionUnits } from '../src/captions/segment.ts';
import { registerProjectFonts, PROJECT_FONT_FAMILY, resolveFontFamily } from '../src/utils/env.ts';
import { getPalette } from '../src/drawing/styles/palette.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import type { CaptionLayoutSettings } from '../src/spec/types.ts';

const fixture = createFixtureProject();
after(fixture.cleanup);
const EXAMPLE = fixture.specPath;

/** 等宽近似测量：1 字 = 28px。让断行逻辑可以脱离 canvas 单元测试 */
const fixedMeasure = (unit = 28) => (s: string) => [...s].length * unit;

// ---------------------------------------------------------------- 分词

test('分词：CJK 逐字、Latin 按词、空格保留为显式 token', () => {
  assert.deepEqual(tokenizeForWrap('你好'), ['你', '好']);
  assert.deepEqual(tokenizeForWrap('Hello world'), ['Hello', ' ', 'world']);
  assert.deepEqual(tokenizeForWrap('这是 mixed 文本'), ['这', '是', ' ', 'mixed', ' ', '文', '本']);
  // 连续空白折叠成一个空格
  assert.deepEqual(tokenizeForWrap('a   b'), ['a', ' ', 'b']);
  // 行首空白有意丢弃：否则断行后会得到带前导空格的行
  assert.deepEqual(tokenizeForWrap('  开头有空格'), ['开', '头', '有', '空', '格']);
});

// ---------------------------------------------------------------- 断行

test('断行：内容完整、无前导空格、不超宽', () => {
  const cases = [
    '窗外的一场雨，让她忽然想起很远的地方。',
    'Hello world 这是一个 mixed 中英文 mixed 的例子。',
    '他说：『其实我早就知道了。』然后笑了笑。',
    '短。',
  ];
  for (const text of cases) {
    const lines = wrapTokens(tokenizeForWrap(text), 453, fixedMeasure());
    assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), `内容应完整: ${text}`);
    for (const l of lines) {
      assert.ok(!l.startsWith(' '), `不应有前导空格: ${JSON.stringify(l)}`);
      assert.ok(fixedMeasure()(l) <= 453, `不应超宽: ${JSON.stringify(l)}`);
    }
  }
});

test('断行：行宽尽量均衡，避免只剩两三个字的孤行', () => {
  const text = '窗外的一场雨，让她忽然想起很远的地方。';
  const lines = wrapTokens(tokenizeForWrap(text), 453, fixedMeasure());
  assert.equal(lines.length, 2);
  const lengths = lines.map((l) => [...l].length);
  const max = Math.max(...lengths);
  const min = Math.min(...lengths);
  assert.ok(
    max - min <= 3,
    `两行字数应接近，实际 ${lengths.join(' / ')}（贪心断行会得到 16/3 这种孤行）`,
  );
});

test('断行：超长无标点文本可强制硬断且不超宽', () => {
  const text = '啊'.repeat(80);
  const lines = wrapTokens(tokenizeForWrap(text), 200, fixedMeasure());
  assert.ok(lines.length > 3);
  for (const l of lines) assert.ok(fixedMeasure()(l) <= 200, '硬断后仍不应超宽');
  assert.equal(lines.join(''), text);
});

test('断行：单个超宽 Latin token 被硬断而不是溢出', () => {
  const text = 'see https://example.com/a/very/long/path/that/exceeds/the/width';
  const lines = wrapTokens(tokenizeForWrap(text), 200, fixedMeasure());
  for (const l of lines) assert.ok(fixedMeasure()(l) <= 200, `超宽行: ${l}`);
  assert.ok(lines.join('').includes('example.com'));
});

test('避头尾：逗号句号不落在行首，左括号不落在行尾', () => {
  const measure = fixedMeasure();
  const lineStarts: string[] = [];
  const lineEnds: string[] = [];

  for (let seed = 0; seed < 40; seed++) {
    // 用不同长度构造出各种断点位置
    const base = '这是一句很长的中文，用来测试避头尾规则。';
    const text = base.repeat(1 + (seed % 3));
    const lines = wrapTokens(tokenizeForWrap(text), 120 + (seed % 7) * 20, measure);
    for (const l of lines) {
      lineStarts.push(l.charAt(0));
      lineEnds.push(l.charAt(l.length - 1));
    }
  }

  for (const ch of lineStarts) {
    assert.ok(!'，。！？：；、）》」』】'.includes(ch), `行首不应出现 "${ch}"`);
  }
  for (const ch of lineEnds) {
    assert.ok(!'（《「『【'.includes(ch), `行尾不应出现 "${ch}"`);
  }
});

// ---------------------------------------------------------------- 版面

test('安全区：竖屏 1080x1920 的数值符合预期', () => {
  const safe = safeAreaFor(1080, 1920);
  assert.equal(safe.x, 1080 * SAFE_INSET.left);
  assert.equal(safe.w, 1080 * (1 - SAFE_INSET.left - SAFE_INSET.right));
  assert.equal(safe.y, 1920 * SAFE_INSET.top);
  assert.equal(safe.h, 1920 * (1 - SAFE_INSET.top - SAFE_INSET.bottom));
  // 安全区必须严格在画面内
  assert.ok(safe.x > 0 && safe.y > 0);
  assert.ok(safe.x + safe.w < 1080 && safe.y + safe.h < 1920);
});

test('版面：短文本不缩小，长文本自动缩小以保证不超安全区', () => {
  const canvas = new Canvas(1080, 1920);
  const ctx = canvas.getContext('2d');
  const safe = safeAreaFor(1080, 1920);
  const baseFontSize = Math.round(Math.min(1080, 1920) * 0.052);

  const short = layoutCaption(ctx, '窗外的一场雨。', {
    maxWidth: safe.w, maxHeight: safe.h * 0.42,
    fontFamily: 'sans-serif', baseFontSize, minFontSize: Math.round(baseFontSize * 0.55),
  });
  assert.equal(short.fontSize, baseFontSize, '短文本不应缩小字号');

  const long = layoutCaption(ctx, '雨'.repeat(150), {
    maxWidth: safe.w, maxHeight: safe.h * 0.42,
    fontFamily: 'sans-serif', baseFontSize, minFontSize: Math.round(baseFontSize * 0.55),
  });
  assert.ok(long.fontSize < baseFontSize, '超长文本应缩小字号');
  assert.ok(long.textHeight <= safe.h * 0.42 + 1, `总高应不超安全区: ${long.textHeight}`);
  for (const l of long.lines) {
    assert.ok(ctx.measureText(l).width <= safe.w + 0.5, `行宽应不超安全区: ${ctx.measureText(l).width}`);
  }
});

test('版面：即使极小字号也放不下，也绝不返回超高结果', () => {
  const canvas = new Canvas(1080, 1920);
  const ctx = canvas.getContext('2d');
  const result = layoutCaption(ctx, '超'.repeat(400), {
    maxWidth: 200, maxHeight: 120, fontFamily: 'sans-serif', baseFontSize: 40, minFontSize: 30, maxLines: 3,
  });
  assert.ok(result.textHeight <= 120 + 1, `不能超出行数/高度上限: ${result.textHeight}`);
  assert.ok(result.lines.length <= 3);
});

// ---------------------------------------------------------------- 轨道

test('时长估算只依赖文本，且随长度单调递增', () => {
  assert.equal(estimateSpeechSeconds('窗外的一场雨。'), estimateSpeechSeconds('窗外的一场雨。'));
  assert.ok(estimateSpeechSeconds('短。') < estimateSpeechSeconds('这是一句更长一些的话。'));
  assert.ok(estimateSpeechSeconds('') >= 1.0, '应保底 1 秒');
  // 中文 4.2 字/秒 + 0.55s 余量
  const t = estimateSpeechSeconds('一二三四五六七八九十');
  assert.ok(Math.abs(t - (10 / 4.2 + 0.55)) < 0.01, `估算公式不符: ${t}`);
});

test('字幕轨道：时间落在视频时长内，且按时间排序', () => {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);
  const cues = buildCaptionTrack(spec);
  assert.ok(cues.length >= spec.audio.narration.length);
  for (const c of cues) {
    assert.ok(c.start >= 0 && c.end <= spec.video.duration + 1e-9, `越界: ${c.start}..${c.end}`);
    assert.ok(c.end > c.start);
  }
  spec.audio.narration.forEach((line,i)=>assert.equal(cues.filter(c=>c.narrationIndex===i).map(c=>c.text).join('').replace(/\s/gu,''),line.text.replace(/\s/gu,'')));
  for (let i = 1; i < cues.length; i++) {
    assert.ok((cues[i] as CaptionCue).start >= (cues[i - 1] as CaptionCue).start);
  }
});

test('字幕轨道：完全落在时长之外的旁白被丢弃', () => {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);
  const cues = buildCaptionTrack({
    ...spec,
    audio: { ...spec.audio, narration: [{ start: 999, voice: 'female_calm', text: '不该出现' }] },
  });
  assert.equal(cues.length, 0);
});

test('字幕轨道：实测时间优先于估算', () => {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);
  const measured = new Map([[0, { start: 2.0, end: 3.5 }]]);
  const cues = buildCaptionTrack(spec, { measured });
  assert.equal(cues[0]?.start, 2.0);
  assert.equal(cues.at(-1)?.end, 3.5);
});

test('长段按标点及实测词拆分，保留全部原文、绝对时间和词级高亮', () => {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec!;
  const text='样本到来时，分析器选择部分数据。系统保留总容量，同时控制处理开销。';
  const tokens=['样本','到来','时','分析器','选择','部分','数据','系统','保留','总容量','同时','控制','处理','开销'];
  const words=tokens.map((text,i)=>({text,start:1+i*.65,end:1+i*.65+.5}));
  const modified={...spec,video:{...spec.video,duration:12},audio:{...spec.audio,narration:[{start:1,text,voice:'male_calm' as const}]}};
  const measured=new Map([[0,{start:1,end:11,words}]]);
  const cues=buildCaptionTrack(modified,{measured});
  assert.ok(cues.length>=4);
  assert.equal(cues.map(c=>c.text).join(''),text);
  assert.ok(cues.every(c=>c.timingSource==='words'&&captionUnits(c.text)<=24));
  assert.deepEqual(cues.flatMap(c=>c.words??[]),words);
  assert.equal(cues[0]!.start,1);assert.equal(cues.at(-1)!.end,11);
  for(let i=1;i<cues.length;i++)assert.ok(cues[i]!.start>=cues[i-1]!.end);
  const routed=cues.find(c=>c.text.includes('分析器'))!;
  assert.ok(Math.abs(routed.start-words[3]!.start)<.07);
  assert.equal(activeWordIndexAt(routed,words[3]!.start+.1),0);
  assert.equal(toSrt(cues).trim().split('\n\n').length,cues.length);
  const vtt=toVtt(cues).replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/gu,'');
  for(const cue of cues)assert.ok(vtt.includes(cue.text));
});

test('数字、单位、英文名称和 URL 保持完整，中文标点仍能断句', () => {
  const spec=validateSpec(loadSpecFile(EXAMPLE)).spec!;
  const text='Example-R1 使用 1,000 GPU 小时，成本 $2.750M。详见 https://example.com/v3.2/report。';
  const cues=buildCaptionTrack({...spec,video:{...spec.video,duration:20},audio:{...spec.audio,narration:[{start:0,text,voice:'male_calm'}]}});
  assert.equal(cues.map(c=>c.text).join('').replace(/\s/gu,''),text.replace(/\s/gu,''));
  for(const token of ['Example-R1','1,000','2.750M','https://example.com/v3.2/report'])assert.ok(cues.some(c=>c.text.includes(token)),token);
  assert.ok(cues.every(c=>c.timingSource==='estimated'));
  const nearLimit=buildCaptionTrack({...spec,video:{...spec.video,duration:20},audio:{...spec.audio,narration:[{start:0,text:'计算'.repeat(11)+'1,000小时，金额$2.750M。',voice:'male_calm'}]}});
  assert.ok(nearLimit.some(c=>c.text.includes('1,000')));
  assert.ok(nearLimit.some(c=>c.text.includes('$2.750M')));
});

test('很短的枚举词合并阅读，无标点长句按完整词拆分', () => {
  const spec=validateSpec(loadSpecFile(EXAMPLE)).spec!;
  const text='数据、算法、算力。'+ '持续改进模型能力'.repeat(5);
  const cues=buildCaptionTrack({...spec,video:{...spec.video,duration:30},audio:{...spec.audio,narration:[{start:0,text,voice:'male_calm'}]}});
  assert.ok(cues[0]!.text.includes('数据、算法、算力。'));
  assert.equal(cues.map(c=>c.text).join(''),text);
  assert.ok(cues.every(c=>captionUnits(c.text)<=24));
  const orphan='持续探索模型的推理能力并通过大量实验来验证问题。';
  const balanced=buildCaptionTrack({...spec,video:{...spec.video,duration:20},audio:{...spec.audio,narration:[{start:0,text:orphan,voice:'male_calm'}]}});
  assert.equal(balanced.map(c=>c.text).join(''),orphan);
  assert.ok(captionUnits(balanced.at(-1)!.text)>=4);
  assert.ok(balanced.every(c=>captionUnits(c.text)<=24));
});

test('词表不匹配时保留脚本、标记估算，双语保持已有对应关系', () => {
  const spec=validateSpec(loadSpecFile(EXAMPLE)).spec!;
  const text='样本到来，选择数据。';
  const measured=new Map<number,MeasuredNarration>([[0,{start:0,end:6,words:[{text:'错误词表',start:0,end:6}]}]]);
  const base={...spec,audio:{...spec.audio,narration:[{start:0,text,voice:'male_calm' as const}]}};
  const cues=buildCaptionTrack(base,{measured});
  assert.equal(cues.map(c=>c.text).join(''),text);
  assert.ok(cues.every(c=>c.timingSource==='estimated'&&!c.words));
  const bilingual=buildCaptionTrack({...base,audio:{...base.audio,narration:[{...base.audio.narration[0]!,translation:'Samples arrive, and data are selected.'}]}},{measured});
  assert.equal(bilingual.length,1);assert.equal(bilingual[0]!.text,text);
  assert.equal(bilingual[0]!.translation,'Samples arrive, and data are selected.');
});

test('片尾裁切保留已发声的词和时间，字幕之间互不重叠', () => {
  const spec=validateSpec(loadSpecFile(EXAMPLE)).spec!;
  const text='开始探索，获得结果。';
  const measured=new Map([[0,{start:1,end:7,words:[{text:'开始',start:1,end:2},{text:'探索',start:2,end:3},{text:'获得',start:4,end:5},{text:'结果',start:6,end:7}]}]]);
  const cues=buildCaptionTrack({...spec,video:{...spec.video,duration:5.5},audio:{...spec.audio,narration:[{start:1,text,voice:'male_calm'}]}},{measured});
  assert.equal(cues.at(-1)!.end,5.5);
  assert.ok(cues.every(c=>c.end>c.start&&c.end<=5.5));
  assert.ok(cues.flatMap(c=>c.words??[]).every(w=>w.start<5.5));
});

test('VTT 词级标记保留脚本的空格、标点，失配时使用完整文字', () => {
  const cue:CaptionCue={index:0,text:'Hello world，继续。',start:0,end:4,words:[{text:'Hello',start:.1,end:1},{text:'world',start:1.2,end:2},{text:'继续',start:2.5,end:3.5}]};
  const body=toVtt([cue]).replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/gu,'');
  assert.ok(body.includes(cue.text));
  assert.ok(toVtt([{...cue,words:[{text:'different',start:0,end:4}]}]).includes(cue.text));
});

test('activeCueAt / activeWordIndexAt 的边界行为', () => {
  const cues: CaptionCue[] = [
    { index: 0, text: '你好世界', start: 1, end: 3, words: [
      { text: '你好', start: 1, end: 2 },
      { text: '世界', start: 2, end: 3 },
    ] },
  ];
  assert.equal(activeCueAt(cues, 0.5), null, '开始前不显示');
  assert.equal(activeCueAt(cues, 1)?.index, 0, '起始时刻应包含');
  assert.equal(activeCueAt(cues, 3), null, '结束时刻不包含（半开区间）');
  assert.equal(activeWordIndexAt(cues[0] as CaptionCue, 1.5), 0);
  assert.equal(activeWordIndexAt(cues[0] as CaptionCue, 2.5), 1);
  assert.equal(activeWordIndexAt({ index: 0, text: 'x', start: 0, end: 1 }, 0.5), null, '无词级时间戳时返回 null');
});

// ---------------------------------------------------------------- 导出

test('时间戳格式化：含毫秒进位边界', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(1.2), '00:00:01,200');
  assert.equal(formatSrtTime(61.5), '00:01:01,500');
  assert.equal(formatSrtTime(3661.25), '01:01:01,250');
  // 关键边界：毫秒四舍五入到 1000 时必须进位，不能出现 01,1000
  assert.equal(formatSrtTime(1.9999), '00:00:02,000');
  assert.ok(!formatSrtTime(1.9999).includes('1000'));
  assert.equal(formatVttTime(1.2), '00:00:01.200');
});

test('SRT 导出格式正确（序号 / 时间行 / 文本 / 空行）', () => {
  const cues: CaptionCue[] = [
    { index: 0, text: '第一句。', start: 0, end: 1.5 },
    { index: 1, text: '第二句。', start: 2, end: 4 },
  ];
  const srt = toSrt(cues);
  const blocks = srt.trim().split('\n\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], '1\n00:00:00,000 --> 00:00:01,500\n第一句。');
  assert.equal(blocks[1], '2\n00:00:02,000 --> 00:00:04,000\n第二句。');
  assert.ok(srt.endsWith('\n'));
});

test('VTT 导出：带 WEBVTT 头，且词级时间戳以行内标签输出', () => {
  const cues: CaptionCue[] = [
    { index: 0, text: '你好世界', start: 0, end: 2, words: [
      { text: '你好', start: 0, end: 1 },
      { text: '世界', start: 1, end: 2 },
    ] },
  ];
  const vtt = toVtt(cues);
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.match(vtt, /00:00:00\.000 --> 00:00:02\.000/);
  assert.match(vtt, /<00:00:00\.000>你好<00:00:01\.000>世界/, '词级时间戳应输出为行内标签');
});

// ---------------------------------------------------------------- 双语字幕

test('双语字幕：translation 进 cue 与导出，未给译文时行为与单语一致', () => {
  const bilingual: CaptionCue = {
    index: 0,
    text: '从 A1 的输入与输出开始。',
    translation: 'It began with input and output in A1.',
    start: 0,
    end: 4,
  };
  const mono: CaptionCue = { index: 0, text: '从 A1 的输入与输出开始。', start: 0, end: 4 };

  // 两行写同一条 cue：拆成两条 cue 会让播放器分开显示，时间也不再同步
  assert.equal(toSrt([bilingual]).trim().split('\n\n').length, 1);
  assert.ok(toSrt([bilingual]).includes('从 A1 的输入与输出开始。\nIt began with input and output in A1.'));
  assert.ok(toVtt([bilingual]).includes('It began with input and output in A1.'));
  // 向后兼容：没有译文时导出与旧版逐字节一致
  assert.equal(toSrt([mono]), '1\n00:00:00,000 --> 00:00:04,000\n从 A1 的输入与输出开始。\n');
  assert.ok(!toSrt([mono]).includes('\n\n\n'));
});

test('双语字幕：非法译文被丢弃并告警，不阻断编译', () => {
  const raw = {
    version: '0.1',
    video: { width: 1920, height: 1080, fps: 24, duration: 6, seed: 3 },
    style: { preset: 'flat', palette: 'warm_night', paper: 'rough', line: 'soft_ink' },
    characters: [],
    scenes: [{
      id: 's1', start: 0, end: 6, environment: 'motion_stage', camera: 'medium',
      composition: {
        backdrop: 'studio', motif: 'none', title: '标题', bpm: 96,
        actors: [{ id: 'lead', x: 0.5, y: 0.7, scale: 1, gesture: 'idle', mood: 'curious' }],
      },
    }],
    audio: { narration: [
      { start: 0.2, voice: 'female_calm', text: '第一句。', translation: '   ' },
      { start: 3, voice: 'female_calm', text: '第二句。', translation: 'Second line.' },
    ] },
    captions: { enabled: true, style: 'boxed', mode: 'sentence' },
  };
  const outcome = validateSpec(raw);
  assert.ok(outcome.spec, '带译文与非法译文的 spec 都应能编译到可渲染状态');
  const lines = outcome.spec.audio.narration;
  assert.equal(lines[0]?.translation, undefined, '空白译文应被当作「没有」，而不是空行');
  assert.equal(lines[1]?.translation, 'Second line.');
  assert.ok(outcome.issues.some((i) => i.code === 'EMPTY_TRANSLATION'), '应给出 EMPTY_TRANSLATION 告警');
  // 修复轨迹可核对：丢弃译文不应改变朗读文本与起始时间
  assert.equal(lines[0]?.text, '第一句。');
  assert.equal(lines[0]?.start, 0.2);
});

/**
 * 双语字幕像素探针：第二行真的画上去了吗，两行有没有溢出安全区。
 *
 * 量测的是文字本身的像素（亮色），不是底板——「看起来有一块底板」不能证明字被画出来了。
 */
function captionInk(cue: CaptionCue, width = 1920, height = 1080, layout?: CaptionLayoutSettings): { ink: number; minX: number; maxX: number; minY: number; maxY: number } {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  drawCaptions({
    ctx, cues: [cue], time: (cue.start + cue.end) / 2, width, height,
    style: 'clean', mode: 'sentence', palette: getPalette('warm_night'),
    fontFamily: PROJECT_FONT_FAMILY, seed: 4242,
    layout,
  });
  const d = ctx.getImageData(0, 0, width, height).data;
  let ink = 0, minX = Number.POSITIVE_INFINITY, maxX = -1, minY = Number.POSITIVE_INFINITY, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const sum = (d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number);
      if (sum <= 240) continue; // 底板与阴影远暗于此阈值
      ink++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { ink, minX, maxX, minY, maxY };
}

test('竖屏字幕可缩小、降低并收窄，双语文字仍在指定版面内', () => {
  registerProjectFonts();
  const cue: CaptionCue = { index: 0, text: '位置改变，圆点向右移动。', translation: 'A dot moves to the right.', start: 0, end: 4 };
  const layout = { fontScale: 40 / 1080, translationScale: 0.625, maxWidth: 0.6, bottomInset: 0.11 };
  const original = captionInk(cue, 1080, 1920);
  const compact = captionInk(cue, 1080, 1920, layout);
  const safe = safeAreaFor(1080, 1920, layout);
  assert.ok(compact.ink > 0 && compact.ink < original.ink);
  assert.ok(compact.maxY > original.maxY);
  assert.ok(compact.minX >= safe.x - 1 && compact.maxX <= safe.x + safe.w + 1);
  assert.ok(compact.minY >= safe.y - 1 && compact.maxY <= safe.y + safe.h + 1);
  const largerTranslation = captionInk(cue, 1080, 1920, { ...layout, translationScale: 1 });
  assert.ok(largerTranslation.ink > compact.ink);
});

test('双语字幕：第二行真的画出像素，且两行都在安全区内', () => {
  registerProjectFonts();
  const text = '使用 12.5 万条样本完成实验，累计运行 320.0 个测试小时。';
  const translation = 'Tested on 125 thousand samples for a total of 320.0 hours.';
  const mono = captionInk({ index: 0, text, start: 0, end: 6 });
  const bilingual = captionInk({ index: 0, text, translation, start: 0, end: 6 });

  assert.ok(mono.ink > 0, '单语字幕应有文字像素');
  assert.ok(bilingual.ink > mono.ink, `双语应多出第二行的墨迹（${bilingual.ink} vs ${mono.ink}）`);
  // 底板贴安全区下沿向上生长：多一行 → 最高像素点上移
  assert.ok(bilingual.minY < mono.minY, `第二行应把版面向上推开（${bilingual.minY} vs ${mono.minY}）`);

  const safe = safeAreaFor(1920, 1080);
  assert.equal(safe.y, 1080 * SAFE_INSET.top, '安全区计算应使用同一份常量');
  assert.ok(bilingual.minX >= safe.x - 1, `左溢出：${bilingual.minX} < ${safe.x}`);
  assert.ok(bilingual.maxX <= safe.x + safe.w + 1, `右溢出：${bilingual.maxX} > ${safe.x + safe.w}`);
  assert.ok(bilingual.minY >= safe.y - 1, `上溢出：${bilingual.minY} < ${safe.y}`);
  assert.ok(bilingual.maxY <= safe.y + safe.h + 1, `下溢出：${bilingual.maxY} > ${safe.y + safe.h}`);
});

test('双语字幕：底板宽度包住更宽的那一行（英文行不得露在底板外）', () => {
  registerProjectFonts();
  const W = 1920, H = 1080;
  const canvas = new Canvas(W, H);
  const ctx = canvas.getContext('2d');
  // 浅色背景：底板是深色的，任何“亮色文字落在白底上”都说明文字跑到板子外面了
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const cue: CaptionCue = {
    index: 0,
    text: '记录并核对实验结果。',
    translation: 'Record each step of the example experiment, then verify the results against the expected values.',
    start: 0,
    end: 8,
  };
  drawCaptions({
    ctx, cues: [cue], time: 4, width: W, height: H,
    style: 'boxed', mode: 'sentence', palette: getPalette('warm_night'),
    fontFamily: PROJECT_FONT_FAMILY, seed: 99,
  });
  const d = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number): number => {
    const i = (y * W + x) * 4;
    return (d[i] as number) + (d[i + 1] as number) + (d[i + 2] as number);
  };
  // 底板包围盒（深色像素）。阈值 420 只取底板本体，抗锯齿边缘的中间色不计入。
  let plateMinX = W, plateMaxX = -1, plateMinY = H, plateMaxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (at(x, y) >= 420) continue;
    if (x < plateMinX) plateMinX = x;
    if (x > plateMaxX) plateMaxX = x;
    if (y < plateMinY) plateMinY = y;
    if (y > plateMaxY) plateMaxY = y;
  }
  assert.ok(plateMaxX > plateMinX, '应能找到底板像素（boxed 样式的深色底板）');
  // 板边 ±3px 的抗锯齿过渡带不计；带外任何亮色像素都是「文字露在底板外」
  const HALO = 3;
  let spilled = 0, firstSpill = -1;
  for (let y = plateMinY; y <= plateMaxY; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= plateMinX - HALO && x <= plateMaxX + HALO) continue;
      const sum = at(x, y);
      if (sum >= 430 && sum <= 745) {
        spilled++;
        if (firstSpill < 0) firstSpill = x;
      }
    }
  }
  assert.equal(spilled, 0, `${spilled} 个文字像素落在底板外（板 ${plateMinX}..${plateMaxX}，首个溢出 x=${firstSpill}）`);
});

test('双语字幕：两行都很长时自动缩小字号，仍不溢出安全区', () => {
  registerProjectFonts();
  const ink = captionInk({
    index: 0,
    text: '这是一个刻意写得非常长的中文测试句子，用来验证在第二行存在的情况下主行会继续按安全区收窄字号而不会硬撑到画面外面去。',
    translation: 'A deliberately long English caption line that verifies the layout shrinks the font instead of overflowing the safe area boundary.',
    start: 0,
    end: 8,
  });
  const safe = safeAreaFor(1920, 1080);
  assert.ok(ink.ink > 0, '长文本仍应画出像素');
  assert.ok(ink.minY >= safe.y - 1 && ink.maxY <= safe.y + safe.h + 1, '长双语字幕不得纵向溢出安全区');
  assert.ok(ink.minX >= safe.x - 1 && ink.maxX <= safe.x + safe.w + 1, '长双语字幕不得横向溢出安全区');
});

// ---------------------------------------------------------------- 字体

/**
 * 豆腐块检测：把单字渲染到黑底，与「必定缺失」的 U+E000 位图比对。
 * 检测方法在本文件用阳性对照验证
 * （U+E000 与 U+10FFFD 位图逐字节相同，确认为 .notdef）。
 */
function glyphHash(font: string, ch: string): { ink: number; hash: string } {
  const size = 96;
  const canvas = new Canvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.font = `400 64px "${font}"`;
  ctx.textBaseline = 'top';
  ctx.fillText(ch, 8, 8);
  const d = ctx.getImageData(0, 0, size, size).data;
  let ink = 0;
  let hash = 2166136261;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] as number;
    if (v > 40) ink++;
    hash = Math.imul(hash ^ v, 16777619);
  }
  return { ink, hash: (hash >>> 0).toString(16) };
}

test('字幕字体：项目字体已注册，且字幕用字全部有字形（无豆腐块）', () => {
  const state = registerProjectFonts();
  assert.equal(state.registered, true, `项目字体应已注册（运行 pnpm fonts）: ${state.filePath}`);
  assert.equal(resolveFontFamily(true), PROJECT_FONT_FAMILY, '应优先使用项目字体而非系统字体');

  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);

  // 字幕实际要用到的全部字符：脚本文本 + 中文标点 + 数字 + 常见混排
  const chars = new Set<string>();
  for (const line of spec.audio.narration) for (const ch of line.text) chars.add(ch);
  for (const ch of '，。！？：；、“”（）—…、《》0123456789ABCabc') chars.add(ch);

  const tofu = glyphHash(PROJECT_FONT_FAMILY, '\uE000');
  const missing: string[] = [];
  for (const ch of chars) {
    if (/\s/.test(ch)) continue;
    const bm = glyphHash(PROJECT_FONT_FAMILY, ch);
    if (bm.ink === 0 || bm.hash === tofu.hash) missing.push(ch);
  }
  assert.deepEqual(missing, [], `以下字符在项目字体里缺字形（会显示豆腐块）: ${missing.join(' ')}`);
});

test('豆腐块检测器自身有效（阳性对照）', () => {
  const tofu = glyphHash(PROJECT_FONT_FAMILY, '\uE000');
  assert.ok(tofu.ink > 0, '.notdef 应当有墨迹（是个方框）');
  // 另一个未分配码位应得到完全相同的位图
  // 注意必须用 \u{...} 形式：'\u10FFFD' 会被解析成 U+10FF 加字面量 "FD"
  assert.equal(glyphHash(PROJECT_FONT_FAMILY, '\u{10FFFD}').hash, tofu.hash, '未分配码位应渲染为同一个 .notdef');
  // 真实汉字必须不同
  assert.notEqual(glyphHash(PROJECT_FONT_FAMILY, '画').hash, tofu.hash, '汉字应有真实字形');
});
