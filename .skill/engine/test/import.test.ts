import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NodeImportFiles } from '../src/adapters/import-files.ts';
import { importOriginals, verifyImport } from '../src/application/import.ts';
import { IMPORT_MANIFEST_SCHEMA, IMPORT_POLICY_SCHEMA, IMPORT_RECEIPT_SCHEMA, validateImportManifest, validateImportPolicy, validateImportReceipt } from '../src/project/import.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const IMPORT_MODULE = fileURLToPath(new URL('../src/application/import.ts', import.meta.url));
const DEFAULT_LIMITS = { maxFileBytes: 1073741824, maxTotalBytes: 4294967296, maxFiles: 5000, maxDepth: 16 };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = (value: any): any => JSON.parse(JSON.stringify(value));

function fixture() {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out');
  mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'import-fixture-')));
  const projects = join(root, 'projects');
  const dir = initProject({ slug: 'import-fixture', projectsRoot: projects }).dir;
  const source = join(root, 'source with spaces.txt');
  writeFileSync(source, 'fictional original bytes');
  return { root, projects, dir, source, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function receiptPath(dir: string, receipt: any) { return join(dir, 'runs', receipt.attemptId, 'receipt.json'); }
function manifestPath(dir: string, receipt: any) { return join(dir, 'inputs/imports', receipt.importId, 'manifest.json'); }
function originalPath(dir: string, receipt: any, path: string) { return join(dir, 'inputs/original', receipt.importId, path); }
function current(dir: string) { return readFileSync(join(dir, 'inputs/import.json')); }
function setPolicy(dir: string, limits: Partial<typeof DEFAULT_LIMITS>) {
  const path = join(dir, 'inputs/import-policy.json');
  const policy = json(path);
  Object.assign(policy, limits);
  writeFileSync(path, JSON.stringify(policy));
  return policy;
}
function assertStoredReceipt(dir: string, receipt: any) {
  assert.deepEqual(validateImportReceipt(receipt), []);
  assert.deepEqual(json(receiptPath(dir, receipt)), receipt);
}
async function failed(dir: string, source: string, options?: Parameters<typeof importOriginals>[2]): Promise<any> {
  let error: any;
  try { await importOriginals(dir, source, options); }
  catch (caught) { error = caught; }
  assert.ok(error, 'the rejected import must fail');
  assert.ok(error.receipt, String(error));
  assert.ok(['failed', 'interrupted'].includes(error.receipt.status), JSON.stringify(error.receipt));
  assertStoredReceipt(dir, error.receipt);
  return error.receipt;
}
function reason(receipt: any) {
  return JSON.stringify({ error: receipt.error, items: receipt.items });
}

function childImporter(dir: string, source: string, pause?: { target: string; stage: 'before' | 'after' }) {
  const script = `import fs from 'node:fs/promises';
    import { readFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const pause = ${JSON.stringify(pause ?? null)}, rename = fs.rename;
    async function stopAt(path) {
      const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
      const continued = new Promise(resolve => process.once('message', resolve));
      await new Promise(resolve => process.send({ attemptId: owner.attemptId, pid: owner.pid }, resolve));
      await continued;
    }
    fs.rename = async (...args) => {
      const selected = pause && String(args[1]) === pause.target;
      if (selected && pause.stage === 'before') await stopAt(String(args[0]));
      await rename(...args);
      if (selected && pause.stage === 'after') await stopAt(String(args[1]));
    };
    syncBuiltinESMExports();
    const { importOriginals } = await import(${JSON.stringify(IMPORT_MODULE)});
    try { console.log(JSON.stringify({ ok: true, receipt: await importOriginals(${JSON.stringify(dir)}, ${JSON.stringify(source)}) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, message: error.message, receipt: error.receipt })); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', bytes => { stdout += bytes.toString(); });
  child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const paused = pause ? new Promise<{ attemptId: string; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('importer did not reach lock rename: ' + stderr + stdout)), 5000);
    child.once('message', value => { clearTimeout(timer); resolve(value as { attemptId: string; pid: number }); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`importer exited ${code} before lock rename: ${stderr}${stdout}`)); });
  }) : undefined;
  return { child, paused, exited };
}

test('one selected file with spaces is copied independently with complete bytes and hash identity', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.source);
    const receipt = await importOriginals(f.dir, f.source);
    assert.equal(receipt.status, 'succeeded');
    assertStoredReceipt(f.dir, receipt);
    const manifest = await verifyImport(f.dir, receipt.importId);
    assert.deepEqual(validateImportManifest(manifest), []);
    const file = manifest.entries.find((item: any) => item.kind === 'file');
    assert.ok(file);
    assert.equal(file.path, 'source with spaces.txt');
    assert.equal(file.bytes, before.length);
    assert.equal(file.sha256, hash(before));
    assert.deepEqual(manifest.totals, { files: 1, bytes: before.length });
    assert.equal(receipt.manifestSha256, hash(readFileSync(manifestPath(f.dir, receipt))));
    assert.deepEqual(receipt.counts, { discoveredFiles: 1, copiedFiles: 1, copiedBytes: before.length });
    const copy = originalPath(f.dir, receipt, file.path);
    assert.deepEqual(readFileSync(copy), before);
    assert.deepEqual(readFileSync(f.source), before);
    assert.equal(lstatSync(copy).isSymbolicLink(), false);
    assert.equal(lstatSync(copy).nlink, 1);
    assert.notEqual(lstatSync(copy).ino, lstatSync(f.source).ino);
    assert.equal(json(join(f.dir, 'inputs/import.json')).currentImportId, receipt.importId);
    writeFileSync(f.source, 'later source edit');
    assert.deepEqual(readFileSync(copy), before);
    rmSync(f.source);
    assert.deepEqual((await verifyImport(f.dir, receipt.importId)).totals, manifest.totals);
  } finally { f.cleanup(); }
});

test('multilevel directories preserve relative structure, binary bytes and empty folders', async () => {
  const f = fixture();
  try {
    const source = join(f.root, 'directory source');
    mkdirSync(join(source, 'first/second'), { recursive: true });
    mkdirSync(join(source, 'empty'), { recursive: true });
    const files: Record<string, Buffer> = { 'root.txt': Buffer.from('root data'), 'first/second/binary.bin': Buffer.from([0, 1, 255, 0, 13, 10]) };
    for (const [path, bytes] of Object.entries(files)) writeFileSync(join(source, path), bytes);
    const receipt = await importOriginals(f.dir, source), manifest = await verifyImport(f.dir, receipt.importId);
    assert.equal(receipt.status, 'succeeded');
    assert.equal(manifest.entries.every((item: any) => item.status === 'received'), true);
    assert.deepEqual(manifest.entries.filter((item: any) => item.kind === 'file').map((item: any) => item.path).sort(), Object.keys(files).sort());
    for (const [path, bytes] of Object.entries(files)) {
      const item = manifest.entries.find((entry: any) => entry.path === path);
      assert.equal(item.bytes, bytes.length);
      assert.equal(item.sha256, hash(bytes));
      assert.deepEqual(readFileSync(originalPath(f.dir, receipt, path)), bytes);
      assert.deepEqual(readFileSync(join(source, path)), bytes);
    }
    assert.ok(manifest.entries.some((item: any) => item.path === 'empty' && item.kind === 'directory'));
    assert.equal(lstatSync(originalPath(f.dir, receipt, 'empty')).isDirectory(), true);
    assert.equal(manifest.totals.files, 2);
    assert.equal(manifest.totals.bytes, Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0));
    assertStoredReceipt(f.dir, receipt);
  } finally { f.cleanup(); }
});

test('same source name with replaced bytes creates a new batch and retains the old original', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.source), first = await importOriginals(f.dir, f.source);
    writeFileSync(f.source, 'new fictional replacement');
    const second = await importOriginals(f.dir, f.source);
    assert.notEqual(second.importId, first.importId);
    assert.notEqual(second.attemptId, first.attemptId);
    assert.deepEqual(readFileSync(originalPath(f.dir, first, 'source with spaces.txt')), before);
    assert.equal(readFileSync(originalPath(f.dir, second, 'source with spaces.txt'), 'utf8'), 'new fictional replacement');
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, second.importId);
    const index = json(join(f.dir, 'inputs/import.json'));
    assert.equal(index.currentImportId, second.importId);
    assert.equal(index.imports.length, 2);
    assert.ok(index.imports.some((item: any) => item.importId === first.importId));
    assert.ok(index.imports.some((item: any) => item.importId === second.importId));
  } finally { f.cleanup(); }
});

test('project policy defaults and per-attempt snapshots record adopted limits and actual counts', async () => {
  const f = fixture();
  try {
    const first = await importOriginals(f.dir, f.source);
    const policyPath = join(f.dir, 'inputs/import-policy.json'), policy = json(policyPath);
    for (const [name, value] of Object.entries(DEFAULT_LIMITS)) assert.equal(policy[name], value);
    assert.deepEqual(validateImportPolicy(policy), []);
    assert.deepEqual(first.policy, policy);
    const snapshotPath = join(f.dir, 'runs', first.attemptId, 'import-policy.json');
    assert.deepEqual(json(snapshotPath), policy);
    assert.equal(first.policySha256, hash(readFileSync(snapshotPath)));
    assert.deepEqual(readFileSync(join(f.dir, 'runs', first.attemptId, 'import-policy.source.json')), readFileSync(policyPath));
    assert.equal(first.policySourceSha256, hash(readFileSync(policyPath)));
    const adopted = setPolicy(f.dir, { maxFileBytes: 40, maxTotalBytes: 50, maxFiles: 2, maxDepth: 2 });
    const second = await importOriginals(f.dir, f.source, { hooks: { onPhase(phase) {
      if (phase === 'copying') setPolicy(f.dir, { maxFileBytes: 1, maxTotalBytes: 1 });
    } } });
    assert.equal(second.status, 'succeeded');
    assert.deepEqual(second.policy, adopted);
    assert.deepEqual(json(join(f.dir, 'runs', second.attemptId, 'import-policy.json')), adopted);
    assert.deepEqual(json(snapshotPath), policy);
    assert.equal(second.counts.copiedBytes, readFileSync(f.source).length);
    const third = await failed(f.dir, f.source);
    assert.equal(third.policy.maxFileBytes, 1);
    assert.match(reason(third), /limit|bytes|size/i);
  } finally { f.cleanup(); }
});

test('malformed project policies fail with a local receipt and retain the valid current batch', async () => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), path = join(f.dir, 'inputs/import-policy.json'), valid = json(path);
    const variants = [
      { ...valid, maxFiles: -1 }, { ...valid, maxDepth: 1.5 },
      { ...valid, maxFileBytes: -1 }, { ...valid, maxTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, unexpected: true }, { ...valid, maxFiles: '2' },
    ];
    for (const policy of variants) {
      writeFileSync(path, JSON.stringify(policy));
      const receipt = await failed(f.dir, f.source);
      assert.match(reason(receipt), /policy|schema/i);
      assert.deepEqual(current(f.dir), previous);
      assert.equal(readFileSync(join(f.dir, 'runs', receipt.attemptId, 'import-policy.source.json'), 'utf8'), JSON.stringify(policy));
      assert.equal(receipt.policySourceSha256, hash(JSON.stringify(policy)));
    }
    writeFileSync(path, '{ invalid json');
    const receipt = await failed(f.dir, f.source);
    assert.match(reason(receipt), /policy|json/i);
    assert.deepEqual(current(f.dir), previous);
    assert.equal(readFileSync(join(f.dir, 'runs', receipt.attemptId, 'import-policy.source.json'), 'utf8'), '{ invalid json');
    assert.equal(receipt.policySourceSha256, hash('{ invalid json'));
  } finally { f.cleanup(); }
});

test('manifest, receipt and policy contracts reject unknown fields, absent identity and malformed hashes', async () => {
  const f = fixture();
  try {
    const receipt = await importOriginals(f.dir, f.source), manifest = await verifyImport(f.dir, receipt.importId);
    const policy = json(join(f.dir, 'inputs/import-policy.json'));
    for (const schema of [IMPORT_MANIFEST_SCHEMA, IMPORT_POLICY_SCHEMA, IMPORT_RECEIPT_SCHEMA]) {
      assert.equal((schema as any).$schema, 'http://json-schema.org/draft-07/schema#');
    }
    for (const [validator, value] of [[validateImportPolicy, policy], [validateImportManifest, manifest], [validateImportReceipt, receipt]] as const) {
      assert.deepEqual(validator(value), []);
      assert.ok(validator({ ...value, undeclared: true }).length);
      const incomplete = clone(value); delete incomplete.version;
      assert.ok(validator(incomplete).length);
    }
    const malformed = clone(manifest);
    malformed.entries.find((item: any) => item.kind === 'file').sha256 = 'untrusted hash';
    assert.ok(validateImportManifest(malformed).length);
    const escaping = clone(manifest); escaping.entries[0].path = '../escape.txt';
    assert.ok(validateImportManifest(escaping).length);
    const absolute = clone(manifest); absolute.originalsPath = '/outside/project';
    assert.ok(validateImportManifest(absolute).length);
    const wrongReceipt = clone(receipt); wrongReceipt.policySha256 = 'a'.repeat(63);
    assert.ok(validateImportReceipt(wrongReceipt).length);
    assert.ok(validateImportReceipt({ ...receipt, policySourceSha256: null }).length);
    const nestedExtra = clone(manifest); nestedExtra.entries[0].undeclared = true;
    assert.ok(validateImportManifest(nestedExtra).length);
  } finally { f.cleanup(); }
});

test('changed raw policy snapshot fails before adoption and retains the current batch', async t => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), readJson = NodeImportFiles.prototype.readJson;
    t.mock.method(NodeImportFiles.prototype, 'readJson', async function (path: string) {
      const value = await readJson.call(this, path);
      if (path.endsWith('/import-policy.source.json')) appendFileSync(path, '\n ');
      return value;
    });
    const receipt = await failed(f.dir, f.source);
    assert.match(reason(receipt), /IMPORT_POLICY_SNAPSHOT_CHANGED/);
    assert.equal(receipt.policy, null);
    assert.equal(receipt.counts.copiedBytes, 0);
    assert.deepEqual(current(f.dir), previous);
    assert.equal(existsSync(join(f.dir, 'runs', receipt.attemptId, 'import-policy.json')), false);
  } finally { f.cleanup(); }
});

test('verification detects changed bytes, missing originals and tampered manifest or current index', async () => {
  const f = fixture();
  try {
    const receipt = await importOriginals(f.dir, f.source);
    const copy = originalPath(f.dir, receipt, 'source with spaces.txt'), bytes = readFileSync(copy);
    const unlisted = originalPath(f.dir, receipt, 'unlisted.txt'); writeFileSync(unlisted, 'unexpected input');
    await assert.rejects(async () => verifyImport(f.dir, receipt.importId), /manifest|entries|extra|unlisted|unexpected|integrity|mismatch/i);
    rmSync(unlisted);
    writeFileSync(copy, Buffer.alloc(bytes.length, 120));
    await assert.rejects(async () => verifyImport(f.dir, receipt.importId), /hash|bytes|mismatch|integrity|changed/i);
    writeFileSync(copy, bytes);
    rmSync(copy);
    await assert.rejects(async () => verifyImport(f.dir, receipt.importId), /missing|enoent|integrity/i);
    writeFileSync(copy, bytes);
    const path = manifestPath(f.dir, receipt), manifestBytes = readFileSync(path), manifest = json(path);
    manifest.entries[0].bytes++;
    writeFileSync(path, JSON.stringify(manifest));
    await assert.rejects(async () => verifyImport(f.dir, receipt.importId), /hash|bytes|mismatch|integrity|changed/i);
    writeFileSync(path, manifestBytes);
    const indexPath = join(f.dir, 'inputs/import.json'), indexBytes = readFileSync(indexPath), index = json(indexPath);
    index.imports.find((item: any) => item.importId === receipt.importId).manifestSha256 = '0'.repeat(64);
    writeFileSync(indexPath, JSON.stringify(index));
    await assert.rejects(async () => verifyImport(f.dir, receipt.importId), /hash|mismatch|integrity|changed/i);
    writeFileSync(indexPath, indexBytes);
    await verifyImport(f.dir, receipt.importId);
  } finally { f.cleanup(); }
});

test('file bytes, total bytes, file count and directory depth limits reject representative small inputs', async () => {
  for (const limit of ['maxFileBytes', 'maxTotalBytes', 'maxFiles', 'maxDepth'] as const) {
    const f = fixture();
    try {
      const first = await importOriginals(f.dir, f.source), previous = current(f.dir);
      const source = join(f.root, 'bounded-source');
      mkdirSync(join(source, 'one/two'), { recursive: true });
      writeFileSync(join(source, 'one/two/deep.txt'), '12345');
      writeFileSync(join(source, 'root.txt'), '12345');
      const limits = { maxFileBytes: 5, maxTotalBytes: 10, maxFiles: 2, maxDepth: 3 };
      limits[limit] = limit === 'maxFileBytes' ? 4 : limit === 'maxTotalBytes' ? 9 : 1;
      setPolicy(f.dir, limits);
      const receipt = await failed(f.dir, source);
      assert.match(reason(receipt), /limit|depth|count|bytes|size|files/i, limit);
      if (limit === 'maxFileBytes') assert.match(reason(receipt), /sourceBytes=5; maxFileBytes=4;.*import-policy\.json.*retaining the original/);
      if (limit === 'maxTotalBytes') assert.match(reason(receipt), /plannedBytes=10; maxTotalBytes=9;.*smaller batches.*retaining the originals/);
      assert.deepEqual(current(f.dir), previous, limit);
      await verifyImport(f.dir, first.importId);
    } finally { f.cleanup(); }
  }
});

test('byte and file limits accept exactly the configured boundary', async () => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const source = join(f.root, 'exact-boundary'); mkdirSync(join(source, 'nested'), { recursive: true });
    writeFileSync(join(source, 'first.txt'), '12345');
    writeFileSync(join(source, 'nested/second.txt'), '67890');
    setPolicy(f.dir, { maxFileBytes: 5, maxTotalBytes: 10, maxFiles: 2, maxDepth: 2 });
    const receipt = await importOriginals(f.dir, source), manifest = await verifyImport(f.dir, receipt.importId);
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual(receipt.counts, { discoveredFiles: 2, copiedFiles: 2, copiedBytes: 10 });
    assert.deepEqual(manifest.totals, { files: 2, bytes: 10 });
  } finally { f.cleanup(); }
});

test('multiple stream chunks persist exact actual counts and retain full binary integrity', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 73); writeFileSync(f.source, bytes);
    let active: any;
    const observed: number[] = [];
    const receipt = await importOriginals(f.dir, f.source, { hooks: {
      onPhase(phase, value) { if (phase === 'copying') active = value; },
      onChunk() { observed.push(json(receiptPath(f.dir, active)).counts.copiedBytes); },
    } });
    assert.ok(observed.length >= 2, 'a large input must be received over multiple bounded writes');
    assert.ok(observed.every((value, index) => value > (observed[index - 1] ?? 0)));
    assert.equal(observed.at(-1), bytes.length);
    assert.deepEqual(receipt.counts, { discoveredFiles: 1, copiedFiles: 1, copiedBytes: bytes.length });
    const manifest = await verifyImport(f.dir, receipt.importId);
    assert.equal(manifest.entries[0]!.sha256, hash(bytes));
    assert.deepEqual(readFileSync(originalPath(f.dir, receipt, 'source with spaces.txt')), bytes);
    assert.deepEqual(readFileSync(f.source), bytes);
  } finally { f.cleanup(); }
});

test('copying a growing source enforces the adopted actual-byte limit and retains the previous index', async () => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), source = join(f.root, 'growing.bin');
    writeFileSync(source, Buffer.alloc(65536, 1));
    setPolicy(f.dir, { maxFileBytes: 100000, maxTotalBytes: 100000 });
    let observedBytes = 0, grew = false;
    const receipt = await failed(f.dir, source, { hooks: { onChunk(_path, bytes) {
      observedBytes += bytes;
      if (!grew) { grew = true; appendFileSync(source, Buffer.alloc(65536, 2)); }
    } } });
    assert.equal(grew, true);
    assert.equal(receipt.counts.copiedBytes, observedBytes);
    assert.ok(receipt.counts.copiedBytes <= 100000);
    assert.match(reason(receipt), /limit|bytes|size|changed/i);
    assert.deepEqual(current(f.dir), previous);
    assert.equal(readFileSync(source).length, 131072);
  } finally { f.cleanup(); }
});

test('same-size source replacement and directory additions or removals during copy cannot be committed', async () => {
  for (const mutation of ['replace', 'add', 'remove'] as const) {
    const f = fixture();
    try {
      const first = await importOriginals(f.dir, f.source), previous = current(f.dir), source = join(f.root, 'mutable-directory');
      mkdirSync(source);
      writeFileSync(join(source, 'first.txt'), 'aaaa');
      writeFileSync(join(source, 'second.txt'), 'bbbb');
      let changed = false;
      const receipt = await failed(f.dir, source, { hooks: { afterFileCopied() {
        if (changed) return; changed = true;
        if (mutation === 'replace') writeFileSync(join(source, 'first.txt'), 'cccc');
        if (mutation === 'add') writeFileSync(join(source, 'new.txt'), 'new item');
        if (mutation === 'remove') rmSync(join(source, 'second.txt'));
      } } });
      assert.equal(changed, true);
      assert.match(reason(receipt), /changed|missing|enoent/i, mutation);
      assert.deepEqual(current(f.dir), previous, mutation);
      await verifyImport(f.dir, first.importId);
    } finally { f.cleanup(); }
  }
});

test('selected symlinks, symlink ancestors, nested symlinks and hardlinked files receive explicit rejection', async () => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), selected = join(f.root, 'selected-link.txt');
    symlinkSync(f.source, selected);
    const throughLink = join(f.root, 'ancestor-link');
    symlinkSync(f.root, throughLink);
    const nested = join(f.root, 'nested-links'); mkdirSync(nested);
    writeFileSync(join(nested, 'ordinary.txt'), 'ordinary');
    symlinkSync(f.source, join(nested, 'linked.txt'));
    const hard = join(f.root, 'hardlinked.txt'); linkSync(f.source, hard);
    for (const source of [selected, join(throughLink, 'source with spaces.txt'), nested, hard]) {
      const receipt = await failed(f.dir, source);
      assert.match(reason(receipt), /link/i);
      assert.deepEqual(current(f.dir), previous);
    }
    assert.equal(readFileSync(f.source, 'utf8'), 'fictional original bytes');
  } finally { f.cleanup(); }
});

test('selected FIFO is rejected without opening or hanging the reader', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') { t.skip('FIFO fixture requires a POSIX host'); return; }
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), source = join(f.root, 'fictional.pipe');
    const mkfifo = spawnSync('mkfifo', [source], { encoding: 'utf8' });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const script = `import { importOriginals } from ${JSON.stringify(IMPORT_MODULE)};
      try { await importOriginals(${JSON.stringify(f.dir)}, ${JSON.stringify(source)}); process.exitCode = 2; }
      catch (error) { if (!error.receipt) throw error; console.log(JSON.stringify(error.receipt)); }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.status, 'failed');
    assert.match(reason(receipt), /special|regular|fifo|file.type/i);
    assertStoredReceipt(f.dir, receipt);
    assert.deepEqual(current(f.dir), previous);
  } finally { f.cleanup(); }
});

