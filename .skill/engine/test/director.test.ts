import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas } from 'skia-canvas';
import { compileDirector, type DirectorPlan } from '../src/project/director.ts';
import { inspectQuality } from '../src/project/quality.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { safeAreaFor } from '../src/captions/render.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { validateSpec } from '../src/spec/validate.ts';
import { fitTitle } from '../src/drawing/scenes/motion-stage.ts';
import { writeBgmWav } from '../src/audio/bgm/procedural.ts';
import { proceduralBgmProvider } from '../src/audio/bgm/index.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { graphicState } from '../src/drawing/scenes/graphics.ts';
import { cameraFor } from '../src/drawing/primitives/camera.ts';
import { narrationTimingIssues } from '../src/audio/verify.ts';

const plan = (): DirectorPlan => ({
  version: '0.1', title: '灵感', idea: '小小灵感汇聚成一个世界', aspect: '16:9', look: 'storybook', bpm: 97,
  shots: [
    { purpose: '提出问题', beats: 4, title: '你好，灵感', backdrop: 'studio', motif: 'orbit', actors: [{ id: 'lead', x: 0.5, y: 0.7, scale: 1, gesture: 'wave', mood: 'curious' }], transition: 'cut' },
    { purpose: '给出答案', beats: 4, title: '一起发光', backdrop: 'night', motif: 'burst', actors: [{ id: 'lead', x: 0.5, y: 0.7, scale: 1, gesture: 'celebrate', mood: 'happy' }], transition: 'dissolve' },
  ],
});

test('原创图元能独立构图，关键帧可随机访问且编译保留所有视觉参数', () => {
  const p = plan(); p.shots[0]!.actors = [];
  p.shots[0]!.elements = [{ id: 'node', kind: 'ellipse', x: 0.3, y: 0.5, width: 0.12, height: 0.2, fill: '#44aacc', keyframes: [{ at: 0, x: 0.2, reveal: 0 }, { at: 1, x: 0.8, reveal: 1 }] }];
  const spec = compileDirector(p).spec;
  assert.deepEqual(spec.scenes[0]!.composition!.elements, p.shots[0]!.elements);
  const node = p.shots[0]!.elements[0]!;
  assert.equal(graphicState(node, 0.5).x, 0.5); assert.equal(graphicState(node, 1).x, 0.8);
  const [a, b, c] = pixels(spec, [8, 30, 8]); assert.deepEqual(a, c); assert.notDeepEqual(a, b);
  const empty = structuredClone(spec); empty.scenes[0]!.composition!.elements = [];
  assert.notDeepEqual(pixels(spec, [30])[0], pixels(empty, [30])[0]);
});

test('图元缺失必要几何、重复 id、乱序关键帧均拒绝，连续配音受片尾约束', () => {
  const p = plan();
  p.shots[0]!.elements = [{ id: 'path', kind: 'polyline', x: 0.5, y: 0.5, width: 0.5, height: 0.3 }];
  assert.throws(() => compileDirector(p));
  p.shots[0]!.elements[0]!.points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  p.shots[0]!.elements[0]!.keyframes = [{ at: 0.8, x: 0.2 }, { at: 0.3, x: 0.7 }];
  assert.throws(() => compileDirector(p));
  p.shots[0]!.elements[0]!.keyframes = [{ at: 0, x: 0.2 }];
  p.shots[0]!.elements.push(structuredClone(p.shots[0]!.elements[0]!));
  assert.throws(() => compileDirector(p));
  const spec = compileDirector(plan()).spec;
  spec.audio.narration = [{ start: 0.2, text: '讲解', voice: 'female_calm' }];
  assert.deepEqual(narrationTimingIssues(spec, new Map([[0, { start: 0.2, end: 4 }]])),[]);
  assert.match(narrationTimingIssues(spec, new Map([[0, { start: 0.2, end: spec.video.duration+1 }]]))[0]!, /NARRATION_OVERRUN/);
});

