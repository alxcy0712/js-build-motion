/**
 * 生成角色片段 → 透明帧序列（抠像一次、渲染时按帧读取），以及按槽位变速 + 帧混合取帧。
 *
 * 输出目录：f000000.png … + meta.json（尺寸、fps、帧数、键色、全片角色包围盒）。
 * 输出放仓库根 output/ 或本片 out/，不提交。ffmpeg / ffprobe 需在 PATH 中。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas, Image, ImageData } from 'skia-canvas';
import { keyBackground, unionBBox, type KeyOptions, type Rgb } from './key.ts';
import { blendIndex, mixRgba, planRetime, retimeAt, type RetimeOptions, type RetimePlan } from './composite.ts';

export interface KeyedClipMeta {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frames: number;
  /** 最后一帧的起点（秒）= (frames − 1) / fps，贴槽时作为片段长度 */
  readonly duration: number;
  readonly key: Rgb;
  /** 全片 alpha 包围盒 [x0, y0, x1, y1)；用于尺寸匹配与锚点 */
  readonly bbox: readonly [number, number, number, number] | null;
}

export function probeVideo(path: string): { width: number; height: number; fps: number } {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`FOOTAGE_PROBE_FAILED: ${path}: ${r.stderr}`);
  const [w, h, rate] = r.stdout.trim().split(',');
  const [num, den] = (rate ?? '0/1').split('/').map(Number);
  const fps = (num ?? 0) / (den || 1);
  if (!(Number(w) > 0 && Number(h) > 0 && fps > 0)) throw new Error(`FOOTAGE_PROBE_FAILED: ${path}: ${r.stdout}`);
  return { width: Number(w), height: Number(h), fps };
}

export function rgbaToPng(rgba: Uint8ClampedArray, w: number, h: number): Buffer {
  const c = new Canvas(w, h); c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  return c.toBufferSync('png');
}

/** 逐帧流式解码 → 抠像 → 写 PNG；返回 meta。 */
export async function keyVideoToFrames(path: string, outDir: string, options: KeyOptions = {}): Promise<KeyedClipMeta> {
  const { width: w, height: h, fps } = probeVideo(path);
  mkdirSync(outDir, { recursive: true });
  const size = w * h * 4;
  const proc = spawn('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  let pending = Buffer.alloc(0), n = 0, bbox: KeyedClipMeta['bbox'] = null, key: Rgb | null = null;
  for await (const chunk of proc.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= size) {
      const frame = new Uint8ClampedArray(pending.subarray(0, size));
      pending = pending.subarray(size);
      // 键色在首帧确定后固定，避免逐帧 'auto' 漂移
      const r = keyBackground(frame, w, h, key ? { ...options, key } : options);
      key = r.key; bbox = unionBBox(bbox, r.bbox);
      writeFileSync(join(outDir, `f${String(n).padStart(6, '0')}.png`), rgbaToPng(r.rgba, w, h));
      n++;
    }
  }
  const code: number = await new Promise((res) => proc.on('close', res));
  if (code !== 0 || n === 0) throw new Error(`FOOTAGE_DECODE_FAILED: ${path}: ${err}`);
  const meta: KeyedClipMeta = { version: 1, width: w, height: h, fps, frames: n, duration: (n - 1) / fps, key: key!, bbox };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  return meta;
}

export interface KeyedClip {
  readonly meta: KeyedClipMeta;
  readonly plan: RetimePlan;
  /** 槽位内时间 → 合成好的透明帧（已按 blend 混合相邻帧） */
  frameAt(slotTime: number): Canvas;
}

/** 打开已抠像的帧序列并贴到 slot 秒的槽位上。blend=true 时输出帧率高于源帧率也平滑。 */
export function openKeyedClip(dir: string, slot: number, o: RetimeOptions & { readonly blend?: boolean } = {}): KeyedClip {
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) throw new Error(`FOOTAGE_NOT_KEYED: ${dir} 缺少 meta.json`);
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as KeyedClipMeta;
  const plan = planRetime(slot, Math.max(1 / meta.fps, meta.duration), o);
  const cache = new Map<number, Uint8ClampedArray>();
  const pixels = (i: number): Uint8ClampedArray => {
    let p = cache.get(i);
    if (!p) {
      const img = new Image(); img.src = readFileSync(join(dir, `f${String(i).padStart(6, '0')}.png`));
      const c = new Canvas(meta.width, meta.height), g = c.getContext('2d'); g.drawImage(img, 0, 0);
      p = new Uint8ClampedArray(g.getImageData(0, 0, meta.width, meta.height).data);
      cache.set(i, p); if (cache.size > 6) cache.delete(cache.keys().next().value!);
    }
    return p;
  };
  const canvas = new Canvas(meta.width, meta.height), ctx = canvas.getContext('2d');
  return {
    meta, plan,
    frameAt(slotTime) {
      const { a, b, w } = blendIndex(retimeAt(plan, slotTime), meta.fps, meta.frames);
      const data = o.blend === false || w === 0 ? pixels(a) : mixRgba(pixels(a), pixels(b), w);
      ctx.putImageData(new ImageData(new Uint8ClampedArray(data), meta.width, meta.height), 0, 0);
      return canvas;
    },
  };
}
