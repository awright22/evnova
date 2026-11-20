/**
 * Constant-product share pools.
 *
 * Every listed company trades against a pool holding shares and marks, so a
 * quote always exists however few captains are online. The pool's product —
 * shares times marks — is its invariant, and it never falls.
 *
 * **Why a pool rather than an order book.** Spec section 10 asks that a quote
 * always exist. A book with six players on it is a book with no quote most of
 * the time, and a market maker with an inventory is a second economy to
 * balance. A pool is one formula, always answers, and its price impact is
 * visible before a captain confirms, which the order ticket needs.
 *
 * **Rounding.** Shares and marks are integers. Every rounding goes the pool's
 * way: marks paid *into* the pool round up, marks paid *out* round down. That
 * makes invariant 3 true by construction rather than by tuning — the product
 * after any trade is at least the product before, so a round trip cannot
 * profit from the arithmetic, and the fees are a further loss on top.
 *
 * **Whose marks.** A pool's marks are the exchange's, not a captain's. Only
 * the captain's side of a trade touches the ledger: marks leave them to buy
 * and reach them on a sale. The pool is a reservoir outside the player credit
 * total, which is what lets the house trader reprice it without inventing
 * marks in anyone's purse.
 */

/** A pool's holdings. Both integers, both positive. */
export interface Pool {
  /** Shares the pool holds and will sell. */
  readonly shares: number;
  /** Marks the pool holds and will pay out. */
  readonly marks: number;
}

/** What a trade would do, before anyone commits to it. */
export interface ShareQuote {
  /** Shares actually moved. Less than asked when the pool cannot cover it. */
  readonly shares: number;
  /** Marks the pool takes in, or pays out, before the fee. */
  readonly marks: number;
  /** The fee, destroyed rather than paid to anyone. */
  readonly fee: number;
  /** What the captain pays (buying) or receives (selling), fee included. */
  readonly total: number;
  /** Marks per share over the whole parcel, which is what a captain feels. */
  readonly averagePrice: number;
  /** The quoted price before the trade. */
  readonly priceBefore: number;
  /** And after, so the ticket can show the impact. */
  readonly priceAfter: number;
  /** The pool as it would stand afterwards. */
  readonly after: Pool;
}

/** The pool's invariant: the product it must never lose. */
export function product(pool: Pool): number {
  return pool.shares * pool.marks;
}

/**
 * The quoted price: marks per share, unrounded.
 *
 * This is the marginal price at the pool's current point on the curve, which
 * is what a chart plots. What a captain actually pays for a parcel is worse,
 * and that is `averagePrice` on the quote.
 */
export function price(pool: Pool): number {
  return pool.shares > 0 ? pool.marks / pool.shares : 0;
}

/**
 * The most shares the pool will sell.
 *
 * A constant-product pool can never be emptied — the price goes to infinity
 * as the last share leaves — so there is a hard stop short of the end. Buying
 * the pool down to one share would cost more marks than exist.
 */
export function sellableShares(pool: Pool, fraction: number): number {
  return Math.max(0, Math.floor(pool.shares * fraction));
}

/**
 * Quote a purchase of `want` shares from the pool.
 *
 * `feeRate` is taken on top of the pool's price and destroyed.
 */
export function quoteBuy(pool: Pool, want: number, feeRate: number, maxFraction: number): ShareQuote {
  const shares = Math.min(Math.max(0, Math.trunc(want)), sellableShares(pool, maxFraction));
  if (shares === 0) return nothing(pool);

  const k = product(pool);
  const sharesAfter = pool.shares - shares;
  // Rounded up: the pool takes the odd mark, so the product rises.
  const marks = Math.ceil(k / sharesAfter) - pool.marks;
  const fee = Math.ceil(marks * feeRate);
  const after: Pool = { shares: sharesAfter, marks: pool.marks + marks };

  return {
    shares,
    marks,
    fee,
    total: marks + fee,
    averagePrice: (marks + fee) / shares,
    priceBefore: price(pool),
    priceAfter: price(after),
    after,
  };
}

/**
 * Quote a sale of `want` shares into the pool.
 *
 * The fee comes out of the proceeds, so a captain receives less than the pool
 * pays and the difference is destroyed.
 */
