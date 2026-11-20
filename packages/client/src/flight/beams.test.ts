import { describe, expect, it } from 'vitest';

import type { Mount, Pose } from '@marque/shared';

import {
  approachLevel,
  beamRipple,
  beamSegment,
  easeEmphasis,
  easeExit,
  interceptAlpha,
  interceptScale,
  motion,
  parseDuration,
} from './beams.ts';

/**
 * Only the muzzle offsets are read, so the module definition a real mount
 * carries is not built here.
 */
function mountAt(offsetX: number, offsetY: number): Mount {
  return { offsetX, offsetY } as unknown as Mount;
}

const AT_REST: Pose = { x: 0, y: 0, angle: 0 };

describe('beamSegment', () => {
  it('starts at the mount and runs along the angle for the length', () => {
    const seg = beamSegment(mountAt(10, 0), AT_REST, 0, 100);
    expect(seg.muzzleX).toBeCloseTo(10);
    expect(seg.muzzleY).toBeCloseTo(0);
    expect(seg.tipX).toBeCloseTo(110);
    expect(seg.tipY).toBeCloseTo(0);
  });

  it('carries the mount offset around with the hull as it turns', () => {
    // A quarter turn puts a mount that was 10 ahead and 4 to starboard at
    // 10 below and 4 ahead of the hull, in screen axes.
    const seg = beamSegment(mountAt(10, 4), { x: 0, y: 0, angle: Math.PI / 2 }, Math.PI / 2, 50);
    expect(seg.muzzleX).toBeCloseTo(-4);
    expect(seg.muzzleY).toBeCloseTo(10);
    expect(seg.tipX).toBeCloseTo(-4);
    expect(seg.tipY).toBeCloseTo(60);
  });

  it('offsets the whole segment by the hull position', () => {
    const seg = beamSegment(mountAt(6, 0), { x: 200, y: -50, angle: 0 }, 0, 10);
    expect(seg.muzzleX).toBeCloseTo(206);
    expect(seg.muzzleY).toBeCloseTo(-50);
    expect(seg.tipX).toBeCloseTo(216);
  });

  it('puts the tip on the muzzle when the beam has no reach', () => {
    const seg = beamSegment(mountAt(6, 2), AT_REST, 1.2, 0);
    expect(seg.tipX).toBeCloseTo(seg.muzzleX);
    expect(seg.tipY).toBeCloseTo(seg.muzzleY);
  });

  it('aims where the server says, not where the hull points', () => {
    // A traversing mount's beam leaves along its own bearing.
    const seg = beamSegment(mountAt(0, 0), AT_REST, Math.PI, 20);
    expect(seg.tipX).toBeCloseTo(-20);
    expect(seg.tipY).toBeCloseTo(0);
  });
});

describe('approachLevel', () => {
  it('arrives exactly at the end of the duration', () => {
    expect(approachLevel(0, 1, 80, 80)).toBeCloseTo(1);
  });

  it('covers half the distance in half the duration', () => {
    expect(approachLevel(0, 1, 40, 80)).toBeCloseTo(0.5);
  });

  it('does not overshoot a long frame', () => {
    expect(approachLevel(0, 1, 500, 80)).toBe(1);
    expect(approachLevel(1, 0, 500, 120)).toBe(0);
  });

  it('runs at the same rate whatever the frame rate', () => {
    const oneStep = approachLevel(0, 1, 16, 80);
    const twoSteps = approachLevel(approachLevel(0, 1, 8, 80), 1, 8, 80);
    expect(twoSteps).toBeCloseTo(oneStep);
  });

  it('falls as well as rises', () => {
    expect(approachLevel(1, 0, 60, 120)).toBeCloseTo(0.5);
  });

  it('snaps when there is no duration to spend', () => {
    expect(approachLevel(0, 1, 16, 0)).toBe(1);
  });
});

describe('the easing shapes', () => {
  it('both run from nothing to everything', () => {
    expect(easeEmphasis(0)).toBeCloseTo(0);
    expect(easeEmphasis(1)).toBeCloseTo(1);
    expect(easeExit(0)).toBeCloseTo(0);
    expect(easeExit(1)).toBeCloseTo(1);
  });

  it('brings a beam up front-loaded and takes it down back-loaded', () => {
    expect(easeEmphasis(0.3)).toBeGreaterThan(0.3);
    expect(easeExit(0.3)).toBeLessThan(0.3);
  });

  it('is monotonic', () => {
    for (let step = 0; step < 10; step++) {
      const t = step / 10;
      expect(easeEmphasis(t + 0.1)).toBeGreaterThan(easeEmphasis(t));
      expect(easeExit(t + 0.1)).toBeGreaterThan(easeExit(t));
    }
  });

  it('clamps outside its range, so a level never draws past full', () => {
    expect(easeEmphasis(1.4)).toBe(1);
    expect(easeExit(-0.2)).toBe(0);
  });
});

describe('beamRipple', () => {
  it('stays close to even, so the beam is textured rather than lumpy', () => {
    for (let t = 0; t <= 1; t += 0.05) {
      const width = beamRipple(t, 1234);
      expect(width).toBeGreaterThan(0.9);
      expect(width).toBeLessThan(1.1);
    }
  });

  it('varies along the beam', () => {
    const samples = new Set<number>();
    for (let t = 0; t <= 1; t += 0.1) samples.add(Math.round(beamRipple(t, 0) * 1000));
    expect(samples.size).toBeGreaterThan(5);
  });

  it('travels with time', () => {
    expect(beamRipple(0.5, 0)).not.toBeCloseTo(beamRipple(0.5, 40));
  });

  it('holds still when time is held, which is what reduced motion passes', () => {
    expect(beamRipple(0.5, 0)).toBeCloseTo(beamRipple(0.5, 0));
    // And still has shape left in it, rather than collapsing to an even line.
    expect(beamRipple(0.2, 0)).not.toBeCloseTo(beamRipple(0.8, 0));
  });

  it('separates two beams on one hull', () => {
    expect(beamRipple(0.5, 100, 0)).not.toBeCloseTo(beamRipple(0.5, 100, 1.7));
  });
});

describe('the intercept flash', () => {
  it('is full at the shot and gone at the end', () => {
    expect(interceptAlpha(0)).toBe(1);
    expect(interceptAlpha(1)).toBe(0);
  });

  it('is mostly gone early, so it does not read as damage', () => {
    expect(interceptAlpha(0.3)).toBeLessThan(0.5);
  });

  it('only ever fades', () => {
    for (let step = 0; step < 10; step++) {
      const t = step / 10;
      expect(interceptAlpha(t + 0.1)).toBeLessThan(interceptAlpha(t));
    }
  });

  it('grows while it fades', () => {
    expect(interceptScale(1)).toBeGreaterThan(interceptScale(0));
  });

  it('holds its size under reduced motion', () => {
    expect(interceptScale(0, true)).toBe(1);
    expect(interceptScale(1, true)).toBe(1);
  });
});

describe('the motion tokens', () => {
  it('reads both units a duration is written in', () => {
    expect(parseDuration('80ms')).toBe(80);
    expect(parseDuration('0.08s')).toBeCloseTo(80);
    expect(parseDuration(' 120ms ')).toBe(120);
  });

  it('refuses anything that is not a duration', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('auto')).toBeUndefined();
    expect(parseDuration('80')).toBeUndefined();
  });

  it('falls back to the token values with no document to read', () => {
    // Headless, as the tests and the screenshot harness run.
    expect(motion()).toEqual({ instant: 80, quick: 120, base: 160, slow: 200 });
  });
});
