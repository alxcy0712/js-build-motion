import { createFixtureProject } from './fixtures/project.ts';
/**
 * VideoSpec 校验与自动修复测试（Phase D）。
 *
 * 重点不在 happy path，而在**脏输入**：
 * 弱模型真实的输出形态是「大部分对、个别字段写错、偶尔漏字段」，
 * 修复层必须能把这类输入变成可渲染的 spec，并且不能悄悄改变剧情语义。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { Ajv } from 'ajv';

import { SeededRandom } from '../src/animation/random.ts';
import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import type { Issue } from '../src/spec/repair.ts';
import { SPEC_VOCABULARY } from '../src/spec/repair.ts';
import { VIDEO_SPEC_SCHEMA } from '../src/spec/schema.ts';
import { loadSpecFile, summarizeIssues, validateSpec } from '../src/spec/validate.ts';
import { CAMERAS, SPEC_DEFAULTS } from '../src/spec/types.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaValidate = ajv.compile(VIDEO_SPEC_SCHEMA);

const fixture = createFixtureProject();
after(fixture.cleanup);
const EXAMPLE = fixture.specPath;

/** 最小的可渲染 spec，用于在测试里做局部改动 */
function baseSpec(): Record<string, unknown> {
  return {
    version: '0.1',
    video: { width: 1080, height: 1920, fps: 24, duration: 8, seed: 1 },
    style: { preset: 'watercolor_storybook', palette: 'warm_night', paper: 'rough', line: 'soft_ink' },
    characters: [{ id: 'girl', preset: 'female_young', hair: 'long_dark', clothing: 'beige_coat' }],
    scenes: [
      {
        id: 's1',
        start: 0,
        end: 8,
        environment: 'rain_window',
        camera: 'medium_close',
        character: 'girl',
        action: 'look_outside',
        emotion: 'nostalgic',
      },
    ],
    audio: { narration: [{ start: 1, voice: 'female_calm', text: '窗外的一场雨。' }] },
    captions: { enabled: true, style: 'handwritten', mode: 'sentence' },
  };
}

const findIssue = (issues: readonly Issue[], code: string): Issue | undefined =>
  issues.find((i) => i.code === code);

test('字幕版面字段保留并校验，缺省规格保持原有字段', () => {
  const raw = baseSpec();
  const layout = { fontScale: 40 / 1080, translationScale: 0.625, maxWidth: 0.78, bottomInset: 0.11 };
  raw.captions = { ...(raw.captions as object), ...layout };
  const result = validateSpec(raw);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.spec?.captions, raw.captions);
  assert.deepEqual(validateSpec(baseSpec()).spec?.captions, { enabled: true, style: 'handwritten', mode: 'sentence' });
  raw.captions = { ...(raw.captions as object), fontScale: 2, translationScale: 'large', maxWidth: 0.1, bottomInset: -1 };
  const repaired = validateSpec(raw);
  assert.equal(repaired.spec?.captions.fontScale, 0.1);
  assert.equal(repaired.spec?.captions.translationScale, 0.62);
  assert.equal(repaired.spec?.captions.maxWidth, 0.4);
  assert.equal(repaired.spec?.captions.bottomInset, 0);
  assert.equal(repaired.issues.length, 4);
  assert.equal(schemaValidate(repaired.spec), true);
});
test('旁白语速百分比保留并修复，省略时保持旧规格', () => {
  const raw = baseSpec();
  const narration = (raw.audio as { narration: Array<Record<string, unknown>> }).narration;
  narration[0]!.rate = -12;
  const valid = validateSpec(raw);
  assert.deepEqual(valid.issues, []);
  assert.equal(valid.spec?.audio.narration[0]?.rate, -12);
  for (const [rate, expected] of [[-100, -50], [150, 100], ['fast', 8], [2.6, 3]] as const) {
    narration[0]!.rate = rate;
    const repaired = validateSpec(raw);
    assert.equal(repaired.spec?.audio.narration[0]?.rate, expected);
    assert.equal(schemaValidate(repaired.spec), true);
  }
  assert.equal(validateSpec(baseSpec()).spec?.audio.narration[0]?.rate, undefined);
});

