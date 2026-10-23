import type { CanvasRenderingContext2D } from 'skia-canvas';
import { clamp01, easing } from '../animation/easing.ts';
import { evalSpring, cubicBezier } from '../themes/motion.ts';
import type { ThemeTokens } from '../themes/types.ts';
import { withLayout } from '../layout/trace.ts';

export interface TextEntrance { opacity: number; y: number; scale: number }
/** Theme-owned text spring; old generic prop easings keep their existing behavior. */
export function textPop(theme: ThemeTokens, seconds: number): TextEntrance {
  if (seconds <= 0) return { opacity: 0, y: 0, scale: 0 };
  if (seconds >= theme.durations.enter) return { opacity: 1, y: 0, scale: 1 };
  const max = theme.textReveal.allowOvershoot ? theme.textReveal.maxOvershoot : 0;
  return { opacity: cubicBezier(theme.textReveal.opacityEase)(clamp01(seconds / theme.textReveal.opacityDuration)),
    y: 0, scale: Math.max(0, Math.min(1 + max, evalSpring(seconds, theme.textReveal.positionSpring))) };
}
export interface LineRevealOptions { index?: number; duration?: number; stagger?: number; rise?: number }
export function lineReveal(seconds: number, { index = 0, duration = .4, stagger = .16, rise = 18 }: LineRevealOptions = {}): TextEntrance {
  if (!(duration > 0) || ![seconds, duration, stagger, rise, index].every(Number.isFinite) || stagger < 0 || index < 0 || !Number.isInteger(index)) throw Error('TEXT_REVEAL_PARAMETERS');
  const progress = easing.outCubic(clamp01((seconds - index * stagger) / duration));
  return { opacity: progress, y: rise * (1 - progress), scale: 1 };
}
/** Draw callbacks keep the project's typography and color; this wrapper owns motion and trace identity. */
export function drawTextEntrance(ctx: CanvasRenderingContext2D, theme: ThemeTokens, time: number,
  options: LineRevealOptions & { id: string; kind: 'pop' | 'line'; enterAt: number; x: number; y: number }, draw: () => void): TextEntrance {
  const { kind, enterAt, x, y } = options, start = enterAt + (kind === 'line' ? (options.index ?? 0) * (options.stagger ?? .16) : 0);
  const duration = kind === 'pop' ? theme.durations.enter : options.duration ?? .4;
  const state = kind === 'pop' ? textPop(theme, time - enterAt) : lineReveal(time - enterAt, options);
  withLayout(ctx, { id: options.id, role: 'text', required: true, textMotion: { start, end: start + duration, easing: kind === 'pop' ? 'theme-spring' : 'outCubic' } }, () => {
    ctx.save();
    try { ctx.globalAlpha *= state.opacity; ctx.translate(x, y + state.y); ctx.scale(state.scale, state.scale); if (state.opacity > 0) draw(); }
    finally { ctx.restore(); }
  });
  return state;
}
