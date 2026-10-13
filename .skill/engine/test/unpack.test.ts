import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importOriginals, verifyImport } from '../src/application/import.ts';
import { unpackOriginal, UnpackFailure, verifyUnpack } from '../src/application/unpack.ts';
import { DEFAULT_UNPACK_POLICY, validateUnpackPolicy, validateUnpackManifest, validateUnpackReceipt, UNPACK_MANIFEST_SCHEMA, UNPACK_RECEIPT_SCHEMA } from '../src/project/unpack.ts';
import { initProject } from '../src/project/scaffold.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { makeZip, unicodePath, zipExtra, type ZipSpec } from './fixtures/zip.ts';
const MODULE = fileURLToPath(new URL('../src/application/unpack.ts', import.meta.url));
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const clone = (value: any) => structuredClone(value);
const receiptPath = (dir: string, receipt: any) => join(dir, 'runs', receipt.attemptId, 'receipt.json');
const outputPath = (dir: string, receipt: any, path: string) => join(dir, 'inputs/unpacked', receipt.unpackId, path);
const index = (dir: string) => readFileSync(join(dir, 'inputs/unpack.json'));
function fixture() {
  const output = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(output, { recursive: true });
  const root = realpathSync(mkdtempSync(join(output, 'unpack-fixture-'))), dir = initProject({ slug: 'unpack-fixture', projectsRoot: join(root, 'projects') }).dir;
  const source = join(root, 'selected.zip');
  return { root, dir, source, async import(bytes: Buffer) { writeFileSync(source, bytes); return await importOriginals(dir, source); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}
function setPolicy(dir: string, overrides: Partial<typeof DEFAULT_UNPACK_POLICY>) {
  const policy = { ...DEFAULT_UNPACK_POLICY, ...overrides }; writeFileSync(join(dir, 'inputs/unpack-policy.json'), JSON.stringify(policy)); return policy;
}
async function failed(dir: string, imported: any, options?: Parameters<typeof unpackOriginal>[3]): Promise<any> {
  let failure: any; try { await unpackOriginal(dir, imported.importId, 'selected.zip', options); } catch (error) { failure = error; }
  assert.ok(failure instanceof UnpackFailure, String(failure)); const receipt = failure.receipt;
  assert.ok(['failed', 'interrupted'].includes(receipt.status), JSON.stringify(receipt)); assert.equal(receipt.indexCommitted, false);
  assert.deepEqual(validateUnpackReceipt(receipt), []); assert.deepEqual(json(receiptPath(dir, receipt)), receipt); return receipt;
}

test('ordinary Stored/Deflate, Unicode, CP437, descriptors, nested bytes and implicit/explicit directories preserve lineage', async () => {
  const f = fixture();
  try {
    const raw = Buffer.from('legacy-name.txt'), unicode = unicodePath(raw, '目录/映射.txt');
    const nested = makeZip([{ name: 'inner.txt', data: 'one level only' }]);
    const specs: ZipSpec[] = [{ name: 'folder/a.txt', data: 'stored bytes', method: 0 }, { name: 'folder/', directory: true },
      { name: '中文.txt', data: '中文内容', descriptor: true }, { name: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), flags: 0, data: 'old encoding' },
      { name: raw, flags: 0, extra: unicode, data: 'unicode extension' }, { name: '.hidden', data: 'hidden' }, { name: 'empty.txt', method: 0 },
      { name: 'empty-dir/', directory: true, method: 8 }, { name: 'nested.zip', data: nested }, { name: 'descriptor.txt', descriptor: true, descriptorSignature: false, data: 'without signature' }];
    const bytes = makeZip(specs, { comment: Buffer.from('fictional archive') }), imported = await f.import(bytes), originalIndex = readFileSync(join(f.dir, 'inputs/import.json'));
    const receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), manifest = await verifyUnpack(f.dir, receipt.unpackId);
    assert.equal(receipt.status, 'succeeded'); assert.deepEqual(validateUnpackReceipt(receipt), []); assert.deepEqual(validateUnpackManifest(manifest), []);
    assert.deepEqual(manifest.source, { importId: imported.importId, path: 'selected.zip', manifestSha256: imported.manifestSha256, archiveBytes: bytes.length, archiveSha256: hash(bytes) });
    for (const [path, expected] of [['folder/a.txt', 'stored bytes'], ['中文.txt', '中文内容'], ['café.txt', 'old encoding'], ['目录/映射.txt', 'unicode extension'], ['.hidden', 'hidden'], ['empty.txt', ''], ['descriptor.txt', 'without signature']] as const) assert.equal(readFileSync(outputPath(f.dir, receipt, path), 'utf8'), expected);
    assert.deepEqual(readFileSync(outputPath(f.dir, receipt, 'nested.zip')), nested); assert.ok(existsSync(outputPath(f.dir, receipt, 'empty-dir')));
    assert.equal(manifest.entries.find(item => item.path === '目录')?.explicit, false); assert.equal(manifest.entries.find(item => item.path === 'folder')?.explicit, true);
    assert.equal(manifest.entries.find(item => item.path === '目录/映射.txt')?.rawNameHex, raw.toString('hex'));
    assert.equal(manifest.counts.archiveEntries, specs.length); assert.equal(manifest.counts.expandedNodes, specs.length + 1);
    assert.deepEqual(readFileSync(join(f.dir, 'inputs/import.json')), originalIndex); assert.deepEqual(readFileSync(f.source), bytes); await verifyImport(f.dir, imported.importId);
    const second = await unpackOriginal(f.dir, imported.importId, 'selected.zip'); assert.notEqual(second.unpackId, receipt.unpackId); assert.notEqual(second.attemptId, receipt.attemptId);
    assert.equal(json(join(f.dir, 'inputs/unpack.json')).unpacks.length, 2); await verifyUnpack(f.dir, receipt.unpackId);
  } finally { f.cleanup(); }
});