// ------------------------------------------------------------ happy path

test('projects/临时夹具/spec/main.json 通过校验且零问题', () => {
  const outcome = validateSpec(loadSpecFile(EXAMPLE));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.schemaErrors, []);
  assert.deepEqual(
    outcome.issues,
    [],
    `示例 spec 不应产生任何问题，实际: ${outcome.issues.map((i) => `${i.severity} ${i.code}`).join(', ')}`,
  );
  assert.equal(outcome.spec?.video.width, 1080);
  assert.equal(outcome.spec?.video.height, 1920);
  assert.equal(outcome.spec?.scenes.length, 1);
});

test('示例 spec 的枚举取值全部来自封闭词汇表', () => {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);
  const s = spec.scenes[0];
  assert.ok(s);
  assert.ok((CAMERAS as readonly string[]).includes(s.camera));
  assert.ok((SPEC_VOCABULARY.environment as readonly string[]).includes(s.environment));
  assert.ok((SPEC_VOCABULARY.action as readonly string[]).includes(s.action));
  assert.ok((SPEC_VOCABULARY.emotion as readonly string[]).includes(s.emotion));
});

// ------------------------------------------------------- SAFE_REPAIR 类

test('非法 camera → SAFE_REPAIR 回退 medium 并附允许值', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['camera'] = 'aaa';
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes[0]?.camera, 'medium');
  const issue = findIssue(issues, 'INVALID_ENUM');
  assert.ok(issue, '应记录 INVALID_ENUM');
  assert.equal(issue.severity, 'SAFE_REPAIR');
  assert.equal(issue.path, 'scenes[0].camera');
  assert.deepEqual(issue.allowed, [...CAMERAS], '必须列出允许值，否则弱模型无从修起');
  assert.equal(issue.from, 'aaa');
  assert.equal(issue.to, 'medium');
});

test('volume 越界 → 钳制到 [0,1]', () => {
  const raw = baseSpec();
  (raw['audio'] as Record<string, unknown>)['bgm'] = { volume: 4, fadeIn: -3 };
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.audio.bgm.volume, 1);
  assert.equal(spec?.audio.bgm.fadeIn, 0);
  const clamped = issues.filter((i) => i.code === 'VALUE_CLAMPED');
  assert.equal(clamped.length, 2);
  assert.ok(clamped.every((i) => i.severity === 'SAFE_REPAIR'));
});

test('scene.end < start → SAFE_REPAIR 交换（保留原时长）', () => {
  const raw = baseSpec();
  const scene = (raw['scenes'] as Record<string, unknown>[])[0]!;
  scene['start'] = 6;
  scene['end'] = 2;
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes[0]?.start, 2);
  assert.equal(spec?.scenes[0]?.end, 6);
  assert.equal(spec?.scenes[0]?.end! - spec.scenes[0]!.start, 4, '交换应保留原意图时长');
  const issue = findIssue(issues, 'SCENE_REVERSED');
  assert.equal(issue?.severity, 'SAFE_REPAIR');
});

test('缺 style → 用默认值补齐，且不记为问题（缺省是合法输入）', () => {
  const raw = baseSpec();
  delete raw['style'];
  const { spec, issues } = validateSpec(raw);
  assert.deepEqual(spec?.style, SPEC_DEFAULTS.style);
  assert.ok(
    !issues.some((i) => i.path.startsWith('style')),
    `缺 style 不应报问题，实际: ${issues.map((i) => i.code).join(', ')}`,
  );
});

test('未知字段 → SAFE_REPAIR 剥离并列出允许字段', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['skiaMethod'] = 'drawPath';
  raw['unknownTop'] = 1;
  const { spec, issues } = validateSpec(raw);
  assert.ok(!('unknownTop' in (spec as unknown as Record<string, unknown>)));
  assert.ok(!('skiaMethod' in (spec?.scenes[0] as unknown as Record<string, unknown>)));
  const stripped = issues.filter((i) => i.code === 'UNKNOWN_FIELD');
  assert.equal(stripped.length, 2);
  assert.ok(stripped.every((i) => i.severity === 'SAFE_REPAIR'));
  assert.ok(stripped.some((i) => i.hint?.includes('skiaMethod') === false));
});

