/**
 * Combat simulation.
 *
 * Shared because the server resolves it and the client predicts parts of it.
 * Deterministic throughout: randomness comes from a seeded generator and time
 * arrives as a step timing, so a soak run reproduces a fight exactly.
 *
 * The module grid is the hitbox. A round that gets through the shields is
 * resolved to the specific module it struck, which is what makes where you
 * put your armour matter.
 */

import { clamp, wrapAngle } from '../math/scalar.ts';
import type { Rng } from '../math/rng.ts';
import type { ModuleDef, Tuning } from '../content/schema.ts';
import {
  CELL_METRES,
  cellKey,
  centreOfMass,
  type PlacedModule,
} from '../ships/geometry.ts';

/** How a weapon's rounds behave, resolved from the module that fired them. */
export const PROJECTILE_KIND = {
  gun: 0,
  turret: 1,
  missile: 2,
} as const;

export type ProjectileKind = (typeof PROJECTILE_KIND)[keyof typeof PROJECTILE_KIND];

/** Minimal shape of a hull, for functions that only need its pose. */
export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/**
 * Transform a world point into a hull's grid coordinates, in cells.
 *
 * The hull's world position is its centre of mass, which is also where the
 * sprite is anchored and what it rotates about, so the three agree by
 * construction.
 */
export function worldToCell(
  pose: Pose,
  com: { x: number; y: number },
  worldX: number,
  worldY: number,
): { cx: number; cy: number } {
  const dx = worldX - pose.x;
  const dy = worldY - pose.y;
  const cos = Math.cos(-pose.angle);
  const sin = Math.sin(-pose.angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return {
    cx: localX / CELL_METRES + com.x,
    cy: localY / CELL_METRES + com.y,
  };
}

/** Hull radius in world units: the furthest any cell sits from the centre of mass. */
export function hullRadius(modules: readonly PlacedModule[], com: { x: number; y: number }): number {
  let worst = 0;
  for (const module of modules) {
    // The far corner of the footprint, which is what a round can clip.
    for (const [ox, oy] of [
      [0, 0],
      [module.width, 0],
      [0, module.height],
      [module.width, module.height],
    ] as const) {
      const dx = module.placement.x + ox - com.x;
      const dy = module.placement.y + oy - com.y;
      worst = Math.max(worst, Math.hypot(dx, dy));
    }
  }
  return worst * CELL_METRES;
}

/** Everything about a hull that hit resolution needs, derived once. */
export interface HullShape {
  readonly modules: readonly PlacedModule[];
  readonly com: { x: number; y: number };
  /** Cell key to placement index. */
  readonly cells: ReadonlyMap<string, number>;
  readonly radius: number;
}

export function hullShape(modules: readonly PlacedModule[]): HullShape {
  const com = centreOfMass(modules);
  const cells = new Map<string, number>();
  modules.forEach((module, index) => {
    for (let dx = 0; dx < module.width; dx++) {
      for (let dy = 0; dy < module.height; dy++) {
        cells.set(cellKey(module.placement.x + dx, module.placement.y + dy), index);
      }
    }
  });
  return { modules, com, cells, radius: hullRadius(modules, com) };
}

export interface HitResult {
  /** Index of the placement that was struck. */
  readonly moduleIndex: number;
  /** Fraction along the swept segment where the hit occurred, 0..1. */
  readonly t: number;
  readonly worldX: number;
  readonly worldY: number;
}

/**
 * Sweep a round's path against a hull.
 *
 * A fast round moves further in one step than a module is wide, so a point
 * test at the end position tunnels straight through. This walks the segment at
 * sub-cell resolution and returns the first cell it enters, which is the
 * module it struck.
 */
export function sweepHit(
  shape: HullShape,
  pose: Pose,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): HitResult | undefined {
  // Broadphase: does the segment come near the hull at all?
  if (!segmentNearPoint(fromX, fromY, toX, toY, pose.x, pose.y, shape.radius)) {
    return undefined;
  }

  const start = worldToCell(pose, shape.com, fromX, fromY);
  const end = worldToCell(pose, shape.com, toX, toY);

  const spanX = end.cx - start.cx;
  const spanY = end.cy - start.cy;
  const span = Math.hypot(spanX, spanY);

  // Half-cell steps: fine enough that a round cannot pass through a 1x1
  // module, cheap enough to run for every round against every nearby hull.
  const steps = Math.max(1, Math.ceil(span * 2));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = start.cx + spanX * t;
    const cy = start.cy + spanY * t;
    const index = shape.cells.get(cellKey(Math.floor(cx), Math.floor(cy)));
    if (index !== undefined) {
      return {
        moduleIndex: index,
        t,
        worldX: fromX + (toX - fromX) * t,
        worldY: fromY + (toY - fromY) * t,
      };
    }
  }

  return undefined;
}

