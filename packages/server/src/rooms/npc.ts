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

export type NpcRole = 'unlettered';

export interface NpcPilot {
  readonly id: string;
  readonly role: NpcRole;
  decide(self: ShipState, profile: ShipProfile, world: NpcWorld): NpcCommand;
}

export interface NpcWorld {
  /** Hulls this pilot might engage, excluding wrecks and itself. */
  candidates(selfId: string): { id: string; ship: ShipState }[];
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
 * An Unlettered raider.
 *
 * Picks the nearest hull, closes to weapons range, keeps its nose on the mark
 * while it shoots, and runs once it is badly hurt. They have no letter of
 * marque, which is the only thing that makes them pirates.
 */
export function unletteredPilot(id: string, seed: string): NpcPilot {
  const rng = new Rng(`npc:${seed}`);
  // A little variation so a wing does not fly as one body.
  const preferredRange = ENGAGE_RANGE * rng.range(0.75, 1.15);
  const aggression = rng.range(0.8, 1.2);

  let markId = '';
  let reconsiderAt = 0;

  return {
    id,
    role: 'unlettered',

    decide(self: ShipState, profile: ShipProfile, world: NpcWorld): NpcCommand {
      const now = world.now();

      // Re-pick a mark periodically, or when the current one is gone.
      const candidates = world.candidates(id);
      const current = candidates.find((c) => c.id === markId);
      if (!current || now >= reconsiderAt) {
        const nearest = candidates.reduce<{ id: string; ship: ShipState; d: number } | undefined>(
          (best, c) => {
            const d = Math.hypot(c.ship.x - self.x, c.ship.y - self.y);
            return !best || d < best.d ? { ...c, d } : best;
          },
          undefined,
        );
        markId = nearest?.id ?? '';
        reconsiderAt = now + rng.range(2500, 5000);
      }

      const mark = candidates.find((c) => c.id === markId);
      if (!mark) return HOLD;

      const dx = mark.ship.x - self.x;
      const dy = mark.ship.y - self.y;
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
