import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrandStage } from '../src/three/stage.mjs';
import { inside, renderThree, validateOptions } from '../src/three/render.mjs';
import { getTheme } from '../src/themes/registry.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { capabilities } from '../src/cli/director.ts';

test('Three stage preserves both themes, exact-colour surfaces and independent scene state', () => {
  for (const id of ['minimal', 'kinetic']) {
    const theme = getTheme(id), settings = { theme, width: 960, height: 540, alpha: false };
    const stage = createBrandStage(settings), transparent = createBrandStage({ ...settings, alpha: true });
    assert.equal(stage.scene.background.getHexString(), theme.palette.bg.slice(1).toLowerCase());
    assert.equal(transparent.scene.background, null);
    assert.equal(stage.camera.aspect, 16 / 9);
    assert.equal(stage.material('accent').color.getHexString(), 'ffc712');
    assert.equal(stage.flatMaterial({ color: theme.palette.accent }).color.getHexString(), 'ffc712');
    assert.equal(stage.flatMaterial().toneMapped, false);
    stage.camera.position.x = 100;
    assert.notEqual(transparent.camera.position.x, 100);
  }
  const tools = (capabilities() as any).tools;
  assert.equal(tools.find((tool: any) => tool.id === 'threejs').status, 'adopted');
  assert.equal(tools.find((tool: any) => tool.id === 'threejs').byteReproducible, false);
});

test('Three entry rejects traversal, links, overwrite and invalid frame budgets before launch', async () => {
  const parent = join(PROJECT_ROOT, '.research/out'); mkdirSync(parent, { recursive: true });
  const project = mkdtempSync(join(parent, 'three-options-'));
  const options = { scene: 'src/scene.mjs', out: 'assets/three/shot', frames: 3 };
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src/scene.mjs'), 'export function createScene() {}');
    writeFileSync(join(project, 'brand.json'), JSON.stringify({ version: 2, theme: 'kinetic', enforcement: 'override', changes: [] }));
    assert.equal(validateOptions(project, options).fps, 30);
    for (const path of ['../src/scene.mjs', '/tmp/outside', 'src/../scene.mjs', 'src//scene.mjs', 'src/file?x']) assert.throws(() => inside(project, path), /THREE_PATH/);
    for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => validateOptions(project, { ...options, frames: value }), /THREE_OPTION_INVALID/);
    for (const out of ['out/three', '.engine/three', 'assets/three/../../outside']) assert.throws(() => validateOptions(project, { ...options, out }));
    symlinkSync(join(project, 'src/scene.mjs'), join(project, 'src/alias.mjs'));
    assert.throws(() => validateOptions(project, { ...options, scene: 'src/alias.mjs' }), /THREE_PATH_LINK/);
    await assert.rejects(renderThree(project, { ...options, browser: '/missing-three-browser' }), /THREE_BROWSER_REQUIRED/);
    assert.equal(existsSync(join(project, options.out)), false);
    mkdirSync(join(project, options.out), { recursive: true });
    assert.throws(() => validateOptions(project, options), /THREE_OUTPUT_EXISTS/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
