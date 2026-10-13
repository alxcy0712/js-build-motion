/** 风格 token 校验：返回问题列表，空数组即合格。不依赖渲染器，可在 CI 中跑。 */
import { THEME_IDS } from './ids.ts';
import { minWindowMotion } from './liveness.ts';
import { bezierOvershoots, isLinear, springOvershoot } from './motion.ts';
import type { Orientation, ThemeTokens, TypeRole } from './types.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;
const ROLES: readonly TypeRole[] = ['hero', 'display', 'title', 'body', 'caption', 'micro'];
const CANVAS: Record<Orientation, [number, number]> = { vertical: [1080, 1920], horizontal: [1920, 1080] };
/** 文字不过冲的容差：解析过冲 < 0.1% 视为无过冲 */
export const NO_OVERSHOOT_EPSILON = 0.001;

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

export function validateTheme(t: ThemeTokens): string[] {
  const e: string[] = [];
  if (!THEME_IDS.includes(t.id)) e.push(`id ${t.id} 未登记`);
  for (const [k, v] of Object.entries(t.palette)) if (!HEX.test(v)) e.push(`palette.${k} 非 #RRGGBB: ${v}`);
  if (HEX.test(t.palette.text) && HEX.test(t.palette.bg) && contrast(t.palette.text, t.palette.bg) < 7) e.push('正文与背景对比度 < 7:1');
  if (HEX.test(t.palette.textSecondary) && contrast(t.palette.textSecondary, t.palette.bg) < 3) e.push('次级文字对比度 < 3:1');
  for (const o of ['vertical', 'horizontal'] as const) {
    const s = t.type[o];
    for (let i = 1; i < ROLES.length; i++) if (!(s[ROLES[i]!] < s[ROLES[i - 1]!])) e.push(`type.${o} 字号未严格递减: ${ROLES[i - 1]} → ${ROLES[i]}`);
    if (s.micro < (o === 'vertical' ? 24 : 20)) e.push(`type.${o}.micro 过小，手机不可读`);
    const sa = t.safeArea[o], [w, h] = CANVAS[o];
    if (sa.left + sa.right >= w * 0.4 || sa.top + sa.bottom >= h * 0.6) e.push(`safeArea.${o} 可用区过小`);
  }
  if (!t.fonts.stack.length || !t.fonts.faces.length) e.push('fonts.stack/faces 为空');
  if (!t.fonts.stack.some((f) => /CJK|SC|PingFang|HarmonyOS/.test(f))) e.push('字体栈缺少中文字体');
  for (const [k, b] of Object.entries(t.easings)) {
    if (b.length !== 4 || b[0] < 0 || b[0] > 1 || b[2] < 0 || b[2] > 1) e.push(`easings.${k} x 坐标须在 [0,1]`);
    if (isLinear(b)) e.push(`easings.${k} 为线性缓动（禁止）`);
  }
  for (const [k, s] of Object.entries(t.springs)) if (!(s.stiffness > 0 && s.damping > 0)) e.push(`springs.${k} 参数非法`);
  if (!t.transitions.length) e.push('transitions 为空');
  for (const [k, v] of Object.entries(t.durations)) if (!(v > 0 && v < 10)) e.push(`durations.${k} 越界`);
  if (t.durations.exit > t.durations.enter) e.push('退场不应慢于进场');
  const r = t.textReveal;
  const os = Math.max(springOvershoot(r.positionSpring), springOvershoot(t.springs.text));
  if (!r.allowOvershoot) {
    if (os > NO_OVERSHOOT_EPSILON) e.push(`文字弹簧过冲 ${(os * 100).toFixed(2)}%，本风格禁止`);
    if (bezierOvershoots(r.opacityEase)) e.push('文字缓动带回弹，本风格禁止');
    if (r.maxOvershoot !== 0) e.push('allowOvershoot=false 时 maxOvershoot 须为 0');
  } else if (os > r.maxOvershoot + 1e-9) e.push(`文字过冲 ${(os * 100).toFixed(2)}% 超过上限 ${(r.maxOvershoot * 100).toFixed(1)}%`);
  if (isLinear(r.opacityEase)) e.push('textReveal.opacityEase 为线性');
  const g = t.treatments.grain.opacity;
  if (g < 0 || g > 0.12) e.push('grain.opacity 越界 [0,0.12]');
  if (t.treatments.motionBlur.samples < 1) e.push('motionBlur.samples ≥ 1');
  const L = t.liveness;
  if (!L) e.push('缺少 liveness（防死帧规则）');
  else {
    if (!L.layers.some((l) => l !== 'grain')) e.push('liveness.layers 至少需要一层非颗粒运动（drift/parallax/lightSweep/boil）');
    if (!(L.maxStillSeconds > 0 && L.maxStillSeconds <= 0.5)) e.push('liveness.maxStillSeconds 须在 (0, 0.5]');
    if (L.layers.includes('drift') && !(t.treatments.drift.scaleTo > 1)) e.push('drift 已启用但 scaleTo ≤ 1');
    if (L.layers.includes('lightSweep') && !L.lightSweep) e.push('lightSweep 已启用但缺少参数');
    const m = minWindowMotion(t);
    if (m < L.minMotionPx) e.push(`微运动不足：最弱 ${L.maxStillSeconds}s 窗口仅 ${m.toFixed(2)}px < ${L.minMotionPx}px`);
  }
  return e;
}
