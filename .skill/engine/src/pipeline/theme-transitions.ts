/**
 * 风格转场（基础版）。mix ∈ [0,1] 为转场进度；previous 已画在 ctx 上之前由本函数决定如何绘制。
 * 所有转场是 mix 的纯函数；缓动取自当前风格，峰值速度落在转场中点（与剪辑点/重拍对齐）。
 */
import type { Canvas, CanvasRenderingContext2D } from 'skia-canvas';
import { cubicBezier } from '../themes/motion.ts';
import type { ThemeTokens, TransitionId } from '../themes/types.ts';
import { focusCenter, zoomToFill, type FocusRect } from '../motion/focus.ts';

import { THEME_TRANSITION_IDS, type Transition } from '../themes/transition-ids.ts';
export { THEME_TRANSITION_IDS } from '../themes/transition-ids.ts';
import { hashString, mulberry32 } from '../animation/random.ts';

export function isThemeTransition(id: string): id is TransitionId {
  return (THEME_TRANSITION_IDS as readonly string[]).includes(id);
}
/** 各转场的标准时长（秒）；风格 durations.transition 为上限参考 */
export function themeTransitionDuration(id: TransitionId, theme: ThemeTokens): number {
  if (id === 'cutOnBeat') return 1 / 60;
  if (id === 'blurDissolve') return Math.min(0.3, theme.durations.transition); // 9 帧@30fps：旧字前 4 帧淡出，新字中点进入
  if (id === 'whipPan' || id === 'glitchCut') return Math.min(0.3, theme.durations['whip'] ?? theme.durations.transition);
  return theme.durations.transition;
}

