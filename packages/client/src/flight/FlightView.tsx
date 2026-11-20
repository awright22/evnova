/**
 * The flight view.
 *
 * Mounts the Pixi renderer, owns the frame loop, and bridges it to the HUD.
 * The loop's order is the netcode contract: tick the predictor, send exactly
 * the inputs it asked for, then read positions and draw.
 */

import { Application } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import {
  BOARDING_RANGE,
  BOARDING_SPEED,
  LANDING_RANGE,
  LANDING_SPEED,
  PROJECTILE_KIND,
  content,
  deriveStats,
  leadPoint,
  placeAll,
  speedOf,
  type ClaimState,
  type SystemDef,
} from '@marque/shared';

import type { AudioMix } from '../audio/mix.ts';
import { sharedMix } from '../audio/shared.ts';
import { playNotice } from '../audio/notices.ts';
import { Hint } from '../shell/Hint.tsx';
import {
  motionIsReduced,
  type Action,
  type Binding,
} from '../shell/settings.ts';
import { CombatAudio } from '../audio/combat.ts';
import { EngineSound } from '../audio/engine.ts';
import { flightAudio, type FlightAudio } from '../audio/flight.ts';
import { isRegion, startMusic, type Music } from '../audio/music.ts';
import { Hud, type HudReadout } from '../hud/Hud.tsx';
import { drawRadar, type RadarContact } from '../hud/radar.ts';
import { Session } from '../net/session.ts';
import { KeyboardInput } from './input.ts';
import { GamepadInput, asked, mergeIntents } from './gamepad.ts';
import { palette } from './palette.ts';
import { HullBook } from './hulls.ts';
import { Effects } from './effects.ts';
import {
  Scene,
  type BeamFrame,
  type RockFrame,
  type CanisterFrame,
  type ProjectileFrame,
  type ShipFrame,
} from './scene.ts';
import './flight.css';

export interface FlightViewProps {
  readonly room: Parameters<typeof Session.attach>[0];
  /** What the captain has, for the instruments. */
  readonly purse: {
    marks: number;
    propellant: number;
    propellantCapacity: number;
    jumpCost: number;
    /** Marks the Prize Court has against this captain. */
    composition: number;
  };
  readonly notice: string | undefined;
  /** The system the captain has plotted for, if any. J spools for it. */
  readonly course: string | undefined;
  /** The plotted system's in-world name, for the instruments. */
  readonly courseName: string | undefined;
  onLand: (portId: string) => void;
  onOpenChart: () => void;
  /** Spool for the plotted course. False when nothing is plotted. */
  onJump: () => boolean;
  onCancelJump: () => void;
  /** True while the chat composer has the keyboard. */
  readonly composing: boolean;
  /**
   * Callsigns of the captains sailing in convoy with this one.
   *
   * By callsign because that is what a hull in the simulation carries: the
   * room's ships know who they are, not which account they belong to.
   */
  readonly convoy: ReadonlySet<string>;
  /**
   * The captain's key bindings, from the settings screen.
   *
   * Changing them while flying rebinds in place rather than rebuilding the
   * renderer, so the hull keeps its position and the backdrop keeps its stars.
   */
  readonly bindings: Record<Action, Binding>;
  /**
   * Called once the hull is genuinely moving.
   *
   * The ticket's first endorsement. Reported from here because this is the
   * only place that knows what the hull is doing: the server's patch rate
   * is low enough that a captain can burn and stop between two of them.
   */
  onUnderWay?: () => void;
}

