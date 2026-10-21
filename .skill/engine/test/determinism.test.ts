/**
 * 确定性渲染测试（Phase C，需求 §5、§6、§7、§25、§31）。
 *
 * 这些测试守护的是项目最核心的承诺：
 *   「同一 (spec, seed, frameIndex) 必然产出逐像素相同的结果，且不依赖任何前置帧。」
 *
 * 一旦这条被破坏，黄金帧回归、断点续渲、多进程并行渲染全部失效。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { SeededRandom, mulberry32, seededArray } from '../src/animation/random.ts';
import { fbm2D, fbm3D, noise1D, noise2D, noise3D } from '../src/animation/noise.ts';
import { breathe, clamp, easing, lerp, pingPong, remap, smoothstep } from '../src/animation/easing.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { SkiaRenderer } from '../src/renderer/skia/skia-renderer.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { frameCount, frameToSeconds, normalizedProgress, sceneProgress, secondsToFrame } from '../src/timeline/frame.ts';
import { CANONICAL_HEIGHT, CANONICAL_WIDTH, drawCanonicalBackdrop, drawCanonicalScene } from './fixtures/canonical-scene.ts';

const FPS = 24;
const TOTAL_FRAMES = 288;
const SEED = 20260926;

function hashOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function renderFrameHash(frameIndex: number, opts: { seed?: number; backdropOnly?: boolean } = {}): string {
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: opts.backdropOnly ? drawCanonicalBackdrop : drawCanonicalScene,
  });
  try {
    const rc = makeFrameContext({
      frameIndex,
      totalFrames: TOTAL_FRAMES,
      fps: FPS,
      width: CANONICAL_WIDTH,
      height: CANONICAL_HEIGHT,
      seed: opts.seed ?? SEED,
    });
    return hashOf(renderer.renderFrame(rc).data);
  } finally {
    renderer.dispose();
  }
}

// ------------------------------------------------------------ 随机访问

test('renderFrame 可随机访问：孤立渲染与顺序渲染逐像素一致', () => {
  // 1) 顺序渲染 0..240，记下抽样帧
  const targets = [0, 1, 57, 240];
  const sequential = new Map<number, string>();
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: drawCanonicalScene,
  });
  try {
    const maxFrame = Math.max(...targets);
    for (let i = 0; i <= maxFrame; i++) {
      const rc = makeFrameContext({
        frameIndex: i,
        totalFrames: TOTAL_FRAMES,
        fps: FPS,
        width: CANONICAL_WIDTH,
        height: CANONICAL_HEIGHT,
        seed: SEED,
      });
      const h = hashOf(renderer.renderFrame(rc).data);
      if (targets.includes(i)) sequential.set(i, h);
    }
  } finally {
    renderer.dispose();
  }

  // 2) 用全新渲染器实例孤立渲染同样的帧，且刻意打乱顺序
  for (const frameIndex of [...targets].reverse()) {
    const isolated = renderFrameHash(frameIndex);
    assert.equal(
      isolated,
      sequential.get(frameIndex),
      `第 ${frameIndex} 帧的孤立渲染结果应与顺序渲染一致（说明渲染不依赖前置帧）`,
    );
  }
});

test('每一步的帧间状态都被重置：连续渲染不同帧不会互相污染', () => {
  const renderer = new SkiaRenderer({
    width: CANONICAL_WIDTH,
    height: CANONICAL_HEIGHT,
    draw: drawCanonicalScene,
  });
  try {
    const rcFor = (i: number): ReturnType<typeof makeFrameContext> =>
      makeFrameContext({
        frameIndex: i,
        totalFrames: TOTAL_FRAMES,
        fps: FPS,
        width: CANONICAL_WIDTH,
        height: CANONICAL_HEIGHT,
        seed: SEED,
      });

    // A→B 与 B→A 两条路径下，B 的结果必须相同
    const a = hashOf(renderer.renderFrame(rcFor(100)).data);
    const b = hashOf(renderer.renderFrame(rcFor(7)).data);
    renderer.renderFrame(rcFor(250));
    const bAgain = hashOf(renderer.renderFrame(rcFor(7)).data);
    const aAgain = hashOf(renderer.renderFrame(rcFor(100)).data);

    assert.equal(b, bAgain, '第 7 帧不应受其间渲染的其它帧影响');
    assert.equal(a, aAgain, '第 100 帧不应受其间渲染的其它帧影响');
  } finally {
    renderer.dispose();
  }
});

// --------------------------------------------------------- 跨进程一致性

test('两个独立进程渲染同一帧得到相同 SHA-256', () => {
  const fixture = join(PROJECT_ROOT, 'test', 'fixtures', 'render-frame.ts');
  const runOnce = (frameIndex: number): { sha256: string; bytes: number } => {
    const out = execFileSync(process.execPath, [fixture, String(SEED), String(frameIndex), String(TOTAL_FRAMES)], {
      encoding: 'utf8',
    });
    return JSON.parse(out) as { sha256: string; bytes: number };
  };

  for (const frameIndex of [0, 33, 191]) {
    const first = runOnce(frameIndex);
    const second = runOnce(frameIndex);
    assert.equal(
      first.sha256,
      second.sha256,
      `第 ${frameIndex} 帧在两个独立进程中应得到相同哈希`,
    );
    assert.equal(first.bytes, CANONICAL_WIDTH * CANONICAL_HEIGHT * 4);
  }
});

test('不同 seed 产出不同画面（seed 确实在起作用）', () => {
  const a = renderFrameHash(60, { seed: 1 });
  const b = renderFrameHash(60, { seed: 2 });
  assert.notEqual(a, b, '换 seed 应改变画面，否则 seed 没有真正接入');
});

// ------------------------------------------------------------- 纹理稳定

test('固定背景逐帧稳定：相邻帧的固定背景层逐像素完全一致（不闪烁）', () => {
  const hashes = [9, 10, 11, 12].map((i) => renderFrameHash(i, { backdropOnly: true }));
  assert.equal(new Set(hashes).size, 1, `固定背景层在相邻帧之间必须完全一致，实际得到 ${hashes.length} 种结果`);
});

test('纹理随时间的变化是连续的，不是逐帧重随机', () => {
  // 固定背景的 breatheTime 走 noise2D 采样（速度 0.08/秒）。
  // 这里直接用更激进的采样步长检验「变化连续」这一性质本身：
  // 若用 Math.random() 逐帧重随机，相邻采样的差值会均匀分布在 [0,1)，
  // 而噪声的相邻采样差值应当显著更小。
  const step = 0.5;
  const samples = [0, 1, 2, 3, 4, 5].map((i) => noise2D(i * step * 0.08, 0.37, 4242));
  const deltas = samples.slice(1).map((v, i) => Math.abs(v - (samples[i] as number)));
  const maxDelta = Math.max(...deltas);
  assert.ok(
    maxDelta < 0.25,
    `相邻时间采样的最大变化 ${maxDelta.toFixed(3)} 过大；超过 0.25 意味着视觉上接近逐帧重随机`,
  );

  // 对照：真正的逐帧随机，其相邻差值的期望远大于噪声
  const rng = new SeededRandom(4242);
  const randomDeltas = Array.from({ length: 200 }, () => Math.abs(rng.next() - rng.next()));
  const randomMean = randomDeltas.reduce((a, b) => a + b, 0) / randomDeltas.length;
  const noiseMean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  assert.ok(
    noiseMean < randomMean / 3,
    `噪声的平均相邻变化 (${noiseMean.toFixed(3)}) 应远小于逐帧随机 (${randomMean.toFixed(3)})`,
  );
});

// ------------------------------------------------- 渲染核心禁用系统时间

/**
 * 把注释与字符串内容置空，但**保留换行符**，使行号不变。
 *
 * 为什么需要状态机而不是逐行正则：
 *   - 块注释可以跨行。逐行处理会把跨行块注释中间的文字当成代码，造成**误报**
 *     （本测试第一次跑就是这样误报了 random.ts / noise.ts 里的文档注释）。
 *   - 字符串里的双斜线（例如 URL）会让朴素的「去掉行注释」逻辑误删后续代码，
 *     造成**漏报**。
 *
 * 这个函数的正确性直接决定本测试的意义，所以它自己也需要被验证
 * （见下面的「注释/字符串剥离器自身可靠」测试）。
 */
