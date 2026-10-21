import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_OFFICE_LIMITS } from '../src/project/catalog-legacy-policy.ts';
import { DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05, INSPECT_POLICY_06, INSPECT_POLICY_07, LEGACY_INSPECT_POLICY, adoptInspectPolicy, assertInspectPolicy } from '../src/project/catalog.ts';
import { validateAssetPlan, validateAssetUsage, type AssetPlan, type AssetUsage, type AssetConsumptionReceipt } from '../src/project/asset-plan.ts';
import { DEFAULT_VIDEO_PREPARATION_LIMITS, validatePreparedVideoMap, validateVideoPreparationRequest, videoFrameSourceIndices, type PreparedVideoMap } from '../src/project/video-preparation.ts';
import { createHash } from 'node:crypto';

const uid = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64), other = 'b'.repeat(64);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tuple = { catalogId: `catalog-${uid}`, catalogManifestSha256: hash, assetId: `asset-${uid}`, assetVersion: `asset-version-${uid}`, byteSha256: hash };
const range = { timeBase: '1/1200', startPts: '0', endPts: '100' };
const file = { path: `assets/derived/video/${uid}/map.json`, bytes: 100, sha256: hash };

function plan(): AssetPlan {
  return { version: '0.1', kind: 'asset-plan', needs: [{ needId: 'Hero', shotId: 'ShotA', purpose: 'Known source pixels', required: true,
    content: { action: null, view: null, identity: null }, constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null }],
    uses: [{ useId: 'HeroImage', needId: 'Hero', shotId: 'ShotA', role: 'visual', ...tuple, selection: { kind: 'source' }, sourceRange: null, crop: null, fit: 'contain', mute: true }] };
}
function usage(): AssetUsage {
  return { version: '0.1', kind: 'asset-usage', attemptId: uid, inputSnapshotSha256: hash, plan: null, coverage: 'partial',
    scope: ['legacy-drawing'], unknownRemainder: ['Direct dynamic IO remains unknown.'], receipts: [], gaps: [] };
}
function receipt(operation: AssetConsumptionReceipt['operation']): AssetConsumptionReceipt {
  const video = ['frame-access', 'video-draw'].includes(operation);
  return { useId: 'HeroImage', needId: 'Hero', shotId: 'ShotA', role: 'visual', ...tuple,
    source: { path: `inputs/original/import-${uid}/${video ? 'source.mp4' : 'image.png'}`, bytes: 32, sha256: hash },
    selected: { path: video ? `assets/derived/video/${uid}/frames.rgba` : 'assets/image.png', bytes: 32, sha256: hash },
    derivedMap: video ? clone(file) : null, operation, frame: video ? 0 : null, sourcePts: video ? '0' : null };
}
function videoMap(): PreparedVideoMap {
  const sourceFrames = [{ pts: '0', duration: '100', rgbaSha256: hash }, { pts: '100', duration: null, rgbaSha256: other }];
  const command = { executable: 'fixture-tool', version: 'fixture', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 0, error: null };
  const tool = { executable: 'fixture-tool', version: 'fixture', files: [{ path: 'fixture-tool', bytes: 1, sha256: hash }], aliases: [{ path: 'fixture-tool', realpath: 'fixture-tool' }] };
  return { version: '0.1', kind: 'prepared-video-map', mapperVersion: 'video-preparation@0.1',
    request: { version: '0.1', kind: 'video-preparation-request', ...tuple, streamIndex: 0, fps: 12, sourceRange: clone(range) },
    limits: clone(DEFAULT_VIDEO_PREPARATION_LIMITS), policySha256: digest(DEFAULT_VIDEO_PREPARATION_LIMITS), source: { bytes: 1, sha256: hash },
    runtime: { id: 'bounded-audio-input', version: '0.1', lockSha256: hash, platform: 'darwin', arch: 'arm64', tools: { ffmpeg: clone(tool), ffprobe: clone(tool) } },
    sourceVideo: { streamIndex: 0, codec: 'h264', timeBase: '1/1200', width: 4, height: 2, pixelFormat: 'yuv420p', rotation: 0, sourceFrames },
    canonical: { path: `assets/derived/video/${uid}/frames.rgba`, bytes: 32, sha256: hash, width: 4, height: 2, fps: 12, frames: 1 },
    proxy: { path: `assets/derived/video/${uid}/proxy.mp4`, bytes: 1, sha256: hash }, frames: [{ sourceIndex: 0, sourcePts: '0', rgbaSha256: hash }],
    commands: { probe: clone(command), decode: clone(command), encode: clone(command), proxyProbe: clone(command) }, cwd: 'fixture-root',
    coverage: { scope: 'complete-selected-video-frames', complete: true, startPts: '0', endPts: '100', audio: 'muted' } };
}

