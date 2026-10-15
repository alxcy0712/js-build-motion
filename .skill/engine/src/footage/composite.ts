/**
 * 生成角色片段的合成：变速贴槽、帧混合、尺寸上限、底部渐隐、低强度轮廓光。
 *
 * 分层约定：生成片段只承担角色动作（平涂底、空白屏幕、无文字），抠像后作为透明层由代码合成；
 * 文字、标签、屏幕内容全部由代码绘制。抠像见 key.ts，规则见 references/assets.md「生成视频分层合成」。
 *
 * 纯函数部分（planRetime / retimeAt / blendIndex / mixRgba / fadeBottom / capScale）不依赖 skia，可直接单测。
 */
import type { CanvasRenderingContext2D } from 'skia-canvas';

// ------------------------------------------------------------ 变速贴槽

export interface RetimeOptions {
  /** 允许的播放速率区间，默认 [0.75, 1.5]；超出说明片段与槽位不匹配，应重新生成或改镜长 */
  readonly minRate?: number;
  readonly maxRate?: number;
  /** 片段过短（需要低于 minRate 才能填满）时的补足方式：pingpong 正反往复（默认），loop 回到开头 */
  readonly tail?: 'pingpong' | 'loop';
}
export interface RetimePlan {
  readonly slot: number;
  readonly clip: number;
  readonly rate: number;
  /** linear：整段线性贴满；trim：以 maxRate 播放，槽位结束时片段未播完；tail：以 minRate 播放，播完后按 tail 补足 */
  readonly mode: 'linear' | 'trim' | 'tail';
  readonly tail: 'pingpong' | 'loop';
}

/** slot、clip 为秒。clip 取「最后一帧的起点」即 frames / fps − 1 / fps，保证不会读到不存在的帧。 */
export function planRetime(slot: number, clip: number, o: RetimeOptions = {}): RetimePlan {
  if (!(slot > 0) || !(clip > 0)) throw new Error(`RETIME_RANGE: slot=${slot}, clip=${clip} 须为正数`);
  const lo = o.minRate ?? 0.75, hi = o.maxRate ?? 1.5, tail = o.tail ?? 'pingpong';
  if (!(lo > 0 && hi >= lo)) throw new Error('RETIME_RANGE: 须满足 0 < minRate ≤ maxRate');
  const natural = clip / slot;
  if (natural > hi) return { slot, clip, rate: hi, mode: 'trim', tail };
  if (natural < lo) return { slot, clip, rate: lo, mode: 'tail', tail };
  return { slot, clip, rate: natural, mode: 'linear', tail };
}

/** 槽位内时间 → 片段源时间（秒）。任何时刻源时间都在变化（不冻结），且落在 [0, clip]。 */
export function retimeAt(plan: RetimePlan, slotTime: number): number {
  const u = Math.max(0, Math.min(plan.slot, slotTime)) * plan.rate;
  if (u <= plan.clip) return u;
  if (plan.tail === 'loop') return u % plan.clip;
  const period = 2 * plan.clip, k = u % period;
  return k <= plan.clip ? k : period - k;
}

// ------------------------------------------------------------ 帧混合

/** 源时间 → 相邻两帧及混合权重。输出帧率高于源帧率（如 24→60）时用于消除顿挫。 */
export function blendIndex(sourceTime: number, sourceFps: number, frames: number): { readonly a: number; readonly b: number; readonly w: number } {
  const f = Math.max(0, Math.min(frames - 1, sourceTime * sourceFps));
  const a = Math.floor(f + 1e-9), b = Math.min(frames - 1, a + 1);
  return { a, b, w: b === a ? 0 : f - a };
}

/** 预乘方式混合两帧 RGBA：结果 = (1−w)·A + w·B，透明边缘不出暗边。 */
export function mixRgba(a: ArrayLike<number>, b: ArrayLike<number>, w: number, out: Uint8ClampedArray = new Uint8ClampedArray(a.length)): Uint8ClampedArray {
  const k = Math.max(0, Math.min(1, w));
  for (let i = 0; i < a.length; i += 4) {
    const aa = (a[i + 3] as number) / 255, ba = (b[i + 3] as number) / 255;
    const oa = aa * (1 - k) + ba * k;
    for (let c = 0; c < 3; c++) {
      const pm = (a[i + c] as number) * aa * (1 - k) + (b[i + c] as number) * ba * k;
      out[i + c] = oa > 0 ? pm / oa : 0;
    }
    out[i + 3] = oa * 255;
  }
  return out;
}

