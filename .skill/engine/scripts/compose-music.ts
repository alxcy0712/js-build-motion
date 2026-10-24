/** node .engine/scripts/compose-music.ts <src/music-score.json> <assets/generated/music.wav> */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MUSIC_SCORE_SCHEMA, parseMusicScore, renderMusicScore } from '../src/audio/bgm/score.ts';
import { MUSIC_SAMPLE_BANK_SCHEMA, renderSampledMusicScore } from '../src/audio/bgm/sampled-score.ts';
import { encodeWav16 } from '../src/audio/bgm/procedural.ts';

const [source, output, ...extra] = process.argv.slice(2);
if (source === '--schema' && !output) {
  console.log(JSON.stringify(MUSIC_SCORE_SCHEMA, null, 2));
} else if (source === '--sample-schema' && !output) {
  console.log(JSON.stringify(MUSIC_SAMPLE_BANK_SCHEMA, null, 2));
} else {
  if (!source || !output || (extra.length && (extra.length !== 2 || extra[0] !== '--samples'))) throw new Error('USAGE: compose-music.ts <score.json> <music.wav> [--samples bank.json] | --schema | --sample-schema');
  if (!output.endsWith('.wav') || [output, output + '.json'].some(path => [source, extra[1]].some(input => input && resolve(input) === resolve(path)))) throw new Error('MUSIC_OUTPUT: use separate output paths');
  const bytes = readFileSync(source);
  const score = parseMusicScore(JSON.parse(bytes.toString('utf8')));
  const sampled = extra[1] ? renderSampledMusicScore(score, extra[1]) : undefined;
  const audio = sampled?.audio ?? renderMusicScore(score), wav = encodeWav16(audio);
  let peak = 0, square = 0;
  const windows = [];
  const windowSamples = Math.round(audio.sampleRate * .25);
  for (let start = 0; start < audio.left.length; start += windowSamples) {
    const end = Math.min(start + windowSamples, audio.left.length);
    let energy = 0, windowPeak = 0;
    for (let i = start; i < end; i++) {
      const l = audio.left[i]!, r = audio.right[i]!;
      energy += (l * l + r * r) / 2;
      windowPeak = Math.max(windowPeak, Math.abs(l), Math.abs(r));
    }
    square += energy; peak = Math.max(peak, windowPeak);
    windows.push({ start: start / audio.sampleRate, end: end / audio.sampleRate, rms: Math.sqrt(energy / (end - start)), peak: windowPeak });
  }
  const receipt = { version: '1', source, sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    output, sha256: createHash('sha256').update(wav).digest('hex'), sampleRate: audio.sampleRate, channels: 2,
    samples: audio.left.length, durationSeconds: audio.left.length / audio.sampleRate,
    notes: score.notes.length, instruments: [...new Set(Object.values(score.voices).map(voice => voice.instrument))],
    peak, rms: Math.sqrt(square / audio.left.length), windows,
    renderer: sampled ? 'recorded-samples' : 'additive-synthesis', sampleBank: sampled?.bank,
    timingBasis: 'authored', subjectiveListening: 'pending' };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, wav);
  writeFileSync(output + '.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ output, receipt: output + '.json', sha256: receipt.sha256, samples: receipt.samples, peak, instruments: receipt.instruments }));
}
