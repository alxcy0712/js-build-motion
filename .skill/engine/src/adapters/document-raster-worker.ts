import { readFixed } from './inspection.ts';
import { importJsonText } from './import-files.ts';
import { assertDocumentOcr, type DocumentRasterRequest } from '../project/document-ocr.ts';
import { extractDocumentRaster } from './document-raster-source.ts';

// stdout is one complete protocol. Library diagnostics stay on stderr.
let diagnostics = '';
for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = (...values: unknown[]) => {
  diagnostics = (diagnostics + values.map(String).join(' ') + '\n').slice(0, 16384);
};
try {
  if (process.argv.length !== 3) throw Error('DOCUMENT_OCR_PROTOCOL_INVALID: request path argv');
  const path = process.argv[2]!, bytes = await readFixed(path, 4194304);
  const request = assertDocumentOcr<DocumentRasterRequest>('request', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.data)));
  const result = await extractDocumentRaster(request);
  const current = await readFixed(path, 4194304, undefined, undefined, false);
  if (current.bytes !== bytes.bytes || current.sha256 !== bytes.sha256) throw Error('DOCUMENT_OCR_PROTOCOL_INVALID: request changed');
  const payload = importJsonText(result);
  if (Buffer.byteLength(payload) > request.limits.maxWorkerPayloadBytes) throw Error('DOCUMENT_OCR_WORKER_PAYLOAD_LIMIT');
  process.stdout.write(payload);
} catch (error) {
  const code = error instanceof Error ? error.message : String(error);
  process.stderr.write((/^CATALOG_SOURCE_CHANGED|^DOCUMENT_RASTER_RUNTIME_/.test(code) ? 'DOCUMENT_RASTER_FATAL:' + JSON.stringify({ code }) : code) + '\n');
  process.exitCode = 1;
} finally { process.stderr.write(diagnostics); }
