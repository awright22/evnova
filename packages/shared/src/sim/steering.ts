/**
 * Steering helpers shared by NPC pilots and headless bots.
 *
 * These produce the same `FlightCommand` a human would hold on the keyboard,
 * so an NPC flies through exactly the same physics step as a player. They are
 * pure functions of the body, the target and the profile, which keeps NPC
 * behaviour deterministic inside the fixed-step loop.
 */

import { shortestArc, sign } from '../math/scalar.ts';
import type { FlightBody } from './flight.ts';
import type { ShipProfile } from './profile.ts';

/** Angular error below which the ship is considered on target. */
const AIM_DEADZONE = 0.02;

/**
 * Pick a turn input that rotates toward `targetAngle` without overshooting.
 *
 * Looks ahead at the rotation the ship would sweep while arresting its current
 * angular velocity. If that sweep would carry it past the target, it
 * counter-turns instead, which is what a pilot feathering the thrusters does.
 */
export function turnToward(
  body: FlightBody,
  targetAngle: number,
  profile: ShipProfile,
): -1 | 0 | 1 {
  const error = shortestArc(body.angle, targetAngle);
  if (Math.abs(error) < AIM_DEADZONE && Math.abs(body.angVel) < AIM_DEADZONE) return 0;

  // Rotation still to come if we started arresting the spin right now.
  const stoppingSweep = (body.angVel * body.angVel) / (2 * profile.turnAccel);

  if (body.angVel !== 0 && sign(body.angVel) === sign(error) && stoppingSweep >= Math.abs(error)) {
    // Already going to arrive or overshoot: kill the rotation.
    return -sign(body.angVel) as -1 | 1;
  }
  return sign(error);
}

/** True when the ship is pointed close enough to `targetAngle` to burn. */
export function isAimedAt(body: FlightBody, targetAngle: number, tolerance = 0.3): boolean {
  return Math.abs(shortestArc(body.angle, targetAngle)) <= tolerance;
}

/** Bearing from the ship to a point, in radians. */
export function bearingTo(body: FlightBody, x: number, y: number): number {
  return Math.atan2(y - body.y, x - body.x);
}

/** Straight-line distance from the ship to a point. */
export function distanceTo(body: FlightBody, x: number, y: number): number {
  return Math.hypot(x - body.x, y - body.y);
}

/**
 * Fly to a point and stop there.
 *
 * Aims at the target, burns while roughly aligned, and brakes once inside the
 * distance it needs to shed its current speed. The arrival radius falls out of
 * the ship's own acceleration, so a heavy freighter starts braking earlier than
 * a shuttle without any per-ship tuning.
 */
export function seekPoint(
  body: FlightBody,
  x: number,
  y: number,
  profile: ShipProfile,
  arriveWithin = 40,
): { turn: -1 | 0 | 1; thrust: 0 | 1; brake: boolean } {
  const distance = distanceTo(body, x, y);
  const speed = Math.hypot(body.vx, body.vy);

  // Distance needed to come to rest at full thrust, plus a margin for the
  // turn-around. Braking early reads as competent piloting; braking late
  // reads as a bug.
  const stoppingDistance = (speed * speed) / (2 * profile.thrustAccel) + speed * 0.35;

  if (distance <= arriveWithin) {
    return { turn: 0, thrust: 0, brake: speed > 0 };
  }
  if (stoppingDistance >= distance) {
    return { turn: 0, thrust: 0, brake: true };
  }

  const bearing = bearingTo(body, x, y);
  return {
    turn: turnToward(body, bearing, profile),
    thrust: isAimedAt(body, bearing) ? 1 : 0,
    brake: false,
  };
}
