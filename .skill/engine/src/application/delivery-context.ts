import { isDeepStrictEqual } from 'node:util';
import { dirname, join, relative, resolve } from 'node:path';
import { NodeImportFiles } from '../adapters/import-files.ts';
import { loadProject } from '../project/manifest.ts';
import { inspectArtifact } from '../project/artifact.ts';
import { readRunLog } from '../project/run-log.ts';
import { validateSpec } from '../spec/validate.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import { readAssetFile, prepareAssetPlan } from './asset-plan.ts';
import { assertProductionCurrent, PRODUCTION_PROJECTION_PATH } from './production-compilation.ts';
import { validateDelivery, type DeliveryContext, type DeliveryFile, type DeliverySubject, type DeliveryRequest, DELIVERY_SCHEMAS } from '../project/delivery.ts';
import { productionHash, validateProduction } from '../project/production.ts';
import { readPostprocess, POSTPROCESS_FILE } from '../project/postprocess.ts';

const jsonLimit = 8 * 1024 * 1024;
const decode = (data: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));

/** Recheck ordinary, independent source files without retaining media in memory. */
export async function verifyDeliveryFiles(projectDir: string, files: readonly DeliveryFile[]): Promise<void> {
  const storage = new NodeImportFiles(projectDir);
  for (const file of files) {
    validateDelivery<DeliveryFile>('file', file);
    const actual = await storage.hash(storage.projectPath(join(projectDir, file.path)));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw Error('DELIVERY_FILE_CHANGED: ' + file.path);
  }
}

export async function readDeliveryDocument<T>(projectDir: string, file: DeliveryFile, kind: keyof typeof DELIVERY_SCHEMAS): Promise<T> {
  const raw = await readAssetFile(projectDir, file.path, jsonLimit, file);
  return validateDelivery<T>(kind, decode(raw.data));
}

/** Closed document schemas give this traversal a fixed depth; each file is checked once. */
export function deliveryDocumentFiles(value: unknown): DeliveryFile[] {
  const found = new Map<string, DeliveryFile>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    const object = item as Record<string, unknown>;
    if (typeof object.path === 'string' && typeof object.bytes === 'number' && typeof object.sha256 === 'string') {
      const file = { path: object.path, bytes: object.bytes, sha256: object.sha256 };
      validateDelivery('file', file);
      const previous = found.get(file.path);
      if (previous && !isDeepStrictEqual(previous, file)) throw Error('DELIVERY_FILE_CONFLICT: ' + file.path);
      found.set(file.path, file);
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value); return [...found.values()];
}

