import { describe, expect, it } from 'vitest';

import { content } from './load.ts';

describe('what the shipped draughts are painted', () => {
  /** Section 4's four liveries, which belong to companies and not captains. */
  const LIVERIES = ['#E9E2D0', '#3A6FD8', '#2FA596', '#4A525E'];

  it('gives every design two colours of its own', () => {
    for (const blueprint of content().blueprints.values()) {
      expect(blueprint.paint, blueprint.id).toHaveLength(2);
      for (const colour of blueprint.paint) {
        expect(colour, `${blueprint.id} paints in ${colour}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('and none of them in a company’s livery', () => {
    // A free captain picks their own two colours. Short Measure used to
    // paint in exactly `--livery-unlettered`, so a player flying it looked
    // like a raider, and Force Majeure in exactly Reprisal's verdigris.
    for (const blueprint of content().blueprints.values()) {
      for (const colour of blueprint.paint) {
        expect(
          LIVERIES.map((livery) => livery.toLowerCase()),
          `${blueprint.id} paints in a livery: ${colour}`,
        ).not.toContain(colour.toLowerCase());
      }
    }
  });

  it('and not all of them grey', () => {
    // Half the catalogue was grey-blue, which reads as unpainted. A hull a
    // captain owns should look like somebody chose it.
    const saturated = [...content().blueprints.values()].filter((blueprint) => {
      const channels = [1, 3, 5].map((at) =>
        Number.parseInt(blueprint.paint[0].slice(at, at + 2), 16),
      );
      return Math.max(...channels) - Math.min(...channels) > 40;
    });
    expect(saturated.length).toBeGreaterThanOrEqual(content().blueprints.size - 1);
  });
});
