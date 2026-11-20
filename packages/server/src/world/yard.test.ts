import { beforeEach, describe, expect, it } from 'vitest';

import { buildCost, content, type Placement } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { openStore, type Store } from '../db/index.ts';
import { Ledger } from './Ledger.ts';
import { Market } from './Market.ts';
import { PilotStore, type Pilot } from './PilotStore.ts';
import { Yard, YardRefused } from './Yard.ts';

let store: Store;
let accounts: Accounts;
let ledger: Ledger;
let market: Market;
let yard: Yard;
let pilots: PilotStore;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
  ledger = new Ledger(store);
  market = new Market(store, ledger);
  yard = new Yard(store, ledger, market);
  pilots = new PilotStore(store);
});

const { blueprints, modules, systems, tuning } = content();

/** A berth with a Staple, which is where a yard can buy what it needs. */
const BERTH = { portId: 'ballast', systemId: 'ostrand' };

function captain(callsign: string, marks = 5_000_000): Pilot {
  const account = accounts.signUp({ callsign, inviteCode: '' }).account;
  const pilot = pilots.load(account.id)!;
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

const starter = (): Placement[] => [...blueprints.get('prudent-return')!.placements];

function totalMarks(): number {
  const row = store.raw.prepare('SELECT COALESCE(SUM(marks), 0) AS t FROM pilots').get() as {
    t: number;
  };
  return row.t;
}

function netPosted(): number {
  const row = store.raw.prepare('SELECT COALESCE(SUM(delta), 0) AS t FROM ledger').get() as {
    t: number;
  };
  return row.t;
}

describe('the Yard', () => {
  it('builds a hull and charges for it', () => {
    const pilot = captain('Shipwright');
    const before = pilot.marks;

    const receipt = yard.build({
      pilot,
      ...BERTH,
      name: 'Second Thoughts',
      placements: starter(),
      now: 1,
    });

    const quoted = buildCost(starter(), modules, tuning);
    expect(receipt.marks).toBe(quoted.marks);
    expect(receipt.premium).toBe(quoted.premium);
    expect(receipt.marksAfter).toBe(before - quoted.marks - receipt.materialsCost);

    const owned = yard.shipsOf(pilot.accountId);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.name).toBe('Second Thoughts');
    expect(owned[0]!.portId).toBe('ballast');
  });

  it('buys what the hold cannot cover, from the berth it is built at', () => {
    const pilot = captain('Buyer');
    const receipt = yard.build({
      pilot,
      ...BERTH,
      name: 'Bought In',
      placements: starter(),
      now: 1,
    });

    expect(Object.keys(receipt.bought).length).toBeGreaterThan(0);
    expect(receipt.materialsCost).toBeGreaterThan(0);

    // And the berth is that much lighter.
    const alloy = content().commodities.get('alloy')!;
    const port = systems.get('ostrand')!.ports.find((p) => p.id === 'ballast')!;
    expect(market.pileOf(port, alloy).stock).toBeLessThan(market.pileOf(port, alloy).target);
  });

  it('takes materials from the hold before buying any', () => {
    const pilot = captain('Stocked');
    market.adjustCargo(pilot.accountId, 'alloy', 500);

    const receipt = yard.build({
      pilot,
      ...BERTH,
      name: 'Own Parts',
      placements: starter(),
      now: 1,
    });

    expect(receipt.fromHold.alloy).toBeGreaterThan(0);
    expect(receipt.bought.alloy ?? 0).toBe(0);
    // And the hold is lighter by exactly what was used.
    expect(market.cargoOf(pilot.accountId).get('alloy')).toBe(500 - receipt.fromHold.alloy!);
  });

  it('refuses a design that does not pass survey, and says why', () => {
    const pilot = captain('Hopeful');

    // Two bridges and nothing else: several rules at once.
    const bad: Placement[] = [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'hrc-bridge-1', x: 4, y: 0, rotation: 0 },
    ];

    let refused: YardRefused | undefined;
    try {
      yard.build({ pilot, ...BERTH, name: 'Two Bridges', placements: bad, now: 1 });
    } catch (error) {
      refused = error as YardRefused;
    }

    expect(refused?.reason).toBe('invalid-design');
    expect(refused?.problems.length).toBeGreaterThan(0);
    expect(refused?.problems.map((p) => p.code)).toContain('many-bridges');
    expect(yard.shipsOf(pilot.accountId)).toHaveLength(0);
  });

  it('a refused build changes nothing: no marks, no materials, no hull', () => {
    const pilot = captain('Broke', 100);
    market.adjustCargo(pilot.accountId, 'alloy', 40);

    const marksBefore = pilot.marks;
    const holdBefore = market.cargoOf(pilot.accountId).get('alloy');
    const postedBefore = netPosted();

    expect(() =>
      yard.build({ pilot, ...BERTH, name: 'Beyond Means', placements: starter(), now: 1 }),
    ).toThrow(YardRefused);

    expect(pilot.marks).toBe(marksBefore);
    expect(market.cargoOf(pilot.accountId).get('alloy')).toBe(holdBefore);
    expect(yard.shipsOf(pilot.accountId)).toHaveLength(0);
    expect(netPosted()).toBe(postedBefore);
    expect(totalMarks()).toBe(netPosted());
  });

  it('invariant 4: every mark a build moves passes through the ledger', () => {
    const a = captain('Yard One');
    const b = captain('Yard Two');

    for (const pilot of [a, b, a]) {
      yard.build({ pilot, ...BERTH, name: 'Hull', placements: starter(), now: 1 });
    }

    expect(totalMarks()).toBe(netPosted());
  });

  it('charges a refit for what it adds and refunds what it strips', () => {
    const pilot = captain('Refitter');
    const built = yard.build({
      pilot,
      ...BERTH,
      name: 'Work In Progress',
      placements: starter(),
      now: 1,
    });

    const bay = modules.get('hrc-cargo-1')!;
    const bigger = [...starter(), { moduleId: bay.id, x: 2, y: 4, rotation: 0 as const }];

    const marksBefore = pilot.marks;
    const refit = yard.build({
      pilot,
      ...BERTH,
      name: 'Work In Progress',
      placements: bigger,
      refitting: built.shipId,
      now: 2,
    });

    expect(refit.shipId).toBe(built.shipId);
    expect(refit.marks).toBe(bay.cost + Math.ceil(bay.cost * tuning.yard.insurancePremium));
    expect(pilot.marks).toBe(marksBefore - refit.marks - refit.materialsCost);

    // Still one hull, now with the extra bay.
    const owned = yard.shipsOf(pilot.accountId);
    expect(owned).toHaveLength(1);
    expect(owned[0]!.placements).toHaveLength(starter().length + 1);
  });

  it('refuses to refit a hull somebody else owns', () => {
    const mine = captain('Owner');
    const theirs = captain('Stranger');
    const built = yard.build({
      pilot: mine,
      ...BERTH,
      name: 'Mine',
      placements: starter(),
      now: 1,
    });

    expect(() =>
      yard.build({
        pilot: theirs,
        ...BERTH,
        name: 'Mine',
        placements: starter(),
        refitting: built.shipId,
        now: 2,
      }),
    ).toThrow(YardRefused);
  });

  it('keeps designs per captain and refuses one that is not theirs', () => {
    const mine = captain('Draughtsman');
    const theirs = captain('Nosy');

    const saved = yard.saveDesign(
      mine.accountId,
      { name: 'Fair Return', placements: starter() },
      1,
    );

    expect(yard.designsOf(mine.accountId)).toHaveLength(1);
    expect(yard.designsOf(theirs.accountId)).toHaveLength(0);
    expect(() => yard.deleteDesign(theirs.accountId, saved.id)).toThrow(YardRefused);

    yard.deleteDesign(mine.accountId, saved.id);
    expect(yard.designsOf(mine.accountId)).toHaveLength(0);
  });

  it('replaces a design in place rather than making another', () => {
    const pilot = captain('Reviser');
    const first = yard.saveDesign(
      pilot.accountId,
      { name: 'Mark One', placements: starter() },
      1,
    );
    const second = yard.saveDesign(
      pilot.accountId,
      { id: first.id, name: 'Mark Two', placements: starter() },
      2,
    );

    expect(second.id).toBe(first.id);
    const kept = yard.designsOf(pilot.accountId);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toBe('Mark Two');
  });
});
