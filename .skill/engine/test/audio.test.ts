import { createFixtureProject } from './fixtures/project.ts';
/**
 * 音频链路测试（Phase G）。
 *
 * 两个层次：
 *   1. **纯函数层**：滤镜图构造。不启动 ffmpeg，因此可以断言图的形状
 *      （是否建了侧链、每条轨的位置/增益/淡入淡出、amix 有没有 normalize=0）。
 *      这一层能抓住"图看起来对但实际不对"的大部分问题。
 *   2. **真实 ffmpeg 层**：真的合成、真的混音、真的用 volumedetect 量。
 *
 * 关于闪避的测法（这一点很容易做假）：
 *   直接对成品量"说话时 vs 静默时"的电平是**错的**——成品里还混着人声本身，
 *   而且 BGM 有淡入淡出，两个窗口本来就不等响。
 *   正确做法是渲染两遍、只差一个开关（duckUnderNarration 开/关），
 *   在**同一时间窗**里对比被闪避后的 BGM 干声。
 *   这样淡入淡出、增益、素材完全相同，差值就只剩闪避。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { buildAudio, exportDuckedBgmStem } from '../src/audio/build.ts';
import { buildMixArgs, mixAudio, measureMeanVolume } from '../src/audio/mixer.ts';
import { narrationTimingIssues, verifyVoicePresence } from '../src/audio/verify.ts';
import type { AudioTimeline, AudioTrack } from '../src/audio/types.ts';
import { proceduralBgmProvider } from '../src/audio/bgm/index.ts';
import { synthBgm, encodeWav16, SAMPLE_RATE } from '../src/audio/bgm/procedural.ts';
import { mockTtsProvider, resolveTtsProvider, defaultVoiceAssetPath } from '../src/audio/tts/index.ts';
import { createEdgeTtsProvider } from '../src/audio/tts/edge.ts';
import { synthSfx } from '../src/audio/sfx/index.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import { SFX_PRESETS, type ResolvedVideoSpec } from '../src/spec/types.ts';

// 临时产物统一落 .research/out/（AGENTS.md 硬性规则 1）：
// 探针/测试产物不进任何产品输出目录，out/ 与 projects/*/out/ 只放真正的成片。
const WORK = join(PROJECT_ROOT, '.research', 'out', 'audio-test');
mkdirSync(WORK, { recursive: true });
after(() => rmSync(WORK, { recursive: true, force: true }));
const fixture = createFixtureProject();
after(fixture.cleanup);
const EXAMPLE = fixture.specPath;

function m0Spec(): ResolvedVideoSpec {
  const spec = validateSpec(loadSpecFile(EXAMPLE)).spec;
  assert.ok(spec);
  return spec;
}

/** 缩短时长以加快测试（音频内容与时长无关） */
function withDuration(spec: ResolvedVideoSpec, seconds: number): ResolvedVideoSpec {
  return { ...spec, video: { ...spec.video, duration: seconds } };
}

function track(partial: Partial<AudioTrack> & Pick<AudioTrack, 'kind' | 'path'>): AudioTrack {
  return { start: 0, gain: 1, sourceDuration: 4, ...partial };
}

function timeline(tracks: AudioTrack[], duration = 8): AudioTimeline {
  return {
    tracks,
    durationSeconds: duration,
    loudnessLufs: -14,
    truePeakDb: -1.5,
    masterPath: join(WORK, 'graph-check.wav'),
    masterSampleRate: 48000,
  };
}

// ------------------------------------------------------- 滤镜图（纯函数）

