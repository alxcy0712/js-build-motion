/**
 * L2 语义对象 —— 窗户与窗上的雨（需求 §9）。
 *
 * 「雨」是本项目里第一个真正的时间驱动元素，因此也是「确定性动画」的第一个考验：
 * 每滴雨的横坐标、速度、初始相位都来自 seed，纵坐标是 `time` 的函数。
 * 绝不能每帧重新随机位置——那会得到一片噪点而不是雨。
 *
 * 雨分为两层，这是让它看起来像「窗上的雨」而不是「下雪」的关键：
 *   1. 流动的雨痕：沿玻璃滑落的细长水线
 *   2. 静止的水珠：附着在玻璃上的圆点（它们不随时间移动）
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import { SeededRandom, seededArray } from '../../animation/random.ts';
import { noise2D } from '../../animation/noise.ts';
import { alpha, mix, shade, type PaletteColors } from '../styles/palette.ts';
import { roughLine, wobblyEllipsePoints, traceSmoothClosed } from '../art/rough.ts';
import { watercolorWash } from '../art/watercolor.ts';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 固定不动的雨珠：它们是「玻璃上的水」的主要视觉证据 */
interface Bead {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly stretch: number;
  readonly alpha: number;
}

function makeBeads(seed: number, area: Rect, count: number): Bead[] {
  return seededArray(seed, count, (rng) => ({
    x: area.x + rng.next() * area.w,
    y: area.y + rng.next() * area.h,
    r: 1.2 + rng.next() * 3.4,
    // 竖向下坠的水珠会被拉长
    stretch: 1 + rng.next() * 1.8,
    alpha: 0.1 + rng.next() * 0.28,
  }));
}

/** 流动的雨痕：只有 (x, speed, phase, len) 是随机的，y 由 time 决定 */
interface Streak {
  readonly x: number;
  readonly speed: number;
  readonly phase: number;
  readonly len: number;
  readonly wobble: number;
  readonly alpha: number;
}

function makeStreaks(seed: number, area: Rect, count: number): Streak[] {
  return seededArray(seed ^ 0x51ed, count, (rng) => ({
    x: area.x + rng.next() * area.w,
    speed: 120 + rng.next() * 340,
    phase: rng.next() * 1000,
    len: 26 + rng.next() * 90,
    wobble: rng.next() * 0.5,
    alpha: 0.06 + rng.next() * 0.18,
  }));
}

export interface RainOptions {
  readonly seed: number;
  readonly area: Rect;
  readonly time: number;
  readonly palette: PaletteColors;
  /** 0..1，控制雨量。0 表示无雨 */
  readonly intensity?: number;
  /** 风向倾斜（弧度），0 = 垂直下落 */
  readonly slant?: number;
}

/**
 * 在给定矩形内绘制「窗上的雨」。
 * 调用方应先把绘制区域裁剪到玻璃范围内。
 */
