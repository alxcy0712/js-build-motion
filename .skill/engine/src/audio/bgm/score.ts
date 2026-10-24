/** Model-authored music: explicit voices and note times, rendered to deterministic PCM. */
import { Ajv } from 'ajv';
import { SeededRandom } from '../../animation/random.ts';
import { SAMPLE_RATE, type SynthResult } from './procedural.ts';

export const MUSIC_INSTRUMENTS = ['piano', 'electric_piano', 'mallet', 'bell', 'pluck', 'reed', 'strings', 'pad', 'bass', 'kick', 'snare', 'hat', 'noise'] as const;
export type MusicInstrument = (typeof MUSIC_INSTRUMENTS)[number];

export interface MusicVoice {
  instrument: MusicInstrument;
  gain: number;
  pan: number;
  brightness?: number;
  attack?: number;
  release?: number;
}
export interface MusicNote {
  id: string;
  voice: string;
  /** Absolute seconds; the author can use changing tempos, meters and deliberate silence. */
  start: number;
  /** Total sounding duration, including attack and release. */
  duration: number;
  /** MIDI pitch; fractional pitches support detuning. Drums use it as their body pitch. */
  pitch: number;
  velocity: number;
}
export interface MusicScore {
  version: '1';
  durationSeconds: number;
  seed: number;
  voices: Record<string, MusicVoice>;
  notes: MusicNote[];
}

const number = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const id = { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' };
export const MUSIC_SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'durationSeconds', 'seed', 'voices', 'notes'],
  properties: {
    version: { const: '1' }, durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 600 },
    seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
    voices: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: id,
      additionalProperties: { type: 'object', additionalProperties: false, required: ['instrument', 'gain', 'pan'], properties: {
        instrument: { enum: [...MUSIC_INSTRUMENTS] }, gain: number(0, 1), pan: number(-1, 1),
        brightness: number(0, 1), attack: number(0.001, 2), release: number(0.005, 8),
      } } },
    notes: { type: 'array', maxItems: 20000, items: {
      type: 'object', additionalProperties: false, required: ['id', 'voice', 'start', 'duration', 'pitch', 'velocity'],
      properties: { id, voice: id, start: number(0, 600), duration: { type: 'number', exclusiveMinimum: 0, maximum: 600 },
        pitch: number(12, 108), velocity: number(0, 1) },
    } },
  },
} as const;
const validate = new Ajv({ allErrors: true, strict: true }).compile(MUSIC_SCORE_SCHEMA);

export function parseMusicScore(value: unknown): MusicScore {
  if (!validate(value)) throw new Error(`MUSIC_SCORE_INVALID: ${JSON.stringify(validate.errors)}`);
  const score = value as MusicScore;
  const ids = new Set<string>();
  for (const note of score.notes) {
    if (ids.has(note.id)) throw new Error(`MUSIC_NOTE_DUPLICATE: ${note.id}`);
    ids.add(note.id);
    if (!Object.hasOwn(score.voices, note.voice)) throw new Error(`MUSIC_VOICE_MISSING: ${note.voice}`);
    if (note.start >= score.durationSeconds || note.start + note.duration > score.durationSeconds + 1e-8) {
      throw new Error(`MUSIC_NOTE_OUTSIDE_SCORE: ${note.id}`);
    }
  }
  return score;
}

/** Ratio, amplitude, decay seconds; zero decay denotes a sustained partial. */
type Partial = readonly [number, number, number];
const PARTIALS: Partial[][] = [
  [[1, 1, 2.2], [2, .42, .8], [3, .2, .4], [4, .1, .24], [6, .04, .12]], // piano
  [[1, 1, 2.4], [2, .25, 1.1], [3, .12, .4], [7, .07, .12]], // electric piano
  [[1, 1, .45], [4, .35, .08], [9.96, .13, .035]], // struck bar
  [[1, 1, 2.8], [2.756, .45, 1.2], [5.404, .2, .45], [8.933, .08, .2]], // bell
  [[1, 1, .75], [2, .5, .32], [3, .3, .17], [4, .18, .09], [5, .08, .05]], // pluck
  [[1, 1, 0], [3, .35, 0], [5, .14, 0], [7, .06, 0]], // reed
  [[1, .7, 0], [2, .35, 0], [3, .22, 0], [4, .13, 0], [5, .07, 0]], // strings
  [[1, 1, 0], [2, .14, 0], [3, .06, 0]], // pad
  [[1, 1, 0], [2, .25, 0], [3, .08, 0]], // bass
];

