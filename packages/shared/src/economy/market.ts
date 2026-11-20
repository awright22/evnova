/**
 * A berth's market.
 *
 * What a berth wants on hand, what it can hold, and how its stock drifts when
 * nobody trades with it. All of it follows from the production and
 * consumption rates in the system data: a berth that refines Alloy out of Ore
 * wants a working stock of both, and drifts one up and the other down.
 *
 * Deterministic and clock-injected, like everything else that runs on both
 * sides: the economy is stepped with an elapsed-hours figure, so the soak can
 * run a month of it in seconds.
 */

import type { CommodityDef, PortDef, Tuning } from '../content/schema.ts';
import type { Stockpile } from './price.ts';

/** Units an hour a berth makes of something, less what it eats, at full tilt. */
export function netRate(port: PortDef, commodityId: string): number {
  const trade = port.trade;
  if (!trade) return 0;
  return (trade.produces[commodityId] ?? 0) - (trade.consumes[commodityId] ?? 0);
}

/**
 * The production ladder: what a thing has to be made out of.
 *
 * Raw is dug or grown and needs nothing. Refined is made from raw, and
 * manufactured from refined, raw, or other manufactured goods — Ordnance
 * takes Circuitry and Machinery, which are its own tier. Consumer and luxury
 * goods are off the ladder entirely: a berth eats Provisions and Leaf
 * because people are there, not because it is making anything out of them,
 * so running out of them does not stop a refinery.
 */
const LADDER: Record<string, number> = { raw: 0, refined: 1, manufactured: 2 };

/**
 * What a berth has to have on hand to make this.
 *
 * Read off what the berth actually consumes rather than off the commodity,
 * because the same good is made different ways: Quorum refines Alloy out of
 * Ore and stops when the Ore does, and Flotsam picks Alloy out of wrecks and
 * does not. The data already says which berth is which.
 */
export function inputsFor(
  port: PortDef,
  commodity: CommodityDef,
  commodities: ReadonlyMap<string, CommodityDef>,
): string[] {
  const trade = port.trade;
  const rung = LADDER[commodity.tier];
  if (!trade || rung === undefined || (trade.produces[commodity.id] ?? 0) <= 0) return [];

  return Object.entries(trade.consumes)
    .filter(([id, rate]) => {
      if (rate <= 0) return false;
      const input = commodities.get(id);
      const inputRung = input ? LADDER[input.tier] : undefined;
      // Never upward: a mine does not stop because a crate of Machinery is
      // late. Sideways is allowed, and a berth that both made and ate the
      // same thing would deadlock — the galaxy data forbids that, and
      // `market.test.ts` holds it to it.
      return inputRung !== undefined && inputRung <= rung && id !== commodity.id;
    })
    .map(([id]) => id);
}

/**
 * How much of what it wanted to make, a berth can actually make.
 *
 * Measured against the flow rather than against the target: what matters is
 * whether the input to be eaten this period is there, so a refinery fed a
 * trickle of Ore converts the trickle instead of stalling at nothing. One
 * input short throttles the lot — a line stops at its narrowest point.
 *
 * Returns 1 for anything with no inputs, which is every raw good, every
 * luxury, and every berth that makes something out of salvage.
 */
export function supplyFor(
  port: PortDef,
  commodity: CommodityDef,
  hours: number,
  stockOf: (commodityId: string) => number,
  commodities: ReadonlyMap<string, CommodityDef>,
): number {
  const inputs = inputsFor(port, commodity, commodities);
  if (inputs.length === 0 || hours <= 0) return 1;

  let worst = 1;
  for (const id of inputs) {
    const wanted = (port.trade?.consumes[id] ?? 0) * hours;
    if (wanted <= 0) continue;
    const share = Math.max(0, Math.min(1, stockOf(id) / wanted));
    if (share < worst) worst = share;
  }
  return worst;
}

