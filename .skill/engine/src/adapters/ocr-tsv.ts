import type { OcrLimits, OcrRegion } from '../project/ocr.ts';

const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const invalid = (reason: string): never => { throw new Error(`OCR_TSV_INVALID: ${reason}`); };
function integer(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('integer');
  return Number(value);
}

/** One complete native TSV; word ranges exclude the canonical separators. */
export function parseOcrTsv(tsv: Buffer, width: number, height: number, limits: OcrLimits): { text: Buffer; regions: OcrRegion[]; status: 'text' | 'no-text' } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) invalid('dimensions');
  if (tsv.length > limits.maxOcrTsvBytes) throw new Error('OCR_TSV_LIMIT');
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(tsv); }
  catch { invalid('UTF-8'); }
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(decoded!)) invalid('control character');
  const rows = decoded!.split('\n'); if (rows.at(-1) === '') rows.pop();
  if (rows.shift() !== HEADER) invalid('header');
  if (rows.length > limits.maxOcrRows) throw new Error('OCR_ROWS_LIMIT');
  const regions: OcrRegion[] = [], pieces: Buffer[] = [], identities = new Set<string>();
  let page = false, currentBlock = 0, currentParagraph = 0, currentLine = 0, bytes = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (Buffer.byteLength(row) > limits.maxOcrRowBytes) throw new Error('OCR_ROW_LIMIT');
    const columns = row.split('\t'); if (columns.length !== 12) invalid('columns');
    const [level, pageNumber, block, paragraph, line, word, x, y, boxWidth, boxHeight] = columns.slice(0, 10).map(integer);
    const confidenceText = columns[10]!, token = columns[11]!;
    if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(confidenceText)) invalid('confidence');
    const confidence = Number(confidenceText);
    if (!Number.isFinite(confidence) || confidence !== -1 && (confidence < 0 || confidence > 100)) invalid('confidence');
    if (level! < 1 || level! > 5 || pageNumber !== 1 || boxWidth! <= 0 || boxHeight! <= 0 ||
        x! + boxWidth! > width || y! + boxHeight! > height) invalid('geometry or level');
    const key = [level, pageNumber, block, paragraph, line, word].join('/');
    if (identities.has(key)) invalid('duplicate identity'); identities.add(key);
    if (level === 1) {
      if (page || index || block || paragraph || line || word || x || y || boxWidth !== width || boxHeight !== height) invalid('page');
      page = true;
    } else {
      if (!page || !block) invalid('parent');
      if (level === 2) {
        if (paragraph || line || word) invalid('block');
        currentBlock = block; currentParagraph = currentLine = 0;
      } else {
        if (block !== currentBlock || !paragraph) invalid('parent');
        if (level === 3) {
          if (line || word) invalid('paragraph'); currentParagraph = paragraph; currentLine = 0;
        } else {
          if (paragraph !== currentParagraph || !line) invalid('parent');
          if (level === 4) { if (word) invalid('line'); currentLine = line; }
          else if (line !== currentLine || !word) invalid('parent');
        }
      }
    }
    if (level !== 5) { if (token || confidence !== -1) invalid('structural text/confidence'); continue; }
    const data = Buffer.from(token);
    if (data.length > limits.maxOcrWordBytes) throw new Error('OCR_WORD_LIMIT');
    if (!data.length) continue;
    if (!regions.length && data.subarray(0, 3).equals(Buffer.from('efbbbf', 'hex'))) invalid('text BOM');
    if (regions.length >= limits.maxOcrRegions) throw new Error('OCR_REGIONS_LIMIT');
    const previous = regions.at(-1), separator = previous ? Buffer.from(previous.block === block && previous.paragraph === paragraph && previous.line === line ? ' ' : '\n') : Buffer.alloc(0);
    if (bytes + separator.length + data.length > limits.maxOcrTextBytes) throw new Error('OCR_TEXT_LIMIT');
    pieces.push(separator, data); bytes += separator.length;
    const ordinal = regions.length + 1;
    regions.push({ id: `ocr-word-${ordinal}`, ordinal, row: index + 1, level: 5, page: 1, block: block!, paragraph: paragraph!, line: line!, word: word!,
      x: x!, y: y!, width: boxWidth!, height: boxHeight!, engineConfidence: confidence === -1 ? null : confidence, byteStart: bytes, byteEnd: bytes + data.length });
    bytes += data.length;
  }
  if (!page) invalid('missing page');
  return { text: Buffer.concat(pieces, bytes), regions, status: regions.length ? 'text' : 'no-text' };
}
