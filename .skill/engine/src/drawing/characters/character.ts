/**
 * L2 语义对象 —— 人物（需求 §10）。
 *
 * 核心约束：**外貌由 CharacterDefinition 决定，场景只能改姿势/表情/动作。**
 * 这不是风格要求，是可复现性要求：如果每个场景都重新决定发型和衣服，
 * 同一个角色在不同镜头之间就会"换人"，而弱模型没有能力自己记住这些。
 * 一致性必须由引擎保证（§10）。
 *
 * 一致性怎么做到的：
 *   - 体型、脸型、发型、衣物颜色全部来自 def 与调色板，与时间无关
 *   - 呼吸/头发摆动只做**位移**，不改变形状本身
 *   - 所有随机（发丝、衣褶）由 `seed:def.id` 派生 → 同一角色跨场景跨帧完全一致
 *
 * 视图：3/4 侧后视（背对镜头望向窗外），左侧露出侧脸轮廓。
 * 这是"望窗外"最自然的机位——但代价是脸上只能看到一只眼，
 * 所以表情主要靠眉/眼/嘴角的少量参数传达（见 EMOTION_FACE）。
 *
 * 比例（以 bodyH = 头顶到脚底 为单位，实测于本文件的重构过程）：
 *   头高        bodyH/6.1   （插画常用 5.5~6.5，比真人 7.5 头身更可爱）
 *   肩高        0.82 bodyH
 *   腰高        0.58 bodyH
 *   臀高        0.52 bodyH
 *   肩宽        1.8 × 头宽  ← 关键：上一版取 1.2，结果人看起来像个圆锥
 *   衣摆        0.46 bodyH（略低于臀）
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import type { Action, CharacterDefinition, Emotion, HairStyle } from '../../spec/types.ts';
import { SeededRandom, hashString } from '../../animation/random.ts';
import { breathe } from '../../animation/easing.ts';
import { mix, shade, type PaletteColors } from '../styles/palette.ts';
import { roughLine, traceSmoothClosed, wobblyEllipsePoints } from '../art/rough.ts';

// ---------------------------------------------------------------- 体型

interface Proportions {
  readonly headR: number;
  /** 头身比 */
  readonly ratio: number;
  readonly shoulderW: number;
  readonly waistW: number;
  readonly hipW: number;
  readonly hemW: number;
  /** 驼背/前倾 0..1 */
  readonly stoop: number;
}

const PROPORTIONS: Readonly<Record<CharacterDefinition['preset'], Proportions>> = {
  female_young: { headR: 56, ratio: 6.1, shoulderW: 168, waistW: 128, hipW: 152, hemW: 182, stoop: 0.06 },
  female_average: { headR: 58, ratio: 5.9, shoulderW: 176, waistW: 140, hipW: 164, hemW: 196, stoop: 0.08 },
  male_young: { headR: 58, ratio: 6.3, shoulderW: 196, waistW: 150, hipW: 158, hemW: 176, stoop: 0.04 },
  male_average: { headR: 60, ratio: 5.9, shoulderW: 212, waistW: 176, hipW: 178, hemW: 190, stoop: 0.1 },
  child: { headR: 60, ratio: 4.2, shoulderW: 138, waistW: 118, hipW: 134, hemW: 156, stoop: 0.12 },
  elder: { headR: 58, ratio: 5.6, shoulderW: 186, waistW: 158, hipW: 176, hemW: 198, stoop: 0.24 },
};

interface FaceParams {
  readonly browTilt: number;
  readonly browLift: number;
  readonly eyeOpen: number;
  /** 正数上翘 */
  readonly mouthCurve: number;
  readonly mouthOpen: number;
  readonly gazeX: number;
  readonly gazeY: number;
}

