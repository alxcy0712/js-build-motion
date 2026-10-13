import { smootherstep } from '../../animation/easing.ts';
import { SeededRandom } from '../../animation/random.ts';

type Point = readonly [number, number];
interface Bounds { x: number; y: number; width: number; height: number }
export interface AssemblyParticle {
  readonly from: Point;
  readonly to: Point;
  readonly delay: number;
  readonly radius: number;
}
export interface ParticleAssembly {
  readonly particles: readonly AssemblyParticle[];
  readonly bend: Point;
  readonly approach: Point;
  readonly start: number;
  readonly duration: number;
}
export interface ParticleAssemblyOptions {
  bounds: Bounds;
  contains: (x: number, y: number) => boolean;
  source: Bounds;
  /** First control point; approach is the second control point's offset from each target. */
  bend: Point;
  approach: Point;
  count: number;
  seed: number | string;
  duration: number;
  start?: number;
  stagger?: number;
  radius?: readonly [number, number];
}

/** Prepare once. The containment predicate and bounds share the drawing's local coordinates. */
export function prepareParticleAssembly(options: ParticleAssemblyOptions): ParticleAssembly {
  const { bounds, contains, source, bend, approach, count, seed, duration } = options;
  const start = options.start ?? 0, stagger = options.stagger ?? .5, radius = options.radius ?? [1, 2];
  const validBounds = (b: Bounds) => [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width >= 0 && b.height >= 0;
  if (!validBounds(bounds) || bounds.width === 0 || bounds.height === 0 || !validBounds(source) ||
      ![...bend, ...approach, start, duration, stagger, ...radius].every(Number.isFinite) ||
      !Number.isInteger(count) || count < 1 || duration <= 0 || stagger < 0 || radius[0] <= 0 || radius[1] < radius[0] ||
      (typeof seed === 'number' && !Number.isFinite(seed))) throw new Error('PARTICLE_ASSEMBLY_INPUT');

  const random = new SeededRandom(seed), targets = random.fork('targets'), flight = random.fork('flight');
  const particles: AssemblyParticle[] = [];
  // A finite budget catches empty masks, mismatched coordinates, and excessively loose bounds.
  for (let attempt = 0; attempt < count * 200 && particles.length < count; attempt++) {
    const x = targets.range(bounds.x, bounds.x + bounds.width), y = targets.range(bounds.y, bounds.y + bounds.height);
    if (!contains(x, y)) continue;
    particles.push({
      from: [flight.range(source.x, source.x + source.width), flight.range(source.y, source.y + source.height)],
      to: [x, y], delay: flight.range(0, stagger), radius: flight.range(radius[0], radius[1]),
    });
  }
  if (particles.length !== count) throw new Error(`PARTICLE_ASSEMBLY_SAMPLING: ${particles.length}/${count}; check containment and tighten bounds`);
  return { particles, bend: [...bend], approach: [...approach], start, duration };
}

function cubic(t: number, a: number, b: number, c: number, d: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

/** Absolute seconds, independent of render order. Apply the solid handoff opacity when drawing. */
export function particleAssemblyAt(assembly: ParticleAssembly, time: number) {
  if (!Number.isFinite(time)) throw new Error('PARTICLE_ASSEMBLY_TIME');
  return assembly.particles.map(particle => {
    const begin = assembly.start + particle.delay;
    const progress = smootherstep(begin, begin + assembly.duration, time);
    return {
      x: cubic(progress, particle.from[0], assembly.bend[0], particle.to[0] + assembly.approach[0], particle.to[0]),
      y: cubic(progress, particle.from[1], assembly.bend[1], particle.to[1] + assembly.approach[1], particle.to[1]),
      radius: particle.radius, progress, opacity: Math.min(1, progress * 4),
    };
  });
}
