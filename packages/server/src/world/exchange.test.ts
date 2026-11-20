import { beforeEach, describe, expect, it } from 'vitest';

import { content } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { openStore, type Store } from '../db/index.ts';
import { Exchange, type BourseRefused } from './Exchange.ts';
import { Gazette } from './Gazette.ts';
import { Ledger } from './Ledger.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';

let store: Store;
let accounts: Accounts;
let ledger: Ledger;
let pilots: PilotStore;
let bourse: Exchange;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
  pilots = new PilotStore(store);
  bourse = new Exchange(store, ledger);
  bourse.seed();
});

const { companies, tuning } = content();

function captain(callsign: string, marks = 1_000_000): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  const pilot = pilots.load(account.id)!;
  ledger.post(
    {
      accountId: account.id,
      delta: marks - pilot.marks,
      category: 'starting-balance',
      reason: 'Test float',
    },
    pilot,
  );
  return pilot;
}

/** What a listing is quoted at right now. */
function quoted(ticker: string): number {
  return bourse.listingsFor(undefined).find((l) => l.ticker === ticker)!.price;
}

describe('the Bourse', () => {
  it('opens every listing at what it is worth', () => {
    const listings = bourse.listingsFor(undefined);
    expect(listings).toHaveLength(companies.size);

    for (const listing of listings) {
      // The opening price is fair value, so nothing lurches on the first tick.
      expect(listing.price).toBeCloseTo(listing.fairValue, 1);
      expect(listing.price).toBeGreaterThan(0);
    }
  });

  it('seeds once, however many times it is opened', () => {
    const before = bourse.listingsFor(undefined).map((l) => l.price);
    bourse.seed();
    bourse.seed();
    expect(bourse.listingsFor(undefined).map((l) => l.price)).toEqual(before);
  });

  it('buys shares, charges for them and records the holding', () => {
    const pilot = captain('Investor');
    const before = pilot.marks;
    const fill = bourse.trade({ pilot, side: 'buy', ticker: 'SLP', shares: 20 });

    expect(fill.shares).toBe(20);
    expect(fill.total).toBe(fill.marks + fill.fee);
    expect(pilot.marks).toBe(before - fill.total);
    expect(fill.priceAfter).toBeGreaterThan(fill.priceBefore);

    const listing = bourse.listingsFor(pilot.accountId).find((l) => l.ticker === 'SLP')!;
    expect(listing.held).toBe(20);
    expect(listing.costBasis).toBe(fill.total);
  });

  it('sells them back for less than they cost', () => {
    const pilot = captain('Round Trip');
    const before = pilot.marks;
    const bought = bourse.trade({ pilot, side: 'buy', ticker: 'TFA', shares: 15 });
    bourse.trade({ pilot, side: 'sell', ticker: 'TFA', shares: bought.shares });

    expect(pilot.marks).toBeLessThan(before);
    expect(bourse.listingsFor(pilot.accountId).find((l) => l.ticker === 'TFA')!.held).toBe(0);
  });

  it('leaves no cost basis behind when a holding is cleared', () => {
    const pilot = captain('Tidy');
    bourse.trade({ pilot, side: 'buy', ticker: 'KSC', shares: 10 });
    bourse.trade({ pilot, side: 'sell', ticker: 'KSC', shares: 10 });
    const listing = bourse.listingsFor(pilot.accountId).find((l) => l.ticker === 'KSC')!;
    expect(listing.costBasis).toBe(0);
  });

  it('keeps the basis proportional on a partial sale', () => {
    const pilot = captain('Partial');
    const bought = bourse.trade({ pilot, side: 'buy', ticker: 'HRC', shares: 20 });
    bourse.trade({ pilot, side: 'sell', ticker: 'HRC', shares: 10 });

    const listing = bourse.listingsFor(pilot.accountId).find((l) => l.ticker === 'HRC')!;
    expect(listing.held).toBe(10);
    // Half the shares, about half the basis — the cost of what is left.
    expect(listing.costBasis).toBeCloseTo(bought.total / 2, -1);
  });

  // --- Refusals -----------------------------------------------------------

  it('refuses a company nobody lists', () => {
    const pilot = captain('Hopeful');
    expect(() => bourse.trade({ pilot, side: 'buy', ticker: 'ZZZ', shares: 1 })).toThrow(
      expect.objectContaining({ reason: 'no-such-listing' }),
    );
  });

  it('refuses to sell what is not held', () => {
    const pilot = captain('Empty Handed');
    try {
      bourse.trade({ pilot, side: 'sell', ticker: 'RPO', shares: 1 });
      expect.unreachable('sold shares it did not hold');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('not-holding');
    }
  });

  it('refuses a captain who cannot pay, and changes nothing', () => {
    // A purse that cannot cover one share at the quote, whatever the quote
    // happens to be: a fixed number of marks stops testing this the moment
    // the listings are retuned, which is exactly what happened.
    const pilot = captain('Skint', 0);
    const before = quoted('PZS');
    try {
      bourse.trade({ pilot, side: 'buy', ticker: 'PZS', shares: 50 });
      expect.unreachable('sold shares to a captain with five marks');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('cannot-afford');
    }
    expect(pilot.marks).toBe(0);
    expect(quoted('PZS')).toBe(before);
  });

  it('caps what one captain may hold of one company', () => {
    const pilot = captain('Cornering', 100_000_000);
    const cap = Math.floor(companies.get('UWH')!.float * tuning.exchange.holdingCap);

    // Buy repeatedly until the cap bites.
    for (let i = 0; i < 40; i++) {
      try {
        bourse.trade({ pilot, side: 'buy', ticker: 'UWH', shares: cap });
      } catch (error) {
        expect((error as BourseRefused).reason).toBe('holding-capped');
        break;
      }
    }

    const held = bourse.listingsFor(pilot.accountId).find((l) => l.ticker === 'UWH')!.held;
    expect(held).toBeLessThanOrEqual(cap);
    expect(held).toBeGreaterThan(0);
  });

  it('never lets a pool be emptied, however hard it is pushed', () => {
    const pilot = captain('Greedy', 1_000_000_000);
    for (let i = 0; i < 60; i++) {
      try {
        bourse.trade({ pilot, side: 'buy', ticker: 'MQP', shares: 1_000_000 });
      } catch {
        break;
      }
    }
    const listing = bourse.listingsFor(undefined).find((l) => l.ticker === 'MQP')!;
    expect(listing.price).toBeGreaterThan(0);
    expect(listing.available).toBeGreaterThanOrEqual(0);
  });

  // --- Invariant 3, through the service -----------------------------------

  it('invariant 3: no pool loses its product, over a long session', () => {
    const traders = [captain('A', 5_000_000), captain('B', 5_000_000), captain('C', 5_000_000)];
    const before = new Map(bourse.products().map((p) => [p.ticker, p.product]));

    const tickers = [...companies.keys()];
    for (let i = 0; i < 400; i++) {
      const pilot = traders[i % traders.length]!;
      const ticker = tickers[i % tickers.length]!;
      try {
        bourse.trade({
          pilot,
          side: i % 3 === 2 ? 'sell' : 'buy',
          ticker,
          shares: 1 + (i % 7),
        });
      } catch {
        // A refusal is a fine outcome; it just must not break the pool.
      }
    }

    for (const after of bourse.products()) {
      expect(after.product).toBeGreaterThanOrEqual(before.get(after.ticker)!);
      expect(after.price).toBeGreaterThan(0);
    }
  });

  // --- Invariant 6 --------------------------------------------------------

  it('invariant 6: wash trading moves no earnings at all', () => {
    const pilot = captain('Washer', 10_000_000);

    // Buy and sell the same parcel back and forth. Nothing about this is an
    // event the world should pay anyone for.
    for (let i = 0; i < 25; i++) {
      const bought = bourse.trade({ pilot, side: 'buy', ticker: 'TLY', shares: 5 });
      bourse.trade({ pilot, side: 'sell', ticker: 'TLY', shares: bought.shares });
    }

    const before = bourse.listingsFor(undefined).find((l) => l.ticker === 'TLY')!.earnings;
    bourse.tick(1);
    const after = bourse.listingsFor(undefined).find((l) => l.ticker === 'TLY')!.earnings;

    // The smoothed figure decays toward the nothing that was earned; it
    // certainly does not rise.
    expect(after).toBeLessThanOrEqual(before);
  });

  it('invariant 6: self-dealing loses money', () => {
    const pilot = captain('Self Dealer', 50_000_000);
    const before = pilot.marks;

    // The attack, played as well as it can be: take the largest holding
    // allowed, spend heavily to lift that company's earnings, let the house
    // trader carry the price up, then sell out at the top.
    const cap = Math.floor(companies.get('SLP')!.float * tuning.exchange.holdingCap);
    let held = 0;
    for (let i = 0; i < 30 && held < cap; i++) {
      try {
        held = bourse.trade({ pilot, side: 'buy', ticker: 'SLP', shares: cap - held }).held;
      } catch {
        break;
      }
    }

    // Spend a fortune on Slipway fittings. This is the costly-to-fake event,
    // and the captain really does pay for it.
    const spent = 2_000_000;
    ledger.post(
      { accountId: pilot.accountId, delta: -spent, category: 'module-purchase', reason: 'Self-dealing' },
      pilot,
    );
    bourse.credit({ ticker: 'SLP', marks: spent, kind: 'modules-sold' });

    // Let the house trader carry it as far as it will go.
    for (let i = 0; i < 60; i++) bourse.tick(i);

    for (let i = 0; i < 30 && held > 0; i++) {
      try {
        held = bourse.trade({ pilot, side: 'sell', ticker: 'SLP', shares: held }).held;
      } catch {
        break;
      }
    }

    // They are poorer than they started. The dividends they collected on the
    // way are counted too, because they are in the purse.
    expect(pilot.marks).toBeLessThan(before);
  });

  // --- The market tick ----------------------------------------------------

  it('moves a price toward fair value when a company earns', () => {
    const before = quoted('DPR');
    for (let i = 0; i < 12; i++) {
      bourse.credit({ ticker: 'DPR', marks: 40_000, kind: 'goods-sold', what: 'grain' });
      bourse.tick(i);
    }
    expect(quoted('DPR')).toBeGreaterThan(before);
  });

  it('and down again when it stops', () => {
    for (let i = 0; i < 12; i++) {
      bourse.credit({ ticker: 'DPR', marks: 40_000, kind: 'goods-sold', what: 'grain' });
      bourse.tick(i);
    }
    const peak = quoted('DPR');
    for (let i = 0; i < 80; i++) bourse.tick(i);
    expect(quoted('DPR')).toBeLessThan(peak);
  });

  it('holds its product while the house trader works', () => {
    const before = new Map(bourse.products().map((p) => [p.ticker, p.product]));
    for (let i = 0; i < 50; i++) {
      bourse.credit({ ticker: 'TFA', marks: 9000, kind: 'goods-sold', what: 'alloy' });
      bourse.tick(i);
    }
    for (const after of bourse.products()) {
      expect(after.product).toBeGreaterThanOrEqual(before.get(after.ticker)!);
    }
  });

  it('pays a dividend to holders and nobody else', () => {
    const holder = captain('Holder', 2_000_000);
    const bystander = captain('Bystander', 2_000_000);

    bourse.trade({ pilot: holder, side: 'buy', ticker: 'TFA', shares: 25 });
    const holderAfterBuying = holder.marks;
    const bystanderBefore = bystander.marks;

    for (let i = 0; i < tuning.exchange.dividendEvery * 2; i++) {
      bourse.credit({ ticker: 'TFA', marks: 200_000, kind: 'goods-sold', what: 'alloy' });
      bourse.tick(i);
    }

    expect(ledger.balanceOf(holder.accountId)).toBeGreaterThan(holderAfterBuying);
    expect(ledger.balanceOf(bystander.accountId)).toBe(bystanderBefore);

    const listing = bourse.listingsFor(holder.accountId).find((l) => l.ticker === 'TFA')!;
    expect(listing.dividends).toBeGreaterThan(0);
  });

  it('pays no dividend out of a company that earned nothing', () => {
    const holder = captain('Patient', 2_000_000);
    bourse.trade({ pilot: holder, side: 'buy', ticker: 'PZS', shares: 10 });
    const after = holder.marks;

    for (let i = 0; i < tuning.exchange.dividendEvery * 3; i++) bourse.tick(i);

    expect(ledger.balanceOf(holder.accountId)).toBe(after);
  });

  it('keeps a bounded run of history for the chart', () => {
    for (let i = 0; i < tuning.exchange.historyKeep + 50; i++) bourse.tick(i);
    const listing = bourse.listingsFor(undefined).find((l) => l.ticker === 'KSC')!;
    expect(listing.history.length).toBeLessThanOrEqual(tuning.exchange.historyKeep);
    expect(listing.history.length).toBeGreaterThan(10);
  });

  // --- Who earns what -----------------------------------------------------

  it('knows which company earns on which good at which berth', () => {
    expect(bourse.producerOf('kessler', 'grain')).toBe('DPR');
    expect(bourse.producerOf('kessler', 'circuitry')).toBe('HRC');
    expect(bourse.producerOf('thirty', 'ore')).toBe('TLY');
    expect(bourse.producerOf('thirty', 'alloy')).toBe('TFA');
    expect(bourse.producerOf('reprisal', 'propellant')).toBe('MQP');
    // A good nobody claims at a berth credits nobody.
    expect(bourse.producerOf('kessler', 'ore')).toBeUndefined();
    expect(bourse.producerOf('neutral', 'grain')).toBeUndefined();
  });

  it('knows which company makes which fittings, and who carries where', () => {
    expect(bourse.makerOf('HRC')).toBe('HRC');
    expect(bourse.makerOf('SLP')).toBe('SLP');
    expect(bourse.makerOf('RPO')).toBe('RPO');
    expect(bourse.carrierOf('home-roads')).toBe('KSC');
    expect(bourse.carrierOf('marque')).toBe('PZS');
    expect(bourse.insurer).toBe('UWH');
    expect(bourse.salvor).toBe('PZS');
  });

  it('ignores a credit for a company nobody lists', () => {
    bourse.credit({ ticker: 'ZZZ', marks: 10_000, kind: 'salvage' });
    expect(() => bourse.tick(1)).not.toThrow();
  });

  it('survives a reload: a holding is on the books, not in memory', () => {
    const pilot = captain('Persistent');
    bourse.trade({ pilot, side: 'buy', ticker: 'RPO', shares: 12 });

    const reopened = new Exchange(store, ledger);
    expect(reopened.listingsFor(pilot.accountId).find((l) => l.ticker === 'RPO')!.held).toBe(12);
  });
});

