import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { assertAttemptInputsCurrent, beginRenderAttempt, commitRenderAttempt, failRenderAttempt, loadAttemptDrawing, type RenderAttempt } from '../src/project/attempt.ts';
import { inspectArtifact } from '../src/project/artifact.ts';
import { loadProject } from '../src/project/manifest.ts';
import { buildFacts, buildMeasured, buildRunLog, repoRelative } from '../src/project/run-log.ts';
import { sha256File } from '../src/utils/hash.ts';
import { createFixtureProject } from './fixtures/project.ts';

function fixture() {
  const base = createFixtureProject();
  mkdirSync(join(base.dir, 'src'), { recursive: true });
  writeFileSync(join(base.dir, 'src/draw.mjs'), 'export function drawScene(context) { context.version = "original"; }\n');
  writeFileSync(base.manifestPath, JSON.stringify({ ...base.manifest, drawing: 'src/draw.mjs' }));
  return { project: loadProject(base.dir), cleanup: base.cleanup };
}
function record(attempt: RenderAttempt, content = 'encoded-fixture') {
  // These unit fixtures verify transactions and identity; CLI integration tests encode actual media.
  const output = join(attempt.workDir, 'final.mp4');
  writeFileSync(output, content);
  const facts = buildFacts({
    video: { width: 160, height: 90, fps: 30, duration: 8, frames: 240, seed: 1 },
    rendererKind: 'skia', rendererPackage: 'skia-canvas', rendererVersion: null,
    encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: null, crf: null, preset: null },
    ffmpeg: { version: null, command: 'ffmpeg' }, providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' },
    captions: { insideFrame: false, cues: 0, wordLevel: false },
    drawing: { entry: 'src/draw.mjs', sources: attempt.drawingSources },
  });
  return { ...buildRunLog({ project: attempt.project.slug, specPath: attempt.project.specPath, specSha256: sha256File(attempt.snapshotProject.specPath),
    briefPath: attempt.project.briefPath, briefSha256: attempt.snapshotProject.briefPath ? sha256File(attempt.snapshotProject.briefPath) : null, facts,
    measured: buildMeasured({ renderMs: 1, msPerFrame: 1, encodeTailMs: 0, audioMixMs: null,
      outputBytes: readFileSync(output).length, outputSha256: sha256File(output), outputPath: repoRelative(join(attempt.outputDir, 'final.mp4')) }),
  }), execution: { attemptId: attempt.attemptId, inputSnapshotSha256: attempt.inputSnapshotSha256, coverage: 'partial' as const } };
}
const alias = (attempt: RenderAttempt) => [{ fromName: 'final.mp4', destination: join(attempt.project.outDir, 'latest.mp4') }];

test('attempt executes copied source, local components and explicit media with fixed runtime imports', async () => {
  const f = fixture(); let attempt: RenderAttempt | undefined;
  try {
    mkdirSync(join(f.project.dir, 'assets'), { recursive: true });
    mkdirSync(join(f.project.dir, '.engine'), { recursive: true });
    writeFileSync(join(f.project.dir, '.engine/fixed.mjs'), 'export const fixed = "runtime";');
    writeFileSync(join(f.project.dir, 'assets/image.txt'), 'frozen-media');
    writeFileSync(join(f.project.dir, 'src/component.mjs'), 'import { fixed } from "../.engine/fixed.mjs"; export const component = fixed;');
    writeFileSync(join(f.project.dir, 'src/draw.mjs'), 'import { readFileSync } from "node:fs"; import { component } from "./component.mjs"; const media = readFileSync(new URL("../assets/image.txt", import.meta.url), "utf8"); export function drawScene(context) { context.version = component + ":" + media; }');
    attempt = beginRenderAttempt(f.project, { mediaPaths: ['assets/image.txt'] });
    assert.equal(attempt.snapshotProject.specPath, join(attempt.snapshotDir, 'spec/main.json'));
    assert.equal(attempt.inputSnapshot.coverage, 'partial');
    writeFileSync(join(f.project.dir, 'src/component.mjs'), 'export const component = "changed";');
    writeFileSync(join(f.project.dir, 'assets/image.txt'), 'changed-media');
    const draw = await loadAttemptDrawing(attempt), context: { version?: string } = {};
    draw!(context as never, {} as never);
    assert.equal(context.version, 'runtime:frozen-media');
    assert.throws(() => assertAttemptInputsCurrent(attempt!), /ATTEMPT_INPUT_CHANGED/);
  } finally { if (attempt) failRenderAttempt(attempt, 'unit cleanup'); f.cleanup(); }
});

