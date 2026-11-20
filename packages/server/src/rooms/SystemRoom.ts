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
  BuildIntent,
  ChatIntent,
  ForgetDesignIntent,
  BuyLicenceIntent,
  GiveDesignIntent,
  ImportDesignIntent,
  BourseIntent,
  AbandonCommissionIntent,
  ChainEndingIntent,
  LetterIntent,
  TakeCommissionIntent,
  SaveDesignIntent,
  SwitchShipIntent,
  StapleIntent,
  berthRefusesPosted,
  compositionForDamage,
  compositionForWriteOff,
  content,
  scrubChat,
  deriveStats,
  buildCost,
  builtBlueprint,
  encodeShareCode,
  isCharter,
  standingName,
  contrabandIn,
  letterLapsed,
  mayHoldLetter,
  CHARTERS,
  placeAll,
  stepFlight,
  type Blueprint,
  type Standing,
  type LicenceId,
  type ChatLine,
  type FlightCommand,
  type PortDef,
  type SystemDef,
} from '@marque/shared';

import { registerRoom, TickMetrics } from '../metrics.ts';
import { AuthError, type Account } from '../accounts.ts';
import { BourseRefused } from '../world/Exchange.ts';
import { CommissionRefused } from '../world/Commissions.ts';
import { InsufficientMarks } from '../world/Ledger.ts';
import { world } from '../world/World.ts';
import type { Pilot } from '../world/PilotStore.ts';
import { CombatSystem, type ImpactEvent } from './combat.ts';
import { ShipRuntime } from './ShipRuntime.ts';
import {
  freighterName,
  freighterPilot,
  patrolName,
  patrolPilot,
  raiderName,
  unletteredPilot,
  type NpcPilot,
  type NpcRole,
} from './npc.ts';
import { TradeRefused } from '../world/Market.ts';
import { YardRefused } from '../world/Yard.ts';

/** The draught every Open Ticket starts with. */
const STARTER_BLUEPRINT = 'prudent-return';

/** Draughts the Unlettered fly: whatever they could get. */
/** How often the leaderboard is re-derived. It is a board, not a readout. */
const STANDINGS_INTERVAL_MS = 15_000;

const RAIDER_BLUEPRINTS = ['short-measure', 'force-majeure'] as const;

/** What the Prize Court puts on patrol. It is faster than what it chases. */
const PATROL_BLUEPRINTS = ['force-majeure'] as const;

/**
 * What the companies put on a milk run: slow, capacious and unarmed.
 *
 * Fair Wear and Tear is five holds and one engine, which is exactly the hull
 * a company buys when the cargo is cheap and the lane is supposed to be safe.
 */
const FREIGHTER_BLUEPRINTS = ['fair-wear-and-tear'] as const;

export interface SystemRoomOptions {
  /** Content id of the system to simulate. */
  systemId?: string;
  /** Company freighters on the lane, for a harness that wants a known sky. */
  freighters?: number;
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

/**
 * Every live system room.
 *
 * The World owns the market tick and knows nothing about rooms, which is
 * right: it should not have to. This is the other half of that — a registry
 * the server's wiring can walk when the Bourse moves, so captains standing on
 * a berth see the board change under them rather than only on the next trade.
 */
const liveRooms = new Set<SystemRoom>();

/** Tell every room the Bourse has moved. */
export function refreshEveryBourse(): void {
  for (const room of liveRooms) room.refreshBourse();
}

/**
 * Let every room's patrols look at the traffic.
 *
 * Driven from the world's economy tick for the same reason the Bourse is: a
 * scan is a thing that happens now and then, and the rooms should not each
 * keep their own timer for it.
 */
export function scanEveryLane(): void {
  for (const room of liveRooms) room.runPatrolScans();
}

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
  /** Company freighters on the lane here, from the system's own traffic. */
  private freighterTarget = 0;

  /**
   * What each freighter is carrying.
   *
   * Only the room knows: a consignment is not on the synchronised state
   * because nothing a captain can see should tell them which hull is worth
   * intercepting before they have looked. Spec M7 gives freighters real
   * cargo a captain can board; this is the earnings half of it.
   */
  private readonly consignments = new Map<string, { commodityId: string; units: number }>();

  /** The leaderboard, and when it was last worked out. */
  private standings: (Standing & { accountId: string })[] | undefined;
  private standingsAt = -Infinity;
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

      // And a company's own berth closes to a captain it has had enough of.
      // Only its own: being hated by the Thirty does not shut a Kessler
      // counting-house, which is what makes taking a side survivable.
      const berth = this.system?.ports.find((candidate) => candidate.id === message.port);
      if (pilot && berth && isCharter(berth.owner)) {
        if (!world().standings.accepts(pilot.accountId, berth.owner)) {
          return ctx.reject('barred-here');
        }
      }

      // Asking again for the berth already being approached is a no-op, not a
      // restart: resetting the progress would mean a captain holding the key
      // down, or a tool asking on a timer, could never actually arrive.
      if (ship.landingAt === port.id) return { landing: port.id };

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
            // Propellant is a commodity like any other: spec section 9 says
            // jump fuel is bought at ports at the market price, so filling the
            // tanks goes through the berth's own Staple and takes its stock
            // down. Charging a fixed rate here meant a berth short of it still
            // sold it at the list price, and the same good had two prices.
            const capacity = stats.propellantCapacity;
            const room = Math.max(0, capacity - pilot.propellant);
            if (room <= 0) return ctx.reject('no-room');

