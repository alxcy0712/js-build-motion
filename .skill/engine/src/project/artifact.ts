import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PROJECT_ROOT } from '../utils/env.ts';
import { sha256File } from '../utils/hash.ts';
import { projectSourceHashes } from './drawing.ts';
import type { ProjectHandle } from './manifest.ts';
import { assertContained } from './paths.ts';
import { readRunLog, RUN_LOG_FILE, verifyRunLog } from './run-log.ts';
import { assertRecordedAttemptInputs, type AttemptExecution } from './attempt.ts';

export interface ArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly runId: string;
  readonly artifactId: string | null;
  readonly runtimeId: string | null;
  readonly runSha256: string;
  readonly attemptId?: string;
  readonly inputSnapshotSha256?: string;
}

export interface ArtifactReport {
  readonly ok: boolean;
  readonly scope: 'file-identity';
  readonly artifact: ArtifactIdentity | null;
  readonly issues: readonly { code: string; message: string }[];
}

/** Bind review evidence to the actual encoded file and the inputs recorded for it. */
export function inspectArtifact(project: ProjectHandle, options: { runtimeId?: string; reviewPath?: string } = {}): ArtifactReport {
  const issues: { code: string; message: string }[] = [];
  let artifact: ArtifactIdentity | null = null;
  try {
    const runPath = assertContained(project.dir, join(project.dir, RUN_LOG_FILE));
    const log = readRunLog(runPath);
    const execution = (log as typeof log & { execution?: AttemptExecution }).execution;
    if (execution) {
      try { assertRecordedAttemptInputs(project, execution, log); }
      catch (error) { issues.push({ code: 'ATTEMPT_INPUT_MISMATCH', message: error instanceof Error ? error.message : String(error) }); }
    }
    const briefSha256 = project.briefPath ? sha256File(project.briefPath) : null;
    const verified = verifyRunLog({ log, specSha256: sha256File(project.specPath), briefSha256 });
    if (!verified.ok) issues.push({ code: 'RUN_MISMATCH', message: verified.reason! });
    if ((log.brief?.sha256 ?? null) !== briefSha256) issues.push({ code: 'BRIEF_MISMATCH', message: '当前 brief 与渲染记录不一致' });
    const drawing = log.facts.drawing;
    if (drawing || project.manifest.drawing) {
      if (!drawing || drawing.entry !== project.manifest.drawing || JSON.stringify(drawing.sources) !== JSON.stringify(projectSourceHashes(project.dir))) {
        issues.push({ code: 'DRAWING_MISMATCH', message: '当前绘制入口或源码与渲染记录不一致' });
      }
    }
    const runtimeId = options.runtimeId ?? process.env['JBM_RUNTIME_ID'];
    if (runtimeId && log.facts.runtime?.packageId !== runtimeId) issues.push({ code: 'RUNTIME_MISMATCH', message: '渲染记录与本片固定运行时不一致' });
    const output = assertContained(project.outDir, resolve(PROJECT_ROOT, log.measured.outputPath));
    const info = statSync(output);
    if (!info.isFile()) throw new Error('渲染记录指定的产物需要为普通文件');
    artifact = {
      path: relative(project.dir, output).split('\\').join('/'),
      sha256: sha256File(output), bytes: info.size, runId: log.runId,
      artifactId: log.measured.artifactId ?? null, runtimeId: log.facts.runtime?.packageId ?? null,
      runSha256: sha256File(runPath),
      ...(execution ? { attemptId: execution.attemptId, inputSnapshotSha256: execution.inputSnapshotSha256 } : {}),
    };
    if (artifact.sha256 !== log.measured.outputSha256) issues.push({ code: 'OUTPUT_HASH_MISMATCH', message: '当前成片 SHA-256 与 run.json 不一致' });
    if (artifact.bytes !== log.measured.outputBytes) issues.push({ code: 'OUTPUT_SIZE_MISMATCH', message: '当前成片字节数与 run.json 不一致' });
  } catch (error) {
    issues.push({ code: 'ARTIFACT_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
  }
  if (options.reviewPath) {
    try {
      const path = assertContained(join(project.dir, 'evidence'), options.reviewPath);
      const saved = JSON.parse(readFileSync(path, 'utf8')) as ArtifactReport;
      const keys: (keyof ArtifactIdentity)[] = ['path', 'sha256', 'bytes', 'runId', 'artifactId', 'runtimeId', 'runSha256', 'attemptId', 'inputSnapshotSha256'];
      if (!saved.ok || saved.scope !== 'file-identity' || !saved.artifact || !artifact || keys.some((key) => saved.artifact![key] !== artifact![key])) {
        issues.push({ code: 'REVIEW_BINDING_MISMATCH', message: '审片身份快照与当前产物或渲染记录不一致；当前版本的审片待完成' });
      }
    } catch (error) {
      issues.push({ code: 'REVIEW_BINDING_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: issues.length === 0, scope: 'file-identity', artifact, issues };
}