describe('freight lost on a lane', () => {
  /**
   * The chain M6 is done when: a freighter does not arrive, the producer
   * whose goods were aboard loses the sale, its price falls over the next
   * few market ticks, and the Gazette says why.
   *
   * Tested here rather than by flying a blockade because the claim is about
   * the economy, not about marksmanship. The acceptance harness flies the
   * interception for real and reports what it managed; this pins down what
   * the loss is supposed to do once it happens.
   */
  it('lowers the producer and prints a headline', () => {
    const gazette = new Gazette();

    // A working lane: the producer has been earning steadily, so its price
    // has somewhere to fall from.
    for (let i = 0; i < 30; i++) {
      bourse.credit({
        ticker: 'TLY',
        marks: 120_000,
        kind: 'goods-sold',
        where: 'Ballast',
        what: 'ore',
      });
      const result = bourse.tick(i);
      gazette.report(result.events, result.dividends, i);
    }

    const settled = bourse.listingsFor(undefined).find((l) => l.ticker === 'TLY')!.price;
    expect(settled).toBeGreaterThan(0);

    // Now the lane is cut: the consignments stop arriving, and the ones in
    // flight are lost outright.
    for (let i = 0; i < 12; i++) {
      bourse.credit({
        ticker: 'TLY',
        marks: -90_000,
        kind: 'goods-sold',
        where: 'Ballast',
        what: 'ore',
      });
      const result = bourse.tick(100 + i);
      gazette.report(result.events, result.dividends, 100 + i);
    }

    const after = bourse.listingsFor(undefined).find((l) => l.ticker === 'TLY')!.price;
    expect(after).toBeLessThan(settled);

    const explained = gazette
      .recent()
      .filter((line) => line.ticker === 'TLY' && line.direction === 'down');
    expect(explained.length).toBeGreaterThan(0);
    expect(explained[0]!.text).toContain('Ore');
  });

  it('costs the carrier too, and names the region', () => {
    const gazette = new Gazette();
    for (let i = 0; i < 8; i++) {
      bourse.credit({
        ticker: 'KSC',
        marks: -40_000,
        kind: 'freight',
        where: 'Hallam',
        what: 'home-roads',
      });
      const result = bourse.tick(i);
      gazette.report(result.events, result.dividends, i);
    }

    const lines = gazette.recent().filter((line) => line.ticker === 'KSC');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.text).toContain('lost in transit');
  });

  it('says nothing at all about a quiet company', () => {
    const gazette = new Gazette();
    for (let i = 0; i < 10; i++) {
      const result = bourse.tick(i);
      gazette.report(result.events, result.dividends, i);
    }
    // A feed that prints "nothing happened" ten times a tick is a feed
    // nobody reads.
    expect(gazette.recent()).toHaveLength(0);
  });
});

