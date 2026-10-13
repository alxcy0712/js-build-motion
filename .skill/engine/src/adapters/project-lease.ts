import { randomUUID } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicImportJson, ensureImportDirectory, importProjectPath, readImportJson } from './import-files.ts';

export interface LeaseOwner { readonly attemptId: string; readonly pid: number; readonly importId?: string; readonly unpackId?: string; catalogId?: string; alignmentId?: string; videoId?: string; productionId?: string }

/** Complete directory leases serialize publication and dead-owner recovery. */
export class ProjectLease {
  readonly projectDir: string;
  readonly temporaryDir: string;
  readonly kind: 'import' | 'unpack' | 'catalog' | 'alignment' | 'video' | 'production';
  readonly idField: 'importId' | 'unpackId' | 'catalogId' | 'alignmentId' | 'videoId' | 'productionId';
  private ownedLock: { readonly path: string; readonly dev: number; readonly ino: number } | null = null;
  constructor(projectDir: string, temporaryDir: string, kind: 'import' | 'unpack' | 'catalog' | 'alignment' | 'video' | 'production') {
    this.projectDir = projectDir; this.temporaryDir = temporaryDir; this.kind = kind; this.idField = kind === 'import' ? 'importId' : kind === 'unpack' ? 'unpackId' : kind === 'alignment' ? 'alignmentId' : kind === 'video' ? 'videoId' : kind === 'production' ? 'productionId' : 'catalogId';
  }
  private failure(message: string): Error { return new Error(message.replaceAll('IMPORT_', this.kind.toUpperCase() + '_')); }
  async acquireLock(owner: LeaseOwner, isAlive: (pid: number, attemptId: string) => boolean, signal?: AbortSignal): Promise<string> {
    const path = importProjectPath(this.projectDir, join(this.projectDir, `runs/${this.kind}.lock`));
    if (!this.temporaryDir) throw this.failure('IMPORT_TEMP_PATH_REQUIRED');
    const stage = async () => {
      signal?.throwIfAborted();
      const directory = importProjectPath(this.projectDir, join(this.temporaryDir, `lock-${randomUUID()}`));
      await ensureImportDirectory(this.projectDir, directory); await atomicImportJson(this.projectDir, join(directory, 'owner.json'), owner, this.temporaryDir);
      return directory;
    };
    const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const ownerAt = async (directory: string): Promise<LeaseOwner> => {
      if (!(await lstat(importProjectPath(this.projectDir, directory))).isDirectory()) throw this.failure('IMPORT_LOCK_INVALID: ordinary lock directory required');
      let old;
      try { old = await readImportJson(this.projectDir, join(directory, 'owner.json')) as Partial<LeaseOwner>; }
      catch (error) { throw this.failure(`IMPORT_LOCK_INVALID: ${error instanceof Error ? error.message : error}`); }
      if (!old || !new RegExp(`^${this.kind}-attempt-${uuid}$`).test(old.attemptId ?? '') || !new RegExp(`^${this.kind}-${uuid}$`).test(old[this.idField] ?? '') || !Number.isSafeInteger(old.pid) || Number(old.pid) < 1) throw this.failure('IMPORT_LOCK_INVALID: lock owner identity');
      return old as LeaseOwner;
    };
    const publish = async (prepared: string): Promise<boolean> => {
      try { importProjectPath(this.projectDir, path); await rename(prepared, path); return true; }
      catch (error) { if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
    };
    signal?.throwIfAborted();
    const prepared = await stage();
    if (!await publish(prepared)) {
      const old = await ownerAt(path), observed = await lstat(path);
      if (isAlive(old.pid, old.attemptId)) throw this.failure(`IMPORT_BUSY: ${old.attemptId}`);
      // A ready recovery lease serializes stale-lock retirement, including a killed recovery owner.
      let parent = path;
      const recovery = await stage();
      for (;;) {
        signal?.throwIfAborted();
        const claim = importProjectPath(this.projectDir, join(parent, 'recovery'));
        try { await rename(recovery, claim); parent = claim; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw this.failure('IMPORT_BUSY: lock ownership changed');
          if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          const recovering = await ownerAt(claim);
          if (isAlive(recovering.pid, recovering.attemptId)) throw this.failure(`IMPORT_BUSY: recovery ${recovering.attemptId}`);
          parent = claim;
        }
      }
      const current = await lstat(importProjectPath(this.projectDir, path)), actualOwner = await ownerAt(path);
      if (current.ino !== observed.ino || current.dev !== observed.dev || JSON.stringify(actualOwner) !== JSON.stringify(old)) {
        const claimedBy = await ownerAt(parent);
        if (claimedBy.attemptId === owner.attemptId) await rename(parent, importProjectPath(this.projectDir, join(this.temporaryDir, `retired-recovery-${randomUUID()}`)));
        throw this.failure('IMPORT_BUSY: lock ownership changed during recovery');
      }
      await rename(path, importProjectPath(this.projectDir, join(this.temporaryDir, `retired-lock-${randomUUID()}`)));
      if (!await publish(prepared)) throw this.failure('IMPORT_BUSY: another importer acquired the project');
    }
    const acquired = await lstat(importProjectPath(this.projectDir, path)); this.ownedLock = { path, dev: acquired.dev, ino: acquired.ino };
    return path;
  }
  async releaseLock(path: string, attemptId: string): Promise<void> {
    const owner = await readImportJson(this.projectDir, join(path, 'owner.json')) as Partial<LeaseOwner>, current = await lstat(importProjectPath(this.projectDir, path));
    if (owner.attemptId !== attemptId || owner.pid !== process.pid || this.ownedLock?.path !== path || this.ownedLock.dev !== current.dev || this.ownedLock.ino !== current.ino) throw this.failure('IMPORT_LOCK_CHANGED: refusing to remove another owner');
    const retired = importProjectPath(this.projectDir, join(this.temporaryDir, `released-lock-${randomUUID()}`));
    await rename(path, retired); this.ownedLock = null;
    await rm(retired, { recursive: true });
  }
}
