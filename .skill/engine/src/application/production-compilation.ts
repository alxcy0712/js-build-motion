import { isDeepStrictEqual } from 'node:util';
import { join, relative } from 'node:path';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { NodeImportFiles, atomicImportJson } from '../adapters/import-files.ts';
import { ProjectLease } from '../adapters/project-lease.ts';
import { readProduction, type ProductionRead } from './production.ts';
import { readAssetFile } from './asset-plan.ts';
import { productionHash } from '../project/production.ts';
import { productionStages } from '../project/production-policy.ts';
import { compileProductionTimeline } from '../project/production-timeline.ts';
import { loadProject } from '../project/manifest.ts';
import { validateSpec } from '../spec/validate.ts';
import type { ResolvedVideoSpec } from '../spec/types.ts';
import { createHash, randomUUID } from 'node:crypto';

export const PRODUCTION_PROJECTION_PATH = 'production-spec.json';
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n');
const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const identity = (path: string, value: unknown) => ({ path, bytes: bytes(value).length, sha256: sha(bytes(value)) });

/** A derived projection is published last; interrupted writes fail the current guard. */
export async function compileProduction(projectDir: string, profile: 'rough' | 'final' = 'rough') {
  const project = loadProject(projectDir), tmp = join(projectDir, 'out/.tmp', 'compile-' + randomUUID());
  const lease = new ProjectLease(projectDir, tmp, 'production'), id = 'production-attempt-' + randomUUID(), productionId = 'production-' + randomUUID();
  const owner = await lease.acquireLock({ attemptId: id, productionId, pid: process.pid }, pid => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
  });
  try {
    const current = await readProduction(projectDir), compiled = compileProductionTimeline(current.bundle, profile);
    const stages = productionStages(current.bundle), blocked = stages.filter(s => s.status !== 'complete');
    const report = { version: '0.1', revision: current.state.revision, bundleHash: productionHash(current.bundle),
      profile, identity: compiled.identity, conflicts: compiled.conflicts, blockedStages: blocked,
      events: compiled.events, captionCues: compiled.captionCues, durationSamples: compiled.durationSamples };
    await atomicImportJson(projectDir, join(projectDir, 'out/production-compile.json'), report, tmp);
    if (!compiled.spec || blocked.length) return { ...report, ok: false, spec: null };
    const latest = await readProduction(projectDir);
    if (!isDeepStrictEqual(current.state, latest.state)) throw Error('PRODUCTION_REVISION_CONFLICT');
    const specPath = relative(projectDir, project.specPath), plan = current.bundle.shots!.assetPlan;
    await atomicImportJson(projectDir, join(projectDir, 'assets/asset-plan.json'), plan, tmp);
    await atomicImportJson(projectDir, project.specPath, compiled.spec, tmp);
    const projection = { version: '0.1', kind: 'production-spec-projection', runtimeId: current.manifest.runtimeId,
      revision: current.state.revision, bundleHash: report.bundleHash, identity: compiled.identity, profile,
      spec: identity(specPath, compiled.spec), assetPlan: identity('assets/asset-plan.json', plan) };
    if (!isDeepStrictEqual(current.state, (await readProduction(projectDir)).state)) throw Error('PRODUCTION_REVISION_CONFLICT');
    await atomicImportJson(projectDir, join(projectDir, PRODUCTION_PROJECTION_PATH), projection, tmp);
    return { ...report, ok: true, projection };
  } finally { await lease.releaseLock(owner, id); await rm(tmp, { recursive: true, force: true }); }
}

export async function assertProductionCurrent(projectDir: string, spec: ResolvedVideoSpec, profile?: 'rough' | 'final') {
  const current = await readProduction(projectDir);
  const raw = await readAssetFile(projectDir, PRODUCTION_PROJECTION_PATH, 8388608), projection = JSON.parse(raw.data.toString('utf8'));
  if (!projection || Object.keys(projection).sort().join() !== 'assetPlan,bundleHash,identity,kind,profile,revision,runtimeId,spec,version' ||
    projection.version !== '0.1' || projection.kind !== 'production-spec-projection' || !['rough', 'final'].includes(projection.profile) ||
    profile && projection.profile !== profile || projection.runtimeId !== current.manifest.runtimeId ||
    projection.revision !== current.state.revision || projection.bundleHash !== productionHash(current.bundle)) throw Error('PRODUCTION_SPEC_STALE');
  const compiled = compileProductionTimeline(current.bundle, projection.profile);
  if (!compiled.spec || productionStages(current.bundle).some(s => s.status !== 'complete') || compiled.identity !== projection.identity ||
    !isDeepStrictEqual(compiled.spec, spec)) throw Error('PRODUCTION_SPEC_STALE');
  const project = loadProject(projectDir);
  if (projection.spec.path !== relative(projectDir, project.specPath) || projection.assetPlan.path !== 'assets/asset-plan.json') throw Error('PRODUCTION_PROJECTION_PATH_INVALID');
  const savedSpec = await readAssetFile(projectDir, projection.spec.path, 8388608, projection.spec);
  const savedPlan = await readAssetFile(projectDir, projection.assetPlan.path, 8388608, projection.assetPlan);
  if (!isDeepStrictEqual(validateSpec(JSON.parse(savedSpec.data.toString('utf8'))).spec, spec) ||
    productionHash(JSON.parse(savedPlan.data.toString('utf8'))) !== productionHash(current.bundle.shots!.assetPlan)) throw Error('PRODUCTION_SPEC_STALE');
  return { current, compiled, projection };
}

/** Freeze the authority and the complete stored evidence needed to recheck imported inputs. */
export async function productionMediaPaths(projectDir: string, current: ProductionRead): Promise<string[]> {
  const files = new NodeImportFiles(projectDir), paths = new Set<string>(['production/manifest.json', 'production/state.json',
    'production/plan.md', 'production/decisions.jsonl', PRODUCTION_PROJECTION_PATH]);
  if (current.bundle.requirements.effective.videoLimits) paths.add(current.bundle.requirements.effective.videoLimits.path);
  let state: ProductionRead['state'] | null = current.state;
  while (state) {
    paths.add(state.bundle.path); paths.add(state.receipt.path);
    state = JSON.parse(readFileSync(join(projectDir, state.receipt.path), 'utf8')).base;
  }
  const tree = async (path: string) => {
    for (const name of await files.children(join(projectDir, path))) {
      const child = path + '/' + name, node = await files.inspect(join(projectDir, child));
      if (node.kind === 'directory') await tree(child);
      else if (node.kind === 'file' && node.nlink === '1') paths.add(child);
      else throw Error('PRODUCTION_SNAPSHOT_NODE_INVALID: ' + child);
    }
  };
  for (const path of ['inputs', 'assets']) {
    try { await files.inspect(join(projectDir, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await tree(path);
  }
  for (const name of await files.children(join(projectDir, 'runs'))) if (/^(import|unpack|catalog|align|alignment|video)-attempt-[a-f0-9-]{36}$/.test(name)) await tree('runs/' + name);
  for (const take of current.bundle.timeline?.takes ?? []) paths.add(take.file.path);
  return [...paths].sort();
}
