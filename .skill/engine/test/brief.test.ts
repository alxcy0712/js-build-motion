import { createFixtureProject } from './fixtures/project.ts';
/**
 * 提示词契约测试（task-4）。
 *
 * 三类检查各自的重点：
 *   - schema 级：字段名写错、枚举越界必须报错，而不是静默忽略
 *   - 工具级：提示词点名的工具，状态必须在渲染前就判定出来
 *   - 声称级：四项独立声称不得自相矛盾
 *
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import type { Issue } from '../src/spec/repair.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import type { ResolvedVideoSpec } from '../src/spec/types.ts';
import { checkBrief, loadBriefFile, validateBrief } from '../src/project/brief.ts';
import { archetypesDirExists } from '../src/project/archetypes.ts';
import { TOOL_REGISTRY, knownToolIds } from '../src/project/tool-registry.ts';

const M0 = createFixtureProject();
after(M0.cleanup);
const M0_SPEC: ResolvedVideoSpec | null = validateSpec(loadSpecFile(M0.specPath)).spec;
const M0_BRIEF_PATH = join(M0.dir, 'brief.json');

function briefOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.1',
    archetype: 'code-animation-no-assets',
    intent: '制作一支 8 秒的测试短片，用于校验 brief 规则。',
    deliverable: { duration: 8, aspect: '9:16' },
    tools: { allowed: ['skia-canvas', 'ffmpeg'] },
    claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: true, humanRevision: false },
    ...overrides,
  };
}

const find = (issues: readonly Issue[], code: string): Issue | undefined =>
  issues.find((i) => i.code === code);

// ------------------------------------------------------------ 正例

test('临时夹具 的 brief.json 通过校验', () => {
  const { brief, warnings } = validateBrief(loadBriefFile(M0_BRIEF_PATH), {
    spec: M0_SPEC,
    projectDir: M0.dir,
  });
  assert.equal(brief.archetype, 'code-animation-no-assets');
  assert.equal(brief.deliverable.duration, 8);
  assert.equal(brief.claims.pureCode, true);
  // edge-tts 是网络服务且输出不逐字节可复现；这条告警是"确定性"表述的护栏
  assert.ok(
    warnings.some((w) => w.code === 'NONDETERMINISTIC_TOOL'),
    `应提示非确定性工具，实际: ${warnings.map((w) => w.code).join(', ')}`,
  );
  // humanRounds 为 null 时必须提示"不得声称 one prompt"
  assert.ok(warnings.some((w) => w.code === 'HUMAN_ROUNDS_UNRECORDED'));
});

test('原型库存在时 临时夹具 的 archetype 必须真实存在于库中', () => {
  if (!archetypesDirExists()) return;
  const result = checkBrief(loadBriefFile(M0_BRIEF_PATH), { spec: M0_SPEC, projectDir: M0.dir });
  assert.equal(find(result.issues, 'ARCHETYPE_UNKNOWN'), undefined);
});

// ------------------------------------------------------------ schema 级

test('缺必填字段 → BRIEF_INVALID，问题里指出字段', () => {
  const raw = briefOf();
  delete raw['claims'];
  const result = checkBrief(raw);
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'BRIEF_SCHEMA');
  assert.ok(issue, '应报 BRIEF_SCHEMA');
  assert.match(issue.message, /claims/);
  assert.throws(
    () => validateBrief(raw),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.BRIEF_INVALID,
  );
});

test('未知字段被拒绝，而不是静默忽略', () => {
  const result = checkBrief(briefOf({ prompt: '把提示词原文塞进自由字段' }));
  assert.equal(result.ok, false);
  assert.match(String(find(result.issues, 'BRIEF_SCHEMA')?.message), /prompt/);
});

test('枚举越界 → 错误里带 allowed 列表与 hint', () => {
  const result = checkBrief(briefOf({ deliverable: { duration: 8, aspect: '3:4' } }));
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'BRIEF_SCHEMA');
  assert.ok(issue?.allowed?.includes('9:16'), `allowed 应含合法画幅，实际 ${JSON.stringify(issue?.allowed)}`);
  assert.ok(issue.hint);
  assert.ok(issue.path.startsWith('deliverable'));
});

// ------------------------------------------------------------ 工具级

test('未登记的工具 id → TOOL_UNKNOWN，并给出可用 id', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['skia-canvas', 'my-homegrown-renderer'] } }));
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'TOOL_UNKNOWN');
  assert.ok(issue, '应报 TOOL_UNKNOWN');
  assert.equal(issue.path, 'tools.allowed[1]');
  assert.ok(issue.allowed?.includes('skia-canvas'));
  assert.throws(
    () => validateBrief(briefOf({ tools: { allowed: ['skia-canvas', 'my-homegrown-renderer'] } })),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.BRIEF_INVALID,
  );
});

test('已否决的工具写进 allowed → TOOL_REJECTED（渲染前就拦住）', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['skia-canvas', 'playwright'] } }));
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'TOOL_REJECTED');
  assert.ok(issue);
  assert.match(issue.message, /Playwright/);
});

test('未登记的外部视觉模型写进 allowed → TOOL_UNREGISTERED', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['skia-canvas', 'seedance'] } }));
  assert.equal(result.ok, false);
  assert.ok(find(result.issues, 'TOOL_UNREGISTERED'));
});

test('allowed 与 forbidden 有交集 → BRIEF_CONFLICT + TOOL_CONFLICT', () => {
  const raw = briefOf({ tools: { allowed: ['skia-canvas', 'ffmpeg'], forbidden: ['ffmpeg'] } });
  const result = checkBrief(raw);
  assert.equal(result.ok, false);
  assert.equal(find(result.issues, 'TOOL_CONFLICT')?.path, 'tools');
  assert.throws(
    () => validateBrief(raw),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.BRIEF_CONFLICT,
  );
});

test('允许项里含备选工具 → 只警告，不失败（声明可以说，但要说明这次没用）', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['skia-canvas', 'manim'] } }));
  assert.equal(result.ok, true);
  const w = find(result.issues, 'TOOL_NOT_IMPLEMENTED');
  assert.ok(w, '应警告 Manim 尚未实现');
  assert.equal(w.severity, 'WARNING');
});

// ------------------------------------------------------------ 声称级

test('生图素材与代码渲染可组合，并保留素材来源', () => {
  const result = checkBrief(briefOf({
    tools: { allowed: ['skia-canvas', 'imagegen', 'ffmpeg'] },
    assets: [{ path: 'assets/generated/board.png', kind: 'image', license: 'generated test fixture', source: 'imagegen; generation record: evidence/assets.json' }],
    claims: { humanRounds: 1, pureCode: false, zeroExternalAssets: false, humanRevision: false },
  }));
  assert.equal(result.ok, true);
  assert.equal(find(result.issues, 'TOOL_NOT_IMPLEMENTED'), undefined);
  assert.equal(result.brief?.assets[0]?.source, 'imagegen; generation record: evidence/assets.json');
  assert.equal(TOOL_REGISTRY.find(tool => tool.id === 'imagegen')?.execution, 'agent');
});

test('生图参与制作时纯代码声明触发冲突', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['skia-canvas', 'imagegen'] } }));
  assert.equal(result.ok, false);
  assert.equal(find(result.issues, 'CLAIM_CONFLICT')?.path, 'claims.pureCode');
});

test('声称纯代码却允许外部视觉模型 → CLAIM_CONFLICT', () => {
  const raw = briefOf({ tools: { allowed: ['skia-canvas', 'midjourney'] } });
  const result = checkBrief(raw);
  assert.ok(find(result.issues, 'CLAIM_CONFLICT'));
  assert.throws(
    () => validateBrief(raw),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.BRIEF_CONFLICT,
  );
});

test('声称纯代码却没有任何渲染器 → CLAIM_CONFLICT', () => {
  const result = checkBrief(briefOf({ tools: { allowed: ['ffmpeg', 'ffprobe'] } }));
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'CLAIM_CONFLICT');
  assert.equal(issue?.path, 'claims.pureCode');
  assert.ok(issue?.allowed?.includes('skia-canvas'));
});

test('声称零外部素材却有 assets → CLAIM_CONFLICT', () => {
  const result = checkBrief(
    briefOf({
      assets: [{ path: 'assets/logo.png', kind: 'image', license: 'CC0' }],
    }),
  );
  assert.equal(result.ok, false);
  assert.match(String(find(result.issues, 'CLAIM_CONFLICT')?.message), /assets/);
});

test('声称零外部素材却有参考片/资料 → CLAIM_CONFLICT（参考片也是外部输入）', () => {
  for (const key of ['referenceClips', 'documents', 'brandAssets', 'audio']) {
    const result = checkBrief(briefOf({ inputs: { [key]: [{ note: '一份外部输入' }] } }));
    assert.equal(result.ok, false, `${key} 应触发冲突`);
    assert.ok(find(result.issues, 'CLAIM_CONFLICT'), `${key} 应报 CLAIM_CONFLICT`);
  }
});

test('有外部素材时 zeroExternalAssets=false 可通过', () => {
  const result = checkBrief(
    briefOf({
      inputs: { referenceClips: [{ note: '授权参考片', license: '已获授权' }] },
      claims: {
        humanRounds: 2,
        pureCode: true,
        zeroExternalAssets: false,
        humanRevision: true,
      },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

// ------------------------------------------------------------ deliverable 对 spec

test('声明时长与 spec 不一致 → DELIVERABLE_MISMATCH', () => {
  const result = checkBrief(briefOf({ deliverable: { duration: 6, aspect: '9:16' } }), { spec: M0_SPEC });
  assert.equal(result.ok, false);
  const issue = find(result.issues, 'DELIVERABLE_MISMATCH');
  assert.equal(issue?.path, 'deliverable.duration');
});

test('声明画幅与 spec 不一致 → DELIVERABLE_MISMATCH', () => {
  const result = checkBrief(briefOf({ deliverable: { duration: 8, aspect: '16:9' } }), { spec: M0_SPEC });
  const issue = find(result.issues, 'DELIVERABLE_MISMATCH');
  assert.equal(issue?.path, 'deliverable.aspect');
  assert.match(String(issue?.message), /1080×1920/);
});

test('声明帧率与 spec 不一致 → DELIVERABLE_MISMATCH；省略则不检查', () => {
  const bad = checkBrief(briefOf({ deliverable: { duration: 8, aspect: '9:16', fps: 30 } }), { spec: M0_SPEC });
  assert.equal(find(bad.issues, 'DELIVERABLE_MISMATCH')?.path, 'deliverable.fps');
  const ok = checkBrief(briefOf({ deliverable: { duration: 8, aspect: '9:16' } }), { spec: M0_SPEC });
  assert.equal(find(ok.issues, 'DELIVERABLE_MISMATCH'), undefined);
});

// ------------------------------------------------------------ assets

test('声明的素材文件不存在 → ASSET_MISSING', () => {
  const result = checkBrief(
    briefOf({
      assets: [{ path: 'assets/nope.png', kind: 'image', license: 'CC0' }],
      claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: false, humanRevision: false },
    }),
    { projectDir: M0.dir },
  );
  assert.equal(result.ok, false);
  assert.equal(find(result.issues, 'ASSET_MISSING')?.path, 'assets[assets/nope.png]');
});

test('素材 hash 不符 → ASSET_HASH_MISMATCH', () => {
  const result = checkBrief(
    briefOf({
      assets: [
        {
          path: 'spec/main.json',
          kind: 'document',
          license: 'internal',
          sha256: '0'.repeat(64),
        },
      ],
      claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: false, humanRevision: false },
    }),
    { projectDir: M0.dir },
  );
  assert.equal(result.ok, false);
  assert.ok(find(result.issues, 'ASSET_HASH_MISMATCH'));
});

test('素材路径逃出项目目录 → ASSET_OUTSIDE_PROJECT', () => {
  const result = checkBrief(
    briefOf({
      assets: [{ path: '../../etc/passwd', kind: 'document', license: 'unknown' }],
      claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: false, humanRevision: false },
    }),
    { projectDir: M0.dir },
  );
  assert.equal(result.ok, false);
  assert.ok(find(result.issues, 'ASSET_OUTSIDE_PROJECT'));
});

test('授权未知 → 只警告，并在披露里单独标出', () => {
  const result = checkBrief(
    briefOf({
      assets: [{ path: 'spec/main.json', kind: 'document', license: 'unknown' }],
      claims: { humanRounds: 1, pureCode: true, zeroExternalAssets: false, humanRevision: false },
    }),
    { projectDir: M0.dir },
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues.filter((i) => i.severity === 'FATAL')));
  assert.equal(find(result.issues, 'LICENSE_UNKNOWN')?.severity, 'WARNING');
});

// ------------------------------------------------------------ archetype

test('archetype 不在原型库里 → 原型库存在时是致命问题', () => {
  const result = checkBrief(briefOf({ archetype: 'not-a-real-archetype' }));
  if (archetypesDirExists()) {
    assert.equal(result.ok, false);
    assert.ok(find(result.issues, 'ARCHETYPE_UNKNOWN')?.allowed?.length);
  } else {
    assert.equal(result.ok, true, '原型库尚未建立时应降级为警告');
    assert.ok(find(result.issues, 'ARCHETYPE_UNCHECKED'));
  }
});

test('knownToolIds 与注册表一一对应且无重复', () => {
  const ids = knownToolIds();
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
  assert.deepEqual(ids.slice().sort(), TOOL_REGISTRY.map((t) => t.id).slice().sort());
});
