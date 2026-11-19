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
import { config } from '../config.ts';
import {
  ARRIVAL_PROTECTION_SECONDS,
  EMPTY_LOADOUT,
  JUMP_CLEARANCE,
  JUMP_SPOOL_SECONDS,
  JumpIntent,
  LANDING_RANGE,
  LANDING_SECONDS,
  LANDING_SPEED,
  LandIntent,
  LaunchIntent,
  SCOOP_RANGE,
  SHIP_INPUT_SANITIZE,
  ScoopIntent,
  TargetIntent,
  jumpCost,
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
import { AuthError, type Account } from '../accounts.ts';
import { world } from '../world/World.ts';
import type { Pilot } from '../world/PilotStore.ts';
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
  /** Issued at sign-up and stored by the client. */
  deviceToken?: string;
  /** Draught to fly, for development. A captain's own draught wins. */
  blueprint?: string;
}

/** Arrivals scatter inside this radius around a berth. */
const SPAWN_RADIUS = 900;

/** How far off the berth arrivals sit, so nobody materialises inside it. */
const SPAWN_STANDOFF = 1600;

/** A wreck lingers this long before it is cleared. */
const WRECK_LINGER_MS = 6000;

/**
 * How long a hull stays in space after its captain drops, per the spec:
 * fifteen seconds, or thirty if it was shot at recently. Reconnecting inside
 * the window resumes the same hull.
 */
const GRACE_MS = 15_000;
const GRACE_AFTER_DAMAGE_MS = 30_000;

/** Damage within this long counts as recent, for the longer grace window. */
const RECENT_DAMAGE_MS = 20_000;

/** How often a captain's hull state is copied to their row. */
const PERSIST_EVERY_TICKS = TICK_RATE * 2;

/** Ordnance a hull carries when it launches, until the Staple exists. */
const STARTING_AMMO = 24;

/**
 * Per-connection message budget.
 *
 * Input rides its own channel and is buffered by the framework; this bounds
 * the intent channel, which runs handlers. Generous enough that no honest
 * client notices, tight enough that a flood costs the room nothing.
 */