test('small ZIP64, ZIP64 descriptors and completely empty archives have verified independent versions', async () => {
  for (const bytes of [makeZip([], {}), makeZip([], { zip64: true }), makeZip([{ name: 'tiny.txt', data: 'tiny', descriptor: true }, { name: 'empty/', directory: true }], { zip64: true })]) {
    const f = fixture(); try { const imported = await f.import(bytes), receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip'); await verifyUnpack(f.dir, receipt.unpackId); assert.equal(receipt.status, 'succeeded'); } finally { f.cleanup(); }
  }
});

test('unsafe member names, duplicate declarations, normalized/case collisions and prefix conflicts fail atomically', async t => {
  const cases: [string, ZipSpec[]][] = [
    ...['../outside', '/absolute', 'C:/drive', 'a\\b', 'a\0b', './dot', 'a//b', 'a/../b', 'trailing.', 'a:b', 'NUL.txt'].map(name => [name, [{ name, data: 'x' }]] as [string, ZipSpec[]]),
    ['duplicate', [{ name: 'a' }, { name: 'a' }]], ['case', [{ name: 'A' }, { name: 'a' }]], ['NFC', [{ name: 'é' }, { name: 'e\u0301' }]],
    ['parent case', [{ name: 'Dir/a' }, { name: 'dir/b' }]], ['file prefix', [{ name: 'a' }, { name: 'a/b' }]], ['reverse prefix', [{ name: 'a/b' }, { name: 'a' }]],
    ['duplicate dir', [{ name: 'dir/' }, { name: 'dir/' }]],
  ];
  for (const [name, specs] of cases) await t.test(JSON.stringify(name), async () => {
    const f = fixture(); try {
      const base = await f.import(makeZip([{ name: 'baseline', data: 'prior' }])); await unpackOriginal(f.dir, base.importId, 'selected.zip'); const previous = index(f.dir);
      const imported = await f.import(makeZip(specs)), rejected = await failed(f.dir, imported); assert.match(rejected.error, /PATH|NAME|invalid|relative/i);
      assert.deepEqual(index(f.dir), previous); await verifyImport(f.dir, imported.importId);
    } finally { f.cleanup(); }
  });
});

test('declared links/special/ambiguous objects, encrypted, split and unsupported methods get receipts', async t => {
  const cases: [string, Buffer][] = [
    ['symlink', makeZip([{ name: 'link', attrs: 0xa1ff0000 }])], ['FIFO', makeZip([{ name: 'fifo', attrs: 0x11a40000 }])], ['unknown creator', makeZip([{ name: 'object', host: 99 }])],
    ['device', makeZip([{ name: 'device', attrs: 0x40, host: 0 }])], ['unix link extra', makeZip([{ name: 'link', extra: zipExtra(0x000d, Buffer.alloc(13)) }])],
    ['encryption', makeZip([{ name: 'encrypted', flags: 0x801 }])], ['strong encryption', makeZip([{ name: 'encrypted', flags: 0x840 }])],
    ['method', makeZip([{ name: 'unsupported', method: 12 }])], ['split EOCD', makeZip([{ name: 'a' }], { disk: 1 })], ['split central', makeZip([{ name: 'a' }], { centralDisk: 1 })], ['split member', makeZip([{ name: 'a', disk: 1 }])],
    ['directory data', makeZip([{ name: 'dir/', data: 'unexpected' }])], ['directory mismatch', makeZip([{ name: 'file', attrs: 0x41ed0010 }])],
  ];
  for (const [name, bytes] of cases) await t.test(JSON.stringify(name), async () => { const f = fixture(); try { const imported = await f.import(bytes); const receipt = await failed(f.dir, imported); assert.match(receipt.error, /UNPACK_|encrypt|size mismatch/i); assert.equal(existsSync(join(f.dir, 'inputs/unpack.json')), false); } finally { f.cleanup(); } });
});

test('corrupt CRC, truncated data, forged lengths/offsets, malformed extra fields and structure fail publication', async t => {
  const centralOffset = (b: Buffer) => b.readUInt32LE(b.length - 6);
  const mutated = (mutate: (b: Buffer) => void) => { const b = makeZip([{ name: 'a', data: 'fictional data', method: 0 }]); mutate(b); return b; };
  const zip64 = makeZip([{ name: 'a', data: 'small' }], { zip64: true });
  zip64.writeBigUInt64LE(9007199254740992n, zip64.indexOf(Buffer.from([1, 0, 24, 0])) + 4);
  const cases: [string, Buffer][] = [
    ['CRC', makeZip([{ name: 'bad', data: 'content', crc: 123 }])], ['actual length', makeZip([{ name: 'bad', data: 'content', declaredBytes: 30 }])],
    ['truncation', makeZip([{ name: 'a', data: 'content' }]).subarray(0, 35)], ['local offset', makeZip([{ name: 'a', data: 'x', localOffset: 1 }])],
    ['local name', makeZip([{ name: 'a', localName: Buffer.from('b') }])], ['extra trailing', makeZip([{ name: 'a', extra: Buffer.from([1]) }])],
    ['extra truncated', makeZip([{ name: 'a', extra: Buffer.from([2, 0, 5, 0, 1]) }])], ['unsafe uint64', zip64],
    ['directory size', mutated(b => b.writeUInt32LE(46, b.length - 10))], ['central signature', mutated(b => b.writeUInt32LE(0, centralOffset(b)))],
    ['local flags', mutated(b => b.writeUInt16LE(0, 6))], ['local declared size', mutated(b => b.writeUInt32LE(100, 22))],
    ['overlapping members', makeZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y', localOffset: 0 }])],
    ['trailing compressed garbage', makeZip([{ name: 'a', data: 'a', compressedData: Buffer.concat([makeZip([]).subarray(0, 0), Buffer.from([75, 4, 0, 99])]) }])],
  ];
  for (const [name, bytes] of cases) await t.test(JSON.stringify(name), async () => { const f = fixture(); try { const imported = await f.import(bytes), receipt = await failed(f.dir, imported); assert.ok(receipt.error); assert.equal(existsSync(join(f.dir, 'inputs/unpack.json')), false); } finally { f.cleanup(); } });
});

test('every configurable resource limit has exact boundary success and one-step rejection', async t => {
  const archive = makeZip([{ name: 'a/b', data: 'abcd', method: 0 }]);
  const probe = fixture(); let measured: any;
  try { const imported = await probe.import(archive); measured = (await unpackOriginal(probe.dir, imported.importId, 'selected.zip')).counts; } finally { probe.cleanup(); }
  const boundaries: [keyof typeof DEFAULT_UNPACK_POLICY, number][] = [['maxArchiveBytes', archive.length], ['maxFileBytes', 4], ['maxTotalBytes', 4], ['maxArchiveEntries', 1], ['maxExpandedNodes', 2], ['maxDepth', 1], ['maxMetadataBytes', measured.metadataBytes]];
  for (const [key, value] of boundaries) await t.test(key, async () => {
    for (const [limit, accepted] of [[value, true], [value - 1, false]] as const) {
      const f = fixture(); try { const imported = await f.import(archive); setPolicy(f.dir, { [key]: limit });
        if (accepted) await verifyUnpack(f.dir, (await unpackOriginal(f.dir, imported.importId, 'selected.zip')).unpackId);
        else assert.match((await failed(f.dir, imported)).error, /LIMIT|archive/i);
      } finally { f.cleanup(); }
    }
  });
});

test('compression ratios, actual output bound despite forged small declaration, directory inflation, metadata and timeout are enforced', async () => {
  const cases = [
    { zip: makeZip([{ name: 'ratio', data: Buffer.alloc(10000) }]), policy: { maxCompressionRatio: 2 }, error: /RATIO/ },
    { zip: makeZip([{ name: 'actual', data: Buffer.alloc(5000), declaredBytes: 1 }]), policy: { maxCompressionRatio: 1000, maxFileBytes: 10 }, error: /BYTE/ },
    { zip: makeZip([{ name: 'a/b/c/d', data: 'x' }]), policy: { maxExpandedNodes: 3 }, error: /NODE/ },
    { zip: makeZip([{ name: 'a/', directory: true }, { name: 'b/', directory: true }, { name: 'c/', directory: true }]), policy: { maxArchiveEntries: 2 }, error: /ENTRY/ },
    { zip: makeZip([{ name: 'a', comment: Buffer.alloc(4096), extra: zipExtra(123, Buffer.alloc(200)) }]), policy: { maxMetadataBytes: 100 }, error: /METADATA/ },
  ];
  for (const c of cases) { const f = fixture(); try { const imported = await f.import(c.zip); setPolicy(f.dir, c.policy); const receipt = await failed(f.dir, imported); assert.match(receipt.error, c.error); assert.ok(receipt.counts.expandedBytes <= (receipt.policy?.maxTotalBytes ?? Infinity)); } finally { f.cleanup(); } }
  const f = fixture(); try { const imported = await f.import(makeZip([{ name: 'a', data: 'abcd' }])); setPolicy(f.dir, { maxElapsedMs: 100 });
    const receipt = await failed(f.dir, imported, { hooks: { async onPhase(phase) { if (phase === 'extracting') await new Promise(resolve => setTimeout(resolve, 120)); } } }); assert.match(receipt.error, /TIME_LIMIT/); assert.equal(receipt.status, 'failed');
  } finally { f.cleanup(); }
});

test('closed contracts reject extra fields/invalid identities; policies preserve raw and adopted hashes', async () => {
  const f = fixture(); try {
    const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])), adopted = setPolicy(f.dir, { maxTotalBytes: 20 });
    const raw = readFileSync(join(f.dir, 'inputs/unpack-policy.json')), receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), manifest = await verifyUnpack(f.dir, receipt.unpackId);
    assert.equal(receipt.policySourceSha256, hash(raw)); assert.deepEqual(receipt.policy, adopted);
    assert.equal(receipt.policySha256, hash(readFileSync(join(f.dir, 'runs', receipt.attemptId, 'unpack-policy.adopted.json'))));
    assert.deepEqual(readFileSync(join(f.dir, 'runs', receipt.attemptId, 'unpack-policy.source.json')), raw);
    for (const [schema, validate, value] of [[UNPACK_MANIFEST_SCHEMA, validateUnpackManifest, manifest], [UNPACK_RECEIPT_SCHEMA, validateUnpackReceipt, receipt]] as const) {
      assert.equal((schema as any).$schema, 'http://json-schema.org/draft-07/schema#'); const extra = clone(value); extra.surprise = true; assert.ok(validate(extra).length);
      const invalid = clone(value); invalid.attemptId = 'invalid'; assert.ok(validate(invalid).length);
      const nested = clone(value); nested.policy.extra = 1; assert.ok(validate(nested).length);
    }
    assert.ok(validateUnpackPolicy({ ...adopted, maxCompressionRatio: 0 }).length); assert.ok(validateUnpackPolicy({ ...adopted, maxElapsedMs: Number.MAX_SAFE_INTEGER }).length);
    assert.ok(validateUnpackManifest({ ...manifest, unpackedPath: '../escape' }).length);
  } finally { f.cleanup(); }
});

