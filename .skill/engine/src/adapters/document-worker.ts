import { assertDocument, newDocumentResult, type DocumentParseRequest, type DocumentParseResult } from '../project/document.ts';

// Library diagnostics share stderr; stdout contains one complete JSON protocol.
for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = (...values: unknown[]) => { process.stderr.write(values.map(String).join(' ') + '\n'); };
let request: DocumentParseRequest | undefined;
try {
  if (process.argv.length !== 3) throw new Error('DOCUMENT_PROTOCOL_INVALID: request argv');
  request = assertDocument<DocumentParseRequest>('request', JSON.parse(process.argv[2]!));
  let result: DocumentParseResult;
  try {
    result = request.format === 'pdf' ? await (await import('./document-pdf.ts')).parsePdfDocument(request) :
      request.format === 'docx' ? await (await import('./document-docx.ts')).parseDocxDocument(request) :
      await (await import('./document-office.ts')).parseOfficeDocument(request);
  } catch (error) {
    const parser = request.format === 'pdf' ? ['pdfjs-dist', '6.4.299'] : ['saxes+yauzl', 'saxes@6.0.0/yauzl@3.4.0'];
    result = newDocumentResult(request, parser[0]!, parser[1]!); result.status = 'failed'; result.reason = error instanceof Error ? error.message : String(error);
  }
  result.metrics.maxRSSKiB = process.resourceUsage().maxRSS; assertDocument('result', result);
  const payload = JSON.stringify(result);
  if (Buffer.byteLength(payload) > request.limits.maxWorkerPayloadBytes) throw new Error('DOCUMENT_PROTOCOL_INVALID: final payload limit');
  process.stdout.write(payload);
} catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
