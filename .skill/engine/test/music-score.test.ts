import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MUSIC_INSTRUMENTS, parseMusicScore, renderMusicScore, type MusicScore } from '../src/audio/bgm/score.ts';
import { encodeWav16 } from '../src/audio/bgm/procedural.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const score = (): MusicScore => ({ version: '1', durationSeconds: 2, seed: 42,
  voices: { lead: { instrument: 'piano', gain: .6, pan: 0 } },
  notes: [{ id: 'first', voice: 'lead', start: .2, duration: .7, pitch: 69, velocity: .8 },
    { id: 'answer', voice: 'lead', start: 1.25, duration: .5, pitch: 72, velocity: .5 }] });

test('authored timing preserves delayed entrances, irregular phrases and exact silence', () => {
  const audio = renderMusicScore(score());
  assert.equal(audio.left.length, 96000);
  for (const [from, to] of [[0, .2], [.9, 1.25], [1.75, 2]]) {
    assert.ok(audio.left.slice(Math.ceil(from * 48000), Math.floor(to * 48000)).every(v => v === 0));
  }
  assert.ok(audio.left.slice(9601, 43200).some(v => Math.abs(v) > .01));
  assert.equal(audio.left[0], 0); assert.equal(audio.right.at(-1), 0);
});

test('instrument families yield distinct finite, bounded PCM at the same pitch and timing', () => {
  const bytes = new Set<string>();
  for (const instrument of MUSIC_INSTRUMENTS) {
    const input = score(); input.voices.lead!.instrument = instrument;
    const audio = renderMusicScore(input);
    let peak = 0;
    for (const v of audio.left) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); }
    assert.ok(peak > .001 && peak <= .9);
    bytes.add(encodeWav16(audio).toString('base64'));
  }
  assert.equal(bytes.size, MUSIC_INSTRUMENTS.length);
});

test('noise is deterministic by note identity, independent of input array order', () => {
  const input = score(); input.voices.lead!.instrument = 'snare';
  const before = structuredClone(input);
  const a = encodeWav16(renderMusicScore(input));
  assert.deepEqual(input, before);
  input.notes.reverse();
  assert.deepEqual(a, encodeWav16(renderMusicScore(input)));
  input.seed++;
  assert.notDeepEqual(a, encodeWav16(renderMusicScore(input)));
});

test('velocity and pan remain authored; quiet phrases are not normalized up', () => {
  const loud = score(); loud.voices.lead!.pan = -1;
  const quiet = structuredClone(loud); quiet.notes.forEach(note => { note.velocity *= .25; });
  const a = renderMusicScore(loud), b = renderMusicScore(quiet);
  assert.ok(a.right.every(v => v === 0));
  for (let i = 0; i < a.left.length; i++) assert.ok(Math.abs(b.left[i]! - a.left[i]! * .25) < 1e-7);
  const dense = score(); dense.notes = Array.from({ length: 100 }, (_, i) => ({ ...dense.notes[0]!, id: `note-${i}` }));
  const result = renderMusicScore(dense);
  assert.ok(result.left.every(v => Math.abs(v) <= .900001));
});

test('score rejects bad instruments, missing voices, duplicate notes and invalid timing before rendering', () => {
  const bad: Array<(s: any) => void> = [
    s => { s.voices.lead.instrument = 'unknown'; }, s => { s.notes[0].voice = 'absent'; },
    s => { s.notes[1].id = 'first'; }, s => { s.notes[0].duration = 3; },
    s => { s.notes[0].start = -.1; }, s => { s.notes[0].pitch = NaN; },
    s => { s.voices.lead.attack = 0; }, s => { s.durationSeconds = Infinity; },
    s => { s.notes[0].velocty = .5; },
  ];
  for (const change of bad) { const input = score(); change(input); assert.throws(() => parseMusicScore(input), /MUSIC_/); }
  const silent = score(); silent.notes = [];
  assert.ok(renderMusicScore(silent).left.every(v => v === 0));
});

test('score CLI writes a playable WAV and a receipt bound to the authored input and actual bytes', () => {
  const parent = join(PROJECT_ROOT, '.research/out'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'music-score-'));
  try {
    const input = join(dir, 'score.json'), output = join(dir, 'music.wav');
    writeFileSync(input, JSON.stringify(score()));
    const command = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/compose-music.ts'), input, output], { encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    const wav = readFileSync(output), receipt = JSON.parse(readFileSync(output + '.json', 'utf8'));
    assert.equal(wav.length, 44 + 96000 * 4);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(receipt.samples, 96000); assert.equal(receipt.subjectiveListening, 'pending');
    assert.equal(receipt.windows.length, 8);
    assert.deepEqual(wav, encodeWav16(renderMusicScore(score())));
    const schema = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts/compose-music.ts'), '--schema'], { encoding: 'utf8' });
    assert.equal(schema.status, 0, schema.stderr); assert.equal(JSON.parse(schema.stdout).type, 'object');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
