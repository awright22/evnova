/**
 * The Prize Court.
 *
 * What firing on lawful traffic costs, and where being posted closes a berth.
 * Pure and data-driven so the server can charge it and the interface can warn
 * about it from the same arithmetic.
 */

import type { SecurityLevel, Tuning } from '../content/schema.ts';

type Law = Tuning['law'];

/**
 * The composition struck for firing on a lawful hull.
 *
 * Reckoned on damage dealt, shields included: the offence is the attack, not
 * whether it got through, and a captain who empties a magazine into someone's
 * shields has still fired on them. Weighted by how much law reaches the
 * system — the Home Roads at full, the Concessions lightly, the Marque not at
 * all — and rounded to whole marks, because every balance in the world is an
 * integer.
 */
export function compositionForDamage(
  damageDealt: number,
  security: SecurityLevel,
  law: Law,
): number {
  if (damageDealt <= 0) return 0;
  return Math.round(damageDealt * law.compositionPerDamage * law.weightBySecurity[security]);
}

/** And the flat sum for writing one off, which is a separate matter. */
export function compositionForWriteOff(security: SecurityLevel, law: Law): number {
  return Math.round(law.compositionPerWriteOff * law.weightBySecurity[security]);
}

/** Whether a berth in this system turns a posted captain away. */
export function berthRefusesPosted(security: SecurityLevel, law: Law): boolean {
  return law.postedRefusedIn.includes(security);
}
