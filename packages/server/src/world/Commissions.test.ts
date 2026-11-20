/**
 * The Factor's board, exercised against every piece of content it can post.
 *
 * Milestone 7 asks that every commission template completes end to end. The
 * protocol harness proves one of each *kind* goes through the real room; this
 * proves the *content* — all nineteen templates and all three chains, every
 * beat, both endings — by driving the service against a real database. It is
 * the fast half of that pair, and it is the half that catches a template
 * nobody can be offered, a chain beat that leads nowhere, and a figure that
 * reads wrong once a captain actually gets paid it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CHARTERS, content, type Charter, type PortDef, type SystemDef } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { openStore, type Store } from '../db/index.ts';
import { Ledger } from './Ledger.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';
import { Standings } from './Standings.ts';
import { CommissionRefused, Commissions } from './Commissions.ts';

let store: Store;
let accounts: Accounts;
let ledger: Ledger;
let standings: Standings;
let pilots: PilotStore;
let commissions: Commissions;

/** A fixed point in world time, so a board window is the same every run. */
const T0 = 1_700_000_000_000;
/** One board window, from `BOARD_HOURS`. */
const WINDOW = 6 * 3_600_000;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
  standings = new Standings(store);
  pilots = new PilotStore(store);
  commissions = new Commissions(store, ledger, standings);
});

/**
 * A captain, thought of by one charter as much as `regard` says.
 *
 * The default is enough to be offered anything that charter posts and still
 * leave headroom under the ceiling, because a chain pays standing at every
 * beat and a captain seeded near the top is pinned there before the end —
 * which makes an ending's standing look like it does nothing.
 */
function captain(callsign: string, favoured?: Charter, regard = 320): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  if (favoured) standings.shift(account.id, favoured, regard, T0);
  const pilot = pilots.load(account.id);
  if (!pilot) throw new Error('the account has no captain');
  return pilot;
}

/** Every berth in the galaxy, with the system it belongs to. */
function berths(): { port: PortDef; system: SystemDef }[] {
  const out: { port: PortDef; system: SystemDef }[] = [];
  for (const system of content().systems.values()) {
    for (const port of system.ports) out.push({ port, system });
  }
  return out;
}

