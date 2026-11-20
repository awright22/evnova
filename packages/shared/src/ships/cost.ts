/**
 * What a design costs to build, and what a refit costs to carry out.
 *
 * Pure and deterministic: the editor's cost panel and the server's build
 * transaction run the same function, so what a captain is quoted is what they
 * are charged. Marks and units are whole, and every rounding goes against the
 * captain.
 *
 * Spec section 7: a build costs marks plus a bill of materials, taken from
 * the hold or bought from the local market in the same transaction at current
 * prices. Part of the marks is a hull insurance premium. A refit charges for
 * what is added and refunds half the marks of what is removed.
 */

import type { ModuleDef, Placement, Tuning } from '../content/schema.ts';

/** How many of each commodity a build needs. */
export type Bill = Map<string, number>;

export interface BuildCost {
  /** Marks for the modules themselves. */
  readonly modules: number;
  /** The insurance premium, which is part of what a build costs. */
  readonly premium: number;
  /** Marks refunded for modules taken off, in a refit. */
  readonly refund: number;
  /** Marks owed in total: modules plus premium, less the refund, never below nothing. */
  readonly marks: number;
  /** Commodities the yard needs, after anything removed is credited back. */
  readonly bill: Bill;
}

/** Add a module's bill of materials into a running total. */
function addBill(into: Bill, def: ModuleDef, sign: number): void {
  for (const [commodityId, units] of Object.entries(def.bom)) {
    if (units === undefined) continue;
    const next = (into.get(commodityId) ?? 0) + units * sign;
    if (next === 0) into.delete(commodityId);
    else into.set(commodityId, next);
  }
}

/**
 * What it costs to go from one design to another.
 *
 * Pass no `from` for a build from nothing. A refit charges for every module
 * added and refunds half the marks of every module removed; the materials of
 * a removed module come back in full, because the yard has the parts in its
 * hands.
 *
 * Modules are matched by what they are, not where they sit: moving a module
 * on the grid is free, which is what makes the editor usable.
 */
export function buildCost(
  to: readonly Placement[],
  modules: ReadonlyMap<string, ModuleDef>,
  tuning: Tuning,
  from: readonly Placement[] = [],
): BuildCost {
  const counts = new Map<string, number>();
  for (const placement of to) {
    counts.set(placement.moduleId, (counts.get(placement.moduleId) ?? 0) + 1);
  }
  for (const placement of from) {
    counts.set(placement.moduleId, (counts.get(placement.moduleId) ?? 0) - 1);
  }

  let added = 0;
  let removed = 0;
  const bill: Bill = new Map();

  for (const [moduleId, delta] of counts) {
    if (delta === 0) continue;
    const def = modules.get(moduleId);
    if (!def) continue;

    if (delta > 0) {
      added += def.cost * delta;
      for (let i = 0; i < delta; i++) addBill(bill, def, 1);
    } else {
      removed += def.cost * -delta;
      for (let i = 0; i < -delta; i++) addBill(bill, def, -1);
    }
  }

  // Materials cannot go negative: a yard credits back what it strips, but it
  // will not hand a captain a pile of Alloy for refitting downwards.
  for (const [commodityId, units] of [...bill]) {
    if (units <= 0) bill.delete(commodityId);
  }

  const premium = Math.ceil(added * tuning.yard.insurancePremium);
  const refund = Math.floor(removed * tuning.yard.refundFraction);
  const marks = Math.max(0, added + premium - refund);

  return { modules: added, premium, refund, marks, bill };
}

/** What is still needed after the hold is counted. */
export interface BillShortfall {
  /** Units of each commodity the hold cannot cover. */
  readonly missing: Bill;
  /** Units taken from the hold. */
  readonly fromHold: Bill;
}

/**
 * Split a bill between what the captain is already carrying and what the yard
 * has to buy for them.
 */
export function splitBill(bill: Bill, hold: ReadonlyMap<string, number>): BillShortfall {
  const missing: Bill = new Map();
  const fromHold: Bill = new Map();

  for (const [commodityId, needed] of bill) {
    const carried = Math.max(0, hold.get(commodityId) ?? 0);
    const taken = Math.min(carried, needed);
    if (taken > 0) fromHold.set(commodityId, taken);
    if (needed > taken) missing.set(commodityId, needed - taken);
  }

  return { missing, fromHold };
}

/**
 * Whether a berth's Yard stocks a fitting.
 *
 * One rule, read by the editor to decide what to show and by the server to
 * decide what to build, so the palette can never offer something the build
 * will refuse. A berth that keeps no Yard stocks nothing.
 */
export function stocksModule(
  stock: Partial<Record<string, number>> | undefined,
  def: Pick<ModuleDef, 'manufacturer' | 'tier'>,
): boolean {
  if (!stock) return false;
  return def.tier <= (stock[def.manufacturer] ?? 0);
}

/**
 * The fittings a design calls for that this berth does not stock.
 *
 * Grouped by fitting rather than listed per cell: four unstocked engines are
 * one thing to go and find, not four problems. Each carries the placements
 * that call for it so the editor can still mark them on the grid.
 */
export function unstockedModules(
  placements: readonly Placement[],
  catalogue: ReadonlyMap<string, ModuleDef>,
  stock: Partial<Record<string, number>> | undefined,
): { moduleId: string; name: string; placements: number[] }[] {
  const missing = new Map<string, { moduleId: string; name: string; placements: number[] }>();
  placements.forEach((placement, index) => {
    const def = catalogue.get(placement.moduleId);
    if (!def || stocksModule(stock, def)) return;
    const entry = missing.get(def.id) ?? { moduleId: def.id, name: def.name, placements: [] };
    entry.placements.push(index);
    missing.set(def.id, entry);
  });
  return [...missing.values()];
}

/**
 * A module's name without its maker's, for a list too narrow for both.
 *
 * The catalogue names every part in full — "Slipway Thirty Mk I Engine" — and
 * a palette that shows that truncates to "Slipway Thirty Mk I..." on every
 * row, which tells a captain nothing. The maker goes in a tag beside it.
 */
export function shortModuleName(name: string, maker: string): string {
  return name.startsWith(`${maker} `) ? name.slice(maker.length + 1) : name;
}

/** Total units in a bill, for showing a hold's worth of materials at a glance. */
export function billUnits(bill: Bill): number {
  let total = 0;
  for (const units of bill.values()) total += units;
  return total;
}
