/**
 * 种子化噪声（需求 §7）。
 *
 * 与 `SeededRandom` 的分工：
 *   - 需要「一批离散随机数」→ 用 SeededRandom
 *   - 需要「在空间/时间上连续变化的随机场」→ 用这里的噪声
 *
 * 为什么纹理必须用噪声而不是逐帧随机：
 *   纸纹、颜料颗粒这类东西在视觉上是**空间连续**的随机场。
 *   如果每帧重新 `Math.random()`，同一像素的亮度会逐帧跳变，画面会「沸腾」。
 *   用 `noise2D(x, y, seed)` 则位置固定；需要缓慢变化时用 `noise3D(x, y, 慢速时间, seed)`。
 */

const FNV_OFFSET = 2166136261;

/**
 * 整数哈希 → [0,1)。
 * 全部走 Math.imul / 位运算，保证跨平台逐位一致（不依赖浮点三角函数）。
 */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ FNV_OFFSET) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (z | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 五次平滑：比 smoothstep 的一阶导/二阶导都连续，视觉上无条纹 */
function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 二维值噪声，返回 [0,1) */
export function noise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);

  const v00 = hash3(x0, y0, 0, seed);
  const v10 = hash3(x0 + 1, y0, 0, seed);
  const v01 = hash3(x0, y0 + 1, 0, seed);
  const v11 = hash3(x0 + 1, y0 + 1, 0, seed);

  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/**
 * 三维值噪声，返回 [0,1)。
 *
 * 第三个维度用于**时间**：`noise3D(x, y, t * speed, seed)`。
 * speed 取很小（例如 0.05）时，纹理整体缓慢流动而不闪烁——
 * 适合「湿纸缓慢洇开」这类效果。
 */
export function noise3D(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = quintic(x - x0);
  const fy = quintic(y - y0);
  const fz = quintic(z - z0);

  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x0 + 1, y0, z0, seed);
  const c010 = hash3(x0, y0 + 1, z0, seed);
  const c110 = hash3(x0 + 1, y0 + 1, z0, seed);
  const c001 = hash3(x0, y0, z0 + 1, seed);
  const c101 = hash3(x0 + 1, y0, z0 + 1, seed);
  const c011 = hash3(x0, y0 + 1, z0 + 1, seed);
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1, seed);

  const bottom = lerp(lerp(c000, c100, fx), lerp(c010, c110, fx), fy);
  const top = lerp(lerp(c001, c101, fx), lerp(c011, c111, fx), fy);
  return lerp(bottom, top, fz);
}

export interface FbmOptions {
  readonly octaves?: number;
  readonly lacunarity?: number;
  readonly gain?: number;
}

/** 分形叠加二维噪声。用于山峦轮廓、纸纤维、颜料不均 */
export function fbm2D(x: number, y: number, seed: number, options: FbmOptions = {}): number {
  const { octaves = 4, lacunarity = 2, gain = 0.5 } = options;
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise2D(x * frequency, y * frequency, (seed + i * 0x9e37) >>> 0);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** 分形叠加三维噪声（含时间维度） */
export function fbm3D(
  x: number,
  y: number,
  z: number,
  seed: number,
  options: FbmOptions = {},
): number {
  const { octaves = 4, lacunarity = 2, gain = 0.5 } = options;
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise3D(x * frequency, y * frequency, z * frequency, (seed + i * 0x9e37) >>> 0);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * 一维噪声：给「沿路径的抖动」「雨丝粗细变化」这类场景用。
 * 实现为固定 y 的二维采样，保证与 noise2D 同源。
 */
export function noise1D(x: number, seed: number): number {
  return noise2D(x, 0.5, seed);
}

/** 把噪声值映射到 [min,max] */
export function noiseRange2D(
  x: number,
  y: number,
  seed: number,
  min: number,
  max: number,
): number {
  return min + noise2D(x, y, seed) * (max - min);
}
