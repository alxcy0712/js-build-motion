import { Canvas, DOMMatrix, Path2D, ImageData } from 'skia-canvas';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { readFixed } from './inspection.ts';
import { preflightOcrImage } from './ocr-raster.ts';
import { rasterLimit, rasterPayload } from './document-raster-source.ts';
import type { DocumentRasterRequest, DocumentRasterResult, PdfRasterLocator } from '../project/document-ocr.ts';

type Name = { name: string }; type Ref = { ref: number; generation: number }; type StringValue = { string: true };
type Value = number | boolean | null | Name | Ref | StringValue | Value[] | Map<string, Value>;
type Token = { kind: 'name' | 'number' | 'string' | 'word' | 'delimiter'; value: string; start: number };
type ObjectValue = { value: Value; stream: Buffer | null; decoded: Buffer | null };
const white = (c: number) => [0, 9, 10, 12, 13, 32].includes(c);
const isName = (v: Value | undefined): v is Name => !!v && typeof v === 'object' && 'name' in v;
const isRef = (v: Value | undefined): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const invalid = (reason: string): never => { throw Error('DOCUMENT_OCR_PDF_INVALID: ' + reason); };
const refused = (reason: string): never => { throw Error('DOCUMENT_OCR_PDF_UNSUPPORTED: ' + reason); };

