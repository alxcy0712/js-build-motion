import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/project/scaffold.ts';
import { loadProject, readProjectManifest } from '../src/project/manifest.ts';
import { loadProjectDrawing, projectSourceHashes } from '../src/project/drawing.ts';
import { compileDirector } from '../src/project/director.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

function fixture() {
  const parent = join(PROJECT_ROOT, '.research/out');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'drawing-test-'));
  const { dir } = initProject({ slug: 'local-drawing', projectsRoot: root });
  mkdirSync(join(dir, 'src'));
  const manifest = readProjectManifest(dir);
  const setEntry = (drawing: string) => writeFileSync(join(dir, 'project.json'), JSON.stringify({ ...manifest, drawing }));
  return { root, dir, setEntry };
}

test('本片入口接受同步模块，拒绝异步导出、缺失导出和 src 越界', async () => {
  const { root, dir, setEntry } = fixture();
  try {
    writeFileSync(join(dir, 'src/good.mjs'), 'export function drawScene() {}');
    setEntry('src/good.mjs');
    assert.equal(typeof await loadProjectDrawing(loadProject(dir)), 'function');
    for (const [file, source] of [['async', 'export async function drawScene() {}'], ['missing', 'export const value = 1']]) {
      writeFileSync(join(dir, `src/${file}.mjs`), source!);
      setEntry(`src/${file}.mjs`);
      await assert.rejects(() => loadProjectDrawing(loadProject(dir)), /同步函数/);
    }
    setEntry('src/../outside.mjs');
    await assert.rejects(async () => loadProjectDrawing(loadProject(dir)));
    setEntry('assets/outside.mjs');
    assert.throws(() => readProjectManifest(dir));
    assert.equal(await loadProjectDrawing(null), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('源码哈希跟随局部修改，软链接及硬链接阻止加载', () => {
  const { root, dir } = fixture();
  try {
    const source = join(dir, 'src/draw.mjs');
    writeFileSync(source, 'export function drawScene() {}');
    const before = projectSourceHashes(dir);
    writeFileSync(source, 'export function drawScene() { return 1; }');
    assert.notDeepEqual(projectSourceHashes(dir), before);
    assert.equal(before[0]!.path, 'src/draw.mjs');
    const alias = join(dir, 'src/alias.mjs');
    symlinkSync(source, alias);
    assert.throws(() => projectSourceHashes(dir));
    rmSync(alias);
    linkSync(source, alias);
    assert.throws(() => projectSourceHashes(dir));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('本片画法接入镜头转场，同帧乱序保持一致，Promise 返回拒绝渲染', () => {
  const spec = compileDirector({ version: '0.1', title: 'test', idea: 'test', aspect: '16:9', look: 'graphic', bpm: 120,
    shots: [0, 1].map(i => ({ purpose: '测试本片入口', visualIntent: '方块移动', beats: 2, title: `test-${i}`, backdrop: 'studio', motif: 'none', transition: i ? 'dissolve' : 'cut' })),
  }).spec;
  const rc = (frameIndex: number) => makeFrameContext({ frameIndex, totalFrames: 48, fps: 24, width: 160, height: 90, seed: spec.video.seed });
  const make = (transition = true) => {
    const local = structuredClone(spec);
    if (!transition) local.scenes[1]!.transition = 'cut';
    return createSpecRenderer({ spec: local, width: 160, height: 90, drawScene: ({ ctx, scene, progress, width, height }) => {
      ctx.fillStyle = scene.id === local.scenes[0]!.id ? '#112233' : '#99aabb';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ee7744';
      ctx.fillRect(20 + progress * 60, 25, 20, 20);
    } });
  };
  const renderer = make(), cut = make(false);
  try {
    const pixels = (frame: number) => Buffer.from(renderer.renderFrame(rc(frame)).data);
    const first = pixels(5), later = pixels(18);
    assert.notDeepEqual(first, later);
    assert.deepEqual(first, pixels(5));
    assert.notDeepEqual(pixels(28), Buffer.from(cut.renderFrame(rc(28)).data));
  } finally { renderer.dispose(); cut.dispose(); }
  const invalid = createSpecRenderer({ spec, width: 160, height: 90, drawScene: (() => Promise.resolve()) as never });
  try { assert.throws(() => invalid.renderFrame(rc(5)), /同步返回/); }
  finally { invalid.dispose(); }
});
