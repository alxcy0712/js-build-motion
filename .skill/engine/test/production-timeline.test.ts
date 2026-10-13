import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionBundleFixture } from './fixtures/production.ts';
import { productionHash, scriptSourceHash, shotsSourceHash, type ProductionBundle } from '../src/project/production.ts';
import { compileProductionTimeline, timelineSourceHash } from '../src/project/production-timeline.ts';
import { validateProductionTimeline } from '../src/project/production-timeline-schema.ts';
import { graphicState } from '../src/drawing/scenes/graphics.ts';
import { validateSpec } from '../src/spec/validate.ts';

function fixture(fps = 24): ProductionBundle {
  const bundle = productionBundleFixture();
  bundle.requirements.effective.fps = fps;
  bundle.requirements.effective.durationSeconds = 8;
  bundle.requirements.requested.hardTargets.durationSeconds = 8;
  bundle.shots!.items.forEach(shot => { shot.durationRange = { minSeconds: 1, maxSeconds: 8 }; });
  bundle.script!.sourceHash = scriptSourceHash(bundle);
  bundle.shots!.sourceHash = shotsSourceHash(bundle);
  const visible = Math.ceil(49000 * fps / 48000);
  const visual = (eventId: string) => ({ backdrop: 'studio' as const, motif: 'none' as const, title: 'Walk', bpm: 96, actors: [],
    elements: [{ id: eventId, kind: 'rect' as const, x: 0.5, y: 0.4, width: 0.2, height: 0.2, fill: '#448c88' }] });
  bundle.timeline = { version: '0.1', sourceHash: timelineSourceHash(bundle), durationFrames: 8 * fps,
    shots: [{ shotId: 'shot-open', startFrame: 0, endFrame: 4 * fps, composition: visual('event-arrive'), camera: 'medium', cameraMove: 'static', transition: 'cut' },
      { shotId: 'shot-detail', startFrame: 4 * fps, endFrame: 8 * fps, composition: visual('event-shadow'), camera: 'close', cameraMove: 'static', transition: 'cut' }],
    clips: [], takes: [{ takeId: 'take-voice', kind: 'voice', lineId: 'line-open',
      file: { path: 'assets/derived/audio/take-voice/source.wav', bytes: 960044, sha256: 'a'.repeat(64) }, sampleRate: 48000, durationSamples: 240000,
      words: [{ pointId: 'word-open', text: bundle.script!.lines[0]!.text, startSample: 1000, endSample: 240000, basis: 'observed' }], beats: [] }],
    placements: [{ placementId: 'place-voice', takeId: 'take-voice', startSample: 48000, inSample: 0, outSample: 240000, gain: 1, mute: false }],
    events: [{ eventId: 'event-arrive', shotId: 'shot-open', prepareFrame: 1, visibleFrame: visible, peakFrame: visible + 3,
      completeFrame: visible + 6, readingEndFrame: 4 * fps - 1,
      anchor: { kind: 'word', placementId: 'place-voice', pointId: 'word-open', phase: 'visible', offsetSamples: 0, precision: 'hard' } },
    { eventId: 'event-shadow', shotId: 'shot-detail', prepareFrame: 4 * fps, visibleFrame: 4 * fps + 3, peakFrame: 4 * fps + 6,
      completeFrame: 4 * fps + 9, readingEndFrame: 8 * fps - 1, anchor: null }], readingGroups: [], captionCues: [] };
  return bundle;
}
function codes(bundle: ProductionBundle) { return compileProductionTimeline(bundle).conflicts.filter(conflict => conflict.severity === 'hard').map(conflict => conflict.code); }
function rehash(bundle: ProductionBundle) {
  bundle.script!.sourceHash = scriptSourceHash(bundle); bundle.shots!.sourceHash = shotsSourceHash(bundle);
  bundle.timeline!.sourceHash = timelineSourceHash(bundle);
}