test('滤镜图：有 voice 与 bgm 时建立侧链压缩，且顺序正确', () => {
  // 刻意每类放两条轨：这样 bus 会真的生成 amix，标签也才是 voice/bgmraw。
  // （单条轨时 bus 会直接复用 [tN]，不生成多余的 amix——那是刻意的优化）
  const { filterComplex } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v1.wav', start: 0, sourceDuration: 3 }),
      track({ kind: 'voice', path: 'v2.wav', start: 3, sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b1.wav', start: 0, gain: 0.25, sourceDuration: 8, duckUnderVoice: true }),
      track({ kind: 'bgm', path: 'b2.wav', start: 0, gain: 0.25, sourceDuration: 8, duckUnderVoice: true }),
    ]),
  );
  assert.match(filterComplex, /\[voice\]asplit=2\[voiceaudible\]\[voicesidechain\]/);
  assert.match(filterComplex, /\[bgmraw\]\[voicesidechain\]sidechaincompress=/);
  // 侧链必须用 voice 做触发，不能用"所有非 voice"
  assert.doesNotMatch(filterComplex, /\[bgmraw\]\[sfx\]/);
  assert.match(filterComplex, /loudnorm=I=-14:TP=-1\.5:LRA=11:linear=true\[out\]$/);
});

test('滤镜图：没有 voice 时不建侧链（避免在无触发源时画蛇添足）', () => {
  const { filterComplex } = buildMixArgs(
    timeline([track({ kind: 'bgm', path: 'b.wav', sourceDuration: 8, duckUnderVoice: true })]),
  );
  assert.doesNotMatch(filterComplex, /sidechaincompress/);
  assert.match(filterComplex, /loudnorm=/);
});

test('滤镜图：bgm 明确关闭闪避时不建侧链', () => {
  const { filterComplex } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v.wav', sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b.wav', sourceDuration: 8, duckUnderVoice: false }),
    ]),
  );
  assert.doesNotMatch(filterComplex, /sidechaincompress/);
});

test('滤镜图：每条轨都补齐到总时长再进 amix（否则 longest 语义不确定）', () => {
  const { filterComplex } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v.wav', sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b.wav', sourceDuration: 5 }),
      track({ kind: 'sfx', path: 's.wav', sourceDuration: 2 }),
    ]),
  );
  const apadCount = (filterComplex.match(/apad,atrim=0:8/g) ?? []).length;
  assert.equal(apadCount, 3, '三条轨都应 apad+atrim 到总时长 8s');
});

test('滤镜图：amix 一律 normalize=0（否则加一轨音量就被多除一次）', () => {
  // 每类两条轨 → 3 个 bus amix + 1 个总混 amix，四个都必须 normalize=0
  const { filterComplex } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v1.wav', sourceDuration: 3 }),
      track({ kind: 'voice', path: 'v2.wav', sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b1.wav', sourceDuration: 8 }),
      track({ kind: 'bgm', path: 'b2.wav', sourceDuration: 8 }),
      track({ kind: 'sfx', path: 's1.wav', sourceDuration: 2 }),
      track({ kind: 'sfx', path: 's2.wav', sourceDuration: 2 }),
    ]),
  );
  const mixes = filterComplex.match(/amix=[^[]*/g) ?? [];
  assert.equal(mixes.length, 4, `应有 3 个 bus + 1 个总混: ${mixes.join(' | ')}`);
  for (const m of mixes) {
    assert.match(m, /normalize=0/, `amix 缺少 normalize=0: ${m}`);
  }
});

test('滤镜图：位置/增益/淡入淡出被写进每条轨的链', () => {
  const { filterComplex } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v.wav', start: 1.25, gain: 1, sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b.wav', gain: 0.25, sourceDuration: 8, fadeIn: 1.5, fadeOut: 2 }),
    ]),
  );
  assert.match(filterComplex, /adelay=1250\|1250/, '变声起始 1.25s 应转成 1250ms delay');
  assert.match(filterComplex, /volume=0\.25/, 'BGM 增益应写入');
  assert.match(filterComplex, /afade=t=in:st=0:d=1\.5/);
  assert.match(filterComplex, /afade=t=out:st=6:d=2/, '淡出应从 8-2=6s 开始');
});

test('滤镜图：只有一条轨时不生成多余的 amix', () => {
  const { filterComplex } = buildMixArgs(timeline([track({ kind: 'bgm', path: 'b.wav', sourceDuration: 8 })]));
  assert.doesNotMatch(filterComplex, /amix/);
  assert.match(filterComplex, /\[t0\]loudnorm=/);
});

