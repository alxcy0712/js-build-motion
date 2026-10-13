/** Original vector graphics: normalized geometry and shot-local keyframes. */
import { EASING_NAMES } from '../animation/easing.ts';

export const GRAPHIC_KINDS = ['rect', 'ellipse', 'polyline', 'curve', 'text'] as const;
/**
 * 关键帧缓动。`smoothstep`（默认）保持历史行为；其余取自 animation/easing.ts。
 * 缓动写在**该段终点**的关键帧上，作用区间是「上一个关键帧 → 本关键帧」。
 */
export const GRAPHIC_EASINGS = ['smoothstep', ...EASING_NAMES] as const;
export type GraphicEasing = (typeof GRAPHIC_EASINGS)[number];
export interface GraphicKeyframe {
  at: number;
  x?: number; y?: number; scale?: number; rotation?: number; opacity?: number; reveal?: number;
  /** 外发光强度 0–1。允许随时间变化，让「充电/衰减」有中间态而不是只有开关。 */
  glow?: number;
  /** 描边宽度（以画面短边为单位，0–0.05）。允许线自己长粗或变细。 */
  strokeWidth?: number;
  /** 缓动名；省略等价于 smoothstep（两端一阶导为 0 的三次平滑） */
  ease?: GraphicEasing;
}
/** 可动画的通道；capabilities 输出直接用它，避免代码与清单漂移。 */
export const GRAPHIC_KEYFRAME_CHANNELS = ['x', 'y', 'scale', 'rotation', 'opacity', 'reveal', 'glow', 'strokeWidth'] as const;
/** 线性渐变填充：角度为度，0 表示从左到右。 */
export interface GraphicGradient {
  from: string;
  to: string;
  angle?: number;
}
export interface GraphicElement {
  id: string;
  kind: typeof GRAPHIC_KINDS[number];
  x: number; y: number; width: number; height: number;
  fill?: string; stroke?: string; strokeWidth?: number;
  /** rect 的圆角半径，以图元短边为单位（0–0.5）。 */
  radius?: number;
  /** 只描边、不填充；用来画圆环、框架与刻度盘。 */
  hollow?: boolean;
  /** 外发光强度 0–1；阴影色取描边色，没有描边时取填充色。 */
  glow?: number;
  /** 虚线密度 0–1；0 或省略为实线。 */
  dash?: number;
  /** 渐变填充；与 fill 同时给出时以 gradient 为准。 */
  gradient?: GraphicGradient;
  text?: string; fontSize?: number;
  /** polyline 是折线；curve 把同一组点当作 Catmull-Rom 控制点，得到光滑曲线，并按弧长描绘。 */
  points?: Array<{ x: number; y: number }>;
  closed?: boolean;
  keyframes?: GraphicKeyframe[];
}
const coordinate = { type: 'number', minimum: -1, maximum: 2 } as const;
const fraction = { type: 'number', minimum: 0, maximum: 1 } as const;
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } as const;
export const GRAPHIC_SCHEMA = {
  type: 'array', maxItems: 80, items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'kind', 'x', 'y', 'width', 'height'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 40 }, kind: { enum: [...GRAPHIC_KINDS] },
      x: coordinate, y: coordinate, width: { type: 'number', exclusiveMinimum: 0, maximum: 2 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 2 },
      fill: color, stroke: color, strokeWidth: { type: 'number', minimum: 0, maximum: 0.05 },
      radius: { type: 'number', minimum: 0, maximum: 0.5 },
      hollow: { type: 'boolean' },
      glow: fraction,
      dash: fraction,
      gradient: {
        type: 'object', additionalProperties: false, required: ['from', 'to'],
        properties: { from: color, to: color, angle: { type: 'number', minimum: -180, maximum: 180 } },
      },
      text: { type: 'string', minLength: 1, maxLength: 100 }, fontSize: { type: 'number', minimum: 0.01, maximum: 0.25 },
      points: { type: 'array', minItems: 2, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: fraction, y: fraction } } },
      closed: { type: 'boolean' },
      keyframes: { type: 'array', minItems: 1, maxItems: 30, items: {
        type: 'object', additionalProperties: false, required: ['at'], minProperties: 2,
        properties: { at: fraction, x: coordinate, y: coordinate, scale: { type: 'number', minimum: 0, maximum: 4 }, rotation: { type: 'number', minimum: -1080, maximum: 1080 }, opacity: fraction, reveal: fraction, glow: fraction, strokeWidth: { type: 'number', minimum: 0, maximum: 0.05 }, ease: { enum: [...GRAPHIC_EASINGS] } },
      } },
    },
    allOf: [
      { if: { properties: { kind: { const: 'text' } } }, then: { required: ['text'] } },
      { if: { properties: { kind: { enum: ['polyline', 'curve'] } } }, then: { required: ['points'] } },
    ],
  },
} as const;

export function graphicIssues(elements: readonly GraphicElement[]): string[] {
  const issues: string[] = [], ids = new Set<string>();
  for (const element of elements) {
    if (ids.has(element.id)) issues.push(`重复图元 id: ${element.id}`);
    ids.add(element.id);
    const keys = element.keyframes ?? [];
    if (keys.some((k, i) => i > 0 && k.at <= keys[i - 1]!.at)) issues.push(`${element.id}: keyframes.at 必须严格递增`);
  }
  return issues;
}