test('verification detects missing/modified/linked/unlisted output, changed manifest/policy and original bytes', async t => {
  for (const mutation of ['missing', 'modified', 'symlink', 'hardlink', 'unlisted', 'manifest', 'policy-source', 'policy-adopted', 'original', 'parent']) await t.test(mutation, async () => {
    const f = fixture(); try {
      const imported = await f.import(makeZip([{ name: 'a', data: 'verified' }, { name: 'empty/', directory: true }])), receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip');
      const path = outputPath(f.dir, receipt, 'a');
      if (mutation === 'missing') unlinkSync(path);
      if (mutation === 'modified') writeFileSync(path, 'changed');
      if (mutation === 'symlink') { unlinkSync(path); symlinkSync(f.source, path); }
      if (mutation === 'hardlink') linkSync(path, join(f.root, 'linked'));
      if (mutation === 'unlisted') writeFileSync(outputPath(f.dir, receipt, 'extra'), 'unlisted');
      if (mutation === 'manifest') writeFileSync(join(f.dir, receipt.manifestPath!), '{}');
      if (mutation.startsWith('policy-')) writeFileSync(join(f.dir, 'runs', receipt.attemptId, `unpack-policy.${mutation === 'policy-source' ? 'source' : 'adopted'}.json`), '{}');
      if (mutation === 'original') writeFileSync(join(f.dir, 'inputs/original', imported.importId, 'selected.zip'), 'changed');
      if (mutation === 'parent') writeFileSync(join(f.dir, 'inputs/imports', imported.importId, 'manifest.json'), '{}');
      await assert.rejects(verifyUnpack(f.dir, receipt.unpackId), /CHANGED|INVALID|UNLISTED|SYMLINK|ENOENT|independent/i);
    } finally { f.cleanup(); }
  });
});

