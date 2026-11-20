/**
 * A rock's shape.
 *
 * The promise worth testing is that it is the same rock everywhere: the
 * server places a belt from a seed and a captain navigates by it, so a
 * client that drew them differently each time would be drawing scenery.
 */

import { describe, expect, it } from 'vitest';

import { rockShape, rockWear } from './rock.ts';

describe('rockShape', () => {
  it('draws the same rock from the same seed, every time', () => {
    expect(rockShape(1234, 90, 500, -200)).toEqual(rockShape(1234, 90, 500, -200));
  });

  it('draws a different rock from a different seed', () => {
    expect(rockShape(1234, 90, 0, 0).radii).not.toEqual(rockShape(1235, 90, 0, 0).radii);
  });

  it('keeps every point near the radius it was given', () => {
    const shape = rockShape(77, 100, 0, 0);
    for (const radius of shape.radii) {
      expect(radius).toBeGreaterThan(70);
      expect(radius).toBeLessThan(130);
    }
  });

  it('is lumpy rather than round', () => {
    const shape = rockShape(9, 100, 0, 0);
    expect(Math.max(...shape.radii) - Math.min(...shape.radii)).toBeGreaterThan(5);
  });

  it('lights it from the star, which is at the origin', () => {
    // Due east of the star: the lit side faces back west, which `atan2`
    // gives as minus pi rather than pi — the same bearing either way.
    expect(Math.abs(rockShape(1, 90, 1000, 0).lightAngle)).toBeCloseTo(Math.PI, 6);
    // Due north: lit from the south.
    expect(rockShape(1, 90, 0, 1000).lightAngle).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('rockWear', () => {
  it('leaves a whole rock whole', () => {
    expect(rockWear(300, 300)).toEqual({ scale: 1, tint: 1 });
  });

  it('shrinks and dulls a worked one', () => {
    const half = rockWear(150, 300);
    expect(half.scale).toBeLessThan(1);
    expect(half.tint).toBeLessThan(1);
  });

  it('never takes one to nothing, because it is still a landmark', () => {
    const bare = rockWear(0, 300);
    expect(bare.scale).toBeGreaterThan(0.5);
    expect(bare.tint).toBeGreaterThan(0.4);
  });

  it('reads a rock with nothing in it the same as one that never held any', () => {
    expect(rockWear(0, 300)).toEqual(rockWear(0, 0));
  });
});
