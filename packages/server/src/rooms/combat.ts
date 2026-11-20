/**
 * Server-side combat.
 *
 * The server owns every outcome. Clients send only the two fire bits on their
 * input; cooldowns, ammunition, aim, hit resolution and damage all happen
 * here, so a forged message cannot create a round, land a hit or change a
 * stat.
 *
 * Rounds are synchronised as a spawn and a removal. A gun round flies a
 * straight line from a known birth, so clients reckon it forward and the wire
 * stays quiet; a missile steers, so its entry is refreshed on a slow cadence.
 */

import {
  BeamState,
  PROJECTILE_KIND,
  ProjectileState,
  CanisterState,
  Rng,
  aimOf,
  slewTurret,
  wrapAngle,
  applyDamage,
  isAdrift,
  leadPoint,
  muzzleOf,
  rockAlong,
  steerMissile,
  sweepHit,
  type HitResult,
  type Mount,
  type Pose,
  type ShipState,
  type SystemState,
  type Tuning,
} from '@marque/shared';

import type { ShipRuntime } from './ShipRuntime.ts';

/** How often a missile's synchronised position is refreshed, in ticks. */
const MISSILE_SYNC_TICKS = 4;

/** How long a wreck's canisters linger before they are cleaned up, in ms. */
const CANISTER_LIFE_MS = 90_000;

/** Server-side truth for a round in flight. */
interface Round {
  readonly id: string;
  readonly owner: string;
  readonly kind: number;
  readonly damage: number;
  readonly speed: number;
  readonly expiresAt: number;
  readonly homing: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  target: string;
  lastSyncTick: number;
}

/** What the room must provide for combat to resolve. */
export interface CombatWorld {
  readonly state: SystemState;
  readonly tuning: Tuning;
  runtimeOf(id: string): ShipRuntime | undefined;
  /** Room clock, in ms. Injected so the soak can run the world fast. */
  now(): number;
  /** Called when a hull is written off, so the room can handle the aftermath. */
  onWrittenOff(id: string, killedBy: string): void;
  /** Presentation events the room broadcasts; never authoritative. */
  onImpact(event: ImpactEvent): void;
  /**
   * A rig took this much off a rock this step.
   *
   * Fractional: a rig cuts at units a second and a step is a fraction of
   * one, so what to do with a part of a unit is the room's business, not
   * combat's. Combat says what was cut; the room says who gets it.
   */
  onMining?(shooterId: string, rockId: string, units: number): void;
}

export interface ImpactEvent {
  readonly x: number;
  readonly y: number;
  /** True when the shields took it, false when it reached the hull. */
  readonly shielded: boolean;
  readonly targetId: string;
  /** Who fired the round, so the Prize Court knows whom to post. */
  readonly shooterId: string;
  readonly kind: number;
  /** True when this hit took a module to zero. */
  readonly disabled: boolean;
  /** Damage this hit landed, shields included, for scaling a composition. */
  readonly damageDealt: number;
}

export class CombatSystem {
  private readonly rounds = new Map<string, Round>();
  private nextId = 1;

  /** One generator for all combat randomness, so a fight replays exactly. */
  private readonly rng: Rng;

  constructor(
    private readonly world: CombatWorld,
    seed: string,
  ) {
    this.rng = new Rng(`combat:${seed}`);
  }

  get roundCount(): number {
    return this.rounds.size;
  }

  /**
   * Fire whatever the pilot asked for and the hull can deliver.
   *
   * Called once per hull per step, after the flight step, so rounds leave from
   * where the hull actually is.
   */
  fire(
    shooterId: string,
    ship: ShipState,
    runtime: ShipRuntime,
    primary: boolean,
    secondary: boolean,
    dt: number,
  ): void {
    const now = this.world.now();
    const pose: Pose = { x: ship.x, y: ship.y, angle: ship.angle };
    const target = this.poseOf(ship.target);

    // Turrets come round whether or not the trigger is down, so a mount with
    // a slow traverse has to be pointed before it is needed. Doing this only
    // while firing would make every turret instant the moment it mattered.
    this.traverse(runtime, pose, target, dt);

    if (!primary && !secondary) return;

    runtime.mounts.forEach((mount, mountIndex) => {
      // A beam is held rather than fired: it has no cooldown and no round,
      // and it is dealt with where its damage is applied, every step.
      if (mount.kind === PROJECTILE_KIND.beam || mount.kind === PROJECTILE_KIND.defense) return;

      const isMissile = mount.kind === PROJECTILE_KIND.missile;
      if (isMissile ? !secondary : !primary) return;
      if (!runtime.tryFire(mountIndex, now)) return;
      this.spawnRound(shooterId, ship, mount, pose, target, now, runtime.turretAim[mountIndex]);
    });
  }