test('invalid selection and invalid/raw policy retain actual rejection evidence without changing the prior index', async () => {
  const f = fixture(); try {
    const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])), first = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), previous = index(f.dir);
    for (const [id, path] of [['invalid', 'selected.zip'], [imported.importId, '../outside'], [imported.importId, 'absent.zip']] as const) {
      let failure: any; try { await unpackOriginal(f.dir, id, path); } catch (error) { failure = error; }
      assert.equal(failure.receipt.status, 'failed'); assert.deepEqual(validateUnpackReceipt(failure.receipt), []); assert.deepEqual(index(f.dir), previous);
    }
    const policyPath = join(f.dir, 'inputs/unpack-policy.json');
    for (const raw of ['{"version":"invalid"}', '{broken json']) {
      writeFileSync(policyPath, raw); const receipt = await failed(f.dir, imported);
      assert.equal(receipt.policySourceSha256, hash(raw)); assert.equal(receipt.policy, null);
      assert.equal(readFileSync(join(f.dir, 'runs', receipt.attemptId, 'unpack-policy.source.json'), 'utf8'), raw); assert.deepEqual(index(f.dir), previous);
    }
    // Earlier frozen versions keep their own adopted policy.
    await verifyUnpack(f.dir, first.unpackId);
  } finally { f.cleanup(); }
});