const EMOTION_FACE: Readonly<Record<Emotion, FaceParams>> = {
  neutral: { browTilt: 0, browLift: 0, eyeOpen: 1, mouthCurve: 0.08, mouthOpen: 0, gazeX: 0, gazeY: 0 },
  nostalgic: { browTilt: -0.12, browLift: -0.08, eyeOpen: 0.82, mouthCurve: 0.24, mouthOpen: 0, gazeX: -0.12, gazeY: -0.3 },
  happy: { browTilt: 0.06, browLift: 0.28, eyeOpen: 0.88, mouthCurve: 0.9, mouthOpen: 0.32, gazeX: 0, gazeY: -0.1 },
  sad: { browTilt: -0.32, browLift: 0.22, eyeOpen: 0.7, mouthCurve: -0.52, mouthOpen: 0, gazeX: 0, gazeY: 0.55 },
  anxious: { browTilt: -0.22, browLift: 0.34, eyeOpen: 1.18, mouthCurve: -0.18, mouthOpen: 0.24, gazeX: 0.14, gazeY: 0.1 },
  calm: { browTilt: 0.02, browLift: -0.04, eyeOpen: 0.9, mouthCurve: 0.2, mouthOpen: 0, gazeX: 0, gazeY: 0 },
  hopeful: { browTilt: 0.1, browLift: 0.22, eyeOpen: 1.06, mouthCurve: 0.42, mouthOpen: 0.08, gazeX: 0, gazeY: -0.5 },
};

interface PoseParams {
  readonly armAngle: number;
  readonly armRaise: number;
  readonly headTurn: number;
  readonly headDrop: number;
  readonly lean: number;
}

const ACTION_POSE: Readonly<Record<Action, PoseParams>> = {
  stand: { armAngle: 0.14, armRaise: 0, headTurn: 0, headDrop: 0, lean: 0 },
  sit: { armAngle: 0.46, armRaise: 0.2, headTurn: 0, headDrop: 0.05, lean: 0.12 },
  walk: { armAngle: 0.28, armRaise: 0.1, headTurn: 0, headDrop: 0, lean: 0.06 },
  write: { armAngle: 0.86, armRaise: 0.55, headTurn: 0.1, headDrop: 0.45, lean: 0.22 },
  read: { armAngle: 0.78, armRaise: 0.5, headTurn: 0.06, headDrop: 0.4, lean: 0.16 },
  look_outside: { armAngle: 0.18, armRaise: 0.1, headTurn: -0.14, headDrop: -0.05, lean: 0.05 },
  drink: { armAngle: 0.68, armRaise: 0.72, headTurn: 0.05, headDrop: 0.12, lean: 0.1 },
  turn_head: { armAngle: 0.12, armRaise: 0, headTurn: 0.3, headDrop: 0, lean: 0 },
  smile: { armAngle: 0.12, armRaise: 0, headTurn: 0, headDrop: -0.02, lean: 0 },
  sleep: { armAngle: 0.58, armRaise: 0.3, headTurn: 0.14, headDrop: 0.5, lean: 0.3 },
};

interface HairShape {
  /** 颅顶盖相对头部的放大系数 */
  readonly capScale: number;
  /** 后发长度（headR 的倍数） */
  readonly backLength: number;
  /** 后发向右的偏移（headR 的倍数） */
  readonly backShift: number;
  readonly accessory: 'none' | 'ponytail' | 'bun';
  /** 0=最深，1=最浅（用于深发/浅发） */
  readonly tone: number;
  readonly fringe: number;
}

function hairShapeFor(style: HairStyle): HairShape {
  switch (style) {
    case 'long_dark': return { capScale: 1.12, backLength: 2.9, backShift: 0.34, accessory: 'none', tone: 0.32, fringe: 1 };
    case 'long_light': return { capScale: 1.1, backLength: 2.7, backShift: 0.32, accessory: 'none', tone: 0.74, fringe: 1 };
    case 'short_dark': return { capScale: 1.1, backLength: 1.0, backShift: 0.16, accessory: 'none', tone: 0.32, fringe: 0.9 };
    case 'short_light': return { capScale: 1.08, backLength: 0.9, backShift: 0.14, accessory: 'none', tone: 0.74, fringe: 0.85 };
    case 'bun': return { capScale: 1.09, backLength: 1.1, backShift: 0.2, accessory: 'bun', tone: 0.38, fringe: 0.8 };
    case 'ponytail': return { capScale: 1.08, backLength: 1.2, backShift: 0.24, accessory: 'ponytail', tone: 0.38, fringe: 0.9 };
    default: return { capScale: 1.1, backLength: 2.4, backShift: 0.3, accessory: 'none', tone: 0.32, fringe: 1 };
  }
}

