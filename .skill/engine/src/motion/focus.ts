/**
 * 元素焦点（归一化矩形）。用于 zoomIntoElement 转场「钻进」上一镜头里的某个元素，
 * 也可作为 cameraPath 的推镜目标。x / y 为矩形左上角，w / h 为宽高，均以画面宽高为 1。
 */
export interface FocusRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface PixelPoint { readonly x: number; readonly y: number }

export const DEFAULT_FOCUS: FocusRect = { x: 0.4, y: 0.42, w: 0.2, h: 0.1 };

export function focusCenter(f: FocusRect, width: number, height: number): PixelPoint {
  return { x: (f.x + f.w / 2) * width, y: (f.y + f.h / 2) * height };
}
/** 让元素充满画面（取宽高中较紧的一边）所需的放大倍数，限制在 [1, maxZoom]。 */
export function zoomToFill(f: FocusRect, fill = 0.9, maxZoom = 8): number {
  const z = fill / Math.max(f.w, f.h, 1e-3);
  return Math.min(maxZoom, Math.max(1, z));
}
export function parseFocus(raw: unknown): FocusRect | string | undefined {
  if (raw === undefined) return undefined;
  const o = raw as Record<string, unknown> | null;
  const ok = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if (!o || typeof o !== 'object' || !ok(o.x, 0, 1) || !ok(o.y, 0, 1) || !ok(o.w, 0.01, 1) || !ok(o.h, 0.01, 1)) return 'focus 须为 { x, y, w, h }，均为 0–1 的归一化值（w/h ≥ 0.01）';
  if ((o.x as number) + (o.w as number) > 1.001 || (o.y as number) + (o.h as number) > 1.001) return 'focus 矩形超出画面';
  return { x: o.x as number, y: o.y as number, w: o.w as number, h: o.h as number };
}
