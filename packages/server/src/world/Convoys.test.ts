/**
 * Convoys, and what sharing work with one does.
 *
 * The rules worth holding are about who may do what — a convoy is the one
 * place in the game where one captain's action changes another captain's
 * screen — and about the faucet: a shared commission pays once.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { Accounts } from '../accounts.ts';
import { openStore, type Store } from '../db/index.ts';
import { Commissions, CommissionRefused } from './Commissions.ts';
import { CONVOY_LIMIT, ConvoyRefused, Convoys } from './Convoys.ts';
import { Ledger } from './Ledger.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';
import { Standings } from './Standings.ts';

import { content, type PortDef, type SystemDef } from '@marque/shared';

let store: Store;
let accounts: Accounts;
let pilots: PilotStore;
let convoys: Convoys;
let commissions: Commissions;

const T0 = 1_700_000_000_000;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  pilots = new PilotStore(store);
  convoys = new Convoys(store);
  const standings = new Standings(store);
  commissions = new Commissions(store, new Ledger(store), standings);
  commissions.convoys = convoys;
});

function captain(callsign: string): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  const pilot = pilots.load(account.id);
  if (!pilot) throw new Error('no captain');
  return pilot;
}

describe('opening a convoy', () => {
  it('comes into being with its first invitation', () => {
    const a = captain('Marchetti');
    const b = captain('Okonjo');

    expect(convoys.of(a.accountId)).toBeUndefined();
    const convoy = convoys.invite(a.accountId, 'Okonjo', T0);

    expect(convoy.leaderId).toBe(a.accountId);
    expect(convoy.members.map((m) => m.state)).toEqual(['member', 'invited']);
    // The one asked is not in it until they say so.
    expect(convoys.of(b.accountId)).toBeUndefined();
    expect(convoys.invitations(b.accountId)).toHaveLength(1);
    expect(convoys.invitations(b.accountId)[0]?.from).toBe('Marchetti');
  });

  it('reads the leader first, then members, then whoever has not answered', () => {
    const a = captain('Leader');
    const b = captain('Second');
    const c = captain('Third');

    convoys.invite(a.accountId, 'Second', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);
    convoys.invite(a.accountId, 'Third', T0 + 2);

    const view = convoys.of(a.accountId)!;
    expect(view.members.map((m) => m.callsign)).toEqual(['Leader', 'Second', 'Third']);
    expect(view.members.map((m) => m.state)).toEqual(['member', 'member', 'invited']);
    expect(view.members[0]?.isLeader).toBe(true);
    void c;
  });

  it('refuses a callsign nobody answers to, and your own', () => {
    const a = captain('Alone');
    expect(() => convoys.invite(a.accountId, 'Nobody At All', T0)).toThrow(ConvoyRefused);
    expect(() => convoys.invite(a.accountId, 'Alone', T0)).toThrow(ConvoyRefused);
  });

  it('refuses to ask the same captain twice', () => {
    const a = captain('Asker');
    captain('Asked');
    convoys.invite(a.accountId, 'Asked', T0);
    expect(() => convoys.invite(a.accountId, 'Asked', T0 + 1)).toThrow(ConvoyRefused);
  });

  it('refuses a captain who already sails with somebody', () => {
    const a = captain('First');
    const b = captain('Taken');
    const c = captain('Second');

    convoys.invite(a.accountId, 'Taken', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);

    expect(() => convoys.invite(c.accountId, 'Taken', T0 + 2)).toThrow(ConvoyRefused);
  });

  it('lets only the captain who opened it ask anybody', () => {
    const a = captain('Leader');
    const b = captain('Member');
    captain('Outsider');

    convoys.invite(a.accountId, 'Member', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);

    expect(() => convoys.invite(b.accountId, 'Outsider', T0 + 2)).toThrow(ConvoyRefused);
  });

  it('stops at the limit', () => {
    const leader = captain('Leader');
    for (let index = 0; index < CONVOY_LIMIT - 1; index += 1) {
      const name = `Hand ${index}`;
      captain(name);
      convoys.invite(leader.accountId, name, T0);
      const id = convoys.of(leader.accountId)!.id;
      const them = convoys.of(leader.accountId)!.members.find((m) => m.callsign === name)!;
      convoys.accept(them.accountId, id, T0 + index);
    }

    captain('One Too Many');
    expect(() => convoys.invite(leader.accountId, 'One Too Many', T0)).toThrow(ConvoyRefused);
  });
});

describe('answering', () => {
  it('takes one up, and drops every other invitation on the way', () => {
    const a = captain('Asker A');
    const b = captain('Asker B');
    const c = captain('Wanted');

    convoys.invite(a.accountId, 'Wanted', T0);
    convoys.invite(b.accountId, 'Wanted', T0 + 1);
    expect(convoys.invitations(c.accountId)).toHaveLength(2);

    convoys.accept(c.accountId, convoys.of(a.accountId)!.id, T0 + 2);
    expect(convoys.of(c.accountId)?.leaderId).toBe(a.accountId);
    expect(convoys.invitations(c.accountId)).toHaveLength(0);
    // And the other convoy is down to the captain who opened it.
    expect(convoys.of(b.accountId)?.members).toHaveLength(1);
  });

  it('turns one down without joining anything', () => {
    const a = captain('Asker');
    const b = captain('Declines');
    convoys.invite(a.accountId, 'Declines', T0);

    convoys.decline(b.accountId, convoys.of(a.accountId)!.id);
    expect(convoys.of(b.accountId)).toBeUndefined();
    expect(convoys.invitations(b.accountId)).toHaveLength(0);
    expect(() => convoys.decline(b.accountId, convoys.of(a.accountId)!.id)).toThrow(
      ConvoyRefused,
    );
  });

  it('refuses an invitation that was never made', () => {
    const a = captain('Asker');
    const b = captain('Stranger');
    const c = captain('Asked');

    // A real convoy, with somebody else in it: a stranger may not walk into
    // one just because it exists.
    convoys.invite(a.accountId, 'Asked', T0);
    const real = convoys.of(a.accountId)!.id;
    void c;

    expect(() => convoys.accept(b.accountId, real, T0 + 1)).toThrow(ConvoyRefused);
    expect(() => convoys.accept(b.accountId, 'not-a-convoy', T0 + 1)).toThrow(ConvoyRefused);
  });
});

describe('leaving', () => {
  it('lets a member go without touching the rest', () => {
    const a = captain('Leader');
    const b = captain('Goes');
    const c = captain('Stays');

    convoys.invite(a.accountId, 'Goes', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);
    convoys.invite(a.accountId, 'Stays', T0 + 2);
    convoys.accept(c.accountId, convoys.of(a.accountId)!.id, T0 + 3);

    const left = convoys.leave(b.accountId);
    expect(left.disbanded).toBe(false);
    expect(left.fleetId).toBe(convoys.of(c.accountId)?.id);
    expect(convoys.of(b.accountId)).toBeUndefined();
    expect(convoys.of(c.accountId)?.members).toHaveLength(2);
  });

  it('dissolves it when the one who opened it goes', () => {
    const a = captain('Leader');
    const b = captain('Member');
    convoys.invite(a.accountId, 'Member', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);

    expect(convoys.leave(a.accountId).disbanded).toBe(true);
    expect(convoys.of(a.accountId)).toBeUndefined();
    expect(convoys.of(b.accountId)).toBeUndefined();
  });

  it('lets the leader put somebody out, and nobody else', () => {
    const a = captain('Leader');
    const b = captain('Member');
    const c = captain('Other');

    convoys.invite(a.accountId, 'Member', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);
    convoys.invite(a.accountId, 'Other', T0 + 2);
    convoys.accept(c.accountId, convoys.of(a.accountId)!.id, T0 + 3);

    expect(() => convoys.remove(b.accountId, c.accountId)).toThrow(ConvoyRefused);
    convoys.remove(a.accountId, b.accountId);
    expect(convoys.of(b.accountId)).toBeUndefined();
  });

  it('refuses to let a captain who sails alone leave anything', () => {
    const a = captain('Alone');
    expect(() => convoys.leave(a.accountId)).toThrow(ConvoyRefused);
  });
});

describe('work on the convoy’s books', () => {
  /** A berth that is posting something to this captain. */
  function anyOffer(pilot: Pilot): { id: string; port: PortDef; system: SystemDef } {
    for (const system of content().systems.values()) {
      for (const port of system.ports) {
        const [offer] = commissions.board(pilot, port, system, T0);
        if (offer) return { id: offer.id, port, system };
      }
    }
    throw new Error('no berth posts anything');
  }

  function pair(): { a: Pilot; b: Pilot } {
    const a = captain('Holder');
    const b = captain('Flier');
    convoys.invite(a.accountId, 'Flier', T0);
    convoys.accept(b.accountId, convoys.of(a.accountId)!.id, T0 + 1);
    return { a, b };
  }

  it('puts one on the books and takes it off again', () => {
    const { a, b } = pair();
    const found = anyOffer(a);
    const held = commissions.take(a, found.id, found.port, found.system, T0);

    expect(commissions.workingOn(b.accountId)).toHaveLength(0);
    commissions.share(a.accountId, held.id, true);
    expect(commissions.workingOn(b.accountId).map((row) => row.id)).toEqual([held.id]);

    commissions.share(a.accountId, held.id, false);
    expect(commissions.workingOn(b.accountId)).toHaveLength(0);
  });

  it('refuses to share for a captain who sails alone', () => {
    const a = captain('Alone');
    const found = anyOffer(a);
    const held = commissions.take(a, found.id, found.port, found.system, T0);
    expect(() => commissions.share(a.accountId, held.id, true)).toThrow(CommissionRefused);
  });

  it('pays once, to whoever discharges it', () => {
    const { a, b } = pair();
    const found = anyOffer(a);
    const held = commissions.take(a, found.id, found.port, found.system, T0);
    commissions.share(a.accountId, held.id, true);

    const holderBefore = a.marks;
    const flierBefore = b.marks;

    // The other captain flies it in.
    const theirs = commissions.workingOn(b.accountId).find((row) => row.id === held.id)!;
    const paid = commissions.settle(b, theirs, T0 + 60_000);

    expect(b.marks - flierBefore).toBe(paid.pay);
    expect(a.marks).toBe(holderBefore);
    // And it is gone from both lists: one commission, discharged once.
    expect(commissions.workingOn(a.accountId)).toHaveLength(0);
    expect(commissions.workingOn(b.accountId)).toHaveLength(0);
  });

  it('comes off the books when the convoy dissolves', () => {
    const { a, b } = pair();
    const found = anyOffer(a);
    const held = commissions.take(a, found.id, found.port, found.system, T0);
    commissions.share(a.accountId, held.id, true);

    convoys.leave(a.accountId);
    expect(commissions.workingOn(b.accountId)).toHaveLength(0);
    // The captain who took it on still has it. It was never anybody else's.
    expect(commissions.held(a.accountId).map((row) => row.id)).toEqual([held.id]);
    expect(commissions.held(a.accountId)[0]?.sharedFleetId).toBe('');
  });
});
