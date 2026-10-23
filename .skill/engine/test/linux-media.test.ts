import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxLibraryPaths, captureLinuxMediaTools } from '../native-media.mjs';
import { validateAudioInputRuntime } from '../src/project/audio-input.ts';

test('Linux loader closure includes aliases and interpreter; missing libraries fail closed', () => {
  const paths = linuxLibraryPaths(' linux-vdso.so.1 (0x0000)\n libavcodec.so.61 => /lib/x86_64-linux-gnu/libavcodec.so.61 (0xabcd)\n /lib64/ld-linux-x86-64.so.2 (0xbcde)\n');
  assert.deepEqual(paths, ['/lib/x86_64-linux-gnu/libavcodec.so.61', '/lib64/ld-linux-x86-64.so.2']);
  assert.throws(() => linuxLibraryPaths('libcodec => not found'), /LIBRARY_MISSING/);
  const tool = { executable: '/usr/bin/ffmpeg', version: 'fixture', files: [{ path: '/usr/bin/ffmpeg', bytes: 1, sha256: 'b'.repeat(64) }], aliases: [{ path: '/usr/bin/ffmpeg', realpath: '/usr/bin/ffmpeg' }] };
  assert.equal(validateAudioInputRuntime({ id: 'bounded-audio-input', version: '0.1', lockSha256: 'a'.repeat(64),
    platform: 'linux', arch: 'x64', tools: { ffmpeg: tool, ffprobe: tool } }).platform, 'linux');
});

test('Linux media identity captures actual native tools', { skip: process.platform !== 'linux' ? 'requires an actual Linux host' : false }, () => {
  const lock = captureLinuxMediaTools();
  for (const tool of Object.values(lock.tools) as { executable: string; files: {path: string}[]; aliases: unknown[] }[]) {
    assert.ok(tool.files.some(file => file.path === tool.executable)); assert.ok(tool.files.length > 1); assert.ok(tool.aliases.length > 1);
  }
});
