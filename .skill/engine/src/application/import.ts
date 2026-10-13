import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importJsonText, NodeImportFiles, sameImportNode } from '../adapters/import-files.ts';
import { assertImportIndex, assertImportManifest, assertImportPolicy, assertImportReceipt, DEFAULT_IMPORT_POLICY, type ImportFilesPort, type ImportIndex, type ImportItem, type ImportManifest, type ImportNode, type ImportPhase, type ImportReceipt, type ImportStoragePort } from '../project/import.ts';

export class ImportFailure extends Error {
  readonly receipt: ImportReceipt;
  readonly receiptPath: string | null;
  constructor(message: string, receipt: ImportReceipt, receiptPath: string | null, cause?: unknown) {
    super(receiptPath ? `${message}; receipt: ${receiptPath}` : message, { cause });
    this.name = 'ImportFailure'; this.receipt = receipt; this.receiptPath = receiptPath;
  }
}
export interface ImportOptions {
  readonly signal?: AbortSignal;
  /** Deterministic fault/source-change seams. Normal callers need only signal. */
  readonly hooks?: {
    onPhase?(phase: ImportPhase, receipt: Readonly<ImportReceipt>): void | Promise<void>;
    onChunk?(path: string, bytes: number): void | Promise<void>;
    afterFileCopied?(path: string, receipt: Readonly<ImportReceipt>): void | Promise<void>;
    afterIndexCommitted?(receipt: Readonly<ImportReceipt>): void | Promise<void>;
  };
}
const importIdPattern = /^import-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const attemptIdPattern = /^import-attempt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const activeImports = new Set<string>();
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);
const digestJson = (value: unknown) => createHash('sha256').update(importJsonText(value)).digest('hex');
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const cloneReceipt = (receipt: ImportReceipt): Readonly<ImportReceipt> => structuredClone(receipt);
function safeName(name: string): boolean { return !!name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name); }
function canonical(path: string): string { return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC'); }
function safeRelative(path: string): boolean { return !!path && path.split('/').every(safeName); }
function ownerAlive(pid: number, attemptId: string): boolean {
  if (pid === process.pid) return activeImports.has(attemptId);
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function assertSourceBoundary(projectDir: string, source: string): void {
  for (const name of ['inputs', 'runs', 'out', '.engine']) {
    const protectedPath = join(projectDir, name);
    if (inside(protectedPath, source) || inside(source, protectedPath)) throw new Error(`IMPORT_SOURCE_OVERLAP: ${source} overlaps ${protectedPath}`);
  }
  if (basename(dirname(projectDir)) === 'projects') {
    const projects = dirname(projectDir), repository = dirname(projects);
    if (inside(projects, source) && !inside(projectDir, source)) throw new Error(`IMPORT_SOURCE_PROTECTED: another project: ${source}`);
    for (const name of ['.skill', '.skill-backups', '.git']) {
      const protectedPath = join(repository, name);
      if (inside(protectedPath, source) || inside(source, protectedPath)) throw new Error(`IMPORT_SOURCE_PROTECTED: ${source}`);
    }
  }
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    if (basename(current) === '.skill' || basename(current) === '.engine') {
      if (inside(current, source) || inside(source, current)) throw new Error(`IMPORT_SOURCE_PROTECTED: ${source}`);
      break;
    }
    current = dirname(current);
  }
}
async function optionalHash(files: ImportFilesPort, path: string): Promise<string | null> {
  try { return (await files.hash(path)).sha256; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function readIndex(projectDir: string, files: ImportStoragePort): Promise<ImportIndex | null> {
  let value;
  try { value = await files.readJson(join(projectDir, 'inputs/import.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const index = assertImportIndex(value), ids = new Set<string>();
  for (const item of index.imports) {
    if (ids.has(item.importId)) throw new Error('IMPORT_INDEX_INVALID: duplicate importId');
    ids.add(item.importId);
  }
  if (!ids.has(index.currentImportId)) throw new Error('IMPORT_INDEX_INVALID: currentImportId absent from committed imports');
  return index;
}

/** Independent project copies and frozen manifest are the authority; the source is evidence only. */
async function verifyStoredImport(projectDir: string, importId: string, manifestSha256: string, signal?: AbortSignal, files: ImportStoragePort = new NodeImportFiles(projectDir)): Promise<ImportManifest> {
  if (!importIdPattern.test(importId)) throw new Error('IMPORT_ID_INVALID');
  const manifestPath = join(projectDir, 'inputs/imports', importId, 'manifest.json');
  if ((await files.hash(files.projectPath(manifestPath), signal)).sha256 !== manifestSha256) throw new Error('IMPORT_MANIFEST_CHANGED');
  const manifest = assertImportManifest(await files.readJson(manifestPath));
  if (digestJson(manifest) !== manifestSha256) throw new Error('IMPORT_MANIFEST_CHANGED: parsed identity');
  if (manifest.importId !== importId || manifest.originalsPath !== `inputs/original/${importId}`) throw new Error('IMPORT_MANIFEST_INVALID: fixed original path/identity mismatch');
  if (!attemptIdPattern.test(manifest.attemptId)) throw new Error('IMPORT_MANIFEST_INVALID: attemptId');
  const frozenPolicyPath = join(projectDir, 'runs', manifest.attemptId, 'import-policy.json');
  const policy = assertImportPolicy(await files.readJson(frozenPolicyPath));
  if ((await files.hash(frozenPolicyPath, signal)).sha256 !== manifest.policySha256 || digestJson(manifest.policy) !== manifest.policySha256 || digestJson(policy) !== manifest.policySha256) throw new Error('IMPORT_POLICY_CHANGED: frozen adopted policy');
  const root = files.projectPath(join(projectDir, manifest.originalsPath));
  if ((await files.inspect(root)).kind !== 'directory') throw new Error('IMPORT_COPY_INVALID: originals directory');
  const listed = new Map<string, ImportItem>(), folded = new Set<string>();
  let fileCount = 0, bytes = 0;
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    if (!safeRelative(entry.path) || listed.has(entry.path) || folded.has(canonical(entry.path))) throw new Error('IMPORT_MANIFEST_INVALID: duplicate or unsafe path');
    listed.set(entry.path, entry); folded.add(canonical(entry.path));
    const path = files.projectPath(resolve(root, entry.path)), info = await files.inspect(path);
    if (info.kind !== entry.kind || (entry.kind === 'file' && info.nlink !== '1')) throw new Error(`IMPORT_COPY_INVALID: ${entry.path}`);
    const depth = entry.kind === 'file' ? entry.path.split('/').length - 1 : entry.path.split('/').length;
    if (depth > policy.maxDepth) throw new Error(`IMPORT_COPY_INVALID: depth: ${entry.path}`);
    if (entry.kind === 'file') {
      const actual = await files.hash(path, signal);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256 || actual.bytes > policy.maxFileBytes) throw new Error(`IMPORT_COPY_CHANGED: ${entry.path}`);
      fileCount++; bytes += actual.bytes;
    }
  }
  async function inventory(dir: string, prefix: string): Promise<void> {
    for (const name of await files.children(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safeName(name) || !listed.has(path)) throw new Error(`IMPORT_COPY_UNLISTED: ${path}`);
      const info = await files.inspect(join(dir, name));
      if (info.kind === 'directory') await inventory(join(dir, name), path);
    }
  }
  await inventory(root, '');
  if (fileCount !== manifest.totals.files || bytes !== manifest.totals.bytes || fileCount > policy.maxFiles || bytes > policy.maxTotalBytes) throw new Error('IMPORT_TOTALS_INVALID');
  if (manifest.source.kind === 'file' && (manifest.entries.length !== 1 || manifest.entries[0]?.kind !== 'file')) throw new Error('IMPORT_MANIFEST_INVALID: single file inventory');
  if ((await files.hash(manifestPath, signal)).sha256 !== manifestSha256) throw new Error('IMPORT_MANIFEST_CHANGED: final identity');
  return manifest;
}
export async function verifyImport(projectDir: string, importId: string): Promise<ImportManifest> {
  projectDir = resolve(projectDir);
  const files = new NodeImportFiles(projectDir); await files.assertProject();
  const index = await readIndex(projectDir, files), committed = index?.imports.find(item => item.importId === importId);
  if (!committed) throw new Error(`IMPORT_NOT_COMMITTED: ${importId}`);
  const manifest = await verifyStoredImport(projectDir, importId, committed.manifestSha256, undefined, files);
  if (manifest.attemptId !== committed.attemptId) throw new Error('IMPORT_INDEX_INVALID: attempt identity mismatch');
  return manifest;
}
async function recoverInterruptedImports(projectDir: string, currentAttemptId: string, files: ImportStoragePort): Promise<void> {
  const index = await readIndex(projectDir, files);
  for (const name of await files.attemptDirectories()) {
    if (!attemptIdPattern.test(name) || name === currentAttemptId) continue;
    const receiptPath = files.projectPath(join(projectDir, 'runs', name, 'receipt.json'));
    let receipt;
    try { receipt = assertImportReceipt(await files.readJson(receiptPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (receipt.attemptId !== name || !importIdPattern.test(receipt.importId) || receipt.tempPath !== `out/.tmp/import-${name}`) throw new Error('IMPORT_RECEIPT_INVALID: recovery identity/path');
    if (!['running', 'prepared'].includes(receipt.status) || ownerAlive(receipt.ownerPid, receipt.attemptId)) continue;
    const committed = index?.imports.find(item => item.importId === receipt.importId);
    if (committed) {
      const manifest = await verifyStoredImport(projectDir, receipt.importId, committed.manifestSha256, undefined, files);
      if (manifest.attemptId !== name || committed.attemptId !== name) throw new Error('IMPORT_INDEX_INVALID: recovered attempt identity');
      receipt.status = 'succeeded'; receipt.indexCommitted = true; receipt.manifestPath = `inputs/imports/${receipt.importId}/manifest.json`;
      receipt.manifestSha256 = committed.manifestSha256; receipt.finishedAt = new Date().toISOString(); receipt.error = null;
      receipt.items = manifest.entries.map(item => ({ ...item }));
      receipt.counts = { discoveredFiles: manifest.totals.files, copiedFiles: manifest.totals.files, copiedBytes: manifest.totals.bytes };
    } else {
      receipt.status = 'interrupted'; receipt.indexCommitted = false; receipt.finishedAt = new Date().toISOString(); receipt.error = 'IMPORT_INTERRUPTED: previous importer stopped before committing the index';
      let copiedBytes = 0, copiedFiles = 0;
      for (const item of receipt.items) {
        if (item.kind !== 'file') { if (item.status === 'pending') item.reason = receipt.error; continue; }
        if (!safeRelative(item.path)) throw new Error('IMPORT_RECEIPT_INVALID: recovery item path');
        const candidates = [join(projectDir, receipt.tempPath, 'payload', item.path), join(projectDir, 'inputs/original', receipt.importId, item.path)];
        let actualBytes = 0;
        for (const path of candidates) {
          try { const info = await files.inspect(files.projectPath(path)); if (info.kind !== 'file' || info.nlink !== '1') throw new Error('IMPORT_COPY_INVALID: interrupted copy'); actualBytes = info.size; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        item.bytes = actualBytes; copiedBytes += actualBytes;
        if (item.status === 'received') copiedFiles++;
        else { item.status = 'rejected'; item.sha256 = null; item.reason = receipt.error; }
      }
      receipt.counts.copiedBytes = copiedBytes; receipt.counts.copiedFiles = copiedFiles;
    }
    await files.writeJson(receiptPath, receipt);
  }
}

export async function importOriginals(projectDir: string, source: string, options: ImportOptions = {}): Promise<ImportReceipt> {
  projectDir = resolve(projectDir); source = resolve(source);
  const attemptId = `import-attempt-${randomUUID()}`, importId = `import-${randomUUID()}`;
  const runDir = join(projectDir, 'runs', attemptId), receiptPath = join(runDir, 'receipt.json');
  const tempPath = `out/.tmp/import-${attemptId}`, workDir = join(projectDir, tempPath), payload = join(workDir, 'payload');
  let receipt: ImportReceipt = { version: '0.1', kind: 'import-receipt', attemptId, importId, source: { path: source, kind: 'unknown' }, ownerPid: process.pid,
    startedAt: new Date().toISOString(), finishedAt: null, status: 'running', phase: 'planning', policy: null, policySha256: null, policySourceSha256: null,
    counts: { discoveredFiles: 0, copiedFiles: 0, copiedBytes: 0 }, items: [], tempPath, manifestPath: null, manifestSha256: null, indexCommitted: false, error: null };
  const files: ImportStoragePort = new NodeImportFiles(projectDir, workDir), stamps = new Map<string, ImportNode>(), inventories = new Map<string, string[]>();
  let lock: string | null = null, receiptWritable = false, currentItem: ImportItem | null = null, committed = false;
  const persist = async () => { assertImportReceipt(receipt); await files.writeJson(receiptPath, receipt); };
  const phase = async (name: ImportPhase) => {
    receipt.phase = name; await persist(); await options.hooks?.onPhase?.(name, cloneReceipt(receipt)); options.signal?.throwIfAborted();
  };
  activeImports.add(attemptId);
  try {
    await files.assertProject();
    await files.ensureDirectory(runDir); receiptWritable = true; await persist();
    lock = await files.acquireLock({ attemptId, importId, pid: process.pid }, ownerAlive);
    await recoverInterruptedImports(projectDir, attemptId, files);
    await files.ensureDirectory(join(projectDir, 'inputs'));
    const policyPath = join(projectDir, 'inputs/import-policy.json');
    let policyInfo;
    try { policyInfo = await files.inspect(policyPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await files.writeJson(policyPath, DEFAULT_IMPORT_POLICY); policyInfo = await files.inspect(policyPath);
    }
    const rawSnapshotPath = join(runDir, 'import-policy.source.json');
    const policyCopy = await files.copy(policyPath, rawSnapshotPath, policyInfo, async () => {}, options.signal);
    receipt.policySourceSha256 = policyCopy.sha256;
    const rawPolicy = await files.readJson(rawSnapshotPath);
    if ((await files.hash(rawSnapshotPath, options.signal)).sha256 !== policyCopy.sha256) throw new Error('IMPORT_POLICY_SNAPSHOT_CHANGED');
    await files.writeJson(join(runDir, 'import-policy.json'), rawPolicy);
    const policy = Object.freeze({ ...assertImportPolicy(rawPolicy) }); receipt.policy = policy; receipt.policySha256 = digestJson(policy);
    await phase('planning');
    assertSourceBoundary(projectDir, source);
    const rootInfo = await files.inspect(source); stamps.set(source, rootInfo);
    if (!['file', 'directory'].includes(rootInfo.kind)) {
      currentItem = { path: basename(source), kind: rootInfo.kind, status: 'rejected', bytes: 0, sha256: null, reason: `IMPORT_SOURCE_INVALID: ${rootInfo.kind}` };
      receipt.items.push(currentItem); throw new Error(currentItem.reason);
    }
    receipt = { ...receipt, source: { path: source, kind: rootInfo.kind as 'file' | 'directory' } };
    let plannedBytes = 0;
    const folded = new Set<string>();
    async function scan(path: string, itemPath: string, directoryDepth: number): Promise<void> {
      options.signal?.throwIfAborted();
      const item: ImportItem = { path: itemPath, kind: 'unknown', status: 'pending', bytes: 0, sha256: null };
      currentItem = item; receipt.items.push(item);
      if ((itemPath && !safeRelative(itemPath)) || folded.has(canonical(itemPath))) throw new Error(`IMPORT_NAME_COLLISION: unsafe/colliding name: ${itemPath}`);
      folded.add(canonical(itemPath));
      const info = await files.inspect(path); item.kind = info.kind; stamps.set(path, info);
      if (info.kind !== 'file' && info.kind !== 'directory') throw new Error(`IMPORT_SOURCE_INVALID: ${info.kind}: ${itemPath}`);
      if (directoryDepth > policy.maxDepth) throw new Error(`IMPORT_DEPTH_LIMIT: ${itemPath}`);
      if (info.kind === 'file') {
        receipt.counts.discoveredFiles++;
        if (info.nlink !== '1') throw new Error(`IMPORT_HARDLINK: ${itemPath}`);
        if (!Number.isSafeInteger(info.size) || info.size > policy.maxFileBytes) throw new Error(`IMPORT_FILE_LIMIT: ${itemPath}; sourceBytes=${info.size}; maxFileBytes=${policy.maxFileBytes}; increase import-policy.json maxFileBytes within available storage, or import selected/split segments while retaining the original`);
        if (receipt.counts.discoveredFiles > policy.maxFiles) throw new Error(`IMPORT_COUNT_LIMIT: ${itemPath}`);
        plannedBytes += info.size;
        if (!Number.isSafeInteger(plannedBytes) || plannedBytes > policy.maxTotalBytes) throw new Error(`IMPORT_TOTAL_LIMIT: ${itemPath}; plannedBytes=${plannedBytes}; maxTotalBytes=${policy.maxTotalBytes}; increase import-policy.json maxTotalBytes within available storage, or import smaller batches while retaining the originals`);
      } else {
        const names = await files.children(path); inventories.set(path, names);
        if (!sameImportNode(info, await files.inspect(path))) throw new Error(`IMPORT_SOURCE_CHANGED: ${itemPath}`);
        for (const name of names) {
          if (!safeName(name)) {
            currentItem = { path: itemPath ? `${itemPath}/${name}` : name, kind: 'unknown', status: 'rejected', bytes: 0, sha256: null, reason: `IMPORT_NAME_INVALID: ${name}` };
            receipt.items.push(currentItem); throw new Error(currentItem.reason);
          }
          const child = join(path, name), childInfo = await files.inspect(child);
          await scan(child, itemPath ? `${itemPath}/${name}` : name, directoryDepth + (childInfo.kind === 'directory' ? 1 : 0));
        }
      }
    }
    await scan(source, rootInfo.kind === 'file' ? basename(source) : '', 0);
    currentItem = null;
    await phase('copying'); await files.ensureDirectory(payload);
    for (const item of receipt.items) {
      currentItem = item; options.signal?.throwIfAborted();
      const destination = files.projectPath(join(payload, item.path));
      if (item.kind === 'directory') { await files.ensureDirectory(destination); item.status = 'received'; await persist(); continue; }
      const sourcePath = rootInfo.kind === 'file' ? source : join(source, item.path), expected = stamps.get(sourcePath)!;
      const result = await files.copy(sourcePath, destination, expected, async bytes => {
        item.bytes += bytes; receipt.counts.copiedBytes += bytes;
        if (item.bytes > policy.maxFileBytes || receipt.counts.copiedBytes > policy.maxTotalBytes) throw new Error(`IMPORT_BYTE_LIMIT: ${item.path}; copiedFileBytes=${item.bytes}; maxFileBytes=${policy.maxFileBytes}; copiedTotalBytes=${receipt.counts.copiedBytes}; maxTotalBytes=${policy.maxTotalBytes}; check source changes and available storage, then adjust import-policy.json or import smaller batches while retaining the originals`);
        await persist(); await options.hooks?.onChunk?.(item.path, item.bytes); options.signal?.throwIfAborted();
      }, options.signal);
      item.bytes = result.bytes; item.sha256 = result.sha256; item.status = 'received'; receipt.counts.copiedFiles++;
      await persist(); await options.hooks?.afterFileCopied?.(item.path, cloneReceipt(receipt)); options.signal?.throwIfAborted();
    }
    currentItem = null;
    async function assertSourceCurrent(): Promise<void> {
      for (const [path, expected] of stamps) {
        options.signal?.throwIfAborted();
        if (!sameImportNode(expected, await files.inspect(path))) throw new Error(`IMPORT_SOURCE_CHANGED: ${path}`);
      }
      for (const [path, expected] of inventories) if (JSON.stringify(await files.children(path)) !== JSON.stringify(expected)) throw new Error(`IMPORT_SOURCE_CHANGED: directory inventory: ${path}`);
    }
    await phase('verifying'); await assertSourceCurrent();
    const originalsPath = `inputs/original/${importId}`, originalDir = files.projectPath(join(projectDir, originalsPath));
    await files.moveDirectory(payload, originalDir);
    const manifest: ImportManifest = { version: '0.1', kind: 'import-manifest', importId, attemptId, createdAt: new Date().toISOString(), source: receipt.source,
      originalsPath, policy, policySha256: receipt.policySha256!, totals: { files: receipt.counts.copiedFiles, bytes: receipt.counts.copiedBytes },
      entries: receipt.items.filter(item => item.path !== '').map(item => ({ ...item })) };
    assertImportManifest(manifest);
    receipt.manifestPath = `inputs/imports/${importId}/manifest.json`; receipt.manifestSha256 = digestJson(manifest);
    await files.writeJson(join(projectDir, receipt.manifestPath), manifest);
    await verifyStoredImport(projectDir, importId, receipt.manifestSha256, options.signal, files);
    const indexPath = join(projectDir, 'inputs/import.json'), oldIndex = await readIndex(projectDir, files), oldIndexHash = await optionalHash(files, indexPath);
    if (oldIndex && digestJson(oldIndex) !== oldIndexHash) throw new Error('IMPORT_INDEX_CHANGED: parsed identity');
    for (const old of oldIndex?.imports ?? []) {
      const prior = await verifyStoredImport(projectDir, old.importId, old.manifestSha256, options.signal, files);
      if (prior.attemptId !== old.attemptId) throw new Error('IMPORT_INDEX_INVALID: prior attempt identity');
    }
    receipt.status = 'prepared'; await phase('committing');
    await assertSourceCurrent(); await verifyStoredImport(projectDir, importId, receipt.manifestSha256, options.signal, files);
    if (await optionalHash(files, indexPath) !== oldIndexHash) throw new Error('IMPORT_INDEX_CHANGED');
    const index: ImportIndex = { version: '0.1', kind: 'import-index', currentImportId: importId,
      imports: [...(oldIndex?.imports ?? []), { importId, attemptId, manifestSha256: receipt.manifestSha256 }] };
    assertImportIndex(index); await files.writeJson(indexPath, index); committed = true;
    receipt.indexCommitted = true; receipt.status = 'succeeded'; receipt.finishedAt = new Date().toISOString();
    await options.hooks?.afterIndexCommitted?.(cloneReceipt(receipt)); await persist();
    return receipt;
  } catch (error) {
    receipt.finishedAt = new Date().toISOString(); receipt.error = message(error);
    if (!committed && receipt.manifestSha256) {
      try {
        const recorded = (await readIndex(projectDir, files))?.imports.find(item => item.importId === importId);
        if (recorded?.attemptId === attemptId && recorded.manifestSha256 === receipt.manifestSha256) {
          await verifyStoredImport(projectDir, importId, recorded.manifestSha256, undefined, files); committed = true;
        }
      } catch { /* An unverified index entry cannot establish a successful import. */ }
    }
    if (committed) { receipt.status = 'succeeded'; receipt.indexCommitted = true; }
    else {
      receipt.status = options.signal?.aborted ? 'interrupted' : 'failed'; receipt.indexCommitted = false;
      if (currentItem) { currentItem.status = 'rejected'; currentItem.sha256 = null; currentItem.reason = receipt.error; }
      for (const item of receipt.items) if (item.status === 'pending') item.reason = `IMPORT_NOT_COPIED: ${receipt.error}`;
    }
    if (receiptWritable) {
      try { await persist(); }
      catch (receiptError) { receipt.error += `; IMPORT_RECEIPT_WRITE_FAILED: ${message(receiptError)}`; }
    }
    throw new ImportFailure(committed ? `IMPORT_POST_COMMIT: ${receipt.error}` : receipt.error, receipt, receiptWritable ? receiptPath : null, error);
  } finally {
    try {
      if (lock) await files.releaseLock(lock, attemptId);
    } catch (error) {
      receipt.error = `${receipt.error ? receipt.error + '; ' : ''}IMPORT_LOCK_RELEASE_FAILED: ${message(error)}`;
      if (receiptWritable) await persist().catch(() => undefined);
    } finally { activeImports.delete(attemptId); }
  }
}
