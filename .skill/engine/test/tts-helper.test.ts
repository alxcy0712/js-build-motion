import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EDGE_HELPER_PATH, ttsFixHint } from '../src/utils/tts-probe.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

test('Edge helper rejects incompatible releases before probing or synthesis and reports the accepted version',
  { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
    const output = join(PROJECT_ROOT, '.research/out'); mkdirSync(output, { recursive: true });
    const scratch = mkdtempSync(join(output, 'edge-helper-')), audio = join(scratch, 'voice.mp3'), metadata = join(scratch, 'words.json');
    const code = `import runpy,sys,types
helper,version=sys.argv[1:3]
sys.modules['edge_tts']=types.SimpleNamespace(__version__=version)
sys.argv=[helper,*sys.argv[3:]]
runpy.run_path(helper,run_name='__main__')`;
    const run = (version: string, args: string[]) => spawnSync('python3', ['-B', '-c', code, EDGE_HELPER_PATH, version, ...args], { encoding: 'utf8' });
    try {
      for (const version of ['7.2.8', '7.3.0', 'unknown']) {
        for (const args of [['--probe'], ['--text', '虚构文本', '--out-audio', audio, '--out-json', metadata]]) {
          const result = run(version, args);
          assert.equal(result.status, 3, result.stderr);
          const outcome = JSON.parse(result.stdout);
          assert.equal(outcome.ok, false); assert.equal(outcome.code, 'TTS_PROVIDER_UNAVAILABLE');
          assert.ok(outcome.error.includes(version)); assert.match(outcome.error, /pip install --upgrade 'edge-tts>=7\.3\.1'/);
          assert.equal(existsSync(audio), false); assert.equal(existsSync(metadata), false);
        }
      }
      for (const version of ['7.3.1', '7.4.0']) {
        const result = run(version, ['--probe']); assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { ok: true, module: 'edge_tts', version });
      }
      assert.match(ttsFixHint({ available: false, python: null, reason: 'edge-tts 7.2.8 需要升级', helperExists: true }), /--upgrade 'edge-tts>=7\.3\.1'/);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