// ------------------------------------------------------------ 底部渐隐

/** 把 y0→y1 之间的 alpha 线性渐隐到 0，y1 以下全部透明（原地修改）。用于半身角色落进黑底。 */
export function fadeBottom(rgba: Uint8ClampedArray, w: number, h: number, y0: number, y1: number): Uint8ClampedArray {
  for (let y = Math.max(0, Math.floor(y0)); y < h; y++) {
    const k = y >= y1 ? 0 : 1 - (y - y0) / Math.max(1e-6, y1 - y0);
    if (k >= 1) continue;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4 + 3; rgba[i] = (rgba[i] as number) * k; }
  }
  return rgba;
}

// ------------------------------------------------------------ 尺寸上限与绘制

/** 当前变换的线性缩放（含相机推镜）。 */
export function transformScale(ctx: Pick<CanvasRenderingContext2D, 'getTransform'>): number {
  const m = ctx.getTransform(); return Math.hypot(m.a, m.b);
}
/** 期望缩放与上限：屏幕上 1 个源像素至多占 maxScreenScale 个输出像素（默认 1 = 不放大超过源尺寸）。 */
export function capScale(want: number, currentTransform = 1, maxScreenScale = 1): number {
  return Math.min(want, maxScreenScale / Math.max(1e-9, currentTransform));
}

export const RIM_ALPHA_MAX = 0.15;
export interface CharacterDraw {
  /** 角色锚点（画布坐标）：x 为水平中心，y 为 anchor 指定的边 */
  readonly x: number;
  readonly y: number;
  readonly anchor?: 'top' | 'bottom';
  /** 期望缩放（源像素 → 当前坐标系），实际值受 capScale 限制 */
  readonly scale: number;
  /** 源图内的角色矩形 [x0, y0, x1, y1)，默认整图；锚点按它对齐 */
  readonly box?: readonly [number, number, number, number];
  readonly alpha?: number;
  /** 轮廓光：深色衣物在黑底上可读；alpha 上限 0.15 */
  readonly rim?: { readonly color: string; readonly alpha: number; readonly blur?: number };
  readonly maxScreenScale?: number;
}
type Drawable = Parameters<CanvasRenderingContext2D['drawImage']>[0] & { readonly width: number; readonly height: number };

/** 绘制一帧透明角色层，返回实际使用的缩放与屏幕缩放。 */
export function drawCharacterLayer(ctx: CanvasRenderingContext2D, layer: Drawable, d: CharacterDraw): { scale: number; screenScale: number } {
  const cur = transformScale(ctx);
  const s = capScale(d.scale, cur, d.maxScreenScale ?? 1);
  const [bx0, by0, bx1, by1] = d.box ?? [0, 0, layer.width, layer.height];
  const x = d.x - ((bx0 + bx1) / 2) * s;
  const y = (d.anchor ?? 'bottom') === 'bottom' ? d.y - by1 * s : d.y - by0 * s;
  ctx.save();
  ctx.globalAlpha *= d.alpha ?? 1;
  if (d.rim && d.rim.alpha > 0) {
    const a = Math.min(RIM_ALPHA_MAX, d.rim.alpha);
    ctx.shadowColor = withAlpha(d.rim.color, a); ctx.shadowBlur = d.rim.blur ?? 16;
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(layer, x, y, layer.width * s, layer.height * s);
  ctx.restore();
  return { scale: s, screenScale: s * cur };
}

/** '#RRGGBB' 或 'r,g,b' → rgba(r,g,b,a) */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  const rgb = m ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)).join(',') : color.replace(/^rgba?\(|\)$/g, '').split(',').slice(0, 3).join(',');
  return `rgba(${rgb},${alpha})`;
}
