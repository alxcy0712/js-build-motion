/**
 * 素材片段层（剪辑已有素材）：图片或视频 → 裁切 → 推拉摇（ken-burns）→ 变速 → 调色 → 暗角。
 *
 * - 纯 seek(t)：任意帧由「镜头内时间」唯一决定；视频先经 ffmpeg 一次性抽成帧序列并缓存，
 *   渲染时按帧号同步读取，避免与编码管线并发解码。
 * - 安全：src 只能指向 assetRoot 之内、扩展名白名单内的文件（拒绝 .. 越界与符号链接逃逸）。
 * - 缓存目录在本片输出区的 .cache/footage，键 = 源文件路径 + 修改时间 + 抽帧参数。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Image, type CanvasRenderingContext2D } from 'skia-canvas';
import { applyCameraPose } from '../drawing/primitives/camera.ts';
import { evaluateCameraPath } from '../motion/camera-path.ts';
import { footageKind, IMAGE_EXT, VIDEO_EXT, type ColorGrade, type FootageClip } from './spec.ts';
export * from './spec.ts';
import { outputPath } from '../utils/output-dir.ts';

/** 把 src 解析为 assetRoot 内的真实路径；越界、缺失或类型不支持时抛错。 */
export function resolveFootagePath(src: string, assetRoot: string): string {
  if (isAbsolute(src) || src.split(/[\\/]/).includes('..')) throw new Error(`FOOTAGE_PATH_OUTSIDE_ROOT: ${src} 须为 assetRoot 内的相对路径`);
  if (!footageKind(src)) throw new Error(`FOOTAGE_TYPE_UNSUPPORTED: ${src}（支持 ${[...IMAGE_EXT, ...VIDEO_EXT].join(' ')}）`);
  const abs = resolve(assetRoot, src);
  if (!existsSync(abs)) throw new Error(`FOOTAGE_NOT_FOUND: ${abs}`);
  const real = realpathSync(abs), rootReal = realpathSync(assetRoot);
  const rel = relative(rootReal, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`FOOTAGE_PATH_OUTSIDE_ROOT: ${src} 经符号链接指向 assetRoot 之外`);
  return real;
}

/** 帧序列提供者：给定镜头内时间返回一张图（同步）。 */
export interface FrameSource { readonly width: number; readonly height: number; frameAt(sceneTime: number): Image }

function loadImage(path: string): Image { const img = new Image(); img.src = readFileSync(path); return img; }

export function imageSource(path: string): FrameSource {
  const img = loadImage(path);
  return { width: img.width, height: img.height, frameAt: () => img };
}

export interface ExtractOptions { readonly fps: number; readonly duration: number; readonly in?: number; readonly speed?: number; readonly maxEdge?: number; readonly cacheDir?: string }
/**
 * 用 ffmpeg 把 [in, in + duration × speed] 抽成 fps 帧/秒（输出时间）的 JPEG 序列。已存在则直接复用。
 * 返回帧目录与帧数。ffmpeg 需在 PATH 中（与编码器一致）。
 */
export function extractVideoFrames(path: string, o: ExtractOptions): { dir: string; count: number } {
  const speed = o.speed ?? 1, start = o.in ?? 0, maxEdge = o.maxEdge ?? 2880;
  const st = statSync(path);
  const key = createHash('sha1').update(JSON.stringify([path, st.size, st.mtimeMs, start, speed, o.duration, o.fps, maxEdge])).digest('hex').slice(0, 16);
  const dir = join(o.cacheDir ?? outputPath('.cache', 'footage'), key);
  const done = join(dir, '.complete');
  if (!existsSync(done)) {
    mkdirSync(dir, { recursive: true });
    const vf = `fps=${(o.fps / speed).toFixed(6)},scale='min(${maxEdge},iw)':-2:flags=lanczos`;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-i', path, '-t', String(o.duration * speed + 1 / o.fps), '-vf', vf, '-q:v', '2', join(dir, 'f%06d.jpg')], { encoding: 'utf8' });
    if (r.error || r.status !== 0) throw new Error(`FOOTAGE_DECODE_FAILED: ${path}: ${r.error?.message ?? r.stderr}`);
    writeFileSync(done, '');
  }
  const count = readdirSync(dir).filter((n) => n.endsWith('.jpg')).length;
  if (count === 0) throw new Error(`FOOTAGE_EMPTY: ${path} 在入点 ${start}s 之后没有可用画面`);
  return { dir, count };
}

