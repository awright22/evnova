/**
 * The flight camera.
 *
 * Smooth follow with velocity look-ahead and a slight zoom-out at speed, so
 * flying fast shows you more of where you are going. Shake is restrained and
 * disabled entirely under reduced motion, because it is presentation rather
 * than gameplay.
 */

import { approachExp, clamp } from '@marque/shared';

/**
 * Pixels per world unit at rest.
 *
 * Sets how large hulls read and how fast the world goes past. At 3, the
 * starter shuttle is about 110px and a ship at top speed crosses a 1080p
 * screen in a little under three seconds.
 */
export const PX_PER_UNIT = 3;

/** How quickly the camera converges on its target, as a time constant. */
const FOLLOW_RATE = 1000 / 120;

/** Seconds of velocity to lead by. */
const LOOK_AHEAD_SECONDS = 0.35;

/** Maximum look-ahead, in screen pixels. */
const LOOK_AHEAD_MAX_PX = 220;

const ZOOM_AT_REST = 1;
const ZOOM_AT_SPEED = 0.82;

const SHAKE_MAX_PX = 6;
const SHAKE_DECAY_MS = 220;

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  shakeX: number;
  shakeY: number;
}

export class Camera {
  readonly state: CameraState = { x: 0, y: 0, zoom: ZOOM_AT_REST, shakeX: 0, shakeY: 0 };

  private shake = 0;
  private shakeAge = 0;
  private reducedMotion = false;

  constructor(reducedMotion = false) {
    this.reducedMotion = reducedMotion;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.shake = 0;
      this.state.shakeX = 0;
      this.state.shakeY = 0;
    }
  }

  /** Snap straight to the target, for a spawn or an arrival. */
  jumpTo(x: number, y: number): void {
    this.state.x = x;
    this.state.y = y;
  }

  /** Add an impact. Amplitude is 0..1 and clamps to the restrained maximum. */
  impact(amplitude: number): void {
    if (this.reducedMotion) return;
    this.shake = Math.max(this.shake, clamp(amplitude, 0, 1));
    this.shakeAge = 0;
  }

  /**
   * Advance the camera.
   *
   * `dtMs` is real frame time: the camera is presentation, not simulation, so
   * it does not need the fixed step.
   */
  update(
    targetX: number,
    targetY: number,
    velocityX: number,
    velocityY: number,
    topSpeed: number,
    dtMs: number,
  ): void {
    const dt = dtMs / 1000;

    // Lead the ship by where it is going, clamped so a fast hull does not sit
    // at the edge of the screen.
    const leadScale = LOOK_AHEAD_MAX_PX / PX_PER_UNIT;
    const leadX = clamp(velocityX * LOOK_AHEAD_SECONDS, -leadScale, leadScale);
    const leadY = clamp(velocityY * LOOK_AHEAD_SECONDS, -leadScale, leadScale);

    const wantX = targetX + (this.reducedMotion ? 0 : leadX);
    const wantY = targetY + (this.reducedMotion ? 0 : leadY);

    this.state.x = approachExp(this.state.x, wantX, FOLLOW_RATE, dt);
    this.state.y = approachExp(this.state.y, wantY, FOLLOW_RATE, dt);

    const speed = Math.hypot(velocityX, velocityY);
    const fraction = topSpeed > 0 ? clamp(speed / topSpeed, 0, 1) : 0;
    const wantZoom = ZOOM_AT_REST + (ZOOM_AT_SPEED - ZOOM_AT_REST) * fraction;
    this.state.zoom = approachExp(this.state.zoom, wantZoom, 2.5, dt);

    // Shake decays on its own clock so it is independent of frame rate.
    if (this.shake > 0) {
      this.shakeAge += dtMs;
      const remaining = Math.max(0, 1 - this.shakeAge / SHAKE_DECAY_MS);
      const amplitude = this.shake * remaining * remaining * SHAKE_MAX_PX;
      // A fixed frequency rather than random jitter, so it reads as an impulse.
      const phase = this.shakeAge / 14;
      this.state.shakeX = Math.sin(phase) * amplitude;
      this.state.shakeY = Math.cos(phase * 1.37) * amplitude;
      if (remaining <= 0) {
        this.shake = 0;
        this.state.shakeX = 0;
        this.state.shakeY = 0;
      }
    }
  }
}
