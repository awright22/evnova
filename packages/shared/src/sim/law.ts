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
 * The composition struck for taking structure off a lawful hull.
 *
 * Weighted by how much law reaches the system: the Home Roads at full, the
 * Concessions lightly, the Marque not at all. Rounded to whole marks because
 * every balance in the world is an integer.
 */
export function compositionForDamage(
  structureLost: number,
  security: SecurityLevel,
  law: Law,
): number {
  if (structureLost <= 0) return 0;
  return Math.round(structureLost * law.compositionPerStructure * law.weightBySecurity[security]);
}

/** And the flat sum for writing one off, which is a separate matter. */
export function compositionForWriteOff(security: SecurityLevel, law: Law): number {
  return Math.round(law.compositionPerWriteOff * law.weightBySecurity[security]);
}

/** Whether a berth in this system turns a posted captain away. */
export function berthRefusesPosted(security: SecurityLevel, law: Law): boolean {
  return law.postedRefusedIn.includes(security);
}
