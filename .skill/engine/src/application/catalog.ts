import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { NodeImportFiles, importJsonText, sameImportNode } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { inspectAsset, inspectFormat, readFixed, type InspectContext } from '../adapters/inspection.ts';
import { documentOcrScope, documentOcrRasterTransform, documentOcrArguments, documentRasterRequest, effectiveDocumentOcrPolicy,
  runDocumentRaster, documentRasterPixels, documentRasterOcr } from '../adapters/inspection-document-ocr.ts';
import { parseOcrTsv } from '../adapters/ocr-tsv.ts';
import { preflightOcrImage } from '../adapters/ocr-raster.ts';
import { ocrRuntimeIdentity, asrRuntimeIdentity, audioInputRuntimeIdentity, documentRasterRuntimeIdentity } from '../../workspace.mjs';
import { preflightAudioInput, decodeAudioInput, audioInputProbeArguments, audioInputDecodeArguments, audioInputNormalizeArguments } from '../adapters/audio-input.ts';
import { audioInputProbeMetadata, AUDIO_INPUT_PCM_TRANSFORM, AUDIO_INPUT_CANONICAL_TRANSFORM } from '../adapters/inspection-audio.ts';
import { validateAudioInputMap, validateAudioInputRuntime, type AudioInputMap } from '../project/audio-input.ts';
import { parseAsrJson } from '../adapters/asr-json.ts';
import { preflightAsrWav } from '../adapters/asr-wav.ts';
import { asrArguments, validateAsrEngine, validateAsrMap, type AsrMap, type AsrObservation } from '../project/asr.ts';
import { validateDocumentMap, type DocumentMap, type DocumentObservation } from '../project/document.ts';
import { assertDocumentOcr, validateDocumentOcrSelectionMap, validateDocumentOcrUnitMap, validateDocumentOcrObservation,
  validateDocumentRasterRuntime, type DocumentOcrInvocationRecord, type DocumentOcrSelectionMap, type DocumentOcrUnitMap, type DocumentOcrObservation } from '../project/document-ocr.ts';
import { validateOcrEngine, validateOcrMap, validateOcrObservation, type OcrMap, type OcrObservation } from '../project/ocr.ts';
import { assertImportIndex, assertImportManifest, type ImportManifest } from '../project/import.ts';
import { assertUnpackIndex, assertUnpackManifest, type UnpackManifest } from '../project/unpack.ts';
import { assertCatalog, assertInspectPolicy, adoptInspectPolicy, documentLimits, ocrLimits, asrLimits, audioInputLimits, catalogAttemptPattern, catalogIdPattern, DEFAULT_INSPECT_POLICY, emptyCatalogCounts, safeCatalogPath,
  type AssetVersion, type CatalogIndex, type CatalogManifest, type CatalogReceipt, type CatalogSelection, type CatalogSource, type InspectPolicy, type Observation, type LegacyObservation, type Rights, type ToolRun } from '../project/catalog.ts';
