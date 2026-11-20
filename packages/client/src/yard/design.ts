/**
 * The editor's state, as a reducer.
 *
 * Placement, rotation, mirroring, undo and redo, copy and paste. Kept apart
 * from the view because it is the part with rules: a design is a set of
 * modules on a grid, and every edit has to leave it a set of modules on a
 * grid. It is pure, so it can be tested without a browser.
 *
 * History is whole snapshots rather than inverse operations. A design is a
 * few dozen small objects; storing the lot is cheaper to reason about than
 * undoing a mirror, and an editor that gets undo wrong is worse than one
 * without it.
 */

import type { ModuleDef, Placement, Rotation } from '@marque/shared';
import { rotatedFootprint } from '@marque/shared';

export interface DesignState {
  readonly placements: readonly Placement[];
  /** Indices of the modules currently selected, for rotate, copy and delete. */
  readonly selection: readonly number[];
  /** What the clipboard holds, relative to its own top-left. */
  readonly clipboard: readonly Placement[];
  /** Mirror new placements across the hull's centre line. */
  readonly mirror: boolean;
  readonly past: readonly (readonly Placement[])[];
  readonly future: readonly (readonly Placement[])[];
}

export type DesignAction =
  | { kind: 'place'; placement: Placement; def: ModuleDef }
  | { kind: 'remove'; indices: readonly number[] }
  | { kind: 'move'; indices: readonly number[]; dx: number; dy: number }
  | { kind: 'rotate'; indices: readonly number[] }
  | { kind: 'select'; indices: readonly number[] }
  | { kind: 'copy' }
  | { kind: 'paste'; at: { x: number; y: number } }
  | { kind: 'mirror'; on: boolean }
  | { kind: 'load'; placements: readonly Placement[] }
  | { kind: 'undo' }
  | { kind: 'redo' };

/** How many steps back an editor remembers. */
const HISTORY_DEPTH = 60;

export function emptyDesign(placements: readonly Placement[] = []): DesignState {
  return {
    placements,
    selection: [],
    clipboard: [],
    mirror: false,
    past: [],
    future: [],
  };
}

/** Push the current design onto the history and clear the redo stack. */
function remember(state: DesignState, next: readonly Placement[]): DesignState {
  return {
    ...state,
    placements: next,
    past: [...state.past, state.placements].slice(-HISTORY_DEPTH),
    future: [],
  };
}

/** The cells a placement covers, as `x,y` keys. */
export function cellsCovered(placement: Placement, def: ModuleDef): string[] {
  const { width, height } = rotatedFootprint(def, placement.rotation);
  const cells: string[] = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) cells.push(`${placement.x + dx},${placement.y + dy}`);
  }
  return cells;
}

/** Whether a placement would sit on top of anything already there. */
function collides(
  placements: readonly Placement[],
  defs: ReadonlyMap<string, ModuleDef>,
  candidate: Placement,
  candidateDef: ModuleDef,
  ignoring: ReadonlySet<number> = new Set(),
): boolean {
  const taken = new Set<string>();
  placements.forEach((placement, index) => {
    if (ignoring.has(index)) return;
    const def = defs.get(placement.moduleId);
    if (def) for (const cell of cellsCovered(placement, def)) taken.add(cell);
  });

  return cellsCovered(candidate, candidateDef).some((cell) => taken.has(cell));
}

/**
 * The mirror of a placement across the hull's centre line.
 *
 * The centre line runs down x = 0, so a module at x spans x..x+w-1 and its
 * mirror spans -(x+w-1)..-x. A module straddling the line is its own mirror
 * and is placed once.
 */
function mirrored(placement: Placement, def: ModuleDef): Placement | undefined {
  const { width } = rotatedFootprint(def, placement.rotation);
  const x = -(placement.x + width - 1);
  if (x === placement.x) return undefined;
  return { ...placement, x };
}

