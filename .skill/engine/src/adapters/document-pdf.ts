import { DOMMatrix, Path2D } from 'skia-canvas';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFixed } from './inspection.ts';
import { assertDocument, documentArtifacts, newDocumentResult, validateDocumentMap,
  type DocumentParseRequest, type DocumentParseResult } from '../project/document.ts';
import type { PDFDocumentLoadingTask, TextContent, TextItem } from 'pdfjs-dist/types/src/display/api.js';

const PARSER_VERSION = '6.4.299', POLICY_PLACEHOLDER = '0'.repeat(64);
const LIMITATIONS = [
  'PDFJS_ITEM_ORDER: text follows PDF.js text-item order and normalization; geometric reading order is unverified.',
  'Native text denotes PDF.js page-text output; text outside page bounds may be omitted. Cross-reference repair may occur; source structure is not independently validated.',
  'Only native page text is extracted; visual layout, image contents, table structure and complex formula structure are unverified.',
  'JavaScript actions, attachments and external resources are not executed or extracted; XFA extraction is disabled.',
  'sourceReadBytes measures the independent source read; internal parser/font/CMap I/O is unmeasured. Peak RSS is supplied by the worker.'
];

function discard(result: DocumentParseResult, reason: string): void {
  result.status = 'failed'; result.reason = reason; result.units = [];
  result.coverage.completedUnits = 0; result.coverage.parsedPages = [];
  result.coverage.omitted = ['No verified native-text units were retained.'];
}

/** The parent repeats these checks with final worker metrics and actual map-file serialization. */
function finish(request: DocumentParseRequest, result: DocumentParseResult): DocumentParseResult {
  let artifacts = documentArtifacts(result, POLICY_PLACEHOLDER);
  if (result.status !== 'failed' && Buffer.byteLength(JSON.stringify(artifacts.map)) > request.limits.maxDocumentMapBytes) {
    discard(result, 'DOCUMENT_MAP_LIMIT'); artifacts = documentArtifacts(result, POLICY_PLACEHOLDER);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > request.limits.maxWorkerPayloadBytes) {
    discard(result, 'CATALOG_BINARY_LIMIT'); artifacts = documentArtifacts(result, POLICY_PLACEHOLDER);
  }
  assertDocument('result', result); validateDocumentMap(artifacts.map, artifacts.text, request.limits);
  if (Buffer.byteLength(JSON.stringify(result)) > request.limits.maxWorkerPayloadBytes) throw new Error('DOCUMENT_PROTOCOL_INVALID: failure footer exceeds payload limit');
  return result;
}

function diagnostic(error: unknown): string {
  return String(error instanceof Error ? `${error.name}: ${error.message}` : error).replace(/[\r\n\0]/g, ' ').slice(0, 256);
}

