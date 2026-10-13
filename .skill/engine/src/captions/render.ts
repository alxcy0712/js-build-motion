/**
 * 字幕渲染（需求 §18、§26、§37）。
 *
 * 三条硬约束：
 *
 * 1. **用 Skia 直接画进帧里**，不用 ffmpeg drawtext。
 *    理由不是性能，而是表达力：手写感、逐字出现、关键词放大、纸片背景、
 *    甚至让文字和画面互动——这些 drawtext 都做不到。
 *    .srt/.vtt 只作为外挂产物（export.ts）。
 *
 * 2. **必须在安全区内**。竖屏更是如此：底部会被平台 UI 遮挡，
 *    顶部会被刘海/状态栏遮挡。超长文本一律换行，再不行就缩小字号。
 *
 * 3. **字体必须显式注册的项目字体**，不依赖系统字体（§26）。
 *    字体族由调用方传入（来自 env.resolveFontFamily），本模块不自己决定。
 *
 * 中文换行不是"按宽度切"那么简单：还有避头尾（禁则）——
 * 逗号句号不能出现在行首，左括号不能出现在行尾。这里实现了基本规则。
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import { CAPTION_LAYOUT_DEFAULTS, type CaptionLayoutSettings, type CaptionMode, type CaptionStyle } from '../spec/types.ts';
import { SeededRandom } from '../animation/random.ts';
import { mix, type PaletteColors } from '../drawing/styles/palette.ts';
import { activeCueAt, activeWordIndexAt, type CaptionCue } from './track.ts';

// ---------------------------------------------------------------- 安全区

export interface SafeArea {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 竖屏安全区（相对画面尺寸的比例）。
 *
 * 默认底部留14%、水平各留8%，供竖屏字幕布局使用。
 */
export const SAFE_INSET = { left: 0.08, right: 0.08, top: 0.08, bottom: CAPTION_LAYOUT_DEFAULTS.bottomInset } as const;

export function safeAreaFor(width: number, height: number, layout: CaptionLayoutSettings = {}): SafeArea {
  const w = width * (layout.maxWidth ?? (1 - SAFE_INSET.left - SAFE_INSET.right));
  return {
    x: layout.maxWidth === undefined ? width * SAFE_INSET.left : (width - w) / 2,
    y: height * SAFE_INSET.top,
    w,
    h: height * (1 - SAFE_INSET.top - (layout.bottomInset ?? CAPTION_LAYOUT_DEFAULTS.bottomInset)),
  };
}

// ---------------------------------------------------------------- 断行

/** 不能出现在行首的字符（避头） */
const NO_LINE_START = new Set([...'，。！？：；、）》」』】｝〉·…—～%!?,.:;)]}\'"']);
/** 不能出现在行尾的字符（避尾） */
const NO_LINE_END = new Set([...'（《「『【｛〈([{']);

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/**
 * 切分为可断行单元。
 * CJK 逐字成 token（中文可以在任意字间断行），Latin/数字按词成 token。
 *
 * 空格必须保留为**显式 token**：初版直接丢弃空格，结果 "Hello world" 被拼成
 * "Helloworld"，中英混排里的间隔也全部消失。
 * 行首的空格在断行时丢弃、行尾的空格在成行时裁掉，因此不会出现多余空白。
 */
