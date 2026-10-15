/**
 * 纯色 / 灰底 / 白底背景抠像（纯函数，RGBA 字节数组进出，不依赖 skia / ffmpeg）。
 *
 * 用途：生成视频里的角色动作片段、生图返回的白底主体图，背景是平涂单色时转成透明层，再由代码合成。
 *
 * 算法（距离键 + 连通性）：
 *   1. 候选背景：与键色的通道最大差 < tolerance；可选「中性色规则」把低饱和、足够亮的像素（白底上的灰阴影）也算候选。
 *   2. 只把与画面边框连通的候选当背景（泛洪），所以主体内部与键色相近的深色衣物、白色衬衫不会被抠穿。
 *   3. 被主体围住的封闭候选区（手臂与身体之间）面积足够且接近平涂时同样当背景。
 *   4. 前景蒙版收缩 choke 像素（去键色描边），再高斯羽化 feather 像素；alpha < 0.02 置零。
 *   5. 去溢色：半透明边缘按 c = (c − (1 − a)·key) / a 反混合，去掉掺进来的背景色。
 */

export type Rgb = readonly [number, number, number];

export interface KeyOptions {
  /** 键色；'auto' 取边框像素的逐通道中位数 */
  readonly key?: Rgb | 'auto';
  /** 通道最大差阈值（0–255），默认 11：适合压缩后的平涂灰底 */
  readonly tolerance?: number;
  /** 中性色规则：色度（max−min）< neutralChroma 且亮度 ≥ minLuma 的像素也算候选背景。白底主体图用来去掉灰阴影 */
  readonly neutralChroma?: number;
  readonly minLuma?: number;
  /** 封闭候选区按背景处理的最小面积（像素）与最大平均键距；pocketMinArea ≤ 0 关闭 */
  readonly pocketMinArea?: number;
  readonly pocketMaxMeanDistance?: number;
  /** 前景收缩像素，默认 1 */
  readonly choke?: number;
  /** 羽化高斯 σ（像素），默认 0.7 */
  readonly feather?: number;
  /** 去溢色，默认 true */
  readonly despill?: boolean;
}

/** 平涂深灰底（生成视频常用）与白底（生图常用）两组起始参数；实际阈值按素材复核。 */
export const FLAT_BACKDROP: KeyOptions = { key: 'auto', tolerance: 11, pocketMinArea: 120, pocketMaxMeanDistance: 5, choke: 1, feather: 0.7 };
export const WHITE_BACKDROP: KeyOptions = { key: [255, 255, 255], tolerance: 24, neutralChroma: 14, minLuma: 150, pocketMinArea: 120, pocketMaxMeanDistance: 12, choke: 1, feather: 0.9 };

export interface KeyResult {
  readonly rgba: Uint8ClampedArray;
  readonly key: Rgb;
  /** alpha > 0.05 的包围盒 [x0, y0, x1, y1)（半开）；全透明时为 null */
  readonly bbox: readonly [number, number, number, number] | null;
}

export function borderMedian(rgba: ArrayLike<number>, w: number, h: number): Rgb {
  const ch: number[][] = [[], [], []];
  const push = (x: number, y: number) => { const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ch[c]!.push(rgba[i + c] as number); };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { push(0, y); push(w - 1, y); }
  const med = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1] ?? 0; };
  return [med(ch[0]!), med(ch[1]!), med(ch[2]!)];
}

/** 4 邻接泛洪：把 mask 中值为 from、与 seeds 连通的像素改成 to，返回改动数。 */
function flood(mask: Uint8Array, w: number, h: number, seeds: number[], from: number, to: number): number {
  const stack = seeds.filter((i) => mask[i] === from);
  for (const i of stack) mask[i] = to;
  let n = stack.length;
  while (stack.length) {
    const i = stack.pop()!; const x = i % w, y = (i - x) / w;
    const visit = (j: number) => { if (mask[j] === from) { mask[j] = to; stack.push(j); n++; } };
    if (x > 0) visit(i - 1); if (x < w - 1) visit(i + 1); if (y > 0) visit(i - w); if (y < h - 1) visit(i + w);
  }
  return n;
}