test('director compilation is deterministic, frame-aligned and preserves intent and beat timing', () => {
  const raw = plan(), before = structuredClone(raw), one = compileDirector(raw), two = compileDirector(raw);
  assert.deepEqual(one, two); assert.deepEqual(raw, before);
  assert.equal(one.plan.idea, raw.idea); assert.equal(one.spec.scenes[0]!.end, one.spec.scenes[1]!.start);
  assert.equal(one.spec.video.duration * 24, Math.round(8 * 60 / 97 * 24));
  assert.equal(one.spec.audio.bgm.bpm, 97); assert.equal(inspectQuality(one.spec).ok, true);
});
test('帧率可指定，省略时保持旧的 24fps 行为，且拍位按累计拍数对齐到帧', () => {
  const base = plan();
  assert.equal(compileDirector(base).spec.video.fps, 24);
  const fast = plan(); fast.fps = 30;
  const spec = compileDirector(fast).spec;
  assert.equal(spec.video.fps, 30);
  // 累计拍数 × 60 / bpm 取整到帧：30fps / 97bpm 下每拍 18.557 帧，边界仍必须落在帧上
  assert.equal(spec.video.duration * 30, Math.round(8 * 60 / 97 * 30));
  assert.equal(spec.scenes[0]!.end, spec.scenes[1]!.start);
  for (const scene of spec.scenes) {
    assert.equal(Number.isInteger(scene.start * 30), true, `${scene.id} 起点未落在 30fps 帧上`);
    assert.equal(Number.isInteger(scene.end * 30), true, `${scene.id} 终点未落在 30fps 帧上`);
  }
  const bad = plan() as unknown as Record<string, unknown>; bad.fps = 27;
  assert.throws(() => compileDirector(bad));
});
test('BGM 情绪预设可指定，省略时保持旧的 playful 行为', () => {
  assert.equal(compileDirector(plan()).spec.audio.bgm.preset, 'playful');
  const doc = plan(); doc.bgmPreset = 'curious';
  assert.equal(compileDirector(doc).spec.audio.bgm.preset, 'curious');
  const invented = plan() as unknown as Record<string, unknown>; invented.bgmPreset = 'epic';
  assert.throws(() => compileDirector(invented));
});
test('导演字幕版面配置进入成片渲染，非法配置拒绝', () => {
  const p = plan(); p.aspect = '9:16';
  p.shots[0]!.narration = '暖水向东移动。';
  const original = compileDirector(p).spec;
  p.captionLayout = { fontScale: 40 / 1080, translationScale: 0.625, maxWidth: 0.78, bottomInset: 0.11 };
  const compact = compileDirector(p).spec;
  assert.deepEqual(compact.captions, { ...original.captions, ...p.captionLayout });
  assert.deepEqual(compact.scenes, original.scenes);
  assert.notDeepEqual(pixels(original, [25])[0], pixels(compact, [25])[0]);
  for (const captionLayout of [{ fontScale: 0 }, { translationScale: 2 }, { maxWidth: 1 }, { bottomInset: -1 }, { unknown: true }]) {
    assert.throws(() => compileDirector({ ...p, captionLayout }));
  }
});
test('导演可排旁白起点、音色语速与镜内音效，旧计划沿用既有默认值', () => {
  const p = plan(); p.shots[0]!.narration = '一个想法。';
  const original = compileDirector(p).spec;
  assert.deepEqual(original.audio.narration[0], { start: 0.2, voice: 'female_calm', text: '一个想法。' });
  assert.deepEqual(original.audio.sfx, [{ start: original.scenes[1]!.start, preset: 'whoosh', volume: 0.08 }]);
  p.voice = 'female_lively'; p.narrationRate = 15;
  p.shots[0]!.narrationOffset = 0;
  p.shots[0]!.sfx = [{ offset: 0.4, preset: 'click', volume: 0.12 }, { offset: 0.8, preset: 'success' }];
  p.shots[1]!.sfx = [];
  const spec = compileDirector(p).spec;
  assert.deepEqual(spec.scenes, original.scenes);
  assert.deepEqual(spec.audio.narration[0], { start: 0, voice: 'female_lively', text: '一个想法。', rate: 15 });
  assert.deepEqual(spec.audio.sfx, [{ start: 0.4, preset: 'click', volume: 0.12 }, { start: 0.8, preset: 'success', volume: 0.08 }]);
  p.shots[1]!.sfx = [{ offset: 0.25, preset: 'heartbeat' }];
  assert.equal(compileDirector(p).spec.audio.sfx.at(-1)!.start, spec.scenes[1]!.start + 0.25);
});
test('导演拒绝越过镜头的旁白/音效起点与无效音色语速', () => {
  const p = plan(); p.shots[0]!.narration = '开始。';
  const end = compileDirector(p).spec.scenes[0]!.end;
  for (const narrationOffset of [-0.1, end, end + 1]) assert.throws(() => compileDirector({ ...p, shots: [{ ...p.shots[0], narrationOffset }, p.shots[1]] }));
  assert.throws(() => compileDirector({ ...p, shots: [{ ...p.shots[0], narration: undefined, narrationOffset: 0 }, p.shots[1]] }));
  for (const offset of [-0.1, end, end + 1]) assert.throws(() => compileDirector({ ...p, shots: [{ ...p.shots[0], sfx: [{ offset, preset: 'clock' }] }, p.shots[1]] }));
  for (const extra of [{ voice: 'unknown' }, { narrationRate: -51 }, { narrationRate: 101 }, { narrationRate: 1.5 }]) assert.throws(() => compileDirector({ ...p, ...extra }));
});
test('director rejects invented capabilities, empty plans, duplicate actors and semantic truncation', () => {
  assert.throws(() => compileDirector({ ...plan(), shots: [] }));
  const bad = plan(); (bad.shots[0] as any).motif = 'blender'; assert.throws(() => compileDirector(bad));
  const duplicate = plan(); duplicate.shots[0]!.actors.push(duplicate.shots[0]!.actors[0]!); assert.throws(() => compileDirector(duplicate));
  const long = plan(); long.shots = Array.from({ length: 120 }, () => ({ ...plan().shots[0]!, beats: 32 })); assert.throws(() => compileDirector(long));
});
test('双语字幕：narrationTranslation 编译为 spec.audio.narration[].translation，且不影响 TTS 文本与时间轴', () => {
  const mono = compileDirector(plan()).spec;
  const withTranslation = plan();
  withTranslation.shots[0]!.narration = '一切从 V2 开始。';
  withTranslation.shots[1]!.narration = 'R1 改变了这条路线。';
  withTranslation.shots[0]!.narrationTranslation = 'It started with V2.';
  withTranslation.shots[1]!.narrationTranslation = 'R1 changed this road.';
  const spec = compileDirector(withTranslation).spec;

  assert.equal(spec.audio.narration.length, 2);
  assert.equal(spec.audio.narration[0]?.text, '一切从 V2 开始。', 'TTS 只读 text');
  assert.equal(spec.audio.narration[0]?.translation, 'It started with V2.');
  assert.equal(spec.audio.narration[1]?.translation, 'R1 changed this road.');
  // 译文不能改变时间轴：与不带译文的同一计划逐场景、逐条旁白一致
  const plain = plan();
  plain.shots[0]!.narration = '一切从 V2 开始。';
  plain.shots[1]!.narration = 'R1 改变了这条路线。';
  const plainSpec = compileDirector(plain).spec;
  assert.deepEqual(spec.scenes, plainSpec.scenes);
  assert.deepEqual(
    spec.audio.narration.map(n => [n.start, n.text, n.voice]),
    plainSpec.audio.narration.map(n => [n.start, n.text, n.voice]),
  );
  assert.deepEqual(mono.audio.narration, [], '不带旁白的计划不受影响');
});