  /**
   * Hold every beam on whatever it can reach, for one step.
   *
   * A beam is not a round: it arrives, so there is nothing to reckon forward
   * and nothing to miss with. What it does instead is apply its damage a
   * fraction at a time, which makes it the opposite trade to a gun — no
   * leading and no travel time, in exchange for having to stay pointed at
   * something while it works.
   *
   * Called once per hull per step, after the flight step, like `fire`.
   */
  holdBeams(
    shooterId: string,
    ship: ShipState,
    runtime: ShipRuntime,
    firing: boolean,
    dt: number,
  ): void {
    const pose: Pose = { x: ship.x, y: ship.y, angle: ship.angle };
    const alive = ship.destroyedAt === 0;

    runtime.mounts.forEach((mount, mountIndex) => {
      const isRig = mount.kind === PROJECTILE_KIND.mining;
      if (mount.kind !== PROJECTILE_KIND.beam && !isRig) return;
      const weapon = mount.def.weapon;
      const key = `${shooterId}:${mountIndex}`;

      // A disabled mount does not fire, and neither does a wreck.
      const broken = (runtime.hp[mount.moduleIndex] ?? 0) <= 0;
      if (!weapon || !firing || !alive || broken) {
        if (this.world.state.beams.has(key)) this.world.state.beams.delete(key);
        return;
      }

      const muzzle = muzzleOf(mount, pose);
      const aim = pose.angle + (runtime.turretAim[mountIndex] ?? 0);
      const reachX = muzzle.x + Math.cos(aim) * weapon.range;
      const reachY = muzzle.y + Math.sin(aim) * weapon.range;

      // A rig cuts rock and does nothing whatever to a hull. That is the
      // whole difference: the same held line, pointed at something that
      // cannot be hurt and can be carried away.
      if (isRig) {
        const cut = this.cutRock(shooterId, muzzle, aim, weapon.range);
        const entry = this.beamEntry(key, shooterId, mountIndex);
        entry.angle = aim;
        entry.length = cut ? cut.along * weapon.range : weapon.range;
        entry.hitting = cut !== undefined;
        if (cut) this.world.onMining?.(shooterId, cut.rockId, weapon.damage * dt);
        return;
      }

      // The first hull along the line, which is what stops it.
      let struck:
        | { id: string; ship: ShipState; runtime: ShipRuntime; hit: HitResult }
        | undefined;
      for (const [id, other] of this.world.state.ships) {
        if (id === shooterId || other.destroyedAt > 0) continue;
        if (other.protectedUntil > this.world.now()) continue;
        const theirs = this.world.runtimeOf(id);
        if (!theirs) continue;

        const hit = sweepHit(
          theirs.shape,
          { x: other.x, y: other.y, angle: other.angle },
          muzzle.x,
          muzzle.y,
          reachX,
          reachY,
        );
        if (!hit) continue;
        if (!struck || hit.t < struck.hit.t) {
          struck = { id, ship: other, runtime: theirs, hit };
        }
      }

      const length = struck ? weapon.range * struck.hit.t : weapon.range;

      const entry = this.beamEntry(key, shooterId, mountIndex);
      entry.angle = aim;
      entry.length = length;
      entry.hitting = struck !== undefined;

      if (!struck) return;

      // Damage a second, taken a step at a time. A beam that killed in one
      // step would be a gun with no travel time, which is not a trade.
      this.applyBeamDamage(struck.id, struck.ship, struck.runtime, {
        owner: shooterId,
        damage: weapon.damage * dt,
        moduleIndex: struck.hit.moduleIndex,
        x: struck.hit.worldX,
        y: struck.hit.worldY,
      });
    });
  }

  /** The wire entry for a held line, made if this is the first step of it. */
  private beamEntry(key: string, owner: string, mount: number): BeamState {
    const existing = this.world.state.beams.get(key);
    if (existing) return existing;

    const entry = new BeamState();
    entry.owner = owner;
    entry.mount = mount;
    this.world.state.beams.set(key, entry);
    return entry;
  }

  /**
   * The nearest rock a held line reaches, and how far along it that is.
   *
   * A rock at nothing is not cut: it is bare, and a rig sitting on it would
   * be a captain being paid for pointing at a stone.
   */
  private cutRock(
    shooterId: string,
    muzzle: { x: number; y: number },
    aim: number,
    range: number,
  ): { rockId: string; along: number } | undefined {
    void shooterId;
    const toX = muzzle.x + Math.cos(aim) * range;
    const toY = muzzle.y + Math.sin(aim) * range;

    let best: { rockId: string; along: number } | undefined;
    for (const [id, rock] of this.world.state.asteroids) {
      if (rock.left <= 0) continue;
      const along = rockAlong(muzzle.x, muzzle.y, toX, toY, rock);
      if (along === undefined) continue;
      if (!best || along < best.along) best = { rockId: id, along };
    }
    return best;
  }