export interface TransitionFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly mix: number;
  readonly theme: ThemeTokens;
  /** 把上一镜头画到给定 ctx（已含相机） */
  readonly drawPrevious: (ctx: CanvasRenderingContext2D) => void;
  /** 已画好新镜头的离屏画布 */
  readonly incoming: Canvas;
  /** 上一镜头离屏画布（whip/scale 等需要整体变换时使用） */
  readonly outgoing: Canvas;
  readonly seed: number;
  /** 新镜头的“无文字”版本（背景+IP），作为溶解的公共底层 */
  readonly drawIncomingBase?: (ctx: CanvasRenderingContext2D) => void;
  readonly incomingBase?: Canvas;
  /** 上一镜头的焦点元素（归一化矩形）：zoomIntoElement 以它为中心钻入，缺省为画面中上部 */
  readonly focus?: FocusRect;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function drawThemeTransition(id: TransitionId, f: TransitionFrame): void {
  const { ctx, width: w, height: h, theme } = f;
  const ease = cubicBezier(theme.easings.camera);
  const m = clamp01(f.mix), e = ease(m);
  const outCtx = f.outgoing.getContext('2d');
  outCtx.clearRect(0, 0, w, h); f.drawPrevious(outCtx);
  const drawImg = (img: Canvas, alpha = 1, filter = '') => {
    ctx.save(); ctx.globalAlpha = alpha; if (filter) ctx.filter = filter; ctx.drawImage(img, 0, 0); ctx.restore();
  };
  const bg = () => { ctx.save(); ctx.fillStyle = theme.palette.bg; ctx.fillRect(0, 0, w, h); ctx.restore(); };
  const scaled = (img: Canvas, s: number, alpha = 1, cx = w / 2, cy = h / 2, filter = '') => {
    ctx.save(); ctx.globalAlpha = alpha; if (filter) ctx.filter = filter;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy); ctx.drawImage(img, 0, 0); ctx.restore();
  };
  switch (id) {
    case 'cutOnBeat':
      drawImg(m >= 0.5 ? f.incoming : f.outgoing); return;
    case 'blurDissolve': {
      // 先后两段，不让新旧文字同时半透明：底层是新镜头的无字版本（背景+IP 不闪），
      // 旧镜头在前半段淡出（带轻微模糊），新镜头在后半段淡入。
      if (f.drawIncomingBase && f.incomingBase) { f.drawIncomingBase(f.incomingBase.getContext('2d')); drawImg(f.incomingBase); } else bg();
      const outA = 1 - clamp01(m / 0.45), inA = clamp01((m - 0.38) / 0.62); // 新字提前约 1 帧进入，无字间隙 ≤ 1 帧
      if (outA > 0) drawImg(f.outgoing, cubicBezier(theme.easings.exit)(outA), `blur(${(4 * (1 - outA)).toFixed(2)}px)`);
      if (inA > 0) drawImg(f.incoming, cubicBezier(theme.easings.enter)(inA), inA < 1 ? `blur(${(4 * (1 - inA)).toFixed(2)}px)` : '');
      return;
    }
    case 'riseFade': {
      // 透明度在中点交接：前半段旧字淡出，后半段新字淡入；共享切点最多产生一帧无字画面。
      // 位移仍独立求值：旧画面上移 1.5%，新画面从下方 3% 处升起。
      // 底层直接是新镜头无字版本（背景/光环/IP 处于目标亮度），不从暗场淡起
      if (f.drawIncomingBase && f.incomingBase) { f.drawIncomingBase(f.incomingBase.getContext('2d')); drawImg(f.incomingBase); } else bg();
      const outA = 1 - clamp01(m / 0.5), inA = clamp01((m - 0.5) / 0.5);
      ctx.save(); ctx.globalAlpha = outA; ctx.translate(0, -h * 0.015 * e); ctx.drawImage(f.outgoing, 0, 0); ctx.restore();
      ctx.save(); ctx.globalAlpha = cubicBezier(theme.easings.enter)(inA); ctx.translate(0, h * 0.03 * (1 - e)); ctx.drawImage(f.incoming, 0, 0); ctx.restore();
      return;
    }
    case 'maskWipeUp': {
      drawImg(f.outgoing);
      const edge = h * (1 - e);
      ctx.save(); ctx.beginPath(); ctx.rect(0, edge, w, h - edge); ctx.clip(); ctx.translate(0, (1 - e) * h * 0.08); ctx.drawImage(f.incoming, 0, 0); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.5 * Math.sin(Math.PI * m); ctx.fillStyle = theme.palette.accent; ctx.fillRect(0, edge - 1, w, 2); ctx.restore();
      return;
    }
    case 'scaleThrough': {
      bg();
      scaled(f.outgoing, 1 + 0.25 * e, 1 - clamp01(m / 0.55));
      scaled(f.incoming, 0.9 + 0.1 * e, clamp01((m - 0.35) / 0.65));
      return;
    }
    case 'zoomIntoElement': {
      // 钻入上一镜头的焦点元素：旧画面以元素中心为原点放大到元素充满画面并淡出，
      // 新画面从同一点展开——观众的视线始终停在同一个位置上，所以两镜头像是连续的一个推镜。
      bg();
      const fc = f.focus ? focusCenter(f.focus, w, h) : { x: w / 2, y: h * 0.47 };
      const target = f.focus ? Math.max(2, zoomToFill(f.focus, 1.1, 10)) : 4;
      const z = Math.pow(target, e);
      scaled(f.outgoing, z, 1 - clamp01((m - 0.4) / 0.4), fc.x, fc.y, `blur(${(e * 10).toFixed(2)}px)`);
      const inP = clamp01((m - 0.45) / 0.55);
      const ie = cubicBezier(theme.easings.enter)(inP);
      // 新画面的展开中心从焦点滑回画面中心，落定时没有偏移
      scaled(f.incoming, 0.6 + 0.4 * ie, inP, fc.x + (w / 2 - fc.x) * ie, fc.y + (h / 2 - fc.y) * ie);
      return;
    }
    case 'whipPan': {
      // 甩切 + 运动模糊：在快门区间内多次采样位移并平均
      bg();
      // 快门宽度随瞬时速度变化：只有峰值附近（约 4 帧）才有明显拖影，两端清晰
      const samples = Math.max(1, theme.treatments.motionBlur.samples);
      const vel = Math.abs(ease(clamp01(m + 0.01)) - ease(clamp01(m - 0.01))) / 0.02; // 归一化速度（≈0..5）
      const shutter = theme.treatments.motionBlur.shutter * 0.06 * Math.max(0, vel - 1.2);
      for (let s = 0; s < samples; s++) {
        const mm = clamp01(m + (s / Math.max(1, samples - 1) - 0.5) * shutter);
        const ee = ease(mm), x = -ee * w;
        // 逐次平均：第 k 次以 1/(k+1) 叠加，结果等于全部采样的均值，深浅底色都不会过曝
        ctx.save(); ctx.globalAlpha = 1 / (s + 1);
        ctx.drawImage(f.outgoing, x, 0); ctx.drawImage(f.incoming, x + w, 0); ctx.restore();
      }
      return;
    }
    case 'glitchCut': {
      drawImg(m < 0.5 ? f.outgoing : f.incoming);
      // 故障只在切点 ±0.2（≈4 帧）内出现，强度较上一版降 30%，减轻人物面部撕裂
      const k = 0.7 * Math.max(0, 1 - Math.abs(m - 0.5) / 0.2); if (k < 0.05) return;
      let s = (f.seed ^ 0x9e3779b9) >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      for (let i = 0; i < 14; i++) {
        const y = rnd() * h, bh = 6 + rnd() * h * 0.04, dx = (rnd() - 0.5) * w * 0.12 * k;
        ctx.save(); ctx.beginPath(); ctx.rect(0, y, w, bh); ctx.clip(); ctx.drawImage(rnd() < 0.5 ? f.outgoing : f.incoming, dx, 0); ctx.restore();
      }
      ctx.save(); ctx.globalAlpha = 0.25 * k; ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = theme.palette.accent; ctx.fillRect(0, h * m - 2, w, 4); ctx.restore();
      return;
    }
    case 'lineScan': {
      drawImg(f.outgoing);
      const y = h * e;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, y); ctx.clip(); ctx.drawImage(f.incoming, 0, 0); ctx.restore();
      ctx.save(); ctx.fillStyle = theme.palette.accent; ctx.globalAlpha = 0.8 * Math.sin(Math.PI * m); ctx.fillRect(0, y - 1, w, 2);
      ctx.globalAlpha = 0.12 * Math.sin(Math.PI * m); ctx.fillRect(0, y - 40, w, 40); ctx.restore();
      return;
    }
    case 'paperFlip': {
      // 纸张翻页：沿水平中线压扁旧页，再展开新页，中段露出纸色
      bg();
      const first = m < 0.5, p = first ? m * 2 : (m - 0.5) * 2, sy = first ? 1 - ease(p) : ease(p);
      ctx.save(); ctx.translate(0, h / 2); ctx.scale(1, Math.max(0.001, sy)); ctx.translate(0, -h / 2);
      ctx.drawImage(first ? f.outgoing : f.incoming, 0, 0); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.25 * (1 - sy); ctx.fillStyle = theme.palette.text; ctx.fillRect(0, h / 2 - 2, w, 4); ctx.restore();
      return;
    }
    case 'inkBleed': {
      // 墨晕：若干确定性圆斑扩散成遮罩
      drawImg(f.outgoing);
      let s = (f.seed ^ 0x51ed27) >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      ctx.save(); ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const cx = rnd() * w, cy = rnd() * h, delay = rnd() * 0.4, r = Math.max(0, (m - delay) / (1 - delay)) * Math.hypot(w, h) * 0.6;
        if (r > 0) { ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2); }
      }
      ctx.clip(); ctx.filter = `blur(${(6 * (1 - m)).toFixed(2)}px)`; ctx.drawImage(f.incoming, 0, 0); ctx.restore();
      return;
    }
  }
}

