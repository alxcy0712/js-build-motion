import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { audioInputRuntimeIdentity } from '../../workspace.mjs';
import { audioInputLimits, type Evidence, type MediaStream, type Technical } from '../project/catalog.ts';
import { AUDIO_INPUT_MAPPER_VERSION, validateAudioInputMap, validateAudioInputRuntime, type AudioInputFacts, type AudioInputRuntimeIdentity } from '../project/audio-input.ts';
import { NodeImportFiles, importJsonText, sameImportNode } from './import-files.ts';
import { readFixed, type InspectContext } from './inspection.ts';
import { preflightAudioInput, decodeAudioInput } from './audio-input.ts';
import { inspectAudioAsr } from './inspection-asr.ts';

const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export const AUDIO_INPUT_PCM_TRANSFORM = 'complete decoded frames; mono signed 16-bit little-endian PCM; original sample rate; presentation mapping unknown';
export const AUDIO_INPUT_CANONICAL_TRANSFORM = 'complete decoded-frame mono PCM resampled to 16000 Hz; swr; dither none; async 0; presentation mapping unknown';
const finite = (value: unknown): number | null => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = (value: unknown): number | null => { const n = finite(value); return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null; };
const integerString = (value: unknown): string | null => typeof value === 'string' && /^-?\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const rational = (value: unknown): string | null => typeof value === 'string' && /^-?\d+\/[1-9]\d*$/.test(value) ? value : null;

/** Normalized probe facts remain separate from complete decoded sample coverage. */
export function audioInputProbeMetadata(probe: Buffer, input: AudioInputFacts): { streams: MediaStream[]; containerDuration: number | null } {
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(probe)), s = raw.streams?.[0];
  if (!Array.isArray(raw.streams) || raw.streams.length !== 1 || !s || !Number.isSafeInteger(s.index) || s.index < 0 ||
      s.codec_type !== 'audio' || s.codec_name !== input.codec || positive(s.sample_rate) !== input.sampleRate || s.channels !== input.channels) throw Error('AUDIO_INPUT_PROBE_INVALID');
  return { containerDuration: finite(raw.format?.duration), streams: [{ index: s.index, type: 'audio', codec: input.codec,
    width: null, height: null, pixelFormat: null, sampleRate: input.sampleRate, channels: input.channels,
    timeBase: rational(s.time_base), startPts: integerString(s.start_pts), durationTs: integerString(s.duration_ts),
    startTime: finite(s.start_time), duration: finite(s.duration), avgFrameRate: s.avg_frame_rate ?? null,
    rFrameRate: s.r_frame_rate ?? null, rotation: null, raw: JSON.stringify(s) }] };
}

