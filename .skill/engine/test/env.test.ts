/**
 * 环境自检的单元测试。
 *
 * 这些测试刻意去验证「失败路径」——一个只有 happy path 的环境检查器
 * 无法证明它真的会在环境缺失时拦住渲染。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, ERROR_CODES } from '../src/utils/errors.ts';
import { checkEnvironment, registerProjectFonts, PROJECT_FONT_FAMILY } from '../src/utils/env.ts';

/** 临时把 PATH 换成不含 ffmpeg 的值，跑完恢复 */
function withoutFfmpeg<T>(fn: () => T): T {
  const saved = process.env['PATH'];
  process.env['PATH'] = '/nonexistent-bin';
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
  }
}

test('当前环境下 checkEnvironment 通过且无 warning', () => {
  // checkTts: false —— 语音链路探测依赖本机 python/edge_tts，
  // 把它排除在"无警告"断言之外，否则这个测试会在另一台机器上假红。
  const r = checkEnvironment({ checkTts: false });
  assert.equal(r.ok, true, `不应有错误: ${r.errors.join('; ')}`);
  assert.deepEqual(r.warnings, [], `不应有警告: ${r.warnings.join('; ')}`);
  assert.equal(r.node.supported, true);
  assert.equal(r.ffmpeg.available, true);
  assert.equal(r.ffprobe.available, true);
  assert.equal(r.ffmpeg.encoders['libx264'], true);
  assert.equal(r.paths.outWritable, true);
});

test('语音链路：报告实际会用的 provider，并在降级时给出修复建议', () => {
  const skipped = checkEnvironment({ checkTts: false });
  assert.equal(skipped.tts.effective, 'mock', '跳过探测时不能声称 edge 可用');
  assert.equal(skipped.tts.edge.reason, '已跳过检查');

  const probed = checkEnvironment();
  assert.ok(['edge', 'file', 'mock'].includes(probed.tts.effective));
  assert.equal(typeof probed.tts.voiceAsset.exists, 'boolean');
  // 不论本机是否装了 edge-tts，都必须能说出「为什么」与「怎么修」
  if (probed.tts.effective === 'edge') {
    assert.equal(probed.tts.edge.available, true);
    assert.ok(probed.tts.edge.python, '可用时必须报告实际使用的解释器');
  } else {
    assert.ok(probed.tts.edge.reason, '不可用时必须给出原因');
    assert.ok(
      probed.warnings.some((w) => w.includes('语音链路降级')),
      `降级必须产生警告: ${probed.warnings.join('; ')}`,
    );
    assert.match(probed.tts.fixHint, /edge-tts|voice\.wav/, '修复建议要可执行');
  }
});

test('缺少 ffmpeg 时严格模式抛 FFMPEG_NOT_FOUND', () => {
  assert.throws(
    () => withoutFfmpeg(() => checkEnvironment({ strict: true, checkTts: false })),
    (err: unknown) => {
      assert.ok(err instanceof EngineError, '应抛 EngineError');
      assert.equal(err.code, ERROR_CODES.FFMPEG_NOT_FOUND);
      return true;
    },
  );
});

test('缺少 ffmpeg 时非严格模式不抛错，但把问题记入 errors', () => {
  const r = withoutFfmpeg(() => checkEnvironment({ strict: false, checkTts: false }));
  assert.equal(r.ffmpeg.available, false);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('ffmpeg')), `errors 应提到 ffmpeg: ${r.errors.join('; ')}`);
});

test('字体文件缺失：非严格模式记 warning，严格模式抛 FONT_NOT_FOUND', () => {
  const bogus = '/nonexistent/font-does-not-exist.ttf';

  // 非严格：只警告（`video env` 要能给出完整报告，不能一上来就抛）
  const lenient = checkEnvironment({ fontFile: bogus, checkTts: false });
  assert.equal(lenient.fonts.fileExists, false);
  assert.equal(lenient.fonts.registered, false);
  assert.ok(
    lenient.warnings.some((w) => w.includes('项目字体缺失')),
    `warnings 应提到字体缺失: ${lenient.warnings.join('; ')}`,
  );

  // 严格：字体缺失意味着会静默回退到系统字体、破坏确定性，必须硬失败
  assert.throws(
    () => checkEnvironment({ strict: true, fontFile: bogus, checkTts: false }),
    (err: unknown) => {
      assert.ok(err instanceof EngineError);
      assert.equal(err.code, ERROR_CODES.FONT_NOT_FOUND);
      return true;
    },
  );
});

test('registerProjectFonts 幂等，且真实注册项目字体', () => {
  const a = registerProjectFonts();
  const b = registerProjectFonts();
  assert.equal(a.registered, true, '项目字体应已注册（需先运行 pnpm fonts）');
  assert.equal(b.registered, true, '重复调用不应失败');
  assert.equal(a.family, PROJECT_FONT_FAMILY);
});

test('EngineError.toLLMString 含错误码、允许值与修复提示', () => {
  const err = new EngineError(ERROR_CODES.SPEC_INVALID, 'scenes[0].camera 不支持', {
    details: { got: 'aaa' },
    allowed: ['wide', 'medium', 'close'],
    hint: '改用枚举内的值',
  });
  const s = err.toLLMString();
  assert.match(s, /^SPEC_INVALID: /);
  assert.match(s, /Allowed: wide \| medium \| close/);
  assert.match(s, /Hint: 改用枚举内的值/);
  assert.match(s, /got: "aaa"/);
  // 不应包含堆栈——堆栈对弱模型是噪声
  assert.doesNotMatch(s, /at .*\.ts:\d+/);
});
