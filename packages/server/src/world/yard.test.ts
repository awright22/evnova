import { beforeEach, describe, expect, it } from 'vitest';

import { buildCost, content, encodeShareCode, type Placement } from '@marque/shared';

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

/**
 * The Bourse at Parity: a Staple to buy materials from and a Yard that stocks
 * tier 2 from all three makers. Ballast at Ostrand keeps no Yard at all.
 */
const BERTH = { portId: 'the-bourse', systemId: 'parity' };
const NO_YARD = { portId: 'ballast', systemId: 'ostrand' };
/** Careenage: Slipway Thirty's own yard, tier 3 engines and tier 1 everything else. */
const SLIPWAY = { portId: 'careenage', systemId: 'adeyemi' };

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
    expect(owned[0]!.portId).toBe('the-bourse');
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

    // And the berth the build happened at is that much lighter.
    const alloy = content().commodities.get('alloy')!;
    const port = systems
      .get(BERTH.systemId)!
      .ports.find((candidate) => candidate.id === BERTH.portId)!;
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

describe('what a berth stocks', () => {
  it('refuses a build at a berth that keeps no Yard', () => {
    const pilot = captain('Nowhere');
    try {
      yard.build({ pilot, ...NO_YARD, name: 'Hopeful', placements: starter(), now: 1 });
      expect.unreachable('a berth with no Yard built a hull');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('no-yard');
    }
  });

  /**
   * The starter with some of its 1x1 hull sections swapped for tier-3 plate.
   *
   * Same footprint in the same cells, so the design stays geometrically
   * valid and the only thing wrong with it is where it is being built. A
   * design that failed survey would be refused for that first and never
   * reach the stock gate.
   */
  function withPlate(count: number): Placement[] {
    const design = starter();
    let swapped = 0;
    for (let i = 0; i < design.length && swapped < count; i++) {
      if (design[i]!.moduleId !== 'hrc-hull-1') continue;
      design[i] = { ...design[i]!, moduleId: 'slp-armour-4' };
      swapped++;
    }
    expect(swapped).toBe(count);
    return design;
  }

  it('refuses a fitting the berth does not stock, and names it', () => {
    const pilot = captain('Overreaching');
    // Tier-3 Slipway plate. The Bourse stocks tier 2 from everyone.
    const plate = modules.get('slp-armour-4')!;
    expect(plate.tier).toBe(3);

    const design = withPlate(1);
    try {
      yard.build({ pilot, ...BERTH, name: 'Too Good', placements: design, now: 1 });
      expect.unreachable('the Bourse fitted tier-3 plate');
    } catch (error) {
      const refused = error as YardRefused;
      expect(refused.reason).toBe('not-stocked-here');
      expect(refused.problems[0]!.code).toBe('not-stocked');
      expect(refused.problems[0]!.message).toContain(plate.name);
      // The problem points at the cell that calls for it.
      expect(refused.problems[0]!.placements).toEqual([3]);
    }
  });

  it('fits the same design at the yard that does stock it', () => {
    const pilot = captain('Travelled');
    const receipt = yard.build({
      pilot,
      ...SLIPWAY,
      name: 'Well Found',
      placements: withPlate(1),
      now: 1,
    });
    expect(receipt.shipId).toBeTruthy();
  });

  it('groups repeats of one unstocked fitting into one thing to go and find', () => {
    const pilot = captain('Ambitious');
    try {
      yard.build({ pilot, ...BERTH, name: 'Plated', placements: withPlate(2), now: 1 });
      expect.unreachable('built it');
    } catch (error) {
      const refused = error as YardRefused;
      expect(refused.problems).toHaveLength(1);
      expect(refused.problems[0]!.placements).toHaveLength(2);
    }
  });
});