export function renderMusicScore(input: MusicScore): SynthResult {
  const score = parseMusicScore(input);
  const size = Math.ceil(score.durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(size), right = new Float32Array(size);
  // Canonical ordering gives identical PCM after an editor reorders the JSON notes.
  const notes = [...score.notes].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const note of notes) {
    const voice = score.voices[note.voice]!;
    const instrument = MUSIC_INSTRUMENTS.indexOf(voice.instrument);
    const frequency = 440 * 2 ** ((note.pitch - 69) / 12);
    const rng = new SeededRandom(score.seed).fork(note.id);
    const bright = voice.brightness ?? .5;
    const sustained = instrument >= 5 && instrument <= 8;
    const attack = Math.min(note.duration * .3, voice.attack ?? (instrument === 6 ? .12 : instrument === 7 ? .25 : .004));
    const release = Math.min(note.duration * .4, voice.release ?? (sustained ? .18 : .025));
    const gain = voice.gain * note.velocity * .22;
    const gl = gain * Math.sqrt((1 - voice.pan) / 2), gr = gain * Math.sqrt((1 + voice.pan) / 2);
    const start = Math.round(note.start * SAMPLE_RATE);
    const count = Math.min(Math.ceil(note.duration * SAMPLE_RATE), size - start);
    const partials = (PARTIALS[instrument] ?? []).filter(([ratio]) => frequency * ratio < SAMPLE_RATE * .45);
    let previousNoise = 0, lowNoise = 0;
    for (let i = 0; i < count; i++) {
      const t = i / SAMPLE_RATE, phase = 2 * Math.PI * frequency * t;
      const envelope = Math.sin(Math.min(1, t / attack) * Math.PI / 2) ** 2
        * Math.sin(Math.min(1, Math.max(0, (note.duration - t) / release)) * Math.PI / 2) ** 2;
      let sample = 0;
      if (instrument < 9) {
        for (const [ratio, amplitude, decay] of partials) {
          const level = amplitude * (ratio === 1 ? 1 : .25 + bright * 1.5);
          sample += Math.sin(phase * ratio) * level * (decay ? Math.exp(-t / decay) : 1);
        }
        if (instrument === 6 || instrument === 7) sample = sample * .7 + Math.sin(phase * 1.002) * .16 + Math.sin(phase * .998) * .14;
        if (instrument === 5) sample *= .93 + .07 * Math.sin(2 * Math.PI * 4.8 * t);
      } else {
        const noise = rng.next() * 2 - 1, high = noise - previousNoise;
        previousNoise = noise;
        lowNoise += (.03 + bright * .25) * (noise - lowNoise);
        if (instrument === 9) {
          // Integrated pitch sweep keeps the bass drum's phase continuous.
          sample = Math.sin(2 * Math.PI * (frequency * t + 3 * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 12)
            + noise * bright * .12 * Math.exp(-t * 110);
        } else if (instrument === 10) {
          sample = (high * (.25 + bright * .35) + Math.sin(phase) * .4) * Math.exp(-t * 20);
        } else if (instrument === 11) sample = high * .5 * Math.exp(-t * (18 + 45 * (1 - bright)));
        else sample = lowNoise * 2;
      }
      left[start + i] += sample * envelope * gl;
      right[start + i] += sample * envelope * gr;
    }
  }
  // Preserve authored dynamics; attenuate only when the complete mix exceeds headroom.
  let peak = 0;
  for (let i = 0; i < size; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  const gain = peak > .9 ? .9 / peak : 1;
  const edge = Math.min(240, size / 2);
  for (let i = 0; i < size; i++) {
    const fade = Math.min(1, i / edge, (size - 1 - i) / edge);
    left[i] *= gain * fade; right[i] *= gain * fade;
  }
  return { left, right, sampleRate: SAMPLE_RATE, durationSeconds: score.durationSeconds };
}