export function videoSource(path: string, o: ExtractOptions): FrameSource {
  const { dir, count } = extractVideoFrames(path, o);
  const lru = new Map<number, Image>();
  const get = (i: number): Image => {
    const k = Math.max(0, Math.min(count - 1, i));
    let img = lru.get(k);
    if (!img) { img = loadImage(join(dir, `f${String(k + 1).padStart(6, '0')}.jpg`)); lru.set(k, img); if (lru.size > 4) lru.delete(lru.keys().next().value!); }
    return img;
  };
  const first = get(0);
  // 帧号由时间直接算出（四舍五入到最近帧，加 1e-6 防止 29.9999 落到上一帧）
  return { width: first.width, height: first.height, frameAt: (t) => get(Math.floor(t * o.fps + 1e-6)) };
}

export function openFootage(clip: FootageClip, assetRoot: string, fps: number, duration: number, cacheDir?: string): FrameSource {
  const path = resolveFootagePath(clip.src, assetRoot);
  return footageKind(path) === 'image' ? imageSource(path)
    : videoSource(path, { fps, duration, ...(clip.in !== undefined ? { in: clip.in } : {}), ...(clip.speed !== undefined ? { speed: clip.speed } : {}), ...(cacheDir ? { cacheDir } : {}) });
}

/** CSS filter 字符串（曝光以档计：+1 档 = 亮度 ×2）。 */
export function gradeFilter(c: ColorGrade = {}): string {
  const parts: string[] = [];
  if (c.exposure) parts.push(`brightness(${Math.pow(2, c.exposure).toFixed(4)})`);
  if (c.contrast !== undefined && c.contrast !== 1) parts.push(`contrast(${c.contrast.toFixed(4)})`);
  if (c.saturation !== undefined && c.saturation !== 1) parts.push(`saturate(${c.saturation.toFixed(4)})`);
  return parts.join(' ');
}

/**
 * 绘制一帧素材。sceneTime ∈ [0, duration]。
 * 推拉摇复用相机路径求值（同一套缓动与对数缩放），cover 模式下 zoom < 1 会被抬到 1，保证不露底。
 */
export function drawFootage(ctx: CanvasRenderingContext2D, clip: FootageClip, source: FrameSource, sceneTime: number, duration: number, width: number, height: number): void {
  const crop = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const sw = source.width * crop.w, sh = source.height * crop.h;
  const fit = clip.fit ?? 'cover';
  const base = fit === 'cover' ? Math.max(width / sw, height / sh) : Math.min(width / sw, height / sh);
  const dw = sw * base, dh = sh * base, dx = (width - dw) / 2, dy = (height - dh) / 2;
  const kb = clip.kenBurns;
  ctx.save();
  if (fit === 'contain') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height); }
  if (kb) {
    const pose = evaluateCameraPath({ keys: [{ t: 0, ...kb.from }, { t: duration, ...kb.to, ...(kb.ease ? { ease: kb.ease } : {}) }] }, sceneTime, 1, 1);
    const zoom = fit === 'cover' ? Math.max(1, pose.zoom) : pose.zoom;
    // 注视点从「裁切后画面」坐标映射到画布像素；cover 时把注视点夹在不露底的范围内
    let fx = dx + pose.x * dw, fy = dy + pose.y * dh;
    if (fit === 'cover') {
      const hx = width / (2 * zoom), hy = height / (2 * zoom);
      fx = Math.min(dx + dw - hx, Math.max(dx + hx, fx)); fy = Math.min(dy + dh - hy, Math.max(dy + hy, fy));
    }
    applyCameraPose(ctx, { x: fx, y: fy, zoom }, width, height);
  }
  const filter = gradeFilter(clip.color);
  if (filter) ctx.filter = filter;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source.frameAt(sceneTime), crop.x * source.width, crop.y * source.height, sw, sh, dx, dy, dw, dh);
  ctx.restore();
  const temp = clip.color?.temperature ?? 0;
  if (temp) {
    ctx.save(); ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = Math.min(1, Math.abs(temp)) * 0.45;
    ctx.fillStyle = temp > 0 ? '#ff9a3c' : '#3c8cff'; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
  const vig = clip.color?.vignette ?? 0;
  if (vig > 0) {
    ctx.save();
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.hypot(width, height) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${(0.65 * Math.min(1, vig)).toFixed(3)})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, width, height); ctx.restore();
  }
}