function stripCommentsAndStrings(src: string): string {
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let out = '';
  let state: State = 'code';
  let i = 0;

  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');

  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && n === '/') { out += '  '; i += 2; state = 'line'; continue; }
        if (c === '/' && n === '*') { out += '  '; i += 2; state = 'block'; continue; }
        if (c === "'") { out += c; i++; state = 'single'; continue; }
        if (c === '"') { out += c; i++; state = 'double'; continue; }
        if (c === '`') { out += c; i++; state = 'template'; continue; }
        out += c; i++; continue;

      case 'line':
        if (c === '\n') { out += '\n'; state = 'code'; } else out += ' ';
        i++; continue;

      case 'block':
        if (c === '*' && n === '/') { out += '  '; i += 2; state = 'code'; continue; }
        out += blank(c); i++; continue;

      case 'single':
      case 'double':
      case 'template': {
        const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`';
        if (c === '\\') { out += '  '; i += 2; continue; }
        if (c === quote) { out += c; i++; state = 'code'; continue; }
        out += blank(c); i++; continue;
      }
    }
  }
  return out;
}

/** 返回首个违规的行号与标签；没有则返回 null */
function findBannedApi(source: string): Array<{ line: number; label: string }> {
  const banned: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bperformance\.now\s*\(/, 'performance.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bnew\s+Date\s*\(/, 'new Date()'],
  ];
  const stripped = stripCommentsAndStrings(source);
  const hits: Array<{ line: number; label: string }> = [];
  stripped.split('\n').forEach((line, idx) => {
    for (const [re, label] of banned) {
      if (re.test(line)) hits.push({ line: idx + 1, label });
    }
  });
  return hits;
}

test('注释/字符串剥离器自身可靠（否则禁用 API 检查形同虚设）', () => {
  // 必须报出：真实调用
  assert.deepEqual(findBannedApi('const x = Math.random();').map((h) => h.label), ['Math.random()']);
  assert.deepEqual(findBannedApi('const t = Date.now();').map((h) => h.label), ['Date.now()']);

  // 必须忽略：行注释 / 块注释 / 字符串中的字样
  assert.deepEqual(findBannedApi('// 这里说明 Math.random() 被禁用'), []);
  assert.deepEqual(findBannedApi('/**\n * 禁用 Math.random()\n */'), []);
  assert.deepEqual(findBannedApi('const msg = "Math.random()";'), []);
  assert.deepEqual(findBannedApi('const msg = `Date.now()`;'), []);

  // 字符串里的 // 不应把后续真实调用一起吃掉（漏报防护）
  const urlThenCall = 'const u = "https://example.com";\nconst bad = Math.random();';
  assert.deepEqual(findBannedApi(urlThenCall).map((h) => h.line), [2]);

  // 行号必须保持原样
  assert.deepEqual(findBannedApi('a\nb\n\nMath.random();').map((h) => h.line), [4]);
});

test('渲染核心路径不含 Date.now / performance.now / Math.random', () => {
  const coreDirs = ['renderer', 'drawing', 'animation', 'timeline'].map((d) => join(PROJECT_ROOT, 'src', d));
  const offenders: string[] = [];

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  };

  let scanned = 0;
  for (const dir of coreDirs) {
    for (const file of walk(dir)) {
      scanned++;
      for (const hit of findBannedApi(readFileSync(file, 'utf8'))) {
        offenders.push(`${file.replace(PROJECT_ROOT + '/', '')}:${hit.line} 使用了 ${hit.label}`);
      }
    }
  }

  // 防止「扫了 0 个文件」这种看似通过的情况
  assert.ok(scanned >= 8, `应扫描到渲染核心文件，实际只扫到 ${scanned} 个`);
  assert.deepEqual(offenders, [], `渲染核心禁止依赖系统时间或全局随机:\n${offenders.join('\n')}`);
});

// ------------------------------------------------------------------ 噪声

test('noise2D / noise3D 是纯函数且值域在 [0,1)', () => {
  for (let i = 0; i < 200; i++) {
    const v = noise2D(i * 0.37, i * 0.11, 7);
    assert.equal(v, noise2D(i * 0.37, i * 0.11, 7), '相同输入必须相同输出');
    assert.ok(v >= 0 && v < 1, `noise2D 越界: ${v}`);

    const w = noise3D(i * 0.37, i * 0.11, i * 0.05, 7);
    assert.equal(w, noise3D(i * 0.37, i * 0.11, i * 0.05, 7));
    assert.ok(w >= 0 && w < 1, `noise3D 越界: ${w}`);
  }
});

test('noise 空间连续：微小位移不会造成数值跳变', () => {
  let maxDelta = 0;
  for (let i = 0; i < 300; i++) {
    const x = i * 0.13;
    const d = Math.abs(noise2D(x + 0.01, 0.5, 99) - noise2D(x, 0.5, 99));
    maxDelta = Math.max(maxDelta, d);
  }
  assert.ok(maxDelta < 0.05, `相邻采样的最大跳变 ${maxDelta.toFixed(4)} 过大，纹理会出现条纹`);
});

test('fbm 叠加后值域仍被限制在 [0,1)', () => {
  for (let i = 0; i < 100; i++) {
    const v = fbm2D(i * 0.21, i * 0.17, 3, { octaves: 5 });
    assert.ok(v >= 0 && v < 1, `fbm2D 越界: ${v}`);
    const w = fbm3D(i * 0.21, i * 0.17, i * 0.03, 3, { octaves: 4 });
    assert.ok(w >= 0 && w < 1, `fbm3D 越界: ${w}`);
  }
});

test('noise1D 与 noise2D 同源，保证一维抖动与二维纹理风格一致', () => {
  assert.equal(noise1D(3.3, 5), noise2D(3.3, 0.5, 5));
});

// ------------------------------------------------------------------ 随机

test('SeededRandom 同 seed 同序列，不同 seed 不同序列', () => {
  const a = new SeededRandom(42);
  const b = new SeededRandom(42);
  const c = new SeededRandom(43);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  const seqC = Array.from({ length: 20 }, () => c.next());
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('fork 的子流与父流消耗进度无关（结构稳定性）', () => {
  const parent1 = new SeededRandom(7);
  const child1 = parent1.fork('rain');
  const first = Array.from({ length: 10 }, () => child1.next());

  // 父流先消耗一堆随机数，再 fork 同名子流
  const parent2 = new SeededRandom(7);
  for (let i = 0; i < 500; i++) parent2.next();
  const child2 = parent2.fork('rain');
  const second = Array.from({ length: 10 }, () => child2.next());

  assert.deepEqual(first, second, '子流必须只由 (seed, label) 决定，不受父流进度影响');
});

test('mulberry32 输出落在 [0,1)', () => {
  const rng = mulberry32(123);
  for (let i = 0; i < 5000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `越界: ${v}`);
  }
});

test('seededArray 每次调用产生相同数组', () => {
  const make = (rng: SeededRandom): number => rng.next();
  assert.deepEqual(seededArray(11, 50, make), seededArray(11, 50, make));
  assert.notDeepEqual(seededArray(11, 50, make), seededArray(12, 50, make));
});

// ------------------------------------------------------------------ 时间轴

test('时间轴换算：帧与秒互为逆运算且无累积误差', () => {
  assert.equal(frameCount(24, 8), 192);
  assert.equal(frameCount(24, 2.5), 60);
  assert.equal(frameToSeconds(240, 24), 10);
  assert.equal(secondsToFrame(10, 24), 240);

  // 长视频不漂移：第 100000 帧仍精确等于 100000/24 秒
  assert.equal(frameToSeconds(100000, 24), 100000 / 24);

  // 浮点边界：8.0 * 24 在浮点下可能得到 191.99999，round 后仍是 192
  assert.equal(frameCount(24, 8.0), 192);
});

test('进度换算在边界上被正确钳制', () => {
  assert.equal(normalizedProgress(0, 1), 0);
  assert.equal(normalizedProgress(0, 100), 0);
  assert.equal(normalizedProgress(99, 100), 1);
  assert.equal(sceneProgress(0, 0, 1), 0);
  assert.equal(sceneProgress(0, 10, 20), 0);
  assert.equal(sceneProgress(10, 10, 20), 0);
  assert.equal(sceneProgress(29, 10, 20), 1);
  assert.equal(sceneProgress(999, 10, 20), 1);
});

test('缓动函数在 [0,1] 两端锚定', () => {
  for (const [name, fn] of Object.entries(easing)) {
    if (name === 'outElastic') continue; // 弹性缓动在 t=0/1 之外的中间值才体现特征
    assert.ok(Math.abs(fn(0) - 0) < 1e-9, `${name}(0) 应为 0`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1) 应为 1`);
  }
});

test('工具函数边界行为正确', () => {
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(remap(5, 0, 10, 0, 100), 50);
  assert.equal(remap(0, 0, 0, 3, 9), 3, '分母为 0 时回退到 outMin');
  assert.equal(remap(20, 0, 10, 0, 100), 100, '超出输入范围应被钳制');
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(breathe(0), 0.5);
  assert.equal(pingPong(0), 0);
  assert.equal(pingPong(0.5), 1);
});
