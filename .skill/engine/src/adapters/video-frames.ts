import { Canvas, ImageData, type CanvasRenderingContext2D } from 'skia-canvas';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readSync, writeSync, rmSync, statfsSync, fstatSync, lstatSync, type BigIntStats } from 'node:fs';
import { validatePreparedVideoMap, type PreparedVideoMap, type ProductionPreparedVideoMap } from '../project/video-preparation.ts';
import { fitImage, type ImageRect } from '../drawing/primitives/image-fit.ts';
import { NodeImportFiles } from './import-files.ts';
import { readFixed, runInspectionTool } from './inspection.ts';
import { LEGACY_INSPECT_POLICY, type ToolRun } from '../project/catalog.ts';

/** One bounded immutable RGBA snapshot and a hidden single-frame drawing canvas. */
export async function openPreparedVideoFrames(projectDir: string, value: PreparedVideoMap, profile: 'rough' | 'final' = 'final',
  onDecodeRun?: (run: ToolRun) => void): Promise<{
  frame(index: number): Buffer;
  draw(ctx: CanvasRenderingContext2D, index: number, target: ImageRect, fit: 'contain' | 'cover', crop?: ImageRect | null): void;
  close(): void;
  verify(): Promise<void>;
  decodeRun?: ToolRun;
}> {
  const map = structuredClone(validatePreparedVideoMap(value)), files = new NodeImportFiles(projectDir);
  if (profile === 'rough') return openProxyFrames(projectDir, map, onDecodeRun);
  if (map.version === '0.2') return openProductionFrames(projectDir, map);
  const path = files.projectPath(join(projectDir, map.canonical.path)), fixed = await readFixed(path, map.limits.maxRgbaBytes);
  if (fixed.bytes !== map.canonical.bytes || fixed.sha256 !== map.canonical.sha256) throw Error('VIDEO_CANONICAL_CHANGED');
  const { width, height, frames } = map.canonical, bytes = width * height * 4;
  const canvas = new Canvas(width, height), context = canvas.getContext('2d'); let rgba: Buffer | null = fixed.data;
  for (let i = 0; i < frames; i++) if (createHash('sha256').update(rgba.subarray(i * bytes, (i + 1) * bytes)).digest('hex') !== map.frames[i]!.rgbaSha256) throw Error('VIDEO_FRAME_CHANGED');
  function source(index: number): Buffer {
    if (!rgba) throw Error('VIDEO_FRAMES_CLOSED');
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames) throw Error('VIDEO_FRAME_RANGE_INVALID');
    return rgba.subarray(index * bytes, (index + 1) * bytes);
  }
  return {
    frame: index => Buffer.from(source(index)),
    draw(ctx, index, target, mode, crop) {
      const data = source(index), normalized = crop ?? { x: 0, y: 0, width: 1, height: 1 };
      if (![normalized.x, normalized.y, normalized.width, normalized.height].every(Number.isFinite) || normalized.x < 0 || normalized.y < 0 ||
          normalized.width <= 0 || normalized.height <= 0 || normalized.x + normalized.width > 1 || normalized.y + normalized.height > 1) throw Error('VIDEO_CROP_INVALID');
      const rect = { x: normalized.x * width, y: normalized.y * height, width: normalized.width * width, height: normalized.height * height };
      const fitted = fitImage(rect, target, mode);
      context.putImageData(new ImageData(data, width, height), 0, 0);
      const s = fitted.source, d = fitted.destination;
      ctx.drawImage(canvas, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
    },
    async verify() {
      if (!rgba) throw Error('VIDEO_FRAMES_CLOSED');
      const current = await readFixed(path, map.limits.maxRgbaBytes, undefined, undefined, false);
      if (current.bytes !== map.canonical.bytes || current.sha256 !== map.canonical.sha256) throw Error('VIDEO_CANONICAL_CHANGED');
    },
    close() { rgba = null; },
  };
}

