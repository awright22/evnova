/**
 * One star system.
 *
 * The room is authoritative: clients send inputs and intents only. It runs the
 * shared flight step at a fixed rate, which Colyseus advertises to predicting
 * clients so their rollback replay integrates with the same `dt`.
 */

import { ClientState, Room, type Client, type StepContext } from '@colyseus/core';
import {
  SHIP_INPUT_SANITIZE,
  SPIKE_PROFILE,
  ShipInput,
  ShipState,
  SUB_STEPS,
  SystemState,
  TICK_RATE,
  Rng,
  stepFlight,
  type ShipProfile,
} from '@manifest/shared';

export interface SystemRoomOptions {
  /** Content id of the system to simulate. */
  systemId?: string;
}

export interface JoinOptions {
  callsign?: string;
}

/** Radius around the system centre that arrivals are scattered across. */
const SPAWN_RADIUS = 900;

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

  /** Flight performance per ship. Derived from the blueprint once M1 lands. */
  private readonly profiles = new Map<string, ShipProfile>();

  override onCreate(options: SystemRoomOptions = {}): void {
    this.state.systemId = options.systemId ?? 'spike';
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE, { subSteps: SUB_STEPS });
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const callsign = sanitiseCallsign(options.callsign) || `Pilot-${client.sessionId.slice(0, 4)}`;

    // Scatter arrivals deterministically from the session id, so two ships
    // never materialise on top of each other.
    const rng = new Rng(client.sessionId);
    const bearing = rng.range(-Math.PI, Math.PI);
    const distance = SPAWN_RADIUS * Math.sqrt(rng.next());

    const ship = new ShipState();
    ship.x = Math.cos(bearing) * distance;
    ship.y = Math.sin(bearing) * distance;
    // Face the system centre: a sensible pose to start flying from.
    ship.angle = Math.atan2(-ship.y, -ship.x);
    ship.callsign = callsign;
    ship.blueprint = 'starter';

    this.profiles.set(client.sessionId, SPIKE_PROFILE);
    this.state.ships.set(client.sessionId, ship);
  }

  override onLeave(client: Client): void {
    // M3 adds the grace window from the spec: a ship persists in space for a
    // short time after its pilot drops. For now the seat clears immediately.
    this.state.ships.delete(client.sessionId);
    this.profiles.delete(client.sessionId);
  }

  private step(ctx: StepContext): void {
    for (const [sessionId, ship] of this.state.ships) {
      const cmd = this.inputs.get(sessionId).next();
      if (!cmd) continue;
      const profile = this.profiles.get(sessionId) ?? SPIKE_PROFILE;
      // `ShipState` carries the flight fields as plain scalars, so it
      // satisfies `FlightBody` structurally: the server mutates the
      // authoritative state in place with the very function the client
      // replays against its predicted mirror.
      stepFlight(ship, cmd, profile, ctx);
    }
    this.state.tick = ctx.tick;
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