export function FlightView({
  room,
  purse,
  notice,
  course,
  courseName,
  onLand,
  onOpenChart,
  onJump,
  onCancelJump,
  composing,
  convoy,
  bindings,
  onUnderWay,
}: FlightViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const radarRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HudReadout>({
    speed: 0,
    heading: 0,
    throttle: 0,
    callsign: '',
    draught: '',
    prize: undefined,
    system: '',
    contacts: 0,
    rtt: 0,
    linkOk: false,
    shield: 0,
    shieldMax: 0,
    integrity: 1,
    target: undefined,
    refusal: undefined,
    propellant: 0,
    propellantCapacity: 0,
    marks: 0,
    composition: 0,
    wreck: false,
    spoolingTo: '',
    course: '',
    spoolProgress: 0,
    landingProgress: 0,
    berth: undefined,
  });

  const [failure, setFailure] = useState<string | undefined>(undefined);

  /**
   * Whether anything adrift has ever been alongside this session.
   *
   * Boarding is the one system a captain cannot go and look at: it only
   * exists when a hull with its engines gone happens to be within reach. So
   * its note waits for that to actually happen, once, and then never again.
   */
  const [prizeAlongside, setPrizeAlongside] = useState(false);
  const sawPrize = useRef(false);
  const [writtenOff, setWrittenOff] = useState<WrittenOff | undefined>(undefined);

  // The frame loop is started once; these keep it reading current values
  // rather than the ones captured when it started.
  const keyboardRef = useRef<KeyboardInput | undefined>(undefined);

  // Rebind in place when the settings change, rather than tearing the
  // renderer down: the captain is mid-flight when they open the settings.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    keyboardRef.current?.rebind(bindings);
  }, [bindings]);

  // Something else has the keyboard: let go of anything held, so a key down
  // when the composer opened does not fly the ship through the conversation.
  useEffect(() => {
    if (composing) keyboardRef.current?.releaseAll();
  }, [composing]);

  // Read through a ref: the draw loop runs outside React and a new Set on
  // every render would rebuild the effect that owns the renderer.
  const convoyRef = useRef(convoy);
  convoyRef.current = convoy;

  const liveRef = useRef({
    purse,
    notice,
    course,
    courseName,
    onLand,
    onOpenChart,
    onJump,
    onCancelJump,
    onUnderWay,
  });
  liveRef.current = {
    purse,
    notice,
    course,
    courseName,
    onLand,
    onOpenChart,
    onJump,
    onCancelJump,
    onUnderWay,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let app: Application | undefined;
    let scene: Scene | undefined;
    let session: Session | undefined;
    let keyboard: KeyboardInput | undefined;
    // One pad reader for the view. It asks the browser each frame rather
    // than listening for connect events, because a pad that was plugged in
    // before the page loaded fires no event at all.
    const pad = new GamepadInput();
    let mix: AudioMix | undefined;
    let engine: EngineSound | undefined;
    let combat: CombatAudio | undefined;
    let music: Music | undefined;
    let hull: FlightAudio | undefined;
    /** Beams that were sounding last frame, so the ones that stopped are let go. */
    const heldBeams = new Set<string>();
    let frame = 0;
    /** The lane being spooled for on the last frame, for the spool's edges. */
    let lastSpoolTo = '';
    let lastSpoolProgress = 0;
    /** The turn being held on the last frame, for the manoeuvring jets. */
    let lastTurn: -1 | 0 | 1 = 0;

    const start = async (): Promise<void> => {
      const { systems, blueprints: catalogue, modules, tuning } = content();
      // Reads like the catalogue, and learns a hull somebody built the first
      // time one shows up on the wire.
      const blueprints = new HullBook(catalogue, modules, tuning);

      session = await Session.attach(room, blueprints);
      if (disposed) return;

      const shieldCapacities = new Map<string, number>();
      const muzzleSpeeds = new Map<string, number>();
      const intactStructure = new Map<string, number>();

      /** Structure remaining, against the draught's intact total. */
      const integrityOf = (frame: ShipFrame): number => {
        let total = intactStructure.get(frame.blueprint) ?? 0;
        if (total === 0) {
          const bp = blueprints.get(frame.blueprint);
          for (const placement of bp?.placements ?? []) {
            total += modules.get(placement.moduleId)?.hitPoints ?? 0;
          }
          intactStructure.set(frame.blueprint, total);
        }
        if (total <= 0) return 0;
        let left = 0;
        for (const hp of frame.moduleHp) left += hp;
        return Math.max(0, Math.min(1, left / total));
      };
      const system: SystemDef =
        systems.get(room.state.systemId) ?? [...systems.values()][0]!;

      app = new Application();
      await app.init({
        resizeTo: host,
        backgroundColor: palette().void,
        // No multisampling on the main canvas. Ship textures are rendered with
        // antialiasing into their own targets, and the backdrop is points and
        // noise, so MSAA here buys almost nothing and costs a full-screen
        // resolve every frame.
        antialias: false,
        // Match the display so 1px rules stay 1px.
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        preference: 'webgl',
      });
      if (disposed) {
        app.destroy(true);
        return;
      }

      host.appendChild(app.canvas);

      // The setting first, then what the browser asks for.
      const reducedMotion = motionIsReduced();
      scene = new Scene(app.renderer, system, blueprints, modules, reducedMotion);
      scene.resize(app.screen.width, app.screen.height);
      app.stage.addChild(scene.root);

      keyboard = new KeyboardInput(window, bindingsRef.current);
      keyboardRef.current = keyboard;

      // Browsers refuse to start audio without a gesture, so the mix is built
      // on the first key press and torn down with the view.
      const startAudio = (): void => {
        if (mix || disposed) return;
        // The one mix for the session, so the volume settings reach it and
        // the port screens' own sounds come out of the same buses.
        mix = sharedMix();
        void mix.unlock().then(() => {
          if (disposed || !mix) return;
          engine = new EngineSound(mix);
          combat = new CombatAudio(mix);
          hull = flightAudio();
          // The hull is already alongside when a captain lands and launches
          // again, so the clamps letting go belong to the view starting,
          // not to a key. Nothing is heard if the view started in flight.
          if (room.state.ships.get(session!.sessionId)?.landingProgress ?? 0) {
            hull?.launch();
          }
          // The region's bed. Started here rather than at the title, because
          // this is the first gesture: a browser will not sound a note before
          // one, and a drone that fails to start is worse than a late one.
          if (isRegion(system.region)) music = startMusic(mix, system.region);
        });
      };
      window.addEventListener('keydown', startAudio, { once: true });
      window.addEventListener('pointerdown', startAudio, { once: true });

      const self0 = session.predicted;
      scene.camera.jumpTo(self0.x, self0.y);

      const frames: ShipFrame[] = [];
      const contacts: RadarContact[] = [];
      const stepLog: number[] = [];
      const knownRounds = new Set<string>();
      /**
       * Hulls already in the sky, so a new one can be heard arriving.
       *
       * Seeded on the first frame rather than empty: joining a system with
       * six hulls in it should not sound six beacons at once.
       */
      const knownShips = new Set<string>();
      let skyKnown = false;
      let lastMark = '';
      let lastNow = performance.now();

      // Effects live in world space, under the same camera transform as hulls.
      const effects = new Effects(`fx:${session.sessionId}`, reducedMotion);
      // Graphics quality scales the effects down and never the gameplay, as
      // spec section 3 requires: the same fight, drawn thinner.
      effects.setDensity(document.documentElement.dataset.quality === 'plain' ? 0.4 : 1);
      scene.attachEffects(effects.view);

      // Shield capacity for the bubble, and muzzle speed for the lead mark,
      // both derived from the same data the server used.
      const shieldCapacityOf = (blueprintId: string): number => {
        const cached = shieldCapacities.get(blueprintId);
        if (cached !== undefined) return cached;
        const bp = blueprints.get(blueprintId);
        const value = bp ? deriveStats(placeAll(bp.placements, modules), tuning).shieldCapacity : 0;
        shieldCapacities.set(blueprintId, value);
        return value;
      };

      const muzzleSpeedOf = (blueprintId: string): number => {
        const cached = muzzleSpeeds.get(blueprintId);
        if (cached !== undefined) return cached;
        const bp = blueprints.get(blueprintId);
        let best = 0;
        for (const placement of bp?.placements ?? []) {
          const weapon = modules.get(placement.moduleId)?.weapon;
          if (weapon && weapon.homing === undefined) {
            best = Math.max(best, weapon.projectileSpeed);
          }
        }
        muzzleSpeeds.set(blueprintId, best);
        return best;
      };

      // A fixed gun needs leading, so the interface shows where to aim.
      scene.leadPointOf = (selfFrame, mark) => {
        const speed = muzzleSpeedOf(selfFrame.blueprint);
        if (speed <= 0) return undefined;
        return leadPoint(
          selfFrame.x,
          selfFrame.y,
          mark.x,
          mark.y,
          mark.vx - selfFrame.vx,
          mark.vy - selfFrame.vy,
          speed,
        );
      };

      // Impacts and write-offs are presentation: the outcome already happened
      // on the server, and these only decide what it looks like.
      session.on('impact', (payload) => {
        const event = payload as {
          x: number;
          y: number;
          shielded: boolean;
          targetId: string;
          kind: number;
          disabled: boolean;
        };

        // Point defense reports the round it shot down, which has no hull, no
        // target and no damage. Nothing else in this handler applies to it:
        // sparks on a hull or a shake would say the captain took a hit.
        if (event.kind === PROJECTILE_KIND.defense) {
          effects.defenseIntercept(event.x, event.y);
          combat?.play('intercept', event.x, event.y);
          return;
        }

        const victim = session!.shipViews().find((v) => v.id === event.targetId);
        const normal = victim ? Math.atan2(event.y - victim.y, event.x - victim.x) : 0;
        const mine = event.targetId === session!.sessionId;

        if (event.shielded) {
          effects.shieldHit(event.x, event.y, normal);
          combat?.play('shieldHit', event.x, event.y);
          // Taking a hit is felt, not just seen. Shields absorb most of it.
          if (mine) scene!.camera.impact(0.25);
        } else {
          effects.hullHit(event.x, event.y, normal);
          combat?.play('hullHit', event.x, event.y);
          if (mine) scene!.camera.impact(0.6);
        }

        if (event.disabled) {
          combat?.play('moduleDisabled', event.x, event.y);
          if (mine) scene!.camera.impact(0.8);
        }
      });

      session.on('respawned', () => setWrittenOff(undefined));

      // What the Hall actually settled, and what the hold actually cost.
      session.on('claim', (payload) => {
        const settled = payload as ClaimState;
        setWrittenOff((was) => (was ? { ...was, settled } : was));
        playNotice('claim');
      });

      // A party coming aboard, either way round. The line itself is drawn by
      // the prompt; this is the other channel the feedback table asks for.
      session.on('scanned', (payload) => {
        const line = payload as { kind?: string };
        if (line.kind === 'boarded' || line.kind === 'boarded-by') playNotice('boarded');
      });

      session.on('written-off', (payload) => {
        const event = payload as {
          x: number;
          y: number;
          blueprint: string;
          id: string;
          callsign: string;
          killedBy: string;
        };

        if (event.id === session!.sessionId) {
          // Death has a designed state, not a blank screen. The figures come
          // from the Hall in a `claim` of its own a moment later; what is
          // known straight away is where it happened and who did it.
          const killer = session!.shipViews().find((v) => v.id === event.killedBy);
          setWrittenOff({ system: system.name, by: killer?.callsign ?? '' });
        }
        const art = blueprints.get(event.blueprint);
        const size = art ? art.placements.length / 12 : 1;
        effects.explosion(event.x, event.y, 0, 0, size);
        combat?.play(size > 1.2 ? 'explosionLarge' : 'explosionSmall', event.x, event.y);
        // The hull is gone: a restrained shake, and never under reduced motion.
        scene!.camera.impact(event.id === session!.sessionId ? 1 : 0.35);
      });

      const loop = (): void => {
        if (disposed || !session || !scene || !app) return;
        const now = performance.now();
        const dtMs = Math.min(100, now - lastNow);
        lastNow = now;

        // 1. Advance the predictor and send exactly the inputs it asks for.
        // Both hands at once: whichever is asking for something wins.
        const padIntent = pad.sample();
        const intent = mergeIntents(keyboard!.sample(), padIntent);
        // A jet puffs when the turn starts, not while it is held: the table
        // asks for a puff on the outboard side, and the sound itself limits
        // how often it will make one.
        if (intent.turn !== 0 && intent.turn !== lastTurn) hull?.thruster(intent.turn);
        lastTurn = intent.turn;
        const due = session.tick(now, intent);
        if (stepLog.length < 600) stepLog.push(due);

        // 2. Only then read positions: a read before the sends is a step stale.
        const views = session.shipViews();
        const selfId = session.sessionId;

        // Another captain arriving: a beacon at distance, once each. Only
        // for hulls carrying a callsign, which is what makes one a captain
        // rather than a patrol or a raider the room spawned.
        for (const view of views) {
          if (view.id === selfId || knownShips.has(view.id)) continue;
          knownShips.add(view.id);
          if (skyKnown && view.callsign !== '' && !view.hostile && !view.patrol) {
            playNotice('contact');
          }
        }
        skyKnown = true;

        frames.length = 0;
        contacts.length = 0;
        contacts.push({ x: 0, y: 0, kind: 'star', isSelf: false });
        for (const port of system.ports) {
          contacts.push({ x: port.x, y: port.y, kind: 'port', isSelf: false });
        }

        let self: ShipFrame | undefined;
        for (const view of views) {
          const isSelf = view.id === selfId;
          // Before anything asks what this hull is. A built hull's grid rides
          // on its own state, and the readouts below all resolve by id.
          blueprints.learn(view.blueprint, view.hull, view.callsign);
          const capacity = shieldCapacityOf(view.blueprint);
          const shipFrame: ShipFrame = {
            id: view.id,
            blueprint: view.blueprint,
            hull: view.hull,
            callsign: view.callsign,
            x: view.x,
            y: view.y,
            angle: view.angle,
            vx: view.vx,
            vy: view.vy,
            throttle: isSelf ? session.currentThrottle : remoteThrottle(view.vx, view.vy),
            isSelf,
            moduleHp: view.moduleHp,
            shieldFraction: capacity > 0 ? view.shield / capacity : 0,
            hostile: view.hostile,
            patrol: view.patrol,
            posted: view.posted,
            isTarget: view.isTarget,
            writtenOff: view.writtenOff,
          };
          frames.push(shipFrame);
          contacts.push({
            x: view.x,
            y: view.y,
            kind: 'ship',
            isSelf,
            convoy: !isSelf && convoyRef.current.has(view.callsign),
          });
          if (isSelf) self = shipFrame;
        }

        // Travel is asked for in edges: the chart, and being taken alongside.
        if (asked(keyboard!.takeChartRequest(), pad.takeChartRequest())) {
          liveRef.current.onOpenChart();
        }

        // The nearest berth within reach, which is what L lands at.
        let nearestBerth: { id: string; name: string; distance: number } | undefined;
        if (self) {
          for (const port of system.ports) {
            const distance = Math.hypot(port.x - self.x, port.y - self.y) - port.radius;
            if (!nearestBerth || distance < nearestBerth.distance) {
              nearestBerth = { id: port.id, name: port.name, distance };
            }
          }
        }
        if (asked(keyboard!.takeLandRequest(), pad.takeLandRequest()) && nearestBerth) {
          liveRef.current.onLand(nearestBerth.id);
        }

        // The nearest hull alongside that cannot run, which is what B
        // boards. Closing speed rather than either hull's own: matching
        // speeds is the manoeuvre, and two hulls holding station together
        // at three hundred a second are stationary with respect to each
        // other, which is the only frame a party can cross in.
        let nearestPrize:
          | { id: string; name: string; distance: number; closing: number }
          | undefined;
        if (self) {
          for (const view of views) {
            if (view.id === selfId || !view.adrift || view.writtenOff) continue;
            const distance = Math.hypot(view.x - self.x, view.y - self.y);
            if (distance > BOARDING_RANGE) continue;
            if (!nearestPrize || distance < nearestPrize.distance) {
              nearestPrize = {
                id: view.id,
                name: view.callsign,
                distance,
                closing: Math.hypot(view.vx - self.vx, view.vy - self.vy),
              };
            }
          }
        }

        // B puts a party aboard whatever is drifting alongside. The server
        // checks all of it again; this is only which hull was meant.
        if (asked(keyboard!.takeBoardRequest(), pad.takeBoardRequest()) && nearestPrize) {
          session.board(nearestPrize.id);
        }

        // J means three things, in the order the captain would expect: stop
        // spooling, spool for the plotted course, or open the chart to plot one.
        if (asked(keyboard!.takeJumpRequest(), pad.takeJumpRequest())) {
          const own = room.state.ships.get(selfId);
          if (own && own.jumpTo !== '') liveRef.current.onCancelJump();
          else if (!liveRef.current.onJump()) liveRef.current.onOpenChart();
        }

        // Cycling the mark is an edge, and the server decides whether it took.
        const cycles = keyboard!.takeCycleRequests() + pad.takeCycleRequests();
        if (cycles > 0) {
          const options = session.targetableIds();
          if (options.length > 0) {
            const current = options.indexOf(session.currentTarget);
            const next = options[(current + cycles) % options.length]!;
            session.selectTarget(next);
          }
        }

        // A round appearing is a shot fired: the sound follows the state
        // rather than the input, so remote weapons sound like the player's.
        const roundViews = session.projectileViews();
        let firedThisFrame = 0;
        if (combat && self) {
          combat.setListener(self.x, self.y);
        }
        for (const round of roundViews) {
          if (knownRounds.has(round.id)) continue;
          knownRounds.add(round.id);
          if (round.isMine) firedThisFrame++;
          combat?.play(
            round.kind === 2 ? 'missile' : round.kind === 1 ? 'turret' : 'gun',
            round.x,
            round.y,
          );
        }
        // Forget rounds that are gone, so the set does not grow without bound.
        if (knownRounds.size > 512) {
          const live = new Set(roundViews.map((r) => r.id));
          for (const id of knownRounds) if (!live.has(id)) knownRounds.delete(id);
        }

        // Firing kicks the hull back: a restrained recoil, so a volley reads
        // as weight rather than a silent stream of rounds.
        if (firedThisFrame > 0 && scene) scene.camera.impact(Math.min(0.18, firedThisFrame * 0.09));

        const rounds: ProjectileFrame[] = roundViews.map((round) => ({
          id: round.id,
          x: round.x,
          y: round.y,
          angle: round.angle,
          kind: round.kind,
          isMine: round.isMine,
        }));

        // A new mark gets a quiet two-tone acknowledgement.
        const mark = session.currentTarget;
        if (mark !== lastMark) {
          lastMark = mark;
          if (mark && self) combat?.play('lock', self.x, self.y);
        }

        const canisterViews = session.canisterViews();
        const canisters: CanisterFrame[] = canisterViews.map((canister) => ({
          id: canister.id,
          x: canister.x,
          y: canister.y,
          inReach: canister.distance <= SCOOP_REACH,
        }));

        // Scoop anything within reach. The server checks the range again.
        for (const canister of canisterViews) {
          if (canister.distance <= SCOOP_REACH) session.scoop(canister.id);
        }

        // Beams are state rather than events: an entry is on the wire for as
        // long as a trigger is down, so the scene is handed the live set and
        // works out appearing, holding and disappearing from it.
        const beams: BeamFrame[] = [];
        room.state.beams.forEach((beam, key) => {
          beams.push({
            id: key,
            owner: beam.owner,
            mount: beam.mount,
            angle: beam.angle,
            length: beam.length,
            hitting: beam.hitting,
          });
        });

        // The belt. Rocks never move, but what is left in one does, and the
        // scene works out which of them a beam is landing on for itself.
        const rocks: RockFrame[] = [];
        room.state.asteroids.forEach((rock, id) => {
          rocks.push({
            id,
            x: rock.x,
            y: rock.y,
            radius: rock.radius,
            left: rock.left,
            whole: rock.whole,
            seed: rock.seed,
          });
        });

        // A beam is a state, so its sound is a voice that is kept rather
        // than a sound that is played: held while the entry is on the wire,
        // let go when it leaves.
        if (combat) {
          const sounding = new Set<string>();
          for (const beam of beams) {
            sounding.add(beam.id);
            const owner = frames.find((frame) => frame.id === beam.owner);
            if (!owner) continue;
            combat.holdBeam(beam.id, owner.x, owner.y, beam.hitting);
          }
          for (const key of heldBeams) {
            if (!sounding.has(key)) combat.releaseBeam(key);
          }
          heldBeams.clear();
          for (const key of sounding) heldBeams.add(key);
        }

        effects.update(dtMs);

        scene.resize(app.screen.width, app.screen.height);
        scene.update(
          frames,
          self,
          session.shipProfile.topSpeed,
          dtMs,
          rounds,
          canisters,
          beams,
          rocks,
        );

        engine?.setThrottle(session.currentThrottle);

        // 3. Instruments.
        if (self) {
          const predicted = session.predicted;
          const telemetry = session.telemetry;
          const readout = readoutRef.current;
          readout.speed = speedOf(predicted);
          // Under way, which is the first thing the clerk wants to see. A
          // hull drifting off a berth at walking pace does not count.
          if (readout.speed > 60) liveRef.current.onUnderWay?.();
          readout.heading = self.angle;
          readout.throttle = session.currentThrottle;
          readout.callsign = self.callsign;
          readout.draught = blueprints.get(self.blueprint)?.name ?? self.blueprint;
          readout.system = system.name;
          readout.contacts = Math.max(0, frames.length - 1);
          readout.rtt = telemetry.rtt;
          readout.linkOk = telemetry.status !== 'diverging';
          readout.shieldMax = shieldCapacityOf(self.blueprint);
          readout.integrity = integrityOf(self);
          readout.refusal = liveRef.current.notice ?? session.lastRefusal;
          readout.propellant = liveRef.current.purse.propellant;
          readout.propellantCapacity = liveRef.current.purse.propellantCapacity;
          readout.marks = liveRef.current.purse.marks;
          readout.composition = liveRef.current.purse.composition;
          // Still on the screen, coming apart. Everything the interface would
          // offer to do with it is refused from here on.
          readout.wreck = self.writtenOff;

          // The hull's own synchronised state. The spool, the approach and the
          // shield all come from here rather than from the predicted mirror:
          // the client does not simulate any of them, and shield in particular
          // is not one of the fields the reconciler carries, so reading it off
          // the prediction gave NaN.
          const own = room.state.ships.get(selfId);
          readout.shield = own?.shield ?? 0;
          const spoolingTo = own?.jumpTo ?? '';
          if (spoolingTo !== '' && lastSpoolTo === '') hull?.startSpool();
          else if (spoolingTo === '' && lastSpoolTo !== '') {
            // Released if the hull is on its way, cancelled if it is still
            // here: the server clears `jumpTo` either way, and only one of
            // the two is a whump.
            hull?.endSpool((own?.jumpProgress ?? 0) <= 0 && lastSpoolProgress > 0.9);
          }
          lastSpoolTo = spoolingTo;
          lastSpoolProgress = own?.jumpProgress ?? 0;
          readout.spoolingTo = spoolingTo;
          readout.course = liveRef.current.courseName ?? '';
          readout.spoolProgress = own?.jumpProgress ?? 0;
          readout.landingProgress = own?.landingProgress ?? 0;
          readout.berth =
            nearestBerth && nearestBerth.distance <= LANDING_RANGE
              ? {
                  name: nearestBerth.name,
                  distance: nearestBerth.distance,
                  // The server refuses a fast approach, so the prompt says so
                  // rather than offering a landing that will be turned down.
                  tooFast: Math.hypot(self.vx, self.vy) > LANDING_SPEED,
                }
              : undefined;

          if (nearestPrize && !sawPrize.current) {
            sawPrize.current = true;
            setPrizeAlongside(true);
          }

          readout.prize = nearestPrize
            ? {
                name: nearestPrize.name,
                // The server refuses a fast pass, so the prompt says so
                // rather than offering a boarding that will be turned down.
                tooFast: nearestPrize.closing > BOARDING_SPEED,
              }
            : undefined;

          // The combat layer. A state rather than an event: it crossfades
          // over two seconds, so saying so every frame is what it is for.
          // A hostile in the same sky is the whole test — a fight is being
          // in one, not having been shot yet.
          if (music) {
            let threat = false;
            for (const frame of frames) {
              if (frame.isSelf || !frame.hostile) continue;
              // The art direction's figure, not a guess.
              if (Math.hypot(frame.x - self.x, frame.y - self.y) < COMBAT_MUSIC_RANGE) {
                threat = true;
                break;
              }
            }
            music.setFighting(threat);
          }

          // The mark's own state, which the spec asks the interface to show.
          const marked = frames.find((f) => f.isTarget);
          if (marked) {
            readout.target = {
              callsign: marked.callsign,
              range: Math.hypot(marked.x - self.x, marked.y - self.y),
              shield: marked.shieldFraction,
              integrity: integrityOf(marked),
              hostile: marked.hostile,
              patrol: marked.patrol,
              posted: marked.posted,
            };
          } else {
            readout.target = undefined;
          }

          const radar = radarRef.current;
          if (radar) drawRadar(radar, self.x, self.y, self.angle, contacts, system);
        }

        frame = requestAnimationFrame(loop);
      };

      frame = requestAnimationFrame(loop);

      // Diagnostics, opt-in by URL so a production build still carries them
      // but nothing is exposed unless asked for.
      if (new URLSearchParams(window.location.search).has('debug')) {
        (window as unknown as { marqueDebug?: unknown }).marqueDebug = {
          telemetry: () => session?.telemetry,
          readout: () => ({ ...readoutRef.current }),
          steps: () => stepLog.slice(),
          ships: () =>
            frames.map((f) => ({ id: f.id, x: f.x, y: f.y, isSelf: f.isSelf })),
          combat: () => ({
            rounds: session!.projectileViews().length,
            canisters: session!.canisterViews().length,
            target: session!.currentTarget,
            shield: room.state.ships.get(session!.sessionId)?.shield ?? 0,
            fx: effects.activeCount,
          }),
          // Authoritative schema values beside the predicted mirror, plus the
          // profile each side derived, for diagnosing divergence.
          compare: () => {
            const authoritative = room.state.ships.get(session!.sessionId);
            const predicted = session!.predicted;
            return {
              profile: { ...session!.shipProfile },
              authoritative: authoritative
                ? {
                    x: authoritative.x, y: authoritative.y,
                    vx: authoritative.vx, vy: authoritative.vy,
                    angle: authoritative.angle, angVel: authoritative.angVel,
                    blueprint: authoritative.blueprint,
                  }
                : null,
              predicted: {
                x: predicted.x, y: predicted.y,
                vx: predicted.vx, vy: predicted.vy,
                angle: predicted.angle, angVel: predicted.angVel,
              },
            };
          },
        };
      }
    };

    void start().catch((error: unknown) => {
      if (disposed) return;
      setFailure(error instanceof Error ? error.message : String(error));
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      keyboard?.destroy();
      engine?.stop();
      // A held voice outlives the frame loop that was feeding it, so a view
      // that goes away while a beam is down would leave a hum behind.
      combat?.releaseAll();
      // The hull's sounds are the session's; only a running spool is this
      // view's, and it is let go rather than left rising.
      hull?.endSpool(false);
      // The music is the session's too, and the bed belongs to the region
      // rather than to the sky: it plays on while the captain is alongside,
      // and the next flight view hands it whatever region it arrived in.
      // Only the fight goes away with the view.
      music?.setFighting(false);
      // The mix is the session's, not this view's: closing it here would
      // silence every screen a captain walks to next.
      scene?.destroy();
      session?.destroy();
      app?.destroy(true, { children: true });
    };
  }, [room]);

  return (
    <div className="flight">
      <div ref={hostRef} className="flight__canvas" />
      {writtenOff && <WrittenOffPanel event={writtenOff} />}
      <Hint which="boarding" ready={prizeAlongside && writtenOff === undefined} />
      {failure === undefined ? (
        <Hud readout={readoutRef} radarRef={radarRef} />
      ) : (
        <div className="flight__failure panel">
          <h2>The flight view did not start</h2>
          <p>{failure}</p>
        </div>
      )}
    </div>
  );
}