export function drawWindowRain(ctx: CanvasRenderingContext2D, options: RainOptions): void {
  const { seed, area, time, palette, intensity = 1, slant = 0.16 } = options;
  if (intensity <= 0) return;

  const streakCount = Math.round(46 * intensity);
  const beadCount = Math.round(150 * intensity);
  const streaks = makeStreaks(seed, area, streakCount);
  const beads = makeBeads(seed ^ 0x9e37, area, beadCount);

  const travel = area.h + 220;

  ctx.save();

  // --- 1. 流动雨痕 ---
  ctx.lineCap = 'round';
  for (const s of streaks) {
    // 关键：位置完全由 time 决定，不含任何每帧随机
    const progress = ((time * s.speed) / travel + s.phase) % 1;
    const y = area.y - 110 + progress * travel;
    const drift = Math.sin(y * 0.01 + s.phase) * s.wobble * 6;
    const x = s.x + drift;

    const dx = Math.sin(slant) * s.len;
    const dy = Math.cos(slant) * s.len;

    ctx.globalAlpha = s.alpha;
    ctx.strokeStyle = palette.rain;
    ctx.lineWidth = 1 + (s.alpha > 0.15 ? 0.8 : 0.3);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - dx, y - dy);
    ctx.stroke();

    // 水痕头部略亮：模拟光在弯月面上的折射
    ctx.globalAlpha = s.alpha * 1.7;
    ctx.fillStyle = palette.glass;
    ctx.beginPath();
    ctx.arc(x, y, 0.9 + s.alpha * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- 2. 静止水珠 ---
  for (const b of beads) {
    ctx.globalAlpha = b.alpha;
    ctx.fillStyle = palette.rain;
    ctx.beginPath();
    ctx.ellipse(b.x, b.y, b.r, b.r * b.stretch, 0, 0, Math.PI * 2);
    ctx.fill();

    // 高光点：这是「水珠」而不是「圆点」的关键
    ctx.globalAlpha = b.alpha * 1.4;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export interface WindowOptions {
  readonly geometry: Rect;
  readonly palette: PaletteColors;
  readonly seed: number;
  readonly time: number;
  readonly intensity?: number;
}

/**
 * 绘制窗户的「外面」：天空 + 远处剪影 + 雨。
 * 这些内容都裁剪在玻璃区域内。
 */
export function drawWindowOutside(ctx: CanvasRenderingContext2D, options: WindowOptions): void {
  const { geometry: g, palette, seed, time, intensity = 1 } = options;

  ctx.save();
  // 玻璃区域（内缩一点，避免雨画到窗框上）
  const inset = Math.min(g.w, g.h) * 0.02;
  const glass: Rect = { x: g.x + inset, y: g.y + inset, w: g.w - inset * 2, h: g.h - inset * 2 };
  ctx.beginPath();
  ctx.rect(glass.x, glass.y, glass.w, glass.h);
  ctx.clip();

  // --- 夜空：上深下浅，靠近地平线处被城市灯火染暖 ---
  const sky = ctx.createLinearGradient(0, glass.y, 0, glass.y + glass.h);
  sky.addColorStop(0, palette.skyDeep);
  sky.addColorStop(0.55, palette.sky);
  sky.addColorStop(1, mix(palette.sky, palette.lamp, 0.28));
  ctx.fillStyle = sky;
  ctx.fillRect(glass.x, glass.y, glass.w, glass.h);

  // --- 云层：低频噪声营造厚度不均 ---
  watercolorWash(
    ctx,
    { x: glass.x, y: glass.y, w: glass.w, h: glass.h * 0.7 },
    { seed: seed + 31, color: shade(palette.skyDeep, 1.25), alpha: 0.5, downscale: 6, feather: 0.25 },
  );

  // --- 远处城市剪影 ---
  const horizon = glass.y + glass.h * 0.72;
  const rng = new SeededRandom(seed ^ 0x1234);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = mix(palette.skyDeep, palette.shadow, 0.5);
  let bx = glass.x;
  while (bx < glass.x + glass.w) {
    const bw = 22 + rng.next() * 54;
    const bh = 18 + rng.next() * 74;
    ctx.fillRect(bx, horizon - bh, Math.min(bw, glass.x + glass.w - bx), bh);
    // 零星亮着的窗
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = palette.lamp;
    const lit = Math.floor(rng.next() * 5);
    for (let i = 0; i < lit; i++) {
      ctx.fillRect(bx + 4 + rng.next() * (bw - 10), horizon - bh + 6 + rng.next() * (bh - 12), 3, 4);
    }
    ctx.restore();
    bx += bw + 2 + rng.next() * 8;
  }
  ctx.restore();

  // --- 雨 ---
  drawWindowRain(ctx, { seed, area: glass, time, palette, intensity });

  // --- 玻璃反光：一道斜向的亮带，让玻璃「存在」 ---
  ctx.save();
  ctx.globalAlpha = 0.09;
  const sheenStart = glass.x + glass.w * (0.12 + 0.04 * Math.sin(time * 0.05));
  const sheen = ctx.createLinearGradient(sheenStart, glass.y, sheenStart + glass.w * 0.34, glass.y + glass.h);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, palette.glass);
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(glass.x, glass.y, glass.w, glass.h);
  ctx.restore();

  // --- 内阴影：玻璃四周略暗，制造纵深 ---
  ctx.save();
  const vig = ctx.createRadialGradient(
    glass.x + glass.w / 2,
    glass.y + glass.h / 2,
    Math.min(glass.w, glass.h) * 0.3,
    glass.x + glass.w / 2,
    glass.y + glass.h / 2,
    Math.max(glass.w, glass.h) * 0.75,
  );
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, alpha(palette.shadow, 0.5));
  ctx.fillStyle = vig;
  ctx.fillRect(glass.x, glass.y, glass.w, glass.h);
  ctx.restore();

  ctx.restore();
}

/**
 * 窗框。画在玻璃之后，覆盖玻璃边缘。
 * 用「水彩填充 + 手绘描边」而不是纯几何矩形——这是插画感的主要来源之一。
 */
export function drawWindowFrame(ctx: CanvasRenderingContext2D, options: WindowOptions): void {
  const { geometry: g, palette, seed } = options;
  const beam = Math.max(10, Math.min(g.w, g.h) * 0.035);

  ctx.save();

  // --- 木质填充（四面框） ---
  const frameColor = mix(palette.wood, palette.wall, 0.35);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = frameColor;
  ctx.fillRect(g.x, g.y, g.w, beam);
  ctx.fillRect(g.x, g.y + g.h - beam, g.w, beam);
  ctx.fillRect(g.x, g.y, beam, g.h);
  ctx.fillRect(g.x + g.w - beam, g.y, beam, g.h);

  // --- 中竖梃与横梃：竖屏窗户用「一竖一横」最稳 ---
  const midX = g.x + g.w * 0.5;
  const midY = g.y + g.h * 0.46;
  ctx.fillRect(midX - beam * 0.32, g.y, beam * 0.64, g.h);
  ctx.fillRect(g.x, midY - beam * 0.28, g.w, beam * 0.56);

  // --- 木纹：几条沿框方向的手绘细线 ---
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 14; i++) {
    const t = (i + 0.5) / 14;
    roughLine(ctx, g.x + g.w * t, g.y + beam * 0.5, g.x + g.w * t, g.y + beam * 0.5, {
      seed: seed + i * 131,
      segments: 2,
      wobble: 0.4,
      color: shade(frameColor, 0.7),
      width: 1,
      alpha: 0.5,
    });
    roughLine(ctx, g.x + beam * 0.5, g.y + g.h * t, g.x + beam * 0.5, g.y + g.h * t, {
      seed: seed + 5000 + i * 137,
      segments: 2,
      wobble: 0.4,
      color: shade(frameColor, 0.7),
      width: 1,
      alpha: 0.5,
    });
  }

  // --- 受光侧：光从室内（下方/右侧）打来 ---
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = palette.lamp;
  ctx.fillRect(g.x + g.w - beam, g.y, beam * 0.35, g.h);
  ctx.fillRect(g.x, g.y + g.h - beam, g.w, beam * 0.3);

  // --- 手绘描边 ---
  ctx.globalAlpha = 0.75;
  const corners: ReadonlyArray<readonly [number, number, number, number]> = [
    [g.x, g.y, g.x + g.w, g.y],
    [g.x, g.y + g.h, g.x + g.w, g.y + g.h],
    [g.x, g.y, g.x, g.y + g.h],
    [g.x + g.w, g.y, g.x + g.w, g.y + g.h],
  ];
  corners.forEach(([x1, y1, x2, y2], i) => {
    roughLine(ctx, x1, y1, x2, y2, {
      seed: seed + 900 + i * 71,
      segments: 22,
      wobble: 1.6,
      color: palette.line,
      width: 2.6,
      alpha: 0.6,
    });
  });
  // 梃的描边
  roughLine(ctx, midX, g.y, midX, g.y + g.h, {
    seed: seed + 1200,
    segments: 20,
    wobble: 1.1,
    color: palette.line,
    width: 1.8,
    alpha: 0.45,
  });
  roughLine(ctx, g.x, midY, g.x + g.w, midY, {
    seed: seed + 1300,
    segments: 20,
    wobble: 1.1,
    color: palette.line,
    width: 1.8,
    alpha: 0.45,
  });

  // --- 窗台：下方一条向外伸出的板 ---
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = mix(palette.wood, palette.lamp, 0.18);
  ctx.beginPath();
  ctx.moveTo(g.x - beam * 1.1, g.y + g.h);
  ctx.lineTo(g.x + g.w + beam * 1.1, g.y + g.h);
  ctx.lineTo(g.x + g.w + beam * 0.6, g.y + g.h + beam * 0.9);
  ctx.lineTo(g.x - beam * 0.6, g.y + g.h + beam * 0.9);
  ctx.closePath();
  ctx.fill();
  roughLine(ctx, g.x - beam * 1.1, g.y + g.h, g.x + g.w + beam * 1.1, g.y + g.h, {
    seed: seed + 1400,
    segments: 22,
    wobble: 1.3,
    color: palette.line,
    width: 2.2,
    alpha: 0.55,
  });

  ctx.restore();
}

