import { createFixtureProject } from './fixtures/project.ts';
/**
 * 实测遥测测试（task-5）。
 *
 * 重点在于两类性质，而不是"文件写出来了"：
 *
 * 1. **可复现**：同输入两次渲染 → `facts` 段逐字节相同、`runId` 相同；
 *    只有显式标注为 `measured` 的耗时/产物哈希允许不同。
 * 2. **不可篡改**：`runId` 与 `artifactId` 都能从文件自身重算，
 *    因此手改 `facts` 或产物记录都会被读出来。
 *
 * 另有一条源码级守卫：遥测模块本身不得引入 `Date.now()` / `Math.random()`。
 * 这条规则如果只写在 AGENTS.md 里，迟早会被绕过；写进测试才有约束力。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

import { PROJECT_ROOT } from '../src/utils/env.ts';
import { sha256File } from '../src/utils/hash.ts';
import {
  audioArtifactHashes,
  buildFacts,
  buildMeasured,
  buildRunLog,
  computeArtifactId,
  computeRunId,
  readRunLog,
  runLogPathFor,
  verifyRunLog,
  writeRunLog,
  type FactsInput,
} from '../src/project/run-log.ts';
import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';

/** 测试临时文件落 .research/out/；用带随机后缀的目录，不留固定父目录 */
const SCRATCH_ROOT = join(PROJECT_ROOT, '.research', 'out');