test('an empty selected directory is a complete zero-byte batch with a received root', async () => {
  const f = fixture();
  try {
    const source = join(f.root, 'empty-root'); mkdirSync(source);
    const receipt = await importOriginals(f.dir, source), manifest = await verifyImport(f.dir, receipt.importId);
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual(manifest.entries, []);
    assert.deepEqual(manifest.totals, { files: 0, bytes: 0 });
    assert.deepEqual(receipt.counts, { discoveredFiles: 0, copiedFiles: 0, copiedBytes: 0 });
    assert.ok(receipt.items.some((item: any) => item.kind === 'directory' && item.path === '' && item.status === 'received'));
    assert.equal(lstatSync(join(f.dir, manifest.originalsPath)).isDirectory(), true);
  } finally { f.cleanup(); }
});

test('explicitly selected project assets copy locally; generated areas and other project inputs are rejected', async () => {
  const f = fixture();
  try {
    const local = join(f.dir, 'assets/local.txt'); writeFileSync(local, 'selected project asset');
    const first = await importOriginals(f.dir, local), previous = current(f.dir);
    assert.equal(readFileSync(originalPath(f.dir, first, 'local.txt'), 'utf8'), 'selected project asset');
    const other = initProject({ slug: 'other-fixture', projectsRoot: f.projects }).dir;
    const foreign = join(other, 'assets/foreign.txt'); writeFileSync(foreign, 'other project private input');
    for (const source of [f.dir, join(f.dir, 'inputs'), join(f.dir, 'runs'), join(f.dir, 'out'), foreign]) {
      await assert.rejects(() => importOriginals(f.dir, source), /overlap|project|boundary|forbidden|isolat/i);
      assert.deepEqual(current(f.dir), previous);
    }
    assert.equal(readFileSync(foreign, 'utf8'), 'other project private input');
    assert.equal(existsSync(join(other, 'inputs/import.json')), false);
    await verifyImport(f.dir, first.importId);
    for (const id of ['../other-fixture', '/outside', first.importId + '/../../escape']) {
      await assert.rejects(async () => verifyImport(f.dir, id), /id|path|invalid|committed/i);
    }
  } finally { f.cleanup(); }
});