test('observed voice and word anchors share the 48k origin at 24/25/30fps across a visual cut', () => {
  for (const fps of [24, 25, 30]) {
    const bundle = fixture(fps), before = productionHash(bundle), result = compileProductionTimeline(bundle);
    assert.deepEqual(result.conflicts, []);
    assert.ok(result.spec);
    assert.equal(result.durationSamples, 384000);
    assert.equal(result.audioPlacements[0]!.endSample, 288000);
    assert.equal(result.narrationTimings.get(0)!.end, 6);
    assert.equal(result.spec.scenes[0]!.end, 4);
    assert.equal(result.captionCues[0]!.startSample, 48000);
    assert.equal(Math.round(result.captionCues[0]!.words![0]!.start * 48000), 49000);
    assert.equal(result.events[0]!.anchorSample, 49000);
    assert.equal(result.events[0]!.anchorFrame, Math.ceil(49000 * fps / 48000));
    assert.equal(result.events[0]!.quantizationErrorSamples, result.events[0]!.anchorFrame! * 48000 / fps - 49000);
    assert.equal(productionHash(bundle), before);
    assert.deepEqual(validateSpec(JSON.parse(JSON.stringify(result.spec))).spec, result.spec);
  }
});

test('event stages drive graphic keyframes and retain unrelated animation channels', () => {
  const bundle = fixture(), shot = bundle.timeline!.shots[0]!, event = bundle.timeline!.events[0]!;
  shot.composition.elements![0]!.keyframes = [{ at: 0, x: 0.2 }, { at: 1, x: 0.8 }];
  const result = compileProductionTimeline(bundle), element = result.spec!.scenes[0]!.composition!.elements![0]!;
  const at = (frame: number) => graphicState(element, frame / shot.endFrame);
  assert.equal(result.events[0]!.drivesGraphic, true);
  assert.equal(at(event.visibleFrame - 1).opacity, 0);
  assert.equal(at(event.visibleFrame).opacity, 1);
  assert.equal(at(event.peakFrame).scale, 1.1);
  assert.equal(at(event.completeFrame).scale, 1);
  assert.equal(at(event.readingEndFrame).scale, 1);
  assert.equal(element.keyframes!.find(key => key.at === 0)!.x, 0.2);
  assert.equal(element.keyframes!.find(key => key.at === 1)!.x, 0.8);
});

test('music point maps from a nonzero source trim and placement without inventing a beat phase', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  timeline.takes.push({ takeId: 'take-music', kind: 'bgm', lineId: null, file: { path: 'assets/derived/audio/music/source.wav', bytes: 960044, sha256: 'b'.repeat(64) },
    sampleRate: 48000, durationSamples: 240000, words: [], beats: [{ pointId: 'beat-selected', sample: 96000, basis: 'authored' }] });
  timeline.placements.push({ placementId: 'place-music', takeId: 'take-music', startSample: 24000, inSample: 48000, outSample: 240000, gain: 0.3, mute: false });
  const event = timeline.events[0]!;
  event.anchor = { kind: 'beat', placementId: 'place-music', pointId: 'beat-selected', phase: 'peak', offsetSamples: 0, precision: 'hard' };
  event.peakFrame = 36; event.completeFrame = 40;
  const result = compileProductionTimeline(bundle);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.spec);
  assert.equal(result.spec.audio.bgm.volume, 1);
  assert.equal(result.events[0]!.anchorSample, 72000);
  assert.equal(result.events[0]!.anchorFrame, 36);
  assert.equal(result.events[0]!.quantizationErrorSamples, 0);
  timeline.placements[1]!.inSample = 120000;
  assert.ok(codes(bundle).includes('ANCHOR_SOURCE_CUT'));
});

test('moving a take preserves file identity and moves its words, captions and event together', () => {
  const bundle = fixture(), initial = compileProductionTimeline(bundle), take = structuredClone(bundle.timeline!.takes[0]!);
  bundle.timeline!.placements[0]!.startSample += 24000;
  const event = bundle.timeline!.events[0]!;
  event.visibleFrame += 12; event.peakFrame += 12; event.completeFrame += 12;
  const moved = compileProductionTimeline(bundle);
  assert.deepEqual(moved.conflicts, []);
  assert.deepEqual(bundle.timeline!.takes[0], take);
  assert.equal(moved.narrationTimings.get(0)!.start - initial.narrationTimings.get(0)!.start, 0.5);
  assert.equal(moved.captionCues[0]!.startSample - initial.captionCues[0]!.startSample, 24000);
  assert.equal(moved.events[0]!.anchorSample! - initial.events[0]!.anchorSample!, 24000);
  assert.notEqual(moved.identity, initial.identity);
});