describe('hull licences', () => {
  it('sells a warrant, charges for it and records it', () => {
    const pilot = captain('Upgrading', 200_000);
    const before = pilot.marks;
    const issued = yard.buyLicence(pilot, 'frigate-warrant');

    expect(issued.licence).toBe('frigate-warrant');
    expect(issued.cost).toBe(tuning.licences['frigate-warrant'].cost);
    expect(pilot.licence).toBe('frigate-warrant');
    expect(pilot.marks).toBe(before - issued.cost);

    // It survives a reload, because it is on the row and not just in memory.
    expect(pilots.load(pilot.accountId)!.licence).toBe('frigate-warrant');
  });

  it('refuses a warrant the captain cannot pay for, and changes nothing', () => {
    const pilot = captain('Hopeful', 1000);
    try {
      yard.buyLicence(pilot, 'capital-charter');
      expect.unreachable('sold a charter for a thousand marks');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('cannot-afford');
    }
    expect(pilot.licence).toBe('open-ticket');
    expect(pilot.marks).toBe(1000);
    expect(pilots.load(pilot.accountId)!.licence).toBe('open-ticket');
  });

  it('only sells upward', () => {
    // Enough for the cruiser warrant and the charter after it: this test
    // climbs the whole ladder.
    const pilot = captain('Settled', 10_000_000);
    yard.buyLicence(pilot, 'cruiser-warrant');

    for (const held of ['open-ticket', 'frigate-warrant', 'cruiser-warrant'] as const) {
      try {
        yard.buyLicence(pilot, held);
        expect.unreachable(`sold ${held} to a cruiser warrant holder`);
      } catch (error) {
        expect((error as YardRefused).reason).toBe('licence-held');
      }
    }

    // Upward is still fine.
    expect(yard.buyLicence(pilot, 'capital-charter').licence).toBe('capital-charter');
  });

  it('refuses a warrant the Register does not issue', () => {
    const pilot = captain('Inventive');
    try {
      yard.buyLicence(pilot, 'dreadnought-licence');
      expect.unreachable('issued a made-up warrant');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('no-such-licence');
    }
  });

  it('every mark a warrant costs passes through the ledger', () => {
    const pilot = captain('Audited', 2_000_000);
    const before = ledger.balanceOf(pilot.accountId);
    const issued = yard.buyLicence(pilot, 'cruiser-warrant');

    // The ledger's own running balance, not the pilot row, so the two cannot
    // drift: a warrant charged outside the ledger would show up here.
    expect(ledger.balanceOf(pilot.accountId)).toBe(before - issued.cost);
    expect(ledger.balanceOf(pilot.accountId)).toBe(pilot.marks);
    expect(
      ledger.history(pilot.accountId).some((row) => row.category === 'licence-purchase'),
    ).toBe(true);
  });
});

