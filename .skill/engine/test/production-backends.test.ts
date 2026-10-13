import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Canvas } from 'skia-canvas';
import { createFixtureProject } from './fixtures/project.ts';
import { productionBundleFixture } from './fixtures/production.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import { buildProductionAudio } from '../src/audio/production.ts';
import { buildMixArgs, mixAudio } from '../src/audio/mixer.ts';
import { openPreparedVideoFrames } from '../src/adapters/video-frames.ts';
import { createAssetPort } from '../src/adapters/asset-port.ts';
import { createProductionDrawing } from '../src/pipeline/production-drawing.ts';
import { DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, type ProductionPreparedVideoMap } from '../src/project/video-preparation.ts';
import type { CompiledProductionTimeline } from '../src/project/production-timeline.ts';
import type { AudioTimeline } from '../src/audio/types.ts';
import type { PreparedAssetPlan } from '../src/application/asset-plan.ts';
import type { AssetPort } from '../src/ports/assets.ts';
import { audioInputRuntimeIdentity } from '../workspace.mjs';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function wav(samples: number, value: (sample: number) => number): Buffer {
  const data = Buffer.alloc(44 + samples * 4);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(48000, 24);
  data.writeUInt32LE(192000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) { const sample = Math.round(value(i)); data.writeInt16LE(sample, 44 + i * 4); data.writeInt16LE(sample, 46 + i * 4); }
  return data;
}
function pcm(path: string): Buffer {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr.toString()); return r.stdout;
}
function amplitude(data: Buffer, hz: number, start = 49000, length = 24000): number {
  let x = 0, y = 0;
  for (let i = start; i < start + length; i++) { const value = data.readInt16LE(i * 2), angle = 2 * Math.PI * hz * i / 48000; x += value * Math.cos(angle); y += value * Math.sin(angle); }
  return Math.hypot(x, y) / length;
}
function compiled(fixture: ReturnType<typeof createFixtureProject>): CompiledProductionTimeline {
  const spec = validateSpec(loadSpecFile(fixture.specPath)).spec!;
  spec.video.duration = 3; spec.video.fps = 24;
  return { sourceHash: '0'.repeat(64), identity: '1'.repeat(64), profile: 'final', spec, durationSamples: 144000,
    captionCues: [], narrationTimings: new Map(), events: [], clips: [], audioPlacements: [], conflicts: [] };
}

test('sample trim and non-millisecond placement preserve the actual impulse sample', () => {
  const f = createFixtureProject();
  try {
    const path = join(f.dir, 'assets/pulse.wav'); writeFileSync(path, wav(96000, i => i === 118 ? 12000 : 0));
    const timeline: AudioTimeline = { tracks: [{ kind: 'original', path, gain: 1, start: 48001 / 48000, startSample: 48001,
      sourceDuration: 1, sourceStartSample: 17, sourceEndSample: 48017 }], durationSeconds: 3, loudnessLufs: -14, truePeakDb: -1.5,
      masterPath: join(f.outDir, 'pulse.wav'), masterSampleRate: 48000 };
    mkdirSync(f.outDir, { recursive: true }); mixAudio(timeline);
    const data = pcm(timeline.masterPath); assert.equal(data.length / 2, 144000);
    let peak = 0; for (let i = 0; i < data.length / 2; i++) if (Math.abs(data.readInt16LE(i * 2)) > Math.abs(data.readInt16LE(peak * 2))) peak = i;
    assert.equal(peak, 48102);
    assert.match(buildMixArgs(timeline).filterComplex, /adelay=48001S\|48001S/);
    assert.throws(() => buildMixArgs({ ...timeline, tracks: [{ ...timeline.tracks[0]!, startSample: 0.5 }] }), /SAMPLE_PLACEMENT_INVALID/);
  } finally { f.cleanup(); }
});