test('滤镜图：duckedBgmOnly 只导出被闪避的 BGM，且不做 loudnorm（用于验证闪避）', () => {
  const { filterComplex, args } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v.wav', sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b.wav', sourceDuration: 8, duckUnderVoice: true }),
    ]),
    { duckedBgmOnly: true },
  );
  assert.match(filterComplex, /sidechaincompress=.*\[bgm\]/);
  assert.doesNotMatch(filterComplex, /amix/);

  // 关键：验证模式必须**不做** loudnorm。
  // loudnorm 会在整段上算一个统一线性增益，把闪避造成的电平差抵消掉
  // （实测：真实 9.7dB 的闪避会被压成 0.2dB，看起来像"闪避没生效"）。
  assert.doesNotMatch(filterComplex, /loudnorm/, '验证模式不应做响度归一化，否则量不准闪避深度');

  // 输出必须是侧链后的 BGM 本身
  const mapAt = args.indexOf('-map');
  assert.equal(args[mapAt + 1], '[bgm]', '应直接映射被闪避后的 BGM 标签');
});

test('滤镜图：duckedBgmOnly 会剔除与此无关的 SFX 轨（否则链悬空，ffmpeg 直接拒绝）', () => {
  // 回归防护：之前没有裁剪 SFX，导致 sfx 的链没人消费，
  // ffmpeg 报 "Filter asetpts has an unconnected output" 并以退出码 234 失败。
  const { filterComplex, args } = buildMixArgs(
    timeline([
      track({ kind: 'voice', path: 'v.wav', sourceDuration: 3 }),
      track({ kind: 'bgm', path: 'b.wav', sourceDuration: 8, duckUnderVoice: true }),
      track({ kind: 'sfx', path: 's.wav', sourceDuration: 4 }),
    ]),
    { duckedBgmOnly: true },
  );
  assert.doesNotMatch(filterComplex, /s\.wav/);
  assert.ok(!filterComplex.includes('[t2]'), `sfx 的链不应出现在图里: ${filterComplex}`);
  // -i 也必须同步裁剪，否则输入数与图对不上
  assert.equal(args.filter((a) => a === '-i').length, 2, '-i 应只包含 voice 与 bgm');
});

test('滤镜图：没有任何轨时明确报错，而不是产出静音文件', () => {
  assert.throws(() => buildMixArgs(timeline([])), /没有可混音的音轨/);
});

// ------------------------------------------------------------ provider

test('MockTTS 确定性：同 seed 同文本得到完全相同的音频与时间戳', async () => {
  const a = await mockTtsProvider.synthesize({
    text: '窗外的一场雨。', voice: 'female_calm', seed: 42, outPath: join(WORK, 'mock-a.wav'),
  });
  const b = await mockTtsProvider.synthesize({
    text: '窗外的一场雨。', voice: 'female_calm', seed: 42, outPath: join(WORK, 'mock-b.wav'),
  });
  assert.deepEqual(readFileSync(a.path), readFileSync(b.path), '同 seed 音频应逐字节相同');
  assert.deepEqual(a.words, b.words, '时间戳也应相同');
  assert.ok((a.words?.length ?? 0) > 0, 'MockTTS 应提供词级时间戳');
  assert.ok(a.durationSeconds > 0);
});

test('MockTTS 不同 seed 产出不同音频（seed 真的在起作用）', async () => {
  const a = await mockTtsProvider.synthesize({
    text: '同一句话。', voice: 'female_calm', seed: 1, outPath: join(WORK, 'mock-s1.wav'),
  });
  const b = await mockTtsProvider.synthesize({
    text: '同一句话。', voice: 'female_calm', seed: 2, outPath: join(WORK, 'mock-s2.wav'),
  });
  assert.notDeepEqual(readFileSync(a.path), readFileSync(b.path));
});

test('TTS provider 选择：至少两个实现可用，且回退会带出原因', async () => {
  // mock 永远可用
  const strict = await resolveTtsProvider({ preferred: 'mock' });
  assert.equal(strict.provider.id, 'mock');
  assert.equal(strict.fallbackReason, undefined, '首选可用时不应有回退原因');

  // 禁用联网 + 无预制音频 → 必然落到 mock，且说明原因
  const offline = await resolveTtsProvider({ allowNetwork: false, voiceAssetPath: '/nonexistent/voice.wav' });
  assert.equal(offline.provider.id, 'mock');
  assert.ok(offline.fallbackReason && offline.fallbackReason.length > 0, '回退必须带原因');
  assert.match(offline.fallbackReason, /edge|file/);
});