describe('the Moorings', () => {
  /** Build two hulls, leaving the first parked and the second parked too. */
  function twoHulls(pilot: Pilot): { first: string; second: string } {
    const first = yard.build({ pilot, ...BERTH, name: 'First', placements: starter(), now: 1 });
    const second = yard.build({ pilot, ...BERTH, name: 'Second', placements: starter(), now: 2 });
    return { first: first.shipId, second: second.shipId };
  }

  it('takes out a hull moored here and leaves nothing flying but it', () => {
    const pilot = captain('Switching');
    const { first } = twoHulls(pilot);

    const taken = yard.switchTo(pilot.accountId, first, BERTH.portId);
    expect(taken.shipId).toBe(first);
    expect(taken.parked).toBeUndefined();

    const flying = yard.flying(pilot.accountId);
    expect(flying?.id).toBe(first);
    // Exactly one hull is flying, always.
    expect(yard.shipsOf(pilot.accountId).filter((s) => s.portId === '')).toHaveLength(1);
  });

  it('ties the old hull up here when swapping', () => {
    const pilot = captain('Swapping');
    const { first, second } = twoHulls(pilot);

    yard.switchTo(pilot.accountId, first, BERTH.portId);
    const taken = yard.switchTo(pilot.accountId, second, BERTH.portId);

    expect(taken.parked).toBe('First');
    expect(yard.flying(pilot.accountId)?.id).toBe(second);
    expect(yard.shipsAt(pilot.accountId, BERTH.portId).map((s) => s.id)).toEqual([first]);
  });

  it('refuses a hull moored at another berth', () => {
    const pilot = captain('Hopeful');
    const { first } = twoHulls(pilot);
    try {
      yard.switchTo(pilot.accountId, first, 'careenage');
      expect.unreachable('fetched a hull from another system');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('not-parked-here');
    }
  });

  it('refuses the hull already being flown', () => {
    const pilot = captain('Confused');
    const { first } = twoHulls(pilot);
    yard.switchTo(pilot.accountId, first, BERTH.portId);
    try {
      yard.switchTo(pilot.accountId, first, BERTH.portId);
      expect.unreachable('switched to the hull it was already in');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('already-flying-it');
    }
  });

  it("refuses somebody else's hull", () => {
    const owner = captain('Owner');
    const thief = captain('Thief');
    const { first } = twoHulls(owner);
    try {
      yard.switchTo(thief.accountId, first, BERTH.portId);
      expect.unreachable('took a hull it did not own');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('no-such-ship');
    }
    expect(yard.flying(owner.accountId)).toBeUndefined();
  });

  it('keeps a parked hull dented', () => {
    const pilot = captain('Battered');
    const { first } = twoHulls(pilot);
    yard.switchTo(pilot.accountId, first, BERTH.portId);

    const sound = yard.flying(pilot.accountId)!.moduleHp;
    yard.recordDamage(pilot.accountId, first, sound.map(() => 1));
    expect(yard.flying(pilot.accountId)!.moduleHp.every((hp) => hp === 1)).toBe(true);

    // And another captain cannot record damage on it.
    const other = captain('Meddler');
    yard.recordDamage(other.accountId, first, sound);
    expect(yard.flying(pilot.accountId)!.moduleHp.every((hp) => hp === 1)).toBe(true);
  });
});

describe('sharing draughts', () => {
  it('exports a draught and reads it back on another captain\'s books', () => {
    const author = captain('Author');
    const reader = captain('Reader');

    const saved = yard.saveDesign(author.accountId, { name: 'Bonded Runner', placements: starter() }, 1);
    const code = yard.shareCode(author.accountId, saved.id);

    const imported = yard.importDesign(reader.accountId, code, undefined, 2);
    expect(imported.name).toBe('Bonded Runner');
    expect(imported.placements).toEqual(saved.placements);

    // And it builds identically: the same bill to the mark.
    const theirs = buildCost(imported.placements, modules, tuning, []);
    const mine = buildCost(saved.placements, modules, tuning, []);
    expect(theirs).toEqual(mine);
  });

  it('refuses a code that will not read', () => {
    const pilot = captain('Mistyped');
    for (const bad of ['not a code at all', 'AAAAAAAAAAAA']) {
      try {
        yard.importDesign(pilot.accountId, bad, undefined, 1);
        expect.unreachable(`read "${bad}" as a draught`);
      } catch (error) {
        expect((error as YardRefused).reason).toBe('bad-share-code');
      }
    }
  });

  it('refuses a code calling for a fitting the Register does not list', () => {
    const pilot = captain('Futuristic');
    const code = encodeShareCode({
      name: 'From Later',
      placements: [{ moduleId: 'hrc-bridge-9', x: 0, y: 0, rotation: 0 }],
    });
    try {
      yard.importDesign(pilot.accountId, code, undefined, 1);
      expect.unreachable('imported a draught from the future');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('unknown-fitting');
    }
  });

  it('gives a draught to another captain by callsign, keeping its own', () => {
    const giver = captain('Giver');
    const taker = captain('Taker');
    const saved = yard.saveDesign(giver.accountId, { name: 'Gift', placements: starter() }, 1);

    const given = yard.giveDesign(giver.accountId, saved.id, 'taker', 2);
    expect(given.toCallsign).toBe('Taker');
    expect(yard.designsOf(taker.accountId).map((d) => d.name)).toContain('Gift');
    // The giver still has theirs.
    expect(yard.designsOf(giver.accountId).map((d) => d.id)).toContain(saved.id);
  });

  it('refuses a callsign nobody holds, and refuses giving to yourself', () => {
    const pilot = captain('Lonely');
    const saved = yard.saveDesign(pilot.accountId, { name: 'Mine', placements: starter() }, 1);

    try {
      yard.giveDesign(pilot.accountId, saved.id, 'nobody at all', 2);
      expect.unreachable('gave it to nobody');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('unknown-captain');
    }

    try {
      yard.giveDesign(pilot.accountId, saved.id, 'lonely', 2);
      expect.unreachable('gave it to itself');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('give-to-self');
    }
  });

  it("refuses to give away a draught that is not yours", () => {
    const owner = captain('Holder');
    const thief = captain('Taker2');
    const saved = yard.saveDesign(owner.accountId, { name: 'Not Yours', placements: starter() }, 1);
    try {
      yard.giveDesign(thief.accountId, saved.id, 'holder', 2);
      expect.unreachable('gave away somebody else\'s draught');
    } catch (error) {
      expect((error as YardRefused).reason).toBe('no-such-design');
    }
  });
});

