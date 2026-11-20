/**
 * Monopoly goods and letters of marque.
 *
 * Spec section 19: in the Home Roads each company holds a monopoly on one
 * good — Kessler on Leaf, the Thirty on Alloy, Reprisal on Ordnance. Carrying
 * one there without good standing with its holder is smuggling. There are no
 * other illegal goods anywhere, which is worth saying plainly: a captain can
 * carry anything they like everywhere else, and the one rule they have to
 * learn is short.
 *
 * A letter of marque is the other side of the same paper. Bought at a
 * company's seat by a captain it already trusts, it makes attacking the other
 * two companies' ships outside the Home Roads lawful, and sells prize cargo
 * at a premium at the issuer's berths. It costs standing with the other two
 * at once — it is a declaration — and it lapses if the issuer stops trusting
 * the holder.
 */

import type { Tuning } from '../content/schema.ts';
import type { Charter } from './standing.ts';

/** Which charter holds the monopoly on a good, if any does. */
export function monopolyHolder(commodityId: string, tuning: Tuning): Charter | undefined {
  for (const [charter, good] of Object.entries(tuning.letters.monopolies)) {
    if (good === commodityId) return charter as Charter;
  }
  return undefined;
}

/**
 * Whether carrying this good through this region is smuggling.
 *
 * Only in the Home Roads, and only without good standing with the holder.
 * Outside them there is nobody whose monopoly it is to enforce.
 */
export function isContraband(
  commodityId: string,
  region: string,
  standings: Record<Charter, number>,
  tuning: Tuning,
): boolean {
  if (region !== 'home-roads') return false;
  const holder = monopolyHolder(commodityId, tuning);
  if (holder === undefined) return false;
  return standings[holder] < tuning.letters.goodStanding;
}

/** Everything in a hold that a patrol would take. */
export function contrabandIn(
  hold: ReadonlyMap<string, number>,
  region: string,
  standings: Record<Charter, number>,
  tuning: Tuning,
): { commodityId: string; units: number; holder: Charter }[] {
  const found: { commodityId: string; units: number; holder: Charter }[] = [];
  for (const [commodityId, units] of hold) {
    if (units <= 0) continue;
    const holder = monopolyHolder(commodityId, tuning);
    if (holder === undefined) continue;
    if (!isContraband(commodityId, region, standings, tuning)) continue;
    found.push({ commodityId, units, holder });
  }
  return found;
}

/** Whether a captain may be issued a letter by this charter. */
export function mayHoldLetter(standing: number, tuning: Tuning): boolean {
  return standing >= tuning.letters.requiresStanding;
}

/** Whether a letter already held has lapsed. */
export function letterLapsed(standing: number, tuning: Tuning): boolean {
  return standing < tuning.letters.lapsesBelow;
}

/**
 * Whether attacking this hull is lawful for a captain holding this letter.
 *
 * A letter licenses raiding the *other two* charters, and only outside the
 * Home Roads. It is not a licence to shoot the issuer, and it is not worth
 * the paper it is written on in the Home Roads, where all three companies
 * answer to the same courts.
 */
export function raidIsLawful(
  letter: Charter | undefined,
  targetCharter: Charter | undefined,
  region: string,
): boolean {
  if (letter === undefined || targetCharter === undefined) return false;
  if (region === 'home-roads') return false;
  return targetCharter !== letter;
}

/**
 * What prize cargo fetches above the quote.
 *
 * Only at the issuer's own berths, and only on cargo actually scooped from a
 * wreck. The premium is well under the half of a hold that is lost when a
 * hull is destroyed, so two captains staging a capture between them lose
 * money on it — which is the only thing that stops the whole arrangement
 * being a mint.
 */
export function prizePremium(
  letter: Charter | undefined,
  berthOwner: string,
  tuning: Tuning,
): number {
  if (letter === undefined || berthOwner !== letter) return 0;
  return tuning.letters.prizePremium;
}