test('EdgeTTS：真实合成采用请求语速覆盖默认值，支持负百分比与词级时间', async () => {
  const provider = createEdgeTtsProvider({ rate: '+25%' });
  const available = await provider.isAvailable();
  assert.equal(typeof available, 'boolean');
  if (available) {
    // 环境里确实装了 edge-tts：做一次真实合成，验证词级时间戳
    const result = await provider.synthesize({
      text: '每一帧都是一幅画。',
      voice: 'female_calm',
      rate: '-12%',
      seed: 1,
      outPath: join(WORK, 'edge-probe.mp3'),
    });
    assert.ok(result.durationSeconds > 0, '应返回时长');
    const metadata = JSON.parse(readFileSync(result.path + '.words.json', 'utf8'));
    assert.equal(metadata.rate, '-12%');
    assert.equal(metadata.voice, 'zh-CN-XiaoxiaoNeural');
    assert.ok((result.words?.length ?? 0) >= 5, `中文应返回词级时间戳，实际 ${result.words?.length ?? 0} 个`);
    for (const w of result.words ?? []) {
      assert.ok(w.end > w.start, `词级时间应递增: ${JSON.stringify(w)}`);
    }
  } else {
    // 不可用时必须能被 resolveTtsProvider 回退掉
    const selection = await resolveTtsProvider({ preferred: 'edge' });
    assert.notEqual(selection.provider.id, 'edge');
    assert.ok(selection.fallbackReason);
  }
});

test('音频构建把逐句语速与音色交给provider，实测时间保留起点', async t => {
  const original = mockTtsProvider.synthesize;
  const requests: Array<{ rate?: string; voice: string }> = [];
  t.mock.method(mockTtsProvider, 'synthesize', async request => { requests.push(request); return original(request); });
  const spec = withDuration(m0Spec(), 8);
  spec.audio.narration = [{ start: 0.3, text: '甲。', voice: 'female_lively', rate: -12 }, { start: 3.1, text: '乙。', voice: 'male_calm' }];
  const result = await buildAudio({ spec, workDir: join(WORK, 'voice-rate'), tts: { provider: 'mock', allowNetwork: false } });
  assert.deepEqual(requests.map(req => req.rate), ['-12%', '+8%']);
  assert.deepEqual(requests.map(req => req.voice), ['female_lively', 'male_calm']);
  assert.equal(result.captionTimings.get(0)?.start, 0.3);
  assert.equal(result.captionTimings.get(1)?.start, 3.1);
});

test('预制 voice.wav 路径可配置（无 TTS 时的兜底）', () => {
  const p = defaultVoiceAssetPath();
  assert.match(p, /assets\/audio\/voice\.wav$/);
  assert.ok(join(PROJECT_ROOT, 'assets') !== p, '路径应指向项目内');
});

test('BGM provider：程序化合成可用，时长精确，且确定性', async () => {
  assert.equal(await proceduralBgmProvider.isAvailable(), true);
  const a = await proceduralBgmProvider.render({
    preset: 'quiet_piano', key: 'C', durationSeconds: 6, seed: 7, outPath: join(WORK, 'bgm-a.wav'),
  });
  const b = await proceduralBgmProvider.render({
    preset: 'quiet_piano', key: 'C', durationSeconds: 6, seed: 7, outPath: join(WORK, 'bgm-b.wav'),
  });
  assert.equal(a.durationSeconds, 6);
  assert.deepEqual(readFileSync(a.path), readFileSync(b.path), '同 seed BGM 应逐字节相同');
  const expected = 44 + Math.ceil(6 * SAMPLE_RATE) * 4;
  assert.equal(statSync(a.path).size, expected, '文件长度应精确对应时长（无尾部多余数据）');

  const c = await proceduralBgmProvider.render({
    preset: 'quiet_piano', key: 'C', durationSeconds: 6, seed: 8, outPath: join(WORK, 'bgm-c.wav'),
  });
  assert.notDeepEqual(readFileSync(a.path), readFileSync(c.path));
});