test('symlinked import targets cannot redirect writes into another project', async () => {
  for (const relative of ['inputs/original', 'inputs/imports', 'runs', 'out/.tmp']) {
    const f = fixture();
    try {
      const other = initProject({ slug: 'other-fixture', projectsRoot: f.projects }).dir;
      const outside = join(other, 'assets'), sentinel = join(outside, 'keep.txt'); writeFileSync(sentinel, 'keep other project bytes');
      const target = join(f.dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { recursive: true, force: true });
      symlinkSync(outside, target);
      await assert.rejects(() => importOriginals(f.dir, f.source), /link|path|isolat|boundary/i, relative);
      assert.deepEqual(readdirSync(outside).sort(), ['keep.txt']);
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep other project bytes');
    } finally { f.cleanup(); }
  }
});

test('case and Unicode-normalization collisions are rejected when the source filesystem represents both names', async t => {
  const f = fixture();
  let represented = 0;
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir);
    for (const [index, [first, second]] of [['Case.txt', 'case.txt'], ['caf\u00e9.txt', 'cafe\u0301.txt']].entries()) {
      const source = join(f.root, `colliding-${index}`); mkdirSync(source);
      writeFileSync(join(source, first!), 'first bytes', { flag: 'wx' });
      try { writeFileSync(join(source, second!), 'second bytes', { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        continue;
      }
      represented++;
      const receipt = await failed(f.dir, source);
      assert.match(reason(receipt), /collision|name/i);
      assert.deepEqual(current(f.dir), previous);
    }
    if (!represented) t.skip('source filesystem aliases case and NFC/NFD names');
  } finally { f.cleanup(); }
});

