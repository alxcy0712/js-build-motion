import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { audioInputRuntimeIdentity } from '../workspace.mjs';
import { runInspectionTool } from '../src/adapters/inspection.ts';
import { DEFAULT_INSPECT_POLICY, type ToolRun } from '../src/project/catalog.ts';
import { DEFAULT_VIDEO_PREPARATION_LIMITS, DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, type LegacyVideoPreparationRequest } from '../src/project/video-preparation.ts';
import { preflightVideoSource, preflightVideoFile, prepareVideoInput, verifyPreparedVideoInput } from '../src/adapters/video-prepare.ts';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex'), uuid = '00000000-0000-4000-8000-000000000001';
const request = (data: Buffer): LegacyVideoPreparationRequest => ({ version: '0.1', kind: 'video-preparation-request', catalogId: `catalog-${uuid}`,
  catalogManifestSha256: '1'.repeat(64), assetId: `asset-${uuid}`, assetVersion: `asset-version-${uuid}`, byteSha256: sha(data), streamIndex: 0,
  fps: 24, sourceRange: { timeBase: '1/12000', startPts: '0', endPts: '12000' } });
const box = (type: string, ...parts: Buffer[]) => { const payload = Buffer.concat(parts), header = Buffer.alloc(8); header.writeUInt32BE(payload.length + 8); header.write(type, 4, 'latin1'); return Buffer.concat([header, payload]); };
const words = (...values: number[]) => { const b = Buffer.alloc(values.length * 4); values.forEach((n, i) => b.writeUInt32BE(n, i * 4)); return b; };
function knownAtoms(frames = 2, delta = 6000, epoch = 0) {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12);
  const tkhd = Buffer.alloc(84); [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824].forEach((n, i) => tkhd.writeUInt32BE(n, 40 + i * 4));
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(12000, 12); mdhd.writeUInt32BE(frames * delta, 16);
  const hdlr = Buffer.alloc(20); hdlr.write('vide', 8);
  const sample = Buffer.alloc(78); sample.writeUInt16BE(1, 6); sample.writeUInt16BE(96, 24); sample.writeUInt16BE(64, 26);
  const avcc = Buffer.from([1, 66, 0, 10, 255, 224, 0]), ftyp = box('ftyp', Buffer.from('isom'), words(0));
  const edits = epoch ? [box('edts', box('elst', words(0, 2, epoch * 1000, 0xffffffff, 65536, Math.round(frames * delta / 12), 0, 65536)))] : [];
  const movie = (offset: number) => box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), ...edits, box('mdia', box('mdhd', mdhd), box('hdlr', hdlr),
    box('minf', box('vmhd', Buffer.alloc(12)), box('dinf', box('dref', words(0, 1), box('url ', words(1)))),
      box('stbl', box('stsd', words(0, 1), box('avc1', sample, box('avcC', avcc))), box('stts', words(0, 1, frames, delta)),
        box('stsz', words(0, 1, frames)), box('stsc', words(0, 1, 1, frames, 1)), box('stco', words(0, 1, offset)))))));
  const moov = movie(0); return Buffer.concat([ftyp, movie(ftyp.length + moov.length + 8), box('mdat', Buffer.alloc(frames, 1))]);
}
test('bounded atoms provide an independent complete sample/PTS oracle', () => {
  const facts = preflightVideoSource(knownAtoms(), 0);
  assert.equal(facts.width, 96); assert.equal(facts.timeBase, '1/12000'); assert.deepEqual(facts.pts, ['0', '6000']);
  assert.deepEqual(facts.durations, ['6000', '6000']); assert.equal(facts.packets.length, 2);
});
test('source rejects atom truncation, external references, aliasing sample extents and unsupported stream selection', () => {
  const source = knownAtoms(); assert.throws(() => preflightVideoSource(source.subarray(0, -1), 0), /VIDEO_SOURCE_INVALID/);
  const external = Buffer.from(source); external.writeUInt32BE(0, external.indexOf('url ') + 4); assert.throws(() => preflightVideoSource(external, 0), /external data reference/);
  const overlap = Buffer.from(source); overlap.writeUInt32BE(0, overlap.indexOf('stco') + 12); assert.throws(() => preflightVideoSource(overlap, 0), /sample outside mdat/);
  assert.throws(() => preflightVideoSource(source, 1), /video stream\/sample coverage/);
});
test('source admits bounded counts and rejects quotas before native work', () => {
  const source = knownAtoms();
  assert.throws(() => preflightVideoSource(source, 0, { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS }), /VIDEO_LEGACY_POLICY_INVALID/);
  for (const overrides of [{ maxSourceBytes: source.length - 1 }, { maxSourceFrames: 1 }, { maxSourcePixels: 100 }, { maxDurationMs: 900 }, { maxStructureEntries: 3 }])
    assert.throws(() => preflightVideoSource(source, 0, { ...DEFAULT_VIDEO_PREPARATION_LIMITS, ...overrides }), /VIDEO_.*LIMIT/);
});
test('production file metadata admits 624 frames, 26 seconds and a source beyond the legacy byte budget', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-production-'))), source = join(dir, 'source.mp4');
  const data = knownAtoms(624, 500), context = { projectDir: dir, limits: { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS }, check() {} };
  try {
    fs.writeFileSync(source, data); const fd = fs.openSync(source, 'r+'), padding = 67108864 + 8, header = Buffer.alloc(8); header.writeUInt32BE(padding); header.write('free', 4);
    fs.writeSync(fd, header, 0, 8, data.length); fs.ftruncateSync(fd, data.length + padding); fs.closeSync(fd);
    const facts = await preflightVideoFile(source, 0, context);
    assert.equal(facts.pts.length, 624); assert.equal(facts.pts.at(-1), '311500'); assert.equal(facts.durations.at(-1), '500');
    assert.equal(facts.pts[528], '264000'); assert.equal(facts.pts[575], '287500'); assert.equal(facts.audio, null);
    for (const limits of [{ maxSourceBytes: data.length }, { maxMetadataBytes: 32 }, { maxResidentBytes: 512 }])
      await assert.rejects(preflightVideoFile(source, 0, { ...context, limits: { ...context.limits, ...limits } }), /VIDEO_RESOURCE_LIMIT.*(split|larger)/);
    fs.truncateSync(source, data.length); const external = Buffer.from(data); external.writeUInt32BE(0, external.indexOf('url ') + 4); fs.writeFileSync(source, external);
    await assert.rejects(preflightVideoFile(source, 0, context), /external data reference/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('production preserves a nonzero leading-empty epoch and legacy keeps its finite edit contract', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-epoch-'))), source = join(dir, 'source.mp4'), data = knownAtoms(624, 500, 2);
  try {
    fs.writeFileSync(source, data); const facts = await preflightVideoFile(source, 0, { projectDir: dir, limits: { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS }, check() {} });
    assert.equal(facts.pts[0], '24000'); assert.equal(facts.pts[528], '288000'); assert.equal(facts.pts.at(-1), '335500');
    assert.throws(() => preflightVideoSource(knownAtoms(2, 6000, 2), 0), /elst version\/flags\/extent/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('production rejects the simultaneous full metadata, selected map and two-frame working set before native work', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-resident-'))), source = join(dir, 'source.mp4'), data = knownAtoms(624, 500);
  try {
    fs.writeFileSync(source, data); const limits = { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS }, facts = await preflightVideoFile(source, 0, { projectDir: dir, limits, check() {} });
    const selectedEntries = 48 * 120 + 48 * 160, resident = facts.residentBytes + selectedEntries + 96 * 64 * 4 * 2;
    await assert.rejects(prepareVideoInput(source, { ...request(data), version: '0.2', output: { width: null, height: null }, mute: false,
      sourceRange: { timeBase: '1/12000', startPts: '264000', endPts: '288000' } }, { projectDir: dir, temporaryDir: join(dir, 'out/.tmp'), limits: { ...limits, maxResidentBytes: resident - 1 }, check() {}, publishedDir: `assets/derived/video/${uuid}` }),
      /VIDEO_RESOURCE_LIMIT.*metadata, selected map and two-frame working set.*(shorten|split)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('cancellation and source links reject before tools and temporary output', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-source-'))), temp = join(dir, 'out/.tmp'); fs.mkdirSync(temp, { recursive: true });
  const bytes = knownAtoms(), source = join(dir, 'source.mp4'); fs.writeFileSync(source, bytes);
  const context = { projectDir: dir, temporaryDir: temp, limits: { ...DEFAULT_VIDEO_PREPARATION_LIMITS }, publishedDir: `assets/derived/video/${uuid}`, check() {} };
  try {
    await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, limits: { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS } }), /VIDEO_LEGACY_POLICY_INVALID/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, signal: controller.signal }));
    const link = join(dir, 'link.mp4'); fs.symlinkSync(source, link); await assert.rejects(prepareVideoInput(link, request(bytes), context), /SYMLINK/); fs.unlinkSync(link);
    fs.linkSync(source, link); await assert.rejects(prepareVideoInput(link, request(bytes), context), /FILE_INVALID/);
    assert.deepEqual(fs.readdirSync(temp), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('fixed native preparation replays complete muted CFR bytes and rejects tampering, quotas and cancellation', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'video-native-'))), temp = join(dir, 'out/.tmp'), source = join(dir, 'source.mp4'); fs.mkdirSync(temp, { recursive: true });
  const runtime = audioInputRuntimeIdentity();
  const generated = await runInspectionTool({ executable: runtime.tools.ffmpeg.executable, version: runtime.tools.ffmpeg.version, cwd: temp,
    policy: DEFAULT_INSPECT_POLICY, argv: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=12:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-map', '0:v:0', '-map', '1:a:0', '-frames:v', '12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '1',
      '-video_track_timescale', '12000', source] });
  assert.equal(generated.error, null, generated.stderr);
  const bytes = fs.readFileSync(source), runs: ToolRun[] = [], context = { projectDir: dir, temporaryDir: temp,
    limits: { ...DEFAULT_VIDEO_PREPARATION_LIMITS }, publishedDir: `assets/derived/video/${uuid}`, check() {}, onTool: (run: ToolRun) => runs.push(run) };
  try {
    const prepared = await prepareVideoInput(source, request(bytes), context);
    assert.equal(prepared.map.sourceVideo.sourceFrames.length, 12); assert.equal(prepared.map.canonical.frames, 24);
    assert.equal(runs.length, 4); assert.equal(prepared.map.coverage.audio, 'muted');
    const published = join(dir, context.publishedDir); fs.mkdirSync(published, { recursive: true });
    fs.writeFileSync(join(published, 'frames.rgba'), prepared.rgba); fs.writeFileSync(join(published, 'proxy.mp4'), prepared.proxy);
    await verifyPreparedVideoInput(source, prepared.map, context);
    assert.equal(runs.length, 9); assert.equal(runs.at(-1)!.binaryBytes, prepared.rgba.length); assert.ok(runs.at(-1)!.argv.includes('-xerror'));
    const twice = await prepareVideoInput(source, request(bytes), context); assert.deepEqual(twice.proxy, prepared.proxy); assert.deepEqual(twice.rgba, prepared.rgba);
    const original = Buffer.from(prepared.rgba), changed = Buffer.from(original); changed[0] ^= 1; changed[96 * 64 * 4] ^= 1;
    fs.writeFileSync(join(published, 'frames.rgba'), changed); await assert.rejects(verifyPreparedVideoInput(source, prepared.map, context), /DERIVED_CHANGED/);
    const coordinated = structuredClone(prepared.map), alteredHash = sha(changed.subarray(0, 96 * 64 * 4)); coordinated.canonical.sha256 = sha(changed);
    coordinated.sourceVideo.sourceFrames[0]!.rgbaSha256 = alteredHash; coordinated.frames[0]!.rgbaSha256 = alteredHash; coordinated.frames[1]!.rgbaSha256 = alteredHash;
    await assert.rejects(verifyPreparedVideoInput(source, coordinated, context), /REPLAY_INVALID/); fs.writeFileSync(join(published, 'frames.rgba'), original);
    const commandChanged = structuredClone(prepared.map); commandChanged.commands.decode.argv.push('-bad'); await assert.rejects(verifyPreparedVideoInput(source, commandChanged, context), /COMMAND_BINDING_INVALID/);
    await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, limits: { ...context.limits, maxSourceFrames: 11 } }), /FRAME_LIMIT/);
    await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, limits: { ...context.limits, maxRgbaBytes: 1 } }), /RGBA_LIMIT/);
    await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, limits: { ...context.limits, maxProbeBytes: 1 } }), /TOOL_OUTPUT_LIMIT/);
    const controller = new AbortController(); await assert.rejects(prepareVideoInput(source, request(bytes), { ...context, signal: controller.signal, onTool() { controller.abort(); } }));
    assert.deepEqual(fs.readdirSync(temp), []); assert.deepEqual(fs.readFileSync(source), bytes);
    const productionRequest = { ...request(bytes), version: '0.2' as const, output: { width: null, height: null }, mute: false },
      productionContext = { ...context, limits: { ...DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS }, publishedDir: 'assets/derived/video/00000000-0000-4000-8000-000000000002' };
    const production = await prepareVideoInput(source, productionRequest, productionContext), target = join(dir, productionContext.publishedDir); fs.mkdirSync(target, { recursive: true });
    assert.equal(production.map.audio!.samples, 48000); assert.equal(production.map.commands.audio!.binaryBytes, 192000); assert.equal(production.map.coverage.audio, 'preserved');
    assert.equal(production.map.canonical.frames, 24); assert.equal(production.map.sourceVideo.sourceFrameCount, 12);
    for (const [from, to] of [[production.files.canonical, 'frames.rgba'], [production.files.proxy, 'proxy.mp4'], [production.files.audio!, 'source-audio.wav']]) fs.copyFileSync(from, join(target, to));
    assert.deepEqual(fs.readFileSync(production.files.canonical), prepared.rgba); await verifyPreparedVideoInput(source, production.map, productionContext);
    const forgedAudio = structuredClone(production.map); forgedAudio.sourceAudio!.startPts = '1'; await assert.rejects(verifyPreparedVideoInput(source, forgedAudio, productionContext), /REPLAY_INVALID/);
    const audio = fs.readFileSync(join(target, 'source-audio.wav')), altered = Buffer.from(audio); altered[44] ^= 1; fs.writeFileSync(join(target, 'source-audio.wav'), altered);
    await assert.rejects(verifyPreparedVideoInput(source, production.map, productionContext), /DERIVED_CHANGED/);
    const forgedBytes = structuredClone(production.map); forgedBytes.audio!.sha256 = sha(altered); await assert.rejects(verifyPreparedVideoInput(source, forgedBytes, productionContext), /REPLAY_INVALID/); fs.writeFileSync(join(target, 'source-audio.wav'), audio);
    const mute = await prepareVideoInput(source, { ...productionRequest, mute: true }, productionContext); assert.equal(mute.map.coverage.audio, 'muted'); assert.equal(mute.map.audio, null); assert.equal(mute.map.commands.audio, null);
    assert.equal(mute.map.canonical.sha256, production.map.canonical.sha256);
    fs.rmSync(production.map.cwd, { recursive: true, force: true }); fs.rmSync(mute.map.cwd, { recursive: true, force: true }); assert.deepEqual(fs.readdirSync(temp), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
