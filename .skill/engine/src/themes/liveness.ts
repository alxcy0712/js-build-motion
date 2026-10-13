/**
 * 镜头微运动（防死帧）：给定镜头内时间，返回相机/视差/扫光/沸腾的连续状态。纯 seek(t)。
 * drift 用指数趋近：任意时刻导数 > 0，永远不会“到点停住”；视差为正弦漂移；扫光为周期相位。
 */
import type { Orientation, ThemeTokens } from './types.ts';

export interface MicroMotion { scale: number; offsetX: number; offsetY: number; sweepPhase: number; boilFrame: number }

export function microMotionAt(theme: ThemeTokens, t: number): MicroMotion {
  const L = theme.liveness, d = theme.treatments.drift;
  const has = (k: string) => (L.layers as readonly string[]).includes(k);
  const tau = d.seconds / 3; // 约 d.seconds 内完成 95% 推进，之后继续缓慢逼近
  const scale = has('drift') ? 1 + (d.scaleTo - 1) * (1 - Math.exp(-Math.max(0, t) / tau)) + (d.scaleTo - 1) * 0.15 * Math.max(0, t) / (d.seconds * 4) : 1;
  const w = (2 * Math.PI) / L.parallaxPeriod;
  const offsetX = has('parallax') ? L.parallaxAmplitudePx * Math.sin(w * t) : 0;
  const offsetY = has('parallax') ? L.parallaxAmplitudePx * 0.5 * Math.cos(w * t) : 0; // 椭圆轨道：速度恒不为 0
  const sweepPhase = has('lightSweep') && L.lightSweep ? (t / L.lightSweep.period) % 1 : 0;
  const boilFrame = has('boil') ? Math.floor(t / (theme.durations['boil'] ?? 0.125)) % 3 : 0;
  return { scale, offsetX, offsetY, sweepPhase, boilFrame };
}

/** 画面角点位移（参考像素）：把 scale 与平移变换作用到画面角点后的位移量。 */
export function cornerDisplacement(a: MicroMotion, b: MicroMotion, orientation: Orientation = 'vertical'): number {
  const [w, h] = orientation === 'vertical' ? [1080, 1920] : [1920, 1080];
  // 取四角与中心的最大位移：缩放与平移在某一角可能抵消，但不会在所有参考点同时抵消
  let best = 0;
  for (const [px, py] of [[0, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    const dx = (b.scale - a.scale) * (px * w / 2) + (b.offsetX - a.offsetX);
    const dy = (b.scale - a.scale) * (py * h / 2) + (b.offsetY - a.offsetY);
    best = Math.max(best, Math.hypot(dx, dy));
  }
  const boil = a.boilFrame !== b.boilFrame ? 1.5 : 0; // 沸腾换帧视为至少 1.5px 的笔触变化
  return Math.max(best, boil);
}

/** 在 [0, seconds] 内按 maxStillSeconds 滑窗检查，返回最小窗口位移。 */
export function minWindowMotion(theme: ThemeTokens, seconds = 20, step = 1 / 60): number {
  const win = theme.liveness.maxStillSeconds;
  let min = Infinity;
  for (let t = 0; t + win <= seconds; t += step) {
    // 窗口内任意两点的最大位移 ≥ 端点位移；取端点与中点的最大值作为窗口内运动量
    const a = microMotionAt(theme, t), m = microMotionAt(theme, t + win / 2), b = microMotionAt(theme, t + win);
    min = Math.min(min, Math.max(cornerDisplacement(a, b), cornerDisplacement(a, m), cornerDisplacement(m, b)));
  }
  return min;
}
