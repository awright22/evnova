/**
 * Trade between captains.
 *
 * The rules worth holding are the ones about atomicity and about what is
 * checked when: an offer is a claim made at one moment and taken up at
 * another, and everything about it may have changed in between. Invariant 4
 * is checked explicitly, because a transfer is the one posting that must
 * create and destroy nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { content } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { openStore, schema, type Store } from '../db/index.ts';
import { Ledger } from './Ledger.ts';
import { Market } from './Market.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';
import { OfferRefused, Trades } from './Trades.ts';
import { Yard } from './Yard.ts';

let store: Store;
let accounts: Accounts;
let ledger: Ledger;
let market: Market;
let yard: Yard;
let pilots: PilotStore;
let trades: Trades;

const T0 = 1_700_000_000_000;
const BERTH = 'countinghouse';
/** Room for anything these tests move. */
const HOLD = 10_000;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
  market = new Market(store, ledger);
  yard = new Yard(store, ledger, market);
  pilots = new PilotStore(store);
  trades = new Trades(store, ledger, market, yard);
});

/** A captain, landed at the berth and carrying what they were given. */
function captain(
  callsign: string,
  options: { at?: string; cargo?: Record<string, number> } = {},
): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  const pilot = pilots.load(account.id);
  if (!pilot) throw new Error('no captain');
  pilot.landedPortId = options.at ?? BERTH;
  for (const [commodityId, units] of Object.entries(options.cargo ?? {})) {
    market.adjustCargo(account.id, commodityId, units);
  }
  return pilot;
}

/** Faucets minus sinks, straight from the ledger. */
function netPosted(): number {
  const row = store.raw.prepare('SELECT SUM(delta) AS total FROM ledger').get() as {
    total: number | null;
  };
  return row.total ?? 0;
}

/** Total marks held by every captain. */
function totalMarks(): number {
  const row = store.raw.prepare('SELECT SUM(marks) AS total FROM pilots').get() as {
    total: number | null;
  };
  return row.total ?? 0;
}

describe('making an offer', () => {
  it('reads back what was put up, with the goods named', () => {
    const a = captain('Seller', { cargo: { ore: 40 } });
    captain('Buyer');

    const offer = trades.offer(a, 'Buyer', { marks: 3_000, cargo: [{ commodityId: 'ore', units: 25 }], designId: '' }, T0);

    expect(offer.from).toBe('Seller');
    expect(offer.to).toBe('Buyer');
    expect(offer.marks).toBe(3_000);
    expect(offer.cargo).toEqual([
      { commodityId: 'ore', name: content().commodities.get('ore')?.name, units: 25 },
    ]);
  });

  it('folds duplicate parcels and drops the empty ones', () => {
    const a = captain('Sloppy', { cargo: { ore: 40 } });
    captain('Patient');

    const offer = trades.offer(
      a,
      'Patient',
      {
        marks: 0,
        cargo: [
          { commodityId: 'ore', units: 10 },
          { commodityId: 'ore', units: 15 },
          { commodityId: 'ice', units: 0 },
        ],
        designId: '',
      },
      T0,
    );
    expect(offer.cargo).toHaveLength(1);
    expect(offer.cargo[0]?.units).toBe(25);
  });

  it('refuses goods that are not in the hold', () => {
    const a = captain('Empty');
    captain('Hopeful');
    expect(() =>
      trades.offer(a, 'Hopeful', { marks: 0, cargo: [{ commodityId: 'ore', units: 1 }], designId: '' }, T0),
    ).toThrow(OfferRefused);
  });

  it('refuses an offer of nothing at all', () => {
    const a = captain('Nothing');
    captain('Nobody');
    expect(() => trades.offer(a, 'Nobody', { marks: 0, cargo: [], designId: '' }, T0)).toThrow(
      OfferRefused,
    );
  });

  it('refuses to pay marks the offering captain does not have', () => {
    const a = captain('Broke');
    captain('Rich');
    expect(() =>
      trades.offer(a, 'Rich', { marks: -(a.marks + 1), cargo: [], designId: '' }, T0),
    ).toThrow(OfferRefused);
  });

  it('refuses a good the Staple does not trade, and a captain on no Register', () => {
    const a = captain('Chancer', { cargo: { ore: 10 } });
    captain('Straight');
    expect(() =>
      trades.offer(a, 'Straight', { marks: 0, cargo: [{ commodityId: 'moonshine', units: 1 }], designId: '' }, T0),
    ).toThrow(OfferRefused);
    expect(() =>
      trades.offer(a, 'Nobody At All', { marks: 0, cargo: [{ commodityId: 'ore', units: 1 }], designId: '' }, T0),
    ).toThrow(OfferRefused);
  });

  it('refuses a draught that is not on the offering captain’s books', () => {
    const a = captain('Draughtsman');
    const b = captain('Borrower');
    const theirs = yard.saveDesign(b.accountId, { name: 'Not Yours', placements: [] }, T0);
    expect(() =>
      trades.offer(a, 'Borrower', { marks: 0, cargo: [], designId: theirs.id }, T0),
    ).toThrow(OfferRefused);
  });

  it('stops a captain papering a berth with offers', () => {
    const a = captain('Keen', { cargo: { ore: 100 } });
    captain('Besieged');
    for (let index = 0; index < 4; index += 1) {
      trades.offer(a, 'Besieged', { marks: index + 1, cargo: [], designId: '' }, T0 + index);
    }
    expect(() =>
      trades.offer(a, 'Besieged', { marks: 99, cargo: [], designId: '' }, T0 + 9),
    ).toThrow(OfferRefused);
  });
});

