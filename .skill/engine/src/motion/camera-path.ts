/**
 * 关键帧相机路径（镜头内时间驱动，纯 seek(t)）。
 *
 * 坐标约定：x / y 为「镜头注视点」在画面中的归一化位置（0–1，0.5 = 画面中心），
 * zoom 为放大倍数（1 = 原始取景），rotate 为角度（度）。归一化让同一条路径同时适用于竖屏与横屏。
 *
 * 相邻两帧之间按该段 ease 插值（默认使用风格的 camera 缓动），起止都有减速，避免「折角」。
 * 推（push）= zoom 增大；摇（pan）= x 变化；升降（tilt）= y 变化；环绕（orbit）= x 与 rotate 同时变化。
 * 视差：调用 applyCameraPose(ctx, pose, w, h, parallax)；远景 parallax<1，前景 >1，固定叠层为 0。
 */
import type { CameraPose } from '../drawing/primitives/camera.ts';
import { cubicBezier } from '../themes/motion.ts';

export type CubicBezierTuple = readonly [number, number, number, number];
export interface CameraKey {
  /** 镜头内秒数（从本镜头 start 起算） */
  readonly t: number;
  readonly x?: number;
  readonly y?: number;
  readonly zoom?: number;
  readonly rotate?: number;
  /** 从上一关键帧到本帧的缓动；'hold' 表示保持上一帧直到本帧瞬切 */
  readonly ease?: CubicBezierTuple | 'hold';
}
export interface CameraPath { readonly keys: readonly CameraKey[] }

export interface ResolvedKey { t: number; x: number; y: number; zoom: number; rotate: number; ease?: CubicBezierTuple | 'hold' }
/** 默认相机缓动：缓起缓停（与风格未提供 camera 缓动时一致） */
export const DEFAULT_CAMERA_EASE: CubicBezierTuple = [0.65, 0, 0.35, 1];
/**
 * 运镜语法（分镜默认值，数字即规范）：
 * - normal：讲解屏推镜 1.0→1.10–1.15，3–4s
 * - emphasis：强调屏 1.0→1.20–1.30
 * - openingPull：开场 logo/标题反向拉 1.2→1.0
 * - ambient：liveness 的环境漂移地板（≈1.03，由 theme liveness 负责，与这里的作者运镜分开叠加）
 * - punchMax：> 1.5 只允许出现在穿透式转场（zoomIntoElement / scaleThrough）里，不作为镜头内运镜
 */
export const CAMERA_GRAMMAR = {
  normal: { from: 1, to: 1.12, seconds: [3, 4] },
  emphasis: { from: 1, to: 1.25, seconds: [2, 3] },
  openingPull: { from: 1.2, to: 1, seconds: [1.5, 2.5] },
  ambient: 1.03,
  punchMax: 1.5,
} as const;
export type CameraMoveKind = 'normal' | 'emphasis' | 'openingPull';
/** 用数字写运镜：push(1.0, 1.08, 2.4) 即「2.4s 内从 1.0 推到 1.08」。可选注视点 x/y（归一化）。 */
export function push(from: number, to: number, seconds: number, at: { x?: number; y?: number; start?: number } = {}): CameraPath {
  const s = at.start ?? 0, p = { ...(at.x !== undefined ? { x: at.x } : {}), ...(at.y !== undefined ? { y: at.y } : {}) };
  return { keys: [{ t: s, zoom: from, ...p }, { t: s + seconds, zoom: to, ...p }] };
}
/** 语法预设 → 具体路径；时长缺省取区间中值并夹到镜头时长内。 */
export function cameraMove(kind: CameraMoveKind, shotSeconds: number, at: { x?: number; y?: number } = {}): CameraPath {
  const g = CAMERA_GRAMMAR[kind];
  return push(g.from, g.to, Math.min(shotSeconds, (g.seconds[0] + g.seconds[1]) / 2), at);
}
export const CAMERA_LIMITS = { zoomMin: 0.5, zoomMax: 8, rotateMax: 45, maxKeys: 24 } as const;

/** 缺省字段继承上一关键帧（第一帧继承画面中心 / zoom 1 / 0°），并按时间排序。 */
export function resolveKeys(path: CameraPath): ResolvedKey[] {
  const sorted = [...path.keys].sort((a, b) => a.t - b.t);
  const out: ResolvedKey[] = [];
  let prev = { x: 0.5, y: 0.5, zoom: 1, rotate: 0 };
  for (const k of sorted) {
    const r: ResolvedKey = { t: k.t, x: k.x ?? prev.x, y: k.y ?? prev.y, zoom: k.zoom ?? prev.zoom, rotate: k.rotate ?? prev.rotate, ...(k.ease ? { ease: k.ease } : {}) };
    out.push(r); prev = r;
  }
  return out;
}

/**
 * 求 t 时刻的相机姿态（像素坐标）。t 在首帧前取首帧，末帧后取末帧。
 * zoom 在对数空间插值：2→4 与 1→2 的感知速度一致，不会出现「推镜后半段突然加速」。
 */