  /** Take every held line this hull had off the wire. */
  dropBeams(shooterId: string, runtime: ShipRuntime): void {
    runtime.mounts.forEach((mount, mountIndex) => {
      if (mount.kind !== PROJECTILE_KIND.beam && mount.kind !== PROJECTILE_KIND.mining) return;
      this.world.state.beams.delete(`${shooterId}:${mountIndex}`);
    });
  }

  /**
   * Point defense: shoot down what is coming in.
   *
   * It picks its own marks — rounds, not hulls — and fires on its own
   * cadence whether or not the captain is doing anything. That is the whole
   * of it: a hull with it fitted is harder to hit with a rack, and a captain
   * who fits it has given up a mount that could have been shooting back.
   */
  defend(ownerId: string, ship: ShipState, runtime: ShipRuntime): void {
    if (ship.destroyedAt > 0) return;
    const now = this.world.now();
    const pose: Pose = { x: ship.x, y: ship.y, angle: ship.angle };

    runtime.mounts.forEach((mount, mountIndex) => {
      if (mount.kind !== PROJECTILE_KIND.defense) return;
      const weapon = mount.def.weapon;
      if (!weapon) return;
      if ((runtime.hp[mount.moduleIndex] ?? 0) <= 0) return;
      if (!runtime.tryFire(mountIndex, now)) return;

      const muzzle = muzzleOf(mount, pose);
      const arc = weapon.arc ?? Math.PI;

      // The nearest round in reach that is somebody else's and is actually
      // coming this way. A round already past is not a threat.
      let best: Round | undefined;
      let bestRange = weapon.range;
      for (const round of this.rounds.values()) {
        if (round.owner === ownerId) continue;
        const dx = round.x - muzzle.x;
        const dy = round.y - muzzle.y;
        const range = Math.hypot(dx, dy);
        if (range > bestRange) continue;
        if (Math.abs(wrapAngle(Math.atan2(dy, dx) - pose.angle)) > arc) continue;
        // Closing, not receding.
        if ((round.vx - ship.vx) * dx + (round.vy - ship.vy) * dy >= 0) continue;
        best = round;
        bestRange = range;
      }

      if (!best) {
        // Nothing to shoot: give the cooldown back, so a mount is not kept
        // warm by a sky with nothing in it.
        runtime.unfire(mountIndex);
        return;
      }

      this.world.onImpact({
        x: best.x,
        y: best.y,
        shielded: false,
        targetId: '',
        shooterId: ownerId,
        kind: PROJECTILE_KIND.defense,
        disabled: false,
        damageDealt: 0,
      });
      this.retire(best.id);
    });
  }

  /** One step of a beam's damage, which is a hit like any other. */
  private applyBeamDamage(
    targetId: string,
    ship: ShipState,
    runtime: ShipRuntime,
    beam: { owner: string; damage: number; moduleIndex: number; x: number; y: number },
  ): void {
    const outcome = applyDamage(beam.damage, ship.shield, runtime.hp[beam.moduleIndex] ?? 0);

    ship.shield = Math.max(0, ship.shield - outcome.toShield);
    runtime.lastHitAt = this.world.now();

    let disabled = false;
    if (outcome.toModule > 0) {
      disabled = runtime.damageModule(beam.moduleIndex, outcome.toModule);
      ship.moduleHp[beam.moduleIndex] = Math.max(0, Math.round(runtime.hp[beam.moduleIndex] ?? 0));
      ship.adrift = isAdrift(runtime.modules, runtime.hp);
    }

    this.world.onImpact({
      x: beam.x,
      y: beam.y,
      shielded: outcome.toModule === 0,
      targetId,
      shooterId: beam.owner,
      kind: PROJECTILE_KIND.beam,
      disabled,
      damageDealt: outcome.toShield + outcome.toModule,
    });

    if (runtime.writtenOff && ship.destroyedAt === 0) {
      this.world.onWrittenOff(targetId, beam.owner);
    }
  }

