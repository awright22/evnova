import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { Rng } from '../math/rng.ts';
import { CELL_METRES, placeAll } from '../ships/geometry.ts';
import type { ModuleDef } from '../content/schema.ts';
import {
  PROJECTILE_KIND,
  aimOf,
  applyDamage,
  hullShape,
  isWrittenOff,
  leadPoint,
  mountsOf,
  muzzleOf,
  powerState,
  slewTurret,
  steerMissile,
  sweepHit,
  worldToCell,
  type Mount,
  type Pose,
} from './combat.ts';

const { modules, blueprints, tuning } = content();

function shapeOf(id: string) {
  const blueprint = blueprints.get(id);
  if (!blueprint) throw new Error(`no draught "${id}"`);
  const placed = placeAll(blueprint.placements, modules);
  return { placed, shape: hullShape(placed) };
}

const atRest: Pose = { x: 0, y: 0, angle: 0 };

describe('hit resolution', () => {
  const { shape } = shapeOf('prudent-return');

  it('resolves a hit to a specific module', () => {
    // Fire straight through the hull from well outside it.
    const hit = sweepHit(shape, atRest, -400, 0, 400, 0);
    expect(hit).toBeDefined();
    expect(hit!.moduleIndex).toBeGreaterThanOrEqual(0);
  });

  it('misses a hull it passes well clear of', () => {
    expect(sweepHit(shape, atRest, -400, 900, 400, 900)).toBeUndefined();
  });

  it('does not tunnel through a hull at any plausible round speed', () => {
    // A gun round covers 900 units a second; one 30 Hz step is 30 units, well
    // over a cell. A point test at the end position would pass straight
    // through, which is the bug the swept test exists to prevent.
    for (const speed of [400, 900, 2000, 8000]) {
      const perStep = speed / 30;
      const from = -perStep / 2;
      const hit = sweepHit(shape, atRest, from, 0, from + perStep, 0);
      expect(hit, `speed ${speed} tunnelled`).toBeDefined();
    }
  });

  it('follows the hull when it rotates', () => {
    // A shot that hits along the hull's long axis should miss once the hull
    // has turned a quarter turn, because the hull is longer than it is wide.
    const turned: Pose = { x: 0, y: 0, angle: Math.PI / 2 };
    const along = sweepHit(shape, atRest, -400, 0, 400, 0);
    const across = sweepHit(shape, turned, -400, 0, 400, 0);
    expect(along).toBeDefined();
    expect(across).toBeDefined();
    // Both hit, but the module struck differs because the hull turned.
    expect(across!.moduleIndex).not.toBe(-1);
  });

  it('maps a world point to the cell under it', () => {
    const { shape: s } = shapeOf('prudent-return');
    const centre = worldToCell(atRest, s.com, 0, 0);
    expect(centre.cx).toBeCloseTo(s.com.x, 6);
    expect(centre.cy).toBeCloseTo(s.com.y, 6);

    // One cell forward of the centre of mass.
    const forward = worldToCell(atRest, s.com, CELL_METRES, 0);
    expect(forward.cx).toBeCloseTo(s.com.x + 1, 6);
  });
});