test('ratio exact boundary and invalid Unicode/Unicode mismatch/descriptor corruption are checked', async () => {
  const archive = makeZip([{ name: 'repeat', data: Buffer.alloc(20) }]);
  for (const [limit, pass] of [[4, true], [3, false]] as const) {
    const f = fixture(); try { const imported = await f.import(archive); setPolicy(f.dir, { maxCompressionRatio: limit });
      if (pass) await unpackOriginal(f.dir, imported.importId, 'selected.zip'); else assert.match((await failed(f.dir, imported)).error, /RATIO/);
    } finally { f.cleanup(); }
  }
  const raw = Buffer.from('plain.txt');
  const descriptor = makeZip([{ name: 'a', data: 'body', descriptor: true }]); descriptor.writeUInt32LE(123, descriptor.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08])) + 4);
  const cases = [makeZip([{ name: Buffer.from([0xff]), flags: 0x800 }]), makeZip([{ name: raw, flags: 0, extra: unicodePath(raw, 'good.txt'), localExtra: unicodePath(raw, 'other.txt') }]), descriptor];
  for (const bytes of cases) { const f = fixture(); try { const imported = await f.import(bytes); await failed(f.dir, imported); } finally { f.cleanup(); } }
  const f = fixture(); try {
    const imported = await f.import(makeZip([{ name: raw, flags: 0, extra: unicodePath(raw, '../ignored', false), data: 'bytes' }]));
    const receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip'); assert.equal(readFileSync(outputPath(f.dir, receipt, 'plain.txt'), 'utf8'), 'bytes');
    unlinkSync(f.source); await verifyUnpack(f.dir, receipt.unpackId); await unpackOriginal(f.dir, imported.importId, 'selected.zip');
  } finally { f.cleanup(); }
});

