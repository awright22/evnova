/**
 * Combat audio.
 *
 * Every sound here is synthesised in Web Audio: no openly licensed audio
 * source is reachable from the build environment, and the spec's stated
 * fallback is to make it in code.
 *
 * Each one is a row of the feedback table in `docs/ART_DIRECTION.md`. Sounds
 * are positional — panned and attenuated by distance from the camera — so a
 * fight across the system reads as further away than one alongside.
 */

import { createNoiseBuffer, type AudioMix } from './mix.ts';

/** Distance at which a sound is at full level, in world units. */
const REFERENCE_DISTANCE = 400;

/** Beyond this, a sound is inaudible. */
const MAX_DISTANCE = 6000;

/** Panning never goes fully to one ear. */
const MAX_PAN = 0.85;

export type CombatSound =
  | 'gun'
  | 'turret'
  | 'missile'
  | 'shieldHit'
  | 'hullHit'
  | 'moduleDisabled'
  | 'explosionSmall'
  | 'explosionLarge'
  | 'lock';

export class CombatAudio {
  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly noise: AudioBuffer;

  /** Where the listener is, so sounds can be placed relative to it. */
  private listenerX = 0;
  private listenerY = 0;

  /** Sounds started in the current frame, to stop a volley stacking into mush. */
  private readonly recent = new Map<CombatSound, number>();

  constructor(mix: AudioMix) {
    this.context = mix.context;
    this.bus = mix.busFor('effects');
    this.noise = createNoiseBuffer(this.context, 1.5);
  }

  setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  /**
   * Play one sound at a world position.
   *
   * A minimum gap per sound type keeps a six-ship volley from turning into a
   * single loud smear; the ear reads two shots and a texture, not twelve.
   */
  play(sound: CombatSound, x: number, y: number): void {
    const now = this.context.currentTime;
    const gap = MIN_GAP[sound];
    const last = this.recent.get(sound) ?? -Infinity;
    if (now - last < gap) return;
    this.recent.set(sound, now);

    const distance = Math.hypot(x - this.listenerX, y - this.listenerY);
    if (distance > MAX_DISTANCE) return;

    // Inverse falloff, as the art direction specifies.
    const attenuation = REFERENCE_DISTANCE / Math.max(REFERENCE_DISTANCE, distance);
    const gain = attenuation * attenuation;
    if (gain < 0.01) return;

    const pan = Math.max(-MAX_PAN, Math.min(MAX_PAN, (x - this.listenerX) / MAX_DISTANCE * 4));

    const panner = this.context.createStereoPanner();
    panner.pan.value = pan;

    const output = this.context.createGain();
    output.gain.value = gain;

    panner.connect(output);
    output.connect(this.bus);

    this.render(sound, panner, now);
  }