/** One descriptor and one verified private frame; verify the whole source before publishing a render. */
async function openProductionFrames(projectDir: string, map: Pick<ProductionPreparedVideoMap, 'canonical' | 'frames' | 'limits'>) {
  const files = new NodeImportFiles(projectDir), path = files.projectPath(join(projectDir, map.canonical.path));
  const identity = (s: BigIntStats) => [String(s.dev), String(s.ino), String(s.nlink), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
  const original = JSON.stringify(identity(lstatSync(path, { bigint: true })));
  const fixed = await readFixed(path, map.limits.maxRgbaBytes, undefined, undefined, false);
  if (fixed.bytes !== map.canonical.bytes || fixed.sha256 !== map.canonical.sha256) throw Error('VIDEO_CANONICAL_CHANGED');
  const { width, height, frames } = map.canonical, bytes = width * height * 4;
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Buffer | null = null, canvas: Canvas | null = null, context: CanvasRenderingContext2D | null = null, closed = false;
  function unchanged() {
    files.projectPath(path);
    const fd = fstatSync(descriptor, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!fd.isFile() || fd.nlink !== 1n || !named.isFile() || JSON.stringify(identity(fd)) !== original || JSON.stringify(identity(named)) !== original) throw Error('VIDEO_CANONICAL_CHANGED');
  }
  try { unchanged(); data = Buffer.alloc(bytes); canvas = new Canvas(width, height); context = canvas.getContext('2d'); }
  catch (error) { closeSync(descriptor); throw error; }
  function source(index: number): Buffer {
    if (closed || !data) throw Error('VIDEO_FRAMES_CLOSED');
    if (!Number.isSafeInteger(index) || index < 0 || index >= frames) throw Error('VIDEO_FRAME_RANGE_INVALID');
    unchanged(); let offset = 0;
    while (offset < bytes) { const count = readSync(descriptor, data, offset, bytes - offset, index * bytes + offset); if (!count) throw Error('VIDEO_FRAME_CHANGED'); offset += count; }
    unchanged(); if (createHash('sha256').update(data).digest('hex') !== map.frames[index]!.rgbaSha256) throw Error('VIDEO_FRAME_CHANGED'); return data;
  }
  return {
    frame: (index: number) => Buffer.from(source(index)),
    async verify() {
      if (closed || !data) throw Error('VIDEO_FRAMES_CLOSED');
      unchanged(); const digest = createHash('sha256'); let offset = 0;
      while (offset < map.canonical.bytes) {
        const count = readSync(descriptor, data, 0, Math.min(data.length, map.canonical.bytes - offset), offset);
        if (!count) throw Error('VIDEO_CANONICAL_CHANGED'); digest.update(data.subarray(0, count)); offset += count;
      }
      unchanged(); if (digest.digest('hex') !== map.canonical.sha256) throw Error('VIDEO_CANONICAL_CHANGED');
    },
    draw(ctx: CanvasRenderingContext2D, index: number, target: ImageRect, mode: 'contain' | 'cover', crop?: ImageRect | null) {
      const frame = source(index), normalized = crop ?? { x: 0, y: 0, width: 1, height: 1 };
      if (![normalized.x, normalized.y, normalized.width, normalized.height].every(Number.isFinite) || normalized.x < 0 || normalized.y < 0 ||
          normalized.width <= 0 || normalized.height <= 0 || normalized.x + normalized.width > 1 || normalized.y + normalized.height > 1) throw Error('VIDEO_CROP_INVALID');
      const fitted = fitImage({ x: normalized.x * width, y: normalized.y * height, width: normalized.width * width, height: normalized.height * height }, target, mode);
      context!.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.length), width, height), 0, 0); const s = fitted.source, d = fitted.destination;
      ctx.drawImage(canvas!, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
    },
    close() { if (closed) return; closed = true; closeSync(descriptor); data = null; context = null; canvas = null; },
  };
}

