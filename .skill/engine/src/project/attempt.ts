import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from '../utils/env.ts';
import { sha256File } from '../utils/hash.ts';
import { loadProjectDrawing, type ProjectSceneDrawer, type SourceHash } from './drawing.ts';
import { loadProject, resolveInsideProject, type ProjectHandle } from './manifest.ts';
import { assertContained, inside } from './paths.ts';
import { verifyRunLog, type RunLog } from './run-log.ts';
import type { AssetPort } from '../ports/assets.ts';
import { assertRecordedAssetUsage } from '../adapters/asset-usage.ts';

interface InputFile {
  readonly path: string;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly role: 'input' | 'source' | 'media';
}
export interface AttemptInputSnapshot {
  readonly version: '0.1';
  readonly coverage: 'partial';
  readonly files: readonly InputFile[];
  readonly assets: readonly SourceHash[];
}
export interface AttemptExecution {
  readonly assetUsage?: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly attemptId: string;
  readonly inputSnapshotSha256: string;
  readonly coverage: 'partial';
}
export interface RenderAttempt {
  readonly attemptId: string;
  readonly project: ProjectHandle;
  readonly runDir: string;
  readonly snapshotDir: string;
  readonly snapshotProject: ProjectHandle;
  readonly workDir: string;
  readonly outputDir: string;
  readonly inputSnapshot: AttemptInputSnapshot;
  readonly inputSnapshotSha256: string;
  readonly drawingSources: readonly SourceHash[];
}
interface AliasCopy { readonly destination: string; readonly previous: string | null; readonly pending: string }
interface Receipt {
  attemptId: string;
  status: 'running' | 'prepared' | 'succeeded' | 'failed';
  startedAt: string;
  previousRunSha256: string | null;
  publishRun?: boolean;
  copies?: AliasCopy[];
  finishedAt?: string;
  error?: string;
}
const active = new WeakMap<RenderAttempt, { lockPath: string; receipt: Receipt }>();
const relativePath = (root: string, path: string): string => relative(root, path).split('\\').join('/');
const optionalHash = (path: string): string | null => existsSync(path) ? sha256File(path) : null;

