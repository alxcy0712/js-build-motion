import type { CanvasRenderingContext2D as Context } from 'skia-canvas';
import type { GraphicEasing, GraphicElement, GraphicKeyframe } from '../../spec/graphic.ts';
import { getEasing } from '../../animation/easing.ts';
import { PROJECT_FONT_FAMILY } from '../../utils/env.ts';

/** 默认缓动：三次平滑。省略 ease 的既有计划因此逐帧不变。 */
const smoothstepEase = (t: number): number => t * t * (3 - 2 * t);

function easeFor(name: GraphicEasing | undefined): (t: number) => number {
  if (!name || name === 'smoothstep') return smoothstepEase;
  return getEasing(name);
}

export function graphicState(element: GraphicElement, progress: number) {
  const state = {
    x: element.x, y: element.y, scale: 1, rotation: 0, opacity: 1, reveal: 1,
    glow: element.glow ?? 0, strokeWidth: element.strokeWidth ?? DEFAULT_STROKE_WIDTH,
  };
  for (const key of Object.keys(state) as Array<keyof typeof state>) {
    const frames = (element.keyframes ?? []).filter(k => k[key] !== undefined);
    let previous: GraphicKeyframe = { at: 0, [key]: state[key] };
    for (const next of frames) {
      if (progress >= next.at) { previous = next; state[key] = next[key]!; continue; }
      const p = Math.max(0, Math.min(1, (progress - previous.at) / (next.at - previous.at || 1)));
      state[key] = previous[key]! + (next[key]! - previous[key]!) * easeFor(next.ease)(p);
      break;
    }
  }
  return state;
}

const DEFAULT_FILL = '#448c88', DEFAULT_STROKE = '#303443';
/** 描边宽度缺省值（以画面短边为单位），与 drawGraphics 里的 fallback 保持一致。 */
const DEFAULT_STROKE_WIDTH = 0.003;
type Gradient = ReturnType<Context['createLinearGradient']>;

/**
 * Catmull-Rom 采样：把控制点转成足够密的折线。
 *
 * 为什么需要它：注意力连线、能量流向这类内容要的是「光滑」，而 polyline 只能画直段。
 * 端点各复制一次，等价于把首尾切线固定在端点方向上，曲线不会甩出去。
 */
function sampleCurve(points: ReadonlyArray<{ x: number; y: number }>, steps = 16): Array<{ x: number; y: number }> {
  if (points.length < 3) return points.map(p => ({ ...p }));
  const pad = [points[0]!, ...points, points[points.length - 1]!];
  const sampled: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < pad.length - 2; i++) {
    const p0 = pad[i - 1]!, p1 = pad[i]!, p2 = pad[i + 1]!, p3 = pad[i + 2]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      sampled.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  sampled.push({ ...points[points.length - 1]! });
  return sampled;
}

/** 按弧长（而非顶点数）描绘：样条各段长度不同，按顶点推进会让曲线「忽快忽慢」。 */
function traceByLength(c: Context, sampled: ReadonlyArray<{ x: number; y: number }>, reveal: number, ew: number, eh: number): void {
  const scaled = sampled.map(p => ({ x: (p.x - 0.5) * ew, y: (p.y - 0.5) * eh }));
  c.moveTo(scaled[0]!.x, scaled[0]!.y);
  if (reveal >= 1) {
    for (let i = 1; i < scaled.length; i++) c.lineTo(scaled[i]!.x, scaled[i]!.y);
    return;
  }
  let total = 0;
  const lengths: number[] = [0];
  for (let i = 1; i < scaled.length; i++) {
    total += Math.hypot(scaled[i]!.x - scaled[i - 1]!.x, scaled[i]!.y - scaled[i - 1]!.y);
    lengths.push(total);
  }
  const target = total * Math.max(0, Math.min(1, reveal));
  for (let i = 1; i < scaled.length; i++) {
    const reached = lengths[i]!;
    if (reached <= target) { c.lineTo(scaled[i]!.x, scaled[i]!.y); continue; }
    const t = target - lengths[i - 1]!;
    const p = scaled[i]!, q = scaled[i - 1]!;
    c.lineTo(q.x + (p.x - q.x) * t, q.y + (p.y - q.y) * t);
    break;
  }
}

