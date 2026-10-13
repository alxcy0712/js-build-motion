import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { asrRuntimeIdentity, asrRuntimePaths } from '../../workspace.mjs';
import { NodeImportFiles, importJsonText, sameImportNode } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { readFixed, runInspectionTool } from '../adapters/inspection.ts';
import { preflightAsrWav } from '../adapters/asr-wav.ts';
import { preflightAudioInput } from '../adapters/audio-input.ts';
import { parseAlignmentJson } from '../adapters/alignment-json.ts';
import { alignScript } from '../adapters/alignment-map.ts';
import { canonicalWavHeader, DEFAULT_ASR_LIMITS, validateAsrEngine, type AsrEngineIdentity, type AsrLanguage } from '../project/asr.ts';
import { assertCatalog, DEFAULT_INSPECT_POLICY, type CatalogIndex } from '../project/catalog.ts';
import { DEFAULT_AUDIO_INPUT_LIMITS, validateAudioInputMap } from '../project/audio-input.ts';
import { verifyCatalog } from './catalog.ts';
import { ALIGNMENT_MAPPER_VERSION, DEFAULT_ALIGNMENT_POLICY, alignmentArguments, alignmentAttemptPattern, alignmentIdPattern,
  alignmentInputPath, assertAlignment, emptyAlignmentCounts, safeAlignmentPath, validateAlignmentScript,
  type AlignmentFileIdentity, type AlignmentIndex, type AlignmentManifest, type AlignmentPolicy, type AlignmentReceipt,
  type AlignmentSelection, type AudioAlignmentSource, type LegacyAlignmentSource } from '../project/alignment.ts';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const digest = (value: unknown) => hash(importJsonText(value));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const active = new Set<string>();