test('planner rejects case and Unicode collisions through the file port on every host', async t => {
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), children = NodeImportFiles.prototype.children, inspect = NodeImportFiles.prototype.inspect;
    for (const [index, [first, second]] of [['Case.txt', 'case.txt'], ['caf\u00e9.txt', 'cafe\u0301.txt']].entries()) {
      const source = join(f.root, `portable-collision-${index}`); mkdirSync(source);
      writeFileSync(join(source, first!), 'fictional collision fixture');
      const listing = t.mock.method(NodeImportFiles.prototype, 'children', async function (path: string) {
        return path === source ? [first!, second!] : children.call(this, path);
      });
      const inspection = t.mock.method(NodeImportFiles.prototype, 'inspect', async function (path: string) {
        return inspect.call(this, path === join(source, second!) ? join(source, first!) : path);
      });
      try {
        const receipt = await failed(f.dir, source);
        assert.match(reason(receipt), /collision/i);
        assert.deepEqual(current(f.dir), previous);
      } finally { listing.mock.restore(); inspection.mock.restore(); }
    }
  } finally { f.cleanup(); }
});

test('a rejected nonportable filename still has a schema-valid receipt with its actual name', async t => {
  if (process.platform === 'win32') { t.skip('backslash is a separator on Windows'); return; }
  const f = fixture();
  try {
    await importOriginals(f.dir, f.source);
    const previous = current(f.dir), name = 'bad\\name.txt', source = join(f.root, name);
    writeFileSync(source, 'fictional invalid name');
    const receipt = await failed(f.dir, source);
    assert.match(reason(receipt), /name|unsafe|collision/i);
    const item = receipt.items.find((entry: any) => entry.path === name);
    assert.ok(item);
    assert.equal(item.status, 'rejected');
    assert.ok(item.reason);
    assert.deepEqual(current(f.dir), previous);
    assert.equal(readFileSync(source, 'utf8'), 'fictional invalid name');
  } finally { f.cleanup(); }
});

