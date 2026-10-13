import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { inspectImageOcr } from '../src/adapters/inspection-ocr.ts';
import { inspectAsset, runInspectionTool, type InspectContext } from '../src/adapters/inspection.ts';
import { DEFAULT_INSPECT_POLICY, emptyCatalogCounts, type Technical, type ToolRun } from '../src/project/catalog.ts';
import { validateOcrMap, type OcrMap } from '../src/project/ocr.ts';

const engineRoot = dirname(dirname(fileURLToPath(import.meta.url))), output = resolve(engineRoot, '../../.research/out');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n';
const PAGE = '1\t1\t0\t0\t0\t0\t0\t0\t8\t8\t-1\t\n';
const TSV = Buffer.from(HEADER + PAGE + '2\t1\t1\t0\t0\t0\t0\t0\t8\t8\t-1\t\n3\t1\t1\t1\t0\t0\t0\t0\t8\t8\t-1\t\n4\t1\t1\t1\t1\t0\t0\t0\t8\t8\t-1\t\n5\t1\t1\t1\t1\t1\t0\t0\t4\t8\t0\t中\n5\t1\t1\t1\t1\t2\t4\t0\t4\t8\t-1\tABC\n');
const lock = JSON.parse(fs.readFileSync(join(engineRoot, 'ocr-dependencies.lock.json'), 'utf8'));
function chunk(kind: string, bytes: Buffer): Buffer {
  const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(kind, 4, 'ascii'); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
}
function png(animated = false): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(8 * 33, 255); for (let y = 0; y < 8; y++) raw[y * 33] = 0;
  const animation = Buffer.alloc(8); animation.writeUInt32BE(1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), ...(animated ? [chunk('acTL', animation)] : []), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture(overrides: Record<string, any> = {}, data = png()) {
  fs.mkdirSync(output, { recursive: true }); const root = fs.realpathSync(fs.mkdtempSync(join(output, 'inspection-ocr-'))), temporaryDir = join(root, 'tmp'), evidenceDir = join(root, 'evidence');
  fs.mkdirSync(temporaryDir); fs.mkdirSync(evidenceDir); fs.mkdirSync(join(root, '.engine/assets/ocr/tessdata'), { recursive: true });
  for (const model of lock.models) fs.copyFileSync(join(engineRoot, model.path), join(root, '.engine', model.path));
  const source = join(root, 'source.png'); fs.writeFileSync(source, data);
  const id = `evidence-${randomUUID()}`, name = `${id}.png`; fs.writeFileSync(join(evidenceDir, name), png());
  const technical: Technical = { status: 'supported', format: 'png_pipe', method: 'fixture', reason: '', raw: '{}', streams: [], text: null, containerDuration: null,
    limitations: [], evidence: [{ id, kind: 'preview', path: `evidence/${name}`, bytes: png().length, sha256: hash(png()), width: 8, height: 8, sourceWidth: 8, sourceHeight: 8,
      transform: 'fixture', streamIndex: null, timeBase: null, pts: null, requestedTime: null, actualTime: null, sampleRate: null, samples: null, coverage: 'full' }] };
  const policy = { ...DEFAULT_INSPECT_POLICY, ...overrides, ocr: { ...DEFAULT_INSPECT_POLICY.ocr, ...overrides.ocr } };
  const context: InspectContext = { projectDir: root, temporaryDir, evidenceDir, publishedDir: 'evidence', policy, counts: emptyCatalogCounts(), tools: [], signal: new AbortController().signal,
    check() {}, sourceBytes: data.length, sourceSha256: hash(data), policySha256: 'a'.repeat(64) };
  return { root, source, technical, context, clean() { fs.rmSync(root, { recursive: true, force: true }); },
    async run() { return inspectImageOcr(source, 'png_pipe', technical, context); },
    data(kind: string) { return fs.readFileSync(join(root, technical.evidence.find(e => e.kind === kind)!.path)); },
    empty() { assert.deepEqual(fs.readdirSync(temporaryDir), []); assert.equal(fs.readdirSync(evidenceDir).length, 1); assert.equal(technical.evidence.length, 1); } };
}
async function synthetic(f: ReturnType<typeof fixture>, options: { tsv?: Buffer; stderr?: string; code?: string; beforeOcr?: () => void } = {}) {
  const spawn = childProcess.spawn; const calls: { executable: string; argv: readonly string[]; options: any }[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: readonly string[], spawnOptions: any) => {
      calls.push({ executable, argv, options: spawnOptions });
      if (executable === lock.tools.ffmpeg.executable) return spawn(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(256,255))'], spawnOptions);
      if (executable === lock.tools.tesseract.executable) {
        options.beforeOcr?.(); const code = options.code ?? `process.stderr.write(${JSON.stringify(options.stderr ?? '')});process.stdout.write(Buffer.from(${JSON.stringify((options.tsv ?? TSV).toString('base64'))},'base64'))`;
        return spawn(process.execPath, ['-e', code], spawnOptions);
      }
      return spawn(executable, argv, spawnOptions);
    }) as typeof spawn; syncBuiltinESMExports();
    const result = await f.run(); return { result, calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
function failed(f: ReturnType<typeof fixture>, status: 'failed' | 'skipped', reason: RegExp) {
  assert.equal(f.technical.status, 'partial'); assert.equal(f.technical.ocr!.status, status); assert.match(f.technical.ocr!.reason, reason);
  assert.equal(f.technical.ocr!.regions, 0); for (const key of ['rasterEvidenceId', 'tsvEvidenceId', 'textEvidenceId', 'mapEvidenceId'] as const) assert.equal(f.technical.ocr![key], null);
  assert.equal(f.technical.text, null); f.empty();
}

test('native blank PNG preserves preview and publishes a validated no-text four-file group', async () => {
  const f = fixture(); try {
    await f.run(); assert.equal(f.technical.status, 'supported', f.technical.reason); assert.equal(f.technical.ocr!.status, 'no-text'); assert.equal(f.technical.ocr!.regions, 0);
    const map: OcrMap = JSON.parse(f.data('ocr-map').toString()); validateOcrMap(map, f.data('text'), f.data('ocr-raster'), f.data('ocr-tsv'), f.context.policy.ocr);
    assert.equal(map.policySha256, f.context.policySha256); assert.equal(map.source.sha256, f.context.sourceSha256); assert.deepEqual(map.regions, []);
    assert.deepEqual(f.technical.text, { bytes: 0, lines: 1, bom: false, lineEndings: 'none' }); assert.equal(f.technical.evidence.length, 5); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), []);
  } finally { f.clean(); }
});
test('fixed argv, minimal OCR env, map/range identities and accepted output accounting', async () => {
  const f = fixture(); try {
    const { calls } = await synthetic(f, { stderr: 'fixture diagnostic\n' }); const map: OcrMap = JSON.parse(f.data('ocr-map').toString());
    assert.equal(f.technical.ocr!.status, 'completed'); assert.equal(f.technical.ocr!.regions, 2); assert.equal(f.data('text').toString(), '中 ABC');
    assert.deepEqual(map.regions.map(r => [r.row, r.engineConfidence, r.byteStart, r.byteEnd]), [[5, 0, 0, 3], [6, null, 4, 7]]);
    validateOcrMap(map, f.data('text'), f.data('ocr-raster'), f.data('ocr-tsv'), f.context.policy.ocr);
    const ocr = calls.find(c => c.executable === lock.tools.tesseract.executable)!;
    assert.match(ocr.argv[0]!, /\/tmp\/ocr-[a-f0-9-]+\/raster\.ppm$/);
    assert.deepEqual(ocr.argv.slice(1), ['stdout', '--tessdata-dir', join(f.root, '.engine/assets/ocr/tessdata'), '-l', 'chi_sim+eng+~chi_sim_vert', '--oem', '1', '--psm', '3', '--dpi', '300', '-c', 'tessedit_create_tsv=1', '-c', 'tessedit_create_txt=0']);
    assert.equal(ocr.options.env.OMP_THREAD_LIMIT, '1'); assert.deepEqual(Object.keys(ocr.options.env).sort(), ['LANG', 'OMP_THREAD_LIMIT', 'OPENSSL_CONF', 'PATH', 'TMPDIR']);
    assert.ok(f.context.tools.every(t => t.stdout === '' && t.stdoutBytes === 0)); assert.match(f.context.tools.at(-1)!.version, /\/ocr-tsv@0\.1$/);
    assert.equal(f.context.tools.at(-1)!.binaryBytes, TSV.length); assert.equal(f.context.counts.toolOutputBytes, Buffer.byteLength('fixture diagnostic\n'));
    assert.equal(f.context.counts.derivedBytes, 256 + f.technical.evidence.slice(1).reduce((sum, e) => sum + e.bytes, 0));
    const raster = f.technical.evidence[1]!; assert.equal(raster.transform, 'identity; white background; autorotate disabled'); assert.equal(raster.width, 8); assert.equal(raster.sourceWidth, 8);
    assert.ok(f.technical.evidence.slice(1).every(e => e.coverage === 'full')); assert.equal(fs.readdirSync(f.context.evidenceDir).length, 5); assert.deepEqual(fs.readdirSync(f.context.temporaryDir), []);
  } finally { f.clean(); }
});
test('disabled and unavailable generic preview use explicit empty references', async () => {
  for (const state of ['disabled', 'failed', 'no-preview'] as const) {
    const f = fixture(state === 'disabled' ? { ocr: { enabled: false } } : {}); try {
      if (state === 'failed') { f.technical.status = 'failed'; f.technical.reason = 'probe failed'; }
      if (state === 'no-preview') f.technical.evidence[0]!.kind = 'probe';
      await f.run(); assert.equal(f.technical.ocr!.status, state === 'disabled' ? 'disabled' : 'skipped'); assert.equal(f.technical.ocr!.engine, null);
      assert.equal(f.technical.status, state === 'disabled' ? 'supported' : state === 'failed' ? 'failed' : 'partial'); assert.equal(f.context.tools.length, 0); assert.equal(f.context.counts.derivedBytes, 0);
      if (state === 'failed') assert.match(f.technical.reason, /^probe failed/); f.empty();
    } finally { f.clean(); }
  }
});
test('successful OCR keeps a generic partial preview and its reason', async () => {
  const f = fixture(); try { f.technical.status = 'partial'; f.technical.reason = 'generic metadata incomplete'; await synthetic(f); assert.equal(f.technical.status, 'partial'); assert.equal(f.technical.reason, 'generic metadata incomplete'); assert.equal(f.technical.ocr!.status, 'completed'); } finally { f.clean(); }
});
test('APNG range is skipped with the existing preview retained', async () => {
  const f = fixture({}, png(true)); try { await f.run(); failed(f, 'skipped', /^OCR_FORMAT_UNSUPPORTED: APNG/); assert.equal(f.context.tools.length, 0); } finally { f.clean(); }
});
test('unchanged source over the OCR cap is skipped; a grown source aborts before the cap decision', async () => {
  const above = fixture({ ocr: { maxOcrSourceBytes: png().length - 1 } }); try { await above.run(); failed(above, 'skipped', /^OCR_SOURCE_LIMIT/); assert.equal(above.context.tools.length, 0); } finally { above.clean(); }
  const changed = fixture({ ocr: { maxOcrSourceBytes: png().length } }); try { fs.appendFileSync(changed.source, Buffer.from([0])); await assert.rejects(changed.run(), /CATALOG_SOURCE_CHANGED/); changed.empty(); } finally { changed.clean(); }
});
for (const stderr of ['Failed loading language chi_sim', 'Error opening data file chi_sim.traineddata', 'Error: LSTM requested, but not present!! Loading tesseract.', 'Error: Tesseract (legacy) engine requested, but components are not present in chi_sim!!', "Tesseract couldn't load any languages!", 'Could not initialize tesseract.']) test(`initialization diagnostic rejected: ${stderr}`, async () => {
  const f = fixture(); try { await synthetic(f, { stderr }); failed(f, 'failed', /^OCR_INITIALIZATION_DEGRADED/); assert.equal(f.context.counts.derivedBytes, 256 + 203 + TSV.length); assert.equal(f.context.counts.toolOutputBytes, Buffer.byteLength(stderr)); } finally { f.clean(); }
});
for (const [name, options, reason] of [['zero stdout', { tsv: Buffer.alloc(0) }, /OCR_TSV_INVALID/], ['invalid TSV', { tsv: Buffer.from('garbage') }, /OCR_TSV_INVALID/], ['exit', { code: 'process.exit(7)' }, /CATALOG_TOOL_EXIT: 7/], ['timeout', { code: 'setInterval(()=>{},1000)' }, /CATALOG_TOOL_TIME_LIMIT/]] as const) test(`tool/protocol failure retains preview: ${name}`, async () => {
  const f = fixture(name === 'timeout' ? { maxToolElapsedMs: 200 } : {}); try { await synthetic(f, options); failed(f, 'failed', reason); assert.ok(f.context.counts.derivedBytes >= 256 + 203); } finally { f.clean(); }
});
test('stderr quota retains exact accepted diagnostic bytes and rejects the tool result', async () => {
  const f = fixture({ maxToolOutputBytes: 4 }); try { await synthetic(f, { stderr: '12345' }); failed(f, 'failed', /CATALOG_TOOL_OUTPUT_LIMIT/); assert.equal(f.context.counts.toolOutputBytes, 4); } finally { f.clean(); }
});
test('TSV exact cap accepts; one extra byte is skipped and retained in accepted-byte accounting', async () => {
  const exact = fixture({ ocr: { maxOcrTsvBytes: TSV.length } }); try { await synthetic(exact); assert.equal(exact.technical.ocr!.status, 'completed'); } finally { exact.clean(); }
  const above = fixture({ ocr: { maxOcrTsvBytes: TSV.length - 1 } }); try { await synthetic(above); failed(above, 'skipped', /^OCR_TSV_LIMIT/); assert.equal(above.context.tools.at(-1)!.binaryBytes, TSV.length - 1); assert.equal(above.context.counts.derivedBytes, 256 + 203 + TSV.length - 1); } finally { above.clean(); }
});
test('map exact cap accepts; one-byte smaller cap publishes no OCR evidence', async () => {
  const first = fixture(); let bytes: number; try { await synthetic(first); bytes = first.data('ocr-map').length; } finally { first.clean(); }
  const exact = fixture({ ocr: { maxOcrMapBytes: bytes } }); try { await synthetic(exact); assert.equal(exact.technical.ocr!.status, 'completed'); } finally { exact.clean(); }
  const above = fixture({ ocr: { maxOcrMapBytes: bytes - 1 } }); try { await synthetic(above); failed(above, 'skipped', /^OCR_MAP_LIMIT/); assert.equal(above.context.counts.derivedBytes, 256 + 203 + TSV.length); } finally { above.clean(); }
});
test('project model missing or changed fails before decoding with no host model mutation', async () => {
  for (const action of ['missing', 'changed'] as const) {
    const f = fixture(); try { const path = join(f.root, '.engine/assets/ocr/tessdata/chi_sim.traineddata'); if (action === 'missing') fs.unlinkSync(path); else fs.writeFileSync(path, Buffer.alloc(lock.models[1].bytes));
      await f.run(); failed(f, 'failed', /^OCR_RUNTIME_UNAVAILABLE/); assert.equal(f.context.tools.length, 0);
    } finally { f.clean(); }
  }
});
test('external native identity mismatch fails before decoding, using a read-only hash injection', async () => {
  const f = fixture(), read = fs.readSync, open = fs.openSync; let target = -1;
  try {
    fs.openSync = ((path: any, ...args: any[]) => { const fd = (open as any)(path, ...args); if (String(path) === lock.tools.tesseract.executable) target = fd; return fd; }) as typeof open;
    fs.readSync = ((fd: number, buffer: Buffer, ...args: any[]) => { const count = (read as any)(fd, buffer, ...args); if (fd === target && count && args[2] === 0) buffer[0] ^= 1; return count; }) as typeof read; syncBuiltinESMExports();
    await f.run(); failed(f, 'failed', /OCR_RUNTIME_CHANGED: tesseract/); assert.equal(f.context.tools.length, 0);
  } finally { fs.openSync = open; fs.readSync = read; syncBuiltinESMExports(); f.clean(); }
});
test('runtime model mutation after native execution rejects the whole evidence group', async () => {
  const f = fixture(); try { await synthetic(f, { beforeOcr() { fs.writeFileSync(join(f.root, '.engine/assets/ocr/tessdata/eng.traineddata'), Buffer.alloc(lock.models[0].bytes)); } }); failed(f, 'failed', /OCR_RUNTIME_MODEL_CHANGED: eng/); assert.equal(f.context.counts.derivedBytes, 256 + 203 + TSV.length); } finally { f.clean(); }
});
test('source changed during native execution aborts the batch and clears own staging', async () => {
  const f = fixture(); try { await assert.rejects(synthetic(f, { beforeOcr() { const bytes = fs.readFileSync(f.source); bytes[bytes.length - 1]! ^= 1; fs.writeFileSync(f.source, bytes); } }), /CATALOG_SOURCE_CHANGED/); f.empty(); } finally { f.clean(); }
});
test('global derived cap and a callback check failure propagate and clean the group', async () => {
  const quota = fixture({ maxDerivedBytes: 256 + 203 + TSV.length - 1 }); try { await assert.rejects(synthetic(quota), /CATALOG_DERIVED_LIMIT/); quota.empty(); assert.equal(quota.context.counts.derivedBytes, 256 + 203); } finally { quota.clean(); }
  const checked = fixture(); let armed = false, thrown = false; try {
    checked.context.check = () => { if (armed && !thrown) { thrown = true; throw new Error('FICTIONAL_GLOBAL_CHECK'); } };
    await assert.rejects(synthetic(checked, { beforeOcr() { armed = true; } }), /FICTIONAL_GLOBAL_CHECK/); checked.empty();
  } finally { checked.clean(); }
});
test('global derived cap at text/map admission aborts before any group file is published', async () => {
  const f = fixture({ maxDerivedBytes: 256 + 203 + TSV.length }); try { await assert.rejects(synthetic(f), /CATALOG_DERIVED_LIMIT/); assert.equal(f.context.counts.derivedBytes, 256 + 203 + TSV.length); f.empty(); } finally { f.clean(); }
});
test('cancellation propagates and cleans staging while preserving prior preview', async () => {
  const f = fixture(), controller = new AbortController(); f.context.signal = controller.signal;
  try { await assert.rejects(synthetic(f, { code: 'setInterval(()=>{},1000)', beforeOcr() { setTimeout(() => controller.abort(new Error('FICTIONAL_ABORT')), 30); } }), /FICTIONAL_ABORT/); f.empty(); } finally { f.clean(); }
});
test('evidence write failure aborts the batch and removes already-created group files', async () => {
  const f = fixture(), open = fsPromises.open; let count = 0;
  try {
    fsPromises.open = (async (...args: Parameters<typeof open>) => {
      if (String(args[0]).startsWith(f.context.evidenceDir + '/') && args[1] === 'wx' && ++count === 2) throw Object.assign(new Error('FICTIONAL_EACCES'), { code: 'EACCES' });
      return open(...args);
    }) as typeof open; syncBuiltinESMExports();
    await assert.rejects(synthetic(f), /FICTIONAL_EACCES/); assert.equal(count, 2); f.empty();
  } finally { fsPromises.open = open; syncBuiltinESMExports(); f.clean(); }
});