function erode(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 1;
    for (let dy = -1; dy <= 1 && m > 0; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      const v = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : (src[yy * w + xx] as number);
      if (v < m) m = v;
    }
    out[y * w + x] = m;
  }
  return out;
}

function gaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src;
  const r = Math.max(1, Math.ceil(sigma * 3)); const k: number[] = []; let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  for (let i = 0; i < k.length; i++) k[i] = (k[i] as number) / s;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -r; i <= r; i++) a += (src[y * w + Math.min(w - 1, Math.max(0, x + i))] as number) * (k[i + r] as number);
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -r; i <= r; i++) a += (tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] as number) * (k[i + r] as number);
    out[y * w + x] = a;
  }
  return out;
}

export function alphaBBox(rgba: ArrayLike<number>, w: number, h: number, threshold = 0.05): [number, number, number, number] | null {
  const t = threshold * 255; let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((rgba[(y * w + x) * 4 + 3] as number) > t) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** 抠像。输入为不透明 RGBA（alpha 通道忽略），返回新的 RGBA。 */
export function keyBackground(rgba: ArrayLike<number>, w: number, h: number, options: KeyOptions = {}): KeyResult {
  const o = { ...FLAT_BACKDROP, ...options };
  const key: Rgb = o.key === 'auto' || o.key === undefined ? borderMedian(rgba, w, h) : o.key;
  const n = w * h, dist = new Float32Array(n), mask = new Uint8Array(n); // mask: 0 前景, 1 候选, 2 背景
  const tol = o.tolerance ?? 11;
  for (let p = 0; p < n; p++) {
    const i = p * 4, r = rgba[i] as number, g = rgba[i + 1] as number, b = rgba[i + 2] as number;
    const d = Math.max(Math.abs(r - key[0]), Math.abs(g - key[1]), Math.abs(b - key[2]));
    dist[p] = d;
    let cand = d < tol;
    if (!cand && o.neutralChroma !== undefined) {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      cand = mx - mn < o.neutralChroma && (0.299 * r + 0.587 * g + 0.114 * b) >= (o.minLuma ?? 0);
    }
    mask[p] = cand ? 1 : 0;
  }
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  flood(mask, w, h, border, 1, 2);
  if ((o.pocketMinArea ?? 0) > 0) {
    for (let p = 0; p < n; p++) if (mask[p] === 1) {
      // 标记该连通区为 3，统计面积与平均键距
      const region: number[] = []; const stack = [p]; mask[p] = 3;
      while (stack.length) {
        const i = stack.pop()!; region.push(i); const x = i % w, y = (i - x) / w;
        const visit = (j: number) => { if (mask[j] === 1) { mask[j] = 3; stack.push(j); } };
        if (x > 0) visit(i - 1); if (x < w - 1) visit(i + 1); if (y > 0) visit(i - w); if (y < h - 1) visit(i + w);
      }
      let sum = 0; for (const i of region) sum += dist[i] as number;
      const isBg = region.length > (o.pocketMinArea as number) && sum / region.length < (o.pocketMaxMeanDistance ?? 5);
      for (const i of region) mask[i] = isBg ? 2 : 0;
    }
  }
  let fg = new Float32Array(n);
  for (let p = 0; p < n; p++) fg[p] = mask[p] === 2 ? 0 : 1;
  for (let c = 0; c < (o.choke ?? 1); c++) fg = erode(fg, w, h);
  const a = gaussian(fg, w, h, o.feather ?? 0.7);
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    let al = a[p] as number; if (al < 0.02) al = 0; if (al > 1) al = 1;
    const i = p * 4;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c] as number;
      out[i + c] = (o.despill ?? true) && al > 0 && al < 0.98 ? (v - (1 - al) * (key[c] as number)) / Math.max(al, 0.25) : v;
    }
    out[i + 3] = Math.round(al * 255);
  }
  return { rgba: out, key, bbox: alphaBBox(out, w, h) };
}

/** 两个包围盒的并集（半开），任一为 null 时返回另一个。 */
export function unionBBox(a: readonly [number, number, number, number] | null, b: readonly [number, number, number, number] | null): [number, number, number, number] | null {
  if (!a) return b ? [...b] as [number, number, number, number] : null;
  if (!b) return [...a] as [number, number, number, number];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
