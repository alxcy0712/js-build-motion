import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testFfmpeg } from './fixtures/ffmpeg.ts';

test('fixture FFmpeg resolves configuration or PATH and reports executable, version and prerequisites', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'test-ffmpeg-'))), executable = join(dir, 'fixture ffmpeg'), onPath = join(dir, 'ffmpeg');
  try {
    const version = 'ffmpeg version independent-fixture';
    for (const path of [executable, onPath]) { writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`); chmodSync(path, 0o700); }
    assert.deepEqual(testFfmpeg({ FFMPEG_PATH: executable, PATH: '' }), { executable, version });
    assert.deepEqual(testFfmpeg({ PATH: dir }), { executable: onPath, version });
    assert.throws(() => testFfmpeg({ FFMPEG_PATH: join(dir, 'missing'), PATH: dir }), /TEST_FFMPEG_UNAVAILABLE.*missing/);
    assert.throws(() => testFfmpeg({ PATH: '' }), /TEST_FFMPEG_UNAVAILABLE.*PATH is empty/);
    writeFileSync(onPath, '#!/bin/sh\necho fixture-version-failed >&2\nexit 7\n');
    assert.throws(() => testFfmpeg({ PATH: dir }), /TEST_FFMPEG_UNAVAILABLE.*7: fixture-version-failed/);
    chmodSync(onPath, 0o600);
    assert.throws(() => testFfmpeg({ PATH: dir }), /TEST_FFMPEG_UNAVAILABLE.*EACCES/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
