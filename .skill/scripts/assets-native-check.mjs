import assert from 'node:assert/strict';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = (project, path) => { const data = readFileSync(join(project, path)); return { path, bytes: data.length, sha256: sha(data) }; };

const nativePrefix = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { audioInputRuntimeIdentity } from './.engine/workspace.mjs';
import { runInspectionTool } from './.engine/src/adapters/inspection.ts';
import { DEFAULT_INSPECT_POLICY } from './.engine/src/project/catalog.ts';
const sha = data => createHash('sha256').update(data).digest('hex'), project = process.cwd(), output = join(project, 'out/asset-native-check');
fs.mkdirSync(output, { recursive: true });
const runtime = audioInputRuntimeIdentity(), commands = [], host = { node: process.version, platform: process.platform, arch: process.arch, release: os.release() };
async function tool(role, name, argv, maximum) {
  const native = runtime.tools[name], parts = [];
  const result = await runInspectionTool({ executable: native.executable, version: native.version, argv, cwd: output,
    policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: 8388608 }, binaryLimit: maximum,
    ...(maximum === undefined ? {} : { binary: async data => parts.push(Buffer.from(data)) }) });
  const data = Buffer.from(JSON.stringify({ cwd: output, ...result }, null, 2) + '\n'), path = join(output, role + '.json');
  fs.writeFileSync(path, data); commands.push({ role, argv, cwd: output, executable: result.executable, version: result.version,
    exitCode: result.exitCode, error: result.error, log: { path, bytes: data.length, sha256: sha(data) } });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.error, null, result.stderr);
  return maximum === undefined ? Buffer.from(result.stdout) : Buffer.concat(parts);
}
`;

const fixtureProgram = nativePrefix + String.raw`
const width = 96, height = 64, frameBytes = width * height * 4, frames = 24, raw = Buffer.alloc(frameBytes * frames);
const colors = Array.from({ length: frames }, (_, i) => [20 + i * 7, 30 + i * 5, 220 - i * 6]);
for (let i = 0; i < frames; i++) for (let pixel = 0; pixel < width * height; pixel++) raw.set([...colors[i], 255], i * frameBytes + pixel * 4);
const input = join(output, 'known-source.rgba'), source = join(project, 'assets/known-vfr.mp4'); fs.writeFileSync(input, raw);
await tool('fixture-encode', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
  '-s', '96x64', '-framerate', '12', '-i', input, '-vf', "settb=1/12000,setpts='if(lt(N,12),N*1000,12000+(N-12)*2000)'",
  '-frames:v', '24', '-fps_mode', 'vfr', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-threads', '1',
  '-pix_fmt', 'yuv420p', '-video_track_timescale', '12000', source]);
const probe = JSON.parse(await tool('fixture-probe', 'ffprobe', ['-v', 'error', '-show_streams', '-show_frames',
  '-show_entries', 'stream=codec_type,width,height,time_base:frame=pts,duration', '-of', 'json', source]));
const pts = Array.from({ length: frames }, (_, i) => String(i < 12 ? i * 1000 : 12000 + (i - 12) * 2000));
assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].time_base, '1/12000');
assert.deepEqual(probe.frames.map(frame => String(frame.pts)), pts);
const decoded = await tool('fixture-decode', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', source,
  '-an', '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], raw.length);
assert.equal(decoded.length, raw.length);
let worstColorError = 0; for (let offset = 0; offset < raw.length; offset++) worstColorError = Math.max(worstColorError, Math.abs(decoded[offset] - raw[offset]));
assert.ok(worstColorError <= 5, 'known source color error: ' + worstColorError);
fs.writeFileSync(join(output, 'source-decoded.rgba'), decoded);
fs.writeFileSync(join(output, 'fixture-report.json'), JSON.stringify({ packageId: process.env.JBM_RUNTIME_ID, host, runtime, commands,
  source: { bytes: fs.statSync(source).size, sha256: sha(fs.readFileSync(source)) }, width, height, frames, frameBytes, pts,
  durations: probe.frames.map(frame => frame.duration === undefined ? null : String(frame.duration)),
  knownColors: colors, decodedSha256: sha(decoded), worstColorError }, null, 2) + '\n');
`;

const oracleProgram = nativePrefix + String.raw`
const selection = JSON.parse(fs.readFileSync(join(output, 'oracle-selection.json'))), fixture = JSON.parse(fs.readFileSync(join(output, 'fixture-report.json')));
const map = JSON.parse(fs.readFileSync(join(project, selection.map))), canonical = fs.readFileSync(join(project, map.canonical.path));
const original = fs.readFileSync(join(output, 'source-decoded.rgba')), frameBytes = fixture.frameBytes;
assert.equal(sha(fs.readFileSync(join(project, selection.source))), fixture.source.sha256);
assert.deepEqual(map.sourceVideo.sourceFrames.map(frame => frame.pts), fixture.pts);
assert.deepEqual(map.sourceVideo.sourceFrames.map(frame => frame.duration), fixture.durations);
const indices = Array.from({ length: 68 }, (_, frame) => {
  let selected = 0; for (let source = 1; source < fixture.pts.length; source++) if (BigInt(fixture.pts[source]) * 24n <= BigInt(frame) * 12000n) selected = source;
  return selected;
});
assert.equal(map.canonical.frames, 68); assert.equal(canonical.length, 68 * frameBytes);
for (const [frame, source] of indices.entries()) {
  assert.equal(map.frames[frame].sourceIndex, source); assert.equal(map.frames[frame].sourcePts, fixture.pts[source]);
  assert.deepEqual(canonical.subarray(frame * frameBytes, (frame + 1) * frameBytes), original.subarray(source * frameBytes, (source + 1) * frameBytes));
}
const artifact = join(project, selection.artifact), probe = JSON.parse(await tool('artifact-probe', 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames',
  '-show_entries', 'stream=codec_type,width,height,time_base,r_frame_rate:frame=pts,duration', '-of', 'json', artifact]));