test('begin rejects a stale project handle before executing a changed drawing manifest', () => {
  const f = fixture();
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
    const previousRun = readFileSync(join(f.project.dir, 'run.json'));
    writeFileSync(join(f.project.dir, 'src/changed.mjs'), 'export function drawScene() {}');
    writeFileSync(f.project.manifestPath, JSON.stringify({ ...f.project.manifest, drawing: 'src/changed.mjs' }));
    assert.throws(() => beginRenderAttempt(f.project), /ATTEMPT_INPUT_CHANGED: project manifest/);
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'first');
    const current = beginRenderAttempt(loadProject(f.project.dir));
    failRenderAttempt(current, 'unit cleanup');
  } finally { f.cleanup(); }
});

test('successful attempts preserve deterministic runId and expire the previous review for identical encoded bytes', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.project.dir, 'src/components'), { recursive: true });
    writeFileSync(join(f.project.dir, 'src/components/value.mjs'), 'export const value = 1;');
    writeFileSync(join(f.project.dir, 'src/components.mjs'), 'export const value = 2;');
    const first = beginRenderAttempt(f.project), firstLog = record(first);
    commitRenderAttempt(first, firstLog, { technicalOk: true, copies: alias(first) });
    const before = inspectArtifact(f.project);
    assert.equal(before.ok, true);
    assert.equal(before.artifact?.attemptId, first.attemptId);
    mkdirSync(join(f.project.dir, 'evidence'), { recursive: true });
    const review = join(f.project.dir, 'evidence/first.json'); writeFileSync(review, JSON.stringify(before));
    const second = beginRenderAttempt(f.project), secondLog = record(second);
    assert.notEqual(first.attemptId, second.attemptId);
    assert.equal(firstLog.runId, secondLog.runId);
    commitRenderAttempt(second, secondLog, { technicalOk: true, copies: alias(second) });
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'encoded-fixture');
    assert.ok(existsSync(join(first.outputDir, 'final.mp4')));
    assert.deepEqual(inspectArtifact(f.project, { reviewPath: review }).issues.map(issue => issue.code), ['REVIEW_BINDING_MISMATCH']);
    assert.equal(JSON.parse(readFileSync(join(second.runDir, 'receipt.json'), 'utf8')).status, 'succeeded');
  } finally { f.cleanup(); }
});

test('changed known media and unobserved asset-tree edits invalidate recorded attempt identity', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.project.dir, 'assets'), { recursive: true });
    const media = join(f.project.dir, 'assets/media.txt'); writeFileSync(media, 'known');
    const attempt = beginRenderAttempt(f.project, { mediaPaths: ['assets/media.txt'] });
    commitRenderAttempt(attempt, record(attempt), { technicalOk: true });
    assert.equal(inspectArtifact(f.project).ok, true);
    writeFileSync(media, 'other');
    assert.ok(inspectArtifact(f.project).issues.some(issue => issue.code === 'ATTEMPT_INPUT_MISMATCH'));
    writeFileSync(media, 'known'); writeFileSync(join(f.project.dir, 'assets/new.txt'), 'unobserved');
    assert.ok(inspectArtifact(f.project).issues.some(issue => issue.code === 'ATTEMPT_INPUT_MISMATCH'));
  } finally { f.cleanup(); }
});