test('BGM 合成：峰值不超过 1.0，且首尾有淡入淡出（不爆音）', () => {
  const r = synthBgm({ preset: 'warm_uplift', key: 'G', seed: 3, durationSeconds: 4 });
  let peak = 0;
  for (let i = 0; i < r.left.length; i++) {
    peak = Math.max(peak, Math.abs(r.left[i] as number), Math.abs(r.right[i] as number));
  }
  assert.ok(peak <= 1.0, `峰值应 <= 1.0，实际 ${peak}`);
  assert.ok(peak > 0.1, '不应是静音');
  assert.ok(Math.abs(r.left[0] as number) < 1e-6, '开头应为 0（淡入）');
  assert.ok(Math.abs(r.left[r.left.length - 1] as number) < 1e-3, '结尾应接近 0（淡出）');
});

test('BGM 合成：调性影响音高（换 key 应产生不同波形）', () => {
  const c = encodeWav16(synthBgm({ preset: 'quiet_piano', key: 'C', seed: 1, durationSeconds: 2 }));
  const g = encodeWav16(synthBgm({ preset: 'quiet_piano', key: 'G', seed: 1, durationSeconds: 2 }));
  assert.notDeepEqual(c, g);
});

test('SFX 合成：每个预设都产出非静音、无削波、首尾归零的音频', () => {
  for (const preset of SFX_PRESETS) {
    const buf = synthSfx(preset, 1.5, 5);
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < buf.left.length; i++) {
      const v = Math.abs(buf.left[i] as number);
      peak = Math.max(peak, v);
      energy += v;
    }
    assert.ok(peak <= 1.0, `${preset} 峰值超限: ${peak}`);
    assert.ok(peak > 0.02, `${preset} 峰值过低，可能是静音: ${peak}`);
    assert.ok(energy / buf.left.length > 0.0005, `${preset} 能量过低`);
    assert.ok(Math.abs(buf.left[0] as number) < 1e-6, `${preset} 开头应归零`);
  }
});

test('点击与完成音效立即触发、只播放一次，短尾窗仍有信号且固定种子可复现', () => {
  for (const preset of ['click', 'success'] as const) {
    const buf = synthSfx(preset, 1.6, 5);
    assert.deepEqual(buf, synthSfx(preset, 1.6, 5));
    assert.ok(buf.left.slice(1, 480).some(v => Math.abs(v) > 0.01), `${preset} 应在触发后 10ms 内发声`);
    assert.ok(buf.left.slice(19200).every(v => v === 0), `${preset} 在 400ms 后应保持安静`);
    const short = synthSfx(preset, 0.08, 5);
    assert.ok(short.left.some(v => Math.abs(v) > 0.01), `${preset} 短尾窗应有信号`);
    assert.ok(Math.abs(short.left.at(-1)!) < 0.003, `${preset} 截短尾部应淡出`);
  }
});

// -------------------------------------------------- 真实 ffmpeg 端到端

test('多句旁白在开启音乐闪避后每一句仍出现在最终混音的正确位置', async () => {
  const dir = join(WORK, 'multi-voice'); mkdirSync(dir, { recursive: true });
  const voice = await mockTtsProvider.synthesize({ text: '完整配音', voice: 'female_calm', seed: 1, outPath: join(dir, 'voice.wav') });
  const bgm = await proceduralBgmProvider.render({ preset: 'quiet_piano', key: 'C', seed: 2, durationSeconds: 10, outPath: join(dir, 'bgm.wav') });
  const starts = [0.3, 3.3, 6.3];
  for (const ducked of [false, true]) {
    const mix = { ...timeline([
      ...starts.map(start => track({ kind: 'voice', path: voice.path, start, sourceDuration: voice.durationSeconds })),
      track({ kind: 'bgm', path: bgm.path, gain: 0, sourceDuration: 10, duckUnderVoice: ducked }),
    ], 10), masterPath: join(dir, `${ducked}.wav`) };
    mixAudio(mix);
    assert.ok(verifyVoicePresence(mix.masterPath, mix.tracks.filter(t => t.kind === 'voice')).every(p => p.ok));
    for (const start of starts) {
      const measured = measureMeanVolume(mix.masterPath, start + 0.2, 0.6);
      assert.ok(measured.meanDb !== null && measured.meanDb > -35, `旁白 ${start}s 丢失: ${measured.meanDb} dBFS`);
    }
    assert.ok(measureMeanVolume(mix.masterPath, 8.5, 0.5).meanDb! < -80, '间隔应保持静音');
  }
});

