import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { documentRasterRuntimeIdentity, ocrRuntimeIdentity } from '../../workspace.mjs';
import { ensureImportDirectory, importJsonText, NodeImportFiles } from './import-files.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';
import { decodeOcrRaster, preflightOcrImage } from './ocr-raster.ts';
import { parseOcrTsv } from './ocr-tsv.ts';
import { documentLimits, type Evidence, type InspectPolicy, type Technical, type ToolRun } from '../project/catalog.ts';
import { validateOcrEngine, type OcrEngineIdentity } from '../project/ocr.ts';
import { assertDocumentOcr, validateDocumentOcrSelectionMap, validateDocumentOcrUnitMap, validateDocumentRasterRuntime,
  type DocumentOcrInvocationRecord, type DocumentOcrPolicy, type DocumentOcrSelectionMap, type DocumentOcrUnitMap, type DocumentRasterRequest,
  type DocumentRasterResult, type DocumentRasterRuntimeIdentity } from '../project/document-ocr.ts';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const identity = (value: unknown) => digest(Buffer.from(importJsonText(value)));
const degraded = /Failed loading language|Error opening data file|Could not initialize tesseract|couldn't load any languages|LSTM requested,? but not present|Loading tesseract/i;
export const documentOcrScope = (format: 'pdf' | 'docx') => format === 'pdf' ? 'selected-pdf-page-pixels' as const : 'selected-docx-embedded-source-pixels' as const;
export const documentOcrRasterTransform = (format: 'pdf' | 'docx') => format === 'pdf' ? 'selected viewport pixels; white background; locator transform' : 'identity; white background; autorotate disabled';
export const documentOcrArguments = (raster: string, models: string) => [raster, 'stdout', '--tessdata-dir', models,
  '-l', 'chi_sim+eng+~chi_sim_vert', '--oem', '1', '--psm', '3', '--dpi', '300', '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0'];
