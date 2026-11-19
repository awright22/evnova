/**
 * Headless bot client.
 *
 * Connects over the real protocol with the real SDK: same prediction,
 * reconciliation and interpolation path a browser client takes. That makes the
 * bot a genuine test of the netcode rather than a shortcut around it, and lets
 * the soak run drive the live server at accelerated scale.
 */

import type {
  Reconciler} from '@colyseus/sdk';
import {
  ColyseusSDK,
  Predict,
  type InputHandle,
  type Room,
} from '@colyseus/sdk';
// Drift telemetry lives on a subpath: it is the SDK's own classifier, so the
// bot's verdict and the dev panel's can never disagree.
import { classifyDrift, type DriftStatus } from '@colyseus/sdk/predict/drift';
import {
  PATCH_RATE,
  SPIKE_PROFILE,
  ShipInput,
  SystemState,
  stepFlight,
  type ShipProfile,
  type ShipState,
} from '@marque/shared';

/**
 * The SDK types a Room by its server room class. The bot deliberately does not
 * import the server package — it talks to whatever is listening, exactly as a
 * browser would — so the room type stays open and the state type carries the
 * safety.
 */
type SystemRoom = Room<unknown, SystemState>;

/** How often the bot runs its frame loop. Stands in for requestAnimationFrame. */
const FRAME_INTERVAL_MS = 1000 / 60;

/** Remote interpolation delay: one to two patch intervals, per the netcode docs. */
const INTERP_DELAY_MS = Math.round((1000 / PATCH_RATE) * 2);

/**
 * Drift tolerance for the divergence verdict.
 *
 * The reconciler mirrors every scalar field, so a correction is measured
 * across position AND velocity. Velocities run to a few hundred units per
 * second, so the tolerance is expressed on that scale: 2 units/s is 0.6% of
 * top speed, which works out to roughly 0.07 units of position error per
 * step — far below anything a player could see. A real determinism break
 * grows without bound and crosses this almost immediately, which is exactly
 * what the baseline run (drift 0.0000) shows.
 */
const DRIFT_TOLERANCE = 2;

/**
 * Corrections larger than this are treated as a teleport rather than a
 * misprediction: smoothing resets, the ship pops, and the jump is excluded
 * from drift telemetry. Spawning, hyperspace arrival and respawn all move a
 * ship much further than any prediction error ever should.
 */
const SNAP_DISTANCE = 50;

/** What a brain sees when it decides what to do. */
export interface BotView {
  /** The bot's own predicted ship state: exact, unsmoothed, for logic. */
  readonly self: ShipState;
  /** Everything in the system, including the bot's own ship. */
  readonly ships: SystemState['ships'];
  readonly profile: ShipProfile;
  readonly sessionId: string;
  /** Server time in ms, for absolute deadlines. */
  readonly serverNow: number;
  /** Fixed step index this command is for. */
  readonly step: number;
}

/** A bot strategy. Stages one command per fixed step. */
export interface BotBrain {
  readonly name: string;
  decide(view: BotView, cmd: ShipInput): void;
}

export interface BotOptions {
  readonly endpoint: string;
  readonly callsign: string;
  readonly brain: BotBrain;
  readonly roomName?: string;
  readonly systemId?: string;
}

/** Netcode health, sampled from the SDK's own telemetry. */
export interface BotTelemetry {
  readonly callsign: string;
  readonly brain: string;
  readonly status: DriftStatus;
  readonly driftEma: number;
  readonly driftPeak: number;
  readonly rtt: number;
  readonly jitter: number;
  readonly pendingInputs: number;
  readonly inputsSent: number;
  readonly steps: number;
  readonly shipsSeen: number;
}

export class Bot {
  private frameTimer: NodeJS.Timeout | undefined;
  private steps = 0;
  private closed = false;

  private constructor(
    private readonly room: SystemRoom,
    private readonly self: ShipState,
    private readonly predict: Predict<SystemState>,
    private readonly me: Reconciler<ShipState>,
    private readonly input: InputHandle<ShipInput>,
    private readonly options: BotOptions,
  ) {}

  static async connect(options: BotOptions): Promise<Bot> {
    const sdk = new ColyseusSDK(options.endpoint);
    const room = await sdk.joinOrCreate<SystemState>(
      options.roomName ?? 'system',
      { callsign: options.callsign, systemId: options.systemId },
      SystemState,
    );

    const self = await waitForOwnShip(room);

    const predict = Predict.get(room, { mode: 'lerp', delay: INTERP_DELAY_MS });

    // Remote ships: interpolated a little in the past. Angles interpolate over
    // the shortest arc, so they must be attached separately from linear fields.
    predict.attachAll('ships', { mode: 'lerp', fields: ['x', 'y', 'vx', 'vy'] });
    predict.attachAll('ships', { mode: 'lerp', fields: ['angle'], angle: true });

    const input = room.input({ type: ShipInput });

    // The bot's own ship: actively predicted, rolled back and replayed against
    // the authoritative state using the shared step function.
    const me = predict.reconciler(self, {
      input,
      step: (ctx, state, cmd) => {
        stepFlight(state, cmd, SPIKE_PROFILE, ctx);
      },
      smoothMs: 65,
      snap: SNAP_DISTANCE,
      warnOnDivergence: DRIFT_TOLERANCE,
    });

    const bot = new Bot(room, self, predict, me, input, options);
    bot.start();
    return bot;
  }

  private start(): void {
    this.frameTimer = setInterval(() => {
      this.frame();
    }, FRAME_INTERVAL_MS);
  }

  /**
   * One frame: advance the predictor, send exactly one input per fixed step due,
   * then read. The order matters — a read between `tick()` and the sends is one
   * step stale.
   */
  private frame(): void {
    if (this.closed) return;

    const due = this.predict.tick(performance.now());

    for (let i = 0; i < due; i++) {
      const view: BotView = {
        self: this.me.state,
        ships: this.room.state.ships,
        profile: SPIKE_PROFILE,
        sessionId: this.room.sessionId,
        serverNow: this.room.clock.serverNow(),
        step: this.steps,
      };

      // Reset to neutral so a brain that sets nothing coasts rather than
      // repeating last frame's command by accident.
      this.input.data.turn = 0;
      this.input.data.thrust = 0;
      this.input.data.brake = false;

      this.options.brain.decide(view, this.input.data);
      this.input.send();
      this.steps++;
    }
  }

  get telemetry(): BotTelemetry {
    const drift = this.me.drift;
    return {
      callsign: this.options.callsign,
      brain: this.options.brain.name,
      status: classifyDrift(drift, DRIFT_TOLERANCE),
      driftEma: drift.ema,
      driftPeak: drift.peak,
      rtt: this.room.clock.smoothedRtt(),
      jitter: this.room.clock.jitter(),
      pendingInputs: this.input.pendingCount,
      inputsSent: this.input.sentCount,
      steps: this.steps,
      shipsSeen: this.room.state.ships.size,
    };
  }

  /** The bot's own authoritative (server) ship state, for assertions. */
  get authoritative(): ShipState {
    return this.self;
  }

  /** The bot's predicted ship state. */
  get predicted(): ShipState {
    return this.me.state;
  }

  async leave(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.frameTimer) clearInterval(this.frameTimer);
    await this.room.leave();
  }
}

/**
 * Wait until the server has created this client's ship and the first patch has
 * decoded it. Joining is not the same as existing in the simulation.
 */
function waitForOwnShip(room: SystemRoom, timeoutMs = 10_000): Promise<ShipState> {
  const existing = room.state.ships.get(room.sessionId);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`bot ${room.sessionId}: own ship never arrived in room state`));
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