test('real partial write and raw read faults preserve the old index, originals and truthful byte counts', async t => {
  for (const fault of ['read', 'write']) await t.test(fault, async t => {
    const f = fixture(); const restorers: (() => void)[] = [];
    try {
      const imported = await f.import(makeZip([{ name: 'a', data: 'abcdefgh', method: 0 }])); await unpackOriginal(f.dir, imported.importId, 'selected.zip'); const previous = index(f.dir), open = fsPromises.open;
      let armed = false, injected = false;
      const mocked = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
        const handle = await open(...args), path = String(args[0]);
        if (fault === 'write' && path.includes('/payload/a')) {
          const write = handle.write.bind(handle); let first = true;
          const patched = t.mock.method(handle, 'write', async (...writeArgs: any[]) => {
            if (first) { first = false; return await write(writeArgs[0], writeArgs[1], Math.min(2, writeArgs[2]), writeArgs[3]); }
            injected = true; throw Object.assign(new Error('FICTIONAL_WRITE_EIO'), { code: 'EIO' });
          }); restorers.push(() => patched.mock.restore());
        }
        if (fault === 'read' && path.endsWith(`/inputs/original/${imported.importId}/selected.zip`)) {
          const read = handle.read.bind(handle);
          const patched = t.mock.method(handle, 'read', async (...readArgs: any[]) => { if (armed) { injected = true; throw Object.assign(new Error('FICTIONAL_READ_EIO'), { code: 'EIO' }); } return await read(...readArgs); });
          restorers.push(() => patched.mock.restore());
        }
        return handle;
      }); restorers.push(() => mocked.mock.restore()); syncBuiltinESMExports();
      const receipt = await failed(f.dir, imported, { hooks: { onPhase(phase) { if (phase === 'extracting') armed = true; } } });
      assert.equal(injected, true); assert.match(receipt.error, /FICTIONAL_/); assert.deepEqual(index(f.dir), previous);
      assert.equal(receipt.counts.expandedBytes, fault === 'write' ? 2 : 0); assert.equal(existsSync(join(f.dir, 'runs/unpack.lock')), false);
      for (const restore of restorers.splice(0)) restore(); syncBuiltinESMExports(); await verifyImport(f.dir, imported.importId);
    } finally { for (const restore of restorers) restore(); syncBuiltinESMExports(); f.cleanup(); }
  });
});

test('actual index rename failure and rename-success EIO preserve factual publication state', async t => {
  for (const after of [false, true]) await t.test(after ? 'post effect' : 'before effect', async t => {
    const f = fixture(); let restore: (() => void) | undefined;
    try {
      const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])), first = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), previous = index(f.dir), rename = fsPromises.rename;
      const mocked = t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof rename>) => {
        if (String(args[1]) === join(f.dir, 'inputs/unpack.json')) { if (after) await rename(...args); throw Object.assign(new Error('FICTIONAL_INDEX_EIO'), { code: 'EIO' }); } return await rename(...args);
      }); restore = () => mocked.mock.restore(); syncBuiltinESMExports();
      let failure: any; try { await unpackOriginal(f.dir, imported.importId, 'selected.zip'); } catch (error) { failure = error; }
      assert.match(failure.receipt.error, /FICTIONAL_INDEX_EIO/); assert.equal(failure.receipt.status, after ? 'succeeded' : 'failed'); assert.equal(failure.receipt.indexCommitted, after);
      if (after) { assert.equal(json(join(f.dir, 'inputs/unpack.json')).currentUnpackId, failure.receipt.unpackId); await verifyUnpack(f.dir, failure.receipt.unpackId); }
      else assert.deepEqual(index(f.dir), previous);
      await verifyUnpack(f.dir, first.unpackId);
    } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
  });
});

test('post-commit receipt write failure is recovered as success from verified index facts', async t => {
  const f = fixture(); let restore: (() => void) | undefined;
  try {
    const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])), open = fsPromises.open;
    let armed: any, failures = 0;
    const mocked = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof open>) => {
      if (armed && String(args[0]).includes(armed.attemptId) && String(args[0]).includes('.receipt.json.')) { failures++; throw Object.assign(new Error('FICTIONAL_RECEIPT_EIO'), { code: 'EIO' }); } return await open(...args);
    }); restore = () => mocked.mock.restore(); syncBuiltinESMExports();
    let actual: any; try { actual = await unpackOriginal(f.dir, imported.importId, 'selected.zip', { hooks: { afterIndexCommitted(receipt) { armed = receipt; } } }); } catch (error) { actual = (error as any).receipt; }
    assert.ok(failures); assert.equal(actual.status, 'succeeded'); assert.equal(actual.indexCommitted, true);
    assert.equal(json(receiptPath(f.dir, actual)).status, 'prepared'); restore(); restore = undefined; syncBuiltinESMExports();
    await unpackOriginal(f.dir, imported.importId, 'selected.zip'); const recovered = json(receiptPath(f.dir, actual)); assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.indexCommitted, true); await verifyUnpack(f.dir, actual.unpackId);
  } finally { restore?.(); syncBuiltinESMExports(); f.cleanup(); }
});

