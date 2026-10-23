import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
test('240 compliant frames, caption times and both theme tokens retain the pre-maintenance bytes', () => {
  const fixture = join(import.meta.dirname, 'fixtures/render-caption-compatibility.ts');
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/caption-compatibility.json'), 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout), expected);
});