assert.equal(probe.streams.length, 1); assert.equal(probe.streams[0].codec_type, 'video'); assert.equal(probe.streams[0].r_frame_rate, '24/1');
assert.equal(probe.streams[0].width, 96); assert.equal(probe.streams[0].height, 64); assert.equal(probe.frames.length, 48);
const [n, d] = probe.streams[0].time_base.split('/').map(Number), ticks = d / (n * 24); assert.ok(Number.isSafeInteger(ticks));
for (const [i, frame] of probe.frames.entries()) { assert.equal(frame.pts, i * ticks); assert.equal(frame.duration, ticks); }
const decoded = await tool('artifact-decode', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', artifact,
  '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], 48 * frameBytes);
assert.equal(decoded.length, 48 * frameBytes);
const expected = Buffer.alloc(decoded.length), errors = [], transitionPixel = (32 * 96 + 32) * 4;
for (let frame = 0; frame < 48; frame++) {
  const incoming = original.subarray(indices[frame] * frameBytes, (indices[frame] + 1) * frameBytes), previous = original.subarray(indices[23] * frameBytes, (indices[23] + 1) * frameBytes);
  const mix = frame < 24 ? 0 : Math.min(1, (frame - 24) / 8); let delta = 0;
  for (let pixel = 0; pixel < 96 * 64; pixel++) for (let channel = 0; channel < 4; channel++) {
    const offset = pixel * 4 + channel, color = frame >= 24 && pixel % 96 >= 80 && Math.floor(pixel / 96) < 16 ? [0, 255, 255, 255][channel] : incoming[offset];
    const value = frame < 24 ? incoming[offset] : Math.round(previous[offset] * (1 - mix) + color * mix);
    expected[frame * frameBytes + offset] = value; delta += Math.abs(decoded[frame * frameBytes + offset] - value);
  }
  errors.push(delta / frameBytes); assert.ok(errors.at(-1) < 4, 'complete encoded frame ' + frame + ': ' + errors.at(-1));
}
const actualMiddle = decoded.subarray(28 * frameBytes + transitionPixel, 28 * frameBytes + transitionPixel + 3), cutMiddle = original.subarray(indices[28] * frameBytes + transitionPixel, indices[28] * frameBytes + transitionPixel + 3);
assert.ok([...actualMiddle].some((channel, index) => Math.abs(channel - cutMiddle[index]) > 3), 'transition must differ from a cut');
fs.writeFileSync(join(output, 'expected-render.rgba'), expected); fs.writeFileSync(join(output, 'decoded-artifact.rgba'), decoded);
fs.writeFileSync(join(output, 'pixel-oracle.json'), JSON.stringify({ packageId: process.env.JBM_RUNTIME_ID, host, commands, sourceFrames: 24, canonicalFrames: 68,
  encodedFrames: 48, checkedPixels: 48 * 96 * 64, errors, worstFrameMeanAbsoluteError: Math.max(...errors),
  rationalOracle: { sourceTimeBase: '1/12000', fps: 24, sourceRange: map.request.sourceRange, sourceIndices: indices, sourcePts: indices.map(index => fixture.pts[index]) },
  expectedSha256: sha(expected), decodedSha256: sha(decoded), transitionFrame: 28, actualMiddle: [...actualMiddle], cutMiddle: [...cutMiddle] }, null, 2) + '\n');
`;

const drawingProgram = String.raw`
export async function prepareDrawing({ assets }) {
  const left = await assets.video('ClipLeft'), right = await assets.video('ClipRight'), image = await assets.image('Badge');
  const first = left.frame(23); left.frame(0); const repeated = left.frame(23);
  if (!first.equals(repeated)) throw Error('ASSET_FIXTURE_FRAME_SEEK'); first.fill(0);
  if (!left.frame(23).equals(repeated)) throw Error('ASSET_FIXTURE_FRAME_COPY');
  return ({ ctx, scene, width, height }, frame) => {
    const incoming = scene.id === 'shot_002', index = incoming ? 24 + Math.min(23, Math.max(0, frame.frameIndex - 24)) : Math.min(23, frame.frameIndex);
    (incoming ? right : left).draw(ctx, index, { x: 0, y: 0, width, height });
    if (incoming) image.draw(ctx, { x: 80, y: 0, width: 16, height: 16 });
  };
}
`;

/** Known fictional pixels and integer PTS; every command enters the standard bound production entry. */
export async function checkAssetsNative({ scratch, skill, run, check }) {
  const root = join(scratch, 'assets workspace'), core = join(root, '.skill'), project = join(root, 'projects/assets-film'), selected = join(scratch, 'assets sources');
  const output = join(project, 'out/asset-native-check'), calls = [];
  const control = (args, expected = 0) => {
    const argv = [join(core, 'scripts/video.mjs'), ...args], result = run(root, argv, expected), log = encoded({ argv: [process.execPath, ...argv], cwd: root, exitCode: expected, output: result });
    mkdirSync(output, { recursive: true }); const path = join(output, `control-${String(calls.length + 1).padStart(3, '0')}.json`); writeFileSync(path, log);
    calls.push({ argv: [process.execPath, ...argv], cwd: root, exitCode: expected, log: { path, bytes: log.length, sha256: sha(log) } }); return result;
  };
  const film = (args, expected = 0) => control(['assets-film', ...args], expected), verifyCatalog = id => JSON.parse(film(['catalog', '--verify', id])).manifest;
  const renderArgs = ['render', '--width', '96', '--height', '64', '--crf', '0', '--preset', 'ultrafast', '--no-captions', '--no-network', '--json'];
  let receipt, manifest, picture, clip, prepared, map, plan, current, artifact, fixture, packageId, failure, status = 'running';
  const writePlan = value => writeFileSync(join(project, 'assets/asset-plan.json'), encoded(value));
  const unchangedCurrent = () => { assert.deepEqual(readFileSync(join(project, 'run.json')), current); assert.equal(sha(readFileSync(join(project, artifact.artifact.path))), artifact.artifact.sha256); };

  try {
  await check('素材标准入口与独立 PNG/VFR 原件、完整 CFR 映射和固定发布身份', async () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected);
    packageId = json(join(skill, 'manifest.json')).packageId;
    assert.equal(JSON.parse(control(['start', '--theme', 'minimal', 'assets-film', '--idea', '虚构素材连续镜头与裁框样片'])).packageId, packageId);
    writeFileSync(join(project, 'asset-native-fixture.mjs'), fixtureProgram); film(['exec', process.execPath, 'asset-native-fixture.mjs']); fixture = json(join(output, 'fixture-report.json'));
    assert.equal(fixture.packageId, packageId); cpSync(join(project, 'assets/known-vfr.mp4'), join(selected, 'known-vfr.mp4'));
    const { Canvas } = await import(pathToFileURL(join(skill, 'engine/node_modules/skia-canvas/lib/index.mjs')).href);
    const canvas = new Canvas(16, 16, { gpu: false }), ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 8, 16); ctx.fillStyle = '#00ffff'; ctx.fillRect(8, 0, 8, 16);
    assert.deepEqual([...ctx.getImageData(4, 8, 1, 1).data], [255, 0, 255, 255]); assert.deepEqual([...ctx.getImageData(12, 8, 1, 1).data], [0, 255, 255, 255]);
    const png = canvas.toBufferSync('png'); writeFileSync(join(selected, 'known.png'), png);
    const imported = JSON.parse(film(['import', '--source', selected])); receipt = JSON.parse(film(['catalog', '--import', imported.importId])); assert.equal(receipt.status, 'succeeded');
    manifest = verifyCatalog(receipt.catalogId); picture = manifest.assets.find(asset => asset.source.path === 'known.png'); clip = manifest.assets.find(asset => asset.source.path === 'known-vfr.mp4');
    assert.ok(picture && clip); assert.equal(picture.source.sha256, sha(png)); assert.equal(clip.source.sha256, fixture.source.sha256);
    const request = { version: '0.1', kind: 'video-preparation-request', catalogId: receipt.catalogId, catalogManifestSha256: sha(readFileSync(join(project, receipt.manifestPath))),
      assetId: clip.assetId, assetVersion: clip.assetVersion, byteSha256: clip.source.sha256, streamIndex: 0, fps: 24,
      sourceRange: { timeBase: '1/12000', startPts: '0', endPts: '34000' } };
    writeFileSync(join(project, 'inputs/video-request.json'), encoded(request)); prepared = JSON.parse(film(['video', '--request', 'inputs/video-request.json'])); assert.equal(prepared.status, 'succeeded');
    map = json(join(project, prepared.map.path)); assert.equal(map.canonical.frames, 68); assert.equal(map.frames.at(-1).sourcePts, '32000'); assert.equal(map.coverage.audio, 'muted');
    assert.deepEqual(JSON.parse(map.commands.proxyProbe.stdout).streams.map(stream => stream.codec_type), ['video']);
    assert.deepEqual(map.sourceVideo.sourceFrames.map(frame => frame.pts), fixture.pts); assert.deepEqual(map.sourceVideo.sourceFrames.map(frame => frame.duration), fixture.durations);
    assert.equal(JSON.parse(film(['video', '--verify', prepared.map.path])).ok, true);
    const publication = json(join(project, prepared.map.path.replace(/map\.json$/, 'publication.json'))); assert.equal(publication.receipt.sha256, sha(readFileSync(join(project, publication.receipt.path))));
    const need = (needId, shotId) => ({ needId, shotId, purpose: '虚构原件视觉证明', required: true, content: { action: null, view: null, identity: null },
      constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null });
    const use = (useId, asset, needId, shotId, video) => ({ useId, needId, shotId, role: 'visual', catalogId: receipt.catalogId, catalogManifestSha256: request.catalogManifestSha256,
      assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, selection: video ? { kind: 'video', map: prepared.map } : { kind: 'source' },
      sourceRange: video ? request.sourceRange : null, crop: video ? null : { x: 0.5, y: 0, width: 0.5, height: 1 }, fit: 'cover', mute: true });
    plan = { version: '0.1', kind: 'asset-plan', needs: [need('NeedLeft', 'shot_001'), need('NeedRight', 'shot_002'), need('NeedBadge', 'shot_002')],
      uses: [use('ClipLeft', clip, 'NeedLeft', 'shot_001', true), use('ClipRight', clip, 'NeedRight', 'shot_002', true), use('Badge', picture, 'NeedBadge', 'shot_002', false)] };
    writePlan(plan); assert.deepEqual(JSON.parse(film(['assets'])).plan, identity(project, 'assets/asset-plan.json'));
  });

  await check('素材连续两镜头与 dissolve 全成片像素、partial/unknown 回执、披露和 artifact 闭合 tuple', () => {
    writeFileSync(join(project, 'project.json'), encoded({ ...json(join(project, 'project.json')), drawing: 'src/native-assets.mjs' })); writeFileSync(join(project, 'src/native-assets.mjs'), drawingProgram);
    writeFileSync(join(project, 'director.json'), encoded({ version: '0.1', title: '虚构连续素材', idea: '独立原件视觉证明', aspect: '16:9', look: 'graphic', fps: 24, bpm: 120, bgmPreset: 'playful',
      shots: [0, 1].map(i => ({ purpose: '虚构连续片段', beats: 2, title: '片段', backdrop: 'studio', motif: 'none', cameraMove: 'static', transition: i ? 'dissolve' : 'cut', sfx: [] })) }));
    const brief = json(join(project, 'brief.json')); brief.claims.pureCode = false; brief.claims.zeroExternalAssets = false;
    brief.assets = [[picture, 'image'], [clip, 'video']].map(([asset, kind]) => ({ path: asset.source.fixedPath, kind, license: 'self-created fictional fixture', sha256: asset.source.sha256 }));
    writeFileSync(join(project, 'brief.json'), encoded(brief)); film(['direct', 'compile']); film(renderArgs); current = readFileSync(join(project, 'run.json'));
    const log = JSON.parse(current), usage = json(join(project, log.execution.assetUsage.path)); assert.equal(usage.coverage, 'partial'); assert.ok(usage.unknownRemainder.length);
    assert.equal(log.facts.providers.bgm, 'procedural'); assert.deepEqual(log.facts.network, []); assert.deepEqual(log.facts.assets.consumed, []);
    assert.ok(usage.receipts.every(entry => entry.role === 'visual'));
    assert.equal(sha(encoded(usage)), log.execution.assetUsage.sha256); assert.equal(usage.attemptId, log.execution.attemptId); assert.equal(usage.inputSnapshotSha256, log.execution.inputSnapshotSha256);
    const { attemptId, inputSnapshotSha256, ...body } = usage; assert.deepEqual(body, log.facts.assets.usage);
    assert.deepEqual(usage.plan, identity(project, 'assets/asset-plan.json')); const snapshot = json(join(project, 'runs', attemptId, 'input-snapshot.json'));
    for (const entry of usage.receipts) {
      const binding = plan.uses.find(use => use.useId === entry.useId), asset = binding.useId === 'Badge' ? picture : clip;
      for (const key of ['needId', 'shotId', 'role', 'catalogId', 'catalogManifestSha256', 'assetId', 'assetVersion', 'byteSha256']) assert.equal(entry[key], binding[key]);
      assert.deepEqual(entry.source, { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: asset.source.sha256 });
      assert.deepEqual(entry.selected, binding.selection.kind === 'video' ? { path: map.canonical.path, bytes: map.canonical.bytes, sha256: map.canonical.sha256 } : entry.source);
      assert.deepEqual(entry.derivedMap, binding.selection.kind === 'video' ? prepared.map : null);
      assert.ok(snapshot.files.some(file => file.path === entry.source.path && file.sha256 === entry.source.sha256));
      if (entry.frame !== null) assert.equal(entry.sourcePts, map.frames[entry.frame].sourcePts);
    }
    const draws = usage.receipts.filter(entry => entry.operation === 'video-draw');
    assert.ok(draws.length >= 56 && draws.length <= 57); assert.equal(draws.filter(entry => entry.useId === 'ClipRight').length, 24);
    assert.equal(usage.receipts.filter(entry => entry.operation === 'image-draw').length, 24);
    assert.equal(usage.receipts.filter(entry => entry.operation === 'frame-access').length, 4);
    const publication = json(join(project, prepared.map.path.replace(/map\.json$/, 'publication.json')));
    assert.ok(snapshot.files.some(file => file.path === publication.receipt.path && file.sha256 === publication.receipt.sha256));
    film(['disclosure', '--json']); const disclosure = readFileSync(join(project, 'DISCLOSURE.md'), 'utf8'); assert.match(disclosure, /partial/); assert.ok(disclosure.includes(clip.assetVersion)); assert.ok(disclosure.includes(picture.assetVersion));
    artifact = JSON.parse(film(['artifact', '--out', 'evidence/assets-artifact.json'])); assert.equal(artifact.ok, true); assert.equal(artifact.artifact.attemptId, attemptId);
    assert.equal(artifact.artifact.sha256, sha(readFileSync(join(project, artifact.artifact.path)))); assert.equal(JSON.parse(film(['artifact', '--review', 'evidence/assets-artifact.json'])).ok, true);
    writeFileSync(join(output, 'oracle-selection.json'), encoded({ map: prepared.map.path, source: clip.source.fixedPath, artifact: artifact.artifact.path }));
    writeFileSync(join(project, 'asset-native-oracle.mjs'), oracleProgram); film(['exec', process.execPath, 'asset-native-oracle.mjs']);
    const pixels = json(join(output, 'pixel-oracle.json')); assert.equal(pixels.packageId, packageId); assert.equal(pixels.encodedFrames, 48); assert.equal(pixels.checkedPixels, 48 * 96 * 64);
    unchangedCurrent();
  });

  await check('素材准备和逐帧绘制失败保留上一 current、编码文件与真实 partial 消费回执', () => {
    const request = json(join(project, 'inputs/video-request.json')); request.sourceRange.endPts = '40000'; writeFileSync(join(project, 'inputs/video-rejected.json'), encoded(request));
    const rejected = JSON.parse(film(['video', '--request', 'inputs/video-rejected.json'], 1)); assert.equal(rejected.status, 'failed'); assert.equal(rejected.map, null); unchangedCurrent();
    const path = join(project, 'src/native-assets.mjs'), original = readFileSync(path);
    for (const [source, error, operations, drawFrames] of [["export async function prepareDrawing({assets}) { const v=await assets.video('ClipLeft'); v.frame(0); throw Error('ASSET_FIXTURE_PREPARE_FAILED'); }\n", 'ASSET_FIXTURE_PREPARE_FAILED', ['prepared-read', 'frame-access'], []],
      [drawingProgram.replace('const incoming =', "if (frame.frameIndex === 5) { process.stdout.write('ASSET_FIXTURE_DRAW_TRAP:5\\n'); throw Error('ASSET_FIXTURE_DRAW_FAILED'); } const incoming ="), '渲染过程中出现未预期错误', ['video-draw'], [0, 1, 2, 3, 4]]]) {
      const known = new Set(readdirSync(join(project, 'runs'))); try {
        writeFileSync(path, source); const result = film(renderArgs, 1); assert.ok(result.includes(`RENDER_FAILED: ${error}\n`)); unchangedCurrent();
        assert.equal(result.split('ASSET_FIXTURE_DRAW_TRAP:5\n').length - 1, drawFrames.length ? 1 : 0);
        const added = readdirSync(join(project, 'runs')).filter(name => !known.has(name) && /^[a-f0-9-]{36}$/.test(name)); assert.equal(added.length, 1);
        const failed = json(join(project, 'runs', added[0], 'receipt.json')); assert.equal(failed.status, 'failed'); assert.equal(failed.error, error); assert.equal(failed.previousRunSha256, sha(current));
        assert.equal(readFileSync(join(project, 'runs', added[0], 'snapshot/assets-film/src/native-assets.mjs'), 'utf8'), source);
        const usage = json(join(project, 'runs', added[0], 'asset-usage.json')); assert.equal(usage.coverage, 'partial'); assert.ok(usage.unknownRemainder.length);
        for (const operation of operations) assert.ok(usage.receipts.some(entry => entry.operation === operation));
        assert.deepEqual(usage.receipts.filter(entry => entry.operation === 'video-draw').map(entry => [entry.useId, entry.frame, entry.sourcePts]), drawFrames.map(frame => ['ClipLeft', frame, map.frames[frame].sourcePts]));
      } finally { writeFileSync(path, original); }
    }
    assert.equal(existsSync(join(project, 'runs/.render.lock')), false); assert.equal(JSON.parse(film(['artifact', '--review', 'evidence/assets-artifact.json'])).ok, true);
  });

  await check('素材 MAP/RGBA、proxy 与 source 协调外层身份篡改仍拒绝，历史 artifact 保持可复查', () => {
    const publicationPath = prepared.map.path.replace(/map\.json$/, 'publication.json'), publication = json(join(project, publicationPath));
    const paths = [prepared.map.path, map.canonical.path, map.proxy.path, clip.source.fixedPath, publicationPath, publication.receipt.path, 'assets/asset-plan.json'];
    const originals = new Map(paths.map(path => [path, readFileSync(join(project, path))]));
    const publishForged = changed => {
      const mapData = encoded(changed); writeFileSync(join(project, prepared.map.path), mapData); const mapIdentity = identity(project, prepared.map.path);
      const receipt = json(join(project, publication.receipt.path)); receipt.map = mapIdentity; receipt.request = changed.request; writeFileSync(join(project, publication.receipt.path), encoded(receipt));
      writeFileSync(join(project, publicationPath), encoded({ ...publication, receipt: identity(project, publication.receipt.path) }));
      const selected = structuredClone(plan); for (const use of selected.uses.filter(use => use.selection.kind === 'video')) { use.selection.map = mapIdentity; use.byteSha256 = changed.request.byteSha256; }
      writePlan(selected);
    };
    for (const kind of ['rgba', 'proxy', 'source']) try {
      const changed = structuredClone(map), selected = kind === 'rgba' ? changed.canonical.path : kind === 'proxy' ? changed.proxy.path : clip.source.fixedPath;
      const data = Buffer.from(originals.get(selected));
      if (kind === 'rgba') {
        for (const [i, frame] of changed.frames.entries()) if (frame.sourceIndex === 0) data[i * 96 * 64 * 4] ^= 1;
        const frameHash = sha(data.subarray(0, 96 * 64 * 4)); changed.sourceVideo.sourceFrames[0].rgbaSha256 = frameHash;
        for (const frame of changed.frames) if (frame.sourceIndex === 0) frame.rgbaSha256 = frameHash; changed.canonical.sha256 = sha(data);
      } else { data[data.length - 1] ^= 1; if (kind === 'proxy') changed.proxy.sha256 = sha(data); else { changed.source.sha256 = sha(data); changed.request.byteSha256 = sha(data); } }
      writeFileSync(join(project, selected), data); publishForged(changed);
      assert.match(film(['video', '--verify', prepared.map.path], 1), /REPLAY|CHANGED|INVALID|HASH|VERSION|SUPPORTED/);
      assert.match(film(['assets'], 1), /REPLAY|CHANGED|INVALID|HASH|VERSION|SUPPORTED/); unchangedCurrent();
    } finally { for (const [path, data] of originals) writeFileSync(join(project, path), data); }
    verifyCatalog(receipt.catalogId); assert.equal(JSON.parse(film(['artifact', '--review', 'evidence/assets-artifact.json'])).ok, true);
    writeFileSync(join(output, 'control-report.json'), encoded({ packageId, host: fixture.host, calls,
      fixture: identity(project, 'out/asset-native-check/fixture-report.json'), pixels: identity(project, 'out/asset-native-check/pixel-oracle.json'),
      artifact, audio: { source: 'muted', proxy: 'muted', artifact: 'procedural-bgm', externalAudioConsumption: [] },
      scope: 'known fictional original pixels, complete bounded CFR and encoded frames, actual AssetPort receipts, publication replay and current preservation' }));
  });
  status = 'passed';
  } catch (error) { status = 'failed'; failure = error; throw error; }
  finally {
    const archive = join(dirname(scratch), 'assets-native-evidence', randomUUID());
    try {
      mkdirSync(archive, { recursive: true });
      if (existsSync(project)) {
        mkdirSync(output, { recursive: true }); writeFileSync(join(output, 'calls.json'), encoded(calls));
        cpSync(project, join(archive, 'project'), { recursive: true, filter: path => !['.engine', 'guide'].includes(path.split('/').at(-1)) });
      }
      if (existsSync(selected)) cpSync(selected, join(archive, 'sources'), { recursive: true });
      cpSync(join(skill, 'scripts/assets-native-check.mjs'), join(archive, 'assets-native-check.mjs'));
      const files = [], visit = directory => { for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name); if (item.isDirectory()) visit(path); else if (item.isFile()) { const data = readFileSync(path); files.push({ path: path.slice(archive.length + 1), bytes: data.length, sha256: sha(data) }); }
      } }; visit(archive);
      writeFileSync(join(archive, 'archive.json'), encoded({ kind: 'assets-native-check-evidence', createdAt: new Date().toISOString(), status,
        packageId: packageId ?? json(join(skill, 'manifest.json')).packageId, error: failure ? failure.stack ?? String(failure) : null,
        origin: { project, sources: selected, scratch, skill }, files: files.sort((a, b) => a.path.localeCompare(b.path)),
        coverage: 'fictional original pixels, bounded rational CFR mapping, complete encoded frames, actual partial consumption, immutable publication and current preservation',
        receiptNote: '56–57 video draws permit the floating transition endpoint; all 48 encoded frames and 24 incoming draws have exact oracles.' }));
      process.stdout.write('ASSETS_NATIVE_EVIDENCE:' + archive + '\n');
    } catch (error) {
      if (failure) process.stderr.write('ASSETS_NATIVE_ARCHIVE_FAILED:' + String(error) + '\n'); else throw error;
    }
  }
}

const productionPrefix = nativePrefix.replace('maxToolOutputBytes: 8388608', 'maxToolOutputBytes: 16777216, maxToolElapsedMs: 300000') + String.raw`
import { readFixed } from './.engine/src/adapters/inspection.ts';
const fileIdentity = async path => { const actual = await readFixed(path, 8589934592, undefined, undefined, false); return { path, bytes: actual.bytes, sha256: actual.sha256 }; };
const variant = process.argv[2], epoch = variant === 'epoch' ? { video: 2, audio: 3 } : { video: 0, audio: 0 };
`;
const productionFixtureProgram = productionPrefix + String.raw`
const source = join(project, 'assets/known-' + variant + '.mp4'), width = 960, height = 540, count = 624;
const lines = Array.from({length:8},(_,i)=>'drawbox=x='+(16+i*2)+':y=16:w=1:h=16:color=white:t=fill').join(',');
const picture = "color=c=0x204080:s=960x540:r=24:d=26,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,540)',drawbox=x=0:y=0:w=iw:h=ih:color=yellow:t=fill:enable='eq(n,564)'," + lines;
const sound = 'aevalsrc=0.02*sin(2*PI*220*t)+0.6*sin(2*PI*1000*t)*between(t\\,22.5\\,22.54)+0.6*sin(2*PI*1500*t)*between(t\\,23.5\\,23.54):s=48000:d=26';
let editConstruction = null;
if (variant === 'base') await tool(variant + '-encode', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
  '-itsoffset', String(epoch.video), '-f', 'lavfi', '-i', picture, '-itsoffset', String(epoch.audio), '-f', 'lavfi', '-i', sound,
  '-map', '0:v:0', '-map', '1:a:0', '-frames:v', String(count), '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-b:v', '24M', '-minrate', '24M', '-maxrate', '24M', '-bufsize', '24M', '-x264-params', 'nal-hrd=cbr:filler=1:keyint=24:min-keyint=24:scenecut=0',
  '-bf', '0', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-aac_pns', '0', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-t', String(26 + epoch.audio), '-video_track_timescale', '12000', source]);
