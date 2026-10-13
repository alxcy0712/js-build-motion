/** 风格层的纯时间运动原语：cubic-bezier 求值与弹簧过冲分析（弹簧求值复用 animation/spring.ts）。 */
import { spring } from '../animation/spring.ts';
import type { Bezier, SpringParams } from './types.ts';

export function cubicBezier([x1, y1, x2, y2]: Bezier): (x: number) => number {
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      const cx = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3 - x;
      const d = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
      if (Math.abs(cx) < 1e-7 || Math.abs(d) < 1e-9) break;
      t = Math.min(1, Math.max(0, t - cx / d));
    }
    return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  };
}
export function dampingRatio({ stiffness, damping, mass = 1 }: SpringParams): number {
  return damping / (2 * Math.sqrt(stiffness * mass));
}
/** 单位阶跃响应的峰值过冲比例（解析式），ζ≥1 为 0。 */
export function springOvershoot(p: SpringParams): number {
  const z = dampingRatio(p);
  return z >= 1 ? 0 : Math.exp(-z * Math.PI / Math.sqrt(1 - z * z));
}
/** 进入 2% 误差带所需时间的保守估计（秒），用于检查 hold 是否足够。 */
export function springSettle(p: SpringParams): number {
  const z = dampingRatio(p), w = Math.sqrt(p.stiffness / (p.mass ?? 1));
  return z >= 1 ? (4 * z) / w + 3 / w : 4 / (z * w);
}
export function evalSpring(t: number, p: SpringParams): number {
  return spring(t, { stiffness: p.stiffness, damping: p.damping, mass: p.mass ?? 1 });
}
export function bezierOvershoots([, y1, , y2]: Bezier): boolean {
  return y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1;
}
export function isLinear([x1, y1, x2, y2]: Bezier): boolean {
  return Math.abs(x1 - y1) < 1e-3 && Math.abs(x2 - y2) < 1e-3;
}