test('long sample trims and repeated placements preserve 12 seconds and exact pulses with default loudnorm', () => {
  const f = createFixtureProject();
  try {
    const base = join(f.dir, 'assets/base-pulses.wav'), epoch = join(f.dir, 'assets/epoch-pulse.wav');
    writeFileSync(base, wav(96000, i => {
      if (i === 80101) return 25000;
      if (i >= 24000 && i < 28800) return 5000 * Math.sin(2 * Math.PI * 1000 * (i - 24000) / 48000);
      if (i >= 72000 && i < 76800) return 5000 * Math.sin(2 * Math.PI * 1500 * (i - 72000) / 48000);
      return 0;
    }));
    writeFileSync(epoch, wav(96000, i => i >= 72000 && i < 76800 ? 5000 * Math.sin(2 * Math.PI * 1000 * (i - 72000) / 48000) : 0));
    const clip = (path: string, startSample: number, sourceStartSample: number, sourceEndSample: number) => ({
      kind: 'original' as const, path, start: startSample / 48000, startSample, sourceStartSample, sourceEndSample,
      gain: 1, sourceDuration: (sourceEndSample - sourceStartSample) / 48000, duckUnderVoice: false,
    });
    const moved = clip(base, 48001, 48000, 96000), reused = clip(base, 144001, 48000, 96000);
    const cases = [
      { id: 'single', tracks: [moved], impulses: [80102], tones: [[72001, 1500]] },
      { id: 'reused', tracks: [moved, reused], impulses: [80102, 176102], tones: [[72001, 1500], [168001, 1500]] },
      { id: 'four-clips', tracks: [moved, clip(base, 96000, 0, 48000), reused, clip(epoch, 384000, 0, 96000)],
        impulses: [80102, 176102], tones: [[72001, 1500], [120000, 1000], [168001, 1500], [456000, 1000]] },
    ];
    mkdirSync(f.outDir, { recursive: true });
    for (const c of cases) {
      const timeline: AudioTimeline = { tracks: c.tracks, durationSeconds: 12, loudnessLufs: -14, truePeakDb: -1.5,
        masterPath: join(f.outDir, c.id + '.wav'), masterSampleRate: 48000 };
      mixAudio(timeline);
      const data = pcm(timeline.masterPath); assert.equal(data.length / 2, 576000, c.id + ' sample count');
      for (const expected of c.impulses) {
        let peak = expected - 512;
        for (let i = expected - 512; i < expected + 512; i++) if (Math.abs(data.readInt16LE(i * 2)) > Math.abs(data.readInt16LE(peak * 2))) peak = i;
        assert.equal(peak, expected, c.id + ' moved impulse');
      }
      for (const [start, frequency] of c.tones) assert.ok(amplitude(data, frequency!, start! + 512, 1024) / 32768 > 0.03, c.id + ' pulse ' + start);
    }
  } finally { f.cleanup(); }
});

