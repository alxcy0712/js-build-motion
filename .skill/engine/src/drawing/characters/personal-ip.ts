/**
 * 个人 IP 角色（assets/personal-ip）在风格镜头中的绘制：使用官方 puppet 运行时（呼吸、眨眼、表情），
 * 再按风格加轮廓光/辉光/底部渐隐或贴纸描边。图像同步解码并缓存，渲染保持纯 seek(t)。
 */
import { Canvas, Image, type CanvasRenderingContext2D } from 'skia-canvas';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../../utils/env.ts';
import type { ThemeTokens } from '../../themes/types.ts';

/**
 * 资产目录定位：$JBM_PERSONAL_IP（显式）→ 从引擎根目录逐级向上寻找 assets/personal-ip。
 * 不写死层级：引擎被复制进项目运行时（projects/<slug>/...）时同样可用；找不到则 IP 层静默跳过。
 */
export function findPersonalIPRoot(start = PROJECT_ROOT, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.JBM_PERSONAL_IP) return existsSync(join(env.JBM_PERSONAL_IP, 'rig.json')) ? resolve(env.JBM_PERSONAL_IP) : null;
  let d = resolve(start);
  for (let i = 0; i < 8; i++) {
    const c = join(d, 'assets', 'personal-ip');
    if (existsSync(join(c, 'rig.json')) && existsSync(join(c, 'puppet.mjs'))) return c;
    const up = dirname(d); if (up === d) break; d = up;
  }
  return null;
}
export const IP_ROOT = findPersonalIPRoot();
type DrawFn = (ctx: unknown, images: unknown, rig: unknown, opts: unknown) => void;
const drawFns = new Map<string, DrawFn | null>();
/** puppet 运行时按需同步加载（Node ≥ 22 支持 require(ESM)），模块加载期不再依赖固定相对路径。 */
function puppetDraw(root: string): DrawFn | null {
  if (!drawFns.has(root)) {
    try { drawFns.set(root, (createRequire(import.meta.url)(join(root, 'puppet.mjs')) as { drawPersonalIP: DrawFn }).drawPersonalIP); }
    catch { drawFns.set(root, null); }
  }
  return drawFns.get(root)!;
}
/**
 * 绑定素材实测分辨率（逻辑 256 方形）：head/body 512px（2×）、眉/颊/嘴 2× 密度，眼睛图集 128px/格（1×）。
 * 使用规则：IP 是小幅美术，不当主视觉放大；显示边长封顶为源尺寸 512（推荐 256–384）。
 */
export const IP_SOURCE_PX = 512;
export const IP_MAX_DISPLAY = 512;
const LAYERS = ['base', 'body', 'mouths', 'blink', 'eyes', 'brows', 'cheeks', 'restMouths'] as const;

interface LoadedIP { rig: Record<string, unknown> & { width: number; height: number }; images: Record<string, Image> }
interface IPAssets { root: string }
const cache = new Map<string, (IPAssets & LoadedIP) | null>();
export function loadPersonalIP(root: string | null = IP_ROOT): (IPAssets & LoadedIP) | null {
  if (!root) return null;
  if (cache.has(root)) return cache.get(root)!;
  let cached: (IPAssets & LoadedIP) | null;
  try {
    const rig = JSON.parse(readFileSync(join(root, 'rig.json'), 'utf8'));
    const images: Record<string, Image> = {};
    for (const k of LAYERS) {
      if (typeof rig[k] !== 'string') continue;
      const img = new Image(); img.src = readFileSync(join(root, rig[k])); images[k] = img;
    }
    cached = { root, rig, images };
  } catch { cached = null; }
  cache.set(root, cached);
  return cached;
}

export interface IPDrawOptions {
  readonly time: number;      // 镜头内时间：驱动呼吸/眨眼
  readonly cx: number;        // 角色水平中心
  readonly bottom: number;    // 角色底边（落在底部安全区上沿）
  readonly size: number;      // 绘制边长（rig 为 256 逻辑像素的方形）
  readonly expression?: string;
  readonly opacity?: number;
}