else {
  // Keep the original encoded samples and AAC forward edit; add exact independent leading-empty epochs.
  const original = join(project,'assets/known-base.mp4'), originalIdentity = await fileIdentity(original), input = fs.openSync(original,'r'), bytes = fs.statSync(original).size;
  let moov, prefixBytes;
  for (let position=0;position<bytes;) {const header=Buffer.alloc(8);assert.equal(fs.readSync(input,header,0,8,position),8);const size=header.readUInt32BE(0);assert.ok(size>=8&&position+size<=bytes);
    if(header.toString('latin1',4,8)==='moov'){assert.equal(position+size,bytes);assert.ok(size<33554432);moov=Buffer.alloc(size);assert.equal(fs.readSync(input,moov,0,size,position),size);prefixBytes=position;}position+=size;}
  assert.ok(moov); const children=data=>{const result=[];for(let p=0;p<data.length;){const n=data.readUInt32BE(p);assert.ok(n>=8&&p+n<=data.length);result.push(data.subarray(p,p+n));p+=n;}return result;}, name=box=>box.toString('latin1',4,8), pack=(type,data)=>{const h=Buffer.alloc(8);h.writeUInt32BE(data.length+8);h.write(type,4);return Buffer.concat([h,data]);};
  function rewrite(box, shift=0){const type=name(box), payload=box.subarray(8);
    if(type==='moov'||type==='trak'||type==='edts'){
      if(type==='trak'){const mdia=children(payload).find(child=>name(child)==='mdia'),hdlr=children(mdia.subarray(8)).find(child=>name(child)==='hdlr');shift=hdlr.toString('latin1',16,20)==='vide'?epoch.video:epoch.audio;}
      return pack(type,Buffer.concat(children(payload).map(child=>rewrite(child,shift))));
    }
    if(type==='elst'){assert.equal(payload.readUInt32BE(0),0);assert.equal(payload.readUInt32BE(4),1);assert.equal(payload.length,20);const data=Buffer.alloc(32);data.writeUInt32BE(2,4);data.writeUInt32BE(shift*1000,8);data.writeInt32BE(-1,12);data.writeUInt32BE(65536,16);payload.copy(data,20,8);return pack(type,data);}
    if(type==='mvhd'||type==='tkhd'){const data=Buffer.from(payload),offset=type==='mvhd'?16:20;assert.equal(data[0],0);if(type==='mvhd')assert.equal(data.readUInt32BE(12),1000);data.writeUInt32BE(data.readUInt32BE(offset)+(type==='mvhd'?Math.max(epoch.video,epoch.audio):shift)*1000,offset);return pack(type,data);}
    return box;
  }
  const changed=rewrite(moov), outputFd=fs.openSync(source,'wx'), buffer=Buffer.alloc(65536), prefixHash=createHash('sha256');
  try{for(let position=0;position<prefixBytes;){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,prefixBytes-position),position);assert.ok(n>0);prefixHash.update(buffer.subarray(0,n));fs.writeSync(outputFd,buffer,0,n);position+=n;}fs.writeSync(outputFd,changed);fs.fsyncSync(outputFd);}finally{fs.closeSync(outputFd);fs.closeSync(input);}
  editConstruction={original:originalIdentity,prefixBytes,prefixSha256:prefixHash.digest('hex'),oldMoovSha256:sha(moov),newMoovSha256:sha(changed),leadingEmptyMovieTicks:{video:2000,audio:3000},forwardEdits:'preserved byte-for-byte including AAC priming'};
}
const probe = JSON.parse(await tool(variant + '-probe', 'ffprobe', ['-v', 'error', '-show_streams', '-show_frames',
  '-show_entries', 'stream=index,codec_type,width,height,time_base,start_pts,duration_ts,nb_frames:frame=stream_index,pts,duration', '-of', 'json', source]));