export function tokenizeForWrap(text: string): string[] {
  const tokens: string[] = [];
  let word = '';

  const flushWord = (): void => {
    if (word) {
      tokens.push(word);
      word = '';
    }
  };

  for (const ch of text) {
    if (/\s/.test(ch)) {
      flushWord();
      // 连续空白折叠成一个空格 token
      if (tokens.length > 0 && tokens[tokens.length - 1] !== ' ') tokens.push(' ');
      continue;
    }
    if (CJK_RE.test(ch)) {
      flushWord();
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  flushWord();
  return tokens;
}

/**
 * 贪心断行（不做避头尾修正）。返回行数组。
 * 抽出来是因为均衡化需要反复试算不同宽度下的行数。
 */
function wrapGreedy(
  tokens: readonly string[],
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let current = '';

  for (const token of tokens) {
    // 行首不能以空格开头
    if (current === '' && token === ' ') continue;

    // token 自身就超宽（一长串英文/URL，且前面已经有过内容）时，
    // 必须先收尾当前行、再把 token 硬断。
    // 初版把硬断限定在 `!current` 条件里，导致 "see https://...very/long"
    // 里的那个超长 token 根本没被断开，直接溢出了一行。
    if (token !== ' ' && measure(token) > maxWidth) {
      if (current) {
        lines.push(trimEnd(current));
        current = '';
      }
      let chunk = '';
      for (const ch of token) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
      continue;
    }

    const candidate = current + token;
    if (current && measure(candidate) > maxWidth) {
      lines.push(trimEnd(current));
      // 断行处如果下一个 token 正好是空格，不能把它当作新行的内容——
      // 否则会得到 " mixed 中英文" 这种带前导空格的行。
      current = token === ' ' ? '' : token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(trimEnd(current));
  return lines;
}

/** 去掉行尾空白（避免断行处多出一个不可见的空格影响后续测量） */
function trimEnd(s: string): string {
  return s.replace(/\s+$/u, '');
}

/**
 * 均衢断行：在**不增加行数**的前提下，把各行宽度尽量拉齐。
 *
 * 为什么需要它：朴素贪心会把第一行塞满，最后一行只剩两三个字——
 * 中文里这叫「孤字」，观感很差（实测：「……很远的 / 地方。」）。
 *
 * 做法：二分找到「仍能得到相同行数」的最小允许宽度。
 * 宽度压得越紧，断点就越靠前，各行越均匀。
 * 由于最终宽度 <= maxWidth，因此不可能反而超宽。
 */
function wrapBalanced(
  tokens: readonly string[],
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const base = wrapGreedy(tokens, maxWidth, measure);
  const target = base.length;
  if (target <= 1) return base;

  let lo = 1;
  let hi = maxWidth;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wrapGreedy(tokens, mid, measure).length > target) lo = mid + 1;
    else hi = mid;
  }

  const balanced = wrapGreedy(tokens, lo, measure);
  return balanced.length === target ? balanced : base;
}

/**
 * 按宽度断行，应用行宽均衢与中文避头尾规则。
 *
 * @param measure 测量一段文本宽度（注入以便测试，不依赖真实 canvas）
 */
export function wrapTokens(
  tokens: readonly string[],
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const lines = wrapBalanced(tokens, maxWidth, measure);
  applyKinjsaku(lines);
  return lines;
}

/** 避头尾修正：把行首的禁则标点提到上一行行尾，把行尾的左括号推到下一行行首 */
function applyKinjsaku(lines: string[]): void {
  // 用 charAt 而不是 [0]：noUncheckedIndexedAccess 下字符串下标会得到 string|undefined，
  // 而 charAt 的返回类型就是 string（越界时为空串），语义更贴切也更少噪音。
  for (let i = 1; i < lines.length; i++) {
    let guard = 0;
    while (guard++ < 8) {
      const cur = lines[i];
      const prev = lines[i - 1];
      if (cur === undefined || prev === undefined || cur.length === 0 || prev.length === 0) break;
      const first = cur.charAt(0);
      if (!NO_LINE_START.has(first)) break;
      lines[i - 1] = prev + first;
      lines[i] = cur.slice(1);
    }
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line === undefined || next === undefined || line.length <= 1) continue;
    const last = line.charAt(line.length - 1);
    if (!NO_LINE_END.has(last)) continue;
    lines[i] = line.slice(0, -1);
    lines[i + 1] = last + next;
  }
}

// ---------------------------------------------------------------- 版面

export interface CaptionLayout {
  readonly lines: readonly string[];
  readonly fontSize: number;
  readonly lineHeight: number;
  /** 实际最宽一行的宽度 */
  readonly textWidth: number;
  readonly textHeight: number;
}

export interface LayoutOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly fontFamily: string;
  readonly baseFontSize: number;
  readonly minFontSize: number;
  readonly weight?: number;
  /** 最多几行；超出则继续缩小字号 */
  readonly maxLines?: number;
}

