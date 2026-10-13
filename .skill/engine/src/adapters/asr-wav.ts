import { asrLimits, type Evidence } from '../project/catalog.ts';
import { canonicalWavHeader, type AsrLimits, type AsrWaveFacts } from '../project/asr.ts';
import type { NativeToolIdentity } from '../project/ocr.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';
import { NodeImportFiles, sameImportNode } from './import-files.ts';

function sampleBounds(frames: number, rate: number, limits: AsrLimits) {
  if (frames * 16000 < limits.minAsrSamples * rate || frames * 16000 > limits.maxAsrSamples * rate) throw new Error('ASR_SAMPLES_LIMIT: source duration');
}

/** Bounded RIFF traversal; sample frames are established independently of the probe. */
export function preflightAsrWav(data: Buffer, limits: AsrLimits): AsrWaveFacts {
  if (data.length > limits.maxAsrSourceBytes) throw new Error('ASR_SOURCE_LIMIT');
  if (data.length < 12) throw new Error('ASR_STRUCTURE_INVALID: RIFF header');
  if (data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') throw new Error('ASR_FORMAT_UNSUPPORTED: RIFF WAVE required');
  if (data.readUInt32LE(4) + 8 !== data.length) throw new Error('ASR_STRUCTURE_INVALID: RIFF extent');
  let position = 12, chunks = 0, format: { sampleRate: number; channels: 1 | 2 } | undefined, audio: { dataOffset: number; dataBytes: number } | undefined;
  while (position < data.length) {
    if (position + 8 > data.length) throw new Error('ASR_STRUCTURE_INVALID: chunk header');
    if (++chunks > limits.maxAsrRiffChunks) throw new Error('ASR_STRUCTURE_LIMIT');
    const id = data.toString('latin1', position, position + 4), size = data.readUInt32LE(position + 4), start = position + 8, end = start + size;
    if (end + size % 2 > data.length) throw new Error('ASR_STRUCTURE_INVALID: chunk extent/padding');
    if (id === 'fmt ') {
      if (format) throw new Error('ASR_STRUCTURE_INVALID: duplicate fmt');
      if (size !== 16) throw new Error('ASR_FORMAT_UNSUPPORTED: fmt size');
      const tag = data.readUInt16LE(start), channels = data.readUInt16LE(start + 2), sampleRate = data.readUInt32LE(start + 4), byteRate = data.readUInt32LE(start + 8), blockAlign = data.readUInt16LE(start + 12), bits = data.readUInt16LE(start + 14);
      if (tag !== 1 || bits !== 16 || channels !== 1 && channels !== 2 || sampleRate < 8000 || sampleRate > 48000) throw new Error('ASR_FORMAT_UNSUPPORTED: PCM16 mono/stereo 8k-48k required');
      if (blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign) throw new Error('ASR_STRUCTURE_INVALID: PCM byte rate/alignment');
      format = { sampleRate, channels };
    } else if (id === 'data') {
      if (audio) throw new Error('ASR_STRUCTURE_INVALID: duplicate data');
      audio = { dataOffset: start, dataBytes: size };
    } else if (id === 'wavl' || id === 'slnt' || id === 'LIST' && size >= 4 && data.toString('latin1', start, start + 4) === 'wavl') {
      throw new Error('ASR_FORMAT_UNSUPPORTED: segmented wave');
    } else if (id === 'LIST' && size < 4) throw new Error('ASR_STRUCTURE_INVALID: LIST type');
    position = end + size % 2;
  }
  if (!format || !audio || audio.dataBytes % (format.channels * 2)) throw new Error('ASR_STRUCTURE_INVALID: fmt/data/alignment');
  const frames = audio.dataBytes / (format.channels * 2); sampleBounds(frames, format.sampleRate, limits);
  return { format: 'wav', ...format, bitsPerSample: 16, frames, ...audio };
}

/** Resample the complete fixed original-rate mono evidence; the caller writes one WAV. */
export async function decodeAsrAudio(sourcePcm: string, wave: AsrWaveFacts, pcm: Evidence, context: InspectContext, tool: NativeToolIdentity): Promise<{ wav: Buffer; samples: number; payloadBytes: number }> {
  const limits = asrLimits(context.policy), { counts, policy, signal } = context, files = new NodeImportFiles(context.projectDir);
  if (wave.format !== 'wav' || wave.bitsPerSample !== 16 || ![1, 2].includes(wave.channels) || !Number.isSafeInteger(wave.sampleRate) || wave.sampleRate < 8000 || wave.sampleRate > 48000 || !Number.isSafeInteger(wave.frames) || wave.frames < 0 || wave.dataBytes !== wave.frames * wave.channels * 2) throw new Error('ASR_AUDIO_INVALID: source wave facts');
  sampleBounds(wave.frames, wave.sampleRate, limits);
  if (pcm.kind !== 'audio-pcm' || pcm.coverage !== 'full' || pcm.sampleRate !== wave.sampleRate || pcm.samples !== wave.frames || pcm.bytes !== wave.frames * 2) throw new Error('ASR_AUDIO_INVALID: complete original-rate mono PCM required');
  const sampleCapacity = limits.maxAsrSamples * 2, audioCapacity = Math.max(0, limits.maxAsrAudioBytes - 44), binaryLimit = Math.min(sampleCapacity, audioCapacity);
  if (binaryLimit < limits.minAsrSamples * 2) throw new Error('ASR_AUDIO_LIMIT');
  const check = () => { signal.throwIfAborted(); context.check(); };
  async function identity() {
    try {
      const node = await files.inspect(sourcePcm);
      const actual = await readFixed(sourcePcm, pcm.bytes, signal, bytes => { counts.sourceReadBytes += bytes; }, false);
      if (actual.bytes !== pcm.bytes || actual.sha256 !== pcm.sha256 || !sameImportNode(node, await files.inspect(sourcePcm))) throw new Error('CATALOG_SOURCE_CHANGED: original PCM');
      return node;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error), code = (error as NodeJS.ErrnoException)?.code;
      if (/^(?:CATALOG_(?:FILE_|READ_LIMIT)|IMPORT_(?:SYMLINK|PATH_INVALID))/.test(message) || ['ENOENT', 'ELOOP'].includes(code ?? '')) throw new Error(`CATALOG_SOURCE_CHANGED: original PCM: ${message}`, { cause: error });
      throw error;
    }
  }
  check(); const before = await identity(); check();
  if (counts.derivedBytes + 44 > policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT');
  counts.derivedBytes += 44;
  const parts: Buffer[] = []; let payloadBytes = 0, callbackFailed = false, callbackError: unknown;
  const run = await runInspectionTool({ executable: tool.executable, version: `${tool.version}/asr-audio@0.1`,
    argv: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000',
      '-protocol_whitelist', 'file', '-format_whitelist', 's16le', '-f', 's16le', '-ar', String(wave.sampleRate), '-ac', '1', '-c:a', 'pcm_s16le', '-max_streams', '1', '-threads', '1', '-i', sourcePcm,
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '1', '-af', 'aresample=16000:resampler=swr:dither_method=none:async=0', '-ar', '16000', '-ac', '1', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
    cwd: context.temporaryDir, policy: { ...policy, maxToolElapsedMs: Math.min(30000, policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, policy.maxToolOutputBytes) }, signal, binaryLimit,
    binary: async chunk => {
      try {
        check();
        if (counts.derivedBytes + chunk.length > policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT');
        if (counts.decodedAudioBytes + chunk.length > policy.maxDecodedAudioBytes) throw new Error('CATALOG_DECODED_AUDIO_LIMIT');
        counts.derivedBytes += chunk.length; counts.decodedAudioBytes += chunk.length; parts.push(Buffer.from(chunk)); payloadBytes += chunk.length;
      } catch (error) { callbackFailed = true; callbackError = error; throw error; }
    }, onRun: value => { context.tools.push(value); counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
  signal.throwIfAborted(); if (callbackFailed) throw callbackError;
  check(); const after = await identity(); check();
  if (!sameImportNode(before, after)) throw new Error('CATALOG_SOURCE_CHANGED: original PCM node');
  if (run.error?.startsWith('CATALOG_') && !/^CATALOG_(?:TOOL_(?:ERROR|EXIT|TIME_LIMIT|OUTPUT_LIMIT)|BINARY_LIMIT)(?::|$)/.test(run.error)) throw new Error(run.error);
  if (run.error === 'CATALOG_BINARY_LIMIT') throw new Error(sampleCapacity <= audioCapacity ? 'ASR_SAMPLES_LIMIT: decoded output' : 'ASR_AUDIO_LIMIT: decoded output');
  if (run.error) throw new Error(`ASR_AUDIO_TOOL_FAILED: ${run.error}`);
  if (payloadBytes % 2) throw new Error('ASR_AUDIO_INVALID: PCM alignment');
  const samples = payloadBytes / 2;
  if (samples < limits.minAsrSamples || samples > limits.maxAsrSamples) throw new Error('ASR_SAMPLES_LIMIT: decoded output');
  if (Math.abs(samples * wave.sampleRate - wave.frames * 16000) > wave.sampleRate) throw new Error('ASR_AUDIO_INVALID: resampled sample count');
  return { wav: Buffer.concat([canonicalWavHeader(samples), ...parts], 44 + payloadBytes), samples, payloadBytes };
}