const video = probe.streams.find(stream => stream.codec_type === 'video'), audio = probe.streams.find(stream => stream.codec_type === 'audio'), frames = probe.frames.filter(frame => frame.stream_index === video.index);
assert.equal(video.width, width); assert.equal(video.height, height); assert.equal(video.time_base, '1/12000'); assert.equal(audio.time_base, '1/48000');
assert.equal(String(video.start_pts), String(epoch.video * 12000)); assert.equal(String(audio.start_pts), String(epoch.audio * 48000));
assert.equal(frames.length, count); assert.deepEqual(frames.map(frame => String(frame.pts)), Array.from({length: count}, (_, i) => String(epoch.video * 12000 + i * 500)));
const original = await fileIdentity(source); assert.ok(original.bytes > 67108864, 'actual CBR source must exceed 64 MiB');
fs.writeFileSync(join(output, variant + '-fixture.json'), JSON.stringify({ packageId: process.env.JBM_RUNTIME_ID, host, runtime, commands, source: original,
  width, height, frameBytes: width * height * 4, count, durationSeconds: 26, epoch, video, audio, pts: frames.map(frame => String(frame.pts)),
  selectedStartOrdinal: 528, selectedEndOrdinal: 576, knownColors: { base: [32,64,128,255], flash12: [255,255,255,255], flash36: [255,255,0,255] },
  knownToneSeconds: [22.5 + epoch.audio, 23.5 + epoch.audio], aacPns:false, editConstruction }, null, 2) + '\n');
