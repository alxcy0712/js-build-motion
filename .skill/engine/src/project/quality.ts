import { slotSuggestions, motionLint } from '../qa/motion.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { IMPLEMENTED_ENVIRONMENTS } from '../drawing/scenes/registry.ts';
import { graphicIssues } from '../spec/graphic.ts';
import { buildCaptionTrack, captionUnitLimit, isShortCaptionGap, type MeasuredNarration, type CaptionCue } from '../captions/track.ts';
import { captionUnits } from '../captions/segment.ts';
import { narrationTimingIssues } from '../audio/verify.ts';
export interface QualityIssue { code: string; path: string; severity: 'error' | 'warning'; message: string }
export interface NarrationPacing {
  voicedSeconds: number; coverage: number; gaps: number[];
  meanGapSeconds: number; maxGapSeconds: number; headSeconds: number; tailSeconds: number;
}
export interface CaptionReadability {
  cues: number; maxCharacters: number; maxUnits: number; shortestSeconds: number; estimatedCues: number;
}
/** Structural preflight. A passing report still requires visual/audio review. */
export function inspectQuality(spec: ResolvedVideoSpec, options: { measuredNarration?: ReadonlyMap<number, MeasuredNarration>; customDrawing?: boolean; captionCues?: readonly CaptionCue[] } = {}): { ok: boolean; issues: QualityIssue[]; reviewFrames: number[]; narrationPacing: NarrationPacing | null; captionReadability: CaptionReadability | null; layoutSuggestions: ReturnType<typeof slotSuggestions>; motionDiagnostics: ReturnType<typeof motionLint> } {
  const issues: QualityIssue[] = [], frames = new Set<number>();
  const fps = spec.video.fps, total = Math.ceil(spec.video.duration * fps);
  const add = (code: string, path: string, severity: QualityIssue['severity'], message: string): void => { issues.push({ code, path, severity, message }); };
  spec.scenes.forEach((s, i) => {
    const path = `scenes[${i}]`, prev = spec.scenes[i - 1];
    if (!IMPLEMENTED_ENVIRONMENTS.includes(s.environment)) add('UNIMPLEMENTED_ENVIRONMENT', path, 'error', `环境 ${s.environment} 仅有占位画面`);
    const expected = prev?.end ?? 0;
    if (Math.abs(s.start - expected) > 0.5 / fps) add('TIMELINE_COVERAGE', path, 'error', '场景必须连续且互不重叠');
    if (s.end - s.start > 8) add('LONG_SHOT', path, 'warning', '镜头超过 8 秒，请确认动作变化和叙事推进');
    for (const time of [s.start, s.start + 0.25, (s.start + s.end) / 2, s.end - 1 / fps]) frames.add(Math.max(0, Math.min(total - 1, Math.round(time * fps))));
    if (s.composition) {
      const comp = s.composition;
      for (const message of graphicIssues(comp.elements ?? [])) add('GRAPHIC_INVALID', path, 'error', message);
      if (spec.audio.bgm.volume > 0 && comp.bpm !== spec.audio.bgm.bpm) add('BEAT_MISMATCH', path, 'error', '画面与 BGM 的 BPM 必须一致');
      if (comp.title.length > 28) add('DENSE_TITLE', path, 'warning', '标题偏长，请在接触表确认可读性');
      if (comp.subtitle && spec.captions.enabled) add('TEXT_COLLISION', path, 'warning', '副标题和旁白字幕同占底部区域，审查重叠');
      if (prev?.composition && JSON.stringify(comp) === JSON.stringify(prev.composition)) add('REPEATED_SHOT', path, 'warning', '相邻镜头的视觉内容相同');

    }
  });
  const stageShots = spec.scenes.filter(s => s.composition);
  if (!options.customDrawing && stageShots.length >= 3 && stageShots.every(s => !s.composition?.elements?.length)) {
    add('TEMPLATE_ONLY_FILM', 'scenes', 'warning', '整片均为预设舞台；需要逐镜头审查语义画面，结构通过不能作为成片质量验收');
  }
  if (Math.abs(spec.scenes.at(-1)!.end - spec.video.duration) > 0.5 / fps) add('TIMELINE_COVERAGE', 'video.duration', 'error', '最后一个镜头应覆盖至影片结束');
  let narrationPacing: NarrationPacing | null = null;
  const measured = options.measuredNarration;
  if (spec.audio.narration.length && measured) {
    const timingIssues = narrationTimingIssues(spec, measured);
    for (const message of timingIssues) add('NARRATION_TIMING_INVALID', 'audio.narration', 'error', message);
    if (!timingIssues.length) {
      const times = spec.audio.narration.map((_, i) => measured.get(i)!);
      const gaps = times.slice(1).map((t, i) => t.start - times[i]!.end);
      const voicedSeconds = times.reduce((n, t) => n + t.end - t.start, 0);
      narrationPacing = {
        voicedSeconds, coverage: voicedSeconds / spec.video.duration, gaps,
        meanGapSeconds: gaps.length ? gaps.reduce((n, gap) => n + gap, 0) / gaps.length : 0,
        maxGapSeconds: gaps.length ? Math.max(...gaps) : 0,
        headSeconds: times[0]!.start, tailSeconds: spec.video.duration - times.at(-1)!.end,
      };
      gaps.forEach((gap, i) => {
        if (gap > 1) add('NARRATION_GAP_REVIEW', `audio.narration[${i}]`, 'warning', `${times[i]!.end.toFixed(3)}–${times[i + 1]!.start.toFixed(3)}s 句间空档 ${gap.toFixed(3)}s；复核新信息、揭幕或阅读用途`);
      });
      if (narrationPacing.tailSeconds < 0.8) add('NARRATION_TAIL_REVIEW', 'video.duration', 'warning', `末句后留 ${narrationPacing.tailSeconds.toFixed(3)}s；复核尾音与结论阅读时间`);
    }
  } else if (spec.audio.narration.length) {
    add('NARRATION_TIMING_PENDING', 'audio.narration', 'warning', '运行 audio 获取当前规格的实测配音，再复核句间空档与尾留');
  }
  spec.audio.narration.forEach((line, i) => {
    if (measured?.has(i)) return;
    const available = (spec.audio.narration[i + 1]?.start ?? spec.video.duration) - line.start;
    if (Array.from(line.text).length / 4 > available) add('NARRATION_DENSITY', `audio.narration[${i}]`, 'warning', '旁白可能超时；以 TTS 实测时长复核');
  });
  const cues = spec.captions.enabled ? options.captionCues ?? buildCaptionTrack(spec,{measured}) : [];
  const captionReadability = cues.length ? {
    cues:cues.length, maxCharacters:Math.max(...cues.map(c=>[...c.text].length)),
    maxUnits:Math.max(...cues.map(c=>captionUnits(c.text))),
    shortestSeconds:Math.min(...cues.map(c=>c.end-c.start)),
    estimatedCues:cues.filter(c=>c.timingSource==='estimated').length,
  } : null;
  const alignmentReported = new Set<number>();
  cues.forEach((cue, index) => {
    const next = cues[index + 1];
    if (next && isShortCaptionGap(cue.end, next.start)) add('CAPTION_SHORT_GAP', `captions[${cue.index}]`, 'error',
      `${cue.end.toFixed(3)}–${next.start.toFixed(3)}s: ${(next.start - cue.end).toFixed(3)}s caption gap below 0.25s`);
  });
  for (const cue of cues) {
    const path = `captions[${cue.index}]`;
    if (captionUnits(cue.text) > captionUnitLimit(spec)) add(cue.translation ? 'CAPTION_TRANSLATION_REVIEW' : 'LONG_CAPTION_REVIEW',path,'warning',
      cue.translation ? '双语长段需要对应的语义分句；复核主字幕与译文的同步和版面' : '完整词组超过字幕宽度预算；复核两行排版与手机可读性');
    if (cue.end-cue.start < .8) add('FLASH_CAPTION_REVIEW',path,'warning',`字幕停留 ${(cue.end-cue.start).toFixed(3)}s；复核短词合并与阅读节奏`);
    if (cue.timingSource==='estimated' && measured?.get(cue.narrationIndex!)?.words?.length && !alignmentReported.has(cue.narrationIndex!)) {
      alignmentReported.add(cue.narrationIndex!);
      add('CAPTION_ALIGNMENT_REVIEW',path,'warning','词表与脚本文字匹配待复核；分句使用估算时间');
    }
    for (const time of [cue.start,cue.end-1/fps]) frames.add(Math.max(0,Math.min(total-1,Math.round(time*fps))));
  }
  return { ok: !issues.some(i => i.severity === 'error'), issues, reviewFrames: [...frames].sort((a, b) => a - b), narrationPacing, captionReadability, layoutSuggestions: slotSuggestions(spec.layout ?? {}), motionDiagnostics: motionLint(spec.layout ?? {}, spec.scenes) };
}