describe('every template can be offered', () => {
  it('posts all nineteen somewhere, to somebody, within a day of windows', () => {
    // Three captains, because a template gated behind one charter's regard is
    // not posted to a captain that charter does not trust — and standing is
    // zero-sum, so no one captain can be trusted by all three.
    const crew = CHARTERS.map((charter) => captain(`Sweep${charter}`, charter, 900));
    const seen = new Set<string>();

    for (const { port, system } of berths()) {
      for (let window = 0; window < 4; window += 1) {
        const now = T0 + window * WINDOW;
        for (const pilot of crew) {
          for (const offer of commissions.board(pilot, port, system, now)) {
            if (!offer.id.startsWith('chain:')) seen.add(offer.templateId);
          }
        }
      }
    }

    const all = content().commissions.templates.map((template) => template.id);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it('posts nothing a berth has no business posting', () => {
    const pilot = captain('Narrow', 'kessler');
    const templates = new Map(content().commissions.templates.map((t) => [t.id, t]));

    for (const { port, system } of berths()) {
      for (const offer of commissions.board(pilot, port, system, T0)) {
        if (offer.id.startsWith('chain:')) continue;
        const template = templates.get(offer.templateId);
        expect(template).toBeDefined();
        if (template?.charter !== undefined) {
          expect(template.charter).toBe(port.owner);
        }
      }
    }
  });
});

describe('every template completes end to end', () => {
  it('takes each one, answers it, and is paid the posted figure', () => {
    const crew = CHARTERS.map((charter) => captain(`Runner${charter}`, charter, 900));
    const done = new Set<string>();
    let settled = 0;

    for (const { port, system } of berths()) {
      for (let window = 0; window < 4; window += 1) {
        const now = T0 + window * WINDOW;
        for (const pilot of crew) {
          for (const offer of commissions.board(pilot, port, system, now)) {
            if (offer.id.startsWith('chain:') || done.has(offer.templateId)) continue;

            const before = pilot.marks;
            const held = commissions.take(pilot, offer.id, port, system, now);
            expect(held.state).toBe('taken');
            expect(commissions.held(pilot.accountId).map((row) => row.id)).toContain(held.id);

            const answer = commissions.settle(pilot, held, now + 60_000);
            // Paid exactly what was posted, in whole marks.
            expect(answer.pay).toBe(Math.round(offer.pay));
            expect(Number.isInteger(pilot.marks)).toBe(true);
            expect(pilot.marks - before).toBe(answer.pay);
            // And the Factor said something that is not a placeholder.
            expect(answer.text.length).toBeGreaterThan(8);
            expect(answer.text).not.toMatch(/\{[a-z]+\}/);

            expect(commissions.held(pilot.accountId).map((row) => row.id)).not.toContain(held.id);
            done.add(offer.templateId);
            settled += 1;
          }
        }
      }
    }

    expect(settled).toBe(content().commissions.templates.length);
    expect(done.size).toBe(content().commissions.templates.length);
  });

  it('reconciles every mark it paid against the ledger', () => {
    const pilot = captain('Books', 'thirty');
    const opening = pilot.marks;
    let paid = 0;

    for (const { port, system } of berths()) {
      for (const offer of commissions.board(pilot, port, system, T0)) {
        if (offer.id.startsWith('chain:')) continue;
        const held = commissions.take(pilot, offer.id, port, system, T0);
        paid += commissions.settle(pilot, held, T0 + 1_000).pay;
      }
    }

    expect(paid).toBeGreaterThan(0);
    expect(pilot.marks).toBe(opening + paid);
    expect(ledger.balanceOf(pilot.accountId)).toBe(pilot.marks);
  });
});

describe('a Factor has limits', () => {
  /** The first berth that posts anything to this captain. */
  function anyBoard(pilot: Pilot): { port: PortDef; system: SystemDef } {
    for (const berth of berths()) {
      if (commissions.board(pilot, berth.port, berth.system, T0).length > 0) return berth;
    }
    throw new Error('no berth posts anything');
  }

  it('refuses an id that was never posted', () => {
    const pilot = captain('Chancer', 'kessler');
    const { port, system } = anyBoard(pilot);
    expect(() => commissions.take(pilot, 'not-a-commission', port, system, T0)).toThrow(
      CommissionRefused,
    );
  });

  it('refuses the same template twice at once', () => {
    const pilot = captain('Double', 'kessler');
    const { port, system } = anyBoard(pilot);
    const [offer] = commissions.board(pilot, port, system, T0);
    if (!offer) throw new Error('nothing posted');

    commissions.take(pilot, offer.id, port, system, T0);
    expect(() => commissions.take(pilot, offer.id, port, system, T0)).toThrow(CommissionRefused);
  });

  it('stops giving out work past what a captain can carry', () => {
    const pilot = captain('Greedy', 'kessler');
    let taken = 0;
    let refused = false;

    for (const { port, system } of berths()) {
      for (const offer of commissions.board(pilot, port, system, T0)) {
        try {
          commissions.take(pilot, offer.id, port, system, T0);
          taken += 1;
        } catch (error) {
          if (!(error instanceof CommissionRefused)) throw error;
          if (error.reason === 'too-many-commissions') refused = true;
        }
      }
    }

    expect(refused).toBe(true);
    expect(commissions.held(pilot.accountId)).toHaveLength(taken);
  });

  it('counts a commission as late only once its hours have run out', () => {
    const pilot = captain('Late', 'kessler');
    const { port, system } = anyBoard(pilot);
    const timed = commissions
      .board(pilot, port, system, T0)
      .find((offer) => offer.hours > 0 && offer.kind !== 'escort');
    if (!timed) throw new Error('nothing posted with a deadline');

    const held = commissions.take(pilot, timed.id, port, system, T0);
    expect(commissions.overdue(pilot.accountId, held.dueAt - 1)).toHaveLength(0);
    expect(commissions.overdue(pilot.accountId, held.dueAt + 1)).toHaveLength(1);
  });

  it('costs standing to give up a charter’s own work', () => {
    const pilot = captain('Quitter', 'kessler');

    // A berth of Kessler's that is posting Kessler's work, not the first
    // berth that is posting anything: the neutral ones cost no standing.
    let found: { offer: { id: string }; port: PortDef; system: SystemDef } | undefined;
    for (const berth of berths()) {
      if (berth.port.owner !== 'kessler') continue;
      const offer = commissions
        .board(pilot, berth.port, berth.system, T0)
        .find((row) => row.charter === 'kessler' && !row.id.startsWith('chain:'));
      if (offer) {
        found = { offer, port: berth.port, system: berth.system };
        break;
      }
    }
    if (!found) throw new Error('no Kessler berth is posting Kessler work');

    const before = standings.of(pilot.accountId).kessler;
    const held = commissions.take(pilot, found.offer.id, found.port, found.system, T0);
    commissions.abandon(pilot, held.id, T0 + 1_000);
    const after = standings.of(pilot.accountId).kessler;

    expect(after).toBeLessThan(before);
    expect(commissions.held(pilot.accountId)).toHaveLength(0);
  });
});

describe('the three chains run to their endings', () => {
  /** A berth belonging to this charter, for the chain to be posted at. */
  function seatOf(charter: Charter): { port: PortDef; system: SystemDef } {
    for (const berth of berths()) {
      if (berth.port.owner === charter && berth.port.seat === true) return berth;
    }
    throw new Error(`${charter} has no seat`);
  }

  /** Run every beat of a chain, in order, and return what was paid for them. */
  function runBeats(pilot: Pilot, charter: Charter): { beats: number; pay: number } {
    const { port, system } = seatOf(charter);
    let beats = 0;
    let pay = 0;

    // Bounded well above the longest chain, so a chain that never advances
    // fails the count rather than hanging the suite.
    for (let guard = 0; guard < 40; guard += 1) {
      const now = T0 + guard * WINDOW;
      const beat = commissions
        .board(pilot, port, system, now)
        .find((offer) => offer.id.startsWith('chain:'));
      if (!beat) break;

      // The beats arrive in order, numbered from nothing.
      expect(beat.id).toBe(`chain:${beat.templateId}:${beats}`);
      const held = commissions.take(pilot, beat.id, port, system, now);
      pay += commissions.settle(pilot, held, now + 60_000).pay;
      beats += 1;
    }

    return { beats, pay };
  }

  for (const chain of content().commissions.chains) {
    describe(chain.name, () => {
      it('posts every beat in order, once each, and pays for them', () => {
        const pilot = captain(`Beat${chain.id}`, chain.charter);
        const { beats, pay } = runBeats(pilot, chain.charter);

        expect(beats).toBe(chain.steps.length);
        expect(pay).toBe(chain.steps.reduce((sum, step) => sum + Math.round(step.basePay), 0));
        // And then nothing: a chain does not loop.
        expect(commissions.chainProgress(pilot.accountId, chain)).toEqual({
          done: chain.steps.length,
          total: chain.steps.length,
        });
      });

      it('waits on its choice, and only at the house’s own seat', () => {
        const pilot = captain(`Wait${chain.id}`, chain.charter);
        expect(commissions.pendingEnding(pilot.accountId)).toBeUndefined();

        runBeats(pilot, chain.charter);
        const waiting = commissions.pendingEnding(pilot.accountId);
        expect(waiting?.id).toBe(chain.id);
        expect(waiting?.endings).toHaveLength(2);
      });

      for (const ending of chain.endings) {
        it(`ends on “${ending.choice}”`, () => {
          const pilot = captain(`End${ending.id}`, chain.charter);
          runBeats(pilot, chain.charter);

          const before = {
            marks: pilot.marks,
            standing: standings.of(pilot.accountId)[chain.charter],
            rivals: { ...standings.of(pilot.accountId) },
          };
          const settled = commissions.chooseEnding(pilot, chain.id, ending.id, T0 + 40 * WINDOW);

          expect(settled.pay).toBe(ending.pay);
          expect(pilot.marks - before.marks).toBe(ending.pay);
          expect(ledger.balanceOf(pilot.accountId)).toBe(pilot.marks);

          // Prose, not a placeholder, and a line the Gazette can print.
          expect(settled.text.length).toBeGreaterThan(40);
          expect(settled.headline.length).toBeGreaterThan(20);
          expect(settled.text).not.toMatch(/\{[a-z]+\}/);

          // The house's regard moves the way the ending says it does, and the
          // other two move against it: one rule moves standing, and it is
          // zero-sum across the three.
          const after = standings.of(pilot.accountId);
          if (ending.standing > 0) {
            expect(after[chain.charter]).toBeGreaterThan(before.standing);
          } else {
            expect(after[chain.charter]).toBeLessThan(before.standing);
          }
          for (const rival of CHARTERS) {
            if (rival === chain.charter) continue;
            if (ending.standing > 0) {
              expect(after[rival]).toBeLessThan(before.rivals[rival]);
            } else {
              expect(after[rival]).toBeGreaterThan(before.rivals[rival]);
            }
          }

          // Once, and never the other way afterwards.
          expect(commissions.pendingEnding(pilot.accountId)).toBeUndefined();
          const other = chain.endings.find((candidate) => candidate.id !== ending.id);
          if (!other) throw new Error('a chain needs two endings');
          expect(() =>
            commissions.chooseEnding(pilot, chain.id, other.id, T0 + 41 * WINDOW),
          ).toThrow(CommissionRefused);
          expect(() => commissions.chooseEnding(pilot, chain.id, ending.id, T0 + 41 * WINDOW)).toThrow(
            CommissionRefused,
          );
        });
      }
    });
  }

  it('refuses an ending to a captain who has not run the chain', () => {
    const [chain] = content().commissions.chains;
    if (!chain) throw new Error('no chains');
    const pilot = captain('Shortcut', chain.charter);
    const [ending] = chain.endings;
    if (!ending) throw new Error('no endings');

    expect(() => commissions.chooseEnding(pilot, chain.id, ending.id, T0)).toThrow(
      CommissionRefused,
    );
  });

  it('refuses a chain to a captain the house does not trust', () => {
    const [chain] = content().commissions.chains;
    if (!chain) throw new Error('no chains');
    // Favoured by a rival, which under a zero-sum register means distrusted here.
    const rival = CHARTERS.find((charter) => charter !== chain.charter);
    if (!rival) throw new Error('no rival');
    const pilot = captain('Stranger', rival);

    const { port, system } = seatOf(chain.charter);
    const beats = commissions
      .board(pilot, port, system, T0)
      .filter((offer) => offer.id.startsWith('chain:'));
    expect(beats).toHaveLength(0);
  });
});
