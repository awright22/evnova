/**
 * One star system.
 *
 * The room is authoritative: clients send inputs and intents only. It runs the
 * shared flight step at a fixed rate, which Colyseus advertises to predicting
 * clients so their rollback replay integrates with the same `dt`.
 */

import { ClientState, Room, type Client, type StepContext } from '@colyseus/core';
import { registerRoom, TickMetrics } from '../metrics.ts';
import {
  EMPTY_LOADOUT,
  SHIP_INPUT_SANITIZE,
  ShipInput,
  ShipState,
  SUB_STEPS,
  SystemState,
  TICK_RATE,
  Rng,
  content,
  deriveStats,
  placeAll,
  stepFlight,
  type ShipProfile,
  type SystemDef,
} from '@marque/shared';

/** The draught every Open Ticket starts with. */
const STARTER_BLUEPRINT = 'prudent-return';

export interface SystemRoomOptions {
  /** Content id of the system to simulate. */
  systemId?: string;
}

export interface JoinOptions {
  callsign?: string;
  /** Draught to fly. Falls back to the starter if unknown. */
  blueprint?: string;
}

/**
 * Arrivals scatter inside this radius, around the first port rather than the
 * system centre: the centre is where the star is, and a captain should arrive
 * somewhere with a berth in sight.
 */
const SPAWN_RADIUS = 900;

/** How far off the port arrivals sit, so nobody materialises inside it. */
const SPAWN_STANDOFF = 1600;

export class SystemRoom extends Room<{
  state: SystemState;
  input: ShipInput;
}> {
  override state = new SystemState();

  /**
   * Per-client input, buffered. Sanitising declares each field's legal domain
   * once: a malformed frame is corrected in place before the step reads it, so
   * a client cannot widen its own control authority.
   *
   * The idle policy holds the last input through a packet gap, so a held thrust
   * key keeps burning. Edge-triggered actions must check `wasIdle` before
   * firing, or a held frame would re-trigger them every tick of the gap.
   */
  override inputs = this.defineInput(ShipInput, {
    bufferMaxSize: 64,
    sanitize: SHIP_INPUT_SANITIZE,
    idle: ({ latest, sessionId }) => {
      const client = this.clients.get(sessionId);
      if (client?.state !== ClientState.JOINED) return true;
      return latest ?? true;
    },
  });

  /**
   * Flight performance per ship, derived from its draught at join. The server
   * owns this: a client has no say in how its hull performs.
   */
  private readonly profiles = new Map<string, ShipProfile>();

  /** The system this room simulates, resolved from content at creation. */
  private system: SystemDef | undefined;

  /** Step timing, reported by the metrics route and held to budget by the soak. */
  private readonly tick = new TickMetrics();
  private unregisterMetrics: (() => void) | undefined;

  override onCreate(options: SystemRoomOptions = {}): void {
    const { systems } = content();
    const requested = options.systemId ?? 'parity';
    // An unknown system id is a configuration error, not a client error: fall
    // back to the first authored system so a room always has a world.
    this.system = systems.get(requested) ?? [...systems.values()][0];
    this.state.systemId = this.system?.id ?? requested;
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE, { subSteps: SUB_STEPS });

    this.unregisterMetrics = registerRoom({
      roomId: this.roomId,
      systemId: this.state.systemId,
      clients: () => this.clients.length,
      entities: () => this.state.ships.size,
      tick: this.tick,
    });
  }

  override onDispose(): void {
    this.unregisterMetrics?.();
    this.unregisterMetrics = undefined;
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const callsign = sanitiseCallsign(options.callsign) || `Captain-${client.sessionId.slice(0, 4)}`;

    const { blueprints, modules, tuning } = content();
    const requested = typeof options.blueprint === 'string' ? options.blueprint : undefined;
    const blueprintId = requested !== undefined && blueprints.has(requested)
      ? requested
      : STARTER_BLUEPRINT;
    const blueprint = blueprints.get(blueprintId);
    if (!blueprint) throw new Error(`starter draught "${STARTER_BLUEPRINT}" is missing`);

    // Derive handling from the draught. The hold is empty on arrival; cargo
    // and Propellant change these numbers once the Staple exists.
    const stats = deriveStats(placeAll(blueprint.placements, modules), tuning, EMPTY_LOADOUT);

    // Scatter arrivals deterministically from the session id, so two ships
    // never materialise on top of each other.
    const rng = new Rng(client.sessionId);
    const bearing = rng.range(-Math.PI, Math.PI);
    const distance = SPAWN_RADIUS * Math.sqrt(rng.next());

    const berth = this.system?.ports[0];
    const anchorX = berth ? berth.x + Math.cos(bearing) * SPAWN_STANDOFF : 0;
    const anchorY = berth ? berth.y + Math.sin(bearing) * SPAWN_STANDOFF : 0;

    const ship = new ShipState();
    ship.x = anchorX + Math.cos(bearing) * distance;
    ship.y = anchorY + Math.sin(bearing) * distance;
    // Face the berth, which is a sensible pose to start flying from.
    ship.angle = berth
      ? Math.atan2(berth.y - ship.y, berth.x - ship.x)
      : Math.atan2(-ship.y, -ship.x);
    ship.callsign = callsign;
    ship.blueprint = blueprintId;

    this.profiles.set(client.sessionId, stats.profile);
    this.state.ships.set(client.sessionId, ship);
  }

  override onLeave(client: Client): void {
    // M3 adds the grace window from the spec: a ship persists in space for a
    // short time after its pilot drops. For now the seat clears immediately.
    this.state.ships.delete(client.sessionId);
    this.profiles.delete(client.sessionId);
  }

  private step(ctx: StepContext): void {
    const startedAt = performance.now();
    for (const [sessionId, ship] of this.state.ships) {
      const cmd = this.inputs.get(sessionId).next();
      if (!cmd) continue;
      const profile = this.profiles.get(sessionId);
      if (!profile) continue;
      // `ShipState` carries the flight fields as plain scalars, so it
      // satisfies `FlightBody` structurally: the server mutates the
      // authoritative state in place with the very function the client
      // replays against its predicted mirror.
      stepFlight(ship, cmd, profile, ctx);
    }
    this.state.tick = ctx.tick;
    this.tick.record(performance.now() - startedAt);
  }
}

function sanitiseCallsign(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  // Letters, digits, spaces, hyphens and apostrophes only, to keep the roster
  // readable and the chat log free of control characters.
  return raw
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '-]/gu, '')
    .trim()
    .slice(0, 20);
}
