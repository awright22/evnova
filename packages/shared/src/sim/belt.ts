/**
 * Where the rocks are.
 *
 * A belt is placed from the system's own id and nothing else, so it is the
 * same belt on every client, in every room, after every restart: a captain
 * who learns where the good rock is in Ostrand has learned something that
 * stays true. Nothing here reads a clock or a global generator.
 *
 * Rocks sit in a ring between the star's clearance and the edge of the
 * system, scattered within it rather than evenly spaced, because a belt laid
 * out on a circle reads as scenery and a belt with clumps in it reads as a
 * place.
 */

import { Rng } from '../math/rng.ts';
import type { SystemDef } from '../content/schema.ts';

/** One rock, as the world holds it. */
export interface Rock {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly commodity: string;
  /** Units in it when whole. */
  readonly whole: number;
  /** Drives the client's shape. */
  readonly seed: number;
}

/**
 * The inner and outer edge of a belt, as fractions of the system's radius.
 *
 * Outside the clearance a jump needs, so a captain working a belt is not
 * sitting where they cannot leave from, and off the berths, so mining is
 * somewhere you go rather than something you do while docked.
 *
 * Not much further out than that. At 0.42 to 0.78 the nearest rock in every
 * system was eight to fourteen thousand units from its berth, which is a
 * minute of flying each way before anything is cut: mining came out worth
 * well under half of a trade run, and the difference was all commute.
 */
const INNER = 0.3;
const OUTER = 0.62;

/** How much a rock's size varies, as a fraction of the mean. */
const SIZE_SPREAD = 0.45;

export function beltOf(system: SystemDef): Rock[] {
  const belt = system.belt;
  if (!belt) return [];

  const rng = new Rng(`belt:${system.id}`);
  const rocks: Rock[] = [];

  // A ring split into arcs, one rock to an arc, each placed anywhere in its
  // own arc. Even enough that the belt reads as a belt, uneven enough that
  // it does not read as a clock face.
  const arc = (Math.PI * 2) / belt.rocks;

  for (let index = 0; index < belt.rocks; index += 1) {
    const bearing = index * arc + rng.range(0, arc);
    const distance = system.radius * rng.range(INNER, OUTER);
    const size = rng.range(1 - SIZE_SPREAD, 1 + SIZE_SPREAD);

    rocks.push({
      id: `rock-${index}`,
      x: Math.cos(bearing) * distance,
      y: Math.sin(bearing) * distance,
      // Bigger rocks hold more, which is the whole of a captain's choice
      // about which one to sit on.
      //
      // Small, in a game whose berths have a radius of about a hundred: a
      // rock at ninety came out the size of a landable world and filled a
      // quarter of the sky from inside a rig's reach, which read as flying
      // into a wall rather than as sitting on a boulder.
      radius: Math.round(26 * size),
      commodity: belt.commodity,
      whole: Math.max(1, Math.round(belt.unitsEach * size)),
      seed: rng.int(0, 65_535),
    });
  }

  return rocks;
}

/**
 * How much a worked rock has come back since it was last touched.
 *
 * Slow, and never past whole. A belt that refilled while a captain turned
 * around would make mining a tap rather than a place; a belt that never
 * refilled would be stripped by the first captain to find it and worth
 * nothing to anybody after.
 */
export function regrown(left: number, whole: number, hours: number, perDay: number): number {
  if (left >= whole || hours <= 0) return Math.min(left, whole);
  return Math.min(whole, left + (perDay / 24) * hours);
}

/**
 * Whether a line from a muzzle reaches a rock, and how far along it does.
 *
 * A rock is a circle, which is the one thing in this game that is: hulls are
 * tested cell by cell because what a round hits decides what breaks, and
 * nothing about a rock cares where it was cut.
 */
export function rockAlong(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  rock: { x: number; y: number; radius: number },
): number | undefined {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return undefined;

  // Closest approach of the segment to the rock's centre.
  const t = Math.max(0, Math.min(1, ((rock.x - fromX) * dx + (rock.y - fromY) * dy) / lengthSq));
  const cx = fromX + dx * t;
  const cy = fromY + dy * t;
  if (Math.hypot(rock.x - cx, rock.y - cy) > rock.radius) return undefined;

  // Where it enters, not where it is nearest: a rig cuts the face it can see.
  const half = Math.sqrt(
    Math.max(0, rock.radius * rock.radius - (rock.x - cx) ** 2 - (rock.y - cy) ** 2),
  );
  const entry = t - half / Math.sqrt(lengthSq);
  return Math.max(0, Math.min(1, entry));
}