const outputNames = ['approval-source.txt', 'audio.wav', 'manifest.json', 'map.json', 'raw.json', 'recognized.txt', 'script.json'];
function alive(pid: number, attemptId: string): boolean {
  if (pid === process.pid) return active.has(attemptId);
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export class AlignmentFailure extends Error {
  receipt: AlignmentReceipt; receiptPath: string | null;
  constructor(receipt: AlignmentReceipt, receiptPath: string | null, cause: unknown) {
    super(receipt.error ?? 'ALIGNMENT_FAILED', { cause }); this.receipt = receipt; this.receiptPath = receiptPath;
  }
}
export interface AlignmentOptions { signal?: AbortSignal; hooks?: {
  onPhase?: (receipt: AlignmentReceipt) => Promise<void>; afterProvider?: (receipt: AlignmentReceipt) => Promise<void>;
  afterPrepared?: (receipt: AlignmentReceipt) => Promise<void>; afterIndexCommitted?: (receipt: AlignmentReceipt) => Promise<void>;
} }
interface Context { dir: string; files: NodeImportFiles; policy: AlignmentPolicy; signal: AbortSignal; read: (bytes: number) => void; check: () => void }
function policy(value: unknown): AlignmentPolicy {
  const result = assertAlignment<AlignmentPolicy>('policy', value);
  if (result.minSamples > result.maxSamples) throw Error('ALIGNMENT_POLICY_INVALID: sample limits');
  return result;
}
function runtimeIdentity(): AsrEngineIdentity {
  try { return validateAsrEngine(asrRuntimeIdentity()); }
  catch (error) { throw Error(`ALIGNMENT_RUNTIME_CHANGED: ${message(error)}`, { cause: error }); }
}
async function fixed(context: Context, path: string, maximum: number, retain = true) {
  if (!safeAlignmentPath(path)) throw Error('ALIGNMENT_PATH_INVALID');
  const absolute = context.files.projectPath(join(context.dir, path)), before = await context.files.inspect(absolute);
  const result = await readFixed(absolute, maximum, context.signal, context.read, retain); context.check();
  if (!sameImportNode(before, await context.files.inspect(absolute))) throw Error('ALIGNMENT_FILE_CHANGED');
  return { ...result, node: before };
}
async function json(context: Context, path: string) {
  const raw = await fixed(context, path, context.policy.maxMetadataBytes);
  return { ...raw, value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.data)) };
}
async function index(context: Context) {
  let raw; try { raw = await json(context, 'assets/alignment.json'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = assertAlignment<AlignmentIndex>('index', raw.value);
  if (new Set(value.alignments.map(entry => entry.alignmentId)).size !== value.alignments.length ||
      new Set(value.alignments.map(entry => entry.attemptId)).size !== value.alignments.length ||
      !value.alignments.some(entry => entry.alignmentId === value.currentAlignmentId)) throw Error('ALIGNMENT_INDEX_INVALID: duplicate/current identity');
  return { value, sha256: raw.sha256 };
}
async function source(context: Context, selection: Pick<AlignmentSelection, 'catalogId' | 'assetId' | 'assetVersion'>) {
  const idx = assertCatalog<CatalogIndex>('index', (await json(context, 'assets/catalog.json')).value);
  const commit = idx.catalogs.filter(entry => entry.catalogId === selection.catalogId);
  if (commit.length !== 1) throw Error('ALIGNMENT_CATALOG_NOT_COMMITTED');
  const catalog = await verifyCatalog(context.dir, selection.catalogId, { signal: context.signal, onRead: context.read }); context.check();
  const frozen = await json(context, `assets/catalogs/${selection.catalogId}/manifest.json`);
  if (frozen.sha256 !== commit[0]!.manifestSha256 || digest(catalog) !== frozen.sha256 || catalog.attemptId !== commit[0]!.attemptId) throw Error('ALIGNMENT_CATALOG_CHANGED');
  const assets = catalog.assets.filter(asset => asset.assetId === selection.assetId && asset.assetVersion === selection.assetVersion);
  if (assets.length !== 1) throw Error('ALIGNMENT_ASSET_INVALID');
  const asset = assets[0]!, pcmItems = asset.technical.evidence.filter(entry => entry.kind === 'audio-pcm');
  if (context.policy.version === '0.2') {
    const descriptor = asset.technical.audioInput;
    if (descriptor?.status !== 'completed' || pcmItems.length !== 1) throw Error('ALIGNMENT_FORMAT_UNSUPPORTED: complete bounded input audio required');
    const item = (id: string | null, kind: string) => {
      const entries = asset.technical.evidence.filter(entry => entry.id === id && entry.kind === kind);
      if (entries.length !== 1 || entries[0]!.coverage !== 'full') throw Error('ALIGNMENT_AUDIO_INPUT_EVIDENCE_INVALID'); return entries[0]!;
    };
    const limits = { ...DEFAULT_AUDIO_INPUT_LIMITS, maxSourceBytes: context.policy.maxSourceBytes, maxRiffChunks: context.policy.maxRiffChunks,
      minSamples: context.policy.minSamples, maxSamples: context.policy.maxSamples, maxAudioBytes: 44 + context.policy.maxSamples * 2 };
    const original = await fixed(context, asset.source.fixedPath, limits.maxSourceBytes);
    if (original.bytes !== asset.source.bytes || original.sha256 !== asset.source.sha256) throw Error('ALIGNMENT_SOURCE_CHANGED');
    const probeItem = item(descriptor.probeEvidenceId, 'probe'), pcmItem = item(descriptor.pcmEvidenceId, 'audio-pcm'),
      audioItem = item(descriptor.audioEvidenceId, 'audio-canonical'), mapItem = item(descriptor.mapEvidenceId, 'audio-input-map');
    const read = async (entry: typeof pcmItem, maximum: number) => {
      const actual = await fixed(context, entry.path, maximum);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('ALIGNMENT_AUDIO_INPUT_CHANGED'); return actual;
    };
    const probe = await read(probeItem, context.policy.maxMetadataBytes), pcm = await read(pcmItem, limits.maxPcmBytes),
      audio = await read(audioItem, limits.maxAudioBytes), mapData = await read(mapItem, limits.maxMapBytes);
    const map = validateAudioInputMap(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(mapData.data)), probe.data, pcm.data, audio.data, limits);
    if (map.source.bytes !== original.bytes || map.source.sha256 !== original.sha256 || digest(map.input) !== digest(preflightAudioInput(original.data, limits)) ||
        map.probe.evidenceId !== probeItem.id || map.sourcePcm.evidenceId !== pcmItem.id || map.audio.evidenceId !== audioItem.id ||
        pcmItem.sampleRate !== map.input.sampleRate || pcmItem.samples !== map.input.samples || audioItem.sampleRate !== 16000 || audioItem.samples !== map.audio.samples) throw Error('ALIGNMENT_AUDIO_INPUT_SOURCE_MISMATCH');
    const identity: AudioAlignmentSource = { catalogId: selection.catalogId, catalogManifestSha256: frozen.sha256,
      assetId: asset.assetId, assetVersion: asset.assetVersion, fixedPath: asset.source.fixedPath, bytes: original.bytes, sha256: original.sha256,
      input: map.input, pcmEvidenceId: pcmItem.id, audioEvidenceId: audioItem.id, audioInputMapEvidenceId: mapItem.id, audioInputMapSha256: mapItem.sha256 };
    return { identity, original, pcm, pcmPath: pcmItem.path, wav: audio.data, samples: map.audio.samples, payloadBytes: map.audio.payloadBytes,
      watched: [{ path: probeItem.path, value: probe }, { path: audioItem.path, value: audio }, { path: mapItem.path, value: mapData }] };
  }
  if (asset.technical.format !== 'wav' || pcmItems.length !== 1) throw Error('ALIGNMENT_FORMAT_UNSUPPORTED: complete WAV PCM required');
  const original = await fixed(context, asset.source.fixedPath, context.policy.maxSourceBytes), pcm = pcmItems[0]!;
  if (original.bytes !== asset.source.bytes || original.sha256 !== asset.source.sha256) throw Error('ALIGNMENT_SOURCE_CHANGED');
  const wave = preflightAsrWav(original.data, { ...DEFAULT_ASR_LIMITS, maxAsrSourceBytes: context.policy.maxSourceBytes,
    maxAsrRiffChunks: context.policy.maxRiffChunks, minAsrSamples: context.policy.minSamples, maxAsrSamples: context.policy.maxSamples });
  if (wave.sampleRate !== 16000 || wave.channels !== 1) throw Error('ALIGNMENT_FORMAT_UNSUPPORTED: 16000 Hz mono PCM16 required');
  const payload = original.data.subarray(wave.dataOffset, wave.dataOffset + wave.dataBytes), originalPcm = await fixed(context, pcm.path, wave.dataBytes);
  if (pcm.coverage !== 'full' || pcm.sampleRate !== 16000 || pcm.samples !== wave.frames || pcm.bytes !== wave.dataBytes ||
      originalPcm.bytes !== pcm.bytes || originalPcm.sha256 !== pcm.sha256 || !originalPcm.data.equals(payload)) throw Error('ALIGNMENT_PCM_SOURCE_MISMATCH');
  const identity: LegacyAlignmentSource = { catalogId: selection.catalogId, catalogManifestSha256: frozen.sha256,
    assetId: asset.assetId, assetVersion: asset.assetVersion, fixedPath: asset.source.fixedPath, bytes: original.bytes, sha256: original.sha256, wave, pcmEvidenceId: pcm.id };
  return { identity, original, pcm: originalPcm, pcmPath: pcm.path, wav: Buffer.concat([canonicalWavHeader(wave.frames), payload]), samples: wave.frames, payloadBytes: wave.dataBytes, watched: [] };
}
function toolOrigin(manifest: AlignmentManifest, cwd: string, language: AsrLanguage): string {
  const { tool, engine, policy, attemptId } = manifest;
  const model = tool.argv[tool.argv.indexOf('-m') + 1], audio = tool.argv[tool.argv.indexOf('-f') + 1];
  const absolute = (path: string | undefined) => typeof path === 'string' && path.startsWith('/') && resolve(path) === path && !/[\x00-\x1f\x7f]/.test(path);
  const suffix = `/out/.tmp/alignment-${attemptId}/audio.wav`, root = audio?.slice(0, -suffix.length);
  if (!absolute(tool.executable) || !tool.executable.endsWith('/' + engine.program.path) || !absolute(model) ||
      model !== tool.executable.slice(0, -engine.program.path.length) + engine.model.path || !absolute(audio) || !audio.endsWith(suffix) ||
      !absolute(cwd) || cwd.slice(0, cwd.lastIndexOf('/')) !== `${root}/out/.tmp/alignment-${attemptId}` || !/^provider-[a-f0-9-]{36}$/.test(cwd.split('/').at(-1)!) ||
      JSON.stringify(tool.argv) !== JSON.stringify(alignmentArguments(language, model!, audio!))) throw Error('ALIGNMENT_TOOL_ORIGIN_INVALID');
  validateAsrEngine(engine);
  if (tool.version !== `${engine.providerVersion}/${ALIGNMENT_MAPPER_VERSION}` || tool.error !== null || tool.exitCode !== 0 || tool.signal !== null ||
      tool.stdoutBytes !== 0 || tool.stdout !== '' || tool.binaryBytes !== manifest.raw.bytes || tool.binaryBytes > policy.maxRawBytes ||
      tool.stdoutBytes + tool.stderrBytes > policy.maxToolOutputBytes || tool.elapsedMs > policy.maxToolElapsedMs + 1000) throw Error('ALIGNMENT_TOOL_FACT_INVALID');
  return model!;
}
async function stored(context: Context, alignmentId: string, expected: string): Promise<AlignmentManifest> {
  if (!alignmentIdPattern.test(alignmentId)) throw Error('ALIGNMENT_ID_INVALID');
  const prefix = `assets/derived/alignment/${alignmentId}`, raw = await json(context, `${prefix}/manifest.json`);
  const manifest = assertAlignment<AlignmentManifest>('manifest', raw.value), limits = policy(manifest.policy);
  if (raw.sha256 !== expected || digest(manifest) !== expected || manifest.alignmentId !== alignmentId || !Number.isFinite(Date.parse(manifest.createdAt))) throw Error('ALIGNMENT_MANIFEST_CHANGED');
  const refs: Context = { ...context, policy: limits }, run = `runs/${manifest.attemptId}`, adopted = await json(refs, `${run}/alignment-policy.adopted.json`);
  if (digest(policy(adopted.value)) !== manifest.policySha256 || digest(limits) !== manifest.policySha256 || adopted.sha256 !== manifest.policySha256) throw Error('ALIGNMENT_POLICY_CHANGED');
  if (manifest.policySourceSha256 === null) {
    if (digest(limits) !== digest(DEFAULT_ALIGNMENT_POLICY)) throw Error('ALIGNMENT_POLICY_SOURCE_INVALID');
  } else {
    const original = await json(refs, `${run}/alignment-policy.source.json`);
    if (original.sha256 !== manifest.policySourceSha256 || digest(policy(original.value)) !== manifest.policySha256) throw Error('ALIGNMENT_POLICY_SOURCE_CHANGED');
  }
  const runNames = ['alignment-command.json', 'alignment-policy.adopted.json', 'receipt.json', ...(manifest.policySourceSha256 ? ['alignment-policy.source.json'] : [])].sort();
  if (JSON.stringify(await context.files.children(join(context.dir, run))) !== JSON.stringify(runNames) ||
      JSON.stringify(await context.files.children(join(context.dir, prefix))) !== JSON.stringify(outputNames)) throw Error('ALIGNMENT_EVIDENCE_UNLISTED');
  const read = async (entry: AlignmentFileIdentity, name: string, maximum: number) => {
    if (entry.path !== `${prefix}/${name}`) throw Error('ALIGNMENT_EVIDENCE_IDENTITY_INVALID');
    const actual = await fixed(refs, entry.path, maximum);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw Error('ALIGNMENT_EVIDENCE_CHANGED');
    return actual.data;
  };
  const scriptData = await read(manifest.scriptSnapshot, 'script.json', limits.maxMetadataBytes);
  const script = validateAlignmentScript(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(scriptData)), limits);
  const approval = await read(manifest.approvalSource, 'approval-source.txt', limits.maxApprovalBytes);
  if (approval.length !== script.approval.sourceRef.bytes || hash(approval) !== script.approval.sourceRef.sha256) throw Error('ALIGNMENT_APPROVAL_SOURCE_CHANGED');
  const audio = await read(manifest.audio, 'audio.wav', 44 + limits.maxSamples * 2), original = await source(refs, manifest.source);
  if (digest(original.identity) !== digest(manifest.source) || !audio.equals(original.wav) || manifest.audio.sampleRate !== 16000 ||
      manifest.audio.samples !== original.samples || manifest.audio.payloadBytes !== original.payloadBytes) throw Error('ALIGNMENT_AUDIO_SOURCE_MISMATCH');
  const provider = await read(manifest.raw, 'raw.json', limits.maxRawBytes), recognized = await read(manifest.recognized, 'recognized.txt', limits.maxRecognizedBytes);
  const mapData = await read(manifest.map, 'map.json', limits.maxMapBytes), map = assertAlignment('map', JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(mapData)));
  const command = (await json(refs, `${run}/alignment-command.json`)).value;
  if (!command || Object.keys(command).sort().join() !== 'cwd,kind,run,version' || command.version !== '0.1' || command.kind !== 'alignment-command' ||
      typeof command.cwd !== 'string' || digest(command.run) !== digest(manifest.tool)) throw Error('ALIGNMENT_COMMAND_CHANGED');
  if (digest(runtimeIdentity()) !== digest(manifest.engine)) throw Error('ALIGNMENT_RUNTIME_CHANGED: stored engine identity');
  context.check();
  const model = toolOrigin(manifest, command.cwd, script.language), parsed = parseAlignmentJson(provider, manifest.audio.samples, script.language, limits, model);
  const replay = alignScript(Buffer.from(script.text, 'utf8'), parsed, manifest.audio.samples, limits);
  if (!parsed.text.equals(recognized) || digest(map) !== manifest.map.sha256 || digest(replay) !== manifest.map.sha256) throw Error('ALIGNMENT_REPLAY_INVALID');
  const count = manifest.counts, derived = [manifest.scriptSnapshot, manifest.approvalSource, manifest.audio, manifest.raw, manifest.recognized, manifest.map].reduce((sum, entry) => sum + entry.bytes, 0);
  if (count.derivedBytes !== derived || derived > limits.maxDerivedBytes || count.sourceReadBytes > limits.maxSourceReadBytes ||
      count.sourceReadBytes < manifest.source.bytes + ('wave' in manifest.source ? manifest.source.wave.dataBytes : manifest.source.input.samples * 2) + manifest.scriptSnapshot.bytes + manifest.approvalSource.bytes ||
      count.toolOutputBytes !== manifest.tool.stdoutBytes + manifest.tool.stderrBytes || count.toolOutputBytes > limits.maxToolOutputBytes || count.elapsedMs > limits.maxElapsedMs) throw Error('ALIGNMENT_COUNTS_INVALID');
  context.check(); return manifest;
}
function readContext(dir: string, files: NodeImportFiles, external?: AbortSignal): Context {
  const timeout = AbortSignal.timeout(DEFAULT_ALIGNMENT_POLICY.maxElapsedMs), signal = external ? AbortSignal.any([timeout, external]) : timeout;
  let readBytes = 0;
  return { dir, files, policy: DEFAULT_ALIGNMENT_POLICY, signal, check: () => signal.throwIfAborted(), read: bytes => {
    readBytes += bytes; signal.throwIfAborted(); if (readBytes > DEFAULT_ALIGNMENT_POLICY.maxSourceReadBytes) throw Error('ALIGNMENT_SOURCE_READ_LIMIT');
  } };
}
export async function verifyAlignment(projectDir: string, alignmentId: string, options: { signal?: AbortSignal } = {}): Promise<AlignmentManifest> {
  const dir = resolve(projectDir), files = new NodeImportFiles(dir), context = readContext(dir, files, options.signal);
  context.check(); await files.assertProject(); const idx = await index(context), commit = idx?.value.alignments.find(entry => entry.alignmentId === alignmentId);
  if (!commit) throw Error('ALIGNMENT_NOT_COMMITTED');
  const manifest = await stored(context, alignmentId, commit.manifestSha256);
  if (manifest.attemptId !== commit.attemptId) throw Error('ALIGNMENT_INDEX_IDENTITY_INVALID'); return manifest;
}
async function recover(context: Context, attemptId: string): Promise<AlignmentReceipt[]> {
  const idx = await index(context), results: AlignmentReceipt[] = [];
  for (const name of await context.files.attemptDirectories()) {
    if (name === attemptId || !alignmentAttemptPattern.test(name)) continue;
    let receipt: AlignmentReceipt;
    try { receipt = assertAlignment('receipt', (await json(context, `runs/${name}/receipt.json`)).value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (receipt.attemptId !== name || receipt.tempPath !== `out/.tmp/alignment-${name}`) throw Error('ALIGNMENT_RECOVERY_IDENTITY_INVALID');
    if (!['running', 'prepared'].includes(receipt.status) || alive(receipt.ownerPid, name)) continue;
    const commit = idx?.value.alignments.find(entry => entry.alignmentId === receipt.alignmentId);
    if (commit) {
      const manifest = await stored(context, receipt.alignmentId, commit.manifestSha256);
      if (commit.attemptId !== name || manifest.attemptId !== name || receipt.manifestSha256 !== commit.manifestSha256 ||
          receipt.manifestPath !== `assets/derived/alignment/${receipt.alignmentId}/manifest.json` ||
          receipt.policySha256 !== manifest.policySha256 || receipt.selection.catalogId !== manifest.source.catalogId ||
          receipt.selection.assetId !== manifest.source.assetId || receipt.selection.assetVersion !== manifest.source.assetVersion) throw Error('ALIGNMENT_RECOVERY_COMMIT_INVALID');
      receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.error = null; receipt.tool = manifest.tool;
      receipt.counts = { ...manifest.counts, sourceReadBytes: Math.max(receipt.counts.sourceReadBytes, manifest.counts.sourceReadBytes), elapsedMs: Math.max(receipt.counts.elapsedMs, manifest.counts.elapsedMs) };
    } else { receipt.status = 'interrupted'; receipt.indexCommitted = false; receipt.error = 'ALIGNMENT_INTERRUPTED: owner stopped before index commit; counters retain last durable observations'; }
    receipt.finishedAt = new Date().toISOString(); await context.files.writeJson(join(context.dir, 'runs', name, 'receipt.json'), receipt); results.push(receipt); context.check();
  }
  return results;
}
export async function recoverAlignmentAttempts(projectDir: string, options: { signal?: AbortSignal } = {}): Promise<AlignmentReceipt[]> {
  const dir = resolve(projectDir), attemptId = `alignment-attempt-${randomUUID()}`, alignmentId = `alignment-${randomUUID()}`, temporaryDir = join(dir, `out/.tmp/alignment-${attemptId}`);
  const files = new NodeImportFiles(dir, temporaryDir), context = readContext(dir, files, options.signal), lease = new ProjectLease(dir, temporaryDir, 'alignment');
  let lock: string | null = null; active.add(attemptId);
  try { context.check(); await files.assertProject(); await files.ensureDirectory(join(dir, 'runs'));
    lock = await lease.acquireLock({ attemptId, alignmentId, pid: process.pid }, alive, context.signal); return await recover(context, attemptId);
  } finally { if (lock) await lease.releaseLock(lock, attemptId); active.delete(attemptId); }
}
export async function alignAsset(projectDir: string, selection: AlignmentSelection, options: AlignmentOptions = {}): Promise<AlignmentReceipt> {
  selection = structuredClone(selection);
  assertAlignment('selection', selection);
  if (!alignmentInputPath(selection.scriptPath)) throw Error('ALIGNMENT_SCRIPT_PATH_INVALID');
  const dir = resolve(projectDir), attemptId = `alignment-attempt-${randomUUID()}`, alignmentId = `alignment-${randomUUID()}`;
  const tempPath = `out/.tmp/alignment-${attemptId}`, temporaryDir = join(dir, tempPath), runDir = join(dir, 'runs', attemptId), receiptPath = join(runDir, 'receipt.json');
  const prefix = `assets/derived/alignment/${alignmentId}`, stage = join(temporaryDir, 'published'), files = new NodeImportFiles(dir, temporaryDir), lease = new ProjectLease(dir, temporaryDir, 'alignment');
  const started = performance.now(), deadline = new AbortController(), signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
  const receipt: AlignmentReceipt = { version: '0.1', kind: 'alignment-receipt', alignmentId, attemptId, ownerPid: process.pid, startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', phase: 'planning', selection, policy: null, policySha256: null, policySourceSha256: null, counts: emptyAlignmentCounts(), tool: null,
    tempPath, manifestPath: null, manifestSha256: null, indexCommitted: false, error: null };
  const context: Context = { dir, files, policy: DEFAULT_ALIGNMENT_POLICY, signal, read: bytes => {
    receipt.counts.sourceReadBytes += bytes; context.check(); if (receipt.counts.sourceReadBytes > context.policy.maxSourceReadBytes) throw Error('ALIGNMENT_SOURCE_READ_LIMIT');
  }, check: () => { signal.throwIfAborted(); if (performance.now() - started >= context.policy.maxElapsedMs) { deadline.abort(); signal.throwIfAborted(); } } };
  let timer = setTimeout(() => deadline.abort(), DEFAULT_ALIGNMENT_POLICY.maxElapsedMs), lock: string | null = null, writable = false, committed = false, cwd: string | null = null;
  const persist = async () => { receipt.counts.elapsedMs = Math.ceil(performance.now() - started); assertAlignment('receipt', receipt); await files.writeJson(receiptPath, receipt); };
  const phase = async (value: AlignmentReceipt['phase']) => { receipt.phase = value; await persist(); await options.hooks?.onPhase?.(structuredClone(receipt)); context.check(); };
  const write = async (path: string, data: Buffer) => {
    context.check(); await files.ensureDirectory(join(path, '..')); const handle = await open(files.projectPath(path), 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  };
  active.add(attemptId);
  try {
    await files.assertProject(); await files.ensureDirectory(runDir); writable = true; await persist(); lock = await lease.acquireLock({ attemptId, alignmentId, pid: process.pid }, alive, signal);
    let submittedPolicy: Awaited<ReturnType<typeof json>> | null = null;
    try { submittedPolicy = await json(context, 'inputs/alignment-policy.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    context.policy = submittedPolicy ? policy(submittedPolicy.value) : DEFAULT_ALIGNMENT_POLICY; receipt.policy = context.policy; receipt.version = context.policy.version;
    receipt.policySha256 = digest(context.policy); receipt.policySourceSha256 = submittedPolicy?.sha256 ?? null;
    clearTimeout(timer); timer = setTimeout(() => deadline.abort(), Math.max(1, context.policy.maxElapsedMs - (performance.now() - started)));
    if (submittedPolicy) await write(join(runDir, 'alignment-policy.source.json'), submittedPolicy.data);
    await files.writeJson(join(runDir, 'alignment-policy.adopted.json'), context.policy); await persist(); await recover(context, attemptId); await phase('planning');
    const oldIndex = await index(context);
    for (const entry of oldIndex?.value.alignments ?? []) { const previous = await stored(context, entry.alignmentId, entry.manifestSha256); if (previous.attemptId !== entry.attemptId) throw Error('ALIGNMENT_PRIOR_IDENTITY_INVALID'); }
    const original = await source(context, selection), scriptRaw = await json(context, selection.scriptPath), script = validateAlignmentScript(scriptRaw.value, context.policy);
    const approval = await fixed(context, script.approval.sourceRef.path, context.policy.maxApprovalBytes);
    if (approval.bytes !== script.approval.sourceRef.bytes || approval.sha256 !== script.approval.sourceRef.sha256) throw Error('ALIGNMENT_APPROVAL_SOURCE_CHANGED');
    const watched = [{ path: original.identity.fixedPath, value: original.original }, { path: original.pcmPath, value: original.pcm }, ...original.watched,
      { path: selection.scriptPath, value: scriptRaw }, { path: script.approval.sourceRef.path, value: approval }];
    function admit(bytes: number) { context.check(); if (receipt.counts.derivedBytes + bytes > context.policy.maxDerivedBytes) throw Error('ALIGNMENT_DERIVED_LIMIT'); receipt.counts.derivedBytes += bytes; }
    admit(original.wav.length + scriptRaw.bytes + approval.bytes);
    const engine = runtimeIdentity(), paths = asrRuntimePaths(), audioPath = join(temporaryDir, 'audio.wav');
    await write(audioPath, original.wav); const audioNode = await files.inspect(audioPath);
    async function unchanged() {
      for (const item of watched) { const actual = await fixed(context, item.path, item.value.bytes, false);
        if (actual.bytes !== item.value.bytes || actual.sha256 !== item.value.sha256 || !sameImportNode(actual.node, item.value.node)) throw Error('ALIGNMENT_INPUT_CHANGED'); }
      const currentAudio = await fixed(context, `${tempPath}/audio.wav`, original.wav.length, false);
      if (currentAudio.sha256 !== hash(original.wav) || !sameImportNode(currentAudio.node, audioNode)) throw Error('ALIGNMENT_AUDIO_CHANGED');
      if (digest(runtimeIdentity()) !== digest(engine)) throw Error('ALIGNMENT_RUNTIME_CHANGED');
      let currentPolicy: Awaited<ReturnType<typeof json>> | null = null;
      try { currentPolicy = await json(context, 'inputs/alignment-policy.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if ((currentPolicy?.sha256 ?? null) !== (submittedPolicy?.sha256 ?? null) || currentPolicy && submittedPolicy && !sameImportNode(currentPolicy.node, submittedPolicy.node)) throw Error('ALIGNMENT_POLICY_CHANGED');
      context.check();
    }
    await phase('aligning'); cwd = join(temporaryDir, `provider-${randomUUID()}`); await mkdir(files.projectPath(cwd), { mode: 0o700 });
    const cwdNode = await files.inspect(cwd), chunks: Buffer[] = []; let callbackFault: unknown;
    try {
      const run = await runInspectionTool({ executable: paths.program, version: `${engine.providerVersion}/${ALIGNMENT_MAPPER_VERSION}`, argv: alignmentArguments(script.language, paths.model, audioPath), cwd,
        policy: { ...DEFAULT_INSPECT_POLICY, maxToolElapsedMs: context.policy.maxToolElapsedMs, maxToolOutputBytes: context.policy.maxToolOutputBytes }, signal, binaryLimit: context.policy.maxRawBytes,
        binary: async chunk => { try { admit(chunk.length); chunks.push(Buffer.from(chunk)); } catch (error) { callbackFault = error; throw error; } },
        onRun: run => { receipt.tool = run; receipt.counts.toolOutputBytes += run.stdoutBytes + run.stderrBytes; } });
      if (!sameImportNode(cwdNode, await files.inspect(cwd)) || (await files.children(cwd)).length) throw Error('ALIGNMENT_CWD_CHANGED');
      if (callbackFault) throw callbackFault;
      if (run.error) throw Error(`ALIGNMENT_TOOL_FAILED: ${run.error}`);
    } finally { if (receipt.tool) await files.writeJson(join(runDir, 'alignment-command.json'), { version: '0.1', kind: 'alignment-command', cwd, run: receipt.tool }); await persist(); }
    await options.hooks?.afterProvider?.(structuredClone(receipt)); await unchanged();
    const raw = Buffer.concat(chunks), parsed = parseAlignmentJson(raw, original.samples, script.language, context.policy, paths.model);
    const map = alignScript(Buffer.from(script.text, 'utf8'), parsed, original.samples, context.policy), mapData = Buffer.from(importJsonText(map)); assertAlignment('map', map);
    if (mapData.length > context.policy.maxMapBytes) throw Error('ALIGNMENT_MAP_LIMIT'); admit(parsed.text.length + mapData.length);
    const data = { 'audio.wav': original.wav, 'script.json': scriptRaw.data, 'approval-source.txt': approval.data, 'raw.json': raw, 'recognized.txt': parsed.text, 'map.json': mapData };
    const identity = (name: keyof typeof data): AlignmentFileIdentity => ({ path: `${prefix}/${name}`, bytes: data[name].length, sha256: hash(data[name]) });
    for (const [name, bytes] of Object.entries(data)) await write(join(stage, name), bytes);
    await phase('verifying');
    const manifest: AlignmentManifest = { version: context.policy.version, kind: 'alignment-manifest', alignmentId, attemptId, createdAt: new Date().toISOString(), policy: context.policy,
      policySha256: receipt.policySha256!, policySourceSha256: receipt.policySourceSha256, source: original.identity, scriptSnapshot: identity('script.json'), approvalSource: identity('approval-source.txt'),
      audio: { ...identity('audio.wav'), sampleRate: 16000, samples: original.samples, payloadBytes: original.payloadBytes }, raw: identity('raw.json'),
      recognized: identity('recognized.txt'), map: identity('map.json'), engine, tool: receipt.tool!, counts: { ...receipt.counts } };
    assertAlignment('manifest', manifest); if (Buffer.byteLength(importJsonText(manifest)) > context.policy.maxMetadataBytes) throw Error('ALIGNMENT_METADATA_LIMIT');
    receipt.manifestPath = `${prefix}/manifest.json`; receipt.manifestSha256 = digest(manifest);
    await files.writeJson(join(stage, 'manifest.json'), manifest); await files.moveDirectory(stage, join(dir, prefix));
    await stored(context, alignmentId, receipt.manifestSha256); receipt.status = 'prepared'; await persist(); await options.hooks?.afterPrepared?.(structuredClone(receipt));
    await phase('committing'); await unchanged(); await stored(context, alignmentId, receipt.manifestSha256); await unchanged();
    if ((await index(context))?.sha256 !== oldIndex?.sha256) throw Error('ALIGNMENT_INDEX_CHANGED'); context.check();
    const updated: AlignmentIndex = { version: oldIndex?.value.version === '0.2' || context.policy.version === '0.2' ? '0.2' : '0.1', kind: 'alignment-index', currentAlignmentId: alignmentId, alignments: [...(oldIndex?.value.alignments ?? []), { alignmentId, attemptId, manifestSha256: receipt.manifestSha256 }] };
    assertAlignment('index', updated); if (Buffer.byteLength(importJsonText(updated)) > context.policy.maxMetadataBytes) throw Error('ALIGNMENT_INDEX_LIMIT');
    await files.writeJson(join(dir, 'assets/alignment.json'), updated); committed = true;
    // Expose the crash window with the last durable prepared receipt; index reality decides recovery.
    await options.hooks?.afterIndexCommitted?.(structuredClone(receipt)); receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.finishedAt = new Date().toISOString(); await persist(); return receipt;
  } catch (error) {
    receipt.error = deadline.signal.aborted ? 'ALIGNMENT_TIME_LIMIT' : message(error); receipt.finishedAt = new Date().toISOString();
    if (!committed && receipt.manifestSha256) try { const check = readContext(dir, files), idx = await index(check), entry = idx?.value.alignments.find(entry => entry.alignmentId === alignmentId);
      if (entry?.attemptId === attemptId && entry.manifestSha256 === receipt.manifestSha256) { await stored(check, alignmentId, entry.manifestSha256); committed = true; }
    } catch { /* Success requires complete verification of published identity. */ }
    receipt.status = committed ? 'succeeded' : options.signal?.aborted ? 'interrupted' : 'failed'; receipt.indexCommitted = committed;
    if (writable) try { await persist(); } catch (error) { receipt.error += `; ALIGNMENT_RECEIPT_WRITE_FAILED: ${message(error)}`; }
    throw new AlignmentFailure(receipt, writable ? receiptPath : null, error);
  } finally {
    clearTimeout(timer);
    try { if (cwd) await rm(cwd, { recursive: true, force: true }); if (lock) await lease.releaseLock(lock, attemptId); }
    catch (error) { receipt.error = `${receipt.error ?? ''}; ALIGNMENT_CLEANUP_FAILED: ${message(error)}`; if (writable) await persist().catch(() => undefined); }
    active.delete(attemptId);
  }
}
