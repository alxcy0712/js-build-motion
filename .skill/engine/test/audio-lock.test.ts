import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildAudio, type BuildAudioResult } from '../src/audio/build.ts';
import { audioLockSignatures, createAudioLock, loadAudioLock } from '../src/audio/lock.ts';
import { narrationTimingIssues, readNarrationTimings, timingSpecHash } from '../src/audio/verify.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import type { ResolvedVideoSpec } from '../src/spec/types.ts';
import { sha256File, sha256Text } from '../src/utils/hash.ts';
import { createFixtureProject } from './fixtures/project.ts';

const fixture = createFixtureProject();
const work = join(fixture.outDir, 'audio-lock-test');
const voicePath = join(fixture.dir, 'assets/voice.wav');
let spec: ResolvedVideoSpec;
let audio: BuildAudioResult;
let created: Awaited<ReturnType<typeof createAudioLock>>;
let manifestPath: string;
let manifestBytes: Buffer;

before(async () => {
  const checked = validateSpec(loadSpecFile(fixture.specPath));
  assert.ok(checked.spec); spec = checked.spec;
  spec.video.duration = 3; spec.scenes[0]!.end = 3;
  spec.audio.narration = [{ start: 0.2, text: '本地声音测试', voice: 'female_calm' }];
  spec.audio.sfx = [{ start: 1.5, preset: 'whoosh', volume: 0.1 }];
  mkdirSync(dirname(voicePath), { recursive: true });
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=0.8', '-c:a', 'pcm_s16le', '-y', voicePath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  audio = await buildAudio({ spec, workDir: work, tts: { provider: 'file', allowNetwork: false, voiceAssetPath: voicePath }, strictNarration: true });
  created = await createAudioLock({ projectDir: fixture.dir, spec, audio, sourceAssets: [voicePath] });
  manifestPath = join(fixture.dir, created.path);
  manifestBytes = readFileSync(manifestPath);
});
after(fixture.cleanup);

test('声音锁保存普通独立输入文件及实测 timing，可独立于原 out 工作目录复用', async () => {
  assert.match(created.path, /^assets\/derived\/audio\/[a-f0-9]{64}\/audio-lock\.json$/);
  const raw = JSON.parse(manifestBytes.toString());
  assert.ok(!manifestBytes.toString().includes(fixture.dir));
  assert.ok(raw.media.every((item: { path: string }) => !item.path.includes('out/')));
  const initial = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec });
  const masterHash = sha256File(audio.masterPath);
  const sourcesBefore = sha256File(voicePath);
  assert.equal(sha256File(initial.audio.masterPath), masterHash);
  assert.equal(initial.provenance.sourceProviders.tts, 'file');
  assert.deepEqual(initial.audio.providerInfo, { tts: '(none)', bgm: '(none)', sfx: '(none)' });
  assert.equal(initial.audio.mix.elapsedMs, 0);
  assert.equal(initial.usage.sha256, created.sha256);
  assert.equal(initial.usage.mediaFiles.length, audio.timeline.tracks.length + 3);
  rmSync(work, { recursive: true, force: true });
  const changed = structuredClone(spec);
  changed.style.palette = 'cool_blue';
  changed.video.width = 720;
  changed.scenes[0]!.camera = 'close';
  changed.audio.narration[0]!.translation = 'Local audio check';
  const reused = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec: changed });
  assert.equal(sha256File(reused.audio.masterPath), masterHash);
  assert.equal(sha256File(voicePath), sourcesBefore);
  assert.notEqual(reused.timingReport.specHash, timingSpecHash(spec));
  assert.equal(reused.timingReport.specHash, timingSpecHash(changed));
  const timingPath = join(fixture.outDir, 'current-lock-timing.json');
  writeFileSync(timingPath, JSON.stringify(reused.timingReport));
  assert.deepEqual(readNarrationTimings([timingPath], changed), reused.audio.captionTimings);
  assert.equal(readNarrationTimings([timingPath], spec), undefined);
  assert.deepEqual(narrationTimingIssues(changed, reused.audio.captionTimings), []);
});