/** Closest approach of a segment to a point, against a radius. */
function segmentNearPoint(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
  radius: number,
): boolean {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : clamp(((px - ax) * abx + (py - ay) * aby) / lengthSq, 0, 1);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy) <= radius;
}

// --- Power and brownout --------------------------------------------------

/**
 * What a brownout costs, as a multiplier per system.
 *
 * Losing reactors degrades weapons first, then shields, then engines: a hull
 * that cannot shoot can still run, which keeps a losing fight from becoming an
 * immediate write-off.
 */
export interface PowerState {
  readonly output: number;
  readonly draw: number;
  /** 1 when fully powered, falling toward 0 as reactors are lost. */
  readonly coverage: number;
  readonly weaponScale: number;
  readonly shieldScale: number;
  readonly engineScale: number;
}

/** Order in which systems are starved. Weapons go first. */
const BROWNOUT_ORDER = ['weapon', 'shield', 'engine'] as const;

export function powerState(
  modules: readonly PlacedModule[],
  alive: (index: number) => boolean,
): PowerState {
  let output = 0;
  let draw = 0;
  modules.forEach((module, index) => {
    if (!alive(index)) return;
    output += module.def.power.output ?? 0;
    draw += module.def.power.draw ?? 0;
  });

  const coverage = draw <= 0 ? 1 : clamp(output / draw, 0, 1);

  // Distribute the shortfall across systems in order: the first system absorbs
  // as much as it can before the next one is touched.
  const scales: Record<(typeof BROWNOUT_ORDER)[number], number> = {
    weapon: 1,
    shield: 1,
    engine: 1,
  };

  let shortfall = 1 - coverage;
  // Each system can absorb up to a third of the total before the next starves,
  // so a small shortfall is felt only in the guns.
  const perSystem = 1 / BROWNOUT_ORDER.length;
  for (const system of BROWNOUT_ORDER) {
    const absorbed = Math.min(shortfall, perSystem);
    scales[system] = clamp(1 - absorbed / perSystem, 0, 1);
    shortfall -= absorbed;
    if (shortfall <= 0) break;
  }

  return {
    output,
    draw,
    coverage,
    weaponScale: scales.weapon,
    shieldScale: scales.shield,
    engineScale: scales.engine,
  };
}

// --- Damage ---------------------------------------------------------------

export interface DamageOutcome {
  /** Damage absorbed by the shields. */
  readonly toShield: number;
  /** Damage that reached the module. */
  readonly toModule: number;
  /** True when this hit took the module to zero. */
  readonly disabled: boolean;
}

/**
 * Apply one hit.
 *
 * Shields take it first and only what is left reaches the hull, so a shield
 * that is nearly down still softens the blow rather than vanishing.
 */
export function applyDamage(
  damage: number,
  shield: number,
  moduleHp: number,
): DamageOutcome {
  const toShield = Math.min(shield, damage);
  const remaining = damage - toShield;
  const toModule = Math.min(moduleHp, remaining);
  return {
    toShield,
    toModule,
    disabled: toModule > 0 && moduleHp - toModule <= 0,
  };
}

/** True when the hull is written off: bridge gone, or structure past the threshold. */
export function isWrittenOff(
  modules: readonly PlacedModule[],
  hp: readonly number[],
  tuning: Tuning,
): boolean {
  let intact = 0;
  let total = 0;
  let bridgeAlive = false;

  modules.forEach((module, index) => {
    const current = hp[index] ?? 0;
    total += module.def.hitPoints;
    intact += current;
    if (module.def.type === 'bridge' && current > 0) bridgeAlive = true;
  });

  if (!bridgeAlive) return true;
  if (total <= 0) return true;
  return intact / total < tuning.hull.structureWriteOffFraction;
}

// --- Firing ---------------------------------------------------------------

/** A weapon mount, resolved from the blueprint once. */
export interface Mount {
  readonly moduleIndex: number;
  readonly def: ModuleDef;
  readonly kind: ProjectileKind;
  /** Muzzle offset from the centre of mass, in world units. */
  readonly offsetX: number;
  readonly offsetY: number;
}

export function mountsOf(modules: readonly PlacedModule[]): Mount[] {
  const com = centreOfMass(modules);
  const mounts: Mount[] = [];

  modules.forEach((module, index) => {
    const weapon = module.def.weapon;
    if (!weapon) return;

    const kind: ProjectileKind =
      module.def.type === 'rack'
        ? PROJECTILE_KIND.missile
        : module.def.type === 'turret'
          ? PROJECTILE_KIND.turret
          : PROJECTILE_KIND.gun;

    // Rounds leave from the forward face of the mount.
    mounts.push({
      moduleIndex: index,
      def: module.def,
      kind,
      offsetX: (module.placement.x + module.width - com.x) * CELL_METRES,
      offsetY: (module.centreY - com.y) * CELL_METRES,
    });
  });

  return mounts;
}