`;
const productionOracleProgram = productionPrefix + String.raw`
import { openPreparedVideoFrames } from './.engine/src/adapters/video-frames.ts';
import { Canvas } from './.engine/node_modules/skia-canvas/lib/index.mjs';
const selection = JSON.parse(fs.readFileSync(join(output, variant + '-selection.json'))), fixture = JSON.parse(fs.readFileSync(join(output, variant + '-fixture.json'))),
  map = JSON.parse(fs.readFileSync(join(project, selection.map))), original = join(project, selection.source), frameBytes = fixture.frameBytes;
const independent = join(output, variant + '-selected-original.rgba'), fullAudio = join(output, variant + '-full-source.pcm'), preview = join(output, variant + '-preview.rgba');
await tool(variant + '-original-video-oracle', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-copyts', '-noautorotate', '-i', original,
  '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', "select='between(n,528,575)',format=rgba", '-frames:v', '48', '-fps_mode', 'passthrough', '-threads', '1', '-filter_threads', '1', '-f', 'rawvideo', independent]);
await tool(variant + '-original-audio-oracle', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-copyts', '-i', original,
  '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'aresample=48000:async=0:first_pts=0:dither_method=none,aformat=sample_fmts=s16:channel_layouts=stereo',
  '-ac', '2', '-ar', '48000', '-threads', '1', '-filter_threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', fullAudio]);