function atomicJson(path: string, value: unknown): void {
  assertContained(dirname(path), path);
  const pending = path + '.' + randomUUID() + '.pending';
  try { writeFileSync(pending, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(pending, path); }
  finally { rmSync(pending, { force: true }); }
}
function independentFile(root: string, path: string): void {
  assertContained(root, path);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`ATTEMPT_INPUT_FILE: ${relativePath(root, path)} requires an independent file`);
}
function treeHashes(root: string, folder: string): SourceHash[] {
  if (!existsSync(folder)) return [];
  const result: SourceHash[] = [];
  const visit = (path: string): void => {
    assertContained(root, path);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`ATTEMPT_INPUT_FILE: ${relativePath(root, path)}`);
    if (info.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else { independentFile(root, path); result.push({ path: relativePath(root, path), sha256: sha256File(path) }); }
  };
  visit(folder);
  return result;
}
function collectInputs(project: ProjectHandle, mediaPaths: readonly string[]): AttemptInputSnapshot {
  const paths = new Map<string, InputFile['role']>();
  for (const path of [project.manifestPath, project.specPath,
    ...(project.manifest.brief ? [resolveInsideProject(project.dir, project.manifest.brief, 'brief')] : []),
    ...(project.manifest.director ? [resolveInsideProject(project.dir, project.manifest.director, 'director')] : []),
    join(project.dir, 'workspace.json'), join(project.dir, 'prompt-history.jsonl')]) paths.set(relativePath(project.dir, path), 'input');
  for (const file of treeHashes(project.dir, join(project.dir, 'src'))) paths.set(file.path, 'source');
  for (const name of mediaPaths) {
    const path = resolveInsideProject(project.dir, name, 'attempt media');
    if (inside(project.outDir, path) || inside(join(project.dir, 'runs'), path) && !(/^runs\/video-attempt-[a-f0-9-]{36}\/receipt\.json$/.test(name) || existsSync(join(project.dir, 'production/manifest.json')) && (/^runs\/(import|unpack|catalog|align|alignment|video)-attempt-[a-f0-9-]{36}\//.test(name) || /^runs\/production-attempt-[a-f0-9-]{36}\/receipt\.json$/.test(name))) || inside(join(project.dir, '.engine'), path)) throw new Error('ATTEMPT_MEDIA_INPUT: use project assets or a fixed publication receipt');
    independentFile(project.dir, path);
    const normalized = relativePath(project.dir, path);
    if (!paths.has(normalized)) paths.set(normalized, 'media');
  }
  const files = [...paths].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, role]): InputFile => {
    const absolute = resolveInsideProject(project.dir, path, 'attempt input');
    if (!existsSync(absolute)) return { path, role, sha256: null, bytes: null };
    independentFile(project.dir, absolute);
    return { path, role, sha256: sha256File(absolute), bytes: lstatSync(absolute).size };
  });
  return { version: '0.1', coverage: 'partial', files, assets: treeHashes(project.dir, join(project.dir, 'assets')) };
}
function assertSnapshotFiles(root: string, snapshot: AttemptInputSnapshot): void {
  for (const file of snapshot.files) {
    const path = resolveInsideProject(root, file.path, 'attempt snapshot');
    if (file.sha256 === null) { if (existsSync(path)) throw new Error(`ATTEMPT_INPUT_CHANGED: ${file.path}`); continue; }
    independentFile(root, path);
    if (sha256File(path) !== file.sha256 || lstatSync(path).size !== file.bytes) throw new Error(`ATTEMPT_INPUT_CHANGED: ${file.path}`);
  }
}
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('RENDER_LOCK_INVALID: inspect the lock owner before recovery');
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; }
}
function headIsAttempt(project: ProjectHandle, attemptId: string): boolean {
  const path = join(project.dir, 'run.json');
  if (!existsSync(path)) return false;
  const log = JSON.parse(readFileSync(path, 'utf8')) as RunLog & { execution?: AttemptExecution };
  return log.execution?.attemptId === attemptId;
}
function restoreCopies(project: ProjectHandle, runDir: string, receipt: Receipt): void {
  if (!receipt.copies?.length || headIsAttempt(project, receipt.attemptId) || (receipt.publishRun === false && receipt.status === 'succeeded')) return;
  if (optionalHash(join(project.dir, 'run.json')) !== receipt.previousRunSha256) throw new Error('RENDER_CURRENT_CHANGED: inspect the interrupted attempt before restoring aliases');
  for (const copy of receipt.copies) {
    const destination = resolveInsideProject(project.dir, copy.destination, 'output alias');
    assertContained(project.outDir, destination);
    const pending = resolveInsideProject(project.dir, copy.pending, 'output alias pending');
    if (copy.previous) {
      const backup = resolveInsideProject(project.dir, copy.previous, 'output alias backup');
      assertContained(runDir, backup); independentFile(runDir, backup);
      copyFileSync(backup, pending); renameSync(pending, destination);
    } else rmSync(destination, { force: true });
    rmSync(pending, { force: true });
  }
}
function acquireLock(project: ProjectHandle, attemptId: string): string {
  const lockPath = assertContained(project.dir, join(project.dir, 'runs/.render.lock'));
  mkdirSync(dirname(lockPath), { recursive: true });
  const create = (): void => { const fd = openSync(lockPath, 'wx'); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, attemptId })); } finally { closeSync(fd); } };
  try { create(); return lockPath; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  independentFile(project.dir, lockPath);
  const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; attemptId: string };
  if (pidAlive(owner.pid)) throw new Error(`RENDER_BUSY: attempt ${owner.attemptId}, pid ${owner.pid}`);
  const recovery = lockPath + '.recovery';
  const fd = openSync(recovery, 'wx');
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof owner;
    if (current.pid !== owner.pid || current.attemptId !== owner.attemptId || pidAlive(current.pid)) throw new Error('RENDER_BUSY: lock owner changed');
    const previous = resolveInsideProject(project.dir, `runs/${owner.attemptId}`, 'interrupted attempt');
    const receiptPath = join(previous, 'receipt.json');
    if (existsSync(receiptPath)) restoreCopies(project, previous, JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt);
    rmSync(lockPath);
  } finally { closeSync(fd); rmSync(recovery, { force: true }); }
  create();
  return lockPath;
}
function releaseLock(attempt: RenderAttempt): void {
  const state = active.get(attempt);
  if (!state) return;
  if (existsSync(state.lockPath)) {
    const owner = JSON.parse(readFileSync(state.lockPath, 'utf8')) as { attemptId: string };
    if (owner.attemptId === attempt.attemptId) rmSync(state.lockPath);
  }
  active.delete(attempt);
}