export function effectiveDocumentOcrPolicy(policy: InspectPolicy): DocumentOcrPolicy {
  if ((policy.version !== '0.6' && policy.version !== '0.7')) throw Error('CATALOG_DOCUMENT_OCR_POLICY_REQUIRED');
  const selected = policy.documentOcr;
  return { ...selected, maxSourceBytes: Math.min(selected.maxSourceBytes, policy.maxSourceBytes),
    maxPixelsPerUnit: Math.min(selected.maxPixelsPerUnit, policy.maxSourcePixels), ocr: { ...selected.ocr,
      maxOcrSourceBytes: Math.min(selected.ocr.maxOcrSourceBytes, policy.maxSourceBytes),
      maxOcrSourcePixels: Math.min(selected.ocr.maxOcrSourcePixels, policy.maxSourcePixels),
      maxOcrTextBytes: Math.min(selected.ocr.maxOcrTextBytes, policy.maxTextBytes) } };
}
function admit(context: InspectContext, bytes: number): void {
  context.signal.throwIfAborted(); context.check();
  if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT');
  context.counts.derivedBytes += bytes;
}
async function write(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
function fatal(error: unknown, context: InspectContext): string {
  context.signal.throwIfAborted(); context.check(); const message = error instanceof Error ? error.message : String(error);
  if (/^(?:CATALOG_(?:SOURCE_CHANGED|DERIVED_LIMIT|DOCUMENT_OCR_(?:UNIT|PIXEL|EMBEDDED)_COUNT_LIMIT)|DOCUMENT_RASTER_RUNTIME_|OCR_RUNTIME_|IMPORT_)/.test(message)) throw error;
  return message;
}
export function documentRasterRequest(source: string, format: 'pdf' | 'docx', unit: number, bytes: number, sha256: string,
  policy: InspectPolicy, runtime: DocumentRasterRuntimeIdentity): DocumentRasterRequest {
  const { enabled, pdfPages, docxImages, dpi, ocr, ...limits } = effectiveDocumentOcrPolicy(policy);
  return assertDocumentOcr<DocumentRasterRequest>('request', { version: '0.1', kind: 'document-raster-request', format,
    sourcePath: source, sourceBytes: bytes, sourceSha256: sha256, unit, dpi, limits, documentLimits: documentLimits(policy), ocrLimits: ocr, runtime });
}
/** One bounded worker protocol and one private request file per selected unit. */
export async function runDocumentRaster(request: DocumentRasterRequest, context: InspectContext, cwd: string): Promise<{ result: DocumentRasterResult; run: ToolRun }> {
  assertDocumentOcr('request', request); const path = join(cwd, 'request.json'), data = Buffer.from(importJsonText(request)); admit(context, data.length); await write(path, data);
  const executable = await realpath(process.execPath), worker = new NodeImportFiles(context.projectDir).projectPath(join(context.projectDir, '.engine/src/adapters/document-raster-worker.ts')), chunks: Buffer[] = [];
  let callbackFault: unknown;
  const run = await runInspectionTool({ executable, version: `node@${process.versions.node}/document-raster-worker@0.1`,
    argv: [`--max-old-space-size=${request.limits.workerOldSpaceMiB}`, worker, path], cwd,
    policy: { ...context.policy, maxToolElapsedMs: Math.min(request.limits.workerElapsedMs, context.policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
    signal: context.signal, binaryLimit: request.limits.maxWorkerPayloadBytes,
    binary: async chunk => { try { admit(context, chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
    onRun: value => { context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
  if (callbackFault) throw callbackFault; context.signal.throwIfAborted(); context.check();
  const firstLine = run.stderr.split('\n', 1)[0]!;
  if (firstLine.startsWith('DOCUMENT_RASTER_FATAL:')) {
    let wire: unknown; try { wire = JSON.parse(firstLine.slice('DOCUMENT_RASTER_FATAL:'.length)); } catch { throw Error('DOCUMENT_RASTER_RUNTIME_FATAL_PROTOCOL_INVALID'); }
    if (!wire || typeof wire !== 'object' || Object.keys(wire).join() !== 'code' || typeof (wire as { code?: unknown }).code !== 'string' ||
        !/^(?:CATALOG_SOURCE_CHANGED|DOCUMENT_RASTER_RUNTIME_)/.test((wire as { code: string }).code)) throw Error('DOCUMENT_RASTER_RUNTIME_FATAL_PROTOCOL_INVALID');
    throw Error((wire as { code: string }).code);
  }
  if (run.error) throw Error(`DOCUMENT_OCR_WORKER_FAILED: ${run.error}`);
  const result = assertDocumentOcr<DocumentRasterResult>('result', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  if (result.format !== request.format || result.unit !== request.unit || result.source.bytes !== request.sourceBytes || result.source.sha256 !== request.sourceSha256) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: source/unit');
  if (/^(?:CATALOG_SOURCE_CHANGED|DOCUMENT_RASTER_RUNTIME_)/.test(result.reason)) throw Error(result.reason);
  const metrics = result.metrics;
  context.counts.sourceReadBytes += metrics.readBytes;
  if (result.status === 'failed') { if (!result.reason || result.payload) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: failure'); return { result, run }; }
  if (metrics.expandedBytes > request.documentLimits.maxDocxDeclaredExpandedBytes || metrics.xmlNodes > request.documentLimits.maxXmlNodes ||
      metrics.decodedStreamBytes > request.limits.maxPdfDecodedStreamBytes || metrics.canvasLivePeakPixels > request.limits.maxCanvasLivePixels ||
      metrics.canvasAllocationPixels > request.limits.maxCanvasAllocationPixels || metrics.resourceBytes > request.limits.maxRuntimeResourceBytes ||
      result.totalUnits > (request.format === 'pdf' ? request.limits.maxPdfDocumentPages : request.limits.maxImageOccurrences)) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: metrics/units');
  const loc = result.locator, payload = result.payload;
  if (!loc || !payload || result.reason || request.unit > result.totalUnits || (loc.kind === 'pdf-page') !== (request.format === 'pdf') ||
      request.unit !== (loc.kind === 'pdf-page' ? loc.page : loc.occurrence) || loc.width > request.limits.maxEdge || loc.height > request.limits.maxEdge ||
      loc.width * loc.height > request.limits.maxPixelsPerUnit || loc.width > request.ocrLimits.maxOcrEdge || loc.height > request.ocrLimits.maxOcrEdge ||
      loc.width * loc.height > request.ocrLimits.maxOcrSourcePixels) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: locator');
  const bytes = Buffer.from(payload.dataBase64, 'base64');
  if (bytes.toString('base64') !== payload.dataBase64 || bytes.length !== payload.bytes || digest(bytes) !== payload.sha256 ||
      bytes.length > (loc.kind === 'pdf-page' ? request.limits.maxRasterBytes : Math.min(request.limits.maxEmbeddedBytesPerUnit, request.ocrLimits.maxOcrSourceBytes))) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: payload');
  if (loc.kind === 'pdf-page') {
    const prefix = Buffer.from(`P6\n${loc.width} ${loc.height}\n255\n`);
    if (payload.format !== 'ppm' || !bytes.subarray(0, prefix.length).equals(prefix) || bytes.length !== prefix.length + 3 * loc.width * loc.height || loc.dpi !== request.dpi || loc.scale !== request.dpi / 72) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: PPM');
  } else {
    if (payload.format !== loc.format || payload.bytes !== loc.embeddedBytes || payload.sha256 !== loc.embeddedSha256) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: embedded identity');
    const header = preflightOcrImage(bytes, loc.format, request.ocrLimits);
    if (header.width !== loc.width || header.height !== loc.height) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: embedded geometry');
  }
  return { result, run };
}
/** Both publication and verification rebuild the same source pixels. */
export async function documentRasterPixels(result: DocumentRasterResult, context: InspectContext, engine: OcrEngineIdentity, cwd: string): Promise<Buffer> {
  if (result.status !== 'complete' || !result.locator || !result.payload) throw Error('DOCUMENT_OCR_UNIT_UNAVAILABLE');
  const bytes = Buffer.from(result.payload.dataBase64, 'base64');
  if (result.locator.kind === 'pdf-page') return bytes;
  const selected = effectiveDocumentOcrPolicy(context.policy), path = join(cwd, 'embedded.image'); admit(context, bytes.length); await write(path, bytes);
  const policy = { ...context.policy, ocr: { enabled: true, ...selected.ocr } } as InspectPolicy;
  const header = preflightOcrImage(bytes, result.locator.format, selected.ocr);
  return (await decodeOcrRaster(path, header, { ...context, temporaryDir: cwd, policy, sourceBytes: bytes.length, sourceSha256: result.payload.sha256 }, engine.tools.ffmpeg)).ppm;
}
export async function documentRasterOcr(ppm: Buffer, width: number, height: number, context: InspectContext, engine: OcrEngineIdentity, cwd: string) {
  const policy = effectiveDocumentOcrPolicy(context.policy), files = new NodeImportFiles(context.projectDir), rasterPath = join(cwd, 'raster.ppm');
  admit(context, ppm.length); await write(rasterPath, ppm); const chunks: Buffer[] = []; let callbackFault: unknown;
  const run = await runInspectionTool({ executable: engine.tools.tesseract.executable, version: `${engine.tools.tesseract.version}/ocr-tsv@0.1`,
    argv: documentOcrArguments(rasterPath, files.projectPath(join(context.projectDir, '.engine/assets/ocr/tessdata'))), cwd,
    policy: { ...context.policy, maxToolElapsedMs: Math.min(30000, context.policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
    signal: context.signal, ocr: true, binaryLimit: policy.ocr.maxOcrTsvBytes,
    binary: async chunk => { try { admit(context, chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
    onRun: value => { context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
  if (callbackFault) throw callbackFault; if (run.error) throw Error(`DOCUMENT_OCR_TOOL_FAILED: ${run.error}`); if (degraded.test(run.stderr)) throw Error('OCR_INITIALIZATION_DEGRADED');
  const tsv = Buffer.concat(chunks); return { tsv, run, ...parseOcrTsv(tsv, width, height, policy.ocr) };
}
/** Native text and selected pixel OCR publish independent, closed evidence groups. */
export async function inspectDocumentOcr(source: string, format: 'pdf' | 'docx', result: Technical, context: InspectContext): Promise<Technical> {
  if ((context.policy.version !== '0.6' && context.policy.version !== '0.7')) return result;
  const policy = effectiveDocumentOcrPolicy(context.policy), selection = format === 'pdf' ? policy.pdfPages : policy.docxImages,
    nativeStatus = result.status as DocumentOcrSelectionMap['nativeStatus'], scope = documentOcrScope(format);
  result.documentOcr = { version: '0.1', status: policy.enabled ? 'skipped' : 'disabled', reason: policy.enabled ? 'DOCUMENT_OCR_SELECTION_EMPTY' : 'DOCUMENT_OCR_DISABLED',
    nativeStatus, scope, selection: [...selection], totalUnits: null, completedUnits: 0, mapEvidenceId: null, runtime: null, engine: null };
  if (!policy.enabled || !selection.length) return result;
  const files = new NodeImportFiles(context.projectDir), original = await readFixed(source, context.policy.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
  if (context.sourceBytes !== undefined && context.sourceBytes !== original.bytes || context.sourceSha256 && context.sourceSha256 !== original.sha256) throw Error('CATALOG_SOURCE_CHANGED: document OCR');
  const runtime = documentRasterRuntimeIdentity(); validateDocumentRasterRuntime(runtime); const engine: OcrEngineIdentity = ocrRuntimeIdentity(); validateOcrEngine(engine);
  const current = () => { if (identity(documentRasterRuntimeIdentity()) !== identity(runtime)) throw Error('DOCUMENT_RASTER_RUNTIME_CHANGED'); if (identity(ocrRuntimeIdentity()) !== identity(engine)) throw Error('OCR_RUNTIME_CHANGED'); };
  const budget = context.documentOcrBudget ??= { units: 0, pixels: 0, embeddedBytes: 0 };
  const map: DocumentOcrSelectionMap = { version: '0.1', kind: 'document-ocr-selection-map', format, scope, status: 'failed', nativeStatus,
    policySha256: context.policySha256 ?? identity(context.policy), source: { bytes: original.bytes, sha256: original.sha256 }, selection: [...selection],
    totalUnits: null, completedUnits: 0, runtime, engine, units: [], limitations: ['Selection coverage is limited to the listed units. OCR recognition accuracy and reading order require separate observation.',
      'Whole-process hard RSS and library-internal IO are unmeasured.'] };
  const created: string[] = []; let published = false;
  async function publish(kind: Evidence['kind'], suffix: string, data: Buffer, id = `evidence-${randomUUID()}`, loc?: DocumentOcrUnitMap['locator']): Promise<Evidence> {
    const name = `${id}.${suffix}`, path = files.projectPath(join(context.evidenceDir, name)); created.push(path); await write(path, data);
    const entry: Evidence = { id, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: digest(data), width: loc?.width ?? null,
      height: loc?.height ?? null, sourceWidth: loc?.width ?? null, sourceHeight: loc?.height ?? null, transform: loc ? documentOcrRasterTransform(format) : null,
      streamIndex: null, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: null, samples: null, coverage: 'full' };
    return entry;
  }
  const entries: Evidence[] = [];
  try {
    await ensureImportDirectory(context.projectDir, context.evidenceDir);
    for (const unit of selection) {
      context.signal.throwIfAborted(); context.check(); if (++budget.units > policy.maxUnitsPerAttempt) throw Error('CATALOG_DOCUMENT_OCR_UNIT_COUNT_LIMIT');
      const selected: DocumentOcrSelectionMap['units'][number] = { id: `document-ocr-unit-${unit}`, ordinal: unit, status: 'failed', reason: '', locator: null, mapEvidenceId: null, invocation: null };
      map.units.push(selected); const cwd = files.projectPath(join(context.evidenceDir, `document-ocr-${unit}-${randomUUID()}`)); await ensureImportDirectory(context.projectDir, cwd);
      const start = context.tools.length, request = documentRasterRequest(source, format, unit, original.bytes, original.sha256, context.policy, runtime);
      let workerResult: DocumentRasterResult | null = null;
      try {
        current();
        const extraction = await runDocumentRaster(request, context, cwd), rasterResult = extraction.result;
        workerResult = rasterResult;
        map.totalUnits ??= rasterResult.totalUnits;
        if (map.totalUnits !== rasterResult.totalUnits) throw Error('DOCUMENT_OCR_WORKER_PROTOCOL_INVALID: total units changed');
        selected.locator = rasterResult.locator;
        if (rasterResult.status !== 'complete') throw Error(rasterResult.reason);
        const loc = rasterResult.locator!;
        budget.pixels += loc.width * loc.height; budget.embeddedBytes += loc.kind === 'docx-image' ? loc.embeddedBytes : 0;
        if (budget.pixels > policy.maxTotalPixels) throw Error('CATALOG_DOCUMENT_OCR_PIXEL_COUNT_LIMIT');
        if (budget.embeddedBytes > policy.maxTotalEmbeddedBytes) throw Error('CATALOG_DOCUMENT_OCR_EMBEDDED_COUNT_LIMIT');
        const ppm = await documentRasterPixels(rasterResult, context, engine, cwd), parsed = await documentRasterOcr(ppm, loc.width, loc.height, context, engine, cwd),
          { tsv, run } = parsed, ids = Array.from({ length: 4 }, () => `evidence-${randomUUID()}`);
        const unitMap: DocumentOcrUnitMap = { version: '0.1', kind: 'document-ocr-map', format, unitId: selected.id, scope, mapperVersion: 'ocr-tsv@0.1',
          status: parsed.status, policySha256: map.policySha256, source: map.source, runtime, locator: loc,
          raster: { evidenceId: ids[0]!, bytes: ppm.length, sha256: digest(ppm), width: loc.width, height: loc.height, encoding: 'P6/RGB8', background: 'white', transform: 'identity', orientationApplied: false },
          rawTsv: { evidenceId: ids[1]!, bytes: tsv.length, sha256: digest(tsv) }, text: { evidenceId: ids[2]!, bytes: parsed.text.length, sha256: digest(parsed.text) },
          engine, regions: parsed.regions, commands: { worker: extraction.run, decode: context.tools.slice(start).filter(value => value.version.endsWith('/ocr-raster@0.1')), ocr: run }, cwd,
          limitations: [...rasterResult.limitations, 'Coordinates address the selected raster pixels. OCR confidence is an engine score.'] };
        validateDocumentOcrUnitMap(unitMap, parsed.text, ppm, tsv, policy); const data = Buffer.from(importJsonText(unitMap));
        if (data.length > policy.maxMapBytes || data.length > policy.ocr.maxOcrMapBytes) throw Error('DOCUMENT_OCR_MAP_LIMIT');
        admit(context, parsed.text.length + data.length);
        const group: Evidence[] = [];
        try {
          for (const [index, kind, suffix, bytes] of [[0, 'document-ocr-raster', 'ppm', ppm], [1, 'document-ocr-tsv', 'txt', tsv],
            [2, 'document-ocr-text', 'txt', parsed.text], [3, 'document-ocr-map', 'json', data]] as const)
            group.push(await publish(kind, suffix, bytes, ids[index]!, kind === 'document-ocr-raster' ? loc : undefined));
        } catch (error) { throw Object.assign(error as Error, { publication: true }); }
        entries.push(...group); selected.status = parsed.status; selected.reason = ''; selected.mapEvidenceId = ids[3]!; map.completedUnits++;
      } catch (error) {
        if ((error as { publication?: boolean }).publication) throw error;
        selected.reason = fatal(error, context);
      } finally { await rm(cwd, { recursive: true, force: true }); current(); }
      if (!context.recordDocumentOcrInvocation) throw Error('CATALOG_DOCUMENT_OCR_JOURNAL_REQUIRED');
      const runs = context.tools.slice(start), value: DocumentOcrInvocationRecord = { version: '0.1', kind: 'document-ocr-command',
        inspectionId: basename(context.evidenceDir), unitId: selected.id, cwd, request,
        workerResult: workerResult ? { ...workerResult, payload: workerResult.payload ? { format: workerResult.payload.format, bytes: workerResult.payload.bytes, sha256: workerResult.payload.sha256 } : null } : null,
        commands: { worker: runs.find(run => run.version.endsWith('/document-raster-worker@0.1')) ?? null,
          decode: runs.filter(run => run.version.endsWith('/ocr-raster@0.1')), ocr: runs.find(run => run.version.endsWith('/ocr-tsv@0.1')) ?? null }, reason: selected.reason };
      assertDocumentOcr('invocation', value); selected.invocation = await context.recordDocumentOcrInvocation(value);
    }
    map.status = map.completedUnits === selection.length ? 'completed' : map.completedUnits ? 'partial' : 'failed';
    validateDocumentOcrSelectionMap(map, policy); const data = Buffer.from(importJsonText(map)); if (data.length > policy.maxMapBytes) throw Error('DOCUMENT_OCR_SELECTION_MAP_LIMIT'); admit(context, data.length);
    const overall = await publish('document-ocr-selection-map', 'json', data); entries.push(overall);
    const after = await readFixed(source, context.policy.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
    if (after.bytes !== original.bytes || after.sha256 !== original.sha256) throw Error('CATALOG_SOURCE_CHANGED: document OCR'); current();
    result.evidence.push(...entries); result.documentOcr = { version: '0.1', status: map.status, reason: map.status === 'completed' ? '' : 'DOCUMENT_OCR_SELECTION_PARTIAL',
      nativeStatus, scope, selection: map.selection, totalUnits: map.totalUnits, completedUnits: map.completedUnits, mapEvidenceId: overall.id, runtime, engine };
    if (nativeStatus === 'failed' || nativeStatus === 'unsupported' || map.status !== 'completed') result.status = map.completedUnits || nativeStatus === 'supported' || nativeStatus === 'partial' ? 'partial' : nativeStatus;
    result.limitations.push(...map.limitations); published = true; return result;
  } finally { if (!published) for (const path of created) await rm(path, { force: true }); }
}
