import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DEFAULT_AUDIO_INPUT_LIMITS, validateAudioInputFacts, validateAudioInputMap, type AudioInputFacts } from '../src/project/audio-input.ts';
import { DEFAULT_INSPECT_POLICY, INSPECT_POLICY_05, adoptInspectPolicy, assertInspectPolicy, audioInputLimits } from '../src/project/catalog.ts';
import { DEFAULT_ALIGNMENT_POLICY, ALIGNMENT_POLICY_02, assertAlignment } from '../src/project/alignment.ts';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const facts: AudioInputFacts = { version: '0.1', kind: 'audio-input-facts', format: 'wav', demuxer: 'wav', codec: 'pcm_s16le', sampleRate: 8000,
  channels: 2, bitsPerSample: 16, samples: 1600, sampleDomain: 'complete-decoded-frames', codedFrames: null, metadataFrames: 0, payloadBytes: 6400, gapless: null, edit: null };
test('explicit container policies preserve frozen historical defaults and adoption', () => {
  assert.equal(DEFAULT_INSPECT_POLICY.version, '0.4'); assert.equal(DEFAULT_ALIGNMENT_POLICY.version, '0.1');
  const enabled = { ...DEFAULT_INSPECT_POLICY, asr: { ...DEFAULT_INSPECT_POLICY.asr, enabled: true, language: 'en' as const } };
  assert.deepEqual(adoptInspectPolicy(enabled), enabled); assert.deepEqual(adoptInspectPolicy(INSPECT_POLICY_05), INSPECT_POLICY_05);
  assert.equal(audioInputLimits({ ...INSPECT_POLICY_05, maxDecodedAudioBytes: 1 }).maxPcmBytes, DEFAULT_AUDIO_INPUT_LIMITS.maxPcmBytes);
  assert.deepEqual(adoptInspectPolicy(enabled, '0.5'), { ...enabled, version: '0.5', audioInput: DEFAULT_AUDIO_INPUT_LIMITS });
  assert.throws(() => adoptInspectPolicy(INSPECT_POLICY_05, '0.4'), /VERSION_INVALID/);
  assert.equal(assertAlignment<any>('policy', ALIGNMENT_POLICY_02).version, '0.2');
  for (const [key, cap] of Object.entries(DEFAULT_AUDIO_INPUT_LIMITS)) {
    assert.throws(() => assertInspectPolicy({ ...INSPECT_POLICY_05, audioInput: { ...INSPECT_POLICY_05.audioInput, [key]: cap + 1 } }), /INVALID/);
  }
  assert.throws(() => assertInspectPolicy({ ...INSPECT_POLICY_05, audioInput: { ...INSPECT_POLICY_05.audioInput, maxSamples: 3199 } }), /INVALID/);
  assert.throws(() => assertInspectPolicy({ ...INSPECT_POLICY_05, audioInput: { ...INSPECT_POLICY_05.audioInput, extra: true } }), /INVALID/);
});
test('complete frame facts enforce duration, format relations and bounded structure', () => {
  assert.deepEqual(validateAudioInputFacts(facts, DEFAULT_AUDIO_INPUT_LIMITS), facts);
  for (const patch of [{ samples: 1599 }, { codec: 'aac' }, { codedFrames: 1 }, { metadataFrames: 1 }, { payloadBytes: 6398 }, { presentationDuration: 0.2 }])
    assert.throws(() => validateAudioInputFacts({ ...facts, ...patch }, DEFAULT_AUDIO_INPUT_LIMITS), /INVALID/);
  const mp3 = { ...facts, format: 'mp3', demuxer: 'mp3', codec: 'mp3', bitsPerSample: null, sampleRate: 44100, samples: 9 * 1152, codedFrames: 9, metadataFrames: 1, payloadBytes: 5000, gapless: { delaySamples: 576, paddingSamples: 12 } };
  assert.doesNotThrow(() => validateAudioInputFacts(mp3, DEFAULT_AUDIO_INPUT_LIMITS));
  assert.throws(() => validateAudioInputFacts({ ...mp3, samples: mp3.samples - 576 }, DEFAULT_AUDIO_INPUT_LIMITS), /RELATION_INVALID/);
  assert.throws(() => validateAudioInputFacts({ ...mp3, metadataFrames: 0 }, DEFAULT_AUDIO_INPUT_LIMITS), /RELATION_INVALID/);
  assert.throws(() => validateAudioInputFacts({ ...mp3, sampleRate: 16000, samples: 4608, codedFrames: 8, gapless: { delaySamples: 4095, paddingSamples: 513 } }, DEFAULT_AUDIO_INPUT_LIMITS), /RELATION_INVALID/);
  const flac = { ...facts, format: 'flac', demuxer: 'flac', codec: 'flac', sampleRate: 16000, samples: 3200, codedFrames: 1, payloadBytes: 6400 };
  assert.doesNotThrow(() => validateAudioInputFacts(flac, DEFAULT_AUDIO_INPUT_LIMITS));
  for (const patch of [{ codedFrames: 201 }, { samples: 65536 }]) assert.throws(() => validateAudioInputFacts({ ...flac, ...patch }, DEFAULT_AUDIO_INPUT_LIMITS), /RELATION_INVALID/);
});
test('common map binds original PCM and 16k canonical bytes with full decoded frame coverage', () => {
  const pcm = Buffer.alloc(3200), wav = Buffer.alloc(6444), probe = Buffer.from('{}');
  wav.write('RIFF'); wav.writeUInt32LE(6436, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(6400, 40);
  const id = 'evidence-00000000-0000-4000-8000-000000000001', entry = (data: Buffer) => ({ evidenceId: id, bytes: data.length, sha256: sha(data) });
  const native = { executable: '/opt/homebrew/bin/ffmpeg', version: '7.1', files: [{ path: '/opt/homebrew/bin/ffmpeg', bytes: 1, sha256: 'a'.repeat(64) }], aliases: [{ path: '/opt/homebrew/bin/ffmpeg', realpath: '/opt/homebrew/bin/ffmpeg' }] };
  const run = { executable: native.executable, version: '7.1', argv: [], exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, binaryBytes: 0, elapsedMs: 1, error: null };
  const map = { version: '0.1', kind: 'audio-input-map', mapperVersion: 'audio-input@0.1', policySha256: 'b'.repeat(64), source: { bytes: 6444, sha256: 'c'.repeat(64) }, input: facts,
    runtime: { id: 'bounded-audio-input', version: '0.1', lockSha256: 'd'.repeat(64), platform: 'darwin', arch: 'arm64', tools: { ffmpeg: native, ffprobe: native } },
    probe: entry(probe), sourcePcm: { ...entry(pcm), sampleRate: 8000, samples: 1600 }, audio: { ...entry(wav), payloadBytes: 6400, sampleRate: 16000, samples: 3200 },
    commands: { probe: run, decode: run, normalize: run }, cwd: '/film/out/.tmp/audio-fixture', coverage: { scope: 'complete-decoded-frames', complete: true, start: 0, end: 1600, presentationMapping: 'unknown' } };
  assert.doesNotThrow(() => validateAudioInputMap(map, probe, pcm, wav, DEFAULT_AUDIO_INPUT_LIMITS));
  for (const patch of [{ coverage: { ...map.coverage, end: 1599 } }, { sourcePcm: { ...map.sourcePcm, samples: 3200 } }, { audio: { ...map.audio, payloadBytes: 3200 } }, { duration: 0.2 }])
    assert.throws(() => validateAudioInputMap({ ...map, ...patch }, probe, pcm, wav, DEFAULT_AUDIO_INPUT_LIMITS), /INVALID/);
  const altered = Buffer.from(wav); altered[altered.length - 1] ^= 1;
  assert.throws(() => validateAudioInputMap(map, probe, pcm, altered, DEFAULT_AUDIO_INPUT_LIMITS), /IDENTITY_INVALID/);
});
