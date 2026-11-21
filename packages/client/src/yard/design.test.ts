import { describe, expect, it } from 'vitest';

import { content, type ModuleDef, type Placement } from '@marque/shared';

import { cellsCovered, designReducer, emptyDesign, type DesignState } from './design.ts';

const { modules } = content();

const HULL = modules.get('hrc-hull-1')!;
const BRIDGE = modules.get('hrc-bridge-1')!;

function at(def: ModuleDef, x: number, y: number, rotation: 0 | 90 | 180 | 270 = 0): Placement {
  return { moduleId: def.id, x, y, rotation };
}

/** Apply a run of actions, which is how the editor actually drives this. */
function run(state: DesignState, ...actions: Parameters<typeof designReducer>[1][]): DesignState {
  return actions.reduce((current, action) => designReducer(current, action, modules), state);
}

describe('the editor´s design state', () => {
  it('places a module', () => {
    const next = run(emptyDesign(), { kind: 'place', placement: at(HULL, 0, 0), def: HULL });
    expect(next.placements).toHaveLength(1);
  });

  it('refuses to stack one module on another', () => {
    const one = run(emptyDesign(), { kind: 'place', placement: at(HULL, 0, 0), def: HULL });
    const two = run(one, { kind: 'place', placement: at(HULL, 0, 0), def: HULL });

    expect(two.placements).toHaveLength(1);
    expect(two).toBe(one);
  });

  it('turns a mirrored wedge, nose or fin so its twin draws the mirror image', () => {
    const wedge = modules.get('hrc-wedge-1')!;
    const nose = modules.get('hrc-nose-1')!;
    const next = run(
      emptyDesign(),
      { kind: 'mirror', on: true },
      { kind: 'place', placement: at(wedge, 2, 0, 0), def: wedge },
      { kind: 'place', placement: at(nose, 3, 2, 0), def: nose },
    );
    // Raked fore-port on one side is raked aft-port on the other; a prow
    // pointing forward points aft.
    expect(next.placements).toContainEqual(at(wedge, -2, 0, 270));
    expect(next.placements).toContainEqual(at(nose, -3, 2, 180));
  });

  it('places a mirrored twin when mirroring is on', () => {
    const next = run(
      emptyDesign(),
      { kind: 'mirror', on: true },
      { kind: 'place', placement: at(HULL, 2, 0), def: HULL },
    );

    expect(next.placements).toHaveLength(2);
    const xs = next.placements.map((placement) => placement.x).sort((a, b) => a - b);
    // A 1-wide module at x=2 mirrors to x=-2.
    expect(xs).toEqual([-2, 2]);
  });

  it('places once when a module straddles the centre line', () => {
    const next = run(
      emptyDesign(),
      { kind: 'mirror', on: true },
      // A bridge is wider than one cell; placed across x=0 it is its own twin.
      { kind: 'place', placement: at(BRIDGE, -1, 0), def: BRIDGE },
    );

    expect(next.placements).toHaveLength(1);
  });

  it('moves a selection, or none of it', () => {
    const two = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 0, 0), def: HULL },
      { kind: 'place', placement: at(HULL, 1, 0), def: HULL },
    );

    const moved = run(two, { kind: 'move', indices: [0], dx: 0, dy: 3 });
    expect(moved.placements[0]!.y).toBe(3);

    // Onto its neighbour: refused, and nothing moves.
    const blocked = run(two, { kind: 'move', indices: [0], dx: 1, dy: 0 });
    expect(blocked).toBe(two);
  });

  it('rotates a selection unless the turn would overlap', () => {
    const wide = modules.get('slp-engine-3') ?? BRIDGE;
    const one = run(emptyDesign(), { kind: 'place', placement: at(wide, 0, 0), def: wide });

    const turned = run(one, { kind: 'rotate', indices: [0] });
    expect(turned.placements[0]!.rotation).toBe(90);
  });

  it('copies relative to the selection and pastes where it is pointed', () => {
    const built = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 5, 5), def: HULL },
      { kind: 'place', placement: at(HULL, 6, 5), def: HULL },
      { kind: 'select', indices: [0, 1] },
      { kind: 'copy' },
    );

    expect(built.clipboard).toHaveLength(2);
    expect(Math.min(...built.clipboard.map((p) => p.x))).toBe(0);

    const pasted = run(built, { kind: 'paste', at: { x: 0, y: 0 } });
    expect(pasted.placements).toHaveLength(4);
    expect(pasted.placements.some((p) => p.x === 0 && p.y === 0)).toBe(true);
  });

  it('refuses a paste that would land on anything, whole', () => {
    const built = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 0, 0), def: HULL },
      { kind: 'select', indices: [0] },
      { kind: 'copy' },
    );

    const onto = run(built, { kind: 'paste', at: { x: 0, y: 0 } });
    expect(onto.placements).toHaveLength(1);
  });

  it('undoes and redoes an edit', () => {
    const one = run(emptyDesign(), { kind: 'place', placement: at(HULL, 0, 0), def: HULL });
    const two = run(one, { kind: 'place', placement: at(HULL, 2, 0), def: HULL });

    const back = run(two, { kind: 'undo' });
    expect(back.placements).toHaveLength(1);

    const forward = run(back, { kind: 'redo' });
    expect(forward.placements).toHaveLength(2);
  });

  it('undoes nothing when there is nothing to undo', () => {
    const blank = emptyDesign();
    expect(run(blank, { kind: 'undo' })).toBe(blank);
    expect(run(blank, { kind: 'redo' })).toBe(blank);
  });

  it('drops the redo stack once a new edit is made', () => {
    const two = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 0, 0), def: HULL },
      { kind: 'place', placement: at(HULL, 2, 0), def: HULL },
      { kind: 'undo' },
    );
    expect(two.future).toHaveLength(1);

    const diverged = run(two, { kind: 'place', placement: at(HULL, 4, 0), def: HULL });
    expect(diverged.future).toHaveLength(0);
  });

  it('removes a selection and clears it', () => {
    const next = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 0, 0), def: HULL },
      { kind: 'place', placement: at(HULL, 2, 0), def: HULL },
      { kind: 'select', indices: [0] },
      { kind: 'remove', indices: [0] },
    );

    expect(next.placements).toHaveLength(1);
    expect(next.selection).toHaveLength(0);
    expect(next.placements[0]!.x).toBe(2);
  });

  it('loads a design and forgets the history with it', () => {
    const edited = run(
      emptyDesign(),
      { kind: 'place', placement: at(HULL, 0, 0), def: HULL },
      { kind: 'place', placement: at(HULL, 2, 0), def: HULL },
    );

    const loaded = run(edited, { kind: 'load', placements: [at(BRIDGE, 0, 0)] });

    expect(loaded.placements).toHaveLength(1);
    // Undoing past a load would take a captain back into a draught they had
    // already left, which is not what undo means.
    expect(loaded.past).toHaveLength(0);
    expect(run(loaded, { kind: 'undo' })).toBe(loaded);
  });

  it('knows which cells a placement covers, turned or not', () => {
    const upright = cellsCovered(at(BRIDGE, 0, 0), BRIDGE);
    const turned = cellsCovered(at(BRIDGE, 0, 0, 90), BRIDGE);

    expect(upright).toHaveLength(BRIDGE.footprint.width * BRIDGE.footprint.height);
    expect(turned).toHaveLength(upright.length);
    if (BRIDGE.footprint.width !== BRIDGE.footprint.height) {
      expect(turned).not.toEqual(upright);
    }
  });
});