test('fixed voice/music/effect/original channels preserve independent gain and explicit mute in PCM', async () => {
  const f = createFixtureProject();
  try {
    const b = productionBundleFixture(), c = compiled(f), frequencies = [220, 440, 660, 880];
    const kinds = ['voice', 'bgm', 'sfx'] as const;
    const identities = frequencies.map((frequency, i) => {
      const data = wav(96000, sample => 1500 * Math.sin(2 * Math.PI * frequency * sample / 48000)), path = `assets/tone-${i}.wav`;
      writeFileSync(join(f.dir, path), data); return { path, bytes: data.length, sha256: sha(data) };
    });
    c.audioPlacements = kinds.map((kind, i) => ({ placementId: `Place-${i}`, takeId: `Take-${i}`, kind, lineId: null,
      file: identities[i]!, sampleRate: 48000, durationSamples: 96000, startSample: 48001, inSample: 17, outSample: 48017, endSample: 96001, gain: 1, mute: false }));
    c.clips = [{ placementId: 'Clip-original', useId: 'Video', kind: 'video', startFrame: 24, endFrame: 48, sourceStartFrame: 0,
      startSample: 48000, endSample: 96000, sourceStartSample: 0, sourceEndSample: 48000, gain: 1, mute: false }];
    const prepared = { bindings: [{ use: { useId: 'Video', mute: false }, video: { version: '0.2', canonical: { fps: 24, frames: 48 }, coverage: { audio: 'preserved' }, audio: { ...identities[3], samples: 96000 } } }] } as unknown as PreparedAssetPlan;
    const render = async () => pcm((await buildProductionAudio(f.dir, b, c, join(f.outDir, 'mix'), prepared)).masterPath!);
    const base = await render(), baseline = frequencies.map(frequency => amplitude(base, frequency));
    for (let i = 0; i < 4; i++) {
      const target = i < 3 ? c.audioPlacements[i]! : c.clips[0]!;
      target.gain = 0.25;
      const changed = await render(), reference = (i + 1) % 4;
      const relative = amplitude(changed, frequencies[i]!) / amplitude(changed, frequencies[reference]!) * baseline[reference]! / baseline[i]!;
      assert.ok(Math.abs(relative - 0.25) < 0.015, `${i}: gain ratio ${relative}`);
      target.mute = true;
      const muted = await render(); assert.ok(amplitude(muted, frequencies[i]!) / amplitude(muted, frequencies[reference]!) < 0.01);
      target.gain = 1; target.mute = false;
    }
    c.audioPlacements.forEach(p => { p.mute = true; }); c.clips[0]!.mute = true;
    c.narrationTimings.set(0, { start: 1, end: 2 });
    mkdirSync(join(f.outDir, 'silent'), { recursive: true }); writeFileSync(join(f.outDir, 'silent/master.wav'), 'previous');
    const silent = await buildProductionAudio(f.dir, b, c, join(f.outDir, 'silent'), prepared);
    assert.equal(silent.masterPath, undefined); assert.equal(silent.timeline.tracks.length, 0); assert.equal(silent.captionTimings.get(0)!.end, 2);
    assert.equal(existsSync(join(f.outDir, 'silent/master.wav')), false);
    c.audioPlacements[0]!.mute = false; c.audioPlacements[0]!.durationSamples--;
    await assert.rejects(buildProductionAudio(f.dir, b, c, join(f.outDir, 'bad'), prepared), /SAMPLE_FACT_CHANGED/);
    c.audioPlacements[0]!.durationSamples++;
    const changed = readFileSync(join(f.dir, identities[0]!.path)); changed[44] ^= 1; writeFileSync(join(f.dir, identities[0]!.path), changed);
    await assert.rejects(buildProductionAudio(f.dir, b, c, join(f.outDir, 'changed'), prepared), /FILE_CHANGED/);
  } finally { f.cleanup(); }
});

test('original audio permits only the prepared last partial frame and rejects larger missing ranges', async () => {
  const f = createFixtureProject();
  try {
    const b = productionBundleFixture(), c = compiled(f), data = wav(96999, i => 1000 * Math.sin(2 * Math.PI * 220 * i / 48000));
    const file = { path: 'assets/tail.wav', bytes: data.length, sha256: sha(data) }; writeFileSync(join(f.dir, file.path), data);
    c.clips = [{ placementId: 'Tail', useId: 'Video', kind: 'video', startFrame: 0, endFrame: 1, sourceStartFrame: 48,
      startSample: 0, endSample: 2000, sourceStartSample: 96000, sourceEndSample: 98000, gain: 1, mute: false }];
    const map = { version: '0.2', canonical: { fps: 24, frames: 49 }, coverage: { audio: 'preserved' }, audio: { ...file, samples: 96999 } };
    const prepared = { bindings: [{ use: { useId: 'Video', mute: false }, video: map }] } as unknown as PreparedAssetPlan;
    const result = await buildProductionAudio(f.dir, b, c, join(f.outDir, 'partial'), prepared);
    assert.equal(result.timeline.tracks[0]!.sourceEndSample, 96999); assert.equal(pcm(result.masterPath!).length / 2, 144000);
    map.audio.samples = 95000;
    await assert.rejects(buildProductionAudio(f.dir, b, c, join(f.outDir, 'missing'), prepared), /ORIGINAL_AUDIO_RANGE_INVALID/);
  } finally { f.cleanup(); }
});