/**
 * 计算字幕版面：断行 + 必要时缩小字号。
 *
 * 返回的 lines 保证每一行都 <= maxWidth，且总高 <= maxHeight
 * （除非已达到 minFontSize 仍放不下——此时返回最后一次尝试的结果并保持不越界的外框）。
 */
/**
 * 版面缓存。
 *
 * 为什么必须有（实测）：版面只取决于「文本 + 字体 + 可用宽高」，
 * 与时间无关，但最初每帧都重算。代价比想象中大得多：
 *   字号循环（最多 7 档）× wrapBalanced 的二分（约 12 次）× 每字一次 measureText
 *   ≈ 每帧上千次 measureText。
 * 实测后果：整帧成本从 5ms 直接跳到 12ms（540×960），
 * 且表现为「旁白一开始画面就变慢」这种很难归因的现象——
 * 是通过逐帧打印耗时、看到第 29 帧（=旁白起始 1.2s）出现台阶才定位到的。
 *
 * 缓存后同一句字幕只算一次。
 */
const layoutCache = new Map<string, CaptionLayout>();
const LAYOUT_CACHE_LIMIT = 64;

function layoutCacheKey(text: string, o: LayoutOptions): string {
  return [
    text,
    o.fontFamily,
    o.maxWidth,
    o.maxHeight,
    o.baseFontSize,
    o.minFontSize,
    o.maxLines ?? 4,
    o.weight ?? 700,
  ].join('|');
}

/** 清空版面缓存（测试用；字体注册发生变化时也应调用） */
export function clearCaptionLayoutCache(): void {
  layoutCache.clear();
}

export function layoutCaption(
  ctx: CanvasRenderingContext2D,
  text: string,
  o: LayoutOptions,
): CaptionLayout {
  const key = layoutCacheKey(text, o);
  const cached = layoutCache.get(key);
  if (cached) return cached;
  const computed = computeLayout(ctx, text, o);
  // 上限保护：字幕文本种类有限，但不要让它无限增长
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
  layoutCache.set(key, computed);
  return computed;
}

function computeLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  o: LayoutOptions,
): CaptionLayout {
  const weight = o.weight ?? 700;
  const maxLines = o.maxLines ?? 4;
  const tokens = tokenizeForWrap(text);

  let best: CaptionLayout | null = null;

  for (let size = o.baseFontSize; size >= o.minFontSize; size -= 2) {
    const lineHeight = Math.round(size * 1.45);
    ctx.font = `${weight} ${size}px "${o.fontFamily}"`;
    const measure = (s: string): number => ctx.measureText(s).width;
    const lines = wrapTokens(tokens, o.maxWidth, measure);
    const textWidth = lines.reduce((m, l) => Math.max(m, measure(l)), 0);
    const textHeight = lines.length * lineHeight;

    const candidate: CaptionLayout = { lines, fontSize: size, lineHeight, textWidth, textHeight };

    if (lines.length <= maxLines && textHeight <= o.maxHeight && textWidth <= o.maxWidth) {
      return candidate;
    }
    best = candidate;
  }

  // 已经到最小字号仍放不下：截断行数，绝不让文本溢出安全区
  const fallback = best ?? {
    lines: [text],
    fontSize: o.minFontSize,
    lineHeight: Math.round(o.minFontSize * 1.45),
    textWidth: o.maxWidth,
    textHeight: Math.round(o.minFontSize * 1.45),
  };
  const allowed = Math.max(1, Math.floor(o.maxHeight / fallback.lineHeight));
  return { ...fallback, lines: fallback.lines.slice(0, allowed), textHeight: Math.min(fallback.textHeight, allowed * fallback.lineHeight) };
}

// ---------------------------------------------------------------- 绘制

