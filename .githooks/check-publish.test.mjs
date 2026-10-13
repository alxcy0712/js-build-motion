import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = resolve('.githooks/check-publish.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');
const scratch = resolve('.research/out');
mkdirSync(scratch, { recursive: true });
function fixture(fn) {
  const dir = mkdtempSync(join(scratch, 'publish-check-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const put = (path, content) => writeFileSync(join(dir, path), content);
  const check = (mode, input) => {
    const result = spawnSync(process.execPath, [checker, mode], { cwd: dir, input, encoding: 'utf8' });
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  git('init', '-q');
  git('config', 'user.name', 'Security Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'core.hooksPath', '.git/hooks');
  try { fn({ dir, git, put, check }); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('clean source passes worktree, index, history and push', () => fixture(({ git, put, check }) => {
  put('README.md', 'Public source review\n'); git('add', '.'); git('commit', '-qm', 'Clean source');
  for (const mode of ['--worktree', '--staged', '--history']) assert.equal(check(mode).status, 0);
  const oid = git('rev-parse', 'HEAD');
  assert.equal(check('--push', `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(40)}\n`).status, 0);
}));
test('authorized personal IP PNG and documentation pass every publication gate', () => fixture(({ dir, git, put, check }) => {
  mkdirSync(join(dir, 'assets/personal-ip/views'), { recursive: true });
  put('assets/personal-ip/views/front.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'));
  put('assets/personal-ip/README.md', '# Reusable character\n');
  put('assets/personal-ip/identity.json', '{"version":"1.0"}\n');
  git('add', '.'); git('commit', '-qm', 'Personal IP assets');
  for (const mode of ['--worktree', '--staged', '--history']) assert.equal(check(mode).status, 0);
  const oid = git('rev-parse', 'HEAD');
  assert.equal(check('--push', `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(40)}\n`).status, 0);
}));
test('cover assets pass worktree, index, history and push with image formats and source files', () => fixture(({ dir, git, put, check }) => {
  mkdirSync(join(dir, 'assets/douyin-cover/examples'), { recursive: true });
  put('assets/douyin-cover/examples/portrait.png', png);
  put('assets/douyin-cover/examples/avatar.webp', Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64'));
  put('assets/douyin-cover/examples/editor-preview.jpg', Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z', 'base64'));
  put('assets/douyin-cover/template.js', 'window.drawCover = () => {};\n');
  put('assets/douyin-cover/image-prompt.txt', 'One isolated illustration.\n');
  git('add', '.'); git('commit', '-qm', 'Cover assets');
  for (const mode of ['--worktree', '--staged', '--history']) assert.equal(check(mode).status, 0);
  const oid = git('rev-parse', 'HEAD');
  assert.equal(check('--push', `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(40)}\n`).status, 0);
}));
test('asset allowance keeps unsupported binaries, forged images, credentials and large files blocked', () => fixture(({ dir, git, put, check }) => {
  mkdirSync(join(dir, 'assets/personal-ip'), { recursive: true });
  mkdirSync(join(dir, 'assets/other'), { recursive: true });
  put('assets/other/avatar.bin', png);
  put('assets/personal-ip/forged.png', 'arbitrary payload');
  put('assets/personal-ip/identity.json', 'API_KEY=' + 'e'.repeat(32));
  put('assets/personal-ip/large.png', Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]));
  git('add', '.');
  const result = check('--staged');
  assert.equal(result.status, 1);
  for (const path of ['assets/other/avatar.bin', 'assets/personal-ip/forged.png', 'assets/personal-ip/identity.json', 'assets/personal-ip/large.png']) {
    assert.ok(result.report.findings.some(item => item.path === path), path);
  }
}));
test('image metadata and appended credentials are blocked while AI provenance is accepted', () => fixture(({ dir, git, put, check }) => {
  mkdirSync(join(dir, 'assets/douyin-cover'), { recursive: true });
  const chunk = (kind, value) => {
    const bytes = Buffer.from(value), size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    return Buffer.concat([size, Buffer.from(kind), bytes, Buffer.alloc(4)]);
  };
  const image = extra => Buffer.concat([png.subarray(0, -12), extra, png.subarray(-12)]);
  put('assets/douyin-cover/hero.png', image(chunk('caBX', 'AI generation provenance'))); git('add', '.');
  assert.equal(check('--staged').status, 0);
  for (const content of [image(chunk('tEXt', 'Author\0Private person')), image(chunk('eXIf', 'GPS')), Buffer.concat([png, Buffer.from('ghp_' + 'z'.repeat(36))])]) {
    put('assets/douyin-cover/hero.png', content); git('add', '.');
    const result = check('--staged'); assert.equal(result.status, 1);
    assert.equal(JSON.stringify(result.report).includes('z'.repeat(36)), false);
  }
  put('assets/douyin-cover/hero.png', image(chunk('caBX', 'ghp_' + 'z'.repeat(36)))); git('add', '.');
  assert.ok(check('--staged').report.findings.some(item => item.reason === 'GitHub 凭据'));
}));
test('local agent records are ignored and forced additions remain blocked', () => fixture(({ dir, git, put, check }) => {
  copyFileSync(resolve('.gitignore'), join(dir, '.gitignore'));
  mkdirSync(join(dir, '.pi/goals'), { recursive: true });
  put('.pi/goals/events.jsonl', '{"objective":"Private task"}\n');
  git('add', '.'); assert.equal(check('--staged').status, 0);
  assert.match(git('check-ignore', '.pi/goals/events.jsonl'), /events\.jsonl/);
  git('add', '-f', '.pi');
  assert.ok(check('--staged').report.findings.some(item => item.path.startsWith('.pi/') && item.reason.includes('本地制作')));
  git('commit', '-qm', 'Forced local record');
  git('rm', '-r', '.pi'); git('commit', '-qm', 'Remove local record');
  assert.equal(check('--staged').status, 0);
  assert.equal(check('--history').status, 1);
}));
test('additional service tokens and authenticated database URLs are blocked', () => fixture(({ git, put, check }) => {
  const values = ['hf_' + 'a'.repeat(32), 'glpat-' + 'b'.repeat(24), 'postgresql://' + 'user:' + 'c'.repeat(20) + '@example.invalid/db'];
  for (const value of values) {
    put('README.md', value); git('add', '.');
    const result = check('--staged'); assert.equal(result.status, 1);
    assert.equal(JSON.stringify(result.report).includes(value), false);
  }
}));
test('general research is shareable while research output and maintenance records stay local', () => fixture(({ dir, git, put, check }) => {
  mkdirSync(join(dir, '.research/out'), { recursive: true });
  mkdirSync(join(dir, 'projects/.maintenance'), { recursive: true });
  put('.research/README.md', '# Motion research\n\nStudy state, attention and continuity.\n');
  git('add', '.research/README.md');
  assert.equal(check('--staged').status, 0);
  put('.research/out/probe.md', 'Temporary observation\n');
  put('.research/history.json', '{}\n');
  put('projects/.maintenance/history.json', '{}\n');
  git('add', '-f', '.');
  const result = check('--staged'); assert.equal(result.status, 1);
  for (const path of ['.research/out/probe.md', '.research/history.json', 'projects/.maintenance/history.json']) {
    assert.ok(result.report.findings.some(item => item.path === path), path);
  }
}));
test('index inspection uses staged bytes', () => fixture(({ git, put, check }) => {
  put('README.md', 'Safe\n'); git('add', '.');
  put('README.md', 'ghp_' + 'a'.repeat(36));
  assert.equal(check('--staged').status, 0);
  const result = check('--worktree'); assert.equal(result.status, 1);
  assert.equal(result.report.findings[0].reason, 'GitHub 凭据');
  assert.equal(JSON.stringify(result.report).includes('a'.repeat(36)), false);
}));
test('deleted historical credential still blocks publication', () => fixture(({ git, put, check }) => {
  put('README.md', 'sk-' + 'b'.repeat(40)); git('add', '.'); git('commit', '-qm', 'Fixture');
  put('README.md', 'Safe\n'); git('add', '.'); git('commit', '-qm', 'Remove fixture');
  assert.equal(check('--staged').status, 0);
  assert.equal(check('--history').status, 1);
}));
test('film content and credential files are blocked even when forced into index', () => fixture(({ git, put, check }) => {
  mkdirSync(join(resolve(git('rev-parse', '--show-toplevel')), 'projects/demo'), { recursive: true });
  put('projects/demo/prompt-history.jsonl', '{}\n'); put('.env', 'LOCAL_SETTING=value\n');
  git('add', '-f', '.');
  const result = check('--staged'); assert.equal(result.status, 1);
  assert.ok(result.report.findings.some(item => item.path === '.env'));
  assert.ok(result.report.findings.some(item => item.path.includes('prompt-history')));
}));
test('home paths, private keys, dotenv credentials and binary payloads are detected', () => fixture(({ git, put, check }) => {
  const payloads = [
    ['', 'Users', 'private-person', 'file'].join('/'),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'API_KEY=' + 'c'.repeat(32),
    Buffer.from('private text', 'utf16le'),
  ];
  for (const content of payloads) { put('README.md', content); git('add', '.'); assert.equal(check('--staged').status, 1); }
  put('.env.example', 'API_KEY=YOUR_API_KEY_HERE\n'); put('README.md', 'Safe\n'); git('add', '.');
  assert.equal(check('--staged').status, 0);
}));
test('internal refs are rejected by the push gate', () => fixture(({ git, put, check }) => {
  put('README.md', 'Safe\n'); git('add', '.'); git('commit', '-qm', 'Clean source');
  const oid = git('rev-parse', 'HEAD');
  const result = check('--push', `refs/heads/main ${oid} refs/codex/checkpoint ${'0'.repeat(40)}\n`);
  assert.equal(result.status, 1);
  assert.ok(result.report.findings.some(item => item.reason.includes('分支和标签')));
}));
test('installed hooks block an actual commit and a local push of sensitive history', () => fixture(({ dir, git, put }) => {
  mkdirSync(join(dir, '.githooks'));
  for (const name of ['check-publish.mjs', 'pre-commit', 'pre-push']) {
    copyFileSync(resolve('.githooks', name), join(dir, '.githooks', name));
    chmodSync(join(dir, '.githooks', name), 0o755);
  }
  git('config', 'core.hooksPath', '.githooks');
  put('README.md', 'Safe\n'); git('add', '.'); git('commit', '-qm', 'Clean source');
  const remote = join(dir, '.research/remote.git');
  git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  const clean = git('-C', remote, 'rev-parse', 'main');
  put('README.md', 'ghp_' + 'd'.repeat(36)); git('add', 'README.md');
  const blockedCommit = spawnSync('git', ['commit', '-qm', 'Fixture'], { cwd:dir, encoding:'utf8' });
  assert.notEqual(blockedCommit.status, 0);
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fixture history');
  put('README.md', 'Safe again\n'); git('add', 'README.md'); git('commit', '-qm', 'Remove fixture');
  const blockedPush = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd:dir, encoding:'utf8' });
  assert.notEqual(blockedPush.status, 0);
  assert.equal(git('-C', remote, 'rev-parse', 'main'), clean);
}));
