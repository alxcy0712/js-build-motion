import { loadImage, type CanvasRenderingContext2D } from 'skia-canvas';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preflightOcrImage } from './ocr-raster.ts';
import { DEFAULT_OCR_LIMITS } from '../project/ocr.ts';
import { validateAssetUsage, type AssetUsage, type AssetConsumptionReceipt } from '../project/asset-plan.ts';
import { readAssetFile, type PreparedAssetPlan, type AssetBinding } from '../application/asset-plan.ts';
import type { AssetPort, AssetDrawTarget, PreparedAssetImage, PreparedAssetVideo } from '../ports/assets.ts';

/** Fixed images and frame reads, with receipts emitted only after successful operations. */
export function createAssetPort(projectDir: string, prepared: PreparedAssetPlan | null, execution: { attemptId: string; inputSnapshotSha256: string; runDir?: string }) {
  const receipts: AssetConsumptionReceipt[] = [], close: (() => void)[] = [];
  const verify: (() => Promise<void>)[] = [];
  const images = new Map<string, PreparedAssetImage>(), videos = new Map<string, PreparedAssetVideo>();
  let retainedBytes = 0, closed = false;
  const binding = (useId: string): AssetBinding => {
    if (closed) throw Error('ASSET_PORT_CLOSED');
    const found = prepared?.bindings.find(b => b.use.useId === useId); if (!found) throw Error('ASSET_USE_UNKNOWN: ' + useId); return found;
  };
  const record = (b: AssetBinding, operation: AssetConsumptionReceipt['operation'], frame: number | null = null,
    selected?: AssetConsumptionReceipt['selected']) => {
    if (closed) throw Error('ASSET_PORT_CLOSED');
    if (receipts.length >= 100000) throw Error('ASSET_RECEIPT_LIMIT');
    const u = b.use;
    receipts.push({ useId: u.useId, needId: u.needId, shotId: u.shotId, role: u.role, catalogId: u.catalogId,
      catalogManifestSha256: u.catalogManifestSha256, assetId: u.assetId, assetVersion: u.assetVersion, byteSha256: u.byteSha256,
      source: { path: b.asset.source.fixedPath, bytes: b.asset.source.bytes, sha256: u.byteSha256 },
      selected: selected ? { path: selected.path, bytes: selected.bytes, sha256: selected.sha256 } : (b.video ? { path: b.video.canonical.path, bytes: b.video.canonical.bytes, sha256: b.video.canonical.sha256 }
        : { path: b.asset.source.fixedPath, bytes: b.asset.source.bytes, sha256: u.byteSha256 }),
      derivedMap: u.selection.kind === 'video' ? { ...u.selection.map } : null, operation, frame,
      sourcePts: frame === null ? null : b.video!.frames[frame]!.sourcePts });
  };
  const bytes = async (b: AssetBinding) => {
    const selected = b.video ? b.video.canonical : { path: b.asset.source.fixedPath, bytes: b.asset.source.bytes, sha256: b.use.byteSha256 };
    return (await readAssetFile(projectDir, selected.path, 268435456, selected)).data;
  };
  const reserve = (amount: number) => {
    if (retainedBytes + amount > 268435456) throw Error(`ASSET_PORT_MEMORY_LIMIT: required=${retainedBytes + amount} bytes; budget=268435456 bytes. Use assets.video for frame reads, or prepare the active shot's assets in a smaller render segment.`);
    retainedBytes += amount;
  };
  const targetValid = (target: AssetDrawTarget) => {
    if (!Object.values(target).every(Number.isFinite) || target.width <= 0 || target.height <= 0) throw Error('ASSET_DRAW_TARGET_INVALID');
  };
  const port: AssetPort = {
    async read(useId) { const b = binding(useId); reserve(b.video?.canonical.bytes ?? b.asset.source.bytes);
      const data = await bytes(b); record(b, 'prepared-read'); return data; },
    async image(useId) {
      const b = binding(useId); if (b.video || b.use.role !== 'visual') throw Error('ASSET_IMAGE_USE_INVALID');
      if (images.has(useId)) return images.get(useId)!;
      if (!['png_pipe', 'jpeg_pipe'].includes(b.asset.technical.format)) throw Error('ASSET_IMAGE_FORMAT_UNSUPPORTED');
      const data = await bytes(b), production = prepared!.plan.version === '0.2';
      let header;
      try { header = preflightOcrImage(data, b.asset.technical.format, production ? { ...DEFAULT_OCR_LIMITS,
        maxOcrSourceBytes: Math.min(b.catalog.policy.maxSourceBytes, 268435456),
        maxOcrSourcePixels: Math.min(b.catalog.policy.maxSourcePixels, 67108864), maxOcrEdge: 67108864,
        maxOcrRasterBytes: 201326720 } : DEFAULT_OCR_LIMITS); }
      catch (e) {
        if (production && e instanceof Error && /^OCR_(?:SOURCE|PIXEL|EDGE|RASTER|STRUCTURE)_LIMIT/.test(e.message))
          throw Error(`ASSET_IMAGE_RESOURCE_LIMIT: ${e.message}; source=${b.asset.source.bytes} bytes; catalog pixel budget=${b.catalog.policy.maxSourcePixels}; resident budget=268435456 bytes. Prepare a delivery-size image derivative and retain the original, or adopt a larger catalog pixel budget within the resident budget.`);
        throw e;
      }
      reserve(header.width * header.height * 4 + (production ? data.length : 0)); const image = await loadImage(data);
      if (image.width !== header.width || image.height !== header.height) throw Error('ASSET_IMAGE_DECODE_INVALID');
      const handle: PreparedAssetImage = Object.freeze({ width: header.width, height: header.height, draw(context: CanvasRenderingContext2D, target: AssetDrawTarget) {
        binding(useId); targetValid(target);
        const crop = b.use.crop ?? { x: 0, y: 0, width: 1, height: 1 };
        let sx = crop.x * image.width, sy = crop.y * image.height, sw = crop.width * image.width, sh = crop.height * image.height;
        let dx = target.x, dy = target.y, dw = target.width, dh = target.height;
        const sourceAspect = sw / sh, targetAspect = dw / dh;
        if (b.use.fit === 'contain') { if (sourceAspect > targetAspect) { dh = dw / sourceAspect; dy += (target.height - dh) / 2; }
          else { dw = dh * sourceAspect; dx += (target.width - dw) / 2; } }
        else if (sourceAspect > targetAspect) { const width = sh * targetAspect; sx += (sw - width) / 2; sw = width; }
        else { const height = sw / targetAspect; sy += (sh - height) / 2; sh = height; }
        context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh); record(b, 'image-draw');
      } });
      images.set(useId, handle); record(b, 'prepared-read'); return handle;
    },
    async video(useId, profile = 'final') {
      const b = binding(useId); if (!b.video || b.use.role !== 'visual') throw Error('ASSET_VIDEO_USE_INVALID');
      const key = `${useId}:${profile}`, selected = profile === 'rough' ? b.video.proxy : b.video.canonical;
      if (videos.has(key)) return videos.get(key)!;
      const width = profile === 'rough' && b.video.version === '0.2' ? b.video.proxy.width : b.video.canonical.width;
      const height = profile === 'rough' && b.video.version === '0.2' ? b.video.proxy.height : b.video.canonical.height;
      reserve(profile === 'rough' || b.video.version === '0.2' ? width * height * 8 : b.video.canonical.bytes);
      const { openPreparedVideoFrames } = await import('./video-frames.ts');
      const opened = await openPreparedVideoFrames(projectDir, b.video, profile, run => {
        if (execution.runDir) writeFileSync(join(execution.runDir, `proxy-decode-${useId}.json`), JSON.stringify({ useId, profile,
          proxy: { path: b.video!.proxy.path, bytes: b.video!.proxy.bytes, sha256: b.video!.proxy.sha256 }, decodeRun: run }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      }); close.push(() => opened.close()); verify.push(() => opened.verify());
      const handle: PreparedAssetVideo = Object.freeze({ width, height,
        frames: b.video.canonical.frames, fps: b.video.canonical.fps,
        frame(index: number) { binding(useId); const data = opened.frame(index); record(b, 'frame-access', index, selected); return data; },
        draw(context: CanvasRenderingContext2D, index: number, target: AssetDrawTarget) {
          binding(useId); targetValid(target); opened.draw(context, index, target, b.use.fit, b.use.crop); record(b, 'video-draw', index, selected);
        } });
      videos.set(key, handle); record(b, 'prepared-read', null, selected); return handle;
    },
  };
  return { port: Object.freeze(port), async verify() { if (closed) throw Error('ASSET_PORT_CLOSED'); for (const check of verify) await check(); },
    usage(completeBuiltin = false): AssetUsage { return validateAssetUsage({ version: '0.1', kind: 'asset-usage',
    attemptId: execution.attemptId, inputSnapshotSha256: execution.inputSnapshotSha256,
    plan: prepared ? { ...prepared.identity } : null, coverage: completeBuiltin && !prepared ? 'complete' : 'partial',
    scope: completeBuiltin && !prepared ? ['builtin-procedural-drawing-and-audio'] : ['asset-port-read', 'asset-port-image-draw', 'asset-port-frame-access', 'asset-port-video-draw'],
    unknownRemainder: completeBuiltin && !prepared ? [] : ['Dynamic IO outside AssetPort and final pixel visibility are unobserved.'],
    receipts: structuredClone(receipts), gaps: prepared ? structuredClone(prepared.gaps) : [] }); },
    close() { if (closed) return; closed = true; for (const release of close) release(); images.clear(); videos.clear(); } };
}
