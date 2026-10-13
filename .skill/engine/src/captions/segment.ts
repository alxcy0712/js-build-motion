import type { CaptionCue, CaptionWord } from './track.ts';

const lexical = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const strongStop = /[。！？!?;；]\s*$/u;
interface WordSpan { from: number; to: number; word: CaptionWord }
interface TextSpan { from: number; to: number }

/** 中文按字宽、Latin 按近似半字宽衡量；真实排版继续由字体测量验收。 */
export function captionUnits(text: string): number {
  return [...text].reduce((n, ch) => n + (/\s/u.test(ch) ? 0 : /[\u2e80-\u9fff\uff00-\uffef]/u.test(ch) ? 1 : .55), 0);
}

function alignWords(text: string, words: readonly CaptionWord[]): WordSpan[] | null {
  const offsets: number[] = [];
  let canonical = '';
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const token = lexical(ch);
    canonical += token;
    for (let n = 0; n < token.length; n++) offsets.push(i);
    i += ch.length;
  }
  const spans: WordSpan[] = [];
  let cursor = 0;
  for (const word of words) {
    const token = lexical(word.text);
    if (!token) continue;
    if (canonical.slice(cursor, cursor + token.length) !== token) return null;
    const from = offsets[cursor]!, last = offsets[cursor + token.length - 1]!;
    spans.push({ from, to:last + String.fromCodePoint(text.codePointAt(last)!).length, word });
    cursor += token.length;
  }
  return cursor === canonical.length && spans.length > 0 ? spans : null;
}

function stopAt(text: string, at: number): boolean {
  const ch = text[at]!;
  if ('，。！？；：、,;!?:.'.includes(ch)) {
    const before = text[at-1] ?? '', after = text[at+1] ?? '';
    if (/[.,:]/u.test(ch) && /\d/u.test(before) && /\d/u.test(after)) return false;
    if (ch === '.' && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return false;
    if (ch === ':' && after === '/') return false;
    return true;
  }
  return ch === '\n';
}

/** 跨语言 ID、数值、URL 和已对齐的实测词作为完整单元保留。 */
function textSpans(text: string, words: readonly WordSpan[] | null, limit: number): {spans: TextSpan[]; boundaries: number[]} {
  const indivisible = [...text.matchAll(/(?:[$€¥]?\d(?:[\d.,:/%+\-]*\d)?[A-Za-z%]*|[A-Za-z][A-Za-z0-9._:/%+@#'\-]*)/gu)]
    .map(match => ({from:match.index!,to:match.index!+match[0].length}));
  const protectedSpans = [...indivisible, ...(words ?? [])];
  const safe = (at: number): boolean => protectedSpans.every(s => at <= s.from || at >= s.to);
  const boundaries: number[] = [], stops: number[] = [];
  for (let i = 0; i < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const end = i + ch.length;
    if (safe(end)) {
      boundaries.push(end);
      if (stopAt(text,i)) stops.push(end);
    }
    i = end;
  }
  const result: TextSpan[] = [];
  let from = 0;
  while (from < text.length) {
    const fitting = boundaries.filter(to => to > from && captionUnits(text.slice(from,to)) <= limit);
    const ceiling = fitting.at(-1) ?? boundaries.find(to => to > from) ?? text.length;
    let to = stops.find(end => end > from && end <= ceiling) ?? ceiling;
    // 句尾的引号、括号跟随其所结束的短句，避免独立闪现。
    while (/[”’」』）》】]/u.test(text[to] ?? '') && safe(to+1)) to++;
    if (text.slice(from,to).trim()) result.push({from,to});
    from = to;
  }
  return {spans:result,boundaries};
}

export function segmentCaption(cue: CaptionCue, limit: number): CaptionCue[] {
  const aligned = cue.words?.length ? alignWords(cue.text,cue.words) : null;
  // 完整译文需要人工提供语义对应的分句，保留已有的双语对应关系。
  if (cue.translation) return [{...cue,timingSource:aligned?'words':'estimated',words:aligned?cue.words:undefined}];
  const {spans,boundaries} = textSpans(cue.text,aligned,limit);
  const weight = Math.max(1,captionUnits(cue.text));
  const timeFor = (span: TextSpan): {start: number; end: number} => {
    const entries = aligned?.filter(w => w.from >= span.from && w.to <= span.to);
    if (entries?.length) return {start:entries[0]!.word.start,end:entries.at(-1)!.word.end};
    return {start:cue.start+(cue.end-cue.start)*captionUnits(cue.text.slice(0,span.from))/weight,
      end:cue.start+(cue.end-cue.start)*captionUnits(cue.text.slice(0,span.to))/weight};
  };
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!, timing = timeFor(span), text = cue.text.slice(span.from,span.to);
    if (timing.end-timing.start >= .8 && captionUnits(text) >= 4) continue;
    const next = spans[i+1], previous = spans[i-1];
    if (next && !strongStop.test(text) && captionUnits(cue.text.slice(span.from,next.to)) <= limit) {
      next.from = span.from; spans.splice(i--,1);
    } else if (previous && !strongStop.test(cue.text.slice(previous.from,previous.to)) && captionUnits(cue.text.slice(previous.from,span.to)) <= limit) {
      previous.to = span.to; spans.splice(i--,1);
    } else if (previous && !strongStop.test(cue.text.slice(previous.from,previous.to))) {
      // 长句尾部的孤词向前借一个完整词组，保留字宽预算与实测边界。
      const cut = boundaries.filter(to=>to>previous.from&&to<previous.to).reverse().find(to=>{
        const tail={from:to,to:span.to},tailTiming=timeFor(tail);
        return captionUnits(cue.text.slice(previous.from,to))>=4 && captionUnits(cue.text.slice(to,span.to))>=4 &&
          captionUnits(cue.text.slice(to,span.to))<=limit && tailTiming.end-tailTiming.start>=.8;
      });
      if (cut !== undefined) {previous.to=cut;span.from=cut;}
    }
  }
  const result = spans.map((span,i): CaptionCue => {
    const timing = timeFor(span), entries = aligned?.filter(w => w.from >= span.from && w.to <= span.to);
    return {...cue,text:cue.text.slice(span.from,span.to).trim(),
      start:i===0?cue.start:Math.max(cue.start,timing.start-(aligned ? .06 : 0)),
      end:i===spans.length-1?cue.end:Math.min(cue.end,timing.end+(aligned ? .15 : 0)),
      words:entries?.length ? entries.map(w=>w.word) : undefined,
      timingSource:aligned?'words':'estimated'};
  });
  return result.map((part,i)=>({...part,end:Math.min(part.end,result[i+1]?.start ?? cue.end)}));
}