/** Freeze the explicitly known inputs. Asset-tree comparisons conservatively cover uninstrumented drawing IO. */
export function beginRenderAttempt(project: ProjectHandle, options: { mediaPaths?: readonly string[] } = {}): RenderAttempt {
  const attemptId = randomUUID(), lockPath = acquireLock(project, attemptId);
  const runDir = assertContained(project.dir, join(project.dir, 'runs', attemptId));
  const snapshotDir = join(runDir, 'snapshot', project.slug);
  const workDir = assertContained(project.outDir, join(project.outDir, '.tmp', `render-${attemptId}`));
  const outputDir = assertContained(project.outDir, join(project.outDir, 'renders', attemptId));
  const receipt: Receipt = { attemptId, status: 'running', startedAt: new Date().toISOString(), previousRunSha256: optionalHash(join(project.dir, 'run.json')) };
  try {
    const inputSnapshot = collectInputs(project, options.mediaPaths ?? []);
    mkdirSync(snapshotDir, { recursive: true }); mkdirSync(workDir, { recursive: true });
    for (const file of inputSnapshot.files) if (file.sha256 !== null) {
      const target = resolveInsideProject(snapshotDir, file.path, 'snapshot input');
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(resolveInsideProject(project.dir, file.path, 'source input'), target);
    }
    assertSnapshotFiles(snapshotDir, inputSnapshot);
    if (JSON.stringify(collectInputs(project, options.mediaPaths ?? [])) !== JSON.stringify(inputSnapshot)) throw new Error('ATTEMPT_INPUT_CHANGED: inputs changed while taking the snapshot');
    const inputPath = join(runDir, 'input-snapshot.json');
    atomicJson(inputPath, inputSnapshot); atomicJson(join(runDir, 'receipt.json'), receipt);
    const snapshotProject = loadProject(snapshotDir);
    if (JSON.stringify(snapshotProject.manifest) !== JSON.stringify(project.manifest)) throw new Error('ATTEMPT_INPUT_CHANGED: project manifest changed since resolving the target');
    const attempt: RenderAttempt = { attemptId, project, runDir, snapshotDir, snapshotProject, workDir, outputDir, inputSnapshot,
      inputSnapshotSha256: sha256File(inputPath), drawingSources: treeHashes(snapshotDir, join(snapshotDir, 'src')) };
    active.set(attempt, { lockPath, receipt });
    return attempt;
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    if (existsSync(runDir)) atomicJson(join(runDir, 'receipt.json'), { ...receipt, status: 'failed', finishedAt: new Date().toISOString(), error: String(error) });
    rmSync(lockPath, { force: true }); throw error;
  }
}

export async function loadAttemptDrawing(attempt: RenderAttempt, assets?: AssetPort): Promise<ProjectSceneDrawer | undefined> {
  const snapshotSrc = join(attempt.snapshotDir, 'src');
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith('file:') && /^\.\.?\//.test(specifier)) {
      const parent = fileURLToPath(context.parentURL);
      if (inside(snapshotSrc, parent)) {
        const originalParent = resolve(attempt.project.dir, relativePath(attempt.snapshotDir, parent));
        const target = resolve(dirname(originalParent), specifier);
        if (inside(join(attempt.project.dir, '.engine'), target)) return nextResolve(pathToFileURL(target).href, context);
      }
    }
    return nextResolve(specifier, context);
  } });
  try { return await loadProjectDrawing(attempt.snapshotProject, assets); }
  finally { hooks.deregister(); }
}

