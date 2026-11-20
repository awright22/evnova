import { beforeEach, describe, expect, it } from 'vitest';

import { content, pressure, type CommodityDef } from '@marque/shared';

import { openStore, type Store } from '../db/index.ts';
import { Freight } from './Freight.ts';
import { Ledger } from './Ledger.ts';
import { Market } from './Market.ts';

let store: Store;
let market: Market;
let freight: Freight;

beforeEach(() => {
  store = openStore(':memory:');
  market = new Market(store, new Ledger(store));
  freight = new Freight(market);
});

const { commodities, systems } = content();

const trading = [...systems.values()].flatMap((system) =>
  system.ports.filter((port) => port.services.includes('staple')),
);

/**
 * Run the world forward with nobody in it.
 *
 * The step only decides how smooth the run is: drift is a function of hours
 * and freight's budget is proportional to them, so a coarser step reaches the
 * same place and a month takes a couple of seconds rather than ten.
 */
function runHours(hours: number, step = 6): void {
  for (let elapsed = 0; elapsed < hours; elapsed += step) {
    market.drift(step, elapsed);
    freight.run(step, elapsed);
  }
}

describe('freight', () => {
  it('moves from a surplus to a shortage', () => {
    const provisions = commodities.get('provisions')!;

    // Half a week of nobody trading leaves the three berths that make
    // Provisions long and everyone who eats them short.
    market.drift(84, 1);

    const shortBefore = shortfallAcross(provisions);
    const surplusBefore = surplusAcross(provisions);
    expect(shortBefore).toBeGreaterThan(0);
    expect(surplusBefore).toBeGreaterThan(0);

    const moved = freight.run(6, 2);

    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((load) => load.units > 0)).toBe(true);
    expect(shortfallAcross(provisions)).toBeLessThan(shortBefore);
    expect(surplusAcross(provisions)).toBeLessThan(surplusBefore);
  });

  it('carries a commodity across the Reach when it is only made at one end', () => {
    // Leaf grows only in the Marque and is chewed only in the Home Roads,
    // which are six lanes apart: if freight will not go that far, every
    // Home Roads berth runs dry whatever else works.
    market.drift(200, 1);

    const moved = freight.run(12, 2).filter((load) => load.commodityId === 'leaf');
    expect(moved.length).toBeGreaterThan(0);

    const homeRoads = [...systems.values()]
      .filter((system) => system.region === 'home-roads')
      .flatMap((system) => system.ports)
      .filter((port) => port.services.includes('staple'));

    expect(moved.some((load) => homeRoads.some((port) => port.id === load.toPortId))).toBe(true);
  });

  it('has work to do the moment a world opens', () => {
    // A berth opens where its own trade has already pushed it — a maker on
    // a surplus, an eater short — so there is freight to run from the first
    // hour. A galaxy that opened at target had nothing to carry anywhere,
    // which is also what a captain's first voyage found.
    const moved = freight.run(6, 1);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((load) => load.units > 0)).toBe(true);
  });

  it('and stops when it has nothing left to even out', () => {
    // Driven to target by its own work: over a long enough run with nobody
    // trading, freight and drift settle against each other rather than
    // shifting cargo for ever.
    runHours(24 * 10);
    const settled = freight.run(6, 24 * 10 + 1);
    const opening = 60;
    expect(settled.length).toBeLessThan(opening);
  });

  /**
   * The condition the spec sets for the soak, checked here deterministically
   * and without a network: over a simulated month with nobody trading, no
   * berth runs to zero or to its capacity, and the Reach as a whole stays
   * near its targets. That is the whole reason freight exists, so all three
   * properties are read off one run of the month rather than three.
   */
  it('keeps every berth trading over a simulated month', { timeout: 30_000 }, () => {
    runHours(24 * 30);

    const empty: string[] = [];
    const full: string[] = [];
    let worst = 0;

    for (const port of trading) {
      for (const commodity of commodities.values()) {
        const pile = market.pileOf(port, commodity);

        expect(pile.stock).toBeGreaterThanOrEqual(0);
        expect(pile.stock).toBeLessThanOrEqual(pile.capacity);

        if (pile.stock === 0) empty.push(`${port.id}/${commodity.id}`);
        if (pile.stock >= pile.capacity) full.push(`${port.id}/${commodity.id}`);
        worst = Math.max(worst, Math.abs(pressure(pile)));
      }
    }

    expect(empty, `berths run dry: ${empty.slice(0, 6).join(', ')}`).toHaveLength(0);
    expect(full, `berths at capacity: ${full.slice(0, 6).join(', ')}`).toHaveLength(0);

    // A berth may be short or long — that is what makes a route worth flying
    // — but the Reach as a whole should not drift to one end.
    expect(worst).toBeLessThan(2.5);
  });
});

/** How far below target every berth is, added up. */
function shortfallAcross(commodity: CommodityDef): number {
  let total = 0;
  for (const port of trading) {
    const pile = market.pileOf(port, commodity);
    total += Math.max(0, pile.target - pile.stock);
  }
  return total;
}

/** And how far above it. */
function surplusAcross(commodity: CommodityDef): number {
  let total = 0;
  for (const port of trading) {
    const pile = market.pileOf(port, commodity);
    total += Math.max(0, pile.stock - pile.target);
  }
  return total;
}
