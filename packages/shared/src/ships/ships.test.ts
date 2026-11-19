import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { placeAll } from './geometry.ts';
import { billOfMaterials, deriveStats, hullCost, type Loadout } from './derive.ts';
import { validateDesign } from './validate.ts';

const { tuning, modules, blueprints, licences } = content();

function statsFor(id: string, loadout?: Loadout) {
  const blueprint = blueprints.get(id);
  if (!blueprint) throw new Error(`no blueprint "${id}"`);
  const placed = placeAll(blueprint.placements, modules);
  return { blueprint, placed, stats: deriveStats(placed, tuning, loadout) };
}

describe('content loading', () => {
  it('validates every data file at load', () => {
    expect(modules.size).toBeGreaterThan(0);
    expect(blueprints.size).toBeGreaterThan(0);
    expect(licences.size).toBe(4);
  });
});

describe('shipped designs', () => {
  it.each([...blueprints.keys()])('%s is a valid design', (id) => {
    const { blueprint, placed } = statsFor(id);
    const licence = licences.get(blueprint.licence);
    expect(licence).toBeDefined();

    const result = validateDesign(placed, licence!, tuning);
    if (!result.valid) {
      throw new Error(
        `${id} is invalid:\n${result.problems.map((p) => `  ${p.code}: ${p.message}`).join('\n')}`,
      );
    }
    expect(result.valid).toBe(true);
  });

  it('derives handling that differs noticeably between the three', () => {
    const starter = statsFor('prudent-return').stats.profile;
    const fast = statsFor('force-majeure').stats.profile;
    const hauler = statsFor('fair-wear-and-tear').stats.profile;

    // The interceptor out-accelerates and out-runs the starter.
    expect(fast.thrustAccel).toBeGreaterThan(starter.thrustAccel * 1.4);
    expect(fast.topSpeed).toBeGreaterThan(starter.topSpeed * 1.2);
    expect(fast.maxTurnRate).toBeGreaterThan(starter.maxTurnRate * 1.15);

    // The hauler is slower and markedly less agile than both.
    expect(hauler.thrustAccel).toBeLessThan(starter.thrustAccel);
    expect(hauler.maxTurnRate).toBeLessThan(starter.maxTurnRate * 0.65);
    expect(hauler.maxTurnRate).toBeLessThan(fast.maxTurnRate * 0.5);
  });

  it('makes a full hold fly worse than an empty one', () => {
    const empty = statsFor('fair-wear-and-tear').stats;
    const full = statsFor('fair-wear-and-tear', {
      cargo: empty.cargoCapacity,
      propellant: empty.propellantCapacity,
    }).stats;

    expect(full.totalMass).toBeGreaterThan(empty.totalMass * 1.8);
    expect(full.profile.thrustAccel).toBeLessThan(empty.profile.thrustAccel * 0.6);
    expect(full.profile.topSpeed).toBeLessThan(empty.profile.topSpeed * 0.8);
    // Carried mass sits in the bays, so it raises inertia as well as mass: a
    // full hold turns worse, not only accelerates worse.
    expect(full.profile.maxTurnRate).toBeLessThan(empty.profile.maxTurnRate * 0.8);
    expect(full.momentOfInertia).toBeGreaterThan(empty.momentOfInertia * 1.5);
  });

  it('ignores cargo beyond the hold and Propellant beyond the tanks', () => {
    const honest = statsFor('fair-wear-and-tear', { cargo: 100, propellant: 60 }).stats;
    const absurd = statsFor('fair-wear-and-tear', { cargo: 10_000, propellant: 9_999 }).stats;
    expect(absurd.totalMass).toBe(honest.totalMass);
  });

  it('covers power draw on every shipped design', () => {
    for (const id of blueprints.keys()) {
      const { stats } = statsFor(id);
      expect(stats.powerOutput).toBeGreaterThanOrEqual(stats.powerDraw);
    }
  });

  it('prices every design and bills its materials', () => {
    for (const id of blueprints.keys()) {
      const { placed } = statsFor(id);
      expect(hullCost(placed)).toBeGreaterThan(0);
      const bom = billOfMaterials(placed);
      expect([...bom.values()].every((units) => units > 0)).toBe(true);
    }
  });
});