describe('selling what you do not have', () => {
  /** The listing every short in these tests is taken in. */
  const TICKER = 'KSC';

  /** What a captain holds of it, negative when they are short. */
  function held(pilot: Pilot): number {
    return bourse.listingsFor(pilot.accountId).find((l) => l.ticker === TICKER)!.held;
  }

  function basisOf(pilot: Pilot): number {
    return bourse.listingsFor(pilot.accountId).find((l) => l.ticker === TICKER)!.costBasis;
  }

  it('refuses a plain sale from a captain who holds nothing', () => {
    const pilot = captain('Empty');
    try {
      bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 10 });
      expect.unreachable('sold what it did not have');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('not-holding');
    }
  });

  it('takes the holding below nothing and pays the proceeds', () => {
    const pilot = captain('Bear');
    const before = pilot.marks;

    const fill = bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 200, short: true });

    expect(fill.shares).toBe(200);
    expect(held(pilot)).toBe(-200);
    expect(pilot.marks).toBe(before + fill.total);
    // The basis of a short is what the sale brought in.
    expect(basisOf(pilot)).toBe(fill.total);
  });

  it('caps a short at the same share of the float a holding is capped at', () => {
    const pilot = captain('Greedy');
    const cap = Math.floor(companies.get(TICKER)!.float * tuning.exchange.holdingCap);

    const fill = bourse.trade({
      pilot,
      side: 'sell',
      ticker: TICKER,
      shares: cap * 10,
      short: true,
    });
    expect(fill.shares).toBe(cap);
    expect(held(pilot)).toBe(-cap);

    try {
      bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 1, short: true });
      expect.unreachable('went past the cap');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('short-capped');
    }
  });

  it('refuses a short the captain could not buy back', () => {
    // A purse that covers a few shares and nothing like the position asked
    // for. The margin is measured on what it would cost to close, so the
    // proceeds of the short do not pay for the short.
    const pilot = captain('Thin', 400);
    try {
      bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 900, short: true });
      expect.unreachable('shorted on nothing');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('margin-short');
    }
    expect(held(pilot)).toBe(0);
  });

  it('measures a position at what it would cost to close, not at the quote', () => {
    const pilot = captain('Measured');
    bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 400, short: true });

    const standing = bourse.standing(pilot.accountId, pilot.marks);
    // Buying 400 back walks the curve, so it costs more than 400 times the
    // quote the sale left behind. Measuring at the quote is what let a short
    // large enough to crush the price be margined against the price it had
    // just crushed.
    expect(standing.owed).toBeGreaterThan(400 * quoted(TICKER));
    expect(standing.equity).toBeLessThan(pilot.marks);
  });

  it('buys part of a short back and leaves the rest owed', () => {
    const pilot = captain('Covering');
    const opened = bourse.trade({
      pilot,
      side: 'sell',
      ticker: TICKER,
      shares: 400,
      short: true,
    });

    bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 150 });

    expect(held(pilot)).toBe(-250);
    // The basis falls with the shares still owed, not with what was paid.
    expect(basisOf(pilot)).toBe(Math.round((opened.total * 250) / 400));
  });

  it('closes a short out exactly, leaving nothing behind', () => {
    const pilot = captain('Square');
    bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 300, short: true });
    bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 300 });

    expect(held(pilot)).toBe(0);
    expect(basisOf(pilot)).toBe(0);
  });

  it('and a captain who buys past their short simply ends up long', () => {
    const pilot = captain('Reversed');
    bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 200, short: true });
    const bought = bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 500 });

    expect(held(pilot)).toBe(300);
    // The basis is what was paid for the 300 beyond the cover, not for all 500.
    expect(basisOf(pilot)).toBe(Math.round((bought.total * 300) / 500));
  });

  it('leaves the marks in the world reconciled with the ledger', () => {
    const pilot = captain('Audited');
    bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 300, short: true });
    bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 120 });

    const total = (
      store.raw.prepare('SELECT COALESCE(SUM(marks), 0) AS t FROM pilots').get() as { t: number }
    ).t;
    const posted = (
      store.raw.prepare('SELECT COALESCE(SUM(delta), 0) AS t FROM ledger').get() as { t: number }
    ).t;
    expect(total).toBe(posted);
  });
});

