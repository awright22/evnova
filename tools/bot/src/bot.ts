/**
 * Headless bot client.
 *
 * Connects over the real protocol with the real SDK: same prediction,
 * reconciliation and interpolation path a browser client takes. That makes the
 * bot a genuine test of the netcode rather than a shortcut around it, and lets
 * the soak run drive the live server at accelerated scale.
 */

import type { Reconciler } from "@colyseus/sdk";
import {
  ColyseusSDK,
  Predict,
  type InputHandle,
  type Room,
} from "@colyseus/sdk";
// Drift telemetry lives on a subpath: it is the SDK's own classifier, so the
// bot's verdict and the dev panel's can never disagree.
import { classifyDrift, type DriftStatus } from "@colyseus/sdk/predict/drift";
import {
  PATCH_RATE,
  SERVER_MESSAGES,
  ShipInput,
  SystemState,
  content,
  deriveStats,
  placeAll,
  stepFlight,
  type ShipProfile,
  type ShipState,
} from "@marque/shared";

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
  readonly ships: SystemState["ships"];
  readonly profile: ShipProfile;
  readonly sessionId: string;
  /** Server time in ms, for absolute deadlines. */
  readonly serverNow: number;
  /** Fixed step index this command is for. */
  readonly step: number;
  /** Ask the server to mark a hull, through the same intent a captain uses. */
  readonly mark: (id: string) => void;

  // --- Trade -------------------------------------------------------------
  //
  // Everything a captain can do at a berth, through the same intents. A
  // trading brain is not given a shortcut: if it can do it, a player can.

  /** The system the bot is in, for a brain that plans a route. */
  readonly systemId: string;
  /** The berth it is standing on, or undefined while flying. */
  readonly landedAt: string | undefined;
  /** The latest purse the server sent. */
  readonly purse: BotPurse;
  /** The berth's Staple, while alongside one that keeps a market. */
  readonly market: BotMarket | undefined;

  readonly land: (portId: string) => void;
  readonly launch: () => void;
  readonly trade: (
    side: "buy" | "sell",
    commodity: string,
    units: number,
  ) => void;
  /** Buy one of the berth's own services: Propellant, Ordnance, repairs. */
  readonly service: (
    name: "propellant" | "ordnance" | "repair" | "composition",
  ) => void;
  readonly jump: (systemId: string) => void;
}

/** What the server says the bot has. */
export interface BotPurse {
  readonly marks: number;
  readonly propellant: number;
  readonly propellantCapacity: number;
  readonly jumpCost: number;
  readonly landedPort: string;
}