test('导演计划拒绝未注册的双语字幕字段名与超长译文', () => {
  const invented = plan();
  (invented.shots[0] as any).english = 'invented field name';
  assert.throws(() => compileDirector(invented), '字段名必须与契约一致，不能让模型自造');
  const tooLong = plan();
  tooLong.shots[0]!.narration = '短句。';
  tooLong.shots[0]!.narrationTranslation = 'x'.repeat(301);
  assert.throws(() => compileDirector(tooLong));
});

test('invalid composition is fatal instead of silently discarding the visual intent', () => {
  const raw = compileDirector(plan()).spec; (raw.scenes[0]!.composition as any).actors[0].x = 12;
  assert.throws(() => validateSpec(raw));
  const wrongEnvironment = compileDirector(plan()).spec; wrongEnvironment.scenes[0]!.environment = 'rain_window';
  assert.throws(() => validateSpec(wrongEnvironment));
});
test('preflight catches placeholder environments, timeline holes and mismatched music', () => {
  const spec = compileDirector(plan()).spec;
  spec.scenes[0]!.environment = 'forest'; spec.scenes[1]!.start += 0.25; spec.audio.bgm.bpm = 120;
  const result = inspectQuality(spec);
  assert.equal(result.ok, false);
  for (const code of ['UNIMPLEMENTED_ENVIRONMENT', 'TIMELINE_COVERAGE', 'BEAT_MISMATCH']) assert.ok(result.issues.some(i => i.code === code));
});
test('preflight warns when actors stand low enough to be covered by the caption plate', () => {
  const low = plan();
  low.shots[0]!.narration = '字幕会出现在画面底部。';
  low.shots[0]!.actors[0]!.y = 0.72;
  const spec = compileDirector(low).spec;
  assert.ok(inspectQuality(spec).issues.some(i => i.code === 'ACTOR_UNDER_CAPTIONS'), '脚位过低应被拦下');
  const raised = plan();
  raised.shots[0]!.narration = '字幕会出现在画面底部。';
  for (const shot of raised.shots) for (const actor of shot.actors) actor.y = 0.48;
  assert.ok(!inspectQuality(compileDirector(raised).spec).issues.some(i => i.code === 'ACTOR_UNDER_CAPTIONS'), '抬高后不应再警告');
});
test('双语字幕：16:9 成片里第二行与镜头标题之间留有空白带（不碰撞）', () => {
  const W = 1920, H = 1080;
  const build = (withTranslation: boolean) => {
    const p = plan();
    p.shots[0]!.title = 'Example 实验';
    p.shots[0]!.narration = '从一个实验装置的输入数据开始，这是一段可以被逐条核对的观察过程。';
    if (withTranslation) {
      p.shots[0]!.narrationTranslation = 'It starts with input data from a sample experiment — a process that can be checked step by step.';
    }
    return compileDirector(p).spec;
  };
  const shot = (spec: ReturnType<typeof build>, frameIndex: number) => {
    const renderer = createSpecRenderer({ spec, width: W, height: H });
    try {
      return Buffer.from(renderer.renderFrame(makeFrameContext({
        frameIndex, fps: 24, totalFrames: Math.ceil(spec.video.duration * 24), width: W, height: H, seed: spec.video.seed,
      })).data);
    } finally { renderer.dispose(); }
  };

  const monoSpec = build(false), bilingualSpec = build(true);
  const frameIndex = Math.round((monoSpec.audio.narration[0]!.start + 1.5) * 24);
  const mono = shot(monoSpec, frameIndex), bilingual = shot(bilingualSpec, frameIndex);

  // 只看深层墨迹（标题）：镜头内的底板与投影都很淡，不会过这个阈值
  const darkRows = (buf: Buffer): boolean[] => {
    const rows: boolean[] = [];
    for (let y = 0; y < H; y++) {
      let dark = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const luma = ((buf[i] as number) * 0.299 + (buf[i + 1] as number) * 0.587 + (buf[i + 2] as number) * 0.114);
        if (luma < 90) dark++;
      }
      rows.push(dark > 0);
    }
    return rows;
  };
  const monoDark = darkRows(mono);
  // 两帧唯一的差别就是双语字幕多出来的图块区域
  const diffRows: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (mono[i] !== bilingual[i] || mono[i + 1] !== bilingual[i + 1] || mono[i + 2] !== bilingual[i + 2]) { diffRows.push(y); break; }
    }
  }

  assert.ok(diffRows.length > 0, '双语帧必须与单语帧不同（第二行真的画上去了）');
  const titleRows = monoDark.slice(0, Math.floor(H * 0.45)).flatMap((has, y) => (has ? [y] : []));
  assert.ok(titleRows.length > 0, '镜头标题应在画面上部可见');
  const titleBottom = titleRows[titleRows.length - 1] as number;
  const translationTop = Math.min(...diffRows);
  assert.ok(translationTop > titleBottom + 8, `字幕扩展区（${translationTop}）应低于标题底边（${titleBottom}）`);

  const safe = safeAreaFor(W, H);
  assert.ok(Math.max(...diffRows) <= Math.round(safe.y + safe.h), '字幕不得越出安全区下沿');
});

