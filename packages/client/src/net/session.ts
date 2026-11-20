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
  REJECTIONS,
  rejectionText,
  type RejectionReason,
  ShipInput,
  content,
  flyingProfile,
  placeAll,
  stepFlight,
  type PlacedModule,
  type ShipProfile,
  type ShipState,
  type SystemState,
} from '@marque/shared';
import type { HullBook } from '../flight/hulls.ts';

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
  /** A built hull's grid, as a share code; empty for a catalogue draught. */
  readonly hull: string;
  readonly callsign: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly vx: number;
  readonly vy: number;
  readonly isSelf: boolean;
  readonly moduleHp: readonly number[];
  readonly shield: number;
  readonly hostile: boolean;
  /** A patrol of the Prize Court. */
  readonly patrol: boolean;
  /** Posted by the Prize Court: patrols will answer for this hull. */
  readonly posted: boolean;
  readonly writtenOff: boolean;
  /** Every engine out: it cannot run, and it can be boarded. */
  readonly adrift: boolean;
  readonly isTarget: boolean;
}

/** A round in flight, reckoned from its spawn to the current server instant. */
export interface ProjectileView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly kind: number;
  readonly isMine: boolean;
}

export interface CanisterView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly commodity: string;
  readonly units: number;
  readonly distance: number;
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
  /**
   * How the hull flies *now*, not how the draught was drawn.
   *
   * Re-derived whenever a module of this captain's hull reaches zero, because
   * the server steps the simulation with the same rule: a hull with an engine
   * shot off turns and accelerates differently, and predicting with the
   * undamaged figures diverged from the server in every fight that disabled
   * anything. Mutable, and read inside the step rather than captured by it.
   */
  private profile: ShipProfile;
  /** The hull's placements, kept for re-deriving the profile. */
  private readonly placed: readonly PlacedModule[];
  /** The module damage the current profile was derived from. */
  private damage: string;

  /** Throttle actually sent last step, for the plume. */
  private throttle = 0;

  private constructor(
    private readonly room: FlightRoom,
    private readonly self: ShipState,
    profile: ShipProfile,
    placed: readonly PlacedModule[],
  ) {
    this.profile = profile;
    this.placed = placed;
    this.damage = [...self.moduleHp].join(',');

    this.predict = Predict.get(room, { mode: 'lerp', delay: INTERP_DELAY_MS });

    // Remote hulls: interpolated a little in the past. Angles interpolate over
    // the shortest arc, so they attach separately from the linear fields.
    this.predict.attachAll('ships', { mode: 'lerp', fields: ['x', 'y', 'vx', 'vy'] });
    this.predict.attachAll('ships', { mode: 'lerp', fields: ['angle'], angle: true });

    this.input = room.input({ type: ShipInput });

    this.me = this.predict.reconciler(self, {
      input: this.input,
      // Exactly the fields the shared step owns.
      //
      // The reconciler mirrors every scalar field of the schema by default,
      // which pulled in shield: the server regenerates it from the time since
      // the hull was last hit and its power state, neither of which the client
      // simulates, so every fight produced corrections the client could never
      // have predicted. Those are not mispredictions to smooth away — they are
      // server truth arriving — so shield, module damage and the rest come in
      // as plain state.
      fields: ['x', 'y', 'vx', 'vy', 'angle', 'angVel'],

      // The same function the server's fixed loop runs. There is no second
      // copy — and it reads the current profile rather than the one this
      // hull was launched with, so damage changes how it flies here exactly
      // when it changes how it flies there.
      step: (ctx, state, cmd) => {
        stepFlight(state, cmd, this.profile, ctx);
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
  static async attach(room: FlightRoom, hulls: HullBook): Promise<Session> {
    const self = await waitForOwnShip(room);

    const { modules, tuning } = content();
    // The captain's own hull may be one they built, which no catalogue
    // describes; the hull book resolves either kind.
    const blueprint = hulls.learn(self.blueprint, self.hull);
    if (!blueprint) {
      throw new Error(`the server assigned draught "${self.blueprint}", which this build lacks`);
    }
    // Derive the same profile the server derived, from the same data — and
    // from the same damage, because a captain can rejoin in a hull that has
    // already been shot at.
    const placed = placeAll(blueprint.placements, modules);
    return new Session(room, self, flyingProfile(placed, [...self.moduleHp], tuning), placed);
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
    this.refreshProfile();
    const due = this.predict.tick(now);

    for (let i = 0; i < due; i++) {
      this.input.data.turn = intent.turn;
      this.input.data.thrust = intent.thrust;
      this.input.data.brake = intent.brake;
      this.input.data.firePrimary = intent.firePrimary;
      this.input.data.fireSecondary = intent.fireSecondary;
      this.input.send();
    }

    if (due > 0) {
      // The plume follows what was actually committed, including the brake's
      // own retrograde burn, which the pilot did not ask for directly.
      this.throttle = intent.brake ? brakeThrottle(this.me.state, this.profile) : intent.thrust;
    }

    return due;
  }

  /**
   * Re-derive how this hull flies, if anything on it has changed.
   *
   * Once a frame, against a signature of the module damage, because the
   * alternative is deriving a dozen modules' worth of mass and leverage every
   * frame for a hull that is usually undamaged. The signature is cheap and
   * the derivation only runs when a module's hit points have actually moved.
   */
  private refreshProfile(): void {
    const now = [...this.self.moduleHp].join(',');
    if (now === this.damage) return;
    this.damage = now;

    const { tuning } = content();
    this.profile = flyingProfile(this.placed, [...this.self.moduleHp], tuning);
  }

  /** Every hull in the system, read through the one render idiom. */
  shipViews(out: ShipView[] = []): ShipView[] {
    out.length = 0;
    const selfId = this.room.sessionId;

    const marked = this.currentTarget;

    this.room.state.ships.forEach((ship, id) => {
      const isSelf = id === selfId;
      out.push({
        id,
        blueprint: ship.blueprint,
        hull: ship.hull,
        callsign: ship.callsign,
        // `predict.value` covers both cases: the reconciled local hull and the
        // interpolated remote ones.
        x: this.predict.value(ship, 'x'),
        y: this.predict.value(ship, 'y'),
        angle: this.predict.value(ship, 'angle'),
        vx: this.predict.value(ship, 'vx'),
        vy: this.predict.value(ship, 'vy'),
        isSelf,
        moduleHp: ship.moduleHp,
        shield: ship.shield,
        hostile: ship.hostile,
        patrol: ship.patrol,
        posted: ship.posted,
        writtenOff: ship.destroyedAt > 0,
        adrift: ship.adrift,
        isTarget: id === marked,
      });
    });

    return out;
  }

  /**
   * Ask the server to select a mark.
   *
   * Target selection is an intent, not per-step input: it is a string and it
   * changes rarely, so it rides the message channel rather than the input
   * packet, which carries flat primitives only.
   */
  selectTarget(id: string): void {
    // A request, not a send: a refusal settles this promise as an error,
    // whereas a refused send disconnects the client.
    void this.room.request('target', { id }).catch((error: unknown) => {
      this.lastRefusal = describeRefusal(error);
    });
  }

  /** Hulls that can be marked, nearest first, excluding this one and wrecks. */
  targetableIds(): string[] {
    const selfId = this.room.sessionId;
    const self = this.me.state;
    const entries: { id: string; distance: number }[] = [];
    this.room.state.ships.forEach((ship, id) => {
      if (id === selfId || ship.destroyedAt > 0) return;
      entries.push({ id, distance: Math.hypot(ship.x - self.x, ship.y - self.y) });
    });
    entries.sort((a, b) => a.distance - b.distance);
    return entries.map((entry) => entry.id);
  }

  get currentTarget(): string {
    return this.room.state.ships.get(this.room.sessionId)?.target ?? '';
  }

  /**
   * Rounds in flight.
   *
   * The wire carries a round's birth, not its path, so each one is reckoned
   * forward from where and when it was fired. A missile's entry is refreshed
   * on a slow cadence, so the same reckoning covers it between refreshes.
   */
  projectileViews(out: ProjectileView[] = []): ProjectileView[] {
    out.length = 0;
    const now = this.room.clock.serverNow();
    const selfId = this.room.sessionId;

    this.room.state.projectiles.forEach((round, id) => {
      const age = Math.max(0, now - round.bornAt) / 1000;
      out.push({
        id,
        x: round.x + round.vx * age,
        y: round.y + round.vy * age,
        angle: Math.atan2(round.vy, round.vx),
        kind: round.kind,
        isMine: round.owner === selfId,
      });
    });

    return out;
  }

  /** Spilled cargo, with how far it is from this hull. */
  canisterViews(out: CanisterView[] = []): CanisterView[] {
    out.length = 0;
    const now = this.room.clock.serverNow();
    const self = this.me.state;

    this.room.state.canisters.forEach((canister, id) => {
      const age = Math.max(0, now - canister.bornAt) / 1000;
      const x = canister.x + canister.vx * age;
      const y = canister.y + canister.vy * age;
      out.push({
        id,
        x,
        y,
        commodity: canister.commodity,
        units: canister.units,
        distance: Math.hypot(x - self.x, y - self.y),
      });
    });

    return out;
  }

  /** Ask to scoop a canister. The server checks the range, not the client. */
  scoop(id: string): void {
    void this.room.request('scoop', { id }).catch((error: unknown) => {
      this.lastRefusal = describeRefusal(error);
    });
  }

  /** Put a party aboard a hull that cannot run, and take what it carries. */
  board(id: string): void {
    void this.room.request('board', { id }).catch((error: unknown) => {
      this.lastRefusal = describeRefusal(error);
    });
  }

  /** The most recent refusal, for the interface to show as a designed state. */
  lastRefusal: string | undefined;

  /** Subscribe to a server broadcast. Returns an unsubscribe. */
  on(type: string, handler: (payload: unknown) => void): () => void {
    this.room.onMessage(type, handler);
    return () => {
      // The SDK removes handlers by type; replacing with a no-op is the
      // supported way to stop listening without tearing down the room.
      this.room.onMessage(type, () => undefined);
    };
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
    // The predictor holds listeners on the room and a list of reconcilers it
    // drives. A flight view is mounted again every time the captain launches
    // from a berth, and each mount makes a fresh predictor, so leaving the old
    // one attached accumulates them for as long as the session lasts.
    this.predict.dispose();
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

/**
 * Turn a refused intent into something the interface can show.
 *
 * The server rejects with one of the protocol's closed set of reasons, so
 * this resolves to written text rather than passing an error message through.
 */
function describeRefusal(error: unknown): string {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  for (const reason of Object.keys(REJECTIONS) as RejectionReason[]) {
    if (raw.includes(reason)) return rejectionText(reason);
  }
  return 'The port declined that.';
}
