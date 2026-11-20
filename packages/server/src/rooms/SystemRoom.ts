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
  PortServiceIntent,
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
  ChatIntent,
  StapleIntent,
  berthRefusesPosted,
  compositionForDamage,
  compositionForWriteOff,
  content,
  scrubChat,
  deriveStats,
  placeAll,
  stepFlight,
  type Blueprint,
  type ChatLine,
  type FlightCommand,
  type PortDef,
  type SystemDef,
} from '@marque/shared';

import { registerRoom, TickMetrics } from '../metrics.ts';
import { AuthError, type Account } from '../accounts.ts';
import { InsufficientMarks } from '../world/Ledger.ts';
import { world } from '../world/World.ts';
import type { Pilot } from '../world/PilotStore.ts';
import { CombatSystem, type ImpactEvent } from './combat.ts';
import { ShipRuntime } from './ShipRuntime.ts';
import { patrolPilot, unletteredPilot, type NpcPilot, type NpcRole } from './npc.ts';
import { TradeRefused } from '../world/Market.ts';

/** The draught every Open Ticket starts with. */
const STARTER_BLUEPRINT = 'prudent-return';

/** Draughts the Unlettered fly: whatever they could get. */
const RAIDER_BLUEPRINTS = ['short-measure', 'force-majeure'] as const;

/** What the Prize Court puts on patrol. It is faster than what it chases. */
const PATROL_BLUEPRINTS = ['force-majeure'] as const;

export interface SystemRoomOptions {
  /** Content id of the system to simulate. */
  systemId?: string;
  /** Raiders to keep in the system while captains are present. */
  raiders?: number;
  /** How many patrols stand here; defaults to what the security level says. */
  patrols?: number;
}

export interface JoinOptions {
  /** Issued at sign-up and stored by the client. */
  deviceToken?: string;
  /** Draught to fly, for development. A captain's own draught wins. */
  blueprint?: string;
}

/** Arrivals scatter inside this radius around a berth. */
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

/** Chat is typed by a person, so it gets a person's budget. */
const CHAT_BUDGET = 6;
const CHAT_WINDOW_MS = 10_000;