function clothingBase(clothing: CharacterDefinition['clothing'], palette: PaletteColors): string {
  switch (clothing) {
    case 'dark_coat': return mix(palette.clothing, palette.shadow, 0.7);
    case 'white_shirt': return '#e9e5dd';
    case 'sweater': return mix(palette.clothing, palette.accent, 0.38);
    case 'dress': return mix(palette.clothing, palette.accent, 0.22);
    case 'school_uniform': return mix(palette.clothing, palette.sky, 0.34);
    case 'beige_coat':
    default: return palette.clothing;
  }
}

// ---------------------------------------------------------------- 主入口

export interface CharacterDrawOptions {
  readonly def: CharacterDefinition;
  readonly palette: PaletteColors;
  /** 脚底位置（像素） */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly time: number;
  readonly action: Action;
  readonly emotion: Emotion;
}

export function drawCharacter(ctx: CanvasRenderingContext2D, options: CharacterDrawOptions): void {
  const { def, palette, x, y, scale, time, action, emotion } = options;

  const p = PROPORTIONS[def.preset];
  const pose = ACTION_POSE[action];
  const hair = hairShapeFor(def.hair);
  const clothBase = clothingBase(def.clothing, palette);
  const idSeed = hashString(def.id);
  const rng = new SeededRandom(idSeed);

  const headR = p.headR;
  const bodyH = headR * 2 * p.ratio;
  const shoulderY = -bodyH * 0.82;
  const hipY = -bodyH * 0.52;
  const hemY = -bodyH * 0.46;
  const headCenterY = -bodyH + headR * 1.0;

  // 呼吸 ~15 次/分（平静）。振幅刻意压到 1~2px：插画角色的"活"来自几乎看不见的位移
  const breath = (breathe(time / 4) - 0.5) * 2;
  const chestLift = breath * 1.7;
  const headBob = breath * 0.9;
  const headSway = Math.sin(time * 0.37) * 0.01 + Math.sin(time * 0.23) * 0.007;
  const hairSway = Math.sin(time * 0.31 + 1.1) * 0.018;

  const lineColor = palette.line;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  const lean = (pose.lean + p.stoop) * 0.055;
  if (lean !== 0) {
    ctx.translate(0, hipY);
    ctx.rotate(-lean);
    ctx.translate(0, -hipY);
  }

  // 深层 → 浅层：下半身 → 躯干 → 手臂 → 头
  drawLegs(ctx, { hipY, hipW: p.hipW, color: mix(clothBase, palette.shadow, 0.42), palette, seed: idSeed });
  drawTorso(ctx, { shoulderY: shoulderY + chestLift, hipY, hemY, p, clothBase, palette, rng, seed: idSeed });
  drawArms(ctx, {
    shoulderY: shoulderY + chestLift,
    p,
    pose,
    base: clothBase,
    skin: palette.skin,
    lineColor,
    sway: breath * 0.9,
  });
  drawHeadAndHair(ctx, {
    headR,
    headCenterY: headCenterY + headBob,
    headSway,
    hairSway,
    pose,
    hair,
    face: EMOTION_FACE[emotion],
    palette,
    lineColor,
    seed: idSeed,
    shoulderY: shoulderY + chestLift,
    clothBase,
  });

  ctx.restore();
}

// ---------------------------------------------------------------- 部件