const INTENT_BUDGET = 30;
const INTENT_WINDOW_MS = 1000;

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

  /** Intent timestamps per connection, for the rate limit. */
  private readonly intentLog = new Map<string, number[]>();

  /** Captains in this room, by session and by account. */
  private readonly pilotsBySession = new Map<string, Pilot>();
  private readonly sessionsByAccount = new Map<string, string>();

  /**
   * Intents that need a result.
   *
   * Each is validated for shape before the handler runs, then for state
   * inside it, and refused with one of the protocol's typed reasons. The
   * client renders a designed state per reason rather than raw error text.
   */
  override messages = {
    /**
     * Anything with no handler of its own.
     *
     * Without this, a client that sends an unknown type is disconnected with
     * close code 4002. That would turn a version skew, or a stray message
     * from a future build, into a mysterious drop rather than a designed
     * state. Unknown types are counted and ignored.
     */
    '*': (client: Client, type: string | number) => {
      if (!this.allowIntent(client.sessionId)) return;
      this.unhandled = (this.unhandled ?? 0) + 1;
      if (this.unhandled <= 5) {
        console.warn(`[${this.roomId}] ${client.sessionId} sent unhandled message "${String(type)}"`);
      }
    },

    target: validate(TargetIntent, (client: Client, message: TargetIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
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

    /**
     * Spool for a linked system.
     *
     * The hull keeps flying and stays vulnerable while it spools, which is
     * what makes a jump something an enemy can interrupt.
     */
    jump: validate(JumpIntent, (client: Client, message: JumpIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const ship = this.state.ships.get(client.sessionId);
      const runtime = this.runtimes.get(client.sessionId);
      if (!ship || !runtime || ship.destroyedAt > 0) return ctx.reject('not-owned');
      if (ship.landingAt !== '') return ctx.reject('not-landed');

      // An empty destination cancels a spool in progress.
      if (message.system === '') {
        ship.jumpTo = '';
        ship.jumpProgress = 0;
        return { spooling: '' };
      }

      if (ship.jumpTo !== '') return ctx.reject('already-spooling');

      const here = this.system;
      if (!here?.links.includes(message.system)) return ctx.reject('no-lane');

      // Clearance is checked against the server's position, never the client's.
      if (Math.hypot(ship.x, ship.y) < JUMP_CLEARANCE) {
        return ctx.reject('too-close-to-the-star');
      }

      const pilot = this.pilotsBySession.get(client.sessionId);
      const cost = jumpCost(runtime.stats.totalMass);
      if (pilot && pilot.propellant < cost) return ctx.reject('short-of-propellant');

      ship.jumpTo = message.system;
      ship.jumpProgress = 0;
      return { spooling: message.system, cost };
    }),

    /** Be taken alongside a berth. A landed hull leaves the simulation. */
    land: validate(LandIntent, (client: Client, message: LandIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const ship = this.state.ships.get(client.sessionId);
      if (!ship || ship.destroyedAt > 0) return ctx.reject('not-owned');

      if (message.port === '') {
        ship.landingAt = '';
        ship.landingProgress = 0;
        return { landing: '' };
      }

      const port = this.system?.ports.find((candidate) => candidate.id === message.port);
      if (!port) return ctx.reject('unknown-target');

      const distance = Math.hypot(port.x - ship.x, port.y - ship.y);
      if (distance > port.radius + LANDING_RANGE) return ctx.reject('not-in-reach');

      const speed = Math.hypot(ship.vx, ship.vy);
      if (speed > LANDING_SPEED) return ctx.reject('too-fast-to-land');

      const pilot = this.pilotsBySession.get(client.sessionId);
      // A posted captain is refused at every port until the composition is paid.
      if (pilot && pilot.composition > 0 && port.owner !== 'unlettered') {
        return ctx.reject('posted-here');
      }

      ship.landingAt = port.id;
      ship.landingProgress = 0;
      ship.jumpTo = '';
      ship.jumpProgress = 0;
      return { landing: port.id };
    }),

    /** Leave the berth and rejoin the simulation. */
    launch: validate(LaunchIntent, (client: Client, _message: LaunchIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      pilot.landedPortId = undefined;

      // Launch clear of the berth, pointed away from it.
      if (port) {
        const rng = new Rng(`${this.roomId}:${client.sessionId}:${this.clock.elapsedTime}`);
        const bearing = rng.range(-Math.PI, Math.PI);
        pilot.x = port.x + Math.cos(bearing) * (port.radius + LANDING_RANGE * 0.7);
        pilot.y = port.y + Math.sin(bearing) * (port.radius + LANDING_RANGE * 0.7);
        pilot.angle = bearing;
      }
      world().pilots.touch(pilot.accountId);

      this.spawnFromPilot(client.sessionId, pilot);
      return { launched: true };
    }),

    scoop: validate(ScoopIntent, (client: Client, message: ScoopIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
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

  private unhandled: number | undefined;

  /**
   * A bug in a handler must not take the server down.
   *
   * Without this, an uncaught exception inside the room shuts the process
   * down ungracefully and disconnects everyone. Logging and carrying on is
   * the designed state.
   */
  override onUncaughtException(error: Error, methodName: string): void {
    console.error(`[${this.roomId}] uncaught exception in ${methodName}:`, error);
  }

  /** True when this connection is inside its intent budget. */
  private allowIntent(sessionId: string): boolean {
    const now = this.clock.elapsedTime;
    const log = this.intentLog.get(sessionId) ?? [];
    const recent = log.filter((at) => now - at < INTENT_WINDOW_MS);
    recent.push(now);
    this.intentLog.set(sessionId, recent);
    return recent.length <= INTENT_BUDGET;
  }

  override onDispose(): void {
    this.unregisterMetrics?.();
    this.unregisterMetrics = undefined;
  }

  /**
   * Who is this.
   *
   * A device token is the only credential a room accepts; opening an account
   * and recovering one are HTTP routes, so the room never sees a phrase.
   * Development builds may join without one, which gives a throwaway captain.
   */
  override onAuth(_client: Client, options: JoinOptions = {}): Account | undefined {
    const token = typeof options.deviceToken === 'string' ? options.deviceToken : '';
    if (token === '') {
      if (config.isProduction) throw new AuthError('bad-token');
      return undefined;
    }
    return world().accounts.signIn(token);
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const account = client.auth as Account | undefined;
    const pilot = account ? world().pilots.load(account.id) : undefined;

    if (pilot) {
      this.pilotsBySession.set(client.sessionId, pilot);
      this.sessionsByAccount.set(pilot.accountId, client.sessionId);

      // A landed captain has no hull in space. They see the port's terminal
      // until they launch.
      if (pilot.landedPortId !== undefined) {
        client.send('at-port', { port: pilot.landedPortId, system: pilot.systemId });
        return;
      }

      this.spawnFromPilot(client.sessionId, pilot);
      return;
    }

    // No account: a throwaway captain, for development and the harnesses.
    const { blueprints } = content();
    const requested = typeof options.blueprint === 'string' ? options.blueprint : undefined;
    const blueprintId =
      requested !== undefined && blueprints.has(requested) ? requested : STARTER_BLUEPRINT;
    this.spawnHull(client.sessionId, blueprintId, `Captain-${client.sessionId.slice(0, 4)}`, false);
  }

  /**
   * A captain dropped without saying goodbye.
   *
   * Their hull stays in space for the grace window, still simulated and still
   * vulnerable, because vanishing the instant someone shoots at you would be
   * the cheapest escape in the game. Reconnecting inside the window resumes
   * the same hull.
   */
  override async onDrop(client: Client): Promise<void> {
    this.persist(client.sessionId);

    const runtime = this.runtimes.get(client.sessionId);
    const hurtRecently =
      runtime !== undefined &&
      runtime.lastHitAt > 0 &&
      this.clock.elapsedTime - runtime.lastHitAt < RECENT_DAMAGE_MS;

    const grace = hurtRecently ? GRACE_AFTER_DAMAGE_MS : GRACE_MS;
    await this.allowReconnection(client, grace / 1000);
  }

  override onReconnect(client: Client): void {
    const pilot = this.pilotsBySession.get(client.sessionId);
    console.log(
      `[${this.roomId}] ${pilot?.callsign ?? client.sessionId} resumed the hull they left`,
    );
  }

  /**
   * A captain is gone for good: they left, or the grace window closed.
   */
  override onLeave(client: Client): void {
    this.intentLog.delete(client.sessionId);
    this.persist(client.sessionId);
    this.releaseCaptain(client.sessionId);
    this.removeHull(client.sessionId);
  }

  /** Spawn a hull from what the captain's row says about it. */
  private spawnFromPilot(sessionId: string, pilot: Pilot): void {
    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(pilot.blueprintId) ?? blueprints.get(STARTER_BLUEPRINT);
    if (!blueprint) throw new Error('no draught to fly');

    const runtime = new ShipRuntime(blueprint, modules, tuning, EMPTY_LOADOUT, pilot.ammo);

    // Restore damage, but never more modules than this draught has: a row
    // written against a different draught must not corrupt the hull.
    pilot.moduleHp.slice(0, runtime.hp.length).forEach((hp, index) => {
      const max = runtime.modules[index]?.def.hitPoints ?? 0;
      runtime.hp[index] = Math.max(0, Math.min(max, hp));
    });

    const ship = new ShipState();
    ship.x = pilot.x;
    ship.y = pilot.y;
    ship.angle = pilot.angle;
    ship.callsign = pilot.callsign;
    ship.blueprint = blueprint.id;
    ship.hostile = false;
    ship.shield = Math.min(pilot.shield, runtime.shieldCapacity);
    for (const hp of runtime.hp) ship.moduleHp.push(Math.round(hp));

    // A captain who has never flown, or who was written off, starts off a berth.
    if (ship.x === 0 && ship.y === 0) {
      const berth = this.system?.ports[0];
      const rng = new Rng(`${this.roomId}:${sessionId}`);
      const bearing = rng.range(-Math.PI, Math.PI);
      ship.x = (berth?.x ?? 0) + Math.cos(bearing) * SPAWN_STANDOFF;
      ship.y = (berth?.y ?? 0) + Math.sin(bearing) * SPAWN_STANDOFF;
      ship.angle = Math.atan2((berth?.y ?? 0) - ship.y, (berth?.x ?? 0) - ship.x);
    }

    // A hull that has just arrived is briefly untouchable, so a jump does not
    // drop a captain straight into somebody's guns.
    ship.protectedUntil = Math.round(this.clock.elapsedTime + ARRIVAL_PROTECTION_SECONDS * 1000);

    this.runtimes.set(sessionId, runtime);
    this.state.ships.set(sessionId, ship);
  }

  /** Write a captain's hull state back to their row. */
  private persist(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    const ship = this.state.ships.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!pilot || !ship || !runtime) return;

    pilot.systemId = this.state.systemId;
    pilot.x = ship.x;
    pilot.y = ship.y;
    pilot.angle = ship.angle;
    pilot.blueprintId = ship.blueprint;
    pilot.moduleHp = [...runtime.hp];
    pilot.shield = ship.shield;
    pilot.ammo = runtime.ammo;
    world().pilots.touch(pilot.accountId);
  }

  private releaseCaptain(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (pilot) {
      world().pilots.release(pilot.accountId);
      this.sessionsByAccount.delete(pilot.accountId);
    }
    this.pilotsBySession.delete(sessionId);
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
      this.advanceTravel(id, ship, runtime, ctx.dt);
      this.combat.fire(id, ship, runtime, command.firePrimary, command.fireSecondary);
      this.regenerateShield(ship, runtime, ctx.dt, now);
    }

    this.combat.step(ctx.dt, ctx.tick);
    this.combat.stepCanisters(ctx.dt);

    // Position and damage are fast-changing, so they are copied to the
    // captain's row on a cadence rather than every step; the world writes
    // them to disk from there.
    if (ctx.tick % PERSIST_EVERY_TICKS === 0) {
      for (const sessionId of this.pilotsBySession.keys()) this.persist(sessionId);
    }

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

  /**
   * Advance a spool or an approach.
   *
   * Both run on the fixed step rather than a timer, so they are paced by the
   * simulation and a captain cannot gain a jump by lagging.
   */
  private advanceTravel(
    sessionId: string,
    ship: ShipState,
    runtime: ShipRuntime,
    dt: number,
  ): void {
    if (ship.jumpTo !== '') {
      // Drifting back inside the clearance cancels the spool: the lane will
      // not take a hull this close to the star.
      if (Math.hypot(ship.x, ship.y) < JUMP_CLEARANCE) {
        ship.jumpTo = '';
        ship.jumpProgress = 0;
        this.clients.get(sessionId)?.send('jump-failed', { reason: 'too-close-to-the-star' });
      } else {
        ship.jumpProgress = Math.min(1, ship.jumpProgress + dt / JUMP_SPOOL_SECONDS);
        if (ship.jumpProgress >= 1) this.completeJump(sessionId, ship, runtime);
      }
      return;
    }

    if (ship.landingAt !== '') {
      ship.landingProgress = Math.min(1, ship.landingProgress + dt / LANDING_SECONDS);
      if (ship.landingProgress >= 1) this.completeLanding(sessionId, ship);
    }
  }

  /**
   * The spool finished.
   *
   * The captain's row moves to the destination and the hull leaves this room.
   * The client joins the destination's room, which spawns it at the edge with
   * a moment of protection.
   */
  private completeJump(sessionId: string, ship: ShipState, runtime: ShipRuntime): void {
    const destination = ship.jumpTo;
    const pilot = this.pilotsBySession.get(sessionId);
    const cost = jumpCost(runtime.stats.totalMass);

    if (pilot) {
      if (pilot.propellant < cost) {
        ship.jumpTo = '';
        ship.jumpProgress = 0;
        this.clients.get(sessionId)?.send('jump-failed', { reason: 'short-of-propellant' });
        return;
      }
      pilot.propellant -= cost;
      pilot.systemId = destination;
      // Arrive at the edge of the destination, on the bearing of travel.
      const bearing = Math.atan2(ship.y, ship.x);
      const edge = (content().systems.get(destination)?.radius ?? 30000) * 0.82;
      pilot.x = Math.cos(bearing) * edge;
      pilot.y = Math.sin(bearing) * edge;
      pilot.angle = Math.atan2(-pilot.y, -pilot.x);
      pilot.moduleHp = [...runtime.hp];
      pilot.shield = ship.shield;
      pilot.ammo = runtime.ammo;
      world().pilots.touch(pilot.accountId);
    }

    this.clients.get(sessionId)?.send('jump-complete', {
      system: destination,
      propellantSpent: cost,
    });

    // The hull is no longer here. The client joins the destination's room.
    this.removeHull(sessionId);
    this.pilotsBySession.delete(sessionId);
    if (pilot) this.sessionsByAccount.delete(pilot.accountId);
  }

  /** The approach finished: the hull is alongside and out of the simulation. */
  private completeLanding(sessionId: string, ship: ShipState): void {
    const portId = ship.landingAt;
    const pilot = this.pilotsBySession.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    const port = this.system?.ports.find((candidate) => candidate.id === portId);

    if (pilot && port) {
      pilot.landedPortId = portId;
      pilot.x = port.x;
      pilot.y = port.y;
      pilot.angle = ship.angle;
      if (runtime) {
        pilot.moduleHp = [...runtime.hp];
        pilot.ammo = runtime.ammo;
      }
      pilot.shield = ship.shield;
      world().pilots.touch(pilot.accountId);
    }

    this.clients.get(sessionId)?.send('landed', { port: portId });

    // A landed hull leaves the simulation and cannot be attacked.
    this.removeHull(sessionId);
    this.pilotsBySession.delete(sessionId);
    if (pilot) this.sessionsByAccount.delete(pilot.accountId);
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