async function assertOwnedChildExited(pid: number): Promise<void> {
  const deadline = performance.now() + 2000;
  for (;;) {
    const state = childProcess.spawnSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: Math.max(1, Math.ceil(deadline - performance.now())) });
    assert.equal(state.error, undefined); const status = state.stdout.trim();
    if ((state.status === 1 && status === '') || (state.status === 0 && status.startsWith('Z'))) return;
    assert.equal(state.status, 0, state.stderr);
    if (performance.now() >= deadline) assert.fail(`owned child ${pid} did not exit: ${status}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Darwin zombie-group retry preserves the callback quota reason in five trials', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture(), kill = process.kill; let eperm = 0;
  try {
    process.kill = ((...args: Parameters<typeof kill>) => { try { return kill(...args); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') eperm++; throw error; } }) as typeof kill;
    for (let i = 0; i < 5; i++) {
      const runs: ToolRun[] = [];
      const run = await runInspectionTool({ executable: process.execPath, version: process.version, argv: ['-e', "process.stdout.write('ready')"], cwd: f.root,
        policy: { ...DEFAULT_INSPECT_POLICY, maxToolElapsedMs: 2000 }, binaryLimit: 5,
        binary: async () => { const end = performance.now() + 25; while (performance.now() < end) {} throw new Error('CATALOG_DERIVED_LIMIT'); }, onRun: value => runs.push(value) });
      assert.equal(run.error, 'CATALOG_DERIVED_LIMIT'); assert.equal(run.exitCode, 0); assert.equal(run.binaryBytes, 0); assert.equal(runs.length, 1); assert.ok(run.elapsedMs < 1500);
    }
    assert.ok(eperm >= 1, 'the real Darwin zombie window must be exercised');
  } finally { process.kill = kill; f.clean(); }
});
test('an exited leader retains an actual group signal for a live descendant', async () => {
  const f = fixture(), spawn = childProcess.spawn, kill = process.kill; let child: ReturnType<typeof spawn> | undefined, descendant = 0, exited = false, groupSignals = 0;
  const exit = Promise.withResolvers<void>();
  try {
    childProcess.spawn = ((...args: Parameters<typeof spawn>) => { child = spawn(...args); child.once('exit', () => { exited = true; exit.resolve(); }); return child; }) as typeof spawn;
    process.kill = ((pid: number, signal: any) => { if (pid === -child!.pid! && signal === 'SIGKILL') { assert.equal(exited, true); groupSignals++; } return kill(pid, signal); }) as typeof kill;
    syncBuiltinESMExports();
    const run = await runInspectionTool({ executable: process.execPath, version: process.version,
      argv: ['-e', "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});c.unref();process.stdout.write(String(c.pid))"], cwd: f.root,
      policy: { ...DEFAULT_INSPECT_POLICY, maxToolElapsedMs: 2000 }, binaryLimit: 32,
      binary: async bytes => { descendant = Number(bytes.toString()); await exit.promise; assert.equal(kill(descendant, 0), true); throw new Error('CATALOG_DERIVED_LIMIT'); } });
    assert.equal(run.error, 'CATALOG_DERIVED_LIMIT'); assert.ok(groupSignals >= 1); assert.equal(exited, true);
    await assertOwnedChildExited(descendant);
  } finally {
    childProcess.spawn = spawn; process.kill = kill; syncBuiltinESMExports();
    if (child?.pid) { try { kill(-child.pid, 'SIGKILL'); } catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code!)) throw error; } }
    f.clean();
  }
});
test('persistent signal refusal rejects callback/timer paths, records the run and releases the isolated parent', async () => {
  const f = fixture();
  try { for (const trigger of ['callback', 'timer']) {
    const script = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      const {runInspectionTool}=await import(${JSON.stringify(new URL('../src/adapters/inspection.ts', import.meta.url).href)});
      const {DEFAULT_INSPECT_POLICY}=await import(${JSON.stringify(new URL('../src/project/catalog.ts', import.meta.url).href)});
      const spawn=cp.spawn,kill=process.kill;let pid=0,runs=0,uncaught=[],unhandled=[],record;
      process.on('uncaughtExceptionMonitor',e=>uncaught.push(e.message));process.on('unhandledRejection',e=>unhandled.push(String(e)));
      cp.spawn=(...args)=>{const child=spawn(...args);pid=child.pid;console.log(JSON.stringify({phase:'spawned',pid}));return child};syncBuiltinESMExports();
      process.kill=(target,signal)=>{if(target===-pid)throw Object.assign(new Error('FICTIONAL_LIVE_GROUP_EPERM'),{code:'EPERM'});return kill(target,signal)};
      let failure;try{await runInspectionTool({executable:process.execPath,version:process.version,argv:['-e',${JSON.stringify(trigger === 'callback' ? "process.stdout.write('ready');setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)')}],cwd:${JSON.stringify(f.root)},
        policy:{...DEFAULT_INSPECT_POLICY,maxToolElapsedMs:${trigger === 'timer' ? 50 : 2000}},binaryLimit:5,
        binary:async()=>{throw new Error('CATALOG_DERIVED_LIMIT')},onRun:value=>{runs++;record=value}})}catch(error){failure=error.message}finally{cp.spawn=spawn;process.kill=kill;syncBuiltinESMExports()}
      console.log(JSON.stringify({phase:'result',pid,failure,runs,record,uncaught,unhandled}));`;
    // The outer deadline includes module startup; elapsedMs below checks the product deadline.
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    const entries = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), spawned = entries.find(e => e.phase === 'spawned'), finished = entries.find(e => e.phase === 'result');
    try {
      assert.equal(result.status, 0, result.stderr || String(result.error)); assert.equal(result.error, undefined); assert.ok(spawned && finished);
      assert.match(finished.failure, /^CATALOG_TOOL_TERMINATION_FAILED: EPERM$/); assert.equal(finished.runs, 1); assert.equal(finished.record.error, finished.failure);
      assert.ok(finished.record.elapsedMs >= 200 && finished.record.elapsedMs < 1500); assert.deepEqual(finished.uncaught, []); assert.deepEqual(finished.unhandled, []);
      assert.equal(process.kill(spawned.pid, 0), true, 'owned refused tool is still alive when the parent has exited');
    } finally {
      if (spawned?.pid) { try { process.kill(-spawned.pid, 'SIGKILL'); } catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code!)) throw error; }
        await assertOwnedChildExited(spawned.pid); }
    }
  } } finally { f.clean(); }
});
test('generic inspection propagates termination failure to the batch boundary', async () => {
  const f = fixture({ ocr: { enabled: false } }), spawn = childProcess.spawn, failure = new Error('CATALOG_TOOL_TERMINATION_FAILED: EPERM'); let invoked = false;
  try {
    childProcess.spawn = (() => { invoked = true; throw failure; }) as typeof spawn; syncBuiltinESMExports();
    await assert.rejects(inspectAsset(f.source, 'source.png', f.context), error => error === failure); assert.equal(invoked, true);
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); f.clean(); }
});
