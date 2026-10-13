import { createHash } from 'node:crypto';
import { ALIGNMENT_MAPPER_VERSION, type AlignmentLimits, type AlignmentMap, type AlignmentToken, type AlignmentUnit, type ParsedAlignment } from '../project/alignment.ts';

interface TextUnit { kind: AlignmentUnit['kind']; byteStart: number; byteEnd: number; text: string; normalized: string | null }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function units(data: Buffer): TextUnit[] {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw Error('ALIGNMENT_TEXT_INVALID: UTF-8'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/.test(text)) throw Error('ALIGNMENT_TEXT_INVALID: control/BOM');
  const result: TextUnit[] = []; let charEnd = 0, byteEnd = 0;
  function append(piece: string, kind: TextUnit['kind']) {
    if (!piece) return;
    const start = byteEnd; byteEnd += Buffer.byteLength(piece);
    result.push({ kind, byteStart: start, byteEnd, text: piece,
      normalized: kind === 'nonlexical' ? null : kind === 'word' ? piece.toLowerCase().replaceAll('\u2019', "'") : piece });
  }
  for (const match of text.matchAll(/[A-Za-z0-9]+(?:['\u2019][A-Za-z0-9]+)*|\p{Script=Han}/gu)) {
    append(text.slice(charEnd, match.index), 'nonlexical');
    append(match[0], /^[A-Za-z0-9]/.test(match[0]) ? 'word' : 'character'); charEnd = match.index + match[0].length;
  }
  append(text.slice(charEnd), 'nonlexical'); return result;
}
function validateParsed(parsed: ParsedAlignment, samples: number, limits: AlignmentLimits) {
  if (!Buffer.isBuffer(parsed.text) || parsed.text.length > limits.maxRecognizedBytes || !Array.isArray(parsed.tokens) ||
      !Number.isSafeInteger(parsed.rawTokens) || parsed.rawTokens < parsed.tokens.length || parsed.rawTokens > limits.maxTokens) throw Error('ALIGNMENT_PARSED_INVALID');
  let end = 0, ordinal = -1, segmentIndex = -1, tokenIndex = -1, sampleStart = 0, sampleEnd = 0;
  for (const t of parsed.tokens) {
    if (!Number.isSafeInteger(t.ordinal) || t.ordinal <= ordinal || t.ordinal >= parsed.rawTokens || t.id !== `alignment-token-${t.ordinal}` ||
        !Number.isSafeInteger(t.segmentIndex) || t.segmentIndex < 0 || t.segmentIndex < segmentIndex || !Number.isSafeInteger(t.tokenIndex) || t.tokenIndex < 0 ||
        t.segmentIndex === segmentIndex && t.tokenIndex <= tokenIndex || !Number.isSafeInteger(t.providerId) || t.providerId < 0 || t.providerId >= 50257 ||
        t.byteStart !== end || !Number.isSafeInteger(t.byteEnd) || t.byteEnd < t.byteStart || t.byteEnd > parsed.text.length ||
        t.byteEnd - t.byteStart > limits.maxTokenTextBytes || typeof t.reason !== 'string' ||
        (t.sampleStart === null) !== (t.sampleEnd === null) || t.sampleStart !== null && (!Number.isSafeInteger(t.sampleStart) ||
          !Number.isSafeInteger(t.sampleEnd) || t.sampleStart < sampleStart || t.sampleStart >= t.sampleEnd! || t.sampleEnd! < sampleEnd || t.sampleEnd! > samples)) throw Error('ALIGNMENT_PARSED_INVALID');
    try { new TextDecoder('utf-8', { fatal: true }).decode(parsed.text.subarray(t.byteStart, t.byteEnd)); }
    catch { throw Error('ALIGNMENT_PARSED_INVALID: token UTF-8 boundary'); }
    end = t.byteEnd; ordinal = t.ordinal; segmentIndex = t.segmentIndex; tokenIndex = t.tokenIndex;
    if (t.sampleStart !== null) { sampleStart = t.sampleStart; sampleEnd = t.sampleEnd!; }
  }
  if (end !== parsed.text.length) throw Error('ALIGNMENT_PARSED_INVALID: token coverage');
}
function uniqueMatches(a: TextUnit[], b: TextUnit[], limits: AlignmentLimits): (number | null)[] {
  const n = a.length, m = b.length, width = m + 1, cells = (n + 1) * width;
  if (!Number.isSafeInteger(cells) || cells > limits.maxMatrixCells || n >= 65536 || m >= 65536) throw Error('ALIGNMENT_MATRIX_LIMIT');
  const prefix = new Uint16Array(cells), suffix = new Uint16Array(cells);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) prefix[(i + 1) * width + j + 1] = a[i]!.normalized === b[j]!.normalized ?
    prefix[i * width + j]! + 1 : Math.max(prefix[i * width + j + 1]!, prefix[(i + 1) * width + j]!);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) suffix[i * width + j] = a[i]!.normalized === b[j]!.normalized ?
    suffix[(i + 1) * width + j + 1]! + 1 : Math.max(suffix[(i + 1) * width + j]!, suffix[i * width + j + 1]!);
  const length = prefix[cells - 1]!;
  return a.map((unit, i) => {
    let candidate: number | null = null, candidates = 0, skipped = false;
    for (let j = 0; j <= m; j++) {
      if (prefix[i * width + j]! + suffix[(i + 1) * width + j]! === length) skipped = true;
      if (j < m && unit.normalized === b[j]!.normalized && prefix[i * width + j]! + 1 + suffix[(i + 1) * width + j + 1]! === length) { candidate = j; candidates++; }
    }
    return !skipped && candidates === 1 ? candidate : null;
  });
}

/** Only matches common to every optimal monotone exact-match path receive token estimates. */
export function alignScript(script: Buffer, parsed: ParsedAlignment, samples: number, limits: AlignmentLimits): AlignmentMap {
  if (script.length > limits.maxScriptBytes) throw Error('ALIGNMENT_SCRIPT_LIMIT');
  if (!Number.isSafeInteger(samples) || samples < limits.minSamples || samples > limits.maxSamples) throw Error('ALIGNMENT_SAMPLES_LIMIT');
  validateParsed(parsed, samples, limits);
  const scriptUnits = units(script), scriptLexical = scriptUnits.filter(unit => unit.normalized !== null), recognized = units(parsed.text).filter(unit => unit.normalized !== null);
  if (scriptLexical.length > limits.maxScriptUnits) throw Error('ALIGNMENT_SCRIPT_UNITS_LIMIT');
  if (recognized.length > limits.maxRecognizedUnits) throw Error('ALIGNMENT_RECOGNIZED_UNITS_LIMIT');
  const matches = uniqueMatches(scriptLexical, recognized, limits), tokenUses = new Map<string, number>();
  let cursor = 0;
  const tokenRanges = recognized.map(unit => {
    while (cursor < parsed.tokens.length && parsed.tokens[cursor]!.byteEnd <= unit.byteStart) cursor++;
    const tokens: AlignmentToken[] = [];
    for (let i = cursor; i < parsed.tokens.length && parsed.tokens[i]!.byteStart < unit.byteEnd; i++) {
      const token = parsed.tokens[i]!; if (token.byteStart === token.byteEnd) continue;
      tokens.push(token); tokenUses.set(token.id, (tokenUses.get(token.id) ?? 0) + 1);
    }
    return tokens;
  });
  let lexicalIndex = 0, estimatedUnits = 0, shared = false;
  const mapped = scriptUnits.map((unit, ordinal): AlignmentUnit => {
    const result: AlignmentUnit = { ...unit, id: `alignment-unit-${ordinal}`, ordinal, recognizedByteStart: null, recognizedByteEnd: null,
      tokenIds: [], sampleStart: null, sampleEnd: null, basis: 'unknown', confidence: null, reason: 'NON_LEXICAL' };
    if (unit.normalized === null) return result;
    const match = matches[lexicalIndex++]!;
    if (match === null) return { ...result, reason: 'NO_UNIQUE_MATCH' };
    const tokens = tokenRanges[match]!, recognizedUnit = recognized[match]!;
    result.recognizedByteStart = recognizedUnit.byteStart; result.recognizedByteEnd = recognizedUnit.byteEnd; result.tokenIds = tokens.map(token => token.id);
    const unknown = tokens.find(token => token.sampleStart === null || token.sampleEnd === null);
    if (!tokens.length || unknown) return { ...result, reason: unknown?.reason || 'MISSING_TOKEN_TIME' };
    const sampleStart = Math.min(...tokens.map(token => token.sampleStart!)), sampleEnd = Math.max(...tokens.map(token => token.sampleEnd!));
    const sharedRange = tokens.some(token => tokenUses.get(token.id)! > 1); shared ||= sharedRange; estimatedUnits++;
    return { ...result, sampleStart, sampleEnd, basis: 'estimated', reason: sharedRange ? 'TOKEN_ESTIMATE_SHARED_RANGE' : 'TOKEN_ESTIMATE' };
  });
  const unknownUnits = scriptLexical.length - estimatedUnits;
  const map: AlignmentMap = { version: '0.1', kind: 'alignment-map', mapperVersion: ALIGNMENT_MAPPER_VERSION,
    status: !estimatedUnits ? 'unknown' : unknownUnits ? 'partial' : 'estimated', sampleRate: 16000, samples,
    scriptTextSha256: digest(script), recognizedSha256: digest(parsed.text), units: mapped,
    coverage: { submittedSampleStart: 0, submittedSampleEnd: samples, scriptBytes: script.length, scriptComplete: true,
      lexicalUnits: scriptLexical.length, estimatedUnits, unknownUnits, listening: 'unverified' },
    limitations: ['Lexical alignment covers ASCII words with internal apostrophes and Han scalar characters; other original text remains explicitly nonlexical.',
      'Token times are experimental estimates from recognition and PCM energy; exact text matching does not establish pronunciation or listening accuracy.',
      'Timing intervals use canonical 16000 Hz PCM; a word spanning tokens retains their bounding interval, including possible internal gaps.',
      ...(shared ? ['Multiple lexical units share a provider token interval; individual word or character boundaries remain unresolved.'] : [])] };
  if (Buffer.byteLength(JSON.stringify(map, null, 2) + '\n') > limits.maxMapBytes) throw Error('ALIGNMENT_MAP_LIMIT');
  return map;
}