describe('layout decides handling', () => {
  it('turns faster with thrusters outboard than amidships', () => {
    // Same parts, same mass, different placement: leverage is the whole point.
    const outboard = placeAll(
      [
        { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
        { moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 },
        { moduleId: 'slp-reactor-1', x: 4, y: 0, rotation: 0 },
        { moduleId: 'slp-thruster-1', x: 1, y: -1, rotation: 0 },
        { moduleId: 'slp-thruster-1', x: 1, y: 2, rotation: 0 },
      ],
      modules,
    );
    const amidships = placeAll(
      [
        { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
        { moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 },
        { moduleId: 'slp-reactor-1', x: 4, y: 0, rotation: 0 },
        { moduleId: 'slp-thruster-1', x: 1, y: 0, rotation: 0 },
        { moduleId: 'slp-thruster-1', x: 1, y: 1, rotation: 0 },
      ],
      modules,
    );

    const a = deriveStats(outboard, tuning);
    const b = deriveStats(amidships, tuning);
    expect(a.totalMass).toBe(b.totalMass);
    expect(a.torque).toBeGreaterThan(b.torque);
    expect(a.profile.maxTurnRate).toBeGreaterThan(b.profile.maxTurnRate);
  });

  it('turns slower when the same mass is spread further out', () => {
    const compact = placeAll(
      [
        { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
        { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
        { moduleId: 'slp-armour-1', x: 2, y: 0, rotation: 0 },
        { moduleId: 'slp-armour-1', x: 2, y: 1, rotation: 0 },
      ],
      modules,
    );
    const spread = placeAll(
      [
        { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
        { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
        { moduleId: 'slp-armour-1', x: 6, y: 0, rotation: 0 },
        { moduleId: 'slp-armour-1', x: 6, y: 1, rotation: 0 },
      ],
      modules,
    );

    expect(deriveStats(spread, tuning).momentOfInertia).toBeGreaterThan(
      deriveStats(compact, tuning).momentOfInertia,
    );
  });
});

describe('validation catches broken designs', () => {
  const licence = licences.get('open-ticket')!;
  const check = (placements: Parameters<typeof placeAll>[0]) =>
    validateDesign(placeAll(placements, modules), licence, tuning);

  it('rejects a design with no bridge', () => {
    const result = check([{ moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 }]);
    expect(result.problems.map((p) => p.code)).toContain('no-bridge');
  });

  it('rejects two bridges', () => {
    const result = check([
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
    ]);
    expect(result.problems.map((p) => p.code)).toContain('many-bridges');
  });

  it('rejects a design with no engine', () => {
    const result = check([{ moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 }]);
    expect(result.problems.map((p) => p.code)).toContain('no-engine');
  });

  it('rejects overlapping fittings', () => {
    const result = check([
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-reactor-1', x: 1, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
    ]);
    expect(result.problems.map((p) => p.code)).toContain('overlap');
  });

  it('rejects a design that floats apart', () => {
    const result = check([
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
      { moduleId: 'slp-armour-1', x: 9, y: 9, rotation: 0 },
    ]);
    expect(result.problems.map((p) => p.code)).toContain('disconnected');
  });

  it('rejects a design whose reactors cannot cover the draw', () => {
    const result = check([
      { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 0, y: 2, rotation: 0 },
      { moduleId: 'hrc-hull-1', x: 1, y: 0, rotation: 0 },
      { moduleId: 'hrc-hull-1', x: 1, y: 1, rotation: 0 },
      { moduleId: 'hrc-hull-1', x: 1, y: 2, rotation: 0 },
      { moduleId: 'rpo-shield-1', x: 2, y: 2, rotation: 0 },
    ]);
    expect(result.problems.map((p) => p.code)).toContain('power-short');
  });

  it('rejects an engine firing into the hull', () => {
    const result = check([
      { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'slp-reactor-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: 4, y: 0, rotation: 0 },
    ]);
    expect(result.problems.map((p) => p.code)).toContain('engine-blocked');
  });

  it('rejects a design beyond the licence extent', () => {
    const placements = [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 as const },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 as const },
    ];
    for (let x = 2; x < 12; x++) {
      placements.push({ moduleId: 'hrc-hull-1', x, y: 0, rotation: 0 as const });
    }
    const result = check(placements);
    expect(result.problems.map((p) => p.code)).toContain('too-large');
  });
});

describe('rotation', () => {
  it('swaps the footprint on a quarter turn', () => {
    const upright = placeAll([{ moduleId: 'hrc-tank-1', x: 0, y: 0, rotation: 0 }], modules)[0]!;
    const turned = placeAll([{ moduleId: 'hrc-tank-1', x: 0, y: 0, rotation: 90 }], modules)[0]!;
    expect([upright.width, upright.height]).toEqual([1, 2]);
    expect([turned.width, turned.height]).toEqual([2, 1]);
  });
});
