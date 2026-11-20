/**
 * Taking the controls from a harness.
 *
 * Three acceptance checks fly a hull through the real protocol, and each one
 * grew its own copy of this until a fix to one of them was a fix to none of
 * the others. It is the bot client's setup cut down to steering, shooting and
 * getting somewhere.
 */

import { Predict, type Room } from '@colyseus/sdk';
import {
  ShipInput,
  content,
  decodeShareCode,
  deriveStats,
  isAimedAt,
  placeAll,
  stepFlight,
  turnToward,
  type ShipProfile,
  type SystemState,
} from '@marque/shared';

import { sleep } from './harness.ts';

/**
 * Take the controls.
 *
 * An input handle on its own sends nothing the server will act on: the
 * sequence numbers the server replays against come from the reconciler, so a
 * harness that only calls `room.input()` and `send()` sits still for ever and
 * wonders why its blockade caught nothing.
 */
export function fly(room: Room<unknown, SystemState>, profile: ShipProfile) {
  const self = room.state.ships.get(room.sessionId);
  if (!self) return undefined;

  const predict = Predict.get(room, { mode: 'lerp', delay: 100 });
  const input = room.input({ type: ShipInput });
  predict.reconciler(self, {
    // Exactly the fields the shared step owns. The rest is server truth
    // arriving, not a misprediction to smooth away.
    input,
    fields: ['x', 'y', 'vx', 'vy', 'angle', 'angVel'],
    step: (ctx, state, cmd) => {
      stepFlight(state, cmd, profile, ctx);
    },
  });

  /**
   * Commit the current controls for however many fixed steps are due.
   *
   * The timestep is the predictor's, not the caller's: an input is only
   * meaningful against a step the server will replay, so sending one per
   * wall-clock frame sends nothing the server can place. Returns how many
   * steps were committed, which is zero most frames.
   */
  const commit = (): number => {
    const due = predict.tick(performance.now());
    for (let i = 0; i < due; i++) input.send();
    return due;
  };

  return { predict, input, commit };
}

/**
 * A hull under a harness's control.
 *
 * Taken off `fly` rather than written out, because the input handle's own
 * type carries the command fields and an interface that names it loses them.
 */
export type Controls = NonNullable<ReturnType<typeof fly>>;

/**
 * The flight profile of whatever this captain is flying.
 *
 * A hull the captain built is not in the catalogue — its id is its own — so
 * its grid arrives on the state as a share code. Reading only the catalogue
 * returned nothing for exactly the captains these harnesses arm, and every
 * flying routine that asked for a profile quietly did nothing.
 */
export function profileOf(room: Room<unknown, SystemState>): ShipProfile | undefined {
  const { blueprints, modules, tuning } = content();
  const self = room.state.ships.get(room.sessionId);
  if (!self) return undefined;

  const placements =
    self.hull !== ''
      ? decodeShareCode(self.hull).placements
      : blueprints.get(self.blueprint)?.placements;
  if (!placements) return undefined;

  return deriveStats(placeAll(placements, modules), tuning).profile;
}

/**
 * Fly to within `standoff` of a point, and stop there.
 *
 * Burns toward it, then brakes into the last stretch: arriving at speed and
 * sliding past is not arriving. Returns whether it got there.
 */
export async function flyTo(
  room: Room<unknown, SystemState>,
  flying: Controls,
  profile: ShipProfile,
  x: number,
  y: number,
  standoff: number,
  timeoutMs: number,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;

  while (Date.now() < until) {
    const me = room.state.ships.get(room.sessionId);
    if (!me) return false;

    const range = Math.hypot(x - me.x, y - me.y);
    const speed = Math.hypot(me.vx, me.vy);
    // In reach is arrived. Parking dead on the mark is a nicety most callers
    // do not need, and waiting for it is how this sat in a braking
    // oscillation twenty units outside its own tolerance for four minutes.
    if (range <= standoff) return true;

    const bearing = Math.atan2(y - me.y, x - me.x);
    // Brake into the last stretch rather than sailing through it: how far it
    // takes to stop at this speed, with something in hand.
    const stopping = ((speed * speed) / (2 * Math.max(1, profile.thrustAccel))) * 1.6;
    const closing = range > standoff + stopping;

    flying.input.data.turn = turnToward(me, bearing, profile);
    flying.input.data.thrust = closing && isAimedAt(me, bearing, 0.4) ? 1 : 0;
    flying.input.data.brake = !closing;
    flying.input.data.firePrimary = false;
    flying.input.data.fireSecondary = false;
    flying.commit();
    await sleep(16);
  }

  return false;
}

/**
 * Hold the brake until the hull is under `speed`, or give up.
 *
 * A hull that has stopped is the precondition for half of what happens next
 * to a prize, and "stopped" on a server means what the server's own velocity
 * says, not what the harness last asked for.
 */
export async function brakeTo(
  room: Room<unknown, SystemState>,
  flying: Controls,
  speed: number,
  timeoutMs: number,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const me = room.state.ships.get(room.sessionId);
    if (!me) return false;
    if (Math.hypot(me.vx, me.vy) <= speed) return true;

    flying.input.data.turn = 0;
    flying.input.data.thrust = 0;
    flying.input.data.brake = true;
    flying.input.data.firePrimary = false;
    flying.input.data.fireSecondary = false;
    flying.commit();
    await sleep(16);
  }
  return false;
}
