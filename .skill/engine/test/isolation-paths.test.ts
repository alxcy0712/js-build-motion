import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/project/scaffold.ts';
import { loadProject, readProjectManifest } from '../src/project/manifest.ts';
import { auditProjectIsolation } from '../src/project/isolation.ts';
import { assertContained } from '../src/project/paths.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { loadImage } from 'skia-canvas';

function fixture(fn: (root: string, dir: string, other: string) => void): void {
  const root = mkdtempSync(join(PROJECT_ROOT, '.research/out/path-regression-'));
  try {
    const dir = initProject({ slug: 'first', projectsRoot: root }).dir;
    const other = initProject({ slug: 'second', projectsRoot: root }).dir;
    fn(root, dir, other);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('input and output symlinks cannot cross project boundaries, including future files', () => fixture((_root, dir, other) => {
  symlinkSync(join(other, 'assets'), join(dir, 'assets/borrowed'));
  assert.throws(() => assertContained(dir, join(dir, 'assets/borrowed/future.png')));
  const briefPath = join(dir, 'brief.json'), brief = JSON.parse(readFileSync(briefPath, 'utf8'));
  brief.assets = [{ path: 'assets/borrowed/test.png' }]; writeFileSync(briefPath, JSON.stringify(brief));
  assert.equal(auditProjectIsolation(dir, readProjectManifest(dir)).isolated, false);
  assert.throws(() => loadProject(dir));
}));
test('symlinked spec, output directory and project root are rejected', () => fixture((root, dir, other) => {
  rmSync(join(dir, 'spec/main.json')); symlinkSync(join(other, 'spec/main.json'), join(dir, 'spec/main.json'));
  assert.throws(() => loadProject(dir));
  assert.equal(auditProjectIsolation(dir, readProjectManifest(dir)).isolated, false);
  rmSync(join(dir, 'spec/main.json')); writeFileSync(join(dir, 'spec/main.json'), '{}');
  rmSync(join(dir, 'out'), { recursive: true }); symlinkSync(join(other, 'out'), join(dir, 'out'));
  assert.throws(() => loadProject(dir));
  symlinkSync(dir, join(root, 'alias')); assert.throws(() => loadProject(join(root, 'alias')));
}));
test('director plans are part of the audited input surface', () => fixture((_root, dir, _other) => {
  const path = join(dir, 'project.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.director = 'director.json'; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => loadProject(dir));
  writeFileSync(join(dir, 'director.json'), JSON.stringify({ idea: '../second/spec/main.json' }));
  assert.throws(() => loadProject(dir));
}));
test('CLI refuses output overrides into another project before writing', () => fixture((_root, dir, other) => {
  const result = spawnSync(process.execPath, ['src/cli/index.ts', 'frame', dir, '--frame', '1', '--out', join(other, 'out/forbidden.png')], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /PROJECT_ISOLATION_VIOLATION/);
}));
test('contact sheet has distinct cells, including a partially filled final row', async () => {
  const root = mkdtempSync(join(PROJECT_ROOT, '.research/out/sheet-regression-'));
  try {
    const dir = initProject({ slug: 'sheet', projectsRoot: root }).dir;
    const result = spawnSync(process.execPath, ['src/cli/index.ts', 'storyboard', dir, '--count', '5', '--width', '160', '--height', '240'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /接触表生成失败/);
    const image = await loadImage(join(dir, 'out/storyboard/contact-sheet.png'));
    assert.equal(image.width, 960); assert.equal(image.height, 720);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nested audio symlinks are rejected by load and by global isolation inspection', () => fixture((_root, dir, other) => {
  mkdirSync(join(dir, 'out/audio'));
  writeFileSync(join(other, 'assets/keep.wav'), 'keep');
  symlinkSync(join(other, 'assets/keep.wav'), join(dir, 'out/audio/bgm.wav'));
  assert.throws(() => loadProject(dir));
  assert.equal(auditProjectIsolation(dir, readProjectManifest(dir)).isolated, false);
  assert.equal(readFileSync(join(other, 'assets/keep.wav'), 'utf8'), 'keep');
}));
