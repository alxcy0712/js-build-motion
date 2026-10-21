import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { importOriginals, ImportFailure, verifyImport } from '../application/import.ts';
import { IMPORT_MANIFEST_SCHEMA, IMPORT_RECEIPT_SCHEMA, IMPORT_POLICY_SCHEMA } from '../project/import.ts';
import { unpackOriginal, UnpackFailure, verifyUnpack } from '../application/unpack.ts';
import { UNPACK_MANIFEST_SCHEMA, UNPACK_RECEIPT_SCHEMA, UNPACK_POLICY_SCHEMA, UNPACK_INDEX_SCHEMA } from '../project/unpack.ts';
import { catalogAssets, CatalogFailure, verifyCatalog } from '../application/catalog.ts';
import { CATALOG_SCHEMAS } from '../project/catalog.ts';
import { alignAsset, verifyAlignment, recoverAlignmentAttempts, AlignmentFailure } from '../application/alignment.ts';
import { ALIGNMENT_SCHEMAS } from '../project/alignment.ts';
import { DEFAULT_ASSET_PLAN_PATH, prepareAssetPlan } from '../application/asset-plan.ts';
import { ASSET_PLAN_SCHEMAS } from '../project/asset-plan.ts';
import { prepareVideo, verifyVideoPreparation, recoverVideoAttempts } from '../application/video.ts';
import { VIDEO_PREPARATION_SCHEMAS } from '../project/video-preparation.ts';
import { loadProject } from '../project/manifest.ts';

export async function cmdImport(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    source: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' },
  }, allowPositionals: true });
  if (positionals.length !== 1 || [values.source, values.verify, values.schema].filter(value => value !== undefined).length !== 1 || Object.values(values).some(value => value === '')) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: import <项目> --source <路径> | --verify <importId> | --schema manifest|receipt|policy');
  }
  if (values.schema !== undefined) {
    const schemas = { manifest: IMPORT_MANIFEST_SCHEMA, receipt: IMPORT_RECEIPT_SCHEMA, policy: IMPORT_POLICY_SCHEMA };
    if (!Object.hasOwn(schemas, values.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '导入契约须为 manifest、receipt 或 policy');
    process.stdout.write(JSON.stringify(schemas[values.schema as keyof typeof schemas], null, 2) + '\n');
    return 0;
  }
  const project = loadProject(positionals[0]);
  if (values.verify !== undefined) {
    const manifest = await verifyImport(project.dir, values.verify);
    process.stdout.write(JSON.stringify({ ok: true, manifest }, null, 2) + '\n');
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const receipt = await importOriginals(project.dir, resolve(values.source!), { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof ImportFailure)) throw error;
    process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n');
    return error.receipt.status === 'succeeded' ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
export async function cmdUnpack(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    import: { type: 'string' }, path: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' },
  }, allowPositionals: true });
  const selection = values.import !== undefined || values.path !== undefined;
  if (positionals.length !== 1 || [selection, values.verify !== undefined, values.schema !== undefined].filter(Boolean).length !== 1 ||
      selection && (values.import === undefined || values.path === undefined) || Object.values(values).some(value => value === '')) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: unpack <项目> --import <importId> --path <归档相对路径> | --verify <unpackId> | --schema manifest|receipt|policy|index');
  }
  if (values.schema !== undefined) {
    const schemas = { manifest: UNPACK_MANIFEST_SCHEMA, receipt: UNPACK_RECEIPT_SCHEMA, policy: UNPACK_POLICY_SCHEMA, index: UNPACK_INDEX_SCHEMA };
    if (!Object.hasOwn(schemas, values.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '展开契约须为 manifest、receipt、policy 或 index');
    process.stdout.write(JSON.stringify(schemas[values.schema as keyof typeof schemas], null, 2) + '\n'); return 0;
  }
  const project = loadProject(positionals[0]);
  if (values.verify !== undefined) {
    process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyUnpack(project.dir, values.verify) }, null, 2) + '\n'); return 0;
  }
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const receipt = await unpackOriginal(project.dir, values.import!, values.path!, { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UnpackFailure)) throw error;
    process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