/** One bounded source produces one atomic four-file audio group before optional ASR. */
export async function inspectAudioInput(source: string, format: 'wav' | 'mp3' | 'flac' | 'mov', context: InspectContext): Promise<Technical> {
  if (context.policy.version !== '0.5' && (context.policy.version !== '0.6' && context.policy.version !== '0.7')) throw Error('CATALOG_AUDIO_POLICY_REQUIRED');
  const limits = audioInputLimits(context.policy), files = new NodeImportFiles(context.projectDir);
  let runtime: AudioInputRuntimeIdentity | null = null, cwd: string | null = null, published = false;
  const created: string[] = [];
  const result: Technical = { status: 'supported', format: format === 'mov' ? 'm4a' : format, method: AUDIO_INPUT_MAPPER_VERSION,
    reason: '', raw: null, streams: [], evidence: [], text: null, containerDuration: null, limitations: [
      'Sample coverage uses complete decoded frames; MP3 gapless and M4A edit metadata are retained while presentation mapping remains unknown.',
      'Technical decoding, speech recognition, semantic observation, rights and listening require their own evidence.'
    ], asr: { version: '0.2', status: context.policy.asr.enabled ? 'skipped' : 'disabled',
      reason: context.policy.asr.enabled ? 'ASR_AUDIO_INPUT_UNAVAILABLE' : 'ASR_DISABLED', scope: 'input-audio-asr', engine: null,
      audioEvidenceId: null, jsonEvidenceId: null, textEvidenceId: null, mapEvidenceId: null, segments: 0 } };
  function outcome(status: 'skipped' | 'failed', reason: string) {
    result.status = status === 'skipped' ? 'partial' : 'failed'; result.reason = reason;
    result.audioInput = { version: '0.1', status, reason, scope: 'bounded-input-audio', runtime,
      probeEvidenceId: null, pcmEvidenceId: null, audioEvidenceId: null, mapEvidenceId: null }; return result;
  }
  function check() { context.signal.throwIfAborted(); context.check(); }
  function admit(bytes: number) { check(); if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT'); context.counts.derivedBytes += bytes; }
  function currentRuntime() {
    try { return validateAudioInputRuntime(audioInputRuntimeIdentity()); }
    catch (error) { check(); throw Error(`CATALOG_AUDIO_RUNTIME_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  check(); await files.ensureDirectory(context.evidenceDir); const sourceNode = await files.inspect(source);
  if (sourceNode.kind !== 'file' || sourceNode.nlink !== '1' || context.sourceBytes !== undefined && context.sourceBytes !== sourceNode.size) throw Error('CATALOG_SOURCE_CHANGED: audio input node');
  if (sourceNode.size > limits.maxSourceBytes) return outcome('skipped', 'AUDIO_INPUT_SOURCE_LIMIT');
  const identity = await readFixed(source, limits.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; });
  if (!sameImportNode(sourceNode, await files.inspect(source)) || context.sourceBytes !== undefined && identity.bytes !== context.sourceBytes || context.sourceSha256 && identity.sha256 !== context.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED: audio input identity');
  const frozenPolicy = importJsonText(context.policy);
  async function unchanged() {
    check(); const after = await readFixed(source, limits.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
    if (after.bytes !== identity.bytes || after.sha256 !== identity.sha256 || !sameImportNode(sourceNode, await files.inspect(source))) throw Error('CATALOG_SOURCE_CHANGED: audio decode input');
    if (runtime && importJsonText(currentRuntime()) !== importJsonText(runtime)) throw Error('CATALOG_AUDIO_RUNTIME_CHANGED');
    if (importJsonText(context.policy) !== frozenPolicy) throw Error('CATALOG_POLICY_CHANGED: audio decode'); check();
  }
  try {
    try {
      const input = preflightAudioInput(identity.data, limits);
      if (input.demuxer !== format) throw Error('AUDIO_INPUT_FORMAT_UNSUPPORTED: signature/demuxer disagreement');
      runtime = currentRuntime();
      cwd = files.projectPath(join(context.temporaryDir, `audio-input-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
      const cwdNode = await files.inspect(cwd), decoded = await decodeAudioInput(source, input, { ...context, temporaryDir: cwd }, runtime), afterCwd = await files.inspect(cwd);
      if (afterCwd.kind !== 'directory' || afterCwd.dev !== cwdNode.dev || afterCwd.ino !== cwdNode.ino || afterCwd.nlink !== cwdNode.nlink || (await files.children(cwd)).length) throw Error('CATALOG_AUDIO_CWD_CHANGED');
      await unchanged(); const metadata = audioInputProbeMetadata(decoded.probe, input), ids = Array.from({ length: 4 }, () => `evidence-${randomUUID()}`);
      const evidenceIdentity = (index: number, data: Buffer) => ({ evidenceId: ids[index]!, bytes: data.length, sha256: hash(data) });
      const map = { version: '0.1' as const, kind: 'audio-input-map' as const, mapperVersion: AUDIO_INPUT_MAPPER_VERSION,
        policySha256: context.policySha256 ?? hash(Buffer.from(frozenPolicy)), source: { bytes: identity.bytes, sha256: identity.sha256 }, input, runtime,
        probe: evidenceIdentity(0, decoded.probe), sourcePcm: { ...evidenceIdentity(1, decoded.pcm), sampleRate: input.sampleRate, samples: input.samples },
        audio: { ...evidenceIdentity(2, decoded.wav), payloadBytes: decoded.payloadBytes, sampleRate: 16000 as const, samples: decoded.samples },
        commands: decoded.commands, cwd, coverage: { scope: 'complete-decoded-frames' as const, complete: true as const, start: 0 as const, end: input.samples, presentationMapping: 'unknown' as const } };
      validateAudioInputMap(map, decoded.probe, decoded.pcm, decoded.wav, limits);
      const mapData = Buffer.from(importJsonText(map)); if (mapData.length > limits.maxMapBytes) throw Error('AUDIO_INPUT_MAP_LIMIT');
      admit(decoded.probe.length + mapData.length); await files.ensureDirectory(context.evidenceDir);
      for (const [index, kind, suffix, data] of [[0, 'probe', 'json', decoded.probe], [1, 'audio-pcm', 's16le', decoded.pcm], [2, 'audio-canonical', 'wav', decoded.wav], [3, 'audio-input-map', 'json', mapData]] as const) {
        check(); const name = `${ids[index]}.${suffix}`, path = files.projectPath(join(context.evidenceDir, name)), handle = await open(path, 'wx', 0o600); created.push(path);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        const audio = kind === 'audio-pcm' || kind === 'audio-canonical';
        result.evidence.push({ id: ids[index]!, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: hash(data),
          width: null, height: null, sourceWidth: null, sourceHeight: null, transform: kind === 'audio-pcm' ? AUDIO_INPUT_PCM_TRANSFORM : kind === 'audio-canonical' ? AUDIO_INPUT_CANONICAL_TRANSFORM : null,
          streamIndex: audio ? metadata.streams[0]!.index : null, timeBase: null, pts: null, requestedTime: null, actualTime: null,
          sampleRate: audio ? kind === 'audio-pcm' ? input.sampleRate : 16000 : null,
          samples: audio ? kind === 'audio-pcm' ? input.samples : decoded.samples : null, coverage: 'full' });
      }
      await unchanged(); result.raw = decoded.probe.toString('utf8'); Object.assign(result, metadata);
      result.audioInput = { version: '0.1', status: 'completed', reason: '', scope: 'bounded-input-audio', runtime,
        probeEvidenceId: ids[0]!, pcmEvidenceId: ids[1]!, audioEvidenceId: ids[2]!, mapEvidenceId: ids[3]! }; published = true;
    } catch (error) {
      check(); const reason = error instanceof Error ? error.message : String(error);
      if (!reason.startsWith('AUDIO_INPUT_')) throw error;
      result.evidence.length = 0;
      return outcome(/(?:UNSUPPORTED|LIMIT)(?::|$)/.test(reason) ? 'skipped' : 'failed', reason);
    }
    return await inspectAudioAsr(source, result, context);
  } finally {
    const cleanup = await Promise.allSettled([...(cwd ? [rm(cwd, { recursive: true, force: true })] : []), ...(!published ? created.map(path => rm(path, { force: true })) : [])]);
    for (const item of cleanup) if (item.status === 'rejected') throw item.reason;
  }
}
