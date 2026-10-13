import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Canvas } from 'skia-canvas';
import { createAssetPort } from '../src/adapters/asset-port.ts';
import { assetNeedGaps, type PreparedAssetPlan } from '../src/application/asset-plan.ts';
import { loadProjectDrawing } from '../src/project/drawing.ts';
import type { ProjectHandle } from '../src/project/manifest.ts';
import type { AssetVersion, CatalogManifest } from '../src/project/catalog.ts';
import type { AssetPlan, AssetUse } from '../src/project/asset-plan.ts';
import { validateVideoReceipt } from '../src/project/video-preparation.ts';

const id = '11111111-1111-4111-8111-111111111111', hash = 'a'.repeat(64);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const execution = { attemptId: id, inputSnapshotSha256: hash };
async function fixture(empty = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asset-port-')));
  const canvas = new Canvas(4, 2), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 2, 2); ctx.fillStyle = '#0000ff'; ctx.fillRect(2, 0, 2, 2);
  const data = empty ? Buffer.alloc(0) : await canvas.toBuffer('png');
  const path = `inputs/original/import-${id}/${empty ? 'empty.txt' : 'picture.png'}`;
  mkdirSync(join(root, `inputs/original/import-${id}`), { recursive: true }); writeFileSync(join(root, path), data);
  const use: AssetUse = { useId: 'Picture', needId: 'Subject', shotId: 'ShotA', role: 'visual', catalogId: `catalog-${id}`,
    catalogManifestSha256: hash, assetId: `asset-${id}`, assetVersion: `asset-version-${id}`, byteSha256: digest(data),
    selection: { kind: 'source' }, sourceRange: null, crop: { x: 0.5, y: 0, width: 0.5, height: 1 }, fit: 'contain', mute: true };
  const plan: AssetPlan = { version: '0.1', kind: 'asset-plan', needs: [{ needId: 'Subject', shotId: 'ShotA', purpose: 'Known source half', required: true,
    content: { action: null, view: null, identity: null }, constraints: { durationSeconds: null, minWidth: null, minHeight: null, aspectRatio: null, transparent: null, rightsUse: null }, alternative: null }], uses: [use] };
  // The adapter consumes this subset of a catalog already checked by prepareAssetPlan.
  const asset = { assetId: use.assetId, assetVersion: use.assetVersion, source: { fixedPath: path, bytes: data.length, sha256: use.byteSha256 },
    technical: { format: empty ? 'utf8' : 'png_pipe', status: 'supported', reason: '', containerDuration: null,
      streams: [{ type: 'video', width: 4, height: 2 }] } } as AssetVersion;
  const catalog = { rights: [] } as unknown as CatalogManifest;
  const prepared: PreparedAssetPlan = { plan, identity: { path: 'assets/asset-plan.json', bytes: 1, sha256: hash },
    bindings: [{ use, asset, catalog, video: null }], mediaPaths: [path], gaps: [] };
  return { root, data, path, prepared, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('AssetPort image preparation preserves known cropped pixels, transform and exact successful receipts', async () => {
  const f = await fixture(), assets = createAssetPort(f.root, f.prepared, execution);
  try {
    const image = await assets.port.image('Picture'); assert.equal(await assets.port.image('Picture'), image); assert.ok(Object.isFrozen(image));
    const canvas = new Canvas(4, 2), ctx = canvas.getContext('2d'); ctx.translate(2, 0);
    image.draw(ctx, { x: 0, y: 0, width: 2, height: 2 });
    assert.deepEqual(Array.from(ctx.getImageData(2, 0, 1, 1).data), [0, 0, 255, 255]);
    assert.equal(ctx.getImageData(0, 0, 1, 1).data[3], 0); assert.equal(ctx.getTransform().e, 2);
    const usage = assets.usage(); assert.deepEqual(usage.receipts.map(r => r.operation), ['prepared-read', 'image-draw']);
    for (const r of usage.receipts) { assert.equal(r.byteSha256, digest(f.data)); assert.equal(r.catalogManifestSha256, hash);
      assert.equal(r.source.path, f.path); assert.deepEqual(r.source, r.selected); assert.equal(r.derivedMap, null); }
    usage.receipts.length = 0; assert.equal(assets.usage().receipts.length, 2);
    assert.throws(() => image.draw(ctx, { x: 0, y: 0, width: 0, height: 2 }), /TARGET_INVALID/); assert.equal(assets.usage().receipts.length, 2);
    assets.close(); assert.throws(() => image.draw(ctx, { x: 0, y: 0, width: 2, height: 2 }), /CLOSED/);
  } finally { assets.close(); f.cleanup(); }
});

test('AssetPort rejects source changes before a receipt and retains the prepared image bytes after loading', async () => {
  const f = await fixture(), failed = createAssetPort(f.root, f.prepared, execution);
  try {
    const changed = Buffer.from(f.data); changed[changed.length - 1] ^= 1; writeFileSync(join(f.root, f.path), changed);
    await assert.rejects(failed.port.image('Picture'), /FILE_CHANGED/); assert.equal(failed.usage().receipts.length, 0);
    writeFileSync(join(f.root, f.path), f.data); const image = await failed.port.image('Picture'); writeFileSync(join(f.root, f.path), changed);
    const canvas = new Canvas(2, 2); image.draw(canvas.getContext('2d'), { x: 0, y: 0, width: 2, height: 2 });
    assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data), [0, 0, 255, 255]);
    assert.equal(failed.usage().receipts.at(-1)!.byteSha256, digest(f.data));
  } finally { failed.close(); f.cleanup(); }
});