test('stream cancellation and stream deadline stop the attempt with measured partial bytes and old index', async () => {
  for (const timed of [false, true]) {
    const f = fixture(); try {
      const imported = await f.import(makeZip([{ name: 'a', data: Buffer.alloc(1024 * 256, 3), method: 0 }])); await unpackOriginal(f.dir, imported.importId, 'selected.zip'); const previous = index(f.dir), controller = new AbortController();
      if (timed) setPolicy(f.dir, { maxElapsedMs: 500 });
      const receipt = await failed(f.dir, imported, { signal: controller.signal, hooks: { async onChunk() {
        if (timed) await new Promise(resolve => setTimeout(resolve, 550)); else controller.abort();
      } } });
      assert.equal(receipt.status, timed ? 'failed' : 'interrupted'); if (timed) assert.match(receipt.error, /TIME_LIMIT/);
      assert.ok(receipt.counts.expandedBytes > 0); assert.ok(receipt.counts.expandedBytes < 256 * 1024);
      assert.deepEqual(index(f.dir), previous); assert.equal(existsSync(join(f.dir, 'runs/unpack.lock')), false);
      const item = receipt.items.find((item: any) => item.kind === 'file'); const bytes = readFileSync(join(f.dir, receipt.tempPath, 'payload', item.path)); assert.equal(bytes.length, receipt.counts.expandedBytes);
    } finally { f.cleanup(); }
  }
});

function childUnpacker(dir: string, imported: any, pause?: { phase?: string; chunk?: boolean; afterCommit?: boolean; target?: string; stage?: string }) {
  const script = `import fs from 'node:fs/promises'; import {readFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {join} from 'node:path';
    const pause=${JSON.stringify(pause ?? null)}, rename=fs.rename;
    async function stop(receipt) { const continued=new Promise(resolve=>process.once('message',resolve)); await new Promise(resolve=>process.send(receipt,resolve)); await continued; }
    fs.rename=async (...args)=>{const selected=pause?.target===String(args[1]); if(selected&&pause.stage==='before')await stop(JSON.parse(readFileSync(join(String(args[0]),'owner.json')))); await rename(...args); if(selected&&pause.stage==='after')await stop(JSON.parse(readFileSync(join(String(args[1]),'owner.json'))));}; syncBuiltinESMExports();
    const {unpackOriginal}=await import(${JSON.stringify(MODULE)}); let receipt;
    try { const result=await unpackOriginal(${JSON.stringify(dir)},${JSON.stringify(imported.importId)},'selected.zip',{hooks:{
      async onPhase(phase,r){receipt=r;if(pause?.phase===phase)await stop(r);}, async onChunk(path,bytes){if(pause?.chunk)await stop({...receipt,path,bytes});}, async afterIndexCommitted(r){if(pause?.afterCommit)await stop(r);}
    }}); console.log(JSON.stringify({ok:true,receipt:result}));} catch(error){console.log(JSON.stringify({ok:false,message:error.message,receipt:error.receipt}));process.exitCode=1;}`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let stdout = '', stderr = '';
  child.stdout!.on('data', bytes => { stdout += bytes; }); child.stderr!.on('data', bytes => { stderr += bytes; });
  const exited = new Promise<any>(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  const paused = pause ? new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unpacker did not pause: ' + stderr + stdout)), 5000);
    child.once('message', value => { clearTimeout(timer); resolve(value); }); child.once('exit', code => { clearTimeout(timer); reject(new Error(`unpacker exited ${code}: ${stderr}${stdout}`)); });
  }) : undefined;
  return { child, paused, exited };
}

test('SIGKILL during stream and after commit recovers interrupted/success receipts independently of import recovery', { timeout: 20000 }, async () => {
  for (const afterCommit of [false, true]) {
    const f = fixture(); let child: ReturnType<typeof childUnpacker> | undefined;
    try {
      const imported = await f.import(makeZip([{ name: 'a', data: Buffer.alloc(256 * 1024, 7), method: 0 }])), first = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), previous = index(f.dir);
      child = childUnpacker(f.dir, imported, afterCommit ? { afterCommit: true } : { chunk: true }); const paused = await child.paused!;
      child.child.kill('SIGKILL'); assert.equal((await child.exited).signal, 'SIGKILL'); const before = json(receiptPath(f.dir, paused));
      assert.ok(['running', 'prepared'].includes(before.status)); if (!afterCommit) assert.deepEqual(index(f.dir), previous);
      await importOriginals(f.dir, f.source); assert.deepEqual(json(receiptPath(f.dir, paused)), before);
      const next = await unpackOriginal(f.dir, imported.importId, 'selected.zip'), recovered = json(receiptPath(f.dir, paused));
      assert.equal(recovered.status, afterCommit ? 'succeeded' : 'interrupted'); assert.equal(recovered.indexCommitted, afterCommit);
      if (afterCommit) await verifyUnpack(f.dir, paused.unpackId); else assert.equal(recovered.counts.expandedBytes, paused.bytes);
      await verifyUnpack(f.dir, first.unpackId); await verifyUnpack(f.dir, next.unpackId); assert.equal(existsSync(join(f.dir, 'runs/unpack.lock')), false);
    } finally { child?.child.kill('SIGKILL'); await child?.exited; f.cleanup(); }
  }
});