/**
 * What a berth actually moves of one good over an interval, in units an hour.
 *
 * Production is throttled by the worst-supplied input, and the consumption
 * that feeds it is throttled by the same figure — a refinery that cannot run
 * does not eat the Ore it cannot use. Everything else a berth eats, it eats
 * regardless: people have to be fed whether or not the line is running.
 */
export function workingRate(
  port: PortDef,
  commodity: CommodityDef,
  hours: number,
  stockOf: (commodityId: string) => number,
  commodities: ReadonlyMap<string, CommodityDef>,
): number {
  const trade = port.trade;
  if (!trade) return 0;

  const made = trade.produces[commodity.id] ?? 0;
  const eaten = trade.consumes[commodity.id] ?? 0;
  if (made === 0 && eaten === 0) return 0;

  const supply = made > 0 ? supplyFor(port, commodity, hours, stockOf, commodities) : 1;

  // Eaten as an input to something this berth makes, rather than eaten by
  // the people on it. The two are throttled differently, so the share of
  // this good's consumption that feeds a line is worked out here.
  let feeding = 0;
  let feedingSupply = 0;
  for (const other of commodities.values()) {
    if ((trade.produces[other.id] ?? 0) <= 0) continue;
    if (!inputsFor(port, other, commodities).includes(commodity.id)) continue;
    feeding += eaten;
    feedingSupply += eaten * supplyFor(port, other, hours, stockOf, commodities);
    // One good can feed several lines; counting it once per line would eat
    // it several times over, so the first line that uses it is enough.
    break;
  }

  const idle = Math.max(0, eaten - feeding);
  return made * supply - (idle + feedingSupply);
}

/** Units an hour a berth moves of something either way. */
export function throughput(port: PortDef, commodityId: string): number {
  const trade = port.trade;
  if (!trade) return 0;
  return (trade.produces[commodityId] ?? 0) + (trade.consumes[commodityId] ?? 0);
}

/**
 * The stock a berth wants on hand.
 *
 * Enough hours of its own throughput to keep working, and never less than the
 * baseline: a berth that neither makes nor eats something is still a market
 * in it, and a market with a target of nothing would quote the ceiling
 * forever.
 */
export function targetStock(port: PortDef, commodity: CommodityDef, tuning: Tuning): number {
  const working = throughput(port, commodity.id) * tuning.market.targetHours;
  return Math.max(tuning.market.baselineTarget, Math.round(working));
}

/** The most it can physically hold. */
export function capacityFor(port: PortDef, commodity: CommodityDef, tuning: Tuning): number {
  return Math.round(targetStock(port, commodity, tuning) * tuning.market.capacityMultiple);
}

/** A berth's opening holding of one commodity: exactly what it wants. */
export function openingPile(
  port: PortDef,
  commodity: CommodityDef,
  tuning: Tuning,
): Stockpile {
  const target = targetStock(port, commodity, tuning);
  return { stock: target, target, capacity: capacityFor(port, commodity, tuning) };
}

/**
 * Drift a berth's stock over an interval, with nobody trading.
 *
 * A producer accumulates and a consumer runs down, both bounded: a berth
 * cannot hold more than its capacity and cannot eat what it does not have.
 * Returns the new stock rather than mutating, so a caller decides whether it
 * happened.
 */
export function driftStock(
  pile: Stockpile,
  ratePerHour: number,
  hours: number,
): number {
  if (ratePerHour === 0 || hours <= 0) return pile.stock;
  const moved = ratePerHour * hours;
  return Math.max(0, Math.min(pile.capacity, pile.stock + moved));
}

/**
 * How far a berth's stock has strayed from what it wants, as a fraction.
 *
 * Positive means a glut, negative a shortage. This is what NPC freight steers
 * by: a lane runs from the biggest surplus to the deepest shortage.
 */
export function pressure(pile: Stockpile): number {
  if (pile.target <= 0) return 0;
  return (pile.stock - pile.target) / pile.target;
}
