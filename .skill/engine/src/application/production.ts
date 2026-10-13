import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { NodeImportFiles, atomicImportJson, ensureImportDirectory, importJsonText, importProjectPath } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { readFixed } from '../adapters/inspection.ts';
import { assertCatalog, type CatalogIndex, type CatalogManifest } from '../project/catalog.ts';
import { productionHash, validateProduction, validateProductionRelations, assertProductionChecks, PRODUCTION_CHECK_IDS,
  scriptSourceHash, shotsSourceHash, type ProductionBundle, type ProductionInit, type ProductionProposal, type ProductionState, type ProductionManifest } from '../project/production.ts';
import { authorizeProduction, productionStages, productionAffected, assertProductionRequirements } from '../project/production-policy.ts';
import { renderProductionView, assertProductionViewHeader } from '../project/production-view.ts';
import { validatePreparedVideoMap } from '../project/video-preparation.ts';
import { verifyCatalog } from './catalog.ts';
import { verifyImport } from './import.ts';
import { readVideoPublication } from './video-publication.ts';

type FileIdentity = ProductionState['bundle'];
export interface ProductionCommitReceipt {
  version: '0.1'; kind: 'production-commit-receipt'; productionId: string; attemptId: string;
  operation: 'initialize' | 'apply' | 'invalidate'; base: ProductionState | null; revision: number; sourceHash: string;
  bundle: FileIdentity; manifestSha256: string; checks: string[]; rawText: string; viewPatch: string | null; viewSourceHash: string | null; createdAt: string;
}
export interface ProductionAttempt {
  version: '0.1'; kind: 'production-attempt'; productionId: string; attemptId: string; ownerPid: number;
  operation: ProductionCommitReceipt['operation']; status: 'running' | 'prepared' | 'succeeded' | 'failed' | 'interrupted';
  tempPath: string; base: ProductionState | null; result: ProductionState | null; sourceHash: string | null; error: string | null;
}
export interface ProductionOptions { signal?: AbortSignal; hooks?: {
  /** Hooks run after each durable stop; throwing simulates an owner interruption and leaves its record recoverable. */
  afterPrepared?: (attempt: ProductionAttempt) => Promise<void>; afterPublished?: (attempt: ProductionAttempt) => Promise<void>;
  afterReceipt?: (attempt: ProductionAttempt) => Promise<void>; afterCommitted?: (attempt: ProductionAttempt) => Promise<void>;
} }
export interface ProductionRead { manifest: ProductionManifest; state: ProductionState; bundle: ProductionBundle }
const metadataBytes = 8 * 1024 * 1024, uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const productionId = new RegExp(`^production-${uuid}$`), attemptId = new RegExp(`^production-attempt-${uuid}$`), active = new Set<string>();
const encoded = (value: unknown) => Buffer.from(importJsonText(value));
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function alive(pid: number, id: string): boolean {
  if (pid === process.pid) return active.has(id);
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function fixed(dir: string, path: string, expected?: FileIdentity, retain = true, signal?: AbortSignal) {
  const raw = await readFixed(importProjectPath(dir, join(dir, path)), expected?.bytes ?? metadataBytes, signal, undefined, retain);
  if (expected && (raw.bytes !== expected.bytes || raw.sha256 !== expected.sha256)) throw Error('PRODUCTION_FILE_CHANGED: ' + path);
  return { ...raw, identity: { path, bytes: raw.bytes, sha256: raw.sha256 } };
}
async function json(dir: string, path: string, expected?: FileIdentity) {
  const raw = await fixed(dir, path, expected); return { ...raw, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.data)) };
}
async function optionalJson(dir: string, path: string) {
  try { return await json(dir, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return null; }
}
function identity(path: string, value: unknown): FileIdentity { const data = encoded(value); return { path, bytes: data.length, sha256: digest(data) }; }
function receipt(value: unknown): ProductionCommitReceipt {
  const r = value as ProductionCommitReceipt;
  const keys = 'attemptId,base,bundle,checks,createdAt,kind,manifestSha256,operation,productionId,rawText,revision,sourceHash,version,viewPatch,viewSourceHash';
  if (!r || Object.keys(r).sort().join() !== keys || r.version !== '0.1' || r.kind !== 'production-commit-receipt' ||
    !productionId.test(r.productionId) || !attemptId.test(r.attemptId) || !['initialize', 'apply', 'invalidate'].includes(r.operation) ||
    typeof r.rawText !== 'string' || !r.rawText || r.viewPatch !== null && typeof r.viewPatch !== 'string' ||
    r.viewSourceHash !== null && !/^[a-f0-9]{64}$/.test(r.viewSourceHash) ||
    !Number.isSafeInteger(r.revision) || r.revision < 1 || !Number.isFinite(Date.parse(r.createdAt)) ||
    !/^[a-f0-9]{64}$/.test(r.sourceHash) || !/^[a-f0-9]{64}$/.test(r.manifestSha256) || !Array.isArray(r.checks)) throw Error('PRODUCTION_RECEIPT_INVALID');
  assertProductionChecks(r.checks);
  if (r.checks.join() !== PRODUCTION_CHECK_IDS.join()) throw Error('PRODUCTION_CHECKS_INCOMPLETE');
  if (r.base !== null) validateProduction('state', r.base);
  validateProduction('state', { version: '0.1', revision: r.revision, bundle: r.bundle, receipt: identity(`production/revisions/${r.productionId}/receipt.json`, r) });
  if (r.bundle.path !== `production/revisions/${r.productionId}/bundle.json` || r.revision !== (r.base?.revision ?? 0) + 1 ||
    (r.operation === 'initialize') !== (r.base === null)) throw Error('PRODUCTION_RECEIPT_BASE_INVALID');
  return r;
}
function attempt(value: unknown): ProductionAttempt {
  const a = value as ProductionAttempt;
  if (!a || Object.keys(a).sort().join() !== 'attemptId,base,error,kind,operation,ownerPid,productionId,result,sourceHash,status,tempPath,version' ||
    a.version !== '0.1' || a.kind !== 'production-attempt' || !productionId.test(a.productionId) || !attemptId.test(a.attemptId) ||
    !Number.isSafeInteger(a.ownerPid) || a.ownerPid < 1 || !['initialize', 'apply', 'invalidate'].includes(a.operation) ||
    !['running', 'prepared', 'succeeded', 'failed', 'interrupted'].includes(a.status) || a.tempPath !== `out/.tmp/${a.attemptId}` ||
    a.sourceHash !== null && !/^[a-f0-9]{64}$/.test(a.sourceHash) || a.error !== null && typeof a.error !== 'string') throw Error('PRODUCTION_ATTEMPT_INVALID');
  if (a.base !== null) validateProduction('state', a.base);
  if (a.result !== null) validateProduction('state', a.result);
  return a;
}
async function readManifest(dir: string) {
  const raw = await json(dir, 'production/manifest.json'), manifest = validateProduction<ProductionManifest>('manifest', raw.value),
    workspace = (await json(dir, 'workspace.json')).value;
  assertProductionChecks(manifest.requiredChecks);
  if (manifest.requiredChecks.join() !== PRODUCTION_CHECK_IDS.join()) throw Error('PRODUCTION_CHECKS_INCOMPLETE');
  if (workspace.packageId !== manifest.runtimeId || process.env.JBM_RUNTIME_ID && process.env.JBM_RUNTIME_ID !== manifest.runtimeId) throw Error('PRODUCTION_RUNTIME_CHANGED');
  return { manifest, sha256: raw.sha256 };
}
async function verifySources(dir: string, bundle: ProductionBundle, signal?: AbortSignal): Promise<void> {
  validateProductionRelations(bundle);
  const history = (await fixed(dir, 'prompt-history.jsonl', undefined, true, signal)).data.toString('utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const sourcePrompt = (ref: ProductionBundle['requirements']['requested']['sourcePrompt'], text: string, actor: string, kind?: string) => {
    const entry = history[ref.entry];
    if (!entry || productionHash(entry) !== ref.sha256 || entry.text !== text || !['prompt', 'answer', 'question'].includes(entry.kind) ||
      actor === 'user' && !['prompt', 'answer'].includes(entry.kind) || actor === 'model' && entry.kind !== 'question' ||
      kind === 'question' && entry.kind !== 'question' || kind === 'answer' && entry.kind !== 'answer') throw Error('PRODUCTION_PROMPT_SOURCE_INVALID');
  };
  const requested = bundle.requirements.requested;
  sourcePrompt(requested.sourcePrompt, requested.rawPrompt, 'user');
  assertProductionRequirements(bundle);
  for (const d of bundle.decisions) {
    if (d.sourcePrompt) sourcePrompt(d.sourcePrompt, d.rawText, d.actor, d.kind);
    else if (d.actor === 'user') throw Error('PRODUCTION_USER_SOURCE_REQUIRED');
  }
  for (const take of bundle.timeline?.takes ?? []) await fixed(dir, take.file.path, take.file, false, signal);
  const catalogs = new Map<string, CatalogManifest>();
  const catalogTuple = async (c: NonNullable<ProductionInit['requested']['inputs'][number]['catalog']>, file?: FileIdentity) => {
    let catalog = catalogs.get(c.catalogId);
    if (!catalog) {
      const index = assertCatalog<CatalogIndex>('index', (await json(dir, 'assets/catalog.json')).value), commits = index.catalogs.filter(i => i.catalogId === c.catalogId);
      if (commits.length !== 1 || commits[0]!.manifestSha256 !== c.manifestSha256) throw Error('PRODUCTION_CATALOG_NOT_COMMITTED');
      catalog = await verifyCatalog(dir, c.catalogId, { signal });
      if ((await fixed(dir, `assets/catalogs/${c.catalogId}/manifest.json`)).sha256 !== c.manifestSha256 || catalog.attemptId !== commits[0]!.attemptId) throw Error('PRODUCTION_CATALOG_CHANGED');
      catalogs.set(c.catalogId, catalog);
    } else if ((await fixed(dir, `assets/catalogs/${c.catalogId}/manifest.json`)).sha256 !== c.manifestSha256) throw Error('PRODUCTION_CATALOG_CHANGED');
    const selected = catalog.assets.filter(a => a.assetId === c.assetId && a.assetVersion === c.assetVersion);
    if (selected.length !== 1) throw Error('PRODUCTION_ASSET_VERSION_INVALID');
    const asset = selected[0]!;
    if (file && (asset.source.fixedPath !== file.path || asset.source.bytes !== file.bytes || asset.source.sha256 !== file.sha256)) throw Error('PRODUCTION_ASSET_IDENTITY_INVALID');
    return asset;
  };
  for (const input of requested.inputs) if (input.file) {
    await fixed(dir, input.file.path, input.file, false, signal);
    if (input.catalog) {
      const asset = await catalogTuple(input.catalog, input.file);
      if (input.role === 'video' && !asset.technical.streams.some(s => s.type === 'video') || input.role === 'image' && !['png_pipe', 'jpeg_pipe'].includes(asset.technical.format)) throw Error('PRODUCTION_INPUT_MEDIA_INVALID');
    } else {
      const match = /^inputs\/original\/(import-[a-f0-9-]{36})\/(.+)$/.exec(input.file.path);
      if (!match) throw Error('PRODUCTION_INPUT_IMPORT_REQUIRED');
      const manifest = await verifyImport(dir, match[1]!);
      if (!manifest.entries.some(e => e.kind === 'file' && e.path === match[2] && e.bytes === input.file!.bytes && e.sha256 === input.file!.sha256)) throw Error('PRODUCTION_INPUT_IMPORT_CHANGED');
    }
  }
  if (bundle.requirements.effective.videoLimits) await fixed(dir, bundle.requirements.effective.videoLimits.path, bundle.requirements.effective.videoLimits, true, signal);
  for (const use of bundle.shots?.assetPlan.uses ?? []) {
    const asset = await catalogTuple({ catalogId: use.catalogId, manifestSha256: use.catalogManifestSha256, assetId: use.assetId, assetVersion: use.assetVersion });
    const file = { path: asset.source.fixedPath, bytes: asset.source.bytes, sha256: use.byteSha256 };
    if (asset.source.sha256 !== use.byteSha256) throw Error('PRODUCTION_ASSET_IDENTITY_INVALID');
    if (!requested.inputs.some(i => i.catalog?.catalogId === use.catalogId && i.catalog.manifestSha256 === use.catalogManifestSha256 &&
      i.catalog.assetId === use.assetId && i.catalog.assetVersion === use.assetVersion && i.file && productionHash(i.file) === productionHash(file))) throw Error('PRODUCTION_ASSET_INPUT_LINEAGE_REQUIRED');
    await fixed(dir, file.path, file, false, signal);
    if (use.selection.kind === 'video') {
      const raw = await fixed(dir, use.selection.map.path, use.selection.map), map = validatePreparedVideoMap(JSON.parse(raw.data.toString('utf8')));
      await readVideoPublication(dir, use.selection.map.path, raw.data);
      const request = map.request;
      if (request.catalogId !== use.catalogId || request.catalogManifestSha256 !== use.catalogManifestSha256 || request.assetId !== use.assetId ||
        request.assetVersion !== use.assetVersion || request.byteSha256 !== use.byteSha256 || productionHash(request.sourceRange) !== productionHash(use.sourceRange) ||
        !use.mute && map.coverage.audio === 'muted') throw Error('PRODUCTION_VIDEO_SELECTION_INVALID');
      await fixed(dir, map.canonical.path, map.canonical, false, signal); await fixed(dir, map.proxy.path, map.proxy, false, signal);
      if (map.audio) await fixed(dir, map.audio.path, map.audio, false, signal);
    }
  }
}
async function stored(dir: string, state: ProductionState, manifestSha256: string, seen = new Set<string>()): Promise<ProductionBundle> {
  validateProduction('state', state);
  if (!new RegExp(`^production/revisions/production-${uuid}/receipt\\.json$`).test(state.receipt.path) || seen.has(state.receipt.path) || seen.size > 1000) throw Error('PRODUCTION_REVISION_CHAIN_INVALID');
  seen.add(state.receipt.path);
  const r = receipt((await json(dir, state.receipt.path, state.receipt)).value), raw = await json(dir, state.bundle.path, state.bundle),
    bundle = validateProduction<ProductionBundle>('bundle', raw.value), prefix = `production/revisions/${r.productionId}`;
  if (state.receipt.path !== `${prefix}/receipt.json` || productionHash(state.bundle) !== productionHash(r.bundle) || state.revision !== r.revision ||
    productionHash(bundle) !== r.sourceHash || r.manifestSha256 !== manifestSha256 || (await new NodeImportFiles(dir).children(join(dir, prefix))).join() !== 'bundle.json,receipt.json') throw Error('PRODUCTION_COMMIT_CHANGED');
  if (r.base) {
    const previous = await stored(dir, r.base, manifestSha256, seen);
    if (productionHash(previous.requirements.requested) !== productionHash(bundle.requirements.requested) ||
      productionHash(previous.decisions) !== productionHash(bundle.decisions.slice(0, previous.decisions.length))) throw Error('PRODUCTION_APPEND_ONLY_VIOLATION');
  }
  validateProductionRelations(bundle); return bundle;
}
export async function readProduction(projectDir: string): Promise<ProductionRead> {
  const dir = resolve(projectDir), { manifest, sha256 } = await readManifest(dir), raw = await json(dir, 'production/state.json'),
    state = validateProduction<ProductionState>('state', raw.value), bundle = await stored(dir, state, sha256);
  if ((await new NodeImportFiles(dir).children(join(dir, 'production'))).some(name => !['manifest.json', 'state.json', 'revisions', 'decisions.jsonl', 'plan.md'].includes(name))) throw Error('PRODUCTION_OUTPUT_UNLISTED');
  await verifySources(dir, bundle); productionStages(bundle); return { manifest, state, bundle };
}
export async function productionNext(projectDir: string) {
  const current = await readProduction(projectDir);
  return { revision: current.state.revision, sourceHash: productionHash(current.bundle), stages: productionStages(current.bundle),
    bundle: current.state.bundle, requirements: current.bundle.requirements, script: current.bundle.script, shots: current.bundle.shots, ...(Object.hasOwn(current.bundle, 'timeline') ? { timeline: current.bundle.timeline } : {}) };
}
async function writeText(dir: string, path: string, text: string, temporaryDir: string) {
  const files = new NodeImportFiles(dir, temporaryDir), target = files.projectPath(join(dir, path));
  try { const node = await files.inspect(target); if (node.kind !== 'file' || node.nlink !== '1') throw Error('PRODUCTION_VIEW_FILE_INVALID'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await ensureImportDirectory(dir, dirname(target)); await ensureImportDirectory(dir, temporaryDir);
  const pending = importProjectPath(dir, join(temporaryDir, `view-${randomUUID()}.pending`)), fd = await open(pending, 'wx', 0o600);
  try { await fd.writeFile(text); await fd.sync(); } finally { await fd.close(); }
  importProjectPath(dir, target); await rename(pending, target);
}
async function projections(dir: string, current: ProductionRead, temporaryDir: string) {
  const rendered = renderProductionView(current.bundle, current.state.revision), r = receipt((await json(dir, current.state.receipt.path, current.state.receipt)).value);
  try { const raw = await fixed(dir, 'production/plan.md');
    if (raw.data.toString('utf8') !== rendered && raw.sha256 !== r.viewSourceHash) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT');
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await writeText(dir, 'production/decisions.jsonl', current.bundle.decisions.map(d => JSON.stringify(d) + '\n').join(''), temporaryDir);
  await writeText(dir, 'production/plan.md', rendered, temporaryDir);
}
async function assertViewSource(dir: string, sourceHash: string | null) {
  let current: string | null = null;
  try { current = (await fixed(dir, 'production/plan.md')).sha256; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (current !== sourceHash) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT');
}
async function lock<T>(dir: string, options: ProductionOptions, work: (files: NodeImportFiles, currentAttempt: ProductionAttempt, temporaryDir: string) => Promise<T>) {
  const id = `production-attempt-${randomUUID()}`, product = `production-${randomUUID()}`, temporaryDir = join(dir, `out/.tmp/${id}`),
    files = new NodeImportFiles(dir, temporaryDir), lease = new ProjectLease(dir, temporaryDir, 'production');
  let acquired: string | null = null; active.add(id);
  const a: ProductionAttempt = { version: '0.1', kind: 'production-attempt', productionId: product, attemptId: id, ownerPid: process.pid,
    operation: 'apply', status: 'running', tempPath: `out/.tmp/${id}`, base: null, result: null, sourceHash: null, error: null };
  try { options.signal?.throwIfAborted(); await files.assertProject(); await files.ensureDirectory(join(dir, 'runs'));
    acquired = await lease.acquireLock({ attemptId: id, productionId: product, pid: process.pid }, alive, options.signal);
    return await work(files, a, temporaryDir);
  } finally {
    if (acquired) await lease.releaseLock(acquired, id); active.delete(id);
    if (a.status !== 'prepared') await rm(files.projectPath(temporaryDir), { recursive: true, force: true });
  }
}
async function cas(dir: string, expected: ProductionState | null) {
  const state = await optionalJson(dir, 'production/state.json');
  if (productionHash(state?.value ?? null) !== productionHash(expected)) throw Error('PRODUCTION_REVISION_CONFLICT');
}
async function recover(dir: string, files: NodeImportFiles, temporaryDir: string) {
  const recovered: ProductionAttempt[] = [];
  for (const name of (await files.attemptDirectories()).filter(n => attemptId.test(n)).sort()) {
    const raw = await optionalJson(dir, `runs/${name}/receipt.json`); if (!raw) continue;
    const a = attempt(raw.value);
    if (a.attemptId !== name) throw Error('PRODUCTION_RECOVERY_IDENTITY_INVALID');
    if ((await files.children(join(dir, 'runs', name))).join() !== 'receipt.json') throw Error('PRODUCTION_OUTPUT_UNLISTED');
    if (!['running', 'prepared'].includes(a.status) || alive(a.ownerPid, name)) continue;
    const { manifest, sha256 } = await readManifest(dir), current = await optionalJson(dir, 'production/state.json');
    try {
      if (!a.result) throw Error('PRODUCTION_INTERRUPTED_BEFORE_RECEIPT');
      const bundle = await stored(dir, a.result, sha256), r = receipt((await json(dir, a.result.receipt.path, a.result.receipt)).value);
      if (r.attemptId !== name || r.productionId !== a.productionId || r.operation !== a.operation || productionHash(r.base) !== productionHash(a.base) || r.sourceHash !== a.sourceHash) throw Error('PRODUCTION_RECOVERY_BINDING_INVALID');
      await verifySources(dir, bundle); productionStages(bundle);
      if (productionHash(current?.value ?? null) !== productionHash(a.result)) {
        await assertViewSource(dir, r.viewSourceHash); await cas(dir, a.base); await atomicImportJson(dir, join(dir, 'production/state.json'), a.result, temporaryDir);
      } else {
        const view = await fixed(dir, 'production/plan.md').catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return null; });
        if (view && view.sha256 !== r.viewSourceHash && view.data.toString('utf8') !== renderProductionView(bundle, a.result.revision)) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT');
      }
      a.status = 'succeeded'; a.error = null; await projections(dir, { manifest, state: a.result, bundle }, temporaryDir);
    } catch (e) { a.status = 'interrupted'; a.error = e instanceof Error ? e.message : String(e); }
    await files.writeJson(join(dir, `runs/${name}/receipt.json`), a); recovered.push(a);
    await rm(files.projectPath(join(dir, a.tempPath)), { recursive: true, force: true });
  }
  return recovered;
}
async function commit(dir: string, files: NodeImportFiles, a: ProductionAttempt, temporaryDir: string,
  manifestSha256: string, bundle: ProductionBundle, rawText: string, viewPatch: string | null, viewSourceHash: string | null, options: ProductionOptions) {
  const run = join(dir, `runs/${a.attemptId}/receipt.json`), stage = join(temporaryDir, 'prepared'), prefix = `production/revisions/${a.productionId}`;
  let hookInterrupted = false, committed = false;
  const hook = async (fn?: (attempt: ProductionAttempt) => Promise<void>) => {
    if (fn) { hookInterrupted = true; await fn(structuredClone(a)); hookInterrupted = false; } options.signal?.throwIfAborted();
  };
  await files.writeJson(run, a);
  try {
    await verifySources(dir, bundle, options.signal); productionStages(bundle); await cas(dir, a.base);
    await files.ensureDirectory(stage); await files.writeJson(join(stage, 'bundle.json'), bundle);
    const r: ProductionCommitReceipt = { version: '0.1', kind: 'production-commit-receipt', productionId: a.productionId, attemptId: a.attemptId,
      operation: a.operation, base: a.base, revision: (a.base?.revision ?? 0) + 1, sourceHash: productionHash(bundle),
      bundle: identity(`${prefix}/bundle.json`, bundle), manifestSha256, checks: [...PRODUCTION_CHECK_IDS], rawText, viewPatch, viewSourceHash, createdAt: new Date().toISOString() };
    receipt(r); a.result = { version: '0.1', revision: r.revision, bundle: r.bundle, receipt: identity(`${prefix}/receipt.json`, r) };
    a.sourceHash = r.sourceHash; a.status = 'prepared'; await files.writeJson(run, a); await hook(options.hooks?.afterPrepared);
    await verifySources(dir, bundle, options.signal); await cas(dir, a.base);
    await files.moveDirectory(stage, join(dir, prefix)); await hook(options.hooks?.afterPublished);
    await files.writeJson(join(dir, `${prefix}/receipt.json`), r); await hook(options.hooks?.afterReceipt);
    await stored(dir, a.result, manifestSha256); await verifySources(dir, bundle, options.signal); await assertViewSource(dir, viewSourceHash); await cas(dir, a.base);
    await files.writeJson(join(dir, 'production/state.json'), a.result); committed = true; a.status = 'succeeded';
    await files.writeJson(run, a); await hook(options.hooks?.afterCommitted);
    const current = await readProduction(dir); await projections(dir, current, temporaryDir); return current;
  } catch (e) {
    if (!hookInterrupted && !committed) { a.status = options.signal?.aborted ? 'interrupted' : 'failed'; a.error = e instanceof Error ? e.message : String(e); await files.writeJson(run, a); }
    throw e;
  }
}
export async function initializeProduction(projectDir: string, input: unknown, options: ProductionOptions = {}): Promise<ProductionRead> {
  const init = validateProduction<ProductionInit>('init', structuredClone(input)), dir = resolve(projectDir);
  const bundle: ProductionBundle = { version: '0.1', requirements: { requested: init.requested, effective: init.effective }, script: null, shots: null, decisions: init.decisions, invalidations: [] };
  return await lock(dir, options, async (files, a, tmp) => {
    if (await optionalJson(dir, 'production/state.json')) throw Error('PRODUCTION_ALREADY_INITIALIZED');
    await verifySources(dir, bundle, options.signal); authorizeProduction(bundle, 'plan', 'project');
    const workspace = (await json(dir, 'workspace.json')).value;
    if (!/^[a-f0-9]{64}$/.test(workspace.packageId) || process.env.JBM_RUNTIME_ID && workspace.packageId !== process.env.JBM_RUNTIME_ID) throw Error('PRODUCTION_RUNTIME_INVALID');
    const manifest: ProductionManifest = { version: '0.1', kind: 'production-manifest', authority: 'production', workflowVersion: 'p3-mvp-1', runtimeId: workspace.packageId, requiredChecks: [...PRODUCTION_CHECK_IDS] };
    const previous = await optionalJson(dir, 'production/manifest.json');
    if (previous && productionHash(previous.value) !== productionHash(manifest)) throw Error('PRODUCTION_MANIFEST_CHANGED');
    if (!previous) await files.writeJson(join(dir, 'production/manifest.json'), manifest);
    a.operation = 'initialize'; return await commit(dir, files, a, tmp, (await fixed(dir, 'production/manifest.json')).sha256, bundle, init.requested.rawPrompt, null, null, options);
  });
}
export async function applyProduction(projectDir: string, input: unknown, options: ProductionOptions = {}): Promise<ProductionRead> {
  const proposal = validateProduction<ProductionProposal>('proposal', structuredClone(input)), dir = resolve(projectDir);
  return await lock(dir, options, async (files, a, tmp) => {
    await recover(dir, files, tmp); const current = await readProduction(dir), sourceHash = productionHash(current.bundle);
    if (proposal.expectedRevision !== current.state.revision || proposal.expectedSourceHash !== sourceHash) throw Error('PRODUCTION_REVISION_CONFLICT');
    authorizeProduction(current.bundle, 'plan', 'project');
    let viewPatch: string | null = null, viewSourceHash: string | null = null;
    try { const raw = await fixed(dir, 'production/plan.md'), text = raw.data.toString('utf8'); assertProductionViewHeader(text, current.state.revision, sourceHash);
      viewSourceHash = raw.sha256;
      if (text !== renderProductionView(current.bundle, current.state.revision)) {
        if (proposal.expectedViewHash !== raw.sha256) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT'); viewPatch = text;
      }
      if (proposal.expectedViewHash !== null && proposal.expectedViewHash !== raw.sha256) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; if (proposal.expectedViewHash !== null) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT'); }
    const bundle = structuredClone(current.bundle);
    if (proposal.changes.effective) bundle.requirements.effective = proposal.changes.effective;
    if (proposal.changes.script) { bundle.script = proposal.changes.script; bundle.script.sourceHash = scriptSourceHash(bundle); }
    if (proposal.changes.shots) { bundle.shots = proposal.changes.shots; bundle.shots.sourceHash = shotsSourceHash(bundle); }
    if (Object.hasOwn(proposal.changes, 'timeline')) bundle.timeline = proposal.changes.timeline;
    bundle.decisions.push(...proposal.decisions);
    bundle.invalidations = bundle.invalidations.filter(i => productionAffected(current.bundle, [i.key]).some(task =>
      task === 'requirements' ? !proposal.changes.effective : task === 'script' ? !proposal.changes.script : task === 'shots' ? !proposal.changes.shots : !Object.hasOwn(proposal.changes, 'timeline')));
    bundle.invalidations.push(...proposal.invalidations);
    productionAffected(bundle, proposal.invalidations.map(i => i.key));
    a.base = current.state; a.operation = 'apply';
    return await commit(dir, files, a, tmp, (await readManifest(dir)).sha256, bundle, proposal.rawText, viewPatch, viewSourceHash, options);
  });
}
export async function resumeProduction(projectDir: string, options: ProductionOptions = {}) {
  const dir = resolve(projectDir);
  return await lock(dir, options, async (files, _a, tmp) => {
    const recovered = await recover(dir, files, tmp), raw = await optionalJson(dir, 'production/state.json'), current = raw ? await readProduction(dir) : null;
    if (current) await projections(dir, current, tmp);
    return { recovered, current };
  });
}
export async function invalidateProduction(projectDir: string, expectedRevision: number, expectedSourceHash: string,
  invalidations: ProductionBundle['invalidations'], options: ProductionOptions = {}) {
  return await applyProduction(projectDir, { version: '0.1', expectedRevision, expectedSourceHash, expectedViewHash: null, rawText: invalidations.map(i => i.reason).join('\n'),
    changes: { effective: null, script: null, shots: null }, decisions: [], invalidations }, options);
}
export async function writeProductionView(projectDir: string, expectedRevision?: number, expectedSourceHash?: string) {
  const dir = resolve(projectDir);
  return await lock(dir, {}, async (files, _a, tmp) => {
    const current = await readProduction(dir);
    if (expectedRevision !== undefined && expectedRevision !== current.state.revision || expectedSourceHash !== undefined && expectedSourceHash !== productionHash(current.bundle)) throw Error('PRODUCTION_REVISION_CONFLICT');
    try { const text = (await fixed(dir, 'production/plan.md')).data.toString('utf8');
      assertProductionViewHeader(text, current.state.revision, productionHash(current.bundle));
      if (text !== renderProductionView(current.bundle, current.state.revision)) throw Error('PRODUCTION_VIEW_PATCH_CONFLICT');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await projections(dir, current, tmp);
    return { path: 'production/plan.md', revision: current.state.revision, sourceHash: productionHash(current.bundle) };
  });
}
