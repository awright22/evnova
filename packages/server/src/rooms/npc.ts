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

export type NpcRole = 'unlettered' | 'patrol' | 'freighter';

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

/**
 * A freighter: carries a consignment between a berth and the lane, and never
 * fights.
 *
 * It flies a slow circuit out from its station and back, which is enough to
 * make it a thing in the sky that can be intercepted. It does not shoot, does
 * not evade and does not take an interest in anybody — a hull that will not
 * defend itself is the whole reason raiding one is worth doing, and the whole
 * reason the companies mind.
 *
 * What it is carrying lives on the room, not here: this decides where it
 * points, and the room decides what is lost when it does not arrive.
 */
export function freighterPilot(id: string, seed: string): NpcPilot {
  const rng = new Rng(`npc:${seed}`);
  // Each one runs its own leg, so a lane is not a column of identical hulls.
  const legSeconds = rng.range(26, 44);
  const bearing = rng.range(-Math.PI, Math.PI);
  const reach = rng.range(2600, 4200);

  return {
    id,
    role: 'freighter',

    decide(self: ShipState, profile: ShipProfile, world: NpcWorld): NpcCommand {
      const station = world.stationOf(id);
      // Out and back on a slow cadence, measured from the room's clock so it
      // is the same circuit on every client's screen.
      const phase = Math.floor(world.now() / (legSeconds * 1000)) % 2;
      const toward =
        phase === 0
          ? { x: station.x + Math.cos(bearing) * reach, y: station.y + Math.sin(bearing) * reach }
          : station;

      const dx = toward.x - self.x;
      const dy = toward.y - self.y;
      if (Math.hypot(dx, dy) <= ON_STATION_RANGE) return { ...HOLD, brake: true };

      const heading = Math.atan2(dy, dx);
      return {
        turn: turnToward(self, heading, profile),
        // Laden and unhurried: a freighter under full burn would outrun the
        // raiders that are supposed to be able to catch it.
        thrust: isAimedAt(self, heading, 0.6) ? 0.55 : 0,
        brake: false,
        firePrimary: false,
        fireSecondary: false,
        target: '',
      };
    },
  };
}

// --- Who they are --------------------------------------------------------
//
// The name banks live here rather than in the room because they are part of
// what an NPC *is*, and because the commission board needs the Unlettered's
// names too: a bounty is posted on somebody by name.

/** Unlettered hulls carry no registry, so they go by what crews call them. */
export const RAIDER_NAMES = [
  'Nothing Owed',
  'Short Measure',
  'Bad Debt',
  'Writ Large',
  'Unlettered',
  'No Fixed Berth',
  'Quiet Settlement',
  'Past Due',
] as const;
/**
 * What the Prize Court calls its hulls: the same legal register as any other
 * ship's name, read flatter.
 */
export const PATROL_NAMES = [
  'Due Process',
  'Strict Liability',
  'Burden of Proof',
  'Letter and Spirit',
  'Without Notice',
  'On the Record',
  'Lawful Order',
  'Good Faith',
] as const;
/**
 * Company freighters, named the way a company names a hull it will never see:
 * after the clause that pays for it.
 */
export const FREIGHTER_NAMES = [
  'Net of Fees',
  'Third Dividend',
  'Errors and Omissions',
  'Carriage Paid',
  'Free on Board',
  'Clean Bill',
  'In Ballast',
  'Laid Up',
  'Running Days',
  'Ullage and Tare',
] as const;
export function raiderName(rng: Rng): string {
  return rng.pick(RAIDER_NAMES);
}
export function patrolName(rng: Rng): string {
  return rng.pick(PATROL_NAMES);
}
export function freighterName(rng: Rng): string {
  return rng.pick(FREIGHTER_NAMES);
}
