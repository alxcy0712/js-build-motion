import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectQuality } from '../src/project/quality.ts';
import { timingSpecHash } from '../src/audio/verify.ts';
import { narrationTimingIssues } from '../src/audio/verify.ts';
import { createFixtureProject } from './fixtures/project.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { validateSpec } from '../src/spec/validate.ts';

test('QA 用实测发声计算空档与尾留，揭幕空档作为复核提示', () => {
  const fixture = createFixtureProject();
  try {
    const spec = validateSpec(JSON.parse(readFileSync(fixture.specPath, 'utf8'))).spec!;
    spec.audio.narration = [0.2, 3, 5].map(start => ({ start, text: '暖水向东。', voice: 'female_calm' }));
    const measuredNarration = new Map([[0, { start: 0.2, end: 1.2 }], [1, { start: 3, end: 4.6 }], [2, { start: 5, end: 7.5 }]]);
    const report = inspectQuality(spec, { measuredNarration });
    assert.equal(report.ok, true);
    const pacing = report.narrationPacing!;
    assert.ok(Math.abs(pacing.voicedSeconds - 5.1) < 1e-9);
    assert.ok(Math.abs(pacing.coverage - 5.1 / 8) < 1e-9);
    assert.ok(Math.abs(pacing.meanGapSeconds - 1.1) < 1e-9);
    assert.equal(pacing.maxGapSeconds, 1.8);
    assert.equal(pacing.headSeconds, 0.2);
    assert.equal(pacing.tailSeconds, 0.5);
    assert.equal(report.issues.filter(i => i.code === 'NARRATION_GAP_REVIEW').length, 1);
    assert.ok(report.issues.some(i => i.code === 'NARRATION_TAIL_REVIEW'));
    assert.ok(!report.issues.some(i => i.code === 'NARRATION_DENSITY'));
    assert.equal(inspectQuality(spec).narrationPacing, null);
    assert.ok(inspectQuality(spec).issues.some(i => i.code === 'NARRATION_TIMING_PENDING'));
    assert.equal(inspectQuality(spec, { measuredNarration: new Map() }).ok, false);
    measuredNarration.set(0, { start: 0.2, end: 3.5 });
    assert.equal(inspectQuality(spec, { measuredNarration }).ok, false);
    spec.audio.narration = [];
    assert.equal(inspectQuality(spec).narrationPacing, null);
    assert.ok(!inspectQuality(spec).issues.some(i => i.code === 'NARRATION_TIMING_PENDING'));
    spec.audio.narration = [{ start: 0.2, text: '一句。', voice: 'female_calm' }];
    assert.equal(inspectQuality(spec, { measuredNarration: new Map([[0, { start: 0.2, end: 2 }]]) }).narrationPacing?.meanGapSeconds, 0);
  } finally { fixture.cleanup(); }
});

test('QA CLI 读取匹配规格的实测时间，过期缓存回到 pending', () => {
  const fixture = createFixtureProject();
  try {
    const spec = validateSpec(JSON.parse(readFileSync(fixture.specPath, 'utf8'))).spec!;
    const dir = join(fixture.outDir, 'audio');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'narration-timing.json');
    const report = { specHash: timingSpecHash(spec), timings: [[0, { start: 1, end: 3 }]] };
    writeFileSync(path, JSON.stringify(report));
    const qa = () => {
      const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'src/cli/index.ts'), 'qa', fixture.dir], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(qa().narrationPacing.voicedSeconds, 2);
    assert.equal(qa().narrationPacing.tailSeconds, 5);
    writeFileSync(path, JSON.stringify({ ...report, specHash: 'stale' }));
    const pending = qa();
    assert.equal(pending.narrationPacing, null);
    assert.ok(pending.issues.some((i: { code: string }) => i.code === 'NARRATION_TIMING_PENDING'));
    const preflight = join(fixture.outDir, 'audio-preflight');
    mkdirSync(preflight, { recursive: true });
    writeFileSync(join(preflight, 'narration-timing.json'), JSON.stringify(report));
    assert.equal(qa().narrationPacing.voicedSeconds, 2);
  } finally { fixture.cleanup(); }
});

test('自定义绘制交由实际画面检查，elements 空数组按绘制入口解释', () => {
  const fixture = createFixtureProject();
  try {
    const spec = JSON.parse(readFileSync(fixture.specPath, 'utf8'));
    const composition = { backdrop: 'studio', motif: 'none', title: '测试', bpm: 96, elements: [] };
    spec.scenes = [0, 1, 2].map(i => ({ ...spec.scenes[0], start: i * 8 / 3, end: (i + 1) * 8 / 3, composition, environment: 'motion_stage' }));
    assert.ok(inspectQuality(spec).issues.some(i => i.code === 'TEMPLATE_ONLY_FILM'));
    assert.ok(!inspectQuality(spec, { customDrawing: true }).issues.some(i => i.code === 'TEMPLATE_ONLY_FILM'));
  } finally { fixture.cleanup(); }
});

test('连续旁白可跨视觉切点，下一句与片尾继续约束声音窗口', () => {
  const fixture=createFixtureProject();
  try {
    const spec=validateSpec(JSON.parse(readFileSync(fixture.specPath,'utf8'))).spec!;
    const composition={backdrop:'studio' as const,motif:'none' as const,title:'解释过程',bpm:96,actors:[]};
    spec.scenes=[0,1].map(i=>({...spec.scenes[0]!,start:i*4,end:(i+1)*4,composition,environment:'motion_stage'}));
    spec.audio.narration=[{start:1,text:'同一段旁白在两个镜头间连续解释。',voice:'female_calm'}];
    const measured=new Map([[0,{start:1,end:7}]]);
    assert.deepEqual(narrationTimingIssues(spec,measured),[]);
    spec.audio.narration.push({start:6,text:'下一段。',voice:'female_calm'});
    measured.set(1,{start:6,end:7.5});
    assert.ok(narrationTimingIssues(spec,measured).some(i=>i.startsWith('NARRATION_OVERRUN')));
    spec.audio.narration.pop();measured.set(0,{start:1,end:9});
    assert.ok(narrationTimingIssues(spec,measured).some(i=>i.startsWith('NARRATION_OVERRUN')));
  } finally {fixture.cleanup();}
});

test('QA 报告拆分后的字幕与词表失配，并提示双语长段复核', () => {
  const fixture=createFixtureProject();
  try {
    const spec=validateSpec(JSON.parse(readFileSync(fixture.specPath,'utf8'))).spec!;
    const text='输入到来，选择专家。计算继续，结果接受验证。';
    spec.audio.narration=[{start:0,text,voice:'female_calm'}];
    const measuredNarration=new Map([[0,{start:0,end:7,words:[{text:'失配',start:0,end:7}]}]]);
    const report=inspectQuality(spec,{measuredNarration});
    assert.ok(report.captionReadability!.cues>1);
    assert.equal(report.captionReadability!.estimatedCues,report.captionReadability!.cues);
    assert.equal(report.issues.filter(i=>i.code==='CAPTION_ALIGNMENT_REVIEW').length,1);
    assert.ok(report.reviewFrames.includes(0));
    spec.audio.narration=[{start:0,text:'这是一整段需要逐句对齐译文的说明。'.repeat(3),voice:'female_calm',translation:'A full translated paragraph.'}];
    assert.ok(inspectQuality(spec).issues.some(i=>i.code==='CAPTION_TRANSLATION_REVIEW'));
  } finally {fixture.cleanup();}
});
