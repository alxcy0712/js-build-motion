import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { asrRuntimeIdentity, asrRuntimePaths } from '../../workspace.mjs';
import { ensureImportDirectory, importJsonText, NodeImportFiles, sameImportNode } from './import-files.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';
import { preflightAsrWav, decodeAsrAudio } from './asr-wav.ts';
import { parseAsrJson } from './asr-json.ts';
import { asrLimits, audioInputLimits, type Evidence, type Technical, type ToolRun } from '../project/catalog.ts';
import { validateAudioInputMap } from '../project/audio-input.ts';
import { asrArguments, canonicalWavHeader, validateAsrEngine, validateAsrMap, type AsrDescriptor, type AsrEngineIdentity, type AsrMap } from '../project/asr.ts';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const skipped = /^ASR_(?:FORMAT_UNSUPPORTED|SOURCE_LIMIT|RIFF_LIMIT|STRUCTURE_LIMIT|SAMPLES_LIMIT|AUDIO_LIMIT)(?:$|:)/;

/** Keep the base evidence and publish one complete ASR group; the canonical WAV is written once. */
export async function inspectAudioAsr(source: string, result: Technical, context: InspectContext): Promise<Technical> {
  if ((context.policy.version === '0.5' || (context.policy.version === '0.6' || context.policy.version === '0.7'))) return inspectCommonAudioAsr(source, result, context);
  const limits = asrLimits(context.policy), files = new NodeImportFiles(context.projectDir);
  let engine: AsrEngineIdentity | null = null, cwd: string | null = null, published = false;
  const created: string[] = [];
  function outcome(status: AsrDescriptor['status'], reason: string) {
    result.asr = { version: '0.1', status, reason, scope: 'input-audio-asr', engine, audioEvidenceId: null,
      jsonEvidenceId: null, textEvidenceId: null, mapEvidenceId: null, segments: 0 };
    if (status !== 'disabled') {
      if (result.status === 'supported') result.status = 'partial';
      result.reason = result.reason ? `${result.reason}; ${reason}` : reason;
    }
    return result;
  }
  if (context.policy.version !== '0.4' || !context.policy.asr.enabled) return outcome('disabled', 'ASR_DISABLED');
  context.signal.throwIfAborted(); context.check();
  let sourceNode: Awaited<ReturnType<NodeImportFiles['inspect']>>;
  try { files.projectPath(source); sourceNode = await files.inspect(source); }
  catch (error) { throw Error(`CATALOG_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  if (sourceNode.kind !== 'file' || sourceNode.nlink !== '1' || context.sourceBytes !== undefined && sourceNode.size !== context.sourceBytes) throw Error('CATALOG_SOURCE_CHANGED: ASR input node');
  if (sourceNode.size > limits.maxAsrSourceBytes) return outcome('skipped', 'ASR_SOURCE_LIMIT');
  async function sourceIdentity(retain: boolean) {
    try {
      const value = await readFixed(source, limits.maxAsrSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, retain);
      if (!sameImportNode(sourceNode, await files.inspect(source))) throw Error('input node');
      return value;
    } catch (error) { context.signal.throwIfAborted(); throw Error(`CATALOG_SOURCE_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const identity = await sourceIdentity(true);
  if (context.sourceBytes !== undefined && context.sourceBytes !== identity.bytes || context.sourceSha256 && context.sourceSha256 !== identity.sha256) throw Error('CATALOG_SOURCE_CHANGED: ASR input identity');
  async function runtimeIdentity(): Promise<AsrEngineIdentity> {
    try { return validateAsrEngine(asrRuntimeIdentity()); }
    catch (error) { context.signal.throwIfAborted(); throw Error(`CATALOG_ASR_RUNTIME_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function admit(bytes: number) {
    context.signal.throwIfAborted(); context.check();
    if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT');
    context.counts.derivedBytes += bytes;
  }
  try {
    try {
      if (result.format !== 'wav') return outcome('skipped', 'ASR_FORMAT_UNSUPPORTED');
      const wave = preflightAsrWav(identity.data, limits), stream = result.streams[0];
      if (result.streams.length !== 1 || stream.type !== 'audio' || stream.codec !== 'pcm_s16le' || stream.sampleRate !== wave.sampleRate || stream.channels !== wave.channels) return outcome('skipped', 'ASR_AUDIO_STREAMS_UNSUPPORTED');
      const pcm = result.evidence.find(e => e.kind === 'audio-pcm');
      if (!pcm || pcm.coverage !== 'full' || pcm.streamIndex !== stream.index || pcm.sampleRate !== wave.sampleRate || pcm.samples !== wave.frames || pcm.bytes !== wave.frames * 2) return outcome('skipped', 'ASR_PCM_UNAVAILABLE');
      if (pcm.path !== `${context.publishedDir}/${basename(pcm.path)}`) throw Error('CATALOG_ASR_PCM_CHANGED: evidence path');
      const pcmPath = files.projectPath(join(context.evidenceDir, basename(pcm.path))), pcmNode = await files.inspect(pcmPath);
      async function pcmIdentity() {
        try {
          const current = await readFixed(pcmPath, pcm.bytes, context.signal, undefined, false);
          if (!sameImportNode(pcmNode, await files.inspect(pcmPath)) || current.bytes !== pcm.bytes || current.sha256 !== pcm.sha256) throw Error('PCM identity');
        } catch (error) { context.signal.throwIfAborted(); throw Error(`CATALOG_ASR_PCM_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await pcmIdentity(); engine = await runtimeIdentity();
      const runtime = JSON.stringify(engine), policy = importJsonText(context.policy), paths = asrRuntimePaths();
      let audioPath: string | null = null, audioNode: Awaited<ReturnType<NodeImportFiles['inspect']>> | null = null, wav: Buffer | null = null;
      async function unchanged() {
        context.signal.throwIfAborted(); context.check();
        const after = await sourceIdentity(false);
        if (after.bytes !== identity.bytes || after.sha256 !== identity.sha256) throw Error('CATALOG_SOURCE_CHANGED: ASR input changed');
        await pcmIdentity();
        if (JSON.stringify(await runtimeIdentity()) !== runtime) throw Error('CATALOG_ASR_RUNTIME_CHANGED');
        if (importJsonText(context.policy) !== policy) throw Error('CATALOG_POLICY_CHANGED: ASR policy');
        if (audioPath && audioNode && wav) {
          try {
            const audio = await readFixed(audioPath, limits.maxAsrAudioBytes, context.signal, undefined, false);
            if (!sameImportNode(audioNode, await files.inspect(audioPath)) || audio.bytes !== wav.length || audio.sha256 !== digest(wav)) throw Error('canonical WAV identity');
          } catch (error) { context.signal.throwIfAborted(); throw Error(`CATALOG_ASR_AUDIO_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
        }
        context.check();
      }
      let payload: { map: AsrMap; mapData: Buffer; text: Buffer; raw: Buffer; ids: string[]; samples: number };
      try {
        const normalized = await decodeAsrAudio(pcmPath, wave, pcm, context, engine.tools.ffmpeg); wav = normalized.wav;
        if (wav.length !== 44 + normalized.samples * 2 || normalized.payloadBytes !== normalized.samples * 2 || !wav.subarray(0, 44).equals(canonicalWavHeader(normalized.samples))) throw Error('ASR_AUDIO_INVALID');
        const ids = Array.from({ length: 4 }, () => `evidence-${randomUUID()}`);
        await ensureImportDirectory(context.projectDir, context.evidenceDir);
        audioPath = files.projectPath(join(context.evidenceDir, `${ids[0]}.wav`));
        const audioHandle = await open(audioPath, 'wx', 0o600); created.push(audioPath);
        try { await audioHandle.writeFile(wav); await audioHandle.sync(); } finally { await audioHandle.close(); }
        audioNode = await files.inspect(audioPath);
        const privateCwd = files.projectPath(join(context.temporaryDir, `asr-${randomUUID()}`));
        await mkdir(privateCwd, { mode: 0o700 }); cwd = privateCwd; const cwdNode = await files.inspect(cwd);
        if ((await files.children(cwd)).length) throw Error('CATALOG_ASR_CWD_CHANGED');
        const chunks: Buffer[] = []; let callbackFault: unknown, invocation: ToolRun | undefined, run: ToolRun;
        try {
          run = await runInspectionTool({ executable: paths.program, version: `${engine.providerVersion}/asr-json@0.1`,
            argv: asrArguments(context.policy.asr.language, paths.model, audioPath), cwd,
            policy: { ...context.policy, maxToolElapsedMs: Math.min(120000, limits.maxAsrToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
            signal: context.signal, binaryLimit: Math.min(4194304, limits.maxAsrRawBytes),
            binary: async chunk => { try { admit(chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
            onRun: value => { invocation = value; context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
        } finally {
          if (invocation) {
            try { await context.recordAsrInvocation?.(invocation, cwd); }
            catch (error) { throw Error(`CATALOG_ASR_COMMAND_FAILED: ${error instanceof Error ? error.message : String(error)}`); }
          }
        }
        if (!sameImportNode(cwdNode, await files.inspect(cwd)) || (await files.children(cwd)).length) throw Error('CATALOG_ASR_CWD_CHANGED');
        if (callbackFault) throw callbackFault;
        context.signal.throwIfAborted(); context.check();
        if (run.error === 'CATALOG_BINARY_LIMIT') throw Error('ASR_RAW_LIMIT');
        if (run.error?.startsWith('CATALOG_TOOL_TERMINATION_FAILED:')) throw Error(run.error);
        if (run.error) throw Error(`ASR_TOOL_FAILED: ${run.error}`);
        const raw = Buffer.concat(chunks), parsed = parseAsrJson(raw, normalized.samples, context.policy.asr.language, limits, paths.model);
        const map: AsrMap = { version: '0.1', kind: 'asr-map', format: 'wav', mapperVersion: 'asr-json@0.1', status: parsed.status,
          scope: 'input-audio-asr', language: context.policy.asr.language, policySha256: context.policySha256 ?? digest(Buffer.from(policy)), engine,
          source: { bytes: identity.bytes, sha256: identity.sha256, wave },
          sourcePcm: { evidenceId: pcm.id, bytes: pcm.bytes, sha256: pcm.sha256, sampleRate: wave.sampleRate, samples: wave.frames },
          audio: { evidenceId: ids[0]!, bytes: wav.length, sha256: digest(wav), payloadBytes: normalized.payloadBytes, sampleRate: 16000, samples: normalized.samples },
          rawJson: { evidenceId: ids[1]!, bytes: raw.length, sha256: digest(raw) }, text: { evidenceId: ids[2]!, bytes: parsed.text.length, sha256: digest(parsed.text) },
          coverage: { scope: 'input-audio-asr', submittedStart: 0, submittedEnd: normalized.samples, complete: true }, segments: parsed.segments };
        validateAsrMap(map, parsed.text, wav, raw, limits);
        const mapData = Buffer.from(importJsonText(map)); if (mapData.length > limits.maxAsrMapBytes) throw Error('ASR_MAP_LIMIT');
        payload = { map, mapData, text: parsed.text, raw, ids, samples: normalized.samples };
      } finally { await unchanged(); }
      admit(payload.text.length + payload.mapData.length);
      const entries: Evidence[] = [];
      for (const [index, kind, suffix, data] of [[0, 'asr-audio', 'wav', wav!], [1, 'asr-json', 'json', payload.raw], [2, 'text', 'txt', payload.text], [3, 'asr-map', 'json', payload.mapData]] as const) {
        context.signal.throwIfAborted(); context.check();
        const id = payload.ids[index]!, name = `${id}.${suffix}`, path = files.projectPath(join(context.evidenceDir, name));
        if (index) { const handle = await open(path, 'wx', 0o600); created.push(path); try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); } }
        entries.push({ id, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: digest(data), width: null, height: null,
          sourceWidth: null, sourceHeight: null, transform: kind === 'asr-audio' ? 'complete original-rate mono PCM resampled to 16000 Hz; swr; dither none; async 0' : null,
          streamIndex: kind === 'asr-audio' ? pcm.streamIndex : null, timeBase: null, pts: null, requestedTime: null, actualTime: null,
          sampleRate: kind === 'asr-audio' ? 16000 : null, samples: kind === 'asr-audio' ? payload.samples : null, coverage: 'full' });
      }
      await unchanged(); result.evidence.push(...entries); published = true;
      result.text = { bytes: payload.text.length, lines: payload.text.toString('utf8').split('\n').length, bom: false, lineEndings: payload.text.includes(10) ? 'LF' : 'none' };
      result.asr = { version: '0.1', status: payload.map.status === 'text' ? 'completed' : 'no-text', reason: '', scope: 'input-audio-asr', engine,
        audioEvidenceId: payload.ids[0]!, jsonEvidenceId: payload.ids[1]!, textEvidenceId: payload.ids[2]!, mapEvidenceId: payload.ids[3]!, segments: payload.map.segments.length };
      result.limitations.push('ASR segment times are estimates in canonical 16000 Hz PCM; processing coverage requires separate recognition-quality and listening evidence.',
        'Provider, model and CPU parameters are fixed; whole-process hard RSS and cross-host byte reproducibility are unverified.');
      return result;
    } catch (error) {
      context.signal.throwIfAborted(); context.check(); const reason = error instanceof Error ? error.message : String(error);
      if (skipped.test(reason)) return outcome('skipped', reason);
      if (reason.startsWith('ASR_')) return outcome('failed', reason);
      throw error;
    }
  } finally {
    const cleanup = await Promise.allSettled([...(cwd ? [rm(cwd, { recursive: true, force: true })] : []), ...(!published ? created.map(path => rm(path, { force: true })) : [])]);
    for (const entry of cleanup) if (entry.status === 'rejected') throw entry.reason;
  }
}

/** ASR 0.2 consumes the already complete canonical audio instead of decoding another copy. */
async function inspectCommonAudioAsr(source: string, result: Technical, context: InspectContext): Promise<Technical> {
  if (context.policy.version !== '0.5' && (context.policy.version !== '0.6' && context.policy.version !== '0.7')) throw Error('CATALOG_AUDIO_POLICY_REQUIRED');
  const limits = asrLimits(context.policy), files = new NodeImportFiles(context.projectDir);
  let engine: AsrEngineIdentity | null = null, cwd: string | null = null, published = false;
  const created: string[] = [];
  const check = () => { context.signal.throwIfAborted(); context.check(); };
  function outcome(status: AsrDescriptor['status'], reason: string) {
    result.asr = { version: '0.2', status, reason, scope: 'input-audio-asr', engine, audioEvidenceId: null,
      jsonEvidenceId: null, textEvidenceId: null, mapEvidenceId: null, segments: 0 };
    if (status !== 'disabled') { if (result.status === 'supported') result.status = 'partial'; result.reason = result.reason ? `${result.reason}; ${reason}` : reason; }
    return result;
  }
  if (!context.policy.asr.enabled) return outcome('disabled', 'ASR_DISABLED');
  if (result.audioInput?.status !== 'completed') return outcome('skipped', 'ASR_AUDIO_INPUT_UNAVAILABLE');
  check(); const descriptor = result.audioInput, items = result.evidence;
  const group = [descriptor.probeEvidenceId, descriptor.pcmEvidenceId, descriptor.audioEvidenceId, descriptor.mapEvidenceId].map(id => items.find(item => item.id === id));
  if (group.some(item => !item) || group[0]!.kind !== 'probe' || group[1]!.kind !== 'audio-pcm' || group[2]!.kind !== 'audio-canonical' || group[3]!.kind !== 'audio-input-map') throw Error('CATALOG_ASR_AUDIO_INPUT_CHANGED');
  const [probe, pcm, audio, mapFile] = group as Evidence[];
  if (context.sourceBytes !== undefined && context.sourceBytes > limits.maxAsrSourceBytes) return outcome('skipped', 'ASR_SOURCE_LIMIT');
  if (audio!.samples! < limits.minAsrSamples || audio!.samples! > limits.maxAsrSamples) return outcome('skipped', 'ASR_SAMPLES_LIMIT');
  if (audio!.bytes > limits.maxAsrAudioBytes) return outcome('skipped', 'ASR_AUDIO_LIMIT');
  async function readEvidence(entry: Evidence, maximum: number) {
    if (entry.path !== `${context.publishedDir}/${basename(entry.path)}`) throw Error('CATALOG_ASR_AUDIO_INPUT_CHANGED: path');
    const path = files.projectPath(join(context.evidenceDir, basename(entry.path))), node = await files.inspect(path);
    const value = await readFixed(path, maximum, context.signal, bytes => { context.counts.sourceReadBytes += bytes; });
    if (value.bytes !== entry.bytes || value.sha256 !== entry.sha256 || !sameImportNode(node, await files.inspect(path))) throw Error('CATALOG_ASR_AUDIO_INPUT_CHANGED: identity');
    return { ...value, path, node };
  }
  const inputLimits = audioInputLimits(context.policy), sourceNode = await files.inspect(source);
  const policySha256 = context.policySha256 ?? digest(Buffer.from(importJsonText(context.policy)));
  const original = await readFixed(source, inputLimits.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
  if (original.bytes > limits.maxAsrSourceBytes) return outcome('skipped', 'ASR_SOURCE_LIMIT');
  if (context.sourceBytes !== undefined && original.bytes !== context.sourceBytes || context.sourceSha256 && original.sha256 !== context.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED: ASR common source');
  const probeData = await readEvidence(probe!, context.policy.maxToolOutputBytes), pcmData = await readEvidence(pcm!, inputLimits.maxPcmBytes),
    audioData = await readEvidence(audio!, inputLimits.maxAudioBytes), mapData = await readEvidence(mapFile!, inputLimits.maxMapBytes);
  const inputMap = validateAudioInputMap(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(mapData.data)), probeData.data, pcmData.data, audioData.data, inputLimits);
  if (inputMap.source.bytes !== original.bytes || inputMap.source.sha256 !== original.sha256 || inputMap.probe.evidenceId !== probe!.id ||
      inputMap.sourcePcm.evidenceId !== pcm!.id || inputMap.audio.evidenceId !== audio!.id || inputMap.policySha256 !== policySha256) throw Error('CATALOG_ASR_AUDIO_INPUT_CHANGED: map binding');
  const policy = importJsonText(context.policy);
  function currentRuntime() {
    try { return validateAsrEngine(asrRuntimeIdentity()); }
    catch (error) { check(); throw Error(`CATALOG_ASR_RUNTIME_CHANGED: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function admit(bytes: number) { check(); if (context.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT'); context.counts.derivedBytes += bytes; }
  async function unchanged() {
    check(); const after = await readFixed(source, inputLimits.maxSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
    if (after.bytes !== original.bytes || after.sha256 !== original.sha256 || !sameImportNode(sourceNode, await files.inspect(source))) throw Error('CATALOG_SOURCE_CHANGED: ASR common source changed');
    for (const current of [probeData, pcmData, audioData, mapData]) {
      const actual = await readFixed(current.path, current.bytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, false);
      if (actual.sha256 !== current.sha256 || actual.bytes !== current.bytes || !sameImportNode(current.node, await files.inspect(current.path))) throw Error('CATALOG_ASR_AUDIO_INPUT_CHANGED');
    }
    if (engine && importJsonText(currentRuntime()) !== importJsonText(engine)) throw Error('CATALOG_ASR_RUNTIME_CHANGED');
    if (importJsonText(context.policy) !== policy) throw Error('CATALOG_POLICY_CHANGED: ASR policy'); check();
  }
  try {
    try {
      engine = currentRuntime();
      if (engine.lockSha256 !== inputMap.runtime.lockSha256 || importJsonText(engine.tools) !== importJsonText(inputMap.runtime.tools)) throw Error('CATALOG_ASR_RUNTIME_CHANGED: common audio tools');
      const paths = asrRuntimePaths(); cwd = files.projectPath(join(context.temporaryDir, `asr-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
      const cwdNode = await files.inspect(cwd), chunks: Buffer[] = []; let callbackFault: unknown, invocation: ToolRun | undefined, run: ToolRun;
      try {
        run = await runInspectionTool({ executable: paths.program, version: `${engine.providerVersion}/asr-json@0.1`,
          argv: asrArguments(context.policy.asr.language, paths.model, audioData.path), cwd,
          policy: { ...context.policy, maxToolElapsedMs: Math.min(120000, limits.maxAsrToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
          signal: context.signal, binaryLimit: Math.min(4194304, limits.maxAsrRawBytes),
          binary: async chunk => { try { admit(chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
          onRun: value => { invocation = value; context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
      } finally {
        if (invocation) await context.recordAsrInvocation?.(invocation, cwd); await unchanged();
      }
      if (!sameImportNode(cwdNode, await files.inspect(cwd)) || (await files.children(cwd)).length) throw Error('CATALOG_ASR_CWD_CHANGED');
      if (callbackFault) throw callbackFault;
      if (run.error === 'CATALOG_BINARY_LIMIT') throw Error('ASR_RAW_LIMIT');
      if (run.error?.startsWith('CATALOG_TOOL_TERMINATION_FAILED:')) throw Error(run.error);
      if (run.error) throw Error(`ASR_TOOL_FAILED: ${run.error}`);
      const raw = Buffer.concat(chunks), parsed = parseAsrJson(raw, inputMap.audio.samples, context.policy.asr.language, limits, paths.model);
      const ids = Array.from({ length: 3 }, () => `evidence-${randomUUID()}`);
      const map: AsrMap = { version: '0.2', kind: 'asr-map', format: inputMap.input.format, mapperVersion: 'asr-json@0.1', status: parsed.status,
        scope: 'input-audio-asr', language: context.policy.asr.language, policySha256: context.policySha256 ?? digest(Buffer.from(policy)), engine,
        source: { bytes: original.bytes, sha256: original.sha256, audioInputMapEvidenceId: mapFile!.id, audioInputMapSha256: mapFile!.sha256, input: inputMap.input },
        sourcePcm: inputMap.sourcePcm, audio: inputMap.audio, rawJson: { evidenceId: ids[0]!, bytes: raw.length, sha256: digest(raw) },
        text: { evidenceId: ids[1]!, bytes: parsed.text.length, sha256: digest(parsed.text) },
        coverage: { scope: 'input-audio-asr', submittedStart: 0, submittedEnd: inputMap.audio.samples, complete: true }, segments: parsed.segments };
      validateAsrMap(map, parsed.text, audioData.data, raw, limits);
      const encoded = Buffer.from(importJsonText(map)); if (encoded.length > limits.maxAsrMapBytes) throw Error('ASR_MAP_LIMIT'); admit(parsed.text.length + encoded.length);
      const entries: Evidence[] = [];
      for (const [index, kind, suffix, data] of [[0, 'asr-json', 'json', raw], [1, 'text', 'txt', parsed.text], [2, 'asr-map', 'json', encoded]] as const) {
        check(); const name = `${ids[index]}.${suffix}`, path = files.projectPath(join(context.evidenceDir, name)), handle = await open(path, 'wx', 0o600); created.push(path);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        entries.push({ id: ids[index]!, kind, path: `${context.publishedDir}/${name}`, bytes: data.length, sha256: digest(data), width: null, height: null,
          sourceWidth: null, sourceHeight: null, transform: null, streamIndex: null, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: null, samples: null, coverage: 'full' });
      }
      await unchanged(); result.evidence.push(...entries); published = true;
      result.text = { bytes: parsed.text.length, lines: parsed.text.toString('utf8').split('\n').length, bom: false, lineEndings: parsed.text.includes(10) ? 'LF' : 'none' };
      result.asr = { version: '0.2', status: parsed.status === 'text' ? 'completed' : 'no-text', reason: '', scope: 'input-audio-asr', engine,
        audioEvidenceId: audio!.id, jsonEvidenceId: ids[0]!, textEvidenceId: ids[1]!, mapEvidenceId: ids[2]!, segments: parsed.segments.length };
      result.limitations.push('ASR segment times estimate canonical 16000 Hz complete-decoded-frame coordinates; presentation mapping and listening remain unverified.');
      return result;
    } catch (error) {
      check(); const reason = error instanceof Error ? error.message : String(error);
      if (skipped.test(reason)) return outcome('skipped', reason);
      if (reason.startsWith('ASR_')) return outcome('failed', reason);
      throw error;
    }
  } finally {
    const cleanup = await Promise.allSettled([...(cwd ? [rm(cwd, { recursive: true, force: true })] : []), ...(!published ? created.map(path => rm(path, { force: true })) : [])]);
    for (const item of cleanup) if (item.status === 'rejected') throw item.reason;
  }
}
