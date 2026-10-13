import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { inspectArtifact } from '../src/project/artifact.ts';
import { loadProject } from '../src/project/manifest.ts';
import { readRunLog } from '../src/project/run-log.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { sha256File } from '../src/utils/hash.ts';
import { createFixtureProject } from './fixtures/project.ts';

const CLI = join(PROJECT_ROOT, 'src/cli/index.ts');
const DRAWING = `import { readFileSync } from 'node:fs';
if (!import.meta.url.includes('/runs/') || !import.meta.url.includes('/snapshot/')) throw new Error('EXPECTED_SNAPSHOT_SOURCE');
const color = readFileSync(new URL('../assets/color.txt', import.meta.url), 'utf8').trim();
export function drawScene({ctx, width, height}) { ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); }
`;

function fixture() {
  const base = createFixtureProject();
  const spec = JSON.parse(readFileSync(base.specPath, 'utf8'));
  spec.video.duration = 2; spec.video.fps = 12;
  spec.scenes = [{ ...spec.scenes[0], start: 0, end: 2, cameraMove: 'static', transition: 'cut' }];
  spec.audio.narration = [{ start: 0.1, text: '固定声音。', voice: 'female_calm' }];
  spec.audio.bgm.volume = 0; spec.audio.sfx = [];
  writeFileSync(base.specPath, JSON.stringify(spec));
  const source = join(base.dir, 'assets/audio/voice.wav');
  mkdirSync(dirname(source), { recursive: true });
  const samples = 24000, rate = 24000, bytes = samples * 2, voice = Buffer.alloc(44 + bytes);
  voice.write('RIFF', 0); voice.writeUInt32LE(36 + bytes, 4); voice.write('WAVE', 8);
  voice.write('fmt ', 12); voice.writeUInt32LE(16, 16); voice.writeUInt16LE(1, 20);
  voice.writeUInt16LE(1, 22); voice.writeUInt32LE(rate, 24); voice.writeUInt32LE(rate * 2, 28);
  voice.writeUInt16LE(2, 32); voice.writeUInt16LE(16, 34); voice.write('data', 36); voice.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++) voice.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 8000), 44 + i * 2);
  writeFileSync(source, voice);
  const color = join(base.dir, 'assets/color.txt'), drawing = join(base.dir, 'src/draw.mjs');
  writeFileSync(color, '#ff0000'); mkdirSync(dirname(drawing), { recursive: true }); writeFileSync(drawing, DRAWING);
  writeFileSync(base.manifestPath, JSON.stringify({ ...base.manifest, drawing: 'src/draw.mjs' }));
  const brief = JSON.parse(readFileSync(base.briefPath!, 'utf8'));
  brief.deliverable.duration = 2; brief.deliverable.fps = 12; brief.claims.zeroExternalAssets = false;
  brief.assets = [{ path: 'assets/color.txt', kind: 'document', license: 'self-owned synthetic fixture' }, { path: 'assets/audio/voice.wav', kind: 'audio', license: 'self-owned synthetic fixture' }];
  writeFileSync(base.briefPath!, JSON.stringify(brief));
  return { ...base, source, color, drawing, spec };
}