describe('a hull written off', () => {
  /** Build a hull at the Bourse and take it out, so it is the one being flown. */
  function flying(pilot: Pilot, name = 'Act of God'): { id: string; cost: number } {
    const receipt = yard.build({
      pilot,
      ...BERTH,
      name,
      placements: starter(),
      now: 1,
    });
    yard.switchTo(pilot.accountId, receipt.shipId, BERTH.portId);
    return { id: receipt.shipId, cost: buildCost(starter(), modules, tuning).modules };
  }

  it('settles half what its fittings cost', () => {
    const pilot = captain('Unlucky');
    const { cost } = flying(pilot);
    const before = pilot.marks;

    const outcome = yard.writeOff(pilot, BERTH.portId);

    expect(outcome.claim).toBe(Math.floor(cost * tuning.yard.claimFraction));
    expect(Number.isInteger(outcome.claim)).toBe(true);
    expect(outcome.marksAfter).toBe(before + outcome.claim);
    expect(outcome.hull).toBe('Act of God');
  });

  it('leaves no damage behind on the captain for the next hull to carry', () => {
    const pilot = captain('Battered');
    flying(pilot);

    // Shot to pieces, and the damage recorded on the captain's own row the
    // way a fight records it.
    pilot.moduleHp = [1, 1, 1, 1];
    pilot.shield = 7;

    yard.writeOff(pilot, BERTH.portId);

    // The structure a berth quotes is derived from this array, not from the
    // hull. Left as it was, insurance handed back a replacement that read as
    // a third destroyed and offered to repair it.
    expect(pilot.moduleHp).toEqual([]);
    expect(pilot.shield).toBe(0);
  });

  it('and the claim is less than the hull cost, so a loss is a loss', () => {
    const pilot = captain('Arsonist');
    const spent = pilot.marks;
    flying(pilot);
    const paid = spent - pilot.marks;

    const outcome = yard.writeOff(pilot, BERTH.portId);
    expect(outcome.claim).toBeLessThan(paid);
  });

  it('posts it through the ledger as a claim, so the invariant still holds', () => {
    const pilot = captain('Claimant');
    flying(pilot);
    const outcome = yard.writeOff(pilot, BERTH.portId);

    expect(totalMarks()).toBe(netPosted());
    const rows = store.raw
      .prepare(`SELECT category, delta FROM ledger WHERE category = 'insurance-claim'`)
      .all() as { category: string; delta: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delta).toBe(outcome.claim);
  });

  it('takes the hull off the books and leaves every other one alone', () => {
    const pilot = captain('Fleet');
    const kept = yard.build({
      pilot,
      ...BERTH,
      name: 'Third Dividend',
      placements: starter(),
      now: 1,
    });
    const { id } = flying(pilot, 'Net of Fees');

    const outcome = yard.writeOff(pilot, BERTH.portId);

    const left = yard.shipsOf(pilot.accountId);
    expect(left.map((ship) => ship.id)).toEqual([kept.shipId]);
    expect(left.map((ship) => ship.id)).not.toContain(id);
    expect(outcome.stillOwned).toBe(1);
  });

  it('names one of their own hulls waiting where they wake', () => {
    const pilot = captain('Provident');
    yard.build({ pilot, ...BERTH, name: 'Spare', placements: starter(), now: 1 });
    flying(pilot, 'Lost');

    // Parked at the berth they wake at: they are put into it rather than
    // handed a starter.
    expect(yard.writeOff(pilot, BERTH.portId).waitingThere).toBeDefined();
  });

  it('and names nothing when their hulls are all somewhere else', () => {
    const pilot = captain('Absentee');
    yard.build({ pilot, ...BERTH, name: 'Elsewhere', placements: starter(), now: 1 });
    flying(pilot, 'Lost Too');

    const outcome = yard.writeOff(pilot, 'tare');
    expect(outcome.stillOwned).toBe(1);
    expect(outcome.waitingThere).toBeUndefined();
  });

  it('keeps the draughts on the captain’s books', () => {
    const pilot = captain('Draughtsman');
    yard.saveDesign(pilot.accountId, { name: 'Still Mine', placements: starter() }, 1);
    flying(pilot);

    yard.writeOff(pilot, BERTH.portId);
    expect(yard.designsOf(pilot.accountId).map((d) => d.name)).toEqual(['Still Mine']);
  });

  it('empties the hold, dropping half of each lot as canisters', () => {
    const pilot = captain('Laden');
    flying(pilot);
    market.adjustCargo(pilot.accountId, 'ice', 11);
    market.adjustCargo(pilot.accountId, 'leaf', 4);

    const outcome = yard.writeOff(pilot, BERTH.portId);

    // Rounding goes against the captain: eleven units drop five, not six.
    expect(outcome.spilled).toEqual(
      expect.arrayContaining([
        { commodityId: 'ice', units: 5 },
        { commodityId: 'leaf', units: 2 },
      ]),
    );
    expect(outcome.lost).toBe(11 - 5 + (4 - 2));
    expect(market.cargoUnits(pilot.accountId)).toBe(0);
  });

  it('and what drops is always less than what was aboard', () => {
    // Spec section 19: the prize premium has to stay under the share of
    // cargo lost when a hull goes, or a capture staged between friends
    // would pay. That only holds if a wreck gives back less than it held.
    const pilot = captain('Staged');
    flying(pilot);
    market.adjustCargo(pilot.accountId, 'ice', 40);

    const outcome = yard.writeOff(pilot, BERTH.portId);
    const dropped = outcome.spilled.reduce((sum, lot) => sum + lot.units, 0);
    expect(dropped).toBeLessThan(40);
    expect(dropped + outcome.lost).toBe(40);
  });

  it('settles nothing on a draught nobody ever paid a premium on', () => {
    const pilot = captain('Shuttle');
    market.adjustCargo(pilot.accountId, 'ice', 6);

    const outcome = yard.writeOff(pilot, BERTH.portId);

    expect(outcome.hull).toBeUndefined();
    expect(outcome.claim).toBe(0);
    expect(outcome.marksAfter).toBe(pilot.marks);
    // The cargo still goes: it was aboard whatever they were flying.
    expect(market.cargoUnits(pilot.accountId)).toBe(0);
    expect(outcome.lost + outcome.spilled.reduce((sum, lot) => sum + lot.units, 0)).toBe(6);
  });

  it('leaves nothing behind to claim twice', () => {
    const pilot = captain('Twice');
    flying(pilot);

    const first = yard.writeOff(pilot, BERTH.portId);
    const second = yard.writeOff(pilot, BERTH.portId);

    expect(first.claim).toBeGreaterThan(0);
    expect(second.claim).toBe(0);
    expect(second.hull).toBeUndefined();
  });
});