  /**
   * Bring every turret round toward the mark.
   *
   * Each mount leads independently, because two turrets at different points
   * on a hull see a close mark at different bearings. With no mark, a mount
   * returns to straight ahead at its own rate: a hull that breaks off does
   * not leave its guns trained on empty space.
   */
  private traverse(
    runtime: ShipRuntime,
    pose: Pose,
    target: { pose: Pose; vx: number; vy: number } | undefined,
    dt: number,
  ): void {
    runtime.mounts.forEach((mount, mountIndex) => {
      if (mount.kind !== PROJECTILE_KIND.turret) return;
      const weapon = mount.def.weapon;
      if (!weapon) return;

      const arc = weapon.arc ?? Math.PI;
      let desired = 0;
      if (target) {
        const muzzle = muzzleOf(mount, pose);
        const lead = leadPoint(
          muzzle.x,
          muzzle.y,
          target.pose.x,
          target.pose.y,
          target.vx,
          target.vy,
          weapon.projectileSpeed,
        );
        desired = wrapAngle(Math.atan2(lead.y - pose.y, lead.x - pose.x) - pose.angle);
      }

      runtime.turretAim[mountIndex] = slewTurret(
        runtime.turretAim[mountIndex] ?? 0,
        desired,
        weapon.tracking,
        dt,
        arc,
      );
    });
  }

  private spawnRound(
    shooterId: string,
    ship: ShipState,
    mount: Mount,
    pose: Pose,
    target: { pose: Pose; vx: number; vy: number } | undefined,
    now: number,
    relativeAim: number | undefined,
  ): void {
    const weapon = mount.def.weapon;
    if (!weapon) return;

    // A turret leads its mark, so its rounds arrive where the hull is going.
    let aimAt: Pose | undefined = target?.pose;
    if (target && mount.kind === PROJECTILE_KIND.turret) {
      const muzzle = muzzleOf(mount, pose);
      const lead = leadPoint(
        muzzle.x,
        muzzle.y,
        target.pose.x,
        target.pose.y,
        target.vx,
        target.vy,
        weapon.projectileSpeed,
      );
      aimAt = { x: lead.x, y: lead.y, angle: 0 };
    }

    const aim = aimOf(mount, pose, aimAt, this.rng, relativeAim);
    if (aim === undefined) return;

    const muzzle = muzzleOf(mount, pose);
    const id = `r${this.nextId++}`;
    const lifeMs = (weapon.range / weapon.projectileSpeed) * 1000;

    // A round inherits the hull's velocity, so firing while burning does not
    // leave the rounds behind.
    const vx = Math.cos(aim) * weapon.projectileSpeed + ship.vx;
    const vy = Math.sin(aim) * weapon.projectileSpeed + ship.vy;

    this.rounds.set(id, {
      id,
      owner: shooterId,
      kind: mount.kind,
      damage: weapon.damage,
      speed: weapon.projectileSpeed,
      expiresAt: now + lifeMs,
      homing: weapon.homing ?? 0,
      x: muzzle.x,
      y: muzzle.y,
      vx,
      vy,
      target: mount.kind === PROJECTILE_KIND.missile ? ship.target : '',
      lastSyncTick: 0,
    });

    const entry = new ProjectileState();
    entry.x = muzzle.x;
    entry.y = muzzle.y;
    entry.vx = vx;
    entry.vy = vy;
    entry.owner = shooterId;
    entry.kind = mount.kind;
    entry.bornAt = Math.round(now);
    entry.lifeMs = Math.round(lifeMs);
    entry.target = mount.kind === PROJECTILE_KIND.missile ? ship.target : '';
    this.world.state.projectiles.set(id, entry);
  }

  /** Advance every round, resolve hits, and retire what is spent. */
  step(dt: number, tick: number): void {
    const now = this.world.now();
    const spent: string[] = [];

    for (const round of this.rounds.values()) {
      if (now >= round.expiresAt) {
        spent.push(round.id);
        continue;
      }

      if (round.homing > 0) {
        const mark = this.poseOf(round.target);
        steerMissile(round, mark?.pose, round.homing, round.speed, dt);
      }

      const fromX = round.x;
      const fromY = round.y;
      round.x += round.vx * dt;
      round.y += round.vy * dt;

      if (this.resolveHit(round, fromX, fromY)) {
        spent.push(round.id);
        continue;
      }

      // A steered round's path cannot be reckoned from its birth, so its
      // entry is refreshed on a slow cadence. A straight round never is.
      if (round.homing > 0 && tick - round.lastSyncTick >= MISSILE_SYNC_TICKS) {
        round.lastSyncTick = tick;
        const entry = this.world.state.projectiles.get(round.id);
        if (entry) {
          entry.x = round.x;
          entry.y = round.y;
          entry.vx = round.vx;
          entry.vy = round.vy;
          entry.bornAt = Math.round(now);
        }
      }
    }

    for (const id of spent) this.retire(id);
  }

