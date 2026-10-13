import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spring, springTrack } from '../src/animation/spring.ts';

test('spring agrees with an independent numerical mass-spring integration in all damping regimes', () => {
  const dt = 1 / 100000;
  for (const damping of [0, 8, 20, 40]) {
    let position = 0, velocity = 0;
    for (let step = 1; step <= 100000; step++) {
      velocity += (100 * (1 - position) - damping * velocity) * dt;
      position += velocity * dt;
      if (step % 10000 === 0) assert.ok(Math.abs(spring(step * dt, { stiffness: 100, damping }) - position) < 0.0001);
    }
  }
  assert.ok(Math.abs(spring(0.3, { stiffness: 400, damping: 80, mass: 4 }) - spring(0.3, { stiffness: 100, damping: 20 })) < 1e-12);
});

test('spring starts at rest, preserves deliberate overshoot and settles according to damping', () => {
  assert.equal(spring(-1), 0);
  assert.equal(spring(0), 0);
  assert.ok(spring(0.35, { stiffness: 100, damping: 8 }) > 1);
  assert.ok(spring(0.3, { stiffness: 100, damping: 40 }) < spring(0.3, { stiffness: 100, damping: 20 }));
  for (const damping of [20, 20 - 1e-7, 20 + 1e-7, 40]) {
    const values = Array.from({ length: 1001 }, (_, index) => spring(index / 100, { stiffness: 100, damping }));
    assert.ok(values.every((value, index) => value >= 0 && value <= 1 && (!index || value >= values[index - 1]!)));
    assert.ok(Math.abs(values.at(-1)! - 1) < 1e-9);
  }
});

test('target changes preserve position and velocity during an unfinished move', () => {
  const keys = [[0, 10], [0.2, 110], [0.35, -20], [0.48, 70]] as const;
  const h = 1e-6;
  for (const [at] of keys.slice(1)) {
    const center = springTrack(at, keys);
    const leftVelocity = (center - springTrack(at - h, keys)) / h;
    const rightVelocity = (springTrack(at + h, keys) - center) / h;
    assert.ok(Math.abs(leftVelocity - rightVelocity) < 0.04);
  }
  assert.equal(springTrack(-2, keys), 10);
  assert.ok(Math.abs(springTrack(10, keys) - 70) < 1e-9);
  const times = [0, 0.24, 0.35, 0.48, 0.7, 3];
  const sequential = times.map(time => springTrack(time, keys));
  assert.deepEqual([...times].reverse().map(time => springTrack(time, keys)), sequential.reverse());
});

test('invalid motion inputs fail before propagating NaN into geometry', () => {
  for (const options of [{ stiffness: 0 }, { damping: -1 }, { mass: 0 }, { damping: Infinity }]) {
    assert.throws(() => spring(1, options), /SPRING_PARAMETERS/);
  }
  assert.throws(() => springTrack(NaN, [[0, 1]]), /SPRING_PARAMETERS/);
  for (const keys of [[], [[0, 1], [0, 2]], [[1, 0], [0, 3]], [[0, NaN]]]) {
    assert.throws(() => springTrack(1, keys as [number, number][]), /SPRING_KEYS/);
  }
});
