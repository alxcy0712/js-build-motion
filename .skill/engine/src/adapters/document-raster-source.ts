import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { documentRasterRuntimeIdentity } from '../../workspace.mjs';
import { assertDocumentOcr, validateDocumentRasterRuntime, type DocumentRasterRequest, type DocumentRasterResult } from '../project/document-ocr.ts';
import { readFixed } from './inspection.ts';

export function rasterLimit(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw Error(`DOCUMENT_OCR_${name}_LIMIT: ${value}/${maximum}`);
}
export function rasterPayload(format: 'ppm' | 'png_pipe' | 'jpeg_pipe', data: Buffer): NonNullable<DocumentRasterResult['payload']> {
  return { format, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') };
}
/** A source unit has its own admission. Whole-attempt budgets belong to the parent. */
export async function extractDocumentRaster(request: DocumentRasterRequest): Promise<DocumentRasterResult> {
  assertDocumentOcr('request', request); validateDocumentRasterRuntime(request.runtime);
  const runtime = () => {
    const actual = documentRasterRuntimeIdentity(); validateDocumentRasterRuntime(actual);
    if (!isDeepStrictEqual(actual, request.runtime)) throw Error('DOCUMENT_RASTER_RUNTIME_CHANGED');
  };
  runtime();
  const result: DocumentRasterResult = { version: '0.1', kind: 'document-raster-result', format: request.format,
    source: { bytes: request.sourceBytes, sha256: request.sourceSha256 }, unit: request.unit, totalUnits: 0,
    status: 'failed', reason: '', locator: null, payload: null,
    metrics: { readBytes: 0, expandedBytes: 0, decodedStreamBytes: 0, xmlNodes: 0, canvasLivePeakPixels: 0, canvasAllocationPixels: 0, resourceBytes: 0 },
    limitations: ['This unit covers selected source pixels; native document text is an independent evidence scope.',
      'Whole-process hard RSS and library-internal IO are unmeasured. Measured readBytes counts independent source hash reads.'] };
  const maximum = Math.min(request.limits.maxSourceBytes, request.documentLimits.maxDocumentSourceBytes);
  let verified = false, sourceIdentity: BigIntStats | undefined;
  const sameSource = (left: BigIntStats, right: BigIntStats) =>
    (['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => left[key] === right[key]);
  async function source(retain: boolean) {
    try {
      const before = await lstat(request.sourcePath, { bigint: true });
      if (sourceIdentity && !sameSource(sourceIdentity, before)) throw Error('CATALOG_SOURCE_CHANGED: cross-unit file identity');
      const data = await readFixed(request.sourcePath, maximum, undefined, bytes => { result.metrics.readBytes += bytes; }, retain);
      if (data.bytes !== request.sourceBytes || data.sha256 !== request.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED');
      const after = await lstat(request.sourcePath, { bigint: true });
      if (!sameSource(before, after)) throw Error('CATALOG_SOURCE_CHANGED: file identity during source read');
      sourceIdentity ??= before;
      return data.data;
    } catch (error) { throw Error(`CATALOG_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  try {
    rasterLimit('SOURCE', request.sourceBytes, maximum);
    const data = await source(true); verified = true;
    if (request.format === 'pdf') await (await import('./document-raster-pdf.ts')).rasterPdfUnit(request, data, result);
    else await (await import('./document-raster-docx.ts')).extractDocxImage(request, data, result);
    result.status = 'complete';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^CATALOG_SOURCE_CHANGED|^DOCUMENT_RASTER_RUNTIME_/.test(message)) throw error;
    result.status = 'failed'; result.reason = message.replace(/[\r\n\0]/g, ' ').slice(0, 1024); result.locator = null; result.payload = null;
  } finally {
    if (verified) await source(false);
    runtime();
  }
  if (Buffer.byteLength(JSON.stringify(result)) > request.limits.maxWorkerPayloadBytes) {
    result.status = 'failed'; result.reason = 'DOCUMENT_OCR_WORKER_PAYLOAD_LIMIT'; result.locator = null; result.payload = null;
  }
  assertDocumentOcr('result', result);
  if (Buffer.byteLength(JSON.stringify(result)) > request.limits.maxWorkerPayloadBytes) throw Error('DOCUMENT_OCR_PROTOCOL_INVALID: failure footer exceeds worker payload');
  return result;
}
