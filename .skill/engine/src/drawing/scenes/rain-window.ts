import { drawFootage, type FrameSource } from '../../footage/clip.ts';
import { drawThemeStage } from './theme-stage.ts';
import { drawMotionStage } from './motion-stage.ts';
/**
 * L3 场景 —— rain_window（需求 §33、§34）。
 *
 * M0 的主场景：夜晚，一位年轻女性站在窗边，看着窗外的雨。
 *
 * 构图（1080x1920 竖屏）：
 *   上 55%  窗户：夜空 + 城市剪影 + 流动雨痕 + 静止水珠
 *   中部    人物：3/4 侧后视，头在 0.30h 附近，背对镜头望向窗外
 *   底部    桌子 + 台灯（暖光）+ 茶杯，压住画面的下半部
 *   全局    纸纹 + 暗角
 *
 * 深度顺序刻意是「室内 → 窗外 → 窗框 → 植物 → 人物 → 桌子 → 纸纹 → 暗角」：
 * 人物在窗框之后、桌子之前，这样她看起来像站在窗边而不是贴在窗上。
 */

import type { CanvasRenderingContext2D } from 'skia-canvas';

import type { Camera, Environment, ResolvedScene } from '../../spec/types.ts';
import type { CharacterDefinition } from '../../spec/types.ts';
import { drawCharacter } from '../characters/character.ts';
import { PaperTexture } from '../art/paper.ts';
import type { PaletteColors } from '../styles/palette.ts';
import { applyStorybookFinish, applyVignette, finishStrengthFor } from '../styles/watercolor-storybook.ts';
import {
  drawChair,
  drawDesk,
  drawFallbackEnvironment,
  drawInterior,
  drawPlant,
  drawWallFrame,
  drawWindowFrame,
  drawWindowOutside,
} from '../objects/window.ts';

// ---------------------------------------------------------------- 取景

/**
 * 取景参数。刻意用「人物占画面高度的比例」而不是绝对像素或缩放倍数——
 * 只有这样，同一份 spec 在 540x960 预览与 1080x1920 终渲下的构图才一致。
 */
export interface Framing {
  /** 头顶位置（占画面高度比例） */
  readonly headTop: number;
  /** 人物总高（占画面高度比例，>1 表示脚超出画面） */
  readonly heightRatio: number;
}

export const CAMERA_FRAMING: Readonly<Record<Camera, Framing>> = {
  wide: { headTop: 0.52, heightRatio: 0.3 },
  medium: { headTop: 0.4, heightRatio: 0.6 },
  // M0 主用取景：头顶在 0.32 高度、人物高占 0.8 → 脚落在 1.12（画面外），
  // 即「腰部以上入画」的中近景。上一版取 0.92 导致人物几乎顶满画面并把窗户全遮住。
  medium_close: { headTop: 0.32, heightRatio: 0.8 },
  close: { headTop: 0.26, heightRatio: 1.3 },
  extreme_close: { headTop: 0.2, heightRatio: 2.1 },
};

/** 人物基准身高（scale=1 时），与 characters/character.ts 的 PROPORTIONS 对应 */
export const BASE_CHARACTER_HEIGHT = 683;

export interface Placement {
  /** 脚底位置（像素）。close 取景下会大于画面高度，即"脚在画面外" */
  readonly feetY: number;
  readonly scale: number;
  readonly x: number;
}

export function computePlacement(
  camera: Camera,
  width: number,
  height: number,
  def: CharacterDefinition | undefined,
  fallbackX = 0.44,
): Placement {
  const f = CAMERA_FRAMING[camera];
  // 头顶在 headTop，脚在 headTop + heightRatio
  const feetY = height * (f.headTop + f.heightRatio);
  const scale = (height * f.heightRatio) / BASE_CHARACTER_HEIGHT;
  const x = width * (def?.x ?? fallbackX);
  return { feetY, scale, x };
}

// ---------------------------------------------------------------- 上下文

export interface SceneRenderContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly palette: PaletteColors;
  readonly scene: ResolvedScene;
  readonly character: CharacterDefinition | undefined;
  /** 整片时间（秒） */
  readonly time: number;
  /** 本场景内的局部时间（秒，从 0 开始） */
  readonly sceneTime: number;
  /** 整片进度 0..1 */
  readonly progress: number;
  readonly seed: number;
  /** 风格预设名，决定收尾强度 */
  readonly stylePreset: string;
  /** 当前（品牌锁定后的）风格 token */
  readonly theme?: import('../../themes/types.ts').ThemeTokens;
  /** 下一镜头带风格转场：本镜头文字不退场，由转场带走 */
  readonly textHold?: boolean;
  /** 本镜头由风格转场带入：文字从第一帧即在位，随转场一起进入 */
  readonly textCarriedIn?: boolean;
  /** 是否为整片第一个镜头 */
  readonly firstShot?: boolean;
  /** 只画背景与 IP、不画文字（溶解转场的公共底层用） */
  readonly noText?: boolean;
  /** environment = footage 时由渲染器预先打开的帧序列 */
  readonly footage?: FrameSource;
}

export type SceneRenderer = (rc: SceneRenderContext) => void;

// ---------------------------------------------------------------- 绘制

/**
 * 夜幕雨窗。
 *
 * 所有随时间变化的量都只用 `time` 与 `sceneTime`，
 * 且都是 `time` 的**直接函数**（没有累加状态），因此任意帧都能独立渲染。
 */