describe('taking one up', () => {
  it('moves marks, cargo and the draught in one go', () => {
    const a = captain('Seller', { cargo: { ore: 40 } });
    const b = captain('Buyer');
    const design = yard.saveDesign(a.accountId, { name: 'Prudent Return', placements: [] }, T0);

    const sellerBefore = a.marks;
    const buyerBefore = b.marks;

    const offer = trades.offer(
      a,
      'Buyer',
      { marks: 1_500, cargo: [{ commodityId: 'ore', units: 25 }], designId: design.id },
      T0,
    );
    trades.accept(b, offer.id, a, HOLD, T0 + 1_000);

    expect(a.marks - sellerBefore).toBe(1_500);
    expect(buyerBefore - b.marks).toBe(1_500);
    expect(market.cargoOf(a.accountId).get('ore')).toBe(15);
    expect(market.cargoOf(b.accountId).get('ore')).toBe(25);
    expect(yard.designsOf(b.accountId).map((row) => row.name)).toContain('Prudent Return');
    // A draught is copied, not handed over.
    expect(yard.designsOf(a.accountId).map((row) => row.name)).toContain('Prudent Return');
  });

  it('creates and destroys nothing: invariant 4 across a transfer', () => {
    const a = captain('One', { cargo: { ore: 10 } });
    const b = captain('Two');
    expect(totalMarks()).toBe(netPosted());

    const offer = trades.offer(a, 'Two', { marks: 1_234, cargo: [{ commodityId: 'ore', units: 3 }], designId: '' }, T0);
    trades.accept(b, offer.id, a, HOLD, T0 + 1);

    expect(totalMarks()).toBe(netPosted());
  });

  it('carries a gift and a payment the other way round', () => {
    const a = captain('Benefactor', { cargo: { grain: 20 } });
    const b = captain('Grateful');
    const before = b.marks;

    const offer = trades.offer(
      a,
      'Grateful',
      { marks: -500, cargo: [{ commodityId: 'grain', units: 20 }], designId: '' },
      T0,
    );
    trades.accept(b, offer.id, a, HOLD, T0 + 1);

    expect(b.marks - before).toBe(500);
    expect(market.cargoOf(b.accountId).get('grain')).toBe(20);
  });

  it('refuses once the goods have been sold since', () => {
    const a = captain('Seller', { cargo: { ore: 40 } });
    const b = captain('Buyer');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 40 }], designId: '' }, T0);

    market.adjustCargo(a.accountId, 'ore', -40);
    expect(() => trades.accept(b, offer.id, a, HOLD, T0 + 1)).toThrow(OfferRefused);
  });

  it('refuses when the receiving captain cannot pay', () => {
    const a = captain('Seller', { cargo: { ore: 1 } });
    const b = captain('Buyer');
    const offer = trades.offer(
      a,
      'Buyer',
      { marks: b.marks + 1, cargo: [{ commodityId: 'ore', units: 1 }], designId: '' },
      T0,
    );
    expect(() => trades.accept(b, offer.id, a, HOLD, T0 + 1)).toThrow(OfferRefused);
    // And nothing moved.
    expect(market.cargoOf(a.accountId).get('ore')).toBe(1);
  });

  it('refuses when there is no room aboard', () => {
    const a = captain('Seller', { cargo: { ore: 400 } });
    const b = captain('Buyer');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 400 }], designId: '' }, T0);
    expect(() => trades.accept(b, offer.id, a, 100, T0 + 1)).toThrow(OfferRefused);
  });

  it('refuses when the other captain has left the berth', () => {
    const a = captain('Seller', { cargo: { ore: 10 } });
    const b = captain('Buyer');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 10 }], designId: '' }, T0);

    // Under way: not alongside any more.
    a.landedPortId = undefined;
    expect(() => trades.accept(b, offer.id, a, HOLD, T0 + 1)).toThrow(OfferRefused);
    // And gone from the room entirely.
    expect(() => trades.accept(b, offer.id, undefined, HOLD, T0 + 1)).toThrow(OfferRefused);
  });

  it('refuses when the receiving captain has moved on to another berth', () => {
    const a = captain('Seller', { cargo: { ore: 10 } });
    const b = captain('Buyer');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 10 }], designId: '' }, T0);

    b.landedPortId = 'quorum';
    expect(() => trades.accept(b, offer.id, a, HOLD, T0 + 1)).toThrow(OfferRefused);
  });

  it('cannot be taken twice', () => {
    const a = captain('Seller', { cargo: { ore: 10 } });
    const b = captain('Buyer');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 10 }], designId: '' }, T0);

    trades.accept(b, offer.id, a, HOLD, T0 + 1);
    expect(() => trades.accept(b, offer.id, a, HOLD, T0 + 2)).toThrow(OfferRefused);
  });

  it('cannot be taken by somebody it was not offered to', () => {
    const a = captain('Seller', { cargo: { ore: 10 } });
    captain('Buyer');
    const c = captain('Interloper');
    const offer = trades.offer(a, 'Buyer', { marks: 0, cargo: [{ commodityId: 'ore', units: 10 }], designId: '' }, T0);

    expect(() => trades.accept(c, offer.id, a, HOLD, T0 + 1)).toThrow(OfferRefused);
  });
});

