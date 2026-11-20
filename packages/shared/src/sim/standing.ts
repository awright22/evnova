/**
 * Company standing.
 *
 * What each of the three chartered companies thinks of a captain, from what
 * the captain has actually done to them: goods bought at their berths, hulls
 * of theirs destroyed, commissions answered, contraband carried through their
 * space.
 *
 * **Taking a side costs.** A gain with one company is a loss with each of
 * the other two, scaled by `rivalShare`. At a half that makes standing
 * zero-sum across the three charters: working all three in rotation nets
 * exactly nothing, so there is no state in which a captain is well in with
 * everybody. That is the point of there being three of them — spec section 19
 * gives each its own monopolies, courts and grievances, and a player who
 * could please all three would never have to choose. A smaller share leaves a
 * gain on every push and the whole thing collapses into a grind.
 *
 * Everything here is pure and integer-free: the caller rounds when it writes.
 */

import { clamp } from '../math/scalar.ts';
import type { Tuning } from '../content/schema.ts';

/** The three charters a captain can stand with. Free captains are nobody's. */
export const CHARTERS = ['kessler', 'thirty', 'reprisal'] as const;
export type Charter = (typeof CHARTERS)[number];

export type Standings = Record<Charter, number>;

export function openingStandings(tuning: Tuning): Standings {
  return {
    kessler: tuning.standing.opening,
    thirty: tuning.standing.opening,
    reprisal: tuning.standing.opening,
  };
}

/** Whether a parent company is one a captain can stand with. */
export function isCharter(parent: string): parent is Charter {
  return (CHARTERS as readonly string[]).includes(parent);
}

/**
 * Move a captain's standing with one company, and against the others.
 *
 * Returns the whole set rather than the one value, because a change with one
 * charter is never only about that charter.
 */
export function shiftStanding(
  current: Standings,
  charter: Charter,
  delta: number,
  tuning: Tuning,
): Standings {
  const { floor, ceiling, rivalShare } = tuning.standing;
  const next: Standings = { ...current };

  next[charter] = clamp(current[charter] + delta, floor, ceiling);

  // The rivals move the other way. A loss with one is a small gain with the
  // others for the same reason a gain is a loss: the companies are each
  // other's problem.
  for (const other of CHARTERS) {
    if (other === charter) continue;
    next[other] = clamp(current[other] - delta * rivalShare, floor, ceiling);
  }

  return next;
}

/**
 * Drift an unworked standing back toward nothing.
 *
 * `hours` of world time. A captain who stops dealing with a company is
 * eventually neither liked nor disliked by it, which keeps an old grudge from
 * being permanent and an old favour from being free for ever.
 */
export function decayStanding(current: Standings, hours: number, tuning: Tuning): Standings {
  const step = (tuning.standing.decayPerDay * hours) / 24;
  const next = { ...current };
  for (const charter of CHARTERS) {
    const value = current[charter];
    if (value > 0) next[charter] = Math.max(0, value - step);
    else if (value < 0) next[charter] = Math.min(0, value + step);
  }
  return next;
}

/** Whether a company's berth will have this captain alongside at all. */
export function berthAccepts(standing: number, tuning: Tuning): boolean {
  return standing > tuning.standing.refusedBelow;
}

/**
 * What standing is worth off the Staple's spread, as a fraction.
 *
 * Capped well inside the spread on purpose: invariant 1 says buying and
 * selling back at one berth loses money, and a discount that beat the spread
 * would hand a favoured captain a machine that prints marks.
 */
export function standingDiscount(standing: number, tuning: Tuning): number {
  const { discountAbove, ceiling, maxDiscount } = tuning.standing;
  if (standing <= discountAbove) return 0;
  const reach = Math.max(1, ceiling - discountAbove);
  return clamp((standing - discountAbove) / reach, 0, 1) * maxDiscount;
}

/**
 * How a standing reads to a captain. The Register's own words.
 *
 * Nine bands rather than six, because the old table called everything from
 * -40 to +39 "Unknown" — which is most of the range a captain moves through
 * in their first week, and which the hub printed in `--danger` red at -40,
 * so the colour said trouble and the word said nobody has an opinion.
 * "Noted" is this world's own term for a small black mark: a Factor notes a
 * late delivery.
 *
 * Every threshold is a fraction of the floor or the ceiling, so retuning
 * the range moves the bands with it rather than stranding them.
 */
export function standingName(standing: number, tuning: Tuning): string {
  const { ceiling, floor, refusedBelow } = tuning.standing;
  if (standing <= refusedBelow) return 'Barred';
  if (standing <= floor * 0.35) return 'Hostile';
  if (standing < floor * 0.15) return 'Out of favour';
  if (standing < floor * 0.02) return 'Noted';
  if (standing <= ceiling * 0.02) return 'Unknown';
  if (standing < ceiling * 0.15) return 'Civil';
  if (standing < ceiling * 0.4) return 'Known';
  if (standing < ceiling * 0.75) return 'Trusted';
  // Not "a friend of the House": the House is Kessler & Daughters by name,
  // and this is read against all three charters.
  return 'A friend of the charter';
}