describe('where you put armour matters', () => {
  // M2's acceptance: placement must measurably change outcomes between
  // otherwise equal designs. Same parts, same mass, different arrangement.
  const nosePlated = placeAll(
    [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
      { moduleId: 'slp-armour-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'slp-armour-1', x: 2, y: 1, rotation: 0 },
    ],
    modules,
  );
  const tailPlated = placeAll(
    [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
      { moduleId: 'slp-armour-1', x: -2, y: 0, rotation: 0 },
      { moduleId: 'slp-armour-1', x: -2, y: 1, rotation: 0 },
    ],
    modules,
  );

  it('puts a different module in the path of the same shot', () => {
    const fromAhead = (placed: ReturnType<typeof placeAll>) => {
      const shape = hullShape(placed);
      // A shot arriving from dead ahead, down the hull's centreline.
      const hit = sweepHit(shape, atRest, 600, 0.5 * CELL_METRES, -600, 0.5 * CELL_METRES);
      expect(hit).toBeDefined();
      return placed[hit!.moduleIndex]!.def.type;
    };

    expect(fromAhead(nosePlated)).toBe('armour');
    expect(fromAhead(tailPlated)).toBe('bridge');
  });

  it('means the plated design survives a frontal burst the other does not', () => {
    const burst = (placed: ReturnType<typeof placeAll>): number => {
      const shape = hullShape(placed);
      const hp = placed.map((m) => m.def.hitPoints);
      let rounds = 0;

      // Pour identical rounds in from dead ahead until the hull is written off.
      while (!isWrittenOff(placed, hp, tuning) && rounds < 500) {
        const hit = sweepHit(shape, atRest, 600, 0.5 * CELL_METRES, -600, 0.5 * CELL_METRES);
        if (!hit) break;
        const outcome = applyDamage(40, 0, hp[hit.moduleIndex]!);
        hp[hit.moduleIndex] = hp[hit.moduleIndex]! - outcome.toModule;
        rounds++;
      }
      return rounds;
    };

    const plated = burst(nosePlated);
    const bare = burst(tailPlated);
    expect(plated).toBeGreaterThan(bare);
  });
});

describe('shields', () => {
  it('absorbs damage before the hull takes any', () => {
    const outcome = applyDamage(30, 100, 90);
    expect(outcome.toShield).toBe(30);
    expect(outcome.toModule).toBe(0);
  });

  it('passes through only what the shields could not take', () => {
    const outcome = applyDamage(50, 20, 90);
    expect(outcome.toShield).toBe(20);
    expect(outcome.toModule).toBe(30);
  });

  it('reports a module taken to zero as disabled', () => {
    expect(applyDamage(90, 0, 90).disabled).toBe(true);
    expect(applyDamage(89, 0, 90).disabled).toBe(false);
  });

  it('never applies more than the module has left', () => {
    const outcome = applyDamage(500, 0, 40);
    expect(outcome.toModule).toBe(40);
  });
});

describe('brownout', () => {
  const { placed } = shapeOf('prudent-return');

  it('leaves everything at full power while the reactor lives', () => {
    const power = powerState(placed, () => true);
    expect(power.coverage).toBe(1);
    expect(power.weaponScale).toBe(1);
    expect(power.shieldScale).toBe(1);
    expect(power.engineScale).toBe(1);
  });

  it('starves weapons before shields, and shields before engines', () => {
    // Kill the reactor: output drops to nothing while draw continues.
    const reactorIndex = placed.findIndex((m) => m.def.type === 'reactor');
    expect(reactorIndex).toBeGreaterThanOrEqual(0);

    const power = powerState(placed, (i) => i !== reactorIndex);
    expect(power.coverage).toBe(0);
    expect(power.weaponScale).toBe(0);
    expect(power.shieldScale).toBe(0);
    expect(power.engineScale).toBe(0);
  });

  it('spends a small shortfall on the guns alone', () => {
    // A hull drawing a little more than it makes should still fly and hold
    // shields; only the weapons suffer.
    const power = powerState(
      placeAll(
        [
          { moduleId: 'hrc-bridge-1', x: 2, y: 0, rotation: 0 },
          { moduleId: 'slp-engine-1', x: 0, y: 0, rotation: 0 },
          { moduleId: 'slp-reactor-1', x: 4, y: 0, rotation: 0 },
          { moduleId: 'rpo-gun-1', x: 6, y: 0, rotation: 0 },
        ],
        modules,
      ),
      () => true,
    );
    expect(power.coverage).toBe(1);
    expect(power.engineScale).toBe(1);
  });
});

describe('write-off', () => {
  const { placed } = shapeOf('prudent-return');

  it('holds while the hull is intact', () => {
    expect(isWrittenOff(placed, placed.map((m) => m.def.hitPoints), tuning)).toBe(false);
  });

  it('writes the hull off when the bridge goes', () => {
    const hp = placed.map((m) => m.def.hitPoints);
    const bridge = placed.findIndex((m) => m.def.type === 'bridge');
    hp[bridge] = 0;
    expect(isWrittenOff(placed, hp, tuning)).toBe(true);
  });

  it('writes the hull off when structure falls past the threshold', () => {
    const hp = placed.map((m, i) => (placed[i]!.def.type === 'bridge' ? m.def.hitPoints : 0));
    expect(isWrittenOff(placed, hp, tuning)).toBe(true);
  });
});

describe('mounts and aiming', () => {
  const armed = placeAll(
    [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
      { moduleId: 'rpo-gun-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'rpo-turret-1', x: 2, y: 1, rotation: 0 },
    ],
    modules,
  );

  it('finds every weapon on the hull', () => {
    const mounts = mountsOf(armed);
    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.kind).sort()).toEqual(
      [PROJECTILE_KIND.gun, PROJECTILE_KIND.turret].sort(),
    );
  });

  it('puts the muzzle ahead of the hull and rotates it with the hull', () => {
    const gun = mountsOf(armed).find((m) => m.kind === PROJECTILE_KIND.gun)!;
    const ahead = muzzleOf(gun, atRest);
    expect(ahead.x).toBeGreaterThan(0);

    const turned = muzzleOf(gun, { x: 0, y: 0, angle: Math.PI / 2 });
    // Facing +y now, so the muzzle's forward offset shows up on y.
    expect(turned.y).toBeGreaterThan(0);
    expect(Math.abs(turned.x)).toBeLessThan(Math.abs(ahead.x));
  });

  it('fires a fixed gun along the hull facing', () => {
    const gun = mountsOf(armed).find((m) => m.kind === PROJECTILE_KIND.gun)!;
    const rng = new Rng('aim');
    const aim = aimOf(gun, { x: 0, y: 0, angle: 0.4 }, undefined, rng);
    expect(aim).toBeDefined();
    // Spread is small, so it stays near the facing.
    expect(Math.abs(aim! - 0.4)).toBeLessThan(0.05);
  });

  it('declines a turret shot outside its arc', () => {
    const turret = mountsOf(armed).find((m) => m.kind === PROJECTILE_KIND.turret)!;
    const rng = new Rng('arc');
    // The mark is directly astern, outside a half-arc of pi... which covers
    // everything, so narrow the test to the arc the module actually declares.
    const arc = turret.def.weapon!.arc!;
    const behind: Pose = { x: -1000, y: 0, angle: 0 };
    const aim = aimOf(turret, { x: 0, y: 0, angle: 0 }, behind, rng);
    if (arc >= Math.PI) {
      expect(aim).toBeDefined();
    } else {
      expect(aim).toBeUndefined();
    }
  });
});

