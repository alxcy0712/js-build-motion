/**
 * 素材片段的类型与结构校验（纯逻辑，不加载 skia / ffmpeg，可在 validate 阶段使用）。
 */
import { extname, isAbsolute } from 'node:path';
import type { CubicBezierTuple } from '../motion/camera-path.ts';
import type { FocusRect } from '../motion/focus.ts';

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] as const;

export interface KenBurnsPose { readonly x: number; readonly y: number; readonly zoom: number }
export interface ColorGrade {
  /** 曝光（档），-1..1 */
  readonly exposure?: number;
  /** 对比度倍数，0.5..1.5 */
  readonly contrast?: number;
  /** 饱和度倍数，0..2 */
  readonly saturation?: number;
  /** 色温，-1（冷）..1（暖） */
  readonly temperature?: number;
  /** 暗角强度 0..1 */
  readonly vignette?: number;
}
export interface FootageClip {
  /** 相对 assetRoot 的路径 */
  readonly src: string;
  /** 视频入点（源素材秒数） */
  readonly in?: number;
  /** 播放速度，0.25..4；<1 为慢放 */
  readonly speed?: number;
  readonly fit?: 'cover' | 'contain';
  /** 源画面的裁切矩形（归一化） */
  readonly crop?: FocusRect;
  /** 推拉摇：镜头起止时的注视点（裁切后画面内归一化坐标）与放大倍数 */
  readonly kenBurns?: { readonly from: KenBurnsPose; readonly to: KenBurnsPose; readonly ease?: CubicBezierTuple };
  readonly color?: ColorGrade;
}
export type FootageKind = 'image' | 'video';
export function footageKind(src: string): FootageKind | null {
  const e = extname(src).toLowerCase();
  if ((IMAGE_EXT as readonly string[]).includes(e)) return 'image';
  if ((VIDEO_EXT as readonly string[]).includes(e)) return 'video';
  return null;
}

export interface ClipIssue { readonly code: string; readonly path: string; readonly message: string }
/** 结构校验（不触盘）。路径存在性在渲染器创建时检查。 */
export function parseFootageClip(raw: unknown, at: string): { value?: FootageClip; issues: ClipIssue[] } {
  const issues: ClipIssue[] = [];
  const bad = (code: string, p: string, m: string) => issues.push({ code, path: p, message: m });
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) { bad('FOOTAGE_INVALID', at, 'footage 须为对象 { src, ... }'); return { issues }; }
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (typeof o.src !== 'string' || !o.src) bad('FOOTAGE_SRC_REQUIRED', `${at}.src`, 'footage.src 必填（相对素材根目录）');
  else if (isAbsolute(o.src) || o.src.split(/[\\/]/).includes('..')) bad('FOOTAGE_PATH_OUTSIDE_ROOT', `${at}.src`, 'src 须为素材根目录内的相对路径');
  else if (!footageKind(o.src)) bad('FOOTAGE_TYPE_UNSUPPORTED', `${at}.src`, `仅支持 ${[...IMAGE_EXT, ...VIDEO_EXT].join(' ')}`);
  if (o.in !== undefined && !num(o.in, 0, 86400)) bad('FOOTAGE_RANGE', `${at}.in`, 'in 须为 ≥ 0 的秒数');
  if (o.speed !== undefined && !num(o.speed, 0.25, 4)) bad('FOOTAGE_RANGE', `${at}.speed`, 'speed 须在 [0.25, 4]');
  if (o.fit !== undefined && o.fit !== 'cover' && o.fit !== 'contain') bad('FOOTAGE_RANGE', `${at}.fit`, "fit 须为 'cover' 或 'contain'");
  if (o.crop !== undefined) {
    const c = o.crop as Record<string, number>;
    if (!c || !num(c.x, 0, 1) || !num(c.y, 0, 1) || !num(c.w, 0.05, 1) || !num(c.h, 0.05, 1) || c.x + c.w > 1.001 || c.y + c.h > 1.001) bad('FOOTAGE_RANGE', `${at}.crop`, 'crop 须为画面内的归一化矩形（w/h ≥ 0.05）');
  }
  if (o.kenBurns !== undefined) {
    const k = o.kenBurns as Record<string, Record<string, number>>;
    const pose = (p: Record<string, number> | undefined) => !!p && num(p.x, 0, 1) && num(p.y, 0, 1) && num(p.zoom, 0.5, 4);
    if (!k || !pose(k.from) || !pose(k.to)) bad('FOOTAGE_RANGE', `${at}.kenBurns`, 'kenBurns 须为 { from:{x,y,zoom}, to:{x,y,zoom} }，x/y ∈ [0,1]，zoom ∈ [0.5,4]');
  }
  if (o.color !== undefined) {
    const c = (o.color ?? {}) as Record<string, unknown>;
    const lim: Record<string, [number, number]> = { exposure: [-1, 1], contrast: [0.5, 1.5], saturation: [0, 2], temperature: [-1, 1], vignette: [0, 1] };
    for (const [k, v] of Object.entries(c)) {
      const l = lim[k];
      if (!l) bad('FOOTAGE_COLOR_UNKNOWN', `${at}.color.${k}`, `未知调色参数 ${k}`);
      else if (!num(v, l[0], l[1])) bad('FOOTAGE_RANGE', `${at}.color.${k}`, `${k} 须在 [${l[0]}, ${l[1]}]`);
    }
  }
  if (issues.length) return { issues };
  return { value: o as unknown as FootageClip, issues };
}