test('copy errors, commit errors and explicit cancellation retain the complete previous batch', async () => {
  for (const stage of ['copy', 'commit', 'abort-before', 'abort-during'] as const) {
    const f = fixture();
    try {
      const first = await importOriginals(f.dir, f.source), previous = current(f.dir), abort = new AbortController();
      if (stage === 'abort-before') abort.abort();
      const receipt = await failed(f.dir, f.source, { signal: abort.signal, hooks: {
        onChunk() {
          if (stage === 'copy') throw new Error('FICTIONAL_COPY_FAILURE');
          if (stage === 'abort-during') abort.abort();
        },
        onPhase(phase) { if (stage === 'commit' && phase === 'committing') throw new Error('FICTIONAL_COMMIT_FAILURE'); },
      } });
      assert.match(reason(receipt), stage === 'copy' ? /FICTIONAL_COPY_FAILURE/ : stage === 'commit' ? /FICTIONAL_COMMIT_FAILURE/ : /abort|interrupt/i);
      assert.deepEqual(current(f.dir), previous, stage);
      assert.equal(receipt.indexCommitted, false);
      assert.ok(receipt.items.every((item: any) => item.status === 'received' || typeof item.reason === 'string'), 'each planned item has a received state or failure reason');
      await verifyImport(f.dir, first.importId);
    } finally { f.cleanup(); }
  }
});

