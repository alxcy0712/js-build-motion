/**
 * 字幕轨道（需求 §17）。
 *
 * 关键约束：**字幕文本与配音共用同一份脚本，不存在 ASR 反向生成。**
 *
 *   脚本 → TTS → 音频
 *   脚本 → 字幕引擎 → 画面上的字      ← 就是这里
 *
 * 之所以强调这一点：一旦走「先生成音频、再语音识别出字幕」，中文专有名词几乎必然出错
 * （人名、术语、同音字），而且平白多一次模型调用。文本本来就在手里。
 *
 * 时长来源分两级（§17 允许先做句级）：
 *   1. 若 TTS provider 返回了实测时长/词级时间戳 → 直接采用（t-audio 提供）
 *   2. 否则用确定性估算 —— 只依赖文本本身，因此同一 spec 任何时候都得到同一时间轴
 */

import type {
  NarrationLine,
  ResolvedVideoSpec,
} from '../spec/types.ts';
import { CAPTION_LAYOUT_DEFAULTS } from '../spec/types.ts';
import { segmentCaption } from './segment.ts';

export interface CaptionWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface CaptionCue {
  readonly index: number;
  readonly text: string;
  /** 第二语言字幕行；缺失时按单语字幕渲染与导出 */
  readonly translation?: string;
  /** 绝对时间（秒，相对视频开头） */
  readonly start: number;
  readonly end: number;
  /** 词级时间戳。缺失时渲染层退化为整句显示 */
  readonly words?: readonly CaptionWord[];
  /** 原旁白下标；一段旁白可对应多条字幕。 */
  readonly narrationIndex?: number;
  /** 分句时间的依据；估算时间需要在实际配音中复核。 */
  readonly timingSource?: 'words' | 'estimated' | 'authored';
}

/**
 * 中文语速估算（字/秒）。
 *
 * 取值依据：普通话朗读约 240~300 字/分钟，即 4~5 字/秒。
 * 取 4.2 是偏保守的下限——宁可字幕停留略久，也不要还没读完就消失。
 * Latin 单词另按 2.6 词/秒计（英文朗读约 150 wpm）。
 */
export const CJK_CHARS_PER_SECOND = 4.2;
export const LATIN_WORDS_PER_SECOND = 2.6;
/** 每条字幕首尾的停留余量 */
export const SPEECH_PADDING_SECONDS = 0.55;

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

/** 估算一段文本的朗读秒数。纯函数，只依赖文本 */
export function estimateSpeechSeconds(text: string): number {
  let cjk = 0;
  let latinWords = 0;
  let inWord = false;

  for (const ch of text) {
    if (CJK.test(ch)) {
      cjk++;
      inWord = false;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      if (!inWord) latinWords++;
      inWord = true;
    } else {
      inWord = false;
    }
  }

  const seconds = cjk / CJK_CHARS_PER_SECOND + latinWords / LATIN_WORDS_PER_SECOND;
  return Math.max(1.0, seconds + SPEECH_PADDING_SECONDS);
}

export interface MeasuredNarration {
  readonly start: number;
  readonly end: number;
  readonly words?: readonly CaptionWord[];
}

export interface BuildCaptionTrackOptions {
  /**
   * 来自 TTS 的实测时间（键为 narration 数组下标）。
   * 有实测就用实测；缺失的条目回退到估算。两者混用是允许的。
   */
  readonly measured?: ReadonlyMap<number, MeasuredNarration>;
  /** 字幕在视频结束前需要留出的最短时间，避免最后一条被截断 */
  readonly videoDuration?: number;
}

export function captionUnitLimit(spec: ResolvedVideoSpec): number {
  const fontSize = Math.min(spec.video.width,spec.video.height) * (spec.captions.fontScale ?? CAPTION_LAYOUT_DEFAULTS.fontScale);
  const lineUnits = spec.video.width * (spec.captions.maxWidth ?? CAPTION_LAYOUT_DEFAULTS.maxWidth) / fontSize;
  return Math.max(4,Math.min(24,Math.floor(lineUnits*2)-2));
}

/**
 * 由 spec 生成字幕轨道。
 *
 * 输出按时间排序，且**不与视频时长冲突**：超出末尾的条目会被截断到时长边界，
 * 完全落在时长之外的条目会被丢弃（repair 层已就此事告警过）。
 */
export function buildCaptionTrack(
  spec: ResolvedVideoSpec,
  options: BuildCaptionTrackOptions = {},
): CaptionCue[] {
  const duration = options.videoDuration ?? spec.video.duration;
  const narration: readonly NarrationLine[] = spec.audio.narration;
  const limit = captionUnitLimit(spec);

  const cues: CaptionCue[] = [];
  narration.forEach((line, i) => {
    const measured = options.measured?.get(i);
    const start = measured?.start ?? line.start;
    const end = measured?.end ?? start + estimateSpeechSeconds(line.text);

    if (start >= duration) return;

    if (end <= start) return;

    const parent: CaptionCue = {
      index: cues.length,
      narrationIndex:i,
      text: line.text,
      start,
      end,
      ...(line.translation ? { translation: line.translation } : {}),
      ...(measured?.words ? { words: clipWords(measured.words, start, end) } : {}),
    };
    for (const part of segmentCaption(parent,limit)) {
      const clampedEnd = Math.min(part.end,duration);
      if (part.start >= clampedEnd) continue;
      cues.push({...part,end:clampedEnd,...(part.words ? {words:clipWords(part.words,part.start,clampedEnd)} : {})});
    }
  });

  cues.sort((a, b) => a.start - b.start);
  // 排序后重编号，保证 index 与显示顺序一致
  return cues.map((c, i) => ({ ...c, index: i, end:Math.min(c.end,cues[i+1]?.start ?? duration) }))
    .filter(c=>c.end>c.start).map((c,i)=>({...c,index:i}));
}

function clipWords(
  words: readonly CaptionWord[],
  start: number,
  end: number,
): CaptionWord[] {
  return words.filter((w) => w.end > start && w.start < end);
}

/** 找出某一时刻应显示的字幕；无则返回 null。 */
export function activeCueAt(cues: readonly CaptionCue[], time: number): CaptionCue | null {
  for (const c of cues) {
    if (time >= c.start && time < c.end) return c;
  }
  return null;
}

/**
 * 判断某个词在给定时刻是否「正在被念到」。
 * 词级高亮（卡拉OK）用；没有词级时间戳时返回 null。
 */
export function activeWordIndexAt(cue: CaptionCue, time: number): number | null {
  if (!cue.words?.length) return null;
  for (let i = 0; i < cue.words.length; i++) {
    const w = cue.words[i] as CaptionWord;
    if (time >= w.start && time < w.end) return i;
  }
  return null;
}