test('逐句信号验收能从有音乐的混音中识别第二句配音丢失', async () => {
  const dir = join(WORK, 'voice-presence'); mkdirSync(dir, { recursive: true });
  const voice = await mockTtsProvider.synthesize({ text: '这一句要出现', voice: 'female_calm', seed: 3, outPath: join(dir, 'voice.wav') });
  const bgm = await proceduralBgmProvider.render({ preset: 'playful', key: 'C', seed: 5, durationSeconds: 8, outPath: join(dir, 'bgm.wav') });
  const voices = [0.2, 4].map(start => track({ kind: 'voice', path: voice.path, start, sourceDuration: voice.durationSeconds }));
  const mix = { ...timeline([voices[0]!, track({ kind: 'bgm', path: bgm.path, gain: 0.2, sourceDuration: 8 })]), masterPath: join(dir, 'broken.wav') };
  mixAudio(mix);
  const result = verifyVoicePresence(mix.masterPath, voices);
  assert.equal(result[0]!.ok, true); assert.equal(result[1]!.ok, false);
});

test('旁白验收拒绝缺句、重叠及越过片尾，正式制作拒绝 mock 替代人声', async () => {
  const spec = withDuration(m0Spec(), 8);
  spec.audio.narration = [{ start: 0.2, text: '甲', voice: 'female_calm' }, { start: 4, text: '乙', voice: 'female_calm' }];
  assert.equal(narrationTimingIssues(spec, new Map()).length, 2);
  assert.equal(narrationTimingIssues(spec, new Map([[0, { start: 0.2, end: 3 }], [1, { start: 4, end: 7 }]])).length, 0);
  assert.equal(narrationTimingIssues(spec, new Map([[0, { start: 0.2, end: 4.5 }], [1, { start: 4, end: 9 }]])).length, 2);
  await assert.rejects(buildAudio({ spec, workDir: join(WORK, 'strict-mock'), strictNarration: true, tts: { provider: 'mock', allowNetwork: false } }), /NARRATION_REQUIRED/);
});

test('端到端：三轨齐全时 master.wav 时长与视频一致，且无削波', async () => {
  const spec = withDuration(m0Spec(), 8);
  const result = await buildAudio({
    spec,
    workDir: WORK,
    tts: { provider: 'mock', allowNetwork: false },
  });

  assert.ok(existsSync(result.masterPath));
  assert.equal(result.providerInfo.tts, 'mock');
  assert.equal(result.providerInfo.bgm, 'procedural');
  assert.equal(result.providerInfo.sfx, 'procedural');
  assert.equal(result.timeline.tracks.filter((t) => t.kind === 'voice').length, 1);
  assert.equal(result.timeline.tracks.filter((t) => t.kind === 'bgm').length, 1);
  assert.equal(result.timeline.tracks.filter((t) => t.kind === 'sfx').length, 1);

  const duration = measureDuration(result.masterPath);
  assert.ok(
    Math.abs(duration - spec.video.duration) < 0.05,
    `master 时长应等于视频时长 ${spec.video.duration}s，实际 ${duration}s`,
  );

  const vol = measureMeanVolume(result.masterPath, 0, spec.video.duration);
  assert.ok(vol.maxDb !== null && vol.maxDb <= 0.0, `不应削波，max ${vol.maxDb} dBFS`);
  assert.ok(vol.meanDb !== null && vol.meanDb > -40, `不应是静音，mean ${vol.meanDb} dB`);
});

