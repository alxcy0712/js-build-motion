import type { CanvasRenderingContext2D } from 'skia-canvas';
import type { Environment, ResolvedScene } from '../../spec/types.ts';
import type { PaletteColors } from '../styles/palette.ts';
import { drawFootage, type FrameSource } from '../../footage/clip.ts';
import { drawThemeStage } from './theme-stage.ts';
import { drawMotionStage } from './motion-stage.ts';

export interface SceneRenderContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly palette: PaletteColors;
  readonly scene: ResolvedScene;
  /** 整片时间（秒） */
  readonly time: number;
  /** 本场景内的局部时间（秒，从 0 开始） */
  readonly sceneTime: number;
  /** 整片进度 0..1 */
  readonly progress: number;
  readonly seed: number;
  /** 当前（品牌锁定后的）风格 token */
  readonly theme?: import('../../themes/types.ts').ThemeTokens;
  /** 下一镜头带风格转场：本镜头文字不退场，由转场带走 */
  readonly textHold?: boolean;
  /** Current pass: handoff is the noText base; entering/leaving are composited scene layers. */
  readonly transitionPhase?: 'entering' | 'stable' | 'leaving' | 'handoff';
  readonly transitionProgress?: number;
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

/** 素材片段镜头：素材缺失时画中性灰底并标注，而不是抛错中断整片。 */
function drawFootageScene(c: SceneRenderContext): void {
  const clip = c.scene.footage;
  if (!clip || !c.footage) { c.ctx.fillStyle = '#202020'; c.ctx.fillRect(0, 0, c.width, c.height); return; }
  drawFootage(c.ctx, clip, c.footage, c.sceneTime, Math.max(0.001, c.scene.end - c.scene.start), c.width, c.height);
}

export const SCENE_RENDERERS: Readonly<Record<Environment, SceneRenderer>> = {
  motion_stage: drawMotionStage, theme_stage: drawThemeStage, footage: drawFootageScene,
};
export const IMPLEMENTED_ENVIRONMENTS = Object.keys(SCENE_RENDERERS) as Environment[];
export function getSceneRenderer(environment: Environment): SceneRenderer { return SCENE_RENDERERS[environment]; }