/** How close the hull must be to scoop, matching the server's own check. */
const SCOOP_REACH = 85;

/**
 * How near a hostile has to be for the combat layer to come in.
 *
 * `docs/ART_DIRECTION.md`, section 6: within 2500 units.
 */
const COMBAT_MUSIC_RANGE = 2500;

/**
 * A remote hull's throttle is not synchronised, so it is inferred from motion.
 * It only drives the plume, and a plume that is slightly wrong is far better
 * than a field on the wire for every ship every tick.
 */
function remoteThrottle(vx: number, vy: number): number {
  const speed = Math.hypot(vx, vy);
  return speed > 8 ? Math.min(1, speed / 220) : 0;
}

interface WrittenOff {
  readonly system: string;
  readonly by: string;
  /** What the Hall settled, once it has said. */
  readonly settled?: ClaimState;
}

/**
 * Written off.
 *
 * Marks, draughts, shares and parked hulls survive it; this hull and its cargo
 * do not. The Hall settles half what the hull's fittings cost, part of the
 * cargo drops where the hull came apart, and the captain wakes at the last
 * berth they landed at.
 */
function WrittenOffPanel({ event }: { event: WrittenOff }): React.JSX.Element {
  const settled = event.settled;

  return (
    <div className="flight__written-off" role="status">
      <div className="flight__written-off-panel panel">
        <h2>Written off at {event.system}</h2>
        {settled ? (
          <p>
            {settled.claim > 0 ? (
              <>
                Underwriters&apos; Hall has settled your claim for{' '}
                <span className="data">{settled.claim.toLocaleString()}</span> marks and wishes
                you a more careful year.
              </>
            ) : (
              <>
                There was no cover on {settled.hull === '' ? 'that hull' : settled.hull}, and so
                there is nothing to settle.
              </>
            )}
            {event.by && <> The loss is recorded against {event.by}.</>}
          </p>
        ) : (
          <p>
            Underwriters&apos; Hall is reading the file.
            {event.by && <> The loss is recorded against {event.by}.</>}
          </p>
        )}
        {settled && (settled.lost > 0 || settled.spilled > 0) && (
          <p className="micro">
            <span className="data">{settled.lost.toLocaleString()}</span> units went with her
            {settled.spilled > 0 && (
              <>
                ; <span className="data">{settled.spilled.toLocaleString()}</span> are adrift in
                canisters for whoever gets there first
              </>
            )}
            .
          </p>
        )}
        <p className="micro">
          {settled && settled.stillOwned > 0
            ? 'You are being set down at the last berth you put in at.'
            : 'A starter hull is being brought up at the last berth you put in at.'}
        </p>
      </div>
    </div>
  );
}
