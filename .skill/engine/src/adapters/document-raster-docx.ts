import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { ZipArchive, type ZipMember } from './unpack-zip.ts';
import { canonicalUnpackPath, DEFAULT_UNPACK_POLICY, safeUnpackPath } from '../project/unpack.ts';
import { preflightOcrImage } from './ocr-raster.ts';
import { rasterLimit, rasterPayload } from './document-raster-source.ts';
import type { DocumentRasterRequest, DocumentRasterResult } from '../project/document-ocr.ts';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PICTURE = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MAIN_PART = 'word/document.xml', REL_PART = 'word/_rels/document.xml.rels';
const excluded = new Set(['pict', 'object', 'txbxContent', 'altChunk', 'ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'customXml']);
const attr = (tag: SaxesTagNS, local: string, uri = '') => Object.values(tag.attributes).find(a => a.local === local && a.uri === uri)?.value;
const invalid = (reason: string): never => { throw Error('DOCUMENT_OCR_DOCX_INVALID: ' + reason); };
type Relation = { id: string; type: string; target: string; external: boolean };

function xml(data: Buffer, request: DocumentRasterRequest, result: DocumentRasterResult, handlers: {
  open(tag: SaxesTagNS, depth: number): void; close?(tag: SaxesTagNS, depth: number): void; text?(text: string): void;
}) {
  let encoding = 'UTF8'; if (data[0] === 0xff && data[1] === 0xfe) encoding = 'UTF16LE'; else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'UTF16BE';
  const text = new TextDecoder(encoding === 'UTF8' ? 'utf-8' : encoding === 'UTF16LE' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(data);
  const parser = new SaxesParser({ xmlns: true }); let depth = 0;
  const node = () => rasterLimit('DOCX_XML_NODES', ++result.metrics.xmlNodes, request.documentLimits.maxXmlNodes);
  parser.on('xmldecl', declaration => {
    const declared = declaration.encoding?.toUpperCase().replaceAll('-', '');
    if (declared && (declared !== encoding && !(declared === 'UTF16' && encoding.startsWith('UTF16')))) invalid('XML encoding declaration/BOM');
  });
  parser.on('doctype', () => invalid('DTD')); parser.on('error', error => invalid('XML: ' + error.message));
  parser.on('opentag', tag => { node(); rasterLimit('DOCX_XML_DEPTH', ++depth, request.documentLimits.maxXmlDepth); handlers.open(tag, depth); });
  parser.on('closetag', tag => { handlers.close?.(tag, depth); depth--; });
  parser.on('text', value => { if (value) node(); handlers.text?.(value); }); parser.on('cdata', value => { node(); handlers.text?.(value); });
  parser.on('comment', node); parser.on('processinginstruction', node);
  for (let offset = 0; offset < text.length; offset += 16384) parser.write(text.slice(offset, offset + 16384)); parser.close();
}
function attributes(tag: SaxesTagNS, allowed: string[]) {
  for (const a of Object.values(tag.attributes)) if (a.uri !== 'http://www.w3.org/2000/xmlns/' && (a.uri || !allowed.includes(a.local))) invalid('unexpected ' + tag.local + ' attribute');
}
function packagePath(value: string): string {
  if (value.startsWith('/')) value = value.slice(1);
  if (!safeUnpackPath(value) || /[%?#]/.test(value) || value !== value.normalize('NFC')) invalid('package part path'); return value;
}
function targetPath(source: string, target: string): string {
  if (!target || /[%?#\\:\x00-\x1f\x7f]/.test(target) || target !== target.normalize('NFC')) invalid('relationship target');
  if ((target.startsWith('/') ? target.slice(1) : target).split('/').some(part => !part || part === '.' || part === '..')) invalid('relationship target segments');
  const parts = (target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(source), target)).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) invalid('relationship target segments'); return packagePath(parts.join('/'));
}

/** All members receive complete CRC validation; only main-body embedded source pixels are selected. */
export async function extractDocxImage(request: DocumentRasterRequest, data: Buffer, result: DocumentRasterResult): Promise<void> {
  if (!['504b0304', '504b0506'].includes(data.subarray(0, 4).toString('hex'))) throw Error('DOCUMENT_OCR_DOCX_UNSUPPORTED: ordinary ZIP Word package required');
  result.limitations.push('DOCX units are main-body paragraph/basic-table DrawingML image occurrences in XML encounter order.',
    'All ZIP members have complete extraction/CRC validation. Body-external part semantics, Word pagination, drawing display crop/rotation/extent/layout and rendered appearance are unverified.',
    'Only original embedded static PNG/JPEG source pixels are selected; repeated occurrences retain distinct source locations. Unselected image header/decoding semantics are unverified.',
    'ZIP internal reads are unmeasured; expandedBytes counts every fully extracted member.');
  const limits = request.documentLimits;
  let archive: ZipArchive | null = null, temporary: string | null = null;
  try {
    archive = await ZipArchive.open(request.sourcePath, { ...DEFAULT_UNPACK_POLICY, maxArchiveBytes: Math.min(request.limits.maxSourceBytes, limits.maxDocumentSourceBytes), maxArchiveEntries: limits.maxDocxEntries }, new AbortController().signal, () => {});
    const nodes = new Map<string, { kind: string; explicit: boolean }>(), folded = new Map<string, string>(); let expanded = 0, compressed = 0;
    const register = (path: string, kind: string, explicit: boolean) => {
      const key = canonicalUnpackPath(path), prior = nodes.get(path), alias = folded.get(key);
      if (alias && alias !== path || prior && (prior.kind !== 'directory' || kind !== 'directory' || prior.explicit || !explicit)) invalid('package path collision');
      rasterLimit('DOCX_PATH_DEPTH', path.split('/').length - (kind === 'file' ? 1 : 0), limits.maxPackagePathDepth);
      nodes.set(path, { kind, explicit }); folded.set(key, path);
    };
    const members = await archive.plan(async member => {
      const parents = member.item.path.split('/'); parents.pop(); let parent = '';
      for (const part of parents) { parent = parent ? parent + '/' + part : part; if (nodes.has(parent)) { if (nodes.get(parent)!.kind !== 'directory') invalid('file parent'); } else register(parent, 'directory', false); }
      register(member.item.path, member.item.kind, true); expanded += member.item.declaredBytes; compressed += member.item.compressedBytes;
      rasterLimit('DOCX_EXPANDED_BYTES', expanded, limits.maxDocxDeclaredExpandedBytes);
      if (member.item.compressedBytes === 0 ? member.item.declaredBytes !== 0 : member.item.declaredBytes / member.item.compressedBytes > limits.maxCompressionRatio) throw Error('DOCUMENT_OCR_DOCX_COMPRESSION_RATIO_LIMIT');
      if (/vbaproject/i.test(member.item.path)) throw Error('DOCUMENT_OCR_DOCX_MACRO_REJECTED');
    });
    if (compressed === 0 ? expanded !== 0 : expanded / compressed > limits.maxCompressionRatio) throw Error('DOCUMENT_OCR_DOCX_COMPRESSION_RATIO_LIMIT');
    const files = new Map(members.filter(m => m.item.kind === 'file').map(m => [m.item.path, m]));
    if (['[Content_Types].xml', '_rels/.rels', MAIN_PART].some(part => !files.has(part))) invalid('required ordinary Word parts');
    temporary = await mkdtemp(join(process.cwd(), 'docx-raster-'));
    const extracted = new Map<string, { path: string; bytes: number; sha256: string; crc32: string }>();
    for (const member of members) {
      const destination = member.item.kind === 'file' ? join(temporary, 'part-' + member.item.archiveIndex) : null;
      const identity = await archive.extract(process.cwd(), destination, member, {
        async onCreated() {}, async onCompressed() {},
        admit(bytes) { rasterLimit('DOCX_EXPANDED_BYTES', result.metrics.expandedBytes + bytes, limits.maxDocxDeclaredExpandedBytes); },
        async onWritten(bytes) { result.metrics.expandedBytes += bytes; },
      });
      if (destination) extracted.set(member.item.path, { path: destination, ...identity });
    }
    await archive.assertCurrent(); let xmlBytes = 0;
    async function xmlPart(part: string) {
      const item = extracted.get(part); if (!item) invalid('missing XML part: ' + part);
      rasterLimit('DOCX_XML_PART_BYTES', item.bytes, limits.maxXmlPartBytes);
      xmlBytes += item.bytes; rasterLimit('DOCX_XML_READ_BYTES', xmlBytes, limits.maxXmlReadBytes); return readFile(item.path);
    }
    const defaults = new Map<string, string>(), overrides = new Map<string, string>();
    xml(await xmlPart('[Content_Types].xml'), request, result, {
      open(tag, depth) {
        if (depth === 1) { if (tag.uri !== TYPES || tag.local !== 'Types') invalid('content types root'); attributes(tag, []); return; }
        if (depth !== 2 || tag.uri !== TYPES || !['Default', 'Override'].includes(tag.local)) invalid('content type structure');
        attributes(tag, [tag.local === 'Default' ? 'Extension' : 'PartName', 'ContentType']);
        const type = attr(tag, 'ContentType'), name = attr(tag, tag.local === 'Default' ? 'Extension' : 'PartName'); if (!type || !name) invalid('content type attributes');
        if (/macroenabled|vbaproject/i.test(type)) throw Error('DOCUMENT_OCR_DOCX_MACRO_REJECTED');
        const values = tag.local === 'Default' ? defaults : overrides, key = tag.local === 'Default' ? name.toLowerCase() : packagePath(name);
        if (tag.local === 'Default' ? !/^[a-z0-9]+$/.test(key) : !name.startsWith('/') || !files.has(key)) invalid('content type part');
        if (values.has(key)) invalid('duplicate content type'); values.set(key, type);
      }, text(value) { if (value.trim()) invalid('content type text'); },
    });
    const contentType = (part: string) => overrides.get(part) ?? defaults.get(posix.extname(part).slice(1).toLowerCase());
    if (contentType(MAIN_PART) !== MAIN) throw Error('DOCUMENT_OCR_DOCX_UNSUPPORTED: ordinary Transitional Word main content type');
    async function relationships(part: string, source: string): Promise<Relation[]> {
      const values: Relation[] = [], ids = new Set<string>();
      xml(await xmlPart(part), request, result, {
        open(tag, depth) {
          if (depth === 1) { if (tag.uri !== RELS || tag.local !== 'Relationships') invalid('relationship root'); attributes(tag, []); return; }
          if (depth !== 2 || tag.uri !== RELS || tag.local !== 'Relationship') invalid('relationship structure'); attributes(tag, ['Id', 'Type', 'Target', 'TargetMode']);
          const id = attr(tag, 'Id'), type = attr(tag, 'Type'), target = attr(tag, 'Target'), mode = attr(tag, 'TargetMode') ?? 'Internal';
          if (!id || !type || !target || ids.has(id) || !['Internal', 'External'].includes(mode)) invalid('relationship attributes'); ids.add(id);
          if (mode === 'Internal' && !files.has(targetPath(source, target))) invalid('relationship missing target');
          values.push({ id, type, target, external: mode === 'External' });
        }, text(value) { if (value.trim()) invalid('relationship text'); },
      }); return values;
    }
    const roots = await relationships('_rels/.rels', ''), main = roots.filter(r => r.type === OFFICE + 'officeDocument');
    if (main.length !== 1 || main[0]!.external || targetPath('', main[0]!.target) !== MAIN_PART) invalid('main relationship');
    const relations = files.has(REL_PART) ? await relationships(REL_PART, MAIN_PART) : [], images = new Map<string, { part: string; member: ZipMember; format: 'png_pipe' | 'jpeg_pipe' }>();
    for (const relation of relations) {
      if (relation.type !== OFFICE + 'image') { if (relation.external) result.limitations.push('Unexecuted external relationship data: ' + relation.id); continue; }
      if (relation.external) throw Error('DOCUMENT_OCR_DOCX_EXTERNAL_IMAGE_REJECTED');
      const part = targetPath(MAIN_PART, relation.target);
      if (!part.startsWith('word/media/')) invalid('image target outside word/media');
      const type = contentType(part), format = type === 'image/png' ? 'png_pipe' : type === 'image/jpeg' ? 'jpeg_pipe' : null;
      if (!format) throw Error('DOCUMENT_OCR_DOCX_IMAGE_FORMAT_UNSUPPORTED: ' + String(type));
      images.set(relation.id, { part, member: files.get(part)!, format });
    }
    type Frame = { uri: string; local: string; path: string | null; children: Map<string, number>; body: boolean; paragraph: boolean; blocked: boolean };
    type Drawing = { occurrence: number; path: string; depth: number; containers: number; graphics: number; graphicData: number; pictures: number; fills: number; embeds: string[]; reason: string };
    const frames: Frame[] = [], drawings: Drawing[] = [], omitted = new Set<string>(); let bodyCount = 0, drawing: Drawing | null = null;
    xml(await xmlPart(MAIN_PART), request, result, {
      open(tag, depth) {
        const parent = frames.at(-1), key = tag.uri + ':' + tag.local, index = (parent?.children.get(key) ?? 0) + 1; parent?.children.set(key, index);
        if (depth === 1 && (tag.uri !== WORD || tag.local !== 'document')) throw Error('DOCUMENT_OCR_DOCX_UNSUPPORTED: Transitional main namespace');
        const path = tag.uri === WORD && (!parent || parent.path) ? (parent?.path ?? '') + `/w:${tag.local}[${index}]` : null;
        const body = parent?.body || depth === 2 && tag.uri === WORD && tag.local === 'body';
        if (tag.uri === WORD && tag.local === 'body') { if (depth !== 2 || ++bodyCount !== 1) invalid('body placement/count'); }
        const blocked = !!parent?.blocked || tag.uri !== WORD || excluded.has(tag.local);
        if (body && !blocked && tag.uri === WORD && tag.local === 'p' &&
            !(parent?.uri === WORD && ['body', 'tc'].includes(parent.local))) invalid('paragraph placement');
        if (body && !blocked && tag.uri === WORD && ['tbl', 'tr', 'tc'].includes(tag.local) &&
            !(tag.local === 'tbl' ? parent?.uri === WORD && ['body', 'tc'].includes(parent.local) :
              tag.local === 'tr' ? parent?.uri === WORD && parent.local === 'tbl' : parent?.uri === WORD && parent.local === 'tr')) invalid('basic table placement');
        const paragraph = !!parent?.paragraph || !!body && !blocked && tag.uri === WORD && tag.local === 'p' && !!parent && ['body', 'tc'].includes(parent.local);
        frames.push({ uri: tag.uri, local: tag.local, path, children: new Map(), body: !!body, paragraph, blocked });
        if (body && excluded.has(tag.local) && tag.uri === WORD) omitted.add('omitted-main-structure:' + tag.local);
        if (body && tag.uri === WORD && tag.local === 'drawing' && !parent?.blocked && parent?.paragraph && path) {
          if (drawing) invalid('nested drawing'); rasterLimit('DOCX_IMAGE_OCCURRENCES', drawings.length + 1, request.limits.maxImageOccurrences);
          drawing = { occurrence: drawings.length + 1, path, depth, containers: 0, graphics: 0, graphicData: 0, pictures: 0, fills: 0, embeds: [], reason: parent.local === 'r' && parent.uri === WORD ? '' : 'drawing placement' }; drawings.push(drawing);
        } else if (body && tag.uri === WORD && tag.local === 'drawing' && !drawing) omitted.add('omitted-drawing-outside-main-paragraph');
        if (!drawing || depth <= drawing.depth) return;
        const chain = frames.slice(drawing.depth), at = (n: number, uri: string, local: string) => chain[n]?.uri === uri && chain[n]?.local === local;
        const container = chain[0]?.uri === WP && ['inline', 'anchor'].includes(chain[0]!.local);
        if (chain.length === 1) { if (container) drawing.containers++; else drawing.reason ||= 'drawing container'; }
        if (tag.uri === DRAWING && tag.local === 'graphic') { if (chain.length === 2 && container) drawing.graphics++; else drawing.reason ||= 'graphic placement'; }
        if (tag.uri === DRAWING && tag.local === 'graphicData') { if (chain.length === 3 && container && at(1, DRAWING, 'graphic') && attr(tag, 'uri') === PICTURE) drawing.graphicData++; else drawing.reason ||= 'picture graphicData'; }
        if (tag.uri === PICTURE && tag.local === 'pic') { if (chain.length === 4 && at(2, DRAWING, 'graphicData')) drawing.pictures++; else drawing.reason ||= 'picture placement'; }
        if (tag.uri === PICTURE && tag.local === 'blipFill') { if (chain.length === 5 && at(3, PICTURE, 'pic')) drawing.fills++; else drawing.reason ||= 'blipFill placement'; }
        if (tag.uri === DRAWING && tag.local === 'blip') {
          const embed = attr(tag, 'embed', OFFICE.slice(0, -1)), link = attr(tag, 'link', OFFICE.slice(0, -1));
          if (chain.length !== 6 || !at(4, PICTURE, 'blipFill') || !embed || link !== undefined) drawing.reason ||= 'embedded blip/link';
          else drawing.embeds.push(embed);
        }
      },
      close(_tag, depth) { if (drawing?.depth === depth) drawing = null; frames.pop(); },
    });
    if (bodyCount !== 1) invalid('main body missing'); result.totalUnits = drawings.length; result.limitations.push(...omitted);
    if (request.unit > drawings.length) throw Error('DOCUMENT_OCR_UNIT_OUT_OF_RANGE');
    const selected = drawings[request.unit - 1]!;
    if (selected.reason || [selected.containers, selected.graphics, selected.graphicData, selected.pictures, selected.fills, selected.embeds.length].some(n => n !== 1)) throw Error('DOCUMENT_OCR_DOCX_DRAWING_UNSUPPORTED: ' + (selected.reason || 'ambiguous image structure'));
    const relationshipId = selected.embeds[0]!, image = images.get(relationshipId); if (!image) invalid('missing/wrong image relationship');
    const actual = extracted.get(image.part)!; rasterLimit('EMBEDDED_BYTES', actual.bytes, request.limits.maxEmbeddedBytesPerUnit);
    const encoded = await readFile(actual.path), header = preflightOcrImage(encoded, image.format, { ...request.ocrLimits,
      maxOcrSourceBytes: Math.min(request.ocrLimits.maxOcrSourceBytes, request.limits.maxEmbeddedBytesPerUnit),
      maxOcrEdge: Math.min(request.ocrLimits.maxOcrEdge, request.limits.maxEdge), maxOcrSourcePixels: Math.min(request.ocrLimits.maxOcrSourcePixels, request.limits.maxPixelsPerUnit) });
    result.locator = { kind: 'docx-image', occurrence: request.unit, mainPart: MAIN_PART, structurePath: selected.path, relationshipsPart: REL_PART, relationshipId,
      embeddedPart: image.part, embeddedBytes: actual.bytes, embeddedSha256: actual.sha256, embeddedCrc32: parseInt(actual.crc32, 16), format: image.format, width: header.width, height: header.height };
    result.payload = rasterPayload(image.format, encoded); await archive.assertCurrent();
  } finally { await archive?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
