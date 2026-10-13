/** Continuous beat clock; frame order never affects the result. */
export function beatAt(time: number, bpm: number): number { return time * bpm / 60; }
export function beatPulse(time: number, bpm: number): number {
  const beat = beatAt(time, bpm);
  return Math.exp(-7 * (beat - Math.floor(beat)));
}
export function easeOutBack(t: number): number {
  const x = Math.max(0, Math.min(1, t)) - 1;
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
}