test('rough reads actual proxy pixels and receipts; final preserves larger canonical pixels and repeated reverse access', async () => {
  const f = createFixtureProject();
  try {
    const prefix = 'assets/derived/video/00000000-0000-4000-8000-000000000001'; mkdirSync(join(f.dir, prefix), { recursive: true });
    const rgba = Buffer.alloc(16 * 8 * 4 * 2);
    for (let frame = 0; frame < 2; frame++) for (let i = 0; i < 16 * 8; i++) { rgba[(frame * 16 * 8 + i) * 4 + frame * 2] = 255; rgba[(frame * 16 * 8 + i) * 4 + 3] = 255; }
    const proxyPath = join(f.dir, prefix, 'proxy.mp4');
    const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '16x8', '-r', '12', '-i', 'pipe:0', '-vf', 'scale=4:2:flags=neighbor', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '0', proxyPath], { input: rgba });
    assert.equal(r.status, 0, r.stderr.toString()); writeFileSync(join(f.dir, prefix, 'frames.rgba'), rgba);
    const proxy = readFileSync(proxyPath), limits = { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, maxProxyEdge: 4 };
    const runtime = audioInputRuntimeIdentity(), tool = { executable: '/fixed/tool', version: 'fixed', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 0, error: null };
    const map: ProductionPreparedVideoMap = { version: '0.2', kind: 'prepared-video-map', mapperVersion: 'video-preparation@0.2', limits,
      policySha256: sha(Buffer.from(JSON.stringify(limits))), runtime, source: { bytes: 1, sha256: '0'.repeat(64) },
      request: { version: '0.2', kind: 'video-preparation-request', catalogId: 'catalog-00000000-0000-4000-8000-000000000001', catalogManifestSha256: '1'.repeat(64),
        assetId: 'asset-00000000-0000-4000-8000-000000000001', assetVersion: 'asset-version-00000000-0000-4000-8000-000000000001', byteSha256: '0'.repeat(64),
        streamIndex: 0, fps: 12, sourceRange: { timeBase: '1/12000', startPts: '0', endPts: '2000' }, output: { width: null, height: null }, mute: false },
      sourceVideo: { streamIndex: 0, codec: 'h264', timeBase: '1/12000', width: 16, height: 8, pixelFormat: 'yuv420p', rotation: 0,
        sourceFrameCount: 2, startPts: '0', endPts: '2000', sourceFrames: [0, 1].map(i => ({ pts: String(i * 1000), duration: '1000', rgbaSha256: sha(rgba.subarray(i * 512, (i + 1) * 512)) })) },
      sourceAudio: null, audio: null, canonical: { path: `${prefix}/frames.rgba`, bytes: rgba.length, sha256: sha(rgba), width: 16, height: 8, fps: 12, frames: 2 },
      proxy: { path: `${prefix}/proxy.mp4`, bytes: proxy.length, sha256: sha(proxy), width: 4, height: 2 },
      frames: [0, 1].map(i => ({ sourceIndex: i, sourcePts: String(i * 1000), rgbaSha256: sha(rgba.subarray(i * 512, (i + 1) * 512)) })),
      commands: { probe: tool, decode: tool, encode: tool, proxyProbe: tool, audio: null }, cwd: '/recorded/cwd', coverage: { scope: 'complete-selected-video-frames', complete: true, startPts: '0', endPts: '2000', audio: 'absent' } };
    const use = { useId: 'Video', needId: 'Need', shotId: 'Shot', role: 'visual', ...map.request, selection: { kind: 'video', map: { path: `${prefix}/map.json`, bytes: 1, sha256: '2'.repeat(64) } }, crop: null, fit: 'cover', mute: false };
    const prepared = { plan: { version: '0.2' }, identity: { path: 'assets/plan.json', bytes: 1, sha256: '3'.repeat(64) }, gaps: [], bindings: [{ use, video: map, asset: { source: { fixedPath: 'inputs/original/source.mp4', bytes: 1 } } }] } as unknown as PreparedAssetPlan;
    const runDir = join(f.dir, 'runs/preview'); mkdirSync(runDir, { recursive: true });
    const assets = createAssetPort(f.dir, prepared, { attemptId: '00000000-0000-4000-8000-000000000001', inputSnapshotSha256: '4'.repeat(64), runDir });
    try {
      const rough = await assets.port.video('Video', 'rough'), final = await assets.port.video('Video', 'final');
      assert.equal(rough.width, 4); assert.equal(final.width, 16);
      const blue = rough.frame(1), red = rough.frame(0); assert.ok(blue[2]! > 245 && red[0]! > 245); assert.deepEqual(rough.frame(1), blue);
      assert.deepEqual(final.frame(0), rgba.subarray(0, 512));
      const receipts = assets.usage().receipts;
      assert.ok(receipts.some(r => r.selected.path === map.proxy.path && r.frame === 1 && r.sourcePts === '1000'));
      assert.ok(receipts.some(r => r.selected.path === map.canonical.path && r.frame === 0));
    } finally { assets.close(); }
    const record = JSON.parse(readFileSync(join(runDir, 'proxy-decode-Video.json'), 'utf8'));
    assert.equal(record.profile, 'rough'); assert.equal(record.proxy.sha256, map.proxy.sha256); assert.equal(record.decodeRun.exitCode, 0); assert.equal(record.decodeRun.binaryBytes, 64);
    const opened = await openPreparedVideoFrames(f.dir, map, 'rough'); assert.equal(opened.decodeRun!.exitCode, 0); opened.close();
    const bad = Buffer.from(proxy); bad[0] ^= 1; writeFileSync(proxyPath, bad);
    await assert.rejects(openPreparedVideoFrames(f.dir, map, 'rough'), /PROXY_CHANGED/);
    const invalid = Buffer.from('invalid proxy'), forged = structuredClone(map); forged.proxy.bytes = invalid.length; forged.proxy.sha256 = sha(invalid); writeFileSync(proxyPath, invalid);
    const failedDir = join(f.dir, 'runs/failed'); mkdirSync(failedDir, { recursive: true });
    const failed = createAssetPort(f.dir, { ...prepared, bindings: [{ ...prepared.bindings[0]!, video: forged }] },
      { attemptId: '00000000-0000-4000-8000-000000000001', inputSnapshotSha256: '4'.repeat(64), runDir: failedDir });
    try { await assert.rejects(failed.port.video('Video', 'rough'), /PROXY_DECODE_INVALID/); }
    finally { failed.close(); }
    const failure = JSON.parse(readFileSync(join(failedDir, 'proxy-decode-Video.json'), 'utf8'));
    assert.notEqual(failure.decodeRun.exitCode, 0); assert.ok(failure.decodeRun.stderr.length > 0);
  } finally { f.cleanup(); }
});