function command(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
}
function success(...args: string[]): Record<string, any> {
  const result = command(...args);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
  return JSON.parse(result.stdout);
}
function createLock(dir: string): string {
  const result = success('audio', 'lock', dir, '--tts-provider', 'file', '--no-network');
  const root = join(dir, 'assets/derived/audio');
  const names = readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(names.length, 1);
  const path = `assets/derived/audio/${names[0]}/audio-lock.json`;
  assert.equal(result.audioLock?.path, path);
  return path;
}
function render(dir: string, lock: string, ...aliases: string[]): Record<string, any> {
  // A synthesis call would select mock and fail strict narration. Success proves the lock branch avoids TTS.
  return success('render', dir, '--audio-lock', lock, '--tts-provider', 'mock', '--no-network', '--width', '144', '--height', '256', '--preset', 'ultrafast', '--json', ...aliases);
}
function receipts(dir: string): Array<{ attemptId: string; status: string }> {
  return readdirSync(join(dir, 'runs')).filter(name => existsSync(join(dir, 'runs', name, 'receipt.json')))
    .map(name => JSON.parse(readFileSync(join(dir, 'runs', name, 'receipt.json'), 'utf8')));
}
function encodedColor(path: string): Buffer {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.75', '-i', path, '-frames:v', '1', '-vf', 'crop=2:2:70:10', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('CLI locks one voice and reuses it across snapshot-based visual renders; failed renders preserve current and aliases', () => {
  const f = fixture();
  try {
    const lock = createLock(f.dir), master = join(f.dir, dirname(lock), 'master.wav');
    const masterSha = sha256File(master), sourceSha = sha256File(f.source), lockSha = sha256File(join(f.dir, lock));
    const defaultVideo = join(f.outDir, `${f.slug}.mp4`), defaultSrt = join(f.outDir, `${f.slug}.srt`), defaultVtt = join(f.outDir, `${f.slug}.vtt`);
    const firstResult = render(f.dir, lock);
    const first = readRunLog(join(f.dir, 'run.json'));
    assert.ok(first.execution);
    const firstOutput = resolve(PROJECT_ROOT, first.measured.outputPath);
    assert.match(firstOutput, new RegExp(`/out/renders/${first.execution.attemptId}/final\\.mp4$`));
    assert.equal(sha256File(defaultVideo), first.measured.outputSha256);
    assert.equal(firstResult.runLog, join(f.dir, 'run.json'));
    assert.equal(inspectArtifact(loadProject(f.dir)).ok, true);
    const review = join(f.dir, 'evidence/first-review.json'); mkdirSync(dirname(review), { recursive: true });
    writeFileSync(review, JSON.stringify(inspectArtifact(loadProject(f.dir))));
    const firstPixel = encodedColor(firstOutput);
    assert.ok(firstPixel[0]! > firstPixel[2]! + 100, 'the first encoded image must consume the red asset');

    writeFileSync(f.color, '#0000ff');
    const customVideo = join(f.outDir, 'aliases/custom.mp4'), customSrt = join(f.outDir, 'aliases/custom.srt'), customVtt = join(f.outDir, 'aliases/custom.vtt');
    render(f.dir, lock, '--out', customVideo, '--srt', customSrt, '--vtt', customVtt);
    const second = readRunLog(join(f.dir, 'run.json'));
    assert.ok(second.execution); assert.notEqual(second.execution.attemptId, first.execution.attemptId);
    const secondOutput = resolve(PROJECT_ROOT, second.measured.outputPath), runDir = join(f.dir, 'runs', second.execution.attemptId);
    assert.notEqual(second.measured.outputSha256, first.measured.outputSha256);
    assert.equal(sha256File(firstOutput), first.measured.outputSha256);
    assert.equal(sha256File(customVideo), second.measured.outputSha256);
    assert.equal(sha256File(customSrt), sha256File(join(dirname(secondOutput), `${f.slug}.srt`)));
    assert.equal(sha256File(customVtt), sha256File(join(dirname(secondOutput), `${f.slug}.vtt`)));
    for (const log of [first, second]) {
      assert.deepEqual(log.facts.providers, { tts: '(none)', bgm: '(none)', sfx: '(none)' });
      assert.equal(log.facts.audioReuse?.sourceProviders.tts, 'file');
      assert.equal(log.facts.audioReuse?.lockSha256, lockSha);
      assert.ok(log.measured.audioArtifacts.some(item => item.sha256 === masterSha));
      assert.equal(log.facts.network.includes('edge-tts'), false);
      const folder = dirname(resolve(PROJECT_ROOT, log.measured.outputPath));
      assert.equal(readdirSync(folder, { recursive: true }).some(name => /(^|\/)voice-.*\.wav$/.test(String(name))), false);
    }
    assert.equal(sha256File(master), masterSha); assert.equal(sha256File(f.source), sourceSha);
    const snapshot = JSON.parse(readFileSync(join(runDir, 'input-snapshot.json'), 'utf8'));
    assert.equal(second.execution.inputSnapshotSha256, sha256File(join(runDir, 'input-snapshot.json')));
    assert.ok(snapshot.files.some((file: any) => file.path === 'src/draw.mjs'));
    assert.ok(snapshot.files.some((file: any) => file.path === 'assets/color.txt'));
    assert.equal(readFileSync(join(runDir, 'snapshot', f.slug, 'assets/color.txt'), 'utf8'), '#0000ff');
    const secondPixel = encodedColor(secondOutput);
    assert.ok(secondPixel[2]! > secondPixel[0]! + 100, 'the second encoded image must consume the blue snapshot asset');
    const reviewed = inspectArtifact(loadProject(f.dir), { reviewPath: review });
    assert.equal(reviewed.ok, false); assert.ok(reviewed.issues.some(issue => issue.code === 'REVIEW_BINDING_MISMATCH'));

    const preserved = [join(f.dir, 'run.json'), firstOutput, secondOutput, defaultVideo, defaultSrt, defaultVtt, customVideo, customSrt, customVtt].map(path => [path, sha256File(path)] as const);
    writeFileSync(f.drawing, 'export function drawScene() { throw new Error("DRAW_FIXTURE_FAILURE"); }\n');
    const failed = command('render', f.dir, '--audio-lock', lock, '--tts-provider', 'mock', '--no-network', '--width', '144', '--height', '256', '--json');
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /RENDER_FAILED/);
    for (const [path, sha] of preserved) assert.equal(sha256File(path), sha, path);
    assert.ok(receipts(f.dir).some(receipt => receipt.status === 'failed'));
    writeFileSync(f.drawing, DRAWING);
    assert.equal(inspectArtifact(loadProject(f.dir)).ok, true);
  } finally { f.cleanup(); }
});

