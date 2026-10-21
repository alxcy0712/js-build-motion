import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GUIDE_FILES, copyGuides } from '../../scripts/guide-files.mjs';
import { PROJECT_ROOT } from '../src/utils/env.ts';

test('macOS guide selection and Linux bootstrap produce the same independent required guides', () => {
  const output = resolve(PROJECT_ROOT, '../../.research/out'); mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, 'guide-bootstrap-')), skill = join(root, '.skill');
  try {
    for (const dir of ['engine/src', 'references', 'assets/project/evidence']) mkdirSync(join(skill, dir), { recursive: true });
    for (const name of [...GUIDE_FILES, 'maintenance.md']) writeFileSync(join(skill, 'references', name), '# ' + name);
    writeFileSync(join(skill, 'engine/package.json'), JSON.stringify({ dependencies: {} }));
    for (const name of ['easing', 'random']) writeFileSync(join(skill, 'engine/src', name + '.ts'), 'export const fixture = 1;');
    writeFileSync(join(skill, 'assets/components.json'), JSON.stringify(Object.fromEntries(['easing', 'random'].map(name => [name, { source: 'src/' + name + '.ts' }]))));
    writeFileSync(join(skill, 'assets/project/AGENTS.md'), 'Read guide/workflow.md');
    copyFileSync(resolve(PROJECT_ROOT, '../brand.json'), join(skill, 'brand.json'));
    writeFileSync(join(skill, 'manifest.json'), JSON.stringify({ packageId: 'fixture', dependencies: [] }));
    const prompt = join(root, 'idea.txt'); writeFileSync(prompt, '独立初始化原文\n第二行');
    copyGuides(skill, join(root, 'mac-project'));
    const child = spawnSync(process.execPath, [resolve(PROJECT_ROOT, '../scripts/start-linux.mjs')], {
      cwd: root, env: { ...process.env, JBM_FILM_SLUG: 'linux-fixture', JBM_FILM_THEME: 'minimal', JBM_IDEA_FILE: prompt }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    const project = join(root, 'projects/linux-fixture');
    for (const dir of [project, join(root, 'mac-project')]) {
      assert.deepEqual(readdirSync(join(dir, 'guide')).sort(), [...GUIDE_FILES].sort());
      for (const name of GUIDE_FILES) {
        const source = join(skill, 'references', name), target = join(dir, 'guide', name);
        assert.deepEqual(readFileSync(target), readFileSync(source));
        assert.notEqual(statSync(target).ino, statSync(source).ino); assert.equal(statSync(target).nlink, 1);
      }
    }
    const workspace = JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8'));
    assert.equal(workspace.mode, 'manual-linux'); assert.equal(workspace.engineSha256, null);
    assert.equal(workspace.sandbox, 'host-managed-unverified');
    assert.equal(JSON.parse(readFileSync(join(project, 'prompt-history.jsonl'), 'utf8')).text, readFileSync(prompt, 'utf8'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