/** The presence topic every room listens on for the global channel. */
const GLOBAL_CHAT_TOPIC = 'chat:global';

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
  /** Where each NPC holds when it has nothing to answer for. */
  private readonly stations = new Map<string, { x: number; y: number }>();
  /** When each captain last spoke, for the chat budget. */
  private readonly chatLog = new Map<string, number[]>();
  private nextChatId = 1;
  /** Torn down on dispose so a room does not keep answering after it ends. */
  private unsubscribeChat: (() => void) | undefined;

  private system: SystemDef | undefined;
  private combat!: CombatSystem;
  private raiderTarget = 0;
  private patrolTarget = 0;
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
      // The Home Roads close to a posted captain. Further out the berths take
      // their money and ask nothing, which is where the composition is paid.
      const security = this.system?.security;
      if (
        pilot &&
        pilot.composition > 0 &&
        security !== undefined &&
        berthRefusesPosted(security, content().tuning.law)
      ) {
        return ctx.reject('posted-here');
      }

      ship.landingAt = port.id;
      ship.landingProgress = 0;
      ship.jumpTo = '';
      ship.jumpProgress = 0;
      return { landing: port.id };
    }),

    /**
     * Buy something at the berth.
     *
     * Every one of these moves marks, so every one goes through the ledger in
     * a single transaction: the row and the balance land together or neither
     * does. A captain who cannot afford it is refused, not clamped.
     */
    port: validate(PortServiceIntent, (client: Client, message: PortServiceIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((p) => p.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');

      const { tuning, blueprints, modules } = content();
      const prices = tuning.ports;
      const blueprint = blueprints.get(pilot.blueprintId);
      if (!blueprint) return ctx.reject('not-owned');

      const placed = placeAll(blueprint.placements, modules);
      const stats = deriveStats(placed, tuning);

      try {
        switch (message.service) {
          case 'repair': {
            if (!port.services.includes('repair')) return ctx.reject('no-such-service');

            const intact = placed.map((m) => m.def.hitPoints);
            const missing = intact.reduce(
              (sum, max, index) => sum + Math.max(0, max - (pilot.moduleHp[index] ?? max)),
              0,
            );
            if (missing <= 0) return ctx.reject('nothing-to-do');

            const cost = Math.ceil(missing * prices.repairPricePerPoint);
            world().ledger.post(
              {
                accountId: pilot.accountId,
                delta: -cost,
                category: 'repair',
                reason: `Repairs at ${port.name}`,
              },
              pilot,
            );
            pilot.moduleHp = [...intact];
            world().pilots.touch(pilot.accountId);
            this.sendPurse(client.sessionId);
            return { marks: pilot.marks, repaired: missing, cost };
          }

          case 'composition': {
            // Settling with the Prize Court. Paid in full or not at all, so a
            // captain is never left part-posted with no way to read it.
            if (pilot.composition <= 0) return ctx.reject('nothing-owed');

            const owed = pilot.composition;
            world().ledger.post(
              {
                accountId: pilot.accountId,
                delta: -owed,
                category: 'composition',
                reason: `Composition settled at ${port.name}`,
              },
              pilot,
            );
            pilot.composition = 0;
            world().pilots.touch(pilot.accountId);

            const own = this.state.ships.get(client.sessionId);
            if (own) own.posted = false;

            this.sendPurse(client.sessionId);
            return { marks: pilot.marks, settled: owed };
          }

          case 'propellant': {
            const capacity = stats.propellantCapacity;
            const room = Math.max(0, capacity - pilot.propellant);
            if (room <= 0) return ctx.reject('no-room');

            const units = message.units > 0 ? Math.min(message.units, room) : room;
            const cost = units * prices.propellantPrice;
            world().ledger.post(
              {
                accountId: pilot.accountId,
                delta: -cost,
                category: 'propellant',
                reason: `${units} units of Propellant at ${port.name}`,
              },
              pilot,
            );
            pilot.propellant += units;
            world().pilots.touch(pilot.accountId);
            this.sendPurse(client.sessionId);
            return { marks: pilot.marks, units, cost };
          }

          case 'ordnance': {
            // A rack with an empty magazine is ballast.
            const capacity = prices.magazineCapacity;
            const room = Math.max(0, capacity - pilot.ammo);
            if (room <= 0) return ctx.reject('no-room');

            const units = message.units > 0 ? Math.min(message.units, room) : room;
            const cost = units * prices.ordnancePrice;
            world().ledger.post(
              {
                accountId: pilot.accountId,
                delta: -cost,
                category: 'cargo-purchase',
                reason: `${units} units of Ordnance at ${port.name}`,
              },
              pilot,
            );
            pilot.ammo += units;
            world().pilots.touch(pilot.accountId);
            this.sendPurse(client.sessionId);
            return { marks: pilot.marks, units, cost };
          }
        }
      } catch (error) {
        if (error instanceof InsufficientMarks) return ctx.reject('cannot-afford');
        throw error;
      }

      return ctx.reject('no-such-service');
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

      // A hull alongside has had time on the berth's power: shields are
      // charged on launch. Structure still costs money to put right.
      this.spawnFromPilot(client.sessionId, pilot, { chargeShields: true });
      this.sendPurse(client.sessionId);
      return { launched: true };
    }),

    /**
     * Trade at the berth's Staple.
     *
     * The market owns the transaction; the room's job is to establish that
     * this captain is actually alongside this berth and how much their hull
     * can carry, neither of which the market knows about.
     */
    staple: validate(StapleIntent, (client: Client, message: StapleIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');

      try {
        const result = world().market.trade({
          side: message.side,
          port,
          commodityId: message.commodity,
          units: message.units,
          pilot,
          holdCapacity: this.holdCapacityOf(pilot),
          now: Date.now(),
        });

        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
        this.sendStaple(client.sessionId, port);
        return result;
      } catch (error) {
        if (error instanceof TradeRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /**
     * Say something. The global channel goes out through presence, so it
     * reaches every room in the process and, behind Redis presence, every
     * process. The system channel is this room's own business.
     */
    chat: validate(ChatIntent, (client: Client, message: ChatIntent, ctx) => {
      if (!this.allowChat(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-signed-in');

      const body = scrubChat(message.body);
      if (body === '') return ctx.reject('malformed');

      const line: ChatLine = {
        id: `${this.roomId}:${this.nextChatId++}`,
        channel: message.channel,
        callsign: pilot.callsign,
        system: this.state.systemId,
        at: Date.now(),
        body,
      };

      if (line.channel === 'global') {
        this.presence.publish(GLOBAL_CHAT_TOPIC, line);
      } else {
        world().chat.add(line);
        this.broadcast('chat', line);
      }

      return { said: line.id };
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
    const requested = options.systemId ?? content().tuning.start.system;
    this.system = systems.get(requested) ?? [...systems.values()][0];
    this.state.systemId = this.system?.id ?? requested;
    // How many Unlettered hunt here follows how much law reaches the system:
    // nothing in the Home Roads, more the further out you go. A tool can still
    // ask for a set number, which is what the soak sim does.
    const { raidersBySecurity, patrolsBySecurity } = content().tuning.world;
    const security = this.system?.security;
    this.raiderTarget = options.raiders ?? (security ? raidersBySecurity[security] : 0);
    this.patrolTarget = options.patrols ?? (security ? patrolsBySecurity[security] : 0);
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

    // Every room hears the global channel and passes it to its own captains.
    const onGlobal = (line: ChatLine): void => {
      world().chat.add(line);
      this.broadcast('chat', line);
    };
    void this.presence.subscribe(GLOBAL_CHAT_TOPIC, onGlobal);
    this.unsubscribeChat = () => {
      void this.presence.unsubscribe(GLOBAL_CHAT_TOPIC, onGlobal);
    };

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
  /**
   * Chat gets its own, tighter budget.
   *
   * It is the one intent a captain sends by typing, so the limit is about a
   * person's pace rather than a client's: a few lines in a row is normal
   * conversation, a hundred is not.
   */
  private allowChat(sessionId: string): boolean {
    const now = this.clock.elapsedTime;
    const log = this.chatLog.get(sessionId) ?? [];
    const recent = log.filter((at) => now - at < CHAT_WINDOW_MS);
    recent.push(now);
    this.chatLog.set(sessionId, recent);
    return recent.length <= CHAT_BUDGET;
  }

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
    this.unsubscribeChat?.();
    this.unsubscribeChat = undefined;
  }

  /**
   * How much the captain's hull can carry.
   *
   * The bays, less the Propellant and Ordnance already riding in them: a hold
   * is a hold, and the market has no business knowing what a ship is made of.
   */
  private holdCapacityOf(pilot: Pilot): number {
    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(pilot.blueprintId);
    if (!blueprint) return 0;
    const stats = deriveStats(placeAll(blueprint.placements, modules), tuning);
    return Math.max(0, Math.floor(stats.cargoCapacity));
  }

  /** Send a captain alongside the berth's current prices and their own hold. */
  private sendStaple(sessionId: string, port: PortDef): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;
    if (!port.services.includes('staple')) return;

    // Named apart from the `staple` request on purpose: a request and a push
    // share one name space, so a push called `staple` is delivered as the
    // answer to any `staple` request in flight and the real answer never
    // arrives. That cost an afternoon.
    this.clients.get(sessionId)?.send('market', {
      port: port.id,
      listings: world().market.listingsFor(port, pilot.accountId),
      holdCapacity: this.holdCapacityOf(pilot),
      holdUsed: world().market.cargoUnits(pilot.accountId),
    });
  }

  /** Whether a pilot of this role would engage that hull. */
  private engages(selfId: string, otherId: string, other: ShipState, role: NpcRole): boolean {
    if (otherId === selfId || other.destroyedAt > 0) return false;
    return role === 'patrol' ? other.hostile || other.posted : !this.pilots.has(otherId);
  }

  /**
   * The nearest hull a pilot of this role would engage.
   *
   * Walks the ships once and keeps the best, allocating nothing: this runs
   * for every NPC on every tick, and the array-building version it replaced
   * was the server's largest source of short-lived garbage.
   */
  private nearestCandidate(selfId: string, role: NpcRole): string | undefined {
    const self = this.state.ships.get(selfId);
    if (!self) return undefined;

    let bestId: string | undefined;
    let bestDistanceSq = Infinity;

    for (const [otherId, other] of this.state.ships) {
      if (!this.engages(selfId, otherId, other, role)) continue;
      const dx = other.x - self.x;
      const dy = other.y - self.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestId = otherId;
      }
    }

    return bestId;
  }

  /**
   * Who is this.
   *
   * A device token is the only credential a room accepts; opening an account
   * and recovering one are HTTP routes, so the room never sees a phrase.
   * Development builds may join without one, which gives a throwaway captain.
   */
  override onAuth(_client: Client, options: JoinOptions = {}): Account | true {
    const token = typeof options.deviceToken === 'string' ? options.deviceToken : '';
    if (token === '') {
      if (config.isProduction) throw new AuthError('bad-token');
      // `true` means "allowed, carrying nothing": a tool flying a draught
      // with no account. Returning undefined would be read as a refusal —
      // Colyseus treats undefined, null and false alike — which silently
      // turned every anonymous join into an auth failure.
      return true;
    }

    const account = world().accounts.signIn(token);

    // A captain belongs to one system, and persisting them writes this room's
    // system back to their row. Matching is filtered on `systemId`, but a
    // client that names none is matched into whatever room is open, so the
    // room refuses them here rather than quietly moving them across the
    // galaxy. The row is the authority; a jump updates it before the client
    // joins the destination.
    const pilot = world().pilots.load(account.id);
    if (pilot && pilot.systemId !== this.state.systemId) {
      throw new AuthError('wrong-system');
    }

    return account;
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    // `true` is the anonymous case; anything else is a real account.
    const auth = client.auth as Account | true | undefined;
    const account = auth === true ? undefined : auth;
    const pilot = account ? world().pilots.load(account.id) : undefined;

    if (pilot) {
      this.pilotsBySession.set(client.sessionId, pilot);
      this.sessionsByAccount.set(pilot.accountId, client.sessionId);

      // What has been said recently, so the overlay is not blank on arrival.
      client.send('chat-backlog', { lines: world().chat.backlogFor(this.state.systemId) });

      // A landed captain has no hull in space. They see the port's terminal
      // until they launch.
      if (pilot.landedPortId !== undefined) {
        client.send('at-port', { port: pilot.landedPortId, system: pilot.systemId });
        this.sendPurse(client.sessionId);
        const berth = this.system?.ports.find((p) => p.id === pilot.landedPortId);
        if (berth) this.sendStaple(client.sessionId, berth);
        return;
      }

      this.spawnFromPilot(client.sessionId, pilot);
      this.sendPurse(client.sessionId);
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
  private spawnFromPilot(
    sessionId: string,
    pilot: Pilot,
    options: { chargeShields?: boolean } = {},
  ): void {
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

    // Tanks cannot hold more than the hull they are in. A row written against
    // a bigger draught is trimmed here rather than read back as "60 of 30".
    pilot.propellant = Math.min(pilot.propellant, Math.floor(runtime.stats.propellantCapacity));

    const ship = new ShipState();
    ship.x = pilot.x;
    ship.y = pilot.y;
    ship.angle = pilot.angle;
    ship.callsign = pilot.callsign;
    ship.blueprint = blueprint.id;
    ship.hostile = false;
    // Being posted follows the captain between systems and across sessions.
    ship.posted = pilot.composition > 0;
    if (options.chargeShields) pilot.shield = runtime.shieldCapacity;
    ship.shield = Math.min(pilot.shield, runtime.shieldCapacity);
    for (const hp of runtime.hp) ship.moduleHp.push(Math.round(hp));

    // A captain who has never flown, or who was written off, starts off a
    // berth, close enough to see it and to be offered the landing.
    if (ship.x === 0 && ship.y === 0) {
      const berth = this.system?.ports[0];
      const rng = new Rng(`${this.roomId}:${sessionId}`);
      const bearing = rng.range(-Math.PI, Math.PI);
      const standoff = (berth?.radius ?? 0) + tuning.world.spawnStandoff;
      ship.x = (berth?.x ?? 0) + Math.cos(bearing) * standoff;
      ship.y = (berth?.y ?? 0) + Math.sin(bearing) * standoff;
      ship.angle = Math.atan2((berth?.y ?? 0) - ship.y, (berth?.x ?? 0) - ship.x);
    }

    // A hull that has just arrived is briefly untouchable, so a jump does not
    // drop a captain straight into somebody's guns.
    ship.protectedUntil = Math.round(this.clock.elapsedTime + ARRIVAL_PROTECTION_SECONDS * 1000);

    this.runtimes.set(sessionId, runtime);
    this.state.ships.set(sessionId, ship);
  }

  /**
   * Tell a captain what they have.
   *
   * Marks, Propellant and Ordnance are not on the synchronised state, because
   * they are nobody else's business. They go to the one client that owns
   * them, whenever they change.
   */
  private sendPurse(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;

    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(pilot.blueprintId);
    const placed = blueprint ? placeAll(blueprint.placements, modules) : [];
    const stats = placed.length > 0 ? deriveStats(placed, tuning) : undefined;

    const intact = placed.reduce((sum, m) => sum + m.def.hitPoints, 0);
    const left = placed.reduce(
      (sum, m, index) => sum + Math.min(m.def.hitPoints, pilot.moduleHp[index] ?? m.def.hitPoints),
      0,
    );

    this.clients.get(sessionId)?.send('purse', {
      marks: pilot.marks,
      propellant: pilot.propellant,
      propellantCapacity: stats?.propellantCapacity ?? 0,
      ordnance: pilot.ammo,
      structure: intact > 0 ? left / intact : 1,
      draught: blueprint?.name ?? pilot.blueprintId,
      licence: pilot.licence,
      composition: pilot.composition,
      jumpCost: stats ? jumpCost(stats.totalMass) : 1,
      system: pilot.systemId,
      landedPort: pilot.landedPortId ?? '',
    });
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

  /**
   * Put a hull in the system.
   *
   * Where it goes follows what it is: a captain is set down off the berth
   * like any other captain, a patrol stands a little further out over it, and
   * the Unlettered hold well off in open space. `role` left out means a
   * captain, which is what an anonymous hull from a tool is.
   */
  private spawnHull(
    id: string,
    blueprintId: string,
    callsign: string,
    hostile: boolean,
    role?: NpcRole,
  ): void {
    const { blueprints, modules, tuning } = content();
    const blueprint: Blueprint | undefined = blueprints.get(blueprintId);
    if (!blueprint) throw new Error(`draught "${blueprintId}" is missing`);

    const runtime = new ShipRuntime(blueprint, modules, tuning, EMPTY_LOADOUT, STARTING_AMMO);

    const rng = new Rng(`${this.roomId}:${id}`);
    const bearing = rng.range(-Math.PI, Math.PI);
    const { raiderStandoff, raiderScatter, spawnStandoff } = tuning.world;
    // A captain is set down where they are put; the others scatter, so a wing
    // does not arrive stacked on one point.
    const distance = role === undefined ? 0 : raiderScatter * Math.sqrt(rng.next());

    const berth = this.system?.ports[0];
    const standoff =
      role === 'unlettered'
        ? raiderStandoff
        : (berth?.radius ?? 0) + spawnStandoff * (role === 'patrol' ? 2 : 1);
    const anchorX = berth ? berth.x + Math.cos(bearing) * standoff : 0;
    const anchorY = berth ? berth.y + Math.sin(bearing) * standoff : 0;
    this.stations.set(id, { x: anchorX, y: anchorY });

    const ship = new ShipState();
    ship.x = anchorX + Math.cos(bearing) * distance;
    ship.y = anchorY + Math.sin(bearing) * distance;
    ship.angle = berth
      ? Math.atan2(berth.y - ship.y, berth.x - ship.x)
      : Math.atan2(-ship.y, -ship.x);
    ship.callsign = callsign;
    ship.blueprint = blueprintId;
    ship.hostile = hostile;
    ship.patrol = role === 'patrol';
    ship.shield = runtime.shieldCapacity;
    for (const hp of runtime.hp) ship.moduleHp.push(Math.round(hp));

    this.runtimes.set(id, runtime);
    this.state.ships.set(id, ship);
  }

  private removeHull(id: string): void {
    this.state.ships.delete(id);
    this.runtimes.delete(id);
    this.pilots.delete(id);
    this.stations.delete(id);
    this.combat.retireRoundsOf(id);
  }

  // --- The step -----------------------------------------------------------

  private step(ctx: StepContext): void {
    const startedAt = performance.now();
    const now = this.clock.elapsedTime;

    this.maintainNpcs();

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
        // What each role is willing to engage. The Unlettered rob traffic and
        // leave each other alone; a patrol answers for the Unlettered and for
        // captains the Prize Court has posted, and for nobody else.
        nearestCandidate: (selfId) => this.nearestCandidate(selfId, pilot.role),
        candidate: (selfId, id) => {
          const other = this.state.ships.get(id);
          return other && this.engages(selfId, id, other, pilot.role) ? other : undefined;
        },
        stationOf: (selfId) => this.stations.get(selfId) ?? { x: 0, y: 0 },
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
      // A landing fee applies per visit. It is small, and it is the first
      // thing in the game that takes marks off a captain.
      const fee = content().tuning.ports.landingFee;
      if (fee > 0) {
        try {
          world().ledger.post(
            {
              accountId: pilot.accountId,
              delta: -fee,
              category: 'landing-fee',
              reason: `Landing fee at ${port.name}`,
            },
            pilot,
          );
        } catch {
          // A captain too poor for the fee still lands: being stranded in
          // space with no marks is not a state worth creating.
        }
      }

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

    this.sendPurse(sessionId);
    this.clients.get(sessionId)?.send('landed', { port: portId });

    // What the berth is trading, so the terminal opens on real prices rather
    // than on a screen that has to ask for them.
    const berth = this.system?.ports.find((candidate) => candidate.id === portId);
    if (berth) this.sendStaple(sessionId, berth);

    // A landed hull leaves the simulation and cannot be attacked. The
    // captain does not leave the room: they are standing on the berth, and
    // every service it sells — repairs, Propellant, Ordnance, the
    // composition, the Staple — is answered by looking them up here. Dropping
    // them meant the room no longer knew whose berth it was, and refused all
    // of it with "you do not own that".
    this.removeHull(sessionId);
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

  /**
   * Keep the system's complement up: a few Unlettered to rob the traffic, and
   * the patrols the Prize Court answers for it with. Both only while there is
   * a captain present to see them.
   */
  private maintainNpcs(): void {
    const captains = [...this.state.ships].filter(
      ([id, ship]) => !this.pilots.has(id) && ship.destroyedAt === 0,
    ).length;

    this.maintainRole('unlettered', captains > 0 ? this.raiderTarget : 0);
    this.maintainRole('patrol', captains > 0 ? this.patrolTarget : 0);
  }

  private maintainRole(role: NpcRole, wanted: number): void {
    const held = [...this.pilots].filter(([, pilot]) => pilot.role === role).map(([id]) => id);

    if (held.length < wanted) {
      const id = `npc-${this.nextNpcId++}`;
      if (role === 'patrol') {
        this.spawnHull(id, this.rng.pick(PATROL_BLUEPRINTS), patrolName(this.rng), false, role);
        this.pilots.set(id, patrolPilot(id, `${this.roomId}:${id}`));
      } else {
        this.spawnHull(id, this.rng.pick(RAIDER_BLUEPRINTS), raiderName(this.rng), true, role);
        this.pilots.set(id, unletteredPilot(id, `${this.roomId}:${id}`));
      }
    } else if (held.length > wanted) {
      const id = held.at(-1);
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

    // Writing off lawful traffic is a separate matter from damaging it.
    if (!ship.hostile) {
      const killer = this.pilotsBySession.get(killedBy);
      const security = this.system?.security;
      if (killer && security) {
        this.addComposition(
          killer,
          killedBy,
          compositionForWriteOff(security, content().tuning.law),
        );
      }
    }

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

  /**
   * Firing on lawful traffic where law reaches.
   *
   * The Prize Court strikes a composition per point of damage dealt, shields
   * included, weighted by the system's security: the Home Roads at full, the Concessions
   * lightly, the Marque not at all. A posted captain is refused at every berth
   * but the Unlettered's, and patrols answer for them.
   *
   * It does not apply to the Unlettered, who are nobody's lawful traffic, and
   * it cannot be run up by shooting a wreck.
   */
  private postIfUnlawful(shooterId: string, targetId: string, damageDealt: number): void {
    if (damageDealt <= 0) return;

    const security = this.system?.security;
    if (!security) return;
    const { law } = content().tuning;
    const struck = compositionForDamage(damageDealt, security, law);
    if (struck <= 0) return;

    // Only a captain can be posted, and only for a hull that was lawful.
    const pilot = this.pilotsBySession.get(shooterId);
    if (!pilot) return;
    const target = this.state.ships.get(targetId);
    if (!target || target.hostile || target.destroyedAt > 0) return;

    this.addComposition(pilot, shooterId, struck);
  }

  /** Raise a captain's composition and tell them why, once per change. */
  private addComposition(pilot: Pilot, sessionId: string, amount: number): void {
    const added = Math.round(amount);
    if (added <= 0) return;

    const wasPosted = pilot.composition > 0;
    pilot.composition += added;
    world().pilots.touch(pilot.accountId);

    const ship = this.state.ships.get(sessionId);
    if (ship) ship.posted = true;

    if (!wasPosted) {
      this.clients.get(sessionId)?.send('posted', { composition: pilot.composition });
    }
    this.sendPurse(sessionId);
  }

  private broadcastImpact(event: ImpactEvent): void {
    this.postIfUnlawful(event.shooterId, event.targetId, event.damageDealt);

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

/**
 * What the Prize Court calls its hulls: the same legal register as any other
 * ship's name, read flatter.
 */
const PATROL_NAMES = [
  'Due Process',
  'Strict Liability',
  'Burden of Proof',
  'Letter and Spirit',
  'Without Notice',
  'On the Record',
  'Lawful Order',
  'Good Faith',
] as const;

function patrolName(rng: Rng): string {
  return rng.pick(PATROL_NAMES);
}
