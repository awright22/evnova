/**
 * Held beams and point-defense intercepts: the parts that are arithmetic.
 *
 * A beam is drawn on every frame it exists rather than spawned once, so
 * everything the renderer needs per frame is here as plain maths: where the
 * line starts and ends given the hull's pose, how far through its rise or fall
 * it is, how the width wanders along its length, and how an intercept flash
 * decays. None of it touches Pixi and none of it allocates, so the renderer can
 * call it in a loop and the tests can check it without a display list.
 *
 * The intercept timing lives here too, next to the beam's, because it is the
 * same kind of thing — a short curve over a duration token — and `effects.ts`
 * cannot be imported into a Node test without pulling Pixi in with it.
 */

import { clamp, muzzleOf, type Mount, type Pose } from '@marque/shared';

/**
 * What the scene needs to know about one held beam this frame.
 *
 * Mirrors `BeamState` on the wire, with the map's key carried as `id` so the
 * renderer can keep a beam's rise and fall across frames.
 */
export interface BeamFrame {
  /** The wire key, `"<owner>:<mount>"`. */
  readonly id: string;
  readonly owner: string;
  /** Index into the owner's mounts, as `mountsOf` orders them. */
  readonly mount: number;
  /** Where it points, in world radians. */
  readonly angle: number;
  /** How far it reaches before it stops, in world units. */
  readonly length: number;
  /** True while it is actually on a hull. */
  readonly hitting: boolean;
}

/** The two ends of a beam, in world units. */
export interface BeamSegment {
  readonly muzzleX: number;
  readonly muzzleY: number;
  readonly tipX: number;
  readonly tipY: number;
}

/**
 * Where a beam's line runs, given the hull's pose this frame.
 *
 * The muzzle comes from the hull's current pose through the same
 * `muzzleOf` the server fires from, so a beam stays welded to its mount while
 * the hull turns instead of pivoting about the hull's centre. The angle is the
 * server's, already in world radians and already including whatever traverse
 * the mount had, and the length is already stopped at whatever it hit.
 */
export function beamSegment(
  mount: Mount,
  pose: Pose,
  angle: number,
  length: number,
): BeamSegment {
  const muzzle = muzzleOf(mount, pose);
  return {
    muzzleX: muzzle.x,
    muzzleY: muzzle.y,
    tipX: muzzle.x + Math.cos(angle) * length,
    tipY: muzzle.y + Math.sin(angle) * length,
  };
}

/**
 * Advance a 0..1 level toward a target at a fixed rate.
 *
 * Linear in time and independent of frame rate, so a beam takes the same
 * number of milliseconds to come up at 30fps as at 144. The curve is applied
 * when it is drawn, not here, because a level that is already eased cannot be
 * eased back out again on the way down.
 */
export function approachLevel(
  level: number,
  target: number,
  dtMs: number,
  durationMs: number,
): number {
  if (durationMs <= 0) return target;
  const step = Math.max(0, dtMs) / durationMs;
  return target > level ? Math.min(target, level + step) : Math.max(target, level - step);
}

/**
 * The `--ease-emphasis` shape, for a beam coming up.
 *
 * That token is `cubic-bezier(0.2, 0, 0, 1)` — arriving content, almost all of
 * the distance covered early. An ease-out cubic is within a couple of per cent
 * of it over the whole curve, and a trigger going down does not deserve a
 * bezier solver.
 */
export function easeEmphasis(t: number): number {
  const remaining = 1 - clamp(t, 0, 1);
  return 1 - remaining * remaining * remaining;
}

/**
 * The `--ease-exit` shape, for a beam cutting out.
 *
 * `cubic-bezier(0.4, 0, 1, 1)` leaves slowly and then goes, which is what a
 * weapon losing its feed looks like. An ease-in quadratic is the same shape.
 */
export function easeExit(t: number): number {
  const level = clamp(t, 0, 1);
  return level * level;
}

/** How much a beam's width may wander from even, as a fraction. */
const RIPPLE_DEPTH = 0.09;

/**
 * The width multiplier at a point along a held beam.
 *
 * `t` is 0 at the muzzle and 1 at the tip. A single even stroke reads as a
 * rectangle somebody left on the screen, so the width breathes along its
 * length: two waves at unrelated frequencies, which do not line up into a
 * visible repeat, travelling muzzle-outward so the eye reads the energy as
 * going that way. `phase` separates two beams on one hull.
 *
 * `elapsedMs` of 0 freezes the travel and leaves the standing variation, which
 * is what reduced motion gets: the beam is still not a dead rectangle, but
 * nothing on it moves.
 */
export function beamRipple(t: number, elapsedMs: number, phase = 0): number {
  const travel = (elapsedMs / 1000) * 9;
  const fast = Math.sin(t * 17 - travel * Math.PI * 2 + phase);
  const slow = Math.sin(t * 6.3 - travel * Math.PI * 1.1 + phase * 0.5);
  return 1 + (fast * 0.6 + slow * 0.4) * RIPPLE_DEPTH;
}

/**
 * How bright a point-defense intercept is, `t` of 0 at the shot, 1 at the end.
 *
 * Squared, so it is mostly gone in the first third of its life. A hull hit
 * holds a white frame and throws sparks for 220ms; this has to read as
 * something that did not land, which means it has to be over before the eye
 * treats it as damage.
 */
export function interceptAlpha(t: number): number {
  const remaining = 1 - clamp(t, 0, 1);
  return remaining * remaining;
}

/**
 * How wide an intercept's ring has grown, as a multiple of its radius.
 *
 * Small and quick: a round was stopped out in space, not a shell landing.
 * Under reduced motion it holds its radius and only fades, because the growth
 * is presentation and the fade carries the same information.
 */
export function interceptScale(t: number, reducedMotion = false): number {
  if (reducedMotion) return 1;
  return 0.45 + clamp(t, 0, 1) * 0.85;
}

/** Durations from the motion tokens, in milliseconds. */
export interface MotionTokens {
  readonly instant: number;
  readonly quick: number;
  readonly base: number;
  readonly slow: number;
}

/**
 * Parse a CSS duration into milliseconds.
 *
 * Only the two units a duration token is ever written in; anything else is
 * refused rather than guessed at, and the caller keeps its fallback.
 */
export function parseDuration(value: string): number | undefined {
  const match = /^(-?[0-9]*\.?[0-9]+)(ms|s)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return undefined;
  return match[2] === 's' ? amount * 1000 : amount;
}

function durationToken(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return parseDuration(value) ?? fallback;
}

let cachedMotion: MotionTokens | undefined;

/**
 * The motion tokens, read from the document as the palette is.
 *
 * `tokens.css` is the one source of truth for durations, and it already
 * collapses the longer steps to the instant one under
 * `prefers-reduced-motion`, so reading the token rather than hard-coding the
 * number is also how an effect's timing gets reduced.
 */
export function motion(): MotionTokens {
  cachedMotion ??= {
    instant: durationToken('--motion-instant', 80),
    quick: durationToken('--motion-quick', 120),
    base: durationToken('--motion-base', 160),
    slow: durationToken('--motion-slow', 200),
  };
  return cachedMotion;
}
