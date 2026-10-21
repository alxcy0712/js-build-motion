import type { CanvasRenderingContext2D as Context } from 'skia-canvas';
import type { SceneRenderContext } from './registry.ts';
import { beatAt, beatPulse, easeOutBack } from '../../animation/beat.ts';
import { hashString, mulberry32 } from '../../animation/random.ts';
import { PROJECT_FONT_FAMILY } from '../../utils/env.ts';
import { drawGraphics } from './graphics.ts';

const TAU = Math.PI * 2;
const themes = {
  studio: { paper: '#f4ecdb', ink: '#303443', accent: '#de795d', secondary: '#448c88', wash: '#e4c2b1' },
  night: { paper: '#202b48', ink: '#fff0d7', accent: '#f1aa65', secondary: '#8ac2c3', wash: '#3b4b70' },
  sunrise: { paper: '#f6ddd0', ink: '#493342', accent: '#c65863', secondary: '#528b8a', wash: '#eeb3a0' },
};
type Theme = typeof themes.studio;
function ellipse(c: Context, x: number, y: number, rx: number, ry: number, fill: string): void {
  c.fillStyle = fill; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fill();
}
function stroke(c: Context, points: number[][], color: string, width: number): void {
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath();
  points.forEach(([x, y], i) => { if (i) c.lineTo(x!, y!); else c.moveTo(x!, y!); }); c.stroke();
}
function star(c: Context, x: number, y: number, r: number, color: string, rotation = 0): void {
  c.save(); c.translate(x, y); c.rotate(rotation); c.fillStyle = color; c.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i * TAU / 8, d = i % 2 ? r * 0.25 : r;
    if (i) c.lineTo(Math.cos(a) * d, Math.sin(a) * d); else c.moveTo(d, 0);
  }
  c.closePath(); c.fill(); c.restore();
}

/** Fits text by measured glyph widths, with at most three lines inside a fixed safe region. */
export function fitTitle(c: Context, text: string, width: number, initialSize: number): { lines: string[]; size: number } {
  let size = initialSize;
  for (;;) {
    c.font = `${size}px "${PROJECT_FONT_FAMILY}"`;
    const lines: string[] = []; let line = '';
    for (const ch of Array.from(text)) {
      if (line && c.measureText(line + ch).width > width) { lines.push(line); line = ''; }
      line += ch;
    }
    if (line) lines.push(line);
    if (lines.length <= 3 || size <= initialSize * 0.25) return { lines, size };
    size *= 0.9;
  }
}

export function drawMotionStage(rc: SceneRenderContext): void {
  const { ctx: c, width: w, height: h, scene, time: t, sceneTime: lt, seed } = rc;
  const comp = scene.composition!;
  const theme = themes[comp.backdrop], unit = Math.min(w, h);
  const p = Math.max(0, Math.min(1, lt / Math.max(0.001, scene.end - scene.start)));
  const pulse = beatPulse(t, comp.bpm), rng = mulberry32(seed ^ hashString(scene.id));
  c.fillStyle = theme.paper; c.fillRect(0, 0, w, h);
  // Large translucent pigment pools; their topology is fixed by the shot seed.
  for (let i = 0; i < 8; i++) {
    const x = rng() * w, y = rng() * h, radius = unit * (0.15 + rng() * 0.3);
    const color = i % 2 ? theme.accent : theme.secondary;
    c.save(); c.globalAlpha = 0.04; ellipse(c, x, y, radius, radius * 0.75, color); c.restore();
  }
  // Stage depth and a stable floor, leaving the lower 15% available for captions.
  c.save(); c.globalAlpha = 0.15; ellipse(c, w * 0.5, h * 0.76, w * 0.52, h * 0.13, theme.wash); c.restore();
  stroke(c, [[w * 0.06, h * 0.77], [w * 0.94, h * 0.77]], theme.wash, unit * 0.002);
  const cx = w * 0.5, cy = h * 0.52;
  if (comp.motif === 'orbit') {
    for (let ring = 0; ring < 3; ring++) {
      c.save(); c.translate(cx, cy); c.rotate(ring * 1.03 + t * 0.09);
      c.strokeStyle = theme.secondary; c.globalAlpha = 0.4; c.lineWidth = unit * 0.002;
      c.beginPath(); c.ellipse(0, 0, unit * 0.34, unit * 0.11, 0, 0, TAU); c.stroke();
      c.globalAlpha = 1; const angle = t * 1.4 + ring * 2;
      ellipse(c, Math.cos(angle) * unit * 0.34, Math.sin(angle) * unit * 0.11, unit * 0.016, unit * 0.016, theme.accent); c.restore();
    }
  } else if (comp.motif === 'growth') {
    for (let i = 0; i < 5; i++) {
      const k = easeOutBack(Math.min(1, Math.max(0, lt * 1.2 - i * 0.14)));
      const bh = unit * (0.09 + i * 0.065) * k;
      c.fillStyle = i % 2 ? theme.secondary : theme.accent;
      c.beginPath(); c.roundRect(w * 0.27 + i * w * 0.095, h * 0.7 - bh, w * 0.055, bh, unit * 0.012); c.fill();
    }
  } else if (comp.motif === 'burst') {
    for (let i = 0; i < 16; i++) {
      const angle = i * TAU / 16 + t * 0.1, radius = unit * (0.24 + pulse * 0.03);
      star(c, cx + Math.cos(angle) * radius * 1.4, cy + Math.sin(angle) * radius, unit * (0.012 + (i % 3) * 0.008), i % 2 ? theme.accent : theme.secondary, angle);
    }
  }
  drawGraphics(c, comp.elements ?? [], p, w, h);
  // Typography is part of the shot, independently staged from the character action.
  // 入场比 0 秒晚一点：混合类转场（dissolve/wipe/zoom/grid…）的前 0.3 秒里上一镜头还没退场，
  // 两个标题同一位置同屏会叠成重影；让新标题等旧画面淡得差不多了再上来。
  const title = fitTitle(c, comp.title, w * 0.8, unit * 0.072);
  c.fillStyle = theme.ink; c.textAlign = 'center'; c.textBaseline = 'middle';
  const titleAlpha = Math.max(0, Math.min(1, (lt - 0.1) / 0.3));
  const enter = easeOutBack(titleAlpha);
  c.save(); c.globalAlpha = titleAlpha; c.translate(cx, h * 0.15); c.scale(0.95 + enter * 0.05, 0.95 + enter * 0.05);
  title.lines.forEach((line, i) => c.fillText(line, 0, i * title.size * 1.15)); c.restore();
  if (comp.subtitle) {
    const subtitle = fitTitle(c, comp.subtitle, w * 0.8, unit * 0.028);
    c.globalAlpha = Math.max(0, Math.min(1, (lt - 0.25) / 0.4));
    subtitle.lines.forEach((line, i) => c.fillText(line, cx, h * 0.82 + i * subtitle.size * 1.2)); c.globalAlpha = 1;
  }
}