export function drawRainWindow(rc: SceneRenderContext): void {
  const { ctx, width: w, height: h, palette, scene, character, time, sceneTime, seed } = rc;

  // --- 1. 室内底色 ---
  drawInterior(ctx, { width: w, height: h, palette, seed, floorAt: 0.9 });

  // --- 2. 墙上的小相框（左上方，给墙面信息） ---
  drawWallFrame(ctx, {
    x: w * 0.07,
    y: h * 0.06,
    w: w * 0.16,
    h: w * 0.13,
    palette,
    seed: seed + 21,
  });

  // --- 3. 窗户 ---
  const win = {
    x: w * 0.1,
    y: h * 0.09,
    w: w * 0.8,
    h: h * 0.42,
  };
  drawWindowOutside(ctx, { geometry: win, palette, seed: seed + 41, time, intensity: 1 });
  drawWindowFrame(ctx, { geometry: win, palette, seed: seed + 43, time });

  // --- 4. 窗台植物（左边缘，部分出画） ---
  drawPlant(ctx, {
    x: w * 0.035,
    y: h * 0.62,
    scale: (h / 1920) * 1.5,
    palette,
    seed: seed + 61,
    time,
  });

  // --- 5. 人物（在窗之前、桌之后） ---
  if (character) {
    const place = computePlacement(scene.camera, w, h, character, 0.58);
    // 呼吸之外的整身极缓慢起伏：让她"活着"但几乎察觉不到
    const idleLift = Math.sin(time * 0.42) * 1.4;
    drawCharacter(ctx, {
      def: character,
      palette,
      x: place.x,
      y: place.feetY + idleLift,
      scale: place.scale,
      time,
      action: scene.action,
      emotion: scene.emotion,
    });
  }

  // --- 6. 桌子 + 台灯 + 茶杯 ---
  const deskY = h * 0.9;
  drawDesk(ctx, {
    x: w * 0.03,
    y: deskY,
    width: w * 0.94,
    palette,
    seed: seed + 81,
    time,
  });

  // 椅子：右下角，暗示这是她的位置
  drawChair(ctx, {
    x: w * 0.84,
    y: deskY,
    scale: (h / 1920) * 1.05,
    palette,
    seed: seed + 83,
  });

  // --- 7. 窗外的光洒在她身上的效果：在人物区域的右上方加一层冷色光 ----
  if (character) {
    const place = computePlacement(scene.camera, w, h, character, 0.58);
    ctx.save();
    ctx.globalAlpha = 0.1;
    const cool = ctx.createLinearGradient(place.x - w * 0.3, place.feetY - h * 0.6, place.x + w * 0.22, place.feetY);
    cool.addColorStop(0, palette.glass);
    cool.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cool;
    ctx.fillRect(place.x - w * 0.32, place.feetY - h * 0.72, w * 0.6, h * 0.8);
    ctx.restore();
  }

  // --- 8. 风格收尾：颜料不均 + 冷暖分区 + 纸纹 + 纸浆提亮 ---
  // 这一遍覆盖包括人物在内的所有像素，把各个物体"统一到同一张纸上"。
  applyStorybookFinish(ctx, {
    width: w,
    height: h,
    palette,
    seed: seed + 101,
    sceneTime,
    strength: finishStrengthFor(rc.stylePreset),
  });

  // --- 9. 暗角 ---
  applyVignette(ctx, { width: w, height: h, palette, strength: 0.62, centerY: 0.46 });
}

/**
 * 尚未实现的环境——仍然出画面，但明显是占位。
 *
 * 为什么不直接报错：运行到一半才失败对用户最不友好。
 * 为什么不假装实现：那等于把"看起来能用"当成能用。
 * 折中：确定性占位 + 渲染期 WARNING，让问题可见且可继续调试。
 */
export function drawPlaceholderEnvironment(rc: SceneRenderContext): void {
  const { ctx, width: w, height: h, palette, seed, sceneTime } = rc;
  drawFallbackEnvironment(ctx, { width: w, height: h, palette, seed });
  applyStorybookFinish(ctx, { width: w, height: h, palette, seed: seed + 3, sceneTime, strength: 0.4 });
  applyVignette(ctx, { width: w, height: h, palette, strength: 0.5 });
}

/** 素材片段镜头：素材缺失时画中性灰底并标注，而不是抛错中断整片。 */
function drawFootageScene(c: SceneRenderContext): void {
  const clip = c.scene.footage;
  if (!clip || !c.footage) { c.ctx.fillStyle = '#202020'; c.ctx.fillRect(0, 0, c.width, c.height); return; }
  drawFootage(c.ctx, clip, c.footage, c.sceneTime, Math.max(0.001, c.scene.end - c.scene.start), c.width, c.height);
}

// ---------------------------------------------------------------- 注册表

export const SCENE_RENDERERS: Readonly<Record<Environment, SceneRenderer>> = {
  rain_window: drawRainWindow,
  motion_stage: drawMotionStage,
  theme_stage: drawThemeStage,
  footage: drawFootageScene,
  // 以下环境在 M0 阶段尚未实现；词汇表先稳定下来，实现逐步补齐（§40：不做大而全）
  office_night: drawPlaceholderEnvironment,
  bedroom: drawPlaceholderEnvironment,
  city_street: drawPlaceholderEnvironment,
  forest: drawPlaceholderEnvironment,
  mountain: drawPlaceholderEnvironment,
  ocean: drawPlaceholderEnvironment,
  coffee_shop: drawPlaceholderEnvironment,
};

/** 已完整实现的环境清单，供 validate/render 提示 */
export const IMPLEMENTED_ENVIRONMENTS: readonly Environment[] = ['rain_window', 'motion_stage', 'theme_stage', 'footage'];

export function getSceneRenderer(environment: Environment): SceneRenderer {
  return SCENE_RENDERERS[environment] ?? drawPlaceholderEnvironment;
}
