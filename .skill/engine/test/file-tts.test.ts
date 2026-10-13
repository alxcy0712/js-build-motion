import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildAudio } from '../src/audio/build.ts';
import { probeAudio } from '../src/audio/probe.ts';
import { createFileTtsProvider } from '../src/audio/tts/index.ts';
import { estimateSpeechSeconds } from '../src/captions/track.ts';
import { loadSpecFile, validateSpec } from '../src/spec/validate.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { createFixtureProject } from './fixtures/project.ts';

const scratch = join(PROJECT_ROOT, '.research/out');
mkdirSync(scratch, { recursive: true });
const WORK = mkdtempSync(join(scratch, 'file-tts-'));
after(() => rmSync(WORK, { recursive: true, force: true }));
const request = { text: '实测文件的长度和文字估算应当独立。'.repeat(4), voice: 'female_calm' as const, seed: 1 };

function wav(path: string, samples: number, sampleRate: number, channels = 1): Buffer {
  const bytes = samples * channels * 2, data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(36 + bytes, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22); data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * channels * 2, 28); data.writeUInt16LE(channels * 2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++) for (let channel = 0; channel < channels; channel++) {
    data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 8000), 44 + (i * channels + channel) * 2);
  }
  writeFileSync(path, data);
  return data;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
}

test('file TTS 使用解码样本和原采样率，保留源字节，词时保持未知', async () => {
  for (const [sampleRate, samples, channels] of [[24000, 24013, 1], [44100, 66157, 2]] as const) {
    const source = join(WORK, `source-${sampleRate}.wav`), outPath = join(WORK, `copy-${sampleRate}.wav`);
    const original = wav(source, samples, sampleRate, channels);
    const measured = await probeAudio(source);
    assert.equal(measured.durationSamples, samples);
    assert.equal(measured.sampleRate, sampleRate);
    assert.equal(measured.durationSeconds, samples / sampleRate);
    const result = await createFileTtsProvider(() => source).synthesize({ ...request, outPath });
    assert.equal(result.durationSeconds, samples / sampleRate);
    assert.equal(result.sampleRate, sampleRate);
    assert.ok(Math.abs(result.durationSeconds - estimateSpeechSeconds(request.text)) > 5);
    assert.equal(result.words, undefined);
    assert.deepEqual(readFileSync(source), original);
    assert.deepEqual(readFileSync(outPath), original);
  }
});

test('audio probe 分开记录容器总长和首音轨解码样本长度', async () => {
  const source = join(WORK, 'short-audio.wav'), media = join(WORK, 'long-container.mkv');
  const samples = 12013, sampleRate = 24000;
  wav(source, samples, sampleRate);
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=16x16:r=10:d=2', '-i', source, '-map', '0:v', '-map', '1:a', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', media]);
  const measured = await probeAudio(media);
  assert.equal(measured.durationSamples, samples);
  assert.equal(measured.durationSeconds, samples / sampleRate);
  assert.ok(measured.containerDurationSeconds >= 2);
});

test('file TTS 对压缩音频按实际解码计时，文件扩展名不决定音频格式', async () => {
  const source = join(WORK, 'mp3-source.wav'), compressed = join(WORK, 'compressed-with-wav-extension.wav');
  const samples = 44113, sampleRate = 44100;
  wav(source, samples, sampleRate);
  ffmpeg(['-i', source, '-c:a', 'libmp3lame', '-f', 'mp3', compressed]);
  const original = readFileSync(compressed);
  const measured = await probeAudio(compressed);
  assert.equal(measured.durationSamples, samples);
  assert.ok(measured.containerDurationSeconds > measured.durationSeconds);
  const result = await createFileTtsProvider(() => compressed).synthesize({ ...request, outPath: join(WORK, 'compressed-copy.wav') });
  assert.equal(result.durationSeconds, samples / sampleRate);
  assert.equal(result.sampleRate, sampleRate);
  assert.deepEqual(readFileSync(compressed), original);
  assert.deepEqual(readFileSync(result.path), original);
});

test('file TTS 拒绝损坏文件和空音轨，失败保留源文件并保持输出未生成', async () => {
  const corrupt = join(WORK, 'corrupt.wav'), truncated = join(WORK, 'truncated.wav'), empty = join(WORK, 'empty.wav');
  writeFileSync(corrupt, 'invalid audio');
  writeFileSync(truncated, wav(truncated, 24000, 24000).subarray(0, 75));
  wav(empty, 0, 24000);
  for (const source of [corrupt, truncated, empty]) {
    const original = readFileSync(source), outPath = `${source}.copy.wav`;
    await assert.rejects(createFileTtsProvider(() => source).synthesize({ ...request, outPath }), /AUDIO_PROBE_FAILED/);
    assert.deepEqual(readFileSync(source), original);
    assert.equal(existsSync(outPath), false);
  }
});

test('file TTS 拒绝无音轨媒体', async () => {
  const source = join(WORK, 'video-only.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=16x16:r=10:d=0.2', '-an', '-c:v', 'ffv1', source]);
  await assert.rejects(createFileTtsProvider(() => source).synthesize({ ...request, outPath: join(WORK, 'video-copy.wav') }), /AUDIO_PROBE_FAILED/);
});

test('file TTS 的同路径、软链接与硬链接输出都无法覆盖原件', async () => {
  const source = join(WORK, 'protected-source.wav');
  const original = wav(source, 12000, 24000);
  const soft = join(WORK, 'soft-output.wav'), hard = join(WORK, 'hard-output.wav');
  symlinkSync(source, soft); linkSync(source, hard);
  for (const outPath of [source, join(WORK, '.', 'protected-source.wav'), soft, hard]) {
    await assert.rejects(createFileTtsProvider(() => source).synthesize({ ...request, outPath }), /AUDIO_SOURCE_OVERWRITE/);
    assert.deepEqual(readFileSync(source), original);
  }
});

test('正式制作保留单文件配音无法映射多句脚本的拒绝条件', async () => {
  const fixture = createFixtureProject();
  try {
    const spec = validateSpec(loadSpecFile(fixture.specPath)).spec;
    assert.ok(spec);
    spec.audio.narration = [{ start: 0, text: '第一句。', voice: 'female_calm' }, { start: 4, text: '第二句。', voice: 'female_calm' }];
    const source = join(WORK, 'multi-line.wav'); wav(source, 24000, 24000);
    await assert.rejects(buildAudio({ spec, workDir: join(WORK, 'multi-line-build'), strictNarration: true, tts: { provider: 'file', allowNetwork: false, voiceAssetPath: source } }), /NARRATION_REQUIRED: 单文件配音/);
  } finally { fixture.cleanup(); }
});
