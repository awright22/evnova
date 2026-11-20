/**
 * The shape of a rock.
 *
 * Drawn rather than textured: a belt is a dozen or more of them in one
 * system, each a different size, and a texture apiece would be a dozen
 * render targets for something that is a lumpy polygon with a shadow on it.
 *
 * Everything here is pure and seeded, so a rock looks the same on every
 * client and after every restart — which it has to, because the server
 * places them from the same seed and a captain navigates by them.
 */

import { Rng } from '@marque/shared';

/** A rock's outline, as radii at even bearings, scaled to its radius. */
export interface RockShape {
  /** Radius at each of `points` bearings, in world units. */
  readonly radii: readonly number[];
  /** Where the bright side is, in radians: the star is at the origin. */
  readonly lightAngle: number;
}

/** How many points go round a rock. Enough to be lumpy, few enough to be cheap. */
const POINTS = 11;

/** How far a rock strays from a circle, as a fraction of its radius. */
const LUMP = 0.22;

export function rockShape(seed: number, radius: number, x: number, y: number): RockShape {
  const rng = new Rng(`rock:${seed}`);
  const radii: number[] = [];
  for (let index = 0; index < POINTS; index += 1) {
    radii.push(radius * (1 - LUMP + rng.range(0, LUMP * 2)));
  }
  return { radii, lightAngle: Math.atan2(-y, -x) };
}

/**
 * How bare a rock looks, from what is left in it.
 *
 * A worked rock is smaller and duller, so a captain can see from a distance
 * which ones somebody has already been at. Never to nothing: a stripped rock
 * is still a rock, and one that vanished would take its landmark with it.
 */
export function rockWear(left: number, whole: number): { scale: number; tint: number } {
  const share = whole > 0 ? Math.max(0, Math.min(1, left / whole)) : 0;
  return {
    // Three-quarters at bare: enough to read, not enough to lose.
    scale: 0.75 + share * 0.25,
    // And darker, because what is left is the rock rather than the ore.
    tint: 0.55 + share * 0.45,
  };
}