export async function parsePdfDocument(request: DocumentParseRequest): Promise<DocumentParseResult> {
  assertDocument('request', request);
  if (request.format !== 'pdf') throw new Error('DOCUMENT_REQUEST_INVALID: PDF format required');
  const result = newDocumentResult(request, 'pdfjs-dist', PARSER_VERSION); result.limitations = [...LIMITATIONS]; result.metrics.sourceReadBytes = 0;
  if (request.sourceBytes > request.limits.maxDocumentSourceBytes) {
    result.status = 'partial'; result.reason = `DOCUMENT_SOURCE_LIMIT: ${request.sourceBytes}>${request.limits.maxDocumentSourceBytes}`;
    result.coverage.omitted = ['All PDF pages: source admission limit; page count is unknown.'];
    return finish(request, result);
  }
  let data: Buffer;
  try {
    const source = await readFixed(request.sourcePath, request.limits.maxDocumentSourceBytes, undefined, bytes => { result.metrics.sourceReadBytes! += bytes; });
    if (source.bytes !== request.sourceBytes || source.sha256 !== request.sourceSha256) throw new Error('CATALOG_SOURCE_CHANGED');
    data = source.data;
  } catch (error) {
    const message = diagnostic(error);
    if (message.includes('CATALOG_SOURCE_CHANGED') || /CATALOG_(FILE|READ)_/.test(message) || /\bENOENT\b|\bELOOP\b/.test(message)) throw new Error(`CATALOG_SOURCE_CHANGED: ${message}`);
    discard(result, `DOCUMENT_READ_FAILED: ${message}`); return finish(request, result);
  }
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    result.status = 'unsupported'; result.reason = 'DOCUMENT_FORMAT_UNSUPPORTED: PDF header required';
    result.coverage.omitted = ['All PDF pages: source signature is outside the supported format.'];
    return finish(request, result);
  }
  let loadingTask: PDFDocumentLoadingTask | undefined;
  try {
    const globals = globalThis as unknown as { DOMMatrix?: typeof DOMMatrix; Path2D?: typeof Path2D };
    globals.DOMMatrix ??= DOMMatrix; globals.Path2D ??= Path2D;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (pdfjs.version !== PARSER_VERSION) throw new Error('DOCUMENT_PARSER_VERSION');
    const packageRoot = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl: join(packageRoot, 'cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: join(packageRoot, 'standard_fonts') + '/', useWorkerFetch: false, useSystemFonts: false,
      useWasm: false, disableFontFace: true, enableXfa: false, stopAtErrors: true, verbosity: pdfjs.VerbosityLevel.WARNINGS });
    const document = await loadingTask.promise;
    result.coverage.totalPages = document.numPages; result.coverage.totalUnits = document.numPages;
    const { info } = await document.getMetadata();
    if (info.EncryptFilterName) {
      const permissions = await document.getPermissions();
      result.limitations.push(`PDF_ENCRYPTION: filter=${String(info.EncryptFilterName).slice(0, 64)}; permissions=${permissions === null ? 'unknown' : [...permissions].join(',')}; readable with an empty password.`);
    }
    if (info.IsXFAPresent) { result.status = 'partial'; result.reason = 'DOCUMENT_XFA_OMITTED'; result.coverage.omitted.push('XFA content is outside native page-text extraction.'); }
    let textBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const prefix = pageNumber > request.limits.maxPdfPages ? 'DOCUMENT_PAGE_LIMIT' : result.units.length >= request.limits.maxDocumentUnits ? 'DOCUMENT_UNIT_LIMIT' : null;
      if (prefix) { result.status = 'partial'; result.reason = prefix; result.coverage.omitted.push(`Pages ${pageNumber}-${document.numPages}: ${prefix}.`); break; }
      const page = await document.getPage(pageNumber), reader = page.streamTextContent({ includeMarkedContent: false, disableNormalization: false }).getReader();
      const pieces: string[] = []; let pageBytes = 0, exceeded = false;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          for (const item of (chunk.value as TextContent).items) {
            if (!('str' in item)) continue;
            const textItem = item as TextItem, piece = textItem.str + (textItem.hasEOL ? '\n' : '');
            const bytes = Buffer.byteLength(piece);
            if (textBytes + (result.coverage.completedUnits ? 1 : 0) + pageBytes + bytes > request.limits.maxDocumentTextBytes) { exceeded = true; break; }
            pieces.push(piece); pageBytes += bytes;
          }
          if (exceeded) { await reader.cancel(new Error('DOCUMENT_TEXT_LIMIT')); break; }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      const id = `pdf-page-${pageNumber}`;
      if (exceeded) {
        result.units.push({ id, ordinal: result.units.length + 1, locator: { kind: 'pdf', page: pageNumber }, text: '', status: 'skipped', reason: 'DOCUMENT_TEXT_LIMIT: complete page does not fit remaining UTF-8 text quota' });
        result.status = 'partial'; result.reason = 'DOCUMENT_TEXT_LIMIT'; result.coverage.omitted.push(`Pages ${pageNumber}-${document.numPages}: DOCUMENT_TEXT_LIMIT; no partial page text retained.`); break;
      }
      // An empty later page still consumes the LF separator between complete units.
      if (textBytes + (result.coverage.completedUnits ? 1 : 0) + pageBytes > request.limits.maxDocumentTextBytes) {
        result.units.push({ id, ordinal: result.units.length + 1, locator: { kind: 'pdf', page: pageNumber }, text: '', status: 'skipped', reason: 'DOCUMENT_TEXT_LIMIT: unit separator does not fit remaining UTF-8 text quota' });
        result.status = 'partial'; result.reason = 'DOCUMENT_TEXT_LIMIT'; result.coverage.omitted.push(`Pages ${pageNumber}-${document.numPages}: DOCUMENT_TEXT_LIMIT.`); break;
      }
      const text = pieces.join('');
      result.units.push({ id, ordinal: result.units.length + 1, locator: { kind: 'pdf', page: pageNumber }, text, status: text ? 'complete' : 'empty', reason: text ? '' : 'native-text-empty' });
      textBytes += (result.coverage.completedUnits ? 1 : 0) + pageBytes;
      result.coverage.completedUnits++; result.coverage.parsedPages.push(pageNumber);
      if (!text) result.coverage.omitted.push(`Page ${pageNumber}: native-text-empty; blank-page/image-page/scan distinctions are unverified.`);
    }
  } catch (error) {
    if ((error as { name?: string })?.name === 'PasswordException') {
      result.status = 'unsupported'; result.reason = 'DOCUMENT_PASSWORD_REQUIRED'; result.coverage.omitted = ['All PDF pages: a password is required.'];
    } else discard(result, `DOCUMENT_PARSE_FAILED: ${diagnostic(error)}`);
  } finally {
    try { await loadingTask?.destroy(); } catch (error) { discard(result, `DOCUMENT_PARSE_FAILED: cleanup: ${diagnostic(error)}`); }
  }
  return finish(request, result);
}