test('complete list reading uses the last item completion', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  bundle.shots!.items[0]!.events.push({ eventId: 'event-last-item', action: 'Last item appears', lineRef: 'line-open' });
  timeline.shots[0]!.composition.elements!.push({ id: 'event-last-item', kind: 'rect', x: 0.3, y: 0.4, width: 0.1, height: 0.1 });
  timeline.events.push({ eventId: 'event-last-item', shotId: 'shot-open', prepareFrame: 50, visibleFrame: 60, peakFrame: 70, completeFrame: 80, readingEndFrame: 95, anchor: null });
  timeline.readingGroups.push({ groupId: 'read-list', eventIds: ['event-arrive', 'event-last-item'], minFrames: 24, endFrame: 95 });
  rehash(bundle);
  assert.ok(codes(bundle).includes('READING_WINDOW'));
  timeline.readingGroups[0]!.minFrames = 15;
  assert.ok(compileProductionTimeline(bundle).spec);
});

test('all hard conflicts are retained and prevent any timing repair or spec publication', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  timeline.sourceHash = 'f'.repeat(64);
  timeline.shots[1]!.startFrame += 1;
  timeline.placements[0]!.startSample = 360000;
  timeline.takes[0]!.words[0]!.basis = 'unknown';
  const before = productionHash(bundle);
  const result = compileProductionTimeline(bundle);
  assert.equal(result.spec, null);
  const hard = result.conflicts.filter(conflict => conflict.severity === 'hard').map(conflict => conflict.code);
  for (const code of ['TIMELINE_SOURCE_STALE', 'SHOT_COVERAGE', 'AUDIO_OVERRUN', 'ANCHOR_TIMING_UNKNOWN', 'ANCHOR_FRAME_CONFLICT']) assert.ok(hard.includes(code), code);
  assert.equal(productionHash(bundle), before);
  assert.equal(timeline.placements[0]!.startSample, 360000);
});

test('no music and no narration allow a silent graphic video with explicit screen captions', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  timeline.takes = []; timeline.placements = []; timeline.events[0]!.anchor = null;
  timeline.captionCues = [{ lineId: 'line-open', startFrame: 24, endFrame: 72 }];
  const result = compileProductionTimeline(bundle);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.spec);
  assert.deepEqual(result.spec.audio.narration, []);
  assert.equal(result.spec.audio.bgm.volume, 0);
  assert.equal(result.captionCues[0]!.text, bundle.script!.lines[0]!.screenText);
  assert.equal(result.narrationTimings.size, 0);
  assert.equal(result.audioPlacements.length, 0);
});

test('muted and zero-gain voice placements retain independent explicit captions', () => {
  for (const kind of ['mute', 'gain'] as const) {
    const bundle = fixture(), timeline = bundle.timeline!;
    if (kind === 'mute') timeline.placements[0]!.mute = true; else timeline.placements[0]!.gain = 0;
    timeline.events[0]!.anchor = null;
    timeline.captionCues = [{ lineId: 'line-open', startFrame: 24, endFrame: 72 }];
    const result = compileProductionTimeline(bundle);
    assert.ok(result.spec);
    assert.deepEqual(result.spec.audio.narration, []);
    assert.equal(result.narrationTimings.size, 0);
    assert.equal(result.captionCues.length, 1);
    timeline.events[0]!.anchor = { kind: 'word', placementId: 'place-voice', pointId: 'word-open', phase: 'visible', offsetSamples: 0, precision: 'hard' };
    assert.ok(codes(bundle).includes('ANCHOR_MUTED'));
  }
});

