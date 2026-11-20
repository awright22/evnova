/**
 * The Bourse's arithmetic.
 *
 * Only the pure parts: the pool the ticket reconstructs from a listing, the
 * bounds on an order, the book derived from the listings, and the plot. The
 * markup is judged from a capture, not from assertions.
 */

import { describe, expect, it } from 'vitest';

import { quoteBuy, type Listing, type Pool } from '@marque/shared';

import {
  ageLabel,
  bookOf,
  buyLimit,
  formatPercent,
  formatRate,
  holdingsOf,
  moveOf,
  poolOf,
} from './Bourse.tsx';
import { plot } from './chart.tsx';

const FEE = 0.005;
const FRACTION = 0.25;

/** A pool, and the listing a server would publish for it. */
function listed(pool: Pool, overrides: Partial<Listing> = {}): Listing {
  const price = pool.marks / pool.shares;
  return {
    ticker: 'KSC',
    name: 'Kessler Carriage',
    parent: 'Kessler & Daughters',
    sector: 'Freight',
    description: 'Freight between the Home Roads and the Concessions.',
    price,
    fairValue: price,
    earnings: 400,
    previous: price,
    history: [price],
    float: 1_000_000,
    holdingCap: 50_000,
    held: 0,
    costBasis: 0,
    dividends: 0,
    available: Math.floor(pool.shares * FRACTION),
    ...overrides,
  };
}

describe('poolOf', () => {
  it('recovers the pool behind a listing', () => {
    const pool: Pool = { shares: 400_000, marks: 20_000_000 };
    expect(poolOf(listed(pool), FRACTION)).toEqual(pool);
  });

  it('quotes a parcel the way the floor would', () => {
    const pool: Pool = { shares: 400_000, marks: 20_000_000 };
    const theirs = quoteBuy(pool, 2_000, FEE, FRACTION);
    const ours = quoteBuy(poolOf(listed(pool), FRACTION), 2_000, FEE, FRACTION);
    expect(ours.total).toBe(theirs.total);
    expect(ours.priceAfter).toBeCloseTo(theirs.priceAfter, 6);
  });

  it('never hands the pool functions an empty pool', () => {
    const pool = poolOf(listed({ shares: 1, marks: 1 }, { available: 0 }), FRACTION);
    expect(pool.shares).toBeGreaterThan(0);
    expect(pool.marks).toBeGreaterThan(0);
  });
});

describe('buyLimit', () => {
  const pool: Pool = { shares: 400_000, marks: 20_000_000 };

  it('stops at the holding cap and says so', () => {
    const limit = buyLimit(
      listed(pool, { holdingCap: 1_000, held: 900 }),
      10_000_000,
      FEE,
      FRACTION,
    );
    expect(limit.max).toBe(100);
    expect(limit.bound).toBe('cap');
  });

  it('stops at what the marks cover and says so', () => {
    const limit = buyLimit(listed(pool), 5_000, FEE, FRACTION);
    expect(limit.bound).toBe('marks');
    expect(limit.max).toBe(limit.affordable);
    // And the parcel it allows is genuinely payable.
    expect(quoteBuy(pool, limit.max, FEE, FRACTION).total).toBeLessThanOrEqual(5_000);
  });

  it('stops at what the pool will part with and says so', () => {
    const limit = buyLimit(
      listed(pool, { holdingCap: 10_000_000 }),
      1_000_000_000_000,
      FEE,
      FRACTION,
    );
    expect(limit.bound).toBe('pool');
    expect(limit.max).toBe(100_000);
  });

  it('allows nothing to a captain already at the cap', () => {
    const limit = buyLimit(
      listed(pool, { holdingCap: 500, held: 500 }),
      10_000_000,
      FEE,
      FRACTION,
    );
    expect(limit.max).toBe(0);
    expect(limit.bound).toBe('cap');
  });
});

