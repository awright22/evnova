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
  LANDING_RANGE,
  LANDING_SPEED,
  content,
  deriveStats,
  leadPoint,
  placeAll,
  speedOf,
  type SystemDef,
} from '@marque/shared';

import { AudioMix } from '../audio/mix.ts';
import { CombatAudio } from '../audio/combat.ts';
import { EngineSound } from '../audio/engine.ts';
import { Hud, type HudReadout } from '../hud/Hud.tsx';
import { drawRadar, type RadarContact } from '../hud/radar.ts';
import { Session } from '../net/session.ts';
import { KeyboardInput } from './input.ts';
import { palette } from './palette.ts';
import { Effects } from './effects.ts';
import { Scene, type CanisterFrame, type ProjectileFrame, type ShipFrame } from './scene.ts';
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
}: FlightViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const radarRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HudReadout>({
    speed: 0,
    heading: 0,
    throttle: 0,
    callsign: '',
    draught: '',
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
    spoolingTo: '',
    course: '',
    spoolProgress: 0,
    landingProgress: 0,
    berth: undefined,
  });

  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [writtenOff, setWrittenOff] = useState<WrittenOff | undefined>(undefined);

  // The frame loop is started once; these keep it reading current values
  // rather than the ones captured when it started.
  const liveRef = useRef({
    purse,
    notice,
    course,
    courseName,
    onLand,
    onOpenChart,
    onJump,
    onCancelJump,
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
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let app: Application | undefined;
    let scene: Scene | undefined;
    let session: Session | undefined;
    let keyboard: KeyboardInput | undefined;
    let mix: AudioMix | undefined;
    let engine: EngineSound | undefined;
    let combat: CombatAudio | undefined;
    let frame = 0;

    const start = async (): Promise<void> => {
      session = await Session.attach(room);
      if (disposed) return;

      const { systems, blueprints, modules, tuning } = content();
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

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scene = new Scene(app.renderer, system, blueprints, modules, reducedMotion);
      scene.resize(app.screen.width, app.screen.height);
      app.stage.addChild(scene.root);

      keyboard = new KeyboardInput();

      // Browsers refuse to start audio without a gesture, so the mix is built
      // on the first key press and torn down with the view.
      const startAudio = (): void => {
        if (mix || disposed) return;
        mix = new AudioMix();
        void mix.unlock().then(() => {
          if (disposed || !mix) return;
          engine = new EngineSound(mix);
          combat = new CombatAudio(mix);
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
      let lastMark = '';
      let lastNow = performance.now();

      // Effects live in world space, under the same camera transform as hulls.
      const effects = new Effects(`fx:${session.sessionId}`);
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
          disabled: boolean;
        };
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
          // Death has a designed state, not a blank screen. Underwriters' Hall
          // settles half the hull's cost, which is computable from the draught.
          const bp = blueprints.get(event.blueprint);
          const cost = bp
            ? bp.placements.reduce(
                (sum, placement) => sum + (modules.get(placement.moduleId)?.cost ?? 0),
                0,
              )
            : 0;
          const killer = session!.shipViews().find((v) => v.id === event.killedBy);
          setWrittenOff({
            system: system.name,
            claim: Math.round(cost / 2),
            by: killer?.callsign ?? '',
          });
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
        const due = session.tick(now, keyboard!.sample());
        if (stepLog.length < 600) stepLog.push(due);

        // 2. Only then read positions: a read before the sends is a step stale.
        const views = session.shipViews();
        const selfId = session.sessionId;

        frames.length = 0;
        contacts.length = 0;
        contacts.push({ x: 0, y: 0, kind: 'star', isSelf: false });
        for (const port of system.ports) {
          contacts.push({ x: port.x, y: port.y, kind: 'port', isSelf: false });
        }

        let self: ShipFrame | undefined;
        for (const view of views) {
          const isSelf = view.id === selfId;
          const capacity = shieldCapacityOf(view.blueprint);
          const shipFrame: ShipFrame = {
            id: view.id,
            blueprint: view.blueprint,
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
          contacts.push({ x: view.x, y: view.y, kind: 'ship', isSelf });
          if (isSelf) self = shipFrame;
        }

        // Travel is asked for in edges: the chart, and being taken alongside.
        if (keyboard!.takeChartRequest()) liveRef.current.onOpenChart();

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
        if (keyboard!.takeLandRequest() && nearestBerth) {
          liveRef.current.onLand(nearestBerth.id);
        }

        // J means three things, in the order the captain would expect: stop
        // spooling, spool for the plotted course, or open the chart to plot one.
        if (keyboard!.takeJumpRequest()) {
          const own = room.state.ships.get(selfId);
          if (own && own.jumpTo !== '') liveRef.current.onCancelJump();
          else if (!liveRef.current.onJump()) liveRef.current.onOpenChart();
        }

        // Cycling the mark is an edge, and the server decides whether it took.
        const cycles = keyboard!.takeCycleRequests();
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

        effects.update(dtMs);

        scene.resize(app.screen.width, app.screen.height);
        scene.update(frames, self, session.shipProfile.topSpeed, dtMs, rounds, canisters);

        engine?.setThrottle(session.currentThrottle);

        // 3. Instruments.
        if (self) {
          const predicted = session.predicted;
          const telemetry = session.telemetry;
          const readout = readoutRef.current;
          readout.speed = speedOf(predicted);
          readout.heading = self.angle;
          readout.throttle = session.currentThrottle;
          readout.callsign = self.callsign;
          readout.draught = blueprints.get(self.blueprint)?.name ?? self.blueprint;
          readout.system = system.name;
          readout.contacts = Math.max(0, frames.length - 1);
          readout.rtt = telemetry.rtt;
          readout.linkOk = telemetry.status !== 'diverging';
          readout.shield = predicted.shield;
          readout.shieldMax = shieldCapacityOf(self.blueprint);
          readout.integrity = integrityOf(self);
          readout.refusal = liveRef.current.notice ?? session.lastRefusal;
          readout.propellant = liveRef.current.purse.propellant;
          readout.propellantCapacity = liveRef.current.purse.propellantCapacity;
          readout.marks = liveRef.current.purse.marks;
          readout.composition = liveRef.current.purse.composition;

          // The spool and the berth in reach are both read off the hull's own
          // synchronised state, so they cannot disagree with the server.
          const own = room.state.ships.get(selfId);
          readout.spoolingTo = own?.jumpTo ?? '';
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
            shield: session!.predicted.shield,
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
      void mix?.close();
      scene?.destroy();
      session?.destroy();
      app?.destroy(true, { children: true });
    };
  }, [room]);

  return (
    <div className="flight">
      <div ref={hostRef} className="flight__canvas" />
      {writtenOff && <WrittenOffPanel event={writtenOff} />}
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
  readonly claim: number;
  readonly by: string;
}

/**
 * Written off.
 *
 * Marks, draughts, shares and parked hulls survive it; this hull and its cargo
 * do not. The Hall settles half the hull's cost and the captain wakes at the
 * last port they landed at, which for now means a fresh starter in place.
 */
function WrittenOffPanel({ event }: { event: WrittenOff }): React.JSX.Element {
  return (
    <div className="flight__written-off" role="status">
      <div className="flight__written-off-panel panel">
        <h2>Written off at {event.system}</h2>
        <p>
          Underwriters&apos; Hall has settled your claim for{' '}
          <span className="data">{event.claim.toLocaleString()}</span> marks and wishes you a
          more careful year.
          {event.by && <> The loss is recorded against {event.by}.</>}
        </p>
        <p className="micro">A replacement hull is being brought up.</p>
      </div>
    </div>
  );
}