/** Final approvals append communication while the encoded production bundle stays fixed. */
export async function verifyDeliveryApprovals(projectDir: string, request: DeliveryRequest): Promise<void> {
  const history = decodeHistory((await readAssetFile(projectDir, 'prompt-history.jsonl', jsonLimit)).data);
  for (const decision of request.approvals) {
    validateProduction('decision', decision);
    const ref = decision.sourcePrompt, entry = ref ? history[ref.entry] : null;
    if (!['approval', 'revoke'].includes(decision.kind) || decision.actor !== 'user' || decision.scope.action !== 'approve' ||
        !['final', 'delivery'].includes(decision.scope.target) || decision.scope.assetIds.length || decision.scope.provider !== null ||
        decision.scope.maxCost !== null && decision.scope.maxCost !== 0 || !ref || !entry ||
        !['prompt', 'answer'].includes(entry.kind) || !Number.isFinite(Date.parse(entry.timestamp)) ||
        entry.text !== decision.rawText || productionHash(entry) !== ref.sha256) throw Error('DELIVERY_APPROVAL_SOURCE_INVALID');
  }
}
function decodeHistory(data: Buffer): { kind: string; text: string; timestamp: string }[] {
  return new TextDecoder('utf-8', { fatal: true }).decode(data).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

/** Current production, encoded artifact and measured sound form one review subject. */
export async function readDeliveryContext(projectDir: string): Promise<DeliveryContext> {
  const project = loadProject(projectDir);
  const spec = validateSpec(decode((await readAssetFile(projectDir, relative(projectDir, project.specPath), jsonLimit)).data)).spec;
  if (!spec) throw Error('DELIVERY_SPEC_INVALID');
  const production = await assertProductionCurrent(projectDir, spec, 'final');
  const report = inspectArtifact(project, { runtimeId: production.current.manifest.runtimeId });
  if (!report.ok || !report.artifact?.attemptId || !report.artifact.inputSnapshotSha256 || !report.artifact.runtimeId) {
    throw Error('DELIVERY_ARTIFACT_INVALID: ' + report.issues.map(issue => issue.code).join(','));
  }
  const artifact = report.artifact as DeliverySubject['artifact'];
  await verifyDeliveryFiles(projectDir, [{ path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 }]);
  const run = readRunLog(join(projectDir, 'run.json'));
  if (run.facts.video.frames !== production.current.bundle.timeline!.durationFrames ||
      ['width', 'height', 'fps', 'duration'].some(key => run.facts.video[key as 'width'] !== spec.video[key as 'width'])) throw Error('DELIVERY_VIDEO_FACTS_STALE');
  const render = await readAssetFile(projectDir, dirname(artifact.path) + '/production-render.json', jsonLimit);
  const observed = decode(render.data), compiled = production.compiled;
  if (observed.version !== '0.1' || observed.kind !== 'production-render-evidence' ||
      !isDeepStrictEqual(observed.projection, production.projection) || !isDeepStrictEqual(observed.clips, compiled.clips) ||
      !isDeepStrictEqual(observed.audioPlacements, compiled.audioPlacements) || !isDeepStrictEqual(observed.events, compiled.events) ||
      !isDeepStrictEqual(observed.captionCues, compiled.captionCues) || observed.durationSamples !== compiled.durationSamples ||
      observed.observed?.encodedFrames !== run.facts.video.frames || !Array.isArray(observed.observed?.voicePresence) ||
      observed.observed.voicePresence.some((item: { ok: boolean }) => item.ok !== true)) throw Error('DELIVERY_RENDER_EVIDENCE_STALE');
  const bundle = production.current.bundle, prepared = await prepareAssetPlan(projectDir);
  const expectedAudio: DeliverySubject['audio']['sources'] = [];
  const addAudio = (file: DeliveryFile, role: string) => {
    if (!expectedAudio.some(source => source.file.path === file.path && source.role === role)) expectedAudio.push({ file, role });
  };
  for (const placement of compiled.audioPlacements) if (!placement.mute && placement.gain !== 0) addAudio(placement.file, placement.kind + '-source');
  for (const clip of compiled.clips) {
    const binding = prepared.bindings.find(item => item.use.useId === clip.useId);
    if (!binding) throw Error('DELIVERY_CLIP_SOURCE_MISSING');
    if (!clip.mute && clip.gain !== 0 && !binding.use.mute && bundle.requirements.effective.originalAudio !== 'mute' && binding.video?.version === '0.2' && binding.video.audio) {
      const { path, bytes, sha256 } = binding.video.audio; addAudio({ path, bytes, sha256 }, 'original-source');
    }
  }
  const audioSources = Array.isArray(observed.sources) ? observed.sources.map(({ path, bytes, sha256, role }: DeliveryFile & { role: string }) => ({ file: { path, bytes, sha256 }, role })) : null;
  const sorted = (value: DeliverySubject['audio']['sources']) => [...value].sort((a, b) => (a.file.path + a.role).localeCompare(b.file.path + b.role));
  if (!audioSources || !isDeepStrictEqual(sorted(audioSources), sorted(expectedAudio))) throw Error('DELIVERY_AUDIO_SOURCES_STALE');
  await verifyDeliveryFiles(projectDir, expectedAudio.map(source => source.file));
  const masters = run.measured.audioArtifacts.filter(item => item.role === 'master');
  let master: DeliveryFile | null = null;
  if (observed.masterSha256 !== null) {
    if (masters.length !== 1 || masters[0]!.sha256 !== observed.masterSha256) throw Error('DELIVERY_MASTER_STALE');
    const path = relative(projectDir, resolve(PROJECT_ROOT, masters[0]!.path)).split('\\').join('/');
    const raw = await readAssetFile(projectDir, path, Number.MAX_SAFE_INTEGER, undefined, { retain: false });
    if (raw.sha256 !== observed.masterSha256) throw Error('DELIVERY_MASTER_STALE');
    master = raw.identity;
  } else if (masters.length || expectedAudio.length) throw Error('DELIVERY_MASTER_MISSING');
  const sources: DeliverySubject['sources'] = [], catalogRights: DeliveryContext['catalogRights'] = [];
  for (const binding of prepared.bindings) {
    const sourceId = binding.use.catalogId + '/' + binding.asset.assetId;
    let source = sources.find(item => item.sourceId === sourceId);
    if (!source) {
      const raw = await readAssetFile(projectDir, 'assets/catalogs/' + binding.use.catalogId + '/manifest.json', jsonLimit);
      source = { sourceId, file: { path: binding.asset.source.fixedPath, bytes: binding.asset.source.bytes, sha256: binding.asset.source.sha256 }, roles: [], catalog: raw.identity };
      sources.push(source);
      const rights = binding.catalog.rights.filter(item => item.assetId === binding.asset.assetId && item.assetVersion === binding.asset.assetVersion && item.byteSha256 === source!.file.sha256).sort((a, b) => b.revision - a.revision)[0] ?? null;
      catalogRights.push({ sourceId, rights });
    }
    if (!source.roles.includes(binding.use.role)) source.roles.push(binding.use.role);
  }
  for (const audio of expectedAudio) {
    const catalog = prepared.bindings.find(binding => binding.video?.version === '0.2' && binding.video.audio?.path === audio.file.path);
    if (catalog) {
      const source = sources.find(item => item.sourceId === catalog.use.catalogId + '/' + catalog.asset.assetId)!;
      if (!source.roles.includes(audio.role)) source.roles.push(audio.role);
    } else {
      const take = bundle.timeline!.takes.find(item => isDeepStrictEqual(item.file, audio.file));
      if (!take) throw Error('DELIVERY_AUDIO_TAKE_MISSING');
      const sourceId = 'take:' + take.takeId, existing = sources.find(item => item.sourceId === sourceId);
      if (existing) { if (!existing.roles.includes(audio.role)) existing.roles.push(audio.role); }
      else { sources.push({ sourceId, file: audio.file, roles: [audio.role], catalog: null }); catalogRights.push({ sourceId, rights: null }); }
    }
  }
  for (const font of run.facts.fonts) {
    if (!font.registered) throw Error('DELIVERY_FONT_UNREGISTERED');
    const raw = await readAssetFile(projectDir, '.engine/' + font.path, Number.MAX_SAFE_INTEGER, undefined, { retain: false });
    if (raw.sha256 !== font.sha256) throw Error('DELIVERY_FONT_CHANGED');
    const sourceId = 'font:' + font.sha256;
    if (!sources.some(item => item.sourceId === sourceId)) { sources.push({ sourceId, file: raw.identity, roles: ['font'], catalog: null }); catalogRights.push({ sourceId, rights: null }); }
  }
  const projection = await readAssetFile(projectDir, PRODUCTION_PROJECTION_PATH, jsonLimit);
  const post = readPostprocess(project, run);
  let deliveredArtifact = artifact, postprocess: DeliverySubject['postprocess'];
  let durationFrames = run.facts.video.frames, fps = run.facts.video.fps;
  if (post) {
    const final = await readAssetFile(projectDir, post.final.path, Number.MAX_SAFE_INTEGER, undefined, { retain: false });
    const record = await readAssetFile(projectDir, POSTPROCESS_FILE, jsonLimit);
    if (final.sha256 !== post.final.sha256 || !isDeepStrictEqual(decode(record.data), post)) throw Error('DELIVERY_POSTPROCESS_CHANGED');
    if (!post.media.video?.frameCount || !Number.isInteger(post.media.video.frameCount)) throw Error('DELIVERY_POSTPROCESS_FRAMES_REQUIRED');
    durationFrames = post.media.video.frameCount; fps = post.media.video.fps;
    deliveredArtifact = { ...artifact, ...final.identity, artifactId: post.recordId };
    postprocess = { record: record.identity, recordId: post.recordId, render: artifact, hasAudio: post.media.audio !== null };
    for (const asset of post.assets) {
      const raw = await readAssetFile(projectDir, asset.path, Number.MAX_SAFE_INTEGER, undefined, { retain: false });
      if (raw.sha256 !== asset.sha256) throw Error('DELIVERY_POSTPROCESS_ASSET_CHANGED');
      const existing = sources.find(s => isDeepStrictEqual(s.file, raw.identity));
      if (existing) { if (!existing.roles.includes('postprocess-source')) existing.roles.push('postprocess-source'); }
      else {
        const sourceId = 'postprocess:' + asset.path;
        sources.push({ sourceId, file: raw.identity, roles: ['postprocess-source'], catalog: null });
        catalogRights.push({ sourceId, rights: null });
      }
    }
  }
  const subject = validateDelivery<DeliverySubject>('subject', { artifact: deliveredArtifact,
    production: { revision: production.current.state.revision, bundle: production.current.state.bundle, projection: projection.identity },
    renderEvidence: render.identity, audio: { master, sources: audioSources }, sources,
    durationFrames, fps, ...(postprocess ? { postprocess } : {}) });
  const consumptionLimitations = [...new Set(['Dynamic IO outside AssetPort and final pixel visibility are unobserved.', ...(run.facts.assets.usage?.unknownRemainder ?? [])])];
  return { subject, bundle, catalogRights, consumptionCoverage: 'partial', consumptionLimitations };
}
