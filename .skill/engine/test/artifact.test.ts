import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectArtifact } from '../src/project/artifact.ts';
import { projectSourceHashes } from '../src/project/drawing.ts';
import { loadProject } from '../src/project/manifest.ts';
import { buildFacts, buildMeasured, buildRunLog, repoRelative, writeRunLog } from '../src/project/run-log.ts';
import { sha256File } from '../src/utils/hash.ts';
import { createFixtureProject } from './fixtures/project.ts';

function fixture() {
  const base = createFixtureProject();
  mkdirSync(join(base.dir, 'src'), { recursive: true });
  writeFileSync(join(base.dir, 'src/draw.mjs'), 'export function drawScene() {}\n');
  writeFileSync(base.manifestPath, JSON.stringify({ ...base.manifest, drawing: 'src/draw.mjs' }));
  const project = loadProject(base.dir);
  mkdirSync(join(project.dir, 'evidence'), { recursive: true });
  const output = join(project.outDir, 'final.mp4'), runPath = join(project.dir, 'run.json');
  writeFileSync(output, 'encoded-A'); // Identity-only fixture; native checks use actual encoded media.
  const record = (runtimeId = 'fixture-runtime') => {
    const facts = buildFacts({
      video: { width: 160, height: 90, fps: 30, duration: 1, frames: 30, seed: 1 },
      rendererKind: 'skia', rendererPackage: 'skia-canvas', rendererVersion: null,
      encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: null, crf: null, preset: null },
      ffmpeg: { version: null, command: 'ffmpeg' }, providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' },
      captions: { insideFrame: false, cues: 0, wordLevel: false },
      drawing: { entry: 'src/draw.mjs', sources: projectSourceHashes(project.dir) },
      runtime: { packageId: runtimeId, platform: process.platform, arch: process.arch },
    });
    const log = buildRunLog({
      project: project.slug, specPath: project.specPath, specSha256: sha256File(project.specPath),
      briefPath: project.briefPath, briefSha256: sha256File(project.briefPath!), facts,
      measured: buildMeasured({ renderMs: 1, msPerFrame: 1, encodeTailMs: 0, audioMixMs: null,
        outputBytes: readFileSync(output).length, outputSha256: sha256File(output), outputPath: repoRelative(output) }),
    });
    writeRunLog(runPath, log);
    return log;
  };
  record();
  return { project, output, runPath, record, inspect: (reviewPath?: string) => inspectArtifact(project, { runtimeId: 'fixture-runtime', ...(reviewPath ? { reviewPath } : {}) }), cleanup: base.cleanup };
}

test('actual artifact identity matches recorded output, sources and fixed runtime', () => {
  const f = fixture();
  try {
    const report = f.inspect();
    assert.equal(report.ok, true);
    assert.equal(report.scope, 'file-identity');
    assert.equal(report.artifact?.sha256, sha256File(f.output));
    assert.equal(report.artifact?.path, 'out/final.mp4');
    assert.equal(report.artifact?.runtimeId, 'fixture-runtime');
  } finally { f.cleanup(); }
});

test('same-size replacement fails even when runId and artifactId remain internally consistent', () => {
  const f = fixture();
  try {
    writeFileSync(f.output, 'encoded-B');
    assert.deepEqual(f.inspect().issues.map(issue => issue.code), ['OUTPUT_HASH_MISMATCH']);
    assert.equal(f.inspect().ok, false);
  } finally { f.cleanup(); }
});

test('changed size and missing encoded file fail identity inspection', () => {
  const f = fixture();
  try {
    writeFileSync(f.output, 'short');
    assert.ok(f.inspect().issues.some(issue => issue.code === 'OUTPUT_SIZE_MISMATCH'));
    rmSync(f.output);
    assert.equal(f.inspect().ok, false);
    assert.equal(f.inspect().artifact, null);
  } finally { f.cleanup(); }
});

test('changed spec, brief or drawing source requires a new render record', () => {
  const f = fixture();
  try {
    for (const path of [f.project.specPath, f.project.briefPath!, join(f.project.dir, 'src/draw.mjs')]) {
      const saved = readFileSync(path);
      writeFileSync(path, Buffer.concat([saved, Buffer.from('\n')]));
      assert.equal(f.inspect().ok, false, path);
      writeFileSync(path, saved);
      assert.equal(f.inspect().ok, true, path);
    }
  } finally { f.cleanup(); }
});

test('a self-consistent record from a different runtime fails the fixed runtime check', () => {
  const f = fixture();
  try {
    f.record('other-runtime');
    assert.deepEqual(f.inspect().issues.map(issue => issue.code), ['RUNTIME_MISMATCH']);
  } finally { f.cleanup(); }
});

test('recorded output outside the film out directory is rejected', () => {
  const f = fixture();
  try {
    const log = f.record();
    writeRunLog(f.runPath, { ...log, measured: { ...log.measured, outputPath: repoRelative(f.project.specPath) } });
    const report = f.inspect();
    assert.equal(report.ok, false);
    assert.equal(report.artifact, null);
    assert.equal(report.issues[0]?.code, 'ARTIFACT_UNAVAILABLE');
  } finally { f.cleanup(); }
});

test('an earlier review snapshot expires when a new valid encoded output is recorded', () => {
  const f = fixture();
  try {
    const review = join(f.project.dir, 'evidence/artifact.json');
    writeFileSync(review, JSON.stringify(f.inspect()));
    assert.equal(f.inspect(review).ok, true);
    writeFileSync(f.output, 'encoded-B');
    f.record();
    assert.equal(f.inspect().ok, true);
    assert.deepEqual(f.inspect(review).issues.map(issue => issue.code), ['REVIEW_BINDING_MISMATCH']);
  } finally { f.cleanup(); }
});

test('missing and malformed review snapshots stay pending', () => {
  const f = fixture();
  try {
    const review = join(f.project.dir, 'evidence/artifact.json');
    assert.equal(f.inspect(review).ok, false);
    writeFileSync(review, '{}');
    assert.equal(f.inspect(review).ok, false);
    writeFileSync(review, 'invalid JSON');
    assert.equal(f.inspect(review).ok, false);
  } finally { f.cleanup(); }
});
