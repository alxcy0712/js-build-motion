import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { assetHash } from '../application/asset-plan.ts';
import { importProjectPath } from './import-files.ts';
import { validateAssetPlan, validateAssetUsage } from '../project/asset-plan.ts';
import { assertCatalog, type CatalogManifest } from '../project/catalog.ts';
import { validatePreparedVideoMap, validateVideoPublication, type VideoPublication } from '../project/video-preparation.ts';
import type { RunLog } from '../project/run-log.ts';
import type { AttemptInputSnapshot } from '../project/attempt.ts';
import { sha256File } from '../utils/hash.ts';

/** Receipt identity is checked against frozen inputs, independent of the mutable current asset aliases. */
export function assertRecordedAssetUsage(projectDir: string, snapshotDir: string, snapshot: AttemptInputSnapshot, log: RunLog): void {
  const execution = log.execution, identity = execution?.assetUsage, facts = log.facts.assets.usage;
  if (!identity && !facts) return;
  if (!identity || !facts || identity.path !== `runs/${execution!.attemptId}/asset-usage.json`) throw Error('ASSET_USAGE_BINDING_INVALID');
  const read = (root: string, path: string) => {
    const absolute = importProjectPath(root, join(root, path)), info = lstatSync(absolute);
    if (!info.isFile() || info.nlink !== 1 || info.size > 268435456) throw Error('ASSET_USAGE_FILE_INVALID');
    return readFileSync(absolute);
  };
  const saved = read(projectDir, identity.path);
  if (saved.length !== identity.bytes || assetHash(saved) !== identity.sha256) throw Error('ASSET_USAGE_FILE_CHANGED');
  const usage = validateAssetUsage(JSON.parse(saved.toString('utf8')));
  const { attemptId, inputSnapshotSha256, ...body } = usage;
  if (attemptId !== execution!.attemptId || inputSnapshotSha256 !== execution!.inputSnapshotSha256 || JSON.stringify(body) !== JSON.stringify(facts)) throw Error('ASSET_USAGE_BINDING_INVALID');
  const inputs = new Map<string, Buffer>(), streamed = new Set<string>();
  const fixed = (path: string, bytes: number, sha256: string, retain = true) => {
    const entry = snapshot.files.find(f => f.path === path);
    if (!entry || entry.bytes !== bytes || entry.sha256 !== sha256) throw Error('ASSET_USAGE_INPUT_MISMATCH: ' + path);
    if (!retain) {
      if (!streamed.has(path)) {
        const absolute = importProjectPath(snapshotDir, join(snapshotDir, path)), info = lstatSync(absolute);
        if (!info.isFile() || info.nlink !== 1 || info.size !== bytes || sha256File(absolute) !== sha256) throw Error('ASSET_USAGE_INPUT_MISMATCH: ' + path);
        streamed.add(path);
      }
      return Buffer.alloc(0);
    }
    const data = inputs.get(path) ?? read(snapshotDir, path);
    if (!inputs.has(path) && (data.length !== bytes || assetHash(data) !== sha256)) throw Error('ASSET_USAGE_INPUT_MISMATCH: ' + path);
    inputs.set(path, data); return data;
  };
  if (usage.coverage === 'complete' && (usage.plan !== null || usage.receipts.length || log.facts.drawing || log.facts.assets.external.length ||
      log.facts.assets.consumed.length || Object.values(log.facts.providers).some(p => !['(none)', 'none', 'procedural'].includes(p)) ||
      JSON.stringify(usage.scope) !== JSON.stringify(['builtin-procedural-drawing-and-audio']))) throw Error('ASSET_COMPLETE_SCOPE_INVALID');
  if (!usage.plan) return;
  const plan = validateAssetPlan(JSON.parse(fixed(usage.plan.path, usage.plan.bytes, usage.plan.sha256).toString('utf8'))), checked = new Set<string>();
  for (const receipt of usage.receipts) {
    const use = plan.uses.find(u => u.useId === receipt.useId);
    if (!use || ['needId', 'shotId', 'role', 'catalogId', 'catalogManifestSha256', 'assetId', 'assetVersion', 'byteSha256'].some(key =>
      use[key as keyof typeof use] !== receipt[key as keyof typeof receipt])) throw Error('ASSET_RECEIPT_USE_MISMATCH');
    const path = `assets/catalogs/${use.catalogId}/manifest.json`, file = snapshot.files.find(f => f.path === path);
    if (!file?.bytes) throw Error('ASSET_CATALOG_INPUT_MISSING');
    const catalog = assertCatalog<CatalogManifest>('manifest', JSON.parse(fixed(path, file.bytes, use.catalogManifestSha256).toString('utf8')));
    const asset = catalog.assets.find(a => a.assetId === use.assetId && a.assetVersion === use.assetVersion && a.source.sha256 === use.byteSha256);
    if (!asset) throw Error('ASSET_VERSION_MISMATCH');
    if (receipt.source.path !== asset.source.fixedPath || receipt.source.bytes !== asset.source.bytes || receipt.source.sha256 !== use.byteSha256) throw Error('ASSET_RECEIPT_SOURCE_INVALID');
    fixed(receipt.source.path, receipt.source.bytes, receipt.source.sha256, false);
    if (!checked.has(receipt.selected.path)) { fixed(receipt.selected.path, receipt.selected.bytes, receipt.selected.sha256, false); checked.add(receipt.selected.path); }
    if (use.selection.kind === 'source') {
      if (receipt.derivedMap !== null || receipt.selected.path !== asset.source.fixedPath || receipt.selected.bytes !== asset.source.bytes || receipt.selected.sha256 !== use.byteSha256 ||
          !['prepared-read', 'image-draw'].includes(receipt.operation)) throw Error('ASSET_RECEIPT_SOURCE_INVALID');
    } else {
      if (JSON.stringify(receipt.derivedMap) !== JSON.stringify(use.selection.map)) throw Error('ASSET_RECEIPT_MAP_INVALID');
      const mapData = fixed(use.selection.map.path, use.selection.map.bytes, use.selection.map.sha256), map = validatePreparedVideoMap(JSON.parse(mapData.toString('utf8')));
      const publicationPath = use.selection.map.path.replace(/map\.json$/, 'publication.json'), publicationFile = snapshot.files.find(f => f.path === publicationPath);
      if (!publicationFile?.bytes || !publicationFile.sha256) throw Error('ASSET_VIDEO_PUBLICATION_MISSING');
      const publication = JSON.parse(fixed(publicationPath, publicationFile.bytes, publicationFile.sha256).toString('utf8')) as VideoPublication;
      validateVideoPublication(publication, fixed(publication.receipt.path, publication.receipt.bytes, publication.receipt.sha256), use.selection.map.path, mapData);
      const r = map.request;
      const selected = receipt.selected.path === map.proxy.path ? map.proxy : map.canonical;
      if (r.catalogId !== use.catalogId || r.catalogManifestSha256 !== use.catalogManifestSha256 || r.assetId !== use.assetId || r.assetVersion !== use.assetVersion ||
          r.byteSha256 !== use.byteSha256 || JSON.stringify(r.sourceRange) !== JSON.stringify(use.sourceRange) || receipt.selected.path !== selected.path ||
          receipt.selected.bytes !== selected.bytes || receipt.selected.sha256 !== selected.sha256 || receipt.operation === 'image-draw' ||
          receipt.frame !== null && map.frames[receipt.frame]?.sourcePts !== receipt.sourcePts) throw Error('ASSET_RECEIPT_VIDEO_INVALID');
    }
  }
}