export function evaluateCameraPath(path: CameraPath, t: number, width: number, height: number, defaultEase: CubicBezierTuple = DEFAULT_CAMERA_EASE): CameraPose {
  const keys = resolveKeys(path);
  if (keys.length === 0) return { x: width / 2, y: height / 2, zoom: 1, rotation: 0 };
  const toPose = (k: Pick<ResolvedKey, 'x' | 'y' | 'zoom' | 'rotate'>): CameraPose => ({ x: k.x * width, y: k.y * height, zoom: k.zoom, rotation: (k.rotate * Math.PI) / 180 });
  if (t <= keys[0]!.t) return toPose(keys[0]!);
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return toPose(last);
  let i = 1; while (keys[i]!.t < t) i++;
  const a = keys[i - 1]!, b = keys[i]!;
  if (b.ease === 'hold') return toPose(a);
  const span = Math.max(1e-6, b.t - a.t);
  const u = cubicBezier(b.ease ?? defaultEase)((t - a.t) / span);
  const lerp = (p: number, q: number) => p + (q - p) * u;
  return toPose({ x: lerp(a.x, b.x), y: lerp(a.y, b.y), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom))), rotate: lerp(a.rotate, b.rotate) });
}

export interface PathIssue { readonly code: string; readonly path: string; readonly message: string; readonly fatal: boolean }
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 校验不可信输入。返回规范化后的路径（无效时为 undefined）与问题列表。 */
export function parseCameraPath(raw: unknown, at: string, shotDuration: number): { value?: CameraPath; issues: PathIssue[] } {
  const issues: PathIssue[] = [];
  const bad = (code: string, path: string, message: string, fatal = true) => issues.push({ code, path, message, fatal });
  if (raw === undefined) return { issues };
  const keysRaw = (raw as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keysRaw) || keysRaw.length < 2) { bad('CAMERA_PATH_INVALID', at, 'cameraPath.keys 须为至少 2 个关键帧的数组'); return { issues }; }
  if (keysRaw.length > CAMERA_LIMITS.maxKeys) bad('CAMERA_PATH_TOO_MANY_KEYS', at, `关键帧最多 ${CAMERA_LIMITS.maxKeys} 个`);
  const keys: CameraKey[] = [];
  keysRaw.slice(0, CAMERA_LIMITS.maxKeys).forEach((k: unknown, i) => {
    const p = `${at}.keys[${i}]`;
    if (typeof k !== 'object' || k === null) return bad('CAMERA_KEY_INVALID', p, '关键帧须为对象');
    const o = k as Record<string, unknown>;
    if (!fin(o.t) || o.t < 0) return bad('CAMERA_KEY_TIME', `${p}.t`, 't 须为 ≥ 0 的秒数');
    if (o.t > shotDuration + 1e-6) bad('CAMERA_KEY_PAST_END', `${p}.t`, `t=${o.t} 超出镜头时长 ${shotDuration.toFixed(2)}s，超出部分不会被看到`, false);
    const key: { -readonly [K in keyof CameraKey]: CameraKey[K] } = { t: o.t };
    for (const f of ['x', 'y'] as const) if (o[f] !== undefined) { if (fin(o[f]) && o[f] >= -0.5 && o[f] <= 1.5) key[f] = o[f]; else bad('CAMERA_KEY_RANGE', `${p}.${f}`, `${f} 为归一化坐标，须在 [-0.5, 1.5]`); }
    if (o.zoom !== undefined) { if (fin(o.zoom) && o.zoom >= CAMERA_LIMITS.zoomMin && o.zoom <= CAMERA_LIMITS.zoomMax) key.zoom = o.zoom; else bad('CAMERA_KEY_RANGE', `${p}.zoom`, `zoom 须在 [${CAMERA_LIMITS.zoomMin}, ${CAMERA_LIMITS.zoomMax}]`); }
    if (o.rotate !== undefined) { if (fin(o.rotate) && Math.abs(o.rotate) <= CAMERA_LIMITS.rotateMax) key.rotate = o.rotate; else bad('CAMERA_KEY_RANGE', `${p}.rotate`, `rotate 须在 ±${CAMERA_LIMITS.rotateMax}°`); }
    if (o.ease !== undefined) {
      if (o.ease === 'hold') key.ease = 'hold';
      else if (Array.isArray(o.ease) && o.ease.length === 4 && o.ease.every(fin) && o.ease[0] >= 0 && o.ease[0] <= 1 && o.ease[2] >= 0 && o.ease[2] <= 1) {
        if (o.ease[0] === o.ease[1] && o.ease[2] === o.ease[3]) bad('CAMERA_EASE_LINEAR', `${p}.ease`, '线性相机运动起止会有折角，建议改用缓入缓出', false);
        key.ease = o.ease as unknown as CubicBezierTuple;
      } else bad('CAMERA_EASE_INVALID', `${p}.ease`, "ease 须为 'hold' 或 cubic-bezier 四元组（x1/x2 ∈ [0,1]）");
    }
    keys.push(key);
  });
  if (keys.some((k) => (k.zoom ?? 1) > CAMERA_GRAMMAR.punchMax)) bad('CAMERA_ZOOM_PUNCH_ONLY', at, `镜头内 zoom > ${CAMERA_GRAMMAR.punchMax} 只应出现在穿透式转场里；讲解推镜 1.0→1.10–1.15，强调 1.0→1.20–1.30`, false);
  if (issues.some((i) => i.fatal)) return { issues };
  return { value: { keys }, issues };
}