/** Where a mount's muzzle is in the world, given the hull's pose. */
export function muzzleOf(mount: Mount, pose: Pose): { x: number; y: number } {
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  return {
    x: pose.x + mount.offsetX * cos - mount.offsetY * sin,
    y: pose.y + mount.offsetX * sin + mount.offsetY * cos,
  };
}

/**
 * Where a turret is pointed after `dt` of traversing toward its mark.
 *
 * Angles here are relative to the hull's facing, because a turret is bolted to
 * the hull: turning the ship carries the mount round with it, and a turret
 * that held a world bearing would be a gyro-stabilised mount nobody bought.
 *
 * `tracking` is the traverse rate in radians per second. A mount with no
 * tracking stat is taken to be infinitely fast, which is what the game did
 * for every turret before the stat was read: a mount reaches its mark the
 * instant it is given one.
 *
 * The result is clamped to the arc, so a turret parks against its stop rather
 * than swinging through the hull to reach a mark behind it.
 */
export function slewTurret(
  current: number,
  desired: number,
  tracking: number | undefined,
  dt: number,
  arc: number,
): number {
  const wanted = clampAngle(wrapAngle(desired), arc);
  if (tracking === undefined) return wanted;

  const offset = wrapAngle(wanted - current);
  const step = tracking * dt;
  if (Math.abs(offset) <= step) return wanted;
  return clampAngle(wrapAngle(current + Math.sign(offset) * step), arc);
}

/** Hold an angle inside ±arc without wrapping it round the long way. */
function clampAngle(angle: number, arc: number): number {
  return Math.max(-arc, Math.min(arc, angle));
}

/**
 * The direction a mount fires.
 *
 * A fixed gun fires along the hull's facing. A turret fires where it is
 * currently pointed, and declines the shot when its mark is outside its arc.
 *
 * `relativeAim` is where the mount has traversed to, as `slewTurret` left it,
 * relative to the hull. Left out, a turret snaps to its mark — which is right
 * for a mount with no traverse rate, and for the lead indicator in the
 * interface, which asks where a turret *would* shoot.
 */
export function aimOf(
  mount: Mount,
  pose: Pose,
  target: Pose | undefined,
  rng: Rng,
  relativeAim?: number,
): number | undefined {
  const weapon = mount.def.weapon;
  if (!weapon) return undefined;

  let aim = pose.angle;

  if (mount.kind === PROJECTILE_KIND.turret && target) {
    const bearing = Math.atan2(target.y - pose.y, target.x - pose.x);
    const arc = weapon.arc ?? Math.PI;
    const offset = wrapAngle(bearing - pose.angle);
    if (Math.abs(offset) > arc) return undefined;

    // Pointed somewhere other than the mark: the shot goes where the barrel
    // is, not where the gunner wishes it were. A mount still coming round is
    // what makes a slow traverse cost something.
    aim = relativeAim === undefined ? bearing : pose.angle + relativeAim;
  }

  if (weapon.spread > 0) {
    aim += rng.range(-weapon.spread, weapon.spread);
  }

  return wrapAngle(aim);
}

/**
 * Lead a moving target, so a turret and the interface's lead indicator agree.
 *
 * Solves for where the target will be when a round at `speed` reaches it.
 * Returns the aim point, or the target's current position when no solution
 * exists (the target is outrunning the round).
 */
export function leadPoint(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  targetVx: number,
  targetVy: number,
  speed: number,
): { x: number; y: number } {
  const dx = targetX - fromX;
  const dy = targetY - fromY;

  const a = targetVx * targetVx + targetVy * targetVy - speed * speed;
  const b = 2 * (dx * targetVx + dy * targetVy);
  const c = dx * dx + dy * dy;

  let time: number;
  if (Math.abs(a) < 1e-6) {
    time = Math.abs(b) < 1e-6 ? 0 : -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return { x: targetX, y: targetY };
    const root = Math.sqrt(disc);
    const t1 = (-b - root) / (2 * a);
    const t2 = (-b + root) / (2 * a);
    const positives = [t1, t2].filter((t) => t > 0);
    if (positives.length === 0) return { x: targetX, y: targetY };
    time = Math.min(...positives);
  }

  if (!Number.isFinite(time) || time < 0) return { x: targetX, y: targetY };
  return { x: targetX + targetVx * time, y: targetY + targetVy * time };
}

/** Advance a missile toward its mark. Straight rounds need no steering. */
export function steerMissile(
  projectile: { x: number; y: number; vx: number; vy: number },
  target: Pose | undefined,
  turnRate: number,
  speed: number,
  dt: number,
): void {
  if (!target) return;
  const heading = Math.atan2(projectile.vy, projectile.vx);
  const bearing = Math.atan2(target.y - projectile.y, target.x - projectile.x);
  const error = wrapAngle(bearing - heading);
  const turn = clamp(error, -turnRate * dt, turnRate * dt);
  const next = heading + turn;
  projectile.vx = Math.cos(next) * speed;
  projectile.vy = Math.sin(next) * speed;
}
