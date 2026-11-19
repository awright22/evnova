/**
 * NPC pilots.
 *
 * They fly designed draughts through the same physics step and the same
 * weapons as a captain: an NPC produces a `FlightCommand` and two fire bits,
 * exactly as a keyboard does. Nothing about them is special-cased in the
 * simulation, so anything that is true of a player's hull is true of theirs.
 *
 * Deterministic: every decision comes from the hull's state and a seeded
 * generator, so a soak run reproduces a fight exactly.
 */

import {
  Rng,
  isAimedAt,
  shortestArc,
  turnToward,
  type FlightCommand,
  type ShipProfile,
  type ShipState,
} from '@marque/shared';

/** What an NPC decides each step. */
export interface NpcCommand extends FlightCommand {
  readonly firePrimary: boolean;
  readonly fireSecondary: boolean;
  /** The hull it wants to shoot, or empty to hold fire. */
  readonly target: string;
}

const HOLD: NpcCommand = {
  turn: 0,
  thrust: 0,
  brake: false,
  firePrimary: false,
  fireSecondary: false,
  target: '',
};

export type NpcRole = 'unlettered' | 'patrol';

export interface NpcPilot {
  readonly id: string;
  readonly role: NpcRole;
  decide(self: ShipState, profile: ShipProfile, world: NpcWorld): NpcCommand;
}

export interface NpcWorld {
  /**
   * The nearest hull this pilot would engage, or undefined for an empty sky.
   *
   * Asked for one at a time rather than as a list, because this runs for every
   * NPC on every tick: building and filtering an array there allocated several
   * hundred short-lived objects a second, and the collection that eventually
   * followed showed up as a 55 ms tick against a 0.65 ms p99. The room decides
   * what counts — an Unlettered raider sees traffic, a patrol sees only the
   * Unlettered and captains the Prize Court has posted.
   */
  nearestCandidate(selfId: string): string | undefined;

  /** That hull, if it is still one this pilot would engage. */
  candidate(selfId: string, id: string): ShipState | undefined;
  /** Where this pilot holds station when it has nobody to engage. */
  stationOf(selfId: string): { x: number; y: number };
  /** Structure remaining on a hull, 0..1. */
  integrityOf(id: string): number;
  now(): number;
}

/** Distance an Unlettered captain closes to before opening fire. */
const ENGAGE_RANGE = 1100;

/** Closer than this and they peel off rather than ram. */
const BREAK_OFF_RANGE = 260;

/** Structure below which they disengage and run. */
const RETREAT_INTEGRITY = 0.35;

/**
 * A hunter: closes on the nearest candidate, keeps its nose on the mark while
 * it shoots, and breaks off when it is badly hurt.
 *
 * Both roles fly this. They differ only in what the room offers them as
 * candidates and in what they do with an empty sky: a raider drifts, a patrol
 * returns to its station.
 */
function hunter(
  id: string,
  seed: string,
  role: NpcRole,
  options: { readonly holdsStation: boolean },
): NpcPilot {
  const rng = new Rng(`npc:${seed}`);
  // A little variation so a wing does not fly as one body.
  const preferredRange = ENGAGE_RANGE * rng.range(0.75, 1.15);
  const aggression = rng.range(0.8, 1.2);

  let markId = '';
  let reconsiderAt = 0;

  return {
    id,
    role,

    decide(self: ShipState, profile: ShipProfile, world: NpcWorld): NpcCommand {
      const now = world.now();

      // Re-pick a mark periodically, or when the current one is gone.
      let mark = markId === '' ? undefined : world.candidate(id, markId);
      if (!mark || now >= reconsiderAt) {
        markId = world.nearestCandidate(id) ?? '';
        mark = markId === '' ? undefined : world.candidate(id, markId);
        reconsiderAt = now + rng.range(2500, 5000);
      }
      if (!mark) {
        // Nothing to answer for. A patrol goes back to its station rather than
        // drifting out of the system it is meant to be standing over.
        return options.holdsStation ? returnToStation(id, self, profile, world) : HOLD;
      }

      const dx = mark.x - self.x;
      const dy = mark.y - self.y;
      const range = Math.hypot(dx, dy);
      const bearing = Math.atan2(dy, dx);

      // Badly hurt: turn away and burn.
      if (world.integrityOf(id) < RETREAT_INTEGRITY) {
        const away = bearing + Math.PI;
        return {
          turn: turnToward(self, away, profile),
          thrust: isAimedAt(self, away, 0.6) ? 1 : 0,
          brake: false,
          firePrimary: false,
          fireSecondary: false,
          target: markId,
        };
      }

      const aimed = isAimedAt(self, bearing, 0.22);
      const inRange = range <= preferredRange;

      // Too close: keep the nose on the mark but stop closing, so the pass
      // reads as a fighting turn rather than a collision.
      const closing = range > BREAK_OFF_RANGE;

      return {
        turn: turnToward(self, bearing, profile),
        thrust: closing && !inRange && Math.abs(shortestArc(self.angle, bearing)) < 0.8 ? 1 : 0,
        brake: !closing,
        firePrimary: aimed && range <= preferredRange * aggression,
        fireSecondary: aimed && range <= preferredRange * 1.6,
        target: markId,
      };
    },
  };
}

/** How close to its station a patrol considers itself on station. */
const ON_STATION_RANGE = 700;

/** Fly back to where this hull is supposed to be, and hold there. */
function returnToStation(
  id: string,
  self: ShipState,
  profile: ShipProfile,
  world: NpcWorld,
): NpcCommand {
  const station = world.stationOf(id);
  const dx = station.x - self.x;
  const dy = station.y - self.y;
  const range = Math.hypot(dx, dy);

  if (range <= ON_STATION_RANGE) {
    return { turn: 0, thrust: 0, brake: true, firePrimary: false, fireSecondary: false, target: '' };
  }

  const bearing = Math.atan2(dy, dx);
  return {
    turn: turnToward(self, bearing, profile),
    thrust: isAimedAt(self, bearing, 0.5) ? 1 : 0,
    brake: false,
    firePrimary: false,
    fireSecondary: false,
    target: '',
  };
}

/**
 * An Unlettered raider. They have no letter of marque, which is the only
 * thing that makes them pirates.
 */
export function unletteredPilot(id: string, seed: string): NpcPilot {
  return hunter(id, seed, 'unlettered', { holdsStation: false });
}

/**
 * A patrol of the Prize Court. It stands over a berth, answers for the
 * Unlettered and for captains the Court has posted, and goes back on station
 * when there is nobody left to answer for.
 */
export function patrolPilot(id: string, seed: string): NpcPilot {
  return hunter(id, seed, 'patrol', { holdsStation: true });
}
