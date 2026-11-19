/**
 * The ship physics step.
 *
 * This is the one function the server's fixed-step loop and the client's
 * reconciler both call. It must stay deterministic: time arrives as a
 * `StepTiming`, there is no wall clock and no global randomness, and every
 * value it reads comes from the body, the command or the profile.
 *
 * Flight is inertial. There is no drag: a ship keeps its velocity until
 * something changes it. Forward thrust tapers as the component of velocity
 * along the ship's facing approaches `topSpeed`, so there is no hard speed
 * clamp and thrusting against your own momentum always gives full authority.
 */

import { clamp, length2, shortestArc, sign, wrapAngle } from '../math/scalar.ts';
import type { ShipProfile } from './profile.ts';
import type { StepTiming } from './timing.ts';

/** The mutable flight state of one ship. */
export interface FlightBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing in radians, in [-PI, PI). */
  angle: number;
  /** Angular velocity in rad/s. */
  angVel: number;
}

/**
 * The pilot's intent for one step. Mirrors the wire input schema: flat
 * primitives only, and everything the step reads lives here.
 */
export interface FlightCommand {
  /** -1 turn left, 0 hold, 1 turn right. */
  readonly turn: number;
  /** 1 to burn the main engine, 0 to coast. */
  readonly thrust: number;
  /** Turn retrograde and burn to a stop. Overrides `turn` and `thrust`. */
  readonly brake: boolean;
}

/**
 * Floor for the brake's rest threshold, so a very low-thrust ship still
 * settles instead of creeping forever.
 */
const BRAKE_MIN_REST_SPEED = 0.5;

/**
 * How closely the ship must be aligned with retrograde before the brake fires
 * the main engine. Wide enough to start slowing early, tight enough that the
 * burn is not wasted sideways.
 */
const BRAKE_ALIGN_TOLERANCE = 0.35;

/**
 * Advance one ship by one fixed step.
 *
 * Integrates `timing.subSteps` sub-steps of `timing.subDt` using a single
 * command, so physics runs at a higher rate than the input stream without
 * applying the input more than once.
 */
export function stepFlight(
  body: FlightBody,
  cmd: FlightCommand,
  profile: ShipProfile,
  timing: StepTiming,
): void {
  const subSteps = timing.subSteps >= 1 ? timing.subSteps : 1;
  for (let i = 0; i < subSteps; i++) {
    stepFlightOnce(body, cmd, profile, timing.subDt);
    quantise(body);
  }
}

/**
 * Round the body to single precision.
 *
 * The synchronised state carries these fields as `float32`, so the server's
 * authoritative values live on the float32 grid while a client's predicted
 * mirror is an ordinary float64 object. Integrating at two different
 * precisions diverges systematically — slowly at low speed, faster near top
 * speed where the thrust taper is steepest — and it shows up as a small,
 * persistent reconcile correction rather than an obvious break.
 *
 * Rounding here puts both sides, and the wire, on one grid. It costs six
 * `Math.fround` calls per sub-step.
 */
function quantise(body: FlightBody): void {
  body.x = Math.fround(body.x);
  body.y = Math.fround(body.y);
  body.vx = Math.fround(body.vx);
  body.vy = Math.fround(body.vy);
  body.angle = Math.fround(body.angle);
  body.angVel = Math.fround(body.angVel);
}

function stepFlightOnce(
  body: FlightBody,
  cmd: FlightCommand,
  profile: ShipProfile,
  dt: number,
): void {
  const speed = length2(body.vx, body.vy);

  // Resolve intent: the brake synthesises its own turn and thrust.
  let turn = clamp(cmd.turn, -1, 1);
  let thrust = clamp(cmd.thrust, 0, 1);

  if (cmd.brake) {
    // Residual speed the engine could cancel inside this step. Braking below
    // it would overshoot through zero and oscillate, so null it instead. This
    // scales with thrust and dt, which keeps the behaviour step-rate
    // independent and identical on both sides of the wire.
    const restSpeed = Math.max(BRAKE_MIN_REST_SPEED, profile.thrustAccel * dt);
    if (speed <= restSpeed) {
      // Close enough to stopped: kill the residual drift so a braked ship
      // holds station instead of creeping. Deterministic on both sides.
      body.vx = 0;
      body.vy = 0;
      turn = 0;
      thrust = 0;
    } else {
      const retrograde = Math.atan2(-body.vy, -body.vx);
      const error = shortestArc(body.angle, retrograde);
      turn = Math.abs(error) > BRAKE_ALIGN_TOLERANCE * 0.25 ? sign(error) : 0;
      thrust = Math.abs(error) <= BRAKE_ALIGN_TOLERANCE ? 1 : 0;
    }
  }

  // --- Rotation -----------------------------------------------------------
  if (turn !== 0) {
    body.angVel = clamp(
      body.angVel + turn * profile.turnAccel * dt,
      -profile.maxTurnRate,
      profile.maxTurnRate,
    );
  } else if (body.angVel !== 0) {
    // Maneuvering thrusters arrest the spin. Closed form so the result does
    // not depend on how the step was subdivided.
    const retained = Math.exp(-profile.turnDamping * dt);
    body.angVel *= retained;
    // Snap the tail to zero so the ship settles instead of drifting forever.
    if (Math.abs(body.angVel) < 1e-4) body.angVel = 0;
  }
  if (body.angVel !== 0) {
    body.angle = wrapAngle(body.angle + body.angVel * dt);
  }

  // --- Thrust -------------------------------------------------------------
  if (thrust > 0) {
    const fx = Math.cos(body.angle);
    const fy = Math.sin(body.angle);
    // Taper on the velocity component along the facing, not on raw speed, so
    // burning against your momentum is never penalised.
    const along = body.vx * fx + body.vy * fy;
    const taper = clamp(1 - along / profile.topSpeed, 0, 1);
    const accel = profile.thrustAccel * taper * thrust;
    body.vx += fx * accel * dt;
    body.vy += fy * accel * dt;
  }

  // --- Position -----------------------------------------------------------
  body.x += body.vx * dt;
  body.y += body.vy * dt;
}

/** Create a body at rest. */
export function createFlightBody(x = 0, y = 0, angle = 0): FlightBody {
  return { x, y, vx: 0, vy: 0, angle, angVel: 0 };
}

/** Copy flight state between bodies without allocating. */
export function copyFlightBody(from: FlightBody, to: FlightBody): void {
  to.x = from.x;
  to.y = from.y;
  to.vx = from.vx;
  to.vy = from.vy;
  to.angle = from.angle;
  to.angVel = from.angVel;
}

/** Current speed in units/s. */
export function speedOf(body: FlightBody): number {
  return length2(body.vx, body.vy);
}

/** Direction of travel in radians. Meaningless at rest; returns facing there. */
export function headingOf(body: FlightBody): number {
  return body.vx === 0 && body.vy === 0 ? body.angle : Math.atan2(body.vy, body.vx);
}
