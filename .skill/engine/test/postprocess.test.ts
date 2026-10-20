import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDisclosure } from '../src/project/disclosure.ts';
import { POSTPROCESS_FILE, readPostprocess, registerPostprocess, type PostprocessRequest } from '../src/project/postprocess.ts';
import { buildFacts, buildMeasured, buildRunLog, readRunLog, repoRelative, writeRunLog } from '../src/project/run-log.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { sha256File } from '../src/utils/hash.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { createFixtureProject } from './fixtures/project.ts';
import { engineArguments } from '../workspace.mjs';

function fixture(fixedRuntimePaths = false) {
  const project = createFixtureProject();
  const ffmpeg = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: project.dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  };
  mkdirSync(project.outDir, { recursive: true });
  mkdirSync(join(project.dir, 'assets'), { recursive: true });
  mkdirSync(join(project.dir, 'evidence'), { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=144x256:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'out/render.mp4']);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', 'assets/voice.norm.wav']);
  writeFileSync(join(project.dir, 'assets/captions.srt'), '1\n00:00:00,000 --> 00:00:01,800\nFixture captions\n');
  ffmpeg(['-i', 'out/render.mp4', '-i', 'assets/voice.norm.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', '2', 'out/mixed.mp4']);
  ffmpeg(['-i', 'out/mixed.mp4', '-vf', 'subtitles=assets/captions.srt', '-c:v', 'libx264', '-c:a', 'copy', 'out/final.mp4']);
  const ref = (path: string) => ({ path, sha256: sha256File(join(project.dir, path)) });
  const voice = { ...ref('assets/voice.norm.wav'), kind: 'audio' as const, license: 'fixture-generated' };
  const spec = JSON.parse(readFileSync(project.specPath, 'utf8'));
  spec.video = { width: 144, height: 256, fps: 24, duration: 2, seed: 1 };
  spec.scenes[0].end = 2; spec.audio = { narration: [], sfx: [], bgm: { volume: 0 } }; spec.captions.enabled = false;
  writeFileSync(project.specPath, JSON.stringify(spec));
  const brief = JSON.parse(readFileSync(project.briefPath!, 'utf8'));
  brief.deliverable.duration = 2;
  brief.tools = { allowed: ['skia-canvas', 'ffmpeg', 'ffprobe', 'doubao-tts'], forbidden: ['whisper'] };
  brief.claims.zeroExternalAssets = false; brief.assets = [voice];
  writeFileSync(project.briefPath!, JSON.stringify(brief));
  const facts = buildFacts({ video: { ...spec.video, frames: 48 }, rendererKind: 'skia', rendererPackage: 'skia-canvas',
    encoder: { video: 'h264', audio: null, pixelFormat: 'yuv420p', crf: null, preset: null },
    ffmpeg: { version: null, command: 'ffmpeg' }, providers: { tts: '(none)', bgm: '(none)', sfx: '(none)' },
    captions: { insideFrame: false, cues: 0, wordLevel: false }, declaredAssets: [voice], projectDir: project.dir });
  const log = buildRunLog({ project: project.slug, specPath: fixedRuntimePaths ? join(PROJECT_ROOT, '../spec/main.json') : project.specPath, specSha256: sha256File(project.specPath),
    briefPath: project.briefPath, briefSha256: sha256File(project.briefPath!), facts,
    measured: buildMeasured({ renderMs: 1, msPerFrame: 1, encodeTailMs: 0, audioMixMs: null,
      outputBytes: statSync(join(project.dir, 'out/render.mp4')).size, outputSha256: ref('out/render.mp4').sha256,
      outputPath: fixedRuntimePaths ? '../out/render.mp4' : repoRelative(join(project.dir, 'out/render.mp4')) }) });
  writeRunLog(join(project.dir, 'run.json'), log);
  const external = [
    { id: 'faster-whisper', kind: 'asr' as const }, { id: 'soxr', kind: 'media' as const },
    { id: 'subtitle-script', kind: 'editor' as const }, { id: 'finalize', kind: 'media' as const },
  ].map(t => ({ ...t, label: t.id, network: false, byteReproducible: false }));
  const request: PostprocessRequest = {
    version: '0.1', tools: { allowed: [...external.map(t => t.id), 'ffmpeg', 'libass'], external },
    assets: [{ ...voice, provenance: { tools: ['doubao-tts', 'soxr'] } },
      { ...ref('assets/captions.srt'), kind: 'document', license: 'fixture-generated', provenance: { tools: ['faster-whisper', 'subtitle-script'] } }],
    steps: [
      { id: 'mix', description: '混音', tools: ['finalize', 'ffmpeg'], inputs: [ref('out/render.mp4'), ref('assets/voice.norm.wav')], output: ref('out/mixed.mp4') },
      { id: 'captions', description: '烧字幕并转码', tools: ['ffmpeg', 'libass'], inputs: [ref('out/mixed.mp4'), ref('assets/captions.srt')], output: ref('out/final.mp4') },
    ], final: ref('out/final.mp4'), captions: { insideFrame: true, cues: 1, wordLevel: true },
  };
  const saveRequest = (value = request) => writeFileSync(join(project.dir, 'evidence/request.json'), JSON.stringify(value));
  saveRequest();
  return { project, request, saveRequest, log, ref, ffmpeg, cleanup: project.cleanup };
}