export function quoteSell(pool: Pool, want: number, feeRate: number): ShareQuote {
  const shares = Math.max(0, Math.trunc(want));
  if (shares === 0) return nothing(pool);

  const k = product(pool);
  const sharesAfter = pool.shares + shares;
  // Rounded down: the pool keeps the odd mark, so the product rises.
  const marks = pool.marks - Math.ceil(k / sharesAfter);
  const fee = Math.ceil(marks * feeRate);
  const after: Pool = { shares: sharesAfter, marks: pool.marks - marks };

  return {
    shares,
    marks,
    fee,
    total: marks - fee,
    averagePrice: (marks - fee) / shares,
    priceBefore: price(pool),
    priceAfter: price(after),
    after,
  };
}

/**
 * The most shares a captain can buy with what they have.
 *
 * Solved by bisection rather than algebraically: the closed form has to
 * account for two ceilings and a fee rate, and getting it subtly wrong would
 * quote a parcel the captain cannot actually pay for. The search calls the
 * same `quoteBuy` the trade will use, so the answer is exact by construction.
 */
export function affordableShares(
  pool: Pool,
  marks: number,
  feeRate: number,
  maxFraction: number,
): number {
  let low = 0;
  let high = sellableShares(pool, maxFraction);
  if (high === 0 || quoteBuy(pool, 1, feeRate, maxFraction).total > marks) return 0;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (quoteBuy(pool, mid, feeRate, maxFraction).total <= marks) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Where the house trader moves a pool this tick.
 *
 * It trades along the curve toward fair value, covering `rate` of the gap, so
 * a price responds to the world even when nobody is trading. Because it moves
 * along the curve the product is preserved, and because both holdings are
 * rounded outward it is preserved *upward*.
 *
 * The pool's marks are the exchange's, so this invents nothing in anyone's
 * purse: a captain only ever gains marks from a pool through a sale, which is
 * ledgered like any other faucet.
 */
export function houseTrade(pool: Pool, fairValue: number, rate: number): Pool {
  const now = price(pool);
  if (now <= 0 || fairValue <= 0 || pool.shares <= 0) return pool;

  const target = now + (fairValue - now) * rate;
  if (target <= 0) return pool;

  // On the curve at the target price: shares = sqrt(k / p), marks = sqrt(k p).
  const k = product(pool);
  const shares = Math.max(1, Math.round(Math.sqrt(k / target)));
  const marks = Math.max(1, Math.ceil(k / shares));

  return { shares, marks };
}

/**
 * What a share is worth: smoothed earnings times a multiple, over the float.
 *
 * **The division by the float is load-bearing, not cosmetic.** Earnings are
 * the whole company's; a share is one of `float` claims on them. Without the
 * division this returns a per-share price computed from a company-wide
 * figure, and a captain who raises earnings by one mark raises the value of
 * their own holding by `holdingCap * float * smoothing * multiple` — which
 * for a float of a few hundred thousand is six figures of profit per mark
 * spent, and invariant 6 fails by that factor.
 *
 * With the division, a captain spending one mark to raise a company's
 * earnings gains at most
 *
 *     holdingCap * smoothing * multiple
 *
 * marks on their holding, whatever the float. Keeping that product below one
 * makes self-dealing lose money *structurally*, before the commodity spread
 * and the Bourse's own fees are counted — which is why the content loader
 * refuses to start if the tuning violates it.
 *
 * The floor is what stops a company that earns nothing for a while from being
 * worth nothing: spec section 10 asks for a floor above zero, and without one
 * a quiet quarter would take a stock to a price no pool can quote out of.
 */
export function fairValue(
  smoothedEarnings: number,
  multiple: number,
  floor: number,
  float: number,
): number {
  if (float <= 0) return floor;
  return Math.max(floor, (smoothedEarnings * multiple) / float);
}

/**
 * The most a captain can gain on their holding per mark they spend to lift a
 * company's earnings.
 *
 * Conservative: it assumes they hold the cap, that the house trader closes
 * the whole gap, and that they pay nothing to get in or out. Below one means
 * self-dealing cannot pay however it is attempted.
 */
export function selfDealingReturn(
  smoothing: number,
  multiple: number,
  holdingCap: number,
): number {
  return smoothing * multiple * holdingCap;
}

/**
 * Fold this tick's earnings into the smoothed figure.
 *
 * An exponential moving average, so one enormous build does not reprice a
 * company permanently and a sustained change does move it. `weight` is how
 * much of the new reading counts.
 */
export function smooth(previous: number, reading: number, weight: number): number {
  return previous + (reading - previous) * weight;
}

function nothing(pool: Pool): ShareQuote {
  return {
    shares: 0,
    marks: 0,
    fee: 0,
    total: 0,
    averagePrice: 0,
    priceBefore: price(pool),
    priceAfter: price(pool),
    after: pool,
  };
}