/** 窗边的一株植物：用不规则叶簇而不是几何图形 */
export function drawPlant(
  ctx: CanvasRenderingContext2D,
  options: { x: number; y: number; scale: number; palette: PaletteColors; seed: number; time: number },
): void {
  const { x, y, scale, palette, seed, time } = options;
  const s = scale;
  const rng = new SeededRandom(seed);
  const leafColor = mix(palette.accent, '#3f7a5a', 0.65);

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);

  // 花盆
  ctx.fillStyle = mix(palette.wood, palette.shadow, 0.3);
  ctx.beginPath();
  ctx.moveTo(-26, 0);
  ctx.lineTo(26, 0);
  ctx.lineTo(20, 44);
  ctx.lineTo(-20, 44);
  ctx.closePath();
  ctx.fill();

  // 叶片：每片有独立的相位，随时间极缓慢摆动
  const leaves = 13;
  for (let i = 0; i < leaves; i++) {
    const baseAngle = -Math.PI / 2 + (i / (leaves - 1) - 0.5) * 1.9;
    const len = 46 + rng.next() * 52;
    const sway = Math.sin(time * 0.5 + i * 0.7) * 0.035;
    const angle = baseAngle + sway + (rng.next() - 0.5) * 0.24;

    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = i % 3 === 0 ? shade(leafColor, 1.18) : leafColor;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    const tipX = Math.cos(angle) * len;
    const tipY = Math.sin(angle) * len;
    const nx = -Math.sin(angle) * 10;
    const ny = Math.cos(angle) * 10;
    ctx.quadraticCurveTo(tipX * 0.5 + nx, tipY * 0.5 + ny, tipX, tipY);
    ctx.quadraticCurveTo(tipX * 0.5 - nx, tipY * 0.5 - ny, 0, 0);
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

/** 窗前的桌子：一块板 + 两条腿 + 桌上杂物 */
export function drawDesk(
  ctx: CanvasRenderingContext2D,
  options: {
    x: number;
    y: number;
    width: number;
    palette: PaletteColors;
    seed: number;
    time: number;
  },
): void {
  const { x, y, width, palette, seed, time } = options;
  const topThick = 16;

  ctx.save();

  // 桌面
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = mix(palette.wood, palette.lamp, 0.1);
  ctx.fillRect(x, y, width, topThick);
  // 桌面受光边
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = palette.lamp;
  ctx.fillRect(x, y, width, 3);

  // 桌腿
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = shade(palette.wood, 0.8);
  ctx.fillRect(x + 14, y + topThick, 14, 120);
  ctx.fillRect(x + width - 28, y + topThick, 14, 120);

  // 桌面上的手绘线
  roughLine(ctx, x, y, x + width, y, {
    seed: seed + 61,
    segments: 20,
    wobble: 1.2,
    color: palette.line,
    width: 2,
    alpha: 0.5,
  });

  // 台灯：灯罩 + 灯杆 + 暖光晕
  const lampX = x + width * 0.76;
  const glow = ctx.createRadialGradient(lampX, y - 62, 6, lampX, y - 62, 168);
  glow.addColorStop(0, alpha(palette.lamp, 0.5));
  glow.addColorStop(1, alpha(palette.lamp, 0));
  ctx.globalAlpha = 1;
  ctx.fillStyle = glow;
  ctx.fillRect(lampX - 180, y - 240, 360, 300);

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = mix(palette.lamp, '#ffffff', 0.35);
  ctx.beginPath();
  ctx.moveTo(lampX - 40, y - 58);
  ctx.lineTo(lampX + 40, y - 58);
  ctx.lineTo(lampX + 26, y - 112);
  ctx.lineTo(lampX - 26, y - 112);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(palette.wood, 0.9);
  ctx.fillRect(lampX - 3, y - 58, 6, 46);

  // 一杯茶：冒出的热气随时间缓慢上升
  const mugX = x + width * 0.3;
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.roundRect(mugX - 18, y - 44, 36, 44, 6);
  ctx.fill();
  ctx.globalAlpha = 0.14;
  for (let i = 0; i < 3; i++) {
    const rise = ((time * 12 + i * 26) % 78);
    const steamAlpha = (1 - rise / 78) * 0.5;
    ctx.globalAlpha = steamAlpha * 0.35;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(mugX - 6 + i * 6, y - 48 - rise);
    ctx.quadraticCurveTo(mugX - 14 + i * 6, y - 60 - rise, mugX - 4 + i * 6, y - 74 - rise);
    ctx.stroke();
  }

  ctx.restore();
}

/** 用不规则叶簇之外的少量家具：一把椅子的剪影，避免画面下半部空掉 */
export function drawChair(
  ctx: CanvasRenderingContext2D,
  options: { x: number; y: number; scale: number; palette: PaletteColors; seed: number },
): void {
  const { x, y, scale, palette, seed } = options;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.globalAlpha = 0.9;
  ctx.fillStyle = mix(palette.wood, palette.shadow, 0.42);
  ctx.beginPath();
  ctx.roundRect(-38, -96, 76, 14, 4);
  ctx.fill();
  ctx.fillRect(-34, -82, 10, 74);
  ctx.fillRect(24, -82, 10, 74);
  // 椅背
  ctx.fillRect(-34, -150, 10, 56);
  ctx.fillRect(24, -150, 10, 56);
  ctx.fillRect(-38, -154, 76, 12);

  roughLine(ctx, -38, -96, 38, -96, {
    seed: seed + 17,
    segments: 12,
    wobble: 1.1,
    color: palette.line,
    width: 1.8,
    alpha: 0.45,
  });
  ctx.restore();
}

/** 室内墙面与地板：整幅画的底色层 */
export function drawInterior(
  ctx: CanvasRenderingContext2D,
  options: {
    width: number;
    height: number;
    palette: PaletteColors;
    seed: number;
    /** 地板起始高度比例 0..1 */
    floorAt?: number;
  },
): void {
  const { width, height, palette, seed, floorAt = 0.86 } = options;
  const floorY = height * floorAt;

  // 墙：上暗下亮（室内灯在下方）
  watercolorWash(ctx, { x: 0, y: 0, w: width, h: floorY }, {
    seed: seed + 3,
    color: palette.wall,
    alpha: 0.95,
    downscale: 10,
  });
  watercolorWash(ctx, { x: 0, y: floorY * 0.35, w: width, h: floorY * 0.65 }, {
    seed: seed + 4,
    color: palette.wallLit,
    alpha: 0.5,
    downscale: 10,
    feather: 0.35,
  });

  // 地板
  watercolorWash(ctx, { x: 0, y: floorY, w: width, h: height - floorY }, {
    seed: seed + 5,
    color: palette.floor,
    alpha: 0.9,
    downscale: 8,
  });

  // 踢脚线
  ctx.save();
  ctx.globalAlpha = 0.5;
  roughLine(ctx, 0, floorY, width, floorY, {
    seed: seed + 6,
    segments: 26,
    wobble: 1.4,
    color: palette.line,
    width: 2.4,
    alpha: 0.5,
  });
  ctx.restore();

  // 地板木纹：几条透视线
  ctx.save();
  ctx.globalAlpha = 0.12;
  const rng = new SeededRandom(seed + 7);
  for (let i = 0; i < 9; i++) {
    const x0 = rng.next() * width;
    ctx.strokeStyle = palette.shadow;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, floorY);
    ctx.lineTo(x0 + (x0 - width / 2) * 0.5, height);
    ctx.stroke();
  }
  ctx.restore();
}

