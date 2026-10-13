import { DEFAULT_ASR_LIMITS, type AsrLanguage } from '../project/asr.ts';
import type { AlignmentLimits, AlignmentToken, ParsedAlignment } from '../project/alignment.ts';
import { parseAsrJson } from './asr-json.ts';

const invalid = (reason: string): never => { throw Error(`ALIGNMENT_JSON_INVALID: ${reason}`); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('object keys');
  return value as Record<string, any>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f\ufeff]/.test(value)) invalid('text or control/BOM');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('surrogate'); }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid('surrogate');
  }
  return value;
}
function timestamp(ms: number): string {
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Replay the fixed full JSON while retaining the original ordinary-token byte order. */
export function parseAlignmentJson(raw: Buffer, samples: number, language: AsrLanguage, limits: AlignmentLimits, modelPath: string): ParsedAlignment {
  if (raw.length > limits.maxRawBytes) throw Error('ALIGNMENT_RAW_LIMIT');
  if (!Number.isSafeInteger(samples) || samples < limits.minSamples || samples > limits.maxSamples) throw Error('ALIGNMENT_SAMPLES_LIMIT');
  let root: any;
  try { root = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)); }
  catch { invalid('UTF-8 or JSON'); }
  if (!root || typeof root !== 'object' || Array.isArray(root) || !Array.isArray(root.transcription)) invalid('root or transcription');
  if (root.transcription.length > DEFAULT_ASR_LIMITS.maxAsrRawSegments) throw Error('ALIGNMENT_SEGMENTS_LIMIT');
  const tokens: AlignmentToken[] = [], pieces: Buffer[] = [], stripped: Record<string, any>[] = [];
  let rawTokens = 0, bytes = 0, previousStart = 0, previousEnd = 0;
  for (const [segmentIndex, value] of root.transcription.entries()) {
    const segment = object(value, ['timestamps', 'offsets', 'text', 'tokens']);
    if (!Array.isArray(segment.tokens)) invalid('tokens');
    const { tokens: sourceTokens, ...original } = segment; stripped.push(original);
    const segmentText = text(segment.text), segmentPieces: string[] = [];
    for (const [tokenIndex, value] of sourceTokens.entries()) {
      if (rawTokens >= limits.maxTokens) throw Error('ALIGNMENT_TOKENS_LIMIT');
      const ordinal = rawTokens++, timed = !!value && typeof value === 'object' && (Object.hasOwn(value, 'timestamps') || Object.hasOwn(value, 'offsets'));
      const token = object(value, ['text', 'id', 'p', 't_dtw', ...(timed ? ['timestamps', 'offsets'] : [])]);
      const tokenText = text(token.text), size = Buffer.byteLength(tokenText);
      if (size > limits.maxTokenTextBytes) throw Error('ALIGNMENT_TOKEN_TEXT_LIMIT');
      if (!Number.isSafeInteger(token.id) || token.id < 0 || token.id >= 51865 || !Number.isFinite(token.p) || token.p < 0 || token.p > 1 || token.t_dtw !== -1) invalid('token id/probability/dtw');
      let sampleStart: number | null = null, sampleEnd: number | null = null, reason = 'MISSING_TOKEN_TIME';
      if (timed) {
        const offsets = object(token.offsets, ['from', 'to']), stamps = object(token.timestamps, ['from', 'to']);
        const from = offsets.from, to = offsets.to;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < 0 || from % 10 || to % 10 ||
            !Number.isSafeInteger(from * 16) || !Number.isSafeInteger(to * 16) || stamps.from !== timestamp(from) || stamps.to !== timestamp(to)) invalid('token time encoding');
        const start = from * 16, end = to * 16, tail = end - samples;
        if (start === end) reason = 'ZERO_TOKEN_RANGE';
        else if (start > end || start >= samples || start < segment.offsets?.from * 16 || end > segment.offsets?.to * 16 ||
            tail > 0 && (tail > 160 || segmentIndex !== root.transcription.length - 1)) reason = 'INVALID_TOKEN_TIME';
        else if (start < previousStart || Math.min(end, samples) < previousEnd) reason = 'NON_MONOTONE_TOKEN_TIME';
        else { sampleStart = start; sampleEnd = Math.min(end, samples); reason = 'TOKEN_ESTIMATE'; }
      }
      if (token.id >= 50257) continue;
      if (sampleStart !== null && sampleEnd !== null) { previousStart = sampleStart; previousEnd = sampleEnd; }
      if (bytes + size > limits.maxRecognizedBytes) throw Error('ALIGNMENT_RECOGNIZED_LIMIT');
      segmentPieces.push(tokenText); pieces.push(Buffer.from(tokenText));
      tokens.push({ id: `alignment-token-${ordinal}`, ordinal, segmentIndex, tokenIndex, providerId: token.id,
        byteStart: bytes, byteEnd: bytes + size, sampleStart, sampleEnd, reason }); bytes += size;
    }
    if (segmentPieces.join('') !== segmentText) invalid('tokens do not reconstruct segment text');
  }
  try {
    parseAsrJson(Buffer.from(JSON.stringify({ ...root, transcription: stripped })), samples, language,
      { ...DEFAULT_ASR_LIMITS, minAsrSamples: limits.minSamples, maxAsrSamples: limits.maxSamples,
        maxAsrRawBytes: limits.maxRawBytes, maxAsrTextBytes: limits.maxRecognizedBytes }, modelPath);
  } catch (error) { invalid(error instanceof Error ? error.message : String(error)); }
  return { text: Buffer.concat(pieces, bytes), tokens, rawTokens };
}
