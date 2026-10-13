import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { importJsonText, NodeImportFiles } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { hashUnpackedFile, ZipArchive } from '../adapters/unpack-zip.ts';
import { assertImportIndex, assertImportManifest } from '../project/import.ts';
import { assertUnpackIndex, assertUnpackManifest, assertUnpackPolicy, assertUnpackReceipt, canonicalUnpackPath, DEFAULT_UNPACK_POLICY, emptyUnpackCounts, emptyUnpackItem,
  importIdPattern, safeUnpackPath, unpackAttemptPattern, unpackIdPattern, ZIP_PARSER, type UnpackIndex, type UnpackItem, type UnpackManifest, type UnpackPhase, type UnpackReceipt, type UnpackSource } from '../project/unpack.ts';

export class UnpackFailure extends Error {
  readonly receipt: UnpackReceipt; readonly receiptPath: string | null;
  constructor(message: string, receipt: UnpackReceipt, receiptPath: string | null, cause?: unknown) {
    super(receiptPath ? `${message}; receipt: ${receiptPath}` : message, { cause }); this.name = 'UnpackFailure'; this.receipt = receipt; this.receiptPath = receiptPath;
  }
}
export interface UnpackOptions {
  readonly signal?: AbortSignal;
  /** Deterministic lifecycle/fault seams; production callers pass only signal. */
  readonly hooks?: {
    onPhase?(phase: UnpackPhase, receipt: Readonly<UnpackReceipt>): void | Promise<void>;
    onChunk?(path: string, bytes: number): void | Promise<void>;
    afterFileUnpacked?(path: string, receipt: Readonly<UnpackReceipt>): void | Promise<void>;
    afterIndexCommitted?(receipt: Readonly<UnpackReceipt>): void | Promise<void>;
  };
}
const active = new Set<string>();
const digest = (value: unknown) => createHash('sha256').update(importJsonText(value)).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const snapshot = (receipt: UnpackReceipt) => structuredClone(receipt);
function ownerAlive(pid: number, attemptId: string): boolean {
  if (pid === process.pid) return active.has(attemptId);
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function optionalHash(files: NodeImportFiles, path: string, signal?: AbortSignal): Promise<string | null> {
  try { return (await files.hash(path, signal)).sha256; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function readIndex(projectDir: string, files: NodeImportFiles): Promise<UnpackIndex | null> {
  let raw; try { raw = await files.readJson(join(projectDir, 'inputs/unpack.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const index = assertUnpackIndex(raw), ids = new Set<string>(), attempts = new Set<string>();
  for (const entry of index.unpacks) {
    if (ids.has(entry.unpackId) || attempts.has(entry.attemptId)) throw new Error('UNPACK_INDEX_INVALID: duplicate identity');
    ids.add(entry.unpackId); attempts.add(entry.attemptId);
  }
  if (!ids.has(index.currentUnpackId)) throw new Error('UNPACK_INDEX_INVALID: current identity absent');
  return index;
}

/** Select only a committed, ordinary project copy bound to its frozen parent manifest. */
async function selectSource(projectDir: string, importId: string, path: string, files: NodeImportFiles, signal?: AbortSignal): Promise<UnpackSource> {
  if (!importIdPattern.test(importId) || !safeUnpackPath(path)) throw new Error('UNPACK_SELECTION_INVALID');
  signal?.throwIfAborted();
  const index = assertImportIndex(await files.readJson(join(projectDir, 'inputs/import.json')));
  const matches = index.imports.filter(item => item.importId === importId);
  if (matches.length !== 1 || !index.imports.some(item => item.importId === index.currentImportId)) throw new Error('UNPACK_PARENT_INVALID: committed import identity');
  const parent = matches[0]!, manifestPath = join(projectDir, 'inputs/imports', importId, 'manifest.json');
  if ((await files.hash(manifestPath, signal)).sha256 !== parent.manifestSha256) throw new Error('UNPACK_PARENT_CHANGED: manifest bytes');
  const manifest = assertImportManifest(await files.readJson(manifestPath));
  if (digest(manifest) !== parent.manifestSha256 || manifest.importId !== importId || manifest.attemptId !== parent.attemptId || manifest.originalsPath !== `inputs/original/${importId}`) throw new Error('UNPACK_PARENT_INVALID: manifest identity/path');
  const entries = manifest.entries.filter(item => item.path === path);
  if (entries.length !== 1 || entries[0]!.kind !== 'file') throw new Error('UNPACK_SELECTION_INVALID: one listed ordinary file required');
  const selected = entries[0]!, archive = files.projectPath(join(projectDir, manifest.originalsPath, path));
  const actual = await files.hash(archive, signal);
  if (actual.bytes !== selected.bytes || actual.sha256 !== selected.sha256 || actual.bytes > manifest.policy.maxFileBytes || actual.bytes > manifest.policy.maxTotalBytes) throw new Error('UNPACK_ARCHIVE_CHANGED: parent byte identity');
  if ((await files.hash(manifestPath, signal)).sha256 !== parent.manifestSha256) throw new Error('UNPACK_PARENT_CHANGED');
  return { importId, path, manifestSha256: parent.manifestSha256, archiveBytes: actual.bytes, archiveSha256: actual.sha256 };
}
function ratio(bytes: number, compressed: number, maximum: number): boolean { return compressed === 0 ? bytes === 0 : bytes / compressed <= maximum; }

async function verifyStored(projectDir: string, unpackId: string, manifestSha256: string, files: NodeImportFiles, signal?: AbortSignal): Promise<UnpackManifest> {
  if (!unpackIdPattern.test(unpackId)) throw new Error('UNPACK_ID_INVALID');
  const path = files.projectPath(join(projectDir, 'inputs/unpacks', unpackId, 'manifest.json'));
  if ((await files.hash(path, signal)).sha256 !== manifestSha256) throw new Error('UNPACK_MANIFEST_CHANGED');
  const manifest = assertUnpackManifest(await files.readJson(path));
  if (manifest.unpackId !== unpackId || manifest.unpackedPath !== `inputs/unpacked/${unpackId}` || digest(manifest) !== manifestSha256) throw new Error('UNPACK_MANIFEST_INVALID: identity/path');
  const policy = assertUnpackPolicy(await files.readJson(join(projectDir, 'runs', manifest.attemptId, 'unpack-policy.adopted.json')));
  const rawPolicy = assertUnpackPolicy(await files.readJson(join(projectDir, 'runs', manifest.attemptId, 'unpack-policy.source.json')));
  if (digest(rawPolicy) !== manifest.policySha256 || digest(policy) !== manifest.policySha256 || digest(manifest.policy) !== manifest.policySha256 || (await files.hash(join(projectDir, 'runs', manifest.attemptId, 'unpack-policy.adopted.json'), signal)).sha256 !== manifest.policySha256 ||
    (await files.hash(join(projectDir, 'runs', manifest.attemptId, 'unpack-policy.source.json'), signal)).sha256 !== manifest.policySourceSha256) throw new Error('UNPACK_POLICY_CHANGED');
  const source = await selectSource(projectDir, manifest.source.importId, manifest.source.path, files, signal);
  if (digest(source) !== digest(manifest.source) || source.archiveBytes > policy.maxArchiveBytes) throw new Error('UNPACK_SOURCE_CHANGED');
  const root = files.projectPath(join(projectDir, manifest.unpackedPath));
  if ((await files.inspect(root)).kind !== 'directory') throw new Error('UNPACK_COPY_INVALID: root');
  const listed = new Map<string, UnpackItem>(), folded = new Set<string>(), archiveIndices = new Set<number>();
  let bytes = 0, compressed = 0, fileCount = 0;
  for (const item of manifest.entries) {
    signal?.throwIfAborted();
    if (!safeUnpackPath(item.path) || item.path.normalize('NFC') !== item.path || listed.has(item.path) || folded.has(canonicalUnpackPath(item.path))) throw new Error('UNPACK_MANIFEST_INVALID: duplicate/unsafe path');
    listed.set(item.path, item); folded.add(canonicalUnpackPath(item.path));
    const depth = item.path.split('/').length - (item.kind === 'file' ? 1 : 0);
    if (depth > policy.maxDepth) throw new Error('UNPACK_DEPTH_LIMIT');
    if (item.explicit) {
      if (item.archiveIndex === null || archiveIndices.has(item.archiveIndex) || item.rawPath === null || item.rawNameHex === null || item.crc32 === null) throw new Error('UNPACK_MANIFEST_INVALID: explicit member identity');
      archiveIndices.add(item.archiveIndex);
    } else if (item.kind !== 'directory' || item.archiveIndex !== null || item.rawPath !== null || item.rawNameHex !== null || item.method !== null || item.declaredBytes || item.compressedBytes || item.crc32 !== null) throw new Error('UNPACK_MANIFEST_INVALID: implicit directory');
    const target = files.projectPath(join(root, item.path)), info = await files.inspect(target);
    if (info.kind !== item.kind) throw new Error(`UNPACK_COPY_INVALID: ${item.path}`);
    if (item.kind === 'file') {
      const actual = await hashUnpackedFile(target, signal);
      if (actual.bytes !== item.bytes || actual.bytes !== item.declaredBytes || actual.sha256 !== item.sha256 || actual.crc32 !== item.crc32 || actual.crc32 !== item.actualCrc32) throw new Error(`UNPACK_COPY_CHANGED: ${item.path}`);
      if (actual.bytes > policy.maxFileBytes || !ratio(actual.bytes, item.compressedBytes, policy.maxCompressionRatio)) throw new Error('UNPACK_FILE_OR_RATIO_LIMIT');
      bytes += actual.bytes; fileCount++;
    } else if (item.bytes || item.declaredBytes || item.sha256 !== null || item.explicit && (item.method === null || item.method === 'stored' && item.compressedBytes !== 0 || item.crc32 !== '00000000' || item.actualCrc32 !== '00000000')) throw new Error('UNPACK_MANIFEST_INVALID: directory data');
    compressed += item.compressedBytes;
  }
  for (const item of listed.values()) {
    const parts = item.path.split('/'); parts.pop();
    while (parts.length) { if (listed.get(parts.join('/'))?.kind !== 'directory') throw new Error('UNPACK_MANIFEST_INVALID: missing parent'); parts.pop(); }
  }
  async function inventory(path: string, prefix: string): Promise<void> {
    signal?.throwIfAborted();
    for (const name of await files.children(path)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!listed.has(relative)) throw new Error(`UNPACK_COPY_UNLISTED: ${relative}`);
      const info = await files.inspect(join(path, name));
      if (info.kind !== listed.get(relative)!.kind || info.kind === 'file' && info.nlink !== '1') throw new Error(`UNPACK_COPY_INVALID: ${relative}`);
      if (info.kind === 'directory') await inventory(join(path, name), relative);
    }
  }
  await inventory(root, '');
  const counts = manifest.counts;
  if (listed.size !== counts.expandedNodes || listed.size !== counts.plannedNodes || archiveIndices.size !== counts.archiveEntries || [...archiveIndices].some(index => index >= counts.archiveEntries) || bytes !== counts.expandedBytes || compressed !== counts.compressedBytes || fileCount !== counts.files ||
    listed.size > policy.maxExpandedNodes || archiveIndices.size > policy.maxArchiveEntries || bytes > policy.maxTotalBytes || !ratio(bytes, compressed, policy.maxCompressionRatio) || counts.metadataBytes > policy.maxMetadataBytes || counts.elapsedMs > policy.maxElapsedMs) throw new Error('UNPACK_TOTALS_INVALID');
  if ((await files.hash(path, signal)).sha256 !== manifestSha256) throw new Error('UNPACK_MANIFEST_CHANGED');
  return manifest;
}
export async function verifyUnpack(projectDir: string, unpackId: string): Promise<UnpackManifest> {
  projectDir = resolve(projectDir); const files = new NodeImportFiles(projectDir); await files.assertProject();
  const committed = (await readIndex(projectDir, files))?.unpacks.find(item => item.unpackId === unpackId);
  if (!committed) throw new Error('UNPACK_NOT_COMMITTED');
  const manifest = await verifyStored(projectDir, unpackId, committed.manifestSha256, files);
  if (manifest.attemptId !== committed.attemptId) throw new Error('UNPACK_INDEX_INVALID: attempt mismatch');
  return manifest;
}
async function recover(projectDir: string, attemptId: string, files: NodeImportFiles, signal: AbortSignal): Promise<void> {
  const index = await readIndex(projectDir, files);
  for (const name of await files.attemptDirectories()) {
    signal.throwIfAborted();
    if (!unpackAttemptPattern.test(name) || name === attemptId) continue;
    const path = files.projectPath(join(projectDir, 'runs', name, 'receipt.json'));
    let receipt;
    try { receipt = assertUnpackReceipt(await files.readJson(path)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (receipt.attemptId !== name || receipt.tempPath !== `out/.tmp/unpack-${name}`) throw new Error('UNPACK_RECEIPT_INVALID: recovery identity/path');
    if (!['running', 'prepared'].includes(receipt.status) || ownerAlive(receipt.ownerPid, name)) continue;
    const committed = index?.unpacks.find(item => item.unpackId === receipt.unpackId);
    if (committed) {
      const manifest = await verifyStored(projectDir, receipt.unpackId, committed.manifestSha256, files, signal);
      if (manifest.attemptId !== name || committed.attemptId !== name) throw new Error('UNPACK_INDEX_INVALID: recovered attempt');
      receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.manifestPath = `inputs/unpacks/${receipt.unpackId}/manifest.json`; receipt.manifestSha256 = committed.manifestSha256;
      receipt.source = manifest.source; receipt.policy = manifest.policy; receipt.policySha256 = manifest.policySha256; receipt.policySourceSha256 = manifest.policySourceSha256;
      receipt.counts = { ...manifest.counts, elapsedMs: Math.max(receipt.counts.elapsedMs, manifest.counts.elapsedMs) }; receipt.items = manifest.entries.map(item => ({ ...item })); receipt.error = null;
    } else {
      receipt.status = 'interrupted'; receipt.indexCommitted = false;
      receipt.error = 'UNPACK_INTERRUPTED: owner stopped before index commit; output bytes remeasured, compressed/metadata counts retain last durable observation';
      let bytes = 0, filesCount = 0; const found = new Set<string>();
      for (const item of receipt.items) {
        signal.throwIfAborted();
        if (!safeUnpackPath(item.path)) { item.status = 'rejected'; item.reason = receipt.error; continue; }
        for (const target of [join(projectDir, receipt.tempPath, 'payload', item.path), join(projectDir, 'inputs/unpacked', receipt.unpackId, item.path)]) {
          try { const info = await files.inspect(files.projectPath(target)); if (info.kind === item.kind) found.add(item.path); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (item.kind === 'file') {
          let actualBytes = 0;
          for (const target of [join(projectDir, receipt.tempPath, 'payload', item.path), join(projectDir, 'inputs/unpacked', receipt.unpackId, item.path)]) {
            try { const info = await files.inspect(files.projectPath(target)); if (info.kind !== 'file' || info.nlink !== '1') throw new Error('UNPACK_COPY_INVALID: interrupted output'); actualBytes = info.size; break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          item.bytes = actualBytes; bytes += actualBytes;
          if (item.status === 'unpacked') filesCount++;
        }
        if (item.status === 'pending') { item.status = 'rejected'; item.reason = receipt.error; item.sha256 = null; }
      }
      receipt.counts.expandedBytes = bytes; receipt.counts.files = filesCount; receipt.counts.expandedNodes = found.size;
    }
    receipt.finishedAt = new Date().toISOString(); assertUnpackReceipt(receipt); await files.writeJson(path, receipt);
  }
}

export async function unpackOriginal(projectDir: string, importId: string, archivePath: string, options: UnpackOptions = {}): Promise<UnpackReceipt> {
  projectDir = resolve(projectDir);
  const started = performance.now(), attemptId = `unpack-attempt-${randomUUID()}`, unpackId = `unpack-${randomUUID()}`;
  const runDir = join(projectDir, 'runs', attemptId), receiptPath = join(runDir, 'receipt.json'), tempPath = `out/.tmp/unpack-${attemptId}`;
  const workDir = join(projectDir, tempPath), payload = join(workDir, 'payload'), files = new NodeImportFiles(projectDir, workDir), lease = new ProjectLease(projectDir, workDir, 'unpack');
  const deadline = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const receipt: UnpackReceipt = { version: '0.1', kind: 'unpack-receipt', attemptId, unpackId, selection: { importId, path: archivePath }, source: null, ownerPid: process.pid,
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', phase: 'planning', parser: ZIP_PARSER, policy: null, policySha256: null, policySourceSha256: null,
    counts: emptyUnpackCounts(), items: [], tempPath, manifestPath: null, manifestSha256: null, indexCommitted: false, error: null };
  let lock: string | null = null, writable = false, archive: ZipArchive | null = null, current: UnpackItem | null = null, committed = false;
  const elapsed = () => { receipt.counts.elapsedMs = Math.ceil(performance.now() - started); };
  const check = () => { elapsed(); signal.throwIfAborted(); if (receipt.counts.elapsedMs > (receipt.policy?.maxElapsedMs ?? DEFAULT_UNPACK_POLICY.maxElapsedMs)) throw new Error('UNPACK_TIME_LIMIT'); };
  const setDeadline = (milliseconds: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => deadline.abort(new Error('UNPACK_TIME_LIMIT')), Math.max(0, milliseconds - (performance.now() - started))); };
  const persist = async () => { elapsed(); assertUnpackReceipt(receipt); await files.writeJson(receiptPath, receipt); };
  const phase = async (name: UnpackPhase) => { check(); receipt.phase = name; await persist(); await options.hooks?.onPhase?.(name, snapshot(receipt)); check(); };
  active.add(attemptId); setDeadline(DEFAULT_UNPACK_POLICY.maxElapsedMs);
  try {
    await files.assertProject(); await files.ensureDirectory(runDir); writable = true; await persist(); check();
    lock = await lease.acquireLock({ attemptId, unpackId, pid: process.pid }, ownerAlive, signal); check();
    await files.ensureDirectory(join(projectDir, 'inputs'));
    const policyPath = join(projectDir, 'inputs/unpack-policy.json'); let info;
    try { info = await files.inspect(policyPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await files.writeJson(policyPath, DEFAULT_UNPACK_POLICY); info = await files.inspect(policyPath); }
    const rawPath = join(runDir, 'unpack-policy.source.json'), copied = await files.copy(policyPath, rawPath, info, async () => { check(); }, signal);
    receipt.policySourceSha256 = copied.sha256;
    const raw = await files.readJson(rawPath);
    if ((await files.hash(rawPath, signal)).sha256 !== copied.sha256) throw new Error('UNPACK_POLICY_SNAPSHOT_CHANGED');
    const policy = Object.freeze({ ...assertUnpackPolicy(raw) }); receipt.policy = policy; receipt.policySha256 = digest(policy); setDeadline(policy.maxElapsedMs);
    await files.writeJson(join(runDir, 'unpack-policy.adopted.json'), policy); check(); await recover(projectDir, attemptId, files, signal); await phase('planning');
    receipt.source = await selectSource(projectDir, importId, archivePath, files, signal);
    if (receipt.source.archiveBytes > policy.maxArchiveBytes) throw new Error('UNPACK_ARCHIVE_LIMIT');
    const sourcePath = files.projectPath(join(projectDir, 'inputs/original', importId, archivePath));
    archive = await ZipArchive.open(sourcePath, policy, signal, amount => {
      check(); if (receipt.counts.metadataBytes + amount > policy.maxMetadataBytes) throw new Error('UNPACK_METADATA_LIMIT'); receipt.counts.metadataBytes += amount;
    });
    const nodes = new Map<string, UnpackItem>(), folded = new Map<string, string>(); let plannedBytes = 0, plannedCompressed = 0;
    function register(path: string, item?: UnpackItem): UnpackItem {
      const canonical = canonicalUnpackPath(path), alias = folded.get(canonical), existing = nodes.get(path);
      if (alias && alias !== path) throw new Error(`UNPACK_NAME_COLLISION: ${path} / ${alias}`);
      if (existing) {
        if (!item || existing.kind !== 'directory' || item.kind !== 'directory' || existing.explicit) throw new Error(`UNPACK_NAME_COLLISION: duplicate/prefix: ${path}`);
        Object.assign(existing, item); return existing;
      }
      const node = item ?? { ...emptyUnpackItem(path), kind: 'directory' as const };
      const depth = path.split('/').length - (node.kind === 'file' ? 1 : 0);
      if (depth > policy.maxDepth) throw new Error(`UNPACK_DEPTH_LIMIT: ${path}`);
      if (nodes.size >= policy.maxExpandedNodes) throw new Error('UNPACK_NODE_LIMIT');
      nodes.set(path, node); folded.set(canonical, path); receipt.items.push(node); receipt.counts.plannedNodes++; return node;
    }
    const members = await archive.plan(async member => {
      check(); current = member.item; receipt.counts.archiveEntries++;
      if (receipt.counts.archiveEntries > policy.maxArchiveEntries) throw new Error('UNPACK_ENTRY_LIMIT');
      const parts = member.item.path.split('/'); parts.pop(); let parent = '';
      for (const part of parts) {
        parent = parent ? `${parent}/${part}` : part;
        const prior = nodes.get(parent);
        if (prior && prior.kind !== 'directory') throw new Error('UNPACK_NAME_COLLISION: file parent');
        if (!prior) register(parent);
        else if (folded.get(canonicalUnpackPath(parent)) !== parent) throw new Error('UNPACK_NAME_COLLISION: parent');
      }
      const node = register(member.item.path, member.item);
      // Explicit directories may complete an already registered implicit parent.
      (member as { item: UnpackItem }).item = node; current = node;
      if (node.kind === 'file') {
        if (node.declaredBytes > policy.maxFileBytes) throw new Error('UNPACK_FILE_LIMIT');
        if (!ratio(node.declaredBytes, node.compressedBytes, policy.maxCompressionRatio)) throw new Error('UNPACK_RATIO_LIMIT: member');
        plannedBytes += node.declaredBytes;
        if (!Number.isSafeInteger(plannedBytes) || !Number.isSafeInteger(plannedCompressed) || plannedBytes > policy.maxTotalBytes) throw new Error('UNPACK_TOTAL_LIMIT');
      }
      plannedCompressed += node.compressedBytes;
      if (!Number.isSafeInteger(plannedCompressed)) throw new Error('UNPACK_TOTAL_LIMIT: compressed integers');
      await persist(); current = null;
    });
    if (!ratio(plannedBytes, plannedCompressed, policy.maxCompressionRatio)) throw new Error('UNPACK_RATIO_LIMIT: batch');
    current = null; await phase('extracting'); await files.ensureDirectory(payload);
    for (const node of receipt.items.filter(item => item.kind === 'directory')) {
      check(); current = node; await files.ensureDirectory(files.projectPath(join(payload, node.path))); receipt.counts.expandedNodes++; node.status = node.explicit ? 'pending' : 'unpacked'; await persist();
    }
    for (const member of members) {
      check(); const node = member.item; current = node;
      const result = await archive.extract(projectDir, node.kind === 'file' ? files.projectPath(join(payload, node.path)) : null, member, {
        async onCreated() { receipt.counts.expandedNodes++; await persist(); },
        async onCompressed(amount) { check(); receipt.counts.compressedBytes += amount; await persist(); },
        admit(amount) {
          check(); const bytes = node.bytes + amount, total = receipt.counts.expandedBytes + amount;
          if (bytes > policy.maxFileBytes || bytes > node.declaredBytes || total > policy.maxTotalBytes) throw new Error('UNPACK_BYTE_LIMIT');
          if (!ratio(bytes, node.compressedBytes, policy.maxCompressionRatio) || !ratio(total, plannedCompressed, policy.maxCompressionRatio)) throw new Error('UNPACK_RATIO_LIMIT: actual output');
        }, async onWritten(amount) {
          node.bytes += amount; receipt.counts.expandedBytes += amount; await persist(); await options.hooks?.onChunk?.(node.path, node.bytes); check();
        } });
      node.bytes = result.bytes; node.sha256 = node.kind === 'file' ? result.sha256 : null; node.actualCrc32 = result.crc32; node.status = 'unpacked'; if (node.kind === 'file') receipt.counts.files++;
      await persist(); await options.hooks?.afterFileUnpacked?.(node.path, snapshot(receipt)); check();
    }
    current = null; await phase('verifying'); await archive.assertCurrent();
    if (receipt.counts.compressedBytes !== plannedCompressed || receipt.counts.expandedBytes !== plannedBytes) throw new Error('UNPACK_TOTALS_INVALID: stream counters');
    const unpackedPath = `inputs/unpacked/${unpackId}`; await files.moveDirectory(payload, files.projectPath(join(projectDir, unpackedPath)));
    elapsed();
    const manifest: UnpackManifest = { version: '0.1', kind: 'unpack-manifest', unpackId, attemptId, createdAt: new Date().toISOString(), source: receipt.source,
      unpackedPath, parser: ZIP_PARSER, policy, policySha256: receipt.policySha256!, policySourceSha256: receipt.policySourceSha256!, counts: { ...receipt.counts }, entries: receipt.items.map(item => ({ ...item })) };
    assertUnpackManifest(manifest); receipt.manifestPath = `inputs/unpacks/${unpackId}/manifest.json`; receipt.manifestSha256 = digest(manifest);
    await files.writeJson(join(projectDir, receipt.manifestPath), manifest); await verifyStored(projectDir, unpackId, receipt.manifestSha256, files, signal); check();
    const indexPath = join(projectDir, 'inputs/unpack.json'), oldIndex = await readIndex(projectDir, files), oldHash = await optionalHash(files, indexPath, signal);
    if (oldIndex && digest(oldIndex) !== oldHash) throw new Error('UNPACK_INDEX_CHANGED: parsed identity');
    for (const prior of oldIndex?.unpacks ?? []) {
      const stored = await verifyStored(projectDir, prior.unpackId, prior.manifestSha256, files, signal);
      if (stored.attemptId !== prior.attemptId) throw new Error('UNPACK_INDEX_INVALID: prior attempt identity'); check();
    }
    receipt.status = 'prepared'; await phase('committing'); await archive.assertCurrent(); await verifyStored(projectDir, unpackId, receipt.manifestSha256, files, signal);
    if (await optionalHash(files, indexPath, signal) !== oldHash) throw new Error('UNPACK_INDEX_CHANGED'); check();
    const index: UnpackIndex = { version: '0.1', kind: 'unpack-index', currentUnpackId: unpackId, unpacks: [...(oldIndex?.unpacks ?? []), { unpackId, attemptId, manifestSha256: receipt.manifestSha256 }] };
    assertUnpackIndex(index); await files.writeJson(indexPath, index); committed = true;
    receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.finishedAt = new Date().toISOString();
    await options.hooks?.afterIndexCommitted?.(snapshot(receipt)); await persist(); return receipt;
  } catch (error) {
    if (receipt.phase === 'planning' && archive?.currentItem) current = archive.currentItem;
    receipt.finishedAt = new Date().toISOString(); receipt.error = deadline.signal.aborted ? 'UNPACK_TIME_LIMIT' : message(error); elapsed();
    if (!committed && receipt.manifestSha256) {
      try { const recorded = (await readIndex(projectDir, files))?.unpacks.find(item => item.unpackId === unpackId);
        if (recorded?.attemptId === attemptId && recorded.manifestSha256 === receipt.manifestSha256) { await verifyStored(projectDir, unpackId, recorded.manifestSha256, files); committed = true; }
      } catch { /* Successful publication requires a verified committed version. */ }
    }
    if (committed) { receipt.status = 'succeeded'; receipt.indexCommitted = true; }
    else {
      receipt.status = options.signal?.aborted ? 'interrupted' : 'failed'; receipt.indexCommitted = false;
      if (current) { current.status = 'rejected'; current.sha256 = null; current.reason = receipt.error;
        const actual = (error as { actual?: { bytes: number; sha256: string; crc32: string } }).actual;
        if (actual) { current.bytes = actual.bytes; current.sha256 = actual.sha256; current.actualCrc32 = actual.crc32; }
        if (!receipt.items.includes(current)) receipt.items.push(current); }
      for (const item of receipt.items) if (item.status === 'pending') item.reason = `UNPACK_NOT_EXPANDED: ${receipt.error}`;
    }
    if (writable) try { await persist(); } catch (receiptError) { receipt.error += `; UNPACK_RECEIPT_WRITE_FAILED: ${message(receiptError)}`; }
    throw new UnpackFailure(committed ? `UNPACK_POST_COMMIT: ${receipt.error}` : receipt.error, receipt, writable ? receiptPath : null, error);
  } finally {
    if (timer) clearTimeout(timer);
    try { try { await archive?.close(); } finally { if (lock) await lease.releaseLock(lock, attemptId); } }
    catch (error) { receipt.error = `${receipt.error ? receipt.error + '; ' : ''}UNPACK_CLEANUP_FAILED: ${message(error)}`; if (writable) await persist().catch(() => undefined); }
    finally { active.delete(attemptId); }
  }
}
