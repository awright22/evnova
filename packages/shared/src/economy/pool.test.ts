import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { Rng } from '../math/rng.ts';

import {
  affordableShares,
  fairValue,
  houseTrade,
  price,
  product,
  quoteBuy,
  sharesToPrice,
  quoteSell,
  selfDealingReturn,
  sellableShares,
  smooth,
  type Pool,
} from './pool.ts';

const FEE = 0.004;
const MAX_FRACTION = 0.25;

/** A pool at 50 marks a share, which is a middling listing. */
const POOL: Pool = { shares: 200_000, marks: 10_000_000 };

describe('share pools', () => {
  it('quotes a price, and a parcel costs more than the quote', () => {
    expect(price(POOL)).toBe(50);
    const quote = quoteBuy(POOL, 1000, FEE, MAX_FRACTION);
    expect(quote.averagePrice).toBeGreaterThan(quote.priceBefore);
  });

  it('moves the price up on a purchase and down on a sale', () => {
    expect(quoteBuy(POOL, 5000, FEE, MAX_FRACTION).priceAfter).toBeGreaterThan(price(POOL));
    expect(quoteSell(POOL, 5000, FEE).priceAfter).toBeLessThan(price(POOL));
  });

  it('charges more per share for a larger parcel', () => {
    const small = quoteBuy(POOL, 100, FEE, MAX_FRACTION);
    const large = quoteBuy(POOL, 20_000, FEE, MAX_FRACTION);
    expect(large.averagePrice).toBeGreaterThan(small.averagePrice);
  });

  it('will not sell more than its cap, however much is asked', () => {
    const quote = quoteBuy(POOL, 10_000_000, FEE, MAX_FRACTION);
    expect(quote.shares).toBe(sellableShares(POOL, MAX_FRACTION));
    expect(quote.after.shares).toBeGreaterThan(0);
  });

  // --- Invariant 3 --------------------------------------------------------

  it('invariant 3: the pool invariant never falls, on any trade', () => {
    const rng = new Rng('pool-invariant');
    let pool = POOL;
    let before = product(pool);

    for (let i = 0; i < 2000; i++) {
      const size = Math.max(1, Math.floor(rng.range(1, 8000)));
      const quote = rng.next() < 0.5
        ? quoteBuy(pool, size, FEE, MAX_FRACTION)
        : quoteSell(pool, size, FEE);
      if (quote.shares === 0) continue;

      pool = quote.after;
      const after = product(pool);
      expect(after).toBeGreaterThanOrEqual(before);
      before = after;
    }

    // And it stayed a working pool rather than drifting to an edge.
    expect(pool.shares).toBeGreaterThan(0);
    expect(pool.marks).toBeGreaterThan(0);
  });

  it('invariant 3: a round trip loses at least the fees', () => {
    for (const size of [1, 10, 500, 5000, 40_000]) {
      const bought = quoteBuy(POOL, size, FEE, MAX_FRACTION);
      if (bought.shares === 0) continue;

      const sold = quoteSell(bought.after, bought.shares, FEE);
      const lost = bought.total - sold.total;

      expect(lost).toBeGreaterThanOrEqual(bought.fee + sold.fee);
      // Which is to say: a round trip is never free.
      expect(lost).toBeGreaterThan(0);
    }
  });

  it('invariant 3: a round trip loses even with no fee at all', () => {
    // The rounding alone has to be enough. If this fails, the fee is the only
    // thing standing between the pool and a free money machine.
    for (const size of [1, 7, 333, 9999]) {
      const bought = quoteBuy(POOL, size, 0, MAX_FRACTION);
      const sold = quoteSell(bought.after, bought.shares, 0);
      expect(sold.total).toBeLessThanOrEqual(bought.total);
    }
  });

  it('invariant 3: splitting a round trip does not beat making it whole', () => {
    const whole = quoteBuy(POOL, 3000, FEE, MAX_FRACTION);

    let pool = POOL;
    let paid = 0;
    let got = 0;
    for (const part of [1000, 1000, 1000]) {
      const quote = quoteBuy(pool, part, FEE, MAX_FRACTION);
      paid += quote.total;
      got += quote.shares;
      pool = quote.after;
    }

    expect(got).toBe(whole.shares);
    expect(paid).toBeGreaterThanOrEqual(whole.total);
  });

  it('never pays out more marks than it holds', () => {
    const rng = new Rng('drain');
    let pool: Pool = { shares: 1000, marks: 50_000 };
    for (let i = 0; i < 500; i++) {
      const quote = quoteSell(pool, Math.max(1, Math.floor(rng.range(1, 5000))), FEE);
      expect(quote.marks).toBeLessThan(pool.marks);
      expect(quote.after.marks).toBeGreaterThan(0);
      pool = quote.after;
    }
  });

  it('quotes nothing for a parcel of nothing', () => {
    expect(quoteBuy(POOL, 0, FEE, MAX_FRACTION).total).toBe(0);
    expect(quoteSell(POOL, 0, FEE).total).toBe(0);
    expect(quoteBuy(POOL, -5, FEE, MAX_FRACTION).shares).toBe(0);
  });

  // --- What a captain can afford -----------------------------------------

  it('finds exactly what a purse covers, and not one share more', () => {
    for (const purse of [0, 49, 51, 1000, 250_000, 9_000_000]) {
      const shares = affordableShares(POOL, purse, FEE, MAX_FRACTION);
      expect(quoteBuy(POOL, shares, FEE, MAX_FRACTION).total).toBeLessThanOrEqual(purse);
      if (shares < sellableShares(POOL, MAX_FRACTION)) {
        expect(quoteBuy(POOL, shares + 1, FEE, MAX_FRACTION).total).toBeGreaterThan(purse);
      }
    }
  });

  it('affords nothing on an empty purse', () => {
    expect(affordableShares(POOL, 0, FEE, MAX_FRACTION)).toBe(0);
  });

  // --- The house trader ---------------------------------------------------

  it('moves the price toward fair value without crossing it', () => {
    const dearer = houseTrade(POOL, 80, 0.2);
    expect(price(dearer)).toBeGreaterThan(50);
    expect(price(dearer)).toBeLessThan(80);

    const cheaper = houseTrade(POOL, 20, 0.2);
    expect(price(cheaper)).toBeLessThan(50);
    expect(price(cheaper)).toBeGreaterThan(20);
  });

  it('converges on fair value if the world stops changing', () => {
    let pool = POOL;
    for (let i = 0; i < 400; i++) pool = houseTrade(pool, 80, 0.2);
    expect(price(pool)).toBeCloseTo(80, 0);
  });

  it('trades along the curve, so the invariant does not fall', () => {
    let pool = POOL;
    let before = product(pool);
    for (const fair of [80, 12, 50, 300, 7, 44]) {
      for (let i = 0; i < 50; i++) {
        pool = houseTrade(pool, fair, 0.2);
        const after = product(pool);
        expect(after).toBeGreaterThanOrEqual(before);
        before = after;
      }
    }
  });

  it('leaves a pool alone when there is nothing to say about it', () => {
    expect(houseTrade(POOL, 0, 0.2)).toEqual(POOL);
    expect(houseTrade({ shares: 0, marks: 10 }, 50, 0.2)).toEqual({ shares: 0, marks: 10 });
  });

  // --- Fair value ---------------------------------------------------------

  it('values a share at a multiple of earnings over the float, above a floor', () => {
    expect(fairValue(1000, 12, 5, 100)).toBe(120);
    expect(fairValue(0, 12, 5, 100)).toBe(5);
    expect(fairValue(-900, 12, 5, 100)).toBe(5);
    expect(fairValue(1000, 12, 5, 0)).toBe(5);
  });

  it('divides by the float, so a wider float is a cheaper share', () => {
    // The division is what keeps invariant 6 within reach: without it, a
    // captain's gain per mark spent scales with the whole float.
    expect(fairValue(1000, 12, 1, 200)).toBe(60);
    expect(fairValue(1000, 12, 1, 400)).toBe(30);
  });

  it('bounds what self-dealing can ever capture', () => {
    expect(selfDealingReturn(0.02, 400, 0.1)).toBeCloseTo(0.8, 6);
    // The shipped tuning must stay under one, or a captain can lift a
    // company's earnings by a mark and gain more than a mark.
    const { exchange } = content().tuning;
    expect(
      selfDealingReturn(exchange.smoothing, exchange.multiple, exchange.holdingCap),
    ).toBeLessThan(1);
  });

  it('smooths a reading rather than taking it whole', () => {
    expect(smooth(100, 200, 0.25)).toBe(125);
    // A spike decays rather than repricing the company for good.
    let value = 100;
    value = smooth(value, 10_000, 0.25);
    for (let i = 0; i < 40; i++) value = smooth(value, 100, 0.25);
    expect(value).toBeCloseTo(100, 1);
  });
});

