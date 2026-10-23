import type { CanvasRenderingContext2D } from 'skia-canvas';
import type { CaptionWord } from '../../captions/track.ts';
import type { ThemeTokens } from '../../themes/types.ts';
import { cssFontStack } from '../../themes/fonts.ts';
import { VERTICAL_SHORT_LAYOUT } from '../../themes/shared.ts';
import { frame } from '../../layout/tools.ts';
import { withLayout } from '../../layout/trace.ts';
import { lineReveal } from '../../motion/text.ts';

/** A phrase spanning provider words anchors to its first measured word, without editing timings. */
export function spokenWordStart(words: readonly CaptionWord[], phrase: string): number {
  const clean = (s: string) => s.replace(/[\s\p{P}]/gu, '');
  const parts = words.map(w => clean(w.text)), index = parts.join('').indexOf(clean(phrase));
  if (index < 0 || !clean(phrase)) throw Error('ENDCARD_WORD_ANCHOR_MISSING: ' + phrase);
  let offset = 0;
  for (let i = 0; i < words.length; i++) { offset += parts[i]!.length; if (offset > index) return words[i]!.start; }
  throw Error('ENDCARD_WORD_ANCHOR_MISSING: ' + phrase);
}
export interface EndCardOptions {
  id: string; width: number; height: number; start: number; end: number; words: readonly CaptionWord[];
  /** Minimum caption outer top throughout this card, computed with captionGeometry. */
  captionTop: number;
  nameStyle: 'accent' | 'underline';
  /** Draw the approved local portrait/rig in this rectangle; internal blink/lip motion may use time. */
  avatar: (ctx: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, time: number) => void;
}
/** Opt-in identity card. Invocation follows the project's recorded end-card choice. */
export function drawEndCard(ctx: CanvasRenderingContext2D, theme: ThemeTokens, time: number, o: EndCardOptions): void {
  const scale = o.height / 1920, x = o.width / 2, duration = .5;
  const nameWord = spokenWordStart(o.words, '澄记'), sloganWord = spokenWordStart(o.words, '用计算机');
  const nameAt = nameWord - duration, sloganAt = sloganWord - duration;
  const holdStart = Math.max(o.start + .6, nameWord, sloganWord);
  if (Math.min(nameAt, sloganAt) < o.start || o.end < Math.max(...o.words.map(w => w.end)) + 1.5) throw Error('ENDCARD_READING_TIME: allow entrance before word anchors and 1.5s after speech');
  if (time < o.start || time >= o.end) return;
  const font = cssFontStack(theme.fonts.stack), safe = frame(o.width, o.height).safe;
  ctx.save();
  try {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `500 ${42 * scale}px ${font}`;
    const sloganInk = ctx.measureText('用计算机思维想现实');
    ctx.font = `700 ${96 * scale}px ${font}`;
    const nameInk = ctx.measureText('澄记');
    const base = VERTICAL_SHORT_LAYOUT.visualCenterY * scale;
    const nameBaseline = base + 80 * scale + 32 * scale + nameInk.actualBoundingBoxAscent;
    const sloganBaseline = nameBaseline + nameInk.actualBoundingBoxDescent + 52 * scale + sloganInk.actualBoundingBoxAscent;
    const shift = Math.min(0, Math.min(o.captionTop - 128 * scale, safe.y + safe.height) - (sloganBaseline + sloganInk.actualBoundingBoxDescent + 24 * scale));
    const avatarTop = base - 320 * scale + shift, nameY = nameBaseline + shift, sloganY = sloganBaseline + shift;
    withLayout(ctx, { id: o.id + ':background', role: 'background' }, () => { ctx.fillStyle = theme.palette.bg; ctx.fillRect(0, 0, o.width, o.height); });
    withLayout(ctx, { id: o.id + ':glow', role: 'decoration' }, () => {
      const glow = ctx.createRadialGradient(x, avatarTop + 200 * scale, 0, x, avatarTop + 200 * scale, 340 * scale);
      glow.addColorStop(0, theme.palette.accent + '18'); glow.addColorStop(1, theme.palette.accent + '00');
      ctx.fillStyle = glow; ctx.fillRect(x - 340 * scale, avatarTop - 140 * scale, 680 * scale, 680 * scale);
    });
    withLayout(ctx, { id: o.id + ':avatar', role: 'shape', required: true, endCard: { part: 'avatar', holdStart, holdEnd: o.end } }, () => {
      const state = lineReveal(time - o.start, { duration: .6, rise: 30 * scale });
      ctx.save(); ctx.globalAlpha *= state.opacity;
      o.avatar(ctx, { x: x - 200 * scale, y: avatarTop + state.y, width: 400 * scale, height: 400 * scale }, time);
      ctx.restore();
    });
    for (const part of ['name', 'slogan'] as const) {
      const start = part === 'name' ? nameAt : sloganAt, wordStart = part === 'name' ? nameWord : sloganWord;
      withLayout(ctx, { id: o.id + ':' + part, role: 'text', required: true, textMotion: { start, end: start + duration, easing: 'outCubic' },
        endCard: { part, wordStart, holdStart, holdEnd: o.end } }, () => {
        const state = lineReveal(time - start, { duration, rise: 24 * scale });
        ctx.save(); ctx.globalAlpha *= state.opacity;
        ctx.font = `${part === 'name' ? 700 : 500} ${(part === 'name' ? 96 : 42) * scale}px ${font}`;
        ctx.fillStyle = part === 'name' ? o.nameStyle === 'accent' ? theme.palette.accent : theme.palette.text : theme.palette.textSecondary;
        ctx.fillText(part === 'name' ? '澄记' : '用计算机思维想现实', x, (part === 'name' ? nameY : sloganY) + state.y);
        if (part === 'name' && o.nameStyle === 'underline') {
          withLayout(ctx, { id: o.id + ':mark', role: 'decoration' }, () => {
            ctx.globalAlpha *= .8; ctx.fillStyle = theme.palette.accent; ctx.beginPath();
            ctx.roundRect(x - 28 * scale, nameY + state.y + 18 * scale, 56 * scale, 4 * scale, 2 * scale); ctx.fill();
          });
        }
        ctx.restore();
      });
    }
  } finally { ctx.restore(); }
}