test('post-render history appends retain frozen review identity while changes to its original prefix fail', () => {
  const f = fixture();
  try {
    const history = join(f.project.dir, 'prompt-history.jsonl');
    const original = JSON.stringify({ timestamp: '2026-10-07T00:00:00.000Z', kind: 'prompt', text: 'original fixture request' }) + '\n';
    writeFileSync(history, original);
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first), { technicalOk: true });
    const review = join(f.project.dir, 'evidence/review.json'); mkdirSync(join(f.project.dir, 'evidence'), { recursive: true });
    writeFileSync(review, JSON.stringify(inspectArtifact(f.project)));
    writeFileSync(history, original + JSON.stringify({ timestamp: '2026-10-07T00:00:01.000Z', kind: 'answer', text: 'later fixture message' }) + '\n');
    assert.equal(inspectArtifact(f.project, { reviewPath: review }).ok, true);
    writeFileSync(history, original.replace('original fixture request', 'modified fixture request'));
    assert.ok(inspectArtifact(f.project).issues.some(issue => issue.code === 'ATTEMPT_INPUT_MISMATCH'));
  } finally { f.cleanup(); }
});

test('input changes and technical failure retain the previous root run and output aliases', () => {
  const f = fixture();
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
    const previousRun = readFileSync(join(f.project.dir, 'run.json'));
    const second = beginRenderAttempt(f.project), log = record(second, 'second');
    writeFileSync(join(f.project.dir, 'src/new.mjs'), 'export const change = true;');
    assert.throws(() => commitRenderAttempt(second, log, { technicalOk: true, copies: alias(second) }), /ATTEMPT_INPUT_CHANGED/);
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'first');
    assert.equal(existsSync(second.outputDir), false);
    const third = beginRenderAttempt(f.project);
    assert.throws(() => commitRenderAttempt(third, record(third, 'third'), { technicalOk: false, copies: alias(third) }), /RENDER_VERIFICATION_FAILED/);
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
    assert.equal(existsSync(third.outputDir), false);
  } finally { f.cleanup(); }
});

test('failed alias preparation cleans pending copies and preserves previous head and aliases', () => {
  const f = fixture();
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
    const previousRun = readFileSync(join(f.project.dir, 'run.json'));
    const second = beginRenderAttempt(f.project);
    assert.throws(() => commitRenderAttempt(second, record(second, 'second'), { technicalOk: true,
      copies: [...alias(second), { fromName: 'missing.srt', destination: join(f.project.outDir, 'latest.srt') }] }));
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'first');
    assert.equal(readdirSync(f.project.outDir).some(name => name.endsWith('.pending')), false);
    assert.equal(JSON.parse(readFileSync(join(second.runDir, 'receipt.json'), 'utf8')).status, 'failed');
  } finally { f.cleanup(); }
});

test('input edits during alias preparation or publication retain the previous root run and aliases', t => {
  for (const stage of ['prepare', 'publish'] as const) {
    const f = fixture();
    let restoreMock: (() => void) | undefined;
    try {
      const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
      const previousRun = readFileSync(join(f.project.dir, 'run.json'));
      const second = beginRenderAttempt(f.project), log = record(second, 'second');
      const destination = join(f.project.outDir, 'latest.mp4');
      const changeInput = (path: unknown): void => {
        if (stage === 'prepare' ? String(path).endsWith('.pending') : String(path) === destination) {
          writeFileSync(join(f.project.dir, 'src/draw.mjs'), 'export function drawScene() { throw new Error("changed during commit"); }');
        }
      };
      if (stage === 'prepare') {
        const copy = fs.copyFileSync;
        const mocked = t.mock.method(fs, 'copyFileSync', (...args: Parameters<typeof copy>) => { copy(...args); changeInput(args[1]); });
        restoreMock = () => mocked.mock.restore();
      } else {
        const rename = fs.renameSync;
        const mocked = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => { rename(...args); changeInput(args[1]); });
        restoreMock = () => mocked.mock.restore();
      }
      syncBuiltinESMExports();
      assert.throws(() => commitRenderAttempt(second, log, { technicalOk: true, copies: alias(second) }), /ATTEMPT_INPUT_CHANGED/);
      assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
      assert.equal(readFileSync(destination, 'utf8'), 'first');
      assert.equal(JSON.parse(readFileSync(join(second.runDir, 'receipt.json'), 'utf8')).status, 'failed');
    } finally { restoreMock?.(); syncBuiltinESMExports(); f.cleanup(); }
  }
});

