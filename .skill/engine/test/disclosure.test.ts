/**
 * 声明—实测对账测试（task-6）。
 *
 * 分两层：
 *
 * 1. **规则表单元测试**：直接调 `reconcile()`，把每条规则的正反例都钉死。
 *    为什么需要这一层：`validateBrief` 已经拦掉了一部分自相矛盾的 brief，
 *    于是有些对账分支（例如"brief 说零素材、run 记录里有素材"）在集成路径上几乎走不到。
 *    那些分支恰恰是"brief 被改过、run.json 没重渲"的真实形态，必须被测到。
 * 2. **集成测试**：造一个真项目目录 + 真 run.json，跑 `buildDisclosure()` 和命令行，
 *    验证「冲突时不生成披露文件、且指名冲突字段」。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { sha256File, sha256Text } from '../src/utils/hash.ts';
import { loadProject } from '../src/project/manifest.ts';
import { validateSpec } from '../src/spec/validate.ts';
import type { BriefAsset, ResolvedBrief } from '../src/project/brief.ts';
import {
  EVIDENCE,
  buildDisclosure,
  reconcile,
  renderDisclosure,
} from '../src/project/disclosure.ts';
import {
  buildFacts,
  buildMeasured,
  buildRunLog,
  writeRunLog,
  type RunLog,
  type RunLogFacts,
} from '../src/project/run-log.ts';

/** 夹具项目落 .research/out/；目录名必须等于 slug，因此 mkdtemp 只用来做父目录 */
const SCRATCH_ROOT = join(PROJECT_ROOT, '.research', 'out');

function scratchParent(name: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, `disclosure-tests-${name}-`));
}

// ---------------------------------------------------------------- 夹具

function minimalSpec(duration = 3): Record<string, unknown> {
  return {
    version: '0.1',
    video: { width: 1080, height: 1920, fps: 24, duration, seed: 20260101 },
    style: { preset: 'watercolor_storybook', palette: 'warm_night', paper: 'rough', line: 'soft_ink' },
    characters: [{ id: 'narrator', preset: 'female_young', hair: 'long_dark', clothing: 'beige_coat' }],
    scenes: [
      {
        id: 'scene_01',
        start: 0,
        end: duration,
        environment: 'rain_window',
        camera: 'medium_close',
        character: 'narrator',
        action: 'look_outside',
        emotion: 'calm',
      },
    ],
    audio: { narration: [{ start: 0.6, voice: 'female_calm', text: '测试旁白。' }] },
    captions: { enabled: true, style: 'handwritten', mode: 'sentence' },
  };
}

function minimalBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.1',
    archetype: 'code-animation-no-assets',
    intent: '对账测试用的最小项目，验证声明与实测的差集能否被抓出来。',
    deliverable: { duration: 3, aspect: '9:16', fps: 24 },
    tools: {
      allowed: ['skia-canvas', 'edge-tts', 'procedural-bgm', 'procedural-sfx', 'ffmpeg', 'ffprobe'],
      forbidden: [],
    },
    claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: true, humanRevision: false },
    ...overrides,
  };
}

interface Fixture {
  readonly slug: string;
  readonly dir: string;
  readonly cleanup: () => void;
  /** 渲染后手改 spec（模拟"改了 spec 没重渲"） */
  readonly bumpSpec: () => void;
  readonly writeRunLog: (mutate?: (log: RunLog) => RunLog) => void;
}

interface FixtureOptions {
  readonly name: string;
  readonly spec?: Record<string, unknown>;
  readonly brief?: Record<string, unknown>;
  readonly providers?: { tts: string; bgm: string; sfx: string };
  readonly declaredAssets?: readonly BriefAsset[];
  readonly withRunLog?: boolean;
}

let counter = 0;

