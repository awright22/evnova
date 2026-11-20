/**
 * A captain who works the Factor's board.
 *
 * Lands wherever work is posted, takes something it can actually deliver,
 * buys the goods if the commission wants goods carried, flies to the berth
 * named on it and lands. The server settles it on arrival, which is the
 * whole point: this brain proves the commission path through the real
 * protocol, from a board a server built to a Factor's verdict.
 *
 * It does not optimise. It takes the best-paying work it can see a route to,
 * which is what a captain does, and it gives up anything whose time has run
 * out rather than carrying a dead commission around.
 *
 * Bounties and escorts are taken too. An escort settles on its own clock, so
 * flying on is the right thing to do with one; a bounty needs a named hull
 * killed, which this brain does not hunt — it gives those up when the clock
 * gets close, which is a captain deciding the work was not worth it.
 */

import { LANDING_RANGE, LANDING_SPEED, Rng, content, seekPoint } from '@marque/shared';
import type { ShipInput, SystemDef } from '@marque/shared';

import type { BotBrain, BotView } from '../bot.ts';

export interface FactorOptions {
  readonly seed: string;
  /** Kinds this bot will take. See `WILL_TAKE` for the default and why. */
  readonly kinds?: readonly string[];
  /** The kind it prefers when the board offers a choice. */
  readonly leans?: string;
}

/**
 * The work this brain can actually finish.
 *
 * Carriage, passage and running all settle by landing somewhere with the
 * right thing aboard, and an escort settles on its own clock while the bot
 * flies on. A bounty needs a named Unlettered hull hunted down, which this
 * brain does not do — and because bounties pay best, a brain that took the
 * best-paying thing on the board took nothing else: the first run of this
 * spent its whole life carrying a bounty to a berth that had no use for it.
 */
const WILL_TAKE: readonly string[] = ['delivery', 'passengers', 'smuggling', 'escort'];

/** Steps between intents, so a refusal is read before the next one. */
const ORDER_GAP_STEPS = 6;

/** Steps alongside with nothing to do before launching again. */
const DWELL_STEPS = 30;

/**
 * Give a commission up with less than this of its time left.
 *
 * A bot that holds work it will not finish blocks the six slots a Factor
 * allows and makes the soak's failure count meaningless.
 */
const GIVE_UP_MS = 90_000;

/** Berths this bot will consider, in the system it is in. */
function berthsIn(system: SystemDef | undefined): string[] {
  return (system?.ports ?? []).map((port) => port.id);
}

/** Which lane leads toward a system, one hop at a time. */
function hopToward(from: SystemDef | undefined, toSystemId: string, rng: Rng): string {
  if (!from) return '';
  if (from.links.includes(toSystemId)) return toSystemId;

  // A breadth-first walk over the chart, which is what the map in front of a
  // captain shows. Short: the Reach is twenty systems.
  const { systems } = content();
  const seen = new Set<string>([from.id]);
  const queue: { id: string; first: string }[] = from.links.map((id) => ({ id, first: id }));

  while (queue.length > 0) {
    const step = queue.shift();
    if (!step) break;
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    if (step.id === toSystemId) return step.first;

    for (const next of systems.get(step.id)?.links ?? []) {
      if (!seen.has(next)) queue.push({ id: next, first: step.first });
    }
  }

  // Nowhere to go that reaches it: take any lane rather than sit still.
  return from.links[rng.int(0, from.links.length - 1)] ?? '';
}

