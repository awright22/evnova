/**
 * What a unit costs, and what an order costs.
 *
 * Price is the base price scaled by target over stock, raised to an
 * elasticity, and clamped to a band — spec section 9. An order's cost is that
 * price integrated across the units traded, so a large order moves the price
 * against itself and splitting an order changes nothing.
 *
 * Everything here is pure and integer-honest: marks are whole, units are
 * whole, and every rounding goes against the player. The integration is
 * literally a sum over the units rather than a closed form, which is what
 * makes invariant 2 true by construction rather than by analysis.
 */

import type { CommodityDef, Tuning } from '../content/schema.ts';

export type Side = 'buy' | 'sell';

/** A berth's holding of one commodity. */
export interface Stockpile {
  /** Units on hand. */
  stock: number;
  /** What the berth wants on hand; the price is 1.0x here. */
  target: number;
  /** The most it can hold. */
  capacity: number;
}

/**
 * The quoted price of the next single unit, in marks, before the spread.
 *
 * Stock at target quotes the base price. Scarcity raises it and glut lowers
 * it, by the tier's elasticity, and the band stops either from running away.
 * A berth with nothing left quotes the ceiling rather than infinity.
 */
export function unitPrice(
  stock: number,
  pile: Pick<Stockpile, 'target'>,
  commodity: CommodityDef,
  tuning: Tuning,
): number {
  const band = tuning.market.bands[commodity.tier];
  const { elasticity } = tuning.market;

  const floor = commodity.basePrice * band.min;
  const ceiling = commodity.basePrice * band.max;

  // An empty berth is at the ceiling, not at infinity.
  if (stock <= 0) return ceiling;

  const scarcity = pile.target / stock;
  const raw = commodity.basePrice * Math.pow(scarcity, elasticity);

  return Math.min(ceiling, Math.max(floor, raw));
}

/** What the berth will pay for a unit: the quote, less its spread. */
export function bidPrice(
  stock: number,
  pile: Pick<Stockpile, 'target'>,
  commodity: CommodityDef,
  tuning: Tuning,
): number {
  return unitPrice(stock, pile, commodity, tuning) * (1 - tuning.market.spread);
}

/** The outcome of pricing an order, before anything is moved. */
export interface Quote {
  /** Units that can actually be traded, which may be fewer than asked. */
  readonly units: number;
  /** Total marks: what the captain pays to buy, or receives to sell. */
  readonly marks: number;
  /** Stock the berth would hold afterwards. */
  readonly stockAfter: number;
  /** Why fewer units than asked, when that is the case. */
  readonly limited?: 'out-of-stock' | 'no-room';
}

/**
 * Price an order by walking it a unit at a time.
 *
 * Buying takes units off the berth, so each unit costs a little more than the
 * last; selling puts them back, so each fetches a little less. Rounding is
 * applied per unit and always against the player — up when they pay, down
 * when they are paid — which is exactly what splitting the order would do, so
 * splitting can never be cheaper.
 *
 * `units` is a request, not a promise: a berth cannot sell what it does not
 * have, and cannot take what it has no room for.
 */
export function quote(
  side: Side,
  units: number,
  pile: Stockpile,
  commodity: CommodityDef,
  tuning: Tuning,
): Quote {
  const wanted = Math.max(0, Math.trunc(units));
  if (wanted === 0) return { units: 0, marks: 0, stockAfter: pile.stock };

  let stock = pile.stock;
  let marks = 0;
  let traded = 0;
  let limited: Quote['limited'];

  for (let i = 0; i < wanted; i++) {
    if (side === 'buy') {
      if (stock <= 0) {
        limited = 'out-of-stock';
        break;
      }
      // Charged on the stock before the unit leaves, so the first unit of an
      // order and a single-unit order cost the same.
      marks += Math.ceil(unitPrice(stock, pile, commodity, tuning));
      stock -= 1;
    } else {
      if (stock >= pile.capacity) {
        limited = 'no-room';
        break;
      }
      marks += Math.floor(bidPrice(stock, pile, commodity, tuning));
      stock += 1;
    }
    traded++;
  }

  return { units: traded, marks, stockAfter: stock, ...(limited ? { limited } : {}) };
}

/**
 * The most units a captain could buy with what they have.
 *
 * Walks the same ladder the order would, so the answer is exact rather than
 * an estimate from the current price.
 */
export function affordableUnits(
  marks: number,
  pile: Stockpile,
  commodity: CommodityDef,
  tuning: Tuning,
  limit: number,
): number {
  let stock = pile.stock;
  let spent = 0;
  let units = 0;

  while (units < limit && stock > 0) {
    const next = Math.ceil(unitPrice(stock, pile, commodity, tuning));
    if (spent + next > marks) break;
    spent += next;
    stock -= 1;
    units++;
  }

  return units;
}