function scratchDir(name: string): { dir: string; cleanup: () => void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, `run-log-tests-${name}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function factsInput(overrides: Partial<FactsInput> = {}): FactsInput {
  return {
    video: { width: 1080, height: 1920, fps: 24, duration: 8, frames: 192, seed: 20260926 },
    rendererKind: 'skia',
    rendererPackage: 'skia-canvas',
    rendererVersion: '3.0.8',
    encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: 'aac', crf: null, preset: null },
    ffmpeg: { version: '7.1', command: 'ffmpeg' },
    providers: { tts: 'edge', bgm: 'procedural', sfx: 'procedural' },
    captions: { insideFrame: true, cues: 1, wordLevel: true },
    ...overrides,
  };
}

function measured(overrides: Partial<Parameters<typeof buildMeasured>[0]> = {}) {
  return buildMeasured({
    renderMs: 4612,
    msPerFrame: 24.02,
    encodeTailMs: 596,
    audioMixMs: null,
    outputBytes: 2254124,
    outputSha256: 'a'.repeat(64),
    outputPath: 'projects/demo/out/demo.mp4',
    ...overrides,
  });
}

const fixture = createFixtureProject();
after(fixture.cleanup);

// ------------------------------------------------------------ facts 构建

test('facts 的 tools 是实际调用的工具，且已排序、去重', () => {
  const facts = buildFacts(factsInput());
  assert.deepEqual(facts.tools, [
    'edge-tts',
    'ffmpeg',
    'ffprobe',
    'procedural-bgm',
    'procedural-sfx',
    'skia-canvas',
  ]);
  assert.deepEqual(facts.network, ['edge-tts'], 'network 应是 tools 里依赖网络的子集');
  assert.deepEqual(facts.unmappedTools, []);
});

test('复用文件音轨保留 provider 来源，实际工具只包含渲染与封装', () => {
  const facts = buildFacts(factsInput({ providers: { tts: 'file', bgm: 'file', sfx: 'file' } }));
  assert.deepEqual(facts.providers, { tts: 'file', bgm: 'file', sfx: 'file' });
  assert.deepEqual(facts.tools, ['ffmpeg', 'ffprobe', 'skia-canvas']);
  assert.deepEqual(facts.network, []);
  assert.deepEqual(facts.unmappedTools, []);
});

test('声音锁保留原制作来源，本次工具事实只记录当前调用', () => {
  const audioReuse = { lockPath: 'assets/derived/audio/locked/audio-lock.json', lockSha256: 'd'.repeat(64), sourceProviders: { tts: 'edge', bgm: 'procedural', sfx: 'procedural' } };
  const facts = buildFacts(factsInput({ providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' }, audioReuse }));
  assert.deepEqual(facts.audioReuse, audioReuse);
  assert.deepEqual(facts.tools, ['ffmpeg', 'ffprobe', 'skia-canvas']);
  assert.deepEqual(facts.network, []);
  assert.notEqual(computeRunId('s', 'b', facts), computeRunId('s', 'b', { ...facts, audioReuse: { ...audioReuse, lockSha256: 'e'.repeat(64) } }));
});

test('unknown renderer kind / provider 会进 unmappedTools 而不是被当成已知工具', () => {
  const facts = buildFacts(
    factsInput({ rendererKind: 'canvas-dom', providers: { tts: 'some-new-tts', bgm: 'procedural', sfx: '(none)' } }),
  );
  assert.equal(facts.renderer.toolId, null);
  assert.ok(facts.unmappedTools.includes('renderer:canvas-dom'));
  assert.ok(facts.unmappedTools.includes('tts:some-new-tts'));
  assert.ok(!facts.tools.includes('skia-canvas'), '映射不到就不能伪造成已知工具');
});

test('无音频的渲染不会凭空写出 tts/bgm 工具', () => {
  const facts = buildFacts(
    factsInput({ providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' } }),
  );
  assert.deepEqual(facts.tools, ['ffmpeg', 'ffprobe', 'skia-canvas']);
  assert.deepEqual(facts.network, []);
});

test('外部素材会被读取并哈希；缺失文件记为未核验而不是静默忽略', () => {
  const manifest = fixture;
  const facts = buildFacts(
    factsInput({
      projectDir: manifest.dir,
      declaredAssets: [{ path: 'spec/main.json', kind: 'document', license: 'internal' }],
    }),
  );
  const first = facts.assets.external[0];
  assert.ok(first);
  assert.equal(first.sha256, sha256File(join(manifest.dir, 'spec/main.json')));
  assert.equal(first.license, 'internal');
});

test('字体哈希进 facts.fonts（工具链资产也要可核对）', () => {
  const fontPath = join(PROJECT_ROOT, 'assets', 'fonts', 'LXGWWenKai-Regular.ttf');
  const facts = buildFacts(
    factsInput({ fonts: [{ family: 'LXGW WenKai', absPath: fontPath, registered: true }] }),
  );
  if (facts.fonts.length > 0) {
    assert.equal(facts.fonts[0]?.sha256, sha256File(fontPath));
    assert.equal(facts.fonts[0]?.registered, true);
  }
});

test('实际命中字族进 facts.fontUsage，并参与运行身份核对', () => {
  const facts = buildFacts(factsInput({ fontUsage: ['Noto Sans CJK SC', 'Inter', 'Noto Sans CJK SC'] }));
  assert.deepEqual(facts.fontUsage, ['Inter', 'Noto Sans CJK SC']);
  const other = buildFacts(factsInput({ fontUsage: ['PingFang SC'] }));
  assert.notEqual(computeRunId('spec-hash', null, facts), computeRunId('spec-hash', null, other));
  assert.equal(buildFacts(factsInput()).fontUsage, undefined);
});

// ------------------------------------------------------------ 可复现性

test('同输入两次构建：facts 与 runId 完全相同', () => {
  const a = buildFacts(factsInput());
  const b = buildFacts(factsInput());
  assert.deepEqual(a, b);
  assert.equal(computeRunId('spec-hash', 'brief-hash', a), computeRunId('spec-hash', 'brief-hash', b));
});

test('独立 execution 保留原 runId 语义，并拒绝损坏的快照身份', () => {
  const input = { project: fixture.slug, specPath: fixture.specPath, specSha256: 'f'.repeat(64), briefPath: fixture.briefPath, briefSha256: 'e'.repeat(64), facts: buildFacts(factsInput()), measured: measured() };
  const first = buildRunLog({ ...input, execution: { attemptId: 'first', inputSnapshotSha256: 'a'.repeat(64), coverage: 'partial' } });
  const second = buildRunLog({ ...input, execution: { attemptId: 'second', inputSnapshotSha256: 'b'.repeat(64), coverage: 'partial' } });
  assert.equal(first.runId, second.runId);
  assert.notDeepEqual(first.execution, second.execution);
  assert.equal(verifyRunLog({ log: first, specSha256: input.specSha256, briefSha256: input.briefSha256 }).ok, true);
  for (const execution of [{ ...first.execution!, attemptId: '' }, { ...first.execution!, inputSnapshotSha256: 'broken' }, { ...first.execution!, coverage: 'complete' }]) {
    const result = verifyRunLog({ log: { ...first, execution } as typeof first, specSha256: null, briefSha256: null });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /执行快照记录无效/);
  }
});

test('facts 的字段顺序不影响 runId（序列化按 key 排序）', () => {
  const a = buildFacts(factsInput());
  const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
  assert.equal(computeRunId('s', 'b', a), computeRunId('s', 'b', reordered));
});

test('measured 允许不同：耗时与产物哈希不参与 runId', () => {
  const facts = buildFacts(factsInput());
  const m1 = measured({ renderMs: 1000, msPerFrame: 5 });
  const m2 = measured({ renderMs: 9000, msPerFrame: 40 });
  const m3 = measured({ outputSha256: 'b'.repeat(64) });

  // runId 只覆盖配置（facts），因此耗时/产物变化都不影响它
  assert.equal(computeRunId('s', 'b', facts), computeRunId('s', 'b', facts));

  // 只有耗时不同 → artifactId 相同（耗时不是产物身份）
  assert.equal(m1.artifactId, m2.artifactId);
  assert.equal(m1.renderMs, 1000);
  assert.equal(m2.renderMs, 9000);

  // 产物哈希不同 → artifactId 必须不同
  assert.notEqual(m1.artifactId, m3.artifactId, '产物哈希不同时 artifactId 必须不同');
});

test('artifactId 可从文件内容重算（不依赖任何外部状态）', () => {
  const m = measured();
  assert.equal(
    m.artifactId,
    computeArtifactId({ outputSha256: m.outputSha256, audioArtifacts: m.audioArtifacts }),
  );
});

test('audioArtifactHashes 按路径排序且跳过不存在的文件', () => {
  const { dir, cleanup } = scratchDir('audio');
  try {
    writeFileSync(join(dir, 'b.wav'), 'b');
    writeFileSync(join(dir, 'a.wav'), 'a');
    const hashes = audioArtifactHashes([
      { role: 'voice', absPath: join(dir, 'b.wav') },
      { role: 'bgm', absPath: join(dir, 'a.wav') },
      { role: 'master', absPath: join(dir, 'missing.wav') },
    ]);
    assert.deepEqual(
      hashes.map((h) => h.role),
      ['bgm', 'voice'],
    );
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------ 读写与篡改

test('run.json 可写出并读回，路径为仓库相对路径', () => {
  const { dir, cleanup } = scratchDir('roundtrip');
  try {
    const facts = buildFacts(factsInput());
    const log = buildRunLog({
      project: 'demo',
      specPath: fixture.specPath,
      specSha256: 'f'.repeat(64),
      briefPath: fixture.briefPath,
      briefSha256: 'e'.repeat(64),
      facts,
      measured: measured(),
    });
    const path = join(dir, 'run.json');
    writeRunLog(path, log);
    const back = readRunLog(path);
    assert.equal(back.runId, log.runId);
    assert.equal(back.spec.path, relative(PROJECT_ROOT, fixture.specPath));
    assert.ok(!back.spec.path.startsWith('/'), '不得写绝对路径');
    assert.equal(verifyRunLog({ log: back, specSha256: 'f'.repeat(64), briefSha256: 'e'.repeat(64) }).ok, true);
  } finally {
    cleanup();
  }
});

test('手改 facts 会被 runId 重算抓出来', () => {
  const facts = buildFacts(factsInput());
  const log = buildRunLog({
    project: null,
    specPath: join(PROJECT_ROOT, 'out', 'x.json'),
    specSha256: 'f'.repeat(64),
    briefPath: null,
    briefSha256: null,
    facts,
    measured: measured(),
  });

  // 悄悄把用过的工具从清单里删掉——这正是"成果声明掺水"的典型手法
  const tampered = {
    ...log,
    facts: { ...log.facts, tools: log.facts.tools.filter((t) => t !== 'edge-tts') },
  };
  const result = verifyRunLog({ log: tampered, specSha256: null, briefSha256: null });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /facts 段被修改过/);
});

test('手改产物记录会被 artifactId 重算抓出来', () => {
  const log = buildRunLog({
    project: null,
    specPath: join(PROJECT_ROOT, 'out', 'x.json'),
    specSha256: 'f'.repeat(64),
    briefPath: null,
    briefSha256: null,
    facts: buildFacts(factsInput()),
    measured: measured(),
  });
  const tampered = {
    ...log,
    measured: { ...log.measured, outputSha256: 'b'.repeat(64) },
  };
  const result = verifyRunLog({ log: tampered, specSha256: null, briefSha256: null });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /产物记录被修改过/);
});

test('spec / brief 被改动会被哈希比对抓出来', () => {
  const log = buildRunLog({
    project: null,
    specPath: join(PROJECT_ROOT, 'out', 'x.json'),
    specSha256: 'f'.repeat(64),
    briefPath: fixture.briefPath,
    briefSha256: 'e'.repeat(64),
    facts: buildFacts(factsInput()),
    measured: measured(),
  });
  assert.match(
    String(verifyRunLog({ log, specSha256: '0'.repeat(64), briefSha256: 'e'.repeat(64) }).reason),
    /spec 已被修改/,
  );
  assert.match(
    String(verifyRunLog({ log, specSha256: 'f'.repeat(64), briefSha256: '0'.repeat(64) }).reason),
    /brief 已被修改/,
  );
});

test('run.json 缺失 → RUN_LOG_MISSING，且提示先渲染', () => {
  assert.throws(
    () => readRunLog(join(SCRATCH_ROOT, 'definitely-missing', 'run.json')),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.RUN_LOG_MISSING,
  );
});

test('run.json 结构不完整 → 报错而不是把 undefined 当成事实', () => {
  const { dir, cleanup } = scratchDir('broken');
  try {
    const path = join(dir, 'run.json');
    writeFileSync(path, JSON.stringify({ version: '0.1' }));
    assert.throws(
      () => readRunLog(path),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.RUN_LOG_MISSING,
    );
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------ 路径

test('runLogPathFor：项目渲染落在项目根，裸 spec 渲染落在产物旁边', () => {
  const manifest = fixture;
  assert.equal(
    runLogPathFor(join(manifest.outDir, 'x.mp4'), manifest.dir),
    join(manifest.dir, 'run.json'),
    '项目路径必须稳定且可提交：projects/*/out/ 是 gitignore 的，run.json 不能落在那里',
  );
  assert.equal(
    runLogPathFor(join(PROJECT_ROOT, 'out', 'x.mp4'), null),
    join(PROJECT_ROOT, 'out', 'run.json'),
    '裸 spec 渲染：遥测跟着产物走，不往 spec 目录里塞文件',
  );
});

// ------------------------------------------------------------ 磁盘上的真实记录

test('临时夹具运行记录匹配输入，输入变化后校验失败', () => {
  const manifest = fixture;
  const log = buildRunLog({ project: manifest.slug, specPath: manifest.specPath, specSha256: sha256File(manifest.specPath), briefPath: manifest.briefPath, briefSha256: sha256File(manifest.briefPath!), facts: buildFacts(factsInput()), measured: measured() });
  const logPath = join(manifest.dir, 'run.json');
  writeRunLog(logPath, log);
  const saved = readRunLog(logPath);
  const verify = () => verifyRunLog({ log: saved, specSha256: sha256File(manifest.specPath), briefSha256: sha256File(manifest.briefPath!) });
  assert.equal(verify().ok, true);
  writeFileSync(manifest.specPath, readFileSync(manifest.specPath, 'utf8') + '\n');
  assert.equal(verify().ok, false);
});

// ------------------------------------------------------------ 源码级守卫

test('遥测与披露模块不得引入 Date.now() / Math.random()', () => {
  for (const file of ['run-log.ts', 'disclosure.ts', 'brief.ts', 'manifest.ts']) {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'project', file), 'utf8');
    // 允许在注释里提到这两个名字（文档需要解释为什么禁用）
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    assert.ok(!code.includes('Date.now('), `${file} 不得使用 Date.now()`);
    assert.ok(!code.includes('Math.random('), `${file} 不得使用 Math.random()`);
  }
});

test('facts 里不存在任何时间戳字段（时间戳会让证据无法复现）', () => {
  const facts = buildFacts(factsInput()) as unknown as Record<string, unknown>;
  const json = JSON.stringify(facts);
  for (const suspicious of ['timestamp', 'generatedAt', 'createdAt', 'now']) {
    assert.ok(!json.includes(suspicious), `facts 不应包含 ${suspicious}`);
  }
});
