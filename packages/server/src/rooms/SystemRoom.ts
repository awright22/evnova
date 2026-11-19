/**
 * One star system.
 *
 * The room is authoritative. Clients send inputs and intents only: the two
 * fire bits on an input ask to shoot, and everything that follows — cooldowns,
 * aim, hit resolution, damage, destruction — happens here. A forged message
 * cannot create a round, land a hit or change a stat.
 *
 * The flight step is the shared one, so the client's reconciler replays
 * exactly what the server ran.
 */

import { ClientState, Room, validate, type Client, type StepContext } from '@colyseus/core';
import {
  EMPTY_LOADOUT,
  SCOOP_RANGE,
  SHIP_INPUT_SANITIZE,
  ScoopIntent,
  TargetIntent,
  ShipInput,
  ShipState,
  SUB_STEPS,
  SystemState,
  TICK_RATE,
  Rng,
  clamp,
  content,
  stepFlight,
  type Blueprint,
  type FlightCommand,
  type SystemDef,
} from '@marque/shared';

import { registerRoom, TickMetrics } from '../metrics.ts';
import { CombatSystem, type ImpactEvent } from './combat.ts';
import { ShipRuntime } from './ShipRuntime.ts';
import { unletteredPilot, type NpcPilot } from './npc.ts';

/** The draught every Open Ticket starts with. */
const STARTER_BLUEPRINT = 'prudent-return';

/** Draughts the Unlettered fly. */
const RAIDER_BLUEPRINTS = ['short-measure', 'force-majeure'] as const;

export interface SystemRoomOptions {
  /** Content id of the system to simulate. */
  systemId?: string;
  /** Raiders to keep in the system while captains are present. */
  raiders?: number;
}

export interface JoinOptions {
  callsign?: string;
  blueprint?: string;
}

/** Arrivals scatter inside this radius around a berth. */
const SPAWN_RADIUS = 900;

/** How far off the berth arrivals sit, so nobody materialises inside it. */
const SPAWN_STANDOFF = 1600;

/** A wreck lingers this long before it is cleared. */
const WRECK_LINGER_MS = 6000;

/** Ordnance a hull carries when it launches, until the Staple exists. */
const STARTING_AMMO = 24;

