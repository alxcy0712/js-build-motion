import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { validateAudioInputRuntime } from './src/project/audio-input.ts';

const hash = data => createHash('sha256').update(data).digest('hex');
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
function run(program, args) {
  const result = spawnSync(program, args, { env: environment, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error('LINUX_MEDIA_TOOL_FAILED: ' + program + ': ' + (result.error ?? result.stderr));
  return result.stdout;
}
function file(path) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || realpathSync(path) !== path) throw Error('LINUX_MEDIA_FILE_INVALID: ' + path);
  const data = readFileSync(path), after = lstatSync(path, { bigint: true });
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]) || BigInt(data.length) !== before.size) throw Error('LINUX_MEDIA_FILE_CHANGED: ' + path);
  return { path, bytes: data.length, sha256: hash(data) };
}
/** ldd reports the transitive ELF loader closure under the same scrubbed environment. */
export function linuxLibraryPaths(output) {
  if (/not found/.test(output)) throw Error('LINUX_MEDIA_LIBRARY_MISSING');
  return [...new Set(output.split('\n').flatMap(line => {
    const match = /^\s*(?:\S+\s+=>\s+)?(\/.*?)\s+\(0x[\da-f]+\)\s*$/i.exec(line);
    return match ? [match[1]] : [];
  }))].sort();
}
export function captureLinuxMediaTools() {
  if (process.platform !== 'linux') throw Error('LINUX_HOST_REQUIRED');
  const tools = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const logical = ['/usr/local/bin', '/usr/bin', '/bin'].map(dir => join(dir, name)).find(path => {
      try { return lstatSync(realpathSync(path)).isFile(); } catch { return false; }
    });
    if (!logical) throw Error('LINUX_MEDIA_TOOL_MISSING: ' + name);
    const executable = realpathSync(logical), libraries = linuxLibraryPaths(run('/usr/bin/ldd', [executable]));
    if (!libraries.length) throw Error('LINUX_MEDIA_ELF_CLOSURE_REQUIRED: ' + name);
    const aliases = [...new Set([logical, executable, ...libraries])].sort().map(path => ({ path, realpath: realpathSync(path) }));
    tools[name] = { executable, version: run(executable, ['-version']).split('\n')[0],
      files: [...new Set(aliases.map(alias => alias.realpath))].sort().map(file), aliases };
  }
  return { version: '0.1', kind: 'linux-media-dependencies', platform: process.platform, arch: process.arch, tools };
}
export function linuxMediaRuntimeIdentity(engine) {
  const data = readFileSync(join(engine, 'media-dependencies.lock.json')), lock = JSON.parse(data);
  if (lock.kind !== 'linux-media-dependencies' || lock.version !== '0.1' || lock.platform !== 'linux' || lock.platform !== process.platform || lock.arch !== process.arch) throw Error('LINUX_MEDIA_LOCK_INVALID');
  const runtime = validateAudioInputRuntime({ id: 'bounded-audio-input', version: '0.1', lockSha256: hash(data), platform: lock.platform, arch: lock.arch, tools: lock.tools });
  // Rediscovery detects new loader dependencies as well as changed bytes and aliases.
  if (JSON.stringify(captureLinuxMediaTools()) !== JSON.stringify(lock)) throw Error('LINUX_MEDIA_RUNTIME_CHANGED');
  return runtime;
}
