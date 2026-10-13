import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { NodeImportFiles } from '../adapters/import-files.ts';
import { readFixed } from '../adapters/inspection.ts';
import { assertCatalog, safeCatalogPath, type CatalogIndex, type CatalogManifest, type AssetVersion } from '../project/catalog.ts';
import { validateAssetPlan, type AssetPlan, type AssetUse, type AssetGap, type AssetFileIdentity } from '../project/asset-plan.ts';
import { DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS, validatePreparedVideoMap, type PreparedVideoMap } from '../project/video-preparation.ts';
import { verifyCatalog } from './catalog.ts';
import { readVideoPublication } from './video-publication.ts';

export const DEFAULT_ASSET_PLAN_PATH = 'assets/asset-plan.json';
export const assetHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function readAssetFile(projectDir: string, path: string, maximum: number, expected?: AssetFileIdentity,
  options: { retain?: boolean; signal?: AbortSignal } = {}) {
  if (!safeCatalogPath(path)) throw Error('ASSET_PATH_INVALID');
  const raw = await readFixed(new NodeImportFiles(projectDir).projectPath(join(projectDir, path)), maximum, options.signal, undefined, options.retain ?? true);
  if (expected && (path !== expected.path || raw.bytes !== expected.bytes || raw.sha256 !== expected.sha256)) throw Error('ASSET_FILE_CHANGED: ' + path);
  return { ...raw, identity: { path, bytes: raw.bytes, sha256: raw.sha256 } };
}
export interface AssetBinding { use: AssetUse; asset: AssetVersion; catalog: CatalogManifest; video: PreparedVideoMap | null }
export interface PreparedAssetPlan { plan: AssetPlan; identity: AssetFileIdentity; bindings: AssetBinding[]; mediaPaths: string[]; gaps: AssetGap[] }
const json = (data: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data));

