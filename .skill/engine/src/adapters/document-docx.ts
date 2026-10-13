import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import saxesPackage from 'saxes/package.json' with { type: 'json' };
import { ZipArchive } from './unpack-zip.ts';
import { readFixed } from './inspection.ts';
import { canonicalUnpackPath, DEFAULT_UNPACK_POLICY } from '../project/unpack.ts';
import { assertDocument, newDocumentResult, type DocumentParseRequest, type DocumentParseResult, type DocumentUnit } from '../project/document.ts';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels'];
const omittedContainers = new Set(['drawing', 'object', 'pict', 'txbxContent', 'altChunk', 'ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'customXml']);
type Frame = { local: string; uri: string; path: string | null; children: Map<string, number>; blocked: boolean; body: boolean };
type Relationship = { id: string; type: string; target: string; external: boolean };
const attr = (tag: SaxesTagNS, local: string, uri = ''): string | undefined =>
  Object.values(tag.attributes).find(a => a.local === local && a.uri === uri)?.value;
const limit = (resource: string, actual: number, maximum: number) => {
  if (!Number.isSafeInteger(actual) || actual > maximum) throw new Error('DOCUMENT_PACKAGE_LIMIT:' + resource + ': ' + actual + '/' + maximum);
};

/** Diagnostics alone: structural admission remains in ZipArchive. */
function declaredEntries(data: Buffer): number | null {
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) !== 0x06054b50 || i + 22 + data.readUInt16LE(i + 20) !== data.length) continue;
    if (i >= 20 && data.readUInt32LE(i - 20) === 0x07064b50) {
      const offset = data.readBigUInt64LE(i - 12);
      if (offset > BigInt(data.length - 56)) return null;
      const count = data.readBigUInt64LE(Number(offset) + 32);
      return count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(count) : null;
    }
    const count = data.readUInt16LE(i + 10); return count === 0xffff ? null : count;
  }
  return null;
}

