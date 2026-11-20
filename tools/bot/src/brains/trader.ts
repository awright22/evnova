/**
 * A trader: fly to a berth, buy what is cheap, carry it somewhere dear, sell.
 *
 * Greedy and unsubtle, which is what the soak wants. It buys whatever has the
 * widest margin it can see, carries it to the next berth it can reach, and
 * sells whatever it can there. It does not plan a route or remember prices:
 * a bot that optimised would tell us less about whether the economy survives
 * ordinary use.
 *
 * Everything goes through the same intents a captain uses. There is no
 * shortcut: if this bot can do it, a player can.
 */

import { LANDING_RANGE, LANDING_SPEED, content, seekPoint } from '@marque/shared';
import type { ShipInput } from '@marque/shared';

import type { BotBrain, BotView } from '../bot.ts';

export interface TraderOptions {
  readonly seed: string;
  /**
   * Berths to work, in order, cycled. A bot given one berth hammers it, which
   * is how the spec's "a bot that hammers one route sees its margin decay" is
   * exercised; a bot given several runs a circuit.
   */
  readonly circuit?: readonly string[];
  /** Units per order. Larger orders move the price further against the bot. */
  readonly lot?: number;
}

/** How long to wait for an order to be answered before moving on. */
const ORDER_GAP_STEPS = 6;

/** Steps to spend alongside before launching, so the berth's drift shows. */
const DWELL_STEPS = 45;

export function traderBrain(options: TraderOptions): BotBrain {
  const lot = options.lot ?? 10;

  let berthIndex = 0;
  let started = false;
  let nextOrderStep = 0;
  /** The berth already asked for, so the approach is not restarted. */
  let askedToLand = '';
  let launchAtStep = 0;
  let landedAtStep = 0;

  /** Berths this bot will work, in the system it is in. */
  const circuitFor = (view: BotView): string[] => {
    const system = content().systems.get(view.systemId);
    const trading = (system?.ports ?? [])
      .filter((port) => port.services.includes('staple'))
      .map((port) => port.id);

    if (!options.circuit || options.circuit.length === 0) return trading;
    const named = options.circuit.filter((id) => trading.includes(id));
    return named.length > 0 ? named : trading;
  };

  return {
    name: 'trader',

    decide(view: BotView, cmd: ShipInput): void {
      const circuit = circuitFor(view);
      if (circuit.length === 0) return;

      // Start with whatever is closest rather than wherever the seed landed:
      // a bot that opens by crossing the system spends the run in transit and
      // tells us nothing about the market.
      if (!started) {
        started = true;
        const system = content().systems.get(view.systemId);
        let best = 0;
        let bestDistance = Infinity;
        circuit.forEach((id, index) => {
          const port = system?.ports.find((candidate) => candidate.id === id);
          if (!port) return;
          const distance = Math.hypot(port.x - view.self.x, port.y - view.self.y);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        });
        berthIndex = best;
      }

      // --- Alongside ------------------------------------------------------
      if (view.landedAt !== undefined) {
        if (landedAtStep === 0) {
          landedAtStep = view.step;
          launchAtStep = view.step + DWELL_STEPS;
        }

        const market = view.market;
        if (market && view.step >= nextOrderStep) {
          nextOrderStep = view.step + ORDER_GAP_STEPS;

          // Sell first: a full hold cannot buy, and what was carried here was
          // carried to be sold.
          const carrying = market.listings.find((listing) => listing.carried > 0);
          if (carrying) {
            view.trade('sell', carrying.commodityId, Math.min(lot, carrying.carried));
            return;
          }

          // Then buy whatever is cheapest against its own usual price, which
          // is the berth telling you it has too much of something.
          const room = market.holdCapacity - market.holdUsed;
          if (room > 0) {
            const affordable = market.listings
              .filter((listing) => listing.stock > lot && listing.ask * lot <= view.purse.marks)
              // Cheapest first: a glut here is a shortage somewhere.
              .sort((a, b) => a.ask - b.ask);

            const pick = affordable[0];
            if (pick) {
              view.trade('buy', pick.commodityId, Math.min(lot, room));
              return;
            }
          }
        }

        if (view.step >= launchAtStep) {
          landedAtStep = 0;
          askedToLand = '';
          berthIndex++;
          view.launch();
        }
        return;
      }

      // --- Flying ---------------------------------------------------------
      landedAtStep = 0;

      const system = content().systems.get(view.systemId);
      const target = circuit[berthIndex % circuit.length]!;
      const berth = system?.ports.find((port) => port.id === target);
      if (!berth) return;

      const { self, profile } = view;
      const distance = Math.hypot(berth.x - self.x, berth.y - self.y);
      const speed = Math.hypot(self.vx, self.vy);

      // Close enough and slow enough: ask to be taken alongside, once. The
      // approach takes a couple of seconds and asking again during it is
      // ignored, so there is nothing to gain by repeating it.
      if (distance <= berth.radius + LANDING_RANGE) {
        if (speed <= LANDING_SPEED * 0.8) {
          if (askedToLand !== berth.id) {
            askedToLand = berth.id;
            view.land(berth.id);
          }
          cmd.brake = true;
          return;
        }
        // In reach but too fast, which the server refuses: stop first.
        cmd.brake = true;
        return;
      }

      const flight = seekPoint(self, berth.x, berth.y, profile);
      cmd.turn = flight.turn;
      cmd.thrust = flight.thrust;
      cmd.brake = flight.brake;
    },
  };
}
