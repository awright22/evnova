import { beforeEach, describe, expect, it } from 'vitest';

import { content, quote, type PortDef } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { openStore, type Store } from '../db/index.ts';
import { Ledger } from './Ledger.ts';
import { Market, TradeRefused } from './Market.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';

let store: Store;
let accounts: Accounts;
let ledger: Ledger;
let market: Market;
let pilots: PilotStore;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
  market = new Market(store, ledger);
  pilots = new PilotStore(store);
});

const { commodities, systems, tuning } = content();

/** A berth that trades, for the trade to happen at. */
function berth(id = 'ballast'): PortDef {
  for (const system of systems.values()) {
    const port = system.ports.find((candidate) => candidate.id === id);
    if (port) return port;
  }
  throw new Error(`no berth "${id}"`);
}

function captain(callsign: string, marks = 100_000): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  const pilot = pilots.load(account.id)!;

  // Through the cached pilot, not around it: posting to the row alone leaves
  // the cache holding the old balance, and the next flush writes it back.
  if (marks !== pilot.marks) {
    ledger.post(
      {
        accountId: account.id,
        delta: marks - pilot.marks,
        category: 'starting-balance',
        reason: 'Test float',
      },
      pilot,
    );
  }

  return pilot;
}

/** Total marks held by every captain. */
function totalMarks(): number {
  const row = store.raw.prepare('SELECT COALESCE(SUM(marks), 0) AS total FROM pilots').get() as {
    total: number;
  };
  return row.total;
}

/** Faucets minus sinks, straight from the ledger. */
function netPosted(): number {
  const row = store.raw.prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM ledger').get() as {
    total: number;
  };
  return row.total;
}

