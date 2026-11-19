import { describe, expect, it } from 'vitest';

import { Rng } from '../math/rng.ts';
import { shortestArc, wrapAngle } from '../math/scalar.ts';
import {
  copyFlightBody,
  createFlightBody,
  speedOf,
  stepFlight,
  type FlightBody,
  type FlightCommand,
} from './flight.ts';
import { SPIKE_PROFILE } from './profile.ts';
import { stepTiming } from './timing.ts';

const timing = stepTiming();
const profile = SPIKE_PROFILE;

const coast: FlightCommand = { turn: 0, thrust: 0, brake: false };
const burn: FlightCommand = { turn: 0, thrust: 1, brake: false };
const brake: FlightCommand = { turn: 0, thrust: 0, brake: true };

function run(body: FlightBody, cmds: readonly FlightCommand[]): FlightBody {
  for (const cmd of cmds) stepFlight(body, cmd, profile, timing);
  return body;
}

function snapshot(body: FlightBody): string {
  return JSON.stringify(body);
}

describe('stepFlight determinism', () => {
  it('produces identical state for an identical input sequence', () => {
    // The check the Colyseus netcode contract prescribes: the same input
    // sequence from the same start state must give bit-identical output, or
    // client prediction will rubber-band.
    const rng = new Rng('flight-determinism');
    const cmds: FlightCommand[] = Array.from({ length: 400 }, () => ({
      turn: rng.int(-1, 1),
      thrust: rng.bool(0.6) ? 1 : 0,
      brake: rng.bool(0.1),
    }));

    const a = run(createFlightBody(10, -4, 0.3), cmds);
    const b = run(createFlightBody(10, -4, 0.3), cmds);

    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('replaying a step from a copied body matches running it once', () => {
    // Rollback replays steps from an adopted state. A step must not depend on
    // anything outside the body, the command and the profile.
    const live = createFlightBody(0, 0, 0);
    run(live, Array.from({ length: 20 }, () => burn));

    const adopted = createFlightBody();
    copyFlightBody(live, adopted);

    stepFlight(live, burn, profile, timing);
    stepFlight(adopted, burn, profile, timing);

    expect(snapshot(adopted)).toBe(snapshot(live));
  });
});

describe('inertial flight', () => {
  it('keeps velocity while coasting: there is no drag', () => {
    const body = createFlightBody(0, 0, 0);
    run(body, Array.from({ length: 10 }, () => burn));
    const moving = speedOf(body);
    expect(moving).toBeGreaterThan(10);

    run(body, Array.from({ length: 300 }, () => coast));
    expect(speedOf(body)).toBeCloseTo(moving, 6);
  });

  it('carries momentum sideways when the ship turns while coasting', () => {
    const body = createFlightBody(0, 0, 0);
    run(body, Array.from({ length: 30 }, () => burn));
    const vx = body.vx;

    // Turn hard without thrusting: velocity must not follow the nose.
    run(body, Array.from({ length: 30 }, () => ({ turn: 1, thrust: 0, brake: false })));
    expect(body.vx).toBeCloseTo(vx, 6);
    expect(body.angle).not.toBeCloseTo(0, 2);
  });
});

describe('thrust taper', () => {
  it('approaches top speed without a hard clamp and never exceeds it under thrust', () => {
    const body = createFlightBody(0, 0, 0);
    run(body, Array.from({ length: 2000 }, () => burn));
    const speed = speedOf(body);
    // Asymptotic: close to top speed but strictly under it.
    expect(speed).toBeLessThan(profile.topSpeed);
    expect(speed).toBeGreaterThan(profile.topSpeed * 0.97);
  });

  it('gives full thrust authority when burning against momentum', () => {
    // Travelling +x at top speed, facing -x: the taper must not apply.
    const body: FlightBody = {
      x: 0,
      y: 0,
      vx: profile.topSpeed,
      vy: 0,
      angle: Math.PI,
      angVel: 0,
    };
    const before = body.vx;
    stepFlight(body, burn, profile, timing);
    const delta = before - body.vx;
    // One full step of unimpeded deceleration.
    expect(delta).toBeCloseTo(profile.thrustAccel * timing.dt, 3);
  });

  it('decelerates a ship that is somehow above top speed', () => {
    const body: FlightBody = {
      x: 0,
      y: 0,
      vx: profile.topSpeed * 1.5,
      vy: 0,
      angle: 0,
      angVel: 0,
    };
    const before = speedOf(body);
    run(body, Array.from({ length: 10 }, () => burn));
    // Taper clamps to zero rather than going negative and shoving it faster.
    expect(speedOf(body)).toBeCloseTo(before, 6);
  });
});

describe('turning', () => {
  it('never exceeds the profile turn rate', () => {
    const body = createFlightBody();
    for (let i = 0; i < 200; i++) {
      stepFlight(body, { turn: 1, thrust: 0, brake: false }, profile, timing);
      expect(Math.abs(body.angVel)).toBeLessThanOrEqual(profile.maxTurnRate + 1e-9);
    }
  });

  it('settles to a stop when the pilot releases the turn', () => {
    const body = createFlightBody();
    run(body, Array.from({ length: 40 }, () => ({ turn: -1, thrust: 0, brake: false })));
    expect(Math.abs(body.angVel)).toBeGreaterThan(0.5);

    run(body, Array.from({ length: 120 }, () => coast));
    expect(body.angVel).toBe(0);
  });

  it('keeps the facing angle wrapped', () => {
    const body = createFlightBody();
    run(body, Array.from({ length: 600 }, () => ({ turn: 1, thrust: 0, brake: false })));
    expect(body.angle).toBeGreaterThanOrEqual(-Math.PI);
    expect(body.angle).toBeLessThan(Math.PI);
  });
});

describe('brake', () => {
  it('brings a moving ship to a full stop from any heading', () => {
    const rng = new Rng('brake');
    for (let trial = 0; trial < 8; trial++) {
      const body = createFlightBody(0, 0, rng.range(-Math.PI, Math.PI));
      body.vx = rng.range(-300, 300);
      body.vy = rng.range(-300, 300);

      run(body, Array.from({ length: 600 }, () => brake));
      expect(speedOf(body)).toBe(0);
    }
  });

  it('turns the ship toward retrograde before burning', () => {
    const body = createFlightBody(0, 0, 0);
    body.vx = 200;
    body.vy = 0;
    // Retrograde is PI. One step should start rotating that way, not thrust.
    stepFlight(body, brake, profile, timing);
    expect(Math.abs(body.angVel)).toBeGreaterThan(0);
    expect(body.vx).toBeCloseTo(200, 6);
  });
});

describe('sub-stepping', () => {
  it('stays close between 1 and 4 sub-steps, so integration is stable', () => {
    const cmds = Array.from({ length: 90 }, (_, i) => ({
      turn: i % 3 === 0 ? 1 : 0,
      thrust: 1,
      brake: false,
    }));

    const coarse = createFlightBody();
    const fine = createFlightBody();
    for (const cmd of cmds) {
      stepFlight(coarse, cmd, profile, stepTiming(30, 1));
      stepFlight(fine, cmd, profile, stepTiming(30, 4));
    }

    // Not identical, but the trajectories must not diverge meaningfully.
    const drift = Math.hypot(coarse.x - fine.x, coarse.y - fine.y);
    const travelled = Math.hypot(fine.x, fine.y);
    expect(drift / travelled).toBeLessThan(0.05);
  });
});

describe('angle helpers', () => {
  it('wraps into [-PI, PI)', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 10);
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 10);
    expect(wrapAngle(Math.PI * 2.5)).toBeCloseTo(Math.PI * 0.5, 10);
  });

  it('takes the shortest arc across the seam', () => {
    expect(shortestArc(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2, 10);
    expect(shortestArc(-Math.PI + 0.1, Math.PI - 0.1)).toBeCloseTo(-0.2, 10);
  });
});