describe('closing', () => {
  it('lets either captain close it, and says which way', () => {
    const a = captain('Offerer', { cargo: { ore: 10 } });
    const b = captain('Receiver');

    const mine = trades.offer(a, 'Receiver', { marks: 1, cargo: [], designId: '' }, T0);
    trades.close(a.accountId, mine.id, T0 + 1);
    expect(stateOf(mine.id)).toBe('withdrawn');

    const theirs = trades.offer(a, 'Receiver', { marks: 2, cargo: [], designId: '' }, T0 + 2);
    trades.close(b.accountId, theirs.id, T0 + 3);
    expect(stateOf(theirs.id)).toBe('declined');
  });

  it('refuses a stranger closing somebody else’s offer', () => {
    const a = captain('Offerer');
    captain('Receiver');
    const c = captain('Stranger');
    const offer = trades.offer(a, 'Receiver', { marks: 1, cargo: [], designId: '' }, T0);
    expect(() => trades.close(c.accountId, offer.id, T0 + 1)).toThrow(OfferRefused);
  });

  it('lapses everything either way when a captain leaves the berth', () => {
    const a = captain('Leaving', { cargo: { ore: 10 } });
    const b = captain('Staying');

    trades.offer(a, 'Staying', { marks: 1, cargo: [], designId: '' }, T0);
    trades.offer(b, 'Leaving', { marks: 2, cargo: [], designId: '' }, T0 + 1);
    expect(trades.openFor(a.accountId)).toHaveLength(2);

    expect(trades.closeAllFor(a.accountId, T0 + 2)).toBe(2);
    expect(trades.openFor(a.accountId)).toHaveLength(0);
    expect(trades.openFor(b.accountId)).toHaveLength(0);
  });

  it('lists what is open either way', () => {
    const a = captain('Busy', { cargo: { ore: 10 } });
    const b = captain('Also Busy');
    trades.offer(a, 'Also Busy', { marks: 1, cargo: [], designId: '' }, T0);
    trades.offer(b, 'Busy', { marks: 2, cargo: [], designId: '' }, T0 + 1);

    expect(trades.openFor(a.accountId).map((row) => row.marks).sort()).toEqual([1, 2]);
  });
});

function stateOf(id: string): string {
  const row = store.db.select().from(schema.trades).all().find((candidate) => candidate.id === id);
  return row?.state ?? '';
}
