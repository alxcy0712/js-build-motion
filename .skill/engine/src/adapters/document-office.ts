import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import saxesPackage from 'saxes/package.json' with { type: 'json' };
import { ZipArchive } from './unpack-zip.ts';
import { readFixed } from './inspection.ts';
import { canonicalUnpackPath, DEFAULT_UNPACK_POLICY } from '../project/unpack.ts';
import { assertDocument, newDocumentResult, type DocumentParseRequest, type DocumentParseResult, type DocumentLocator } from '../project/document.ts';

const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const CONTENT = 'application/vnd.openxmlformats-officedocument.';
type Xml = { uri: string; local: string; path: string; text: string; tag: SaxesTagNS; children: Xml[]; parent: Xml | null };
type Relationship = { id: string; type: string; target: string };
type OfficeLocator = Extract<DocumentLocator, { kind: 'pptx' | 'xlsx' }>;
const attr = (node: Xml, local: string, uri = '') => Object.values(node.tag.attributes).find(a => a.local === local && a.uri === uri)?.value;
const children = (node: Xml, uri: string, local: string) => node.children.filter(c => c.uri === uri && c.local === local);
function one(node: Xml, uri: string, local: string, required = true): Xml | undefined {
  const values = children(node, uri, local);
  if (values.length > 1 || required && !values.length) throw Error('DOCUMENT_OFFICE_STRUCTURE_INVALID: ' + local);
  return values[0];
}
function *walk(node: Xml): Generator<Xml> { yield node; for (const child of node.children) yield *walk(child); }
function limit(resource: string, actual: number, maximum: number): void {
  if (!Number.isSafeInteger(actual) || actual > maximum) throw Error('DOCUMENT_PACKAGE_LIMIT:' + resource + ': ' + actual + '/' + maximum);
}
function root(node: Xml, uri: string, local: string): void {
  if (node.uri !== uri || node.local !== local) throw Error('DOCUMENT_OFFICE_NAMESPACE_UNSUPPORTED: ' + local);
}
function coordinate(value: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value); let column = 0;
  if (!match) throw Error('DOCUMENT_CELL_INVALID: coordinate ' + value);
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw Error('DOCUMENT_CELL_INVALID: coordinate ' + value);
  return { column, row };
}
function tableRange(value: string, maximum: number): { columns: number } {
  const parts = value.split(':'); if (parts.length > 2) throw Error('DOCUMENT_TABLE_RANGE_INVALID');
  const first = coordinate(parts[0]!), last = coordinate(parts[1] ?? parts[0]!);
  if (last.column < first.column || last.row < first.row) throw Error('DOCUMENT_TABLE_RANGE_INVALID');
  limit('table-range-cells', (last.column - first.column + 1) * (last.row - first.row + 1), maximum);
  return { columns: last.column - first.column + 1 };
}