test('clip cuts and moves project their video frames and original samples from the same row', () => {
  const bundle = fixture(), timeline = bundle.timeline!, assetPlan = bundle.shots!.assetPlan;
  const uuid = '11111111-1111-4111-8111-111111111111';
  assetPlan.needs.push({ needId: 'need-clip', shotId: 'shot-open', purpose: 'Show clip', required: true,
    content: { action: null, view: null, identity: null }, constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null });
  assetPlan.uses.push({ useId: 'use-clip', needId: 'need-clip', shotId: 'shot-open', role: 'visual', catalogId: 'catalog-' + uuid,
    catalogManifestSha256: 'c'.repeat(64), assetId: 'asset-' + uuid, assetVersion: 'asset-version-' + uuid, byteSha256: 'd'.repeat(64),
    selection: { kind: 'video', map: { path: 'assets/derived/video/' + uuid + '/map.json', bytes: 1000, sha256: 'e'.repeat(64) } },
    sourceRange: { timeBase: '1/48000', startPts: '480000', endPts: '864000' }, crop: null, fit: 'contain', mute: false });
  timeline.clips.push({ placementId: 'place-clip', useId: 'use-clip', startFrame: 12, endFrame: 60, sourceStartFrame: 72, gain: 0.7, mute: false });
  rehash(bundle);
  const result = compileProductionTimeline(bundle);
  assert.ok(result.spec);
  assert.deepEqual(result.clips[0], { ...timeline.clips[0], kind: 'video', startSample: 24000, endSample: 120000, sourceStartSample: 144000, sourceEndSample: 240000 });
  timeline.clips[0]!.startFrame = 24; timeline.clips[0]!.endFrame = 72;
  const moved = compileProductionTimeline(bundle).clips[0]!;
  assert.equal(moved.startSample - result.clips[0]!.startSample, 24000);
  assert.equal(moved.sourceStartSample, result.clips[0]!.sourceStartSample);
  timeline.clips[0]!.sourceStartFrame = 190;
  assert.ok(codes(bundle).includes('CLIP_SOURCE_RANGE'));
  timeline.clips = [];
  assert.ok(codes(bundle).includes('CLIP_BINDING_REQUIRED'));
});

test('captions, take trims, event keyframe conflicts and profile projection fail visibly', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  timeline.captionCues = [{ lineId: 'line-open', startFrame: 24, endFrame: 193 }];
  timeline.placements[0]!.outSample -= 100;
  timeline.shots[0]!.composition.elements![0]!.keyframes = [{ at: 0, opacity: 1 }];
  const result = compileProductionTimeline(bundle);
  assert.equal(result.spec, null);
  for (const code of ['CAPTION_RANGE', 'VOICE_TRIMMED', 'EVENT_KEYFRAME_CONFLICT']) assert.ok(result.conflicts.some(conflict => conflict.code === code));
  const valid = fixture(), rough = compileProductionTimeline(valid), final = compileProductionTimeline(valid, 'final');
  assert.equal(rough.spec!.video.width, 320);
  assert.equal(final.spec!.video.width, 1280);
  assert.deepEqual(rough.clips, final.clips);
  assert.deepEqual(rough.audioPlacements, final.audioPlacements);
  assert.notEqual(rough.identity, final.identity);
});

test('timeline schema rejects unknown fields, fractional frames and unsafe asset paths', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  assert.throws(() => validateProductionTimeline({ ...timeline, optionalFeature: true }), /TIMELINE_INVALID/);
  timeline.shots[0]!.startFrame = 0.5;
  assert.throws(() => validateProductionTimeline(timeline), /TIMELINE_INVALID/);
  timeline.shots[0]!.startFrame = 0;
  timeline.takes[0]!.file.path = '../outside.wav';
  assert.throws(() => validateProductionTimeline(timeline), /TIMELINE_INVALID/);
});

test('soft estimated anchors remain visible conflicts while hard duration remains fixed', () => {
  const bundle = fixture(), timeline = bundle.timeline!;
  timeline.takes[0]!.words[0]!.basis = 'estimated';
  timeline.events[0]!.anchor!.precision = 'soft';
  const result = compileProductionTimeline(bundle);
  assert.ok(result.spec);
  assert.ok(result.conflicts.some(conflict => conflict.code === 'ANCHOR_TIMING_UNKNOWN' && conflict.severity === 'soft'));
  bundle.requirements.requested.hardTargets.durationSeconds = 7;
  assert.ok(codes(bundle).includes('HARD_DURATION_CONFLICT'));
});
