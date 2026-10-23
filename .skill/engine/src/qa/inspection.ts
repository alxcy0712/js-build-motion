import type { LayoutElement, Rect } from '../layout/plan.ts';
import type { LayoutTrace, TraceDraw } from '../layout/trace.ts';
import type { LayoutIssue } from '../layout/check.ts';
import type { ThemeTokens } from '../themes/types.ts';

interface Sample { frame: number; time: number; bounds: Rect; alpha: number; scale: number; text: string; exact: boolean }
interface Track { element: LayoutElement; samples: Sample[] }
const union = (a: Rect, b: Rect): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
  height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) });
const id = (e: LayoutElement, text = '') => `${e.scene ?? 'screen'}/${e.id.includes(':auto-') ? 'text:' + text : e.id}`;
function linear(points: Sample[], value: (p: Sample) => number, minimum: number): boolean {
  if (points.length < 4) return false;
  const first = points[0]!, last = points.at(-1)!, change = value(last) - value(first);
  return Math.abs(change) >= minimum && last.time > first.time && points.every(p =>
    Math.abs(value(p) - value(first) - change * (p.time - first.time) / (last.time - first.time)) <= Math.abs(change) * .001);
}
/** Compact geometry/opacity observations; no retained paths, pixels or source-code guesses. */
export class MotionInspection {
  private tracks = new Map<string, Track>();
  private frames = new Set<number>();
  private fps: number;
  private theme: ThemeTokens;
  private height: number;
  constructor(fps: number, theme: ThemeTokens, height: number) { this.fps = fps; this.theme = theme; this.height = height; }
  observe(trace: Pick<LayoutTrace, 'draws' | 'declarations'>, frame: number): void {
    this.frames.add(frame);
    for (const element of trace.declarations) if (element.textMotion || element.endCard) {
      const key = id(element), track = this.tracks.get(key);
      if (track) track.element = element; else this.tracks.set(key, { element, samples: [] });
    }
    const groups = new Map<string, TraceDraw[]>();
    for (const draw of trace.draws) {
      if ((!draw.text && draw.endCard?.part !== 'avatar') || ['caption', 'background', 'decoration'].includes(draw.role) || draw.alpha < .15 || draw.visible.width <= 0 || draw.visible.height <= 0 || ['leaving', 'handoff'].includes(draw.phase ?? '')) continue;
      const key = id(draw, draw.text); groups.set(key, [...(groups.get(key) ?? []), draw]);
    }
    for (const [key, group] of groups) {
      const first = group[0]!, track = this.tracks.get(key) ?? { element: { ...first }, samples: [] };
      track.samples.push({ frame, time: frame / this.fps, bounds: group.map(d => d.bounds).reduce(union),
        alpha: Math.max(...group.map(d => d.alpha)), scale: Math.max(...group.map(d => Math.max(Math.hypot(d.matrix[0], d.matrix[1]), Math.hypot(d.matrix[2], d.matrix[3])))),
        text: [...new Set(group.flatMap(d => d.text ? [d.text] : []))].join(''), exact: group.every(d => d.confidence === 'exact') });
      this.tracks.set(key, track);
    }
  }
  finish(): LayoutIssue[] {
    const issues: LayoutIssue[] = [], maximum = this.theme.textReveal.allowOvershoot ? this.theme.textReveal.maxOvershoot : 0;
    const add = (track: Track, code: string, severity: LayoutIssue['severity'], basis: string, sample = track.samples[0], frame = sample?.frame ?? 0) => {
      issues.push({ code, severity, frame, time: frame / this.fps, elements: [track.element.id], text: sample?.text ? [sample.text] : [], spaces: ['output'],
        bounds: sample ? [sample.bounds] : [], area: 0, ratio: 0, basis, preview: { frame, region: sample?.bounds ?? null } });
    };
    for (const track of this.tracks.values()) {
      const { element, samples } = track, motion = element.textMotion, card = element.endCard;
      if (card) {
        if (card.wordStart !== undefined) {
          const anchor = Math.ceil(card.wordStart * this.fps - 1e-8), at = samples.find(p => p.frame === anchor), threshold = card.part === 'name' ? .99 : .8;
          if (!this.frames.has(anchor)) add(track, 'ENDCARD_ANCHOR_UNOBSERVED', 'coverage', 'word anchor lies outside the sampled frames', at, anchor);
          else if (!at || at.alpha < threshold) add(track, 'ENDCARD_WORD_LATE', 'error', `${card.part} must reach opacity ${threshold} by word start ${card.wordStart}s`, at, anchor);
        }
        const hold = samples.filter(p => p.time >= card.holdStart && p.time < card.holdEnd), first = hold[0];
        if (!first) add(track, 'ENDCARD_HOLD_UNOBSERVED', 'coverage', 'stable hold requires visible observations');
        else {
          const moved = hold.find(p => Math.abs(p.bounds.x - first.bounds.x) > 1e-4 || Math.abs(p.bounds.y - first.bounds.y) > 1e-4);
          if (moved) add(track, 'ENDCARD_HOLD_MOVED', 'error', `${card.part} moved during its stable hold: dx=${(moved.bounds.x - first.bounds.x).toFixed(2)}, dy=${(moved.bounds.y - first.bounds.y).toFixed(2)}px`, moved);
        }
      }
      if (!samples.some(p => p.text)) continue;
      if (!card && samples.some(p => p.text.includes('用计算机思维想现实'))) add(track, 'ENDCARD_DECLARATION_MISSING', 'coverage', 'declare avatar/name/slogan, measured wordStart and hold interval for end-card timing checks');
      if (motion?.easing === 'linear') add(track, 'TEXT_LINEAR_ENTRANCE', 'error', 'declared text entrance/reveal uses linear easing');
      // A declared entrance supplies its settled time. For unannotated fillText,
      // require four consecutive stable, opaque observations before inferring it.
      const settled = motion ? samples.find(p => p.time >= motion.end && p.alpha >= .98) : samples.find((p, i) => {
        const run = samples.slice(i, i + 4);
        return run.length === 4 && run.every((q, n) => q.frame === p.frame + n && q.alpha >= .98 &&
          Math.abs(q.bounds.width - p.bounds.width) < .05 && Math.abs(q.bounds.x - p.bounds.x) < .05 && Math.abs(q.bounds.y - p.bounds.y) < .05);
      });
      if (!settled) { add(track, 'TEXT_SETTLE_UNOBSERVED', 'coverage', 'entrance needs a visible settled reference'); continue; }
      const entrance = samples.filter(p => p.frame <= settled.frame && (!motion || p.time >= motion.start));
      if (!entrance.length || entrance.some(p => p.text !== settled.text)) continue;
      const peak = entrance.reduce((a, b) => Math.max(b.bounds.width / settled.bounds.width, b.scale / settled.scale) > Math.max(a.bounds.width / settled.bounds.width, a.scale / settled.scale) ? b : a);
      const overshoot = Math.max(peak.bounds.width / settled.bounds.width, peak.scale / settled.scale) - 1;
      if (overshoot > maximum + 1e-4) add(track, 'TEXT_OVERSHOOT', peak.exact ? 'error' : 'review', `observed text width/scale overshoot ${(overshoot * 100).toFixed(3)}% exceeds ${maximum * 100}%`, peak);
      const fading = entrance.filter(p => p.alpha < .98);
      const moving = entrance.filter(p => p.frame < settled.frame);
      if (motion?.easing !== 'linear' && (linear(fading, p => p.alpha, .3) ||
        linear(moving, p => p.bounds.x, 8 * this.height / 1920) || linear(moving, p => p.bounds.y, 8 * this.height / 1920) || linear(moving, p => p.scale, .1))) {
        add(track, 'TEXT_LINEAR_ENTRANCE', 'error', 'four or more actual entrance samples follow a linear opacity/position/scale trajectory');
      }
    }
    return issues;
  }
}
