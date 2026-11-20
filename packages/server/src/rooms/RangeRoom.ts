/**
 * The range.
 *
 * Spec section 7 and M8: a captain should be able to fly a draught, and fight
 * something in it, before paying for it. This is where that happens — a room
 * of its own rather than a mode of a system, so that nothing a captain does
 * out here can reach their books by any path at all. The range reads their
 * licence and their callsign and writes nothing, ever: no ledger, no
 * stockpiles, no holdings, no hull row, not even a position. The hull being
 * flown does not exist, and when the room closes it is gone.
 *
 * It is the same simulation as everywhere else: the same flight step, the
 * same weapons, the same Unlettered brain behind the sparring hulls. A
 * draught that handles badly out here handles badly in the Marque.
 */

import { Room, validate, type Client, type StepContext } from '@colyseus/core';

import {
  EMPTY_LOADOUT,
  RangeSparIntent,
  Rng,
  SHIP_INPUT_SANITIZE,
  builtBlueprint,
  clamp,
  encodeShareCode,
  SUB_STEPS,
  ShipInput,
  ShipState,
  SystemState,
  TICK_RATE,
  TargetIntent,
  content,
  placeAll,
  stepFlight,
  validateDesign,
  type FlightCommand,
  type LicenceId,
  type Placement,
  type SystemDef,
} from '@marque/shared';

import { config } from '../config.ts';
import { AuthError, type Account } from '../accounts.ts';
import { world } from '../world/World.ts';
import { CombatSystem } from './combat.ts';
import { ShipRuntime } from './ShipRuntime.ts';
import { unletteredPilot, type NpcPilot } from './npc.ts';

export interface RangeOptions {
  /** Whose sky to draw. The range sits far out in it, clear of every berth. */
  readonly systemId?: string;
  readonly deviceToken?: string;
  /** The draught under test, as a grid. */
  readonly placements?: unknown;
  /** What the captain has called it, which is what the hull reads as. */
  readonly name?: string;
  /** What to put up against it, by catalogue draught id. */
  readonly against?: string;
}

/** How far out the arena sits, as a share of the system's radius. */
const ARENA = 0.86;

/** How far the sparring hulls start from the captain. */
const SPAR_STANDOFF = 1400;

/** How long a wreck lies there before the range hands back a sound hull. */
const MEND_AFTER_MS = 2500;

/** What the range puts up unless the captain asks for something else. */
const DEFAULT_SPAR = 'force-majeure';

/** How many of them. Two, so a draught is tested against being outnumbered. */
const SPAR_COUNT = 2;