  private render(sound: CombatSound, destination: AudioNode, now: number): void {
    switch (sound) {
      case 'gun':
        // A dry mechanical report: a short noise burst through a band, with a
        // click of body under it.
        this.burst(destination, now, { duration: 0.09, frequency: 1500, q: 1.1, level: 0.5 });
        this.tone(destination, now, { from: 190, to: 70, duration: 0.07, level: 0.26, type: 'square' });
        break;

      case 'turret':
        // Softer, and a touch of pitch variance so repeats do not phase.
        this.burst(destination, now, {
          duration: 0.1,
          frequency: 1100 * (0.92 + Math.random() * 0.16),
          q: 1.4,
          level: 0.38,
        });
        this.tone(destination, now, { from: 150, to: 60, duration: 0.08, level: 0.2, type: 'square' });
        break;

      case 'missile':
        // A rail clunk, then a roar that recedes.
        this.tone(destination, now, { from: 120, to: 48, duration: 0.1, level: 0.4, type: 'square' });
        this.burst(destination, now + 0.05, { duration: 0.9, frequency: 420, q: 0.6, level: 0.3, decay: 0.9 });
        break;

      case 'shieldHit':
        // Resonant: the shield rings rather than bangs.
        this.tone(destination, now, { from: 760, to: 520, duration: 0.3, level: 0.3, type: 'sine' });
        this.tone(destination, now, { from: 1140, to: 780, duration: 0.22, level: 0.14, type: 'sine' });
        this.burst(destination, now, { duration: 0.08, frequency: 2600, q: 3, level: 0.16 });
        break;

      case 'hullHit':
        // Dull and structural: low body, little top.
        this.burst(destination, now, { duration: 0.16, frequency: 320, q: 0.8, level: 0.5 });
        this.tone(destination, now, { from: 110, to: 42, duration: 0.18, level: 0.4, type: 'triangle' });
        break;

      case 'moduleDisabled':
        // A power-down whine with a warning chirp on top.
        this.tone(destination, now, { from: 640, to: 90, duration: 0.55, level: 0.3, type: 'sawtooth' });
        this.tone(destination, now + 0.16, { from: 1760, to: 1760, duration: 0.07, level: 0.16, type: 'square' });
        this.tone(destination, now + 0.28, { from: 1320, to: 1320, duration: 0.07, level: 0.16, type: 'square' });
        break;

      case 'explosionSmall':
        this.explosion(destination, now, 1);
        break;

      case 'explosionLarge':
        this.explosion(destination, now, 1.9);
        break;

      case 'lock':
        // Two quiet tones: acquisition, not an alarm.
        this.tone(destination, now, { from: 880, to: 880, duration: 0.05, level: 0.12, type: 'sine' });
        this.tone(destination, now + 0.07, { from: 1320, to: 1320, duration: 0.07, level: 0.12, type: 'sine' });
        break;
    }
  }

  /** Layered boom, scaled by hull size. */
  private explosion(destination: AudioNode, now: number, scale: number): void {
    this.burst(destination, now, {
      duration: 0.9 * scale,
      frequency: 180 / scale,
      q: 0.5,
      level: 0.75,
      decay: 0.85,
    });
    this.tone(destination, now, {
      from: 150 / scale,
      to: 28,
      duration: 0.7 * scale,
      level: 0.6,
      type: 'sine',
    });
    // Debris patter after the body of it.
    this.burst(destination, now + 0.18 * scale, {
      duration: 1.1 * scale,
      frequency: 2200,
      q: 0.8,
      level: 0.14,
      decay: 0.9,
    });
  }

  /** Filtered noise with an exponential decay. */
  private burst(
    destination: AudioNode,
    at: number,
    options: { duration: number; frequency: number; q: number; level: number; decay?: number },
  ): void {
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = options.frequency;
    filter.Q.value = options.q;

    const envelope = this.context.createGain();
    const peak = options.level;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(peak, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * 0.001),
      at + options.duration * (options.decay ?? 1),
    );

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(destination);

    source.start(at);
    source.stop(at + options.duration + 0.05);
  }

  /** A pitched tone sweeping between two frequencies. */
  private tone(
    destination: AudioNode,
    at: number,
    options: {
      from: number;
      to: number;
      duration: number;
      level: number;
      type: OscillatorType;
    },
  ): void {
    const osc = this.context.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(options.from, at);
    if (options.to !== options.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.to), at + options.duration);
    }

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(options.level, at + 0.005);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, options.level * 0.001),
      at + options.duration,
    );

    osc.connect(envelope);
    envelope.connect(destination);

    osc.start(at);
    osc.stop(at + options.duration + 0.05);
  }
}

/** Minimum seconds between repeats of each sound. */
const MIN_GAP: Record<CombatSound, number> = {
  gun: 0.05,
  turret: 0.06,
  missile: 0.12,
  shieldHit: 0.05,
  hullHit: 0.05,
  moduleDisabled: 0.25,
  explosionSmall: 0.12,
  explosionLarge: 0.12,
  lock: 0.2,
};
