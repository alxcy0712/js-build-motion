import { createHash, randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ocrRuntimeIdentity } from '../../workspace.mjs';
import { ensureImportDirectory, importJsonText, NodeImportFiles } from './import-files.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';
import { preflightOcrImage, decodeOcrRaster } from './ocr-raster.ts';
import { parseOcrTsv } from './ocr-tsv.ts';
import { ocrLimits, type Evidence, type Technical } from '../project/catalog.ts';
import { validateOcrEngine, validateOcrMap, type OcrDescriptor, type OcrEngineIdentity, type OcrMap } from '../project/ocr.ts';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const localLimit = /^OCR_(?:SOURCE|PIXEL|EDGE|STRUCTURE|RASTER|TSV|ROWS|ROW|REGIONS|WORD|TEXT|MAP)_LIMIT(?:$|:)/;
const degraded = /Failed loading language|Error opening data file|Could not initialize tesseract|couldn't load any languages|LSTM requested,? but not present|Tesseract \(legacy\) engine requested.*components are not present|(?:legacy|LSTM) (?:engine|initialization).*?(?:not present|unavailable|failed)|Loading tesseract/i;

/** Publish only a complete, validated four-file group; generic image evidence stays attached. */
export async function inspectImageOcr(source: string, format: 'png_pipe' | 'jpeg_pipe', result: Technical, context: InspectContext): Promise<Technical> {
  const limits = ocrLimits(context.policy), files = new NodeImportFiles(context.projectDir);
  let engine: OcrEngineIdentity | null = null;
  function outcome(status: OcrDescriptor['status'], reason: string) {
    result.ocr = { version: '0.1', status, reason, scope: 'single-image-ocr', engine, rasterEvidenceId: null,
      tsvEvidenceId: null, textEvidenceId: null, mapEvidenceId: null, regions: 0 };
    if (status !== 'disabled') {
      if (result.status !== 'failed') result.status = 'partial';
      result.reason = result.reason ? `${result.reason}; ${reason}` : reason;
    }
    return result;
  }
  if (!['0.3', '0.4', '0.5', '0.6', '0.7'].includes(context.policy.version) || !context.policy.ocr.enabled) return outcome('disabled', 'OCR_DISABLED');
  if (result.status === 'failed' || !result.evidence.some(e => e.kind === 'preview' && e.bytes > 0 && e.width && e.height)) return outcome('skipped', 'OCR_PREVIEW_UNAVAILABLE');
  context.signal.throwIfAborted(); context.check();
  let info: Awaited<ReturnType<NodeImportFiles['inspect']>>;
  try { files.projectPath(source); info = await files.inspect(source); }
  catch (error) { throw new Error(`CATALOG_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  if (info.kind !== 'file' || info.nlink !== '1' || context.sourceBytes !== undefined && info.size !== context.sourceBytes) throw new Error('CATALOG_SOURCE_CHANGED: OCR input node');
  if (info.size > limits.maxOcrSourceBytes) return outcome('skipped', 'OCR_SOURCE_LIMIT');
  async function sourceIdentity(retain: boolean) {
    try { return await readFixed(source, limits.maxOcrSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, retain); }
    catch (error) { context.signal.throwIfAborted(); throw new Error(`CATALOG_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const identity = await sourceIdentity(true);
  if (context.sourceBytes !== undefined && context.sourceBytes !== identity.bytes || context.sourceSha256 && context.sourceSha256 !== identity.sha256) throw new Error('CATALOG_SOURCE_CHANGED: OCR input identity');
  async function runtimeIdentity(): Promise<OcrEngineIdentity> {
    try {
      const current: OcrEngineIdentity = ocrRuntimeIdentity(); validateOcrEngine(current);
      for (const model of current.models) {
        const path = files.projectPath(join(context.projectDir, '.engine', model.path)), actual = await readFixed(path, model.bytes, context.signal, undefined, false);
        if (actual.bytes !== model.bytes || actual.sha256 !== model.sha256) throw new Error(`OCR_RUNTIME_MODEL_CHANGED: ${model.code}`);
      }
      return current;
    } catch (error) { context.signal.throwIfAborted(); throw new Error(`OCR_RUNTIME_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function admit(bytes: number) {
    context.signal.throwIfAborted(); context.check();
    if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT');
    context.counts.derivedBytes += bytes;
  }
  let staging: string | null = null, published = false;
  const created: string[] = [];
  try {
    let payload: { map: OcrMap; mapData: Buffer; text: Buffer; tsv: Buffer; ppm: Buffer; ids: string[] };
    try {
      const header = preflightOcrImage(identity.data, format, limits);
      engine = await runtimeIdentity(); context.check();
      try {
        const raster = await decodeOcrRaster(source, header, context, engine.tools.ffmpeg), { width, height, ppm } = raster;
        const ppmHeader = Buffer.from(`P6\n${width} ${height}\n255\n`);
        if (width !== header.width || height !== header.height || ppm.length !== ppmHeader.length + 3 * width * height || !ppm.subarray(0, ppmHeader.length).equals(ppmHeader)) throw new Error('OCR_RASTER_GEOMETRY_INVALID');
        if (ppm.length > limits.maxOcrRasterBytes) throw new Error('OCR_RASTER_LIMIT');
        staging = files.projectPath(join(context.temporaryDir, `ocr-${randomUUID()}`));
        await ensureImportDirectory(context.projectDir, staging);
        const rasterPath = files.projectPath(join(staging, 'raster.ppm'));
        admit(ppm.length);
        const rasterHandle = await open(rasterPath, 'wx', 0o600);
        try { await rasterHandle.writeFile(ppm); await rasterHandle.sync(); } finally { await rasterHandle.close(); }
        const chunks: Buffer[] = []; let callbackFault: unknown;
        const run = await runInspectionTool({ executable: engine.tools.tesseract.executable, version: `${engine.tools.tesseract.version}/ocr-tsv@0.1`,
          argv: [rasterPath, 'stdout', '--tessdata-dir', files.projectPath(join(context.projectDir, '.engine/assets/ocr/tessdata')),
            '-l', 'chi_sim+eng+~chi_sim_vert', '--oem', '1', '--psm', '3', '--dpi', '300', '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0'],
          cwd: staging, policy: { ...context.policy, maxToolElapsedMs: Math.min(30000, context.policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
          signal: context.signal, ocr: true, binaryLimit: limits.maxOcrTsvBytes,
          binary: async chunk => { try { admit(chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
          onRun: value => { context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
        if (callbackFault) throw callbackFault;
        context.check();
        if (run.error === 'CATALOG_BINARY_LIMIT') throw new Error('OCR_TSV_LIMIT');
        if (run.error) throw new Error(`OCR_TOOL_FAILED: ${run.error}`);
        if (degraded.test(run.stderr)) throw new Error('OCR_INITIALIZATION_DEGRADED');
        const tsv = Buffer.concat(chunks), parsed = parseOcrTsv(tsv, width, height, limits), ids = Array.from({ length: 4 }, () => `evidence-${randomUUID()}`);
        const map: OcrMap = { version: '0.1', kind: 'ocr-map', format, mapperVersion: 'ocr-tsv@0.1', status: parsed.status,
          scope: 'single-image-ocr', policySha256: context.policySha256 ?? digest(Buffer.from(importJsonText(context.policy))),
          source: { bytes: identity.bytes, sha256: identity.sha256, width, height },
          raster: { evidenceId: ids[0]!, bytes: ppm.length, sha256: digest(ppm), width, height, encoding: 'P6/RGB8', background: 'white', transform: 'identity', orientationApplied: false },
          rawTsv: { evidenceId: ids[1]!, bytes: tsv.length, sha256: digest(tsv) }, text: { evidenceId: ids[2]!, bytes: parsed.text.length, sha256: digest(parsed.text) }, engine, regions: parsed.regions };
        validateOcrMap(map, parsed.text, ppm, tsv, limits);
        const mapData = Buffer.from(importJsonText(map)); if (mapData.length > limits.maxOcrMapBytes) throw new Error('OCR_MAP_LIMIT');
        payload = { map, mapData, text: parsed.text, tsv, ppm, ids };
      } finally {
        const after = await sourceIdentity(false);
        if (after.bytes !== identity.bytes || after.sha256 !== identity.sha256) throw new Error('CATALOG_SOURCE_CHANGED: OCR input changed');
        const current = await runtimeIdentity(); if (JSON.stringify(current) !== JSON.stringify(engine)) throw new Error('OCR_RUNTIME_CHANGED');
        context.check();
      }
    } catch (error) {
      context.signal.throwIfAborted(); context.check(); const reason = error instanceof Error ? error.message : String(error);
      if (localLimit.test(reason) || /^OCR_FORMAT_UNSUPPORTED(?:$|:)/.test(reason)) return outcome('skipped', reason);
      if (reason.startsWith('OCR_')) return outcome('failed', reason);
      throw error;
    }
    admit(payload.text.length + payload.mapData.length);
    await ensureImportDirectory(context.projectDir, context.evidenceDir);
    const entries: Evidence[] = [];
    for (const [index, kind, suffix, data] of [[0, 'ocr-raster', 'ppm', payload.ppm], [1, 'ocr-tsv', 'txt', payload.tsv], [2, 'text', 'txt', payload.text], [3, 'ocr-map', 'json', payload.mapData]] as const) {
      context.signal.throwIfAborted(); context.check();
      const id = payload.ids[index]!, name = `${id}.${suffix}`, path = files.projectPath(join(context.evidenceDir, name)), handle = await open(path, 'wx', 0o600);
      created.push(path);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      entries.push({ id, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: digest(data), width: kind === 'ocr-raster' ? payload.map.source.width : null,
        height: kind === 'ocr-raster' ? payload.map.source.height : null, sourceWidth: kind === 'ocr-raster' ? payload.map.source.width : null, sourceHeight: kind === 'ocr-raster' ? payload.map.source.height : null,
        transform: kind === 'ocr-raster' ? 'identity; white background; autorotate disabled' : null, streamIndex: null, timeBase: null, pts: null, requestedTime: null,
        actualTime: null, sampleRate: null, samples: null, coverage: 'full' });
    }
    result.evidence.push(...entries); published = true;
    result.text = { bytes: payload.text.length, lines: payload.text.toString('utf8').split('\n').length, bom: false, lineEndings: payload.text.includes(10) ? 'LF' : 'none' };
    result.ocr = { version: '0.1', status: payload.map.status === 'text' ? 'completed' : 'no-text', reason: '', scope: 'single-image-ocr', engine,
      rasterEvidenceId: payload.ids[0]!, tsvEvidenceId: payload.ids[1]!, textEvidenceId: payload.ids[2]!, mapEvidenceId: payload.ids[3]!, regions: payload.map.regions.length };
    result.limitations.push('OCR word confidence describes engine output; processing coverage does not establish recognition accuracy or reading order.',
      'OCR raster uses source coordinates, an integer white background and disabled autorotation. ICC color management is unverified.',
      'Native and Node buffers are bounded; whole-process hard RSS and library-internal IO are unmeasured.');
    return result;
  } finally {
    const cleanup = await Promise.allSettled([...(staging ? [rm(staging, { recursive: true, force: true })] : []), ...(!published ? created.map(path => rm(path, { force: true })) : [])]);
    for (const entry of cleanup) if (entry.status === 'rejected') throw entry.reason;
  }
}
