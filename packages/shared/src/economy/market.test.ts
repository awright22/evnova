import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { capacityFor, netRate, openingPile, pressure, targetStock, throughput } from './market.ts';
import { unitPrice } from './price.ts';

const { commodities, systems, tuning } = content();

/** Every berth that keeps a Staple, which is every berth with a market. */
const trading = [...systems.values()].flatMap((system) =>
  system.ports.filter((port) => port.services.includes('staple')),
);

describe('berth markets', () => {
  it('gives every Staple a trade profile', () => {
    for (const port of trading) {
      expect(port.trade, `${port.id} has no trade profile`).toBeDefined();
    }
  });

  it('names only real commodities', () => {
    for (const port of trading) {
      for (const id of Object.keys(port.trade?.produces ?? {})) {
        expect(commodities.has(id), `${port.id} produces unknown "${id}"`).toBe(true);
      }
      for (const id of Object.keys(port.trade?.consumes ?? {})) {
        expect(commodities.has(id), `${port.id} consumes unknown "${id}"`).toBe(true);
      }
    }
  });

  it('never has a berth both make and eat the same thing', () => {
    for (const port of trading) {
      for (const id of Object.keys(port.trade?.produces ?? {})) {
        expect(
          port.trade?.consumes[id] ?? 0,
          `${port.id} both makes and eats ${id}`,
        ).toBe(0);
      }
    }
  });

  /**
   * The galaxy has to be roughly in balance, or the soak's requirement that
   * no stock run to zero or without bound cannot hold however well the
   * pricing behaves: a commodity made faster than it is eaten fills every
   * berth to capacity and sits at its price floor, and one eaten faster
   * empties them and sits at the ceiling.
   *
   * A surplus is allowed and a deficit is not: captains buy, and a freighter
   * that is destroyed never delivers, so both take goods out of the world.
   */
  it('balances every commodity across the galaxy', () => {
    for (const commodity of commodities.values()) {
      let made = 0;
      let eaten = 0;
      for (const port of trading) {
        made += port.trade?.produces[commodity.id] ?? 0;
        eaten += port.trade?.consumes[commodity.id] ?? 0;
      }

      expect(made, `nothing in the Reach makes ${commodity.id}`).toBeGreaterThan(0);
      expect(eaten, `nothing in the Reach eats ${commodity.id}`).toBeGreaterThan(0);

      const skew = (made - eaten) / made;
      expect(skew, `${commodity.id} runs a deficit of ${(-skew * 100).toFixed(1)}%`)
        .toBeGreaterThanOrEqual(0);
      expect(skew, `${commodity.id} runs a surplus of ${(skew * 100).toFixed(1)}%`)
        .toBeLessThan(0.2);
    }
  });

  it('opens every berth at exactly what it wants, quoting the base price', () => {
    for (const port of trading) {
      for (const commodity of commodities.values()) {
        const pile = openingPile(port, commodity, tuning);
        expect(pile.stock).toBe(pile.target);
        expect(pile.capacity).toBeGreaterThan(pile.target);
        expect(pressure(pile)).toBe(0);
        expect(unitPrice(pile.stock, pile, commodity, tuning)).toBeCloseTo(
          commodity.basePrice,
          6,
        );
      }
    }
  });

  it('wants more of what it moves more of', () => {
    const ullage = trading.find((port) => port.id === 'ullage')!;
    const ice = commodities.get('ice')!;
    const leaf = commodities.get('leaf')!;

    // Ullage refines Propellant out of Ice and does nothing with Leaf.
    expect(throughput(ullage, 'ice')).toBeGreaterThan(0);
    expect(throughput(ullage, 'leaf')).toBe(0);
    expect(targetStock(ullage, ice, tuning)).toBeGreaterThan(
      targetStock(ullage, leaf, tuning),
    );
    expect(targetStock(ullage, leaf, tuning)).toBe(tuning.market.baselineTarget);
  });

  it('reads a producer as positive and a consumer as negative', () => {
    const ballast = trading.find((port) => port.id === 'ballast')!;
    expect(netRate(ballast, 'ore')).toBeGreaterThan(0);
    expect(netRate(ballast, 'provisions')).toBeLessThan(0);
    expect(netRate(ballast, 'leaf')).toBe(0);
  });

  it('holds capacity above target everywhere, so a berth can take a delivery', () => {
    for (const port of trading) {
      for (const commodity of commodities.values()) {
        expect(capacityFor(port, commodity, tuning)).toBeGreaterThan(
          targetStock(port, commodity, tuning),
        );
      }
    }
  });
});
