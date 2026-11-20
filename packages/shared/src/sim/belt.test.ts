/**
 * Where the rocks are, and what happens to them.
 *
 * A belt is placed from the system's id and nothing else, which is the whole
 * of what makes it a landmark rather than scenery: these tests are mostly
 * about that promise holding.
 */

import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { beltOf, regrown, rockAlong } from './belt.ts';

const { systems, tuning } = content();

/** A system with a belt in it. */
const withBelt = [...systems.values()].filter((system) => system.belt !== undefined);

describe('where a belt is', () => {
  it('puts rock in the systems whose geography says there is rock', () => {
    expect(withBelt.length).toBeGreaterThan(0);
    for (const system of withBelt) {
      // Only raw goods come out of the ground.
      const commodity = content().commodities.get(system.belt!.commodity);
      expect(commodity?.tier, `${system.id} mines ${system.belt!.commodity}`).toBe('raw');
    }
  });

  it('leaves the Home Roads worked out', () => {
    for (const system of withBelt) {
      expect(system.region, `${system.id} has a belt`).not.toBe('home-roads');
    }
  });

  it('lays the same belt every time, from the system alone', () => {
    for (const system of withBelt) {
      expect(beltOf(system)).toEqual(beltOf(system));
    }
  });

  it('lays a different belt in every system', () => {
    const first = withBelt.map((system) => beltOf(system)[0]);
    const places = new Set(first.map((rock) => `${rock?.x.toFixed(3)},${rock?.y.toFixed(3)}`));
    expect(places.size).toBe(first.length);
  });

  it('gives every system exactly the rocks it asked for', () => {
    for (const system of withBelt) {
      expect(beltOf(system), system.id).toHaveLength(system.belt!.rocks);
    }
  });

  it('keeps every rock inside its system and clear of the star', () => {
    for (const system of withBelt) {
      for (const rock of beltOf(system)) {
        const distance = Math.hypot(rock.x, rock.y);
        expect(distance, `${system.id} ${rock.id}`).toBeGreaterThan(system.star.radius * 2);
        expect(distance, `${system.id} ${rock.id}`).toBeLessThan(system.radius);
      }
    }
  });

  it('gives a bigger rock more in it', () => {
    for (const system of withBelt) {
      const rocks = [...beltOf(system)].sort((a, b) => a.radius - b.radius);
      const smallest = rocks[0];
      const largest = rocks[rocks.length - 1];
      expect(largest!.whole).toBeGreaterThan(smallest!.whole);
    }
  });

  it('gives no system a belt of one rock in one place', () => {
    for (const system of withBelt) {
      const rocks = beltOf(system);
      const bearings = rocks.map((rock) => Math.atan2(rock.y, rock.x));
      const spread = Math.max(...bearings) - Math.min(...bearings);
      expect(spread, system.id).toBeGreaterThan(Math.PI);
    }
  });
});

describe('cutting into one', () => {
  const rock = { x: 1000, y: 0, radius: 100 };

  it('finds a rock straight ahead, and says where the face is', () => {
    const along = rockAlong(0, 0, 2000, 0, rock);
    expect(along).toBeDefined();
    // The face is at 900 of a 2000 reach.
    expect(along!).toBeCloseTo(0.45, 2);
  });

  it('misses a rock the line goes past', () => {
    expect(rockAlong(0, 300, 2000, 300, rock)).toBeUndefined();
  });

  it('misses a rock beyond the end of the line', () => {
    // Reaching only 500, with the rock's face at 900.
    expect(rockAlong(0, 0, 500, 0, rock)).toBeUndefined();
  });

  it('counts a rock the line starts inside as right here', () => {
    expect(rockAlong(1000, 0, 2000, 0, rock)).toBe(0);
  });

  it('finds one off the beam, as long as the line clips it', () => {
    const along = rockAlong(0, 0, 2000, 160, rock);
    expect(along).toBeDefined();
  });
});

describe('what comes back', () => {
  it('fills a worked rock at the rate the Register says', () => {
    // A day's worth, from half empty.
    expect(regrown(100, 300, 24, tuning.world.rockPerDay)).toBeCloseTo(140, 6);
  });

  it('never fills one past whole', () => {
    expect(regrown(290, 300, 24 * 30, tuning.world.rockPerDay)).toBe(300);
  });

  it('leaves a whole rock alone', () => {
    expect(regrown(300, 300, 48, tuning.world.rockPerDay)).toBe(300);
  });

  it('does nothing over no time', () => {
    expect(regrown(100, 300, 0, tuning.world.rockPerDay)).toBe(100);
  });

  it('takes a long while to bring a stripped rock back', () => {
    // The point of the rate: a captain who strips a rock comes back to find
    // it still thin, and a belt worked out a month ago is worth another look.
    const aDay = regrown(0, 300, 24, tuning.world.rockPerDay);
    expect(aDay).toBeLessThan(300 * 0.2);
    expect(regrown(0, 300, 24 * 10, tuning.world.rockPerDay)).toBeGreaterThan(300 * 0.9);
  });
});