test('端到端：字幕拿到 TTS 实测时间，且换算为绝对时间', async () => {
  const spec = withDuration(m0Spec(), 8);
  const result = await buildAudio({
    spec, workDir: WORK, tts: { provider: 'mock', allowNetwork: false },
  });
  const timing = result.captionTimings.get(0);
  assert.ok(timing, '应有第 0 条旁白的实测时间');
  assert.equal(timing.start, spec.audio.narration[0]!.start, '起始时间应等于脚本里的 start');
  assert.ok((timing.words?.length ?? 0) > 0, '应带回词级时间戳');
  assert.ok(
    (timing.words?.[0]?.start ?? 0) >= spec.audio.narration[0]!.start,
    '词级时间应是绝对时间（已加上起始偏移）',
  );
});

test('端到端：实测响度进入管线并被记录（LUFS / dBTP）', async () => {
  const spec = withDuration(m0Spec(), 8);
  const result = await buildAudio({
    spec, workDir: WORK, tts: { provider: 'mock', allowNetwork: false },
  });
  const { inputIntegratedLufs, inputTruePeakDbtp } = result.measuredLoudness;
  assert.ok(inputIntegratedLufs !== null, '应测到整体响度');
  assert.ok(inputTruePeakDbtp !== null, '应测到真峰值');
  // 目标 -14 LUFS，容差放宽到 ±3（linear 模式做不到精确命中）
  assert.ok(
    Math.abs((inputIntegratedLufs ?? 0) - spec.audio.loudness) <= 3,
    `响度偏离目标过大: ${inputIntegratedLufs} LUFS (目标 ${spec.audio.loudness})`,
  );
  assert.ok((inputTruePeakDbtp ?? 1) <= -0.5, `真峰值应留有余量: ${inputTruePeakDbtp} dBTP`);
});

test('端到端：闪避确实生效——同窗口对比开/关闪避的 BGM 干声', async () => {
  const spec = withDuration(m0Spec(), 12);
  const narrationStart = spec.audio.narration[0]!.start;
  const narrationLen = 5; // 估算是 ~5.07s

  const build = async (duck: boolean): Promise<{ master: string; workDir: string }> => {
    const s: ResolvedVideoSpec = {
      ...spec,
      audio: { ...spec.audio, bgm: { ...spec.audio.bgm, duckUnderNarration: duck } },
    };
    const dir = join(WORK, duck ? 'duck-on' : 'duck-off');
    const r = await buildAudio({ spec: s, workDir: dir, tts: { provider: 'mock', allowNetwork: false } });
    const stem = join(dir, 'bgm-stem.wav');
    exportDuckedBgmStem(r.timeline, stem);
    return { master: stem, workDir: dir };
  };

  const on = await build(true);
  const off = await build(false);

  // 说话中（取中段，避开淡入淡出）
  const speechAt = narrationStart + 0.6;
  const speechDur = 2.0;
  // 静默：旁白结束后、BGM 淡出开始前。12s 视频 fadeOut=2 → 10s 起淡出
  const quietAt = narrationStart + narrationLen + 0.4;

  const onSpeech = measureMeanVolume(on.master, speechAt, speechDur).meanDb;
  const offSpeech = measureMeanVolume(off.master, speechAt, speechDur).meanDb;
  const onQuiet = measureMeanVolume(on.master, quietAt, 1.2).meanDb;
  const offQuiet = measureMeanVolume(off.master, quietAt, 1.2).meanDb;

  assert.ok(onSpeech !== null && offSpeech !== null && onQuiet !== null && offQuiet !== null);

  const duckDepth = (offSpeech as number) - (onSpeech as number);
  // 阈值取 6dB：这是用**替身信号**（MockTTS）在真 ffmpeg 上量到的值。
  // 真实语音的密度影响闪避深度，以当前信号检查为准。
  // 这里要求 6dB 而不是更低，是因为过低的下限惊醒不了"闪避其实没生效"的回归
  // （当初正是因为替身信号太尖锐，真实 13dB 被掩盖成 0.2dB）。
  assert.ok(
    duckDepth >= 6,
    `说话段 BGM 应被明显压低：未闪避 ${offSpeech}dB → 闪避后 ${onSpeech}dB，深度仅 ${duckDepth.toFixed(2)}dB`,
  );

  const quietDelta = Math.abs((offQuiet as number) - (onQuiet as number));
  assert.ok(
    quietDelta <= 1.0,
    `静默段不应被闪避影响：未闪避 ${offQuiet}dB vs 闪避 ${onQuiet}dB，差 ${quietDelta.toFixed(2)}dB`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `    [实测] 闪避深度 ${duckDepth.toFixed(2)}dB（说话段 ${offSpeech}→${onSpeech}dB）；` +
      `静默段差 ${quietDelta.toFixed(2)}dB（${offQuiet} vs ${onQuiet}dB）`,
  );
});