test('a live import owns the project write lock and blocks a concurrent attempt', { timeout: 10000 }, async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let first: ReturnType<typeof importOriginals> | undefined;
  try {
    const entered = new Promise<void>((resolve, reject) => {
      first = importOriginals(f.dir, f.source, { hooks: { async onPhase(phase) {
        if (phase !== 'copying') return;
        resolve();
        await new Promise<void>(unlock => { release = unlock; });
      } } });
      void first.catch(reject);
    });
    await entered;
    await assert.rejects(() => importOriginals(f.dir, f.source), /busy|lock|concurrent/i);
    release!();
    const receipt = await first!;
    assert.equal(receipt.status, 'succeeded');
    await verifyImport(f.dir, receipt.importId);
  } finally { release?.(); await first?.catch(() => {}); f.cleanup(); }
});

test('malformed lock identities cannot direct recovery outside the selected project', async () => {
  const f = fixture();
  try {
    const first = await importOriginals(f.dir, f.source), previous = current(f.dir), path = join(f.dir, 'runs/import.lock/owner.json');
    mkdirSync(dirname(path));
    const variants = [
      { pid: 2147483647, attemptId: '../../escape', importId: first.importId },
      { pid: 2147483647, attemptId: first.attemptId, importId: '../escape' },
      { pid: 0, attemptId: first.attemptId, importId: first.importId },
    ];
    const sentinel = join(f.root, 'escape.txt'); writeFileSync(sentinel, 'preserved outside project');
    for (const owner of variants) {
      writeFileSync(path, JSON.stringify(owner));
      const receipt = await failed(f.dir, f.source);
      assert.match(reason(receipt), /lock|identity|invalid/i);
      assert.deepEqual(current(f.dir), previous);
      assert.deepEqual(json(path), owner);
      assert.equal(readFileSync(sentinel, 'utf8'), 'preserved outside project');
    }
    rmSync(dirname(path), { recursive: true });
    await verifyImport(f.dir, first.importId);
  } finally { f.cleanup(); }
});

test('SIGKILL immediately before or after root lock publication permits the next import to recover', { timeout: 20000 }, async () => {
  for (const stage of ['before', 'after'] as const) {
    const f = fixture();
    let importer: ReturnType<typeof childImporter> | undefined;
    try {
      const first = await importOriginals(f.dir, f.source), previous = current(f.dir), lock = join(f.dir, 'runs/import.lock');
      importer = childImporter(f.dir, f.source, { target: lock, stage });
      const paused = await importer.paused!;
      assert.equal(existsSync(lock), stage === 'after');
      assert.deepEqual(current(f.dir), previous);
      importer.child.kill('SIGKILL');
      assert.equal((await importer.exited).signal, 'SIGKILL');
      const next = await importOriginals(f.dir, f.source), interrupted = json(receiptPath(f.dir, paused));
      assert.equal(interrupted.status, 'interrupted', stage);
      assert.equal(interrupted.indexCommitted, false);
      assert.equal(interrupted.counts.copiedBytes, 0);
      assert.equal(existsSync(lock), false);
      await verifyImport(f.dir, first.importId);
      await verifyImport(f.dir, next.importId);
    } finally { importer?.child.kill('SIGKILL'); await importer?.exited; f.cleanup(); }
  }
});

