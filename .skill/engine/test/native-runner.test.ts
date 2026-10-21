import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { nativeCollector } from '../../scripts/native-runner.mjs';
test('native collector preserves binary bytes, accepted exits and failed timeout evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-runner-'));
  try {
    const collect = nativeCollector({ records: dir, packageId: 'fixture', timeoutMs: 1000 });
    assert.deepEqual(collect(dir, process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,255,128]))'], 0, true), Buffer.from([0,255,128]));
    assert.match(collect(dir, process.execPath, ['-e', "process.stderr.write('expected');process.exit(1)"], 1), /expected/);
    assert.equal(collect(dir, process.execPath, ['-e', 'process.exit(2)'], [1,2]), '');
    assert.throws(() => collect(dir, process.execPath, ['-e', 'setInterval(()=>{},1000)'], 0, 100), /ETIMEDOUT/);
    const logs = readFileSync(join(dir, 'commands.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(logs.map(x => x.status), ['passed', 'passed', 'passed', 'failed']);
    assert.equal(logs[0].stdoutBytes, 3); assert.equal(logs[3].timeoutMs, 100);
    assert.ok(logs.every(x => ['already-exited', 'SIGKILL-sent'].includes(x.collectorGroupCleanup)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