const digest = (value: unknown) => createHash('sha256').update(importJsonText(value)).digest('hex');
const active = new Set<string>();
function alive(pid: number, attempt: string) { if (pid === process.pid) return active.has(attempt); try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export class CatalogFailure extends Error { receipt: CatalogReceipt; receiptPath: string | null; constructor(receipt: CatalogReceipt, path: string | null, cause: unknown) { super(receipt.error!, { cause }); this.receipt = receipt; this.receiptPath = path; } }
export interface CatalogOptions { signal?: AbortSignal; hooks?: { onPhase?: (receipt: CatalogReceipt) => Promise<void>; afterInspection?: (asset: AssetVersion, receipt: CatalogReceipt) => Promise<void>; afterIndexCommitted?: (receipt: CatalogReceipt) => Promise<void> } }
interface Context { dir: string; files: NodeImportFiles; policy: InspectPolicy; signal?: AbortSignal; read?: (amount: number) => void; check?: () => void; toolSource?: CatalogManifest }
async function json(context: Context, relative: string): Promise<{ value: any; bytes: number; sha256: string }> {
  if (!safeCatalogPath(relative)) throw new Error('CATALOG_PATH_INVALID');
  const fixed = await readFixed(context.files.projectPath(join(context.dir, relative)), context.policy.maxCatalogBytes, context.signal, context.read); context.check?.();
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fixed.data)), bytes: fixed.bytes, sha256: fixed.sha256 };
}
async function index(context: Context): Promise<{ value: CatalogIndex; sha256: string } | null> {
  let raw; try { raw = await json(context, 'assets/catalog.json'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  const value = assertCatalog<CatalogIndex>('index', raw.value);
  if (new Set(value.catalogs.map(v => v.catalogId)).size !== value.catalogs.length || new Set(value.catalogs.map(v => v.attemptId)).size !== value.catalogs.length || new Set(value.assets.map(v => v.assetId)).size !== value.assets.length || !value.catalogs.some(v => v.catalogId === value.currentCatalogId)) throw new Error('CATALOG_INDEX_INVALID: duplicate/current identity');
  return { value, sha256: raw.sha256 };
}
async function parentImport(context: Context, importId: string): Promise<{ manifest: ImportManifest; hash: string }> {
  const idx = assertImportIndex((await json(context, 'inputs/import.json')).value), matches = idx.imports.filter(v => v.importId === importId);
  if (matches.length !== 1 || !idx.imports.some(v => v.importId === idx.currentImportId)) throw new Error('CATALOG_IMPORT_NOT_COMMITTED');
  const raw = await json(context, `inputs/imports/${importId}/manifest.json`), manifest = assertImportManifest(raw.value);
  if (raw.sha256 !== matches[0]!.manifestSha256 || digest(manifest) !== raw.sha256 || manifest.importId !== importId || manifest.attemptId !== matches[0]!.attemptId || manifest.originalsPath !== `inputs/original/${importId}` || new Set(manifest.entries.map(e => e.path)).size !== manifest.entries.length) throw new Error('CATALOG_IMPORT_CHANGED');
  return { manifest, hash: raw.sha256 };
}
async function fixedSource(context: Context, source: CatalogSource): Promise<void> {
  const selected = await sources(context, source.kind === 'import' ? { importId: source.importId, path: source.path } : { unpackId: source.unpackId!, path: source.path });
  if (selected.length !== 1 || digest(selected[0]) !== digest(source)) throw new Error('CATALOG_SOURCE_CHANGED');
  const result = await readFixed(context.files.projectPath(join(context.dir, source.fixedPath)), context.policy.maxSourceBytes, context.signal, context.read, false);
  if (result.bytes !== source.bytes || result.sha256 !== source.sha256) throw new Error('CATALOG_SOURCE_CHANGED: bytes'); context.check?.();
}
async function sources(context: Context, selection: { importId: string; path?: string } | { unpackId: string; path?: string }): Promise<CatalogSource[]> {
  if (selection.path !== undefined && !safeCatalogPath(selection.path)) throw new Error('CATALOG_SELECTION_INVALID');
  let importId: string, importHash: string, unpackId: string | null = null, unpackHash: string | null = null, manifest: ImportManifest | UnpackManifest, prefix: string;
  if ('importId' in selection) {
    if (!/^import-[a-f0-9-]{36}$/.test(selection.importId)) throw new Error('CATALOG_SELECTION_INVALID');
    const parent = await parentImport(context, selection.importId); importId = selection.importId; importHash = parent.hash; manifest = parent.manifest; prefix = manifest.originalsPath;
  } else {
    if (!/^unpack-[a-f0-9-]{36}$/.test(selection.unpackId)) throw new Error('CATALOG_SELECTION_INVALID');
    const idx = assertUnpackIndex((await json(context, 'inputs/unpack.json')).value), matches = idx.unpacks.filter(v => v.unpackId === selection.unpackId);
    if (matches.length !== 1 || !idx.unpacks.some(v => v.unpackId === idx.currentUnpackId)) throw new Error('CATALOG_UNPACK_NOT_COMMITTED');
    const raw = await json(context, `inputs/unpacks/${selection.unpackId}/manifest.json`), parent = assertUnpackManifest(raw.value);
    if (raw.sha256 !== matches[0]!.manifestSha256 || digest(parent) !== raw.sha256 || parent.unpackId !== selection.unpackId || parent.attemptId !== matches[0]!.attemptId || parent.unpackedPath !== `inputs/unpacked/${selection.unpackId}` || new Set(parent.entries.map(e => e.path)).size !== parent.entries.length) throw new Error('CATALOG_UNPACK_CHANGED');
    const original = await parentImport(context, parent.source.importId), zip = original.manifest.entries.find(e => e.path === parent.source.path);
    if (original.hash !== parent.source.manifestSha256 || zip?.kind !== 'file' || zip.sha256 !== parent.source.archiveSha256 || zip.bytes !== parent.source.archiveBytes) throw new Error('CATALOG_UNPACK_PARENT_CHANGED');
    const actual = await readFixed(context.files.projectPath(join(context.dir, original.manifest.originalsPath, parent.source.path)), Math.min(original.manifest.policy.maxFileBytes, parent.policy.maxArchiveBytes), context.signal, context.read, false);
    if (actual.bytes !== zip.bytes || actual.sha256 !== zip.sha256) throw new Error('CATALOG_UNPACK_PARENT_CHANGED: ZIP bytes');
    importId = original.manifest.importId; importHash = original.hash; unpackId = selection.unpackId; unpackHash = raw.sha256; manifest = parent; prefix = parent.unpackedPath;
  }
  const entries = manifest.entries.filter(e => selection.path === undefined ? e.kind === 'file' : e.path === selection.path);
  if (selection.path !== undefined && (entries.length !== 1 || entries[0]!.kind !== 'file') || entries.length > context.policy.maxSelectedFiles) throw new Error('CATALOG_SELECTION_OR_FILE_LIMIT');
  let total = 0;
  const result = entries.map(e => {
    if (!safeCatalogPath(e.path) || !e.sha256 || !['received', 'unpacked'].includes(e.status)) throw new Error('CATALOG_SOURCE_INVALID');
    total += e.bytes; if (e.bytes > context.policy.maxSourceBytes || !Number.isSafeInteger(total) || total > context.policy.maxTotalSourceBytes) throw new Error(`CATALOG_SOURCE_LIMIT: ${e.path}; sourceBytes=${e.bytes}; maxSourceBytes=${context.policy.maxSourceBytes}; selectedTotalBytes=${total}; maxTotalSourceBytes=${context.policy.maxTotalSourceBytes}; increase inspect-policy.json source budgets within available resources, or inspect smaller selections while retaining the originals`);
    return { kind: unpackId ? 'unpack' as const : 'import' as const, importId, importManifestSha256: importHash, unpackId, unpackManifestSha256: unpackHash, path: e.path, fixedPath: `${prefix}/${e.path}`, bytes: e.bytes, sha256: e.sha256 };
  }); return result;
}
async function inspectionContext(context: Context, asset: AssetVersion): Promise<Context> {
  const run = `runs/${asset.inspection.attemptId}`, adopted = await json(context, `${run}/inspect-policy.adopted.json`), original = await json(context, `${run}/inspect-policy.source.json`);
  const policy = assertInspectPolicy(adopted.value);
  if (adopted.sha256 !== asset.inspection.policySha256 || digest(policy) !== adopted.sha256 || original.sha256 !== asset.inspection.policySourceSha256 || digest(adoptInspectPolicy(original.value, policy.version)) !== adopted.sha256) throw new Error('CATALOG_INSPECTION_POLICY_CHANGED');
  return { ...context, policy };
}
function versionFor(assets: AssetVersion[], record: Observation | Rights): AssetVersion {
  const asset = assets.find(v => v.assetId === record.assetId && v.assetVersion === record.assetVersion);
  if (!asset || asset.source.sha256 !== record.byteSha256) throw new Error('CATALOG_RECORD_ASSET_MISMATCH'); return asset;
}
async function documentEvidence(context: Context, asset: AssetVersion): Promise<{ map: DocumentMap; text: Buffer } | null> {
  const descriptor = asset.technical.document, items = (context.policy.version === '0.6' || context.policy.version === '0.7') ? asset.technical.evidence.filter(e => !e.kind.startsWith('document-ocr-')) : asset.technical.evidence,
    nativeStatus = (context.policy.version === '0.6' || context.policy.version === '0.7') && asset.technical.documentOcr ? asset.technical.documentOcr.nativeStatus : asset.technical.status;
  if (!descriptor) { if (items.some(e => e.kind === 'document-map') || ['pdf', 'docx', 'pptx', 'xlsx'].includes(asset.technical.format) && (items.length || (context.policy.version === '0.6' || context.policy.version === '0.7') && ['supported', 'partial'].includes(nativeStatus))) throw new Error('CATALOG_DOCUMENT_DESCRIPTOR_REQUIRED'); return null; }
  if (['pptx', 'xlsx'].includes(asset.technical.format) && (context.policy.version !== '0.7' || descriptor.version !== '0.2')) throw Error('CATALOG_OFFICE_POLICY_REQUIRED');
  if (context.policy.version === '0.1' || !['supported', 'partial'].includes(nativeStatus) || items.length !== 2 || asset.technical.streams.length) throw new Error('CATALOG_DOCUMENT_DESCRIPTOR_INVALID');
  const textEvidence = items.find(e => e.id === descriptor.textEvidenceId), mapEvidence = items.find(e => e.id === descriptor.mapEvidenceId), limits = documentLimits(context.policy);
  if (textEvidence?.kind !== 'text' || mapEvidence?.kind !== 'document-map' || textEvidence === mapEvidence) throw new Error('CATALOG_DOCUMENT_EVIDENCE_INVALID');
  const text = await readFixed(context.files.projectPath(join(context.dir, textEvidence.path)), limits.maxDocumentTextBytes, context.signal, context.read),
    raw = await readFixed(context.files.projectPath(join(context.dir, mapEvidence.path)), limits.maxDocumentMapBytes, context.signal, context.read);
  if (text.bytes !== textEvidence.bytes || text.sha256 !== textEvidence.sha256 || raw.bytes !== mapEvidence.bytes || raw.sha256 !== mapEvidence.sha256) throw new Error('CATALOG_DOCUMENT_EVIDENCE_CHANGED');
  const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.data)) as DocumentMap; validateDocumentMap(map, text.data, limits);
  if (digest(map) !== raw.sha256 || descriptor.version !== map.version || descriptor.format !== asset.technical.format || map.format !== descriptor.format || map.source.bytes !== asset.source.bytes || map.source.sha256 !== asset.source.sha256 ||
      map.policySha256 !== asset.inspection.policySha256 || digest(map.parser) !== digest(descriptor.parser) || map.coverage.scope !== descriptor.scope ||
      map.coverage.totalUnits !== descriptor.totalUnits || map.coverage.completedUnits !== descriptor.completedUnits ||
      nativeStatus === 'supported' && (map.coverage.totalUnits === null || map.coverage.completedUnits !== map.coverage.totalUnits || map.units.some(u => !['complete', 'empty'].includes(u.status)))) throw new Error('CATALOG_DOCUMENT_BINDING_INVALID');
  if (!asset.technical.text || asset.technical.text.bytes !== text.bytes || asset.technical.text.lines !== text.data.toString('utf8').split('\n').length || asset.technical.text.bom || asset.technical.text.lineEndings !== (text.data.includes(10) ? 'LF' : 'none') || items.some(e => e.coverage !== (nativeStatus === 'supported' ? 'full' : 'partial'))) throw new Error('CATALOG_DOCUMENT_TEXT_FACT_INVALID');
  return { map, text: text.data };
}
async function validateDocumentObservation(context: Context, asset: AssetVersion, record: DocumentObservation): Promise<void> {
  const document = await documentEvidence(context, asset), descriptor = asset.technical.document, loc = record.locator;
  if (!document || !descriptor || loc.evidenceId !== descriptor.textEvidenceId || loc.mapEvidenceId !== descriptor.mapEvidenceId || !record.evidenceRefs.includes(descriptor.mapEvidenceId)) throw new Error('CATALOG_DOCUMENT_OBSERVATION_EVIDENCE_MISMATCH');
  const unit = document.map.units.find(u => u.id === loc.unitId);
  if (!unit || !['complete', 'empty'].includes(unit.status) || unit.byteStart === null || unit.byteEnd === null || loc.byteStart < unit.byteStart || loc.byteEnd > unit.byteEnd || loc.byteEnd < loc.byteStart) throw new Error('CATALOG_DOCUMENT_UNIT_RANGE_INVALID');
  for (const pos of [loc.byteStart, loc.byteEnd]) if (pos < document.text.length && (document.text[pos]! & 0xc0) === 0x80) throw new Error('CATALOG_DOCUMENT_UTF8_BOUNDARY_INVALID');
  if (record.coverage === 'full' && (loc.byteStart !== unit.byteStart || loc.byteEnd !== unit.byteEnd)) throw new Error('CATALOG_DOCUMENT_COVERAGE_INVALID');
}
async function ocrEvidence(context: Context, asset: AssetVersion): Promise<{ map: OcrMap; text: Buffer } | null> {
  const descriptor = asset.technical.ocr, items = asset.technical.evidence, ocrItems = items.filter(e => ['ocr-raster', 'ocr-tsv', 'ocr-map'].includes(e.kind));
  const image = ['png_pipe', 'jpeg_pipe'].includes(asset.technical.format);
  if (!descriptor) {
    if (ocrItems.length || ['0.3', '0.4', '0.5', '0.6', '0.7'].includes(context.policy.version) && image) throw new Error('CATALOG_OCR_DESCRIPTOR_REQUIRED'); return null;
  }
  if (!['0.3', '0.4', '0.5', '0.6', '0.7'].includes(context.policy.version) || !image || descriptor.scope !== 'single-image-ocr') throw new Error('CATALOG_OCR_DESCRIPTOR_INVALID');
  if (descriptor.engine) validateOcrEngine(descriptor.engine);
  const ids = [descriptor.rasterEvidenceId, descriptor.tsvEvidenceId, descriptor.textEvidenceId, descriptor.mapEvidenceId];
  if (!['completed', 'no-text'].includes(descriptor.status)) {
    if (ids.some(id => id !== null) || descriptor.regions || ocrItems.length || items.some(e => e.kind === 'text') || !descriptor.reason ||
        (descriptor.status === 'disabled' ? context.policy.ocr.enabled || descriptor.engine !== null : !context.policy.ocr.enabled || !['partial', 'failed'].includes(asset.technical.status))) throw new Error('CATALOG_OCR_REFUSAL_INVALID');
    return null;
  }
  if (!context.policy.ocr.enabled || !descriptor.engine || ids.some(id => id === null) || new Set(ids).size !== 4 || !['supported', 'partial'].includes(asset.technical.status) || !items.some(e => e.kind === 'preview') || ocrItems.length !== 3 || items.filter(e => e.kind === 'text').length !== 1) throw new Error('CATALOG_OCR_DESCRIPTOR_INVALID');
  const rasterEvidence = items.find(e => e.id === descriptor.rasterEvidenceId), tsvEvidence = items.find(e => e.id === descriptor.tsvEvidenceId),
    textEvidence = items.find(e => e.id === descriptor.textEvidenceId), mapEvidence = items.find(e => e.id === descriptor.mapEvidenceId), limits = ocrLimits(context.policy);
  if (rasterEvidence?.kind !== 'ocr-raster' || tsvEvidence?.kind !== 'ocr-tsv' || textEvidence?.kind !== 'text' || mapEvidence?.kind !== 'ocr-map' ||
      !rasterEvidence.path.endsWith('.ppm') || !tsvEvidence.path.endsWith('.txt') || !textEvidence.path.endsWith('.txt') || !mapEvidence.path.endsWith('.json')) throw new Error('CATALOG_OCR_EVIDENCE_INVALID');
  const read = async (e: typeof rasterEvidence, max: number) => {
    const actual = await readFixed(context.files.projectPath(join(context.dir, e.path)), max, context.signal, context.read);
    if (actual.bytes !== e.bytes || actual.sha256 !== e.sha256) throw new Error('CATALOG_OCR_EVIDENCE_CHANGED'); return actual.data;
  };
  const raster = await read(rasterEvidence, limits.maxOcrRasterBytes), tsv = await read(tsvEvidence, limits.maxOcrTsvBytes), text = await read(textEvidence, limits.maxOcrTextBytes), raw = await read(mapEvidence, limits.maxOcrMapBytes);
  const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as OcrMap; validateOcrMap(map, text, raster, tsv, limits);
  const parsed = parseOcrTsv(tsv, map.source.width, map.source.height, limits);
  if (!parsed.text.equals(text) || digest(parsed.regions) !== digest(map.regions) || parsed.status !== map.status || digest(map) !== mapEvidence.sha256 ||
      map.format !== asset.technical.format || map.source.bytes !== asset.source.bytes || map.source.sha256 !== asset.source.sha256 || map.policySha256 !== asset.inspection.policySha256 ||
      map.raster.evidenceId !== rasterEvidence.id || map.rawTsv.evidenceId !== tsvEvidence.id || map.text.evidenceId !== textEvidence.id ||
      digest(map.engine) !== digest(descriptor.engine) || descriptor.regions !== map.regions.length || descriptor.status !== (map.status === 'text' ? 'completed' : 'no-text')) throw new Error('CATALOG_OCR_BINDING_INVALID');
  const source = await readFixed(context.files.projectPath(join(context.dir, asset.source.fixedPath)), limits.maxOcrSourceBytes, context.signal, context.read),
    header = preflightOcrImage(source.data, map.format, limits);
  if (source.bytes !== asset.source.bytes || source.sha256 !== asset.source.sha256 || header.width !== map.source.width || header.height !== map.source.height || rasterEvidence.width !== header.width || rasterEvidence.height !== header.height ||
      rasterEvidence.sourceWidth !== header.width || rasterEvidence.sourceHeight !== header.height || rasterEvidence.transform !== 'identity; white background; autorotate disabled' ||
      [rasterEvidence, tsvEvidence, textEvidence, mapEvidence].some(e => e.coverage !== 'full') || !asset.technical.text || asset.technical.text.bytes !== text.length ||
      asset.technical.text.lines !== text.toString('utf8').split('\n').length || asset.technical.text.bom || asset.technical.text.lineEndings !== (text.includes(10) ? 'LF' : 'none')) throw new Error('CATALOG_OCR_FACT_INVALID');
  return { map, text };
}
async function ocrObservation(context: Context, asset: AssetVersion, record: OcrObservation): Promise<void> {
  const ocr = await ocrEvidence(context, asset), descriptor = asset.technical.ocr;
  if (!ocr || !descriptor || record.locator.mapEvidenceId !== descriptor.mapEvidenceId) throw new Error('CATALOG_OCR_OBSERVATION_EVIDENCE_MISMATCH');
  validateOcrObservation(record, ocr.map, ocr.text);
}
interface DocumentOcrEvidence { selection: DocumentOcrSelectionMap; selectionMapEvidenceId: string; units: Map<string, { map: DocumentOcrUnitMap; text: Buffer }>; pixels: number; embeddedBytes: number }
function documentOcrToolOrigin(context: Context, asset: AssetVersion, origin: CatalogManifest, unit: DocumentOcrSelectionMap['units'][number], journal: DocumentOcrInvocationRecord): void {
  const suffix = `/out/.tmp/catalog-${origin.attemptId}/${asset.inspectionId}/document-ocr-${unit.ordinal}-`, at = journal.cwd.lastIndexOf(suffix), root = journal.cwd.slice(0, at), request = journal.request;
  if (at < 1 || resolve(journal.cwd) !== journal.cwd || /[\x00-\x1f\x7f]/.test(journal.cwd) || !/^[a-f0-9-]{36}$/.test(journal.cwd.slice(at + suffix.length)) ||
      journal.inspectionId !== asset.inspectionId || journal.unitId !== unit.id || journal.reason !== unit.reason ||
      digest(request) !== digest(documentRasterRequest(`${root}/${asset.source.fixedPath}`, asset.technical.format as 'pdf' | 'docx', unit.ordinal,
        asset.source.bytes, asset.source.sha256, context.policy, request.runtime))) throw Error('CATALOG_DOCUMENT_OCR_COMMAND_BINDING_INVALID');
  const limits = effectiveDocumentOcrPolicy(context.policy), worker = journal.commands.worker;
  if (!worker || worker.executable !== request.runtime.node.executable || worker.version !== `node@${request.runtime.node.version.slice(1)}/document-raster-worker@0.1` ||
      JSON.stringify(worker.argv) !== JSON.stringify([`--max-old-space-size=${limits.workerOldSpaceMiB}`, `${root}/.engine/src/adapters/document-raster-worker.ts`, `${journal.cwd}/request.json`])) throw Error('CATALOG_DOCUMENT_OCR_WORKER_COMMAND_INVALID');
  const decode = journal.commands.decode, ocr = journal.commands.ocr, loc = journal.workerResult?.locator;
  if (decode.length > (request.format === 'pdf' ? 0 : 1) || decode.length && (!loc || loc.kind !== 'docx-image')) throw Error('CATALOG_DOCUMENT_OCR_DECODE_COMMAND_INVALID');
  for (const run of [worker, ...decode, ...(ocr ? [ocr] : [])]) {
    if (origin.tools.filter(t => digest(t) === digest(run)).length !== 1 || run.stdoutBytes !== 0 || run.stdout !== '' ||
        run.stdoutBytes + run.stderrBytes > Math.min(1048576, context.policy.maxToolOutputBytes) ||
        run.elapsedMs > Math.min(context.policy.maxToolElapsedMs, limits.workerElapsedMs) + 1000) throw Error('CATALOG_DOCUMENT_OCR_TOOL_ORIGIN_INVALID');
    if (!run.error && (run.exitCode !== 0 || run.signal !== null)) throw Error('CATALOG_DOCUMENT_OCR_TOOL_FACT_INVALID');
  }
  if (decode.length) {
    const run = decode[0]!, format = (loc as Extract<NonNullable<typeof loc>, { kind: 'docx-image' }>).format, tool = asset.technical.documentOcr!.engine!.tools.ffmpeg;
    const argv = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000',
      '-protocol_whitelist', 'file', '-format_whitelist', format, '-f', format, '-max_streams', '1', '-threads', '1', '-noautorotate',
      '-c:v', format === 'png_pipe' ? 'png' : 'mjpeg', '-i', `${journal.cwd}/embedded.image`, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
      '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'];
    if (run.executable !== tool.executable || run.version !== `${tool.version}/ocr-raster@0.1` || JSON.stringify(run.argv) !== JSON.stringify(argv) ||
        !run.error && run.binaryBytes !== 4 * loc!.width * loc!.height) throw Error('CATALOG_DOCUMENT_OCR_DECODE_COMMAND_INVALID');
  }
  if (ocr) {
    const tool = asset.technical.documentOcr!.engine!.tools.tesseract;
    if (ocr.executable !== tool.executable || ocr.version !== `${tool.version}/ocr-tsv@0.1` ||
        JSON.stringify(ocr.argv) !== JSON.stringify(documentOcrArguments(`${journal.cwd}/raster.ppm`, `${root}/.engine/assets/ocr/tessdata`)) ||
        request.format === 'docx' && decode.length !== 1 || ocr.binaryBytes > limits.ocr.maxOcrTsvBytes) throw Error('CATALOG_DOCUMENT_OCR_ENGINE_COMMAND_INVALID');
  }
}
async function documentOcrEvidence(context: Context, asset: AssetVersion): Promise<DocumentOcrEvidence | null> {
  const items = asset.technical.evidence, special = items.filter(e => e.kind.startsWith('document-ocr-')), descriptor = asset.technical.documentOcr,
    format = asset.technical.format as 'pdf' | 'docx';
  if (!descriptor) { if (special.length || (context.policy.version === '0.6' || context.policy.version === '0.7') && ['pdf', 'docx'].includes(format)) throw Error('CATALOG_DOCUMENT_OCR_DESCRIPTOR_REQUIRED'); return null; }
  if ((context.policy.version !== '0.6' && context.policy.version !== '0.7') || !['pdf', 'docx'].includes(format)) throw Error('CATALOG_DOCUMENT_OCR_POLICY_REQUIRED');
  assertDocumentOcr('descriptor', descriptor); const limits = effectiveDocumentOcrPolicy(context.policy), selection = format === 'pdf' ? limits.pdfPages : limits.docxImages;
  if (descriptor.scope !== documentOcrScope(format) || JSON.stringify(descriptor.selection) !== JSON.stringify(selection)) throw Error('CATALOG_DOCUMENT_OCR_SELECTION_INVALID');
  if (!limits.enabled || !selection.length) {
    if (descriptor.status !== (limits.enabled ? 'skipped' : 'disabled') || descriptor.reason !== (limits.enabled ? 'DOCUMENT_OCR_SELECTION_EMPTY' : 'DOCUMENT_OCR_DISABLED') ||
        descriptor.mapEvidenceId !== null || descriptor.runtime !== null || descriptor.engine !== null || descriptor.totalUnits !== null || descriptor.completedUnits || special.length ||
        descriptor.nativeStatus !== asset.technical.status) throw Error('CATALOG_DOCUMENT_OCR_REFUSAL_INVALID');
    return null;
  }
  if (!descriptor.runtime || !descriptor.engine || !descriptor.mapEvidenceId) throw Error('CATALOG_DOCUMENT_OCR_DESCRIPTOR_INVALID');
  validateDocumentRasterRuntime(descriptor.runtime); validateOcrEngine(descriptor.engine);
  if (digest(documentRasterRuntimeIdentity()) !== digest(descriptor.runtime) || digest(ocrRuntimeIdentity()) !== digest(descriptor.engine)) throw Error('CATALOG_DOCUMENT_OCR_RUNTIME_CHANGED');
  const overallFile = special.find(e => e.id === descriptor.mapEvidenceId);
  if (overallFile?.kind !== 'document-ocr-selection-map' || !overallFile.path.endsWith('.json')) throw Error('CATALOG_DOCUMENT_OCR_SELECTION_EVIDENCE_INVALID');
  const read = async (entry: typeof overallFile, maximum: number) => {
    const fixed = await readFixed(context.files.projectPath(join(context.dir, entry.path)), maximum, context.signal, context.read);
    if (fixed.bytes !== entry.bytes || fixed.sha256 !== entry.sha256) throw Error('CATALOG_DOCUMENT_OCR_EVIDENCE_CHANGED'); return fixed.data;
  };
  const overall = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(overallFile, limits.maxMapBytes))) as DocumentOcrSelectionMap;
  validateDocumentOcrSelectionMap(overall, limits);
  const expectedStatus = descriptor.nativeStatus === 'failed' || descriptor.nativeStatus === 'unsupported' || overall.status !== 'completed' ?
    overall.completedUnits || ['supported', 'partial'].includes(descriptor.nativeStatus) ? 'partial' : descriptor.nativeStatus : descriptor.nativeStatus;
  if (digest(overall) !== overallFile.sha256 || overall.format !== format || overall.source.bytes !== asset.source.bytes || overall.source.sha256 !== asset.source.sha256 ||
      overall.policySha256 !== asset.inspection.policySha256 || overall.nativeStatus !== descriptor.nativeStatus || overall.status !== descriptor.status ||
      overall.totalUnits !== descriptor.totalUnits || overall.completedUnits !== descriptor.completedUnits || digest(overall.runtime) !== digest(descriptor.runtime) ||
      digest(overall.engine) !== digest(descriptor.engine) || descriptor.reason !== (overall.status === 'completed' ? '' : 'DOCUMENT_OCR_SELECTION_PARTIAL') ||
      asset.technical.status !== expectedStatus || special.length !== 1 + overall.completedUnits * 4) throw Error('CATALOG_DOCUMENT_OCR_BINDING_INVALID');
  const origin = await audioOrigin(context, asset), receipt = assertCatalog<CatalogReceipt>('receipt', (await json(context, `runs/${origin.attemptId}/receipt.json`)).value);
  if (receipt.catalogId !== origin.catalogId || receipt.attemptId !== origin.attemptId || receipt.policySha256 !== origin.policySha256 || digest(receipt.tools) !== digest(origin.tools) ||
      !receipt.assets.some(a => digest(a) === digest(asset)) || !['running', 'prepared', 'succeeded'].includes(receipt.status)) throw Error('CATALOG_DOCUMENT_OCR_RECEIPT_ORIGIN_INVALID');
  const used = new Set([overallFile.id]), units: DocumentOcrEvidence['units'] = new Map(); let pixels = 0, embeddedBytes = 0;
  await context.files.ensureDirectory(join(context.dir, 'out/.tmp'));
  for (const unit of overall.units) {
    const ref = unit.invocation;
    if (!ref || !new RegExp(`^runs/${origin.attemptId}/document-ocr-command-[a-f0-9-]{36}\\.json$`).test(ref.path) || ref.bytes > limits.maxMapBytes) throw Error('CATALOG_DOCUMENT_OCR_COMMAND_REFERENCE_INVALID');
    const rawJournal = await json(context, ref.path), journal = assertDocumentOcr<DocumentOcrInvocationRecord>('invocation', rawJournal.value);
    if (rawJournal.bytes !== ref.bytes || rawJournal.sha256 !== ref.sha256 || digest(journal) !== ref.sha256 || digest(journal.request.runtime) !== digest(overall.runtime) ||
        digest(journal.workerResult?.locator ?? null) !== digest(unit.locator) || journal.workerResult && journal.workerResult.totalUnits !== overall.totalUnits) throw Error('CATALOG_DOCUMENT_OCR_COMMAND_CHANGED');
    documentOcrToolOrigin(context, asset, origin, unit, journal);
    const result = journal.workerResult;
    if (result?.status === 'complete' && result.locator) { pixels += result.locator.width * result.locator.height; embeddedBytes += result.locator.kind === 'docx-image' ? result.locator.embeddedBytes : 0; }
    const cwd = context.files.projectPath(join(context.dir, 'out/.tmp', `document-ocr-verify-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
    let readBytes = 0; const counts = { ...emptyCatalogCounts(), get sourceReadBytes() { return readBytes; }, set sourceReadBytes(value: number) { const amount = value - readBytes; readBytes = value; context.read?.(amount); } };
    const replay: InspectContext = { projectDir: context.dir, temporaryDir: cwd, evidenceDir: cwd, publishedDir: '', policy: context.policy, counts, tools: [],
      signal: context.signal ?? new AbortController().signal, check: () => { context.signal?.throwIfAborted(); context.check?.(); } };
    let currentFailure = '', rebuilt: Awaited<ReturnType<typeof runDocumentRaster>> | null = null;
    try {
      try { rebuilt = await runDocumentRaster({ ...journal.request, sourcePath: context.files.projectPath(join(context.dir, asset.source.fixedPath)) }, replay, cwd); }
      catch (error) { replay.check(); currentFailure = message(error); }
      if (result) {
        const actual = rebuilt?.result, stripped = actual ? { ...actual, payload: actual.payload ? { format: actual.payload.format, bytes: actual.payload.bytes, sha256: actual.payload.sha256 } : null } : null;
        if (digest(stripped) !== digest(result) || rebuilt!.run.binaryBytes !== journal.commands.worker!.binaryBytes) throw Error('CATALOG_DOCUMENT_OCR_SOURCE_REPLAY_INVALID');
      } else if (!journal.commands.worker!.error || !currentFailure || currentFailure !== unit.reason) throw Error('CATALOG_DOCUMENT_OCR_WORKER_FAILURE_REPLAY_INVALID');
      if (rebuilt?.result.status === 'failed') { if (unit.status !== 'failed' || rebuilt.result.reason !== unit.reason || journal.commands.decode.length || journal.commands.ocr) throw Error('CATALOG_DOCUMENT_OCR_FAILURE_REPLAY_INVALID'); continue; }
      if (!rebuilt) continue;
      let ppm: Buffer | null = null, parsed: Awaited<ReturnType<typeof documentRasterOcr>> | null = null;
      try { ppm = await documentRasterPixels(rebuilt.result, replay, overall.engine, cwd); parsed = await documentRasterOcr(ppm, rebuilt.result.locator!.width, rebuilt.result.locator!.height, replay, overall.engine, cwd); }
      catch (error) { replay.check(); currentFailure = message(error); }
      if (unit.status === 'failed') {
        if (currentFailure === unit.reason) continue;
        if (parsed && ppm && journal.commands.ocr && journal.commands.worker) {
          const loc = rebuilt.result.locator!, ids = Array.from({ length: 4 }, (_, i) => `evidence-00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`);
          const prospective: DocumentOcrUnitMap = { version: '0.1', kind: 'document-ocr-map', format, unitId: unit.id, scope: overall.scope, mapperVersion: 'ocr-tsv@0.1', status: parsed.status,
            policySha256: overall.policySha256, source: overall.source, runtime: overall.runtime, locator: loc,
            raster: { evidenceId: ids[0]!, bytes: ppm.length, sha256: createHash('sha256').update(ppm).digest('hex'), width: loc.width, height: loc.height, encoding: 'P6/RGB8', background: 'white', transform: 'identity', orientationApplied: false },
            rawTsv: { evidenceId: ids[1]!, bytes: parsed.tsv.length, sha256: createHash('sha256').update(parsed.tsv).digest('hex') }, text: { evidenceId: ids[2]!, bytes: parsed.text.length, sha256: createHash('sha256').update(parsed.text).digest('hex') },
            engine: overall.engine, regions: parsed.regions, commands: { worker: journal.commands.worker, decode: journal.commands.decode, ocr: journal.commands.ocr }, cwd: journal.cwd,
            limitations: [...rebuilt.result.limitations, 'Coordinates address the selected raster pixels. OCR confidence is an engine score.'] };
          try { validateDocumentOcrUnitMap(prospective, parsed.text, ppm, parsed.tsv, limits); const length = Buffer.byteLength(importJsonText(prospective)); if (length > limits.maxMapBytes || length > limits.ocr.maxOcrMapBytes) throw Error('DOCUMENT_OCR_MAP_LIMIT'); } catch (error) { if (message(error) === unit.reason) continue; }
        }
        throw Error('CATALOG_DOCUMENT_OCR_FAILURE_REPLAY_INVALID');
      }
      if (!ppm || !parsed || currentFailure || !journal.commands.ocr || journal.commands.worker!.error || journal.commands.decode.some(run => run.error) || journal.commands.ocr.error) throw Error('CATALOG_DOCUMENT_OCR_REPLAY_INVALID');
      const mapFile = special.find(e => e.id === unit.mapEvidenceId);
      if (mapFile?.kind !== 'document-ocr-map' || !mapFile.path.endsWith('.json') || used.has(mapFile.id)) throw Error('CATALOG_DOCUMENT_OCR_UNIT_GROUP_INVALID');
      const map = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(mapFile, Math.min(limits.maxMapBytes, limits.ocr.maxOcrMapBytes)))) as DocumentOcrUnitMap;
      const rasterFile = special.find(e => e.id === map.raster.evidenceId), tsvFile = special.find(e => e.id === map.rawTsv.evidenceId), textFile = special.find(e => e.id === map.text.evidenceId);
      if (rasterFile?.kind !== 'document-ocr-raster' || tsvFile?.kind !== 'document-ocr-tsv' || textFile?.kind !== 'document-ocr-text' ||
          !rasterFile.path.endsWith('.ppm') || !tsvFile.path.endsWith('.txt') || !textFile.path.endsWith('.txt')) throw Error('CATALOG_DOCUMENT_OCR_UNIT_GROUP_INVALID');
      const raster = await read(rasterFile, Math.min(limits.maxRasterBytes, limits.ocr.maxOcrRasterBytes)), tsv = await read(tsvFile, limits.ocr.maxOcrTsvBytes), text = await read(textFile, limits.ocr.maxOcrTextBytes);
      validateDocumentOcrUnitMap(map, text, raster, tsv, limits);
      if (digest(map) !== mapFile.sha256 || map.format !== format || map.unitId !== unit.id || map.status !== unit.status || digest(map.source) !== digest(overall.source) ||
          map.policySha256 !== overall.policySha256 || digest(map.runtime) !== digest(overall.runtime) || digest(map.engine) !== digest(overall.engine) ||
          digest(map.locator) !== digest(unit.locator) || map.cwd !== journal.cwd || digest(map.commands) !== digest(journal.commands) ||
          !raster.equals(ppm) || !tsv.equals(parsed.tsv) || !text.equals(parsed.text) || digest(map.regions) !== digest(parsed.regions) || map.status !== parsed.status ||
          journal.commands.ocr.binaryBytes !== tsv.length || rasterFile.width !== map.locator.width || rasterFile.height !== map.locator.height ||
          rasterFile.sourceWidth !== map.locator.width || rasterFile.sourceHeight !== map.locator.height || rasterFile.transform !== documentOcrRasterTransform(format)) throw Error('CATALOG_DOCUMENT_OCR_REPLAY_INVALID');
      for (const entry of [rasterFile, tsvFile, textFile, mapFile]) { if (used.has(entry.id) || entry.coverage !== 'full') throw Error('CATALOG_DOCUMENT_OCR_GROUP_OVERLAP'); used.add(entry.id); }
      units.set(unit.id, { map, text });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
  if (used.size !== special.length || special.some(e => !used.has(e.id)) || digest(documentRasterRuntimeIdentity()) !== digest(overall.runtime) || digest(ocrRuntimeIdentity()) !== digest(overall.engine)) throw Error('CATALOG_DOCUMENT_OCR_GROUP_INVALID');
  return { selection: overall, selectionMapEvidenceId: overallFile.id, units, pixels, embeddedBytes };
}
async function documentOcrObservation(context: Context, asset: AssetVersion, record: DocumentOcrObservation): Promise<void> {
  const group = await documentOcrEvidence(context, asset), unit = group?.units.get(record.locator.unitId);
  if (!group || !unit || record.locator.mapEvidenceId !== group.selection.units.find(u => u.id === record.locator.unitId)?.mapEvidenceId) throw Error('CATALOG_DOCUMENT_OCR_OBSERVATION_EVIDENCE_MISMATCH');
  validateDocumentOcrObservation(record, unit.map, unit.text, group.selectionMapEvidenceId);
}
async function audioOrigin(context: Context, asset: AssetVersion): Promise<CatalogManifest> {
  let origin = context.toolSource;
  if (origin?.catalogId !== asset.inspection.catalogId) {
    const entry = (await index(context))?.value.catalogs.find(e => e.catalogId === asset.inspection.catalogId);
    if (!entry) throw Error('CATALOG_AUDIO_TOOL_ORIGIN_INVALID');
    const frozen = await json(context, `assets/catalogs/${entry.catalogId}/manifest.json`); origin = assertCatalog<CatalogManifest>('manifest', frozen.value);
    if (frozen.sha256 !== entry.manifestSha256 || digest(origin) !== frozen.sha256 || origin.attemptId !== entry.attemptId || !origin.assets.some(a => digest(a) === digest(asset))) throw Error('CATALOG_AUDIO_TOOL_ORIGIN_CHANGED');
  }
  if (origin.attemptId !== asset.inspection.attemptId || origin.policySha256 !== asset.inspection.policySha256) throw Error('CATALOG_AUDIO_TOOL_ORIGIN_INVALID');
  return origin;
}
interface AudioEvidence { map: AudioInputMap; probe: Buffer; pcm: Buffer; wav: Buffer; mapEvidenceId: string; mapSha256: string }
function audioToolOrigin(context: Context, asset: AssetVersion, origin: CatalogManifest, map: AudioInputMap, probe: Buffer): string {
  const absolute = (path: string) => path.startsWith('/') && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
  const suffix = `/out/.tmp/catalog-${origin.attemptId}/`, at = map.cwd.lastIndexOf(suffix), root = map.cwd.slice(0, at);
  if (!absolute(map.cwd) || at < 1 || !/^audio-input-[a-f0-9-]{36}$/.test(map.cwd.slice(at + suffix.length))) throw Error('CATALOG_AUDIO_CWD_ORIGIN_INVALID');
  const source = `${root}/${asset.source.fixedPath}`, pcm = `${map.cwd}/source.s16le`, limits = audioInputLimits(context.policy);
  const argumentsByRole = { probe: audioInputProbeArguments(map.input, source), decode: audioInputDecodeArguments(map.input, source), normalize: audioInputNormalizeArguments(map.input, pcm) };
  for (const role of ['probe', 'decode', 'normalize'] as const) {
    const run = map.commands[role], tool = map.runtime.tools[role === 'probe' ? 'ffprobe' : 'ffmpeg'];
    const binaryBytes = role === 'decode' ? map.sourcePcm.bytes : role === 'normalize' ? map.audio.payloadBytes : 0;
    if (!origin.tools.some(entry => digest(entry) === digest(run)) || run.executable !== tool.executable ||
        run.version !== `${tool.version}/audio-input@0.1/${role}` || JSON.stringify(run.argv) !== JSON.stringify(argumentsByRole[role]) ||
        run.error !== null || run.exitCode !== 0 || run.signal !== null || run.binaryBytes !== binaryBytes ||
        run.stdoutBytes !== (role === 'probe' ? probe.length : 0) || run.stdout !== (role === 'probe' ? probe.toString('utf8') : '') ||
        run.stdoutBytes + run.stderrBytes > context.policy.maxToolOutputBytes || run.elapsedMs > Math.min(context.policy.maxToolElapsedMs, limits.maxToolElapsedMs) + 1000) throw Error('CATALOG_AUDIO_TOOL_FACT_INVALID');
  }
  return source;
}
async function audioEvidence(context: Context, asset: AssetVersion): Promise<AudioEvidence | null> {
  const descriptor = asset.technical.audioInput, items = asset.technical.evidence, special = items.filter(e => ['audio-canonical', 'audio-input-map'].includes(e.kind));
  if (!descriptor) {
    if (special.length || ['0.5', '0.6', '0.7'].includes(context.policy.version) && ['wav', 'mp3', 'flac', 'm4a'].includes(asset.technical.format)) throw Error('CATALOG_AUDIO_DESCRIPTOR_REQUIRED');
    return null;
  }
  if (!['0.5', '0.6', '0.7'].includes(context.policy.version) || descriptor.version !== '0.1' || descriptor.scope !== 'bounded-input-audio' ||
      !['wav', 'mp3', 'flac', 'm4a'].includes(asset.technical.format) || asset.technical.asr?.version !== '0.2') throw Error('CATALOG_AUDIO_DESCRIPTOR_INVALID');
  if (descriptor.runtime) validateAudioInputRuntime(descriptor.runtime);
  const ids = [descriptor.probeEvidenceId, descriptor.pcmEvidenceId, descriptor.audioEvidenceId, descriptor.mapEvidenceId];
  if (descriptor.status !== 'completed') {
    if (!descriptor.reason || ids.some(id => id !== null) || special.length || items.length || !['partial', 'failed', 'unsupported'].includes(asset.technical.status)) throw Error('CATALOG_AUDIO_REFUSAL_INVALID');
    return null;
  }
  const kinds = ['probe', 'audio-pcm', 'audio-canonical', 'audio-input-map', ...(['completed', 'no-text'].includes(asset.technical.asr.status) ? ['asr-json', 'text', 'asr-map'] : [])];
  if (items.length !== kinds.length || kinds.some(kind => items.filter(entry => entry.kind === kind).length !== 1)) throw Error('CATALOG_AUDIO_GROUP_INVALID');
  if (!descriptor.runtime || ids.some(id => id === null) || new Set(ids).size !== 4 || special.length !== 2 ||
      items.filter(e => e.kind === 'probe').length !== 1 || items.filter(e => e.kind === 'audio-pcm').length !== 1 || !['supported', 'partial'].includes(asset.technical.status)) throw Error('CATALOG_AUDIO_DESCRIPTOR_INVALID');
  const [probeFile, pcmFile, audioFile, mapFile] = ids.map(id => items.find(e => e.id === id)), limits = audioInputLimits(context.policy);
  if (probeFile?.kind !== 'probe' || pcmFile?.kind !== 'audio-pcm' || audioFile?.kind !== 'audio-canonical' || mapFile?.kind !== 'audio-input-map' ||
      !probeFile.path.endsWith('.json') || !pcmFile.path.endsWith('.s16le') || !audioFile.path.endsWith('.wav') || !mapFile.path.endsWith('.json')) throw Error('CATALOG_AUDIO_EVIDENCE_INVALID');
  const read = async (entry: typeof probeFile, maximum: number) => {
    const value = await readFixed(context.files.projectPath(join(context.dir, entry.path)), maximum, context.signal, context.read);
    if (value.bytes !== entry.bytes || value.sha256 !== entry.sha256) throw Error('CATALOG_AUDIO_EVIDENCE_CHANGED'); return value.data;
  };
  const probe = await read(probeFile, context.policy.maxToolOutputBytes), pcm = await read(pcmFile, limits.maxPcmBytes),
    wav = await read(audioFile, limits.maxAudioBytes), mapData = await read(mapFile, limits.maxMapBytes);
  const map = validateAudioInputMap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mapData)), probe, pcm, wav, limits);
  if (digest(map) !== mapFile.sha256 || map.probe.evidenceId !== probeFile.id || map.sourcePcm.evidenceId !== pcmFile.id ||
      map.audio.evidenceId !== audioFile.id || map.source.bytes !== asset.source.bytes || map.source.sha256 !== asset.source.sha256 ||
      map.policySha256 !== asset.inspection.policySha256 || map.input.format !== asset.technical.format || digest(map.runtime) !== digest(descriptor.runtime) ||
      [probeFile, pcmFile, audioFile, mapFile].some(e => e.coverage !== 'full') || pcmFile.sampleRate !== map.input.sampleRate ||
      pcmFile.samples !== map.input.samples || audioFile.sampleRate !== 16000 || audioFile.samples !== map.audio.samples ||
      pcmFile.transform !== AUDIO_INPUT_PCM_TRANSFORM || audioFile.transform !== AUDIO_INPUT_CANONICAL_TRANSFORM ||
      [probeFile, mapFile].some(e => e.sampleRate !== null || e.samples !== null || e.transform !== null || e.streamIndex !== null)) throw Error('CATALOG_AUDIO_BINDING_INVALID');
  const metadata = audioInputProbeMetadata(probe, map.input);
  if (digest(asset.technical.streams) !== digest(metadata.streams) || asset.technical.containerDuration !== metadata.containerDuration ||
      asset.technical.raw !== probe.toString('utf8') || pcmFile.streamIndex !== metadata.streams[0]!.index || audioFile.streamIndex !== pcmFile.streamIndex) throw Error('CATALOG_AUDIO_PROBE_FACT_INVALID');
  const origin = await audioOrigin(context, asset); audioToolOrigin(context, asset, origin, map, probe);
  const sourcePath = context.files.projectPath(join(context.dir, asset.source.fixedPath)), sourceNode = await context.files.inspect(sourcePath),
    source = await readFixed(sourcePath, limits.maxSourceBytes, context.signal, context.read), facts = preflightAudioInput(source.data, limits);
  if (source.bytes !== asset.source.bytes || source.sha256 !== asset.source.sha256 || digest(facts) !== digest(map.input)) throw Error('CATALOG_AUDIO_SOURCE_FACT_INVALID');
  const runtime = validateAudioInputRuntime(audioInputRuntimeIdentity());
  if (digest(runtime) !== digest(map.runtime)) throw Error('CATALOG_AUDIO_RUNTIME_CHANGED');
  await context.files.ensureDirectory(join(context.dir, 'out/.tmp'));
  const cwd = context.files.projectPath(join(context.dir, 'out/.tmp', `audio-verify-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
  let readBytes = 0;
  const counts = { ...emptyCatalogCounts(), get sourceReadBytes() { return readBytes; }, set sourceReadBytes(value: number) { const amount = value - readBytes; readBytes = value; context.read?.(amount); } };
  const check = () => { context.signal?.throwIfAborted(); context.check?.(); };
  try {
    const node = await context.files.inspect(cwd), replay = await decodeAudioInput(sourcePath, facts, { projectDir: context.dir, temporaryDir: cwd,
      evidenceDir: cwd, publishedDir: '', policy: context.policy, counts, tools: [], signal: context.signal ?? new AbortController().signal, check }, runtime), afterCwd = await context.files.inspect(cwd);
    if (!replay.pcm.equals(pcm) || !replay.wav.equals(wav) || !replay.probe.equals(probe) || digest(replay.facts) !== digest(map.input) ||
        afterCwd.kind !== 'directory' || afterCwd.dev !== node.dev || afterCwd.ino !== node.ino || afterCwd.nlink !== node.nlink || (await context.files.children(cwd)).length) throw Error('CATALOG_AUDIO_REPLAY_INVALID');
    const after = await readFixed(sourcePath, limits.maxSourceBytes, context.signal, context.read, false);
    if (after.bytes !== source.bytes || after.sha256 !== source.sha256 || !sameImportNode(sourceNode, await context.files.inspect(sourcePath))) throw Error('CATALOG_SOURCE_CHANGED: audio replay');
    if (digest(validateAudioInputRuntime(audioInputRuntimeIdentity())) !== digest(runtime)) throw Error('CATALOG_AUDIO_RUNTIME_CHANGED'); check();
  } finally { await rm(cwd, { recursive: true, force: true }); }
  return { map, probe, pcm, wav, mapEvidenceId: mapFile.id, mapSha256: mapFile.sha256 };
}
async function asrEvidence(context: Context, asset: AssetVersion, commonAudio?: AudioEvidence | null): Promise<{ map: AsrMap; text: Buffer } | null> {
  if (['0.5', '0.6', '0.7'].includes(context.policy.version) && asset.technical.audioInput) return commonAsrEvidence(context, asset, commonAudio);
  const descriptor = asset.technical.asr, items = asset.technical.evidence, special = items.filter(e => ['asr-audio', 'asr-json', 'asr-map'].includes(e.kind));
  if (!descriptor) { if (special.length || context.policy.version === '0.4' && asset.technical.format === 'wav') throw Error('CATALOG_ASR_DESCRIPTOR_REQUIRED'); return null; }
  if (context.policy.version !== '0.4' || asset.technical.format !== 'wav') throw Error('CATALOG_ASR_DESCRIPTOR_INVALID');
  const policy = context.policy.asr, ids = [descriptor.audioEvidenceId, descriptor.jsonEvidenceId, descriptor.textEvidenceId, descriptor.mapEvidenceId];
  if (descriptor.engine) validateAsrEngine(descriptor.engine);
  if (!['completed', 'no-text'].includes(descriptor.status)) {
    if (!descriptor.reason || ids.some(id => id !== null) || descriptor.segments || special.length || items.some(e => e.kind === 'text') ||
      (descriptor.status === 'disabled' ? policy.enabled || descriptor.engine !== null : !policy.enabled || !['partial', 'failed', 'unsupported'].includes(asset.technical.status))) throw Error('CATALOG_ASR_REFUSAL_INVALID');
    return null;
  }
  if (!policy.enabled || !descriptor.engine || ids.some(id => id === null) || new Set(ids).size !== 4 || special.length !== 3 || items.filter(e => e.kind === 'text').length !== 1 || !['supported', 'partial'].includes(asset.technical.status)) throw Error('CATALOG_ASR_DESCRIPTOR_INVALID');
  const audio = items.find(e => e.id === ids[0])!, raw = items.find(e => e.id === ids[1])!, text = items.find(e => e.id === ids[2])!, mapFile = items.find(e => e.id === ids[3])!, pcm = items.find(e => e.kind === 'audio-pcm'), limits = asrLimits(context.policy);
  if (audio?.kind !== 'asr-audio' || raw?.kind !== 'asr-json' || text?.kind !== 'text' || mapFile?.kind !== 'asr-map' || !pcm || !audio.path.endsWith('.wav') || !raw.path.endsWith('.json') || !text.path.endsWith('.txt') || !mapFile.path.endsWith('.json')) throw Error('CATALOG_ASR_EVIDENCE_INVALID');
  const read = async (entry: typeof audio, maximum: number) => { const result = await readFixed(context.files.projectPath(join(context.dir, entry.path)), maximum, context.signal, context.read); if (result.bytes !== entry.bytes || result.sha256 !== entry.sha256) throw Error('CATALOG_ASR_EVIDENCE_CHANGED'); return result.data; };
  const wav = await read(audio, limits.maxAsrAudioBytes), jsonData = await read(raw, limits.maxAsrRawBytes), textData = await read(text, limits.maxAsrTextBytes), mapData = await read(mapFile, limits.maxAsrMapBytes);
  const map = validateAsrMap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mapData)), textData, wav, jsonData, limits);
  if (map.version !== '0.1') throw Error('CATALOG_ASR_MAP_VERSION_INVALID');
  let origin = context.toolSource;
  if (origin?.catalogId !== asset.inspection.catalogId) {
    const entry = (await index(context))?.value.catalogs.find(e => e.catalogId === asset.inspection.catalogId); if (!entry) throw Error('CATALOG_ASR_TOOL_ORIGIN_INVALID');
    const frozen = await json(context, `assets/catalogs/${entry.catalogId}/manifest.json`); origin = assertCatalog<CatalogManifest>('manifest', frozen.value);
    if (frozen.sha256 !== entry.manifestSha256 || digest(origin) !== frozen.sha256 || origin.attemptId !== entry.attemptId || !origin.assets.some(a => digest(a) === digest(asset))) throw Error('CATALOG_ASR_TOOL_ORIGIN_CHANGED');
  }
  if (origin.attemptId !== asset.inspection.attemptId || origin.policySha256 !== asset.inspection.policySha256) throw Error('CATALOG_ASR_TOOL_ORIGIN_INVALID');
  const runs = origin.tools.filter(run => run.version === `${map.engine.providerVersion}/asr-json@0.1` && run.executable.endsWith('/' + map.engine.program.path) && run.binaryBytes === raw.bytes && run.error === null && run.exitCode === 0 && run.signal === null);
  const matching = runs.filter(run => {
    const model = run.argv[run.argv.indexOf('-m') + 1], submitted = run.argv[run.argv.indexOf('-f') + 1];
    const audioSuffix = `/out/.tmp/catalog-${origin.attemptId}/${asset.inspectionId}/${audio.id}.wav`;
    if (!model?.startsWith('/') || !model.endsWith('/' + map.engine.model.path) || !submitted?.startsWith('/') || !submitted.endsWith(audioSuffix) || JSON.stringify(run.argv) !== JSON.stringify(asrArguments(map.language, model, submitted))) return false;
    try { const parsed = parseAsrJson(jsonData, map.audio.samples, map.language, limits, model); return parsed.text.equals(textData) && digest(parsed.segments) === digest(map.segments) && parsed.status === map.status; } catch { return false; }
  });
  if (!matching.length) throw Error('CATALOG_ASR_REPLAY_INVALID');
  const source = await readFixed(context.files.projectPath(join(context.dir, asset.source.fixedPath)), limits.maxAsrSourceBytes, context.signal, context.read), wave = preflightAsrWav(source.data, limits);
  const sourcePcm = await readFixed(context.files.projectPath(join(context.dir, pcm.path)), context.policy.maxDecodedAudioBytes, context.signal, context.read, false), stream = asset.technical.streams[0];
  if (source.bytes !== asset.source.bytes || source.sha256 !== asset.source.sha256 || digest(wave) !== digest(map.source.wave) || map.source.bytes !== source.bytes || map.source.sha256 !== source.sha256 ||
    pcm.coverage !== 'full' || pcm.sampleRate !== wave.sampleRate || pcm.samples !== wave.frames || sourcePcm.bytes !== pcm.bytes || sourcePcm.sha256 !== pcm.sha256 ||
    wave.sampleRate === 16000 && (map.audio.samples !== pcm.samples || createHash('sha256').update(wav.subarray(44)).digest('hex') !== sourcePcm.sha256) ||
    map.sourcePcm.evidenceId !== pcm.id || map.sourcePcm.bytes !== pcm.bytes || map.sourcePcm.sha256 !== pcm.sha256 || asset.technical.streams.length !== 1 || stream?.type !== 'audio' || stream.codec !== 'pcm_s16le' || stream.channels !== wave.channels || stream.sampleRate !== wave.sampleRate || pcm.streamIndex !== stream.index ||
    map.audio.evidenceId !== audio.id || map.rawJson.evidenceId !== raw.id || map.text.evidenceId !== text.id || map.policySha256 !== asset.inspection.policySha256 || map.language !== policy.language ||
    digest(map.engine) !== digest(descriptor.engine) || digest(map) !== mapFile.sha256 || descriptor.segments !== map.segments.length || descriptor.status !== (map.status === 'text' ? 'completed' : 'no-text') ||
    audio.sampleRate !== 16000 || audio.samples !== map.audio.samples || audio.streamIndex !== pcm.streamIndex || [audio, raw, text, mapFile].some(e => e.coverage !== 'full') ||
    !asset.technical.text || asset.technical.text.bytes !== textData.length || asset.technical.text.lines !== textData.toString('utf8').split('\n').length || asset.technical.text.bom || asset.technical.text.lineEndings !== (textData.includes(10) ? 'LF' : 'none')) throw Error('CATALOG_ASR_BINDING_INVALID');
  return { map, text: textData };
}
async function commonAsrEvidence(context: Context, asset: AssetVersion, audioGroup?: AudioEvidence | null): Promise<{ map: AsrMap; text: Buffer } | null> {
  if (!['0.5', '0.6', '0.7'].includes(context.policy.version)) throw Error('CATALOG_AUDIO_POLICY_REQUIRED');
  const descriptor = asset.technical.asr, items = asset.technical.evidence, special = items.filter(e => ['asr-audio', 'asr-json', 'asr-map'].includes(e.kind));
  if (!descriptor || descriptor.version !== '0.2') throw Error('CATALOG_ASR_DESCRIPTOR_REQUIRED');
  const policy = context.policy.asr, ids = [descriptor.audioEvidenceId, descriptor.jsonEvidenceId, descriptor.textEvidenceId, descriptor.mapEvidenceId];
  if (descriptor.engine) validateAsrEngine(descriptor.engine);
  if (!['completed', 'no-text'].includes(descriptor.status)) {
    if (!descriptor.reason || ids.some(id => id !== null) || descriptor.segments || special.length || items.some(e => e.kind === 'text') ||
        (descriptor.status === 'disabled' ? policy.enabled || descriptor.engine !== null : !policy.enabled || !['partial', 'failed', 'unsupported'].includes(asset.technical.status))) throw Error('CATALOG_ASR_REFUSAL_INVALID');
    return null;
  }
  if (!policy.enabled || !descriptor.engine || ids.some(id => id === null) || new Set(ids).size !== 4 || special.length !== 2 ||
      items.some(e => e.kind === 'asr-audio') || items.filter(e => e.kind === 'text').length !== 1 || !['supported', 'partial'].includes(asset.technical.status)) throw Error('CATALOG_ASR_DESCRIPTOR_INVALID');
  const group = audioGroup === undefined ? await audioEvidence(context, asset) : audioGroup; if (!group) throw Error('CATALOG_ASR_AUDIO_INPUT_REQUIRED');
  const [audio, raw, text, mapFile] = ids.map(id => items.find(e => e.id === id)), limits = asrLimits(context.policy);
  if (audio?.kind !== 'audio-canonical' || raw?.kind !== 'asr-json' || text?.kind !== 'text' || mapFile?.kind !== 'asr-map' ||
      !raw.path.endsWith('.json') || !text.path.endsWith('.txt') || !mapFile.path.endsWith('.json')) throw Error('CATALOG_ASR_EVIDENCE_INVALID');
  const read = async (entry: typeof raw, maximum: number) => { const value = await readFixed(context.files.projectPath(join(context.dir, entry.path)), maximum, context.signal, context.read); if (value.bytes !== entry.bytes || value.sha256 !== entry.sha256) throw Error('CATALOG_ASR_EVIDENCE_CHANGED'); return value.data; };
  const jsonData = await read(raw, limits.maxAsrRawBytes), textData = await read(text, limits.maxAsrTextBytes), mapData = await read(mapFile, limits.maxAsrMapBytes),
    map = validateAsrMap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mapData)), textData, group.wav, jsonData, limits);
  if (map.version !== '0.2' || map.source.bytes > limits.maxAsrSourceBytes || digest(map.engine) !== digest(validateAsrEngine(asrRuntimeIdentity())) ||
      map.engine.lockSha256 !== group.map.runtime.lockSha256 || digest(map.engine.tools) !== digest(group.map.runtime.tools) ||
      map.source.bytes !== asset.source.bytes || map.source.sha256 !== asset.source.sha256 || map.source.audioInputMapEvidenceId !== group.mapEvidenceId ||
      map.source.audioInputMapSha256 !== group.mapSha256 || digest(map.source.input) !== digest(group.map.input) ||
      digest(map.sourcePcm) !== digest(group.map.sourcePcm) || digest(map.audio) !== digest(group.map.audio) ||
      map.rawJson.evidenceId !== raw.id || map.text.evidenceId !== text.id || map.policySha256 !== asset.inspection.policySha256 || map.language !== policy.language ||
      digest(map.engine) !== digest(descriptor.engine) || digest(map) !== mapFile.sha256 || descriptor.segments !== map.segments.length ||
      descriptor.status !== (map.status === 'text' ? 'completed' : 'no-text') || [raw, text, mapFile].some(e => e.coverage !== 'full') ||
      !asset.technical.text || asset.technical.text.bytes !== textData.length || asset.technical.text.lines !== textData.toString('utf8').split('\n').length ||
      asset.technical.text.bom || asset.technical.text.lineEndings !== (textData.includes(10) ? 'LF' : 'none')) throw Error('CATALOG_ASR_BINDING_INVALID');
  const origin = await audioOrigin(context, asset), runs = origin.tools.filter(run => run.version === `${map.engine.providerVersion}/asr-json@0.1` &&
    run.executable.endsWith('/' + map.engine.program.path) && run.binaryBytes === raw.bytes && run.error === null && run.exitCode === 0 && run.signal === null);
  const root = group.map.cwd.slice(0, group.map.cwd.lastIndexOf(`/out/.tmp/catalog-${origin.attemptId}/`));
  const commands = [];
  for (const name of await context.files.children(join(context.dir, 'runs', origin.attemptId))) if (/^asr-command-[a-f0-9-]{36}\.json$/.test(name)) commands.push((await json(context, `runs/${origin.attemptId}/${name}`)).value);
  const matching = runs.filter(run => {
    const model = run.argv[run.argv.indexOf('-m') + 1], submitted = run.argv[run.argv.indexOf('-f') + 1];
    if (!model?.startsWith('/') || model !== run.executable.slice(0, -map.engine.program.path.length) + map.engine.model.path ||
        submitted !== `${root}/out/.tmp/catalog-${origin.attemptId}/${asset.inspectionId}/${audio.id}.wav` ||
        JSON.stringify(run.argv) !== JSON.stringify(asrArguments(map.language, model, submitted)) || run.stdoutBytes !== 0 || run.stdout !== '' ||
        !commands.some(command => command && Object.keys(command).sort().join() === 'cwd,kind,run,version' && command.version === '0.1' && command.kind === 'asr-command' &&
          typeof command.cwd === 'string' && command.cwd.startsWith(`${root}/out/.tmp/catalog-${origin.attemptId}/`) && /^asr-[a-f0-9-]{36}$/.test(command.cwd.slice(`${root}/out/.tmp/catalog-${origin.attemptId}/`.length)) && digest(command.run) === digest(run))) return false;
    try { const parsed = parseAsrJson(jsonData, map.audio.samples, map.language, limits, model); return parsed.text.equals(textData) && digest(parsed.segments) === digest(map.segments) && parsed.status === map.status; } catch { return false; }
  });
  if (!matching.length) throw Error('CATALOG_ASR_REPLAY_INVALID');
  return { map, text: textData };
}
async function asrObservation(context: Context, asset: AssetVersion, record: AsrObservation): Promise<void> {
  const evidence = await asrEvidence(context, asset), descriptor = asset.technical.asr, loc = record.locator;
  if (!evidence || !descriptor || loc.evidenceId !== descriptor.textEvidenceId || loc.mapEvidenceId !== descriptor.mapEvidenceId || loc.audioEvidenceId !== descriptor.audioEvidenceId || [loc.evidenceId, loc.mapEvidenceId, loc.audioEvidenceId].some(id => !record.evidenceRefs.includes(id))) throw Error('CATALOG_ASR_OBSERVATION_EVIDENCE_MISMATCH');
  const segment = evidence.map.segments.find(s => s.id === loc.segmentId);
  if (!segment || loc.byteStart < segment.byteStart || loc.byteStart >= loc.byteEnd || loc.byteEnd > segment.byteEnd || record.coverage === 'full' && (loc.byteStart !== segment.byteStart || loc.byteEnd !== segment.byteEnd)) throw Error('CATALOG_ASR_RANGE_INVALID');
  for (const position of [loc.byteStart, loc.byteEnd]) try { new TextDecoder('utf-8', { fatal: true }).decode(evidence.text.subarray(segment.byteStart, position)); } catch { throw Error('CATALOG_ASR_TEXT_BOUNDARY_INVALID'); }
}
export async function validateObservation(context: Context, assets: AssetVersion[], record: Observation): Promise<void> {
  assertCatalog('observation', record); const asset = versionFor(assets, record); context = await inspectionContext(context, asset); const evidence = asset.technical.evidence.find(e => e.id === record.locator.evidenceId);
  if (!evidence || !record.evidenceRefs.includes(evidence.id) || record.evidenceRefs.some(id => !asset.technical.evidence.some(e => e.id === id))) throw new Error('CATALOG_OBSERVATION_EVIDENCE_MISMATCH');
  if (record.version === '0.2') { await validateDocumentObservation(context, asset, record); return; }
  if (record.version === '0.3') { await ocrObservation(context, asset, record); return; }
  if (record.version === '0.6') { await documentOcrObservation(context, asset, record); return; }
  if (record.version === '0.4' || record.version === '0.5') { if (record.version !== (asset.technical.asr?.version === '0.2' ? '0.5' : '0.4')) throw Error('CATALOG_ASR_OBSERVATION_VERSION_INVALID'); await asrObservation(context, asset, record); return; }
  if (asset.technical.document || ['pdf', 'docx', 'pptx', 'xlsx'].includes(asset.technical.format)) throw new Error('CATALOG_DOCUMENT_LOCATOR_REQUIRED');
  const loc = record.locator;
  if (loc.kind === 'text' && asset.technical.ocr) throw new Error('CATALOG_OCR_LOCATOR_REQUIRED');
  if (loc.kind === 'text' && asset.technical.asr) throw new Error('CATALOG_ASR_LOCATOR_REQUIRED');
  const requireNull = (keys: (keyof LegacyObservation['locator'])[]) => { if (keys.some(k => loc[k] !== null)) throw new Error('CATALOG_LOCATOR_FIELDS_INVALID'); };
  const textKeys = ['byteStart', 'byteEnd', 'lineStart', 'lineEnd'] as const, imageKeys = ['x', 'y', 'width', 'height'] as const, videoKeys = ['streamIndex', 'timeBase', 'pts'] as const, audioKeys = ['sampleRate', 'sampleStart', 'sampleEnd'] as const;
  if (loc.kind === 'text') {
    requireNull([...imageKeys, ...videoKeys, ...audioKeys]);
    if (evidence.kind !== 'text' || textKeys.some(k => loc[k] === null) || loc.byteStart! > loc.byteEnd! || loc.byteEnd! > evidence.bytes) throw new Error('CATALOG_TEXT_RANGE_INVALID');
    const data = (await readFixed(context.files.projectPath(join(context.dir, evidence.path)), context.policy.maxTextBytes, context.signal, context.read)).data;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (const pos of [loc.byteStart!, loc.byteEnd!]) try { decoder.decode(data.subarray(0, pos)); } catch { throw new Error('CATALOG_TEXT_BOUNDARY_INVALID'); }
    const line = (pos: number) => data.subarray(0, pos).toString('utf8').split(/\r\n|\r|\n/).length;
    if (loc.lineStart !== line(loc.byteStart!) || loc.lineEnd !== line(loc.byteEnd! > loc.byteStart! ? loc.byteEnd! - 1 : loc.byteEnd!)) throw new Error('CATALOG_TEXT_LINE_INVALID');
    if (record.coverage === 'full' && (loc.byteStart !== 0 || loc.byteEnd !== evidence.bytes)) throw new Error('CATALOG_COVERAGE_INVALID');
  } else if (loc.kind === 'image' || loc.kind === 'video') {
    requireNull([...textKeys, ...audioKeys]); if (loc.kind === 'image') requireNull([...videoKeys]);
    if (loc.kind === 'image' ? evidence.kind !== 'preview' : evidence.kind !== 'frame') throw new Error('CATALOG_PIXEL_EVIDENCE_INVALID');
    if (imageKeys.some(k => loc[k] === null) || !evidence.width || !evidence.height || loc.x! + loc.width! > evidence.width || loc.y! + loc.height! > evidence.height) throw new Error('CATALOG_PIXEL_RANGE_INVALID');
    if (loc.kind === 'video' && (loc.streamIndex !== evidence.streamIndex || loc.timeBase !== evidence.timeBase || loc.pts !== evidence.pts || record.coverage !== 'sample')) throw new Error('CATALOG_VIDEO_LOCATION_OR_COVERAGE_INVALID');
  } else {
    requireNull([...textKeys, ...imageKeys, 'timeBase', 'pts']);
    if (evidence.kind !== 'audio-pcm' || loc.streamIndex !== evidence.streamIndex || loc.sampleRate !== evidence.sampleRate || loc.sampleStart === null || loc.sampleEnd === null || loc.sampleStart > loc.sampleEnd || loc.sampleEnd > evidence.samples!) throw new Error('CATALOG_AUDIO_RANGE_INVALID');
    if (record.coverage === 'full' && (evidence.coverage !== 'full' || loc.sampleStart !== 0 || loc.sampleEnd !== evidence.samples)) throw new Error('CATALOG_COVERAGE_INVALID');
  }
}
function promptStatement(data: Buffer, statement: string): boolean {
  const entries = data.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  if (!entries.length || entries[0].kind !== 'prompt' || entries.some(e => !['prompt', 'question', 'answer'].includes(e.kind) || typeof e.text !== 'string' || !Number.isFinite(Date.parse(e.timestamp)))) throw new Error('CATALOG_PROMPT_RECORD_INVALID');
  return entries.some(e => ['prompt', 'answer'].includes(e.kind) && e.text.includes(statement));
}
async function validateRights(context: Context, assets: AssetVersion[], record: Rights): Promise<void> {
  assertCatalog('rights', record); const asset = versionFor(assets, record); context = await inspectionContext(context, asset);
  if ((record.status !== 'unknown' || record.thirdPartyRightsStatus !== 'unknown') && asset.technical.streams.some(s => ['video', 'audio'].includes(s.type)) && !record.affectedStreams.length || record.affectedStreams.some(i => !asset.technical.streams.some(s => s.index === i)) || record.status === 'unknown' && record.allowedUses.length || record.status !== 'unknown' && !record.sourceRefs.length || [record.status, record.thirdPartyRightsStatus].includes('documented') && !record.sourceRefs.some(r => r.kind === 'license') || [record.status, record.thirdPartyRightsStatus].includes('user-declared') && !record.sourceRefs.some(r => r.kind === 'prompt')) throw new Error('CATALOG_RIGHTS_SCOPE_INVALID');
  for (const ref of record.sourceRefs) {
    if (!safeCatalogPath(ref.path)) throw new Error('CATALOG_RIGHTS_SOURCE_INVALID');
    // Rights cite frozen prompt snapshots or catalogued license originals only.
    if (ref.kind === 'prompt' ? !/^runs\/catalog-attempt-[a-f0-9-]{36}\/rights-prompt-\d+\.jsonl$/.test(ref.path) : !assets.some(a => a.source.fixedPath === ref.path && a.source.sha256 === ref.sha256)) throw new Error('CATALOG_RIGHTS_SOURCE_INVALID');
    const read = await readFixed(context.files.projectPath(join(context.dir, ref.path)), context.policy.maxTextBytes, context.signal, context.read);
    if (read.bytes !== ref.bytes || read.sha256 !== ref.sha256 || !(ref.kind === 'prompt' ? promptStatement(read.data, ref.statement) : read.data.toString('utf8').includes(ref.statement))) throw new Error('CATALOG_RIGHTS_SOURCE_CHANGED');
  }
}
async function stored(context: Context, catalogId: string, expected: string): Promise<CatalogManifest> {
  if (!catalogIdPattern.test(catalogId)) throw new Error('CATALOG_ID_INVALID');
  const raw = await json(context, `assets/catalogs/${catalogId}/manifest.json`), manifest = assertCatalog<CatalogManifest>('manifest', raw.value);
  if (raw.sha256 !== expected || digest(manifest) !== expected || manifest.catalogId !== catalogId) throw new Error('CATALOG_MANIFEST_CHANGED');
  const policy = assertInspectPolicy(manifest.policy), references: Context = { ...context, policy, toolSource: manifest }, run = `runs/${manifest.attemptId}`;
  const adopted = await json(context, `${run}/inspect-policy.adopted.json`), original = await json(context, `${run}/inspect-policy.source.json`);
  if (digest(adoptInspectPolicy(original.value, policy.version)) !== manifest.policySha256 || digest(assertInspectPolicy(adopted.value)) !== manifest.policySha256 || digest(policy) !== manifest.policySha256 || adopted.sha256 !== manifest.policySha256 || original.sha256 !== manifest.policySourceSha256) throw new Error('CATALOG_POLICY_CHANGED');
  if ((await context.files.children(join(context.dir, 'assets/catalogs', catalogId))).join() !== 'manifest.json') throw new Error('CATALOG_MANIFEST_UNLISTED');
  const isAsrRun = (run: CatalogManifest['tools'][number]) => (policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && run.version === '1.9.5/asr-json@0.1' && manifest.assets.some(a => a.inspection.catalogId === catalogId && a.technical.asr?.engine && run.executable.endsWith('/' + a.technical.asr.engine.program.path));
  const binaryLimit = (version: string) => (policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && version.endsWith('/asr-json@0.1') ? asrLimits(policy).maxAsrRawBytes :
    (policy.version === '0.6' || policy.version === '0.7') && version.endsWith('/document-raster-worker@0.1') ? policy.documentOcr.maxWorkerPayloadBytes :
    ['0.5', '0.6', '0.7'].includes(policy.version) && version.endsWith('/audio-input@0.1/probe') ? 0 :
    ['0.5', '0.6', '0.7'].includes(policy.version) && version.endsWith('/audio-input@0.1/decode') ? audioInputLimits(policy).maxPcmBytes :
    ['0.5', '0.6', '0.7'].includes(policy.version) && version.endsWith('/audio-input@0.1/normalize') ? Math.min(audioInputLimits(policy).maxSamples * 2, audioInputLimits(policy).maxAudioBytes - 44) :
    policy.version === '0.4' && version.endsWith('/asr-audio@0.1') ? Math.min(asrLimits(policy).maxAsrSamples * 2, asrLimits(policy).maxAsrAudioBytes - 44) : policy.version !== '0.1' && version.endsWith('/document-worker@0.1') ? policy.document.maxWorkerPayloadBytes :
    (policy.version === '0.3' || policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && version.endsWith('/ocr-tsv@0.1') ? Math.max(ocrLimits(policy).maxOcrTsvBytes, (policy.version === '0.6' || policy.version === '0.7') ? policy.documentOcr.ocr.maxOcrTsvBytes : 0) :
    (policy.version === '0.3' || policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && version.endsWith('/ocr-raster@0.1') ? 4 * Math.max(ocrLimits(policy).maxOcrSourcePixels, (policy.version === '0.6' || policy.version === '0.7') ? policy.documentOcr.ocr.maxOcrSourcePixels : 0) : policy.maxDerivedBytes;
  const elapsedLimit = (run: CatalogManifest['tools'][number]) => isAsrRun(run) && (policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) ? policy.asr.maxAsrToolElapsedMs :
    ['0.5', '0.6', '0.7'].includes(policy.version) && /\/audio-input@0\.1\/(probe|decode|normalize)$/.test(run.version) ? Math.min(policy.maxToolElapsedMs, policy.audioInput.maxToolElapsedMs) : policy.maxToolElapsedMs;
  if (manifest.counts.selectedFiles > policy.maxSelectedFiles || manifest.counts.sourceBytes > policy.maxTotalSourceBytes || manifest.counts.derivedBytes > policy.maxDerivedBytes || manifest.counts.decodedAudioBytes > policy.maxDecodedAudioBytes || manifest.counts.elapsedMs > policy.maxElapsedMs || manifest.tools.some(t => t.stdoutBytes + t.stderrBytes > policy.maxToolOutputBytes || t.binaryBytes > binaryLimit(t.version) || t.elapsedMs > elapsedLimit(t) + 1000)) throw new Error('CATALOG_COUNTS_INVALID');
  const versions = new Set<string>(), evidenceIds = new Set<string>(), dirs = new Map<string, Set<string>>(), documentOcrBudget = { units: 0, pixels: 0, embeddedBytes: 0 };
  for (const asset of manifest.assets) {
    let toolSource = manifest;
    if (versions.has(asset.assetVersion)) throw new Error('CATALOG_VERSION_DUPLICATE'); versions.add(asset.assetVersion);
    if (asset.inspection.catalogId === catalogId) {
      if (asset.inspection.attemptId !== manifest.attemptId || asset.inspection.policySha256 !== manifest.policySha256 || asset.inspection.policySourceSha256 !== manifest.policySourceSha256) throw new Error('CATALOG_INSPECTION_ORIGIN_INVALID');
    } else {
      const origin = (await index(context))?.value.catalogs.find(e => e.catalogId === asset.inspection.catalogId); if (!origin) throw new Error('CATALOG_INSPECTION_ORIGIN_NOT_COMMITTED');
      const frozen = await json(context, `assets/catalogs/${origin.catalogId}/manifest.json`), ancestor = assertCatalog<CatalogManifest>('manifest', frozen.value);
      toolSource = ancestor;
      if (frozen.sha256 !== origin.manifestSha256 || digest(ancestor) !== frozen.sha256 || ancestor.attemptId !== origin.attemptId || ancestor.attemptId !== asset.inspection.attemptId || !ancestor.assets.some(a => digest(a) === digest(asset))) throw new Error('CATALOG_INSPECTION_ORIGIN_CHANGED');
    }
    const originalContext = await inspectionContext({ ...context, toolSource }, asset); await fixedSource(originalContext, asset.source);
    const prefix = `assets/derived/inspection/${asset.inspectionId}/`; const listed = new Set<string>();
    for (const e of asset.technical.evidence) {
      if (evidenceIds.has(e.id) || !e.path.startsWith(prefix) || !(e.kind === 'asr-audio' && originalContext.policy.version === '0.4' || e.kind === 'audio-canonical' && ['0.5', '0.6', '0.7'].includes(originalContext.policy.version) ? /^evidence-[a-f0-9-]{36}\.wav$/ : /^evidence-[a-f0-9-]{36}\.(txt|json|png|s16le|ppm)$/).test(e.path.slice(prefix.length))) throw new Error('CATALOG_EVIDENCE_IDENTITY_INVALID'); evidenceIds.add(e.id);
      const actual = await readFixed(context.files.projectPath(join(context.dir, e.path)), Math.max(policy.maxDerivedBytes, policy.maxTextBytes), context.signal, context.read, false);
      if (actual.bytes !== e.bytes || actual.sha256 !== e.sha256) throw new Error('CATALOG_EVIDENCE_CHANGED'); listed.add(e.path.slice(prefix.length));
      if (e.kind === 'audio-pcm' && (e.samples !== Math.floor(e.bytes / 2) || e.bytes % 2 || !e.sampleRate) || ['preview', 'frame'].includes(e.kind) && (!e.width || !e.height || !e.sourceWidth || !e.sourceHeight)) throw new Error('CATALOG_EVIDENCE_FACT_INVALID');
    }
    await documentEvidence(originalContext, asset);
    const documentOcr = await documentOcrEvidence(originalContext, asset);
    if (documentOcr && asset.inspection.catalogId === catalogId && (policy.version === '0.6' || policy.version === '0.7')) {
      documentOcrBudget.units += documentOcr.selection.units.length; documentOcrBudget.pixels += documentOcr.pixels; documentOcrBudget.embeddedBytes += documentOcr.embeddedBytes;
      if (documentOcrBudget.units > policy.documentOcr.maxUnitsPerAttempt || documentOcrBudget.pixels > policy.documentOcr.maxTotalPixels || documentOcrBudget.embeddedBytes > policy.documentOcr.maxTotalEmbeddedBytes) throw Error('CATALOG_DOCUMENT_OCR_ATTEMPT_BUDGET_INVALID');
    }
    await ocrEvidence(originalContext, asset);
    const audio = await audioEvidence(originalContext, asset);
    await asrEvidence(originalContext, asset, audio);
    if (dirs.has(prefix)) throw new Error('CATALOG_INSPECTION_DUPLICATE'); dirs.set(prefix, listed);
    let children: string[] = [];
    try { children = await context.files.children(join(context.dir, prefix)); }
    catch (error) { if (listed.size || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (children.some(name => !listed.has(name))) throw new Error('CATALOG_EVIDENCE_UNLISTED');
  }
  if (new Set(manifest.observations.map(r => r.id)).size !== manifest.observations.length || new Set(manifest.rights.map(r => `${r.id}:${r.revision}`)).size !== manifest.rights.length) throw new Error('CATALOG_RECORD_DUPLICATE');
  for (const r of manifest.observations) await validateObservation(references, manifest.assets, r);
  for (const r of manifest.rights) await validateRights(references, manifest.assets, r);
  if (manifest.recordSnapshot) {
    if (manifest.recordSnapshot.path !== `${run}/record.source.json`) throw new Error('CATALOG_RECORD_SNAPSHOT_INVALID');
    const snapshot = await json(context, manifest.recordSnapshot.path);
    if (snapshot.bytes !== manifest.recordSnapshot.bytes || snapshot.sha256 !== manifest.recordSnapshot.sha256) throw new Error('CATALOG_RECORD_SNAPSHOT_CHANGED');
    const record = snapshot.value as Observation | Rights;
    if ('locator' in record ? !manifest.observations.some(r => digest(r) === digest(record)) : !manifest.rights.some(r => { const submitted = structuredClone(r); for (const ref of submitted.sourceRefs) if (ref.kind === 'prompt') ref.path = 'prompt-history.jsonl'; return digest(submitted) === digest(record); })) throw new Error('CATALOG_RECORD_SNAPSHOT_MISMATCH');
  }
  context.check?.(); return manifest;
}
export async function verifyCatalog(projectDir: string, catalogId: string, options: { signal?: AbortSignal; onRead?: (bytes: number) => void } = {}): Promise<CatalogManifest> {
  const dir = resolve(projectDir), files = new NodeImportFiles(dir), deadline = AbortSignal.timeout(DEFAULT_INSPECT_POLICY.maxElapsedMs), signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline, context: Context = { dir, files, policy: DEFAULT_INSPECT_POLICY, signal, read: options.onRead };
  signal.throwIfAborted();
  await files.assertProject(); const idx = await index(context), commit = idx?.value.catalogs.find(v => v.catalogId === catalogId); if (!commit) throw new Error('CATALOG_NOT_COMMITTED');
  const manifest = await stored(context, catalogId, commit.manifestSha256); if (commit.attemptId !== manifest.attemptId) throw new Error('CATALOG_INDEX_IDENTITY_INVALID');
  if (idx!.value.currentCatalogId === catalogId && (idx!.value.assets.some(e => !manifest.assets.some(a => a.assetId === e.assetId && a.assetVersion === e.currentVersion)) || new Set(manifest.assets.map(a => a.assetId)).size !== idx!.value.assets.length)) throw new Error('CATALOG_CURRENT_VERSION_INVALID');
  return manifest;
}
async function recover(context: Context, attemptId: string) {
  const idx = await index(context);
  for (const name of await context.files.attemptDirectories()) {
    if (name === attemptId || !catalogAttemptPattern.test(name)) continue;
    let receipt: CatalogReceipt; try { receipt = assertCatalog('receipt', (await json(context, `runs/${name}/receipt.json`)).value); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (receipt.attemptId !== name || receipt.tempPath !== `out/.tmp/catalog-${name}`) throw new Error('CATALOG_RECOVERY_IDENTITY_INVALID');
    if (!['running', 'prepared'].includes(receipt.status) || alive(receipt.ownerPid, name)) continue;
    const committed = idx?.value.catalogs.find(v => v.catalogId === receipt.catalogId);
    if (committed) {
      const manifest = await stored(context, receipt.catalogId, committed.manifestSha256);
      if (manifest.attemptId !== name || committed.attemptId !== name) throw new Error('CATALOG_RECOVERY_COMMIT_INVALID');
      receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.assets = manifest.assets; receipt.tools = manifest.tools; receipt.counts = { ...manifest.counts, sourceReadBytes: Math.max(receipt.counts.sourceReadBytes, manifest.counts.sourceReadBytes), elapsedMs: Math.max(receipt.counts.elapsedMs, manifest.counts.elapsedMs) }; receipt.manifestPath = `assets/catalogs/${receipt.catalogId}/manifest.json`; receipt.manifestSha256 = committed.manifestSha256; receipt.error = null;
    } else {
      if ((receipt.policy?.version === '0.6' || receipt.policy?.version === '0.7')) {
        const inspections = new Set<string>();
        for (const asset of receipt.assets) {
          if (asset.inspection.attemptId !== name || asset.inspection.catalogId !== receipt.catalogId) throw Error('CATALOG_RECOVERY_ASSET_ORIGIN_INVALID');
          inspections.add(asset.inspectionId);
        }
        if ((receipt.policy?.version === '0.6' || receipt.policy?.version === '0.7')) for (const file of await context.files.children(join(context.dir, 'runs', name))) if (/^document-ocr-command-[a-f0-9-]{36}\.json$/.test(file)) {
          const command = assertDocumentOcr<DocumentOcrInvocationRecord>('invocation', (await json(context, `runs/${name}/${file}`)).value), suffix = `/out/.tmp/catalog-${name}/${command.inspectionId}/document-ocr-`;
          if (!command.cwd.includes(suffix)) throw Error('CATALOG_RECOVERY_COMMAND_ORIGIN_INVALID'); inspections.add(command.inspectionId);
        }
        for (const inspectionId of inspections) {
          const path = join(context.dir, 'assets/derived/inspection', inspectionId), staged = join(context.dir, receipt.tempPath, inspectionId);
          const published = await context.files.inspect(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (published) { await context.files.ensureDirectory(join(context.dir, receipt.tempPath)); await context.files.moveDirectory(path, staged); }
        }
      }
      receipt.status = 'interrupted'; receipt.indexCommitted = false; receipt.error = 'CATALOG_INTERRUPTED: owner stopped before index commit; counters retain last durable observations';
    }
    receipt.finishedAt = new Date().toISOString(); await context.files.writeJson(join(context.dir, 'runs', name, 'receipt.json'), receipt);
  }
}
export async function catalogAssets(projectDir: string, selection: CatalogSelection, options: CatalogOptions = {}): Promise<CatalogReceipt> {
  const dir = resolve(projectDir), attemptId = `catalog-attempt-${randomUUID()}`, catalogId = `catalog-${randomUUID()}`, tempPath = `out/.tmp/catalog-${attemptId}`, temporaryDir = join(dir, tempPath), runDir = join(dir, 'runs', attemptId), receiptPath = join(runDir, 'receipt.json');
  const files = new NodeImportFiles(dir, temporaryDir), lease = new ProjectLease(dir, temporaryDir, 'catalog'), started = performance.now(), deadline = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let asrIdentity: ReturnType<typeof asrRuntimeIdentity> | null = null;
  const publishedInspections: { path: string; staged: string }[] = [];
  let timer: ReturnType<typeof setTimeout>, committed = false, writable = false, lock: string | null = null;
  const receipt: CatalogReceipt = { version: '0.4', kind: 'catalog-receipt', catalogId, attemptId, ownerPid: process.pid, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', phase: 'planning', selection: JSON.stringify(selection), policy: null, policySha256: null, policySourceSha256: null, counts: emptyCatalogCounts(), tools: [], assets: [], tempPath, manifestPath: null, manifestSha256: null, indexCommitted: false, error: null };
  const context: Context = { dir, files, policy: DEFAULT_INSPECT_POLICY, signal, read: bytes => { receipt.counts.sourceReadBytes += bytes; }, check: () => { signal.throwIfAborted(); if (receipt.counts.toolOutputBytes > context.policy.maxCatalogBytes) throw new Error('CATALOG_MANIFEST_LIMIT: accumulated tool metadata'); if (performance.now() - started >= Math.min(DEFAULT_INSPECT_POLICY.maxElapsedMs, context.policy.maxElapsedMs)) { deadline.abort(); signal.throwIfAborted(); } } };
  function setDeadline(ms: number) { clearTimeout(timer); timer = setTimeout(() => deadline.abort(), Math.max(1, ms - (performance.now() - started))); }
  const persist = async () => { receipt.counts.elapsedMs = Math.ceil(performance.now() - started); assertCatalog('receipt', receipt); await files.writeJson(receiptPath, receipt); };
  const phase = async (value: CatalogReceipt['phase']) => { receipt.phase = value; await persist(); await options.hooks?.onPhase?.(structuredClone(receipt)); context.check!(); };
  active.add(attemptId); setDeadline(DEFAULT_INSPECT_POLICY.maxElapsedMs);
  try {
    await files.assertProject(); await files.ensureDirectory(runDir); writable = true; await persist(); lock = await lease.acquireLock({ attemptId, catalogId, pid: process.pid }, alive, signal);
    const policyPath = join(dir, 'inputs/inspect-policy.json'); if ((await files.inspect(policyPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) === null) await files.writeJson(policyPath, DEFAULT_INSPECT_POLICY);
    const rawPolicy = await readFixed(policyPath, DEFAULT_INSPECT_POLICY.maxCatalogBytes, signal, context.read), policy = adoptInspectPolicy(JSON.parse(rawPolicy.data.toString('utf8')));
    receipt.version = policy.version === '0.7' ? '0.7' : policy.version === '0.6' ? '0.6' : policy.version === '0.5' ? '0.5' : '0.4'; receipt.policy = policy; receipt.policySha256 = digest(policy); receipt.policySourceSha256 = rawPolicy.sha256; context.policy = policy; setDeadline(Math.min(DEFAULT_INSPECT_POLICY.maxElapsedMs, policy.maxElapsedMs));
    await files.copy(policyPath, join(runDir, 'inspect-policy.source.json'), await files.inspect(policyPath), async () => { context.check!(); }, signal);
    if ((await readFixed(join(runDir, 'inspect-policy.source.json'), DEFAULT_INSPECT_POLICY.maxCatalogBytes, signal)).sha256 !== rawPolicy.sha256) throw new Error('CATALOG_POLICY_CHANGED');
    await files.writeJson(join(runDir, 'inspect-policy.adopted.json'), policy); await persist(); await recover(context, attemptId); await phase('planning');
    const oldIndex = await index(context); if (oldIndex && Number(oldIndex.value.version) > Number(receipt.version)) receipt.version = oldIndex.value.version; let old: CatalogManifest | null = null;
    for (const entry of oldIndex?.value.catalogs ?? []) { const prior = await stored(context, entry.catalogId, entry.manifestSha256); if (prior.attemptId !== entry.attemptId) throw new Error('CATALOG_PRIOR_IDENTITY_INVALID'); if (entry.catalogId === oldIndex!.value.currentCatalogId) old = prior; }
    const assets = structuredClone(old?.assets ?? []), observations = structuredClone(old?.observations ?? []), rights = structuredClone(old?.rights ?? []);
    let recordSnapshot: CatalogManifest['recordSnapshot'] = null;
    if ('observation' in selection || 'rights' in selection) {
      const path = 'observation' in selection ? selection.observation : selection.rights;
      const raw = await json(context, path); await files.copy(files.projectPath(join(dir, path)), join(runDir, 'record.source.json'), await files.inspect(join(dir, path)), async () => context.check!(), signal);
      const snapshot = await json(context, `runs/${attemptId}/record.source.json`); if (snapshot.sha256 !== raw.sha256) throw new Error('CATALOG_RECORD_CHANGED'); recordSnapshot = { path: `runs/${attemptId}/record.source.json`, sha256: raw.sha256, bytes: raw.bytes };
      if ('observation' in selection) { const record = assertCatalog<Observation>('observation', raw.value); await validateObservation(context, assets, record); if (observations.some(r => r.id === record.id)) throw new Error('CATALOG_OBSERVATION_DUPLICATE'); observations.push(record); }
      else {
        const record = assertCatalog<Rights>('rights', raw.value), previous = rights.filter(r => r.id === record.id);
        if (record.revision !== (previous.length ? Math.max(...previous.map(r => r.revision)) + 1 : 1) || previous.some(r => r.assetId !== record.assetId || r.assetVersion !== record.assetVersion || r.byteSha256 !== record.byteSha256)) throw new Error('CATALOG_RIGHTS_REVISION_INVALID');
        let count = 0;
        for (const ref of record.sourceRefs) if (ref.kind === 'prompt') {
          if (ref.path !== 'prompt-history.jsonl') throw new Error('CATALOG_PROMPT_SOURCE_INVALID');
          const src = await readFixed(join(dir, ref.path), policy.maxTextBytes, signal, context.read);
          if (ref.bytes !== src.bytes || ref.sha256 !== src.sha256 || !promptStatement(src.data, ref.statement)) throw new Error('CATALOG_PROMPT_SOURCE_CHANGED');
          const fixed = `runs/${attemptId}/rights-prompt-${count++}.jsonl`; await files.copy(join(dir, ref.path), join(dir, fixed), await files.inspect(join(dir, ref.path)), async () => context.check!(), signal); ref.path = fixed;
        }
        await validateRights(context, assets, record); rights.push(record);
      }
    } else {
      const selected = await sources(context, selection);
      if (selection.assetId && (selected.length !== 1 || !selection.path || !assets.some(a => a.assetId === selection.assetId))) throw new Error('CATALOG_REPLACEMENT_INVALID');
      let documents = 0, images = 0, audios = 0, commonAudios = 0; const documentOcrBudget = { units: 0, pixels: 0, embeddedBytes: 0 };
      receipt.counts.selectedFiles = selected.length; receipt.counts.sourceBytes = selected.reduce((n, s) => n + s.bytes, 0); await phase('inspecting');
      for (const source of selected) {
        context.check!(); await fixedSource(context, source);
        const { format, header } = await inspectFormat(files.projectPath(join(dir, source.fixedPath)), source.path, { projectDir: dir, temporaryDir, evidenceDir: temporaryDir, publishedDir: '', policy, counts: receipt.counts, tools: receipt.tools, signal, check: context.check! });
        if (['pdf', 'docx', 'pptx', 'xlsx'].includes(format) && ++documents > documentLimits(policy).maxDocumentsPerAttempt) throw new Error('CATALOG_DOCUMENT_COUNT_LIMIT');
        if ((policy.version === '0.3' || policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && policy.ocr.enabled && ['png_pipe', 'jpeg_pipe'].includes(format) && ++images > policy.ocr.maxOcrImagesPerAttempt) throw new Error('CATALOG_OCR_IMAGE_COUNT_LIMIT');
        const sameSource = assets.filter(a => digest(a.source) === digest(source)), latestSource = sameSource.at(-1),
          existing = (policy.version === '0.6' || policy.version === '0.7') ? latestSource?.inspection.policySha256 === receipt.policySha256 ? latestSource : undefined : sameSource[0];
        if (existing) { if (selection.assetId && existing.assetId !== selection.assetId) throw new Error('CATALOG_SOURCE_ALREADY_ASSOCIATED'); continue; }
        const commonAudio = ['0.5', '0.6', '0.7'].includes(policy.version) && (['wav', 'mp3', 'flac'].includes(format) || /\.m4a$/i.test(source.path));
        if (commonAudio && ++commonAudios > audioInputLimits(policy).maxAudiosPerAttempt) throw Error('CATALOG_AUDIO_COUNT_LIMIT');
        const selectedAsr = (policy.version === '0.4' || policy.version === '0.5' || (policy.version === '0.6' || policy.version === '0.7')) && policy.asr.enabled && (policy.version === '0.4' ? format === 'wav' : commonAudio);
        if (selectedAsr && ++audios > policy.asr.maxAsrAudiosPerAttempt) throw new Error('CATALOG_ASR_AUDIO_COUNT_LIMIT');
        if (selectedAsr) { const current = asrRuntimeIdentity(); if (asrIdentity && digest(asrIdentity) !== digest(current)) throw Error('CATALOG_ASR_RUNTIME_CHANGED'); asrIdentity = current; }
        const assetId = selection.assetId ?? ((policy.version === '0.6' || policy.version === '0.7') ? sameSource.at(-1)?.assetId : undefined) ?? `asset-${randomUUID()}`, assetVersion = `asset-version-${randomUUID()}`, inspectionId = `inspection-${randomUUID()}`, publishedDir = `assets/derived/inspection/${inspectionId}`, evidenceDir = join(temporaryDir, inspectionId);
        const before = await files.inspect(join(dir, source.fixedPath));
        const technical = await inspectAsset(files.projectPath(join(dir, source.fixedPath)), source.path, { projectDir: dir, temporaryDir, evidenceDir, publishedDir, policy, counts: receipt.counts, tools: receipt.tools, signal, check: context.check!, sourceBytes: source.bytes, sourceSha256: source.sha256, policySha256: receipt.policySha256!,
          format, header, documentOcrBudget, recordDocumentOcrInvocation: async value => {
            assertDocumentOcr('invocation', value); const data = Buffer.from(importJsonText(value)), path = `runs/${attemptId}/document-ocr-command-${randomUUID()}.json`;
            if (data.length > Math.min(policy.maxCatalogBytes, (policy.version === '0.6' || policy.version === '0.7') ? policy.documentOcr.maxMapBytes : 0)) throw Error('CATALOG_DOCUMENT_OCR_COMMAND_LIMIT');
            if (receipt.counts.derivedBytes + data.length > policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT'); receipt.counts.derivedBytes += data.length;
            await files.writeJson(join(dir, path), value); return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
          }, recordAsrInvocation: async (run, cwd) => { await files.writeJson(join(runDir, `asr-command-${randomUUID()}.json`), { version: '0.1', kind: 'asr-command', cwd, run }); } });
        if (asrIdentity && digest(asrRuntimeIdentity()) !== digest(asrIdentity)) throw Error('CATALOG_ASR_RUNTIME_CHANGED_AFTER_INSPECTION');
        if (JSON.stringify(before) !== JSON.stringify(await files.inspect(join(dir, source.fixedPath)))) throw new Error('CATALOG_SOURCE_CHANGED: analysis node'); await fixedSource(context, source);
        publishedInspections.push({ path: join(dir, publishedDir), staged: evidenceDir }); await files.moveDirectory(evidenceDir, join(dir, publishedDir));
        const unknown = () => ({ result: 'unknown', reason: 'Requires a separate content/usage assessment.' });
        const asset: AssetVersion = { assetId, assetVersion, inspectionId, inspection: { catalogId, attemptId, policySha256: receipt.policySha256!, policySourceSha256: receipt.policySourceSha256! }, source, technical, usability: { technical: { result: technical.status, reason: technical.reason || 'Measured by the recorded adapter.' }, semanticMatch: unknown(), compositionFit: unknown(), continuityFit: unknown(), rightsScope: unknown() } };
        assets.push(asset); receipt.assets.push(asset); if (Buffer.byteLength(importJsonText({ assets, observations, rights, tools: receipt.tools })) > policy.maxCatalogBytes) throw new Error('CATALOG_MANIFEST_LIMIT: accumulated material'); await persist(); await options.hooks?.afterInspection?.(structuredClone(asset), structuredClone(receipt)); context.check!();
      }
    }
    await phase('verifying');
    const manifest: CatalogManifest = { version: receipt.version, kind: 'catalog-manifest', catalogId, attemptId, createdAt: new Date().toISOString(), previousCatalogId: old?.catalogId ?? null, policy, policySha256: receipt.policySha256!, policySourceSha256: receipt.policySourceSha256!, counts: { ...receipt.counts }, tools: receipt.tools, assets, observations, rights, recordSnapshot };
    const bytes = Buffer.byteLength(importJsonText(manifest)); if (bytes > policy.maxCatalogBytes) throw new Error('CATALOG_MANIFEST_LIMIT'); assertCatalog('manifest', manifest);
    receipt.manifestPath = `assets/catalogs/${catalogId}/manifest.json`; receipt.manifestSha256 = digest(manifest); await files.writeJson(join(dir, receipt.manifestPath), manifest);
    await stored(context, catalogId, receipt.manifestSha256); context.check!(); receipt.status = 'prepared'; await phase('committing');
    const ocrAssets = receipt.assets.filter(a => a.technical.ocr && ['completed', 'no-text'].includes(a.technical.ocr.status));
    if (ocrAssets.length) { const identity = ocrRuntimeIdentity(); if (ocrAssets.some(a => digest(a.technical.ocr!.engine) !== digest(identity))) throw new Error('CATALOG_OCR_RUNTIME_CHANGED_BEFORE_COMMIT'); }
    const documentOcrAssets = receipt.assets.filter(a => a.technical.documentOcr?.mapEvidenceId);
    if (documentOcrAssets.length) {
      const runtime = documentRasterRuntimeIdentity(), engine = ocrRuntimeIdentity();
      if (documentOcrAssets.some(a => digest(a.technical.documentOcr!.runtime) !== digest(runtime) || digest(a.technical.documentOcr!.engine) !== digest(engine))) throw Error('CATALOG_DOCUMENT_OCR_RUNTIME_CHANGED_BEFORE_COMMIT');
    }
    if (asrIdentity && digest(asrRuntimeIdentity()) !== digest(asrIdentity)) throw new Error('CATALOG_ASR_RUNTIME_CHANGED_BEFORE_COMMIT');
    await stored(context, catalogId, receipt.manifestSha256); if ((await index(context))?.sha256 !== oldIndex?.sha256) throw new Error('CATALOG_INDEX_CHANGED'); context.check!();
    const current = new Map((oldIndex?.value.assets ?? []).map(a => [a.assetId, a.currentVersion])); for (const a of receipt.assets) current.set(a.assetId, a.assetVersion);
    const updated: CatalogIndex = { version: receipt.version, kind: 'catalog-index', currentCatalogId: catalogId, catalogs: [...(oldIndex?.value.catalogs ?? []), { catalogId, attemptId, manifestSha256: receipt.manifestSha256 }], assets: [...current].map(([assetId, currentVersion]) => ({ assetId, currentVersion })) };
    assertCatalog('index', updated); if (Buffer.byteLength(importJsonText(updated)) > policy.maxCatalogBytes) throw new Error('CATALOG_INDEX_LIMIT'); await files.writeJson(join(dir, 'assets/catalog.json'), updated); committed = true;
    receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.finishedAt = new Date().toISOString(); await options.hooks?.afterIndexCommitted?.(structuredClone(receipt)); await persist(); return receipt;
  } catch (error) {
    receipt.error = deadline.signal.aborted ? 'CATALOG_TIME_LIMIT' : message(error); receipt.finishedAt = new Date().toISOString();
    if (!committed && receipt.manifestSha256) try { const idx = await index({ ...context, signal: undefined, check: undefined }); const entry = idx?.value.catalogs.find(e => e.catalogId === catalogId); if (entry?.attemptId === attemptId && entry.manifestSha256 === receipt.manifestSha256) { await stored({ ...context, signal: undefined, check: undefined }, catalogId, receipt.manifestSha256); committed = true; } } catch { /* A committed identity requires complete verification. */ }
    receipt.status = committed ? 'succeeded' : options.signal?.aborted ? 'interrupted' : 'failed'; receipt.indexCommitted = committed;
    if (!committed && (receipt.policy?.version === '0.6' || receipt.policy?.version === '0.7')) for (const publication of publishedInspections.toReversed()) {
      try {
        const published = await files.inspect(publication.path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (published) await files.moveDirectory(publication.path, publication.staged);
      } catch (rollbackError) { receipt.error += `; CATALOG_DERIVED_ROLLBACK_FAILED: ${message(rollbackError)}`; }
    }
    const detailLimit = Math.max(4096, Math.min(DEFAULT_INSPECT_POLICY.maxCatalogBytes, context.policy.maxCatalogBytes));
    if (Buffer.byteLength(importJsonText(receipt)) > detailLimit) {
      receipt.error += '; CATALOG_RECEIPT_DETAILS_LIMIT: latest item/tool detail omitted; counters retain measured facts';
      while (Buffer.byteLength(importJsonText(receipt)) > detailLimit && (receipt.assets.length || receipt.tools.length)) { if (receipt.assets.length) receipt.assets.pop(); else receipt.tools.pop(); }
    }
    if (writable) try { await persist(); } catch (e) { receipt.error += `; CATALOG_RECEIPT_WRITE_FAILED: ${message(e)}`; }
    throw new CatalogFailure(receipt, writable ? receiptPath : null, error);
  } finally {
    clearTimeout(timer); try { if (lock) await lease.releaseLock(lock, attemptId); } catch (e) { receipt.error = `${receipt.error ?? ''}; CATALOG_CLEANUP_FAILED: ${message(e)}`; if (writable) await persist().catch(() => undefined); } active.delete(attemptId);
  }
}
