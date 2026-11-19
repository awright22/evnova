/**
 * The netcode session.
 *
 * Owns the prediction stack for a joined room: the input handle that stages and
 * sends one frame per fixed step, the reconciler that predicts and replays the
 * local hull against the shared step function, and the interpolation attached
 * to every remote hull.
 *
 * The order inside a frame matters: tick, then send, then read. A read between
 * the tick and the sends renders one step stale.
 */

import type { Reconciler} from '@colyseus/sdk';
import { Predict, type InputHandle, type Room } from '@colyseus/sdk';
import { classifyDrift, type DriftStatus } from '@colyseus/sdk/predict/drift';
import {
  PATCH_RATE,
  ShipInput,
  content,
  deriveStats,
  placeAll,
  stepFlight,
  type ShipProfile,
  type ShipState,
  type SystemState,
} from '@marque/shared';

import type { FlightIntent } from '../flight/input.ts';

/** Remote interpolation delay: two patch intervals, per the netcode guidance. */
const INTERP_DELAY_MS = Math.round((1000 / PATCH_RATE) * 2);

/**
 * Drift tolerance, in the units the reconciler measures. It mirrors every
 * scalar field, so corrections span velocity too, where values run to a few
 * hundred. See `docs/DESIGN.md`.
 */
const DRIFT_TOLERANCE = 2;

/** Corrections past this are a teleport, not a misprediction. */
const SNAP_DISTANCE = 50;

export interface ShipView {
  readonly id: string;
  readonly blueprint: string;
  readonly callsign: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly vx: number;
  readonly vy: number;
  readonly isSelf: boolean;
}

export interface SessionTelemetry {
  readonly status: DriftStatus;
  readonly driftEma: number;
  readonly rtt: number;
  readonly jitter: number;
  readonly pending: number;
}

type FlightRoom = Room<unknown, SystemState>;

export class Session {
  private readonly predict: Predict<SystemState>;
  private readonly input: InputHandle<ShipInput>;
  private readonly me: Reconciler<ShipState>;
  private readonly profile: ShipProfile;

  /** Throttle actually sent last step, for the plume. */
  private throttle = 0;

  private constructor(
    private readonly room: FlightRoom,
    self: ShipState,
    profile: ShipProfile,
  ) {
    this.profile = profile;

    this.predict = Predict.get(room, { mode: 'lerp', delay: INTERP_DELAY_MS });

    // Remote hulls: interpolated a little in the past. Angles interpolate over
    // the shortest arc, so they attach separately from the linear fields.
    this.predict.attachAll('ships', { mode: 'lerp', fields: ['x', 'y', 'vx', 'vy'] });
    this.predict.attachAll('ships', { mode: 'lerp', fields: ['angle'], angle: true });

    this.input = room.input({ type: ShipInput });

    this.me = this.predict.reconciler(self, {
      input: this.input,
      // The same function the server's fixed loop runs. There is no second copy.
      step: (ctx, state, cmd) => {
        stepFlight(state, cmd, profile, ctx);
      },
      smoothMs: 65,
      snap: SNAP_DISTANCE,
      warnOnDivergence: DRIFT_TOLERANCE,
    });
  }

  /**
   * Attach to a joined room.
   *
   * Waits for the server to create this client's hull, because joining is not
   * the same as existing in the simulation.
   */
  static async attach(room: FlightRoom): Promise<Session> {
    const self = await waitForOwnShip(room);

    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(self.blueprint);
    if (!blueprint) {
      throw new Error(`the server assigned draught "${self.blueprint}", which this build lacks`);
    }
    // Derive the same profile the server derived, from the same data.
    const stats = deriveStats(placeAll(blueprint.placements, modules), tuning);

    return new Session(room, self, stats.profile);
  }

  get shipProfile(): ShipProfile {
    return this.profile;
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  get currentThrottle(): number {
    return this.throttle;
  }

  /**
   * Advance one rendered frame.
   *
   * Returns how many fixed steps were due, having sent exactly that many
   * inputs. Call before reading any position.
   */
  tick(now: number, intent: FlightIntent): number {
    const due = this.predict.tick(now);

    for (let i = 0; i < due; i++) {
      this.input.data.turn = intent.turn;
      this.input.data.thrust = intent.thrust;
      this.input.data.brake = intent.brake;
      this.input.send();
    }

    if (due > 0) {
      // The plume follows what was actually committed, including the brake's
      // own retrograde burn, which the pilot did not ask for directly.
      this.throttle = intent.brake ? brakeThrottle(this.me.state, this.profile) : intent.thrust;
    }

    return due;
  }

  /** Every hull in the system, read through the one render idiom. */
  shipViews(out: ShipView[] = []): ShipView[] {
    out.length = 0;
    const selfId = this.room.sessionId;

    this.room.state.ships.forEach((ship, id) => {
      const isSelf = id === selfId;
      out.push({
        id,
        blueprint: ship.blueprint,
        callsign: ship.callsign,
        // `predict.value` covers both cases: the reconciled local hull and the
        // interpolated remote ones.
        x: this.predict.value(ship, 'x'),
        y: this.predict.value(ship, 'y'),
        angle: this.predict.value(ship, 'angle'),
        vx: this.predict.value(ship, 'vx'),
        vy: this.predict.value(ship, 'vy'),
        isSelf,
      });
    });

    return out;
  }

  /** The exact predicted state, for game logic rather than rendering. */
  get predicted(): ShipState {
    return this.me.state;
  }

  get telemetry(): SessionTelemetry {
    const drift = this.me.drift;
    return {
      status: classifyDrift(drift, DRIFT_TOLERANCE),
      driftEma: drift.ema,
      rtt: this.room.clock.smoothedRtt(),
      jitter: this.room.clock.jitter(),
      pending: this.input.pendingCount,
    };
  }

  destroy(): void {
    this.me.reset();
  }
}

/**
 * Whether the brake is currently burning, for the plume.
 *
 * The brake only fires the engine once the hull is aligned with retrograde, so
 * showing a plume for the whole manoeuvre would be a lie.
 */
function brakeThrottle(state: ShipState, profile: ShipProfile): number {
  const speed = Math.hypot(state.vx, state.vy);
  if (speed <= profile.thrustAccel / 30) return 0;
  const retrograde = Math.atan2(-state.vy, -state.vx);
  let error = retrograde - state.angle;
  while (error > Math.PI) error -= Math.PI * 2;
  while (error < -Math.PI) error += Math.PI * 2;
  return Math.abs(error) <= 0.35 ? 1 : 0;
}

function waitForOwnShip(room: FlightRoom, timeoutMs = 10_000): Promise<ShipState> {
  const existing = room.state.ships.get(room.sessionId);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('the server never created a hull for this session'));
    }, timeoutMs);

    const poll = setInterval(() => {
      const ship = room.state.ships.get(room.sessionId);
      if (ship) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ship);
      }
    }, 16);
  });
}