function pixels(spec: ReturnType<typeof compileDirector>['spec'], frames: number[]): Buffer[] {
  const renderer = createSpecRenderer({ spec, width: 320, height: 180 });
  try { return frames.map(frameIndex => Buffer.from(renderer.renderFrame(makeFrameContext({ frameIndex, fps: 24, totalFrames: Math.ceil(spec.video.duration * 24), width: 320, height: 180, seed: spec.video.seed })).data)); }
  finally { renderer.dispose(); }
}
test('new scenes move while repeated and out-of-order frames remain pixel identical', () => {
  const spec = compileDirector(plan()).spec;
  const [a, b, c] = pixels(spec, [20, 35, 20]); assert.deepEqual(a, c); assert.notDeepEqual(a, b);
  assert.deepEqual(pixels(spec, [35])[0], b);
});
test('dissolve, wipe and iris show outgoing content at boundary and actual blending during transition', () => {
  for (const transition of ['dissolve', 'wipe', 'iris'] as const) {
    const spec = compileDirector(plan()).spec; spec.scenes[1]!.transition = transition;
    const boundary = Math.round(spec.scenes[1]!.start * 24);
    const outgoing = structuredClone(spec); outgoing.scenes = [outgoing.scenes[0]!];
    assert.deepEqual(pixels(spec, [boundary])[0], pixels(outgoing, [boundary])[0]);
    const cut = structuredClone(spec); cut.scenes[1]!.transition = 'cut';
    assert.notDeepEqual(pixels(spec, [boundary + 4])[0], pixels(cut, [boundary + 4])[0]);
  }
});
test('title fitting respects safe width for Chinese and Latin long titles', () => {
  const c = new Canvas(320, 180).getContext('2d');
  for (const text of ['让每一个微小的想法成为有生命的世界'.repeat(2), 'Supercalifragilisticexpialidocious'.repeat(2)]) {
    const fit = fitTitle(c, text, 250, 24); assert.ok(fit.lines.length <= 3);
    assert.ok(fit.lines.every(l => c.measureText(l).width <= 250));
  }
});
test('BGM provider forwards the visual tempo to the actual waveform synthesizer', async () => {
  const dir = join(PROJECT_ROOT, '.research/out/director-audio'); mkdirSync(dir, { recursive: true });
  const actual = join(dir, 'actual.wav'), expected = join(dir, 'expected.wav');
  await proceduralBgmProvider.render({ preset: 'playful', key: 'C', seed: 4, durationSeconds: 2, bpm: 123, outPath: actual });
  writeBgmWav({ preset: 'playful', key: 'C', seed: 4, durationSeconds: 2, bpm: 123 }, expected);
  assert.deepEqual(readFileSync(actual), readFileSync(expected));
});

