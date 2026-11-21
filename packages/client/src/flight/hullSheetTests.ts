/**
 * Grids a captain could lay out in the Loft, chosen to be awkward.
 *
 * The content catalogue's six draughts were all drawn by somebody who knew
 * what a ship looks like. A renderer that only ever sees those can look right
 * and still turn a captain's own design into a floor plan, so the hull sheet
 * also draws these: a diagonal staircase, single cells sticking out on their
 * own, a T with a thin stem, a hull with a hole in it, and a plain brick.
 *
 * They are not legal designs and are never flown. They name real fittings,
 * because the renderer reads the catalogue, but nothing validates them.
 */

import type { Blueprint, Placement } from '@marque/shared';

/** Single-cell fittings, by the letter that stands for them in a plan. */
const ONE_CELL: Readonly<Record<string, string>> = {
  H: 'hrc-hull-1',
  A: 'slp-armour-1',
  t: 'slp-thruster-1',
  W: 'rpo-gun-1',
  T: 'rpo-turret-3',
  d: 'rpo-defense-1',
};

/**
 * A plan as rows of letters, with the bow to the right: the same way the Loft
 * and the flight view draw a hull. `.` is empty. Larger fittings are placed
 * separately, because a letter can only stand for one cell.
 */
function fromPlan(
  id: string,
  name: string,
  rows: readonly string[],
  larger: readonly Placement[] = [],
): Blueprint {
  const placements: Placement[] = [...larger];
  rows.forEach((row, y) => {
    [...row].forEach((letter, x) => {
      const moduleId = ONE_CELL[letter];
      if (moduleId) placements.push({ moduleId, x, y, rotation: 0 });
    });
  });
  return {
    id: `loft-test-${id}`,
    name: `Loft test: ${name}`,
    licence: 'capital-charter',
    placements,
    paint: ['#5B7FA6', '#2E4A6B'],
  };
}

export const LOFT_TESTS: readonly Blueprint[] = [
  fromPlan(
    'staircase',
    'staircase',
    [
      '.....HHW',
      '....HHH.',
      '...HHH..',
      '..HHH...',
      '.HHH....',
      'HHH.....',
    ],
  ),
  fromPlan(
    'outriggers',
    'cells standing out alone',
    [
      '..t...t...',
      '..HHHHHHHW',
      '..t...t...',
    ],
    [{ moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 }, { moduleId: 'slp-engine-1', x: 1, y: 1, rotation: 0 }],
  ),
  fromPlan(
    'hammerhead',
    'a T on a thin stem',
    [
      '.......H.',
      '.......H.',
      '..HHHHHHW',
      '.......H.',
      '.......H.',
    ],
    [{ moduleId: 'slp-engine-1', x: 0, y: 2, rotation: 0 }, { moduleId: 'slp-engine-1', x: 1, y: 2, rotation: 0 }],
  ),
  fromPlan(
    'ring',
    'a hull with a hole in it',
    [
      'HHHHHHH',
      'HH...HHW',
      'HH...HH.',
      'HHHHHHH',
    ],
  ),
  fromPlan(
    'brick',
    'a plain brick',
    [
      '..HHHHHH',
      '..HHHHHHW',
      '..HHHHHHW',
      '..HHHHHH',
    ],
    [
      { moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 0, y: 2, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 1, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 1, y: 2, rotation: 0 },
    ],
  ),
];
