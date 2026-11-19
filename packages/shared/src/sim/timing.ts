/**
 * Simulation rates.
 *
 * One input equals one fixed step equals one server tick. Colyseus advertises
 * `TICK_RATE` and `SUB_STEPS` to predicting clients through the join handshake,
 * so these constants are declared once here and read from the step context
 * everywhere else. Never hand-write a `dt`.
 */

/** Inputs per second, and the authoritative simulation rate. */
export const TICK_RATE = 30;

/**
 * Physics sub-steps per input tick, so integration runs at 60 Hz while the
 * wire carries 30 inputs/second. One input still drives exactly one fixed step.
 */
export const SUB_STEPS = 2;

/** State patches per second sent to clients. */
export const PATCH_RATE = 20;

/**
 * The timing a simulation step needs. Structurally compatible with Colyseus's
 * server `StepContext` and the client reconciler's step context, so the same
 * shared functions accept either without adaptation.
 */
export interface StepTiming {
  /** Fixed step in seconds. */
  readonly dt: number;
  /** Sub-step in seconds (`dt / subSteps`). */
  readonly subDt: number;
  /** Sub-steps per fixed step; at least 1. */
  readonly subSteps: number;
}

/** A `StepTiming` for tests and headless tools that run outside a room. */
export function stepTiming(tickRate = TICK_RATE, subSteps = SUB_STEPS): StepTiming {
  const dt = 1 / tickRate;
  return { dt, subDt: dt / subSteps, subSteps };
}