test('奇数尺寸 → 自动调整为偶数（yuv420p 要求）', () => {
  const raw = baseSpec();
  (raw['video'] as Record<string, unknown>)['width'] = 1081;
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.video.width % 2, 0);
  const issue = findIssue(issues, 'ODD_DIMENSION');
  assert.equal(issue?.severity, 'SAFE_REPAIR');
  assert.equal(issue?.from, 1081);
  assert.equal(issue?.to, 1082);
});

test('不支持的 fps → SAFE_REPAIR 回退 24 并列出支持值', () => {
  const raw = baseSpec();
  (raw['video'] as Record<string, unknown>)['fps'] = 23;
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.video.fps, 24);
  const issue = findIssue(issues, 'UNSUPPORTED_FPS');
  assert.equal(issue?.severity, 'SAFE_REPAIR');
  assert.deepEqual(issue?.allowed, SPEC_VOCABULARY.fps.map(String));
});

test('数字字段写成字符串 → SAFE_REPAIR 回退默认值', () => {
  const raw = baseSpec();
  (raw['video'] as Record<string, unknown>)['duration'] = '八秒';
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.video.duration, SPEC_DEFAULTS.video.duration);
  assert.equal(findIssue(issues, 'NOT_A_NUMBER')?.severity, 'SAFE_REPAIR');
});

// ------------------------------------------------ 语义相关：只警告不偷改

test('引用不存在的人物 → WARNING 且不擅自换人', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['character'] = 'nobody';
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes[0]?.character, undefined, '不能凭空安排另一个角色出场');
  const issue = findIssue(issues, 'UNKNOWN_CHARACTER');
  assert.equal(issue?.severity, 'WARNING', '这是语义变化，必须是 WARNING 而不是静默修复');
  assert.deepEqual(issue?.allowed, ['girl'], '应告知可用的人物 id');
});

test('人物 id 重复 → WARNING 并保留先出现的定义', () => {
  const raw = baseSpec();
  (raw['characters'] as Record<string, unknown>[]).push({
    id: 'girl',
    preset: 'male_average',
    hair: 'short_dark',
    clothing: 'dark_coat',
  });
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.characters.length, 1);
  assert.equal(spec?.characters[0]?.preset, 'female_young');
  assert.equal(findIssue(issues, 'DUPLICATE_CHARACTER_ID')?.severity, 'WARNING');
});

test('场景时间重叠 → WARNING 并说明渲染语义', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[]).push({
    id: 's2',
    start: 4,
    end: 8,
    environment: 'bedroom',
  });
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes.length, 2);
  const issue = findIssue(issues, 'SCENES_OVERLAP');
  assert.equal(issue?.severity, 'WARNING');
  assert.match(issue?.message ?? '', /后开始的场景优先/);
});

test('时间轴有裂缝 → WARNING 指出具体时长', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['end'] = 5; // 视频 8s，剩 3s 无场景
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes[0]?.end, 5);
  const gap = issues.find((i) => i.code === 'TIMELINE_GAP');
  assert.equal(gap?.severity, 'WARNING');
  assert.match(gap?.message ?? '', /3\.00s/);
});

test('空旁白 → WARNING 并丢弃该条', () => {
  const raw = baseSpec();
  (raw['audio'] as Record<string, unknown>)['narration'] = [{ start: 0, voice: 'female_calm', text: '   ' }];
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.audio.narration.length, 0);
  assert.equal(findIssue(issues, 'EMPTY_NARRATION')?.severity, 'WARNING');
});

test('超长旁白 → WARNING（换行由字幕引擎负责，不是校验层的事）', () => {
  const raw = baseSpec();
  (raw['audio'] as Record<string, unknown>)['narration'] = [
    { start: 0, voice: 'female_calm', text: '雨'.repeat(200) },
  ];
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.audio.narration.length, 1, '超长不应丢弃内容');
  assert.equal(spec?.audio.narration[0]?.text.length, 200);
  const issue = findIssue(issues, 'NARRATION_TOO_LONG');
  assert.equal(issue?.severity, 'WARNING');
  assert.match(issue?.hint ?? '', /拆分/);
});