test('live submission lock rejects another attempt and stale dead owner restores interrupted aliases', () => {
  const f = fixture(); let live: RenderAttempt | undefined;
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
    live = beginRenderAttempt(f.project);
    assert.throws(() => beginRenderAttempt(f.project), /RENDER_BUSY/);
    failRenderAttempt(live, 'unit cleanup'); live = undefined;
    const runDir = join(f.project.dir, 'runs/interrupted'), backup = join(runDir, 'aliases/0.previous');
    mkdirSync(join(runDir, 'aliases'), { recursive: true }); writeFileSync(backup, 'first');
    writeFileSync(join(f.project.outDir, 'latest.mp4'), 'interrupted-new');
    writeFileSync(join(runDir, 'receipt.json'), JSON.stringify({ attemptId: 'interrupted', status: 'prepared', startedAt: 'fixture', publishRun: true,
      previousRunSha256: sha256File(join(f.project.dir, 'run.json')), copies: [{ destination: 'out/latest.mp4', previous: relative(f.project.dir, backup), pending: 'out/.interrupted.pending' }] }));
    writeFileSync(join(f.project.dir, 'runs/.render.lock'), JSON.stringify({ pid: 2147483647, attemptId: 'interrupted' }));
    live = beginRenderAttempt(f.project);
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'first');
    assert.equal(JSON.parse(readFileSync(join(f.project.dir, 'run.json'), 'utf8')).execution.attemptId, first.attemptId);
  } finally { if (live) failRenderAttempt(live, 'unit cleanup'); f.cleanup(); }
});

test('tampered snapshot, changed current head and canonical overwrite targets are rejected', () => {
  const f = fixture();
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first), { technicalOk: true });
    const second = beginRenderAttempt(f.project), secondLog = record(second);
    writeFileSync(join(second.snapshotDir, 'src/draw.mjs'), 'export function drawScene() {}');
    assert.throws(() => commitRenderAttempt(second, secondLog, { technicalOk: true }), /ATTEMPT_INPUT_CHANGED/);
    const third = beginRenderAttempt(f.project), thirdLog = record(third);
    const current = join(f.project.dir, 'run.json'); writeFileSync(current, readFileSync(current, 'utf8') + '\n');
    assert.throws(() => commitRenderAttempt(third, thirdLog, { technicalOk: true }), /RENDER_CURRENT_CHANGED/);
    const fourth = beginRenderAttempt(f.project);
    assert.throws(() => commitRenderAttempt(fourth, record(fourth), { technicalOk: true, copies: [{ fromName: 'final.mp4', destination: join(first.outputDir, 'final.mp4') }] }), /ATTEMPT_ALIAS_PATH/);
    assert.equal(readFileSync(join(first.outputDir, 'final.mp4'), 'utf8'), 'encoded-fixture');
  } finally { f.cleanup(); }
});

test('no-run-log publishes successful aliases and local attempt evidence while retaining the current root run', () => {
  const f = fixture();
  try {
    const first = beginRenderAttempt(f.project); commitRenderAttempt(first, record(first, 'first'), { technicalOk: true, copies: alias(first) });
    const previousRun = readFileSync(join(f.project.dir, 'run.json'));
    const second = beginRenderAttempt(f.project);
    const runPath = commitRenderAttempt(second, record(second, 'second'), { technicalOk: true, publishRun: false, copies: alias(second) });
    assert.equal(runPath, join(second.runDir, 'run.json'));
    assert.equal(readFileSync(join(f.project.outDir, 'latest.mp4'), 'utf8'), 'second');
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), previousRun);
    assert.equal(JSON.parse(readFileSync(join(second.runDir, 'receipt.json'), 'utf8')).status, 'succeeded');
  } finally { f.cleanup(); }
});