export class RangeRoom extends Room<{
  state: SystemState;
  input: ShipInput;
}> {
  override state = new SystemState();

  override inputs = this.defineInput(ShipInput, {
    bufferMaxSize: 64,
    sanitize: SHIP_INPUT_SANITIZE,
    idle: ({ latest }) => latest ?? true,
  });

  override maxClients = 1;

  private readonly runtimes = new Map<string, ShipRuntime>();
  private readonly pilots = new Map<string, NpcPilot>();
  private combat!: CombatSystem;
  private rng!: Rng;
  private system: SystemDef | undefined;

  /** The grid under test, so a mend can rebuild it exactly. */
  private design: Placement[] = [];
  private flying = '';
  /** What the draught under test is called. */
  private named = 'Under Trial';
  /** The warrant the draught was checked against, which also paints it. */
  private licence: LicenceId = 'open-ticket';
  private sparring = DEFAULT_SPAR;
  private nextSpar = 1;
  /** Where the arena is, so everything spawns around one point. */
  private centre = { x: 0, y: 0 };

  override onAuth(_client: Client, options: RangeOptions = {}): Account | true {
    const token = typeof options.deviceToken === 'string' ? options.deviceToken : '';
    if (token === '') {
      if (config.isProduction) throw new AuthError('bad-token');
      return true;
    }
    return world().accounts.signIn(token);
  }

  override onCreate(options: RangeOptions = {}): void {
    const { systems } = content();
    const requested = options.systemId ?? content().tuning.start.system;
    this.system = systems.get(requested) ?? [...systems.values()][0];
    this.state.systemId = this.system?.id ?? requested;

    this.rng = new Rng(`range:${this.roomId}`);
    // Far out, on a bearing of its own, so no berth is ever in reach and the
    // interface offers nothing a captain on a range cannot have.
    const bearing = this.rng.range(-Math.PI, Math.PI);
    const out = (this.system?.radius ?? 30_000) * ARENA;
    this.centre = { x: Math.cos(bearing) * out, y: Math.sin(bearing) * out };

    this.combat = new CombatSystem(
      {
        state: this.state,
        tuning: content().tuning,
        runtimeOf: (id) => this.runtimes.get(id),
        now: () => this.clock.elapsedTime,
        onWrittenOff: (id, killedBy) => this.writeOff(id, killedBy),
        onImpact: (event) => this.broadcast('impact', event),
      },
      this.roomId,
    );

    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE, { subSteps: SUB_STEPS });
  }

  override messages = {
    '*': (client: Client, type: string | number) => {
      // Everything a captain cannot do out here — land, jump, trade, build —
      // reaches this. Refusing by type rather than one handler per type:
      // the range offers two things, and the rest is not a version skew.
      void client;
      void type;
    },

    target: validate(TargetIntent, (client: Client, message: TargetIntent, ctx) => {
      const ship = this.state.ships.get(client.sessionId);
      if (!ship) return ctx.reject('not-owned');
      if (message.id === '') {
        ship.target = '';
        return { target: '' };
      }
      if (!this.state.ships.has(message.id)) return ctx.reject('unknown-target');
      ship.target = message.id;
      return { target: message.id };
    }),

    /**
     * Put something else up, and start again with a sound hull.
     *
     * The point of a range is to try a draught against more than one thing:
     * a hull that beats a gunboat and cannot touch a turret is a hull a
     * captain should find out about here rather than off Sato's Error.
     */
    spar: validate(RangeSparIntent, (client: Client, message: RangeSparIntent, ctx) => {
      const { blueprints } = content();
      if (message.against !== '' && !blueprints.has(message.against)) {
        return ctx.reject('unknown-draught');
      }
      if (message.against !== '') this.sparring = message.against;

      for (const [id] of [...this.state.ships]) {
        if (id !== client.sessionId) this.removeHull(id);
      }
      this.mend(client.sessionId);
      for (let i = 0; i < SPAR_COUNT; i++) this.spawnSpar();

      return { against: this.sparring, count: SPAR_COUNT };
    }),
  };

  override onJoin(client: Client, options: RangeOptions = {}): void {
    const auth = client.auth as Account | true | undefined;
    const account = auth === true ? undefined : auth;
    // Read-only: the licence caps what may be drawn, and the callsign is on
    // the hull. Nothing is written back.
    const pilot = account ? world().pilots.load(account.id) : undefined;
    const licence = (pilot?.licence ?? 'open-ticket') as LicenceId;

    const { blueprints, licences, modules, tuning } = content();
    const asked = Array.isArray(options.placements)
      ? (options.placements as Placement[])
      : undefined;

    // A draught the captain named, or the grid they sent. Either is checked
    // against their warrant before anything is built, the same check the Yard
    // makes, because the range must not fly what the Yard would refuse.
    const grid = asked ?? blueprints.get(tuning.start.draught)?.placements ?? [];
    const known = grid.every((placement) => modules.has(placement.moduleId));
    const rule = licences.get(licence) ?? [...licences.values()][0]!;
    const problems = known
      ? validateDesign(placeAll([...grid], modules), rule, tuning).problems
      : [{ kind: 'unknown', message: 'a fitting the Register does not list' }];

    if (!known || problems.length > 0) {
      client.send('range', {
        flying: '',
        against: '',
        problems: problems.map((problem) => problem.message),
      });
      return;
    }

    this.design = [...grid];
    this.flying = pilot?.callsign ?? 'Trials';
    // The hull reads as the draught, not as the captain: the whole question
    // out here is what *she* is, and a readout that names the pilot answers
    // a question nobody asked.
    this.named =
      typeof options.name === 'string' && options.name.trim() !== ''
        ? options.name.trim().slice(0, 40)
        : 'Under Trial';
    this.sparring = typeof options.against === 'string' && blueprints.has(options.against)
      ? options.against
      : DEFAULT_SPAR;

    this.licence = licence;
    this.spawnHull(client.sessionId, this.design, this.flying, false, licence);
    for (let i = 0; i < SPAR_COUNT; i++) this.spawnSpar();

    client.send('range', {
      flying: this.named,
      against: this.sparring,
      problems: [],
      // What the range is: said once, in the words the interface will use.
      note: 'Nothing out here is real. Come back when you have seen enough.',
    });
  }

  override onLeave(client: Client): void {
    this.removeHull(client.sessionId);
  }

  // --- Hulls ---------------------------------------------------------------

  private spawnHull(
    id: string,
    placements: readonly Placement[],
    callsign: string,
    hostile: boolean,
    licence: LicenceId = 'open-ticket',
    /** A catalogue draught's id, when this hull is one. */
    draughtId = '',
  ): void {
    const { modules, tuning } = content();
    const runtime = new ShipRuntime(
      // The same shape the Moorings hands a built hull over in, so a draught
      // flies here exactly as it would once it is paid for.
      builtBlueprint({ id, name: callsign, placements: [...placements] }, licence, tuning),
      modules,
      tuning,
      EMPTY_LOADOUT,
      // A full magazine, because the range is for finding out what a draught
      // does and not for finding out what it does with an empty one.
      999,
    );

    const ship = new ShipState();
    ship.callsign = callsign;
    const named = draughtId === '' ? this.named : callsign;
    // The same contract the rest of the game uses: a catalogue draught goes
    // by its id, and anything else travels as the share code the client
    // already decodes. A grid under test is not in anybody's catalogue, so
    // without the code the client has nothing to draw it from — or to
    // predict its flight with.
    const catalogued = content().blueprints.get(draughtId);
    ship.blueprint = catalogued ? draughtId : id;
    ship.hull = catalogued
      ? ''
      : encodeShareCode({ name: named, placements: [...placements] });
    ship.hostile = hostile;
    ship.shield = runtime.shieldCapacity;
    for (const hp of runtime.hp) ship.moduleHp.push(Math.round(hp));
    ship.x = this.centre.x;
    ship.y = this.centre.y;

    this.runtimes.set(id, runtime);
    this.state.ships.set(id, ship);
  }

  /** Put another sparring hull up, standing off the arena's centre. */
  private spawnSpar(): void {
    const { blueprints } = content();
    const draught = blueprints.get(this.sparring);
    if (!draught) return;

    const id = `spar-${this.nextSpar++}`;
    this.spawnHull(id, draught.placements, draught.name, true, 'open-ticket', draught.id);

    const ship = this.state.ships.get(id);
    if (ship) {
      const bearing = this.rng.range(-Math.PI, Math.PI);
      ship.x = this.centre.x + Math.cos(bearing) * SPAR_STANDOFF;
      ship.y = this.centre.y + Math.sin(bearing) * SPAR_STANDOFF;
      ship.angle = Math.atan2(this.centre.y - ship.y, this.centre.x - ship.x);
    }
    this.pilots.set(id, unletteredPilot(id, `${this.roomId}:${id}`));
  }

  private removeHull(id: string): void {
    this.combat.retireRoundsOf(id);
    const runtime = this.runtimes.get(id);
    if (runtime) this.combat.dropBeams(id, runtime);
    this.state.ships.delete(id);
    this.runtimes.delete(id);
    this.pilots.delete(id);
  }

  /** Hand back a sound hull, which out here costs nothing and means nothing. */
  private mend(sessionId: string): void {
    this.removeHull(sessionId);
    if (this.design.length === 0) return;
    this.spawnHull(sessionId, this.design, this.flying, false, this.licence);
  }

  private writeOff(id: string, killedBy: string): void {
    const ship = this.state.ships.get(id);
    if (!ship) return;
    ship.destroyedAt = Math.round(this.clock.elapsedTime) || 1;
    ship.shield = 0;
    ship.target = '';

    this.broadcast('written-off', {
      id,
      callsign: ship.callsign,
      killedBy,
      x: ship.x,
      y: ship.y,
      blueprint: ship.blueprint,
    });
  }

  // --- The tick ------------------------------------------------------------

  private step(ctx: StepContext): void {
    const now = this.clock.elapsedTime;

    for (const [id, ship] of this.state.ships) {
      const runtime = this.runtimes.get(id);
      if (!runtime) continue;

      if (ship.destroyedAt > 0) {
        this.combat.dropBeams(id, runtime);
        ship.x += ship.vx * ctx.dt;
        ship.y += ship.vy * ctx.dt;
        if (now - ship.destroyedAt > MEND_AFTER_MS) {
          // Out here a wreck is a lesson, not a loss: the sparring hull is
          // put up again and the captain's is handed back sound.
          if (this.pilots.has(id)) {
            this.removeHull(id);
            this.spawnSpar();
          } else {
            this.mend(id);
          }
        }
        continue;
      }

      const command = this.commandFor(id, ship, runtime);
      if (!command) continue;

      stepFlight(ship, command, runtime.profile, ctx);
      this.combat.fire(id, ship, runtime, command.firePrimary, command.fireSecondary, ctx.dt);
      this.combat.holdBeams(id, ship, runtime, command.firePrimary, ctx.dt);
      this.combat.defend(id, ship, runtime);
      this.regenerateShield(ship, runtime, ctx.dt, now);
    }

    this.combat.step(ctx.dt, ctx.tick);
    this.combat.stepCanisters(ctx.dt);
    this.state.tick = ctx.tick;
  }

  private commandFor(
    id: string,
    ship: ShipState,
    runtime: ShipRuntime,
  ): (FlightCommand & { firePrimary: boolean; fireSecondary: boolean }) | undefined {
    const pilot = this.pilots.get(id);
    if (pilot) {
      const decision = pilot.decide(ship, runtime.profile, {
        // Everything that is not another sparring hull, which is the captain.
        nearestCandidate: (selfId) => this.quarry(selfId),
        candidate: (selfId, other) =>
          other !== selfId && !this.pilots.has(other)
            ? this.state.ships.get(other)
            : undefined,
        stationOf: () => this.centre,
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

  /** Shields come back a while after the last hit, as they do everywhere. */
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

  /** The hull a sparring pilot is here to shoot at, which is the captain's. */
  private quarry(selfId: string): string | undefined {
    for (const [id, ship] of this.state.ships) {
      if (id === selfId || this.pilots.has(id) || ship.destroyedAt > 0) continue;
      return id;
    }
    return undefined;
  }
}