/** 墙上挂着的一个小相框——给墙面一点信息，避免大片空白 */
export function drawWallFrame(
  ctx: CanvasRenderingContext2D,
  options: { x: number; y: number; w: number; h: number; palette: PaletteColors; seed: number },
): void {
  const { x, y, w, h, palette, seed } = options;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = mix(palette.wood, palette.wallLit, 0.4);
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = mix(palette.sky, palette.wall, 0.5);
  ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
  roughLine(ctx, x, y, x + w, y, { seed: seed + 1, segments: 8, wobble: 0.9, color: palette.line, width: 2, alpha: 0.5 });
  roughLine(ctx, x, y + h, x + w, y + h, { seed: seed + 2, segments: 8, wobble: 0.9, color: palette.line, width: 2, alpha: 0.5 });
  roughLine(ctx, x, y, x, y + h, { seed: seed + 3, segments: 8, wobble: 0.9, color: palette.line, width: 2, alpha: 0.5 });
  roughLine(ctx, x + w, y, x + w, y + h, { seed: seed + 4, segments: 8, wobble: 0.9, color: palette.line, width: 2, alpha: 0.5 });
  ctx.restore();
}

/** 供未知环境兜底：至少不要是黑屏 */
export function drawFallbackEnvironment(
  ctx: CanvasRenderingContext2D,
  options: { width: number; height: number; palette: PaletteColors; seed: number },
): void {
  const { width, height, palette, seed } = options;
  watercolorWash(ctx, { x: 0, y: 0, w: width, h: height }, {
    seed: seed + 11,
    color: palette.wall,
    alpha: 0.9,
    downscale: 12,
  });
  // 一个大的水彩色块，至少保证「有东西」而不是纯色
  const pts = wobblyEllipsePoints({
    seed: seed + 12,
    cx: width / 2,
    cy: height / 2,
    rx: width * 0.34,
    ry: height * 0.22,
    wobble: 0.1,
    points: 36,
  });
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = palette.accent;
  traceSmoothClosed(ctx, pts);
  ctx.fill();
  ctx.restore();
  void noise2D;
}
