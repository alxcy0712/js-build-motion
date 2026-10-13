import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Canvas } from 'skia-canvas';
import { DEFAULT_VIDEO_PREPARATION_LIMITS, DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, type LegacyPreparedVideoMap, type ProductionPreparedVideoMap } from '../src/project/video-preparation.ts';
import { openPreparedVideoFrames } from '../src/adapters/video-frames.ts';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex'), uuid = '00000000-0000-4000-8000-000000000001';
function fixture(first?: Buffer) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-frames-'))), prefix = `assets/derived/video/${uuid}`;
  const red = first ?? Buffer.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]), blue = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  const rgba = Buffer.concat([red, blue]), limits = { ...DEFAULT_VIDEO_PREPARATION_LIMITS }, tool = { executable: '/fixed/tool', version: 'fixed', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 0, error: null };
  const native = { executable: '/fixed/tool', version: 'fixed', files: [{ path: '/fixed/tool', bytes: 1, sha256: '0'.repeat(64) }], aliases: [{ path: '/fixed/tool', realpath: '/fixed/tool' }] };
  const map: LegacyPreparedVideoMap = { version: '0.1', kind: 'prepared-video-map', mapperVersion: 'video-preparation@0.1', limits, policySha256: hash(JSON.stringify(limits)),
    request: { version: '0.1', kind: 'video-preparation-request', catalogId: `catalog-${uuid}`, catalogManifestSha256: '1'.repeat(64), assetId: `asset-${uuid}`, assetVersion: `asset-version-${uuid}`,
      byteSha256: '0'.repeat(64), streamIndex: 0, fps: 12, sourceRange: { timeBase: '1/12000', startPts: '0', endPts: '2000' } },
    source: { bytes: 1, sha256: '0'.repeat(64) }, runtime: { id: 'bounded-audio-input', version: '0.1', lockSha256: '0'.repeat(64), platform: 'darwin', arch: 'arm64', tools: { ffmpeg: native, ffprobe: native } },
    sourceVideo: { streamIndex: 0, codec: 'h264', timeBase: '1/12000', width: 2, height: 2, pixelFormat: 'yuv420p', rotation: 0,
      sourceFrames: [{ pts: '0', duration: '1000', rgbaSha256: hash(red) }, { pts: '1000', duration: '1000', rgbaSha256: hash(blue) }] },
    canonical: { path: `${prefix}/frames.rgba`, bytes: rgba.length, sha256: hash(rgba), width: 2, height: 2, fps: 12, frames: 2 }, proxy: { path: `${prefix}/proxy.mp4`, bytes: 1, sha256: '0'.repeat(64) },
    frames: [{ sourceIndex: 0, sourcePts: '0', rgbaSha256: hash(red) }, { sourceIndex: 1, sourcePts: '1000', rgbaSha256: hash(blue) }], commands: { probe: tool, decode: tool, encode: tool, proxyProbe: tool }, cwd: '/recorded/cwd',
    coverage: { scope: 'complete-selected-video-frames', complete: true, startPts: '0', endPts: '2000', audio: 'muted' } };
  fs.mkdirSync(join(dir, prefix), { recursive: true }); fs.writeFileSync(join(dir, map.canonical.path), rgba);
  return { dir, map, rgba, red, blue, clean() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
function production(map: LegacyPreparedVideoMap): ProductionPreparedVideoMap {
  const limits = { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS };
  return { ...map, version: '0.2', mapperVersion: 'video-preparation@0.2', limits, policySha256: hash(JSON.stringify(limits)),
    request: { ...map.request, version: '0.2', output: { width: null, height: null }, mute: false },
    sourceVideo: { ...map.sourceVideo, sourceFrameCount: 720, startPts: '0', endPts: '720000' }, sourceAudio: null,
    proxy: { ...map.proxy, width: 2, height: 2 }, audio: null, commands: { ...map.commands, audio: null }, coverage: { ...map.coverage, audio: 'absent' } };
}
test('frame snapshots support bounded first/last, copied repeated reverse access and explicit close', async () => {
  const f = fixture(); try {
    const video = await openPreparedVideoFrames(f.dir, f.map); assert.deepEqual(video.frame(1), f.blue); const first = video.frame(0); first.fill(0);
    assert.deepEqual(video.frame(0), f.red); assert.deepEqual(video.frame(1), f.blue);
    for (const index of [-1, 2, 0.5, NaN, Infinity]) assert.throws(() => video.frame(index), /FRAME_RANGE_INVALID/);
    video.close(); assert.throws(() => video.frame(0), /FRAMES_CLOSED/);
  } finally { f.clean(); }
});
test('draw preserves target transforms and supports contain/cover/crop with stable repeated pixels', async () => {
  const f = fixture(); try {
    const video = await openPreparedVideoFrames(f.dir, f.map), canvas = new Canvas(8, 8), ctx = canvas.getContext('2d');
    ctx.translate(2, 2); video.draw(ctx, 0, { x: 0, y: 0, width: 4, height: 4 }, 'cover'); const first = canvas.toBufferSync('raw');
    assert.equal(first[(3 * 8 + 3) * 4], 255); assert.equal(first[3], 0);
    ctx.clearRect(-2, -2, 8, 8); video.draw(ctx, 1, { x: 0, y: 0, width: 4, height: 4 }, 'contain', { x: 0, y: 0, width: 0.5, height: 1 });
    assert.equal(canvas.toBufferSync('raw')[(3 * 8 + 3) * 4 + 2], 255);
    ctx.clearRect(-2, -2, 8, 8); video.draw(ctx, 0, { x: 0, y: 0, width: 4, height: 4 }, 'cover'); assert.deepEqual(canvas.toBufferSync('raw'), first);
    for (const crop of [{ x: 0.5, y: 0, width: 0.6, height: 1 }, { x: -0.1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }])
      assert.throws(() => video.draw(ctx, 0, { x: 0, y: 0, width: 4, height: 4 }, 'cover', crop), /CROP_INVALID/);
    video.close();
  } finally { f.clean(); }
});
test('normalized crop selects the right or left half of a frame', async () => {
  const f = fixture(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255])); try {
    const video = await openPreparedVideoFrames(f.dir, f.map), canvas = new Canvas(2, 4), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    for (const [x, expected] of [[0.5, [0, 255, 0, 255]], [0, [255, 0, 0, 255]]] as const) {
      video.draw(ctx, 0, { x: 0, y: 0, width: 2, height: 4 }, 'contain', { x, y: 0, width: 0.5, height: 1 });
      const raw = canvas.toBufferSync('raw'); for (let offset = 0; offset < raw.length; offset += 4) assert.deepEqual([...raw.subarray(offset, offset + 4)], expected);
    }
    video.close();
  } finally { f.clean(); }
});
test('canonical identity and each frame hash reject same-size replacement and forged outer hash', async () => {
  const f = fixture(); try {
    const changed = Buffer.from(f.rgba); changed[0] ^= 1; fs.writeFileSync(join(f.dir, f.map.canonical.path), changed);
    await assert.rejects(openPreparedVideoFrames(f.dir, f.map), /CANONICAL_CHANGED/);
    const forged = structuredClone(f.map); forged.canonical.sha256 = hash(changed); await assert.rejects(openPreparedVideoFrames(f.dir, forged), /FRAME_CHANGED/);
  } finally { f.clean(); }
});
test('production descriptor supports reverse copies, normalized half crops, actual-frame hashes and close', async () => {
  const f = fixture(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]));
  try {
    const map = production(f.map), video = await openPreparedVideoFrames(f.dir, map), canvas = new Canvas(2, 4), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    assert.deepEqual(video.frame(1), f.blue); const copy = video.frame(0); copy.fill(0); assert.deepEqual(video.frame(0), f.red);
    video.draw(ctx, 0, { x: 0, y: 0, width: 2, height: 4 }, 'contain', { x: 0.5, y: 0, width: 0.5, height: 1 });
    const raw = canvas.toBufferSync('raw'); for (let i = 0; i < raw.length; i += 4) assert.deepEqual([...raw.subarray(i, i + 4)], [0, 255, 0, 255]);
    assert.throws(() => video.frame(2), /FRAME_RANGE_INVALID/); assert.throws(() => video.draw(ctx, 0, { x: 0, y: 0, width: 2, height: 4 }, 'cover', { x: 0.5, y: 0, width: 0.6, height: 1 }), /CROP_INVALID/);
    video.close(); video.close(); assert.throws(() => video.frame(0), /FRAMES_CLOSED/);
    const forged = structuredClone(map); forged.frames[0]!.rgbaSha256 = '1'.repeat(64); forged.sourceVideo.sourceFrames[0]!.rgbaSha256 = '1'.repeat(64);
    const wrong = await openPreparedVideoFrames(f.dir, forged); assert.throws(() => wrong.frame(0), /FRAME_CHANGED/); wrong.close();
  } finally { f.clean(); }
});
test('production detects in-place modification, path replacement and added aliases after open', async () => {
  for (const operation of ['modify', 'replace', 'link']) {
    const f = fixture(); try {
      const video = await openPreparedVideoFrames(f.dir, production(f.map)), path = join(f.dir, f.map.canonical.path);
      if (operation === 'link') fs.linkSync(path, join(f.dir, 'alias.rgba'));
      else if (operation === 'replace') { fs.unlinkSync(path); fs.writeFileSync(path, f.rgba); }
      else { const changed = Buffer.from(f.rgba); changed[0] ^= 1; fs.writeFileSync(path, changed); }
      assert.throws(() => video.frame(1), /CANONICAL_CHANGED/); video.close();
    } finally { f.clean(); }
  }
});