/** Structural tokens exclude string contents and declared stream payloads. */
class Lexer {
  position: number; private queue: (Token | null)[] = [];
  readonly text: string; readonly end: number; readonly request: DocumentRasterRequest; readonly state: { tokens: number };
  constructor(text: string, start: number, end: number, request: DocumentRasterRequest, state: { tokens: number }) {
    this.text = text; this.position = start; this.end = end; this.request = request; this.state = state;
  }
  skip() {
    while (this.position < this.end) {
      if (white(this.text.charCodeAt(this.position))) this.position++;
      else if (this.text[this.position] === '%') { while (this.position < this.end && ![10, 13].includes(this.text.charCodeAt(this.position))) this.position++; }
      else break;
    }
  }
  private read(): Token | null {
    this.skip(); if (this.position === this.end) return null;
    rasterLimit('PDF_STRUCTURE_TOKENS', ++this.state.tokens, this.request.limits.maxPdfStructureTokens);
    const start = this.position, c = this.text[this.position++]!;
    if (c === '/') {
      let value = '';
      while (this.position < this.end && !white(this.text.charCodeAt(this.position)) && !'()<>[]{}/%'.includes(this.text[this.position]!)) {
        const character = this.text[this.position++]!;
        if (character === '#') {
          const hex = this.text.slice(this.position, this.position + 2); if (!/^[a-f0-9]{2}$/i.test(hex)) invalid('name escape');
          value += String.fromCharCode(parseInt(hex, 16)); this.position += 2;
        } else value += character;
      }
      if (!value || /[\x00-\x1f\x7f]/.test(value)) invalid('name'); return { kind: 'name', value, start };
    }
    if (c === '(') {
      let depth = 1;
      while (depth && this.position < this.end) {
        const character = this.text[this.position++]!;
        if (character === '\\') { if (this.position === this.end) invalid('string escape'); const next = this.text[this.position++]!; if (next === '\r' && this.text[this.position] === '\n') this.position++; }
        else if (character === '(') { depth++; rasterLimit('PDF_STRUCTURE_DEPTH', depth, this.request.limits.maxPdfStructureDepth); }
        else if (character === ')') depth--;
      }
      if (depth) invalid('unterminated string'); return { kind: 'string', value: '', start };
    }
    if (c === '<' && this.text[this.position] !== '<') {
      while (this.position < this.end && this.text[this.position] !== '>') {
        if (!white(this.text.charCodeAt(this.position)) && !/[a-f0-9]/i.test(this.text[this.position]!)) invalid('hex string'); this.position++;
      }
      if (this.position === this.end) invalid('unterminated hex string'); this.position++; return { kind: 'string', value: '', start };
    }
    if ('<>'.includes(c)) { if (this.text[this.position++] !== c) invalid('dictionary delimiter'); return { kind: 'delimiter', value: c + c, start }; }
    if ('[]'.includes(c)) return { kind: 'delimiter', value: c, start };
    if ('){}'.includes(c)) invalid('unexpected delimiter');
    while (this.position < this.end && !white(this.text.charCodeAt(this.position)) && !'()<>[]{}/%'.includes(this.text[this.position]!)) this.position++;
    const value = this.text.slice(start, this.position);
    return { kind: /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'word', value, start };
  }
  peek(index = 0): Token | null { while (this.queue.length <= index) this.queue.push(this.read()); return this.queue[index]!; }
  take(): Token { const token = this.queue.length ? this.queue.shift()! : this.read(); if (!token) invalid('unexpected end'); return token; }
  word(value: string) { const token = this.take(); if (token.value !== value || token.kind !== (value === ']' || value === '>>' ? 'delimiter' : 'word')) invalid('expected ' + value); }
  value(depth = 1): Value {
    rasterLimit('PDF_STRUCTURE_DEPTH', depth, this.request.limits.maxPdfStructureDepth);
    const token = this.take();
    if (token.kind === 'name') return { name: token.value };
    if (token.kind === 'string') return { string: true };
    if (token.kind === 'number') {
      const n = Number(token.value); if (!Number.isFinite(n)) invalid('nonfinite number');
      const second = this.peek();
      if (/^\d+$/.test(token.value) && second?.kind === 'number' && /^\d+$/.test(second.value) && this.peek(1)?.value === 'R') {
        const generation = Number(this.take().value); this.word('R');
        if (!Number.isSafeInteger(n) || !Number.isSafeInteger(generation) || n < 1 || generation > 65535) invalid('reference');
        return { ref: n, generation };
      }
      return n;
    }
    if (token.value === 'null') return null;
    if (token.value === 'true' || token.value === 'false') return token.value === 'true';
    if (token.value === '[') { const values: Value[] = []; while (this.peek()?.value !== ']') values.push(this.value(depth + 1)); this.word(']'); return values; }
    if (token.value === '<<') {
      const values = new Map<string, Value>();
      while (this.peek()?.value !== '>>') { const key = this.take(); if (key.kind !== 'name' || values.has(key.value)) invalid('dictionary key'); values.set(key.value, this.value(depth + 1)); }
      this.word('>>'); return values;
    }
    return invalid('value ' + token.value);
  }
  jump(position: number) { if (this.queue.length || position < this.position || position > this.end) invalid('stream extent'); this.position = position; }
  finish() { if (this.peek() !== null) invalid('unconsumed object extent'); }
}

