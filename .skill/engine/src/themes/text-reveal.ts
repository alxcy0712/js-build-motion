/**
 * 统一文字进退场组件（所有风格共用，参数来自 theme.textReveal）。
 * - opacity 走 bezier，position/scale 走闭式弹簧：两条曲线解耦。
 * - 不允许过冲的风格会把弹簧进度钳制在 [0,1]，即使参数被误改也不会回弹。
 * - 不动画 letter-spacing；CJK 文本 tracking 恒为 0。
 * - 纯函数 seek(t)：不依赖前一帧。
 */
import { cubicBezier, evalSpring } from './motion.ts';
import type { ThemeTokens, TypeRole, Orientation } from './types.ts';
import { cssFontStack } from './fonts.ts';

export interface RevealState { opacity: number; dy: number; blur: number; scale: number; visible: boolean }
export interface RevealTiming { enterAt: number; exitAt?: number; index?: number }

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;

export function revealState(theme: ThemeTokens, t: number, { enterAt, exitAt = Infinity, index = 0 }: RevealTiming): RevealState {
  const r = theme.textReveal;
  const start = enterAt + index * r.stagger;
  const lt = t - start;
  if (lt < 0) return { opacity: 0, dy: r.rise, blur: r.blurFrom, scale: r.scaleFrom, visible: false };
  let p = evalSpring(lt, r.positionSpring);
  p = r.allowOvershoot ? Math.min(p, 1 + r.maxOvershoot) : clamp01(p);
  const opIn = cubicBezier(r.opacityEase)(clamp01(lt / r.opacityDuration));
  const out = cubicBezier(theme.easings.exit)(clamp01((t - exitAt) / r.exitDuration));
  const opacity = opIn * (1 - out);
  return {
    opacity,
    dy: (1 - p) * r.rise - out * r.rise * 0.6,
    // 进场模糊只在前 0.2s 内存在（30fps ≤ 6 帧），之后恒为 0，停留帧不出现残留模糊
    blur: Math.max(0, (lt < 0.2 ? (1 - clamp01(p)) * r.blurFrom * (1 - lt / 0.2) : 0) + out * r.blurFrom * 0.8),
    scale: r.scaleFrom + (1 - r.scaleFrom) * p,
    visible: opacity > 0.002,
  };
}

export interface Ctx2D {
  save(): void; restore(): void; translate(x: number, y: number): void; scale(x: number, y: number): void;
  fillText(s: string, x: number, y: number): void;
  globalAlpha: number; filter: string; font: string; fillStyle: unknown; textAlign: string; textBaseline: string; letterSpacing?: string;
}
export interface DrawTextOptions extends RevealTiming {
  role: TypeRole; orientation: Orientation; x: number; y: number; color?: string; align?: 'left' | 'center' | 'right';
}
export function drawRevealText(ctx: Ctx2D, theme: ThemeTokens, text: string, t: number, o: DrawTextOptions): RevealState {
  const s = revealState(theme, t, o);
  if (!s.visible) return s;
  const size = theme.type[o.orientation][o.role];
  const track = CJK.test(text) ? 0 : (theme.tracking[o.role] ?? 0);
  ctx.save();
  ctx.globalAlpha = s.opacity;
  if (s.blur > 0.3) ctx.filter = `blur(${s.blur.toFixed(2)}px)`;
  ctx.translate(o.x, o.y + s.dy);
  if (s.scale !== 1) ctx.scale(s.scale, s.scale);
  ctx.font = `${theme.weight[o.role] ?? 600} ${size}px ${cssFontStack(theme.fonts.stack)}`;
  ctx.fillStyle = o.color ?? theme.palette.text;
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = `${(track * size).toFixed(2)}px`; // 固定值，不随时间变化
  ctx.fillText(text, 0, 0);
  ctx.restore();
  return s;
}
/** 每屏字数检查：供 spec 校验/审片使用。 */
export function exceedsScreenBudget(theme: ThemeTokens, lines: readonly string[]): boolean {
  const joined = lines.join('');
  const cjk = [...joined].filter((c) => CJK.test(c)).length;
  const words = joined.replace(/[\u3400-\u9fff]/g, ' ').split(/\s+/).filter(Boolean).length;
  return cjk > theme.maxCharsPerScreen.cjk || words > theme.maxCharsPerScreen.latinWords;
}