test('声音内容、排布及混音参数变化均使旧 master 失效', async () => {
  const changes: ((value: ResolvedVideoSpec) => void)[] = [
    value => { value.audio.narration[0]!.text += '修改'; },
    value => { value.audio.narration[0]!.voice = 'male_calm'; },
    value => { value.audio.narration[0]!.rate = 30; },
    value => { value.audio.narration[0]!.start += 0.1; },
    value => { value.video.duration += 1; },
    value => { value.video.seed++; },
    value => { value.audio.bgm.volume += 0.1; },
    value => { value.audio.bgm.bpm = 100; },
    value => { value.audio.bgm.preset = 'playful'; },
    value => { value.audio.bgm.key = 'G'; },
    value => { value.audio.bgm.fadeIn += 0.1; },
    value => { value.audio.bgm.fadeOut += 0.1; },
    value => { value.audio.bgm.duckUnderNarration = !value.audio.bgm.duckUnderNarration; },
    value => { value.audio.sfx[0]!.start += 0.1; },
    value => { value.audio.sfx[0]!.preset = 'click'; },
    value => { value.audio.sfx[0]!.volume += 0.1; },
    value => { value.audio.loudness += 1; },
  ];
  for (const change of changes) {
    const changed = structuredClone(spec); change(changed);
    assert.notDeepEqual(audioLockSignatures(changed), audioLockSignatures(spec));
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec: changed }), /声音内容或排布已变化/);
  }
  const defaults = structuredClone(spec);
  defaults.audio.narration[0]!.rate = 8;
  defaults.audio.bgm.key = 'C';
  assert.deepEqual(audioLockSignatures(defaults), audioLockSignatures(spec));
});

test('同路径声音原件替换会使锁失效', async () => {
  const original = readFileSync(voicePath);
  try {
    const replaced = Buffer.from(original); replaced[replaced.length - 1]! ^= 1;
    writeFileSync(voicePath, replaced);
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /原声音素材 hash 已变化/);
  } finally { writeFileSync(voicePath, original); }
});

test('file 声轨拒绝绑定无关源文件或构建后被替换的源字节', async () => {
  const loaded = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec });
  const ready = { ...loaded.audio, providerInfo: loaded.provenance.sourceProviders };
  const unrelated = join(fixture.dir, 'assets/unrelated-voice.wav');
  copyFileSync(ready.masterPath, unrelated);
  await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio: ready, sourceAssets: [unrelated] }), /声轨字节未匹配/);
  const original = readFileSync(voicePath);
  try {
    const replaced = Buffer.from(original); replaced[replaced.length - 1]! ^= 1;
    writeFileSync(voicePath, replaced);
    await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio: ready, sourceAssets: [voicePath] }), /声轨字节未匹配/);
    const metadata = JSON.parse(manifestBytes.toString());
    metadata.sourceAssets = [{ path: 'assets/unrelated-voice.wav', sha256: sha256File(unrelated) }];
    writeFileSync(manifestPath, JSON.stringify(metadata));
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /声轨字节未匹配/);
  } finally { writeFileSync(voicePath, original); writeFileSync(manifestPath, manifestBytes); }
});

test('file 锁保持完整样本长度及单条旁白契约，未知提供方拒绝入库', async () => {
  const loaded = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec });
  const ready = { ...loaded.audio, providerInfo: loaded.provenance.sourceProviders };
  const shorter = { ...ready,
    timeline: { ...ready.timeline, tracks: ready.timeline.tracks.map(track => track.kind === 'voice' ? { ...track, sourceDuration: 0.4 } : track) },
    captionTimings: new Map([[0, { start: 0.2, end: 0.6 }]]),
  };
  await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio: shorter, sourceAssets: [voicePath] }), /覆盖完整解码样本/);
  const multiSpec = structuredClone(spec);
  multiSpec.audio.narration.push({ start: 1.4, text: '第二条旁白', voice: 'female_calm' });
  const voice = ready.timeline.tracks.find(track => track.kind === 'voice')!;
  const multi = { ...ready,
    timeline: { ...ready.timeline, tracks: [...ready.timeline.tracks, { ...voice, start: 1.4 }] },
    captionTimings: new Map([[0, { start: 0.2, end: 1 }], [1, { start: 1.4, end: 2.2 }]]),
  };
  await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec: multiSpec, audio: multi, sourceAssets: [voicePath] }), /仅支持单条预制旁白/);
  await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio: { ...ready, providerInfo: { ...ready.providerInfo, tts: 'unknown-tts' } }, sourceAssets: [voicePath] }), /schema 不合法/);
  try {
    for (const role of ['tts', 'bgm', 'sfx']) {
      const metadata = JSON.parse(manifestBytes.toString());
      metadata.sourceProviders[role] = 'unknown-provider';
      writeFileSync(manifestPath, JSON.stringify(metadata));
      await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /schema 不合法/);
    }
  } finally { writeFileSync(manifestPath, manifestBytes); }
});