test('production drawing maps cuts, moves, reuse and reverse queries to exact fixed source frames', async () => {
  const f = createFixtureProject();
  try {
    const c = compiled(f), seen: number[] = [], profiles: string[] = [];
    c.clips = [{ placementId: 'Clip', useId: 'Video', kind: 'video', startFrame: 24, endFrame: 48, sourceStartFrame: 17,
      startSample: 48000, endSample: 96000, sourceStartSample: 34000, sourceEndSample: 82000, gain: 1, mute: false }];
    const assets = { video: async (_id: string, profile: string) => { profiles.push(profile); return { width: 4, height: 4, frames: 100, fps: 24,
      draw(ctx: ReturnType<Canvas['getContext']>, index: number) { seen.push(index); ctx.fillStyle = index === 19 ? '#ff0000' : '#0000ff'; ctx.fillRect(0, 0, 4, 4); } }; } } as unknown as AssetPort;
    const draw = await createProductionDrawing(c, assets, 'rough'), canvas = new Canvas(4, 4), ctx = canvas.getContext('2d');
    const context = { ctx, width: 4, height: 4, progress: 1, scene: { start: 1, end: 2, composition: { elements: [
      { id: 'Event', kind: 'rect', x: 0.5, y: 0.5, width: 0.5, height: 0.5, fill: '#00ff00', keyframes: [{ at: 0, opacity: 0 }, { at: 1, opacity: 1 }] }
    ] } } } as Parameters<typeof draw>[0];
    for (const index of [47, 26, 24, 26]) draw(context, { frameIndex: index, fps: 24 } as Parameters<typeof draw>[1]);
    assert.deepEqual(seen, [40, 19, 17, 19]); assert.deepEqual(profiles, ['rough']);
    const pixels = canvas.toBufferSync('raw'); assert.equal(pixels[0], 255); assert.equal(pixels[(2 * 4 + 2) * 4 + 1], 255);
    c.clips.push({ ...c.clips[0]!, placementId: 'Second', sourceStartFrame: 90 });
    await assert.rejects(createProductionDrawing(c, assets, 'final'), /CLIP_FRAME_RANGE_INVALID/);
  } finally { f.cleanup(); }
});