test('production guard refuses uncompiled or changed director plans', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { initProject } = await import('../src/project/scaffold.ts');
  const { loadProject } = await import('../src/project/manifest.ts');
  const { assertDirectorCurrent } = await import('../src/cli/director.ts');
  const root = mkdtempSync(join(PROJECT_ROOT, '.research/out/director-guard-'));
  try {
    const dir = initProject({ slug: 'guard', projectsRoot: root }).dir;
    const manifestPath = join(dir, 'project.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.director = 'director.json'; writeFileSync(manifestPath, JSON.stringify(manifest));
    const raw = plan(), compiled = compileDirector(raw).spec;
    writeFileSync(join(dir, 'director.json'), JSON.stringify(raw));
    const project = loadProject(dir);
    assert.doesNotThrow(() => assertDirectorCurrent(project, compiled));
    raw.shots[0]!.title = '变化后的标题'; writeFileSync(join(dir, 'director.json'), JSON.stringify(raw));
    assert.throws(() => assertDirectorCurrent(project, compiled), /DIRECTOR_STALE/);
    raw.shots = []; writeFileSync(join(dir, 'director.json'), JSON.stringify(raw));
    assert.throws(() => assertDirectorCurrent(project, compiled));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('新增绘制参数（圆角/发光/渐变/空心/虚线）都改变像素，且同参数同帧可复现', () => {
  const shot = (mutate: (element: NonNullable<DirectorPlan['shots'][number]['elements']>[number]) => void): Buffer => {
    const p = plan(); p.shots[0]!.actors = [];
    p.shots[0]!.elements = [{ id: 'panel', kind: 'rect', x: 0.5, y: 0.5, width: 0.5, height: 0.4, fill: '#f1aa65' }];
    mutate(p.shots[0]!.elements[0]!);
    return pixels(compileDirector(p).spec, [24])[0]!;
  };
  const plain = shot(() => {});
  const variants: Array<[string, Buffer]> = [
    ['radius', shot(el => { el.radius = 0.4; })],
    ['glow', shot(el => { el.glow = 1; el.stroke = '#fff0d7'; })],
    ['gradient', shot(el => { el.gradient = { from: '#f1aa65', to: '#202b48', angle: 45 }; })],
    ['hollow', shot(el => { el.hollow = true; el.stroke = '#fff0d7'; el.strokeWidth = 0.012; })],
    ['dash', shot(el => { el.hollow = true; el.stroke = '#fff0d7'; el.strokeWidth = 0.012; el.dash = 0.6; })],
  ];
  for (const [name, frame] of variants) assert.notDeepEqual(frame, plain, `${name} 应改变像素`);
  assert.deepEqual(shot(el => { el.glow = 0.5; el.radius = 0.2; }), shot(el => { el.glow = 0.5; el.radius = 0.2; }), '同参数同帧必须逐像素一致');
});

test('关键帧 ease 可选项改变中间帧、默认仍等于 smoothstep、且未知名被拒绝', () => {
  const node = (ease?: string): NonNullable<DirectorPlan['shots'][number]['elements']>[number] => ({
    id: 'node', kind: 'rect', x: 0.3, y: 0.5, width: 0.2, height: 0.2, fill: '#f1aa65',
    keyframes: [{ at: 0, x: 0.2 }, { at: 1, x: 0.8, ...(ease ? { ease } : {}) }],
  });
  // 数值：0.25 处 linear 就是线性中点，smoothstep 明显落后（起步慢，落定稳）
  const near = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-9;
  assert.ok(near(graphicState(node('linear') as never, 0.25).x, 0.35), 'linear 在 0.25 处应落在中点');
  assert.ok(near(graphicState(node() as never, 0.25).x, 0.2 + 0.6 * 0.15625), '默认缓动应等于 smoothstep');
  assert.ok(near(graphicState(node('outCubic') as never, 1).x, 0.8), '走完全程应到达终点');
  const shot = (ease?: string): Buffer => {
    const p = plan(); p.shots[0]!.actors = []; p.shots[0]!.elements = [node(ease)];
    return pixels(compileDirector(p).spec, [24])[0]!;
  };
  assert.deepEqual(shot(), shot('smoothstep'), '显式 smoothstep 必须与省略等价');
  assert.notDeepEqual(shot(), shot('linear'), 'linear 的中间帧必须不同于默认平滑');
  assert.notDeepEqual(shot('outBack'), shot('linear'), '不同缓动必须画出不同像素');
  assert.deepEqual(shot('outBack'), shot('outBack'), '同参数同帧必须逐像素一致');
  const bad = plan(); bad.shots[0]!.actors = []; bad.shots[0]!.elements = [node('springy')];
  assert.throws(() => compileDirector(bad), /导演计划未通过校验/);
});

test('zoom、grid、glitch 转场：边界帧等于上一镜头、中段确实混合、同帧可复现', () => {
  for (const transition of ['zoom', 'grid', 'glitch'] as const) {
    const spec = compileDirector(plan()).spec; spec.scenes[1]!.transition = transition;
    const boundary = Math.round(spec.scenes[1]!.start * 24);
    const outgoing = structuredClone(spec); outgoing.scenes = [outgoing.scenes[0]!];
    const cut = structuredClone(spec); cut.scenes[1]!.transition = 'cut';
    assert.deepEqual(pixels(spec, [boundary])[0], pixels(outgoing, [boundary])[0], `${transition} 边界帧应只有上一镜头`);
    const mid = pixels(spec, [boundary + 4])[0]!;
    assert.notDeepEqual(mid, pixels(cut, [boundary + 4])[0], `${transition} 中段应不同于直接切换`);
    assert.notDeepEqual(mid, pixels(outgoing, [boundary + 4])[0], `${transition} 中段应不同于上一镜头静止帧`);
    assert.deepEqual(pixels(spec, [boundary + 4])[0], mid, `${transition} 同帧重渲染必须一致`);
  }
});
type Elem = NonNullable<DirectorPlan['shots'][number]['elements']>[number];

const shotPixels = (element: Elem, frame = 24): Buffer => {
  const p = plan(); p.shots[0]!.actors = []; p.shots[0]!.elements = [element];
  return pixels(compileDirector(p).spec, [frame])[0]!;
};

test('curve 图元：按弧长描绘的光滑样条，既不同于折线也让 reveal 真正控制进度', () => {
  const arc: Elem = {
    id: 'arc', kind: 'curve', x: 0.5, y: 0.5, width: 0.6, height: 0.4, stroke: '#8ac2c3', strokeWidth: 0.01,
    points: [{ x: 0, y: 0.8 }, { x: 0.5, y: 0 }, { x: 1, y: 0.8 }],
  };
  const curve = shotPixels(arc);
  assert.notDeepEqual(curve, shotPixels({ ...arc, kind: 'polyline' }), 'curve 应画成光滑样条而不是直段折线');
  assert.deepEqual(curve, shotPixels(structuredClone(arc)), '同参数同帧必须逐像素一致');
  const half = shotPixels({ ...arc, keyframes: [{ at: 0, reveal: 0 }, { at: 1, reveal: 1 }] }, 12);
  assert.notDeepEqual(half, curve, 'reveal 推进中的帧必须不同于完整曲线');
  const empty = shotPixels({ ...arc, keyframes: [{ at: 0, reveal: 0 }, { at: 1, reveal: 0 }] }, 12);
  assert.notDeepEqual(empty, half, 'reveal=0 什么都不画');
  assert.deepEqual(empty, shotPixels({ ...arc, keyframes: [{ at: 0, reveal: 0 }, { at: 1, reveal: 0 }] }, 12), '同帧重渲染必须逐像素一致');
  const bad = plan(); bad.shots[0]!.actors = []; bad.shots[0]!.elements = [{ id: 'c', kind: 'curve', x: 0.5, y: 0.5, width: 0.3, height: 0.3 }];
  assert.throws(() => compileDirector(bad), /导演计划未通过校验/, 'curve 缺 points 必须被拒绝');
});

test('glow 与 strokeWidth 成为可动画通道：数值插值、缺省回落、越界被拒', () => {
  const withKeys = (first: Partial<Elem['keyframes']>[number], last: Partial<Elem['keyframes']>[number]): Elem => ({
    id: 'node', kind: 'ellipse', x: 0.5, y: 0.5, width: 0.3, height: 0.3, stroke: '#fff0d7',
    keyframes: [{ at: 0, ...first }, { at: 1, ...last }],
  });
  const ramp = withKeys({ glow: 0.2 }, { glow: 0.9 });
  assert.equal(graphicState(ramp, 0).glow, 0.2);
  assert.equal(graphicState(ramp, 1).glow, 0.9);
  assert.ok(graphicState(ramp, 0.5).glow > 0.2 && graphicState(ramp, 0.5).glow < 0.9, 'glow 应在两帧之间插值');
  const width = withKeys({ strokeWidth: 0.004 }, { strokeWidth: 0.03 });
  assert.equal(graphicState(width, 1).strokeWidth, 0.03);
  // 省略关键帧时回落到元素自身设置：静态 glow/strokeWidth 的行为不变
  const base: Elem = { id: 'node', kind: 'ellipse', x: 0.5, y: 0.5, width: 0.3, height: 0.3, stroke: '#fff0d7', glow: 0.5, strokeWidth: 0.02 };
  assert.equal(graphicState(base, 0.5).glow, 0.5);
  assert.equal(graphicState(base, 0.5).strokeWidth, 0.02);
  assert.deepEqual(shotPixels(base), shotPixels(base), '静态材质同帧必须一致');
  assert.notDeepEqual(shotPixels(ramp, 12), shotPixels(withKeys({ glow: 0.2 }, { glow: 0.2 }), 12), 'glow 关键帧必须改变像素');
  assert.notDeepEqual(shotPixels(width, 12), shotPixels(withKeys({ strokeWidth: 0.004 }, { strokeWidth: 0.004 }), 12), 'strokeWidth 关键帧必须改变像素');
  const bad = plan(); bad.shots[0]!.actors = []; bad.shots[0]!.elements = [withKeys({ glow: 0 }, { glow: 2 })];
  assert.throws(() => compileDirector(bad), /导演计划未通过校验/, 'glow 越界必须被拒绝');
});

test('tilt_up / tilt_down 是竖直推移：与横摇互不为别名，且编译后保留', () => {
  const p = plan(); p.shots[0]!.actors = []; p.shots[0]!.cameraMove = 'tilt_down';
  p.shots[0]!.elements = [{ id: 'dot', kind: 'ellipse', x: 0.5, y: 0.5, width: 0.2, height: 0.2, fill: '#f1aa65' }];
  assert.equal(compileDirector(p).spec.scenes[0]!.cameraMove, 'tilt_down', '编译后应保留新的运镜词汇');
  // 与 pan 一样：起点在正偏移处、终点回到 0，全程只有一个方向
  const down = [cameraFor('tilt_down', 0), cameraFor('tilt_down', 0.5), cameraFor('tilt_down', 1)];
  assert.ok((down[0]!.offsetY ?? 0) > (down[2]!.offsetY ?? 0), 'tilt_down 的画面应一路向下移动');
  assert.equal(down[0]!.offsetX, 0, '俯仰不应产生横向偏移');
  assert.ok((cameraFor('tilt_up', 0).offsetY ?? 0) > 0, 'tilt_up 起手应偏低');
  assert.notDeepEqual(cameraFor('tilt_up', 0), cameraFor('pan_left', 0), '俯仰与横摇不是同一个运动');
  for (const move of ['tilt_up', 'tilt_down', 'pan_left', 'pan_right'] as const) {
    const shot = (cameraMove: typeof move): Buffer => {
      const q = plan(); q.shots[0]!.actors = []; q.shots[0]!.cameraMove = cameraMove;
      q.shots[0]!.elements = [{ id: 'dot', kind: 'ellipse', x: 0.5, y: 0.5, width: 0.2, height: 0.2, fill: '#f1aa65' }];
      return pixels(compileDirector(q).spec, [4])[0]!;
    };
    assert.notDeepEqual(shot(move), shot('static'), `${move} 必须真的推移画面`);
    assert.deepEqual(shot(move), shot(move), `${move} 同帧必须可复现`);
  }
});

test('tokenize 转场：边界帧等于上一镜头、中段逐行错峰、同帧可复现', () => {
  const spec = compileDirector(plan()).spec; spec.scenes[1]!.transition = 'tokenize';
  const boundary = Math.round(spec.scenes[1]!.start * 24);
  const outgoing = structuredClone(spec); outgoing.scenes = [outgoing.scenes[0]!];
  const cut = structuredClone(spec); cut.scenes[1]!.transition = 'cut';
  const at = (s: typeof spec, frame: number): Buffer => pixels(s, [frame])[0]!;
  assert.deepEqual(at(spec, boundary), at(outgoing, boundary), '边界帧应只有上一镜头');
  for (const offset of [2, 5, 8]) {
    const mid = at(spec, boundary + offset);
    assert.notDeepEqual(mid, at(cut, boundary + offset), `中段 +${offset} 帧应不同于直接切换`);
    assert.notDeepEqual(mid, at(outgoing, boundary + offset), `中段 +${offset} 帧应不同于上一镜头静止帧`);
    assert.deepEqual(at(spec, boundary + offset), mid, '同帧重渲染必须一致');
  }
  // 错峰：同一时刻上排已经切到新画面、下排还停在旧画面
  const strip = (buf: Buffer, y: number): Buffer => buf.subarray(y * 320 * 4, (y + 1) * 320 * 4);
  const distance = (a: Buffer, b: Buffer): number => a.reduce((sum, v, i) => sum + Math.abs(v - (b[i] ?? 0)), 0);
  const frame = boundary + 3;
  for (const y of [4, 168]) {
    const mid = strip(at(spec, frame), y), oldRow = strip(at(outgoing, frame), y), newRow = strip(at(cut, frame), y);
    if (y === 4) assert.ok(distance(mid, newRow) < distance(mid, oldRow), '上排应已切到新镜头');
    else assert.ok(distance(mid, oldRow) < distance(mid, newRow), '下排应仍停在上一镜头');
  }
});

test('镜头标题在混合类转场里让位：前 0.1 秒不与上一镜标题同屏', () => {
  // 两镜同底色，只有标题不同；标题带内的显著差异就只可能来自标题本身。
  const p = plan();
  for (const s of p.shots) { s.actors = []; s.backdrop = 'night'; s.motif = 'none'; }
  p.shots[1]!.transition = 'dissolve';
  const spec = compileDirector(p).spec;
  const start = Math.round(spec.scenes[1]!.start * 24);
  /** 标题带：画面 0–0.21h。带内只有镜头标题、底色与每个镜头各自的淡色块。 */
  const band = (frame: number): Buffer => pixels(spec, [frame])[0]!.subarray(0, 320 * 38 * 4);
  // 每镜各自的淡色块（4% alpha）会带来约 10 个色阶的差异，标题墨色是 200 量级。
  // 阈值取 40：既能忽略底色块，又不会漏掉任何可见的标题笔画。
  const changed = (a: Buffer, b: Buffer): number => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 40) n++;
    return n;
  };
  assert.equal(changed(band(start), band(start + 2)), 0, '转场起点处新标题必须完全透明，否则会与旧标题叠成重影');
  assert.ok(changed(band(start + 12), band(start)) > 20, '0.5 秒后新标题必须已经出现');
  // 同一镜头内：前 0.1 秒标题带保持稳定，一旦出现就逐帧变化
  const only = structuredClone(spec); only.scenes = [only.scenes[0]!];
  assert.equal(changed(band(start + 2), band(start + 2)), 0);
  const cut0 = pixels(only, [0])[0]!.subarray(0, 320 * 38 * 4);
  const cut2 = pixels(only, [2])[0]!.subarray(0, 320 * 38 * 4);
  assert.equal(changed(cut0, cut2), 0, '镜头开头 0.1 秒内标题不应已可见');
});
