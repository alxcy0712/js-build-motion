/** Analytic, unit-step spring response. Time is in seconds; evaluation is stateless. */
export interface SpringOptions {
  stiffness?: number;
  damping?: number;
  mass?: number;
}

export function spring(time: number, { stiffness = 170, damping = 26, mass = 1 }: SpringOptions = {}): number {
  if (![time, stiffness, damping, mass].every(Number.isFinite) || stiffness <= 0 || damping < 0 || mass <= 0) {
    throw new Error('SPRING_PARAMETERS: finite time, positive stiffness/mass and nonnegative damping required');
  }
  if (time <= 0) return 0;
  const frequency = Math.sqrt(stiffness / mass);
  const ratio = damping / (2 * Math.sqrt(stiffness * mass));
  if (Math.abs(ratio - 1) < 1e-8) return 1 - Math.exp(-frequency * time) * (1 + frequency * time);
  if (ratio < 1) {
    const damped = frequency * Math.sqrt(1 - ratio * ratio);
    return 1 - Math.exp(-ratio * frequency * time) *
      (Math.cos(damped * time) + ratio * frequency / damped * Math.sin(damped * time));
  }
  const sum = ratio + Math.sqrt(ratio * ratio - 1);
  const slow = frequency / sum, fast = frequency * sum;
  return 1 - (fast * Math.exp(-slow * time) - slow * Math.exp(-fast * time)) / (fast - slow);
}

/** First key is the initial value, held before its time. Later keys change the target. */
export function springTrack(time: number, keys: readonly (readonly [number, number])[], options: SpringOptions = {}): number {
  if (!keys.length || keys.some(([at, value], index) =>
    !Number.isFinite(at) || !Number.isFinite(value) || (index > 0 && at <= keys[index - 1]![0]))) {
    throw new Error('SPRING_KEYS: finite, strictly increasing times and finite values required');
  }
  spring(time, options);
  let value = keys[0]![1];
  for (let index = 1; index < keys.length; index++) {
    const [at, target] = keys[index]!;
    value += (target - keys[index - 1]![1]) * spring(time - at, options);
  }
  return value;
}