/** Namespace-aware XML, with the five predefined entities and numeric character references. */
function parseXml(data: Buffer, request: DocumentParseRequest, state: { nodes: number }, handlers: {
  open(tag: SaxesTagNS, depth: number): void; close(tag: SaxesTagNS): void; text?(text: string): void;
}): void {
  let encoding = 'UTF8';
  if (data[0] === 0xff && data[1] === 0xfe) encoding = 'UTF16LE';
  else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'UTF16BE';
  let xml: string;
  try { xml = new TextDecoder(encoding === 'UTF8' ? 'utf-8' : encoding === 'UTF16LE' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(data); }
  catch { throw new Error('DOCUMENT_XML_ENCODING_INVALID: bytes'); }
  const parser = new SaxesParser({ xmlns: true }); let depth = 0;
  const node = () => limit('xml-nodes', ++state.nodes, request.limits.maxXmlNodes);
  parser.on('xmldecl', declaration => {
    if (!declaration.encoding) return;
    const declared = declaration.encoding.toUpperCase().replaceAll('-', '');
    if (!['UTF8', 'UTF16', 'UTF16LE', 'UTF16BE'].includes(declared)) throw new Error('DOCUMENT_XML_ENCODING_UNSUPPORTED: ' + declaration.encoding);
    if (declared !== encoding && !(declared === 'UTF16' && encoding.startsWith('UTF16'))) throw new Error('DOCUMENT_XML_ENCODING_INVALID: declaration/BOM conflict');
  });
  parser.on('doctype', () => { throw new Error('DOCUMENT_XML_DTD_REJECTED'); });
  parser.on('error', error => { throw new Error('DOCUMENT_XML_INVALID: ' + error.message); });
  parser.on('opentag', tag => { node(); limit('xml-depth', ++depth, request.limits.maxXmlDepth); handlers.open(tag, depth); });
  parser.on('closetag', tag => { handlers.close(tag); depth--; });
  parser.on('text', text => { if (text) node(); handlers.text?.(text); });
  parser.on('cdata', text => { node(); handlers.text?.(text); });
  parser.on('comment', node); parser.on('processinginstruction', node);
  for (let offset = 0; offset < xml.length; offset += 16384) parser.write(xml.slice(offset, offset + 16384));
  parser.close();
}

export async function parseDocxDocument(request: DocumentParseRequest): Promise<DocumentParseResult> {
  assertDocument('request', request);
  if (request.format !== 'docx') throw new Error('DOCUMENT_REQUEST_INVALID: DOCX format required');
  const result = newDocumentResult(request, 'saxes+yauzl', 'saxes@6.0.0/yauzl@3.4.0');
  result.limitations.push('DOCX pagination is unknown. Only main-body paragraph text and basic table cell paragraphs are extracted.',
    'ZIP internal reads are unmeasured; sourceReadBytes counts the independent source hash reads.',
    'Fields retain cached text without calculation; styling, layout, images and embedded objects require separate observation.');
  const limits = request.limits;
  if (request.sourceBytes > limits.maxDocumentSourceBytes) {
    result.status = 'partial'; result.reason = 'DOCUMENT_SOURCE_LIMIT'; result.coverage.omitted.push('entire document: source admission limit'); return result;
  }
  let archive: ZipArchive | null = null, temporary: string | null = null, sourceVerified = false, readBytes = 0, entryCount: number | null = null;
  try {
    if (saxesPackage.name !== 'saxes' || saxesPackage.version !== '6.0.0') throw new Error('DOCUMENT_PARSER_CHANGED: saxes@6.0.0 required');
    const source = await readFixed(request.sourcePath, limits.maxDocumentSourceBytes, undefined, bytes => { readBytes += bytes; });
    if (source.bytes !== request.sourceBytes || source.sha256 !== request.sourceSha256) throw new Error('CATALOG_SOURCE_CHANGED');
    sourceVerified = true;
    if (source.data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw new Error('DOCUMENT_CFB_UNSUPPORTED: encrypted or legacy Office wrapper');
    if (!['504b0304', '504b0506'].includes(source.data.subarray(0, 4).toString('hex'))) throw new Error('DOCUMENT_FORMAT_INVALID: DOCX ZIP signature');
    entryCount = declaredEntries(source.data);
    archive = await ZipArchive.open(request.sourcePath, { ...DEFAULT_UNPACK_POLICY, maxArchiveBytes: limits.maxDocumentSourceBytes,
      maxArchiveEntries: limits.maxDocxEntries }, new AbortController().signal, () => {});
    const nodes = new Map<string, { kind: string; explicit: boolean }>(), folded = new Map<string, string>();
    let expanded = 0, compressed = 0;
    const register = (path: string, kind: string, explicit: boolean) => {
      const key = canonicalUnpackPath(path), prior = nodes.get(path), alias = folded.get(key);
      if (alias && alias !== path || prior && (prior.kind !== 'directory' || kind !== 'directory' || prior.explicit || !explicit)) throw new Error('DOCUMENT_PACKAGE_PATH_COLLISION: ' + path);
      limit('path-depth', path.split('/').length - (kind === 'file' ? 1 : 0), limits.maxPackagePathDepth);
      nodes.set(path, { kind, explicit }); folded.set(key, path);
    };
    const members = await archive.plan(async member => {
      const parts = member.item.path.split('/'); parts.pop(); let parent = '';
      for (const part of parts) {
        parent = parent ? parent + '/' + part : part;
        if (nodes.has(parent)) { if (nodes.get(parent)!.kind !== 'directory') throw new Error('DOCUMENT_PACKAGE_PATH_COLLISION: ' + parent); }
        else register(parent, 'directory', false);
      }
      register(member.item.path, member.item.kind, true);
      expanded += member.item.declaredBytes; compressed += member.item.compressedBytes;
      limit('expanded', expanded, limits.maxDocxDeclaredExpandedBytes);
      if (member.item.compressedBytes === 0 ? member.item.declaredBytes !== 0 : member.item.declaredBytes / member.item.compressedBytes > limits.maxCompressionRatio) throw new Error('DOCUMENT_PACKAGE_LIMIT:ratio: ' + member.item.declaredBytes + '/' + member.item.compressedBytes + ' > ' + limits.maxCompressionRatio + '; ' + member.item.path);
      if (/vbaproject/i.test(member.item.path)) throw new Error('DOCUMENT_MACRO_REJECTED: VBA part');
    });
    if (compressed === 0 ? expanded !== 0 : expanded / compressed > limits.maxCompressionRatio) throw new Error('DOCUMENT_PACKAGE_LIMIT:ratio: ' + expanded + '/' + compressed + ' > ' + limits.maxCompressionRatio + '; package');
    const files = new Map(members.filter(m => m.item.kind === 'file').map(m => [m.item.path, m]));
    if (PARTS.slice(0, 3).some(part => !files.has(part))) throw new Error('DOCUMENT_OPC_INVALID: required ordinary Word parts missing');
    temporary = await mkdtemp(join(process.cwd(), 'docx-parts-'));
    let xmlBytes = 0; const xmlState = { nodes: 0 };
    async function xmlPart(part: string): Promise<Buffer> {
      const member = files.get(part)!; limit('part-bytes', member.item.declaredBytes, limits.maxXmlPartBytes);
      limit('xml-bytes', xmlBytes + member.item.declaredBytes, limits.maxXmlReadBytes);
      let written = 0; const destination = join(temporary!, 'part-' + PARTS.indexOf(part) + '.xml');
      await archive!.extract(process.cwd(), destination, member, { async onCreated() {}, async onCompressed() {},
        admit(bytes) {
          limit('part-bytes', written + bytes, limits.maxXmlPartBytes); limit('xml-bytes', xmlBytes + bytes, limits.maxXmlReadBytes);
          if (written + bytes > member.item.declaredBytes) throw new Error('DOCUMENT_PACKAGE_SIZE_INVALID: ' + (written + bytes) + '/' + member.item.declaredBytes);
        },
        async onWritten(bytes) { written += bytes; xmlBytes += bytes; } });
      return readFile(destination);
    }
    let bodyContentType: string | undefined; const typeKeys = new Set<string>();
    parseXml(await xmlPart(PARTS[0]), request, xmlState, {
      open(tag, depth) {
        if (depth === 1 && (tag.uri !== TYPES || tag.local !== 'Types')) throw new Error('DOCUMENT_OPC_UNSUPPORTED: content types namespace/root');
        if (depth > 2 || depth === 2 && tag.uri !== TYPES) throw new Error('DOCUMENT_OPC_INVALID: content type structure');
        if (depth !== 2) return;
        if (!['Override', 'Default'].includes(tag.local)) throw new Error('DOCUMENT_OPC_INVALID: content type entry');
        const content = attr(tag, 'ContentType'), name = attr(tag, tag.local === 'Override' ? 'PartName' : 'Extension');
        if (!content || !name) throw new Error('DOCUMENT_OPC_INVALID: content type attributes');
        const key = tag.local + ':' + canonicalUnpackPath(name);
        if (typeKeys.has(key)) throw new Error('DOCUMENT_OPC_INVALID: duplicate content type'); typeKeys.add(key);
        if (/macroenabled|vbaproject/i.test(content)) throw new Error('DOCUMENT_MACRO_REJECTED: content type');
        if (tag.local === 'Override' && name === '/word/document.xml') bodyContentType = content;
      }, close() {}, text(text) { if (text.trim()) throw new Error('DOCUMENT_OPC_INVALID: content type text'); },
    });
    if (bodyContentType !== MAIN_TYPE) throw new Error('DOCUMENT_MAIN_PART_UNSUPPORTED: ordinary Word content type');
    async function relationships(part: string): Promise<Relationship[]> {
      const values: Relationship[] = [], ids = new Set<string>();
      parseXml(await xmlPart(part), request, xmlState, {
        open(tag, depth) {
          if (depth === 1 && (tag.uri !== RELS || tag.local !== 'Relationships')) throw new Error('DOCUMENT_OPC_UNSUPPORTED: relationships namespace/root');
          if (depth > 2) throw new Error('DOCUMENT_RELATIONSHIP_INVALID: nested entry');
          if (depth !== 2) return;
          if (tag.uri !== RELS || tag.local !== 'Relationship') throw new Error('DOCUMENT_RELATIONSHIP_INVALID: entry');
          const id = attr(tag, 'Id'), type = attr(tag, 'Type'), target = attr(tag, 'Target'), mode = attr(tag, 'TargetMode') ?? 'Internal';
          if (!id || !type || !target || ids.has(id) || !['Internal', 'External'].includes(mode)) throw new Error('DOCUMENT_RELATIONSHIP_INVALID: attributes/identity');
          ids.add(id); values.push({ id, type, target, external: mode === 'External' });
        }, close() {}, text(text) { if (text.trim()) throw new Error('DOCUMENT_RELATIONSHIP_INVALID: text'); },
      }); return values;
    }
    const rootRelations = await relationships(PARTS[1]);
    const main = rootRelations.filter(r => r.type === OFFICE + 'officeDocument');
    if (main.length !== 1) throw new Error('DOCUMENT_MAIN_PART_UNSUPPORTED: officeDocument relationship');
    if (main[0].external) throw new Error('DOCUMENT_EXTERNAL_MAIN_RELATIONSHIP_REJECTED');
    if (!['word/document.xml', '/word/document.xml'].includes(main[0].target)) {
      if (/[\\?#]/.test(main[0].target) || main[0].target.split('/').includes('..') || /^[a-z]+:/i.test(main[0].target)) throw new Error('DOCUMENT_MAIN_RELATIONSHIP_INVALID: target');
      throw new Error('DOCUMENT_MAIN_PART_UNSUPPORTED: fixed main part');
    }
    const documentRelations = files.has(PARTS[3]) ? await relationships(PARTS[3]) : [];
    const omitted = new Set<string>();
    for (const part of files.keys()) if (!PARTS.includes(part)) omitted.add('unread-part:' + part + '; CRC/content unverified');
    for (const relation of documentRelations) if (relation.external) result.limitations.push('External relationship retained as data: ' + relation.id + ' ' + relation.type + ' ' + relation.target);
    if (!files.has(PARTS[3])) result.limitations.push('Document relationship facts are unknown where no relationships part is present.');
    const frames: Frame[] = []; let bodyCount = 0, totalUnits = 0, textBytes = 0, completed = 0, stopped = false;
    let paragraph: { depth: number; unit: DocumentUnit; parts: string[]; bytes: number; overflow: boolean; blocked: boolean } | null = null;
    const append = (text: string) => {
      if (!paragraph || paragraph.blocked || paragraph.overflow || stopped) return;
      paragraph.bytes += Buffer.byteLength(text);
      if (textBytes + (completed ? 1 : 0) + paragraph.bytes > limits.maxDocumentTextBytes) { paragraph.overflow = true; paragraph.parts = []; }
      else paragraph.parts.push(text);
    };
    parseXml(await xmlPart(PARTS[2]), request, xmlState, {
      open(tag, depth) {
        const parent = frames.at(-1), key = tag.uri + ':' + tag.local, index = (parent?.children.get(key) ?? 0) + 1;
        parent?.children.set(key, index);
        if (depth === 1 && (tag.uri !== WORD || tag.local !== 'document')) throw new Error('DOCUMENT_WORD_NAMESPACE_UNSUPPORTED');
        const path = tag.uri === WORD && /^[A-Za-z]+$/.test(tag.local) && (!parent || parent.path) ? (parent?.path ?? '') + '/w:' + tag.local + '[' + index + ']' : null;
        const body = parent?.body || depth === 2 && tag.uri === WORD && tag.local === 'body';
        if (tag.uri === WORD && tag.local === 'body' && depth !== 2) throw new Error('DOCUMENT_BODY_INVALID: body placement');
        if (depth === 2 && tag.uri === WORD && tag.local === 'body' && ++bodyCount !== 1) throw new Error('DOCUMENT_BODY_INVALID: duplicate body');
        const blocked = !!parent?.blocked || tag.uri !== WORD || omittedContainers.has(tag.local);
        frames.push({ uri: tag.uri, local: tag.local, path, children: new Map(), blocked, body: !!body });
        if (body && !blocked && tag.uri === WORD && ['tbl', 'tr', 'tc'].includes(tag.local)) {
          const parents = tag.local === 'tbl' ? ['body', 'tc'] : tag.local === 'tr' ? ['tbl'] : ['tr'];
          if (!parent || !parents.includes(parent.local)) throw new Error('DOCUMENT_BODY_INVALID: table placement');
        }
        if (body && !blocked && tag.uri === WORD && ['t', 'tab', 'br', 'cr'].includes(tag.local) && (parent?.local !== 'r' || !frames.some(frame => frame.uri === WORD && frame.local === 'p'))) throw new Error('DOCUMENT_BODY_INVALID: run text placement');
        if (body && (tag.uri !== WORD || omittedContainers.has(tag.local))) omitted.add('omitted-structure:' + (path ?? tag.name));
        if (body && tag.uri === WORD && ['fldSimple', 'fldChar', 'instrText'].includes(tag.local)) omitted.add('field-cache-uncomputed');
        if (paragraph && blocked && !parent?.blocked && !['drawing', 'object', 'pict', 'txbxContent'].includes(tag.local)) {
          paragraph.blocked = true; paragraph.parts = [];
        }
        if (body && tag.uri === WORD && tag.local === 'hyperlink') {
          const id = attr(tag, 'id', OFFICE.slice(0, -1));
          if (id && !documentRelations.some(r => r.id === id)) omitted.add('unresolved-hyperlink:' + id);
        }
        if (body && tag.uri === WORD && tag.local === 'p') {
          totalUnits++;
          if (paragraph) { if (blocked) return; throw new Error('DOCUMENT_BODY_INVALID: nested paragraph'); }
          if (!blocked && parent?.local !== 'body' && parent?.local !== 'tc') throw new Error('DOCUMENT_BODY_INVALID: paragraph placement');
          if (!path || stopped) return;
          if (result.units.length >= limits.maxDocumentUnits) { stopped = true; result.reason = 'DOCUMENT_UNIT_LIMIT'; omitted.add('remaining paragraphs: unit limit'); return; }
          paragraph = { depth, unit: { id: 'docx-p-' + totalUnits, ordinal: result.units.length + 1,
            locator: { kind: 'docx', part: 'word/document.xml', structurePath: path }, text: '', status: 'empty', reason: '' },
            parts: [], bytes: 0, overflow: false, blocked };
        }
        if (paragraph && !blocked && tag.uri === WORD && ['tab', 'br', 'cr'].includes(tag.local)) append(tag.local === 'tab' ? '\t' : '\n');
      },
      text(text) { const frame = frames.at(-1); if (frame?.uri === WORD && frame.local === 't' && !frame.blocked) append(text); },
      close(_tag) {
        if (paragraph && paragraph.depth === frames.length) {
          const unit = paragraph.unit;
          if (!paragraph.blocked && textBytes + (completed ? 1 : 0) + paragraph.bytes > limits.maxDocumentTextBytes) paragraph.overflow = true;
          if (paragraph.blocked) { unit.status = 'skipped'; unit.reason = 'DOCUMENT_SCOPE_OMITTED'; }
          else if (paragraph.overflow) { unit.status = 'skipped'; unit.reason = 'DOCUMENT_TEXT_LIMIT'; result.reason = unit.reason; stopped = true; omitted.add('remaining paragraphs: text limit'); }
          else { unit.text = paragraph.parts.join(''); unit.status = unit.text ? 'complete' : 'empty'; textBytes += (completed ? 1 : 0) + Buffer.byteLength(unit.text); completed++; }
          result.units.push(unit); paragraph = null;
        }
        frames.pop();
      },
    });
    if (bodyCount !== 1) throw new Error('DOCUMENT_BODY_INVALID: main body missing');
    result.coverage.totalUnits = totalUnits; result.coverage.completedUnits = completed; result.coverage.omitted = [...omitted];
    if (omitted.size || stopped) { result.status = 'partial'; result.reason ||= 'DOCUMENT_SCOPE_PARTIAL'; }
    await archive.assertCurrent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/CATALOG_(?:FILE_CHANGED|FILE_INVALID|READ_LIMIT|SOURCE_CHANGED)|UNPACK_ARCHIVE_CHANGED|IMPORT_(?:SYMLINK|SOURCE_CHANGED|FILE_CHANGED|PATH_INVALID|PATH_ESCAPE)|ENOENT|ELOOP/.test(message)) throw new Error('CATALOG_SOURCE_CHANGED');
    result.units = []; result.coverage.completedUnits = 0; result.coverage.totalUnits = null;
    result.status = /DOCUMENT_(?:FORMAT|CFB|OPC|MAIN_PART|WORD_NAMESPACE|XML_ENCODING)_UNSUPPORTED/.test(message) ? 'unsupported' : 'failed';
    result.reason = message.startsWith('UNPACK_ENTRY_LIMIT') ? 'DOCUMENT_PACKAGE_LIMIT:entries: ' +
      (entryCount === null ? 'declaredEntries>' + limits.maxDocxEntries + ' (lower bound)' : entryCount + '/' + limits.maxDocxEntries) : message;
  } finally {
    await archive?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (sourceVerified) {
      try {
        const fixed = await readFixed(request.sourcePath, limits.maxDocumentSourceBytes, undefined, bytes => { readBytes += bytes; }, false);
        if (fixed.bytes !== request.sourceBytes || fixed.sha256 !== request.sourceSha256) throw new Error('CATALOG_SOURCE_CHANGED');
      } catch { throw new Error('CATALOG_SOURCE_CHANGED'); }
    }
    result.metrics.sourceReadBytes = readBytes; result.metrics.maxRSSKiB = process.resourceUsage().maxRSS;
  }
  return assertDocument<DocumentParseResult>('result', result);
}
