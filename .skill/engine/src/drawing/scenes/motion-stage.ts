import type { CanvasRenderingContext2D as Context } from 'skia-canvas';
import type { SceneRenderContext } from './rain-window.ts';
import type { MotionActor } from '../../spec/motion.ts';
import { beatAt, beatPulse, easeOutBack } from '../../animation/beat.ts';
import { hashString, mulberry32 } from '../../animation/random.ts';
import { watercolorBlob } from '../art/watercolor.ts';
import { PaperTexture } from '../art/paper.ts';
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

/** Shared character with identity-derived colors, readable expression and articulated limbs. */
function actor(c: Context, a: MotionActor, t: number, bpm: number, size: number, theme: Theme): void {
  const identity = hashString(a.id), phase = (identity % 100) / 100 * TAU;
  const beat = beatAt(t, bpm) * TAU;
  const energetic = ['bounce', 'celebrate', 'walk'].includes(a.gesture);
  const lift = energetic ? Math.max(0, Math.sin(beat)) * 0.14 : Math.sin(t * 2 + phase) * 0.012;
  const squash = energetic ? Math.cos(beat) * 0.045 : 0;
  const color = identity % 2 ? theme.accent : theme.secondary;
  c.save(); c.translate(0, -size * lift); c.scale(size * (1 + squash), size * (1 - squash));
  c.rotate(a.gesture === 'celebrate' ? Math.sin(beat / 2) * 0.08 : Math.sin(t * 1.2 + phase) * 0.015);
  const step = a.gesture === 'walk' ? Math.sin(beat) * 0.17 : 0;
  stroke(c, [[-0.18, -0.19], [-0.21 - step, 0], [-0.32 - step, 0]], theme.ink, 0.045);
  stroke(c, [[0.18, -0.19], [0.21 + step, 0], [0.32 + step, 0]], theme.ink, 0.045);
  const hand = a.gesture === 'wave' ? -0.68 + Math.sin(beat) * 0.12 : a.gesture === 'celebrate' ? -0.78 : -0.33;
  stroke(c, [[-0.32, -0.46], [-0.49, hand + 0.07], [-0.58, hand]], theme.ink, 0.035);
  if (a.gesture !== 'think') {
    stroke(c, [[0.32, -0.46], [0.49, hand + 0.07], [0.58, hand]], theme.ink, 0.035);
    ellipse(c, 0.58, hand, 0.055, 0.05, color);
  }
  ellipse(c, -0.58, hand, 0.055, 0.05, color);
  c.fillStyle = color; c.strokeStyle = theme.ink; c.lineWidth = 0.022;
  c.beginPath(); c.roundRect(-0.36, -0.8, 0.72, 0.63, 0.15); c.fill(); c.stroke();
  c.save(); c.globalAlpha = 0.16; ellipse(c, -0.13, -0.65, 0.18, 0.08, '#fff8e9'); c.restore();
  const blink = Math.sin(t * 1.7 + phase) > 0.996;
  const eyeY = -0.53;
  for (const x of [-0.13, 0.13]) {
    if (blink) stroke(c, [[x - 0.04, eyeY], [x + 0.04, eyeY]], '#302c39', 0.022);
    else { ellipse(c, x, eyeY, 0.058, a.mood === 'curious' ? 0.09 : 0.07, '#fff6df'); ellipse(c, x + 0.012, eyeY, 0.025, 0.039, '#302c39'); }
  }
  c.strokeStyle = '#302c39'; c.lineWidth = 0.023; c.beginPath();
  c.moveTo(-0.07, -0.36); c.quadraticCurveTo(0, a.mood === 'worried' ? -0.44 : -0.27, 0.07, -0.36); c.stroke();
  if (a.gesture === 'think') {
    stroke(c, [[0.34, -0.45], [0.46, -0.28], [0.14, -0.33]], theme.ink, 0.035);
    ellipse(c, 0.14, -0.33, 0.05, 0.045, color);
    for (let i = 0; i < 3; i++) ellipse(c, 0.43 + i * 0.11, -0.83 - i * 0.08, 0.022 + i * 0.012, 0.022 + i * 0.012, theme.ink);
  }
  c.restore();
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
    if (rc.stylePreset === 'flat') {
      c.save(); c.globalAlpha = 0.04; ellipse(c, x, y, radius, radius * 0.75, color); c.restore();
    } else watercolorBlob(c, { seed: seed + i, cx: x, cy: y, rx: radius, ry: radius * 0.75, color, layers: 3, alpha: 0.025, edgeDarkening: 0, granulation: 0, wobble: 0.16, points: 20 });
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
  for (const a of comp.actors) {
    const size = unit * 0.34 * a.scale;
    const x = a.x * w + (a.gesture === 'walk' ? Math.sin(p * Math.PI * 2) * w * 0.035 : 0);
    c.save(); c.globalAlpha = 0.15; ellipse(c, x, a.y * h + unit * 0.013, size * 0.4, size * 0.04, theme.ink); c.restore();
    c.save(); c.translate(x, a.y * h); actor(c, a, t, comp.bpm, size, theme); c.restore();
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
  if (rc.stylePreset !== 'flat') PaperTexture.get({ seed, tint: null, grain: 0.35, fiber: 0.25 }).draw(c, w, h, { alpha: 0.3 });
}