test('CLI rejects locks after text, placement, duration changes or same-size sound replacement', () => {
  const f = fixture();
  try {
    const lock = createLock(f.dir), originalSpec = readFileSync(f.specPath);
    const variants = [
      (spec: any) => { spec.audio.narration[0].text = '改过台词。'; },
      (spec: any) => { spec.audio.narration[0].start = 0.2; },
      (spec: any) => { spec.video.duration = 3; spec.scenes[0].end = 3; },
    ];
    for (const change of variants) {
      const spec = JSON.parse(originalSpec.toString()); change(spec); writeFileSync(f.specPath, JSON.stringify(spec));
      const failed = command('render', f.dir, '--audio-lock', lock, '--no-network', '--width', '144', '--height', '256', '--json');
      assert.notEqual(failed.status, 0); assert.match(failed.stderr, /AUDIO_LOCK_INVALID/);
      assert.equal(existsSync(join(f.dir, 'run.json')), false);
      assert.equal(existsSync(join(f.outDir, `${f.slug}.mp4`)), false);
    }
    writeFileSync(f.specPath, originalSpec);
    const master = join(f.dir, dirname(lock), 'master.wav'), bytes = readFileSync(master), length = bytes.length;
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; writeFileSync(master, bytes);
    assert.equal(readFileSync(master).length, length);
    const failed = command('render', f.dir, '--audio-lock', lock, '--no-network', '--width', '144', '--height', '256', '--json');
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /AUDIO_LOCK_INVALID/);
    assert.equal(existsSync(join(f.dir, 'run.json')), false);
  } finally { f.cleanup(); }
});

test('CLI no-run-log preserves the public opt-out while storing an isolated successful result', () => {
  const f = fixture();
  try {
    const silent = JSON.parse(readFileSync(f.specPath, 'utf8'));
    silent.audio.narration = [];
    writeFileSync(f.specPath, JSON.stringify(silent));
    const result = success('render', f.dir, '--no-audio', '--no-captions', '--no-run-log', '--no-network', '--width', '144', '--height', '256', '--preset', 'ultrafast', '--json');
    assert.equal(result.runLog, null);
    assert.equal(existsSync(join(f.dir, 'run.json')), false);
    assert.ok(existsSync(join(f.outDir, `${f.slug}.mp4`)));
    const successful = receipts(f.dir).filter(receipt => receipt.status === 'succeeded');
    assert.equal(successful.length, 1);
    assert.ok(existsSync(join(f.outDir, 'renders', successful[0]!.attemptId, 'final.mp4')));
  } finally { f.cleanup(); }
});