export class SystemRoom extends Room<{
  state: SystemState;
  input: ShipInput;
}> {
  override state = new SystemState();

  override inputs = this.defineInput(ShipInput, {
    bufferMaxSize: 64,
    sanitize: SHIP_INPUT_SANITIZE,
    idle: ({ latest, sessionId }) => {
      const client = this.clients.get(sessionId);
      if (client?.state !== ClientState.JOINED) return true;
      return latest ?? true;
    },
  });

  /** Server-side truth per hull: grid, mounts, hit points, cooldowns. */
  private readonly runtimes = new Map<string, ShipRuntime>();

  /** NPC pilots, keyed by the same id as their hull. */
  private readonly pilots = new Map<string, NpcPilot>();

  private system: SystemDef | undefined;
  private combat!: CombatSystem;
  private raiderTarget = 0;
  private nextNpcId = 1;
  private rng = new Rng('system');

  private readonly tick = new TickMetrics();
  private unregisterMetrics: (() => void) | undefined;

  /**
   * Intents that need a result.
   *
   * Each is validated for shape before the handler runs, then for state
   * inside it, and refused with one of the protocol's typed reasons. The
   * client renders a designed state per reason rather than raw error text.
   */
  override messages = {
    target: validate(TargetIntent, (client: Client, message: TargetIntent, ctx) => {
      const ship = this.state.ships.get(client.sessionId);
      if (!ship) return ctx.reject('unknown-target');

      // An empty id clears the mark, which is always allowed.
      if (message.id === '') {
        ship.target = '';
        return { target: '' };
      }

      if (message.id === client.sessionId) return ctx.reject('target-self');

      const mark = this.state.ships.get(message.id);
      if (!mark) return ctx.reject('unknown-target');
      if (mark.destroyedAt > 0) return ctx.reject('target-written-off');

      ship.target = message.id;
      return { target: message.id };
    }),

    scoop: validate(ScoopIntent, (client: Client, message: ScoopIntent, ctx) => {
      const ship = this.state.ships.get(client.sessionId);
      const runtime = this.runtimes.get(client.sessionId);
      if (!ship || !runtime || ship.destroyedAt > 0) return ctx.reject('not-owned');

      const canister = this.state.canisters.get(message.id);
      if (!canister) return ctx.reject('unknown-target');

      // Range is checked against the server's position, never the client's.
      const distance = Math.hypot(canister.x - ship.x, canister.y - ship.y);
      if (distance > SCOOP_RANGE) return ctx.reject('out-of-range');

      // Until the Staple exists, the only cargo a hull carries is Ordnance.
      if (canister.commodity === 'ordnance') runtime.ammo += canister.units;
      this.state.canisters.delete(message.id);
      return { commodity: canister.commodity, units: canister.units };
    }),
  };

  override onCreate(options: SystemRoomOptions = {}): void {
    const { systems } = content();
    const requested = options.systemId ?? 'parity';
    this.system = systems.get(requested) ?? [...systems.values()][0];
    this.state.systemId = this.system?.id ?? requested;
    this.raiderTarget = options.raiders ?? 2;
    this.rng = new Rng(`system:${this.roomId}`);

    this.combat = new CombatSystem(
      {
        state: this.state,
        tuning: content().tuning,
        runtimeOf: (id) => this.runtimes.get(id),
        now: () => this.clock.elapsedTime,
        onWrittenOff: (id, killedBy) => this.writeOff(id, killedBy),
        onImpact: (event) => this.broadcastImpact(event),
      },
      this.roomId,
    );

    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE, { subSteps: SUB_STEPS });

    this.unregisterMetrics = registerRoom({
      roomId: this.roomId,
      systemId: this.state.systemId,
      clients: () => this.clients.length,
      entities: () => this.state.ships.size + this.state.projectiles.size,
      tick: this.tick,
    });
  }

  override onDispose(): void {
    this.unregisterMetrics?.();
    this.unregisterMetrics = undefined;
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const callsign = sanitiseCallsign(options.callsign) || `Captain-${client.sessionId.slice(0, 4)}`;
    const { blueprints } = content();

    const requested = typeof options.blueprint === 'string' ? options.blueprint : undefined;
    const blueprintId =
      requested !== undefined && blueprints.has(requested) ? requested : STARTER_BLUEPRINT;

    this.spawnHull(client.sessionId, blueprintId, callsign, false);
  }

  override onLeave(client: Client): void {
    // M3 adds the grace window from the spec: a hull persists in space for a
    // short time after its captain drops.
    this.removeHull(client.sessionId);
  }

  // --- Spawning -----------------------------------------------------------

  private spawnHull(id: string, blueprintId: string, callsign: string, hostile: boolean): void {
    const { blueprints, modules, tuning } = content();
    const blueprint: Blueprint | undefined = blueprints.get(blueprintId);
    if (!blueprint) throw new Error(`draught "${blueprintId}" is missing`);

    const runtime = new ShipRuntime(blueprint, modules, tuning, EMPTY_LOADOUT, STARTING_AMMO);

    const rng = new Rng(`${this.roomId}:${id}`);
    const bearing = rng.range(-Math.PI, Math.PI);
    const distance = SPAWN_RADIUS * Math.sqrt(rng.next());

    const berth = this.system?.ports[0];
    const anchorX = berth ? berth.x + Math.cos(bearing) * SPAWN_STANDOFF : 0;
    const anchorY = berth ? berth.y + Math.sin(bearing) * SPAWN_STANDOFF : 0;

    const ship = new ShipState();
    ship.x = anchorX + Math.cos(bearing) * distance;
    ship.y = anchorY + Math.sin(bearing) * distance;
    ship.angle = berth
      ? Math.atan2(berth.y - ship.y, berth.x - ship.x)
      : Math.atan2(-ship.y, -ship.x);
    ship.callsign = callsign;
    ship.blueprint = blueprintId;
    ship.hostile = hostile;
    ship.shield = runtime.shieldCapacity;
    for (const hp of runtime.hp) ship.moduleHp.push(Math.round(hp));

    this.runtimes.set(id, runtime);
    this.state.ships.set(id, ship);
  }

  private removeHull(id: string): void {
    this.state.ships.delete(id);
    this.runtimes.delete(id);
    this.pilots.delete(id);
    this.combat.retireRoundsOf(id);
  }

  // --- The step -----------------------------------------------------------

  private step(ctx: StepContext): void {
    const startedAt = performance.now();
    const now = this.clock.elapsedTime;

    this.maintainRaiders();

    for (const [id, ship] of this.state.ships) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;

      if (ship.destroyedAt > 0) {
        // A wreck keeps its momentum for a moment, then is cleared.
        ship.x += ship.vx * ctx.dt;
        ship.y += ship.vy * ctx.dt;
        if (now - ship.destroyedAt > WRECK_LINGER_MS) this.removeHull(id);
        continue;
      }

      const command = this.commandFor(id, ship, runtime);
      if (!command) continue;

      stepFlight(ship, command, runtime.profile, ctx);
      this.combat.fire(id, ship, runtime, command.firePrimary, command.fireSecondary);
      this.regenerateShield(ship, runtime, ctx.dt, now);
    }

    this.combat.step(ctx.dt, ctx.tick);
    this.combat.stepCanisters(ctx.dt);

    this.state.tick = ctx.tick;
    this.tick.record(performance.now() - startedAt);
  }

  /**
   * What a hull is being told to do this step.
   *
   * A captain's hull reads its buffered input; an NPC's asks its pilot. Both
   * produce the same shape, so the simulation cannot tell them apart.
   */
  private commandFor(
    id: string,
    ship: ShipState,
    runtime: ShipRuntime,
  ): (FlightCommand & { firePrimary: boolean; fireSecondary: boolean }) | undefined {
    const pilot = this.pilots.get(id);
    if (pilot) {
      const decision = pilot.decide(ship, runtime.profile, {
        candidates: (selfId) =>
          [...this.state.ships]
            .filter(([otherId, other]) => otherId !== selfId && other.destroyedAt === 0)
            // Raiders do not fight each other.
            .filter(([otherId]) => !this.pilots.has(otherId))
            .map(([otherId, other]) => ({ id: otherId, ship: other })),
        integrityOf: (hullId) => this.runtimes.get(hullId)?.integrity ?? 0,
        now: () => this.clock.elapsedTime,
      });
      ship.target = decision.target;
      return decision;
    }

    const cmd = this.inputs.get(id).next();
    if (!cmd) return undefined;
    return {
      turn: cmd.turn,
      thrust: cmd.thrust,
      brake: cmd.brake,
      firePrimary: cmd.firePrimary,
      fireSecondary: cmd.fireSecondary,
    };
  }

  /** Shields recover after a delay without being hit. */
  private regenerateShield(
    ship: ShipState,
    runtime: ShipRuntime,
    dt: number,
    now: number,
  ): void {
    const capacity = runtime.shieldCapacity;
    if (capacity <= 0) {
      ship.shield = 0;
      return;
    }
    if (now - runtime.lastHitAt < runtime.shieldDelayMs) return;
    if (ship.shield >= capacity) return;
    ship.shield = clamp(ship.shield + runtime.shieldRegen * dt, 0, capacity);
  }

  // --- Raiders ------------------------------------------------------------

  /** Keep a few Unlettered about while there are captains to rob. */
  private maintainRaiders(): void {
    const captains = [...this.state.ships].filter(
      ([id, ship]) => !this.pilots.has(id) && ship.destroyedAt === 0,
    ).length;

    const wanted = captains > 0 ? this.raiderTarget : 0;
    const current = this.pilots.size;

    if (current < wanted) {
      const id = `npc-${this.nextNpcId++}`;
      const blueprint = this.rng.pick(RAIDER_BLUEPRINTS);
      this.spawnHull(id, blueprint, raiderName(this.rng), true);
      this.pilots.set(id, unletteredPilot(id, `${this.roomId}:${id}`));
    } else if (current > wanted) {
      const [id] = [...this.pilots.keys()];
      if (id !== undefined) this.removeHull(id);
    }
  }

  // --- Aftermath ----------------------------------------------------------

  private writeOff(id: string, killedBy: string): void {
    const ship = this.state.ships.get(id);
    const runtime = this.runtimes.get(id);
    if (!ship || !runtime) return;

    ship.destroyedAt = Math.round(this.clock.elapsedTime) || 1;
    ship.shield = 0;
    ship.target = '';

    // Part of the hold spills. The Staple fills holds in M4; until then a
    // wreck spills its Ordnance, which is the only cargo a hull carries.
    if (runtime.ammo > 0) {
      this.combat.spill(ship, [{ commodity: 'ordnance', units: Math.ceil(runtime.ammo / 2) }], this.clock.elapsedTime);
    }

    this.combat.retireRoundsOf(id);

    this.broadcast('written-off', {
      id,
      callsign: ship.callsign,
      killedBy,
      x: ship.x,
      y: ship.y,
      blueprint: ship.blueprint,
    });

    // A captain gets a fresh hull; a raider simply stops existing.
    if (!this.pilots.has(id) && this.clients.get(id)) {
      this.clock.setTimeout(() => this.respawn(id), WRECK_LINGER_MS);
    }
  }

  /**
   * Death costs the hull and its cargo.
   *
   * Marks, draughts, shares and parked hulls survive it, and Underwriters'
   * Hall settles half the hull's cost. Those live in the account, which
   * arrives in M3; for now the captain wakes in a fresh starter.
   */
  private respawn(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;

    const previous = this.state.ships.get(id);
    const callsign = previous?.callsign ?? `Captain-${id.slice(0, 4)}`;
    this.removeHull(id);
    this.spawnHull(id, STARTER_BLUEPRINT, callsign, false);
    client.send('respawned', { id });
  }

  private broadcastImpact(event: ImpactEvent): void {
    // Presentation only: clients draw a ripple or sparks. Nothing about the
    // outcome depends on a client receiving it.
    this.broadcast('impact', event);
  }
}

function sanitiseCallsign(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '-]/gu, '')
    .trim()
    .slice(0, 20);
}

/** Unlettered hulls carry no registry, so they go by what crews call them. */
const RAIDER_NAMES = [
  'Nothing Owed',
  'Short Measure',
  'Bad Debt',
  'Writ Large',
  'Unlettered',
  'No Fixed Berth',
  'Quiet Settlement',
  'Past Due',
] as const;

function raiderName(rng: Rng): string {
  return rng.pick(RAIDER_NAMES);
}