test('P2 independent: historical policies keep their identities and Office adoption is explicit', () => {
  const originals = [DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05, INSPECT_POLICY_06].map(clone);
  for (const original of originals) { assert.deepEqual(adoptInspectPolicy(original), original); assert.equal('office' in original, false); }
  assert.equal(adoptInspectPolicy(clone(LEGACY_INSPECT_POLICY)).version, '0.4');
  const explicit = adoptInspectPolicy(clone(INSPECT_POLICY_06), '0.7'); assert.equal(explicit.version, '0.7'); assert.deepEqual(explicit.office, DEFAULT_OFFICE_LIMITS);
  const custom = clone(INSPECT_POLICY_07); custom.office.maxSlides = 1; assert.deepEqual(adoptInspectPolicy(custom), custom);
  assert.throws(() => assertInspectPolicy({ ...custom, office: { ...custom.office, maxSlides: 201 } }), /INVALID/);
  assert.throws(() => assertInspectPolicy({ ...custom, office: { ...custom.office, externalReferences: true } }), /INVALID/);
});

test('P2 independent: need/use identity, selectors and crops remain closed', () => {
  validateAssetPlan(plan());
  const cases = [
    (p: AssetPlan) => p.needs.push(clone(p.needs[0]!)),
    (p: AssetPlan) => p.uses.push(clone(p.uses[0]!)),
    (p: AssetPlan) => { p.uses[0]!.needId = 'Unknown'; },
    (p: AssetPlan) => { p.uses[0]!.shotId = 'Other'; },
    (p: AssetPlan) => { p.uses[0]!.crop = { x: 0.75, y: 0, width: 0.5, height: 1 }; },
    (p: AssetPlan) => { p.uses[0]!.sourceRange = clone(range); },
    (p: AssetPlan) => { p.uses[0]!.assetVersion = 'latest'; },
    (p: AssetPlan) => { p.uses[0]!.byteSha256 = 'A'.repeat(64); },
  ];
  for (const change of cases) { const p = plan(); change(p); assert.throws(() => validateAssetPlan(p), /INVALID|DUPLICATE|MISMATCH/); }
  const p = plan(); p.uses[0]!.selection = { kind: 'video', map: clone(file) }; p.uses[0]!.sourceRange = clone(range); validateAssetPlan(p);
  for (const wrong of [{ mute: false }, { role: 'audio' }, { selection: { kind: 'video', map: { ...file, path: '../map.json' } } }]) assert.throws(() => validateAssetPlan({ ...p, uses: [{ ...p.uses[0], ...wrong }] }), /INVALID/);
});

test('P2 independent: complete and partial asset coverage need explicit truthful scope', () => {
  validateAssetUsage(usage());
  const complete = { ...usage(), coverage: 'complete', scope: ['builtin-closed-route'], unknownRemainder: [] };
  validateAssetUsage(complete);
  assert.throws(() => validateAssetUsage({ ...complete, scope: [] }), /INVALID/);
  assert.throws(() => validateAssetUsage({ ...complete, unknownRemainder: ['dynamic-io'] }), /INVALID/);
  assert.throws(() => validateAssetUsage({ ...usage(), unknownRemainder: [] }), /INVALID/);
});

