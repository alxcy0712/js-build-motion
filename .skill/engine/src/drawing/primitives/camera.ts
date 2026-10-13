/**
 * 镜头运动（L0 原语层，需求 §9、§12）。
 *
 * 关键约束：镜头必须**由 frameIndex 直接决定**，不能是「每帧累加一点点」。
 * 累加式实现会让任意帧渲染失效（§5），并且长时间会有浮点漂移（§6）。
 *
 * cameraFor 保留轻幅预设；applyCameraPose 提供本片焦点、尺度与分层运镜。
 */

import type { CameraMove } from '../../spec/types.ts';
import { smootherstep, clamp01 } from '../../animation/easing.ts';

export interface CameraState {
  /** 缩放系数。恒 >= 1，避免露出画布外的空白 */
  readonly scale: number;
  /** 平移量（像素，已按缩放后坐标系计） */
  readonly offsetX: number;
  readonly offsetY: number;
}

export const IDENTITY_CAMERA: CameraState = { scale: 1, offsetX: 0, offsetY: 0 };

/** 轻幅预设的缩放量；逐镜构图可使用 applyCameraPose。 */
const PUSH_MAX = 0.08;
/**
 * 平移与俯仰的最大偏移（像素）。
 * 竖屏画面高度是宽度的 1.78 倍，同样的像素在竖直方向显得更小，
 * 所以俯仰比横摇多给 10px，两者的视觉幅度才一致。
 */
const PAN_OFFSET = 30, TILT_OFFSET = 40;

/**
 * 根据镜头运动与整片进度计算变换。
 *
 * @param progress 0..1 的归一化进度（通常来自 normalizedProgress(frameIndex, totalFrames)）
 */
export function cameraFor(move: CameraMove, progress: number): CameraState {
  const t = clamp01(progress);
  // 用 smootherstep：缓慢的镜头运动最忌讳「起步和收尾有折角」
  const eased = smootherstep(0, 1, t);

  switch (move) {
    case 'slow_push':
      return { scale: 1 + PUSH_MAX * eased, offsetX: 0, offsetY: 0 };
    case 'slow_pull':
      return { scale: 1 + PUSH_MAX * (1 - eased), offsetX: 0, offsetY: 0 };
    case 'pan_left':
      return { scale: 1 + PUSH_MAX, offsetX: PAN_OFFSET * (1 - eased), offsetY: 0 };
    case 'pan_right':
      return { scale: 1 + PUSH_MAX, offsetX: -PAN_OFFSET * eased, offsetY: 0 };
    case 'tilt_up':
      return { scale: 1 + PUSH_MAX, offsetX: 0, offsetY: TILT_OFFSET * (1 - eased) };
    case 'tilt_down':
      return { scale: 1 + PUSH_MAX, offsetX: 0, offsetY: -TILT_OFFSET * eased };
    case 'static':
    default:
      return IDENTITY_CAMERA;
  }
}

/**
 * 应用镜头变换。调用方负责 save/restore 之外的一切。
 *
 * 变换顺序：平移到中心 → 缩放 → 平移回原点 + 偏移。
 * 这样缩放是围绕画面中心进行的，符合观众对「推镜」的预期。
 */
export function applyCamera(
  ctx: { translate(x: number, y: number): void; scale(sx: number, sy: number): void },
  camera: CameraState,
  width: number,
  height: number,
): void {
  ctx.translate(width / 2 + camera.offsetX, height / 2 + camera.offsetY);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-width / 2, -height / 2);
}

export interface CameraPose {
  /** Camera focus in the same logical coordinates as the scene. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  /** Camera angle in radians. */
  readonly rotation?: number;
}

/**
 * Focus maps to the viewport center at parallax=1. Use 0 for a fixed overlay,
 * <1 for distant layers and >1 for foreground layers. This is a 2D transform.
 * Caller owns save/restore and draws linked objects with the same parallax.
 */
export function applyCameraPose(
  ctx: { translate(x: number, y: number): void; scale(x: number, y: number): void; rotate(angle: number): void },
  pose: CameraPose,
  width: number,
  height: number,
  parallax = 1,
): void {
  const rotation = pose.rotation ?? 0;
  const zoom = 1 + (pose.zoom - 1) * parallax;
  if (![pose.x, pose.y, pose.zoom, rotation, width, height, parallax, zoom].every(Number.isFinite) ||
    pose.zoom <= 0 || zoom <= 0 || width <= 0 || height <= 0 || parallax < 0) {
    throw new Error('CAMERA_POSE: finite coordinates, positive zoom/viewport and nonnegative parallax required');
  }
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-rotation * parallax);
  ctx.scale(zoom, zoom);
  ctx.translate(-width / 2 - (pose.x - width / 2) * parallax, -height / 2 - (pose.y - height / 2) * parallax);
}
