import { randomUUID } from 'node:crypto';
import { open, rm, readdir, rename } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { NodeImportFiles, importJsonText, sameImportNode } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { prepareVideoInput, verifyPreparedVideoInput } from '../adapters/video-prepare.ts';
import { assertCatalog, type CatalogIndex } from '../project/catalog.ts';
import { videoPreparationLimits, validateVideoPreparationRequest, validatePreparedVideoMap, type VideoPreparationRequest,
  type VideoPreparationLimits, type PreparedVideoMap } from '../project/video-preparation.ts';
import { productionVideoPreparationLimits, DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, type AnyVideoPreparationLimits } from '../project/video-preparation.ts';
import { validateVideoReceipt, type VideoPreparationReceipt } from '../project/video-preparation.ts';
import { UUID_PATTERN } from '../project/unpack.ts';
import { readAssetFile, assetHash } from './asset-plan.ts';
import { verifyCatalog } from './catalog.ts';
import { readVideoPublication } from './video-publication.ts';

type VideoReceipt = VideoPreparationReceipt;
export interface VideoOptions { signal?: AbortSignal; limits?: AnyVideoPreparationLimits; hooks?: {
  afterProvider?: (receipt: VideoReceipt) => Promise<void>; afterPrepared?: (receipt: VideoReceipt) => Promise<void>;
  afterPublished?: (receipt: VideoReceipt) => Promise<void> } }