            const wanted = message.units > 0 ? Math.min(message.units, room) : room;
            try {
              const filled = world().market.fill({
                port,
                commodityId: 'propellant',
                units: wanted,
                pilot,
                now: Date.now(),
              });
              pilot.propellant += filled.units;
              world().pilots.touch(pilot.accountId);
              this.sendPurse(client.sessionId);
              this.sendStaple(client.sessionId, port);
              return { marks: pilot.marks, units: filled.units, cost: filled.marks };
            } catch (error) {
              if (error instanceof TradeRefused) return ctx.reject(error.reason);
              throw error;
            }
          }

          case 'ordnance': {
            // Ordnance is a commodity too, bought from the berth's own stock
            // at the berth's own price. A rack with an empty magazine is
            // ballast, and a berth that has been shot dry charges for it.
            const capacity = prices.magazineCapacity;
            const room = Math.max(0, capacity - pilot.ammo);
            if (room <= 0) return ctx.reject('no-room');

            const wanted = message.units > 0 ? Math.min(message.units, room) : room;
            try {
              const filled = world().market.fill({
                port,
                commodityId: 'ordnance',
                units: wanted,
                pilot,
                now: Date.now(),
              });
              pilot.ammo += filled.units;
              world().pilots.touch(pilot.accountId);
              this.sendPurse(client.sessionId);
              this.sendStaple(client.sessionId, port);
              return { marks: pilot.marks, units: filled.units, cost: filled.marks };
            } catch (error) {
              if (error instanceof TradeRefused) return ctx.reject(error.reason);
              throw error;
            }
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

    /** Keep a draught on the captain's books. */
    'save-design': validate(SaveDesignIntent, (client: Client, message: SaveDesignIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');

      try {
        const saved = world().yard.saveDesign(
          pilot.accountId,
          { ...(message.id !== undefined ? { id: message.id } : {}), name: message.name, placements: message.placements },
          Date.now(),
        );
        this.sendYard(client.sessionId);
        return saved;
      } catch (error) {
        if (error instanceof YardRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /** And take one off them. */
    'forget-design': validate(
      ForgetDesignIntent,
      (client: Client, message: ForgetDesignIntent, ctx) => {
        if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
        const pilot = this.pilotsBySession.get(client.sessionId);
        if (!pilot) return ctx.reject('not-owned');

        try {
          world().yard.deleteDesign(pilot.accountId, message.id);
          this.sendYard(client.sessionId);
          return { forgotten: message.id };
        } catch (error) {
          if (error instanceof YardRefused) return ctx.reject(error.reason);
          throw error;
        }
      },
    ),

    /**
     * Build a hull, or refit the one being flown.
     *
     * Only at a berth that keeps a Yard, and only from a design the server
     * validates for itself: the editor's quote is a courtesy, not an
     * authority.
     */
    build: validate(BuildIntent, (client: Client, message: BuildIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');
      if (!port.services.includes('yard')) return ctx.reject('no-yard');

      try {
        const receipt = world().yard.build({
          pilot,
          portId: port.id,
          systemId: this.state.systemId,
          name: message.name,
          placements: message.placements,
          ...(message.refitting !== undefined ? { refitting: message.refitting } : {}),
          now: Date.now(),
        });

        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
        this.sendStaple(client.sessionId, port);
        this.sendYard(client.sessionId);
        return receipt;
      } catch (error) {
        if (error instanceof YardRefused) {
          // The problems go with the refusal: the editor marks them on the
          // grid where they are, and a captain fixing one should not find the
          // next by surprise.
          this.clients.get(client.sessionId)?.send('survey', { problems: error.problems });
          return ctx.reject(error.reason);
        }
        throw error;
      }
    }),

    /**
     * Read a draught code onto the captain's books.
     *
     * No berth needed: a draught is paper, and a captain reading one in open
     * space is doing nothing a Yard has to witness.
     */
    'import-design': validate(
      ImportDesignIntent,
      (client: Client, message: ImportDesignIntent, ctx) => {
        if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
        const pilot = this.pilotsBySession.get(client.sessionId);
        if (!pilot) return ctx.reject('not-owned');

        try {
          const saved = world().yard.importDesign(
            pilot.accountId,
            message.code,
            message.name,
            Date.now(),
          );
          this.sendYard(client.sessionId);
          return saved;
        } catch (error) {
          if (error instanceof YardRefused) return ctx.reject(error.reason);
          throw error;
        }
      },
    ),

    /** Hand a draught to another captain, wherever they are. */
    'give-design': validate(GiveDesignIntent, (client: Client, message: GiveDesignIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');
      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');

      try {
        const given = world().yard.giveDesign(
          pilot.accountId,
          message.id,
          message.callsign,
          Date.now(),
        );

        // If they happen to be in this system, they find out at once; if not,
        // the draught is simply on their books next time they look. The
        // notice is a courtesy, so nothing here depends on it arriving.
        const theirSession = this.sessionsByAccount.get(given.toAccountId);
        if (theirSession !== undefined) {
          this.clients.get(theirSession)?.send('given-design', {
            name: given.design.name,
            from: pilot.callsign,
          });
          this.sendYard(theirSession);
        }

        return { to: given.toCallsign, name: given.design.name };
      } catch (error) {
        if (error instanceof YardRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /**
     * Take a commission off this berth's board.
     *
     * The offer is rebuilt from the board rather than trusted from the
     * client: an id is a claim about what was posted, and what a Factor
     * actually offered is the Factor's business.
     */
    'take-commission': validate(
      TakeCommissionIntent,
      (client: Client, message: TakeCommissionIntent, ctx) => {
        if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

        const pilot = this.pilotsBySession.get(client.sessionId);
        if (!pilot) return ctx.reject('not-owned');
        if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

        const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
        if (!port || !this.system) return ctx.reject('unknown-target');

        try {
          const taken = world().commissions.take(pilot, message.id, port, this.system, Date.now());
          this.sendCommissions(client.sessionId);
          return taken;
        } catch (error) {
          if (error instanceof CommissionRefused) return ctx.reject(error.reason);
          throw error;
        }
      },
    ),

    /**
     * Settle a finished chain by taking one of its two endings.
     *
     * At the chartering company's own seat, the same berth that issues its
     * letters: a captain who has run six or seven errands for a company says
     * what they are going to say in front of it. The Gazette carries the
     * choice the same hour, so the other two companies read it too.
     */
    'chain-ending': validate(ChainEndingIntent, (client: Client, message: ChainEndingIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');

      const waiting = world().commissions.pendingEnding(pilot.accountId);
      if (!waiting || waiting.id !== message.chain) return ctx.reject('no-such-commission');
      if (port.seat !== true || port.owner !== waiting.charter) return ctx.reject('not-a-seat');

      try {
        const settled = world().commissions.chooseEnding(
          pilot,
          message.chain,
          message.ending,
          Date.now(),
        );
        world().gazette.publish('', settled.headline, 'flat', Date.now());
        this.sendPurse(client.sessionId);
        this.sendStanding(client.sessionId);
        this.sendCommissions(client.sessionId);
        return settled;
      } catch (error) {
        if (error instanceof CommissionRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /** Give one up. */
    'abandon-commission': validate(
      AbandonCommissionIntent,
      (client: Client, message: AbandonCommissionIntent, ctx) => {
        if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

        const pilot = this.pilotsBySession.get(client.sessionId);
        if (!pilot) return ctx.reject('not-owned');

        try {
          world().commissions.abandon(pilot, message.id, Date.now());
          this.sendCommissions(client.sessionId);
          this.sendStanding(client.sessionId);
          return { abandoned: message.id };
        } catch (error) {
          if (error instanceof CommissionRefused) return ctx.reject(error.reason);
          throw error;
        }
      },
    ),

    /**
     * Take out a letter of marque, or give one up.
     *
     * Only at the issuing company's own seat, only to a captain it already
     * trusts, and it costs standing with the other two at once. A letter is a
     * declaration; the Register would rather a captain made it in person.
     */
    letter: validate(LetterIntent, (client: Client, message: LetterIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');

      const { tuning } = content();
      const now = Date.now();

      // Giving one up needs no seat and costs nothing but the standing
      // already spent. A captain who wants to deal with the other two again
      // should not have to fly anywhere to stop being their enemy.
      if (message.charter === '') {
        pilot.letter = '';
        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
        this.sendStanding(client.sessionId);
        return { letter: '' };
      }

      if (port.seat !== true || port.owner !== message.charter) return ctx.reject('not-a-seat');
      if (!isCharter(message.charter)) return ctx.reject('not-a-seat');
      if (pilot.letter !== '') return ctx.reject('letter-held');

      const standings = world().standings.of(pilot.accountId);
      if (!mayHoldLetter(standings[message.charter], tuning)) {
        return ctx.reject('standing-too-low');
      }

      try {
        world().ledger.post(
          {
            accountId: pilot.accountId,
            delta: -tuning.letters.cost,
            category: 'letter-of-marque',
            reason: `Letter of marque, ${port.name}`,
          },
          pilot,
        );
      } catch (error) {
        if (error instanceof InsufficientMarks) return ctx.reject('cannot-afford');
        throw error;
      }

      pilot.letter = message.charter;
      // The other two hear about it at once. That is what a letter is.
      for (const other of CHARTERS) {
        if (other === message.charter) continue;
        world().standings.shift(pilot.accountId, other, -tuning.letters.standingCost, now);
      }
      world().pilots.touch(pilot.accountId);

      this.sendPurse(client.sessionId);
      this.sendStanding(client.sessionId);
      return { letter: message.charter, cost: tuning.letters.cost };
    }),

    /**
     * Buy a hull licence.
     *
     * At a berth that keeps a Yard: a warrant is issued over a counter, and
     * the Yard's counter is the one in the game.
     */
    'buy-licence': validate(BuyLicenceIntent, (client: Client, message: BuyLicenceIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');
      if (!port.services.includes('yard')) return ctx.reject('no-yard');

      try {
        const issued = world().yard.buyLicence(pilot, message.licence);
        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
        this.sendYard(client.sessionId);
        return issued;
      } catch (error) {
        if (error instanceof YardRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /**
     * Take out a hull moored at this berth.
     *
     * The captain must be landed here, and the hull must be tied up here:
     * hulls do not teleport between berths, which is the whole reason the
     * Moorings are worth looking at before leaving a system.
     *
     * The hull in space is replaced, so the captain's old one is written back
     * to its row first and the new one is spawned from scratch at the berth.
     */
    'switch-ship': validate(SwitchShipIntent, (client: Client, message: SwitchShipIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');

      // Everything the old hull did lands in its row before the swap, or the
      // damage it took this session would be lost.
      this.persist(client.sessionId);

      try {
        const taken = world().yard.switchTo(pilot.accountId, message.id, port.id);

        // The new hull is sound, full and fresh out of the moorings: its own
        // damage is on its row and restored by `spawnFromPilot`, but the
        // captain's row still describes the hull they just left, so the
        // carried-over damage array is cleared here.
        pilot.moduleHp = [];
        pilot.shield = 0;
        world().pilots.touch(pilot.accountId);

        this.sendPurse(client.sessionId);
        this.sendYard(client.sessionId);
        return taken;
      } catch (error) {
        if (error instanceof YardRefused) return ctx.reject(error.reason);
        throw error;
      }
    }),

    /**
     * Buy or sell shares on the Bourse.
     *
     * Only at a berth that keeps one. The price is read from the pool as it
     * stands, never from whatever the ticket last showed, so a captain who
     * sat on an order while somebody else moved the market is filled at the
     * real price and told what it was.
     */
    bourse: validate(BourseIntent, (client: Client, message: BourseIntent, ctx) => {
      if (!this.allowIntent(client.sessionId)) return ctx.reject('rate-limited');

      const pilot = this.pilotsBySession.get(client.sessionId);
      if (!pilot) return ctx.reject('not-owned');
      if (pilot.landedPortId === undefined) return ctx.reject('not-landed');

      const port = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
      if (!port) return ctx.reject('unknown-target');
      if (!port.services.includes('bourse')) return ctx.reject('no-bourse');

      try {
        const fill = world().exchange.trade({
          pilot,
          side: message.side,
          ticker: message.ticker,
          shares: message.shares,
        });
        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
        this.sendBourse(client.sessionId);
        return fill;
      } catch (error) {
        if (error instanceof BourseRefused) return ctx.reject(error.reason);
        throw error;
      }
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

      // Ordnance goes to the magazine, where a hull keeps it; everything
      // else goes in the hold. This used to drop everything that was not
      // Ordnance on the floor — written before the Staple existed, and never
      // revisited once a hull had a hold to put things in.
      const pilot = this.pilotsBySession.get(client.sessionId);
      let taken = canister.units;

      if (canister.commodity === 'ordnance') {
        const room = Math.max(0, content().tuning.ports.magazineCapacity - runtime.ammo);
        taken = Math.min(taken, room);
        runtime.ammo += taken;
        if (pilot) pilot.ammo = runtime.ammo;
      } else if (pilot) {
        const room = Math.max(
          0,
          Math.floor(runtime.stats.cargoCapacity) -
            world().market.cargoUnits(pilot.accountId),
        );
        taken = Math.min(taken, room);
        if (taken > 0) {
          // Scooped from a wreck, so it is prize cargo: it fetches a premium
          // at the berths of whichever charter licensed the taking.
          world().market.adjustCargo(pilot.accountId, canister.commodity, taken, {
            prize: true,
          });
        }
      } else {
        taken = 0;
      }

      if (taken <= 0) return ctx.reject('no-room');

      // What was not taken stays in space for somebody else.
      if (taken < canister.units) canister.units -= taken;
      else this.state.canisters.delete(message.id);

      if (pilot) {
        world().pilots.touch(pilot.accountId);
        this.sendPurse(client.sessionId);
      }
      return { commodity: canister.commodity, units: taken };
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
    // Traffic follows trade: a system whose berths produce something has
    // hulls carrying it out, and a system that produces nothing has none.
    this.freighterTarget =
      options.freighters ??
      ((this.system?.ports ?? []).some((port) =>
        Object.values(port.trade?.produces ?? {}).some((rate) => rate > 0),
      )
        ? 2
        : 0);
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

    liveRooms.add(this);
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
    liveRooms.delete(this);
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

  /** What the captain has on their books and at their moorings. */
  private sendYard(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;

    // What the captain is flying, which the editor starts a refit from. The
    // same resolver the simulation uses, so a captain who has never built
    // opens the editor on the draught they actually fly rather than an empty
    // grid, and one who has built opens on their own hull under its own name.
    const { licences } = content();
    const { blueprint } = this.hullFor(pilot);
    const owned = world().yard.flying(pilot.accountId);

    const berth = this.system?.ports.find((candidate) => candidate.id === pilot.landedPortId);
    const held = licences.get(pilot.licence as LicenceId);

    this.clients.get(sessionId)?.send('yard', {
      designs: world().yard.designsOf(pilot.accountId),
      ships: world().yard.shipsOf(pilot.accountId),
      licence: pilot.licence,
      flying: blueprint.placements,
      flyingId: owned?.id ?? '',
      flyingName: blueprint.name,

      /** What this berth's Yard stocks, so the palette shows only the rest. */
      stock: berth?.yardStock ?? {},
      berthName: berth?.name ?? '',

      /**
       * The warrant ladder, with what each one covers.
       *
       * Sent whole rather than just the next rung: a captain deciding whether
       * to save for a cruiser warrant wants to see what it buys, and the
       * editor should not have to carry a second copy of the costs.
       */
      licences: [...licences.entries()]
        .sort((a, b) => a[1].rank - b[1].rank)
        .map(([id, def]) => ({
          id,
          name: def.name,
          cost: def.cost,
          maxModules: def.maxModules,
          maxExtent: def.maxExtent,
          held: id === pilot.licence,
          /** Below the one held: shown as passed, not as something to buy. */
          behind: held !== undefined && def.rank < held.rank,
        })),
    });
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

    switch (role) {
      // A freighter carries cargo and nothing else. It is the reason the
      // other two roles exist and it takes no part in what they do.
      case 'freighter':
        return false;

      // The Prize Court answers for the Unlettered and for captains it has
      // posted, and for nobody else.
      case 'patrol':
        return other.hostile || other.posted;

      // The Unlettered rob the traffic: captains, and the company freighters
      // that are the traffic. Not each other, and not the patrols — they
      // shoot back and carry nothing.
      case 'unlettered': {
        const theirPilot = this.pilots.get(otherId);
        return theirPilot === undefined || theirPilot.role === 'freighter';
      }
    }
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
        this.sendYard(client.sessionId);
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

  /**
   * The hull a captain is actually flying.
   *
   * Two sources, and the Yard's beats the Register's. A captain who owns a
   * built hull — the `ships` row with nowhere parked — flies that, and the
   * content catalogue has never heard of it. A captain who has never built
   * flies the draught named on their row.
   *
   * `code` is the hull's share code when it is a built one, and empty when it
   * is a catalogue draught the client can look up for itself. Everything that
   * needs to know what a captain flies goes through here, so the Yard, the
   * flight simulation and the purse cannot disagree about it.
   */
  private hullFor(pilot: Pilot): { blueprint: Blueprint; code: string } {
    const { blueprints, tuning } = content();
    const owned = world().yard.flying(pilot.accountId);
    if (owned) {
      return {
        blueprint: builtBlueprint(owned, pilot.licence as LicenceId, tuning),
        code: encodeShareCode({ name: owned.name, placements: owned.placements }),
      };
    }

    const blueprint = blueprints.get(pilot.blueprintId) ?? blueprints.get(STARTER_BLUEPRINT);
    if (!blueprint) throw new Error('no draught to fly');
    return { blueprint, code: '' };
  }

  /** Spawn a hull from what the captain's row says about it. */
  private spawnFromPilot(
    sessionId: string,
    pilot: Pilot,
    options: { chargeShields?: boolean } = {},
  ): void {
    const { modules, tuning } = content();
    const { blueprint, code } = this.hullFor(pilot);

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
    ship.hull = code;
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

    const { modules, tuning } = content();
    const { blueprint } = this.hullFor(pilot);
    const placed = placeAll(blueprint.placements, modules);
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
      draught: blueprint.name,
      licence: pilot.licence,
      composition: pilot.composition,
      jumpCost: stats ? jumpCost(stats.totalMass) : 1,
      system: pilot.systemId,
      landedPort: pilot.landedPortId ?? '',
    });
  }

  /**
   * Push the board to every captain standing on a berth here.
   *
   * Called when the world's market tick fires. Only to those alongside: a
   * captain in flight has no Bourse open and no use for ten prices, and the
   * bandwidth budget in spec section 3 is for the flight view.
   */
  refreshBourse(): void {
    for (const [sessionId, pilot] of this.pilotsBySession) {
      if (pilot.landedPortId === undefined) continue;
      this.sendBourse(sessionId);
    }
  }

  /**
   * The Bourse, the Gazette and the standings.
   *
   * Sent together because they are one screen: a price without the headline
   * that explains it is the thing spec section 10 exists to prevent.
   */
  private sendBourse(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;

    const client = this.clients.get(sessionId);
    if (!client) return;

    const { exchange } = content().tuning;
    client.send('bourse', {
      listings: world().exchange.listingsFor(pilot.accountId),
      feeRate: exchange.feeRate,
      maxPoolFraction: exchange.maxPoolFraction,
    });
    client.send('news', { headlines: world().gazette.recent() });
    client.send('standings', { standings: this.standingsFor(pilot.accountId) });
  }

  /**
   * The leaderboard: what every captain is worth.
   *
   * Net worth rather than marks, because a captain who has put everything
   * into a cruiser and a parcel of Slipway shares is not poor. Hulls count at
   * what they cost to build, which is the only figure the world actually
   * knows; a second-hand market would give a better one and there is not one.
   */
  private standingsFor(accountId: string): Standing[] {
    // Recomputed on a cadence, not on every push.
    //
    // This walks every captain on the books and re-derives the build cost of
    // every hull they own, which is not a thing to do on the room's tick
    // path: with the Bourse pushing on each market tick it took the p99 over
    // the 4ms budget in spec section 3. The board is a leaderboard — a few
    // seconds stale is not a thing anybody can see.
    const now = this.clock.elapsedTime;
    if (this.standings !== undefined && now - this.standingsAt < STANDINGS_INTERVAL_MS) {
      return this.standings.map((line) => ({
        ...line,
        isSelf: line.accountId === accountId,
      }));
    }

    const { modules, tuning } = content();
    const out: (Standing & { accountId: string })[] = [];

    for (const account of world().pilots.everyone()) {
      const shares = world().exchange.portfolioValue(account.accountId);
      let hulls = 0;
      for (const hull of world().yard.shipsOf(account.accountId)) {
        try {
          hulls += buildCost(hull.placements, modules, tuning, []).marks;
        } catch {
          // A hull naming a fitting this build lacks is worth nothing we can
          // state, which is better than refusing to draw the whole board.
        }
      }

      out.push({
        accountId: account.accountId,
        callsign: account.callsign,
        worth: account.marks + shares + hulls,
        marks: account.marks,
        shares,
        hulls,
        isSelf: false,
      });
    }

    this.standings = out.sort((a, b) => b.worth - a.worth).slice(0, 20);
    this.standingsAt = now;
    return this.standings.map((line) => ({
      ...line,
      isSelf: line.accountId === accountId,
    }));
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
    // `blueprintId` names a catalogue draught, so it is only written when the
    // hull being flown is one. A built hull's id belongs to the `ships` table
    // and writing it here would leave the Register naming a draught that does
    // not exist, which `hullFor` would then fall back out of on the next join.
    if (ship.hull === '') pilot.blueprintId = ship.blueprint;
    pilot.moduleHp = [...runtime.hp];
    pilot.shield = ship.shield;
    pilot.ammo = runtime.ammo;
    world().pilots.touch(pilot.accountId);

    // A built hull keeps its own damage, so a captain who parks a battered
    // hull and comes back in another one finds it as they left it.
    if (ship.hull !== '') world().yard.recordDamage(pilot.accountId, ship.blueprint, [...runtime.hp]);
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
    ship.freighter = role === 'freighter';
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
      this.combat.fire(id, ship, runtime, command.firePrimary, command.fireSecondary, ctx.dt);
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
    this.sendYard(sessionId);
    this.sendBourse(sessionId);
    this.sendStanding(sessionId);
    this.settleOnLanding(sessionId, portId);

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
    this.maintainRole('freighter', captains > 0 ? this.freighterTarget : 0);
  }

  private maintainRole(role: NpcRole, wanted: number): void {
    const held = [...this.pilots].filter(([, pilot]) => pilot.role === role).map(([id]) => id);

    if (held.length < wanted) {
      const id = `npc-${this.nextNpcId++}`;
      if (role === 'freighter') {
        this.spawnHull(id, this.rng.pick(FREIGHTER_BLUEPRINTS), freighterName(this.rng), false, role);
        this.pilots.set(id, freighterPilot(id, `${this.roomId}:${id}`));
        const consignment = this.consignmentFor(id);
        if (consignment) this.consignments.set(id, consignment);
      } else if (role === 'patrol') {
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

  /**
   * What a freighter is carrying.
   *
   * Drawn from what this system's berths actually produce, so a hull lost off
   * a mining world costs the miner and a hull lost off a farm costs the
   * farmer. Seeded from the hull's id, so the same freighter is carrying the
   * same thing however many times its consignment is asked for.
   */
  private consignmentFor(id: string): { commodityId: string; units: number } | undefined {
    const produced = new Set<string>();
    for (const port of this.system?.ports ?? []) {
      // `produces` is a rate per commodity, not a list; a rate of nothing is
      // not production.
      for (const [commodityId, rate] of Object.entries(port.trade?.produces ?? {})) {
        if (rate > 0) produced.add(commodityId);
      }
    }
    if (produced.size === 0) return undefined;

    const rng = new Rng(`consignment:${this.roomId}:${id}`);
    const commodityId = rng.pick([...produced].sort());
    return { commodityId, units: Math.round(rng.range(30, 140)) };
  }

  // --- Aftermath ----------------------------------------------------------

  /**
   * Patrols scan the traffic, and a letter lapses on its own.
   *
   * Run on the economy's cadence rather than every tick: a scan is a thing
   * that happens to a captain now and then, not a thing that happens sixty
   * times a second, and reading every hold at tick rate would be the kind of
   * work spec section 3's budget is there to prevent.
   *
   * Only in the Home Roads, because that is the only place the monopolies
   * bind. Outside them a patrol has nothing to look for.
   */
  runPatrolScans(): void {
    this.patrolsScan();
    this.settleEscorts();
  }

  /**
   * An escort is answered by its time running out with the lane intact.
   *
   * The only commission that is finished by nothing happening, which is why
   * it is settled here rather than on a landing: a captain who sat on station
   * for the whole watch has done the job, and should not have to go
   * somewhere to be told so.
   */
  private settleEscorts(): void {
    const now = Date.now();
    for (const [sessionId, pilot] of this.pilotsBySession) {
      for (const held of world().commissions.held(pilot.accountId)) {
        if (held.kind !== 'escort' || held.dueAt === 0 || now < held.dueAt) continue;
        const said = world().commissions.settle(pilot, held, now);
        this.clients.get(sessionId)?.send('commission', {
          id: held.id,
          title: held.title,
          outcome: 'done',
          text: said.text,
          pay: said.pay,
        });
        this.sendPurse(sessionId);
        this.sendCommissions(sessionId);
      }
    }
  }

  private patrolsScan(): void {
    const region = this.system?.region;
    if (region !== 'home-roads') return;

    const { tuning } = content();
    const now = Date.now();

    for (const [sessionId, pilot] of this.pilotsBySession) {
      // A letter whose issuer has stopped trusting its holder is waste paper,
      // and finding that out should not need a trip to the seat.
      if (pilot.letter !== '' && isCharter(pilot.letter)) {
        const standing = world().standings.of(pilot.accountId)[pilot.letter];
        if (letterLapsed(standing, tuning)) {
          pilot.letter = '';
          world().pilots.touch(pilot.accountId);
          this.clients.get(sessionId)?.send('scanned', {
            kind: 'letter-lapsed',
            text: 'Your letter of marque has lapsed. The issuer no longer vouches for you.',
          });
          this.sendStanding(sessionId);
        }
      }

      const ship = this.state.ships.get(sessionId);
      if (!ship || ship.destroyedAt > 0) continue;

      // A patrol has to actually be near enough to hail.
      let nearest = Infinity;
      for (const [id, other] of this.state.ships) {
        if (!other.patrol || other.destroyedAt > 0 || id === sessionId) continue;
        nearest = Math.min(nearest, Math.hypot(other.x - ship.x, other.y - ship.y));
      }
      if (nearest > tuning.letters.scanRange) continue;

      // Not every pass. Smuggling that is always caught is not a decision,
      // and smuggling that is never caught is not a risk.
      const rng = new Rng(`scan:${this.roomId}:${sessionId}:${Math.floor(now / 10_000)}`);
      if (rng.next() > tuning.letters.scanChance) continue;

      const hold = world().market.cargoOf(pilot.accountId);
      const found = contrabandIn(
        hold,
        region,
        world().standings.of(pilot.accountId),
        tuning,
      );
      if (found.length === 0) continue;

      // Confiscation and a composition. The goods are gone — not sold, not
      // moved to a stockpile: a patrol that resold contraband would be a
      // trading partner, and the Prize Court is not one.
      let seized = 0;
      for (const row of found) {
        world().market.adjustCargo(pilot.accountId, row.commodityId, -row.units);
        seized += row.units;
        world().standings.shift(
          pilot.accountId,
          row.holder,
          tuning.standing.perSmugglingCaught,
          now,
        );
      }

      pilot.composition += Math.round(seized * tuning.law.compositionPerDamage);
      world().pilots.touch(pilot.accountId);

      this.clients.get(sessionId)?.send('scanned', {
        kind: 'seized',
        text:
          `A patrol scanned your hull and took ${seized} units of monopoly goods. ` +
          'The Prize Court has entered a composition against you.',
        seized,
      });
      this.sendPurse(sessionId);
      this.sendStanding(sessionId);
    }
  }

  /**
   * What a kill does to the killer's standing.
   *
   * Only a captain's kills count: the Unlettered shooting a freighter is the
   * Unlettered being themselves, and crediting a captain for it would pay
   * them for being in the room. Nothing here reads who was shot *at* — a hull
   * is judged by what it was, which is what a company's assessor would see.
   */
  private noteKill(id: string, ship: ShipState, killedBy: string): void {
    const killer = this.pilotsBySession.get(killedBy);
    if (!killer || killedBy === id) return;

    const { tuning } = content();
    const now = Date.now();

    // Destroying a company's freighter is the clearest way to be disliked by
    // it. Which company is whoever owns the berth it was working out of.
    if (ship.freighter) {
      const owner = this.system?.ports.find((port) => isCharter(port.owner))?.owner;
      if (owner !== undefined && isCharter(owner)) {
        world().standings.shift(
          killer.accountId,
          owner,
          tuning.standing.perFreighterLost,
          now,
        );
        this.sendStanding(killedBy);
      }
      return;
    }

    // And clearing the Unlettered off a lane is worth something to whoever
    // holds that lane. They are nobody's licensed raiders, so every charter
    // with a berth in the system is glad of it.
    const pilot = this.pilots.get(id);
    if (pilot?.role === 'unlettered') {
      // A bounty names a captain. Theirs is on their hull, which is the only
      // way anybody could tell one raider from another.
      for (const held of world().commissions.held(killer.accountId)) {
        if (held.kind !== 'bounty' || held.terms.target !== ship.callsign) continue;
        const said = world().commissions.settle(killer, held, now);
        this.clients.get(killedBy)?.send('commission', {
          id: held.id,
          title: held.title,
          outcome: 'done',
          text: said.text,
          pay: said.pay,
        });
        this.sendPurse(killedBy);
        this.sendCommissions(killedBy);
      }

      const owner = this.system?.ports.find((port) => isCharter(port.owner))?.owner;
      if (owner !== undefined && isCharter(owner)) {
        world().standings.shift(
          killer.accountId,
          owner,
          tuning.standing.perUnletteredKilled,
          now,
        );
        this.sendStanding(killedBy);
      }
    }
  }

  /**
   * The berth's board and what the captain is carrying.
   *
   * Sent together because a board a captain cannot see their own work
   * against is half a screen.
   */
  private sendCommissions(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot || !this.system) return;

    const port = this.system.ports.find((candidate) => candidate.id === pilot.landedPortId);
    const now = Date.now();

    // A chain waiting on its choice comes with the board: the captain is
    // standing in the room where it is made.
    const chain = world().commissions.pendingEnding(pilot.accountId);

    this.clients.get(sessionId)?.send('commissions', {
      board: port ? world().commissions.board(pilot, port, this.system, now) : [],
      held: world().commissions.held(pilot.accountId),
      berthName: port?.name ?? '',
      ...(chain !== undefined && port?.seat === true && port.owner === chain.charter
        ? {
            ending: {
              chain: chain.id,
              name: chain.name,
              charter: chain.charter,
              choices: chain.endings.map((option) => ({
                id: option.id,
                choice: option.choice,
                pay: option.pay,
                // Sign only. The figure behind it is the Register's business,
                // and a captain weighing this wants to know which way it cuts.
                favours: option.standing >= 0,
              })),
            },
          }
        : {}),
    });
  }

  /**
   * Answer whatever this landing answers.
   *
   * Delivery, passengers and smuggling are all settled by arriving somewhere
   * with something aboard, so they are checked here rather than by each
   * having its own trigger. Anything whose time ran out is failed at the same
   * moment: a captain should find out they are late when they land, not
   * silently.
   */
  private settleOnLanding(sessionId: string, portId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;

    const now = Date.now();
    const commissions = world().commissions;

    for (const held of commissions.overdue(pilot.accountId, now)) {
      const said = commissions.fail(pilot, held, now);
      this.clients.get(sessionId)?.send('commission', {
        id: held.id,
        title: held.title,
        outcome: 'failed',
        text: said.text,
      });
    }

    for (const held of commissions.held(pilot.accountId)) {
      if (held.terms.toPortId !== portId) continue;
      if (held.kind !== 'delivery' && held.kind !== 'passengers' && held.kind !== 'smuggling') {
        continue;
      }

      // The goods have to actually be aboard, and they are handed over.
      if (held.terms.units > 0 && held.terms.commodityId !== '') {
        const carried =
          world().market.cargoOf(pilot.accountId).get(held.terms.commodityId) ?? 0;
        if (carried < held.terms.units) continue;
        world().market.adjustCargo(pilot.accountId, held.terms.commodityId, -held.terms.units);
      }

      const said = commissions.settle(pilot, held, now);
      this.clients.get(sessionId)?.send('commission', {
        id: held.id,
        title: held.title,
        outcome: 'done',
        text: said.text,
        pay: said.pay,
      });
    }

    this.sendPurse(sessionId);
    this.sendStanding(sessionId);
    this.sendCommissions(sessionId);
  }

  /** Tell a captain where they stand with the three charters. */
  private sendStanding(sessionId: string): void {
    const pilot = this.pilotsBySession.get(sessionId);
    if (!pilot) return;

    const { tuning } = content();
    const standings = world().standings.of(pilot.accountId);
    this.clients.get(sessionId)?.send('standing', {
      standings,
      names: Object.fromEntries(
        CHARTERS.map((charter) => [charter, standingName(standings[charter], tuning)]),
      ),
    });
  }

  /**
   * A freighter did not arrive.
   *
   * Two companies lose. The carrier for this region loses the haulage it will
   * not now be paid for — spec section 10's "carriers ... lose on freight
   * destroyed" — and the producer whose goods were aboard loses the sale,
   * because those units never reach a buyer. That is what makes blockading a
   * mining system show up on the mining company's price a few market ticks
   * later, with a line in the Gazette saying why.
   *
   * The goods are gone from the world either way: part of the hold spills as
   * canisters, and what is scooped is salvage rather than a sale.
   */
  private freightLost(id: string): void {
    // An escort is answered by nothing happening, so a hull lost on the lane
    // is the one thing that fails it — for every captain in the system who
    // took the work, whoever actually pulled the trigger.
    const now = Date.now();
    for (const [sessionId, pilot] of this.pilotsBySession) {
      for (const held of world().commissions.held(pilot.accountId)) {
        if (held.kind !== 'escort') continue;
        const said = world().commissions.fail(pilot, held, now);
        this.clients.get(sessionId)?.send('commission', {
          id: held.id,
          title: held.title,
          outcome: 'failed',
          text: said.text,
        });
        this.sendCommissions(sessionId);
      }
    }

    const consignment = this.consignments.get(id);
    this.consignments.delete(id);
    if (!consignment || !this.system) return;

    const commodity = content().commodities.get(consignment.commodityId);
    if (!commodity) return;

    const value = Math.round(consignment.units * commodity.basePrice);
    const exchange = world().exchange;

    const carrier = exchange.carrierOf(this.system.region);
    if (carrier !== undefined) {
      exchange.credit({
        ticker: carrier,
        marks: -Math.round(value * 0.08),
        kind: 'freight',
        where: this.system.name,
        what: this.system.region,
      });
    }

    // Whichever company's berth here produces it is the one out of pocket.
    for (const port of this.system.ports) {
      if ((port.trade?.produces[consignment.commodityId] ?? 0) <= 0) continue;
      const producer = exchange.producerOf(port.owner, consignment.commodityId);
      if (producer !== undefined) {
        exchange.credit({
          ticker: producer,
          marks: -value,
          kind: 'goods-sold',
          where: this.system.name,
          what: consignment.commodityId,
        });
      }
      break;
    }
  }

  private writeOff(id: string, killedBy: string): void {
    const ship = this.state.ships.get(id);
    const runtime = this.runtimes.get(id);
    if (!ship || !runtime) return;

    // Read before it is cleared: the spill below needs to know what was
    // aboard, and the companies need to be told what did not arrive.
    const consignment = this.consignments.get(id);
    this.freightLost(id);

    ship.destroyedAt = Math.round(this.clock.elapsedTime) || 1;
    ship.shield = 0;
    ship.target = '';

    // Part of the hold spills, which is what makes a wreck worth flying to.
    const spilled: { commodity: string; units: number }[] = [];
    if (runtime.ammo > 0) {
      spilled.push({ commodity: 'ordnance', units: Math.ceil(runtime.ammo / 2) });
    }
    if (consignment) {
      // Less than was aboard: spec section 8 says part of the cargo drops,
      // and section 19's letters-of-marque rule depends on a capture being
      // worth less than the cargo lost, or staging one between friends would
      // pay. Half is the share the rest of the economy is tuned against.
      spilled.push({ commodity: consignment.commodityId, units: Math.ceil(consignment.units / 2) });
    }
    if (spilled.length > 0) this.combat.spill(ship, spilled, this.clock.elapsedTime);

    this.noteKill(id, ship, killedBy);
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






