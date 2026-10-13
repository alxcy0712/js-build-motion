import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Canvas, Path2D } from 'skia-canvas';
import { smootherstep } from '../src/animation/easing.ts';
import { prepareParticleAssembly, particleAssemblyAt, type ParticleAssemblyOptions } from '../src/drawing/primitives/particle-assembly.ts';

const probe = new Canvas(1, 1).getContext('2d');
const ring = new Path2D('M0 0H100V100H0Z M30 30H70V70H30Z M120 0H150V40H120Z');
const options: ParticleAssemblyOptions = {
  bounds: { x: 0, y: 0, width: 150, height: 100 },
  contains: (x, y) => probe.isPointInPath(ring, x, y, 'evenodd'),
  source: { x: -100, y: 130, width: 90, height: 40 },
  bend: [-20, 20], approach: [-30, 25], radius: [.5, 1], count: 480,
  seed: 'ring-and-block', start: .2, duration: 2, stagger: .6,
};

test('targets preserve holes and disconnected parts in the supplied fill rule', () => {
  const assembly = prepareParticleAssembly(options);
  assert.equal(assembly.particles.length, 480);
  assert.ok(assembly.particles.every(p => options.contains(...p.to)));
  assert.ok(assembly.particles.some(p => p.to[0] > 120));
  assert.ok(assembly.particles.some(p => p.to[0] < 100));
  assert.ok(assembly.particles.every(p => !(p.to[0] > 30 && p.to[0] < 70 && p.to[1] > 30 && p.to[1] < 70)));
  const nonzeroRing = new Path2D('M0 0H100V100H0Z M30 30V70H70V30Z');
  const nonzero = prepareParticleAssembly({ ...options, contains: (x, y) => probe.isPointInPath(nonzeroRing, x, y, 'nonzero') });
  assert.ok(nonzero.particles.every(p => !(p.to[0] > 30 && p.to[0] < 70 && p.to[1] > 30 && p.to[1] < 70)));
});

test('seed fixes targets and trajectories; changing appearance preserves the targets', () => {
  const a = prepareParticleAssembly(options);
  assert.deepEqual(a, prepareParticleAssembly(options));
  assert.notDeepEqual(a.particles, prepareParticleAssembly({ ...options, seed: 'another-ring' }).particles);
  assert.deepEqual(a.particles.map(p => p.to), prepareParticleAssembly({ ...options, radius: [2, 4], duration: 1 }).particles.map(p => p.to));
  assert.ok(a.particles.every(p => p.from[0] >= -100 && p.from[0] <= -10 && p.from[1] >= 130 && p.from[1] <= 170 && p.radius >= .5 && p.radius <= 1));
});

test('each staggered particle holds its exact start and target outside its flight interval', () => {
  const assembly = prepareParticleAssembly(options);
  const before = particleAssemblyAt(assembly, -1), after = particleAssemblyAt(assembly, 4);
  for (const [i, p] of assembly.particles.entries()) {
    assert.deepEqual([before[i]!.x, before[i]!.y, before[i]!.opacity], [...p.from, 0]);
    assert.deepEqual([after[i]!.x, after[i]!.y, after[i]!.progress], [...p.to, 1]);
  }
  const staggered = particleAssemblyAt(assembly, .4);
  assert.ok(staggered.some(p => p.progress === 0));
  assert.ok(staggered.some(p => p.progress > 0));
});

test('curves remain finite and within their control hull, with smooth endpoint arrival', () => {
  const assembly = prepareParticleAssembly({ ...options, count: 24 });
  for (let frame = 0; frame <= 90; frame++) {
    const states = particleAssemblyAt(assembly, frame / 30);
    for (const [i, state] of states.entries()) {
      const p = assembly.particles[i]!;
      assert.ok(Object.values(state).every(Number.isFinite));
      assert.ok(state.progress >= 0 && state.progress <= 1 && state.opacity >= 0 && state.opacity <= 1);
      for (const [axis, value] of [state.x, state.y].entries()) {
        const controls = [p.from[axis]!, assembly.bend[axis]!, p.to[axis]! + assembly.approach[axis]!, p.to[axis]!];
        assert.ok(value >= Math.min(...controls) - 1e-9 && value <= Math.max(...controls) + 1e-9);
      }
    }
  }
  for (const [i, p] of assembly.particles.entries()) {
    const begin = assembly.start + p.delay, epsilon = assembly.duration * 1e-4;
    const first = particleAssemblyAt(assembly, begin + epsilon)[i]!;
    const last = particleAssemblyAt(assembly, begin + assembly.duration - epsilon)[i]!;
    assert.ok(Math.hypot(first.x - p.from[0], first.y - p.from[1]) < 1e-6);
    assert.ok(Math.hypot(last.x - p.to[0], last.y - p.to[1]) < 1e-6);
  }
});

test('random-access evaluation is repeatable and leaves its prepared input untouched', () => {
  const assembly = prepareParticleAssembly(options), saved = structuredClone(assembly);
  const a = particleAssemblyAt(assembly, 1.7);
  particleAssemblyAt(assembly, 4); particleAssemblyAt(assembly, .1);
  assert.deepEqual(a, particleAssemblyAt(assembly, 1.7));
  a[0]!.x = -999;
  assert.notDeepEqual(a, particleAssemblyAt(assembly, 1.7));
  assert.deepEqual(assembly, saved);
});

test('an empty mask stops within a finite sampling budget and invalid timing is rejected', () => {
  let calls = 0;
  assert.throws(() => prepareParticleAssembly({ ...options, count: 4, contains: () => { calls++; return false; } }), /SAMPLING/);
  assert.ok(calls > 0 && calls <= 800);
  for (const change of [{ duration: 0 }, { stagger: -1 }, { count: 1.5 }, { bounds: { x: 0, y: 0, width: 0, height: 10 } }, { radius: [2, 1] as const }]) {
    assert.throws(() => prepareParticleAssembly({ ...options, ...change }), /INPUT/);
  }
  assert.throws(() => particleAssemblyAt(prepareParticleAssembly(options), NaN), /TIME/);
});

test('particle-to-solid handoff finishes at the exact original mask, including negative space', () => {
  const assembly = prepareParticleAssembly(options);
  function pixels(time: number, reference = false) {
    const canvas = new Canvas(320, 220), ctx = canvas.getContext('2d');
    ctx.translate(100, 10); ctx.fillStyle = '#276b62';
    const solid = reference ? 1 : smootherstep(1.8, 3, time);
    for (const p of particleAssemblyAt(assembly, time)) {
      ctx.globalAlpha = p.opacity * (1 - solid);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = solid; ctx.fill(ring, 'evenodd');
    return ctx.getImageData(0, 0, 320, 220).data;
  }
  assert.deepEqual(pixels(3), pixels(3, true));
  assert.deepEqual(pixels(4), pixels(3, true));
  assert.notDeepEqual(pixels(2), pixels(3, true));
  assert.equal(pixels(3)[(60 * 320 + 150) * 4 + 3], 0);
});