test('真实静音中间件经混音和字幕烧录后，以最终视频生成 §1 / §4 / §5', () => {
  const f = fixture();
  try {
    const runPath = join(f.project.dir, 'run.json'), before = readFileSync(runPath);
    const record = registerPostprocess(f.project, 'evidence/request.json');
    assert.deepEqual(readFileSync(runPath), before, '后期登记保留原始渲染记录');
    assert.equal(record.media.audio?.codec, 'aac');
    assert.equal(record.final.sha256, f.ref('out/final.mp4').sha256);
    assert.deepEqual(record.steps, f.request.steps);
    const result = buildDisclosure(f.project);
    assert.equal(result.reconcile.ok, true, JSON.stringify(result.reconcile.findings));
    const section1 = result.content.split('## 1.')[1]!.split('## 2.')[0]!;
    assert.match(section1.split('### 中间渲染件')[0]!, /音频编码 \| aac/);
    assert.match(section1.split('### 中间渲染件')[1]!, /无音频流/);
    for (const section of ['## 1.', '## 5.']) assert.ok(result.content.split(section)[1]!.includes(record.final.sha256));
    for (const id of ['doubao-tts', 'soxr', 'faster-whisper', 'subtitle-script', 'finalize', 'libass']) {
      assert.ok(result.content.includes(`| \`${id}\` |`), id);
      assert.ok(!result.content.split('\n').some(line => /本次未使用|本次并未调用/.test(line) && line.includes(id)), id);
    }
    assert.match(result.content, /成片帧内字幕 【声明】 \| 1 条/);
    assert.doesNotMatch(result.content, /本片无旁白|成片里没有对应人声/);
    assert.equal(readPostprocess(f.project, f.log)?.recordId, record.recordId);
    assert.equal(validateSpec(JSON.parse(readFileSync(f.project.specPath, 'utf8'))).ok, true);
    const cli = spawnSync(process.execPath, ['src/cli/index.ts', 'disclosure', f.project.dir, '--json'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr + cli.stdout);
    assert.equal(JSON.parse(cli.stdout).ok, true);
  } finally { f.cleanup(); }
});

test('最终视频、渲染件、源素材和处理记录替换均被复查拒绝', () => {
  const f = fixture();
  try {
    registerPostprocess(f.project, 'evidence/request.json');
    for (const name of ['out/final.mp4', 'out/render.mp4', 'assets/voice.norm.wav', 'assets/captions.srt', POSTPROCESS_FILE]) {
      const path = join(f.project.dir, name), saved = readFileSync(path);
      if (name === POSTPROCESS_FILE) {
        const record = JSON.parse(saved.toString()); record.steps[0].tools = ['ffmpeg']; writeFileSync(path, JSON.stringify(record));
      } else writeFileSync(path, Buffer.concat([saved, Buffer.from('changed')]));
      assert.throws(() => buildDisclosure(f.project), /POSTPROCESS_|ASSET_HASH_MISMATCH/);
      writeFileSync(path, saved);
    }
    const path = join(f.project.dir, 'run.json'), saved = readFileSync(path);
    const log = readRunLog(path); writeRunLog(path, { ...log, facts: { ...log.facts, tools: ['ffmpeg'] } });
    assert.throws(() => buildDisclosure(f.project), /run.json 与当前输入不一致/);
    assert.throws(() => readPostprocess(f.project, readRunLog(path)), /POSTPROCESS_RUN_MISMATCH/);
    writeFileSync(path, saved);
  } finally { f.cleanup(); }
});

test('后期登记拒绝断链、未声明工具、越界与循环输出，并保持上一份记录', () => {
  const f = fixture();
  try {
    registerPostprocess(f.project, 'evidence/request.json');
    const before = readFileSync(join(f.project.dir, POSTPROCESS_FILE));
    const cases = [
      (r: PostprocessRequest) => ({ ...r, steps: r.steps.slice(1) }),
      (r: PostprocessRequest) => ({ ...r, steps: [{ ...r.steps[0]!, tools: ['whisper'] }, ...r.steps.slice(1)] }),
      (r: PostprocessRequest) => ({ ...r, final: { ...r.final, path: '../outside.mp4' } }),
      (r: PostprocessRequest) => ({ ...r, steps: [{ ...r.steps[0]!, output: f.ref('out/render.mp4') }, ...r.steps.slice(1)] }),
    ];
    for (const mutate of cases) {
      f.saveRequest(mutate(f.request));
      assert.throws(() => registerPostprocess(f.project, 'evidence/request.json'), /POSTPROCESS_/);
      assert.deepEqual(readFileSync(join(f.project.dir, POSTPROCESS_FILE)), before);
    }
  } finally { f.cleanup(); }
});

test('固定运行时路径按原 spec 恢复，最终规格与原 spec / brief 继续校验', () => {
  const f = fixture(true);
  try {
    registerPostprocess(f.project, 'evidence/request.json');
    for (const path of [f.project.specPath, f.project.briefPath!]) {
      const saved = readFileSync(path);
      writeFileSync(path, Buffer.concat([saved, Buffer.from('\n')]));
      assert.throws(() => buildDisclosure(f.project), /run.json 与当前输入不一致/);
      writeFileSync(path, saved);
    }
    f.ffmpeg(['-i', 'out/mixed.mp4', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', 'out/final.mp4']);
    const final = f.ref('out/final.mp4');
    f.saveRequest({ ...f.request, final, steps: [f.request.steps[0]!, { ...f.request.steps[1]!, output: final }] });
    registerPostprocess(f.project, 'evidence/request.json');
    const result = buildDisclosure(f.project);
    assert.equal(result.reconcile.ok, false);
    assert.ok(result.reconcile.findings.some(finding => finding.code === 'DELIVERABLE_DRIFT'));
    assert.deepEqual(engineArguments(f.project.dir, ['postprocess', '--verify']), ['postprocess', f.project.dir, '--verify']);
  } finally { f.cleanup(); }
});

test('归档模式核验最终文件和现存来源，将缺失原件标为待复核，保留 run 防篡改', () => {
  const f = fixture(true);
  try {
    f.saveRequest({ ...f.request, sourceVerification: 'records-only' });
    rmSync(join(f.project.dir, 'out/render.mp4'));
    rmSync(join(f.project.dir, 'assets/voice.norm.wav'));
    const before = readFileSync(join(f.project.dir, 'run.json'));
    const record = registerPostprocess(f.project, 'evidence/request.json');
    assert.deepEqual(record.unavailable, ['assets/voice.norm.wav', 'out/render.mp4']);
    const result = buildDisclosure(f.project);
    assert.equal(result.reconcile.ok, true);
    assert.ok(result.reconcile.findings.some(f => f.code === 'SOURCE_VERIFICATION_PARTIAL'));
    assert.match(result.content, /原件待复核清单/);
    assert.match(result.content, /`assets\/voice.norm.wav` .*【声明】/);
    assert.match(result.content, /`out\/final.mp4` .*【实测】/);
    assert.deepEqual(readFileSync(join(f.project.dir, 'run.json')), before);
    writeFileSync(join(f.project.dir, 'assets/captions.srt'), 'changed');
    assert.throws(() => buildDisclosure(f.project), /ASSET_HASH_MISMATCH|POSTPROCESS_FILE_MISMATCH/);
    writeFileSync(join(f.project.dir, 'run.json'), JSON.stringify({ ...f.log, facts: { ...f.log.facts, tools: [] } }));
    assert.throws(() => buildDisclosure(f.project), /run.json 与当前输入不一致/);
  } finally { f.cleanup(); }
});
