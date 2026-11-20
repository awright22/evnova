/**
 * Blueprint validation.
 *
 * The editor shows these problems on the grid where they occur, and the server
 * runs the same function before it will build anything, so a design posted
 * straight to the server is held to exactly what the interface showed.
 */

import type { LicenceDef, Placement, Tuning } from '../content/schema.ts';
import {
  boundsOf,
  hasClearLane,
  isConnected,
  occupancy,
  overlaps,
  type PlacedModule,
} from './geometry.ts';

export type ProblemCode =
  | 'no-bridge'
  | 'many-bridges'
  | 'no-engine'
  | 'overlap'
  | 'disconnected'
  | 'power-short'
  | 'engine-blocked'
  | 'weapon-blocked'
  | 'too-many-modules'
  | 'too-large'
  /** The design is sound; this berth simply does not sell the fitting. */
  | 'not-stocked';

export interface Problem {
  readonly code: ProblemCode;
  /** One sentence, in the game's voice, shown next to the offending cells. */
  readonly message: string;
  /** Placements this problem points at, by index, for highlighting on the grid. */
  readonly placements: readonly number[];
  /** Cells to highlight, as `x,y` keys, when the problem is about empty space. */
  readonly cells?: readonly string[];
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly problems: readonly Problem[];
}

/**
 * Check a design against every rule in spec section 7.
 *
 * Returns every problem rather than the first, because the editor shows them
 * all at once and a captain fixing one should not discover the next by
 * surprise.
 */
export function validateDesign(
  modules: readonly PlacedModule[],
  licence: LicenceDef,
  tuning: Tuning,
): ValidationResult {
  const problems: Problem[] = [];

  const indicesOfType = (type: string): number[] =>
    modules.flatMap((module, index) => (module.def.type === type ? [index] : []));

  // --- Exactly one bridge ------------------------------------------------
  const bridges = indicesOfType('bridge');
  if (bridges.length === 0) {
    problems.push({
      code: 'no-bridge',
      message: 'A hull needs a bridge. Nothing here can be flown.',
      placements: [],
    });
  } else if (bridges.length > 1) {
    problems.push({
      code: 'many-bridges',
      message: 'A hull carries one bridge. Remove the others.',
      placements: bridges,
    });
  }

  // --- At least one engine ----------------------------------------------
  const engines = indicesOfType('engine');
  if (engines.length === 0) {
    problems.push({
      code: 'no-engine',
      message: 'No engine. The hull will not move under its own power.',
      placements: [],
    });
  }

  // --- No two modules in the same cell -----------------------------------
  const clashes = overlaps(modules);
  if (clashes.length > 0) {
    const offenders = modules.flatMap((module, index) => {
      const cells = new Set(occupancyCellsOf(module));
      return clashes.some((cell) => cells.has(cell)) ? [index] : [];
    });
    problems.push({
      code: 'overlap',
      message: 'Two fittings claim the same space.',
      placements: offenders,
      cells: clashes,
    });
  }

  // --- Every module joined edge to edge ----------------------------------
  if (clashes.length === 0 && !isConnected(modules)) {
    problems.push({
      code: 'disconnected',
      message: 'Every fitting must join the hull edge to edge. Part of this design floats free.',
      placements: [],
    });
  }

  // --- Power covered ------------------------------------------------------
  let output = 0;
  let draw = 0;
  for (const module of modules) {
    output += module.def.power.output ?? 0;
    draw += module.def.power.draw ?? 0;
  }
  if (draw > output) {
    problems.push({
      code: 'power-short',
      message: `Reactors cover ${output} of ${draw} units of draw. Fit more reactor, or less of everything else.`,
      placements: indicesOfType('reactor'),
    });
  }

  // --- Clear lanes --------------------------------------------------------
  if (clashes.length === 0) {
    const cells = occupancy(modules);
    const bounds = boundsOf(modules);

    const blockedEngines = engines.filter(
      (index) => !hasClearLane(modules[index]!, modules, -1, cells, bounds),
    );
    if (blockedEngines.length > 0) {
      problems.push({
        code: 'engine-blocked',
        message: 'An engine is firing into the hull. Clear the lane astern of it.',
        placements: blockedEngines,
      });
    }

    const weapons = indicesOfType('weapon');
    const blockedWeapons = weapons.filter(
      (index) => !hasClearLane(modules[index]!, modules, 1, cells, bounds),
    );
    if (blockedWeapons.length > 0) {
      problems.push({
        code: 'weapon-blocked',
        message: 'A fixed mount is pointed into the hull. Clear the lane ahead of it.',
        placements: blockedWeapons,
      });
    }
  }

  // --- Within the licence -------------------------------------------------
  if (modules.length > licence.maxModules) {
    problems.push({
      code: 'too-many-modules',
      message: `${licence.name} covers ${licence.maxModules} fittings. This design has ${modules.length}.`,
      placements: [],
    });
  }

  const bounds = boundsOf(modules);
  const extent = Math.max(bounds.width, bounds.height);
  if (extent > licence.maxExtent) {
    problems.push({
      code: 'too-large',
      message: `${licence.name} covers ${licence.maxExtent} cells across. This design spans ${extent}.`,
      placements: [],
    });
  }

  void tuning;
  return { valid: problems.length === 0, problems };
}

function occupancyCellsOf(module: PlacedModule): string[] {
  const cells: string[] = [];
  for (let dx = 0; dx < module.width; dx++) {
    for (let dy = 0; dy < module.height; dy++) {
      cells.push(`${module.placement.x + dx},${module.placement.y + dy}`);
    }
  }
  return cells;
}

/** Placements that reference a module the catalogue does not have. */
export function unknownModules(
  placements: readonly Placement[],
  catalogue: ReadonlySet<string>,
): string[] {
  return [...new Set(placements.map((p) => p.moduleId).filter((id) => !catalogue.has(id)))];
}