test('P2 independent: draw and frame receipts enforce role, derived map and operation fields', () => {
  for (const operation of ['prepared-read', 'image-draw', 'frame-access', 'video-draw'] as const) {
    const r = receipt(operation), u = { ...usage(), plan: { path: 'inputs/asset-plan.json', bytes: 100, sha256: hash }, receipts: [r] };
    validateAssetUsage(u);
    if (operation !== 'prepared-read') assert.throws(() => validateAssetUsage({ ...u, receipts: [{ ...r, role: 'audio' }] }), /INVALID/);
  }
  const u = { ...usage(), plan: { path: 'inputs/asset-plan.json', bytes: 100, sha256: hash }, receipts: [receipt('image-draw')] };
  assert.throws(() => validateAssetUsage({ ...u, receipts: [{ ...u.receipts[0], derivedMap: clone(file) }] }), /INVALID/);
  assert.throws(() => validateAssetUsage({ ...u, plan: null }), /ASSET_RECEIPT_PLAN_REQUIRED/);
});

test('P2 independent: exact integer PTS holds remain correct beyond Number precision', () => {
  const origin = 100000000000000001n;
  const sourceFrames = [{ pts: String(origin), duration: '20', rgbaSha256: hash }, { pts: String(origin + 20n), duration: '50', rgbaSha256: hash },
    { pts: String(origin + 70n), duration: '30', rgbaSha256: hash }, { pts: String(origin + 100n), duration: null, rgbaSha256: hash }];
  const selected = { timeBase: '1/1200', startPts: String(origin + 35n), endPts: String(origin + 100n) };
  assert.deepEqual(videoFrameSourceIndices(sourceFrames, selected, 60), [1, 1, 2, 2]);
  assert.deepEqual(videoFrameSourceIndices(sourceFrames, { ...selected, timeBase: '2/1200', startPts: String(origin + 20n) }, 60), [1, 1, 1, 1, 1, 2, 2, 2]);
  assert.throws(() => videoFrameSourceIndices(sourceFrames, { ...selected, endPts: String(origin + 101n) }, 60), /INVALID/);
});

test('P2 independent: unknown terminal intervals stay excluded and selections keep their explicit endpoints', () => {
  const sourceFrames = [{ pts: '0', duration: '20', rgbaSha256: hash }, { pts: '20', duration: null, rgbaSha256: hash }];
  const selected = { timeBase: '1/1200', startPts: '0', endPts: '20' }, before = clone(selected);
  assert.deepEqual(videoFrameSourceIndices(sourceFrames, selected, 60), [0]); assert.deepEqual(selected, before);
  assert.throws(() => videoFrameSourceIndices(sourceFrames, { ...selected, endPts: '21' }, 60), /INVALID/);
  const req = videoMap().request; req.sourceRange.endPts = req.sourceRange.startPts; assert.throws(() => validateVideoPreparationRequest(req), /INVALID/);
});

test('P2 independent: prepared video identity and mapping reject coordinated field drift', () => {
  validatePreparedVideoMap(videoMap());
  const changes = [
    (m: PreparedVideoMap) => { m.source.sha256 = other; },
    (m: PreparedVideoMap) => { m.sourceVideo.timeBase = '2/1200'; },
    (m: PreparedVideoMap) => { m.frames[0]!.sourcePts = '1'; },
    (m: PreparedVideoMap) => { m.frames[0]!.rgbaSha256 = other; },
    (m: PreparedVideoMap) => { m.canonical.bytes++; },
    (m: PreparedVideoMap) => { m.proxy.path = 'assets/derived/video/another/proxy.mp4'; },
    (m: PreparedVideoMap) => { m.commands.decode.exitCode = 1; },
  ];
  for (const change of changes) { const m = videoMap(); change(m); assert.throws(() => validatePreparedVideoMap(m), /INVALID/); }
});