test('端到端：三轨可分别缺失（结构独立，缺一轨不崩）', async () => {
  const base = withDuration(m0Spec(), 6);

  // 1) 无旁白：只有 BGM + SFX
  const noVoice = await buildAudio({
    spec: { ...base, audio: { ...base.audio, narration: [] } },
    workDir: join(WORK, 'no-voice'),
  });
  assert.equal(noVoice.timeline.tracks.filter((t) => t.kind === 'voice').length, 0);
  assert.ok(existsSync(noVoice.masterPath));
  assert.ok((noVoice.timeline.tracks.length ?? 0) >= 2);

  // 2) BGM 音量为 0：跳过 BGM
  const noBgm = await buildAudio({
    spec: { ...base, audio: { ...base.audio, bgm: { ...base.audio.bgm, volume: 0 } } },
    workDir: join(WORK, 'no-bgm'),
    tts: { provider: 'mock', allowNetwork: false },
  });
  assert.equal(noBgm.timeline.tracks.filter((t) => t.kind === 'bgm').length, 0);
  assert.ok(existsSync(noBgm.masterPath));

  // 3) 无音效
  const noSfx = await buildAudio({
    spec: { ...base, audio: { ...base.audio, sfx: [] } },
    workDir: join(WORK, 'no-sfx'),
    tts: { provider: 'mock', allowNetwork: false },
  });
  assert.equal(noSfx.timeline.tracks.filter((t) => t.kind === 'sfx').length, 0);
  assert.ok(existsSync(noSfx.masterPath));

  // 4) 只有旁白
  const voiceOnly = await buildAudio({
    spec: { ...base, audio: { ...base.audio, bgm: { ...base.audio.bgm, volume: 0 }, sfx: [] } },
    workDir: join(WORK, 'voice-only'),
    tts: { provider: 'mock', allowNetwork: false },
  });
  assert.equal(voiceOnly.timeline.tracks.length, 1);
  assert.equal(voiceOnly.timeline.tracks[0]?.kind, 'voice');
  assert.ok(existsSync(voiceOnly.masterPath));
});

test('端到端：一条轨都没有时明确报错', async () => {
  const base = withDuration(m0Spec(), 4);
  await assert.rejects(
    () =>
      buildAudio({
        spec: { ...base, audio: { ...base.audio, narration: [], bgm: { ...base.audio.bgm, volume: 0 }, sfx: [] } },
        workDir: join(WORK, 'empty'),
      }),
    /没有任何可混音的音轨/,
  );
});

test('端到端：旁白合成失败时降级而不是整片失败', async () => {
  const base = withDuration(m0Spec(), 6);
  const result = await buildAudio({
    spec: base,
    workDir: join(WORK, 'tts-fail'),
    // 指向一个必然失败的 provider 配置：file 且路径不存在 → resolve 会回退到 mock，
    // 因此这里改为直接验证"回退发生且带原因"
    tts: { provider: 'file', voiceAssetPath: '/nonexistent/voice.wav', allowNetwork: false },
  });
  assert.ok(result.providerInfo.tts !== 'file', '应回退到其他 provider');
  assert.ok(result.warnings.some((w) => w.includes('回退')), `应有回退告警: ${result.warnings.join('; ')}`);
  assert.ok(existsSync(result.masterPath));
});

// ------------------------------------------------------------- 工具

function measureDuration(path: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
  });
  return Number((r.stdout ?? '').trim());
}