test('AssetPort reads empty fixed text, records its actual zero bytes, and keeps unknown IO explicit', async () => {
  const f = await fixture(true), assets = createAssetPort(f.root, f.prepared, execution);
  try {
    assert.equal((await assets.port.read('Picture')).length, 0); const usage = assets.usage();
    assert.equal(usage.receipts[0]!.source.bytes, 0); assert.equal(usage.coverage, 'partial'); assert.ok(usage.unknownRemainder.length);
    assert.equal(assets.usage(true).coverage, 'partial'); await assert.rejects(assets.port.read('Unknown'), /USE_UNKNOWN/);
    assets.close(); await assert.rejects(assets.port.read('Picture'), /CLOSED/);
    const builtin = createAssetPort(f.root, null, execution); assert.equal(builtin.usage(true).coverage, 'complete'); builtin.close();
  } finally { assets.close(); f.cleanup(); }
});

test('Production photo drawing adopts catalog pixels independently of the frozen OCR budget', async () => {
  const f = await fixture();
  const canvas = new Canvas(4096, 4096, { gpu: false }), context = canvas.getContext('2d');
  context.fillStyle = '#0000ff'; context.fillRect(0, 0, canvas.width, canvas.height);
  const data = await canvas.toBuffer('png'), binding = f.prepared.bindings[0]!;
  writeFileSync(join(f.root, f.path), data); binding.asset.source.bytes = data.length;
  binding.use.byteSha256 = binding.asset.source.sha256 = digest(data);
  binding.use.crop = null;
  binding.catalog.policy = { maxSourceBytes: 1073741824, maxSourcePixels: 40000000 } as CatalogManifest['policy'];
  const legacy = createAssetPort(f.root, f.prepared, execution);
  let production;
  try {
    await assert.rejects(legacy.port.image('Picture'), /OCR_PIXEL_LIMIT/);
    assert.equal(legacy.usage().receipts.length, 0); f.prepared.plan.version = '0.2';
    production = createAssetPort(f.root, f.prepared, execution);
    const image = await production.port.image('Picture'); assert.equal(image.width, 4096); assert.equal(image.height, 4096);
    const output = new Canvas(2, 2, { gpu: false }); image.draw(output.getContext('2d'), { x: 0, y: 0, width: 2, height: 2 });
    assert.deepEqual([...output.getContext('2d').getImageData(0, 0, 1, 1).data], [0, 0, 255, 255]);
    assert.equal(production.usage().receipts.at(-1)!.byteSha256, digest(data));
    binding.catalog.policy.maxSourcePixels = 16000000;
    const limited = createAssetPort(f.root, f.prepared, execution);
    try { await assert.rejects(limited.port.image('Picture'), /ASSET_IMAGE_RESOURCE_LIMIT.*catalog pixel budget=16000000.*Prepare a delivery-size/); }
    finally { limited.close(); }
  } finally { legacy.close(); production?.close(); f.cleanup(); }
});

