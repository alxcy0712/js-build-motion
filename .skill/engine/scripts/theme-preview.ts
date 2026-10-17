/** 每个风格出一张竖屏预览静帧（不出视频）。用法：node scripts/theme-preview.ts <outDir> */
import { Canvas, FontLibrary } from 'skia-canvas';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { THEME_IDS, getTheme, assertThemeFonts, drawRevealText, cssFontStack } from '../src/themes/index.ts';
import { outputPath } from '../src/utils/output-dir.ts';

const out = process.argv[2] || outputPath('theme-preview'); mkdirSync(out, { recursive: true });
const W = 1080, H = 1920;
const COPY: Record<string, [string, string, string]> = {
  minimal: ['电脑', '不会焦虑。', '用计算机思维想现实'],
  kinetic: ['3 秒', '搞定。', 'AI WORKFLOW · 01'],
  storybook: ['雨夜里，', '电脑也在想', '关于人生的小事'],
};
for (const id of THEME_IDS) {
  const th = getTheme(id); const c = new Canvas(W, H), ctx = c.getContext('2d');
  const fonts = assertThemeFonts(th, FontLibrary, ctx, join(import.meta.dirname, '../assets/fonts'), { strict: false });
  const P = th.palette, sa = th.safeArea.vertical, cx = (sa.left + W - sa.right) / 2, cy = 900;
  ctx.fillStyle = P.bg; ctx.fillRect(0, 0, W, H);
  if (th.treatments.glow.opacity > 0) {
    const g = ctx.createRadialGradient(cx, cy - 60, 0, cx, cy - 60, 700); g.addColorStop(0, P.accent + '22'); g.addColorStop(1, P.accent + '00'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  const [a, b, sub] = COPY[id]!;
  const t = 3; // 全部进场完成后的静帧
  drawRevealText(ctx as never, th, a, t, { role: 'display', orientation: 'vertical', x: cx, y: cy - 120, enterAt: 0, color: P.textSecondary });
  drawRevealText(ctx as never, th, b, t, { role: 'hero', orientation: 'vertical', x: cx, y: cy + 40, enterAt: 0, index: 1 });
  ctx.font = `500 ${th.type.vertical.caption}px ${cssFontStack(th.fonts.mono ?? th.fonts.stack)}`; ctx.fillStyle = P.textSecondary; ctx.textAlign = 'center'; ctx.fillText(sub, cx, cy + 200);
  ctx.font = `600 ${th.type.vertical.micro}px ${cssFontStack(th.fonts.stack)}`; ctx.fillStyle = P.accent; ctx.fillText(`${th.name} · ${id}`, cx, H - sa.bottom - 40);
  // 安全区参考线（QA）
  ctx.setLineDash([10, 10]); ctx.strokeStyle = 'rgba(255,0,80,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(sa.left, sa.top, W - sa.left - sa.right, H - sa.top - sa.bottom);
  await c.toFile(join(out, `${id}.png`));
  console.log(id, fonts.map((f) => `${f.family}:${f.registered ? 'ok' : 'missing'}`).join(' '));
}
