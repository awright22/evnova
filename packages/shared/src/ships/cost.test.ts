import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { billUnits, buildCost, splitBill } from './cost.ts';
import type { ModuleDef, Placement } from '../content/schema.ts';

const { blueprints, modules, tuning } = content();

const starter = blueprints.get('prudent-return')!;

/** A design as a list of placements, which is what a build is costed from. */
function design(id: string): readonly Placement[] {
  return blueprints.get(id)!.placements;
}

describe('what a yard charges', () => {
  it('costs a build from nothing as its modules plus the premium', () => {
    const cost = buildCost(design('prudent-return'), modules, tuning);

    let bare = 0;
    for (const placement of starter.placements) {
      bare += modules.get(placement.moduleId)!.cost;
    }

    expect(cost.modules).toBe(bare);
    expect(cost.premium).toBe(Math.ceil(bare * tuning.yard.insurancePremium));
    expect(cost.refund).toBe(0);
    expect(cost.marks).toBe(cost.modules + cost.premium);
  });

  it('bills every material its modules need', () => {
    const cost = buildCost(design('prudent-return'), modules, tuning);

    const expected = new Map<string, number>();
    for (const placement of starter.placements) {
      for (const [id, units] of Object.entries(modules.get(placement.moduleId)!.bom)) {
        if (units !== undefined) expected.set(id, (expected.get(id) ?? 0) + units);
      }
    }

    expect([...cost.bill].sort()).toEqual([...expected].sort());
    expect(billUnits(cost.bill)).toBeGreaterThan(0);
  });

  it('charges nothing to rearrange a hull', () => {
    // Same modules, different places: moving one costs a yard nothing, and a
    // captain who paid to slide a plate across would never use the editor.
    const moved = starter.placements.map((placement, index) =>
      index === 0 ? { ...placement, x: placement.x + 9 } : placement,
    );

    const cost = buildCost(moved, modules, tuning, starter.placements);

    expect(cost.marks).toBe(0);
    expect(cost.bill.size).toBe(0);
  });

  it('charges for what a refit adds', () => {
    const extra = modules.get('hrc-cargo-1')!;
    const bigger = [
      ...starter.placements,
      { moduleId: extra.id, x: 20, y: 20, rotation: 0 as const },
    ];

    const cost = buildCost(bigger, modules, tuning, starter.placements);

    expect(cost.modules).toBe(extra.cost);
    expect(cost.marks).toBe(extra.cost + Math.ceil(extra.cost * tuning.yard.insurancePremium));
    expect(cost.bill.get('alloy')).toBe(extra.bom.alloy);
  });

  it('refunds half the marks of what a refit strips, and no materials', () => {
    const stripped = starter.placements.filter(
      (placement) => placement.moduleId !== 'hrc-cargo-1',
    );
    const bay = modules.get('hrc-cargo-1')!;

    const cost = buildCost(stripped, modules, tuning, starter.placements);

    expect(cost.modules).toBe(0);
    expect(cost.refund).toBe(Math.floor(bay.cost * tuning.yard.refundFraction));
    // Nothing is owed, and the yard does not hand back Alloy for the privilege.
    expect(cost.marks).toBe(0);
    expect(cost.bill.size).toBe(0);
  });

  it('never owes a captain marks for refitting downwards', () => {
    const cost = buildCost([], modules, tuning, starter.placements);
    expect(cost.marks).toBe(0);
    expect(cost.refund).toBeGreaterThan(0);
  });

  it('rounds the premium up and the refund down, against the captain', () => {
    // Against a made-up module rather than a shipped one: every module in the
    // catalogue happens to cost a round number today, so testing this on the
    // real data would pass whatever the rounding did.
    const awkward: ModuleDef = {
      ...modules.get('hrc-hull-1')!,
      id: 'test-awkward',
      cost: 333,
    };
    const catalogue = new Map(modules);
    catalogue.set(awkward.id, awkward);

    const placement = { moduleId: awkward.id, x: 0, y: 0, rotation: 0 as const };
    const built = buildCost([placement], catalogue, tuning);
    const stripped = buildCost([], catalogue, tuning, [placement]);

    // 333 * 0.12 = 39.96, charged as 40; 333 * 0.5 = 166.5, refunded as 166.
    expect(built.premium).toBe(Math.ceil(333 * tuning.yard.insurancePremium));
    expect(built.premium).toBeGreaterThan(333 * tuning.yard.insurancePremium);
    expect(stripped.refund).toBe(Math.floor(333 * tuning.yard.refundFraction));
    expect(stripped.refund).toBeLessThan(333 * tuning.yard.refundFraction);
  });

  it('ignores a module the catalogue does not have', () => {
    const cost = buildCost(
      [{ moduleId: 'not-a-module', x: 0, y: 0, rotation: 0 }],
      modules,
      tuning,
    );
    expect(cost.marks).toBe(0);
    expect(cost.bill.size).toBe(0);
  });
});

describe('paying a bill from the hold', () => {
  it('takes what the hold has and leaves the rest to buy', () => {
    const bill = new Map([
      ['alloy', 30],
      ['circuitry', 6],
    ]);
    const split = splitBill(bill, new Map([['alloy', 12]]));

    expect(split.fromHold.get('alloy')).toBe(12);
    expect(split.missing.get('alloy')).toBe(18);
    expect(split.missing.get('circuitry')).toBe(6);
    expect(split.fromHold.has('circuitry')).toBe(false);
  });

  it('needs nothing bought when the hold covers it', () => {
    const bill = new Map([['alloy', 10]]);
    const split = splitBill(bill, new Map([['alloy', 40]]));

    expect(split.fromHold.get('alloy')).toBe(10);
    expect(split.missing.size).toBe(0);
  });

  it('ignores a hold that claims a negative count', () => {
    const split = splitBill(new Map([['alloy', 5]]), new Map([['alloy', -99]]));
    expect(split.missing.get('alloy')).toBe(5);
    expect(split.fromHold.size).toBe(0);
  });
});
