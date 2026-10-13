import { parseArgs } from 'node:util';
import { loadProject } from '../project/manifest.ts';
import { PRODUCTION_SCHEMAS, validateProduction, type ProductionInit, type ProductionProposal } from '../project/production.ts';
import { readAssetFile } from '../application/asset-plan.ts';
import { compileProduction } from '../application/production-compilation.ts';
import { initializeProduction, productionNext, applyProduction, resumeProduction, invalidateProduction, writeProductionView } from '../application/production.ts';

/** Model-authored proposals enter through the same fixed project boundary as originals. */
export async function cmdProduction(argv: string[]): Promise<number> {
  const [target, ...args] = argv;
  if (!target) throw Error('PRODUCTION_USAGE: production <project> init|next|apply|resume|invalidate|view|compile [options]');
  const { values, positionals } = parseArgs({ args, options: {
    profile: { type: 'string' }, request: { type: 'string' }, proposal: { type: 'string' }, schema: { type: 'string' },
    'expected-revision': { type: 'string' }, 'source-hash': { type: 'string' }, key: { type: 'string', multiple: true }, reason: { type: 'string' },
  }, allowPositionals: true });
  if (positionals.length > 1) throw Error('PRODUCTION_USAGE: one operation');
  const operation = positionals[0];
  const allowed: Record<string, readonly string[]> = {
    compile: ['profile'], init: ['request'], next: [], apply: ['proposal'], resume: [],
    invalidate: ['expected-revision', 'source-hash', 'key', 'reason'], view: ['expected-revision', 'source-hash'],
  };
  if (values.schema !== undefined) {
    if (operation || Object.keys(values).length !== 1 || !Object.hasOwn(PRODUCTION_SCHEMAS, values.schema)) throw Error('PRODUCTION_SCHEMA_UNKNOWN');
    process.stdout.write(JSON.stringify(PRODUCTION_SCHEMAS[values.schema as keyof typeof PRODUCTION_SCHEMAS], null, 2) + '\n');
    return 0;
  }
  if (!operation || !Object.hasOwn(allowed, operation) || Object.keys(values).some(k => !allowed[operation]!.includes(k))) throw Error('PRODUCTION_USAGE: unexpected operation or option');
  const project = loadProject(target);
  const read = async <T>(path: string | undefined, kind: 'init' | 'proposal'): Promise<T> => {
    if (!path) throw Error('PRODUCTION_USAGE: --' + (kind === 'init' ? 'request' : 'proposal') + ' required');
    const raw = await readAssetFile(project.dir, path, 4194304);
    return validateProduction<T>(kind, JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.data)));
  };
  const expected = (): [number, string] => {
    const revision = values['expected-revision'], hash = values['source-hash'];
    if (!revision || !/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !hash || !/^[a-f0-9]{64}$/.test(hash)) throw Error('PRODUCTION_USAGE: expected revision and source hash required');
    return [Number(revision), hash];
  };
  let result: unknown;
  switch (operation) {
    case 'compile': {
      if (values.profile !== undefined && !['rough', 'final'].includes(values.profile)) throw Error('PRODUCTION_PROFILE_INVALID');
      result = await compileProduction(project.dir, (values.profile ?? 'rough') as 'rough' | 'final'); break;
    }
    case 'init': result = await initializeProduction(project.dir, await read<ProductionInit>(values.request, 'init')); break;
    case 'next': result = await productionNext(project.dir); break;
    case 'apply': result = await applyProduction(project.dir, await read<ProductionProposal>(values.proposal, 'proposal')); break;
    case 'resume': result = await resumeProduction(project.dir); break;
    case 'invalidate': {
      if (!values.key?.length || !values.reason?.trim()) throw Error('PRODUCTION_USAGE: --key and --reason required');
      result = await invalidateProduction(project.dir, ...expected(), values.key.map(key => ({ key, reason: values.reason! })));
      break;
    }
    case 'view': result = await writeProductionView(project.dir, ...(values['expected-revision'] !== undefined || values['source-hash'] !== undefined ? expected() : [])); break;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return operation === 'compile' && !(result as { ok: boolean }).ok ? 1 : 0;
}