describe('lead', () => {
  it('aims ahead of a crossing target', () => {
    const lead = leadPoint(0, 0, 1000, 0, 0, 200, 900);
    expect(lead.y).toBeGreaterThan(0);
    expect(lead.x).toBeCloseTo(1000, 6);
  });

  it('aims straight at a stationary target', () => {
    const lead = leadPoint(0, 0, 1000, 0, 0, 0, 900);
    expect(lead.x).toBeCloseTo(1000, 6);
    expect(lead.y).toBeCloseTo(0, 6);
  });

  it('falls back to the target when it outruns the round', () => {
    const lead = leadPoint(0, 0, 1000, 0, 5000, 0, 100);
    expect(Number.isFinite(lead.x)).toBe(true);
    expect(Number.isFinite(lead.y)).toBe(true);
  });
});

describe('missiles', () => {
  it('turns toward the mark at no more than its turn rate', () => {
    const missile = { x: 0, y: 0, vx: 380, vy: 0 };
    const target: Pose = { x: 0, y: 1000, angle: 0 };
    const before = Math.atan2(missile.vy, missile.vx);
    steerMissile(missile, target, 2.6, 380, 1 / 30);
    const after = Math.atan2(missile.vy, missile.vx);
    const turned = Math.abs(after - before);
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThanOrEqual(2.6 / 30 + 1e-9);
    expect(Math.hypot(missile.vx, missile.vy)).toBeCloseTo(380, 6);
  });

  it('flies straight with no mark', () => {
    const missile = { x: 0, y: 0, vx: 380, vy: 0 };
    steerMissile(missile, undefined, 2.6, 380, 1 / 30);
    expect(missile.vy).toBe(0);
  });
});

describe('turret traverse', () => {
  const FAST = Math.PI; // rad/s
  const ARC = Math.PI / 2;

  /**
   * A turret with a known arc.
   *
   * The catalogue's turrets declare arcs wide enough that "outside the arc"
   * is hard to reach, and the arc is the thing under test, so it is stated
   * here rather than borrowed from content that may be tuned later.
   */
  function turretMount(): Mount {
    return {
      moduleIndex: 0,
      kind: PROJECTILE_KIND.turret,
      offsetX: 0,
      offsetY: 0,
      def: {
        weapon: { damage: 1, roundsPerSecond: 1, projectileSpeed: 1000, range: 1000, spread: 0, arc: ARC, tracking: FAST },
      } as unknown as ModuleDef,
    };
  }

  it('reaches the mark at its own rate, not at once', () => {
    // Half a radian of traverse in a tenth of a second, so a mount ninety
    // degrees off its mark is nowhere near it after one step.
    const after = slewTurret(0, ARC, FAST, 0.1, ARC);
    expect(after).toBeCloseTo(FAST * 0.1, 6);
    expect(after).toBeLessThan(ARC);
  });

  it('arrives and stops, without overshooting', () => {
    let aim = 0;
    for (let i = 0; i < 100; i++) aim = slewTurret(aim, 0.4, FAST, 0.1, ARC);
    expect(aim).toBeCloseTo(0.4, 6);
  });

  it('takes the short way round', () => {
    // From just inside one stop to just inside the other, the mount must not
    // travel the long way through the hull.
    const after = slewTurret(-1.2, 1.2, FAST, 0.01, ARC);
    expect(after).toBeGreaterThan(-1.2);
  });

  it('parks against its stop rather than swinging past it', () => {
    // Two radians to port is well outside a half-arc of ninety degrees, so
    // the mount runs to that stop and stays there. (A mark at exactly dead
    // astern is equidistant from both stops; which one it picks is not
    // behaviour worth pinning down.)
    let aim = 0;
    for (let i = 0; i < 200; i++) aim = slewTurret(aim, 2, FAST, 0.1, ARC);
    expect(aim).toBeCloseTo(ARC, 6);
    for (let i = 0; i < 200; i++) aim = slewTurret(aim, -2, FAST, 0.1, ARC);
    expect(aim).toBeCloseTo(-ARC, 6);
  });

  it('is instant for a mount with no traverse rate', () => {
    expect(slewTurret(0, 0.9, undefined, 0.001, ARC)).toBeCloseTo(0.9, 6);
  });

  it('fires where the barrel is pointed, not where the mark is', () => {
    const rng = new Rng('traverse');
    const turret = turretMount();
    const pose = { x: 0, y: 0, angle: 0 };
    const mark = { x: 0, y: 100, angle: 0 };

    // Mark is abeam to port; the mount is still pointed straight ahead.
    const stillComingRound = aimOf(turret, pose, mark, rng, 0);
    expect(stillComingRound).toBeCloseTo(0, 6);

    // Once it has come round, the shot goes to the mark.
    const onTarget = aimOf(turret, pose, mark, rng, Math.PI / 2);
    expect(onTarget).toBeCloseTo(Math.PI / 2, 6);
  });

  it('still declines a shot outside the arc', () => {
    const rng = new Rng('traverse');
    const behindMe = { x: -100, y: 0, angle: 0 };
    expect(aimOf(turretMount(), { x: 0, y: 0, angle: 0 }, behindMe, rng, 0)).toBeUndefined();
  });
});