/** Decode the fixed preview proxy into a bounded, temporary random-access surface. */
async function openProxyFrames(projectDir: string, map: PreparedVideoMap, onDecodeRun?: (run: ToolRun) => void) {
  const files = new NodeImportFiles(projectDir), proxy = files.projectPath(join(projectDir, map.proxy.path));
  const checkProxy = async () => {
    const fixed = await readFixed(proxy, map.limits.maxProxyBytes, undefined, undefined, false);
    if (fixed.bytes !== map.proxy.bytes || fixed.sha256 !== map.proxy.sha256) throw Error('VIDEO_PROXY_CHANGED');
  };
  await checkProxy();
  const width = map.version === '0.2' ? map.proxy.width : map.canonical.width;
  const height = map.version === '0.2' ? map.proxy.height : map.canonical.height;
  const frameBytes = width * height * 4, bytes = frameBytes * map.canonical.frames;
  if (!Number.isSafeInteger(bytes) || bytes > map.limits.maxRgbaBytes) throw Error(`VIDEO_PROXY_RESOURCE_LIMIT: required=${bytes} bytes; budget=${map.limits.maxRgbaBytes} bytes. Prepare a shorter selected range or render a smaller segment.`);
  const temporary = join(projectDir, 'out/.tmp', `proxy-frames-${randomUUID()}`);
  await files.ensureDirectory(temporary);
  const space = statfsSync(temporary), available = space.bavail * space.bsize, reserve = map.version === '0.2' ? map.limits.minFreeBytes : 0;
  if (bytes + reserve > available) {
    rmSync(temporary, { recursive: true, force: true });
    throw Error(`VIDEO_PROXY_RESOURCE_LIMIT: required=${bytes} bytes; available=${available} bytes; reserve=${reserve} bytes. Free disk space, prepare a shorter selected range, or render a smaller segment.`);
  }
  const path = join(temporary, 'frames.rgba'), descriptor = openSync(path, 'wx', 0o600);
  const hashes: string[] = [], canonicalDigest = createHash('sha256'); let length = 0, inFrame = 0, digest = createHash('sha256'), decodeRun: ToolRun | undefined;
  try {
    const tool = map.runtime.tools.ffmpeg;
    const run = await runInspectionTool({ executable: tool.executable, version: tool.version,
      argv: ['-nostdin', '-v', 'error', '-xerror', '-i', proxy, '-map', '0:v:0', '-an', '-vsync', '0', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
      cwd: temporary, policy: { ...LEGACY_INSPECT_POLICY, maxToolElapsedMs: map.limits.maxToolElapsedMs }, binaryLimit: bytes,
      binary: async chunk => {
        canonicalDigest.update(chunk);
        let written = 0;
        while (written < chunk.length) { const count = writeSync(descriptor, chunk, written, chunk.length - written); if (!count) throw Error('VIDEO_PROXY_WRITE_FAILED'); written += count; }
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(frameBytes - inFrame, chunk.length - offset);
          digest.update(chunk.subarray(offset, offset + count)); offset += count; inFrame += count;
          if (inFrame === frameBytes) { hashes.push(digest.digest('hex')); digest = createHash('sha256'); inFrame = 0; }
        }
        length += chunk.length;
      }, onRun: run => { decodeRun = structuredClone(run); onDecodeRun?.(decodeRun); } });
    if (run.error || run.exitCode !== 0 || run.signal || length !== bytes || inFrame || hashes.length !== map.canonical.frames) throw Error('VIDEO_PROXY_DECODE_INVALID: ' + (run.error ?? run.stderr));
  } catch (error) { closeSync(descriptor); rmSync(temporary, { recursive: true, force: true }); throw error; }
  closeSync(descriptor);
  try {
    await checkProxy();
    const opened = await openProductionFrames(projectDir, { canonical: { ...map.canonical, path: relative(projectDir, path).split('\\').join('/'), width, height, bytes, sha256: canonicalDigest.digest('hex') },
      frames: map.frames.map((frame, i) => ({ ...frame, rgbaSha256: hashes[i]! })),
      limits: map.limits as ProductionPreparedVideoMap['limits'] });
    return { ...opened, decodeRun, async verify() { await opened.verify(); await checkProxy(); },
      close() { opened.close(); rmSync(temporary, { recursive: true, force: true }); } };
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}
