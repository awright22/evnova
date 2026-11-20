/**
 * A hull built in a Yard, presented as a draught.
 *
 * Everything downstream of the editor — the flight profile, the renderer, the
 * stat derivation — takes a `Blueprint`. A hull a captain built is the same
 * thing in every respect that matters: a name and a list of placements. The
 * two differences are supplied here.
 *
 * The first is the licence. A catalogue draught declares which warrant covers
 * it; a built hull was already checked against its owner's warrant when it
 * was built, so the field records what it was built under.
 *
 * The second is paint. A catalogue draught is painted by whoever authored it.
 * A yard delivers a hull in whatever it has in the shed, which is one of the
 * liveries in tuning data, settled by the hull's own id so that it is chosen
 * once and never drifts. Nothing here reads a clock or a global generator, so
 * a hull looks the same on every client that draws it.
 */

import { hashSeed } from '../math/rng.ts';
import type { Blueprint, LicenceId, Placement, Tuning } from '../content/schema.ts';

export interface BuiltHull {
  readonly id: string;
  readonly name: string;
  readonly placements: readonly Placement[];
}

export function builtBlueprint(
  hull: BuiltHull,
  licence: LicenceId,
  tuning: Tuning,
): Blueprint {
  const { liveries } = tuning.yard;
  return {
    id: hull.id,
    name: hull.name,
    licence,
    placements: [...hull.placements],
    paint: liveries[hashSeed(hull.id) % liveries.length]!,
  };
}
