import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startDirectorProject } from '../src/cli/director.ts';
import { appendPromptHistory, promptHistorySnapshot, readPromptHistory, PROMPT_HISTORY_FILE } from '../src/project/prompt-history.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { sha256File } from '../src/utils/hash.ts';

function fixture(action: (dir: string) => void): void {
  const out = join(PROJECT_ROOT, '.research/out');
  mkdirSync(out, { recursive: true });
  const dir = mkdtempSync(join(out, 'prompt-history-'));
  try { action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const original = '  制作一支讲解片。\n保留公式 πr²、引号 "A"、反引号 `code` 和 $(literal)。\n';

test('创建保存原文，问答与修改按顺序追加，编译保留历史字节与快照', () => fixture(dir => {
  const project = startDirectorProject({ slug: 'prompt-film', idea: original, projectsRoot: dir }).dir;
  assert.ok(readFileSync(join(project, 'NOTES.md'), 'utf8').includes('学习状态：pending。'));
  const path = join(project, PROMPT_HISTORY_FILE);
  const initial = readFileSync(path, 'utf8');
  assert.equal(readPromptHistory(project)[0]!.text, original);
  appendPromptHistory(project, 'question', '画幅选 16:9 还是 9:16？');
  appendPromptHistory(project, 'answer', '9:16，保留中文旁白。');
  const revision = '把结论停留延长。\n' + '补充要求。'.repeat(1200);
  appendPromptHistory(project, 'prompt', revision);
  const entries = readPromptHistory(project);
  assert.deepEqual(entries.map(entry => entry.kind), ['prompt', 'question', 'answer', 'prompt']);
  assert.equal(entries[3]!.text, revision);
  assert.ok(entries.every(entry => Number.isFinite(Date.parse(entry.timestamp))));
  assert.ok(readFileSync(path, 'utf8').startsWith(initial));
  const before = readFileSync(path, 'utf8');
  const plan = { version: '0.1', idea: original, title: '解释', aspect: '9:16', look: 'graphic', bpm: 96,
    shots: [{ purpose: '呈现结论', visualIntent: '固定视点，公式出现后停稳', beats: 4, title: '结论', backdrop: 'studio', motif: 'none', cameraMove: 'static', transition: 'cut' }] };
  writeFileSync(join(project, 'director.json'), JSON.stringify(plan));
  const rejected = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), 'direct', 'compile', project], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /VISUAL_INTENT_IMPLEMENTATION_REQUIRED/);
  const manifest = JSON.parse(readFileSync(join(project, 'project.json'), 'utf8'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src/draw.mjs'), 'export function drawScene({ctx,width,height}) { ctx.fillStyle="#203E36"; ctx.font="48px sans-serif"; ctx.fillText("πr²",width*.35,height*.4); }');
  writeFileSync(join(project, 'project.json'), JSON.stringify({ ...manifest, drawing: 'src/draw.mjs' }));
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), 'direct', 'compile', project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(promptHistorySnapshot(project), { path: PROMPT_HISTORY_FILE, sha256: sha256File(path), entries: 4 });
}));

test('CLI 从本片文件保留多行原文，查看记录，拒绝越界文件与歧义参数', () => fixture(dir => {
  const project = startDirectorProject({ slug: 'prompt-cli', idea: original, projectsRoot: dir }).dir;
  const text = '\n回答：使用红色箭头。\n保留 `literal` 和 $HOME。\n';
  writeFileSync(join(project, 'answer.txt'), text);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), 'prompt', project, ...args], { encoding: 'utf8' });
  assert.equal(cli('--kind', 'answer', '--file', 'answer.txt').status, 0);
  const shown = cli();
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout)[1].text, text);
  const before = readFileSync(join(project, PROMPT_HISTORY_FILE), 'utf8');
  writeFileSync(join(dir, 'outside.txt'), 'outside');
  for (const args of [['--kind', 'answer', '--file', '../outside.txt'], ['--kind', 'answer', '--text', 'answer', '--file', 'answer.txt'], ['--text', 'answer']]) {
    assert.notEqual(cli(...args).status, 0);
    assert.equal(readFileSync(join(project, PROMPT_HISTORY_FILE), 'utf8'), before);
  }
}));

test('无原始 prompt、无效输入或损坏记录均拒绝追加，保留已有内容', () => fixture(dir => {
  assert.deepEqual(readPromptHistory(dir), []);
  assert.equal(promptHistorySnapshot(dir), undefined);
  assert.throws(() => appendPromptHistory(dir, 'question', '问题'), /原始 prompt/);
  appendPromptHistory(dir, 'prompt', original);
  const path = join(dir, PROMPT_HISTORY_FILE);
  const before = readFileSync(path, 'utf8');
  assert.throws(() => appendPromptHistory(dir, 'summary', '改写'));
  assert.throws(() => appendPromptHistory(dir, 'answer', ' \n'));
  assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(path, before + '{broken}\n');
  assert.throws(() => appendPromptHistory(dir, 'answer', '答案'), /JSON 无效/);
  assert.equal(readFileSync(path, 'utf8'), before + '{broken}\n');
}));

test('软链接与硬链接记录拒绝修改，目标原文保持完整', () => fixture(dir => {
  const target = join(dir, 'source.txt');
  const project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(target, 'original');
  const path = join(project, PROMPT_HISTORY_FILE);
  for (const link of [symlinkSync, linkSync]) {
    link(target, path);
    assert.throws(() => appendPromptHistory(project, 'prompt', 'changed'));
    assert.equal(readFileSync(target, 'utf8'), 'original');
    rmSync(path);
  }
}));
