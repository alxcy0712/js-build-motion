import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrRuntimePaths } from '../workspace.mjs';
import { inspectAudioAsr } from '../src/adapters/inspection-asr.ts';
import { type InspectContext } from '../src/adapters/inspection.ts';
import { asrLimits, DEFAULT_INSPECT_POLICY, emptyCatalogCounts, type Technical, type ToolRun } from '../src/project/catalog.ts';
import { asrArguments, canonicalWavHeader, validateAsrMap, type AsrMap } from '../src/project/asr.ts';

const engineRoot = dirname(dirname(fileURLToPath(import.meta.url))), output = resolve(engineRoot, '../../.research/out');
const paths = asrRuntimePaths(), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const lock = JSON.parse(fs.readFileSync(join(engineRoot, 'asr-dependencies.lock.json'), 'utf8'));
function raw(language = 'zh', entries = [{ timestamps: { from: '00:00:00,000', to: '00:00:01,000' }, offsets: { from: 0, to: 1000 }, text: ' 中🙂e\u0301  ' }]) {
  return Buffer.from(JSON.stringify({ systeminfo: 'fixture CPU', model: { type: 'base', multilingual: true, vocab: 51865, audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 },
    params: { model: paths.model, language, translate: false }, result: { language }, transcription: entries }));
}
function fixture(overrides: Record<string, any> = {}, samples = 16000) {
  fs.mkdirSync(output, { recursive: true }); const root = fs.realpathSync(fs.mkdtempSync(join(output, 'inspection-asr-'))), temporaryDir = join(root, 'tmp'), evidenceDir = join(root, 'evidence');
  fs.mkdirSync(temporaryDir); fs.mkdirSync(evidenceDir);
  const pcm = Buffer.alloc(samples * 2), wav = Buffer.concat([canonicalWavHeader(samples), pcm]), source = join(root, 'source.wav'); fs.writeFileSync(source, wav);
  const id = `evidence-${randomUUID()}`, name = `${id}.s16le`, pcmPath = join(evidenceDir, name); fs.writeFileSync(pcmPath, pcm);
  const technical: Technical = { status: 'supported', format: 'wav', method: 'fixture', reason: '', raw: '{}', text: null, containerDuration: samples / 16000, limitations: [],
    streams: [{ index: 0, type: 'audio', codec: 'pcm_s16le', width: null, height: null, pixelFormat: null, sampleRate: 16000, channels: 1, timeBase: '1/16000', startPts: null, durationTs: String(samples), startTime: null, duration: samples / 16000, avgFrameRate: null, rFrameRate: null, rotation: null, raw: '{}' }],
    evidence: [{ id, kind: 'audio-pcm', path: `evidence/${name}`, bytes: pcm.length, sha256: hash(pcm), width: null, height: null, sourceWidth: null, sourceHeight: null,
      transform: 'first audio stream; mono PCM signed 16-bit little-endian; original sample rate', streamIndex: 0, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: 16000, samples, coverage: 'full' }] };
  const policy = { ...DEFAULT_INSPECT_POLICY, ...overrides, asr: { ...DEFAULT_INSPECT_POLICY.asr, enabled: true, ...overrides.asr } };
  const counts = emptyCatalogCounts(); counts.derivedBytes = counts.decodedAudioBytes = pcm.length;
  const invocations: { run: ToolRun; cwd: string; contents: string[] }[] = [];
  const context: InspectContext = { projectDir: root, temporaryDir, evidenceDir, publishedDir: 'evidence', policy, counts, tools: [], signal: new AbortController().signal,
    check() {}, sourceBytes: wav.length, sourceSha256: hash(wav), policySha256: 'a'.repeat(64),
    async recordAsrInvocation(run, cwd) { invocations.push({ run: structuredClone(run), cwd, contents: fs.readdirSync(cwd) }); } };
  return { root, source, pcmPath, technical, context, invocations, samples, baseBytes: pcm.length,
    clean() { fs.rmSync(root, { recursive: true, force: true }); }, run() { return inspectAudioAsr(source, technical, context); },
    data(kind: string) { return fs.readFileSync(join(root, technical.evidence.find(e => e.kind === kind)!.path)); },
    empty() { assert.deepEqual(fs.readdirSync(temporaryDir), []); assert.equal(fs.readdirSync(evidenceDir).length, 1); assert.equal(technical.evidence.length, 1); } };
}
async function synthetic(f: ReturnType<typeof fixture>, options: { raw?: Buffer; stderr?: string; code?: string; beforeAsr?: (argv: readonly string[], cwd: string) => void } = {}) {
  const spawn = childProcess.spawn; const calls: { executable: string; argv: readonly string[]; options: any; contents: string[]; mode: number }[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: readonly string[], spawnOptions: any) => {
      calls.push({ executable, argv, options: spawnOptions, contents: fs.readdirSync(spawnOptions.cwd), mode: fs.statSync(spawnOptions.cwd).mode & 0o777 });
      if (executable === paths.program) {
        options.beforeAsr?.(argv, spawnOptions.cwd);
        const code = options.code ?? `process.stderr.write(${JSON.stringify(options.stderr ?? '')});process.stdout.write(Buffer.from(${JSON.stringify((options.raw ?? raw(f.context.policy.asr.language)).toString('base64'))},'base64'))`;
        return spawn(process.execPath, ['-e', code], spawnOptions);
      }
      return spawn(executable, argv, spawnOptions);
    }) as typeof spawn; syncBuiltinESMExports(); return { result: await f.run(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
function failed(f: ReturnType<typeof fixture>, status: 'skipped' | 'failed', reason: RegExp, baseStatus: Technical['status'] = 'partial') {
  assert.equal(f.technical.status, baseStatus); assert.equal(f.technical.asr!.status, status); assert.match(f.technical.asr!.reason, reason);
  assert.equal(f.technical.asr!.segments, 0); for (const key of ['audioEvidenceId', 'jsonEvidenceId', 'textEvidenceId', 'mapEvidenceId'] as const) assert.equal(f.technical.asr![key], null);
  assert.equal(f.technical.text, null); f.empty();
}

test('fixed invocation uses one staged WAV, an independent empty cwd, minimal env and exact accounting', async () => {
  const f = fixture(); try {
    const data = raw(), { calls } = await synthetic(f, { raw: data, stderr: 'fixture diagnostic\n' });
    assert.equal(f.technical.asr!.status, 'completed'); const map: AsrMap = JSON.parse(f.data('asr-map').toString());
    assert.deepEqual(f.data('text'), Buffer.from('20e4b8adf09f998265cc812020', 'hex'));
    validateAsrMap(map, f.data('text'), f.data('asr-audio'), f.data('asr-json'), asrLimits(f.context.policy));
    const call = calls.find(c => c.executable === paths.program)!, audioPath = call.argv.at(-1)!;
    assert.deepEqual(call.argv, asrArguments('zh', paths.model, audioPath)); assert.match(audioPath, /\/evidence\/evidence-[a-f0-9-]+\.wav$/);
    assert.match(call.options.cwd, /\/tmp\/asr-[a-f0-9-]+$/); assert.equal(audioPath.startsWith(call.options.cwd + '/'), false); assert.deepEqual(call.contents, []); assert.equal(call.mode, 0o700);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['LANG', 'OPENSSL_CONF', 'PATH', 'TMPDIR']);
    assert.equal(call.options.env.TMPDIR, call.options.cwd); assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0]!.cwd, call.options.cwd); assert.deepEqual(f.invocations[0]!.contents, []);
    const run = f.context.tools.at(-1)!; assert.equal(run.version, '1.9.5/asr-json@0.1'); assert.equal(run.binaryBytes, data.length); assert.equal(run.stdoutBytes, 0); assert.equal(run.stdout, '');
    assert.equal(f.context.counts.toolOutputBytes, Buffer.byteLength('fixture diagnostic\n'));
    assert.equal(f.context.counts.derivedBytes, f.baseBytes + f.technical.evidence.slice(1).reduce((sum, e) => sum + e.bytes, 0));
    assert.equal(f.context.counts.decodedAudioBytes, f.baseBytes * 2);
    const audio = f.technical.evidence[1]!; assert.equal(audio.sampleRate, 16000); assert.equal(audio.samples, 16000); assert.equal(audio.streamIndex, 0); assert.equal(audio.coverage, 'full');
    assert.deepEqual(map.sourcePcm, { evidenceId: f.technical.evidence[0]!.id, bytes: f.baseBytes, sha256: f.technical.evidence[0]!.sha256, sampleRate: 16000, samples: 16000 });
    assert.equal(map.policySha256, f.context.policySha256); assert.equal(map.source.sha256, f.context.sourceSha256); assert.equal(fs.readdirSync(f.context.evidenceDir).length, 5); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), []);
  } finally { f.clean(); }
});
test('empty completed JSON publishes a validated no-text group and preserves generic partial state', async () => {
  const f = fixture(); try { f.technical.status = 'partial'; f.technical.reason = 'generic metadata incomplete'; await synthetic(f, { raw: raw('zh', []) });
    assert.equal(f.technical.status, 'partial'); assert.equal(f.technical.reason, 'generic metadata incomplete'); assert.equal(f.technical.asr!.status, 'no-text');
    assert.equal(f.technical.asr!.segments, 0); assert.deepEqual(f.technical.text, { bytes: 0, lines: 1, bom: false, lineEndings: 'none' }); assert.equal(f.technical.evidence.length, 5);
  } finally { f.clean(); }
});
test('disabled ASR keeps base state and avoids native calls and runtime lookup', async () => {
  const f = fixture({ asr: { enabled: false } }); try { await f.run(); assert.equal(f.technical.status, 'supported'); assert.equal(f.technical.asr!.status, 'disabled'); assert.equal(f.technical.asr!.engine, null); assert.equal(f.context.tools.length, 0); f.empty(); } finally { f.clean(); }
});
for (const state of ['partial', 'failed', 'unsupported'] as const) test(`local refusal retains the original ${state} base state`, async () => {
  const f = fixture(); try { f.technical.status = state; f.technical.reason = 'base outcome'; await synthetic(f, { raw: Buffer.from('{}') }); failed(f, 'failed', /ASR_JSON_INVALID/, state); assert.match(f.technical.reason, /^base outcome;/); } finally { f.clean(); }
});
test('scope, single audio stream and complete PCM are required before provider execution', async () => {
  for (const state of ['format', 'multiple', 'codec', 'rate', 'channels', 'missing', 'partial', 'samples', 'stream'] as const) {
    const f = fixture(); try {
      if (state === 'format') f.technical.format = 'flac'; if (state === 'multiple') f.technical.streams.push({ ...f.technical.streams[0]!, index: 1 });
      if (state === 'codec') f.technical.streams[0]!.codec = 'pcm_f32le'; if (state === 'rate') f.technical.streams[0]!.sampleRate = 48000;
      if (state === 'channels') f.technical.streams[0]!.channels = 2; if (state === 'missing') f.technical.evidence[0]!.kind = 'probe';
      if (state === 'partial') f.technical.evidence[0]!.coverage = 'partial'; if (state === 'samples') f.technical.evidence[0]!.samples!--;
      if (state === 'stream') f.technical.evidence[0]!.streamIndex = 1;
      await f.run(); failed(f, 'skipped', /ASR_(?:FORMAT_UNSUPPORTED|AUDIO_STREAMS_UNSUPPORTED|PCM_UNAVAILABLE)/); assert.equal(f.context.tools.length, 0);
    } finally { f.clean(); }
  }
});
test('source and duration caps skip; a changed source remains global even when over a cap', async () => {
  const cap = fixture({ asr: { maxAsrSourceBytes: 32043 } }); try { await cap.run(); failed(cap, 'skipped', /ASR_SOURCE_LIMIT/); } finally { cap.clean(); }
  const tiny = fixture({}, 3199); try { await tiny.run(); failed(tiny, 'skipped', /ASR_SAMPLES_LIMIT/); assert.equal(tiny.context.tools.length, 0); } finally { tiny.clean(); }
  const changed = fixture(); try { fs.appendFileSync(changed.source, Buffer.from([0])); await assert.rejects(changed.run(), /CATALOG_SOURCE_CHANGED/); changed.empty(); } finally { changed.clean(); }
});
for (const [name, options, reason] of [['zero stdout', { raw: Buffer.alloc(0) }, /ASR_JSON_INVALID/], ['bad JSON', { raw: Buffer.from('garbage') }, /ASR_JSON_INVALID/],
  ['exit', { code: 'process.exit(7)' }, /CATALOG_TOOL_EXIT: 7/], ['timeout', { code: 'setInterval(()=>{},1000)' }, /CATALOG_TOOL_TIME_LIMIT/]] as const) test(`provider failure retains base PCM and records invocation: ${name}`, async () => {
  const f = fixture(name === 'timeout' ? { asr: { maxAsrToolElapsedMs: 150 } } : {}); try { await synthetic(f, options); failed(f, 'failed', reason); assert.equal(f.invocations.length, 1); assert.equal(f.context.counts.decodedAudioBytes, f.baseBytes * 2); } finally { f.clean(); }
});
test('raw exact cap succeeds; one-byte tighter cap fails with accepted bytes retained', async () => {
  const data = raw(), exact = fixture({ asr: { maxAsrRawBytes: data.length } }); try { await synthetic(exact, { raw: data }); assert.equal(exact.technical.asr!.status, 'completed'); } finally { exact.clean(); }
  const above = fixture({ asr: { maxAsrRawBytes: data.length - 1 } }); try { await synthetic(above, { raw: data }); failed(above, 'failed', /ASR_RAW_LIMIT/);
    assert.equal(above.context.tools.at(-1)!.binaryBytes, data.length - 1); assert.equal(above.context.counts.derivedBytes, above.baseBytes * 2 + 44 + data.length - 1);
  } finally { above.clean(); }
});
test('stderr consumes the diagnostics cap and survives local failure', async () => {
  const f = fixture({ maxToolOutputBytes: 4 }); try { await synthetic(f, { stderr: '12345' }); failed(f, 'failed', /CATALOG_TOOL_OUTPUT_LIMIT/); assert.equal(f.context.counts.toolOutputBytes, 4); assert.equal(f.context.tools.at(-1)!.stderr, '1234'); } finally { f.clean(); }
});
test('text and map individual limits remove the whole group while retaining consumption counts', async () => {
  for (const asr of [{ maxAsrTextBytes: 1 }, { maxAsrMapBytes: 1 }, { maxAsrSegmentTextBytes: 1 }, { maxAsrRawSegments: 1 }]) {
    const f = fixture({ asr }); try {
      const data = asr.maxAsrRawSegments ? raw('zh', [{ timestamps: { from: '00:00:00,000', to: '00:00:00,500' }, offsets: { from: 0, to: 500 }, text: ' ' }, { timestamps: { from: '00:00:00,500', to: '00:00:01,000' }, offsets: { from: 500, to: 1000 }, text: 'a' }]) : raw();
      await synthetic(f, { raw: data }); failed(f, 'failed', /ASR_(?:TEXT|MAP|SEGMENT_TEXT|RAW_SEGMENTS)_LIMIT/); assert.equal(f.context.counts.derivedBytes, f.baseBytes * 2 + 44 + data.length);
    } finally { f.clean(); }
  }
});
test('global raw and text/map derived admission errors propagate and clear only ASR files', async () => {
  for (const cap of [64044 + raw().length - 1, 64044 + raw().length]) {
    const f = fixture({ maxDerivedBytes: cap }); try { await assert.rejects(synthetic(f), /CATALOG_DERIVED_LIMIT/); f.empty(); assert.equal(f.invocations.length, 1); } finally { f.clean(); }
  }
});
test('a global check failure inside the binary callback propagates after retaining tool facts', async () => {
  const f = fixture(); let armed = false, thrown = false;
  try {
    f.context.check = () => { if (armed && !thrown) { thrown = true; throw Error('FIXTURE_GLOBAL_CHECK'); } };
    await assert.rejects(synthetic(f, { beforeAsr() { armed = true; } }), /FIXTURE_GLOBAL_CHECK/); f.empty(); assert.equal(f.invocations.length, 1);
  } finally { f.clean(); }
});
for (const target of ['source', 'pcm', 'wav', 'policy', 'cwd'] as const) test(`${target} mutation is global and removes the ASR group`, async () => {
  const f = fixture(); try {
    await assert.rejects(synthetic(f, { beforeAsr(argv, cwd) {
      if (target === 'source' || target === 'pcm') { const path = target === 'source' ? f.source : f.pcmPath, bytes = fs.readFileSync(path); fs.renameSync(path, path + '.old'); fs.writeFileSync(path, bytes); fs.unlinkSync(path + '.old'); }
      if (target === 'wav') fs.appendFileSync(argv.at(-1)!, Buffer.from([0])); if (target === 'policy') f.context.policy.asr.language = 'en'; if (target === 'cwd') fs.writeFileSync(join(cwd, 'unexpected'), 'x');
    } }), /CATALOG_(?:SOURCE|ASR_PCM|ASR_AUDIO|POLICY|ASR_CWD)_CHANGED/); f.empty(); assert.equal(f.invocations.length, 1);
  } finally { f.clean(); }
});
test('read-only runtime hash injection demonstrates post-call identity drift is global', async () => {
  const f = fixture(), read = fs.readSync, open = fs.openSync; let target = -1, changed = false;
  try {
    fs.openSync = ((path: any, ...args: any[]) => { const fd = (open as any)(path, ...args); if (String(path) === paths.program) target = fd; return fd; }) as typeof open;
    fs.readSync = ((fd: number, buffer: Buffer, ...args: any[]) => { const count = (read as any)(fd, buffer, ...args); if (changed && fd === target && count && args[2] === 0) buffer[0] ^= 1; return count; }) as typeof read; syncBuiltinESMExports();
    await assert.rejects(synthetic(f, { beforeAsr() { changed = true; } }), /CATALOG_ASR_RUNTIME_CHANGED/); f.empty();
  } finally { fs.openSync = open; fs.readSync = read; syncBuiltinESMExports(); f.clean(); }
});
test('cancellation records the stopped invocation and cleans the staged group', async () => {
  const f = fixture(), controller = new AbortController(); f.context.signal = controller.signal;
  try { await assert.rejects(synthetic(f, { code: 'setInterval(()=>{},1000)', beforeAsr() { setTimeout(() => controller.abort(Error('FIXTURE_ABORT')), 30); } }), /FIXTURE_ABORT/); f.empty(); assert.equal(f.invocations.length, 1); } finally { f.clean(); }
});
test('invocation recorder failure is global', async () => {
  const f = fixture(); try { f.context.recordAsrInvocation = async () => { throw Error('ASR_FIXTURE_RECORDER_FAILURE'); }; await assert.rejects(synthetic(f), /CATALOG_ASR_COMMAND_FAILED/); f.empty(); } finally { f.clean(); }
});
test('an evidence write error retracts already-written group files', async () => {
  const f = fixture(), open = fsPromises.open; let writes = 0;
  try {
    fsPromises.open = (async (...args: Parameters<typeof open>) => { if (String(args[0]).startsWith(f.context.evidenceDir + '/') && args[1] === 'wx' && ++writes === 3) throw Error('FIXTURE_WRITE_FAILURE'); return open(...args); }) as typeof open; syncBuiltinESMExports();
    await assert.rejects(synthetic(f), /FIXTURE_WRITE_FAILURE/); f.empty(); assert.equal(writes, 3);
  } finally { fsPromises.open = open; syncBuiltinESMExports(); f.clean(); }
});
test('real CPU silence records the tool result and applies the actual PCM boundary', async () => {
  const f = fixture({ asr: { language: 'en' } }); try {
    await f.run();
    if (f.technical.asr!.status === 'failed') failed(f, 'failed', /ASR_JSON_INVALID: segment range/);
    else {
      assert.ok(['completed', 'no-text'].includes(f.technical.asr!.status), f.technical.asr!.reason);
      const map: AsrMap = JSON.parse(f.data('asr-map').toString()); validateAsrMap(map, f.data('text'), f.data('asr-audio'), f.data('asr-json'), asrLimits(f.context.policy));
      assert.equal(map.engine.program.sha256, lock.program.sha256); assert.equal(map.audio.samples, 16000);
    }
    assert.equal(f.invocations.length, 1); assert.ok(f.context.tools.at(-1)!.binaryBytes > 0);
    assert.equal(f.context.tools.at(-1)!.error, null); assert.deepEqual(f.invocations[0]!.contents, []); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), []);
  } finally { f.clean(); }
});