function classicPdf(data: Buffer, request: DocumentRasterRequest, result: DocumentRasterResult) {
  const text = data.toString('latin1'), state = { tokens: 0 }, header = /^%PDF-1\.[0-7](?:\r\n|\r|\n)/.exec(text);
  if (!header) refused('PDF1.0-1.7 header required');
  const footer = /(?:\r\n|\r|\n)startxref[\x00\t\n\f\r ]+(\d+)[\x00\t\n\f\r ]+%%EOF[\x00\t\n\f\r ]*$/.exec(text);
  if (!footer) invalid('exact startxref/EOF required');
  const xref = Number(footer[1]); if (!Number.isSafeInteger(xref) || xref < header[0].length || xref >= footer.index) invalid('xref offset');
  const lexer = new Lexer(text, xref, text.length, request, state); lexer.word('xref');
  const entries = new Map<number, { offset: number; generation: number; used: boolean }>();
  while (lexer.peek()?.value !== 'trailer') {
    const startToken = lexer.take(), countToken = lexer.take();
    if (!/^\d+$/.test(startToken.value) || !/^\d+$/.test(countToken.value)) invalid('xref section');
    const start = Number(startToken.value), count = Number(countToken.value);
    rasterLimit('PDF_OBJECTS', start + count - 1, request.limits.maxPdfObjects); if (!count) invalid('empty xref section');
    for (let n = start; n < start + count; n++) {
      const offset = lexer.take(), generation = lexer.take(), kind = lexer.take();
      if (!/^\d{10}$/.test(offset.value) || !/^\d{5}$/.test(generation.value) || !['n', 'f'].includes(kind.value) || entries.has(n)) invalid('xref entry');
      const value = { offset: Number(offset.value), generation: Number(generation.value), used: kind.value === 'n' };
      if (value.generation > 65535 || value.used && (!n || value.offset < header[0].length || value.offset >= xref)) invalid('xref entry bounds'); entries.set(n, value);
    }
  }
  lexer.word('trailer'); const trailer = lexer.value(); if (!(trailer instanceof Map)) invalid('trailer dictionary');
  for (const key of trailer.keys()) if (!['Size', 'Root', 'Info', 'ID'].includes(key)) refused('trailer ' + key);
  const size = trailer.get('Size'), zero = entries.get(0);
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size !== entries.size || !zero || zero.used || zero.offset !== 0 || zero.generation !== 65535 ||
      [...entries.keys()].some(n => n >= size)) invalid('xref size/free object');
  lexer.word('startxref'); if (Number(lexer.take().value) !== xref) invalid('startxref value'); lexer.finish();
  const used = [...entries].filter(([, e]) => e.used).sort((a, b) => a[1].offset - b[1].offset);
  rasterLimit('PDF_OBJECTS', used.length, request.limits.maxPdfObjects);
  const prefix = new Lexer(text, header[0].length, used[0]?.[1].offset ?? xref, request, state); prefix.finish();
  const objects = new Map<number, ObjectValue>(), active = new Set<number>();
  const spans = new Map(used.map(([n, e], i) => [n, { ...e, end: used[i + 1]?.[1].offset ?? xref }]));
  if (new Set(used.map(([, e]) => e.offset)).size !== used.length) invalid('overlapping object offsets');
  function object(n: number): ObjectValue {
    if (objects.has(n)) return objects.get(n)!;
    const span = spans.get(n); if (!span || active.has(n)) invalid('missing/cyclic length object'); active.add(n);
    const reader = new Lexer(text, span.offset, span.end, request, state), id = reader.take(), generation = reader.take();
    if (id.start !== span.offset || !/^\d+$/.test(id.value) || Number(id.value) !== n || Number(generation.value) !== span.generation) invalid('object/index identity'); reader.word('obj');
    const value = reader.value(); let stream: Buffer | null = null;
    if (reader.peek()?.value === 'stream') {
      if (!(value instanceof Map)) invalid('stream dictionary'); reader.word('stream');
      let start = reader.position;
      if (text[start] === '\r') { start++; if (text[start] === '\n') start++; } else if (text[start] === '\n') start++; else invalid('stream EOL');
      const lengthValue = value.get('Length'); let length: Value | undefined = lengthValue;
      if (isRef(lengthValue)) { const target = entries.get(lengthValue.ref); if (!target?.used || target.generation !== lengthValue.generation) invalid('length reference'); length = object(lengthValue.ref).value; }
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || start + length > span.end) invalid('stream length');
      stream = data.subarray(start, start + length); reader.jump(start + length); reader.word('endstream');
    }
    reader.word('endobj'); reader.finish(); active.delete(n);
    const record = { value, stream, decoded: null }; objects.set(n, record); return record;
  }
  for (const [n] of used) object(n);
  const dereference = (value: Value | undefined): Value | undefined => {
    if (!isRef(value)) return value;
    const entry = entries.get(value.ref); if (!entry?.used || entry.generation !== value.generation) invalid('dangling reference'); return objects.get(value.ref)!.value;
  };
  const forbidden = new Set(['Encrypt', 'ObjStm', 'XRef', 'XRefStm', 'Prev', 'XFA', 'OpenAction', 'AA', 'JavaScript', 'JS', 'Launch', 'GoToR', 'GoToE', 'URI', 'SubmitForm', 'ImportData', 'RichMedia', 'Movie', 'Sound', 'EmbeddedFile', 'EmbeddedFiles', 'Filespec', 'EF', 'RF', 'JPXDecode', 'JBIG2Decode', 'Crypt']);
  const checkValue = (value: Value): void => {
    if (isRef(value)) { dereference(value); return; }
    if (isName(value)) { if (forbidden.has(value.name)) refused(value.name); return; }
    if (value instanceof Map) for (const [key, v] of value) { if (forbidden.has(key)) refused(key); checkValue(v); }
    else if (Array.isArray(value)) for (const v of value) checkValue(v);
  };
  checkValue(trailer); let imagePixels = 0;
  for (const record of objects.values()) {
    checkValue(record.value); if (record.stream === null) continue;
    const dictionary = record.value as Map<string, Value>;
    if (['F', 'FFilter', 'FDecodeParms'].some(key => dictionary.has(key))) refused('external file stream');
    const subtype = dereference(dictionary.get('Subtype')), image = isName(subtype) && subtype.name === 'Image';
    if (image) {
      const width = dereference(dictionary.get('Width')), height = dereference(dictionary.get('Height'));
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !record.stream.length) invalid('Image dimensions/nonempty stream');
      rasterLimit('PDF_IMAGE_EDGE', Math.max(width, height), request.limits.maxEdge);
      rasterLimit('PDF_IMAGE_PIXELS', width * height, request.limits.maxPixelsPerUnit);
      imagePixels += width * height; rasterLimit('PDF_IMAGE_TOTAL_PIXELS', imagePixels, request.limits.maxCanvasAllocationPixels);
    }
    const filterValue = dereference(dictionary.get('Filter')), filters = Array.isArray(filterValue) ? filterValue : filterValue === undefined ? [] : [filterValue];
    if (filters.length > 1 || filters.some(v => !isName(v) || !['FlateDecode', 'DCTDecode'].includes(v.name))) refused('stream filter');
    const filter = (filters[0] as Name | undefined)?.name;
    if (filter === 'DCTDecode') {
      if (!image) refused('DCT non-image stream');
      const header = preflightOcrImage(record.stream, 'jpeg_pipe', { ...request.ocrLimits, maxOcrEdge: Math.min(request.ocrLimits.maxOcrEdge, request.limits.maxEdge),
        maxOcrSourcePixels: Math.min(request.ocrLimits.maxOcrSourcePixels, request.limits.maxPixelsPerUnit) });
      if (header.width !== dereference(dictionary.get('Width')) || header.height !== dereference(dictionary.get('Height'))) invalid('DCT geometry');
    } else {
      const remaining = request.limits.maxPdfDecodedStreamBytes - result.metrics.decodedStreamBytes;
      if (filter === 'FlateDecode') {
        const inflated = inflateSync(record.stream, { maxOutputLength: remaining + 1, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== record.stream.length) invalid('Flate trailing bytes'); record.decoded = inflated.buffer;
      } else record.decoded = record.stream;
      result.metrics.decodedStreamBytes += record.decoded.length;
      rasterLimit('PDF_DECODED_STREAM_BYTES', result.metrics.decodedStreamBytes, request.limits.maxPdfDecodedStreamBytes);
    }
  }
  const dictionary = (value: Value | undefined): Map<string, Value> => { const resolved = dereference(value); if (!(resolved instanceof Map)) invalid('dictionary reference'); return resolved; };
  const catalog = dictionary(trailer.get('Root')); if (!isName(catalog.get('Type')) || (catalog.get('Type') as Name).name !== 'Catalog') invalid('Catalog');
  const leafs: { dictionary: Map<string, Value>; inherited: Map<string, Value> }[] = [], visited = new Set<number>(), contentStreams = new Set<ObjectValue>();
  function pages(reference: Value | undefined, parent: Ref | null, inherited: Map<string, Value>, depth: number): number {
    rasterLimit('PDF_STRUCTURE_DEPTH', depth, request.limits.maxPdfStructureDepth);
    if (!isRef(reference) || visited.has(reference.ref)) invalid('page tree reference/cycle'); visited.add(reference.ref);
    const page = dictionary(reference), declaredParent = page.get('Parent');
    if (parent ? !isRef(declaredParent) || declaredParent.ref !== parent.ref || declaredParent.generation !== parent.generation : declaredParent !== undefined) invalid('page Parent');
    const values = new Map(inherited); for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) if (page.has(key)) values.set(key, page.get(key)!);
    const type = page.get('Type'); if (!isName(type)) invalid('page Type');
    if (type.name === 'Pages') {
      const kids = dereference(page.get('Kids')); if (!Array.isArray(kids) || !kids.length) invalid('Pages Kids');
      let count = 0; for (const kid of kids) count += pages(kid, reference, values, depth + 1);
      if (dereference(page.get('Count')) !== count) invalid('Pages Count'); return count;
    }
    if (type.name !== 'Page') invalid('page tree Type'); leafs.push({ dictionary: page, inherited: values });
    const contents = page.get('Contents'), parts = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
    for (const part of parts) { if (!isRef(part) || !objects.get(part.ref)?.stream) invalid('page Contents stream'); contentStreams.add(objects.get(part.ref)!); }
    if (values.has('Resources')) dictionary(values.get('Resources'));
    return 1;
  }
  pages(catalog.get('Pages'), null, new Map(), 1);
  result.totalUnits = leafs.length;
  rasterLimit('PDF_DOCUMENT_PAGES', leafs.length, Math.min(request.limits.maxPdfDocumentPages, request.documentLimits.maxPdfPages));
  for (const [n, record] of objects) {
    if (!(record.value instanceof Map)) continue;
    const type = record.value.get('Type'), subtype = record.value.get('Subtype');
    if (isName(type) && ['Page', 'Pages'].includes(type.name) && !visited.has(n)) invalid('unreferenced page tree object');
    if (isName(subtype) && subtype.name === 'Form' && record.stream) contentStreams.add(record);
  }
  for (const content of contentStreams) {
    if (!content.decoded) refused('content stream filter');
    const reader = new Lexer(content.decoded.toString('latin1'), 0, content.decoded.length, request, state);
    while (reader.peek()) { const token = reader.take(); if (token.kind === 'word' && token.value === 'BI') refused('inline image'); }
  }
  if (request.unit > leafs.length) throw Error('DOCUMENT_OCR_UNIT_OUT_OF_RANGE');
  const selected = leafs[request.unit - 1]!;
  function box(value: Value | undefined): number[] {
    const resolved = dereference(value);
    if (!Array.isArray(resolved) || resolved.length !== 4 || resolved.some(v => typeof v !== 'number' || !Number.isFinite(v))) invalid('page box');
    const numbers = resolved as number[]; if (numbers[2]! <= numbers[0]! || numbers[3]! <= numbers[1]!) invalid('page box range'); return numbers;
  }
  const media = box(selected.inherited.get('MediaBox')), crop = selected.inherited.has('CropBox') ? box(selected.inherited.get('CropBox')) : media;
  const viewBox = [Math.max(media[0]!, crop[0]!), Math.max(media[1]!, crop[1]!), Math.min(media[2]!, crop[2]!), Math.min(media[3]!, crop[3]!)];
  if (viewBox[2]! <= viewBox[0]! || viewBox[3]! <= viewBox[1]!) invalid('CropBox/MediaBox intersection');
  const rotation = dereference(selected.inherited.get('Rotate')) ?? 0, userUnit = dereference(selected.dictionary.get('UserUnit')) ?? 1;
  if (![0, 90, 180, 270].includes(rotation as number) || typeof userUnit !== 'number' || !Number.isFinite(userUnit) || userUnit <= 0) invalid('page rotation/UserUnit');
  return { viewBox, rotation: rotation as PdfRasterLocator['rotation'], userUnit, pages: leafs.length };
}

