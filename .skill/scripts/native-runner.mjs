import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const sha = value => createHash('sha256').update(value).digest('hex');

/** Native suites select their own budget and output contract; all collectors reap descendants. */
export function nativeCollector({ records, packageId, timeoutMs, stderrMode = 'one', cleanupErrorCode }) {
  let ordinal = 0;
  return (cwd, executable, argv, expected = 0, limitOrBinary = timeoutMs) => {
    const binary = limitOrBinary === true, timeout = typeof limitOrBinary === 'number' ? limitOrBinary : timeoutMs;
    const id = `command-${String(++ordinal).padStart(4, '0')}`, began = Date.now(), startedAt = new Date().toISOString();
    const r = spawnSync(executable, argv, { cwd, encoding: binary ? null : 'utf8', timeout, killSignal: 'SIGKILL', detached: true, maxBuffer: 32 * 1024 * 1024 });
    let cleanup = 'no-pid', cleanupError;
    if (r.pid) try { process.kill(-r.pid, 'SIGKILL'); cleanup = 'SIGKILL-sent'; }
    catch (error) { if (error.code === 'ESRCH') cleanup = 'already-exited'; else { cleanup = 'failed'; cleanupError = error; } }
    const stdout = r.stdout ?? (binary ? Buffer.alloc(0) : ''), stderr = r.stderr ?? '';
    const accepted = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
    writeFileSync(join(records, id + '.stdout.log'), stdout); writeFileSync(join(records, id + '.stderr.log'), stderr);
    appendFileSync(join(records, 'commands.jsonl'), JSON.stringify({ id, packageId, cwd, executable, argv, startedAt, finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - began, timeoutMs: timeout, expectedExitCode: expected, exitCode: r.status, signal: r.signal,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: sha(stdout), stderrSha256: sha(stderr), binary,
      collectorPid: r.pid ?? null, collectorGroupCleanup: cleanup, error: r.error?.message ?? cleanupError?.message ?? null,
      status: r.error || cleanupError || !accepted ? 'failed' : 'passed' }) + '\n');
    if (cleanupError && cleanupErrorCode) throw new Error(cleanupErrorCode, { cause: cleanupError });
    if (r.error || cleanupError) throw r.error ?? cleanupError;
    assert.ok(accepted, `${argv.join(' ')}\n${String(stderr)}\n${binary ? '' : stdout}`);
    return !binary && (stderrMode === 'truthy' ? expected : stderrMode === 'one' && expected === 1) ? stdout + stderr : stdout;
  };
}