test('场景起点超出视频时长 → WARNING 并丢弃该场景', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[]).push({
    id: 's3',
    start: 99,
    end: 100,
    environment: 'forest',
  });
  const { spec, issues } = validateSpec(raw);
  assert.equal(spec?.scenes.length, 1);
  assert.equal(findIssue(issues, 'SCENE_OUT_OF_RANGE')?.severity, 'WARNING');
});

// ---------------------------------------------------------------- FATAL

test('没有场景 → FATAL，抛 SPEC_INVALID', () => {
  const raw = baseSpec();
  raw['scenes'] = [];
  assert.throws(
    () => validateSpec(raw),
    (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal(err.code, ERROR_CODES.SPEC_INVALID);
      assert.match(err.toLLMString(), /NO_SCENES|没有任何场景/);
      return true;
    },
  );
});

test('全部场景都越界 → FATAL', () => {
  const raw = baseSpec();
  raw['scenes'] = [{ id: 's1', start: 100, end: 200, environment: 'forest' }];
  assert.throws(() => validateSpec(raw), /没有可渲染的场景|所有场景/);
});

test('输入不是对象 → FATAL', () => {
  assert.throws(() => validateSpec('not a spec'), EngineError);
  assert.throws(() => validateSpec(null), EngineError);
  assert.throws(() => validateSpec([1, 2, 3]), EngineError);
});

test('文件不存在 / 非法 JSON → SPEC_UNREADABLE', () => {
  assert.throws(
    () => loadSpecFile(join(PROJECT_ROOT, 'examples', 'does-not-exist.json')),
    (err: unknown) => err instanceof EngineError && err.code === ERROR_CODES.SPEC_UNREADABLE,
  );
});

// ----------------------------------------------------- 修复必须收敛

test('修复结果必然通过 schema 校验（逐条复核脏输入）', () => {
  const dirty: Record<string, unknown>[] = [];

  const d1 = baseSpec();
  (d1['scenes'] as Record<string, unknown>[])[0]!['camera'] = 'aaa';
  dirty.push(d1);

  const d2 = baseSpec();
  (d2['video'] as Record<string, unknown>)['width'] = 1081;
  dirty.push(d2);

  const d3 = baseSpec();
  delete d3['style'];
  dirty.push(d3);

  const d4 = baseSpec();
  (d4['audio'] as Record<string, unknown>)['bgm'] = { volume: 99, fadeIn: -1 };
  dirty.push(d4);

  const d5 = baseSpec();
  (d5['scenes'] as Record<string, unknown>[])[0]!['extra'] = true;
  dirty.push(d5);

  const d6 = baseSpec();
  (d6['video'] as Record<string, unknown>)['fps'] = 999;
  dirty.push(d6);

  for (const [i, raw] of dirty.entries()) {
    const { spec } = validateSpec(raw);
    assert.ok(spec, `第 ${i} 条应产出 spec`);
    const valid = schemaValidate(spec);
    assert.ok(
      valid,
      `第 ${i} 条的修复结果通过了 schema 校验失败: ${ajv.errorsText(schemaValidate.errors)}`,
    );
  }
});

