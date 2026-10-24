import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSampledMusicScore } from '../src/audio/bgm/sampled-score.ts';
import { encodeWav16 } from '../src/audio/bgm/procedural.ts';
import type { MusicScore } from '../src/audio/bgm/score.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

function fixture(run: (dir: string, bank: any, score: MusicScore, save: () => string) => void): void {
  const parent = join(PROJECT_ROOT, '.research/out'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'music-samples-'));
  try {
    const make = (value: number) => encodeWav16({ left: new Float32Array(48000).fill(value),
      right: new Float32Array(48000).fill(value / 2), sampleRate: 48000, durationSeconds: 1 });
    const samples = [.5, 1].map((velocity, i) => {
      const file = `layer-${i}.wav`, wav = make(i ? -.2 : .1); writeFileSync(join(dir, file), wav);
      return { instrument: 'piano', file, sha256: createHash('sha256').update(wav).digest('hex'), pitch: 60, velocity };
    });
    const bank = { version: '1', name: 'Original test signals', source: 'generated fixture', license: 'test-only', samples };
    const score: MusicScore = { version: '1', durationSeconds: 2, seed: 42,
      voices: { piano: { instrument: 'piano', gain: 1, pan: 0 } },
      notes: [{ id: 'soft', voice: 'piano', start: .1, duration: .6, pitch: 60, velocity: .5 },
        { id: 'hard', voice: 'piano', start: 1, duration: .6, pitch: 60, velocity: 1 }] };
    const save = () => { const path = join(dir, 'bank.json'); writeFileSync(path, JSON.stringify(bank)); return path; };
    run(dir, bank, score, save);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('sample playback preserves recorded PCM, stereo, velocity layers and authored silence', () => fixture((dir, bank, score, save) => {
  const result = renderSampledMusicScore(score, save()), { audio } = result;
  assert.equal(audio.left.length, 96000);
  for (const [time, layer] of [[.3, 0], [1.2, 1]]) {
    const wav = readFileSync(join(dir, `layer-${layer}.wav`));
    assert.ok(Math.abs(audio.left[Math.round(time * 48000)]! - wav.readInt16LE(44) / 32768) < 1e-7);
    assert.ok(Math.abs(audio.right[Math.round(time * 48000)]! - wav.readInt16LE(46) / 32768) < 1e-7);
  }
  assert.ok(audio.left.slice(33600, 48000).every(v => v === 0));
  assert.equal(result.bank.samples.length, 2);
  const before = encodeWav16(audio); score.notes.reverse();
  assert.deepEqual(encodeWav16(renderSampledMusicScore(score, save()).audio), before);
}));

test('nearest velocity precedes key distance and pan preserves authored balance', () => fixture((dir, bank, score, save) => {
  bank.samples[1].pitch = 61;
  score.notes = [{ ...score.notes[0]!, pitch: 61 }];
  const { audio } = renderSampledMusicScore(score, save());
  assert.ok(audio.left[14400]! > .09, 'quiet note must use positive soft layer despite hard layer exact key');
  score.voices.piano!.pan = -1;
  const panned = renderSampledMusicScore(score, save()).audio;
  assert.ok(panned.right.every(v => v === 0));
  assert.ok(Math.abs(panned.left[14400]! / audio.left[14400]! - Math.SQRT2) < 1e-6);
}));

test('a nearby recorded key is shifted by the requested interval while onset remains sample accurate', () => fixture((dir, bank, score, save) => {
  const samples = Float32Array.from({ length: 48000 }, (_, i) => .2 * Math.sin(2 * Math.PI * 220 * i / 48000));
  const wav = encodeWav16({ left: samples, right: samples, sampleRate: 48000, durationSeconds: 1 });
  writeFileSync(join(dir, bank.samples[0].file), wav);
  bank.samples[0].sha256 = createHash('sha256').update(wav).digest('hex');
  score.notes = [{ ...score.notes[0]!, pitch: 61 }];
  const audio = renderSampledMusicScore(score, save()).audio;
  assert.ok(audio.left.slice(0, 4800).every(v => v === 0));
  let cycles = 0;
  for (let i = 6000; i < 20400; i++) if (audio.left[i]! <= 0 && audio.left[i + 1]! > 0) cycles++;
  assert.ok(Math.abs(cycles / .3 - 220 * 2 ** (1 / 12)) < 4);
}));

test('sample mode rejects missing instruments, distant keys, changed bytes and escaped files', () => fixture((dir, bank, score, save) => {
  score.voices.piano!.instrument = 'strings';
  assert.throws(() => renderSampledMusicScore(score, save()), /MUSIC_SAMPLE_MISSING/);
  score.voices.piano!.instrument = 'piano'; score.notes[0]!.pitch = 80;
  assert.throws(() => renderSampledMusicScore(score, save()), /MUSIC_SAMPLE_MISSING/);
  score.notes[0]!.pitch = 60;
  const original = bank.samples[0].sha256; bank.samples[0].sha256 = '0'.repeat(64);
  assert.throws(() => renderSampledMusicScore(score, save()), /MUSIC_SAMPLE_HASH/);
  bank.samples[0].sha256 = original;
  symlinkSync(join(PROJECT_ROOT, 'package.json'), join(dir, 'outside.wav'));
  bank.samples[0].file = 'outside.wav';
  assert.throws(() => renderSampledMusicScore(score, save()), /MUSIC_SAMPLE_PATH/);
}));

test('sample CLI binds the selected bank and recordings to output; protects score/receipt collisions', () => fixture((dir, bank, score, save) => {
  const bankPath = save(), input = join(dir, 'score.json'), output = join(dir, 'music.wav');
  writeFileSync(input, JSON.stringify(score));
  const cli = join(PROJECT_ROOT, 'scripts/compose-music.ts');
  const result = spawnSync(process.execPath, [cli, input, output, '--samples', bankPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output + '.json', 'utf8'));
  assert.equal(receipt.renderer, 'recorded-samples');
  assert.equal(receipt.sampleBank.sha256, createHash('sha256').update(readFileSync(bankPath)).digest('hex'));
  assert.deepEqual(receipt.sampleBank.samples, bank.samples);
  assert.equal(receipt.subjectiveListening, 'pending');
  const collision = join(dir, 'protected.wav.json'), original = JSON.stringify(score); writeFileSync(collision, original);
  const denied = spawnSync(process.execPath, [cli, collision, join(dir, 'protected.wav')], { encoding: 'utf8' });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /MUSIC_OUTPUT/);
  assert.equal(readFileSync(collision, 'utf8'), original);
}));
