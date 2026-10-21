import type { TraceDraw } from '../layout/trace.ts';
/**
 * 构图居中检查：测量一帧画面里「内容」的对比加权重心，与画布中心比较。
 * - 内容 = 亮度高于背景阈值的像素（默认黑底；浅色底传 background: 'light'）。
 * - 颗粒、暗角这类低幅度纹理低于阈值，不计入；角落署名等固定元素用 exclude 矩形排除。
 * - 偏移以画布宽/高的比例表示：offsetX = (内容中心 x − 宽/2) / 宽，正值表示偏右/偏下。
 */
export interface LumaFrame {
  readonly width: number;
  readonly height: number;
  /** 灰度（每像素 1 通道）或 RGBA（每像素 4 通道）。 */
  readonly data: Uint8Array | Uint8ClampedArray;
}
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface CenteringOptions {
  /** 与背景的最小亮度差（0–255），默认 48。 */
  readonly threshold?: number;
  readonly accent?: readonly [number, number, number];
  readonly accentWeight?: number;
  readonly background?: 'dark' | 'light';
  /** 不参与测量的区域（像素坐标），例如角落署名。 */
  readonly exclude?: readonly Rect[];
}
export interface ContentCenter {
  readonly bbox: Rect;
  readonly center: { readonly x: number; readonly y: number };
  readonly offsetX: number;
  readonly offsetY: number;
}

function channelsOf(frame: LumaFrame): 1 | 4 {
  const n = frame.width * frame.height;
  if (frame.data.length === n) return 1;
  if (frame.data.length === n * 4) return 4;
  throw new Error(`CENTERING_FRAME_SIZE: expected ${n} or ${n * 4} bytes, got ${frame.data.length}`);
}

/** 返回内容包围盒与中心偏移；画面里没有内容时返回 null。 */
export function measureContentCenter(frame: LumaFrame, options: CenteringOptions = {}): ContentCenter | null {
  const { width, height, data } = frame;
  const threshold = options.threshold ?? 48;
  const light = options.background === 'light';
  const exclude = options.exclude ?? [];
  const ch = channelsOf(frame);
  let x0 = width, y0 = height, x1 = -1, y1 = -1, mass = 0, mx = 0, my = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      const luma = ch === 1 ? data[i]! : 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      const contrast = (light ? 255 - luma : luma) * (ch === 4 ? data[i + 3]! / 255 : 1);
      if (contrast < threshold) continue;
      if (exclude.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
      const accent = ch === 4 && options.accent && options.accent.every((v, k) => Math.abs(v - data[i + k]!) < 24);
      const weight = contrast * (accent ? options.accentWeight ?? 1.25 : 1);
      mass += weight; mx += (x + .5) * weight; my += (y + .5) * weight;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const cx = mx / mass, cy = my / mass;
  return {
    bbox: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
    center: { x: cx, y: cy },
    offsetX: (cx - width / 2) / width,
    offsetY: (cy - height / 2) / height,
  };
}

/** 水平居中（默认容差 2%）；纵向只在给出 toleranceY 时检查（竖屏常为字幕/平台 UI 让位而略上移）。 */
export function isCentered(m: ContentCenter | null, { toleranceX = 0.02, toleranceY }: { toleranceX?: number; toleranceY?: number } = {}): boolean {
  if (!m) return false;
  return Math.abs(m.offsetX) <= toleranceX && (toleranceY === undefined || Math.abs(m.offsetY) <= toleranceY);
}

/** 内容包围盒是否完全落在安全区内（边距为像素）。 */
export function withinSafeArea(m: ContentCenter, width: number, height: number, safe: { top: number; bottom: number; left: number; right: number }): boolean {
  const b = m.bbox;
  return b.x >= safe.left && b.y >= safe.top && b.x + b.width <= width - safe.right && b.y + b.height <= height - safe.bottom;
}

/** Element model: visible rectangle area × approximate contrast × alpha × accent weight. */
export function measureElementCenter(draws:readonly TraceDraw[],width:number,height:number,accent='#FFC712'):ContentCenter|null {
  let mass=0,mx=0,my=0,x0=width,y0=height,x1=0,y1=0;
  for(const d of draws){
    if(d.alpha<.15||d.protection||['background','decoration','caption'].includes(d.role))continue;
    const b=d.visible;if(b.width<=0||b.height<=0)continue;
    const h=d.color?.match(/^#([0-9a-f]{6})$/i),rgb=d.color?.match(/^rgba?\(([^)]+)\)$/);
    const c=h?[0,2,4].map(i=>parseInt(h[1]!.slice(i,i+2),16)):rgb?rgb[1]!.split(',').slice(0,3).map(Number):null;
    const contrast=c?(.2126*c[0]!+.7152*c[1]!+.0722*c[2]!)/255:.5;
    const weight=b.width*b.height*contrast*d.alpha*(d.color?.toLowerCase()===accent.toLowerCase()?1.25:1);
    mass+=weight;mx+=(b.x+b.width/2)*weight;my+=(b.y+b.height/2)*weight;
    x0=Math.min(x0,b.x);y0=Math.min(y0,b.y);x1=Math.max(x1,b.x+b.width);y1=Math.max(y1,b.y+b.height);
  }
  if(!mass)return null;const x=mx/mass,y=my/mass;
  return {bbox:{x:x0,y:y0,width:x1-x0,height:y1-y0},center:{x,y},offsetX:(x-width/2)/width,offsetY:(y-height/2)/height};
}
export function centerDiagnostic(current:ContentCenter|null,previous:ContentCenter|null,width:number,height:number,settled=true) {
  const jump=current&&previous?Math.hypot(current.center.x-previous.center.x,current.center.y-previous.center.y)/height:null;
  return {status:!current?'coverage':!settled?'transient':Math.abs(current.offsetX)>.06||Math.abs(current.offsetY)>.08||(jump!==null&&jump>.15)?'review':'within-reference',
    center:current,previousJumpHeight:jump,thresholds:{horizontal:.06,vertical:.08,adjacentHeight:.15},
    basis:'diagnostic for settled reading frames; intentional bias, tracking and demonstrations retain content-specific judgment'};
}