test('确定性模糊测试：任意变异要么明确 FATAL，要么修复为 schema 合法且可渲染', () => {
  const rng = new SeededRandom(20260926);
  const enumFields: ReadonlyArray<readonly [string, string, string]> = [
    ['style', 'preset', 'STYLE'],
    ['style', 'palette', 'PALETTE'],
    ['style', 'paper', 'PAPER'],
    ['style', 'line', 'LINE'],
  ];
  let fatal = 0;
  let repaired = 0;
  let clean = 0;

  for (let iter = 0; iter < 300; iter++) {
    const raw = structuredClone(baseSpec());
    const mutations = rng.int(1, 4);

    for (let m = 0; m < mutations; m++) {
      const pick = rng.int(0, 7);
      const scenes = raw['scenes'] as Record<string, unknown>[];
      const scene = scenes[0]!;
      const video = raw['video'] as Record<string, unknown>;

      switch (pick) {
        case 0: scene['camera'] = rng.pick(['aaa', 'zoom', '', 42, null, {}]); break;
        case 1: video['fps'] = rng.pick([23, 0, -1, 'fast', 144]); break;
        case 2: video['width'] = rng.pick([1081, -5, 0, 'wide', 1e9]); break;
        case 3: scene[rng.pick(['start', 'end'])] = rng.pick([-3, 'now', null, 9999]); break;
        case 4: raw['style'] = rng.pick([null, 'watercolor', [], 7]); break;
        case 5: {
          const [section, key] = rng.pick(enumFields);
          const sec = raw[section];
          if (sec && typeof sec === 'object' && !Array.isArray(sec)) {
            (sec as Record<string, unknown>)[key] = rng.pick(['nope', 3, null, '']);
          }
          break;
        }
        case 6: scene['character'] = rng.pick(['ghost', '', 5, 'girl']); break;
        default:
          (raw as Record<string, unknown>)[rng.pick(['bogus', 'spec', 'skiaMethod'])] = rng.pick([1, 'x', null]);
          break;
      }
    }

    let outcome;
    try {
      outcome = validateSpec(raw);
    } catch (err) {
      assert.ok(err instanceof EngineError, `变异后应抛 EngineError，实际 ${String(err)}`);
      assert.equal(err.code, ERROR_CODES.SPEC_INVALID, `第 ${iter} 次变异的错误码应为 SPEC_INVALID`);
      fatal++;
      continue;
    }

    assert.ok(outcome.spec, `第 ${iter} 次变异应产出 spec`);
    assert.ok(
      schemaValidate(outcome.spec),
      `第 ${iter} 次变异修复后仍不合法: ${ajv.errorsText(schemaValidate.errors)}\n输入: ${JSON.stringify(raw)}`,
    );
    // 可渲染性的最低要求
    assert.ok(outcome.spec.scenes.length > 0, '修复后应至少有一个场景');
    assert.ok(outcome.spec.video.duration > 0);
    assert.ok(outcome.spec.video.width > 0 && outcome.spec.video.height > 0);
    assert.equal(outcome.spec.video.width % 2, 0);
    assert.equal(outcome.spec.video.height % 2, 0);
    if (outcome.issues.length === 0) clean++;
    else repaired++;
  }

  // 三条路径都必须被覆盖到，否则这个模糊测试没测到东西
  assert.ok(repaired > 0, '应有被修复后仍可渲染的用例');
  assert.ok(fatal > 0, '应有明确判为 FATAL 的用例');
  assert.equal(repaired + fatal + clean, 300);
});

// ----------------------------------------------------------- 确定性与输出

test('同一输入重复校验结果完全一致（确定性）', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['camera'] = 'zzz';
  const a = validateSpec(structuredClone(raw));
  const b = validateSpec(structuredClone(raw));
  assert.deepEqual(a.issues, b.issues);
  assert.deepEqual(JSON.parse(JSON.stringify(a.spec)), JSON.parse(JSON.stringify(b.spec)));
});

test('summarizeIssues 给出人类可读摘要', () => {
  assert.equal(summarizeIssues([]), '无问题');
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['character'] = 'nobody';
  (raw['video'] as Record<string, unknown>)['fps'] = 23;
  const s = summarizeIssues(validateSpec(raw).issues);
  assert.match(s, /自动修复/);
  assert.match(s, /警告/);
});

test('修复是幂等的：对已修复的 spec 再跑一次不应产生新问题', () => {
  const raw = baseSpec();
  (raw['scenes'] as Record<string, unknown>[])[0]!['camera'] = 'aaa';
  (raw['video'] as Record<string, unknown>)['fps'] = 23;
  const first = validateSpec(raw);
  assert.ok(first.spec);
  const second = validateSpec(JSON.parse(JSON.stringify(first.spec)));
  assert.deepEqual(second.issues, [], `二次校验应无问题，实际: ${second.issues.map((i) => i.code).join(', ')}`);
});

test('临时夹具 的 spec 在磁盘上存在且是合法 JSON', () => {
  const text = readFileSync(EXAMPLE, 'utf8');
  assert.doesNotThrow(() => JSON.parse(text));
});