test('two real importers competing for a dead-owner lock preserve one recovery owner and the index', { timeout: 20000 }, async () => {
  const f = fixture();
  let dead: ReturnType<typeof childImporter> | undefined, recovering: ReturnType<typeof childImporter> | undefined, competing: ReturnType<typeof childImporter> | undefined;
  try {
    const first = await importOriginals(f.dir, f.source), previous = current(f.dir), lock = join(f.dir, 'runs/import.lock');
    dead = childImporter(f.dir, f.source, { target: lock, stage: 'after' });
    await dead.paused!; dead.child.kill('SIGKILL'); await dead.exited;
    recovering = childImporter(f.dir, f.source, { target: join(lock, 'recovery'), stage: 'after' });
    const owner = await recovering.paused!;
    assert.equal(json(join(lock, 'recovery/owner.json')).pid, owner.pid);
    competing = childImporter(f.dir, f.source);
    const rejected = await competing.exited, rejectedOutput = JSON.parse(rejected.stdout);
    assert.equal(rejectedOutput.ok, false, rejected.stderr);
    assert.match(rejectedOutput.message, /busy|lock/i);
    assert.deepEqual(current(f.dir), previous);
    assert.equal(json(join(lock, 'recovery/owner.json')).pid, owner.pid);
    recovering.child.send('continue');
    const accepted = await recovering.exited, acceptedOutput = JSON.parse(accepted.stdout);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(acceptedOutput.ok, true);
    const index = json(join(f.dir, 'inputs/import.json'));
    assert.equal(index.imports.length, 2);
    assert.equal(index.currentImportId, acceptedOutput.receipt.importId);
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, acceptedOutput.receipt.importId);
    assert.equal(existsSync(lock), false);
  } finally {
    for (const importer of [dead, recovering, competing]) { importer?.child.kill('SIGKILL'); await importer?.exited; }
    f.cleanup();
  }
});

test('a dead recovery lease is recovered before publishing the next complete import', { timeout: 20000 }, async () => {
  const f = fixture();
  let dead: ReturnType<typeof childImporter> | undefined, recovering: ReturnType<typeof childImporter> | undefined;
  try {
    const first = await importOriginals(f.dir, f.source), previous = current(f.dir), lock = join(f.dir, 'runs/import.lock');
    dead = childImporter(f.dir, f.source, { target: lock, stage: 'after' });
    const originalOwner = await dead.paused!; dead.child.kill('SIGKILL'); await dead.exited;
    recovering = childImporter(f.dir, f.source, { target: join(lock, 'recovery'), stage: 'after' });
    const recoveryOwner = await recovering.paused!; recovering.child.kill('SIGKILL'); await recovering.exited;
    assert.deepEqual(current(f.dir), previous);
    const next = await importOriginals(f.dir, f.source);
    for (const owner of [originalOwner, recoveryOwner]) {
      const receipt = json(receiptPath(f.dir, owner));
      assert.equal(receipt.status, 'interrupted');
      assert.equal(receipt.indexCommitted, false);
    }
    assert.equal(existsSync(lock), false);
    assert.equal(json(join(f.dir, 'inputs/import.json')).imports.length, 2);
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, next.importId);
  } finally {
    for (const importer of [dead, recovering]) { importer?.child.kill('SIGKILL'); await importer?.exited; }
    f.cleanup();
  }
});

