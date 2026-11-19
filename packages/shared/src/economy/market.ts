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

/** Units an hour a berth makes of something, less what it eats. */
export function netRate(port: PortDef, commodityId: string): number {
  const trade = port.trade;
  if (!trade) return 0;
  return (trade.produces[commodityId] ?? 0) - (trade.consumes[commodityId] ?? 0);
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
