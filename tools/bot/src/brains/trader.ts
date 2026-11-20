/**
 * A trader: fly to a berth, buy what is cheap, carry it somewhere dear, sell.
 *
 * Greedy and unsubtle, which is what the soak wants. It buys whatever a berth
 * has too much of, carries it to the next berth on its circuit, and sells
 * whatever it can there. It remembers nothing and plans nothing: a bot that
 * optimised would tell us less about whether the economy survives ordinary
 * use.
 *
 * It takes lanes, because within one system there is often no margin to find
 * — Parity's two berths both only consume — and the long haul is where the
 * economy actually lives. A bot held to one system instead (`--stay`) is how
 * the spec's "a bot that hammers one route sees its margin decay" is run.
 *
 * Everything goes through the same intents a captain uses. There is no
 * shortcut: if this bot can do it, a player can.
 */

import { LANDING_RANGE, LANDING_SPEED, Rng, content, seekPoint } from '@marque/shared';
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
  /**
   * Stay in one system. A bot that cannot leave works the same berths over
   * and over, which is what decays a route.
   */
  readonly stay?: boolean;
  /** How many berths to work before taking a lane. */
  readonly berthsPerSystem?: number;
}

/**
 * How far from target counts as a glut or a shortage worth acting on.
 *
 * Below this a berth is near enough its target that the spread eats the
 * margin, and trading on it is how a bot loses money politely.
 */
const SHORTAGE = 0.1;

/** How long to wait for an order to be answered before moving on. */
const ORDER_GAP_STEPS = 6;

/** Steps to spend alongside before launching, so the berth's drift shows. */
const DWELL_STEPS = 45;

export function traderBrain(options: TraderOptions): BotBrain {
  const rng = new Rng(`trader:${options.seed}`);
  const lot = options.lot ?? 10;
  // One berth then a lane, by default. The Reach's berths are far apart —
  // Parity's two are ten thousand units from each other — so a bot that works
  // several before leaving spends a whole run inside one system, and the
  // systems that actually have a glut to sell are elsewhere.
  const berthsPerSystem = options.berthsPerSystem ?? 1;

  let berthIndex = 0;
  let started = false;
  let berthsWorked = 0;
  let spoolingFor = '';
  /** Berths visited since buying, so a hold is not carried forever. */
  let legsCarried = 0;
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

          // Sell first: a full hold cannot buy. Sell into a shortage by
          // preference, because that is where the berth pays most, and sell
          // anything at all rather than carry it on a third leg.
          const carried = market.listings.filter((listing) => listing.carried > 0);
          const wanted = carried
            .filter((listing) => listing.pressure < -SHORTAGE)
            .sort((a, b) => a.pressure - b.pressure);
          const toSell = wanted[0] ?? (legsCarried >= 2 ? carried[0] : undefined);

          if (toSell) {
            view.trade('sell', toSell.commodityId, Math.min(lot, toSell.carried));
            return;
          }

          // Enough Propellant to leave again. A captain who cannot pay for a
          // lane is stuck working berths with no margin, which is how this
          // bot used to spend a whole run.
          if (
            !options.stay &&
            view.purse.propellant < view.purse.jumpCost * 3 &&
            view.purse.propellant < view.purse.propellantCapacity
          ) {
            view.service('propellant');
            return;
          }

          // Then buy what this berth has too much of. Cheapest-by-price would
          // only ever buy Ice; cheapest against its own usual price is the
          // berth telling you it has a glut, and a glut here is a shortage
          // somewhere else.
          const room = market.holdCapacity - market.holdUsed;
          if (room >= lot && carried.length === 0) {
            const glut = market.listings
              .filter(
                (listing) =>
                  listing.pressure > SHORTAGE &&
                  listing.stock > lot * 2 &&
                  listing.ask * lot <= view.purse.marks,
              )
              .sort((a, b) => b.pressure - a.pressure);

            const pick = glut[0];
            if (pick) {
              legsCarried = 0;
              view.trade('buy', pick.commodityId, Math.min(lot, room));
              return;
            }
          }
        }

        if (view.step >= launchAtStep) {
          landedAtStep = 0;
          askedToLand = '';
          berthIndex++;
          berthsWorked++;
          legsCarried++;
          view.launch();
        }
        return;
      }

      // --- Flying ---------------------------------------------------------
      landedAtStep = 0;

      const system = content().systems.get(view.systemId);

      // Worked this system's berths: take a lane, if the hull can pay for it
      // and the bot is allowed to leave. A margin lives between systems far
      // more often than inside one.
      if (
        !options.stay &&
        berthsWorked >= berthsPerSystem &&
        system &&
        system.links.length > 0
      ) {
        if (spoolingFor === '') {
          if (view.purse.propellant >= view.purse.jumpCost) {
            spoolingFor = system.links[rng.int(0, system.links.length - 1)]!;
            view.jump(spoolingFor);
          } else {
            // Not enough Propellant to leave: work the berths again and buy
            // some, which is exactly what a captain in that position does.
            berthsWorked = 0;
          }
        } else if (view.systemId !== spoolingFor) {
          // Spooling. Hold still and clear of traffic.
          cmd.brake = true;
          return;
        }
      }

      // Arrived somewhere new: start again on its nearest berth.
      if (spoolingFor !== '' && view.systemId === spoolingFor) {
        spoolingFor = '';
        berthsWorked = 0;
        started = false;
      }
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
