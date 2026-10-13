import type { AsrLanguage, AsrLimits, AsrSegment } from '../project/asr.ts';

const invalid = (reason: string): never => { throw new Error(`ASR_JSON_INVALID: ${reason}`); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid('object keys');
  return value as Record<string, any>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f\ufeff]/.test(value)) invalid('string or control/BOM');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('surrogate'); }
    else if (code >= 0xdc00 && code <= 0xdfff) invalid('surrogate');
  }
  return value;
}
function timestamp(ms: number): string {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Fixed v1.9.5 -oj output; every original segment is validated before whitespace filtering. */
export function parseAsrJson(raw: Buffer, samples: number, language: AsrLanguage, limits: AsrLimits, modelPath: string): { status: 'text' | 'no-text'; text: Buffer; segments: AsrSegment[] } {
  if (!Number.isSafeInteger(samples) || samples < 0 || !['zh', 'en'].includes(language) || !string(modelPath)) invalid('input identity');
  if (samples < limits.minAsrSamples || samples > limits.maxAsrSamples || 44 + samples * 2 > limits.maxAsrAudioBytes) throw Error('ASR_SAMPLES_LIMIT');
  if (raw.length > limits.maxAsrRawBytes) throw Error('ASR_RAW_LIMIT');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)); }
  catch { invalid('UTF-8 or JSON'); }
  const root = object(value, ['systeminfo', 'model', 'params', 'result', 'transcription']);
  if (!string(root.systeminfo)) invalid('systeminfo');
  const model = object(root.model, ['type', 'multilingual', 'vocab', 'audio', 'text', 'mels', 'ftype']);
  const audio = object(model.audio, ['ctx', 'state', 'head', 'layer']), text = object(model.text, ['ctx', 'state', 'head', 'layer']);
  if (model.type !== 'base' || model.multilingual !== true || model.vocab !== 51865 || model.mels !== 80 || model.ftype !== 1 ||
      audio.ctx !== 1500 || audio.state !== 512 || audio.head !== 8 || audio.layer !== 6 || text.ctx !== 448 || text.state !== 512 || text.head !== 8 || text.layer !== 6) invalid('base model');
  const params = object(root.params, ['model', 'language', 'translate']), result = object(root.result, ['language']);
  if (params.model !== modelPath || params.language !== language || params.translate !== false || result.language !== language) invalid('params or language');
  if (!Array.isArray(root.transcription)) invalid('transcription');
  if (root.transcription.length > limits.maxAsrRawSegments) throw Error('ASR_RAW_SEGMENTS_LIMIT');
  const segments: AsrSegment[] = [], pieces: Buffer[] = []; let bytes = 0, previousRawEnd = 0;
  for (const [rawIndex, value] of root.transcription.entries()) {
    const entry = object(value, ['timestamps', 'offsets', 'text']);
    const times = object(entry.timestamps, ['from', 'to']), offsets = object(entry.offsets, ['from', 'to']);
    const from = offsets.from, to = offsets.to;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || from % 10 || to % 10 ||
        from < previousRawEnd || !Number.isSafeInteger(to * 16) || times.from !== timestamp(from) || times.to !== timestamp(to)) invalid('segment time or order');
    const sampleStart = from * 16, rawSampleEnd = to * 16, clippedEndSamples = Math.max(0, rawSampleEnd - samples);
    if (sampleStart >= samples || clippedEndSamples > 160 || clippedEndSamples && rawIndex !== root.transcription.length - 1) invalid('segment range');
    const sampleEnd = rawSampleEnd - clippedEndSamples;
    if (sampleStart >= sampleEnd) invalid('empty sample range');
    previousRawEnd = to;
    const token = string(entry.text), data = Buffer.from(token);
    if (data.length > limits.maxAsrSegmentTextBytes) throw Error('ASR_SEGMENT_TEXT_LIMIT');
    if (/^ *$/.test(token)) continue;
    if (segments.length >= limits.maxAsrSegments) throw Error('ASR_SEGMENTS_LIMIT');
    const separator = segments.length ? Buffer.from('\n') : Buffer.alloc(0);
    if (bytes + separator.length + data.length > limits.maxAsrTextBytes) throw Error('ASR_TEXT_LIMIT');
    pieces.push(separator, data); bytes += separator.length;
    const ordinal = segments.length;
    segments.push({ id: `asr-segment-${ordinal}`, ordinal, rawIndex, rawStartMs: from, rawEndMs: to, sampleStart, sampleEnd,
      clippedEndSamples, byteStart: bytes, byteEnd: bytes + data.length });
    bytes += data.length;
  }
  return { status: segments.length ? 'text' : 'no-text', text: Buffer.concat(pieces, bytes), segments };
}