describe('filling to a limit', () => {
  const { tuning } = content();
  const { feeRate, maxPoolFraction } = tuning.exchange;
  /** A round pool, so the arithmetic in the expectations is readable. */
  const pool = { shares: 10_000, marks: 1_000_000 };

  it('fills nothing when the price has already passed a buy limit', () => {
    // The pool quotes a hundred; a captain willing to pay ninety gets nothing.
    expect(price(pool)).toBe(100);
    expect(sharesToPrice(pool, 'buy', 90, feeRate, maxPoolFraction)).toBe(0);
  });

  it('and nothing when it has passed a sell limit', () => {
    expect(sharesToPrice(pool, 'sell', 110, feeRate, maxPoolFraction)).toBe(0);
  });

  it('buys up to the limit and not one share past it', () => {
    const shares = sharesToPrice(pool, 'buy', 110, feeRate, maxPoolFraction);
    expect(shares).toBeGreaterThan(0);
    expect(quoteBuy(pool, shares, feeRate, maxPoolFraction).priceAfter).toBeLessThanOrEqual(110);
    expect(quoteBuy(pool, shares + 1, feeRate, maxPoolFraction).priceAfter).toBeGreaterThan(110);
  });

  it('sells down to the limit and not one share past it', () => {
    const shares = sharesToPrice(pool, 'sell', 90, feeRate, maxPoolFraction);
    expect(shares).toBeGreaterThan(0);
    expect(quoteSell(pool, shares, feeRate).priceAfter).toBeGreaterThanOrEqual(90);
    expect(quoteSell(pool, shares + 1, feeRate).priceAfter).toBeLessThan(90);
  });

  it('never takes more of a pool than one order is allowed to', () => {
    // A limit far above the price would fill for ever if the cap did not hold.
    const shares = sharesToPrice(pool, 'buy', 1_000_000, feeRate, maxPoolFraction);
    expect(shares).toBe(Math.floor(pool.shares * maxPoolFraction));
  });

  it('and the same on the sell side', () => {
    const shares = sharesToPrice(pool, 'sell', 0.0001, feeRate, maxPoolFraction);
    expect(shares).toBe(Math.floor(pool.shares * maxPoolFraction));
  });

  it('is monotone: a looser limit never fills less', () => {
    let last = 0;
    for (const limit of [101, 103, 106, 110, 120, 140]) {
      const shares = sharesToPrice(pool, 'buy', limit, feeRate, maxPoolFraction);
      expect(shares).toBeGreaterThanOrEqual(last);
      last = shares;
    }
    expect(last).toBeGreaterThan(0);
  });

  it('refuses a limit of nothing rather than dividing by it', () => {
    expect(sharesToPrice(pool, 'buy', 0, feeRate, maxPoolFraction)).toBe(0);
    expect(sharesToPrice(pool, 'sell', -5, feeRate, maxPoolFraction)).toBe(0);
  });

  it('fills nothing out of a pool with no shares in it', () => {
    expect(sharesToPrice({ shares: 0, marks: 500 }, 'buy', 1000, feeRate, maxPoolFraction)).toBe(0);
  });
});
