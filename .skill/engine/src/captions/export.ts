/**
 * 外挂字幕导出（需求 §18）。
 *
 * 画面内的字幕由 Skia 画进帧里（render.ts），这里的 .srt/.vtt 是**附带产物**，
 * 用途是：平台上传、无障碍、以及人工校对。
 *
 * 两者必须来自同一份 cue 列表，否则会出现"画面上的字和外挂字幕不一致"
 * 这类极难排查的问题。
 */

import type { CaptionCue } from './track.ts';

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

/** 秒 → `HH:MM:SS,mmm`（SRT 用逗号） */
export function formatSrtTime(seconds: number): string {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const s = Math.floor(t - h * 3600 - m * 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  // 四舍五入到 1000ms 时进位，避免出现 `00:00:01,1000`
  if (ms === 1000) return formatSrtTime(t + 0.0005);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** 秒 → `HH:MM:SS.mmm`（VTT 用点） */
export function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(',', '.');
}

/** 生成 SRT，直接消费字幕轨已统一拆句、去句读的显示文本。 */
export function toSrt(cues: readonly CaptionCue[]): string {
  const blocks = cues.map((c, i) => {
    const idx = i + 1;
    return `${idx}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${cueBody(c)}`;
  });
  return blocks.join('\n\n') + '\n';
}

/**
 * cue 的文本体（外挂字幕用）。
 *
 * 双语时两行写进同一条 cue——这是 .srt/.vtt 表达双语字幕的通行做法，
 * 拆成两条 cue 会让播放器把两行分开显示，时间也不再同步。
 */
function cueBody(cue: CaptionCue): string {
  return cue.translation ? `${cue.text}\n${cue.translation}` : cue.text;
}

/**
 * 生成 VTT。
 * 若 cue 带词级时间戳，额外输出 `<00:00:01.200>` 形式的行内时间戳，
 * 播放器支持时即可获得逐词高亮（与画面内的卡拉OK效果一致）。
 */
export function toVtt(cues: readonly CaptionCue[]): string {
  const header = 'WEBVTT\n';
  const blocks = cues.map((c, i) => {
    const idx = i + 1;
    const body = c.words?.length
      ? renderWordTimedText(c)
      : c.text;
    const withTranslation = c.translation ? `${body}\n${c.translation}` : body;
    return `${idx}\n${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${withTranslation}`;
  });
  return header + '\n' + blocks.join('\n\n') + '\n';
}

function renderWordTimedText(cue: CaptionCue): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const w of cue.words ?? []) {
    const at = cue.text.indexOf(w.text,cursor);
    if (at < 0) return cue.text;
    parts.push(cue.text.slice(cursor,at),`<${formatVttTime(w.start)}>${w.text}`);
    cursor = at+w.text.length;
  }
  parts.push(cue.text.slice(cursor));
  return parts.join('');
}