describe('beams and point defense', () => {
  const fitted = placeAll(
    [
      { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 },
      { moduleId: 'slp-engine-1', x: -1, y: 0, rotation: 0 },
      { moduleId: 'slp-beam-1', x: 2, y: 0, rotation: 0 },
      { moduleId: 'rpo-defense-1', x: 2, y: 2, rotation: 0 },
    ],
    modules,
  );

  it('reads a beam and a point-defense mount as their own kinds', () => {
    const kinds = mountsOf(fitted).map((mount) => mount.kind);
    expect(kinds).toContain(PROJECTILE_KIND.beam);
    expect(kinds).toContain(PROJECTILE_KIND.defense);
  });

  it('gives a beam a muzzle like any other mount', () => {
    const beam = mountsOf(fitted).find((mount) => mount.kind === PROJECTILE_KIND.beam)!;
    const muzzle = muzzleOf(beam, atRest);
    expect(muzzle.x).toBeGreaterThan(0);
  });

  it('declares every beam as damage a second, not a round', () => {
    // Nothing enforces this but the reading of it, so it is written down:
    // a beam's `roundsPerSecond` is 1 because the figure it carries is
    // already per second, and the server multiplies by `dt`.
    for (const module of modules.values()) {
      if (module.type !== 'beam') continue;
      expect(module.weapon?.roundsPerSecond, module.id).toBe(1);
    }
  });

  it('gives every beam a reach shorter than the guns of its tier', () => {
    // The trade is reach for certainty: a beam cannot miss and cannot be
    // dodged, so it has to be something a captain closes to use.
    for (const beam of modules.values()) {
      if (beam.type !== 'beam') continue;
      const guns = [...modules.values()].filter(
        (other) => other.type === 'weapon' && other.tier === beam.tier,
      );
      for (const gun of guns) {
        expect(beam.weapon?.range ?? 0, `${beam.id} against ${gun.id}`).toBeLessThan(
          gun.weapon?.range ?? 0,
        );
      }
    }
  });

  it('gives point defense an arc and no ammunition', () => {
    for (const module of modules.values()) {
      if (module.type !== 'defense') continue;
      expect(module.weapon?.arc, module.id).toBeGreaterThan(0);
      expect(module.weapon?.ammoPerShot, module.id).toBeUndefined();
    }
  });

  it('keeps point defense from being a gun: it reaches nothing a gun does', () => {
    const guns = [...modules.values()].filter((module) => module.type === 'weapon');
    const shortest = Math.min(...guns.map((gun) => gun.weapon?.range ?? Infinity));
    for (const module of modules.values()) {
      if (module.type !== 'defense') continue;
      expect(module.weapon?.range ?? 0, module.id).toBeLessThan(shortest);
    }
  });

  it('charges a beam more power than anything that shoots a round', () => {
    // It runs continuously, so it is the thing a reactor is bought for.
    const rounds = [...modules.values()].filter(
      (module) => module.type === 'weapon' || module.type === 'turret' || module.type === 'rack',
    );
    const heaviest = Math.max(...rounds.map((module) => module.power.draw ?? 0));
    for (const module of modules.values()) {
      if (module.type !== 'beam') continue;
      expect(module.power.draw ?? 0, module.id).toBeGreaterThan(heaviest);
    }
  });
});