  /** Test one round's swept path against every hull it could have struck. */
  private resolveHit(round: Round, fromX: number, fromY: number): boolean {
    const now = this.world.now();

    for (const [id, ship] of this.world.state.ships) {
      // A hull cannot shoot itself, and a wreck is not a target.
      if (id === round.owner || ship.destroyedAt > 0) continue;
      // Nor is a hull that has just arrived and is still under protection, or
      // one that is already alongside a berth.
      if (ship.protectedUntil > now) continue;

      const runtime = this.world.runtimeOf(id);
      if (!runtime) continue;

      const pose: Pose = { x: ship.x, y: ship.y, angle: ship.angle };
      const hit = sweepHit(runtime.shape, pose, fromX, fromY, round.x, round.y);
      if (!hit) continue;

      this.applyHit(id, ship, runtime, round, hit.moduleIndex, hit.worldX, hit.worldY);
      return true;
    }
    return false;
  }

  private applyHit(
    targetId: string,
    ship: ShipState,
    runtime: ShipRuntime,
    round: Round,
    moduleIndex: number,
    worldX: number,
    worldY: number,
  ): void {
    const outcome = applyDamage(round.damage, ship.shield, runtime.hp[moduleIndex] ?? 0);

    ship.shield = Math.max(0, ship.shield - outcome.toShield);
    runtime.lastHitAt = this.world.now();

    let disabled = false;
    if (outcome.toModule > 0) {
      disabled = runtime.damageModule(moduleIndex, outcome.toModule);
      ship.moduleHp[moduleIndex] = Math.max(0, Math.round(runtime.hp[moduleIndex] ?? 0));
      // The one place a module reaching zero is known, which is the one
      // place a hull can be found to have stopped being able to run.
      ship.adrift = isAdrift(runtime.modules, runtime.hp);
    }

    this.world.onImpact({
      x: worldX,
      y: worldY,
      shielded: outcome.toModule === 0,
      targetId,
      shooterId: round.owner,
      kind: round.kind,
      disabled,
      damageDealt: outcome.toShield + outcome.toModule,
    });

    if (runtime.writtenOff && ship.destroyedAt === 0) {
      this.world.onWrittenOff(targetId, round.owner);
    }
  }

  private retire(id: string): void {
    this.rounds.delete(id);
    this.world.state.projectiles.delete(id);
  }

  /** Drop every round fired by a hull that is no longer in the system. */
  retireRoundsOf(ownerId: string): void {
    for (const round of [...this.rounds.values()]) {
      if (round.owner === ownerId) this.retire(round.id);
    }
    // And anything it was holding on something, which has no owner left.
    for (const key of [...this.world.state.beams.keys()]) {
      if (this.world.state.beams.get(key)?.owner === ownerId) {
        this.world.state.beams.delete(key);
      }
    }
  }

  /** Scatter a wreck's cargo as canisters anyone can scoop. */
  spill(
    ship: ShipState,
    cargo: { commodity: string; units: number }[],
    now: number,
  ): void {
    for (const lot of cargo) {
      if (lot.units <= 0) continue;
      const id = `c${this.nextId++}`;
      const bearing = this.rng.range(-Math.PI, Math.PI);
      const drift = this.rng.range(10, 45);

      const canister = new CanisterState();
      canister.x = ship.x;
      canister.y = ship.y;
      canister.vx = ship.vx * 0.3 + Math.cos(bearing) * drift;
      canister.vy = ship.vy * 0.3 + Math.sin(bearing) * drift;
      canister.commodity = lot.commodity;
      canister.units = lot.units;
      canister.bornAt = Math.round(now);
      this.world.state.canisters.set(id, canister);
    }
  }

  /** Drift canisters and clear the ones nobody collected. */
  stepCanisters(dt: number): void {
    const now = this.world.now();
    const gone: string[] = [];
    for (const [id, canister] of this.world.state.canisters) {
      if (now - canister.bornAt > CANISTER_LIFE_MS) {
        gone.push(id);
        continue;
      }
      canister.x += canister.vx * dt;
      canister.y += canister.vy * dt;
    }
    for (const id of gone) this.world.state.canisters.delete(id);
  }

  private poseOf(id: string): { pose: Pose; vx: number; vy: number } | undefined {
    if (!id) return undefined;
    const ship = this.world.state.ships.get(id);
    if (!ship || ship.destroyedAt > 0) return undefined;
    return {
      pose: { x: ship.x, y: ship.y, angle: ship.angle },
      vx: ship.vx,
      vy: ship.vy,
    };
  }
}