describe('the book', () => {
  const pool: Pool = { shares: 400_000, marks: 20_000_000 };

  it('derives cost, value, gain and dividends from the listings', () => {
    const rows = holdingsOf([
      listed(pool, { ticker: 'KSC', held: 100, costBasis: 4_000, dividends: 120 }),
      listed(pool, { ticker: 'TLY', held: 0, costBasis: 0, dividends: 0 }),
    ]);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.averageCost).toBe(40);
    // The quote is 50 a share, so 100 held are worth 5,000 against 4,000 paid.
    expect(row?.value).toBe(5_000);
    expect(row?.gain).toBe(1_000);
    expect(row?.gainFraction).toBeCloseTo(0.25, 6);
  });

  it('keeps a company sold out of but paid by', () => {
    const rows = holdingsOf([
      listed(pool, { ticker: 'UWH', held: 0, costBasis: 0, dividends: 300 }),
    ]);
    expect(rows.map((row) => row.ticker)).toEqual(['UWH']);
    expect(rows[0]?.averageCost).toBe(0);
  });

  it('totals the rows', () => {
    const book = bookOf(
      holdingsOf([
        listed(pool, { ticker: 'KSC', held: 100, costBasis: 4_000, dividends: 120 }),
        listed(pool, { ticker: 'TLY', held: 40, costBasis: 2_400, dividends: 0 }),
      ]),
    );
    expect(book.costBasis).toBe(6_400);
    expect(book.value).toBe(7_000);
    expect(book.gain).toBe(600);
    expect(book.dividends).toBe(120);
  });

  it('reads an empty book as nothing rather than as a division by zero', () => {
    const book = bookOf([]);
    expect(book.gainFraction).toBe(0);
    expect(book.value).toBe(0);
  });
});

describe('figures as the screen prints them', () => {
  it('signs a move and never shows a signed zero', () => {
    expect(formatPercent(0.0123)).toBe('+1.2%');
    expect(formatPercent(-0.0123)).toBe('-1.2%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(-0.00001)).toBe('0.0%');
  });

  it('reads a rate without a sign and without a dangling zero', () => {
    expect(formatRate(0.005)).toBe('0.5%');
    expect(formatRate(0.25)).toBe('25%');
  });

  it('guards a move against a missing previous quote', () => {
    expect(moveOf(50, 0)).toBe(0);
    expect(moveOf(55, 50)).toBeCloseTo(0.1, 6);
  });

  it('ages a headline in the Gazette’s words', () => {
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(-5_000)).toBe('just now');
    expect(ageLabel(120_000)).toBe('2m ago');
    expect(ageLabel(3 * 3_600_000)).toBe('3h ago');
    expect(ageLabel(50 * 3_600_000)).toBe('2d ago');
  });
});

describe('plot', () => {
  it('keeps the line, the quote and fair value all on scale', () => {
    const figure = plot([10, 12, 11, 14], 14, 20);
    expect(figure.low).toBeLessThan(10);
    expect(figure.high).toBeGreaterThan(20);
    expect(figure.fairY).toBeGreaterThanOrEqual(0);
    expect(figure.fairY).toBeLessThanOrEqual(100);
  });

  it('spans the well from the oldest reading to the newest', () => {
    const figure = plot([10, 12, 11, 14], 14, 12);
    expect(figure.line.startsWith('0,')).toBe(true);
    expect(figure.last?.x).toBe(100);
    expect(figure.rising).toBe(true);
  });

  it('gives a flat series a range rather than one line of readings', () => {
    const figure = plot([20, 20, 20], 20, 20);
    expect(figure.high).toBeGreaterThan(figure.low);
    expect(figure.rising).toBe(true);
  });

  it('draws nothing from nothing', () => {
    const figure = plot([], 0, 0);
    expect(figure.line).toBe('');
    expect(figure.area).toBe('');
    expect(figure.last).toBeUndefined();
  });

  it('marks a falling window as falling', () => {
    expect(plot([30, 20, 10], 10, 10).rising).toBe(false);
  });
});