export interface DrawCaptionsOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly cues: readonly CaptionCue[];
  readonly time: number;
  readonly width: number;
  readonly height: number;
  readonly style: CaptionStyle;
  readonly mode: CaptionMode;
  readonly palette: PaletteColors;
  /** 项目字体族，来自 resolveFontFamily() */
  readonly fontFamily: string;
  readonly seed: number;
  readonly layout?: CaptionLayoutSettings;
  /** 风格配色（themes/）；缺省沿用原水彩字幕配色 */
  readonly themeColors?: { readonly text: string; readonly active: string; readonly plate: string; readonly secondary: string };
}

/**
 * 把当前生效的字幕画进帧里。
 *
 * 竖屏字幕统一**底部对齐到安全区下沿**：多行时向上生长。
 * 这样单行与多行不会让画面重心上下跳。
 */
export function drawCaptions(o: DrawCaptionsOptions): void {
  const cue = activeCueAt(o.cues, o.time);
  if (!cue) return;

  const ctx = o.ctx;
  const safe = safeAreaFor(o.width, o.height, o.layout);

  const baseFontSize = Math.round(Math.min(o.width, o.height) * (o.layout?.fontScale ?? CAPTION_LAYOUT_DEFAULTS.fontScale));
  const layout = layoutCaption(ctx, cue.text, {
    maxWidth: safe.w,
    maxHeight: safe.h * 0.42,
    fontFamily: o.fontFamily,
    baseFontSize,
    minFontSize: Math.round(baseFontSize * 0.55),
    maxLines: cue.translation ? 4 : 2,
  });

  // 双语字幕的第二行：字号小一号、颜色略淡，与主行共用同一块底板与时间轴。
  // 主行已经占满 42% 安全区时，这里会自动把可用高度压到剩下的部分。
  const gap = Math.round(layout.fontSize * 0.34);
  const secondarySize = Math.round(baseFontSize * (o.layout?.translationScale ?? CAPTION_LAYOUT_DEFAULTS.translationScale));
  const secondaryLayout = cue.translation
    ? layoutCaption(ctx, cue.translation, {
      maxWidth: safe.w,
      maxHeight: Math.max(secondarySize, safe.h - layout.textHeight - gap),
      fontFamily: o.fontFamily,
      baseFontSize: secondarySize,
      minFontSize: Math.round(secondarySize * 0.6),
      maxLines: 2,
    })
    : null;

  const padX = Math.round(layout.fontSize * 0.7);
  const padY = Math.round(layout.fontSize * 0.5);
  // 底板必须包住**最宽的那一行**：双语时英文行通常比中文行宽，
  // 若只按主行算宽度，第二行会露在底板外面，在浅色背景上直接读不清。
  // 底板也不得越过安全区：它仍是「会出现在屏幕上的墨迹」，
  // 越界的那部分在平台裁切/叠加 UI 时会被吃掉，不能靠「反正字在里面」蒙过去。
  const widestLine = Math.max(layout.textWidth, secondaryLayout?.textWidth ?? 0);
  const plateW = Math.min(safe.w, widestLine + padX * 2);
  const plateH = layout.textHeight + padY * 2 + (secondaryLayout ? gap + secondaryLayout.textHeight : 0);
  const plateX = o.width / 2 - plateW / 2;
  // 底边贴安全区下沿
  const plateY = safe.y + safe.h - plateH;

  ctx.save();

  // ---- 底板 ----
  if (o.style === 'boxed' || o.style === 'handwritten') {
    const plateAlpha = o.style === 'boxed' ? 0.82 : 0.62;
    ctx.globalAlpha = plateAlpha;
    ctx.fillStyle = o.themeColors?.plate ?? mix(o.palette.shadow, '#000000', 0.45);
    ctx.beginPath();
    ctx.roundRect(plateX, plateY, plateW, plateH, Math.round(layout.fontSize * 0.34));
    ctx.fill();

    if (o.style === 'handwritten') {
      // 手写感：底板外再套一层更淡的、略微错位的框，像"描了两遍"
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.roundRect(plateX - 3, plateY - 2, plateW + 6, plateH + 4, Math.round(layout.fontSize * 0.36));
      ctx.fill();
    }
  } else {
    // clean：不铺底板，用柔和阴影保证在各种背景上都可读
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.roundRect(plateX + 2, plateY + 3, plateW, plateH, Math.round(layout.fontSize * 0.34));
    ctx.fill();
  }

  // ---- 文本 ----
  const isWordMode = o.mode === 'word';
  const activeWord = isWordMode ? activeWordIndexAt(cue, o.time) : null;

  // 逐词切分（仅 word 模式需要），并保留词边界以便着色
  const wordSpans = isWordMode ? splitIntoWordSpans(cue) : null;

  let y = plateY + padY;
  let charIndexAll = 0;

  for (let lineIdx = 0; lineIdx < layout.lines.length; lineIdx++) {
    const line = layout.lines[lineIdx] as string;
    ctx.font = `700 ${layout.fontSize}px "${o.fontFamily}"`;
    const lineWidth = ctx.measureText(line).width;
    let x = o.width / 2 - lineWidth / 2;
    const baseline = y + layout.lineHeight * 0.5;

    for (const ch of line) {
      const advance = ctx.measureText(ch).width;
      const active = isActiveChar(wordSpans, activeWord, charIndexAll);

      // 手写抖动：由 (seed, cue, char) 决定 → 同一帧稳定，不闪烁
      const jitter = new SeededRandom((o.seed ^ (cue.index * 7919) ^ (charIndexAll * 131)) >>> 0);
      const dy = o.style === 'handwritten' ? jitter.range(-1.6, 1.6) : 0;
      const rot = o.style === 'handwritten' ? jitter.range(-0.022, 0.022) : 0;

      if (active) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = o.palette.accent;
        ctx.beginPath();
        ctx.roundRect(x - advance * 0.08, y + layout.lineHeight * 0.06, advance * 1.16, layout.lineHeight * 0.82, layout.fontSize * 0.2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = active ? (o.themeColors?.active ?? '#ffd666') : (o.themeColors?.text ?? '#f6f2e8');

      if (rot !== 0 || dy !== 0) {
        ctx.save();
        ctx.translate(x + advance / 2, baseline + dy);
        ctx.rotate(rot);
        ctx.fillText(ch, -advance / 2, 0);
        ctx.restore();
      } else {
        ctx.fillText(ch, x, baseline + dy);
      }

      x += advance;
      charIndexAll++;
    }

    y += layout.lineHeight;
  }

  if (secondaryLayout) {
    y += gap;
    for (const line of secondaryLayout.lines) {
      ctx.font = `600 ${secondaryLayout.fontSize}px "${o.fontFamily}"`;
      const lineWidth = ctx.measureText(line).width;
      ctx.globalAlpha = 0.86;
      ctx.fillStyle = o.themeColors?.secondary ?? '#d9d4c8';
      ctx.fillText(line, o.width / 2 - lineWidth / 2, y + secondaryLayout.lineHeight * 0.5);
      y += secondaryLayout.lineHeight;
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

interface WordSpan {
  readonly start: number;
  readonly end: number;
}

/** 把 cue 的文本切成与 words 对应的字符区间（仅在使用词级时间戳时可用） */
function splitIntoWordSpans(cue: CaptionCue): WordSpan[] | null {
  if (!cue.words?.length) return null;
  const spans: WordSpan[] = [];
  let cursor = 0;
  for (const w of cue.words) {
    // cue.text 里词与词之间可能有空格，这里按顺序在文本中定位
    const idx = cue.text.indexOf(w.text, cursor);
    if (idx < 0) return null; // 文本与词表对不上：放弃词级高亮，退化为整句
    spans.push({ start: idx, end: idx + w.text.length });
    cursor = idx + w.text.length;
  }
  return spans;
}

function isActiveChar(spans: WordSpan[] | null, activeWord: number | null, charIndex: number): boolean {
  if (!spans || activeWord === null) return false;
  const span = spans[activeWord];
  if (!span) return false;
  return charIndex >= span.start && charIndex < span.end;
}

/** 供测试与调试：只算版面不落笔 */
export function measureCaptionLayout(
  ctx: CanvasRenderingContext2D,
  text: string,
  o: LayoutOptions,
): CaptionLayout {
  return layoutCaption(ctx, text, o);
}
