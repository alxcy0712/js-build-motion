/**
 * theme_stage：完全由风格 token 驱动的标题/观点镜头。
 * 背景、视差层、强调光与文字（drawRevealText）都取自当前风格；文字只在安全区内、按每屏字数预算排版。
 */
import type { CanvasRenderingContext2D } from 'skia-canvas';
import type { SceneRenderContext } from './registry.ts';
import { DEFAULT_THEME } from '../../themes/ids.ts';
import { getTheme } from '../../themes/registry.ts';
import { drawRevealText } from '../../themes/text-reveal.ts';
import { cssFontStack } from '../../themes/fonts.ts';
import { microMotionAt } from '../../themes/liveness.ts';
import type { ThemeTokens, TypeRole, Orientation } from '../../themes/types.ts';
import { drawThemedIP, IP_MAX_DISPLAY } from '../characters/personal-ip.ts';
import { cubicBezier } from '../../themes/motion.ts';

function pickRole(theme: ThemeTokens, ctx: CanvasRenderingContext2D, text: string, o: Orientation, maxW: number, first: boolean, k: number): TypeRole {
  const roles: TypeRole[] = first ? ['hero', 'display', 'title', 'body'] : ['display', 'title', 'body'];
  for (const r of roles) {
    ctx.font = `${theme.weight[r] ?? 700} ${theme.type[o][r] * k}px ${cssFontStack(theme.fonts.stack)}`;
    if (ctx.measureText(text).width <= maxW) return r;
  }
  return 'body';
}

