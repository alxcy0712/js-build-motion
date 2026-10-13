import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { NodeImportFiles, atomicImportJson } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { validateDelivery, type DeliveryCredits, type DeliveryFile, type DeliveryManifest, type DeliveryRequest, type StructuredReview } from '../project/delivery.ts';
import { assertDeliverable } from '../project/review-validation.ts';
import { UUID_PATTERN } from '../project/unpack.ts';
import { readAssetFile } from './asset-plan.ts';
import { readDeliveryContext, readDeliveryDocument, verifyDeliveryApprovals, verifyDeliveryFiles } from './delivery-context.ts';

interface DeliveryCopy { source: DeliveryFile; file: DeliveryFile }
interface DeliveryReceipt {
  version: '0.1'; kind: 'delivery-receipt'; deliveryId: string; attemptId: string; ownerPid: number;
  createdAt: string; finishedAt: string | null; status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted';
  request: DeliveryRequest; manifest: DeliveryFile | null; copies: DeliveryCopy[]; previousCurrent: DeliveryFile | null; error: string | null;
}
interface DeliveryCurrent { version: '0.1'; kind: 'delivery-current'; deliveryId: string; manifest: DeliveryFile; receipt: DeliveryFile }
export interface DeliveryHookState { deliveryId: string; attemptId: string; manifest: DeliveryFile | null; copies: DeliveryCopy[] }
export interface DeliveryOptions { signal?: AbortSignal; hooks?: {
  afterCopy?: (state: DeliveryHookState) => Promise<void>;
  beforePublish?: (state: DeliveryHookState) => Promise<void>;
  afterPublish?: (state: DeliveryHookState) => Promise<void>;
  beforeCurrent?: (state: DeliveryHookState) => Promise<void>;
} }
const idPattern = new RegExp(`^delivery-${UUID_PATTERN}$`), active = new Set<string>();
const CURRENT = 'out/deliveries/current.json', METADATA_BYTES = 8388608;
const receiptPath = (id: string) => `runs/delivery-attempt-${id.slice(9)}/receipt.json`;
const manifestPath = (id: string) => `out/deliveries/${id}/manifest.json`;
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected;
const validFile = (v: unknown): v is DeliveryFile => {
  try { validateDelivery<DeliveryFile>('file', v); return true; } catch { return false; }
};
function checkId(id: string): void { if (!idPattern.test(id)) throw Error('DELIVERY_ID_INVALID'); }
function distinct(files: readonly DeliveryFile[]): DeliveryFile[] {
  const result = new Map<string, DeliveryFile>();
  for (const file of files) {
    if (!validFile(file)) throw Error('DELIVERY_FILE_INVALID');
    const previous = result.get(file.path);
    if (previous && !isDeepStrictEqual(previous, file)) throw Error('DELIVERY_FILE_BINDING_CONFLICT: ' + file.path);
    result.set(file.path, file);
  }
  if (result.size > 1000) throw Error('DELIVERY_FILE_SET_LIMIT');
  return [...result.values()];
}
function evidenceFiles(review: StructuredReview, credits: DeliveryCredits): DeliveryFile[] {
  return distinct([...review.observations.flatMap(o => o.evidence), ...review.checks.flatMap(c => c.evidence),
    ...review.references.flatMap(r => [...r.evidence, ...(r.file ? [r.file] : [])]), ...credits.sources.flatMap(s => s.evidence)]);
}
async function identity(files: NodeImportFiles, path: string, signal?: AbortSignal): Promise<DeliveryFile> {
  return { path, ...await files.hash(files.projectPath(join(files.projectDir, path)), signal) };
}
async function optionalIdentity(files: NodeImportFiles, path: string, signal?: AbortSignal): Promise<DeliveryFile | null> {
  try { return await identity(files, path, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function documents(dir: string, request: DeliveryRequest) {
  const context = await readDeliveryContext(dir);
  const review = await readDeliveryDocument<StructuredReview>(dir, request.review, 'review');
  const credits = await readDeliveryDocument<DeliveryCredits>(dir, request.credits, 'credits');
  await verifyDeliveryApprovals(dir, request);
  const checked = assertDeliverable(request, review, credits, context);
  await verifyDeliveryFiles(dir, evidenceFiles(checked.review, checked.credits));
  return { context, ...checked };
}
function assertReceipt(value: unknown, id: string): DeliveryReceipt {
  const r = value as DeliveryReceipt;
  if (!r || typeof r !== 'object' || !keys(r, 'attemptId,copies,createdAt,deliveryId,error,finishedAt,kind,manifest,ownerPid,previousCurrent,request,status,version') ||
    r.version !== '0.1' || r.kind !== 'delivery-receipt' || r.deliveryId !== id || r.attemptId !== `delivery-attempt-${id.slice(9)}` ||
    !Number.isSafeInteger(r.ownerPid) || r.ownerPid < 1 || typeof r.createdAt !== 'string' || !r.createdAt ||
    typeof r.finishedAt !== 'string' || !r.finishedAt || r.status !== 'succeeded' || r.error !== null ||
    !validFile(r.manifest) || r.manifest.path !== manifestPath(id) || r.previousCurrent !== null && !validFile(r.previousCurrent) ||
    !Array.isArray(r.copies) || !r.copies.length || r.copies.length > 1000 || r.copies.some(c => !c ||
      !keys(c, 'file,source') || !validFile(c.source) || !validFile(c.file) || !c.file.path.startsWith(`out/deliveries/${id}/`) ||
      c.file.path === manifestPath(id) || c.source.bytes !== c.file.bytes || c.source.sha256 !== c.file.sha256)) throw Error('DELIVERY_NOT_COMMITTED');
  validateDelivery<DeliveryRequest>('request', r.request);
  if (distinct(r.copies.map(c => c.file)).length !== r.copies.length || distinct(r.copies.map(c => c.source)).length !== r.copies.length) throw Error('DELIVERY_RECEIPT_INVALID');
  return r;
}
function assertCurrent(value: unknown): DeliveryCurrent {
  const c = value as DeliveryCurrent;
  if (!c || typeof c !== 'object' || !keys(c, 'deliveryId,kind,manifest,receipt,version') || c.version !== '0.1' || c.kind !== 'delivery-current' ||
    !idPattern.test(c.deliveryId) || !validFile(c.manifest) || !validFile(c.receipt) ||
    c.manifest.path !== manifestPath(c.deliveryId) || c.receipt.path !== receiptPath(c.deliveryId)) throw Error('DELIVERY_CURRENT_INVALID');
  return c;
}
async function copyPlan(dir: string, request: DeliveryRequest, review: StructuredReview, credits: DeliveryCredits, files: NodeImportFiles) {
  const s = request.subject, entries: { source: DeliveryFile; name: string }[] = [];
  const add = (source: DeliveryFile, name: string) => {
    const existing = entries.find(e => e.source.path === source.path);
    if (existing) { if (!isDeepStrictEqual(existing.source, source)) throw Error('DELIVERY_FILE_BINDING_CONFLICT'); return; }
    entries.push({ source, name });
  };
  add({ path: s.artifact.path, bytes: s.artifact.bytes, sha256: s.artifact.sha256 }, 'artifact.mp4');
  add(request.review, 'review.json'); add(request.credits, 'credits.json');
  add(s.production.bundle, 'bundle.json'); add(s.production.projection, 'projection.json'); add(s.renderEvidence, 'render-evidence.json');
  if (s.audio.master) add(s.audio.master, 'master.wav');
  const run = await identity(files, 'run.json');
  if (run.sha256 !== s.artifact.runSha256) throw Error('DELIVERY_RUN_CHANGED');
  add(run, 'run.json');
  const snapshot = await identity(files, `runs/${s.artifact.attemptId}/input-snapshot.json`);
  if (snapshot.sha256 !== s.artifact.inputSnapshotSha256) throw Error('DELIVERY_SNAPSHOT_CHANGED');
  add(snapshot, 'input-snapshot.json');
  for (const extension of ['srt', 'vtt']) {
    const file = await optionalIdentity(files, `${dirname(s.artifact.path)}/${basename(dir)}.${extension}`);
    if (file) add(file, `captions.${extension}`);
  }
  for (const [index, source] of evidenceFiles(review, credits).entries()) add(source, `evidence/${index}-${basename(source.path)}`);
  distinct(entries.map(e => e.source));
  return entries;
}
function ownerAlive(pid: number, attempt: string): boolean {
  if (pid === process.pid) return active.has(attempt);
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; }
}

/** Publish one immutable local package. Current changes only after all byte and review gates pass. */
export async function deliverProject(projectDir: string, value: unknown, options: DeliveryOptions = {}) {
  const request = structuredClone(validateDelivery<DeliveryRequest>('request', value)), uuid = randomUUID(), deliveryId = `delivery-${uuid}`,
    attemptId = `delivery-attempt-${uuid}`, leaseAttempt = `production-attempt-${uuid}`,
    tmp = join(projectDir, `out/.tmp/${attemptId}`), stage = join(tmp, 'package'), destination = `out/deliveries/${deliveryId}`,
    files = new NodeImportFiles(projectDir, tmp), lease = new ProjectLease(projectDir, tmp, 'production');
  const receipt: DeliveryReceipt = { version: '0.1', kind: 'delivery-receipt', deliveryId, attemptId, ownerPid: process.pid,
    createdAt: new Date().toISOString(), finishedAt: null, status: 'running', request, manifest: null, copies: [], previousCurrent: null, error: null };
  let owner: string | null = null, committed = false, receiptSucceeded = false;
  const cleanupErrors: string[] = [];
  const save = () => files.writeJson(join(projectDir, receiptPath(deliveryId)), receipt);
  const hook = async (fn?: (state: DeliveryHookState) => Promise<void>) => {
    if (fn) await fn(structuredClone({ deliveryId, attemptId, manifest: receipt.manifest, copies: receipt.copies }));
    options.signal?.throwIfAborted();
  };
  active.add(leaseAttempt);
  try {
    options.signal?.throwIfAborted(); await files.assertProject(); await files.ensureDirectory(join(projectDir, 'runs'));
    owner = await lease.acquireLock({ attemptId: leaseAttempt, productionId: `production-${uuid}`, pid: process.pid }, ownerAlive, options.signal);
    receipt.previousCurrent = await optionalIdentity(files, CURRENT, options.signal); await save();
    const checked = await documents(projectDir, request), plan = await copyPlan(projectDir, request, checked.review, checked.credits, files);
    await files.ensureDirectory(stage);
    for (const { source, name } of plan) {
      options.signal?.throwIfAborted(); const from = files.projectPath(join(projectDir, source.path)), to = files.projectPath(join(stage, name));
      const copied = await files.copy(from, to, await files.inspect(from), async () => {}, options.signal);
      if (copied.bytes !== source.bytes || copied.sha256 !== source.sha256) throw Error('DELIVERY_SOURCE_CHANGED: ' + source.path);
      receipt.copies.push({ source, file: { path: `${destination}/${name}`, ...copied } });
      const actual = await files.hash(to, options.signal);
      if (!isDeepStrictEqual(actual, copied)) throw Error('DELIVERY_COPY_CHANGED: ' + name);
    }
    const manifest = validateDelivery<DeliveryManifest>('manifest', { version: '0.1', kind: 'delivery-manifest', deliveryId,
      createdAt: receipt.createdAt, scope: 'local-delivery', subject: request.subject, review: request.review, credits: request.credits,
      files: receipt.copies.map(c => c.file), sourceRights: checked.credits.sources, knownLimitations: request.knownLimitations });
    await files.writeJson(join(stage, 'manifest.json'), manifest);
    receipt.manifest = { path: manifestPath(deliveryId), ...await files.hash(join(stage, 'manifest.json'), options.signal) };
    receipt.status = 'prepared'; await save(); await hook(options.hooks?.afterCopy);
    const recheck = async () => {
      options.signal?.throwIfAborted(); await documents(projectDir, request);
      await verifyDeliveryFiles(projectDir, receipt.copies.map(c => c.source));
      if (!isDeepStrictEqual(await optionalIdentity(files, CURRENT, options.signal), receipt.previousCurrent)) throw Error('DELIVERY_CURRENT_CHANGED');
    };
    await recheck(); await hook(options.hooks?.beforePublish); await recheck();
    await files.moveDirectory(stage, join(projectDir, destination)); await hook(options.hooks?.afterPublish);
    await recheck(); await verifyDeliveryFiles(projectDir, [...receipt.copies.map(c => c.file), receipt.manifest]);
    receipt.status = 'succeeded'; receipt.finishedAt = new Date().toISOString(); await save(); receiptSucceeded = true;
    const current: DeliveryCurrent = { version: '0.1', kind: 'delivery-current', deliveryId, manifest: receipt.manifest,
      receipt: await identity(files, receiptPath(deliveryId), options.signal) };
    await hook(options.hooks?.beforeCurrent);
    await recheck(); await verifyDeliveryFiles(projectDir, [...receipt.copies.map(c => c.file), receipt.manifest, current.receipt]);
    options.signal?.throwIfAborted(); await atomicImportJson(projectDir, join(projectDir, CURRENT), current, tmp); committed = true;
    return { ok: true, status: 'succeeded' as const, deliveryId, path: destination, manifest: current.manifest, receipt: current.receipt, current: CURRENT, cleanupErrors };
  } catch (error) {
    if (owner && !committed) {
      const message = error instanceof Error ? error.message : String(error);
      if (receiptSucceeded) await files.writeJson(join(projectDir, `runs/${attemptId}/error.json`), { version: '0.1', kind: 'delivery-current-publication-error',
        deliveryId, attemptId, recordedAt: new Date().toISOString(), manifest: receipt.manifest, previousCurrent: receipt.previousCurrent, error: message });
      else { receipt.status = options.signal?.aborted ? 'interrupted' : 'failed'; receipt.finishedAt = new Date().toISOString(); receipt.error = message; await save(); }
    }
    throw error;
  } finally {
    const cleanupError = async (error: unknown) => {
      if (!committed) throw error;
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
      await files.writeJson(join(projectDir, `runs/${attemptId}/cleanup-error.json`), { version: '0.1', kind: 'delivery-cleanup-error',
        deliveryId, attemptId, recordedAt: new Date().toISOString(), errors: cleanupErrors }).catch(error => cleanupErrors.push(String(error)));
    };
    try { if (owner) await lease.releaseLock(owner, leaseAttempt).catch(cleanupError); }
    finally { active.delete(leaseAttempt); await rm(tmp, { recursive: true, force: true }).catch(cleanupError); }
  }
}

/** Recheck both the immutable copies and their current project sources; historical bytes alone cannot pass current delivery. */
export async function verifyDelivery(projectDir: string, deliveryId?: string) {
  let current: DeliveryCurrent | null = null;
  if (deliveryId === undefined) current = assertCurrent(JSON.parse((await readAssetFile(projectDir, CURRENT, METADATA_BYTES)).data.toString('utf8')));
  const id = deliveryId ?? current!.deliveryId; checkId(id);
  const receiptRaw = await readAssetFile(projectDir, receiptPath(id), METADATA_BYTES, current?.receipt);
  const receipt = assertReceipt(JSON.parse(receiptRaw.data.toString('utf8')), id);
  const manifest = await readDeliveryDocument<DeliveryManifest>(projectDir, receipt.manifest!, 'manifest');
  if (manifest.deliveryId !== id || current && !isDeepStrictEqual(current.manifest, receipt.manifest) ||
    !isDeepStrictEqual(manifest.subject, receipt.request.subject) || !isDeepStrictEqual(manifest.review, receipt.request.review) ||
    !isDeepStrictEqual(manifest.credits, receipt.request.credits) || !isDeepStrictEqual(manifest.files, receipt.copies.map(c => c.file)) ||
    !isDeepStrictEqual(manifest.knownLimitations, receipt.request.knownLimitations)) throw Error('DELIVERY_MANIFEST_BINDING_INVALID');
  const checked = await documents(projectDir, receipt.request);
  if (!isDeepStrictEqual(manifest.sourceRights, checked.credits.sources)) throw Error('DELIVERY_RIGHTS_CHANGED');
  await verifyDeliveryFiles(projectDir, distinct([...manifest.files, ...receipt.copies.map(c => c.source)]));
  const prefix = `out/deliveries/${id}/`, plan = await copyPlan(projectDir, receipt.request, checked.review, checked.credits, new NodeImportFiles(projectDir));
  if (plan.length !== receipt.copies.length || plan.some(({ source, name }) => {
    const copy = receipt.copies.find(c => c.file.path === prefix + name);
    return !copy || !isDeepStrictEqual(copy.source, source);
  })) throw Error('DELIVERY_REQUIRED_COPY_MISSING');
  return { ok: true, status: 'succeeded' as const, deliveryId: id, path: prefix.slice(0, -1), manifest: receipt.manifest!, receipt: receiptRaw.identity, current: current ? CURRENT : null };
}
