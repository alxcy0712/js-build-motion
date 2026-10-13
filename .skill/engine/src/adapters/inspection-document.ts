import { createHash, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importJsonText } from './import-files.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';
import { documentLimits, type Evidence, type Technical } from '../project/catalog.ts';
import { assertDocument, documentArtifacts, validateDocumentMap, type DocumentParseRequest, type DocumentParseResult, type DocumentFormat } from '../project/document.ts';

/** The parent alone admits and publishes a complete, validated worker payload. */
export async function inspectDocument(source: string, format: DocumentFormat, context: InspectContext): Promise<Technical> {
  const limits = documentLimits(context.policy), result: Technical = { status: 'failed', format, method: 'document-worker@0.1', reason: '', raw: null,
    streams: [], evidence: [], text: null, containerDuration: null, limitations: ['Technical evidence requires separate semantic observation and rights records.',
      'V8 old-space is bounded; whole-process hard RSS is unverified. Library-internal IO is unmeasured.'] };
  const identity = context.sourceBytes !== undefined && context.sourceSha256 ? { bytes: context.sourceBytes, sha256: context.sourceSha256 } :
    await readFixed(source, context.policy.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
  if (identity.bytes > limits.maxDocumentSourceBytes) { result.status = 'partial'; result.reason = 'DOCUMENT_SOURCE_LIMIT: native text extraction skipped'; return result; }
  const policySha256 = context.policySha256 ?? createHash('sha256').update(importJsonText(context.policy)).digest('hex');
  const request: DocumentParseRequest = { version: ['pptx', 'xlsx'].includes(format) ? '0.2' : '0.1', format, sourcePath: source, sourceBytes: identity.bytes, sourceSha256: identity.sha256, limits, ...(context.policy.version === '0.7' && ['pptx', 'xlsx'].includes(format) ? { office: context.policy.office } : {}) };
  assertDocument('request', request);
  const executable = await realpath(process.execPath), worker = fileURLToPath(new URL('./document-worker.ts', import.meta.url));
  const chunks: Buffer[] = [];
  const run = await runInspectionTool({ executable, version: `node@${process.versions.node}/document-worker@0.1`,
    argv: [`--max-old-space-size=${limits.workerOldSpaceMiB}`, worker, JSON.stringify(request)], cwd: context.temporaryDir,
    policy: { ...context.policy, maxToolElapsedMs: Math.min(30000, context.policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
    signal: context.signal, binaryLimit: limits.maxWorkerPayloadBytes,
    binary: async chunk => { context.check(); chunks.push(Buffer.from(chunk)); },
    onRun: value => { context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
  context.check();
  if (run.error) { if (run.error === 'CATALOG_DERIVED_LIMIT') throw new Error(run.error); result.reason = run.error; return result; }
  let parsed: DocumentParseResult, text: Buffer, mapData: Buffer;
  try {
    parsed = assertDocument<DocumentParseResult>('result', JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    if (parsed.reason.startsWith('CATALOG_SOURCE_CHANGED')) throw new Error(parsed.reason);
    if (parsed.format !== format || parsed.sourceBytes !== identity.bytes || parsed.sourceSha256 !== identity.sha256) throw new Error('DOCUMENT_PROTOCOL_INVALID: source identity');
    const parser = format === 'pdf' ? { id: 'pdfjs-dist', version: '6.4.299' } : { id: 'saxes+yauzl', version: 'saxes@6.0.0/yauzl@3.4.0' };
    if (JSON.stringify(parsed.parser) !== JSON.stringify(parser)) throw new Error('DOCUMENT_PROTOCOL_INVALID: parser identity');
    if (parsed.metrics.sourceReadBytes !== null) context.counts.sourceReadBytes += parsed.metrics.sourceReadBytes;
    const artifacts = documentArtifacts(parsed, policySha256); text = artifacts.text; validateDocumentMap(artifacts.map, text, limits);
    if (parsed.status === 'supported' && (parsed.coverage.totalUnits === null || parsed.coverage.completedUnits !== parsed.coverage.totalUnits || parsed.units.some(u => !['complete', 'empty'].includes(u.status))) ||
        ['failed', 'unsupported'].includes(parsed.status) && parsed.units.length) throw new Error('DOCUMENT_PROTOCOL_INVALID: status/coverage');
    mapData = Buffer.from(importJsonText(artifacts.map));
    if (mapData.length > limits.maxDocumentMapBytes) { result.reason = 'DOCUMENT_MAP_LIMIT'; return result; }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('CATALOG_SOURCE_CHANGED')) throw error;
    result.reason = `DOCUMENT_PROTOCOL_INVALID: ${message}`; return result;
  }
  result.status = parsed.status; result.reason = parsed.reason; result.method = `${parsed.parser.id}@${parsed.parser.version}/document-worker@0.1`;
  result.limitations.push(...parsed.limitations);
  if (['failed', 'unsupported'].includes(parsed.status)) return result;
  const bytes = text.length + mapData.length;
  if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT');
  context.check(); context.counts.derivedBytes += bytes;
  async function publish(kind: Evidence['kind'], suffix: string, data: Buffer): Promise<Evidence> {
    const id = `evidence-${randomUUID()}`, name = `${id}.${suffix}`, handle = await open(join(context.evidenceDir, name), 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    const entry: Evidence = { id, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      width: null, height: null, sourceWidth: null, sourceHeight: null, transform: null, streamIndex: null, timeBase: null, pts: null, requestedTime: null,
      actualTime: null, sampleRate: null, samples: null, coverage: parsed.status === 'supported' ? 'full' : 'partial' };
    result.evidence.push(entry); return entry;
  }
  const textEvidence = await publish('text', 'txt', text), mapEvidence = await publish('document-map', 'json', mapData);
  result.text = { bytes: text.length, lines: text.toString('utf8').split('\n').length, bom: false, lineEndings: text.includes(10) ? 'LF' : 'none' };
  result.document = { version: parsed.version, format, parser: parsed.parser, scope: parsed.coverage.scope, textEvidenceId: textEvidence.id,
    mapEvidenceId: mapEvidence.id, totalUnits: parsed.coverage.totalUnits, completedUnits: parsed.coverage.completedUnits };
  return result;
}