const TURNS: readonly Rotation[] = [0, 90, 180, 270];

export function designReducer(
  state: DesignState,
  action: DesignAction,
  defs: ReadonlyMap<string, ModuleDef>,
): DesignState {
  switch (action.kind) {
    case 'place': {
      if (collides(state.placements, defs, action.placement, action.def)) return state;

      const added: Placement[] = [action.placement];
      if (state.mirror) {
        const twin = mirrored(action.placement, action.def);
        // Only if the mirror has somewhere to go: a design is not improved by
        // half a symmetric pair.
        if (twin && !collides([...state.placements, action.placement], defs, twin, action.def)) {
          added.push(twin);
        }
      }

      return remember(state, [...state.placements, ...added]);
    }

    case 'remove': {
      if (action.indices.length === 0) return state;
      const drop = new Set(action.indices);
      const next = state.placements.filter((_, index) => !drop.has(index));
      return { ...remember(state, next), selection: [] };
    }

    case 'move': {
      if (action.indices.length === 0) return state;
      const moving = new Set(action.indices);

      const next = state.placements.map((placement, index) =>
        moving.has(index)
          ? { ...placement, x: placement.x + action.dx, y: placement.y + action.dy }
          : placement,
      );

      // All or nothing: a selection that would land on something stays put,
      // rather than half of it moving.
      for (const index of action.indices) {
        const placement = next[index]!;
        const def = defs.get(placement.moduleId);
        if (!def) continue;
        if (collides(next, defs, placement, def, moving)) return state;
      }

      return remember(state, next);
    }

    case 'rotate': {
      if (action.indices.length === 0) return state;
      const turning = new Set(action.indices);

      const next = state.placements.map((placement, index) => {
        if (!turning.has(index)) return placement;
        const turn = TURNS[(TURNS.indexOf(placement.rotation) + 1) % TURNS.length]!;
        return { ...placement, rotation: turn };
      });

      for (const index of action.indices) {
        const placement = next[index]!;
        const def = defs.get(placement.moduleId);
        if (!def) continue;
        if (collides(next, defs, placement, def, turning)) return state;
      }

      return remember(state, next);
    }

    case 'select':
      return { ...state, selection: [...action.indices] };

    case 'copy': {
      const picked = state.selection
        .map((index) => state.placements[index])
        .filter((placement): placement is Placement => placement !== undefined);
      if (picked.length === 0) return state;

      // Relative to the selection's own corner, so a paste lands where the
      // captain points rather than where it was cut from.
      const left = Math.min(...picked.map((placement) => placement.x));
      const top = Math.min(...picked.map((placement) => placement.y));

      return {
        ...state,
        clipboard: picked.map((placement) => ({
          ...placement,
          x: placement.x - left,
          y: placement.y - top,
        })),
      };
    }

    case 'paste': {
      if (state.clipboard.length === 0) return state;

      const landing = state.clipboard.map((placement) => ({
        ...placement,
        x: placement.x + action.at.x,
        y: placement.y + action.at.y,
      }));

      // Refuse the whole paste if any of it would overlap: a half-pasted
      // selection is never what was meant.
      const running = [...state.placements];
      for (const placement of landing) {
        const def = defs.get(placement.moduleId);
        if (!def) return state;
        if (collides(running, defs, placement, def)) return state;
        running.push(placement);
      }

      return { ...remember(state, running), selection: [] };
    }

    case 'mirror':
      return { ...state, mirror: action.on };

    case 'load':
      return { ...emptyDesign(action.placements), mirror: state.mirror };

    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        placements: previous,
        past: state.past.slice(0, -1),
        future: [state.placements, ...state.future].slice(0, HISTORY_DEPTH),
        selection: [],
      };
    }

    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        placements: next,
        past: [...state.past, state.placements].slice(-HISTORY_DEPTH),
        future: state.future.slice(1),
        selection: [],
      };
    }

    default:
      return state;
  }
}