test('a killed copier recovers an interrupted receipt with real byte counts before the next import', { timeout: 15000 }, async () => {
  const f = fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const first = await importOriginals(f.dir, f.source), previous = current(f.dir), source = join(f.root, 'interrupted.bin');
    writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 9));
    const script = `import { importOriginals } from ${JSON.stringify(IMPORT_MODULE)};
      let active;
      await importOriginals(${JSON.stringify(f.dir)}, ${JSON.stringify(source)}, { hooks: {
        onPhase(phase, receipt) { if (phase === 'copying') active = receipt; },
        async onChunk(path, bytes) {
          await new Promise(resolve => process.send({ attemptId: active.attemptId, path, bytes }, resolve));
          await new Promise(() => {});
        }
      } });`;
    child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
    const message = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child copier did not reach a written chunk: ' + stderr)), 5000);
      child!.once('message', data => { clearTimeout(timer); resolve(data); });
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited ${code}: ${stderr}`)); });
    });
    const livePath = join(f.dir, 'runs', message.attemptId, 'receipt.json'), live = json(livePath);
    assert.equal(live.status, 'running');
    assert.equal(live.phase, 'copying');
    assert.equal(live.counts.copiedBytes, message.bytes);
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    assert.deepEqual(current(f.dir), previous);
    const next = await importOriginals(f.dir, f.source), interrupted = json(livePath);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.indexCommitted, false);
    assert.equal(interrupted.counts.copiedBytes, message.bytes);
    assert.match(reason(interrupted), /interrupt|owner|process/i);
    assertStoredReceipt(f.dir, interrupted);
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, next.importId);
    assert.equal(json(join(f.dir, 'inputs/import.json')).currentImportId, next.importId);
  } finally { child?.kill('SIGKILL'); f.cleanup(); }
});

test('an actual index rename failure preserves the old index and leaves a truthful failed receipt', async t => {
  const f = fixture();
  let restore: (() => void) | undefined;
  try {
    const first = await importOriginals(f.dir, f.source), previous = current(f.dir), indexPath = join(f.dir, 'inputs/import.json');
    const rename = fsPromises.rename;
    let injected = false;
    const mocked = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof rename>) => {
      if (String(args[1]) === indexPath) {
        injected = true;
        throw Object.assign(new Error('FICTIONAL_INDEX_RENAME_FAILURE'), { code: 'EIO' });
      }
      return rename(...args);
    });
    restore = () => mocked.mock.restore(); syncBuiltinESMExports();
    const receipt = await failed(f.dir, f.source);
    assert.equal(injected, true);
    assert.match(reason(receipt), /FICTIONAL_INDEX_RENAME_FAILURE/);
    assert.equal(receipt.indexCommitted, false);
    assert.deepEqual(current(f.dir), previous);
    await verifyImport(f.dir, first.importId);
  } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
});

test('index publication cannot become a failed import through cleanup of its renamed pending file', async t => {
  const f = fixture();
  let restore: (() => void) | undefined;
  try {
    await importOriginals(f.dir, f.source);
    const rename = fsPromises.rename, unlink = fsPromises.unlink;
    let published = false;
    const renamed = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof rename>) => {
      await rename(...args);
      if (String(args[1]) === join(f.dir, 'inputs/import.json')) published = true;
    });
    const cleanup = t.mock.method(fsPromises, 'unlink', async (...args: Parameters<typeof unlink>) => {
      if (published && String(args[0]).includes('.import.json.')) {
        throw Object.assign(new Error('FICTIONAL_POST_INDEX_CLEANUP_EIO'), { code: 'EIO' });
      }
      return unlink(...args);
    });
    restore = () => { renamed.mock.restore(); cleanup.mock.restore(); }; syncBuiltinESMExports();
    let receipt: any;
    try { receipt = await importOriginals(f.dir, f.source); }
    catch (error) { receipt = (error as any).receipt; }
    assert.ok(receipt);
    assert.equal(published, true);
    assert.equal(json(join(f.dir, 'inputs/import.json')).currentImportId, receipt.importId);
    assert.equal(receipt.status, 'succeeded', 'the complete committed batch controls terminal state');
    assert.equal(receipt.indexCommitted, true);
    assertStoredReceipt(f.dir, receipt);
    await verifyImport(f.dir, receipt.importId);
  } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
});

test('an index rename that takes effect before returning EIO preserves committed success and the error', async t => {
  const f = fixture();
  let restore: (() => void) | undefined;
  try {
    const first = await importOriginals(f.dir, f.source), rename = fsPromises.rename;
    let tookEffect = false;
    const mocked = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof rename>) => {
      await rename(...args);
      if (String(args[1]) === join(f.dir, 'inputs/import.json')) {
        tookEffect = true;
        throw Object.assign(new Error('FICTIONAL_RENAME_POST_EFFECT_EIO'), { code: 'EIO' });
      }
    });
    restore = () => mocked.mock.restore(); syncBuiltinESMExports();
    let failure: any;
    try { await importOriginals(f.dir, f.source); } catch (error) { failure = error; }
    assert.equal(tookEffect, true);
    assert.ok(failure?.receipt);
    const receipt = failure.receipt;
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.indexCommitted, true);
    assert.match(receipt.error, /FICTIONAL_RENAME_POST_EFFECT_EIO/);
    assert.match(failure.message, /FICTIONAL_RENAME_POST_EFFECT_EIO/);
    assertStoredReceipt(f.dir, receipt);
    const index = json(join(f.dir, 'inputs/import.json'));
    assert.equal(index.currentImportId, receipt.importId);
    assert.equal(index.imports.length, 2);
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, receipt.importId);
    assert.deepEqual(readFileSync(originalPath(f.dir, receipt, 'source with spaces.txt')), readFileSync(f.source));
  } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
});

test('receipt write failure after the index commit recovers success for the already complete batch', async t => {
  const f = fixture();
  let restore: (() => void) | undefined;
  try {
    const first = await importOriginals(f.dir, f.source);
    const open = fsPromises.open;
    let active: any, injected = 0;
    const mocked = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
      if (active && String(args[0]).includes(active.attemptId) && String(args[0]).includes('.receipt.json.')) {
        injected++;
        throw Object.assign(new Error('FICTIONAL_TERMINAL_RECEIPT_FAILURE'), { code: 'EIO' });
      }
      return open(...args);
    });
    restore = () => mocked.mock.restore(); syncBuiltinESMExports();
    let result: any;
    try { result = await importOriginals(f.dir, f.source, { hooks: { afterIndexCommitted(receipt) { active = receipt; } } }); }
    catch (error) { result = (error as any).receipt; }
    assert.ok(active);
    assert.ok(injected > 0, 'the terminal receipt write must actually reach the injected FS failure');
    assert.ok(result);
    assert.equal(result.status === 'failed', false, 'a complete committed index must never be labeled failed');
    assert.equal(json(join(f.dir, 'inputs/import.json')).currentImportId, active.importId);
    const saved = json(receiptPath(f.dir, active));
    assert.equal(saved.status === 'failed', false);
    restore(); restore = undefined; syncBuiltinESMExports();
    const next = await importOriginals(f.dir, f.source), recovered = json(receiptPath(f.dir, active));
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.indexCommitted, true);
    assertStoredReceipt(f.dir, recovered);
    await verifyImport(f.dir, first.importId);
    await verifyImport(f.dir, active.importId);
    await verifyImport(f.dir, next.importId);
  } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
});

test('SIGKILL after atomic index publication recovers the committed batch as succeeded', { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const first = await importOriginals(f.dir, f.source);
    const script = `import { importOriginals } from ${JSON.stringify(IMPORT_MODULE)};
      await importOriginals(${JSON.stringify(f.dir)}, ${JSON.stringify(f.source)}, { hooks: {
        afterIndexCommitted() { process.kill(process.pid, 'SIGKILL'); }
      } });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const index = json(join(f.dir, 'inputs/import.json')), committed = index.imports.find((item: any) => item.importId === index.currentImportId);
    assert.ok(committed);
    assert.notEqual(committed.importId, first.importId);
    const path = receiptPath(f.dir, committed), beforeRecovery = json(path);
    assert.equal(beforeRecovery.status === 'failed', false);
    await importOriginals(f.dir, f.source);
    const recovered = json(path);
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.indexCommitted, true);
    assert.equal(recovered.manifestSha256, committed.manifestSha256);
    await verifyImport(f.dir, committed.importId);
    await verifyImport(f.dir, first.importId);
  } finally { f.cleanup(); }
});