await tool(variant + '-preview-decode', 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', join(project, map.proxy.path),
  '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', 'scale=960:540:flags=bilinear', '-frames:v', '48', '-fps_mode', 'passthrough', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', preview]);
assert.equal(map.version, '0.2'); assert.equal(map.sourceVideo.sourceFrameCount, 624); assert.equal(map.canonical.width, 960); assert.equal(map.canonical.height, 540);
assert.equal(map.proxy.width, 512); assert.equal(map.proxy.height, 288); assert.equal(map.canonical.frames, 48); assert.equal(map.canonical.bytes, frameBytes * 48);
assert.equal(map.sourceVideo.startPts, String(epoch.video * 12000)); assert.equal(map.sourceAudio.startPts, String(epoch.audio * 48000));
assert.equal(map.coverage.audio, 'preserved'); assert.equal(map.request.mute, false); assert.equal(map.audio.samples, 96000); assert.equal(map.commands.audio.binaryBytes, 384000);
assert.deepEqual(map.sourceVideo.sourceFrames.map(frame => frame.pts), fixture.pts.slice(528, 576)); assert.deepEqual(map.frames.map(frame => frame.sourceIndex), Array.from({length:48}, (_, i) => i));
assert.equal(map.commands.decode.binaryBytes, frameBytes * 48); assert.ok(map.commands.decode.argv.includes('-ss')); assert.equal(map.commands.decode.argv[map.commands.decode.argv.indexOf('-ss') + 1], (22 + epoch.video).toFixed(9));
const expectedIdentity = await fileIdentity(independent), canonicalIdentity = await fileIdentity(join(project, map.canonical.path)); assert.equal(expectedIdentity.bytes, frameBytes * 48); assert.equal(canonicalIdentity.sha256, expectedIdentity.sha256);
assert.equal(fs.statSync(preview).size, frameBytes * 48); assert.deepEqual(JSON.parse(map.commands.proxyProbe.stdout).streams.map(stream => stream.codec_type), ['video']);
const provider = await openPreparedVideoFrames(project, map), descriptor = fs.openSync(independent, 'r'), expected = Buffer.alloc(frameBytes), canvas = new Canvas(960, 540, { gpu: false }), ctx = canvas.getContext('2d');
let worstColorError = 0;
try {
  for (let frame = 47; frame >= 0; frame--) {
    assert.equal(fs.readSync(descriptor, expected, 0, frameBytes, frame * frameBytes), frameBytes); assert.ok(provider.frame(frame).equals(expected), 'complete original frame ' + frame);
    const color = frame === 12 ? fixture.knownColors.flash12 : frame === 36 ? fixture.knownColors.flash36 : fixture.knownColors.base;
    for (let byte = 0; byte < expected.length; byte++) {const pixel=Math.floor(byte/4),x=pixel%960,y=Math.floor(pixel/960);if(x<14||x>33||y<14||y>33)worstColorError = Math.max(worstColorError, Math.abs(expected[byte] - color[byte % 4]));}
    assert.equal(map.frames[frame].sourcePts, fixture.pts[528 + frame]);
  }
  assert.ok(worstColorError <= 5, 'known source pixels exceed codec color tolerance: ' + worstColorError);
  for (const frame of [0, 12, 36, 47]) { provider.draw(ctx, frame, {x:0,y:0,width:960,height:540}, 'cover'); fs.readSync(descriptor, expected, 0, frameBytes, frame * frameBytes); assert.ok(canvas.toBufferSync('raw').equals(expected), 'delivery draw ' + frame); }
  await provider.verify();
} finally { provider.close(); fs.closeSync(descriptor); }
const contrast=frame=>{let sum=0;for(let y=20;y<28;y++)for(let x=16;x<32;x+=2)sum+=Math.abs(frame[(y*960+x)*4]-frame[(y*960+x+1)*4]);return sum/64;};
const sourceDescriptor=fs.openSync(independent,'r'),previewDescriptor=fs.openSync(preview,'r'), previewFrame=Buffer.alloc(frameBytes);fs.readSync(sourceDescriptor,expected,0,frameBytes,0);fs.readSync(previewDescriptor,previewFrame,0,frameBytes,0);fs.closeSync(sourceDescriptor);fs.closeSync(previewDescriptor);
const sourceLineContrast=contrast(expected),previewLineContrast=contrast(previewFrame);assert.ok(sourceLineContrast>80);assert.ok(previewLineContrast<sourceLineContrast*0.65,'preview amplification must lose the known source line contrast');
const pcm = fs.readFileSync(fullAudio), wav = fs.readFileSync(join(project, map.audio.path)), startSample = (22 + epoch.video) * 48000,
  selected = pcm.subarray(startSample * 4, (startSample + 96000) * 4), actual = wav.subarray(44);
assert.equal(wav.toString('ascii',0,4),'RIFF'); assert.equal(wav.readUInt32LE(4)+8,wav.length); assert.equal(wav.readUInt32LE(24),48000); assert.equal(wav.readUInt16LE(22),2);
let firstDifferentSample = null, differingSamples = 0; for (let sample = 0; sample < 96000; sample++) if (!actual.subarray(sample*4,sample*4+4).equals(selected.subarray(sample*4,sample*4+4))) { firstDifferentSample ??= sample; differingSamples++; }
const tones = fixture.knownToneSeconds.filter(time => time >= 22+epoch.video && time < 24+epoch.video).map(time => Math.round((time-22-epoch.video)*48000));
const energy = (a,b) => { let sum = 0; for(let i=a;i<b;i++) sum += actual.readInt16LE(i*4)**2; return sum/(b-a); };
const toneEnergies = tones.map(sample => {const quiet=energy(sample-2400,sample-1200);let observedSample=null;for(let position=sample-1024;position<=sample+1024;position+=64)if(energy(position,position+128)>Math.max(1000000,quiet*20)){observedSample=position;break;}
  assert.ok(observedSample!==null);return {sample,observedSample,errorSamples:observedSample-sample,toleranceSamples:1024,quiet,tone:energy(sample+256,sample+1024)};});
const report = { packageId: process.env.JBM_RUNTIME_ID, host, runtime, commands, original: await fileIdentity(original), map: await fileIdentity(join(project,selection.map)), canonical: canonicalIdentity,
  independentSelectedPixels: expectedIdentity, preview: await fileIdentity(preview), fullAudio: await fileIdentity(fullAudio), selectedAudio: await fileIdentity(join(project,map.audio.path)),
  sourceFrameCount:624, sourceSeconds:26, selectedFrames:48, sourceRange:map.request.sourceRange, canonicalSize:[960,540], previewSize:[512,288],
  completePixelEquality:true, worstColorError, sourceLineContrast,previewLineContrast,sourceSha256Unchanged:(await fileIdentity(original)).sha256===fixture.source.sha256,
  samples:96000, firstDifferentSample, differingSamples, independentSelectedPcmSha256:sha(selected), actualPcmSha256:sha(actual),
  sourceEpoch:epoch, flashSourcePts:[map.frames[12].sourcePts,map.frames[36].sourcePts], flashOutputSamples:[24000,72000], toneEnergies };
fs.writeFileSync(join(output, variant+'-oracle.json'), JSON.stringify(report,null,2)+'\n'); fs.writeFileSync(join(output,variant+'-expected-selected.pcm'),selected);
assert.equal(selected.length,384000); assert.equal(actual.length,384000); assert.equal(differingSamples,0,'complete original PCM: first mismatch '+firstDifferentSample);
assert.equal(report.sourceSha256Unchanged,true);
for(const event of toneEnergies) { assert.ok(event.quiet < 1000000); assert.ok(event.tone > 1000000); assert.ok(event.tone > event.quiet * 20); }
`;

const productionDeliveryProgram = productionPrefix + String.raw`
const selection=JSON.parse(fs.readFileSync(join(output,'delivery-selection.json'))),map=JSON.parse(fs.readFileSync(join(project,selection.map))),run=JSON.parse(fs.readFileSync(join(project,'run.json'))),
  decoded=join(output,'delivery-frames.rgba'),reference=join(output,'delivery-encoded-format.rgba'),frames=48,frameBytes=960*540*4;
const probe=JSON.parse(await tool('delivery-probe','ffprobe',['-v','error','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=width,height,codec_type,r_frame_rate:frame=pts,width,height','-of','json',join(project,selection.artifact)]));
assert.equal(probe.streams[0].width,960);assert.equal(probe.streams[0].height,540);assert.equal(probe.frames.length,frames);
await tool('delivery-decode','ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-xerror','-i',join(project,selection.artifact),'-map','0:v:0','-an','-fps_mode','passthrough','-threads','1','-pix_fmt','rgba','-f','rawvideo',decoded]);
assert.equal(run.facts.encoder.crf,0);assert.equal(run.facts.encoder.pixelFormat,'yuv420p');
await tool('delivery-format-reference','ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-xerror','-f','rawvideo','-pix_fmt','rgba','-s','960x540','-r','24','-i',join(output,'base-selected-original.rgba'),'-vf','format=yuv420p,format=rgba','-frames:v','48','-fps_mode','passthrough','-threads','1','-filter_threads','1','-c:v','rawvideo','-pix_fmt','rgba','-f','rawvideo',reference]);
assert.equal(fs.statSync(decoded).size,frameBytes*frames);assert.equal(fs.statSync(reference).size,frameBytes*frames);
const encoded=fs.openSync(decoded,'r'),source=fs.openSync(join(output,'base-selected-original.rgba'),'r'),format=fs.openSync(reference,'r'),actual=Buffer.alloc(frameBytes),expected=Buffer.alloc(frameBytes),formatted=Buffer.alloc(frameBytes);let worstPixelError=0,formatMaxError=0,sourceRgbOverEight=0,deliveryLineContrast=0;
try{for(let frame=0;frame<frames;frame++){for(const [fd,buffer]of[[encoded,actual],[source,expected],[format,formatted]])assert.equal(fs.readSync(fd,buffer,0,frameBytes,frame*frameBytes),frameBytes);for(let byte=0;byte<frameBytes;byte++){const difference=Math.abs(actual[byte]-expected[byte]);worstPixelError=Math.max(worstPixelError,difference);if(difference>8)sourceRgbOverEight++;formatMaxError=Math.max(formatMaxError,Math.abs(actual[byte]-formatted[byte]));}if(frame===0){for(let y=20;y<28;y++)for(let x=16;x<32;x+=2)deliveryLineContrast+=Math.abs(actual[(y*960+x)*4]-actual[(y*960+x+1)*4]);deliveryLineContrast/=64;}}}finally{fs.closeSync(encoded);fs.closeSync(source);fs.closeSync(format);}
const previewLineContrast=JSON.parse(fs.readFileSync(join(output,'base-oracle.json'))).previewLineContrast;
assert.equal(formatMaxError,0,'complete encoded-format reference');assert.ok(deliveryLineContrast>80&&deliveryLineContrast>previewLineContrast*10,'delivery preserves original line detail');assert.equal(map.coverage.audio,'muted');assert.equal(map.audio,null);assert.equal(run.facts.providers.bgm,'procedural');assert.deepEqual(run.facts.network,[]);assert.deepEqual(run.facts.assets.consumed,[]);
const usage=JSON.parse(fs.readFileSync(join(project,run.execution.assetUsage.path)));assert.deepEqual(usage.receipts.filter(entry=>entry.operation==='video-draw').map(entry=>[entry.frame,entry.sourcePts]),map.frames.map((frame,index)=>[index,frame.sourcePts]));
fs.writeFileSync(join(output,'delivery-oracle.json'),JSON.stringify({packageId:process.env.JBM_RUNTIME_ID,host,runtime,commands,encodedFrames:frames,checkedPixels:960*540*frames,worstPixelError,artifact:await fileIdentity(join(project,selection.artifact)),
  decoded:await fileIdentity(decoded),formatReference:await fileIdentity(reference),formatMaxError,sourceRgbOverEight,deliveryLineContrast,previewLineContrast,pixelDifferenceScope:'RGBA source remains exact in canonical; CRF0 yuv420p delivery matches the independent format roundtrip',usage:await fileIdentity(join(project,run.execution.assetUsage.path)),originalMuted:true,bgm:'procedural',network:[],externalAudioConsumption:[]},null,2)+'\n');
