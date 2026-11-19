/**
 * Scalar helpers used by simulation code.
 *
 * Everything here is pure and allocation-free: these run inside the fixed-step
 * loop on the server and inside rollback replay on the client, so they must
 * produce the same result for the same inputs every time.
 */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp to [-1, 1]. Common enough in steering code to be worth a name. */
export function clampUnit(value: number): number {
  return clamp(value, -1, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap an angle into [-PI, PI). */
export function wrapAngle(radians: number): number {
  const wrapped = (radians + Math.PI) % TAU;
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI;
}

/** Signed shortest rotation from `from` to `to`, in [-PI, PI). */
export function shortestArc(from: number, to: number): number {
  return wrapAngle(to - from);
}

/**
 * Exponential approach of `current` toward `target` with time constant `rate`
 * (per second), integrated over `dt`.
 *
 * Uses the closed form rather than `current += (target - current) * rate * dt`
 * so the result does not depend on how `dt` is subdivided. That keeps a
 * sub-stepped integration consistent with a single large step.
 */
export function approachExp(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0) return current;
  const blend = 1 - Math.exp(-rate * dt);
  return current + (target - current) * blend;
}

/** Zero out values whose magnitude is below `epsilon`. */
export function deadzone(value: number, epsilon: number): number {
  return Math.abs(value) < epsilon ? 0 : value;
}

export function sign(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export function length2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