test('Asset needs evaluate the selected crop, rights and semantic review independently', async () => {
  const f = await fixture(); try {
    const need = f.prepared.plan.needs[0]!; need.constraints.minWidth = 3; need.constraints.rightsUse = 'publish'; need.content.identity = 'Known character';
    const codes = assetNeedGaps(f.prepared.plan, f.prepared.bindings).map(g => g.code);
    assert.deepEqual(codes, ['dimensions', 'rights', 'semantic', 'composition', 'continuity']);
    f.prepared.plan.uses[0]!.crop = null;
    assert.equal(assetNeedGaps(f.prepared.plan, f.prepared.bindings).some(g => g.code === 'dimensions'), false);
  } finally { f.cleanup(); }
});

test('Drawing awaits preparation and rejects asynchronous frame results before encoding', async () => {
  const f = await fixture(), assets = createAssetPort(f.root, f.prepared, execution);
  try {
    mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src/draw.mjs'), "export async function prepareDrawing({assets}) { const image=await assets.image('Picture'); return (context) => image.draw(context.ctx,{x:0,y:0,width:2,height:2}); }");
    const project = { dir: f.root, manifest: { drawing: 'src/draw.mjs' } } as ProjectHandle, drawer = await loadProjectDrawing(project, assets.port);
    const canvas = new Canvas(2, 2); drawer!({ ctx: canvas.getContext('2d') } as never, {} as never);
    assert.deepEqual(Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data), [0, 0, 255, 255]);
    writeFileSync(join(f.root, 'src/async.mjs'), 'export function drawScene() { return Promise.resolve(); }'); project.manifest.drawing = 'src/async.mjs';
    const invalid = await loadProjectDrawing(project, assets.port); assert.throws(() => invalid!({} as never, {} as never), /ASYNC_FRAME_REJECTED/);
  } finally { assets.close(); f.cleanup(); }
});

test('Video receipt ownership binds its preparation directory, map and terminal status', () => {
  const tuple = { catalogId: `catalog-${id}`, catalogManifestSha256: hash, assetId: `asset-${id}`, assetVersion: `asset-version-${id}`, byteSha256: hash };
  const receipt = { version: '0.1', kind: 'video-preparation-receipt', attemptId: `video-attempt-${id}`, videoId: `video-${id}`, ownerPid: 1,
    status: 'succeeded', startedAt: 'fixture-start', finishedAt: 'fixture-end', request: { version: '0.1', kind: 'video-preparation-request', ...tuple,
      streamIndex: 0, fps: 12, sourceRange: { timeBase: '1/1200', startPts: '0', endPts: '100' } },
    tempPath: `out/.tmp/video-attempt-${id}`, map: { path: `assets/derived/video/${id}/map.json`, bytes: 1, sha256: hash }, error: null };
  validateVideoReceipt(receipt);
  for (const change of [{ tempPath: 'out/.tmp/other' }, { finishedAt: null }, { map: null }, { error: 'late failure' },
    { map: { ...receipt.map, path: 'assets/derived/video/other/map.json' } }]) assert.throws(() => validateVideoReceipt({ ...receipt, ...change }), /INVALID/);
  assert.throws(() => validateVideoReceipt({ ...receipt, status: 'prepared' }), /INVALID/);
  assert.throws(() => validateVideoReceipt({ ...receipt, status: 'failed' }), /INVALID/);
});
