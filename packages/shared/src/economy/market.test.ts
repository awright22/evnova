import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import type { CommodityDef, PortDef } from '../content/schema.ts';
import {
  capacityFor,
  inputsFor,
  netRate,
  openingPile,
  pressure,
  supplyFor,
  targetStock,
  throughput,
  workingRate,
} from './market.ts';
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

describe('production chains', () => {

  /** A berth by id, from the real galaxy. */
  function berth(id: string): PortDef {
    for (const system of systems.values()) {
      const port = system.ports.find((candidate) => candidate.id === id);
      if (port) return port;
    }
    throw new Error(`no berth called "${id}"`);
  }

  const good = (id: string): CommodityDef => {
    const found = commodities.get(id);
    if (!found) throw new Error(`no commodity "${id}"`);
    return found;
  };

  it('knows what a refinery is made to run on, and what it is not', () => {
    // Quorum refines Alloy out of Ore, and feeds its people on Provisions.
    expect(inputsFor(berth('quorum'), good('alloy'), commodities)).toEqual(['ore']);
  });

  it('treats a salvage yard as having nothing to run out of', () => {
    // Flotsam picks Alloy out of wrecks: it consumes no raw good at all.
    expect(inputsFor(berth('flotsam'), good('alloy'), commodities)).toEqual([]);
  });

  it('counts nothing a berth eats for its own sake as an input', () => {
    // Countinghouse makes Circuitry out of Alloy. The Leaf and the
    // Provisions are for the people, not for the line.
    expect(inputsFor(berth('countinghouse'), good('circuitry'), commodities)).toEqual(['alloy']);
  });

  it('gives a raw good no inputs, however much the berth eats', () => {
    // Ballast digs Ore and buys Machinery to do it with; a mine does not
    // stop because a crate of Machinery is late.
    expect(inputsFor(berth('ballast'), good('ore'), commodities)).toEqual([]);
  });

  it('runs a well-stocked line at full tilt', () => {
    const port = berth('quorum');
    const full = (): number => 10_000;
    expect(supplyFor(port, good('alloy'), 1, full, commodities)).toBe(1);
    expect(workingRate(port, good('alloy'), 1, full, commodities)).toBe(
      port.trade?.produces.alloy ?? 0,
    );
  });

  it('stops a line that has run out of what it is made of', () => {
    const port = berth('quorum');
    const dry = (id: string): number => (id === 'ore' ? 0 : 10_000);
    expect(supplyFor(port, good('alloy'), 1, dry, commodities)).toBe(0);
    expect(workingRate(port, good('alloy'), 1, dry, commodities)).toBe(0);
  });

  it('converts a trickle at the rate the trickle arrives', () => {
    const port = berth('quorum');
    const wanted = (port.trade?.consumes.ore ?? 0) * 1;
    // A quarter of an hour's Ore on hand, and an hour to work.
    const trickle = (id: string): number => (id === 'ore' ? wanted / 4 : 10_000);

    expect(supplyFor(port, good('alloy'), 1, trickle, commodities)).toBeCloseTo(0.25, 6);
    expect(workingRate(port, good('alloy'), 1, trickle, commodities)).toBeCloseTo(
      (port.trade?.produces.alloy ?? 0) * 0.25,
      6,
    );
  });

  it('stops eating what a stopped line cannot use', () => {
    const port = berth('quorum');
    const dry = (id: string): number => (id === 'ore' ? 0 : 10_000);
    // With no Alloy to make, the Ore line consumes nothing — there is
    // nothing to consume — and the figure does not go negative on a berth
    // that is only waiting.
    expect(workingRate(port, good('ore'), 1, dry, commodities)).toBe(0);
  });

  it('keeps feeding the people whether or not the line is running', () => {
    const port = berth('quorum');
    const dry = (id: string): number => (id === 'ore' ? 0 : 10_000);
    // Provisions are eaten because people are there. A berth with its
    // refinery stopped still runs its Provisions down.
    expect(workingRate(port, good('provisions'), 1, dry, commodities)).toBeLessThan(0);
    expect(workingRate(port, good('provisions'), 1, dry, commodities)).toBe(
      -(port.trade?.consumes.provisions ?? 0),
    );
  });

  it('throttles a line by its narrowest input, not its widest', () => {
    // Ropewalk makes Machinery out of Alloy and Circuitry.
    const port = berth('ropewalk');
    expect(inputsFor(port, good('machinery'), commodities).sort()).toEqual(['alloy', 'circuitry']);

    const short = (id: string): number =>
      id === 'circuitry' ? (port.trade?.consumes.circuitry ?? 0) * 0.5 : 10_000;
    expect(supplyFor(port, good('machinery'), 1, short, commodities)).toBeCloseTo(0.5, 6);
  });

  it('never lets a berth deadlock itself on its own output', () => {
    // A berth that needed B to make A and A to make B would sit at zero
    // forever, because each line would be waiting on the other. Sideways
    // inputs are allowed, so this is the thing that keeps them safe.
    for (const system of systems.values()) {
      for (const port of system.ports) {
        for (const made of commodities.values()) {
          if ((port.trade?.produces[made.id] ?? 0) <= 0) continue;
          for (const input of inputsFor(port, made, commodities)) {
            const other = commodities.get(input);
            if (!other) continue;
            expect(
              inputsFor(port, other, commodities),
              `${port.id} makes ${made.id} from ${input} and ${input} from ${made.id}`,
            ).not.toContain(made.id);
          }
        }
      }
    }
  });

  it('never makes something out of nothing: every chain ends at a raw good', () => {
    for (const system of systems.values()) {
      for (const port of system.ports) {
        for (const commodity of commodities.values()) {
          for (const input of inputsFor(port, commodity, commodities)) {
            const made = commodities.get(input);
            expect(made, `${port.id} says ${commodity.id} is made of ${input}`).toBeDefined();
          }
        }
      }
    }
  });

  it('leaves the Reach able to make everything it eats', () => {
    // Every good something consumes is made somewhere, at a berth that can
    // actually run: either it needs no inputs, or its inputs are made too.
    const madeSomewhere = new Set<string>();
    for (const system of systems.values()) {
      for (const port of system.ports) {
        for (const [id, rate] of Object.entries(port.trade?.produces ?? {})) {
          if (rate > 0) madeSomewhere.add(id);
        }
      }
    }

    const eaten = new Set<string>();
    for (const system of systems.values()) {
      for (const port of system.ports) {
        for (const [id, rate] of Object.entries(port.trade?.consumes ?? {})) {
          if (rate > 0) eaten.add(id);
        }
      }
    }

    for (const id of eaten) {
      expect(madeSomewhere.has(id), `nothing in the Reach makes ${id}`).toBe(true);
    }
  });
});