describe('the Staple', () => {
  it('lists every commodity with a price on both sides', () => {
    const pilot = captain('Carvalho');
    const listings = market.listingsFor(berth(), pilot);

    expect(listings).toHaveLength(commodities.size);
    for (const listing of listings) {
      expect(listing.ask).toBeGreaterThan(0);
      expect(listing.bid).toBeGreaterThan(0);
      expect(listing.bid).toBeLessThan(listing.ask);
      expect(listing.carried).toBe(0);
    }
  });

  it('moves cargo into the hold and marks out of the purse', () => {
    const pilot = captain('Leung');
    const before = pilot.marks;

    const result = market.trade({
      side: 'buy',
      port: berth(),
      commodityId: 'ore',
      units: 20,
      pilot,
      holdCapacity: 100,
      now: 1,
    });

    expect(result.units).toBe(20);
    expect(result.carried).toBe(20);
    expect(result.marksAfter).toBe(before - result.marks);
    expect(market.cargoUnits(pilot.accountId)).toBe(20);
  });

  // --- Invariant 1, through the real market -------------------------------

  it('invariant 1: buying and selling back at one berth never makes money', () => {
    const pilot = captain('Bello');
    const port = berth();

    for (const commodityId of ['ore', 'leaf', 'machinery']) {
      const before = pilot.marks;
      const bought = market.trade({
        side: 'buy', port, commodityId, units: 25, pilot, holdCapacity: 500, now: 1,
      });
      const sold = market.trade({
        side: 'sell', port, commodityId, units: bought.units, pilot, holdCapacity: 500, now: 2,
      });

      expect(sold.marksAfter).toBeLessThan(before);
      expect(sold.carried).toBe(0);
      // And the berth is back where it started.
      expect(sold.stock).toBe(bought.stock + bought.units);
    }
  });

  // --- Invariant 2, through the real market -------------------------------

  it('invariant 2: splitting an order costs the same as placing it whole', () => {
    const port = berth();
    const whole = captain('Whole');
    const split = captain('Split');

    const one = market.trade({
      side: 'buy', port, commodityId: 'alloy', units: 40, pilot: whole,
      holdCapacity: 500, now: 1,
    });

    // The second captain buys the same forty units in pieces, from a berth
    // that has been reset to where the first one found it.
    store.raw.prepare('DELETE FROM stockpiles').run();

    let spent = 0;
    for (const part of [9, 1, 20, 10]) {
      spent += market.trade({
        side: 'buy', port, commodityId: 'alloy', units: part, pilot: split,
        holdCapacity: 500, now: 2,
      }).marks;
    }

    expect(spent).toBe(one.marks);
  });

  // --- Invariant 4 --------------------------------------------------------

  it('invariant 4: every mark a trade moves passes through the ledger', () => {
    const a = captain('Sarkissian');
    const b = captain('Whitlock');
    const port = berth();

    for (let i = 0; i < 12; i++) {
      const pilot = i % 2 === 0 ? a : b;
      market.trade({
        side: 'buy', port, commodityId: 'ore', units: 7, pilot, holdCapacity: 400, now: i,
      });
      market.trade({
        side: 'sell', port, commodityId: 'ore', units: 3, pilot, holdCapacity: 400, now: i,
      });
    }

    expect(totalMarks()).toBe(netPosted());
  });

  it('invariant 4: a refused trade posts nothing at all', () => {
    const pilot = captain('Broke', 10);
    const before = netPosted();

    expect(() =>
      market.trade({
        side: 'buy', port: berth(), commodityId: 'leaf', units: 40, pilot,
        holdCapacity: 400, now: 1,
      }),
    ).toThrow(TradeRefused);

    expect(netPosted()).toBe(before);
    expect(market.cargoUnits(pilot.accountId)).toBe(0);
    expect(totalMarks()).toBe(netPosted());
  });

  // --- Invariant 5 --------------------------------------------------------

  it('invariant 5: no stock and no hold ever goes negative', () => {
    // Deep enough pockets to buy a berth out: the point of the test is what
    // happens at zero, not what a captain can afford.
    const pilot = captain('Van der Meer', 50_000_000);
    const port = berth();

    // Try to sell what is not aboard, and buy what the berth does not have.
    expect(() =>
      market.trade({
        side: 'sell', port, commodityId: 'circuitry', units: 5, pilot,
        holdCapacity: 400, now: 1,
      }),
    ).toThrow(TradeRefused);

    const commodity = commodities.get('ore')!;
    const pile = market.pileOf(port, commodity);

    // Empty the berth, then ask for more.
    market.trade({
      side: 'buy', port, commodityId: 'ore', units: pile.stock, pilot,
      holdCapacity: 100_000, now: 2,
    });
    expect(market.pileOf(port, commodity).stock).toBe(0);

    expect(() =>
      market.trade({
        side: 'buy', port, commodityId: 'ore', units: 5, pilot,
        holdCapacity: 100_000, now: 3,
      }),
    ).toThrow(TradeRefused);

    const rows = store.raw
      .prepare('SELECT MIN(stock) AS lowest FROM stockpiles')
      .get() as { lowest: number | null };
    expect(rows.lowest ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('invariant 5: a hull cannot carry more than its bays hold', () => {
    const pilot = captain('Tight Hold');
    const result = market.trade({
      side: 'buy', port: berth(), commodityId: 'ore', units: 500, pilot,
      holdCapacity: 20, now: 1,
    });

    expect(result.units).toBe(20);
    expect(market.cargoUnits(pilot.accountId)).toBe(20);

    expect(() =>
      market.trade({
        side: 'buy', port: berth(), commodityId: 'ice', units: 1, pilot,
        holdCapacity: 20, now: 2,
      }),
    ).toThrow(TradeRefused);
  });

  it('refuses a commodity or a berth that does not exist', () => {
    const pilot = captain('Nowhere');

    expect(() =>
      market.trade({
        side: 'buy', port: berth(), commodityId: 'unobtanium', units: 1, pilot,
        holdCapacity: 100, now: 1,
      }),
    ).toThrow(TradeRefused);

    // Underwriters' Hall keeps no Staple in the data, so it is not a market.
    const noMarket: PortDef = { ...berth(), services: ['moorings'] };
    expect(() =>
      market.trade({
        side: 'buy', port: noMarket, commodityId: 'ore', units: 1, pilot,
        holdCapacity: 100, now: 1,
      }),
    ).toThrow(TradeRefused);
  });

  // --- The clock ----------------------------------------------------------

  it('drifts a producer up and a consumer down', () => {
    const port = berth('ballast');
    const ore = commodities.get('ore')!;
    const provisions = commodities.get('provisions')!;

    const oreBefore = market.pileOf(port, ore).stock;
    const provisionsBefore = market.pileOf(port, provisions).stock;

    market.drift(6, 1);

    expect(market.pileOf(port, ore).stock).toBeGreaterThan(oreBefore);
    expect(market.pileOf(port, provisions).stock).toBeLessThan(provisionsBefore);
  });

  it('drifts by elapsed time, not by how often it was asked', () => {
    const port = berth('ballast');
    const ore = commodities.get('ore')!;
    const start = market.pileOf(port, ore).stock;

    market.drift(4, 1);
    const once = market.pileOf(port, ore).stock;

    store.raw.prepare('DELETE FROM stockpiles').run();
    for (let i = 0; i < 4; i++) market.drift(1, i);
    const stepped = market.pileOf(port, ore).stock;

    expect(stepped).toBe(once);
    expect(stepped).toBeGreaterThan(start);
  });

  it('never drifts a berth past its capacity or below nothing', () => {
    const port = berth('ballast');
    const ore = commodities.get('ore')!;
    const provisions = commodities.get('provisions')!;

    // A year of nobody trading.
    market.drift(24 * 365, 1);

    const orePile = market.pileOf(port, ore);
    const provisionsPile = market.pileOf(port, provisions);

    expect(orePile.stock).toBeLessThanOrEqual(orePile.capacity);
    expect(provisionsPile.stock).toBeGreaterThanOrEqual(0);
  });

  it('prices a berth that has drifted into shortage above one at target', () => {
    const port = berth('ballast');
    const provisions = commodities.get('provisions')!;

    const atTarget = market.pileOf(port, provisions);
    const before = quote('buy', 1, atTarget, provisions, tuning).marks;

    // Half a day, which leaves the berth short but still trading. Long enough
    // to empty it is a different property, and one only freight can hold.
    market.drift(12, 1);

    const short = market.pileOf(port, provisions);
    const after = quote('buy', 1, short, provisions, tuning).marks;

    expect(short.stock).toBeLessThan(atTarget.stock);
    expect(short.stock).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
  });

  it('leaves a consuming berth empty with nobody supplying it', () => {
    // Not a bug but the shape of the problem freight exists to solve: a berth
    // that only eats something runs out, and the galaxy is only stable
    // because goods move from surplus to shortage. Stated here so that the
    // day drift changes, this says what it was relying on.
    const port = berth('ballast');
    const provisions = commodities.get('provisions')!;

    market.drift(24 * 7, 1);

    expect(market.pileOf(port, provisions).stock).toBe(0);
  });
});
