/** Play an authored score using local recordings of instruments. */
import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { MUSIC_INSTRUMENTS, parseMusicScore, type MusicInstrument, type MusicScore } from './score.ts';
import { SAMPLE_RATE, type SynthResult } from './procedural.ts';

interface InstrumentSample {
  instrument: MusicInstrument;
  file: string;
  sha256: string;
  pitch: number;
  /** Played strength of this recording; nearest velocity layer is selected. */
  velocity: number;
  offsetSeconds?: number;
}
interface SampleBank { version: '1'; name: string; source: string; license: string; samples: InstrumentSample[] }
const text = { type: 'string', minLength: 1 };
export const MUSIC_SAMPLE_BANK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'name', 'source', 'license', 'samples'],
  properties: {
    version: { const: '1' }, name: text, source: text, license: text,
    samples: { type: 'array', minItems: 1, maxItems: 2048, items: {
      type: 'object', additionalProperties: false, required: ['instrument', 'file', 'sha256', 'pitch', 'velocity'],
      properties: { instrument: { enum: [...MUSIC_INSTRUMENTS] }, file: text,
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        pitch: { type: 'number', minimum: 12, maximum: 108 },
        velocity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        offsetSeconds: { type: 'number', minimum: 0, maximum: 60 },
      },
    } },
  },
} as const;
const validate = new Ajv({ allErrors: true, strict: true }).compile(MUSIC_SAMPLE_BANK_SCHEMA);
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export function renderSampledMusicScore(input: MusicScore, bankPath: string): {
  audio: SynthResult;
  bank: { name: string; source: string; license: string; sha256: string; samples: InstrumentSample[] };
} {
  const score = parseMusicScore(input), bytes = readFileSync(bankPath);
  const bank: SampleBank = JSON.parse(bytes.toString('utf8'));
  if (!validate(bank)) throw new Error(`MUSIC_SAMPLE_BANK_INVALID: ${JSON.stringify(validate.errors)}`);
  const root = realpathSync(dirname(bankPath));
  const cache = new Map<string, Buffer>(), used = new Map<string, InstrumentSample>();
  const size = Math.ceil(score.durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(size), right = new Float32Array(size);
  const notes = [...score.notes].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const note of notes) {
    const voice = score.voices[note.voice]!;
    // A nearby recorded key preserves its acoustic character. Missing coverage is explicit.
    const candidates = bank.samples.filter(s => s.instrument === voice.instrument && Math.abs(s.pitch - note.pitch) <= 3);
    candidates.sort((a, b) => Math.abs(a.velocity - note.velocity) - Math.abs(b.velocity - note.velocity)
      || Math.abs(a.pitch - note.pitch) - Math.abs(b.pitch - note.pitch));
    const sample = candidates[0];
    if (!sample) throw new Error(`MUSIC_SAMPLE_MISSING: ${voice.instrument} pitch ${note.pitch}`);
    if (note.velocity === 0 || voice.gain === 0) continue;
    const shift = note.pitch - sample.pitch, key = `${sample.file}\0${sample.sha256}\0${shift}\0${sample.offsetSeconds ?? 0}`;
    let pcm = cache.get(key);
    if (!pcm) {
      const path = realpathSync(resolve(root, sample.file)), local = relative(root, path);
      if (isAbsolute(sample.file) || local.startsWith('..') || isAbsolute(local)) throw new Error('MUSIC_SAMPLE_PATH: use files inside the bank directory');
      const format = extname(path).toLowerCase().slice(1);
      if (format !== 'wav' && format !== 'flac') throw new Error('MUSIC_SAMPLE_FORMAT: use WAV or FLAC recordings');
      if (hash(readFileSync(path)) !== sample.sha256) throw new Error(`MUSIC_SAMPLE_HASH: ${sample.file}`);
      // Resampling uses FFmpeg's band-limited filter; no oscillators or effects are added.
      const filters = [`aresample=${SAMPLE_RATE}`];
      if (sample.offsetSeconds) filters.push(`atrim=start=${sample.offsetSeconds}`, 'asetpts=N/SR/TB');
      if (shift !== 0) filters.push(`asetrate=${Math.round(SAMPLE_RATE * 2 ** (shift / 12))}`, `aresample=${SAMPLE_RATE}`);
      const decoded = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
        '-f', format, '-i', path, '-map', '0:a:0', '-vn', '-af', filters.join(','), '-ac', '2', '-f', 'f32le', 'pipe:1'],
      { maxBuffer: 64 * 1024 * 1024 });
      if (decoded.error || decoded.status !== 0) throw new Error(`MUSIC_SAMPLE_DECODE: ${sample.file}: ${decoded.error?.message ?? decoded.stderr.toString()}`);
      pcm = decoded.stdout;
      if (pcm.length < 16 || pcm.length % 8) throw new Error(`MUSIC_SAMPLE_EMPTY: ${sample.file}`);
      for (let i = 0; i < pcm.length; i += 4) if (!Number.isFinite(pcm.readFloatLE(i))) throw new Error(`MUSIC_SAMPLE_NONFINITE: ${sample.file}`);
      cache.set(key, pcm);
    }
    used.set(JSON.stringify(sample), sample);
    const start = Math.round(note.start * SAMPLE_RATE), frames = pcm.length / 8;
    const count = Math.min(Math.ceil(note.duration * SAMPLE_RATE), frames, size - start);
    const attack = Math.min(count * .3, (voice.attack ?? .001) * SAMPLE_RATE);
    const release = Math.min(count * .4, (voice.release ?? .15) * SAMPLE_RATE);
    const gain = voice.gain * note.velocity / sample.velocity;
    // Balance the existing stereo image; center retains both recorded channels.
    const gl = gain * Math.sqrt(1 - voice.pan), gr = gain * Math.sqrt(1 + voice.pan);
    for (let i = 0; i < count; i++) {
      const envelope = Math.sin(Math.min(1, i / attack) * Math.PI / 2) ** 2
        * Math.sin(Math.min(1, (count - 1 - i) / release) * Math.PI / 2) ** 2;
      left[start + i] += pcm.readFloatLE(i * 8) * gl * envelope;
      right[start + i] += pcm.readFloatLE(i * 8 + 4) * gr * envelope;
    }
  }
  let peak = 0;
  for (let i = 0; i < size; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  const gain = peak > .9 ? .9 / peak : 1, edge = Math.min(240, size / 2);
  for (let i = 0; i < size; i++) {
    const fade = Math.min(1, i / edge, (size - 1 - i) / edge);
    left[i] *= gain * fade; right[i] *= gain * fade;
  }
  return { audio: { left, right, sampleRate: SAMPLE_RATE, durationSeconds: score.durationSeconds },
    bank: { name: bank.name, source: bank.source, license: bank.license, sha256: hash(bytes), samples: [...used.values()] } };
}