`;

/** Production selection has its own disk/resource policy and independent source-clock pixel/PCM oracles. */
export async function checkProductionAssetsNative({ scratch, skill, run, check }) {
  const root = join(scratch, 'production assets workspace'), core = join(root, '.skill'), project = join(root, 'projects/production-assets'), sources = join(scratch, 'production assets sources'), output = join(project,'out/asset-native-check');
  const calls = [], selections = []; let packageId, failure, status = 'running';
  const control = (args, expected = 0) => { const argv = [join(core,'scripts/video.mjs'),...args], result = run(root,argv,expected); mkdirSync(output,{recursive:true});
    const data = encoded({argv:[process.execPath,...argv],cwd:root,exitCode:expected,output:result}), path = join(output,`production-control-${String(calls.length+1).padStart(3,'0')}.json`); writeFileSync(path,data);
    calls.push({argv:[process.execPath,...argv],cwd:root,exitCode:expected,log:{path,bytes:data.length,sha256:sha(data)}}); return result; };
  const film = (args, expected = 0) => control(['production-assets',...args],expected);
  const prepare = variant => {
    writeFileSync(join(project,'production-assets-fixture.mjs'),productionFixtureProgram); film(['exec',process.execPath,'production-assets-fixture.mjs',variant]);
    cpSync(join(project,'assets',`known-${variant}.mp4`),join(sources,`known-${variant}.mp4`));
    const imported = JSON.parse(film(['import','--source',join(sources,`known-${variant}.mp4`)])), receipt = JSON.parse(film(['catalog','--import',imported.importId])); assert.equal(receipt.status,'succeeded');
    const manifest = JSON.parse(film(['catalog','--verify',receipt.catalogId])).manifest, fixture = json(join(output,variant+'-fixture.json')),
      asset = manifest.assets.find(item => item.source.sha256 === fixture.source.sha256); assert.ok(asset, 'current fictional original must be present in the cumulative catalog');
    const request = {version:'0.2',kind:'video-preparation-request',catalogId:receipt.catalogId,catalogManifestSha256:sha(readFileSync(join(project,receipt.manifestPath))),
      assetId:asset.assetId,assetVersion:asset.assetVersion,byteSha256:asset.source.sha256,streamIndex:0,fps:24,output:{width:null,height:null},
      sourceRange:{timeBase:'1/12000',startPts:String((22+fixture.epoch.video)*12000),endPts:String((24+fixture.epoch.video)*12000)}};
    writeFileSync(join(project,'inputs',variant+'-request.json'),encoded(request)); const prepared = JSON.parse(film(['video','--request','inputs/'+variant+'-request.json'])); assert.equal(prepared.status,'succeeded');
    const map = json(join(project,prepared.map.path)); assert.equal(map.request.mute,false); assert.equal(map.coverage.audio,'preserved');
    assert.equal(JSON.parse(film(['video','--verify',prepared.map.path])).ok,true);
    const selection = {variant,source:asset.source.fixedPath,map:prepared.map.path,request,prepared,asset,receipt}; selections.push(selection);
    writeFileSync(join(output,variant+'-selection.json'),encoded(selection)); writeFileSync(join(project,'production-assets-oracle.mjs'),productionOracleProgram); film(['exec',process.execPath,'production-assets-oracle.mjs',variant]);
    assert.equal(json(join(output,variant+'-oracle.json')).differingSamples,0); return selection;
  };
  try {
    await check('生产后段：26 秒/624 帧/>64 MiB 原件，960×540 交付与 512×288 预览、48 帧及完整原声样本',()=>{
      mkdirSync(root,{recursive:true}); cpSync(skill,core,{recursive:true}); mkdirSync(sources); packageId=json(join(skill,'manifest.json')).packageId;
      assert.equal(JSON.parse(control(['start','--theme','minimal','production-assets','--idea','虚构长素材后段与源时钟声画验证'])).packageId,packageId); prepare('base');
    });
    await check('独立非零音视频 epoch：leading-empty edit 的原始 PTS 与全 PCM 时钟对应',()=>{prepare('epoch');});
    await check('实际资源政策失败与保留原声的标准 render 明确 pending',()=>{
      const selection=selections[0], map=json(join(project,selection.map)), mutedRequest={...selection.request,mute:true};
      writeFileSync(join(project,'inputs/muted-request.json'),encoded(mutedRequest));const muted=JSON.parse(film(['video','--request','inputs/muted-request.json']));assert.equal(muted.status,'succeeded');const mutedMap=json(join(project,muted.map.path));
      assert.equal(mutedMap.request.mute,true);assert.equal(mutedMap.coverage.audio,'muted');assert.equal(mutedMap.audio,null);assert.equal(mutedMap.commands.audio,null);assert.equal(mutedMap.canonical.sha256,map.canonical.sha256);
      const need={needId:'NeedSource',shotId:'shot_001',purpose:'虚构原声同步选段',required:true,content:{action:null,view:null,identity:null},constraints:{durationSeconds:null,minWidth:null,minHeight:null,aspectRatio:null,transparent:null,rightsUse:null},alternative:null};
      const use={useId:'Source',needId:need.needId,shotId:need.shotId,role:'visual',catalogId:selection.receipt.catalogId,catalogManifestSha256:selection.request.catalogManifestSha256,
        assetId:selection.asset.assetId,assetVersion:selection.asset.assetVersion,byteSha256:selection.asset.source.sha256,selection:{kind:'video',map:muted.map},sourceRange:selection.request.sourceRange,crop:null,fit:'cover',mute:true};
      writeFileSync(join(project,'assets/asset-plan.json'),encoded({version:'0.2',kind:'asset-plan',needs:[need],uses:[use]})); film(['assets']);
      writeFileSync(join(project,'project.json'),encoded({...json(join(project,'project.json')),drawing:'src/production-source.mjs'}));
      writeFileSync(join(project,'src/production-source.mjs'),"export async function prepareDrawing({assets}){const clip=await assets.video('Source');return({ctx,width,height},frame)=>clip.draw(ctx,frame.frameIndex,{x:0,y:0,width,height});}\n");
      writeFileSync(join(project,'director.json'),encoded({version:'0.1',title:'虚构原声选段',idea:'原始音视频时钟校验',aspect:'16:9',look:'graphic',fps:24,bpm:120,bgmPreset:'playful',shots:[{purpose:'虚构原声选段',beats:4,title:'选段',backdrop:'studio',motif:'none',cameraMove:'static',transition:'cut',sfx:[]}]}));
      const brief=json(join(project,'brief.json')); brief.claims.pureCode=false; brief.claims.zeroExternalAssets=false; brief.assets=[{path:selection.asset.source.fixedPath,kind:'video',license:'self-created fictional fixture',sha256:selection.asset.source.sha256}]; writeFileSync(join(project,'brief.json'),encoded(brief));
      film(['direct','compile']);const render=['render','--width','960','--height','540','--crf','0','--preset','ultrafast','--no-network','--no-captions','--json'];film(render);
      const current=readFileSync(join(project,'run.json')),runData=JSON.parse(current),snapshot=json(join(project,'runs',runData.execution.attemptId,'input-snapshot.json'));
      for(const file of [selection.asset.source.fixedPath,mutedMap.canonical.path,mutedMap.proxy.path,muted.map.path])assert.ok(snapshot.files.some(entry=>entry.path===file),'frozen production input '+file);
      film(['disclosure','--json']);const artifact=JSON.parse(film(['artifact','--out','evidence/production-assets-artifact.json']));assert.equal(artifact.ok,true);assert.equal(JSON.parse(film(['artifact','--review','evidence/production-assets-artifact.json'])).ok,true);
      const artifactBytes=readFileSync(join(project,artifact.artifact.path)),unchanged=()=>{assert.deepEqual(readFileSync(join(project,'run.json')),current);assert.deepEqual(readFileSync(join(project,artifact.artifact.path)),artifactBytes);};
      writeFileSync(join(output,'delivery-selection.json'),encoded({map:muted.map.path,artifact:artifact.artifact.path}));writeFileSync(join(project,'production-delivery-oracle.mjs'),productionDeliveryProgram);film(['exec',process.execPath,'production-delivery-oracle.mjs','base']);
      const drawingPath=join(project,'src/production-source.mjs'), drawingSource=readFileSync(drawingPath);
      const changeAfterDraw=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const path=new URL('../${mutedMap.canonical.path}',import.meta.url),before=fs.lstatSync(path,{bigint:true}),lstat=fs.lstatSync,fstat=fs.fstatSync;
const frozen=s=>s.ino===before.ino&&s.dev===before.dev?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{mtimeNs:before.mtimeNs,ctimeNs:before.ctimeNs}):s;
fs.lstatSync=(...args)=>frozen(lstat(...args));fs.fstatSync=(...args)=>frozen(fstat(...args));syncBuiltinESMExports();
export async function prepareDrawing({assets}){const clip=await assets.video('Source');return({ctx,width,height},frame)=>{clip.draw(ctx,frame.frameIndex,{x:0,y:0,width,height});if(frame.frameIndex===0){const fd=fs.openSync(path,'r+'),b=Buffer.alloc(1);try{fs.readSync(fd,b,0,1,0);b[0]^=1;fs.writeSync(fd,b,0,1,0);}finally{fs.closeSync(fd);}}};}\n`;
      try {
        writeFileSync(drawingPath,changeAfterDraw);
        for(const flags of [[],['--no-run-log']]) {
          const known=new Set(readdirSync(join(project,'runs')));
          assert.match(film([...render,...flags],1),/VIDEO_CANONICAL_CHANGED/);unchanged();
          const added=readdirSync(join(project,'runs')).filter(name=>!known.has(name)&&/^[a-f0-9-]{36}$/.test(name));assert.equal(added.length,1);
          const failed=json(join(project,'runs',added[0],'receipt.json'));assert.equal(failed.status,'failed');assert.match(failed.error,/VIDEO_CANONICAL_CHANGED/);
          const usage=json(join(project,'runs',added[0],'asset-usage.json'));assert.equal(usage.receipts.filter(r=>r.operation==='video-draw').length,48,'all requested frames passed before the whole-file boundary rejected publication');
        }
      } finally {writeFileSync(drawingPath,drawingSource);}
      const limits={...map.limits,maxRgbaBytes:map.canonical.bytes-1};writeFileSync(join(project,'inputs/tight-video-policy.json'),encoded(limits));const bytes=readFileSync(join(project,selection.map)),rejected=JSON.parse(film(['video','--request','inputs/base-request.json','--limits','inputs/tight-video-policy.json'],1));
      assert.equal(rejected.status,'failed');assert.equal(rejected.map,null);assert.match(rejected.error,/VIDEO_RESOURCE_LIMIT.*selected RGBA.*(shorten|split)/);assert.deepEqual(rejected.limits,limits);assert.deepEqual(readFileSync(join(project,selection.map)),bytes);unchanged();
      use.selection.map=selection.prepared.map;use.mute=false;writeFileSync(join(project,'assets/asset-plan.json'),encoded({version:'0.2',kind:'asset-plan',needs:[need],uses:[use]}));film(['assets']);
      for(const extra of [[],['--no-audio']]){assert.match(film([...render,...extra],1),/VIDEO_ORIGINAL_AUDIO_TIMELINE_PENDING/);unchanged();}
      const accepted=selections.map(({variant,source,map,prepared})=>{const fixture=json(join(output,variant+'-fixture.json')),oracle=json(join(output,variant+'-oracle.json')),preparedMap=json(join(project,map));return{
        variant,fixture:identity(project,'out/asset-native-check/'+variant+'-fixture.json'),oracle:identity(project,'out/asset-native-check/'+variant+'-oracle.json'),source:{...fixture.source,path:source,unchanged:oracle.sourceSha256Unchanged,durationSeconds:26,frameCount:624},
        sourceRange:preparedMap.request.sourceRange,canonical:{width:960,height:540,frames:48,bytes:preparedMap.canonical.bytes,sha256:preparedMap.canonical.sha256},proxy:{width:512,height:288,bytes:preparedMap.proxy.bytes,sha256:preparedMap.proxy.sha256},
        originalAudio:{mute:false,coverage:'preserved',samples:96000,sampleRate:48000,channels:2,differingSamples:oracle.differingSamples,firstDifferentSample:oracle.firstDifferentSample,expectedPcmSha256:oracle.independentSelectedPcmSha256,actualPcmSha256:oracle.actualPcmSha256},
        completePixelEquality:oracle.completePixelEquality,sourceLineContrast:oracle.sourceLineContrast,previewLineContrast:oracle.previewLineContrast,
        epoch:{videoPts:preparedMap.sourceVideo.startPts,videoTimeBase:preparedMap.sourceVideo.timeBase,audioPts:preparedMap.sourceAudio.startPts,audioTimeBase:preparedMap.sourceAudio.timeBase},
        events:{flashSourcePts:oracle.flashSourcePts,flashOutputFrames:[12,36],flashOutputSamples:[24000,72000],toneOutputSamples:oracle.toneEnergies.map(event=>event.sample),toneObservedSamples:oracle.toneEnergies.map(event=>event.observedSample),toneErrors:oracle.toneEnergies.map(event=>event.errorSamples),toleranceSamples:1024,
          originalToneMinusFlashSeconds:fixture.epoch.audio-fixture.epoch.video,selectedToneMinusFirstFlashSeconds:oracle.toneEnergies[0].sample/48000-0.5},publication:prepared.map};});
      writeFileSync(join(output,'production-acceptance.json'),encoded({version:'0.1',kind:'production-video-acceptance',packageId,status:'passed',sources:accepted,
        explicitMute:{request:identity(project,'inputs/muted-request.json'),publication:muted.map,coverage:'muted',audio:null,canonicalEqualsUnmuted:true},delivery:identity(project,'out/asset-native-check/delivery-oracle.json'),
        previousCurrent:{path:'run.json',sha256:sha(current),attemptId:runData.execution.attemptId,artifact:artifact.artifact,unchangedAfterResourceFailure:true,unchangedAfterPending:true},
        resourceFailure:{receipt:identity(project,'runs/'+rejected.attemptId+'/receipt.json'),limits,error:rejected.error,shortenOrSplitAvailable:true},pending:{code:'VIDEO_ORIGINAL_AUDIO_TIMELINE_PENDING',defaultUnmuted:true,noAudioFlag:true},wholeProcessLibraryRss:'unmeasured',
        pcmEqualityScope:'deterministic AAC LC fixture with aac_pns=0; arbitrary AAC seeks can differ from full decoding in decoder noise/quantization history; same-argv replay retains strict derived SHA',scope:'P2 sidecar and explicit-muted delivery; original-audio placement/mix pending P4'}));
      writeFileSync(join(output,'production-control-report.json'),encoded({packageId,calls,selections:selections.map(({variant,source,map})=>({variant,source,map})),
        scope:'P2 file-backed selection and source-aligned audio sidecar; production clip placement and original-audio final mix remain pending in P4',status:'passed'}));
    }); status='passed';
  } catch(error) {status='failed';failure=error;throw error;}
  finally {
    const archive=join(dirname(scratch),'assets-production-native-evidence',randomUUID());
    try {
      mkdirSync(archive,{recursive:true}); if(existsSync(project)){mkdirSync(output,{recursive:true});writeFileSync(join(output,'production-calls.json'),encoded(calls));cpSync(project,join(archive,'project'),{recursive:true,filter:path=>!['.engine','guide'].includes(path.split('/').at(-1))});}
      if(existsSync(sources))cpSync(sources,join(archive,'sources'),{recursive:true});cpSync(join(skill,'scripts/assets-native-check.mjs'),join(archive,'assets-native-check.mjs'));
      const files=[]; async function visit(directory){for(const item of readdirSync(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await visit(path);else{const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);files.push({path:path.slice(archive.length+1),bytes:statSync(path).size,sha256:digest.digest('hex')});}}}
      await visit(archive);writeFileSync(join(archive,'archive.json'),encoded({version:'0.1',kind:'assets-production-native-evidence',packageId:packageId??null,status,error:failure?String(failure):null,origin:{skill,project,sources},files}));
      process.stdout.write('ASSETS_PRODUCTION_NATIVE_EVIDENCE:'+archive+'\n');
    } catch(error){if(failure)process.stderr.write('ASSETS_PRODUCTION_NATIVE_ARCHIVE_FAILED:'+String(error)+'\n');else throw error;}
  }
}
