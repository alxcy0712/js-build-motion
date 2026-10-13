import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { ProjectLease } from './project-lease.ts';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { ImportLockOwner, ImportNode, ImportStoragePort } from '../project/import.ts';

export function sameImportNode(a: ImportNode, b: ImportNode): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function node(info: BigIntStats): ImportNode {
  return { kind: info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'special',
    dev: String(info.dev), ino: String(info.ino), nlink: String(info.nlink), size: Number(info.size),
    mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) };
}

/** Check lexical ancestors too. A selected /tmp alias reports its physical path instead of hiding the link. */
export function assertImportPath(path: string, missing = false): string {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`IMPORT_SYMLINK: ${current}; provide the physical source path (for example /private/tmp)`);
    if (current !== absolute && !info.isDirectory()) throw new Error(`IMPORT_PATH_INVALID: ancestor is not a directory: ${current}`);
  }
  return absolute;
}
export function importProjectPath(projectDir: string, path: string): string {
  const root = resolve(projectDir), target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`IMPORT_PATH_ESCAPE: ${target}`);
  return assertImportPath(target, true);
}
export async function ensureImportDirectory(projectDir: string, path: string): Promise<void> {
  const target = importProjectPath(projectDir, path), root = resolve(projectDir);
  let current = root;
  if (!(await lstat(root)).isDirectory()) throw new Error('IMPORT_PROJECT_INVALID: project directory required');
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    importProjectPath(root, current);
    try { await mkdir(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!(await lstat(current)).isDirectory()) throw new Error(`IMPORT_PATH_INVALID: directory required: ${current}`);
    importProjectPath(root, current);
  }
}
async function independentHandle(path: string) {
  assertImportPath(path);
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw new Error(`IMPORT_FILE_INVALID: independent ordinary file required: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  if (!sameImportNode(node(info), node(await handle.stat({ bigint: true })))) {
    await handle.close(); throw new Error(`IMPORT_SOURCE_CHANGED: ${path}`);
  }
  return { handle, before: node(info) };
}
export async function readImportJson(projectDir: string, path: string): Promise<unknown> {
  importProjectPath(projectDir, path);
  const { handle } = await independentHandle(path);
  try { return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}
export function importJsonText(value: unknown): string { return JSON.stringify(value, null, 2) + '\n'; }
export async function atomicImportJson(projectDir: string, path: string, value: unknown, temporaryDir: string): Promise<void> {
  importProjectPath(projectDir, path);
  await ensureImportDirectory(projectDir, dirname(path));
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`IMPORT_FILE_INVALID: ${path}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await ensureImportDirectory(projectDir, temporaryDir);
  const pending = importProjectPath(projectDir, join(temporaryDir, `.${basename(path)}.${randomUUID()}.pending`));
  let published = false;
  try {
    const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(importJsonText(value)); await handle.sync(); }
    finally { await handle.close(); }
    importProjectPath(projectDir, path); await rename(pending, path); published = true;
  } finally {
    if (!published) await unlink(pending).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export class NodeImportFiles implements ImportStoragePort {
  readonly projectDir: string;
  readonly temporaryDir: string | null;
  private lease: ProjectLease | null = null;
  constructor(projectDir: string, temporaryDir?: string) { this.projectDir = resolve(projectDir); this.temporaryDir = temporaryDir ?? null; }
  async assertProject(): Promise<void> {
    assertImportPath(this.projectDir);
    if (!(await lstat(this.projectDir)).isDirectory()) throw new Error('IMPORT_PROJECT_INVALID: directory required');
  }
  projectPath(path: string): string { return importProjectPath(this.projectDir, path); }
  async ensureDirectory(path: string): Promise<void> { await ensureImportDirectory(this.projectDir, path); }
  async readJson(path: string): Promise<unknown> { return await readImportJson(this.projectDir, path); }
  async writeJson(path: string, value: unknown): Promise<void> {
    if (!this.temporaryDir) throw new Error('IMPORT_TEMP_PATH_REQUIRED');
    await atomicImportJson(this.projectDir, path, value, this.temporaryDir);
  }
  async moveDirectory(from: string, to: string): Promise<void> {
    this.projectPath(from); this.projectPath(to); await this.ensureDirectory(dirname(to));
    try { await lstat(to); throw new Error('IMPORT_DESTINATION_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(from, to);
  }
  async attemptDirectories(): Promise<string[]> { return await readdir(this.projectPath(join(this.projectDir, 'runs'))); }
  async acquireLock(owner: ImportLockOwner, isAlive: (pid: number, attemptId: string) => boolean): Promise<string> {
    if (!this.temporaryDir) throw new Error('IMPORT_TEMP_PATH_REQUIRED');
    this.lease = new ProjectLease(this.projectDir, this.temporaryDir, 'import');
    return await this.lease.acquireLock(owner, isAlive);
  }
  async releaseLock(path: string, attemptId: string): Promise<void> {
    if (!this.lease) throw new Error('IMPORT_LOCK_CHANGED');
    await this.lease.releaseLock(path, attemptId);
  }
  async inspect(path: string): Promise<ImportNode> {
    assertImportPath(dirname(path));
    return node(await lstat(path, { bigint: true }));
  }
  async children(path: string): Promise<string[]> { assertImportPath(path); return (await readdir(path)).sort(); }
  async copy(source: string, destination: string, expected: ImportNode, onChunk: (bytes: number) => Promise<void>, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
    signal?.throwIfAborted();
    const { handle: input, before } = await independentHandle(source);
    let output;
    try {
      if (!sameImportNode(before, expected)) throw new Error(`IMPORT_SOURCE_CHANGED: ${source}`);
      importProjectPath(this.projectDir, destination);
      await ensureImportDirectory(this.projectDir, dirname(destination));
      output = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        if (bytes + bytesRead > expected.size) throw new Error(`IMPORT_SOURCE_CHANGED: source grew while copying: ${source}`);
        let offset = 0;
        while (offset < bytesRead) {
          signal?.throwIfAborted();
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (!bytesWritten) throw new Error(`IMPORT_COPY_FAILED: zero byte write: ${destination}`);
          hash.update(buffer.subarray(offset, offset + bytesWritten)); offset += bytesWritten; bytes += bytesWritten;
          await onChunk(bytesWritten);
        }
      }
      await output.sync();
      if (bytes !== expected.size || !sameImportNode(before, node(await input.stat({ bigint: true }))) || !sameImportNode(before, await this.inspect(source))) throw new Error(`IMPORT_SOURCE_CHANGED: ${source}`);
      return { bytes, sha256: hash.digest('hex') };
    } finally { await output?.close(); await input.close(); }
  }
  async hash(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
    const { handle, before } = await independentHandle(path);
    try {
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      let bytes = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
      }
      if (bytes !== before.size || !sameImportNode(before, node(await handle.stat({ bigint: true }))) || !sameImportNode(before, await this.inspect(path))) throw new Error(`IMPORT_FILE_CHANGED: ${path}`);
      return { bytes, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  }
}