test('定稿拒绝缺失或越窗 timing、mock 来源及错误混音排布，失败后保留原锁', async () => {
  const loaded = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec });
  const ready = { ...loaded.audio, providerInfo: loaded.provenance.sourceProviders };
  const root = dirname(dirname(manifestPath));
  const before = readdirSync(root);
  const cases: [BuildAudioResult, RegExp][] = [
    [{ ...ready, captionTimings: new Map() }, /timing 引用不完整/],
    [{ ...ready, captionTimings: new Map([[0, { start: 0.2, end: 4 }]]) }, /实测 timing 不一致/],
    [{ ...ready, providerInfo: { ...ready.providerInfo, tts: 'mock' } }, /需要真实配音来源/],
    [{ ...ready, timeline: { ...ready.timeline, tracks: ready.timeline.tracks.map(track => track.kind === 'bgm' ? { ...track, gain: 0.99 } : track) } }, /音乐混音排布不一致/],
  ];
  for (const [invalid, expected] of cases) {
    await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio: invalid, sourceAssets: [voicePath] }), expected);
  }
  assert.deepEqual(readdirSync(root), before);
  assert.equal(sha256File(manifestPath), created.sha256);
});

test('相同定稿内容可重复创建同一锁，保留已有有效版本', async () => {
  const loaded = await loadAudioLock({ projectDir: fixture.dir, path: created.path, spec });
  const again = await createAudioLock({ projectDir: fixture.dir, spec, audio: { ...loaded.audio, providerInfo: loaded.provenance.sourceProviders }, sourceAssets: [voicePath] });
  assert.deepEqual(again, created);
  assert.equal(sha256File(manifestPath), created.sha256);
});

test('锁拒绝 metadata 改写，即使同时重算自身 hash 也与固定目录身份冲突', async () => {
  const lock = JSON.parse(manifestBytes.toString());
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)])) : value;
  try {
    writeFileSync(manifestPath, manifestBytes.toString() + '\n');
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /内容身份已变化/);
    lock.warnings.push('metadata modified');
    writeFileSync(manifestPath, JSON.stringify(lock));
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /内容身份已变化/);
    delete lock.contentSha256;
    lock.contentSha256 = sha256Text(JSON.stringify(sorted(lock)));
    writeFileSync(manifestPath, JSON.stringify(sorted(lock)) + '\n');
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /内容身份已变化/);
    lock.unknownField = true;
    writeFileSync(manifestPath, JSON.stringify(lock));
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /schema 不合法/);
  } finally { writeFileSync(manifestPath, manifestBytes); }
});

test('锁拒绝同大小 master 字节替换及锁内软硬链接', async () => {
  const master = join(dirname(manifestPath), 'master.wav');
  const original = readFileSync(master);
  const backup = join(dirname(master), 'saved-master.wav');
  try {
    const replaced = Buffer.from(original); replaced[replaced.length - 1]! ^= 1;
    writeFileSync(master, replaced);
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /音频 hash 已变化/);
    writeFileSync(master, original);
    renameSync(master, backup);
    symlinkSync(backup, master);
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /禁止软链接/);
    unlinkSync(master);
    linkSync(backup, master);
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path: created.path, spec }), /普通独立文件/);
  } finally {
    if (existsSync(backup)) { if (existsSync(master)) unlinkSync(master); renameSync(backup, master); }
    else writeFileSync(master, original);
  }
});

test('锁仅从本片正式输入域读取，越界和 out 来源引用均拒绝', async () => {
  for (const path of [manifestPath, '../other/audio-lock.json', created.path.replace('assets/derived', 'out')]) {
    await assert.rejects(loadAudioLock({ projectDir: fixture.dir, path, spec }), /声音锁相对路径/);
  }
  const source = join(fixture.outDir, 'outside-source.wav');
  copyFileSync(voicePath, source);
  await assert.rejects(createAudioLock({ projectDir: fixture.dir, spec, audio, sourceAssets: [source] }), /源素材必须位于/);
});
