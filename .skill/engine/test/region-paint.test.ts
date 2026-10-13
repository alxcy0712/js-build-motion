import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Canvas, Path2D } from 'skia-canvas';
import { paintRegion, pressureStroke } from '../src/drawing/art/region-paint.ts';
import { clearWashCache } from '../src/drawing/art/watercolor.ts';
import { PaperTexture } from '../src/drawing/art/paper.ts';
import { colorCoverage, frameDifference } from '../src/drawing/primitives/visual-check.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { drawMaterialScene, MATERIAL_WIDTH, MATERIAL_HEIGHT, SEMANTIC_FRAMES } from './fixtures/material-scene.ts';
import { buildCaptionTrack, activeWordIndexAt } from '../src/captions/track.ts';
import { compileDirector } from '../src/project/director.ts';
import { SkiaRenderer } from '../src/renderer/skia/skia-renderer.ts';
import { renderVideo } from '../src/pipeline/render-video.ts';
import { probeMedia, verifyDecodable } from '../src/ffmpeg/encoder.ts';

function raster(frame: number, seed = 41) {
  const canvas = new Canvas(MATERIAL_WIDTH, MATERIAL_HEIGHT); drawMaterialScene(canvas.getContext('2d'), frame, seed);
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}
const hash = (data: ArrayLike<number>) => createHash('sha256').update(Buffer.from(data as Uint8Array)).digest('hex');
test('regional paint preserves exact path holes and outer clearance and restores drawing state', () => {
  const canvas = new Canvas(120, 100), ctx = canvas.getContext('2d'), path = new Path2D();
  path.rect(10, 10, 100, 80); path.rect(45, 35, 30, 30);
  ctx.globalAlpha = 0.7; ctx.fillStyle = '#123456'; ctx.translate(1, 2);
  const before = { transform: ctx.getTransform().toString(), alpha: ctx.globalAlpha, fill: ctx.fillStyle };
  paintRegion(ctx, path, { x: 10, y: 10, w: 100, h: 80 }, { seed: 7, color: '#226b65', wetness: 0.5 });
  const pixels = ctx.getImageData(0, 0, 120, 100);
  assert.equal(pixels.data[(50 * 120 + 60) * 4 + 3], 0);
  assert.equal(pixels.data[(5 * 120 + 5) * 4 + 3], 0);
  assert.ok([...pixels.data].some((v, i) => i % 4 === 3 && v > 0));
  assert.deepEqual({ transform: ctx.getTransform().toString(), alpha: ctx.globalAlpha, fill: ctx.fillStyle }, before);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillRect(0, 0, 2, 2); assert.ok(ctx.getImageData(0, 0, 1, 1).data[3]! > 0);
  assert.throws(() => paintRegion(ctx, path, { x: 0, y: 0, w: 100, h: 80 }, { seed: 1, color: '#000000', spacing: 0 }), /OPTIONS/);
});
test('pressure and dry gaps produce visible, deterministic material differences', () => {
  const draw = (dryness: number, seed = 2) => {
    const canvas = new Canvas(140, 80), ctx = canvas.getContext('2d');
    pressureStroke(ctx, [10, 40], [130, 40], { seed, color: '#226b65', width: 36, pressure: [0.1, 1, 0.1], dryness, alpha: 1 });
    return ctx.getImageData(0, 0, 140, 80);
  };
  const wet = draw(0), dry = draw(1);
  assert.ok(wet.data[(25 * 140 + 70) * 4 + 3]! > 0); assert.equal(wet.data[(25 * 140 + 16) * 4 + 3], 0);
  const area = (data: ArrayLike<number>) => Array.from(data).filter((v, i) => i % 4 === 3 && v > 0).length;
  assert.ok(area(dry.data) < area(wet.data) * 0.8);
  assert.equal(hash(dry.data), hash(draw(1).data)); assert.notEqual(hash(dry.data), hash(draw(1, 8).data));
});
test('paper, wash and regional strokes match across cold cache, warm cache, out-of-order frames and fresh processes', () => {
  PaperTexture.clearCache(); clearWashCache();
  const targets = [0, 24, 53, 72, 108], expected = new Map(targets.map(frame => [frame, hash(raster(frame).data)]));
  for (const frame of [...targets].reverse()) assert.equal(hash(raster(frame).data), expected.get(frame));
  PaperTexture.clearCache(); clearWashCache();
  for (const frame of [53, 0, 108, 24, 72]) assert.equal(hash(raster(frame).data), expected.get(frame));
  const script = join(PROJECT_ROOT, 'test/fixtures/render-material.ts');
  for (const frame of [0, 53, 108]) assert.equal(execFileSync(process.execPath, [script, String(frame), '41'], { encoding: 'utf8' }).trim(), expected.get(frame));
  assert.notEqual(hash(raster(53, 8).data), expected.get(53));
  assert.equal(colorCoverage(raster(0), { x: 322, y: 191, width: 6, height: 6 }, [52, 125, 122], 24), 0);
  assert.equal(colorCoverage(raster(72), { x: 405, y: 172, width: 1, height: 8 }, [36, 79, 80], 30), 1);
});
test('Chinese semantic moments and full-list reading share measured words and remain frame-verifiable', () => {
  const spec = compileDirector({ version: '0.1', idea: 'a marked band changes', title: 'band', aspect: '16:9', look: 'graphic', bpm: 120,
    shots: [{ purpose: 'trace identity', title: 'band', beats: 10, actors: [], backdrop: 'studio', motif: 'none' }],
  }).spec;
  spec.audio.narration = [{ start: 0.5, voice: 'female_calm', text: '输入，收拢，完成十二格。' }];
  const measured = new Map([[0, { start: 0.5, end: 3.5, words: [{ text: '输入', start: 0.5, end: 0.9 }, { text: '收拢', start: 1, end: 1.4 }, { text: '完成', start: 2.8, end: 3 }, { text: '十二格', start: 3, end: 3.5 }] }]]);
  const cues = buildCaptionTrack(spec, { measured }), cue = cues.find(c => c.words?.some(w => w.text === '收拢'))!;
  assert.equal(cue.timingSource, 'words');
  assert.equal(cue.words![activeWordIndexAt(cue, 1)!]!.text, '收拢');
  assert.equal(Math.ceil(measured.get(0)!.words[0]!.start * 24), SEMANTIC_FRAMES.firstVisible);
  assert.equal(Math.round(measured.get(0)!.words[1]!.start * 24), SEMANTIC_FRAMES.emphasisPeak);
  assert.equal(Math.ceil(measured.get(0)!.words[3]!.start * 24), SEMANTIC_FRAMES.actionComplete);
  assert.equal((SEMANTIC_FRAMES.readingEnd - Math.max(...SEMANTIC_FRAMES.itemComplete)) / 24, 1.5);
  const roi = (frame: number, x: number, y: number, w: number, h: number) => {
    const canvas = new Canvas(MATERIAL_WIDTH, MATERIAL_HEIGHT); drawMaterialScene(canvas.getContext('2d'), frame);
    return canvas.getContext('2d').getImageData(x, y, w, h);
  };
  assert.ok(frameDifference(roi(11, 270, 85, 110, 40), roi(12, 270, 85, 110, 40)).changedArea > 0);
  assert.ok(frameDifference(roi(23, 270, 85, 110, 40), roi(24, 270, 85, 110, 40), 0).changedArea > 0);
  assert.equal(frameDifference(roi(72, 205, 85, 250, 220), roi(107, 205, 85, 250, 220)).changedArea, 0);
  assert.ok(frameDifference(roi(71, 375, 260, 70, 40), roi(72, 375, 260, 70, 40)).changedArea > 0);
});
test('H.264 preserves material clearance, identity mark and the completed reading hold', async () => {
  const parent = join(PROJECT_ROOT, '.research/out'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'regional-encoding-')), out = join(dir, 'band.mp4');
  const renderer = new SkiaRenderer({ width: MATERIAL_WIDTH, height: MATERIAL_HEIGHT, draw: (ctx, frame) => drawMaterialScene(ctx, frame.frameIndex) });
  try {
    await renderVideo({ renderer, fps: 24, totalFrames: 120, seed: 41, outPath: out, video: { codec: 'libx264', preset: 'fast', crf: 18 } });
    assert.equal(probeMedia(out).video!.frameCount, 120); assert.equal(verifyDecodable(out), null);
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', "select='eq(n,72)+eq(n,107)'", '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: MATERIAL_WIDTH * MATERIAL_HEIGHT * 8 + 1024 });
    const size = MATERIAL_WIDTH * MATERIAL_HEIGHT * 4, first = { width: MATERIAL_WIDTH, height: MATERIAL_HEIGHT, data: decoded.subarray(0, size) }, last = { ...first, data: decoded.subarray(size) };
    assert.equal(decoded.length, size * 2);
    assert.equal(colorCoverage(first, { x: 352, y: 191, width: 6, height: 6 }, [233, 232, 219], 12), 1);
    assert.ok(colorCoverage(first, { x: 405, y: 172, width: 1, height: 8 }, [36, 79, 80], 50) >= 0.875);
    assert.ok(frameDifference(first, last).changedArea < 0.001);
    assert.ok(frameDifference(raster(72), first).meanDifference < 0.01);
  } finally { renderer.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
