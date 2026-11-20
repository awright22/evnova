/**
 * Seals.
 *
 * Spec section 4 and the art direction: every company and institution has a
 * seal, procedurally drawn, geometric and heraldic, struck rather than
 * illustrated. One construction system, so they read as a set — a circular
 * rim, an inner device on a six-point radial grid, and a letter-less centre.
 *
 * The design is derived from a seed on the issuer's id, so the same
 * institution always strikes the same mark: a captain learns a seal the way
 * they learn a flag, and a seal that changed between sessions would be no
 * use at all.
 *
 * This is geometry, not drawing. It lives in shared because the same marks
 * go on documents, on port chrome and on hulls, and those are drawn by
 * different renderers that must agree to the point.
 */

import { Rng } from '../math/rng.ts';

/** The shapes a seal's inner device can be made of. */
export type Device = 'lozenge' | 'chevron' | 'bar' | 'ring';

export const DEVICES: readonly Device[] = ['lozenge', 'chevron', 'bar', 'ring'];

/** The six-point radial grid every device is struck on. */
export const POINTS = 6;

export interface SealDesign {
  /** Which shape the device is made of. */
  readonly device: Device;
  /** How many times it repeats around the grid: 1, 2, 3 or 6. */
  readonly repeats: number;
  /** Where the first repeat sits, as a step on the six-point grid. */
  readonly turn: number;
  /** How far out the device reaches, as a fraction of the rim's radius. */
  readonly reach: number;
  /** An inner ring at this fraction of the radius, or 0 for none. */
  readonly innerRing: number;
  /** Which of the six grid points carry a tick on the rim. */
  readonly ticks: readonly number[];
}

/**
 * The design an issuer always strikes.
 *
 * Deterministic in the id and nothing else: no clock, no counter, no
 * randomness the caller holds.
 */
export function sealOf(issuerId: string): SealDesign {
  const rng = new Rng(`seal:${issuerId}`);

  const device = DEVICES[rng.nextUint32() % DEVICES.length]!;
  // Two, three or six: divisors of the grid, so a device closes on itself.
  // Never one — a single shape off the centre reads as an accident rather
  // than as a mark somebody cut a die for.
  const repeats = [2, 3, 6][rng.nextUint32() % 3]!;
  const turn = rng.nextUint32() % POINTS;
  // Most of the way to the rim. A device drawn small sits in the middle of
  // a lot of nothing and reads as a dot; this is a struck mark, and a struck
  // mark fills its field.
  const reach = 0.52 + (rng.nextUint32() % 22) / 100;
  const innerRing = rng.nextUint32() % 2 === 0 ? 0.3 + (rng.nextUint32() % 10) / 100 : 0;

  const ticks: number[] = [];
  for (let point = 0; point < POINTS; point++) {
    if (rng.nextUint32() % 3 === 0) ticks.push(point);
  }

  return { device, repeats, turn, reach, innerRing, ticks };
}

/** A straight run of points, to be drawn as a polyline or a polygon. */
export interface SealPath {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** True when the last point joins the first. */
  readonly closed: boolean;
}

/** Everything in a struck seal, in units of the rim's radius. */
export interface SealGeometry {
  /** The device, repeated around the grid. */
  readonly paths: readonly SealPath[];
  /** Rings inside the rim, as radius fractions. */
  readonly rings: readonly number[];
  /** Ticks on the rim: a short radial line at each, from `from` to `to`. */
  readonly ticks: readonly { readonly angle: number; readonly from: number; readonly to: number }[];
}

/** Where a point on the six-point grid sits, in radians. */
function angleOf(step: number): number {
  // Twelve o'clock first, because a seal is read the way a clock is.
  return (step / POINTS) * Math.PI * 2 - Math.PI / 2;
}

function at(angle: number, radius: number): { x: number; y: number } {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Strike the design: every line in it, in units of the rim's radius.
 *
 * The caller scales. Keeping it unitless is what lets one seal go on a
 * document at forty pixels and on a hull at six without being drawn twice.
 */
export function sealGeometry(design: SealDesign): SealGeometry {
  const paths: SealPath[] = [];
  const step = POINTS / design.repeats;

  for (let i = 0; i < design.repeats; i++) {
    const angle = angleOf(design.turn + i * step);
    paths.push(strike(design.device, angle, design.reach));
  }

  const rings = design.innerRing > 0 ? [design.innerRing] : [];
  const ticks = design.ticks.map((point) => ({
    angle: angleOf(point),
    from: 0.84,
    to: 0.95,
  }));

  return { paths, rings, ticks };
}

/** One repeat of a device, pointed along `angle` and reaching `reach`. */
function strike(device: Device, angle: number, reach: number): SealPath {
  const across = angle + Math.PI / 2;

  switch (device) {
    case 'lozenge': {
      // A diamond standing on the grid point, half as wide as it is long.
      const tip = at(angle, reach);
      const base = at(angle, reach * 0.16);
      const half = reach * 0.26;
      const left = {
        x: (tip.x + base.x) / 2 + Math.cos(across) * half,
        y: (tip.y + base.y) / 2 + Math.sin(across) * half,
      };
      const right = {
        x: (tip.x + base.x) / 2 - Math.cos(across) * half,
        y: (tip.y + base.y) / 2 - Math.sin(across) * half,
      };
      return { points: [tip, left, base, right], closed: true };
    }

    case 'chevron': {
      // A broad arrowhead, open at the back: two arms meeting at the point.
      const tip = at(angle, reach);
      const span = reach * 0.46;
      const back = reach * 0.42;
      const arm = (sign: number): { x: number; y: number } => ({
        x: Math.cos(angle) * back + Math.cos(across) * span * sign,
        y: Math.sin(angle) * back + Math.sin(across) * span * sign,
      });
      return { points: [arm(1), tip, arm(-1)], closed: false };
    }

    case 'bar': {
      // A radial bar with square ends, struck from the middle outward.
      const inner = at(angle, reach * 0.22);
      const outer = at(angle, reach);
      const half = reach * 0.11;
      const offset = (point: { x: number; y: number }, sign: number) => ({
        x: point.x + Math.cos(across) * half * sign,
        y: point.y + Math.sin(across) * half * sign,
      });
      return {
        points: [offset(inner, 1), offset(outer, 1), offset(outer, -1), offset(inner, -1)],
        closed: true,
      };
    }

    case 'ring': {
      // A small circle out on the grid point, drawn as a closed polygon so
      // every device in the system is the same kind of thing to draw.
      const centre = at(angle, reach * 0.68);
      const radius = reach * 0.3;
      const points = [];
      for (let i = 0; i < 12; i++) {
        const around = (i / 12) * Math.PI * 2;
        points.push({
          x: centre.x + Math.cos(around) * radius,
          y: centre.y + Math.sin(around) * radius,
        });
      }
      return { points, closed: true };
    }
  }
}