/** 0 度表示从左到右；渐变跨度为图元外接盒在给定方向上的投影长度。 */
function fillStyleFor(c: Context, element: GraphicElement, ew: number, eh: number): string | Gradient {
  const g = element.gradient;
  if (!g) return element.fill ?? DEFAULT_FILL;
  const angle = (g.angle ?? 0) * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle);
  const reach = (Math.abs(dx) * ew + Math.abs(dy) * eh) / 2;
  const gradient = c.createLinearGradient(-dx * reach, -dy * reach, dx * reach, dy * reach);
  gradient.addColorStop(0, g.from);
  gradient.addColorStop(1, g.to);
  return gradient;
}

/** Array order is paint order. All motion is evaluated from local progress. */
export function drawGraphics(c: Context, elements: readonly GraphicElement[], progress: number, w: number, h: number): void {
  const unit = Math.min(w, h);
  for (const element of elements) {
    const state = graphicState(element, progress), ew = element.width * w, eh = element.height * h;
    c.save(); c.translate(state.x * w, state.y * h); c.rotate(state.rotation * Math.PI / 180); c.scale(state.scale, state.scale);
    c.globalAlpha *= state.opacity; c.fillStyle = fillStyleFor(c, element, ew, eh); c.strokeStyle = element.stroke ?? DEFAULT_STROKE;
    c.lineWidth = state.strokeWidth * unit; c.lineCap = 'round'; c.lineJoin = 'round';
    if (element.dash && element.dash > 0) { const segment = element.dash * unit * 0.02; c.setLineDash([segment, segment * 0.85]); }
    if (state.glow > 0) { c.shadowColor = element.stroke ?? element.fill ?? '#fff0d7'; c.shadowBlur = state.glow * unit * 0.09; }
    c.beginPath();
    if (element.kind === 'rect') {
      const boxW = ew * state.reveal, radius = element.radius ? Math.min(element.radius * Math.min(ew, eh), Math.min(Math.abs(boxW), eh) / 2) : 0;
      if (radius > 0.01 && boxW > 0.01) c.roundRect(-ew / 2, -eh / 2, boxW, eh, radius);
      else c.rect(-ew / 2, -eh / 2, boxW, eh);
    }
    else if (element.kind === 'ellipse') c.ellipse(0, 0, ew / 2 * state.reveal, eh / 2 * state.reveal, 0, 0, Math.PI * 2);
    else if (element.kind === 'polyline') {
      const points = element.points ?? [];
      const distance = state.reveal * (points.length - 1);
      points.forEach((point, i) => {
        if (i === 0) c.moveTo((point.x - 0.5) * ew, (point.y - 0.5) * eh);
        else if (i <= distance) c.lineTo((point.x - 0.5) * ew, (point.y - 0.5) * eh);
        else if (i - 1 < distance) {
          const prev = points[i - 1]!, p = distance - i + 1;
          c.lineTo((prev.x + (point.x - prev.x) * p - 0.5) * ew, (prev.y + (point.y - prev.y) * p - 0.5) * eh);
        }
      });
      if (element.closed && state.reveal === 1) c.closePath();
    } else if (element.kind === 'curve') {
      const sampled = sampleCurve(element.points ?? []);
      traceByLength(c, sampled, state.reveal, ew, eh);
      if (element.closed && state.reveal === 1) c.closePath();
    } else {
      c.font = `${(element.fontSize ?? 0.04) * unit}px "${PROJECT_FONT_FAMILY}"`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const chars = Array.from(element.text ?? '');
      c.fillText(chars.slice(0, Math.ceil(chars.length * state.reveal)).join(''), 0, 0, ew);
    }
    if (element.kind !== 'text') {
      // 折线与曲线默认只描边（它们是「路径」不是「面」），要填充得显式 closed。
      const isPath = element.kind === 'polyline' || element.kind === 'curve';
      if ((!isPath || element.closed) && !element.hollow) c.fill();
      if (element.stroke || isPath) c.stroke();
    }
    c.restore();
  }
}
