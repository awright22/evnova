/**
 * Server-side state for one hull.
 *
 * Holds everything the simulation needs that clients never see: the resolved
 * module grid, weapon mounts, per-mount cooldowns, and the derived flight
 * profile. The profile is re-derived whenever a module is disabled, so losing
 * an engine genuinely costs thrust and losing an outboard plate moves the
 * balance point.
 *
 * Synchronised values — position, shields, module hit points — live on the
 * schema. This is the authority behind them.
 */

import {
  EMPTY_LOADOUT,
  deriveStats,
  flyingProfile,
  hullShape,
  isWrittenOff,
  mountsOf,
  placeAll,
  powerState,
  type Blueprint,
  type HullShape,
  type Loadout,
  type ModuleDef,
  type Mount,
  type PlacedModule,
  type PowerState,
  type ShipProfile,
  type ShipStats,
  type Tuning,
} from '@marque/shared';

export class ShipRuntime {
  readonly blueprintId: string;
  readonly modules: readonly PlacedModule[];
  readonly mounts: readonly Mount[];

  /** Hit points per placement. The schema mirrors this for clients. */
  readonly hp: number[];

  /** Server time each mount may next fire, in room-clock ms. */
  private readonly readyAt: number[];

  /**
   * Where each turret is pointed, relative to the hull's facing.
   *
   * Zero is straight ahead, which is where a mount sits when it has nothing
   * to track. Fixed mounts keep an entry and never use it, so this indexes
   * the same way as `mounts` and `readyAt`.
   */
  readonly turretAim: number[];

  /** Room-clock ms of the last hit taken, for the shield regeneration delay. */
  lastHitAt = 0;

  /** Units of Ordnance aboard, spent by missile racks. */
  ammo: number;

  private shapeCache: HullShape;
  private statsCache: ShipStats;
  private powerCache: PowerState;
  private dirty = false;

  constructor(
    blueprint: Blueprint,
    catalogue: ReadonlyMap<string, ModuleDef>,
    private readonly tuning: Tuning,
    private loadout: Loadout = EMPTY_LOADOUT,
    ammo = 0,
  ) {
    this.blueprintId = blueprint.id;
    this.modules = placeAll(blueprint.placements, catalogue);
    this.mounts = mountsOf(this.modules);
    this.hp = this.modules.map((module) => module.def.hitPoints);
    this.readyAt = this.mounts.map(() => 0);
    this.turretAim = this.mounts.map(() => 0);
    this.ammo = ammo;

    this.shapeCache = hullShape(this.modules);
    this.statsCache = deriveStats(this.modules, tuning, loadout);
    this.powerCache = powerState(this.modules, () => true);
  }

  /** Modules that still function. A disabled module keeps its cells but not its stats. */
  get aliveModules(): PlacedModule[] {
    return this.modules.filter((_, index) => (this.hp[index] ?? 0) > 0);
  }

  isAlive(index: number): boolean {
    return (this.hp[index] ?? 0) > 0;
  }

  /**
   * The hull's current performance.
   *
   * Recomputed only when something was disabled, because deriving stats walks
   * every module and the step runs thirty times a second.
   */
  get stats(): ShipStats {
    this.refresh();
    return this.statsCache;
  }

  get profile(): ShipProfile {
    // The shared rule, which the client predicts with. There is no second
    // copy of it: a hull that flies one way here and another way there is a
    // prediction that diverges every time anything is shot off.
    return flyingProfile(this.modules, this.hp, this.tuning, this.loadout);
  }

  get power(): PowerState {
    this.refresh();
    return this.powerCache;
  }

  /** The hitbox: always the full grid, because a disabled module still blocks. */
  get shape(): HullShape {
    return this.shapeCache;
  }

  get shieldCapacity(): number {
    return this.stats.shieldCapacity * this.power.shieldScale;
  }

  get shieldRegen(): number {
    return this.stats.shieldRegen * this.power.shieldScale;
  }

  get shieldDelayMs(): number {
    return this.stats.shieldDelay * 1000;
  }

  setLoadout(loadout: Loadout): void {
    this.loadout = loadout;
    this.dirty = true;
  }

  /**
   * Apply damage to one module. Returns true when this disabled it.
   *
   * The caller has already taken the shields off the top.
   */
  damageModule(index: number, amount: number): boolean {
    const before = this.hp[index] ?? 0;
    if (before <= 0 || amount <= 0) return false;
    const after = Math.max(0, before - amount);
    this.hp[index] = after;
    this.dirty = true;
    return after === 0;
  }

  /** Can this mount fire now, and if so, reserve its next shot. */
  tryFire(mountIndex: number, nowMs: number): boolean {
    const mount = this.mounts[mountIndex];
    if (!mount) return false;
    if (!this.isAlive(mount.moduleIndex)) return false;

    const weapon = mount.def.weapon;
    if (!weapon) return false;

    // A brownout slows the guns before it touches anything else.
    const rate = weapon.roundsPerSecond * this.power.weaponScale;
    if (rate <= 0) return false;

    if (nowMs < (this.readyAt[mountIndex] ?? 0)) return false;

    const cost = weapon.ammoPerShot ?? 0;
    if (cost > 0) {
      if (this.ammo < cost) return false;
      this.ammo -= cost;
    }

    this.readyAt[mountIndex] = nowMs + 1000 / rate;
    return true;
  }

  /**
   * Give a mount its cooldown back.
   *
   * Point defense asks whether it may fire before it knows whether there is
   * anything to fire at, because the cheap question comes first: a hull with
   * four of them and nothing incoming would otherwise walk every round in
   * the sky looking for a mark four times a step. A mount that found nothing
   * is a mount that has not fired.
   */
  unfire(mountIndex: number): void {
    this.readyAt[mountIndex] = 0;
  }

  get writtenOff(): boolean {
    return isWrittenOff(this.modules, this.hp, this.tuning);
  }

  /** Structure remaining, as a fraction of intact. */
  get integrity(): number {
    let intact = 0;
    let total = 0;
    this.modules.forEach((module, index) => {
      total += module.def.hitPoints;
      intact += this.hp[index] ?? 0;
    });
    return total > 0 ? intact / total : 0;
  }

  private refresh(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const alive = this.aliveModules;
    // A hull with nothing left still needs a profile rather than a crash.
    this.statsCache = deriveStats(alive.length > 0 ? alive : this.modules, this.tuning, this.loadout);
    this.powerCache = powerState(this.modules, (index) => this.isAlive(index));
  }
}
