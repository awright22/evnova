import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { affordableUnits, bidPrice, quote, unitPrice, type Stockpile } from './price.ts';

const { commodities, tuning } = content();

/** A berth holding exactly what it wants of something. */
function pileAt(stock: number, target = 500, capacity = 2000): Stockpile {
  return { stock, target, capacity };
}

const ORE = commodities.get('ore')!;
const LEAF = commodities.get('leaf')!;

/**
 * Spec invariants 1 and 2, which are properties of the pricing rule itself
 * rather than of any screen: buying and selling back at one berth never makes
 * money, and splitting an order costs exactly what placing it whole costs.
 */
describe('pricing', () => {
  it('quotes the base price at target stock', () => {
    const price = unitPrice(500, pileAt(500), ORE, tuning);
    expect(price).toBeCloseTo(ORE.basePrice, 6);
  });

  it('charges more as stock falls and less as it rises', () => {
    const scarce = unitPrice(100, pileAt(500), ORE, tuning);
    const even = unitPrice(500, pileAt(500), ORE, tuning);
    const glut = unitPrice(1500, pileAt(500), ORE, tuning);

    expect(scarce).toBeGreaterThan(even);
    expect(even).toBeGreaterThan(glut);
  });

  it('holds every price inside its tier band', () => {
    for (const commodity of commodities.values()) {
      const band = tuning.market.bands[commodity.tier];
      for (const stock of [0, 1, 10, 250, 500, 5000, 100_000]) {
        const price = unitPrice(stock, pileAt(500), commodity, tuning);
        expect(price).toBeGreaterThanOrEqual(commodity.basePrice * band.min - 1e-9);
        expect(price).toBeLessThanOrEqual(commodity.basePrice * band.max + 1e-9);
      }
    }
  });

  it('pays less than it charges', () => {
    for (const stock of [1, 50, 500, 2000]) {
      expect(bidPrice(stock, pileAt(500), LEAF, tuning)).toBeLessThan(
        unitPrice(stock, pileAt(500), LEAF, tuning),
      );
    }
  });

  // --- Invariant 1 --------------------------------------------------------

  it('invariant 1: buying and selling back at one berth never makes money', () => {
    for (const commodity of commodities.values()) {
      for (const stock of [40, 120, 500, 900, 1800]) {
        for (const units of [1, 5, 25, 100]) {
          const pile = pileAt(stock);
          const bought = quote('buy', units, pile, commodity, tuning);
          if (bought.units === 0) continue;

          // Sell them straight back into the berth they came from.
          const after: Stockpile = { ...pile, stock: bought.stockAfter };
          const sold = quote('sell', bought.units, after, commodity, tuning);

          expect(sold.marks).toBeLessThanOrEqual(bought.marks);
          // And the berth ends where it started.
          expect(sold.stockAfter).toBe(pile.stock);
        }
      }
    }
  });

  // --- Invariant 2 --------------------------------------------------------

  it('invariant 2: splitting a buy costs exactly what buying it whole costs', () => {
    for (const commodity of commodities.values()) {
      for (const stock of [60, 500, 1700]) {
        const pile = pileAt(stock);
        const whole = quote('buy', 30, pile, commodity, tuning);

        let stepped = 0;
        let running = pile.stock;
        for (const part of [7, 1, 12, 10]) {
          const piece = quote('buy', part, { ...pile, stock: running }, commodity, tuning);
          stepped += piece.marks;
          running = piece.stockAfter;
        }

        expect(stepped).toBe(whole.marks);
        expect(running).toBe(whole.stockAfter);
      }
    }
  });

  it('invariant 2: splitting a sale pays exactly what selling it whole pays', () => {
    for (const commodity of commodities.values()) {
      for (const stock of [60, 500, 1700]) {
        const pile = pileAt(stock);
        const whole = quote('sell', 30, pile, commodity, tuning);

        let stepped = 0;
        let running = pile.stock;
        for (const part of [3, 18, 9]) {
          const piece = quote('sell', part, { ...pile, stock: running }, commodity, tuning);
          stepped += piece.marks;
          running = piece.stockAfter;
        }

        expect(stepped).toBe(whole.marks);
        expect(running).toBe(whole.stockAfter);
      }
    }
  });

  it('charges a single unit the same whether asked for alone or first', () => {
    const pile = pileAt(430);
    const alone = quote('buy', 1, pile, ORE, tuning);
    const asPartOfTen = quote('buy', 10, pile, ORE, tuning);
    const rest = quote('buy', 9, { ...pile, stock: alone.stockAfter }, ORE, tuning);

    expect(alone.marks + rest.marks).toBe(asPartOfTen.marks);
  });

  // --- Limits -------------------------------------------------------------

  it('sells only what the berth has', () => {
    const pile = pileAt(8, 500, 2000);
    const order = quote('buy', 50, pile, ORE, tuning);

    expect(order.units).toBe(8);
    expect(order.stockAfter).toBe(0);
    expect(order.limited).toBe('out-of-stock');
  });

  it('takes only what the berth has room for', () => {
    const pile = pileAt(1995, 500, 2000);
    const order = quote('sell', 50, pile, ORE, tuning);

    expect(order.units).toBe(5);
    expect(order.stockAfter).toBe(2000);
    expect(order.limited).toBe('no-room');
  });

  it('trades nothing for a zero or negative order', () => {
    for (const units of [0, -1, -100]) {
      const order = quote('buy', units, pileAt(500), ORE, tuning);
      expect(order.units).toBe(0);
      expect(order.marks).toBe(0);
    }
  });

  it('quotes whole marks in both directions', () => {
    for (const commodity of commodities.values()) {
      const bought = quote('buy', 17, pileAt(333), commodity, tuning);
      const sold = quote('sell', 17, pileAt(333), commodity, tuning);
      expect(Number.isInteger(bought.marks)).toBe(true);
      expect(Number.isInteger(sold.marks)).toBe(true);
    }
  });

  // --- Affordability ------------------------------------------------------

  it('never offers more units than the purse covers', () => {
    for (const marks of [0, 35, 400, 10_000]) {
      const pile = pileAt(600);
      const units = affordableUnits(marks, pile, ORE, tuning, 1000);
      const order = quote('buy', units, pile, ORE, tuning);

      expect(order.marks).toBeLessThanOrEqual(marks);

      // And one more unit would not have fitted.
      const oneMore = quote('buy', units + 1, pile, ORE, tuning);
      if (oneMore.units > units) expect(oneMore.marks).toBeGreaterThan(marks);
    }
  });
});