export function assertAttemptInputsCurrent(attempt: RenderAttempt): void {
  const mediaPaths = attempt.inputSnapshot.files.filter(file => file.role === 'media').map(file => file.path);
  if (JSON.stringify(collectInputs(attempt.project, mediaPaths)) !== JSON.stringify(attempt.inputSnapshot)) throw new Error('ATTEMPT_INPUT_CHANGED: project inputs changed during rendering');
  if (sha256File(join(attempt.runDir, 'input-snapshot.json')) !== attempt.inputSnapshotSha256) throw new Error('ATTEMPT_SNAPSHOT_CHANGED: input manifest');
  assertSnapshotFiles(attempt.snapshotDir, attempt.inputSnapshot);
}

/** Also used by artifact inspection; dynamic drawing IO remains explicitly partial. */
export function assertRecordedAttemptInputs(project: ProjectHandle, execution: AttemptExecution, log?: RunLog): void {
  const runDir = resolveInsideProject(project.dir, `runs/${execution.attemptId}`, 'attempt');
  const inputPath = assertContained(runDir, join(runDir, 'input-snapshot.json'));
  independentFile(runDir, inputPath);
  if (sha256File(inputPath) !== execution.inputSnapshotSha256) throw new Error('ATTEMPT_SNAPSHOT_CHANGED: input manifest');
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf8')) as AttemptInputSnapshot;
  if (snapshot.version !== '0.1' || snapshot.coverage !== 'partial' || execution.coverage !== 'partial' || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.assets)) throw new Error('ATTEMPT_SNAPSHOT_INVALID');
  const mediaPaths = snapshot.files.filter(file => file.role === 'media').map(file => file.path);
  const snapshotDir = join(runDir, 'snapshot', project.slug);
  assertSnapshotFiles(snapshotDir, snapshot);
  if (log) assertRecordedAssetUsage(project.dir, snapshotDir, snapshot, log);
  const current = collectInputs(project, mediaPaths);
  // Later communication appends retain the original render's history prefix and frozen evidence.
  const history = snapshot.files.find(file => file.path === 'prompt-history.jsonl');
  if (history) {
    const saved = history.sha256 === null ? Buffer.alloc(0) : readFileSync(join(snapshotDir, history.path));
    const path = resolveInsideProject(project.dir, history.path, 'prompt history');
    const actual = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    if (!actual.subarray(0, saved.length).equals(saved)) throw new Error('ATTEMPT_INPUT_CHANGED: rendered prompt history prefix');
  }
  const comparable = { ...current, files: current.files.map(file => file.path === 'prompt-history.jsonl' && history ? history : file) };
  if (JSON.stringify(comparable) !== JSON.stringify(snapshot)) throw new Error('ATTEMPT_INPUT_CHANGED: recorded project inputs');
}