test('real concurrent unpackers preserve the active lock and allow only one publication', { timeout: 15000 }, async () => {
  const f = fixture(); let a: ReturnType<typeof childUnpacker> | undefined, b: ReturnType<typeof childUnpacker> | undefined;
  try {
    const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])); await unpackOriginal(f.dir, imported.importId, 'selected.zip'); const previous = index(f.dir);
    a = childUnpacker(f.dir, imported, { phase: 'extracting' }); const owner = await a.paused!;
    b = childUnpacker(f.dir, imported); const result = await b.exited, rejected = JSON.parse(result.stdout); assert.equal(rejected.ok, false); assert.match(rejected.receipt.error, /BUSY/); assert.deepEqual(index(f.dir), previous);
    assert.equal(json(join(f.dir, 'runs/unpack.lock/owner.json')).attemptId, owner.attemptId);
    a.child.send('continue'); const accepted = await a.exited; assert.equal(accepted.code, 0, accepted.stderr); assert.equal(json(join(f.dir, 'inputs/unpack.json')).unpacks.length, 2);
  } finally { for (const child of [a, b]) { child?.child.kill('SIGKILL'); await child?.exited; } f.cleanup(); }
});

test('killed lock publication and competing/dead recovery leases preserve ownership and old index', { timeout: 20000 }, async () => {
  for (const stage of ['before', 'after']) {
    const f = fixture(); let dead: ReturnType<typeof childUnpacker> | undefined, recovering: ReturnType<typeof childUnpacker> | undefined, competitor: ReturnType<typeof childUnpacker> | undefined;
    try {
      const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])); await unpackOriginal(f.dir, imported.importId, 'selected.zip'); const previous = index(f.dir), lock = join(f.dir, 'runs/unpack.lock');
      dead = childUnpacker(f.dir, imported, { target: lock, stage }); const owner = await dead.paused!; dead.child.kill('SIGKILL'); await dead.exited; assert.deepEqual(index(f.dir), previous);
      if (stage === 'after') {
        recovering = childUnpacker(f.dir, imported, { target: join(lock, 'recovery'), stage: 'after' }); const recovery = await recovering.paused!;
        competitor = childUnpacker(f.dir, imported); const rejected = JSON.parse((await competitor.exited).stdout); assert.equal(rejected.ok, false); assert.match(rejected.receipt.error, /BUSY/);
        assert.equal(json(join(lock, 'recovery/owner.json')).attemptId, recovery.attemptId); recovering.child.kill('SIGKILL'); await recovering.exited;
      }
      const next = await unpackOriginal(f.dir, imported.importId, 'selected.zip'); assert.equal(json(receiptPath(f.dir, owner)).status, 'interrupted'); await verifyUnpack(f.dir, next.unpackId); assert.equal(existsSync(lock), false);
    } finally { for (const child of [dead, recovering, competitor]) { child?.child.kill('SIGKILL'); await child?.exited; } f.cleanup(); }
  }
});


test('unsigned descriptors whose CRC equals the signature retain both ZIP and ZIP64 content identity', async () => {
  const data = Buffer.from([172, 10, 122, 213]); assert.equal(crc32(data), 0x08074b50);
  for (const zip64 of [false, true]) { const f = fixture(); try {
    const imported = await f.import(makeZip([{ name: 'signature-crc.bin', data, method: 0, descriptor: true, descriptorSignature: false }], { zip64 }));
    const receipt = await unpackOriginal(f.dir, imported.importId, 'selected.zip');
    assert.deepEqual(readFileSync(outputPath(f.dir, receipt, 'signature-crc.bin')), data); await verifyUnpack(f.dir, receipt.unpackId);
  } finally { f.cleanup(); } }
});

test('deadline during adoption still preserves both policy snapshots and actual node creation counts', async () => {
  const f = fixture(); try {
    const imported = await f.import(makeZip([{ name: 'a', data: 'bytes' }])); setPolicy(f.dir, { maxElapsedMs: 1 }); const receipt = await failed(f.dir, imported);
    assert.equal(existsSync(join(f.dir, 'runs', receipt.attemptId, 'unpack-policy.source.json')), true);
    assert.equal(existsSync(join(f.dir, 'runs', receipt.attemptId, 'unpack-policy.adopted.json')), true);
    assert.equal(receipt.counts.expandedNodes, 0); assert.match(receipt.error, /TIME_LIMIT/);
  } finally { f.cleanup(); }
});
