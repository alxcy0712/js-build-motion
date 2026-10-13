/**
 * 时间轴基础（需求 §6、§14）。
 *
 * 核心约束：帧与时间的换算是**纯函数**，不做累加。
 *
 *   time = frameIndex / fps          ✅ 任意帧直接可算，无累积误差
 *   time += 1 / fps                  ❌ 长视频会漂移，且无法随机访问
 */

/** 视频时间轴的静态描述 */
export interface TimelineDescription {
  readonly fps: number;
  readonly durationSeconds: number;
}

/**
 * 总帧数。
 *
 * 用 Math.round 而不是 Math.floor：duration 通常由人写成整数秒或 1 位小数，
 * 例如 8.0s @24fps = 192 帧。浮点误差会让 8.0*24 变成 191.99999，floor 会少一帧。
 */
export function frameCount(fps: number, durationSeconds: number): number {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 必须为正有限数，收到 ${fps}`);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`durationSeconds 必须为非负有限数，收到 ${durationSeconds}`);
  }
  return Math.round(fps * durationSeconds);
}

/**
 * 帧号 → 秒。
 * 注意这是「第 frameIndex 帧的起始时刻」，第 0 帧始终是 0 秒。
 */
export function frameToSeconds(frameIndex: number, fps: number): number {
  return frameIndex / fps;
}

/** 秒 → 帧号（向下取整：落在某一帧内部的时刻属于该帧） */
export function secondsToFrame(seconds: number, fps: number): number {
  return Math.floor(seconds * fps);
}

/**
 * 归一化进度 [0,1]，用于「整片进度」驱动的动画（如缓慢推镜）。
 * totalFrames <= 1 时返回 0，避免除零。
 */
export function normalizedProgress(frameIndex: number, totalFrames: number): number {
  if (totalFrames <= 1) return 0;
  return frameIndex / (totalFrames - 1);
}

/**
 * 场景内局部进度 [0,1]。
 * 场景时间轴统一用「场景起始帧 + 持续帧数」表示，避免秒与帧混用。
 */
export function sceneProgress(
  frameIndex: number,
  startFrame: number,
  durationFrames: number,
): number {
  if (durationFrames <= 1) return 0;
  const local = frameIndex - startFrame;
  if (local <= 0) return 0;
  if (local >= durationFrames - 1) return 1;
  return local / (durationFrames - 1);
}