export function failRenderAttempt(attempt: RenderAttempt, error: unknown): void {
  const state = active.get(attempt);
  if (!state) return;
  restoreCopies(attempt.project, attempt.runDir, state.receipt);
  if (!headIsAttempt(attempt.project, attempt.attemptId)) {
    atomicJson(join(attempt.runDir, 'receipt.json'), { ...state.receipt, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    rmSync(attempt.workDir, { recursive: true, force: true });
  }
  releaseLock(attempt);
}

/** The caller supplies successful media verification. Only the final atomic run.json replacement commits current. */
export function commitRenderAttempt(attempt: RenderAttempt, log: RunLog, options: {
  technicalOk: boolean;
  publishRun?: boolean;
  copies?: readonly { fromName: string; destination: string }[];
}): string {
  const state = active.get(attempt);
  if (!state) throw new Error('ATTEMPT_CLOSED');
  try {
    if (!options.technicalOk) throw new Error('RENDER_VERIFICATION_FAILED');
    assertAttemptInputsCurrent(attempt);
    if (optionalHash(join(attempt.project.dir, 'run.json')) !== state.receipt.previousRunSha256) throw new Error('RENDER_CURRENT_CHANGED');
    const execution = (log as RunLog & { execution?: AttemptExecution }).execution;
    if (execution?.attemptId !== attempt.attemptId || execution.inputSnapshotSha256 !== attempt.inputSnapshotSha256 || execution.coverage !== 'partial') throw new Error('ATTEMPT_EXECUTION_MISMATCH');
    const verified = verifyRunLog({ log, specSha256: sha256File(attempt.snapshotProject.specPath), briefSha256: attempt.snapshotProject.briefPath ? sha256File(attempt.snapshotProject.briefPath) : null });
    if (!verified.ok) throw new Error(`ATTEMPT_RUN_MISMATCH: ${verified.reason}`);
    assertRecordedAssetUsage(attempt.project.dir, attempt.snapshotDir, attempt.inputSnapshot, log);
    const encoded = assertContained(attempt.workDir, join(attempt.workDir, 'final.mp4'));
    independentFile(attempt.workDir, encoded);
    if (resolve(PROJECT_ROOT, log.measured.outputPath) !== join(attempt.outputDir, 'final.mp4') || sha256File(encoded) !== log.measured.outputSha256 || lstatSync(encoded).size !== log.measured.outputBytes) throw new Error('ATTEMPT_OUTPUT_MISMATCH');
    mkdirSync(dirname(attempt.outputDir), { recursive: true }); renameSync(attempt.workDir, attempt.outputDir);
    const runPath = join(attempt.runDir, 'run.json'); atomicJson(runPath, log);
    const copies: AliasCopy[] = [], seen = new Set<string>();
    state.receipt = { ...state.receipt, status: 'prepared', publishRun: options.publishRun ?? true, copies };
    for (const [index, copy] of (options.copies ?? []).entries()) {
      const source = resolveInsideProject(attempt.outputDir, copy.fromName, 'alias source'); independentFile(attempt.outputDir, source);
      const destination = assertContained(attempt.project.outDir, resolve(attempt.project.dir, copy.destination));
      if (inside(join(attempt.project.outDir, 'renders'), destination) || inside(join(attempt.project.outDir, '.tmp'), destination) || seen.has(destination)) throw new Error('ATTEMPT_ALIAS_PATH: use a unique output alias outside renders/.tmp');
      seen.add(destination); mkdirSync(dirname(destination), { recursive: true });
      let previous: string | null = null;
      if (existsSync(destination)) {
        independentFile(attempt.project.outDir, destination);
        const backup = join(attempt.runDir, 'aliases', `${index}.previous`); mkdirSync(dirname(backup), { recursive: true }); copyFileSync(destination, backup);
        previous = relativePath(attempt.project.dir, backup);
      }
      const pending = assertContained(attempt.project.outDir, join(dirname(destination), `.${basename(destination)}.${attempt.attemptId}.pending`));
      copies.push({ destination: relativePath(attempt.project.dir, destination), previous, pending: relativePath(attempt.project.dir, pending) });
      copyFileSync(source, pending);
    }
    atomicJson(join(attempt.runDir, 'receipt.json'), state.receipt);
    assertAttemptInputsCurrent(attempt);
    if (optionalHash(join(attempt.project.dir, 'run.json')) !== state.receipt.previousRunSha256) throw new Error('RENDER_CURRENT_CHANGED');
    for (const copy of copies) renameSync(resolveInsideProject(attempt.project.dir, copy.pending, 'pending alias'), resolveInsideProject(attempt.project.dir, copy.destination, 'alias'));
    assertAttemptInputsCurrent(attempt);
    state.receipt = { ...state.receipt, status: 'succeeded', finishedAt: new Date().toISOString() };
    atomicJson(join(attempt.runDir, 'receipt.json'), state.receipt);
    if (options.publishRun !== false) {
      if (optionalHash(join(attempt.project.dir, 'run.json')) !== state.receipt.previousRunSha256) throw new Error('RENDER_CURRENT_CHANGED');
      atomicJson(join(attempt.project.dir, 'run.json'), log);
    }
    releaseLock(attempt);
    return options.publishRun === false ? runPath : join(attempt.project.dir, 'run.json');
  } catch (error) { failRenderAttempt(attempt, error); throw error; }
}