/** Fixed PDF.js interpretation of one selected CropBox; source structure is independently closed. */
export async function rasterPdfUnit(request: DocumentRasterRequest, data: Buffer, result: DocumentRasterResult): Promise<void> {
  const expected = classicPdf(data, request, result), metrics = result.metrics;
  result.limitations.push('PDF1.0-1.7 classic xref, one revision, raw/Flate/DCT streams and Image XObjects form the finite source scope; inline images are refused.',
    'Pixels use PDF.js/Skia interpretation of the selected CropBox, intrinsic rotation and UserUnit. Annotations, forms, attachments and actions are omitted or refused.',
    'decodedStreamBytes measures raw/Flate payloads; DCT internal decoded bytes are unmeasured and bounded by independently checked image dimensions.',
    'PDF page pixels cover this selected unit; other pages and semantic OCR accuracy are outside its coverage.');
  let live = 0;
  type Entry = { canvas: Canvas; context: ReturnType<Canvas['getContext']> };
  class BoundedCanvasFactory {
    private pixels = new Map<Canvas, number>();
    private admit(width: number, height: number, prior = 0) {
      if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) invalid('canvas geometry');
      rasterLimit('CANVAS_EDGE', Math.max(width, height), request.limits.maxEdge);
      rasterLimit('CANVAS_LIVE_PIXELS', live - prior + width * height, request.limits.maxCanvasLivePixels);
      rasterLimit('CANVAS_ALLOCATION_PIXELS', metrics.canvasAllocationPixels + width * height, request.limits.maxCanvasAllocationPixels);
      live += width * height - prior; metrics.canvasLivePeakPixels = Math.max(metrics.canvasLivePeakPixels, live); metrics.canvasAllocationPixels += width * height;
    }
    create(width: number, height: number): Entry {
      width = Math.ceil(width); height = Math.ceil(height); this.admit(width, height);
      const canvas = new Canvas(width, height, { gpu: false }); this.pixels.set(canvas, width * height); return { canvas, context: canvas.getContext('2d') };
    }
    reset(entry: Entry, width: number, height: number) {
      width = Math.ceil(width); height = Math.ceil(height); const prior = this.pixels.get(entry.canvas); if (prior === undefined) invalid('unknown canvas');
      this.admit(width, height, prior); entry.canvas.width = width; entry.canvas.height = height; this.pixels.set(entry.canvas, width * height);
    }
    destroy(entry: Entry) { const pixels = this.pixels.get(entry.canvas); if (pixels === undefined) invalid('unknown canvas'); live -= pixels; this.pixels.delete(entry.canvas); entry.canvas.width = entry.canvas.height = 0; }
  }
  const engineRoot = dirname(fileURLToPath(new URL('../../workspace.mjs', import.meta.url)));
  class FixedBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      if (!['cMapUrl', 'standardFontDataUrl'].includes(kind) || typeof filename !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(filename) || ['.', '..'].includes(filename)) refused('external runtime resource');
      const path = `node_modules/pdfjs-dist/${kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts'}/${filename}`;
      const fixed = request.runtime.files.find(file => file.path === path); if (!fixed) throw Error('DOCUMENT_RASTER_RUNTIME_CHANGED: unlisted resource');
      rasterLimit('RUNTIME_RESOURCE_BYTES', metrics.resourceBytes + fixed.bytes, request.limits.maxRuntimeResourceBytes);
      const actual = await readFixed(join(engineRoot, path), fixed.bytes);
      if (actual.bytes !== fixed.bytes || actual.sha256 !== fixed.sha256) throw Error('DOCUMENT_RASTER_RUNTIME_CHANGED: resource'); metrics.resourceBytes += actual.bytes;
      return new Uint8Array(actual.data);
    }
  }
  const saved = Object.fromEntries(['log', 'info', 'warn', 'error'].map(key => [key, console[key as 'log']])), diagnostics: string[] = [];
  let bootstrap = true;
  for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = (...values: unknown[]) => {
    const message = values.map(String).join(' ');
    if (!(bootstrap && message.startsWith('Warning: Cannot load "@napi-rs/canvas" package:'))) diagnostics.push(message);
    saved[key]!(...values);
  };
  let task: import('pdfjs-dist/types/src/display/api.js').PDFDocumentLoadingTask | undefined;
  try {
    const globals = globalThis as unknown as { DOMMatrix: typeof DOMMatrix; Path2D: typeof Path2D; ImageData: typeof ImageData };
    globals.DOMMatrix = DOMMatrix; globals.Path2D = Path2D; globals.ImageData = ImageData;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); bootstrap = false;
    if (pdfjs.version !== '6.4.299') throw Error('DOCUMENT_RASTER_RUNTIME_CHANGED: PDF.js');
    task = pdfjs.getDocument({ data: new Uint8Array(data), CanvasFactory: BoundedCanvasFactory, BinaryDataFactory: FixedBinaryDataFactory,
      cMapUrl: join(engineRoot, 'node_modules/pdfjs-dist/cmaps') + '/', cMapPacked: true,
      standardFontDataUrl: join(engineRoot, 'node_modules/pdfjs-dist/standard_fonts') + '/', useWorkerFetch: false, useSystemFonts: false,
      useWasm: false, disableFontFace: true, enableXfa: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      stopAtErrors: true, maxImageSize: request.limits.maxPixelsPerUnit, canvasMaxAreaInBytes: request.limits.maxCanvasLivePixels * 4,
      verbosity: pdfjs.VerbosityLevel.WARNINGS });
    const document = await task.promise; if (document.numPages !== expected.pages) invalid('parser page count');
    const page = await document.getPage(request.unit), scale = request.dpi / 72, viewport = page.getViewport({ scale });
    if (JSON.stringify(page.view) !== JSON.stringify(expected.viewBox) || page.rotate !== expected.rotation || page.userUnit !== expected.userUnit) invalid('parser viewport');
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    rasterLimit('RASTER_EDGE', Math.max(width, height), request.limits.maxEdge); rasterLimit('RASTER_PIXELS', width * height, request.limits.maxPixelsPerUnit);
    const header = Buffer.from(`P6\n${width} ${height}\n255\n`); rasterLimit('RASTER_BYTES', header.length + width * height * 3, request.limits.maxRasterBytes);
    const factory = document.canvasFactory as BoundedCanvasFactory, entry = factory.create(width, height);
    try {
      await page.render({ canvas: entry.canvas, canvasContext: entry.context, viewport, background: 'rgb(255,255,255)', annotationMode: pdfjs.AnnotationMode.DISABLE, intent: 'display' }).promise;
      if (diagnostics.length) throw Error('DOCUMENT_OCR_PDF_RENDER_DIAGNOSTIC: ' + diagnostics.join('; '));
      const rgba = entry.context.getImageData(0, 0, width, height).data, rgb = Buffer.alloc(width * height * 3);
      for (let n = 0; n < width * height; n++) for (let c = 0; c < 3; c++) rgb[n * 3 + c] = Math.floor((rgba[n * 4 + c]! * rgba[n * 4 + 3]! + 255 * (255 - rgba[n * 4 + 3]!) + 127) / 255);
      result.locator = { kind: 'pdf-page', page: request.unit, viewBox: [...page.view], userUnit: page.userUnit, rotation: page.rotate as PdfRasterLocator['rotation'], dpi: request.dpi,
        scale, transform: [...viewport.transform], width, height }; result.payload = rasterPayload('ppm', Buffer.concat([header, rgb]));
    } finally { page.cleanup(); factory.destroy(entry); }
  } finally {
    try { await task?.destroy(); if (diagnostics.length) throw Error('DOCUMENT_OCR_PDF_RENDER_DIAGNOSTIC: ' + diagnostics.join('; ')); }
    finally { for (const key of ['log', 'info', 'warn', 'error'] as const) console[key] = saved[key]!; }
  }
}