/** Check a committed catalog before freezing its exact manifest and selected byte identities. */
export async function prepareAssetPlan(projectDir: string, path = DEFAULT_ASSET_PLAN_PATH): Promise<PreparedAssetPlan> {
  if (!/^assets\/(?:[^/]+\/)*[^/]+\.json$/.test(path) || !safeCatalogPath(path)) throw Error('ASSET_PLAN_PATH_INVALID');
  const raw = await readAssetFile(projectDir, path, 4194304), plan = validateAssetPlan(json(raw.data));
  const index = plan.uses.length ? assertCatalog<CatalogIndex>('index', json((await readAssetFile(projectDir, 'assets/catalog.json', 8388608)).data)) : null;
  const catalogs = new Map<string, CatalogManifest>(), bindings: AssetBinding[] = [], paths = new Set([path, ...(index ? ['assets/catalog.json'] : [])]);
  for (const use of plan.uses) {
    let catalog = catalogs.get(use.catalogId);
    const manifestPath = `assets/catalogs/${use.catalogId}/manifest.json`;
    if (!catalog) {
      const commit = index!.catalogs.filter(c => c.catalogId === use.catalogId);
      if (commit.length !== 1 || commit[0]!.manifestSha256 !== use.catalogManifestSha256) throw Error('ASSET_CATALOG_NOT_COMMITTED');
      catalog = await verifyCatalog(projectDir, use.catalogId);
      const manifest = await readAssetFile(projectDir, manifestPath, 8388608);
      if (manifest.sha256 !== use.catalogManifestSha256 || catalog.attemptId !== commit[0]!.attemptId) throw Error('ASSET_CATALOG_CHANGED');
      catalogs.set(use.catalogId, catalog);
    }
    const manifest = await readAssetFile(projectDir, manifestPath, 8388608);
    if (manifest.sha256 !== use.catalogManifestSha256) throw Error('ASSET_CATALOG_CHANGED');
    const assets = catalog.assets.filter(a => a.assetId === use.assetId && a.assetVersion === use.assetVersion && a.source.sha256 === use.byteSha256);
    if (assets.length !== 1) throw Error('ASSET_VERSION_MISMATCH');
    const asset = assets[0]!;
    if (!/^inputs\/(?:original|unpacked)\//.test(asset.source.fixedPath)) throw Error('ASSET_SOURCE_PATH_INVALID');
    await readAssetFile(projectDir, asset.source.fixedPath, plan.version === '0.2' ? catalog.policy.maxSourceBytes : 67108864,
      { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: use.byteSha256 }, { retain: false });
    paths.add(manifestPath); paths.add(asset.source.fixedPath);
    let video: PreparedVideoMap | null = null;
    if (use.selection.kind === 'video') {
      const mapFile = await readAssetFile(projectDir, use.selection.map.path,
        plan.version === '0.2' ? DEFAULT_PRODUCTION_VIDEO_PREPARATION_LIMITS.maxMapBytes : 8388608, use.selection.map);
      video = validatePreparedVideoMap(json(mapFile.data));
      const publication = await readVideoPublication(projectDir, use.selection.map.path, mapFile.data);
      paths.add(publication.path); paths.add(publication.value.receipt.path);
      const r = video.request;
      if (r.catalogId !== use.catalogId || r.catalogManifestSha256 !== use.catalogManifestSha256 || r.assetId !== use.assetId ||
          r.assetVersion !== use.assetVersion || r.byteSha256 !== use.byteSha256 || JSON.stringify(r.sourceRange) !== JSON.stringify(use.sourceRange)) throw Error('ASSET_VIDEO_BINDING_INVALID');
      if (!use.mute && video.coverage.audio === 'muted') throw Error('ASSET_VIDEO_AUDIO_UNAVAILABLE: prepare this source range with video request 0.2 and mute=false.');
      const { verifyPreparedVideoInput } = await import('../adapters/video-prepare.ts');
      await verifyPreparedVideoInput(join(projectDir, asset.source.fixedPath), video, { projectDir,
        temporaryDir: join(projectDir, 'out/.tmp'), limits: video.limits, check() {}, publishedDir: video.canonical.path.replace(/\/frames\.rgba$/, '') });
      paths.add(use.selection.map.path); paths.add(video.canonical.path); paths.add(video.proxy.path);
      if (video.version === '0.2' && video.audio) paths.add(video.audio.path);
    }
    bindings.push({ use, asset, catalog, video });
  }
  return { plan, identity: raw.identity, bindings, mediaPaths: [...paths].sort(), gaps: assetNeedGaps(plan, bindings) };
}

export async function assertAssetPlanSnapshot(projectDir: string, prepared: PreparedAssetPlan): Promise<void> {
  await readAssetFile(projectDir, prepared.identity.path, 4194304, prepared.identity);
  for (const { use, asset, catalog, video } of prepared.bindings) {
    const path = `assets/catalogs/${use.catalogId}/manifest.json`, manifest = await readAssetFile(projectDir, path, 8388608);
    if (manifest.sha256 !== use.catalogManifestSha256) throw Error('ASSET_CATALOG_CHANGED');
    await readAssetFile(projectDir, asset.source.fixedPath, prepared.plan.version === '0.2' ? catalog.policy.maxSourceBytes : 67108864,
      { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: use.byteSha256 }, { retain: false });
    if (use.selection.kind === 'video' && video) {
      const mapFile = await readAssetFile(projectDir, use.selection.map.path, video.limits.maxMapBytes, use.selection.map);
      await readVideoPublication(projectDir, use.selection.map.path, mapFile.data);
      await readAssetFile(projectDir, video.canonical.path, video.limits.maxRgbaBytes, video.canonical, { retain: false });
      await readAssetFile(projectDir, video.proxy.path, video.limits.maxProxyBytes, video.proxy, { retain: false });
      if (video.version === '0.2' && video.audio) await readAssetFile(projectDir, video.audio.path, video.limits.maxAudioBytes, video.audio, { retain: false });
    }
  }
}

/** Technical constraints, semantic evidence and rights remain distinct facts. */
export function assetNeedGaps(plan: AssetPlan, bindings: readonly AssetBinding[]): AssetGap[] {
  const gaps: AssetGap[] = [];
  for (const need of plan.needs) {
    const selected = bindings.filter(b => b.use.needId === need.needId);
    const add = (code: AssetGap['code'], reason: string, useId: string | null) => gaps.push({ needId: need.needId, shotId: need.shotId, useId, code, reason });
    if (!selected.length) { add('unbound', need.alternative ?? 'No asset use binds this need.', null); continue; }
    for (const { use, asset, catalog, video } of selected) {
      const c = need.constraints, stream = asset.technical.streams.find(s => s.type === 'video');
      const rawWidth = video?.canonical.width ?? stream?.width, rawHeight = video?.canonical.height ?? stream?.height;
      const width = rawWidth ? rawWidth * (use.crop?.width ?? 1) : null, height = rawHeight ? rawHeight * (use.crop?.height ?? 1) : null;
      if (!['supported', 'partial'].includes(asset.technical.status)) add('technical', asset.technical.reason || asset.technical.status, use.useId);
      const duration = video ? (() => { const [n, d] = video!.request.sourceRange.timeBase.split('/').map(Number);
        return Number(BigInt(video!.request.sourceRange.endPts) - BigInt(video!.request.sourceRange.startPts)) * n! / d!; })() : asset.technical.containerDuration;
      if (c.durationSeconds !== null && (duration === null || duration === undefined || duration < c.durationSeconds)) add('duration', 'Selected presentation duration is unknown or below the need.', use.useId);
      if ((c.minWidth !== null && (!width || width < c.minWidth)) || (c.minHeight !== null && (!height || height < c.minHeight))) add('dimensions', 'Selected pixel dimensions are unknown or below the need.', use.useId);
      if (c.aspectRatio !== null && (!width || !height || Math.abs(width / height - c.aspectRatio) > 0.001)) add('aspect', 'Selected source aspect requires composition review.', use.useId);
      if (c.transparent !== null) add('alpha', 'Transparency requires explicit pixel evidence.', use.useId);
      if (c.rightsUse !== null) {
        const rights = catalog.rights.filter(r => r.assetId === use.assetId && r.assetVersion === use.assetVersion && r.byteSha256 === use.byteSha256).sort((a, b) => b.revision - a.revision)[0];
        if (!rights || rights.status === 'unknown' || rights.thirdPartyRightsStatus === 'unknown' || !rights.allowedUses.includes(c.rightsUse) || rights.restrictions.length) add('rights', 'The requested use has no closed rights record.', use.useId);
      }
      if (Object.values(need.content).some(v => v !== null)) add('semantic', 'Action, view and identity need a review tied to this need and version.', use.useId);
      add('composition', 'Source suitability requires a shot composition review.', use.useId);
      add('continuity', 'Continuity requires an adjacent shot review.', use.useId);
    }
  }
  return gaps;
}
