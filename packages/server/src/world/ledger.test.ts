import { beforeEach, describe, expect, it } from 'vitest';

import { Accounts } from '../accounts.ts';
import { openStore, schema, type Store } from '../db/index.ts';
import { InsufficientMarks, Ledger } from './Ledger.ts';
import { PilotStore } from './PilotStore.ts';

/**
 * Spec invariant 4: every mark created or destroyed passes through the ledger
 * with a category, and the change in total marks always equals faucets minus
 * sinks. These tests are the automated form of it.
 */

let store: Store;
let accounts: Accounts;
let ledger: Ledger;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
});

/** Total marks held by every captain. */
function totalMarks(): number {
  const rows = store.raw.prepare('SELECT SUM(marks) AS total FROM pilots').get() as {
    total: number | null;
  };
  return rows.total ?? 0;
}

/** Faucets minus sinks, straight from the ledger. */
function netPosted(): number {
  const rows = store.raw.prepare('SELECT SUM(delta) AS total FROM ledger').get() as {
    total: number | null;
  };
  return rows.total ?? 0;
}

describe('invariant 4: marks reconcile with the ledger', () => {
  it('holds for a captain who has only just opened an account', () => {
    accounts.signUp({ callsign: 'Mehta', inviteCode: '' });
    expect(totalMarks()).toBe(netPosted());
  });

  it('holds across a long run of faucets and sinks', () => {
    const a = accounts.signUp({ callsign: 'Leung', inviteCode: '' }).account;
    const b = accounts.signUp({ callsign: 'Bello', inviteCode: '' }).account;

    const postings = [
      { accountId: a.id, delta: -60, category: 'landing-fee' as const, reason: 'Landing fee' },
      { accountId: a.id, delta: -240, category: 'propellant' as const, reason: 'Propellant' },
      { accountId: b.id, delta: 900, category: 'bounty' as const, reason: 'Bounty' },
      { accountId: b.id, delta: -140, category: 'repair' as const, reason: 'Repairs' },
      { accountId: a.id, delta: 1500, category: 'cargo-sale' as const, reason: 'Sold Leaf' },
      { accountId: a.id, delta: -1200, category: 'cargo-purchase' as const, reason: 'Bought Ore' },
      { accountId: b.id, delta: -30, category: 'trade-fee' as const, reason: 'Fee' },
    ];

    for (const posting of postings) ledger.post(posting);

    expect(totalMarks()).toBe(netPosted());
  });

  it('writes the row and the balance together, or neither', () => {
    const captain = accounts.signUp({ callsign: 'Okonjo', inviteCode: '' }).account;
    const before = ledger.balanceOf(captain.id);

    // More than they have: the whole posting must be refused.
    expect(() =>
      ledger.post({
        accountId: captain.id,
        delta: -(before + 1),
        category: 'hull-purchase',
        reason: 'A hull they cannot afford',
      }),
    ).toThrow(InsufficientMarks);

    expect(ledger.balanceOf(captain.id)).toBe(before);
    expect(totalMarks()).toBe(netPosted());

    const rows = store.db.select().from(schema.ledger).all();
    expect(rows.some((row) => row.category === 'hull-purchase')).toBe(false);
  });

  it('never lets a balance go negative', () => {
    const captain = accounts.signUp({ callsign: 'Sato', inviteCode: '' }).account;
    const balance = ledger.balanceOf(captain.id);

    // Spend it all, which is allowed.
    ledger.post({
      accountId: captain.id,
      delta: -balance,
      category: 'hull-purchase',
      reason: 'Everything',
    });
    expect(ledger.balanceOf(captain.id)).toBe(0);

    // One more mark is not.
    expect(() =>
      ledger.post({ accountId: captain.id, delta: -1, category: 'repair', reason: 'One too many' }),
    ).toThrow(InsufficientMarks);
    expect(ledger.balanceOf(captain.id)).toBe(0);
  });

  it('records the balance after each row, so the history reconciles', () => {
    const captain = accounts.signUp({ callsign: 'Whitlock', inviteCode: '' }).account;
    ledger.post({ accountId: captain.id, delta: -100, category: 'repair', reason: 'Repairs' });
    ledger.post({ accountId: captain.id, delta: 250, category: 'bounty', reason: 'Bounty' });

    const rows = ledger.history(captain.id).reverse();
    let running = 0;
    for (const row of rows) {
      running += row.delta;
      expect(row.balance).toBe(running);
    }
    expect(running).toBe(ledger.balanceOf(captain.id));
  });

  it('rounds against fractions rather than storing them', () => {
    const captain = accounts.signUp({ callsign: 'Tolliver', inviteCode: '' }).account;
    const before = ledger.balanceOf(captain.id);
    ledger.post({ accountId: captain.id, delta: -10.9, category: 'repair', reason: 'Repairs' });
    // Truncated toward zero: the captain is never charged a fraction.
    expect(ledger.balanceOf(captain.id)).toBe(before - 10);
    expect(Number.isInteger(ledger.balanceOf(captain.id))).toBe(true);
  });

  it('groups totals by category for the admin page', () => {
    const captain = accounts.signUp({ callsign: 'Adeyemi', inviteCode: '' }).account;
    ledger.post({ accountId: captain.id, delta: -60, category: 'landing-fee', reason: 'Fee' });
    ledger.post({ accountId: captain.id, delta: -60, category: 'landing-fee', reason: 'Fee' });

    const fees = ledger.totals().find((row) => row.category === 'landing-fee');
    expect(fees?.total).toBe(-120);
    expect(fees?.count).toBe(2);
  });
});

describe('a captain who is loaded while somebody else moves their marks', () => {
  it('keeps the loaded copy in step, so a flush cannot erase a dividend', () => {
    const pilots = new PilotStore(store);
    ledger.pilots = pilots;

    const account = accounts.signUp({ callsign: 'Shareholder', inviteCode: '' }).account;
    const pilot = pilots.load(account.id)!;
    const before = pilot.marks;

    // Posted the way the market tick posts a dividend: for an account, with
    // no captain in hand, because most of the holders are offline.
    ledger.post({
      accountId: account.id,
      delta: 500,
      category: 'dividend',
      reason: 'Test dividend',
    });

    expect(pilot.marks).toBe(before + 500);

    // And a flush of the loaded captain — which happens on every landing —
    // does not write the old figure back over it.
    pilots.touch(account.id);
    pilots.flush();
    expect(ledger.balanceOf(account.id)).toBe(before + 500);
    expect(totalMarks()).toBe(netPosted());
  });

  it('and does not pull an offline captain into memory to do it', () => {
    const pilots = new PilotStore(store);
    ledger.pilots = pilots;

    const account = accounts.signUp({ callsign: 'Absent', inviteCode: '' }).account;
    const before = ledger.balanceOf(account.id);
    ledger.post({
      accountId: account.id,
      delta: 500,
      category: 'dividend',
      reason: 'Test dividend',
    });

    expect(pilots.online).toBe(0);
    expect(ledger.balanceOf(account.id)).toBe(before + 500);
  });
});
