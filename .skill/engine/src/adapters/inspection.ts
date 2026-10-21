import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { asrRuntimeIdentity } from '../../workspace.mjs';
import { inspectAudioAsr } from './inspection-asr.ts';
import { inspectAudioInput } from './inspection-audio.ts';
import { inspectImageOcr } from './inspection-ocr.ts';
import { assertImportPath, ensureImportDirectory, sameImportNode, NodeImportFiles } from './import-files.ts';
import type { CatalogCounts, Evidence, InspectPolicy, MediaStream, Technical, ToolRun } from '../project/catalog.ts';

/** One independent descriptor, bounded reads, and before/after node identity. */
export async function readFixed(path: string, maximum: number, signal?: AbortSignal, onRead?: (bytes: number) => void, retain = true): Promise<{ bytes: number; sha256: string; data: Buffer }> {
  assertImportPath(path); const files = new NodeImportFiles('/'), before = await files.inspect(path);
  if (before.kind !== 'file' || before.nlink !== '1') throw new Error('CATALOG_FILE_INVALID');
  if (before.size > maximum) throw new Error('CATALOG_READ_LIMIT');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const digest = createHash('sha256'), parts: Buffer[] = []; let bytes = 0;
  const node = (s: Awaited<ReturnType<typeof handle.stat>>) => ({ kind: s.isFile() ? 'file' as const : 'unknown' as const, dev: String(s.dev), ino: String(s.ino), nlink: String(s.nlink), size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
  try {
    if (!sameImportNode(before, node(await handle.stat({ bigint: true })))) throw new Error('CATALOG_FILE_CHANGED');
    const buffer = Buffer.alloc(Math.min(65536, maximum + 1));
    while (true) {
      signal?.throwIfAborted(); const result = await handle.read(buffer, 0, Math.min(buffer.length, maximum - bytes + 1), bytes);
      if (!result.bytesRead) break; onRead?.(result.bytesRead); bytes += result.bytesRead;
      if (bytes > maximum || bytes > before.size) throw new Error('CATALOG_READ_LIMIT: changed size');
      const chunk = buffer.subarray(0, result.bytesRead); digest.update(chunk); if (retain) parts.push(Buffer.from(chunk));
    }
    if (bytes !== before.size || !sameImportNode(before, node(await handle.stat({ bigint: true }))) || !sameImportNode(before, await files.inspect(path))) throw new Error('CATALOG_FILE_CHANGED');
    signal?.throwIfAborted(); return { bytes, sha256: digest.digest('hex'), data: Buffer.concat(parts) };
  } finally { await handle.close(); }
}
export async function inspectionExecutable(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    try { const path = await realpath(join(dir, name)); if ((await lstat(path)).isFile()) return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`CATALOG_TOOL_UNAVAILABLE: ${name}`);
}
export interface ToolOptions { executable: string; version: string; argv: string[]; cwd: string; policy: InspectPolicy; signal?: AbortSignal;
  binary?: (chunk: Buffer) => Promise<void>; binaryLimit?: number; onRun?: (run: ToolRun) => void; ocr?: true; }
/** Fixed program/argv at callers. Process groups retain descendant termination even after leader exit. */
export async function runInspectionTool(options: ToolOptions): Promise<ToolRun> {
  options.signal?.throwIfAborted();
  const started = performance.now(); const run: ToolRun = { executable: options.executable, version: options.version, argv: options.argv, exitCode: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 0, error: null };
  const child = spawn(options.executable, options.argv, { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: options.cwd, OPENSSL_CONF: '/dev/null', ...(options.ocr ? { OMP_THREAD_LIMIT: '1' } : {}) } });
  let stopped = false, termination: Promise<void> | undefined;
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const terminationFailure = Promise.withResolvers<never>();
  const killGroup = async () => {
    if (!child.pid) return;
    const deadline = performance.now() + 250;
    for (;;) {
      try { process.kill(-child.pid, 'SIGKILL'); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return;
        if (process.platform !== 'darwin' || code !== 'EPERM' || performance.now() >= deadline) {
          run.error = `CATALOG_TOOL_TERMINATION_FAILED: ${code ?? String(error)}`;
          throw new Error(run.error, { cause: error });
        }
        // A Darwin group containing only an unreaped zombie can return EPERM.
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
    }
  };
  const terminate = () => {
    if (!termination) { termination = killGroup(); termination.catch(error => terminationFailure.reject(error)); }
    return termination;
  };
  const stop = (reason: string) => { if (!stopped) { stopped = true; run.error = reason; terminate(); } };
  const abort = () => stop('CATALOG_INTERRUPTED'); options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('CATALOG_TOOL_TIME_LIMIT'), options.policy.maxToolElapsedMs);
  const close = new Promise<void>(resolve => { child.once('error', error => { run.error = `CATALOG_TOOL_ERROR: ${error.message}`; resolve(); }); child.once('close', (code, signal) => { run.exitCode = code; run.signal = signal; resolve(); }); });
  async function drain(stream: NonNullable<typeof child.stdout>, channel: 'stdout' | 'stderr') {
    try { for await (const data of stream) {
      const chunk = Buffer.from(data); if (stopped) continue;
      if (channel === 'stdout' && options.binary) {
        const left = Math.max(0, (options.binaryLimit ?? Number.MAX_SAFE_INTEGER) - run.binaryBytes), accepted = chunk.subarray(0, left);
        if (accepted.length) { await options.binary(accepted); run.binaryBytes += accepted.length; }
        if (chunk.length > left) stop('CATALOG_BINARY_LIMIT');
      } else {
        const left = Math.max(0, options.policy.maxToolOutputBytes - run.stdoutBytes - run.stderrBytes), accepted = chunk.subarray(0, left);
        run[channel] += decoders[channel].write(accepted); run[channel === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += accepted.length;
        if (chunk.length > left) stop('CATALOG_TOOL_OUTPUT_LIMIT');
      }
    } } catch (error) { stop(error instanceof Error ? error.message : String(error)); } finally { if (!(channel === 'stdout' && options.binary)) run[channel] += decoders[channel].end(); }
  }
  try {
    if (options.signal?.aborted) abort();
    await Promise.race([Promise.all([drain(child.stdout, 'stdout'), drain(child.stderr, 'stderr'), close]), terminationFailure.promise]);
    if (!run.error && run.exitCode !== 0) run.error = `CATALOG_TOOL_EXIT: ${run.exitCode}`;
    options.signal?.throwIfAborted(); return run;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    try { await terminate(); }
    catch (error) { child.unref(); throw error; }
    finally { child.stdout.destroy(); child.stderr.destroy(); run.elapsedMs = Math.ceil(performance.now() - started); options.onRun?.(run); }
  }
}
const finite = (value: unknown): number | null => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const positive = (value: unknown): number | null => { const n = finite(value); return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null; };
const integerString = (value: unknown): string | null => typeof value === 'string' && /^-?\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const rational = (value: unknown): string | null => typeof value === 'string' && /^-?\d+\/[1-9]\d*$/.test(value) ? value : null;
function mediaStream(raw: Record<string, any>): MediaStream {
  return { index: raw.index, type: raw.codec_type ?? 'unknown', codec: raw.codec_name ?? null, width: positive(raw.width), height: positive(raw.height), pixelFormat: raw.pix_fmt ?? null,
    sampleRate: positive(raw.sample_rate), channels: positive(raw.channels), timeBase: rational(raw.time_base), startPts: integerString(raw.start_pts), durationTs: integerString(raw.duration_ts), startTime: finite(raw.start_time), duration: finite(raw.duration), avgFrameRate: raw.avg_frame_rate ?? null, rFrameRate: raw.r_frame_rate ?? null,
    rotation: finite(raw.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ?? raw.tags?.rotate), raw: JSON.stringify(raw) };
}
function webmHeader(data: Buffer): boolean {
  function vint(offset: number, marker: boolean): { value: number; bytes: number } | null {
    const first = data[offset]; if (!first) return null; let mask = 0x80, bytes = 1;
    while (!(first & mask) && bytes <= 8) { mask >>= 1; bytes++; }
    if (bytes > 8 || offset + bytes > data.length) return null;
    let value = marker ? first : first & (mask - 1);
    for (let i = 1; i < bytes; i++) value = value * 256 + data[offset + i]!;
    return Number.isSafeInteger(value) ? { value, bytes } : null;
  }
  const header = vint(4, false); if (!header) return false;
  let pos = 4 + header.bytes; const end = pos + header.value; if (end > data.length) return false;
  while (pos < end) {
    const id = vint(pos, true); if (!id) return false; pos += id.bytes;
    const size = vint(pos, false); if (!size) return false; pos += size.bytes;
    if (pos + size.value > end) return false;
    if (id.value === 0x4282) return data.toString('ascii', pos, pos + size.value) === 'webm'; pos += size.value;
  }
  return false;
}
function signature(data: Buffer, name: string, office = false): string {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png_pipe';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg_pipe';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (data.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (data.toString('ascii', 0, 3) === 'ID3' || data[0] === 255 && (data[1]! & 0xe0) === 0xe0) return 'mp3';
  if (['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(data.toString('ascii', 4, 8))) return 'mov';
  if (data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return webmHeader(data) ? 'matroska' : 'unknown';
  if (data.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  if ((/\.docx$/i.test(name) || office && /\.(pptx|xlsx)$/i.test(name)) && data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return 'office-cfb';
  if (data.toString('ascii', 0, 2) === 'PK') return /\.docx$/i.test(name) ? 'docx' : office && /\.(pptx|xlsx)$/i.test(name) ? name.toLowerCase().endsWith('.pptx') ? 'pptx' : 'xlsx' : 'zip';
  if (/\.(txt|md)$/i.test(name) || /^\.[^.]+$/.test(basename(name))) return 'utf8'; return 'unknown';
}
export interface InspectContext { projectDir: string; temporaryDir: string; evidenceDir: string; publishedDir: string; policy: InspectPolicy; counts: CatalogCounts; tools: ToolRun[]; signal: AbortSignal; check: () => void; sourceBytes?: number; sourceSha256?: string; policySha256?: string; format?: string; header?: Buffer; recordAsrInvocation?: (run: ToolRun, cwd: string) => Promise<void> }
export async function inspectFormat(source: string, name: string, context: InspectContext): Promise<{ format: string; header: Buffer }> {
  const { counts } = context, files = new NodeImportFiles(context.projectDir), info = await files.inspect(source);
  // Prefix routing uses the same independent reader; source size was admitted by the application.
  const headerHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let header: Buffer;
  try { const data = Buffer.alloc(Math.min(4096, info.size)); const { bytesRead } = await headerHandle.read(data, 0, data.length, 0); header = data.subarray(0, bytesRead); counts.sourceReadBytes += bytesRead; }
  finally { await headerHandle.close(); }
  return { format: signature(header, name, context.policy.version === '0.7'), header };
}
export async function inspectAsset(source: string, name: string, context: InspectContext): Promise<Technical> {
  const routed = context.format && context.header ? { format: context.format, header: context.header } : await inspectFormat(source, name, context);
  context = { ...context, ...routed };
  if (context.policy.version === '0.5' || (context.policy.version === '0.6' || context.policy.version === '0.7')) {
    const format = ['wav', 'mp3', 'flac'].includes(routed.format) ? routed.format : /\.m4a$/i.test(name) ? 'mov' : null;
    if (format) return inspectAudioInput(source, format as 'wav' | 'mp3' | 'flac' | 'mov', context);
  }
  if (routed.format === 'wav' && context.policy.version === '0.4' && context.policy.asr.enabled) {
    context.signal.throwIfAborted(); context.check();
    try { asrRuntimeIdentity(); } catch (error) { throw new Error('CATALOG_ASR_RUNTIME_UNAVAILABLE: ' + (error instanceof Error ? error.message : String(error))); }
  }
  const base = await inspectBaseAsset(source, name, context);
  if ((context.policy.version === '0.3' || context.policy.version === '0.4' || context.policy.version === '0.5' || (context.policy.version === '0.6' || context.policy.version === '0.7')) && (base.format === 'png_pipe' || base.format === 'jpeg_pipe')) return inspectImageOcr(source, base.format, base, context);
  return context.policy.version === '0.4' && base.format === 'wav' ? inspectAudioAsr(source, base, context) : base;
}
async function inspectBaseAsset(source: string, name: string, context: InspectContext): Promise<Technical> {
  const { policy, signal, counts } = context, files = new NodeImportFiles(context.projectDir), info = await files.inspect(source);
  const { format, header } = context.format && context.header ? { format: context.format, header: context.header } : await inspectFormat(source, name, context);
  const result: Technical = { status: 'supported', format, method: `inspection@0.1/node@${process.versions.node}`, reason: '', raw: null, streams: [], evidence: [], text: null, containerDuration: null, limitations: ['Technical evidence requires separate semantic observation and rights records.', 'Null normalized fields indicate missing, nonfinite or unsafe numeric metadata; available fields remain in the raw probe.'] };
  await ensureImportDirectory(context.projectDir, context.evidenceDir);
  if (['pdf', 'docx', 'pptx', 'xlsx'].includes(format)) { result.status = 'unsupported'; result.reason = 'DOCUMENT_IMPORT_REMOVED: use an independently prepared image or UTF-8 text asset.'; return result; }
  function admit(bytes: number) { context.check(); if (counts.derivedBytes + bytes > policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT'); counts.derivedBytes += bytes; }
  async function evidence(kind: Evidence['kind'], suffix: string, data: Buffer, fields: Partial<Evidence> = {}, admitted = false) {
    if (admitted) context.check(); else admit(data.length); const id = `evidence-${randomUUID()}`, path = join(context.evidenceDir, `${id}.${suffix}`), handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    const entry: Evidence = { id, kind, path: `${context.publishedDir}/${id}.${suffix}`, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), width: null, height: null, sourceWidth: null, sourceHeight: null, transform: null, streamIndex: null, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: null, samples: null, coverage: 'full', ...fields };
    result.evidence.push(entry); return entry;
  }
  if (format === 'office-cfb') { result.status = 'unsupported'; result.reason = 'DOCUMENT_CFB_UNSUPPORTED: encrypted or legacy Office wrapper'; return result; }
  if (format === 'zip' || format === 'unknown') { result.status = format === 'zip' ? 'requires-unpack' : 'unsupported'; result.reason = format === 'zip' ? 'Select the committed ZIP through unpack before inspecting its members.' : 'Unsupported signature/format.'; return result; }
  if (format === 'utf8') {
    if (info.size > policy.maxTextBytes) { result.status = 'partial'; result.reason = 'CATALOG_TEXT_LIMIT: extraction skipped'; return result; }
    const read = await readFixed(source, policy.maxTextBytes, signal, bytes => { counts.sourceReadBytes += bytes; });
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.data);
      if (/\x00/.test(text)) throw new Error('binary NUL');
      const bom = read.data.subarray(0, 3).equals(Buffer.from('efbbbf', 'hex')), endings = [text.includes('\r\n') ? 'CRLF' : '', /(?<!\r)\n/.test(text) ? 'LF' : '', /\r(?!\n)/.test(text) ? 'CR' : ''].filter(Boolean).join('+') || 'none';
      result.text = { bytes: read.bytes, lines: text.split(/\r\n|\r|\n/).length, bom, lineEndings: endings }; await evidence('text', 'txt', read.data);
    } catch (error) { if ((error as Error).message.startsWith('CATALOG_')) throw error; result.status = 'failed'; result.reason = `CATALOG_UTF8_INVALID: ${(error as Error).message}`; }
    return result;
  }
  if (format === 'png_pipe' && header.length >= 24) {
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!width || !height || width * height > policy.maxSourcePixels) { result.status = 'failed'; result.reason = 'CATALOG_PIXEL_LIMIT_OR_INVALID: PNG header'; return result; }
  }
  let ffprobe: string, ffmpeg: string;
  try { ffprobe = await inspectionExecutable('ffprobe'); ffmpeg = await inspectionExecutable('ffmpeg'); } catch (error) { result.status = 'failed'; result.reason = (error as Error).message; return result; }
  async function tool(executable: string, argv: string[], binary?: (chunk: Buffer) => Promise<void>, binaryLimit?: number): Promise<ToolRun> {
    const version = context.tools.find(r => r.executable === executable && r.argv[0] === '-version')?.stdout.split('\n')[0];
    if (!version) await runInspectionTool({ executable, version: 'version-query', argv: ['-version'], cwd: context.temporaryDir, policy, signal, onRun: r => { context.tools.push(r); counts.toolOutputBytes += r.stdoutBytes + r.stderrBytes; } });
    const adopted = context.tools.find(r => r.executable === executable && r.argv[0] === '-version');
    if (adopted?.error) throw new Error(adopted.error);
    const run = await runInspectionTool({ executable, version: adopted!.stdout.split('\n')[0], argv, cwd: context.temporaryDir, policy, signal, binary, binaryLimit, onRun: r => { context.tools.push(r); counts.toolOutputBytes += r.stdoutBytes + r.stderrBytes; } });
    context.check(); if (run.error === 'CATALOG_DERIVED_LIMIT') throw new Error(run.error); return run;
  }
  const input = ['-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000', '-protocol_whitelist', 'file', '-format_whitelist', format, '-f', format, '-max_streams', String(Math.max(1, policy.maxStreamsPerAsset))];
  try {
    const probe = await tool(ffprobe, ['-v', 'error', ...input, '-show_format', '-show_streams', '-of', 'json', source]);
    result.raw = probe.stdout; await evidence('probe', 'json', Buffer.from(probe.stdout));
    if (probe.error) throw new Error(probe.error); const raw = JSON.parse(probe.stdout);
    if (!Array.isArray(raw.streams) || raw.streams.length > policy.maxStreamsPerAsset || !raw.streams.every((s: any) => Number.isSafeInteger(s.index) && s.index >= 0) || new Set(raw.streams.map((s: any) => s.index)).size !== raw.streams.length) throw new Error('CATALOG_STREAMS_INVALID');
    result.streams = raw.streams.map(mediaStream); result.containerDuration = finite(raw.format?.duration);
    const videos = result.streams.filter(s => s.type === 'video'), audio = result.streams.find(s => s.type === 'audio'), image = format === 'png_pipe' || format === 'jpeg_pipe';
    for (const video of videos) {
      if (!video.width || !video.height || video.width * video.height > policy.maxSourcePixels) throw new Error('CATALOG_PIXEL_LIMIT_OR_INVALID');
      const scale = Math.min(1, policy.maxPreviewEdge / Math.max(video.width, video.height)), width = Math.max(1, Math.floor(video.width * scale)), height = Math.max(1, Math.floor(video.height * scale));
      if (!policy.maxPreviewEdge) throw new Error('CATALOG_PREVIEW_LIMIT');
      const start = video.startTime ?? (image ? 0 : null), duration = video.duration;
      const rate = video.avgFrameRate?.split('/').map(Number), step = rate && rate[0] > 0 && rate[1] > 0 ? rate[1] / rate[0] : duration === null ? 0 : Math.min(0.5, duration / 10);
      const sampleCount = image ? 1 : start === null || duration === null || duration <= 0 ? Math.min(1, policy.defaultVideoSamplesPerAsset) : policy.defaultVideoSamplesPerAsset;
      if (!image && !sampleCount) { result.status = 'partial'; result.reason = 'CATALOG_VIDEO_SAMPLE_LIMIT: probe-only coverage'; }
      for (let i = 0; i < sampleCount; i++) {
        context.check();
        const requestedTime = image ? 0 : start === null ? null : duration === null || duration <= 0 || sampleCount === 1 ? start : start + (i === sampleCount - 1 ? Math.max(0, duration - step) : duration * i / (sampleCount - 1));
        const chunks: Buffer[] = [], filter = [!image && requestedTime !== null ? `select=gte(t\\,${requestedTime})` : '', 'showinfo', `scale=${width}:${height}`].filter(Boolean).join(',');
        const run = await tool(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-xerror', ...input, '-copyts', '-noautorotate', '-i', source, '-map', `0:${video.index}`, '-vf', filter, '-frames:v', '1', '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], async chunk => { admit(chunk.length); chunks.push(chunk); });
        const data = Buffer.concat(chunks);
        if (run.error || !data.length) { result.status = 'partial'; result.reason = run.error ?? 'CATALOG_FRAME_UNAVAILABLE'; continue; }
        if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) { result.status = 'partial'; result.reason = 'CATALOG_PREVIEW_GEOMETRY_INVALID'; continue; }
        const pts = /\bn:\s*0\s+pts:\s*(-?\d+)\s+pts_time:([^\s]+)/.exec(run.stderr), base = /config in time_base:\s*(\d+\/\d+)/.exec(run.stderr)?.[1] ?? null;
        const actual = finite(pts?.[2]); if (!image && (!pts || base !== video.timeBase || actual === null)) { result.status = 'partial'; result.reason = 'CATALOG_FRAME_LOCATION_UNKNOWN'; continue; }
        await evidence(image ? 'preview' : 'frame', 'png', data, { width, height, sourceWidth: video.width, sourceHeight: video.height, transform: `source pixels scaled ${width}/${video.width},${height}/${video.height}; autorotate disabled`, streamIndex: video.index, timeBase: video.timeBase, pts: pts?.[1] ?? null, requestedTime, actualTime: actual, coverage: image ? 'full' : 'sample' }, true);
      }
    }
    if (audio && !image) {
      if (!audio.sampleRate) throw new Error('CATALOG_SAMPLE_RATE_UNKNOWN');
      const id = `evidence-${randomUUID()}`, filename = `${id}.s16le`, handle = await open(join(context.evidenceDir, filename), 'wx', 0o600), digest = createHash('sha256'); let bytes = 0;
      const remaining = Math.max(0, policy.maxDecodedAudioBytes - counts.decodedAudioBytes), limit = remaining - remaining % 2;
      let run: ToolRun;
      try { run = await tool(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', ...input, '-i', source, '-map', `0:${audio.index}`, '-vn', '-ar', String(audio.sampleRate), '-ac', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], async chunk => {
        admit(chunk.length); await handle.writeFile(chunk); digest.update(chunk); bytes += chunk.length; counts.decodedAudioBytes += chunk.length;
      }, limit); await handle.sync(); } catch (error) { await handle.close(); await rm(join(context.evidenceDir, filename)); throw error; } finally { await handle.close().catch(() => undefined); }
      if (run!.error === 'CATALOG_BINARY_LIMIT' && policy.version === '0.4' && policy.asr.enabled && format === 'wav') throw new Error('CATALOG_DECODED_AUDIO_LIMIT');
      const full = !run!.error && bytes % 2 === 0;
      if (!full) { result.status = 'partial'; result.reason = run!.error ?? 'CATALOG_PCM_ALIGNMENT'; }
      result.evidence.push({ id, kind: 'audio-pcm', path: `${context.publishedDir}/${filename}`, bytes, sha256: digest.digest('hex'), width: null, height: null, sourceWidth: null, sourceHeight: null, transform: 'first audio stream; mono PCM signed 16-bit little-endian; original sample rate', streamIndex: audio.index, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: audio.sampleRate, samples: Math.floor(bytes / 2), coverage: full ? 'full' : 'partial' });
    }
    if (!result.streams.length) throw new Error('CATALOG_STREAMS_EMPTY');
    if (!image) result.limitations.push('Video evidence covers sampled frames; audio PCM measures the first audio stream. Container duration and decoded sample coverage are separate. Missing normalized fields remain null; the raw probe preserves available metadata. FFmpeg max_alloc bounds single allocations; stream/pixel admission applies to preview decoding.');
  } catch (error) {
    signal.throwIfAborted(); context.check(); const message = error instanceof Error ? error.message : String(error);
    if (message === 'CATALOG_DERIVED_LIMIT' || message === 'CATALOG_DECODED_AUDIO_LIMIT' || message.startsWith('CATALOG_TOOL_TERMINATION_FAILED:')) throw error;
    result.status = result.evidence.some(e => e.kind !== 'probe') ? 'partial' : 'failed'; result.reason = message;
  }
  return result;
}
