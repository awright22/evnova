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
  | 'intercept'
  | 'lock';

/** One beam's voice, kept for as long as the beam is. */
interface HeldVoice {
  readonly panner: StereoPannerNode;
  readonly output: GainNode;
  readonly low: OscillatorNode;
  readonly high: OscillatorNode;
  /** The rasp's gain, which opens only while the beam is on something. */
  readonly rasp: GainNode;
  /** The hum's filter, which opens with it. */
  readonly colour: BiquadFilterNode;
  x: number;
  y: number;
}

export class CombatAudio {
  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly noise: AudioBuffer;

  /** Where the listener is, so sounds can be placed relative to it. */
  private listenerX = 0;
  private listenerY = 0;

  /** Sounds started in the current frame, to stop a volley stacking into mush. */
  private readonly recent = new Map<CombatSound, number>();

  /** Beams currently sounding, keyed the way the beams themselves are. */
  private readonly held = new Map<string, HeldVoice>();

  constructor(mix: AudioMix) {
    this.context = mix.context;
    this.bus = mix.busFor('effects');
    this.noise = createNoiseBuffer(this.context, 1.5);
  }

  setListener(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;

    // A held voice has to follow the listener as well as its own source,
    // because both move: the ear is on the captain's hull.
    for (const voice of this.held.values()) this.placeHeld(voice);
  }

  /**
   * Keep a beam sounding, for as long as it is held.
   *
   * Everything else here is a one-shot, because everything else is an
   * event. A beam is a state: it starts when a trigger goes down, runs
   * until it comes up, and changes while it runs — a line on nothing is a
   * hum, and a line on a hull gains a rasp. So it is a voice that is kept
   * rather than a sound that is played, keyed the way the beam is.
   */
  holdBeam(key: string, x: number, y: number, hitting: boolean): void {
    const now = this.context.currentTime;
    let voice = this.held.get(key);

    if (!voice) {
      const panner = this.context.createStereoPanner();
      const output = this.context.createGain();
      output.gain.setValueAtTime(0, now);
      output.gain.linearRampToValueAtTime(1, now + 0.06);
      panner.connect(output);
      output.connect(this.bus);

      // The hum: two detuned saws an octave apart, which is enough body to
      // sit under a fight without becoming a drone.
      const low = this.context.createOscillator();
      low.type = 'sawtooth';
      low.frequency.value = 96;
      const high = this.context.createOscillator();
      high.type = 'sawtooth';
      high.frequency.value = 193;

      const hum = this.context.createGain();
      hum.gain.value = 0.09;
      const colour = this.context.createBiquadFilter();
      colour.type = 'lowpass';
      colour.frequency.value = 900;
      colour.Q.value = 0.8;

      low.connect(hum);
      high.connect(hum);
      hum.connect(colour);
      colour.connect(panner);

      // The rasp: filtered noise that only opens while the beam is on
      // something, which is the whole of the difference a captain hears.
      const rasp = this.context.createBufferSource();
      rasp.buffer = this.noise;
      rasp.loop = true;
      const raspBand = this.context.createBiquadFilter();
      raspBand.type = 'bandpass';
      raspBand.frequency.value = 1700;
      raspBand.Q.value = 1.1;
      const raspGain = this.context.createGain();
      raspGain.gain.value = 0;

      rasp.connect(raspBand);
      raspBand.connect(raspGain);
      raspGain.connect(panner);

      low.start(now);
      high.start(now);
      rasp.start(now);

      voice = { panner, output, low, high, rasp: raspGain, colour, x, y };
      this.held.set(key, voice);
    }

    voice.x = x;
    voice.y = y;
    this.placeHeld(voice);

    // On something: the rasp opens and the hum brightens.
    voice.rasp.gain.setTargetAtTime(hitting ? 0.085 : 0, now, 0.05);
    voice.colour.frequency.setTargetAtTime(hitting ? 2200 : 900, now, 0.08);
  }

  /** Let one go, with a short fall rather than a cut. */
  releaseBeam(key: string): void {
    const voice = this.held.get(key);
    if (!voice) return;
    this.held.delete(key);

    const now = this.context.currentTime;
    voice.output.gain.cancelScheduledValues(now);
    voice.output.gain.setValueAtTime(voice.output.gain.value, now);
    voice.output.gain.linearRampToValueAtTime(0, now + 0.09);

    voice.low.stop(now + 0.12);
    voice.high.stop(now + 0.12);
    voice.rasp.gain.setValueAtTime(0, now);
  }

  /** Stop every held voice, for a view that is going away. */
  releaseAll(): void {
    for (const key of [...this.held.keys()]) this.releaseBeam(key);
  }

  /** Pan and attenuate a held voice from where it is now. */
  private placeHeld(voice: HeldVoice): void {
    const distance = Math.hypot(voice.x - this.listenerX, voice.y - this.listenerY);
    const attenuation = REFERENCE_DISTANCE / Math.max(REFERENCE_DISTANCE, distance);
    const now = this.context.currentTime;
    voice.output.gain.setTargetAtTime(attenuation * attenuation, now, 0.05);
    voice.panner.pan.setTargetAtTime(
      Math.max(-MAX_PAN, Math.min(MAX_PAN, ((voice.x - this.listenerX) / MAX_DISTANCE) * 4)),
      now,
      0.05,
    );
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

      case 'intercept':
        // A dry snap, high and quiet. It has to be unmistakable for a gun —
        // a captain hearing it should know something was stopped, not that
        // something was fired — so it is shorter, thinner and has no body
        // under it at all.
        this.burst(destination, now, { duration: 0.045, frequency: 3400, q: 2.6, level: 0.3 });
        this.tone(destination, now, {
          from: 1800,
          to: 900,
          duration: 0.05,
          level: 0.1,
          type: 'sine',
        });
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
  // Short, because a pair of watches firing at a volley is several in a
  // row and the ear should read "they are being dealt with" rather than
  // one noise.
  intercept: 0.04,
  lock: 0.2,
};