export async function cmdCatalog(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { import: { type: 'string' }, unpack: { type: 'string' }, path: { type: 'string' }, asset: { type: 'string' }, observation: { type: 'string' }, rights: { type: 'string' }, verify: { type: 'string' }, schema: { type: 'string' } }, allowPositionals: true });
  const selected = v.import !== undefined || v.unpack !== undefined;
  if (positionals.length !== 1 || [v.import, v.unpack, v.observation, v.rights, v.verify, v.schema].filter(x => x !== undefined).length !== 1 || (v.path !== undefined || v.asset !== undefined) && !selected || v.asset !== undefined && v.path === undefined || Object.values(v).some(x => x === '')) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: catalog <项目> --import <importId> | --unpack <unpackId> [--path <条目> [--asset <assetId>]] | --observation <本片JSON> | --rights <本片JSON> | --verify <catalogId> | --schema manifest|receipt|policy|index|observation|rights|ocr-map|asr-map|audio-input-map');
  if (v.schema !== undefined) { if (!Object.hasOwn(CATALOG_SCHEMAS, v.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '素材目录契约须为 manifest、receipt、policy、index、observation、rights、ocr-map、asr-map、audio-input-map'); process.stdout.write(JSON.stringify(CATALOG_SCHEMAS[v.schema as keyof typeof CATALOG_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]);
  if (v.verify !== undefined) { process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyCatalog(project.dir, v.verify) }, null, 2) + '\n'); return 0; }
  const selection = v.observation !== undefined ? { observation: v.observation } : v.rights !== undefined ? { rights: v.rights } : { ...(v.import !== undefined ? { importId: v.import } : { unpackId: v.unpack! }), ...(v.path !== undefined ? { path: v.path } : {}), ...(v.asset !== undefined ? { assetId: v.asset } : {}) };
  const controller = new AbortController(), interrupt = () => controller.abort(); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try { const receipt = await catalogAssets(project.dir, selection, { signal: controller.signal }); process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1; }
  catch (error) { if (!(error instanceof CatalogFailure)) throw error; process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
export async function cmdAlign(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { catalog: { type: 'string' }, asset: { type: 'string' }, version: { type: 'string' }, script: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' } }, allowPositionals: true });
  const selected = v.catalog !== undefined;
  if (positionals.length !== 1 || [selected, v.verify !== undefined, v.recover === true, v.schema !== undefined].filter(Boolean).length !== 1 || Object.values(v).some(value => value === '') || selected && (!v.asset || !v.version || !v.script) || !selected && [v.asset, v.version, v.script].some(value => value !== undefined)) throw new EngineError(ERROR_CODES.CLI_USAGE, '用法: align <项目> --catalog <catalogId> --asset <assetId> --version <assetVersion> --script <批准稿JSON> | --verify <alignmentId> | --recover | --schema policy|script|selection|map|manifest|index|receipt');
  if (v.schema !== undefined) { if (!Object.hasOwn(ALIGNMENT_SCHEMAS, v.schema)) throw new EngineError(ERROR_CODES.CLI_USAGE, '对齐契约名称无效'); process.stdout.write(JSON.stringify(ALIGNMENT_SCHEMAS[v.schema as keyof typeof ALIGNMENT_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), controller = new AbortController(), interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (v.verify !== undefined) { process.stdout.write(JSON.stringify({ ok: true, manifest: await verifyAlignment(project.dir, v.verify, { signal: controller.signal }) }, null, 2) + '\n'); return 0; }
    if (v.recover) { process.stdout.write(JSON.stringify({ ok: true, receipts: await recoverAlignmentAttempts(project.dir, { signal: controller.signal }) }, null, 2) + '\n'); return 0; }
    const receipt = await alignAsset(project.dir, { catalogId: v.catalog!, assetId: v.asset!, assetVersion: v.version!, scriptPath: v.script! }, { signal: controller.signal });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } catch (error) { if (!(error instanceof AlignmentFailure)) throw error; process.stdout.write(JSON.stringify(error.receipt, null, 2) + '\n'); return error.receipt.status === 'succeeded' ? 0 : 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
export async function cmdAssets(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { plan: { type: 'string' }, schema: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || v.plan !== undefined && v.schema !== undefined || Object.values(v).some(x => x === '')) throw Error('CLI_USAGE: assets <project> [--plan assets/asset-plan.json | --schema plan|usage]');
  if (v.schema) { if (!Object.hasOwn(ASSET_PLAN_SCHEMAS, v.schema)) throw Error('ASSET_SCHEMA_INVALID');
    process.stdout.write(JSON.stringify(ASSET_PLAN_SCHEMAS[v.schema as keyof typeof ASSET_PLAN_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), prepared = await prepareAssetPlan(project.dir, v.plan ?? DEFAULT_ASSET_PLAN_PATH);
  process.stdout.write(JSON.stringify({ plan: prepared.identity, gaps: prepared.gaps, mediaPaths: prepared.mediaPaths }, null, 2) + '\n'); return 0;
}
export async function cmdVideo(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, options: { request: { type: 'string' }, verify: { type: 'string' }, recover: { type: 'boolean' }, schema: { type: 'string' }, limits: { type: 'string' } }, allowPositionals: true });
  if (positionals.length !== 1 || [v.request !== undefined, v.verify !== undefined, v.recover === true, v.schema !== undefined].filter(Boolean).length !== 1 ||
      Object.values(v).some(x => x === '') || v.limits && !v.request && !v.verify) throw Error('CLI_USAGE: video <project> --request <project JSON> | --verify <map path> [--limits <project resource-policy JSON>] | --recover | --schema request|map|limits|receipt|publication');
  if (v.schema) { if (!Object.hasOwn(VIDEO_PREPARATION_SCHEMAS, v.schema)) throw Error('VIDEO_SCHEMA_INVALID');
    process.stdout.write(JSON.stringify(VIDEO_PREPARATION_SCHEMAS[v.schema as keyof typeof VIDEO_PREPARATION_SCHEMAS], null, 2) + '\n'); return 0; }
  const project = loadProject(positionals[0]), controller = new AbortController(), interrupt = () => controller.abort();
  const { readAssetFile } = await import('../application/asset-plan.ts');
  const { videoPreparationLimits } = await import('../project/video-preparation.ts');
  const limits = v.limits ? videoPreparationLimits(JSON.parse((await readAssetFile(project.dir, v.limits, 4194304)).data.toString('utf8'))) : undefined;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    if (v.verify) { process.stdout.write(JSON.stringify({ ok: true, map: await verifyVideoPreparation(project.dir, v.verify, { signal: controller.signal, limits }) }, null, 2) + '\n'); return 0; }
    if (v.recover) { process.stdout.write(JSON.stringify({ ok: true, receipts: await recoverVideoAttempts(project.dir) }, null, 2) + '\n'); return 0; }
    const request = JSON.parse((await readAssetFile(project.dir, v.request!, 4194304)).data.toString('utf8'));
    const receipt = await prepareVideo(project.dir, request, { signal: controller.signal, limits });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n'); return receipt.status === 'succeeded' ? 0 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
