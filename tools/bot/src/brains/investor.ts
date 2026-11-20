/**
 * Investor: buys what the Bourse is quoting below fair value, sells above.
 *
 * The honest strategy, and the one the exploiters are measured against. It
 * does nothing a captain could not do from the order ticket: it reads the
 * listings the server sent it, compares the quote to fair value, and places
 * an order through the same intent.
 *
 * It lands and stays landed. Flying is not what is being measured here, and a
 * captain standing on a floor is exactly what an investor is.
 */

import { Rng, content } from '@marque/shared';
import type { BotBrain, BotView } from '../bot.ts';
import type { ShipInput } from '@marque/shared';

/** How far below fair value is worth buying, as a fraction. */
const CHEAP = 0.06;

/** And how far above is worth selling into. */
const DEAR = 0.05;

/** Steps between orders, so a brain does not hammer the floor every tick. */
const PATIENCE = 90;

export function investorBrain(seed: string): BotBrain {
  const rng = new Rng(`investor:${seed}`);
  let actAt = rng.int(30, PATIENCE);

  return {
    name: 'investor',

    decide(view: BotView, cmd: ShipInput): void {
      cmd.turn = 0;
      cmd.thrust = 0;
      cmd.brake = true;
      cmd.firePrimary = false;
      cmd.fireSecondary = false;

      // Get alongside and stay there. A berth with a Bourse is the only
      // place an order can be placed.
      if (view.landedAt === undefined) {
        // The floor is at one berth in settled space, so that is the one to
        // be standing on. A brain that cannot reach it does nothing, which
        // is the right answer for a captain in the wrong system.
        const berth = content()
          .systems.get(view.systemId)
          ?.ports.find((candidate) => candidate.services.includes('bourse'));
        if (berth) view.land(berth.id);
        return;
      }
      if (view.step < actAt) return;
      actAt = view.step + rng.int(PATIENCE, PATIENCE * 3);

      const listings = view.bourse;
      if (!listings || listings.length === 0) return;

      // Sell anything held that has run past fair value.
      for (const listing of listings) {
        if (listing.held <= 0) continue;
        if (listing.price > listing.fairValue * (1 + DEAR)) {
          view.deal('sell', listing.ticker, Math.max(1, Math.floor(listing.held / 2)));
          return;
        }
      }

      // Otherwise buy the cheapest thing going, within what the purse and the
      // holding cap allow.
      let best: (typeof listings)[number] | undefined;
      let bestGap = -Infinity;
      for (const listing of listings) {
        if (listing.held >= listing.holdingCap) continue;
        const gap = (listing.fairValue - listing.price) / Math.max(1, listing.fairValue);
        if (gap > CHEAP && gap > bestGap) {
          bestGap = gap;
          best = listing;
        }
      }
      if (!best) return;

      // A quarter of the purse at a time, so one order does not spend
      // everything on the first thing that looks cheap.
      const spend = Math.floor(view.purse.marks / 4);
      const shares = Math.min(
        Math.max(1, Math.floor(spend / Math.max(1, best.price))),
        best.holdingCap - best.held,
        best.available,
      );
      if (shares >= 1) view.deal('buy', best.ticker, shares);
    },
  };
}