/** 转场专用中性色：与暗场主题的暖白/橙色一致，不依赖调色板名称。 */
const TRANSITION_INK = '#fff0d7';
const TRANSITION_ACCENT = '#f1aa65';
/** 有混合过程的转场；cut 与 fade 不需要预绘上一镜头。 */
const BLENDED_TRANSITIONS = ['dissolve', 'wipe', 'iris', 'zoom', 'grid', 'glitch', 'tokenize'] as const;


/** Public legacy names remain supported; cut/fade have no previous-frame blend. */
export function isBlendedTransition(id: Transition): boolean { return isThemeTransition(id) || (BLENDED_TRANSITIONS as readonly string[]).includes(id); }
export function transitionDuration(id: Transition, theme: ThemeTokens): number { return isThemeTransition(id) ? themeTransitionDuration(id, theme) : 0.5; }
export function drawTransition(id: Transition, f: TransitionFrame & { readonly sceneId: string }): void {
  if (isThemeTransition(id)) return drawThemeTransition(id, f);
  const { ctx, width, height, mix, incoming } = f;
if (id === 'zoom') {
  // 旧画面被镜头推近并压暗，新画面从稍远处放大到位。
  const ease = mix * mix * (3 - 2 * mix);
  ctx.save();
  ctx.globalAlpha = 1 - 0.7 * mix;
  const push = 1 + 0.32 * mix;
  ctx.translate(width / 2, height / 2); ctx.scale(push, push); ctx.translate(-width / 2, -height / 2);
  f.drawPrevious(ctx);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = Math.min(1, ease * 1.35);
  const arrive = 1.16 - 0.16 * ease;
  ctx.translate(width / 2, height / 2); ctx.scale(arrive, arrive); ctx.translate(-width / 2, -height / 2);
  ctx.drawImage(incoming, 0, 0);
  ctx.restore();
} else {
  f.drawPrevious(ctx);
  if (id === 'dissolve' || id === 'wipe' || id === 'iris') {

    ctx.save();
    if (id === 'dissolve') ctx.globalAlpha = mix;
    else {
      ctx.beginPath();
      if (id === 'wipe') ctx.rect(0, 0, width * mix, height);
      else ctx.arc(width / 2, height / 2, Math.hypot(width, height) / 2 * mix, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(incoming, 0, 0);
    ctx.restore();
  } else if (id === 'grid') {
    // 网格式接管：每格按种子确定的次序从上方滑入，未完成的格子留一条亮边。

    const cols = 6, rows = Math.max(3, Math.round(6 * height / width));
    const cellW = width / cols, cellH = height / rows;
    const rng = mulberry32(hashString(`${f.sceneId}:grid`));
    const total = cols * rows;
    for (let i = 0; i < total; i++) {
      const threshold = rng();
      const p = Math.max(0, Math.min(1, (mix - threshold * 0.7) / 0.3));
      if (p <= 0) continue;
      const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cellW, cellH); ctx.clip();
      ctx.globalAlpha = p;
      ctx.translate(0, (1 - p) * cellH * 0.55);
      ctx.drawImage(incoming, 0, 0);
      ctx.restore();
      if (p < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.5; ctx.strokeStyle = TRANSITION_INK; ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, cellW - 1.5, cellH - 1.5);
        ctx.restore();
      }
    }
  } else if (id === 'tokenize') {
    // 逐行「重新排版」：新画面像一行行文字被重新打散再对齐，
    // 自上而下错峰落位，未落定的行保留一条亮边，读起来像词元在逐行归位。

    const rows = 7, bandH = height / rows;
    const rng = mulberry32(hashString(`${f.sceneId}:tokenize`));
    for (let i = 0; i < rows; i++) {
      const delay = (i / rows) * 0.34;
      const p = Math.max(0, Math.min(1, (mix - delay) / (1 - 0.34)));
      if (p <= 0) continue;
      const e = p * p * (3 - 2 * p);
      const y = i * bandH;
      const dir = rng() < 0.5 ? -1 : 1;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, y, width, bandH + 1); ctx.clip();
      ctx.globalAlpha = Math.min(1, p * 1.6);
      ctx.translate((1 - e) * dir * width * 0.05, 0);
      ctx.translate(width / 2, y); ctx.scale(0.94 + 0.06 * e, 1); ctx.translate(-width / 2, -y);
      ctx.drawImage(incoming, 0, 0);
      ctx.restore();
      if (p < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.45; ctx.fillStyle = TRANSITION_ACCENT;
        ctx.fillRect(0, y - 1.5, width, 3);
        ctx.restore();
      }
    }
  } else if (id === 'glitch') {
    // 条带位移 + 扫描光带：中段最强烈，两端回到稳定画面。

    const slices = 18, sliceH = height / slices;
    const intensity = Math.sin(Math.PI * mix);
    const coverage = Math.min(1, mix * 1.25);
    const rng = mulberry32(hashString(`${f.sceneId}:glitch`));
    const alpha = Math.min(1, mix * 2.2);
    for (let i = 0; i < slices; i++) {
      const roll = rng();
      const shift = (roll * 2 - 1) * intensity * width * 0.09;
      const y = i * sliceH;
      if (roll < coverage) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, y, width, sliceH + 1); ctx.clip();
        ctx.globalAlpha = alpha; ctx.translate(shift, 0); ctx.drawImage(incoming, 0, 0);
        ctx.restore();
      }
      if (roll > 0.9) {
        ctx.save();
        ctx.globalAlpha = 0.12 * intensity; ctx.fillStyle = TRANSITION_ACCENT;
        ctx.fillRect(shift * 0.6, y, width, sliceH);
        ctx.restore();
      }
    }
    ctx.save();
    ctx.globalAlpha = 0.18 * intensity; ctx.fillStyle = TRANSITION_ACCENT;
    ctx.fillRect(0, mix * height - 3, width, 6);
    ctx.globalAlpha = 0.1 * intensity; ctx.fillStyle = TRANSITION_INK;
    ctx.fillRect(0, mix * height - 9, width, 2);
    ctx.restore();
  }
}
}

export function drawTransitionFade(ctx: CanvasRenderingContext2D, width: number, height: number, localTime: number, untilEnd: number): void {
const sinceStart = localTime;
const fadeDur = 0.6;
const fade = Math.max(
  sinceStart < fadeDur ? 1 - sinceStart / fadeDur : 0,
  untilEnd < fadeDur ? 1 - untilEnd / fadeDur : 0,
);
if (fade > 0) {
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, fade));
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
}