/** Finite native Office text; every package member is inflated and CRC verified before XML interpretation. */
export async function parseOfficeDocument(request: DocumentParseRequest): Promise<DocumentParseResult> {
  assertDocument('request', request);
  if (!['pptx', 'xlsx'].includes(request.format) || !request.office) throw Error('DOCUMENT_REQUEST_INVALID: Office format required');
  const result = newDocumentResult(request, 'saxes+yauzl', 'saxes@6.0.0/yauzl@3.4.0'), limits = request.limits, office = request.office;
  result.limitations.push('Only ordinary transitional Office XML is supported. ZIP internal IO is unmeasured; sourceReadBytes counts independent source hash reads.',
    'External targets are refused in interpreted relationship parts. Unread relationship parts receive CRC verification and partial/omitted coverage; no external target is fetched.',
    request.format === 'pptx' ? 'Slide shape/basic table paragraphs and notes body placeholders are native text. Layout, masters, media, charts, SmartArt and displayed ordering require separate observation.' :
      'Explicit worksheet cell values and basic table name/range/columns are native data. Formula caches are uncomputed; styles, displayed dates/numbers, drawings, pivots and charts require separate observation.');
  if (request.sourceBytes > limits.maxDocumentSourceBytes) {
    result.status = 'partial'; result.reason = 'DOCUMENT_SOURCE_LIMIT'; result.coverage.omitted.push('entire document: source admission limit'); return result;
  }
  let archive: ZipArchive | null = null, temporary: string | null = null, verified = false, readBytes = 0;
  const omitted = new Set<string>(), usedParts = new Set<string>(); let totalUnits = 0, completed = 0, textBytes = 0;
  function emit(locator: OfficeLocator, text: string, reason = ''): void {
    totalUnits++;
    if (result.units.length >= limits.maxDocumentUnits) { omitted.add('remaining native units: unit limit'); result.reason ||= 'DOCUMENT_UNIT_LIMIT'; return; }
    const bytes = Buffer.byteLength(text);
    if (!reason && textBytes + (completed ? 1 : 0) + bytes > limits.maxDocumentTextBytes) reason = 'DOCUMENT_TEXT_LIMIT';
    if (reason) { omitted.add(reason + ': ' + locator.part + locator.structurePath); result.reason ||= reason; }
    else { textBytes += (completed ? 1 : 0) + bytes; completed++; }
    result.units.push({ id: request.format + '-unit-' + totalUnits, ordinal: result.units.length + 1, locator,
      text: reason ? '' : text, status: reason ? 'skipped' : text ? 'complete' : 'empty', reason });
  }
  try {
    if (saxesPackage.name !== 'saxes' || saxesPackage.version !== '6.0.0') throw Error('DOCUMENT_PARSER_CHANGED: saxes@6.0.0 required');
    const source = await readFixed(request.sourcePath, limits.maxDocumentSourceBytes, undefined, bytes => { readBytes += bytes; });
    if (source.bytes !== request.sourceBytes || source.sha256 !== request.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED'); verified = true;
    if (source.data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) throw Error('DOCUMENT_CFB_UNSUPPORTED: encrypted or legacy Office wrapper');
    if (!['504b0304', '504b0506'].includes(source.data.subarray(0, 4).toString('hex'))) throw Error('DOCUMENT_FORMAT_INVALID: Office ZIP signature');
    archive = await ZipArchive.open(request.sourcePath, { ...DEFAULT_UNPACK_POLICY, maxArchiveBytes: limits.maxDocumentSourceBytes,
      maxArchiveEntries: limits.maxDocxEntries }, new AbortController().signal, () => {});
    const nodes = new Map<string, { kind: string; explicit: boolean }>(), folded = new Map<string, string>(); let expanded = 0, compressed = 0;
    function register(path: string, kind: string, explicit: boolean) {
      const key = canonicalUnpackPath(path), prior = nodes.get(path), alias = folded.get(key);
      if (alias && alias !== path || prior && (prior.kind !== 'directory' || kind !== 'directory' || prior.explicit || !explicit)) throw Error('DOCUMENT_PACKAGE_PATH_COLLISION: ' + path);
      limit('path-depth', path.split('/').length - (kind === 'file' ? 1 : 0), limits.maxPackagePathDepth);
      nodes.set(path, { kind, explicit }); folded.set(key, path);
    }
    const members = await archive.plan(async member => {
      const parents = member.item.path.split('/'); parents.pop(); let parent = '';
      for (const part of parents) {
        parent = parent ? parent + '/' + part : part;
        if (nodes.has(parent)) { if (nodes.get(parent)!.kind !== 'directory') throw Error('DOCUMENT_PACKAGE_PATH_COLLISION: ' + parent); }
        else register(parent, 'directory', false);
      }
      register(member.item.path, member.item.kind, true);
      expanded += member.item.declaredBytes; compressed += member.item.compressedBytes;
      limit('expanded', expanded, limits.maxDocxDeclaredExpandedBytes);
      if (member.item.compressedBytes === 0 ? member.item.declaredBytes !== 0 : member.item.declaredBytes / member.item.compressedBytes > limits.maxCompressionRatio) throw Error('DOCUMENT_PACKAGE_LIMIT:ratio: ' + member.item.path);
      if (/vbaproject|vbadata|(?:^|\/)(?:intl)?macrosheets\//i.test(member.item.path)) throw Error('DOCUMENT_MACRO_REJECTED: ' + member.item.path);
    });
    if (compressed === 0 ? expanded !== 0 : expanded / compressed > limits.maxCompressionRatio) throw Error('DOCUMENT_PACKAGE_LIMIT:ratio: package');
    temporary = await mkdtemp(join(process.cwd(), 'office-parts-'));
    const files = new Map<string, string>(), sizes = new Map<string, number>(); let written = 0;
    for (const [index, member] of members.entries()) {
      const destination = member.item.kind === 'file' ? join(temporary, 'part-' + index) : null;
      await archive.extract(process.cwd(), destination, member, { async onCreated() {}, async onCompressed() {},
        admit(bytes) { limit('expanded', written + bytes, limits.maxDocxDeclaredExpandedBytes); }, async onWritten(bytes) { written += bytes; } });
      if (destination) { files.set(member.item.path, destination); sizes.set(member.item.path, member.item.declaredBytes); }
    }
    let xmlBytes = 0, xmlNodes = 0;
    async function xmlPart(part: string): Promise<Xml> {
      const path = files.get(part); if (!path) throw Error('DOCUMENT_OFFICE_PART_MISSING: ' + part);
      if (usedParts.has(part)) throw Error('DOCUMENT_OFFICE_PART_REUSED: ' + part); usedParts.add(part);
      limit('part-bytes', sizes.get(part)!, limits.maxXmlPartBytes); limit('xml-bytes', xmlBytes + sizes.get(part)!, limits.maxXmlReadBytes);
      const data = await readFile(path); xmlBytes += data.length;
      let encoding = 'UTF8';
      if (data[0] === 0xff && data[1] === 0xfe) encoding = 'UTF16LE'; else if (data[0] === 0xfe && data[1] === 0xff) encoding = 'UTF16BE';
      let xml: string;
      try { xml = new TextDecoder(encoding === 'UTF8' ? 'utf-8' : encoding === 'UTF16LE' ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(data); }
      catch { throw Error('DOCUMENT_XML_ENCODING_INVALID: ' + part); }
      const parser = new SaxesParser({ xmlns: true }), frames: { node: Xml; counts: Map<string, number> }[] = []; let document: Xml | undefined;
      const count = () => limit('xml-nodes', ++xmlNodes, limits.maxXmlNodes);
      parser.on('xmldecl', declaration => {
        if (!declaration.encoding) return; const declared = declaration.encoding.toUpperCase().replaceAll('-', '');
        if (!['UTF8', 'UTF16', 'UTF16LE', 'UTF16BE'].includes(declared)) throw Error('DOCUMENT_XML_ENCODING_UNSUPPORTED: ' + declaration.encoding);
        if (declared !== encoding && !(declared === 'UTF16' && encoding.startsWith('UTF16'))) throw Error('DOCUMENT_XML_ENCODING_INVALID: declaration/BOM conflict');
      });
      parser.on('doctype', () => { throw Error('DOCUMENT_XML_DTD_REJECTED'); });
      parser.on('error', error => { throw Error('DOCUMENT_XML_INVALID: ' + error.message); });
      parser.on('opentag', tag => {
        count(); limit('xml-depth', frames.length + 1, limits.maxXmlDepth);
        const parent = frames.at(-1), key = tag.uri + ':' + tag.local, index = (parent?.counts.get(key) ?? 0) + 1; parent?.counts.set(key, index);
        const prefix = tag.uri === PRESENTATION ? 'p:' : tag.uri === DRAWING ? 'a:' : tag.uri === SHEET ? 's:' : '';
        const path = /^[A-Za-z]+$/.test(tag.local) && (!parent || parent.node.path) ? (parent?.node.path ?? '') + '/' + prefix + tag.local + '[' + index + ']' : '';
        const node: Xml = { uri: tag.uri, local: tag.local, path, text: '', tag, children: [], parent: parent?.node ?? null };
        if (parent) parent.node.children.push(node); else document = node; frames.push({ node, counts: new Map() });
      });
      parser.on('closetag', () => { frames.pop(); });
      const text = (value: string) => { if (value) count(); if (frames.length) frames.at(-1)!.node.text += value; };
      parser.on('text', text); parser.on('cdata', text); parser.on('comment', count); parser.on('processinginstruction', count);
      for (let offset = 0; offset < xml.length; offset += 16384) parser.write(xml.slice(offset, offset + 16384)); parser.close();
      if (!document) throw Error('DOCUMENT_XML_INVALID: missing root'); return document;
    }
    const contentTypes = new Map<string, string>(), defaults = new Set<string>(), typeRoot = await xmlPart('[Content_Types].xml'); root(typeRoot, TYPES, 'Types');
    for (const entry of typeRoot.children) {
      if (entry.uri !== TYPES || !['Override', 'Default'].includes(entry.local) || entry.children.length || entry.text.trim()) throw Error('DOCUMENT_OPC_INVALID: content types entry');
      const content = attr(entry, 'ContentType'), name = attr(entry, entry.local === 'Override' ? 'PartName' : 'Extension');
      if (!content || !name) throw Error('DOCUMENT_OPC_INVALID: content types attributes');
      if (/macroenabled|vbaproject|macrosheet/i.test(content)) throw Error('DOCUMENT_MACRO_REJECTED: content type');
      const key = canonicalUnpackPath(name);
      if (entry.local === 'Override') { if (!name.startsWith('/') || contentTypes.has(key)) throw Error('DOCUMENT_OPC_INVALID: content types identity'); contentTypes.set(key, content); }
      else { if (defaults.has(key)) throw Error('DOCUMENT_OPC_INVALID: content types identity'); defaults.add(key); }
    }
    function contentType(part: string, expected: string) {
      if (contentTypes.get(canonicalUnpackPath('/' + part)) !== CONTENT + expected + '+xml') throw Error('DOCUMENT_OFFICE_CONTENT_TYPE_UNSUPPORTED: ' + part);
    }
    const relations = new Map<string, Relationship[]>();
    async function relationships(part: string, optional = false): Promise<Relationship[]> {
      if (relations.has(part)) return relations.get(part)!;
      if (!files.has(part) && optional) return [];
      const document = await xmlPart(part); root(document, RELS, 'Relationships'); const ids = new Set<string>(), values: Relationship[] = [];
      for (const entry of document.children) {
        const id = attr(entry, 'Id'), type = attr(entry, 'Type'), target = attr(entry, 'Target'), mode = attr(entry, 'TargetMode') ?? 'Internal';
        if (entry.uri !== RELS || entry.local !== 'Relationship' || entry.children.length || entry.text.trim() || !id || !type || !target || ids.has(id) || !['Internal', 'External'].includes(mode)) throw Error('DOCUMENT_RELATIONSHIP_INVALID: ' + part);
        if (mode === 'External') throw Error('DOCUMENT_EXTERNAL_RELATIONSHIP_REJECTED: ' + part + '#' + id);
        ids.add(id); values.push({ id, type, target });
      }
      relations.set(part, values); return values;
    }
    function target(owner: string, relation: Relationship, family: RegExp): string {
      if (/[\\%?#\x00-\x1f\x7f]/.test(relation.target) || /^[a-z]+:/i.test(relation.target) || relation.target.startsWith('//')) throw Error('DOCUMENT_RELATIONSHIP_TARGET_INVALID: ' + relation.target);
      const path = relation.target.startsWith('/') ? relation.target.slice(1) : posix.normalize(posix.join(posix.dirname(owner), relation.target));
      if (!family.test(path) || !files.has(path)) throw Error('DOCUMENT_RELATIONSHIP_TARGET_INVALID: ' + relation.target); return path;
    }
    function relation(values: Relationship[], id: string | undefined, type: string): Relationship {
      const selected = values.filter(r => r.id === id && r.type === OFFICE + type);
      if (!id || selected.length !== 1) throw Error('DOCUMENT_RELATIONSHIP_INVALID: ' + type + '#' + id); return selected[0]!;
    }
    const rootRelations = await relationships('_rels/.rels'), main = rootRelations.filter(r => r.type === OFFICE + 'officeDocument');
    if (main.length !== 1) throw Error('DOCUMENT_MAIN_PART_UNSUPPORTED: officeDocument relationship');
    const mainPart = request.format === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml';
    target('', main[0]!, new RegExp('^' + mainPart.replace('.', '\\.') + '$'));
    contentType(mainPart, request.format === 'pptx' ? 'presentationml.presentation.main' : 'spreadsheetml.sheet.main');
    if (request.format === 'pptx') {
      const presentation = await xmlPart(mainPart); root(presentation, PRESENTATION, 'presentation');
      const ids = one(presentation, PRESENTATION, 'sldIdLst', false)?.children ?? [], seenIds = new Set<string>(), slides = new Set<string>();
      limit('slides', ids.length, office.maxSlides);
      const presentationRelations = await relationships('ppt/_rels/presentation.xml.rels', !ids.length);
      for (const [index, item] of ids.entries()) {
        if (item.uri !== PRESENTATION || item.local !== 'sldId') throw Error('DOCUMENT_SLIDE_INVALID: slide list');
        const id = attr(item, 'id'); if (!id || !/^[1-9][0-9]*$/.test(id) || seenIds.has(id)) throw Error('DOCUMENT_SLIDE_INVALID: identity'); seenIds.add(id);
        const part = target(mainPart, relation(presentationRelations, attr(item, 'id', OFFICE.slice(0, -1)), 'slide'), /^ppt\/slides\/slide[1-9][0-9]*\.xml$/);
        if (slides.has(part)) throw Error('DOCUMENT_SLIDE_INVALID: duplicate part'); slides.add(part); contentType(part, 'presentationml.slide');
        async function paragraphs(part: string, notes: boolean) {
          const document = await xmlPart(part); root(document, PRESENTATION, notes ? 'notes' : 'sld');
          const tree = one(one(document, PRESENTATION, 'cSld')!, PRESENTATION, 'spTree')!;
          for (const paragraph of walk(tree)) {
            if (paragraph.uri !== DRAWING || paragraph.local !== 'p') continue;
            const ancestors: Xml[] = []; for (let parent = paragraph.parent; parent && parent !== tree; parent = parent.parent) ancestors.push(parent);
            const shape = ancestors.find(n => n.uri === PRESENTATION && n.local === 'sp'), table = ancestors.find(n => n.uri === DRAWING && n.local === 'tbl');
            const foreign = ancestors.some(n => ![PRESENTATION, DRAWING].includes(n.uri));
            const body = shape && one(one(shape, PRESENTATION, 'nvSpPr')!, PRESENTATION, 'nvPr')!;
            const placeholder = body && one(body, PRESENTATION, 'ph', false);
            if (notes && (!placeholder || attr(placeholder, 'type') !== 'body')) continue;
            if (!paragraph.path || foreign || !shape && !table || notes && !shape || !['txBody'].includes(paragraph.parent?.local ?? '')) { omitted.add('unsupported paragraph: ' + part + paragraph.path); continue; }
            let text = '';
            for (const child of paragraph.children) {
              if (child.uri !== DRAWING) { omitted.add('unsupported paragraph structure: ' + part + child.path); continue; }
              if (child.local === 'br') text += '\n';
              else if (['r', 'fld'].includes(child.local)) {
                const value = one(child, DRAWING, 't', false); if (value?.children.length) throw Error('DOCUMENT_SLIDE_INVALID: run text'); text += value?.text ?? '';
                if (child.local === 'fld') omitted.add('field cache uncomputed: ' + part + child.path);
              } else if (!['pPr', 'endParaRPr'].includes(child.local)) omitted.add('unsupported paragraph structure: ' + part + child.path);
            }
            emit({ kind: 'pptx', slide: index + 1, part, structurePath: paragraph.path }, text);
          }
        }
        await paragraphs(part, false);
        const slideRelations = await relationships(posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels'), true), notes = slideRelations.filter(r => r.type === OFFICE + 'notesSlide');
        if (notes.length > 1) throw Error('DOCUMENT_NOTES_INVALID: duplicate relationship');
        if (notes.length) { const notePart = target(part, notes[0]!, /^ppt\/notesSlides\/notesSlide[1-9][0-9]*\.xml$/); contentType(notePart, 'presentationml.notesSlide'); await paragraphs(notePart, true); }
      }
    } else {
      const workbook = await xmlPart(mainPart); root(workbook, SHEET, 'workbook');
      if (children(workbook, SHEET, 'externalReferences').length) throw Error('DOCUMENT_EXTERNAL_REFERENCE_REJECTED');
      const workbookRelations = await relationships('xl/_rels/workbook.xml.rels'), sharedRelations = workbookRelations.filter(r => r.type === OFFICE + 'sharedStrings');
      if (sharedRelations.length > 1) throw Error('DOCUMENT_SHARED_STRING_INVALID: relationship');
      function stringValue(node: Xml, part: string): string {
        let text = ''; const plain = children(node, SHEET, 't'), runs = children(node, SHEET, 'r');
        if (plain.length > 1 || plain.length && runs.length) throw Error('DOCUMENT_SHARED_STRING_INVALID: text structure');
        for (const value of plain.length ? plain : runs.map(r => one(r, SHEET, 't')!)) {
          if (value.children.length) throw Error('DOCUMENT_SHARED_STRING_INVALID: nested text'); text += value.text;
        }
        for (const child of node.children) if (child.uri !== SHEET || !['t', 'r'].includes(child.local)) omitted.add('omitted string structure: ' + part + child.path);
        return text;
      }
      const strings: string[] = []; let sharedBytes = 0;
      if (sharedRelations.length) {
        const part = target(mainPart, sharedRelations[0]!, /^xl\/sharedStrings\.xml$/); contentType(part, 'spreadsheetml.sharedStrings'); const sst = await xmlPart(part); root(sst, SHEET, 'sst');
        for (const item of sst.children) {
          if (item.uri !== SHEET || item.local !== 'si') { omitted.add('omitted shared-string structure: ' + part + item.path); continue; }
          limit('shared-strings', strings.length + 1, office.maxSharedStrings); const text = stringValue(item, part); sharedBytes += Buffer.byteLength(text);
          limit('shared-string-bytes', sharedBytes, limits.maxDocumentTextBytes); strings.push(text);
        }
      }
      const worksheets = one(workbook, SHEET, 'sheets')!.children, sheetIds = new Set<string>(), names = new Set<string>(), sheetParts = new Set<string>(), tableParts = new Set<string>();
      limit('worksheets', worksheets.length, office.maxWorksheets);
      for (const [index, item] of worksheets.entries()) {
        if (item.uri !== SHEET || item.local !== 'sheet') throw Error('DOCUMENT_SHEET_INVALID: sheet list');
        const sheetName = attr(item, 'name'), id = attr(item, 'sheetId');
        if (!sheetName || sheetName.length > 256 || !id || !/^[1-9][0-9]*$/.test(id) || sheetIds.has(id) || names.has(canonicalUnpackPath(sheetName))) throw Error('DOCUMENT_SHEET_INVALID: identity');
        sheetIds.add(id); names.add(canonicalUnpackPath(sheetName));
        const part = target(mainPart, relation(workbookRelations, attr(item, 'id', OFFICE.slice(0, -1)), 'worksheet'), /^xl\/worksheets\/sheet[1-9][0-9]*\.xml$/);
        if (sheetParts.has(part)) throw Error('DOCUMENT_SHEET_INVALID: duplicate part'); sheetParts.add(part); contentType(part, 'spreadsheetml.worksheet');
        const worksheet = await xmlPart(part); root(worksheet, SHEET, 'worksheet'); const data = one(worksheet, SHEET, 'sheetData')!;
        let priorRow = 0;
        for (const row of data.children) {
          const rowNumber = Number(attr(row, 'r'));
          if (row.uri !== SHEET || row.local !== 'row' || !Number.isInteger(rowNumber) || rowNumber <= priorRow || rowNumber > 1048576) throw Error('DOCUMENT_CELL_INVALID: row identity'); priorRow = rowNumber;
          let priorColumn = 0;
          for (const cell of row.children) {
            if (cell.uri !== SHEET || cell.local !== 'c') { omitted.add('omitted row structure: ' + part + cell.path); continue; }
            const reference = attr(cell, 'r'), location = coordinate(reference ?? '');
            if (location.row !== rowNumber || location.column <= priorColumn) throw Error('DOCUMENT_CELL_INVALID: duplicate/order/row'); priorColumn = location.column;
            const value = one(cell, SHEET, 'v', false), inline = one(cell, SHEET, 'is', false), formula = one(cell, SHEET, 'f', false), type = attr(cell, 't') ?? 'n';
            if (value?.children.length || value && inline) throw Error('DOCUMENT_CELL_INVALID: cached value');
            let text = '', reason = '';
            if (formula) omitted.add('formula cache uncomputed: ' + part + '#' + reference);
            if (formula && (!value && !inline || type === 'n' && value?.text.trim() === '')) reason = 'DOCUMENT_FORMULA_CACHE_MISSING';
            else if (type === 'inlineStr') { if (value || !inline) throw Error('DOCUMENT_CELL_INVALID: inline string'); text = stringValue(inline, part); }
            else if (inline) throw Error('DOCUMENT_CELL_INVALID: inline type');
            else if (value) {
              const raw = value.text;
              if (type === 's') { if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) >= strings.length) throw Error('DOCUMENT_SHARED_STRING_INVALID: index'); text = strings[Number(raw)]!; }
              else if (type === 'b') { if (!['0', '1'].includes(raw)) throw Error('DOCUMENT_CELL_INVALID: boolean'); text = raw; }
              else if (type === 'n') { if (raw && (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?$/.test(raw) || !Number.isFinite(Number(raw)))) throw Error('DOCUMENT_CELL_INVALID: number'); text = raw; }
              else if (['str', 'e', 'd'].includes(type)) text = raw;
              else reason = 'DOCUMENT_CELL_TYPE_UNSUPPORTED';
            } else if (!['n', 'str', 'e', 'd', 'b'].includes(type)) reason = 'DOCUMENT_CELL_TYPE_UNSUPPORTED';
            emit({ kind: 'xlsx', sheet: index + 1, sheetName, part, cell: reference!, range: null, structurePath: cell.path }, text, reason);
          }
        }
        const tableList = one(worksheet, SHEET, 'tableParts', false), worksheetRelations = await relationships(posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels'), true);
        if (tableList) {
          if (attr(tableList, 'count') !== undefined && Number(attr(tableList, 'count')) !== tableList.children.length) throw Error('DOCUMENT_TABLE_INVALID: list count');
          const relationshipIds = new Set<string>();
          for (const entry of tableList.children) {
            if (entry.uri !== SHEET || entry.local !== 'tablePart') throw Error('DOCUMENT_TABLE_INVALID: entry');
            const id = attr(entry, 'id', OFFICE.slice(0, -1)); if (!id || relationshipIds.has(id)) throw Error('DOCUMENT_TABLE_INVALID: duplicate relationship'); relationshipIds.add(id);
            const tablePart = target(part, relation(worksheetRelations, id, 'table'), /^xl\/tables\/table[1-9][0-9]*\.xml$/);
            if (tableParts.has(tablePart)) throw Error('DOCUMENT_TABLE_INVALID: duplicate part'); tableParts.add(tablePart); limit('tables', tableParts.size, office.maxTables);
            contentType(tablePart, 'spreadsheetml.table'); const table = await xmlPart(tablePart); root(table, SHEET, 'table');
            const name = attr(table, 'displayName') ?? attr(table, 'name'), range = attr(table, 'ref'); if (!name || !range) throw Error('DOCUMENT_TABLE_INVALID: name/range');
            const columns = one(table, SHEET, 'tableColumns')!, bounds = tableRange(range, limits.maxDocumentUnits), columnIds = new Set<string>(), headings: string[] = [];
            for (const column of columns.children) {
              const id = attr(column, 'id'), heading = attr(column, 'name');
              if (column.uri !== SHEET || column.local !== 'tableColumn' || !id || columnIds.has(id) || heading === undefined) throw Error('DOCUMENT_TABLE_INVALID: column');
              columnIds.add(id); headings.push(heading);
              if (column.children.length) omitted.add('table calculated/extra column metadata: ' + tablePart + column.path);
            }
            if (headings.length !== bounds.columns || Number(attr(columns, 'count')) !== headings.length) throw Error('DOCUMENT_TABLE_INVALID: columns/range');
            emit({ kind: 'xlsx', sheet: index + 1, sheetName, part: tablePart, cell: null, range, structurePath: table.path }, name + '\t' + range + '\n' + headings.join('\t'));
          }
        }
      }
    }
    for (const part of files.keys()) if (!usedParts.has(part)) omitted.add('unread part: ' + part + '; CRC verified, XML/content interpretation omitted');
    result.coverage.totalUnits = totalUnits; result.coverage.completedUnits = completed; result.coverage.omitted = [...omitted];
    if (omitted.size) { result.status = 'partial'; result.reason ||= 'DOCUMENT_SCOPE_PARTIAL'; }
    await archive.assertCurrent();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/CATALOG_(?:FILE_CHANGED|FILE_INVALID|READ_LIMIT|SOURCE_CHANGED)|UNPACK_ARCHIVE_CHANGED|IMPORT_(?:SYMLINK|SOURCE_CHANGED|FILE_CHANGED|PATH_INVALID|PATH_ESCAPE)|ENOENT|ELOOP/.test(message)) throw Error('CATALOG_SOURCE_CHANGED');
    result.units = []; result.coverage.completedUnits = 0; result.coverage.totalUnits = null; result.coverage.omitted = [...omitted];
    result.status = /DOCUMENT_(?:CFB|OFFICE_NAMESPACE|OFFICE_CONTENT_TYPE|XML_ENCODING)_UNSUPPORTED/.test(message) ? 'unsupported' : 'failed'; result.reason = message;
  } finally {
    await archive?.close(); if (temporary) await rm(temporary, { recursive: true, force: true });
    if (verified) {
      try { const source = await readFixed(request.sourcePath, limits.maxDocumentSourceBytes, undefined, bytes => { readBytes += bytes; }, false);
        if (source.bytes !== request.sourceBytes || source.sha256 !== request.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED'); }
      catch { throw Error('CATALOG_SOURCE_CHANGED'); }
    }
    result.metrics.sourceReadBytes = readBytes; result.metrics.maxRSSKiB = process.resourceUsage().maxRSS;
  }
  return assertDocument<DocumentParseResult>('result', result);
}
