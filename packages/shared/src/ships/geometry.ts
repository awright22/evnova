/**
 * Grid geometry for ship blueprints.
 *
 * The grid is the ship: it is the hitbox, the mass distribution and the thing
 * the renderer draws. `x` grows forward toward the nose and `y` grows to
 * starboard, so the lane astern of a module is the cells at lower `x` in its
 * own rows, and the lane ahead is the cells at higher `x`.
 *
 * Everything here is pure and works in grid cells. One cell is `CELL_METRES`
 * across in world units.
 */

import type { ModuleDef, Placement, Rotation } from '../content/schema.ts';

/**
 * World units across one grid cell.
 *
 * Sets the scale of everything: a six-cell shuttle is 36 units long, which at
 * the flight view's two pixels per unit reads as a 72px hull, and a ship at its
 * top speed crosses the screen in about three seconds.
 */
export const CELL_METRES = 6;

/** A module placed on the grid, resolved against its definition. */
export interface PlacedModule {
  readonly placement: Placement;
  readonly def: ModuleDef;
  /** Footprint after rotation. */
  readonly width: number;
  readonly height: number;
  /** Centre of the footprint, in cell coordinates. */
  readonly centreX: number;
  readonly centreY: number;
}

/** Footprint after a quarter-turn. 90 and 270 swap the axes. */
export function rotatedFootprint(
  def: ModuleDef,
  rotation: Rotation,
): { width: number; height: number } {
  const swap = rotation === 90 || rotation === 270;
  return swap
    ? { width: def.footprint.height, height: def.footprint.width }
    : { width: def.footprint.width, height: def.footprint.height };
}

export function placeModule(placement: Placement, def: ModuleDef): PlacedModule {
  const { width, height } = rotatedFootprint(def, placement.rotation);
  return {
    placement,
    def,
    width,
    height,
    centreX: placement.x + width / 2,
    centreY: placement.y + height / 2,
  };
}

/** Resolve every placement against the catalogue. Throws on an unknown id. */
export function placeAll(
  placements: readonly Placement[],
  catalogue: ReadonlyMap<string, ModuleDef>,
): PlacedModule[] {
  return placements.map((placement) => {
    const def = catalogue.get(placement.moduleId);
    if (!def) throw new Error(`unknown module "${placement.moduleId}"`);
    return placeModule(placement, def);
  });
}

/** Every cell a module occupies, as packed `x,y` keys. */
export function cellsOf(module: PlacedModule): string[] {
  const cells: string[] = [];
  for (let dx = 0; dx < module.width; dx++) {
    for (let dy = 0; dy < module.height; dy++) {
      cells.push(cellKey(module.placement.x + dx, module.placement.y + dy));
    }
  }
  return cells;
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Map of occupied cell to the index of the module occupying it. */
export function occupancy(modules: readonly PlacedModule[]): Map<string, number> {
  const map = new Map<string, number>();
  modules.forEach((module, index) => {
    for (const cell of cellsOf(module)) map.set(cell, index);
  });
  return map;
}

/** Cells claimed by more than one module. */
export function overlaps(modules: readonly PlacedModule[]): string[] {
  const seen = new Set<string>();
  const clashes = new Set<string>();
  for (const module of modules) {
    for (const cell of cellsOf(module)) {
      if (seen.has(cell)) clashes.add(cell);
      seen.add(cell);
    }
  }
  return [...clashes];
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Cells spanned along each axis. */
  readonly width: number;
  readonly height: number;
}

export function boundsOf(modules: readonly PlacedModule[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const module of modules) {
    minX = Math.min(minX, module.placement.x);
    minY = Math.min(minY, module.placement.y);
    maxX = Math.max(maxX, module.placement.x + module.width);
    maxY = Math.max(maxY, module.placement.y + module.height);
  }

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Centre of mass in cell coordinates.
 *
 * Only intact modules should be passed when deriving a damaged ship's stats:
 * losing an outboard armour plate genuinely moves the balance point.
 */
export function centreOfMass(
  modules: readonly PlacedModule[],
  massOf: MassOf = (module) => module.def.mass,
): { x: number; y: number } {
  let mass = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < modules.length; i++) {
    const module = modules[i]!;
    const m = massOf(module, i);
    mass += m;
    x += m * module.centreX;
    y += m * module.centreY;
  }
  if (mass === 0) return { x: 0, y: 0 };
  return { x: x / mass, y: y / mass };
}

/**
 * Effective mass of a module, which is its own mass plus its share of whatever
 * it is carrying. A loaded bay is heavier than an empty one, and sits in the
 * same place, so cargo changes both the balance point and the inertia.
 */
export type MassOf = (module: PlacedModule, index: number) => number;

/**
 * Moment of inertia about the centre of mass, in cell units.
 *
 * Each module contributes its own inertia as a rectangular plate plus the
 * parallel-axis term for its distance from the balance point. That is what
 * makes a long ship turn slowly and a compact one snap around.
 */
export function momentOfInertia(
  modules: readonly PlacedModule[],
  com: { x: number; y: number },
  massOf: MassOf = (module) => module.def.mass,
): number {
  let total = 0;
  for (let i = 0; i < modules.length; i++) {
    const module = modules[i]!;
    const m = massOf(module, i);
    const dx = module.centreX - com.x;
    const dy = module.centreY - com.y;
    const own = (m * (module.width * module.width + module.height * module.height)) / 12;
    total += m * (dx * dx + dy * dy) + own;
  }
  return total;
}

/** Distance from the centre of mass to a module's centre, in cells. */
export function leverArm(module: PlacedModule, com: { x: number; y: number }): number {
  return Math.hypot(module.centreX - com.x, module.centreY - com.y);
}

/** True when every module is reachable from the first by edge adjacency. */
export function isConnected(modules: readonly PlacedModule[]): boolean {
  if (modules.length <= 1) return true;

  const cells = occupancy(modules);
  const firstCell = cellsOf(modules[0]!)[0];
  if (firstCell === undefined) return false;

  const seen = new Set<string>([firstCell]);
  const queue = [firstCell];
  const reached = new Set<number>();

  while (queue.length > 0) {
    const key = queue.pop()!;
    const index = cells.get(key);
    if (index !== undefined) reached.add(index);

    const [xs, ys] = key.split(',');
    const x = Number(xs);
    const y = Number(ys);
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      const next = cellKey(nx, ny);
      if (cells.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return reached.size === modules.length;
}

/**
 * True when nothing blocks the given module's exhaust or line of fire.
 *
 * `direction` is -1 for the lane astern (engines) and +1 for the lane ahead
 * (fixed weapons). The lane runs from the module's face to the edge of the
 * ship's bounding box, across every row the module occupies.
 */
export function hasClearLane(
  module: PlacedModule,
  modules: readonly PlacedModule[],
  direction: -1 | 1,
  cells = occupancy(modules),
  bounds = boundsOf(modules),
): boolean {
  const from = direction === -1 ? bounds.minX : module.placement.x + module.width;
  const to = direction === -1 ? module.placement.x : bounds.maxX;

  for (let y = module.placement.y; y < module.placement.y + module.height; y++) {
    for (let x = from; x < to; x++) {
      if (cells.has(cellKey(x, y))) return false;
    }
  }
  return true;
}