/** What a berth is trading, as the bot sees it. */
export interface BotMarket {
  readonly port: string;
  readonly listings: readonly {
    commodityId: string;
    name: string;
    ask: number;
    bid: number;
    stock: number;
    /** How far from target, as a fraction: positive is a glut. */
    pressure: number;
    carried: number;
  }[];
  readonly holdCapacity: number;
  readonly holdUsed: number;
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
  /** Draught to fly. Falls back to the starter. */
  readonly blueprint?: string;
  /**
   * Open an account on the Register before joining.
   *
   * An anonymous hull has no captain's row, so it has no purse, no hold and
   * no standing: every berth refuses it. A brain that trades needs one.
   */
  readonly account?: boolean;
  /**
   * Reuse an account already on the Register, instead of opening one.
   *
   * A bot that takes a lane has to rejoin in the destination's room as the
   * same captain, which means signing in with the token it already holds.
   */
  readonly deviceToken?: string;
  /**
   * Told when the server says this captain has arrived somewhere else.
   *
   * The bot cannot follow by itself: a jump moves the captain to another
   * room, and the hull in this one is gone. Staying would mean predicting
   * against a ship the server no longer has, which is exactly what it looks
   * like — a client diverging on velocity. The runner replaces the bot.
   */
  readonly onJumped?: (systemId: string, deviceToken: string | undefined) => void;
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
  /** What the bot has, and how its orders went, for the soak's report. */
  readonly marks: number;
  readonly trades: number;
  readonly refusedTrades: number;
  /** Every refused intent, and the last one, so a stuck bot says why. */
  readonly refusals: number;
  readonly lastRefusal: string;
  readonly landedAt: string;
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
    private me: Reconciler<ShipState>,
    private readonly input: InputHandle<ShipInput>,
    private readonly options: BotOptions,
    private readonly profile: ShipProfile,
  ) {}

  static async connect(options: BotOptions): Promise<Bot> {
    const sdk = new ColyseusSDK(options.endpoint);
    // A trading bot needs a captain's row, which only the Register issues.
    let deviceToken: string | undefined = options.deviceToken;
    if (options.account && deviceToken === undefined) {
      const httpBase = options.endpoint
        .replace(/^ws/, "http")
        .replace(/\/$/, "");
      const response = await fetch(`${httpBase}/account/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callsign: options.callsign, inviteCode: "" }),
      });
      if (!response.ok) {
        throw new Error(
          `could not open an account for ${options.callsign}: ${response.status}`,
        );
      }
      deviceToken = ((await response.json()) as { deviceToken: string })
        .deviceToken;
    }

    const room = await sdk.joinOrCreate<SystemState>(
      options.roomName ?? "system",
      {
        callsign: options.callsign,
        // A captain joins the system their row names; an anonymous hull takes
        // whichever it was told.
        systemId: deviceToken
          ? content().tuning.start.system
          : options.systemId,
        ...(deviceToken !== undefined ? { deviceToken } : {}),
        ...(options.blueprint !== undefined
          ? { blueprint: options.blueprint }
          : {}),
      },
      SystemState,
    );

    // Catch what the server says before anything is awaited.
    //
    // The purse is sent while the captain joins, and the next await here is a
    // poll that can take a few hundred milliseconds: registering handlers
    // after it threw that first purse away, so a trading bot believed it had
    // no marks and no Propellant, and never had the fuel to take a lane. The
    // state these land in is held in plain variables until the bot exists.
    const inbox = {
      purse: undefined as Partial<BotPurse> | undefined,
      market: undefined as BotMarket | undefined,
      landedAt: undefined as string | undefined,
      jumpedTo: undefined as string | undefined,
      /** The bot, once it exists. The handlers above close over this. */
      bot: undefined as Bot | undefined,
    };

    const handled = new Set<string>([
      "purse",
      "market",
      "landed",
      "at-port",
      "jump-complete",
    ]);

    room.onMessage("purse", (payload) => {
      inbox.purse = payload as Partial<BotPurse>;
      inbox.bot?.notePurse(inbox.purse);
    });
    room.onMessage("market", (payload) => {
      inbox.market = payload as BotMarket;
      inbox.bot?.noteMarket(inbox.market);
    });
    for (const type of ["landed", "at-port"] as const) {
      room.onMessage(type, (payload) => {
        inbox.landedAt = (payload as { port: string }).port;
        inbox.bot?.noteLanded(inbox.landedAt);
      });
    }
    room.onMessage("jump-complete", (payload) => {
      inbox.jumpedTo = (payload as { system: string }).system;
      inbox.bot?.noteJumped(inbox.jumpedTo);
    });

    // The rest are presentation broadcasts for browsers. Registering no-ops
    // keeps the SDK from warning once per message that nothing is listening —
    // but only for types nothing else is listening for, because a second
    // handler for a type replaces the first, and a no-op registered over the
    // purse handler is how this bot came to think it had no marks.
    for (const type of SERVER_MESSAGES) {
      if (!handled.has(type)) room.onMessage(type, () => undefined);
    }


    const self = await waitForOwnShip(room);

    // Derive handling from the draught the server assigned, from the same data
    // the server used. A bot that predicts with the wrong profile would report
    // divergence that says nothing about the netcode.
    const { blueprints, modules, tuning } = content();
    const blueprint = blueprints.get(self.blueprint);
    if (!blueprint) throw new Error(`unknown draught "${self.blueprint}"`);
    const profile = deriveStats(
      placeAll(blueprint.placements, modules),
      tuning,
    ).profile;

    const predict = Predict.get(room, { mode: "lerp", delay: INTERP_DELAY_MS });

    // Remote ships: interpolated a little in the past. Angles interpolate over
    // the shortest arc, so they must be attached separately from linear fields.
    predict.attachAll("ships", {
      mode: "lerp",
      fields: ["x", "y", "vx", "vy"],
    });
    predict.attachAll("ships", {
      mode: "lerp",
      fields: ["angle"],
      angle: true,
    });

    const input = room.input({ type: ShipInput });

    // The bot's own ship: actively predicted, rolled back and replayed against
    // the authoritative state using the shared step function.
    const me = predict.reconciler(self, {
      input,
      // Exactly the fields the shared step owns.
      //
      // The reconciler mirrors every scalar field of the schema by default,
      // which pulled in shield: the server regenerates it from the time since
      // the hull was last hit and its power state, neither of which the client
      // simulates, so every fight produced corrections the client could never
      // have predicted. Those are not mispredictions to smooth away — they are
      // server truth arriving — so shield, module damage and the rest come in
      // as plain state.
      fields: ["x", "y", "vx", "vy", "angle", "angVel"],

      step: (ctx, state, cmd) => {
        stepFlight(state, cmd, profile, ctx);
      },
      smoothMs: 65,
      snap: SNAP_DISTANCE,
      warnOnDivergence: DRIFT_TOLERANCE,
    });

    const bot = new Bot(room, self, predict, me, input, options, profile);
    inbox.bot = bot;
    bot.noteBound(self);
    bot.noteToken(deviceToken);

    // Hand over anything that arrived while the hull was being waited for.
    if (inbox.purse) bot.notePurse(inbox.purse);
    if (inbox.market) bot.noteMarket(inbox.market);
    if (inbox.landedAt !== undefined) bot.noteLanded(inbox.landedAt);
    if (inbox.jumpedTo !== undefined) bot.noteJumped(inbox.jumpedTo);

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
  /** The server's latest word on what this captain has. */
  notePurse(purse: Partial<BotPurse>): void {
    this.purse = { ...this.purse, ...purse };
    // The purse is the authority on whether the bot is alongside: `landed`
    // announces an arrival, but only the purse says it is still true.
    this.landedAt =
      this.purse.landedPort === "" ? undefined : this.purse.landedPort;
    if (this.landedAt === undefined) this.market = undefined;
  }

  noteMarket(market: BotMarket): void {
    this.market = market;
  }

  noteLanded(port: string): void {
    this.landedAt = port === "" ? undefined : port;
  }

  /**
   * Bind the predictor to the hull that is actually in the simulation.
   *
   * Landing removes the hull and launching creates a new one, so a reconciler
   * bound at connect time is left pointing at a ship the server no longer
   * has: it predicts forward against nothing and reports that as divergence.
   * The browser rebinds by remounting the flight view; this is the same thing
   * done deliberately.
   */
  private rebind(ship: ShipState): void {
    this.me = this.predict.reconciler(ship, {
      input: this.input,
      step: (ctx, state, cmd) => {
        stepFlight(state, cmd, this.profile, ctx);
      },
      fields: ["x", "y", "vx", "vy", "angle", "angVel"],
      smoothMs: 60,
      warnOnDivergence: DRIFT_TOLERANCE,
    });
    this.boundTo = ship;
  }

  private purse: BotPurse = {
    marks: 0,
    propellant: 0,
    propellantCapacity: 0,
    jumpCost: 1,
    landedPort: "",
  };
  private market: BotMarket | undefined;
  private landedAt: string | undefined;
  /** The hull the predictor is bound to, so a relaunch can rebind. */
  private boundTo: ShipState | undefined;
  private deviceToken: string | undefined;
  private jumped = false;

  /** Record the hull bound at connect time. */
  noteBound(ship: ShipState): void {
    this.boundTo = ship;
  }

  /** The account this bot flies as, so a replacement can be the same captain. */
  noteToken(token: string | undefined): void {
    this.deviceToken = token;
  }

  get token(): string | undefined {
    return this.deviceToken;
  }

  /** The captain has arrived in another system; this room is no longer theirs. */
  noteJumped(systemId: string): void {
    if (this.jumped) return;
    this.jumped = true;
    this.landedAt = undefined;
    this.market = undefined;
    this.options.onJumped?.(systemId, this.deviceToken);
  }

  /** True once the captain has left this room for another system. */
  get hasJumped(): boolean {
    return this.jumped;
  }
  /** Orders sent and orders refused, for the soak's report. */
  private trades = 0;
  private refusedTrades = 0;
  private refusals = 0;
  private lastRefusal = "";

  /**
   * Send an intent, keeping why it was refused.
   *
   * A bot that swallows its refusals is a bot that cannot be debugged: this
   * one spent a run flying in circles because every `land` was being turned
   * down and nothing said so.
   */
  private send(type: string, payload: unknown, onRefused?: () => void): void {
    void this.room.request(type, payload).catch((error: unknown) => {
      const reason = (error as { reason?: string }).reason ?? "unknown";
      this.lastRefusal = `${type}:${reason}`;
      this.refusals++;
      onRefused?.();
    });
  }

  private frame(): void {
    if (this.closed) return;

    // Gone to another system: this room's hull is the server's, not ours.
    // Predicting on would report divergence that is only this bot looking at
    // the wrong room.
    if (this.jumped) return;

    // While alongside there is no hull to predict. Ticking the predictor
    // against one the server has removed is what made a trading bot report
    // divergence it had not actually suffered.
    if (this.landedAt !== undefined) {
      this.runBrain();
      return;
    }

    // Launched again: the server made a new hull, so bind to that one.
    const live = this.room.state.ships.get(this.room.sessionId);
    if (live && live !== this.boundTo) this.rebind(live);
    if (!live) return;

    const due = this.predict.tick(performance.now());

    for (let i = 0; i < due; i++) {
      const view = this.view();

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

  /** Everything a brain is given, rebuilt each step. */
  private view(): BotView {
    return {
      self: this.me.state,
      ships: this.room.state.ships,
      profile: this.profile,
      sessionId: this.room.sessionId,
      serverNow: this.room.clock.serverNow(),
      step: this.steps,
      mark: (id: string) => {
        void this.room.request("target", { id }).catch(() => undefined);
      },
      systemId: this.room.state.systemId,
      landedAt: this.landedAt,
      purse: this.purse,
      market: this.market,
      land: (portId: string) => {
        this.send("land", { port: portId });
      },
      launch: () => {
        this.send("launch", {});
      },
      trade: (side, commodity, units) => {
        this.trades++;
        this.send(
          "staple",
          { side, commodity, units },
          () => this.refusedTrades++,
        );
      },
      service: (name) => {
        this.send("port", { service: name, units: 0 });
      },
      jump: (systemId: string) => {
        this.send("jump", { system: systemId });
      },
    };
  }

  /**
   * Run the brain without flying.
   *
   * Alongside, the brain is still where trading and the decision to launch
   * happen, but there is no hull and nothing to send.
   */
  private runBrain(): void {
    this.options.brain.decide(this.view(), this.input.data);
    this.steps++;
  }

  get telemetry(): BotTelemetry {
    const drift = this.me.drift;
    return {
      marks: this.purse.marks,
      trades: this.trades,
      refusedTrades: this.refusedTrades,
      refusals: this.refusals,
      lastRefusal: this.lastRefusal,
      landedAt: this.landedAt ?? "",
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
function waitForOwnShip(
  room: SystemRoom,
  timeoutMs = 10_000,
): Promise<ShipState> {
  const existing = room.state.ships.get(room.sessionId);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `bot ${room.sessionId}: own ship never arrived in room state`,
        ),
      );
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