const layerCache = new Map<number, { fig: Canvas; fx: Canvas }>();
function scratch(size: number) {
  const s = Math.ceil(size * 1.4);
  let hit = layerCache.get(s);
  if (!hit) { hit = { fig: new Canvas(s, s), fx: new Canvas(s, s) }; layerCache.set(s, hit); }
  return { ...hit, s };
}
function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 返回是否绘制成功（资产缺失时返回 false，调用方可告警）。 */
export function drawThemedIP(ctx: CanvasRenderingContext2D, theme: ThemeTokens, o: IPDrawOptions): boolean {
  const ip = loadPersonalIP(); if (!ip) return false;
  const { fig, fx, s } = scratch(o.size);
  const pad = (s - o.size) / 2;
  const fc = fig.getContext('2d'); fc.clearRect(0, 0, s, s); fc.imageSmoothingEnabled = true; fc.imageSmoothingQuality = 'high';
  // 轻微漂浮：与呼吸不同相位，保证停留段也有可见微运动
  const float = Math.sin(o.time * 2 * Math.PI / 5.2) * o.size * 0.006;
  const drawPersonalIP = puppetDraw(ip.root); if (!drawPersonalIP) return false;
  drawPersonalIP(fc, ip.images, ip.rig, { time: o.time, x: pad, y: pad + float, size: o.size, expression: o.expression ?? 'neutral', blink: true, motion: true });
  // 底部渐隐：肩颈在画面中自然消失，不出现硬切边
  fc.save(); fc.globalCompositeOperation = 'destination-in';
  // 只在卫衣下沿 36px（1080 宽参考）内渐隐，保留完整肩部
  const fadePx = 36 * o.size / 560;
  const fade = fc.createLinearGradient(0, pad + o.size - fadePx - 4, 0, pad + o.size - 4);
  fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
  fc.fillStyle = fade; fc.fillRect(0, 0, s, s); fc.restore();
  const x = o.cx - s / 2, y = o.bottom - pad - o.size;
  const xc = fx.getContext('2d');
  const silhouette = (color: string, blur: number) => {
    xc.clearRect(0, 0, s, s); xc.save(); xc.drawImage(fig, 0, 0);
    xc.globalCompositeOperation = 'source-in'; xc.fillStyle = color; xc.fillRect(0, 0, s, s); xc.restore();
    return blur;
  };
  ctx.save(); ctx.globalAlpha = o.opacity ?? 1;
  // 背后柔光
  const glowA = Math.max(0.12, theme.treatments.glow.opacity * 0.6);
  const g = ctx.createRadialGradient(o.cx, y + pad + o.size * 0.45, 0, o.cx, y + pad + o.size * 0.45, o.size * 0.75);
  g.addColorStop(0, hexToRgba(theme.palette.accent, glowA * 0.5)); g.addColorStop(1, hexToRgba(theme.palette.accent, 0));
  ctx.fillStyle = g; ctx.fillRect(o.cx - o.size, y, o.size * 2, s);
  // 轮廓光：着色剪影模糊后垫在人物下方，边缘露出一圈光
  const rim = theme.id === 'kinetic' ? theme.palette.accent : '#FFE2B0';
  // 轮廓光：清晰的着色剪影按 3px 外扩垫在人物下方（不叠加模糊），只露出一圈细边
  silhouette(rim, 0);
  ctx.save(); ctx.globalAlpha = (o.opacity ?? 1) * (theme.id === 'kinetic' ? 0.8 : 0.45);
  for (const [dx, dy] of [[0, -3], [-2.5, -1.5], [2.5, -1.5]] as const) ctx.drawImage(fx, x + dx, y + dy);
  ctx.restore();
  if (theme.id === 'kinetic') { // 洋红色差描边（清晰、右下偏移）
    silhouette(theme.palette['accent2'] ?? theme.palette.accent, 0);
    ctx.save(); ctx.globalAlpha = (o.opacity ?? 1) * 0.45; ctx.drawImage(fx, x + 3, y + 1.5); ctx.restore();
  }
  ctx.drawImage(fig, Math.round(x), Math.round(y)); // 人物主体整像素落位：1:1 区域不再二次重采样
  ctx.restore();
  return true;
}