export function factorBrain(options: FactorOptions): BotBrain {
  const rng = new Rng(`factor:${options.seed}`);
  const kinds = options.kinds ?? WILL_TAKE;
  /** The kind this bot prefers, so a run of them covers the board. */
  const leans = options.leans ?? kinds[rng.int(0, kinds.length - 1)] ?? '';

  let berthIndex = 0;
  let started = false;
  let spoolingFor = '';
  let askedToLand = '';
  let nextOrderStep = 0;
  let landedAtStep = 0;
  let launchAtStep = 0;

  return {
    name: 'factor',

    decide(view: BotView, cmd: ShipInput): void {
      const system = content().systems.get(view.systemId);
      const circuit = berthsIn(system);
      if (circuit.length === 0) return;

      if (!started) {
        started = true;
        // Start on the nearest berth rather than the first in the file.
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
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

      const held = view.commissions?.held ?? [];
      // The one being flown: whatever is in hand with a berth named on it.
      const carrying = held.find((row) => row.toPortId !== '' && row.toSystemId !== '');

      // --- Alongside ------------------------------------------------------
      if (view.landedAt !== undefined) {
        if (landedAtStep === 0) {
          landedAtStep = view.step;
          launchAtStep = view.step + DWELL_STEPS;
        }
        if (view.step < nextOrderStep) return;
        nextOrderStep = view.step + ORDER_GAP_STEPS;

        // Work whose time has nearly run out, given up rather than carried.
        const lapsing = held.find(
          (row) => row.dueAt > 0 && row.dueAt - view.serverNow < GIVE_UP_MS,
        );
        if (lapsing) {
          view.abandonCommission(lapsing.id);
          return;
        }

        // Carrying something that has to be bought: buy it here if this berth
        // sells it. The Staple is the only place it can come from, and a
        // commission that cannot be loaded cannot be answered.
        const market = view.market?.port === view.landedAt ? view.market : undefined;
        if (carrying && carrying.units > 0 && carrying.commodityId !== '' && market) {
          const listing = market.listings.find(
            (row) => row.commodityId === carrying.commodityId,
          );
          const short = carrying.units - (listing?.carried ?? 0);
          if (listing && short > 0) {
            const room = market.holdCapacity - market.holdUsed;
            const affordable = Math.floor(view.purse.marks / Math.max(1, listing.ask));
            const units = Math.min(short, room, affordable, listing.stock);
            if (units > 0) {
              view.trade('buy', carrying.commodityId, units);
              return;
            }
          }
        }

        // Enough Propellant to reach wherever the work is.
        if (
          view.purse.propellant < view.purse.jumpCost * 3 &&
          view.purse.propellant < view.purse.propellantCapacity
        ) {
          view.service('propellant');
          return;
        }

        // Nothing in hand: take something off this board.
        //
        // Not simply the best-paying thing. Bots that all took the maximum
        // took the same template every time — fifteen runs of one smuggling
        // job and nothing else — because the board's best-payer at a berth
        // is the same offer for everybody. Each bot leans toward its own
        // kind of work and picks among the better half of what is left, so a
        // run covers the board rather than one line of it.
        const board = view.commissions?.board ?? [];
        if (!carrying && board.length > 0) {
          const wanted = board
            .filter((offer) => kinds.includes(offer.kind))
            .sort((a, b) => b.pay - a.pay);
          const favoured = wanted.filter((offer) => offer.kind === leans);
          const pool = favoured.length > 0 ? favoured : wanted;
          const better = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)));
          const pick = better[rng.int(0, better.length - 1)];
          if (pick) {
            view.takeCommission(pick.id);
            return;
          }
        }

        if (view.step >= launchAtStep) {
          landedAtStep = 0;
          askedToLand = '';
          berthIndex += 1;
          view.launch();
        }
        return;
      }

      // --- Flying ---------------------------------------------------------
      landedAtStep = 0;

      // Carrying work for somewhere else: take the lane toward it.
      if (carrying && carrying.toSystemId !== '' && carrying.toSystemId !== view.systemId) {
        if (spoolingFor === '') {
          if (view.purse.propellant >= view.purse.jumpCost) {
            spoolingFor = hopToward(system, carrying.toSystemId, rng);
            if (spoolingFor !== '') view.jump(spoolingFor);
          }
        } else if (view.systemId !== spoolingFor) {
          cmd.brake = true;
          return;
        }
      }

      if (spoolingFor !== '' && view.systemId === spoolingFor) {
        spoolingFor = '';
        started = false;
        askedToLand = '';
      }

      // Where to land: the berth the work names, if it is in this system;
      // otherwise work the berths here looking for a board.
      const named =
        carrying && carrying.toSystemId === view.systemId ? carrying.toPortId : undefined;
      const targetId = named ?? circuit[berthIndex % circuit.length];
      const berth = system?.ports.find((port) => port.id === targetId);
      if (!berth) return;

      const { self, profile } = view;
      const distance = Math.hypot(berth.x - self.x, berth.y - self.y);
      const speed = Math.hypot(self.vx, self.vy);

      if (distance <= berth.radius + LANDING_RANGE) {
        if (speed <= LANDING_SPEED * 0.5) {
          if (askedToLand !== berth.id) {
            askedToLand = berth.id;
            view.land(berth.id);
          }
          cmd.brake = true;
          return;
        }
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
