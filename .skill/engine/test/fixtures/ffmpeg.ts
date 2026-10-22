import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Fixture generation only; production tool identity and closure checks stay at their callers. */
export function testFfmpeg(env: NodeJS.ProcessEnv = process.env): { executable: string; version: string } {
  const configured = env.FFMPEG_PATH;
  const candidates = configured?.includes('/') ? [resolve(configured)]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(join(dir, configured || 'ffmpeg')));
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      const executable = realpathSync(candidate);
      if (!statSync(executable).isFile()) throw Error('expected an executable file');
      const run = spawnSync(executable, ['-version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
      if (run.error || run.status !== 0) throw Error(`${run.error?.message ?? run.signal ?? run.status}: ${run.stderr?.trim()}`);
      const version = run.stdout.split('\n')[0]!.trim();
      if (!version.startsWith('ffmpeg version ')) throw Error('unrecognized ffmpeg -version output');
      process.stderr.write(`TEST_FFMPEG: ${JSON.stringify({ executable, version })}\n`);
      return { executable, version };
    } catch (error) { failures.push(`${candidate}: ${(error as Error).message}`); }
  }
  throw Error(`TEST_FFMPEG_UNAVAILABLE: install FFmpeg and set FFMPEG_PATH or PATH. ${failures.join('; ') || 'PATH is empty'}`);
}