function makeFixture(options: FixtureOptions): Fixture {
  const slug = `fx-${options.name}${counter++}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const dir = join(scratchParent(options.name), slug);
  mkdirSync(join(dir, 'spec'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });

  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify(
      {
        version: '0.1',
        slug,
        title: '对账测试项目',
        status: 'production',
        entry: 'spec/main.json',
      },
      null,
      2,
    ),
  );

  const spec = options.spec ?? minimalSpec();
  writeFileSync(join(dir, 'spec', 'main.json'), JSON.stringify(spec, null, 2));
  writeFileSync(join(dir, 'brief.json'), JSON.stringify(options.brief ?? minimalBrief(), null, 2));

  // 素材文件：声明了就必须真实存在，否则 brief 校验会先失败
  for (const asset of options.declaredAssets ?? []) {
    const abs = join(dir, asset.path);
    mkdirSync(join(abs, '..'), { recursive: true });
    if (!existsSync(abs)) writeFileSync(abs, 'fixture asset\n');
  }

  const specPath = join(dir, 'spec', 'main.json');
  const briefPath = join(dir, 'brief.json');

  const buildLog = (mutate?: (log: RunLog) => RunLog): RunLog => {
    const facts = buildFacts({
      video: { width: 1080, height: 1920, fps: 24, duration: Number((spec['video'] as Record<string, unknown>)['duration']), frames: 72, seed: 20260101 },
      rendererKind: 'skia',
      rendererPackage: 'skia-canvas',
      rendererVersion: '3.0.8',
      encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: 'aac', crf: null, preset: null },
      ffmpeg: { version: '7.1', command: 'ffmpeg' },
      providers: options.providers ?? { tts: 'edge', bgm: 'procedural', sfx: 'procedural' },
      projectDir: dir,
      ...(options.declaredAssets ? { declaredAssets: options.declaredAssets } : {}),
      captions: { insideFrame: true, cues: 1, wordLevel: true },
    });
    const log = buildRunLog({
      project: slug,
      specPath,
      specSha256: sha256File(specPath),
      briefPath,
      briefSha256: sha256File(briefPath),
      facts,
      measured: buildMeasured({
        renderMs: 3000,
        msPerFrame: 41.6,
        encodeTailMs: 200,
        audioMixMs: null,
        outputBytes: 1000000,
        outputSha256: sha256Text('fixture output'),
        outputPath: `${slug}/out/main.mp4`,
      }),
    });
    return mutate ? mutate(log) : log;
  };

  const write = (mutate?: (log: RunLog) => RunLog): void => {
    writeRunLog(join(dir, 'run.json'), buildLog(mutate));
  };

  if (options.withRunLog !== false) write();

  return {
    slug,
    dir,
    cleanup: () => rmSync(dirname(dir), { recursive: true, force: true }),
    bumpSpec: () => writeFileSync(specPath, JSON.stringify(minimalSpec(4), null, 2)),
    writeRunLog: write,
  };
}

// ---------------------------------------------------------------- 规则表

const baseBrief: ResolvedBrief = {
  version: '0.1',
  archetype: 'code-animation-no-assets',
  intent: '单元测试用的 brief 对象',
  audience: null,
  deliverable: { duration: 3, aspect: '9:16', fps: 24, captions: 'inside_frame' },
  inputs: { referenceClips: [], documents: [], brandAssets: [], audio: [] },
  assets: [],
  tools: { allowed: ['skia-canvas', 'ffmpeg', 'ffprobe'], forbidden: [] },
  claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: true, humanRevision: false },
  acceptance: [],
  notes: null,
};

function baseFacts(overrides: Partial<RunLogFacts> = {}): RunLogFacts {
  return {
    video: { width: 1080, height: 1920, fps: 24, duration: 3, frames: 72, seed: 1 },
    renderer: { kind: 'skia', toolId: 'skia-canvas', package: 'skia-canvas', version: '3.0.8' },
    encoder: { video: 'h264', pixelFormat: 'yuv420p', audio: 'aac', crf: null, preset: null },
    ffmpeg: { version: '7.1', command: 'ffmpeg' },
    providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' },
    tools: ['ffmpeg', 'ffprobe', 'skia-canvas'],
    unmappedTools: [],
    network: [],
    assets: { external: [], consumed: [] },
    fonts: [],
    captions: { insideFrame: true, cues: 1, wordLevel: false },
    ...overrides,
  };
}

function logWith(facts: Partial<RunLogFacts>): RunLog {
  const f = baseFacts(facts);
  return buildRunLog({
    project: null,
    specPath: join(PROJECT_ROOT, 'out', 'x.json'),
    specSha256: sha256Text('s'),
    briefPath: null,
    briefSha256: null,
    facts: f,
    measured: buildMeasured({
      renderMs: 1,
      msPerFrame: 1,
      encodeTailMs: 0,
      audioMixMs: null,
      outputBytes: 1,
      outputSha256: sha256Text('o'),
      outputPath: 'out/x.mp4',
    }),
  });
}

const codesOf = (result: ReturnType<typeof reconcile>): string[] => result.findings.map((f) => f.code);

test('对账通过：声明与实测无差集', () => {
  const result = reconcile(baseBrief, logWith({}));
  assert.equal(result.ok, true, JSON.stringify(result.findings));
  assert.equal(result.counts.fatal, 0);
});

test('实际调用了未声明的工具 → USED_UNDECLARED_TOOL（致命）', () => {
  const result = reconcile(baseBrief, logWith({ tools: ['ffmpeg', 'ffprobe', 'skia-canvas', 'edge-tts'] }));
  assert.equal(result.ok, false);
  assert.deepEqual(codesOf(result), ['USED_UNDECLARED_TOOL', 'ASSET_COVERAGE_PARTIAL']);
  assert.equal(result.findings[0]?.field, 'tools.allowed');
  assert.match(String(result.findings[0]?.message), /edge-tts/);
});

test('调用了明确禁止的工具 → USED_FORBIDDEN_TOOL（致命）', () => {
  const brief: ResolvedBrief = {
    ...baseBrief,
    tools: { allowed: ['skia-canvas', 'ffprobe'], forbidden: ['ffmpeg'] },
  };
  const result = reconcile(brief, logWith({}));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('USED_FORBIDDEN_TOOL'));
  assert.equal(result.findings[0]?.field, 'tools.forbidden');
});

test('声称纯代码但渲染器不是代码渲染器 → PURE_CODE_VIOLATED', () => {
  for (const renderer of [
    { kind: 'remotion', toolId: 'remotion', package: 'remotion', version: '4.0.0' },
    { kind: 'unknown', toolId: null, package: 'mystery', version: null },
  ]) {
    const result = reconcile(baseBrief, logWith({ renderer }));
    assert.equal(result.ok, false, `${renderer.kind} 应触发冲突`);
    assert.ok(codesOf(result).includes('PURE_CODE_VIOLATED'));
  }
});

test('声称零外部素材但实测核验了外部素材 → ZERO_ASSETS_VIOLATED', () => {
  const result = reconcile(
    baseBrief,
    logWith({
      assets: {
        external: [{ path: 'assets/logo.png', sha256: 'a'.repeat(64), kind: 'image', license: 'CC0' }],
        consumed: [],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('ZERO_ASSETS_VIOLATED'));
});

test('声称零外部素材但管线读取了素材文件 → ZERO_ASSETS_VIOLATED', () => {
  const result = reconcile(
    baseBrief,
    logWith({
      assets: { external: [], consumed: [{ path: 'x/bgm.wav', sha256: 'b'.repeat(64), role: 'bgm' }] },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('ZERO_ASSETS_VIOLATED'));
});

test('读取了未声明的素材 → USED_UNDECLARED_ASSET（致命）', () => {
  const brief: ResolvedBrief = {
    ...baseBrief,
    claims: { ...baseBrief.claims, zeroExternalAssets: false },
    assets: [{ path: 'assets/known.wav', kind: 'audio', license: 'CC0' }],
  };
  const result = reconcile(
    brief,
    logWith({
      assets: {
        external: [{ path: 'assets/known.wav', sha256: 'c'.repeat(64), kind: 'audio', license: 'CC0' }],
        consumed: [{ path: 'assets/secret.wav', sha256: 'd'.repeat(64), role: 'bgm' }],
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('USED_UNDECLARED_ASSET'));
});

test('partial 消费记录保留 DECLARED_ASSET_UNOBSERVED 警告', () => {
  const brief: ResolvedBrief = {
    ...baseBrief,
    claims: { ...baseBrief.claims, zeroExternalAssets: false },
    assets: [{ path: 'assets/known.wav', kind: 'audio', license: 'CC0' }],
  };
  const result = reconcile(
    brief,
    logWith({
      assets: {
        external: [{ path: 'assets/known.wav', sha256: 'c'.repeat(64), kind: 'audio', license: 'CC0' }],
        consumed: [],
      },
    }),
  );
  assert.equal(result.ok, true, '只警告不阻断');
  assert.deepEqual(codesOf(result), ['DECLARED_ASSET_UNOBSERVED']);
  assert.equal(result.findings[0]?.severity, 'WARNING');
});

test('素材授权未知 → ASSET_LICENSE_UNKNOWN（警告）', () => {
  const brief: ResolvedBrief = {
    ...baseBrief,
    claims: { ...baseBrief.claims, zeroExternalAssets: false },
    assets: [{ path: 'assets/known.wav', kind: 'audio', license: 'unknown' }],
  };
  const result = reconcile(
    brief,
    logWith({
      assets: {
        external: [{ path: 'assets/known.wav', sha256: 'c'.repeat(64), kind: 'audio', license: 'unknown' }],
        consumed: [{ path: 'assets/known.wav', sha256: 'c'.repeat(64), role: 'bgm' }],
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.ok(codesOf(result).includes('ASSET_LICENSE_UNKNOWN'));
});

test('观测到未登记工具 → TOOL_NOT_IN_REGISTRY（警告）', () => {
  const result = reconcile(baseBrief, logWith({ unmappedTools: ['renderer:canvas-dom'] }));
  assert.equal(result.ok, true);
  assert.deepEqual(codesOf(result), ['TOOL_NOT_IN_REGISTRY', 'ASSET_COVERAGE_PARTIAL']);
});

test('声明时长与实测不一致 → DELIVERABLE_DRIFT（致命）', () => {
  const result = reconcile(baseBrief, logWith({ video: { width: 1080, height: 1920, fps: 24, duration: 9, frames: 216, seed: 1 } }));
  assert.equal(result.ok, false);
  assert.ok(codesOf(result).includes('DELIVERABLE_DRIFT'));
});

// ---------------------------------------------------------------- 披露渲染

test('披露文件带三类证据等级，并包含"不应这样描述"', () => {
  const log = logWith({});
  const content = renderDisclosure({
    brief: baseBrief,
    briefPath: '/dev/null',
    log,
    project: { manifest: { title: '测试片' } } as unknown as Parameters<typeof renderDisclosure>[0]['project'],
    reconcile: reconcile(baseBrief, log),
    briefWarnings: [],
  });

  assert.ok(content.includes(EVIDENCE.measured));
  assert.ok(content.includes(EVIDENCE.declared));
  assert.ok(content.includes(EVIDENCE.inferred));
  assert.ok(content.includes('不应这样描述'));
  assert.ok(content.includes('可以这样描述'));
  assert.ok(content.includes('不要手改'));
  assert.ok(content.includes(log.runId), '披露里必须写 runId，便于第三方复算');
});

test('声音锁披露保留原来源，并据实报告声音复用和音轨数量', () => {
  const log = logWith({
    providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' },
    audioReuse: { lockPath: 'assets/derived/audio/id/audio-lock.json', lockSha256: 'a'.repeat(64), sourceProviders: { tts: 'edge', bgm: 'procedural', sfx: '(none)' } },
    assets: { external: [], consumed: [{ path: 'assets/audio/voice.wav', sha256: 'b'.repeat(64), role: 'audio-source' }] },
  });
  const spec = validateSpec(minimalSpec()).spec!;
  const content = renderDisclosure({ brief: baseBrief, briefPath: '/dev/null', log: { ...log, measured: { ...log.measured, audioArtifacts: [{ role: 'voice', path: 'assets/derived/audio/id/track-0.wav', sha256: 'c'.repeat(64) }] } },
    project: { manifest: { title: '测试片' }, slug: 'x' } as unknown as Parameters<typeof renderDisclosure>[0]['project'], spec, reconcile: reconcile(baseBrief, log), briefWarnings: [] });
  assert.match(content, /原制作来源为 TTS=edge/);
  assert.match(content, /复用声音锁（原来源 edge）：实测成功 1\/1 条/);
  assert.match(content, /声音沿用有哈希的定稿声音包/);
  assert.equal(content.includes('**零外部素材**'), false);
  assert.ok(reconcile(baseBrief, log).findings.some(finding => finding.code === 'ZERO_ASSETS_VIOLATED'));
});

test('披露里写出字幕与配音的对账：双语条数、词级时间戳、有无回退', () => {
  const project = { manifest: { title: '测试片' }, slug: 'x' } as unknown as Parameters<typeof renderDisclosure>[0]['project'];
  const rendered = (spec: ReturnType<typeof validateSpec>['spec'], audioArtifacts: number) => {
    const log = logWith({});
    const withVoices: RunLog = {
      ...log,
      measured: {
        ...log.measured,
        audioArtifacts: Array.from({ length: audioArtifacts }, (_, i) => ({
          role: 'voice' as const, path: `voice-${i}.wav`, sha256: `h${i}`,
        })),
      },
    };
    return renderDisclosure({
      brief: baseBrief, briefPath: '/dev/null', log: withVoices, project,
      reconcile: reconcile(baseBrief, withVoices), briefWarnings: [], spec,
    });
  };

  // 双语 + 全部旁白合成成功
  const bilingual = validateSpec(minimalSpec()).spec;
  assert.ok(bilingual);
  bilingual.audio.narration[0]!.translation = 'A test line.';
  const ok = rendered(bilingual, 1);
  assert.ok(ok.includes('1/1 条旁白带第二语言行'), `双语条数应可核对：${ok.match(/双语字幕[^\n]*/)?.[0]}`);
  assert.ok(ok.includes('第二行**不参与 TTS**'), '必须写明第二行不参与配音');
  assert.ok(ok.includes('实测成功 1/1 条，无回退'), '配音成功时也要明确写出"无回退"');

  // 旁白合成失败 → 必须直说
  const hasVoiceGap = validateSpec(minimalSpec()).spec;
  assert.ok(hasVoiceGap);
  const missing = rendered(hasVoiceGap, 0);
  assert.ok(missing.includes('实测成功 0/1 条，**存在回退/缺失**'), '回退必须显式标出');
  assert.ok(missing.includes('有 1 条旁白未能合成'), '必须说明成片里没有对应人声');
  assert.ok(!missing.includes('1/1 条旁白带第二语言行'), '没有译文时不应宣称双语');
});

test('披露里只有"实际调用"的工具出现在工具链表；允许但未使用的单独列出', () => {
  const brief: ResolvedBrief = { ...baseBrief, tools: { allowed: [...baseBrief.tools.allowed, 'manim'], forbidden: [] } };
  const log = logWith({});
  const project = {
    manifest: { title: '测试片' },
    slug: 'x',
  } as unknown as Parameters<typeof renderDisclosure>[0]['project'];

  const content = renderDisclosure({
    brief,
    briefPath: '/dev/null',
    log,
    project,
    reconcile: reconcile(brief, log),
    briefWarnings: [],
  });

  assert.ok(!content.includes('| `manim` |'), 'Manim 未被调用，不得出现在实际调用表里');
  assert.ok(content.includes('提示词允许但**本次未使用**的工具：`manim`'));
  assert.ok(content.includes('"允许"不等于"使用"'));
});

test('输入素材的来源工具进入使用清单，并与渲染调用分别披露', () => {
  const asset = { path: 'assets/voice.wav', kind: 'audio' as const, license: 'owned', sha256: 'a'.repeat(64), provenance: { tools: ['doubao-tts'] } };
  const brief: ResolvedBrief = { ...baseBrief, assets: [asset],
    tools: { ...baseBrief.tools, allowed: [...baseBrief.tools.allowed, 'doubao-tts'] },
    claims: { ...baseBrief.claims, zeroExternalAssets: false } };
  const log = logWith({ providers: { tts: 'file', bgm: '(none)', sfx: '(none)' }, assets: { external: [asset], consumed: [] } });
  const content = renderDisclosure({ brief, log, briefPath: '/dev/null',
    project: { manifest: { title: '输入素材回归' }, slug: 'fixture' } as Parameters<typeof renderDisclosure>[0]['project'],
    reconcile: reconcile(brief, log), briefWarnings: [] });
  assert.match(content, /\| `doubao-tts` \|.*用于生成输入素材.*【声明】/);
  assert.match(content, /配音输入素材由 `doubao-tts` 生成/);
  assert.doesNotMatch(content, /允许但.*doubao-tts|doubao-tts.*本次并未调用|配音由 file 生成/);
  assert.equal(log.facts.tools.includes('doubao-tts'), false);
  assert.equal(reconcile({ ...brief, tools: baseBrief.tools }, log).ok, false);
});

// ---------------------------------------------------------------- 集成

test('一致的项目：buildDisclosure 生成披露文件', () => {
  const fx = makeFixture({ name: 'ok' });
  try {
    const result = buildDisclosure(loadProject(fx.dir));
    assert.equal(result.reconcile.ok, true, JSON.stringify(result.reconcile.findings));
    assert.ok(result.content.includes('对账结果 | 通过'));
    assert.equal(result.path, join(fx.dir, 'DISCLOSURE.md'));
  } finally {
    fx.cleanup();
  }
});

test('run.json 缺失 → RUN_LOG_MISSING（而不是生成一份没有实测依据的披露）', () => {
  const fx = makeFixture({ name: 'no-runlog', withRunLog: false });
  try {
    assert.throws(
      () => buildDisclosure(loadProject(fx.dir)),
      (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.RUN_LOG_MISSING,
    );
  } finally {
    fx.cleanup();
  }
});

test('brief 在渲染后被改动 → 对账失败并指出需要重新渲染', () => {
  const fx = makeFixture({ name: 'stale-brief' });
  try {
    const briefPath = join(fx.dir, 'brief.json');
    const brief = JSON.parse(readFileSync(briefPath, 'utf8')) as Record<string, unknown>;
    brief['intent'] = '改过一句话，但没有重新渲染。';
    writeFileSync(briefPath, JSON.stringify(brief, null, 2));

    assert.throws(
      () => buildDisclosure(loadProject(fx.dir)),
      (err: unknown) =>
        err instanceof EngineError &&
        err.code === ERROR_CODES.BRIEF_CONFLICT &&
        /brief 已被修改/.test(String(err.details?.['reason'])),
    );
  } finally {
    fx.cleanup();
  }
});

test('spec 在渲染后被改动 → 对账失败并指出需要重新渲染', () => {
  const fx = makeFixture({ name: 'stale-spec' });
  try {
    fx.bumpSpec();
    assert.throws(
      () => buildDisclosure(loadProject(fx.dir)),
      (err: unknown) =>
        err instanceof EngineError &&
        err.code === ERROR_CODES.BRIEF_CONFLICT &&
        /spec 已被修改/.test(String(err.details?.['reason'])),
    );
  } finally {
    fx.cleanup();
  }
});

test('run.json 被手改（删掉一个用过的工具）→ 对账失败', () => {
  const fx = makeFixture({ name: 'tampered-runlog' });
  try {
    const logPath = join(fx.dir, 'run.json');
    const log = JSON.parse(readFileSync(logPath, 'utf8')) as RunLog;
    log.facts = { ...log.facts, tools: log.facts.tools.filter((t) => t !== 'edge-tts') };
    writeFileSync(logPath, JSON.stringify(log, null, 2));

    assert.throws(
      () => buildDisclosure(loadProject(fx.dir)),
      (err: unknown) =>
        err instanceof EngineError &&
        err.code === ERROR_CODES.BRIEF_CONFLICT &&
        /facts 段被修改过/.test(String(err.details?.['reason'])),
    );
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- 命令行

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src', 'cli', 'index.ts'), ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('CLI：一致时退出码 0 并写出 DISCLOSURE.md', () => {
  const fx = makeFixture({ name: 'cli-ok' });
  try {
    const rel = fx.dir.replace(PROJECT_ROOT + '/', '');
    const r = runCli(['disclosure', rel]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(fx.dir, 'DISCLOSURE.md')));
    assert.match(r.stdout, /声明与实测一致/);
  } finally {
    fx.cleanup();
  }
});

test('CLI：冲突时退出码 1、指出冲突字段、且不生成披露文件', () => {
  const fx = makeFixture({
    name: 'cli-conflict',
    brief: minimalBrief({
      tools: { allowed: ['skia-canvas', 'ffprobe'], forbidden: ['ffmpeg'] },
    }),
  });
  try {
    const rel = fx.dir.replace(PROJECT_ROOT + '/', '');
    const r = runCli(['disclosure', rel]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /USED_FORBIDDEN_TOOL/);
    assert.match(r.stderr + r.stdout, /tools\.forbidden/);
    assert.ok(!existsSync(join(fx.dir, 'DISCLOSURE.md')), '冲突时不得生成披露文件');
  } finally {
    fx.cleanup();
  }
});

test('CLI：--json 输出结构化对账结果', () => {
  const fx = makeFixture({ name: 'cli-json' });
  try {
    const rel = fx.dir.replace(PROJECT_ROOT + '/', '');
    const r = runCli(['disclosure', rel, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; runId: string; written: string };
    assert.equal(parsed.ok, true);
    assert.ok(parsed.runId.length > 0);
    assert.match(parsed.written, /DISCLOSURE\.md$/);
  } finally {
    fx.cleanup();
  }
});
