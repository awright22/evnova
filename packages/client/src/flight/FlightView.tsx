/**
 * The flight view.
 *
 * Mounts the Pixi renderer, owns the frame loop, and bridges it to the HUD.
 * The loop's order is the netcode contract: tick the predictor, send exactly
 * the inputs it asked for, then read positions and draw.
 */

import { Application } from 'pixi.js';
import { useEffect, useRef, useState } from 'react';
import { content, speedOf, type SystemDef } from '@marque/shared';

import { AudioMix } from '../audio/mix.ts';
import { EngineSound } from '../audio/engine.ts';
import { Hud, type HudReadout } from '../hud/Hud.tsx';
import { drawRadar, type RadarContact } from '../hud/radar.ts';
import { Session } from '../net/session.ts';
import { KeyboardInput } from './input.ts';
import { palette } from './palette.ts';
import { Scene, type ShipFrame } from './scene.ts';
import './flight.css';

export function FlightView({ room }: { room: Parameters<typeof Session.attach>[0] }): React.JSX.Element {
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
  });

  const [failure, setFailure] = useState<string | undefined>(undefined);

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
    let frame = 0;

    const start = async (): Promise<void> => {
      session = await Session.attach(room);
      if (disposed) return;

      const { systems, blueprints, modules } = content();
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
        });
      };
      window.addEventListener('keydown', startAudio, { once: true });
      window.addEventListener('pointerdown', startAudio, { once: true });

      const self0 = session.predicted;
      scene.camera.jumpTo(self0.x, self0.y);

      const frames: ShipFrame[] = [];
      const contacts: RadarContact[] = [];
      const stepLog: number[] = [];
      let lastNow = performance.now();

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
          };
          frames.push(shipFrame);
          contacts.push({ x: view.x, y: view.y, kind: 'ship', isSelf });
          if (isSelf) self = shipFrame;
        }

        scene.resize(app.screen.width, app.screen.height);
        scene.update(frames, self, session.shipProfile.topSpeed, dtMs);

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

/**
 * A remote hull's throttle is not synchronised, so it is inferred from motion.
 * It only drives the plume, and a plume that is slightly wrong is far better
 * than a field on the wire for every ship every tick.
 */
function remoteThrottle(vx: number, vy: number): number {
  const speed = Math.hypot(vx, vy);
  return speed > 8 ? Math.min(1, speed / 220) : 0;
}