function drawLegs(
  ctx: CanvasRenderingContext2D,
  o: { hipY: number; hipW: number; color: string; palette: PaletteColors; seed: number },
): void {
  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = o.color;
  // 两条腿 + 裙摆/裤型的整体块，形状不规则以免变成两个矩形
  const pts: Array<[number, number]> = [
    [-o.hipW * 0.5, o.hipY],
    [-o.hipW * 0.56, o.hipY + 90],
    [-o.hipW * 0.42, -40],
    [-o.hipW * 0.5 - 6, 0],
    [-o.hipW * 0.13, 4],
    [-o.hipW * 0.1, -46],
    [o.hipW * 0.1, -46],
    [o.hipW * 0.13, 4],
    [o.hipW * 0.5 + 6, 0],
    [o.hipW * 0.42, -40],
    [o.hipW * 0.56, o.hipY + 90],
    [o.hipW * 0.5, o.hipY],
  ];
  ctx.beginPath();
  ctx.moveTo(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
  for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTorso(
  ctx: CanvasRenderingContext2D,
  o: {
    shoulderY: number;
    hipY: number;
    hemY: number;
    p: Proportions;
    clothBase: string;
    palette: PaletteColors;
    rng: SeededRandom;
    seed: number;
  },
): void {
  const { shoulderY, hipY, hemY, p, clothBase } = o;
  const top = shoulderY - 6;
  const bottom = hemY;

  // 宽度控制点：肩 → 腋 → 腰 → 臀 → 摆。分档线性插值，避免出现"圆锥"
  const ctrl: ReadonlyArray<readonly [number, number]> = [
    [0, p.shoulderW / 2],
    [0.16, (p.shoulderW / 2) * 0.99],
    [0.33, (p.shoulderW / 2) * 0.9],
    [0.55, p.waistW / 2],
    [0.78, p.hipW / 2],
    [1, p.hemW / 2],
  ];
  const halfAt = (t: number): number => {
    for (let i = 1; i < ctrl.length; i++) {
      const a = ctrl[i - 1] as readonly [number, number];
      const b = ctrl[i] as readonly [number, number];
      if (t <= b[0]) {
        const k = (t - a[0]) / (b[0] - a[0] || 1);
        const s = k * k * (3 - 2 * k);
        return a[1] + (b[1] - a[1]) * s;
      }
    }
    return (ctrl[ctrl.length - 1] as readonly [number, number])[1];
  };

  ctx.save();
  ctx.fillStyle = clothBase;

  const rows = 30;
  const jitterRng = new SeededRandom((o.seed ^ 0x77aa) >>> 0);
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const yy = top + (bottom - top) * t;
    const half = halfAt(t) + (jitterRng.next() - 0.5) * 1.8;
    left.push([-half, yy]);
    right.push([half, yy]);
  }
  ctx.beginPath();
  ctx.moveTo(left[0]?.[0] ?? 0, left[0]?.[1] ?? top);
  for (const [px, py] of left.slice(1)) ctx.lineTo(px, py);
  for (const [px, py] of right.reverse()) ctx.lineTo(px, py);
  ctx.closePath();
  ctx.fill();

  // 受光（右侧靠灯）
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.16;
  const lit = ctx.createLinearGradient(-p.shoulderW * 0.2, 0, p.shoulderW * 0.6, 0);
  lit.addColorStop(0, 'rgba(0,0,0,0)');
  lit.addColorStop(1, o.palette.lamp);
  ctx.fillStyle = lit;
  ctx.fillRect(-p.shoulderW, top, p.shoulderW * 2, bottom - top);

  // 阴影（左侧背光）
  ctx.globalAlpha = 0.12;
  const sh = ctx.createLinearGradient(-p.shoulderW * 0.6, 0, 0, 0);
  sh.addColorStop(0, o.palette.shadow);
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(-p.shoulderW, top, p.shoulderW, bottom - top);
  ctx.restore();

  // 门襟：大衣从领口到下摆的一条线，是"这是件外套"的关键线索
  ctx.save();
  ctx.globalAlpha = 0.28;
  roughLine(ctx, p.shoulderW * 0.06, top + 26, p.hemW * 0.04, bottom - 8, {
    seed: (o.seed + 313) >>> 0, segments: 10, wobble: 1.3, color: o.palette.line, width: 2.2, alpha: 0.6,
  });
  // 衣褶
  ctx.globalAlpha = 0.14;
  for (let i = 0; i < 7; i++) {
    const fx = (i / 6 - 0.5) * p.hemW * 0.82;
    roughLine(ctx, fx, hipY - 26, fx * 0.88, bottom - 12, {
      seed: (o.seed + i * 91) >>> 0, segments: 6, wobble: 1.4,
      color: mix(clothBase, o.palette.line, 0.55), width: 1.7, alpha: 0.5,
    });
  }
  ctx.restore();

  // 外轮廓
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.strokeStyle = o.palette.line;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(left[0]?.[0] ?? 0, left[0]?.[1] ?? top);
  for (const [px, py] of left.slice(1)) ctx.lineTo(px, py);
  ctx.stroke();

  // 袖窿（肩到腋的弧线），把手臂和躯干在视觉上分开
  for (const side of [-1, 1] as const) {
    ctx.globalAlpha = 0.3;
    roughLine(ctx, side * p.shoulderW * 0.44, top + 6, side * p.shoulderW * 0.5, top + 96, {
      seed: (o.seed + (side > 0 ? 501 : 502)) >>> 0, segments: 6, wobble: 1.2,
      color: o.palette.line, width: 2, alpha: 0.5,
    });
  }
  ctx.restore();
  ctx.restore();
}

function drawArms(
  ctx: CanvasRenderingContext2D,
  o: {
    shoulderY: number;
    p: Proportions;
    pose: PoseParams;
    base: string;
    skin: string;
    lineColor: string;
    sway: number;
  },
): void {
  const upper = o.p.shoulderW * 0.52;
  const fore = o.p.shoulderW * 0.46;
  const sleeveW = o.p.shoulderW * 0.155;
  // 袖子只比大衣略深一点：上一版压暗 10% 后袖子变成灰管，和大衣割裂
  const sleeve = mix(o.base, o.lineColor, 0.12);

  ctx.save();
  for (const side of [-1, 1] as const) {
    const raise = o.pose.armRaise * (side === 1 ? 1.3 : 0.7);
    const a = o.pose.armAngle * side + (side === 1 ? -raise : raise * 0.35);
    const sway = o.sway * side * 0.3;
    const sx = side * (o.p.shoulderW / 2 - sleeveW * 0.9);
    const sy = o.shoulderY + 12;

    const ex = sx + Math.sin(a) * upper + sway;
    const ey = sy + Math.cos(a) * upper;
    const wx = ex + Math.sin(a * 0.68) * fore + sway * 0.6;
    const wy = ey + Math.cos(a * 0.68) * fore;

    // 袖子：用两段圆头线而不是一条直线，形成肘部转折
    ctx.globalAlpha = 0.98;
    ctx.strokeStyle = sleeve;
    ctx.lineCap = 'round';
    ctx.lineWidth = sleeveW;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo((sx + ex) / 2 + side * 3, (sy + ey) / 2, ex, ey);
    ctx.stroke();
    ctx.lineWidth = sleeveW * 0.92;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.quadraticCurveTo((ex + wx) / 2, (ey + wy) / 2, wx, wy);
    ctx.stroke();

    // 袖口：只在手腕附近的一小段。
    // 上一版把整条小臂（肘→腕）都描了深色，结果两条手臂看起来是灰管子，
    // 和大衣完全割裂。
    ctx.globalAlpha = 0.2;
    ctx.strokeStyle = o.lineColor;
    ctx.lineWidth = sleeveW * 1.04;
    ctx.beginPath();
    ctx.moveTo(ex + (wx - ex) * 0.76, ey + (wy - ey) * 0.76);
    ctx.lineTo(wx, wy);
    ctx.stroke();

    // 手
    ctx.globalAlpha = 1;
    ctx.fillStyle = o.skin;
    ctx.beginPath();
    ctx.ellipse(wx, wy + 4, sleeveW * 0.44, sleeveW * 0.55, a * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHeadAndHair(
  ctx: CanvasRenderingContext2D,
  o: {
    headR: number;
    headCenterY: number;
    headSway: number;
    hairSway: number;
    pose: PoseParams;
    hair: HairShape;
    face: FaceParams;
    palette: PaletteColors;
    lineColor: string;
    seed: number;
    shoulderY: number;
    clothBase: string;
  },
): void {
  const { headR, palette, lineColor, face, hair } = o;

  ctx.save();
  ctx.translate(0, o.headCenterY + o.pose.headDrop * headR * 0.22);
  ctx.rotate(o.headSway + o.pose.headTurn * 0.05);

  // --- 脖子（画在脸之前，会被下巴压住） ---
  ctx.globalAlpha = 0.98;
  ctx.fillStyle = shade(palette.skin, 0.86);
  ctx.beginPath();
  ctx.roundRect(-headR * 0.27, headR * 0.6, headR * 0.54, headR * 0.85, headR * 0.16);
  ctx.fill();

  // --- 脸：完整椭圆（右侧随后被头发盖住） ---
  const facePts = wobblyEllipsePoints({
    seed: (o.seed + 11) >>> 0, cx: 0, cy: 0, rx: headR * 0.85, ry: headR, wobble: 0.03, points: 34,
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.skin;
  traceSmoothClosed(ctx, facePts);
  ctx.fill();

  // 耳（左侧，3/4 侧后视时可见）
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = shade(palette.skin, 0.94);
  ctx.beginPath();
  ctx.ellipse(-headR * 0.1, headR * 0.12, headR * 0.12, headR * 0.18, 0.2, 0, Math.PI * 2);
  ctx.fill();

  // 颊部红晕
  ctx.save();
  ctx.globalAlpha = 0.16;
  const blush = ctx.createRadialGradient(-headR * 0.46, headR * 0.2, 2, -headR * 0.46, headR * 0.2, headR * 0.44);
  blush.addColorStop(0, mix(palette.accent, '#ff9d8a', 0.55));
  blush.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = blush;
  ctx.beginPath();
  ctx.arc(-headR * 0.46, headR * 0.2, headR * 0.44, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawProfile(ctx, { headR, face, lineColor, skin: palette.skin });
  drawEye(ctx, { headR, face, lineColor, palette });
  drawHair(ctx, {
    headR, hair, palette, lineColor, seed: o.seed, sway: o.hairSway,
  });

  ctx.restore();

  // 大衣领：画在头之后，形成"衣领包住脖子"的层次
  drawCollar(ctx, {
    y: o.headCenterY + headR * 1.22,
    headR,
    shoulderY: o.shoulderY,
    clothBase: o.clothBase,
    lineColor,
  });
}

function drawProfile(
  ctx: CanvasRenderingContext2D,
  o: { headR: number; face: FaceParams; lineColor: string; skin: string },
): void {
  const { headR, face, lineColor } = o;
  ctx.save();
  ctx.strokeStyle = lineColor;
  ctx.lineCap = 'round';

  // 鼻：左侧弧上的一个小凸起
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(-headR * 0.5, -headR * 0.1);
  ctx.quadraticCurveTo(-headR * 0.88, headR * 0.04, -headR * 0.7, headR * 0.2);
  ctx.stroke();

  // 唇
  const mouthY = headR * 0.44;
  const curve = face.mouthCurve * headR * 0.12;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(-headR * 0.72, mouthY);
  ctx.quadraticCurveTo(-headR * 0.55, mouthY + curve * 0.6, -headR * 0.36, mouthY + curve);
  ctx.stroke();
  if (face.mouthOpen > 0.04) {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = mix(o.skin, '#6b2b32', 0.6);
    ctx.beginPath();
    ctx.ellipse(-headR * 0.54, mouthY + face.mouthOpen * headR * 0.06, headR * 0.14, face.mouthOpen * headR * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 下颌
  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-headR * 0.68, headR * 0.44);
  ctx.quadraticCurveTo(-headR * 0.44, headR * 0.88, -headR * 0.04, headR * 0.94);
  ctx.stroke();
  ctx.restore();
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  o: { headR: number; face: FaceParams; lineColor: string; palette: PaletteColors },
): void {
  const { headR, face, lineColor } = o;
  const ex = -headR * 0.5;
  const ey = -headR * 0.12;
  const w = headR * 0.19;
  const h = Math.max(1.4, headR * 0.1 * face.eyeOpen);

  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = mix(o.palette.skin, '#ffffff', 0.5);
  ctx.beginPath();
  ctx.ellipse(ex, ey, w, h, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = mix(o.palette.hair, '#000000', 0.35);
  ctx.beginPath();
  ctx.arc(ex + face.gazeX * w * 0.6, ey + face.gazeY * h * 0.55, Math.max(1.6, w * 0.52), 0, Math.PI * 2);
  ctx.fill();

  // 上眼睑：比眼白粗，是"有神的眼睛"的关键
  ctx.globalAlpha = 0.68;
  ctx.strokeStyle = lineColor;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.3;
  ctx.beginPath();
  ctx.moveTo(ex - w * 1.15, ey - h * 0.2);
  ctx.quadraticCurveTo(ex, ey - h * 1.75, ex + w * 1.15, ey - h * 0.05);
  ctx.stroke();

  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(ex - w * 0.85, ey + h * 0.8);
  ctx.quadraticCurveTo(ex, ey + h * 1.45, ex + w * 0.9, ey + h * 0.75);
  ctx.stroke();

  // 眉
  ctx.globalAlpha = 0.46;
  ctx.lineWidth = 2;
  const browY = ey - headR * (0.33 + face.browLift * 0.08);
  const tilt = face.browTilt * headR * 0.16;
  ctx.beginPath();
  ctx.moveTo(ex - w * 1.2, browY + tilt);
  ctx.quadraticCurveTo(ex, browY - headR * 0.045 + tilt * 0.3, ex + w * 1.25, browY - tilt);
  ctx.stroke();
  ctx.restore();
}

/**
 * 头发。
 *
 * 上一版的重大错误：把「颅顶」画成了一个**完整的 360° 圆**，
 * 结果整个头（包括脸）都被盖住，人物变成一颗黑球。
 * 正确做法是只画上半部（颅顶盖）+ 后脑下方延伸（后发）+ 额前几缕（刘海）。
 */
function drawHair(
  ctx: CanvasRenderingContext2D,
  o: {
    headR: number;
    hair: HairShape;
    palette: PaletteColors;
    lineColor: string;
    seed: number;
    sway: number;
  },
): void {
  const { headR, hair, lineColor } = o;
  const hairColor = mix(o.palette.hair, '#ffffff', Math.max(0, hair.tone - 0.32) * 0.62);
  const rx = headR * 0.85;
  const ry = headR;
  const backBottom = headR * hair.backLength;
  const shift = headR * hair.backShift;

  // 轮廓点：从左额角 → 颅顶 → 右后 → 后发下摆 → 左脸侧 → 回到左额角
  // 侧后视时"后脑"在右侧，所以后发的偏移量往右。
  const pts: Array<[number, number]> = [
    [-rx * 1.0, -ry * 0.34],                    // 左额角（脸侧起点）
    [-rx * 0.92 + o.sway * headR, -ry * 0.86],  // 左上
    [-rx * 0.42, -ry * 1.14],                   // 头顶偏左
    [rx * 0.24, -ry * 1.16],                    // 头顶偏右
    [rx * 0.88, -ry * 0.9],                     // 右上
    [rx * 1.1 + shift * 0.3, -ry * 0.42],       // 右上后
    [rx * 1.16 + shift * 0.5, ry * 0.3],        // 后脑
    [rx * 1.1 + shift, ry * 0.9],               // 后颈
    [rx * 0.86 + shift, backBottom * 0.62],     // 后发上段
    [rx * 0.5 + shift, backBottom],             // 后发下摆
    [rx * 0.02 + shift * 0.6, backBottom * 0.94],
    [-rx * 0.45, backBottom * 0.72],
    [-rx * 0.66, backBottom * 0.4],
    [-rx * 0.78, ry * 0.34],                    // 脸侧
    [-rx * 0.92, -ry * 0.05],
  ];

  ctx.save();
  ctx.fillStyle = hairColor;
  ctx.beginPath();
  ctx.moveTo(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
  for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
  ctx.closePath();
  ctx.fill();

  // 发丝纹理：沿发流方向的几条线（位置由 seed 固定，只有极轻微摆动）
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 11; i++) {
    const t = (i + 1) / 12;
    const sx = -rx * 0.5 + t * rx * 1.7;
    roughLine(ctx, sx, -ry * 1.0, sx + shift * 1.1 + o.sway * headR * 1.5, backBottom * 0.92, {
      seed: (o.seed + i * 173) >>> 0,
      segments: 9,
      wobble: 2.2,
      color: mix(hairColor, lineColor, 0.5),
      width: 1.6,
      alpha: 0.5,
    });
  }
  // 高光带
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = mix(hairColor, '#ffffff', 0.7);
  ctx.beginPath();
  ctx.ellipse(-rx * 0.28, -ry * 0.72, rx * 0.46, ry * 0.15, -0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 刘海：几缕从发际线垂到眉上方，是"不是光头戴帽子"的关键
  if (hair.fringe > 0) {
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = mix(hairColor, lineColor, 0.12);
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const x0 = -rx * 0.86 + t * rx * 0.86;
      const drop = ry * (0.3 + 0.16 * Math.sin(i * 2.1)) * hair.fringe;
      ctx.beginPath();
      ctx.moveTo(x0, -ry * 0.72);
      ctx.quadraticCurveTo(x0 + rx * 0.16, -ry * 0.2, x0 + rx * 0.06 + o.sway * headR, -ry * 0.72 + drop);
      ctx.quadraticCurveTo(x0 + rx * 0.3, -ry * 0.3, x0 + rx * 0.36, -ry * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 发饰
  if (hair.accessory === 'bun') {
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = hairColor;
    traceSmoothClosed(
      ctx,
      wobblyEllipsePoints({ seed: (o.seed + 71) >>> 0, cx: rx * 0.72 + shift, cy: -ry * 0.66, rx: headR * 0.42, ry: headR * 0.38, wobble: 0.1, points: 20 }),
    );
    ctx.fill();
  } else if (hair.accessory === 'ponytail') {
    ctx.globalAlpha = 0.96;
    ctx.fillStyle = hairColor;
    ctx.beginPath();
    ctx.moveTo(rx * 0.9 + shift, -ry * 0.5);
    ctx.quadraticCurveTo(rx * 1.9 + o.sway * headR * 2, ry * 0.5, rx * 1.35, ry * 1.7);
    ctx.quadraticCurveTo(rx * 1.15, ry * 0.5, rx * 0.72, -ry * 0.28);
    ctx.closePath();
    ctx.fill();
  }

  // 轮廓
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0]?.[0] ?? 0, pts[0]?.[1] ?? 0);
  for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

function drawCollar(
  ctx: CanvasRenderingContext2D,
  o: { y: number; headR: number; shoulderY: number; clothBase: string; lineColor: string },
): void {
  const w = o.headR * 1.42;
  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.fillStyle = mix(o.clothBase, o.lineColor, 0.2);
  ctx.beginPath();
  ctx.moveTo(-w, o.y + 12);
  ctx.quadraticCurveTo(-w * 0.42, o.y - 16, o.headR * 0.06, o.y - 10);
  ctx.quadraticCurveTo(w * 0.55, o.y - 2, w, o.y + 16);
  ctx.lineTo(w * 0.78, o.y + 52);
  ctx.quadraticCurveTo(0, o.y + 30, -w * 0.78, o.y + 52);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = o.lineColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}