const active = new Set<string>();
function alive(pid: number, attemptId: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error('VIDEO_OWNER_INVALID');
  if (pid === process.pid) return active.has(attemptId);
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function catalogSource(projectDir: string, request: VideoPreparationRequest, limits: AnyVideoPreparationLimits, signal?: AbortSignal) {
  const index = assertCatalog<CatalogIndex>('index', JSON.parse((await readAssetFile(projectDir, 'assets/catalog.json', 8388608)).data.toString('utf8')));
  const commits = index.catalogs.filter(c => c.catalogId === request.catalogId);
  if (commits.length !== 1 || commits[0]!.manifestSha256 !== request.catalogManifestSha256) throw Error('VIDEO_CATALOG_NOT_COMMITTED');
  const catalog = await verifyCatalog(projectDir, request.catalogId, { signal }); signal?.throwIfAborted();
  const file = await readAssetFile(projectDir, `assets/catalogs/${request.catalogId}/manifest.json`, 8388608);
  if (file.sha256 !== request.catalogManifestSha256 || catalog.attemptId !== commits[0]!.attemptId) throw Error('VIDEO_CATALOG_CHANGED');
  const assets = catalog.assets.filter(a => a.assetId === request.assetId && a.assetVersion === request.assetVersion && a.source.sha256 === request.byteSha256);
  if (assets.length !== 1 || assets[0]!.technical.format !== 'mov') throw Error('VIDEO_SOURCE_UNSUPPORTED');
  const asset = assets[0]!;
  if (!/^inputs\/(?:original|unpacked)\//.test(asset.source.fixedPath)) throw Error('VIDEO_SOURCE_PATH_INVALID');
  if (request.version === '0.2' && asset.source.bytes > limits.maxSourceBytes)
    throw Error(`VIDEO_SOURCE_RESOURCE_LIMIT: source=${asset.source.bytes} bytes; maxSourceBytes=${limits.maxSourceBytes} bytes. Raise maxSourceBytes in the adopted video limits after checking disk and time budgets, or import a selected original-quality segment while retaining this original.`);
  await readAssetFile(projectDir, asset.source.fixedPath, limits.maxSourceBytes,
    { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: request.byteSha256 }, { retain: false, signal });
  return asset;
}
const mapPath = (value: string) => new RegExp(`^assets/derived/video/${UUID_PATTERN}/map\\.json$`).test(value);
export async function verifyVideoPreparation(projectDir: string, path: string, options: Pick<VideoOptions, 'signal' | 'limits'> = {}): Promise<PreparedVideoMap> {
  if (!mapPath(path)) throw Error('VIDEO_MAP_PATH_INVALID');
  const file = await readAssetFile(projectDir, path, options.limits?.maxMapBytes ?? DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS.maxMapBytes),
    map = validatePreparedVideoMap(JSON.parse(file.data.toString('utf8')), options.limits);
  await readVideoPublication(projectDir, path, file.data);
  if (map.canonical.path !== path.replace(/map\.json$/, 'frames.rgba')) throw Error('VIDEO_MAP_PATH_INVALID');
  const asset = await catalogSource(projectDir, map.request, map.limits, options.signal), check = () => options.signal?.throwIfAborted();
  await verifyPreparedVideoInput(join(projectDir, asset.source.fixedPath), map, { projectDir, temporaryDir: join(projectDir, 'out/.tmp'),
    limits: map.limits, signal: options.signal, check, publishedDir: path.replace(/\/map\.json$/, '') });
  check(); return map;
}

/** Publish a unique immutable prepared directory; earlier preparations remain independent of this attempt. */
export async function prepareVideo(projectDir: string, input: unknown, options: VideoOptions = {}): Promise<VideoReceipt> {
  const request = validateVideoPreparationRequest(input), limits = request.version === '0.2' ? productionVideoPreparationLimits(options.limits)
    : videoPreparationLimits(options.limits) as VideoPreparationLimits, uuid = randomUUID(), attemptId = `video-attempt-${randomUUID()}`;
  if (request.version === '0.1' && 'version' in limits) throw Error('VIDEO_LEGACY_POLICY_INVALID');
  const tempPath = `out/.tmp/${attemptId}`, temporaryDir = resolve(projectDir, tempPath), files = new NodeImportFiles(projectDir, temporaryDir);
  const lease = new ProjectLease(projectDir, temporaryDir, 'video'), run = `runs/${attemptId}/receipt.json`, publishedDir = `assets/derived/video/${uuid}`;
  const receipt: VideoReceipt = { version: request.version, kind: 'video-preparation-receipt', attemptId, videoId: `video-${uuid}`, ownerPid: process.pid,
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null, request, tempPath, map: null, error: null,
    ...(request.version === '0.2' ? { limits: productionVideoPreparationLimits(limits) } : {}) };
  let lock: string | null = null, published = false;
  const check = () => options.signal?.throwIfAborted();
  await files.assertProject(); await files.ensureDirectory(temporaryDir); active.add(attemptId);
  try {
    check(); lock = await lease.acquireLock({ attemptId, videoId: receipt.videoId, pid: process.pid }, alive, options.signal);
    await files.writeJson(join(projectDir, run), receipt);
    const asset = await catalogSource(projectDir, request, limits, options.signal), source = files.projectPath(join(projectDir, asset.source.fixedPath)), node = await files.inspect(source);
    const prepared = await prepareVideoInput(source, request, { projectDir, temporaryDir, limits, signal: options.signal, check, publishedDir });
    await options.hooks?.afterProvider?.(structuredClone(receipt)); check();
    const map = validatePreparedVideoMap(prepared.map, limits), encoded = Buffer.from(importJsonText(map));
    if (encoded.length > limits.maxMapBytes || map.version !== request.version || map.canonical.path !== `${publishedDir}/frames.rgba` || map.proxy.path !== `${publishedDir}/proxy.mp4` ||
        JSON.stringify(map.request) !== JSON.stringify(request) || JSON.stringify(map.limits) !== JSON.stringify(limits)) throw Error('VIDEO_PROVIDER_BINDING_INVALID');
    await readAssetFile(projectDir, asset.source.fixedPath, limits.maxSourceBytes, { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: request.byteSha256 }, { retain: false, signal: options.signal });
    if (!sameImportNode(node, await files.inspect(source))) throw Error('VIDEO_SOURCE_CHANGED');
    const stage = join(temporaryDir, 'prepared'); await files.ensureDirectory(stage);
    const mapHandle = await open(files.projectPath(join(stage, 'map.json')), 'wx', 0o600);
    try { await mapHandle.writeFile(encoded); await mapHandle.sync(); } finally { await mapHandle.close(); }
    if (map.version === '0.1') {
      if (!('rgba' in prepared) || assetHash(prepared.rgba) !== map.canonical.sha256 || prepared.rgba.length !== map.canonical.bytes ||
          assetHash(prepared.proxy) !== map.proxy.sha256 || prepared.proxy.length !== map.proxy.bytes) throw Error('VIDEO_PROVIDER_BINDING_INVALID');
      for (const [name, data] of [['frames.rgba', prepared.rgba], ['proxy.mp4', prepared.proxy]] as const) {
        const handle = await open(files.projectPath(join(stage, name)), 'wx', 0o600); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      }
    } else {
      if (!('files' in prepared) || (map.audio !== null) !== (prepared.files.audio !== null)) throw Error('VIDEO_PROVIDER_BINDING_INVALID');
      const outputs = [[prepared.files.canonical, map.canonical], [prepared.files.proxy, map.proxy],
        ...(map.audio ? [[prepared.files.audio, map.audio]] : [])] as const;
      for (const [providerPath, identity] of outputs) {
        if (typeof providerPath !== 'string' || resolve(providerPath) !== providerPath || !providerPath.startsWith(temporaryDir + sep)) throw Error('VIDEO_PROVIDER_PATH_INVALID');
        const sourceNode = await files.inspect(files.projectPath(providerPath));
        if (sourceNode.kind !== 'file' || sourceNode.nlink !== '1') throw Error('VIDEO_PROVIDER_FILE_INVALID');
        const target = join(stage, identity.path.split('/').at(-1)!);
        try { await files.inspect(target); throw Error('VIDEO_PROVIDER_DESTINATION_EXISTS'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        await readAssetFile(projectDir, providerPath.slice(resolve(projectDir).length + 1), identity.bytes, { ...identity, path: providerPath.slice(resolve(projectDir).length + 1) }, { retain: false, signal: options.signal });
        if (!sameImportNode(sourceNode, await files.inspect(providerPath))) throw Error('VIDEO_PROVIDER_CHANGED');
        await rename(providerPath, target);
        const fd = await open(target, 'r'); try { await fd.sync(); } finally { await fd.close(); }
        await readAssetFile(projectDir, target.slice(resolve(projectDir).length + 1), identity.bytes, { ...identity, path: target.slice(resolve(projectDir).length + 1) }, { retain: false, signal: options.signal });
      }
    }
    receipt.map = { path: `${publishedDir}/map.json`, bytes: encoded.length, sha256: assetHash(encoded) }; receipt.status = 'prepared';
    await files.writeJson(join(projectDir, run), receipt); await options.hooks?.afterPrepared?.(structuredClone(receipt)); check();
    const completed = validateVideoReceipt({ ...receipt, status: 'succeeded', finishedAt: new Date().toISOString() }), completedData = Buffer.from(importJsonText(completed));
    const publication = { version: request.version, kind: 'prepared-video-publication', receipt: { path: run, bytes: completedData.length, sha256: assetHash(completedData) } };
    const marker = await open(files.projectPath(join(stage, 'publication.json')), 'wx', 0o600);
    try { await marker.writeFile(importJsonText(publication)); await marker.sync(); } finally { await marker.close(); }
    await files.moveDirectory(stage, join(projectDir, publishedDir)); published = true;
    await options.hooks?.afterPublished?.(structuredClone(receipt)); check();
    Object.assign(receipt, completed); await files.writeJson(join(projectDir, run), receipt);
    return receipt;
  } catch (error) {
    receipt.status = options.signal?.aborted ? 'interrupted' : 'failed'; receipt.error = error instanceof Error ? error.message : String(error); receipt.finishedAt = new Date().toISOString();
    if (published) await rm(files.projectPath(join(projectDir, publishedDir)), { recursive: true, force: true });
    await files.writeJson(join(projectDir, run), receipt); return receipt;
  } finally {
    if (lock) await lease.releaseLock(lock, attemptId); active.delete(attemptId); await rm(files.projectPath(temporaryDir), { recursive: true, force: true });
  }
}

export async function recoverVideoAttempts(projectDir: string): Promise<VideoReceipt[]> {
  const recoveryId = `video-attempt-${randomUUID()}`, temporaryDir = join(projectDir, `out/.tmp/${recoveryId}`),
    files = new NodeImportFiles(projectDir, temporaryDir), lease = new ProjectLease(projectDir, temporaryDir, 'video'), recovered: VideoReceipt[] = [];
  await files.assertProject(); await files.ensureDirectory(temporaryDir); active.add(recoveryId);
  let lock: string | null = null;
  try {
    lock = await lease.acquireLock({ attemptId: recoveryId, videoId: `video-${randomUUID()}`, pid: process.pid }, alive);
    let names: string[]; try { names = await readdir(files.projectPath(join(projectDir, 'runs'))); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    if (names.length > 10000) throw Error('VIDEO_RECOVERY_LIMIT');
    for (const name of names.filter(n => new RegExp(`^video-attempt-${UUID_PATTERN}$`).test(n)).sort()) {
      const raw = await readAssetFile(projectDir, `runs/${name}/receipt.json`, 8388608), receipt = validateVideoReceipt(JSON.parse(raw.data.toString('utf8')));
      if (receipt.attemptId !== name) throw Error('VIDEO_RECOVERY_INVALID');
      if (!['running', 'prepared'].includes(receipt.status) || alive(receipt.ownerPid, name)) continue;
      const abandoned = join(projectDir, receipt.tempPath), writer = new NodeImportFiles(projectDir, temporaryDir);
      const published = `assets/derived/video/${receipt.videoId.slice(6)}`;
      try {
        const marker = JSON.parse((await readAssetFile(projectDir, `${published}/publication.json`, 8388608)).data.toString('utf8'));
        if (marker.kind !== 'prepared-video-publication' || marker.receipt?.path !== `runs/${name}/receipt.json` || !receipt.map) throw Error('VIDEO_RECOVERY_PUBLICATION_MISMATCH');
        await readAssetFile(projectDir, receipt.map.path, receipt.limits?.maxMapBytes ?? 8388608, receipt.map);
        await rm(writer.projectPath(join(projectDir, published)), { recursive: true });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      receipt.status = 'interrupted'; receipt.finishedAt = new Date().toISOString(); receipt.error = 'VIDEO_OWNER_INTERRUPTED';
      await writer.writeJson(join(projectDir, `runs/${name}/receipt.json`), receipt); recovered.push(receipt);
      await rm(writer.projectPath(abandoned), { recursive: true, force: true });
    }
    return recovered;
  } finally { if (lock) await lease.releaseLock(lock, recoveryId); active.delete(recoveryId); await rm(files.projectPath(temporaryDir), { recursive: true, force: true }); }
}
