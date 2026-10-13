import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Canvas, loadImage } from 'skia-canvas';
import { frameDifference, summarizeFramePairs, type FramePair } from '../src/drawing/primitives/visual-check.ts';
import { trackTextBounds, textOutside } from '../src/drawing/primitives/text-bounds.ts';
import { compileDirector } from '../src/project/director.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { createFixtureProject } from './fixtures/project.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

function pixels(frame: number, mode: 'fixed' | 'move' | 'jump' | 'hold') {
  const canvas = new Canvas(100, 60), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 100, 60);
  if (mode === 'jump' && frame === 12) { ctx.fillStyle = '#102040'; ctx.fillRect(0, 0, 100, 60); }
  else { ctx.fillStyle = '#245a65'; ctx.fillRect(5 + (mode === 'fixed' ? 0 : mode === 'hold' ? Math.min(frame, 8) : frame), 18, 20, 20); }
  return ctx.getImageData(0, 0, 100, 60);
}
function series(mode: Parameters<typeof pixels>[1]) {
  const pairs: FramePair[] = [];
  const heat = new Uint32Array(6000);
  for (let frame = 1; frame < 25; frame++) pairs.push({ from: frame - 1, to: frame, ...frameDifference(pixels(frame - 1, mode), pixels(frame, mode), 8, heat) });
  return { ...summarizeFramePairs(pairs, 24), heat, pairs };
}
test('fixed frames report complete stillness, empty motion bounds and heat', () => {
  const report = series('fixed');
  assert.equal(report.staticRatio, 1); assert.equal(report.holds[0]!.seconds, 1);
  assert.equal(report.holds[0]!.from, 0); assert.equal(report.holds[0]!.to, 24);
  assert.equal(report.jumps.length, 0); assert.ok(report.heat.every(value => value === 0));
  assert.ok(report.pairs.every(pair => pair.bounds === null));
});
test('continuous motion localizes the swept region and remains distinct from an isolated jump', () => {
  const moving = series('move');
  assert.equal(moving.staticRatio, 0); assert.equal(moving.jumps.length, 0);
  assert.deepEqual(moving.pairs[0]!.bounds, { x: 5, y: 18, width: 21, height: 20 });
  assert.equal(moving.pairs[0]!.changedArea, 40 / 6000);
  const broken = series('jump');
  assert.deepEqual(broken.jumps.map(pair => pair.to), [12, 13]);
  assert.deepEqual(broken.jumps.map(pair => pair.time), [0.5, 13 / 24]);
  assert.equal(broken.jumps[0]!.changedArea, 1);
});
test('intentional hold retains its interval for purpose-aware review', () => {
  const report = series('hold');
  assert.equal(report.staticRatio, 16 / 24); assert.equal(report.holds.length, 1);
  assert.equal(report.holds[0]!.start, 8 / 24); assert.equal(report.holds[0]!.end, 1);
  assert.equal(report.jumps.length, 0);
  assert.equal(summarizeFramePairs([], 24).staticRatio, null);
  assert.throws(() => summarizeFramePairs([{ ...report.pairs[0]!, to: 2 }], 24), /SEQUENCE/);
});
test('frame thresholds respect transparent RGB and reject invalid sampling inputs', () => {
  const a = { width: 1, height: 1, data: [0, 0, 0, 0] }, b = { ...a, data: [255, 200, 30, 0] };
  assert.equal(frameDifference(a, b).meanDifference, 0);
  assert.equal(frameDifference(a, { ...a, data: [8, 0, 0, 255] }).changedArea, 1);
  assert.throws(() => frameDifference(a, { ...a, width: 2 }), /SIZE/);
  assert.throws(() => frameDifference(a, { ...a, data: [] }), /PIXELS/);
  assert.throws(() => frameDifference(a, a, NaN), /THRESHOLD/);
});
test('glyph bounds follow alignment, rotation, camera scale and maxWidth without changing pixels', () => {
  const canvas = new Canvas(200, 100), ctx = canvas.getContext('2d'), tracked = trackTextBounds(ctx);
  ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.translate(100, 50); ctx.rotate(0.2); ctx.scale(1.5, 1.5); ctx.fillText('orbit', 0, 0, 40);
  const bounds = tracked.draws[0]!.bounds;
  const image = ctx.getImageData(0, 0, 200, 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) if (image.data[(y * 200 + x) * 4 + 3]! > 100) {
    assert.ok(x >= bounds.x - 1 && x <= bounds.x + bounds.width + 1 && y >= bounds.y - 1 && y <= bounds.y + bounds.height + 1, 'measured box must contain the raster glyph');
  }
  assert.equal(textOutside(bounds, 200, 100), false);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.textAlign = 'left'; ctx.fillText('cut', -12, 40);
  assert.equal(textOutside(tracked.draws.at(-1)!.bounds, 200, 100), true);
  tracked.reset(); assert.equal(tracked.draws.length, 0);
});
test('tracked offscreen text retains source cropping and drawImage destination transform', () => {
  const source = new Canvas(120, 60), src = source.getContext('2d'), screen = new Canvas(240, 120), dst = screen.getContext('2d');
  trackTextBounds(src); const tracked = trackTextBounds(dst);
  src.font = '24px sans-serif'; src.fillText('cropped', -10, 30);
  dst.translate(30, 15); dst.scale(1.2, 1.2); dst.drawImage(source, 0, 0, 120, 60);
  assert.equal(tracked.draws.length, 1); assert.equal(tracked.draws[0]!.sourceClipped, true);
  assert.ok(tracked.draws[0]!.bounds.x < 30);
  const b = tracked.draws[0]!.bounds;
  dst.fillRect(0, 0, 240, 120);
  assert.deepEqual(tracked.draws[0]!.bounds, b, 'occlusion remains a declared raster-review limit');
});
test('pipeline incoming text and captions are observed, opt-in tracing preserves frame pixels', () => {
  const spec = compileDirector({ version: '0.1', idea: 'testing', title: 'test', aspect: '16:9', look: 'graphic', bpm: 120,
    shots: [0, 1].map(i => ({ purpose: 'check text', title: 'test', beats: 2, backdrop: 'studio', motif: 'none', actors: [], cameraMove: 'static', transition: i ? 'zoom' : 'cut' })),
  }).spec;
  spec.audio.narration = [{ start: 0, voice: 'female_calm', text: '中文标记。' }]; spec.captions.enabled = true;
  const drawScene = ({ ctx, scene }: any) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 135); ctx.font = '18px sans-serif'; ctx.fillStyle = '#123'; ctx.fillText(scene.id === spec.scenes[0]!.id ? 'old' : 'incoming', 80, 40); };
  const traced = createSpecRenderer({ spec, width: 240, height: 135, drawScene, trackText: true }), plain = createSpecRenderer({ spec, width: 240, height: 135, drawScene });
  try {
    const rc = makeFrameContext({ frameIndex: 27, totalFrames: 48, fps: 24, width: 240, height: 135, seed: 7 });
    assert.deepEqual(traced.renderFrame(rc).data, plain.renderFrame(rc).data);
    assert.ok(traced.textBounds().some(draw => draw.text === 'incoming'));
    assert.ok(traced.textBounds().some(draw => draw.text === '中'));
  } finally { traced.dispose(); plain.dispose(); }
});
test('diagnose binds continuous encoded frames, labels evidence, honors hold purpose and preserves prior evidence on stale input', async () => {
  const fixture = createFixtureProject();
  try {
    const spec = compileDirector({ version: '0.1', idea: 'a fictional moving tile', title: 'tile', aspect: '16:9', look: 'graphic', bpm: 120,
      shots: [{ purpose: 'check a tile', title: 'tile', beats: 4, actors: [], backdrop: 'studio', motif: 'none', cameraMove: 'static', transition: 'cut' }],
    }).spec;
    spec.audio.narration = []; spec.audio.bgm.volume = 0; spec.audio.sfx = []; spec.captions.enabled = false;
    const brief = JSON.parse(readFileSync(fixture.briefPath!, 'utf8'));
    brief.deliverable = { ...brief.deliverable, duration: 2, aspect: '16:9', fps: 24, captions: 'none' };
    writeFileSync(fixture.briefPath!, JSON.stringify(brief));
    writeFileSync(fixture.specPath, JSON.stringify(spec)); mkdirSync(join(fixture.dir, 'src'), { recursive: true });
    const manifest = fixture.manifest;
    writeFileSync(join(fixture.dir, 'project.json'), JSON.stringify({ ...manifest, drawing: 'src/draw.mjs' }));
    writeFileSync(join(fixture.dir, 'src/draw.mjs'), "export function drawScene({ctx,width,height},frame){ctx.fillStyle='#f8f2e5';ctx.fillRect(0,0,width,height);ctx.fillStyle='#225868';ctx.fillRect(15+Math.min(frame.frameIndex,12),30,20,20);ctx.font='18px sans-serif';ctx.fillText('crop',-14,80);}");
    const run = (args: string[], expected = 0) => {
      const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), ...args], { encoding: 'utf8' });
      assert.equal(result.status, expected, result.stderr + result.stdout); return result.stdout;
    };
    run(['render', fixture.dir, '--no-audio', '--no-captions', '--width', '160', '--height', '90', '--preset', 'ultrafast', '--json']);
    const result = JSON.parse(run(['diagnose', fixture.dir, '--from', '0.25', '--to', '1.25', '--width', '80', '--purpose', 'hold']));
    assert.equal(result.window.firstFrame, 6); assert.equal(result.window.lastFrame, 29); assert.equal(result.summary.pairCount, 23);
    const out = join(fixture.dir, result.outDir), reportPath = join(out, 'report.json'), saved = readFileSync(reportPath);
    const report = JSON.parse(saved.toString());
    assert.equal(report.purpose, 'hold'); assert.ok(report.summary.staticRatio > 0.5);
    assert.equal(report.text.scope, 'source-glyph-bounds'); assert.equal(report.text.issues.length, 24);
    const strip = await loadImage(join(out, 'frame-strip.png')), heat = await loadImage(join(out, 'motion-heatmap.png'));
    assert.equal(heat.width, 80); assert.equal(heat.height, 45); assert.ok(strip.width >= 80);
    assert.ok(report.evidence.stripFrames.includes(6)); assert.ok(report.evidence.stripFrames.includes(29));
    assert.equal(report.artifact.sha256, result.artifact.sha256);
    run(['diagnose', fixture.dir, '--to', '1', '--out-dir', 'src/diagnostic'], 1);
    writeFileSync(join(fixture.dir, 'src/draw.mjs'), '// changed source');
    run(['diagnose', fixture.dir, '--to', '1'], 1);
    assert.deepEqual(readFileSync(reportPath), saved);
  } finally { fixture.cleanup(); }
});