function drawBackdrop(ctx: CanvasRenderingContext2D, th: ThemeTokens, w: number, h: number, sceneTime: number): void {
  const P = th.palette;
  ctx.fillStyle = P.bg; ctx.fillRect(-w, -h, w * 3, h * 3);
  const m = microMotionAt(th, sceneTime), far = th.treatments.depth.parallax[1] ?? 0.5;
  if (th.treatments.glow.opacity > 0) {
    const gx = w / 2 - m.offsetX * far * 2, gy = h * 0.42 - m.offsetY * far * 2;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.55);
    g.addColorStop(0, hexA(P.accent, th.treatments.glow.opacity * 0.22 * (th.id === 'minimal' ? 1.25 : 1))); g.addColorStop(1, hexA(P.accent, 0));
    ctx.fillStyle = g; ctx.fillRect(-w, -h, w * 3, h * 3);
  }
  ctx.save();
  ctx.translate(-m.offsetX * far, -m.offsetY * far);
  if (th.id === 'kinetic') {
    ctx.strokeStyle = P['accent2'] ?? P.accent; ctx.globalAlpha = 0.18; ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) { const y = h * (0.15 + i * 0.14) + Math.sin(sceneTime * 1.3 + i) * 6; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y - w * 0.18); ctx.stroke(); }
  } else {
    ctx.fillStyle = P.textSecondary; ctx.globalAlpha = 0.08;
    const step = Math.round(w / 18);
    for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

export function drawThemeStage(c: SceneRenderContext): void {
  const th = c.theme ?? getTheme(DEFAULT_THEME);
  const { ctx, width: w, height: h, scene } = c;
  const o: Orientation = h >= w ? 'vertical' : 'horizontal';
  const ref = o === 'vertical' ? 1080 : 1920, k = w / ref;
  const sa = th.safeArea[o];
  drawBackdrop(ctx, th, w, h, scene.cameraMove === 'static' && !scene.cameraPath ? 0 : c.sceneTime);
  const left = sa.left * k, right = w - sa.right * k, maxW = right - left, cx = (left + right) / 2;
  const lines = scene.headline ?? [];
  const dur = scene.end - scene.start;
  // 下一镜头带风格转场时文字不退场，交给转场带走；否则在镜头末尾退场
  const exitAt = c.textHold ? Infinity : Math.max(0.6, dur - th.textReveal.exitDuration - 0.05);
  // 由转场带入、或风格要求首屏即清晰时，文字第一帧就在位
  // 整片首镜头默认首帧即完整显示（封面/钩子帧）；风格可显式设为 reveal
  const firstInstant = c.firstShot && (th.textReveal.firstScreen ?? 'instant') === 'instant';
  const enterAt = c.textCarriedIn || firstInstant ? -10 : 0.15;
  // 首帧可见状态上的轻微进场：缩放 0.985→1、亮度 0.85→1（不经过透明/模糊）
  const intro = firstInstant ? cubicBezier(th.easings.enter)(Math.min(1, c.sceneTime / th.durations.enter)) : 1;
  // IP：小幅美术，按源尺寸或更小显示；identity=身份署名，actor=讲解动画里的演员
  const ip = scene.ip;
  if (ip) {
    const size = Math.min(IP_MAX_DISPLAY, (ip.size ?? 288) * k);
    const bottomSafe = h - sa.bottom * k - 8 * k;
    const pos = ip.position ?? 'bottom-center';
    const ipCx = pos === 'bottom-left' ? sa.left * k + size / 2 : pos === 'bottom-right' ? w - sa.right * k - size / 2 : pos === 'custom' ? (ip.x ?? 0.5) * w : cx;
    const ipBottom = pos === 'center' ? h / 2 + size / 2 : pos === 'custom' ? (ip.y ?? 0.7) * h : bottomSafe;
    const ipOpacity = c.firstShot && !c.textCarriedIn ? Math.max(0, Math.min(1, (c.sceneTime - 4 / 30) / 0.2)) : 1;
    const expression = ip.expression ?? scene.ipExpression;
    if (ipOpacity > 0) drawThemedIP(ctx, th, { time: c.sceneTime + scene.start, cx: ipCx, bottom: ipBottom, size, opacity: ipOpacity, motion: ip.role === 'actor', ...(expression ? { expression } : {}) });
  }

  // 最后一行是落点（hero），前面的行为铺垫（display，次级色）
  const roles = lines.map((line, i) => pickRole(th, ctx, line, o, maxW, i === lines.length - 1, k));
  const sizes = roles.map((r) => th.type[o][r] * k * th.leading * 1.05);
  const kickerSize = scene.kicker ? th.type[o].body * k * 1.8 : 0;
  const total = sizes.reduce((a, b) => a + b, 0) + kickerSize;
  // 纯文字镜头居中；identity 署名在底部时文字略上移，actor 由镜头自行编排
  const centerY = (scene.ip?.role === 'identity' && (scene.ip.position ?? 'bottom-center').startsWith('bottom') ? (o === 'vertical' ? 0.4 : 0.42) : (o === 'vertical' ? 0.44 : 0.5)) * h;
  let y = Math.max(sa.top * k, centerY - total / 2);
  if (c.noText) return;
  ctx.save();
  if (intro < 1) {
    const midY = y + total / 2, sc = 0.985 + 0.015 * intro;
    ctx.translate(cx, midY); ctx.scale(sc, sc); ctx.translate(-cx, -midY);
    ctx.filter = `brightness(${(0.85 + 0.15 * intro).toFixed(3)})`;
  }
  if (scene.kicker) {
    drawRevealText(ctx as never, th, scene.kicker, c.sceneTime, { role: 'body', orientation: o, x: cx, y: y + th.type[o].body * k, enterAt: enterAt < 0 ? enterAt : 0.1, exitAt, color: th.palette.accent });
    y += kickerSize;
  }
  lines.forEach((line, i) => {
    const size = th.type[o][roles[i]!] * k;
    const color = i < lines.length - 1 ? th.palette.textSecondary : th.palette.text;
    drawRevealText(ctx as never, th, line, c.sceneTime, { role: roles[i]!, orientation: o, x: cx, y: y + size * 0.92, enterAt, exitAt, index: i + (scene.kicker ? 1 : 0), color });
    y += sizes[i]!;
  });
  ctx.restore();
}
