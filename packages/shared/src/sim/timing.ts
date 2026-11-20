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
 * The most steps a client may catch up on in one frame.
 *
 * `predict.tick(now)` returns every fixed step owed since the last call, and
 * a client that has not called for a while is owed a great many: a browser
 * tab in the background stops getting animation frames, so ten seconds away
 * is three hundred steps. Sending all of them floods the reconciler's replay
 * buffer — the SDK warns at sixty-four — and replays ten seconds of whatever
 * key was last held as though the captain had been holding it.
 *
 * Twelve steps is four hundred milliseconds, which covers a slow frame or a
 * garbage collection and nothing longer. Past that the client stops
 * pretending it was flying and lets the reconciler put the hull where the
 * server says it is, which is what the SDK's snap distance is for.
 *
 * Found in a soak: twelve bots in one process cannot keep twelve frame
 * loops, and the catch-up bursts tripped the same warning a backgrounded
 * tab would.
 */
export const MAX_CATCHUP_STEPS = 12;

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