describe('an order with a limit on it', () => {
  const TICKER = 'KSC';

  it('fills nothing when the price is the wrong side of the limit', () => {
    const pilot = captain('Patient');
    try {
      bourse.trade({
        pilot,
        side: 'buy',
        ticker: TICKER,
        shares: 100,
        limit: quoted(TICKER) * 0.5,
      });
      expect.unreachable('filled below the market');
    } catch (error) {
      expect((error as BourseRefused).reason).toBe('limit-not-reached');
    }
  });

  it('fills as far as the limit and no further', () => {
    const pilot = captain('Bounded');
    const limit = quoted(TICKER) * 1.05;

    const fill = bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 100_000, limit });

    expect(fill.shares).toBeGreaterThan(0);
    expect(fill.shares).toBeLessThan(100_000);
    // The quote it left behind is on the right side of the limit.
    expect(fill.priceAfter).toBeLessThanOrEqual(limit);
  });

  it('and a sell limit is a floor rather than a ceiling', () => {
    const pilot = captain('Holder');
    bourse.trade({ pilot, side: 'buy', ticker: TICKER, shares: 500 });

    const limit = quoted(TICKER) * 0.95;
    const fill = bourse.trade({ pilot, side: 'sell', ticker: TICKER, shares: 500, limit });

    expect(fill.shares).toBeGreaterThan(0);
    expect(fill.priceAfter).toBeGreaterThanOrEqual(limit);
  });
});
