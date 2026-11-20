/**
 * The sounds a hull makes that are not weapons.
 *
 * The feedback table in `docs/ART_DIRECTION.md` names these and the engine
 * loop was the only one of them that existed: manoeuvring jets on a turn,
 * the spool rising for four seconds, the jump releasing into a whump, the
 * arrival, the clamps at a berth and the clamps letting go.
 *
 * All on the effects bus and all synthesised, like everything else. The
 * spool is the only held voice here — it runs for as long as the lane takes
 * and is released by whatever ends it, including a cancelled jump.
 */

import { sounded } from './log.ts';
import { createNoiseBuffer, type AudioMix } from './mix.ts';
import { existingMix, sharedMix } from './shared.ts';

export class FlightAudio {
  private readonly context: AudioContext;
  private readonly bus: GainNode;
  private readonly noise: AudioBuffer;

  /** The spool, while one is running. */
  private spool:
    | { osc: OscillatorNode; ring: OscillatorNode; gain: GainNode }
    | undefined;

  /** When the last thruster puff was, so a held turn is not a hiss. */
  private lastThruster = 0;

  private stopped = false;

  constructor(mix: AudioMix) {
    this.context = mix.context;
    this.bus = this.context.createGain();
    this.bus.gain.value = 1;
    this.bus.connect(mix.busFor('effects'));
    this.noise = createNoiseBuffer(this.context, 1);
  }

  /**
   * A manoeuvring jet, on the outboard side.
   *
   * Rate-limited: a captain holding a turn is one manoeuvre, not sixty a
   * second, and the table asks for a puff rather than a jet engine. Panned
   * to the side the jet is on, which is the opposite of the turn.
   */
  thruster(direction: -1 | 1): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    if (now - this.lastThruster < 0.38) return;
    this.lastThruster = now;

    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2400;
    filter.Q.value = 0.8;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    const pan = this.context.createStereoPanner();
    // The jet that turns a hull to port is on its starboard side.
    pan.pan.value = direction === -1 ? 0.5 : -0.5;
    source.connect(filter).connect(gain).connect(pan).connect(this.bus);
    source.start(now);
    source.stop(now + 0.22);
    sounded('thruster');
  }

  /**
   * Start the spool.
   *
   * A rising harmonic over four seconds, as the table says. Two voices a
   * fifth apart so the rise has an interval in it rather than being one
   * slide, and a slow tremolo on the upper one.
   */
  startSpool(seconds = 4): void {
    if (this.stopped || this.spool) return;
    const now = this.context.currentTime;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.6);
    gain.gain.linearRampToValueAtTime(0.2, now + seconds);
    gain.connect(this.bus);

    const osc = this.context.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(110, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + seconds);

    const ring = this.context.createOscillator();
    ring.type = 'sine';
    ring.frequency.setValueAtTime(165, now);
    ring.frequency.exponentialRampToValueAtTime(660, now + seconds);
    const ringGain = this.context.createGain();
    ringGain.gain.value = 0.45;

    osc.connect(gain);
    ring.connect(ringGain).connect(gain);
    osc.start(now);
    ring.start(now);

    this.spool = { osc, ring, gain };
    sounded('spool');
  }

  /**
   * End the spool.
   *
   * `released` is true when the lane actually took the hull, which is a
   * whump; false when the captain changed their mind, which is the rise
   * falling away and nothing else.
   */
  endSpool(released: boolean): void {
    const running = this.spool;
    this.spool = undefined;
    const now = this.context.currentTime;

    if (running) {
      running.gain.gain.cancelScheduledValues(now);
      running.gain.gain.setValueAtTime(running.gain.gain.value, now);
      running.gain.gain.exponentialRampToValueAtTime(0.0001, now + (released ? 0.12 : 0.5));
      running.osc.stop(now + 0.6);
      running.ring.stop(now + 0.6);
    }

    if (!released || this.stopped) return;

    // The whump: a sine falling two octaves in a fifth of a second, with a
    // noise wash behind it that outlasts it.
    const osc = this.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.22);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.42, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    osc.connect(gain).connect(this.bus);
    osc.start(now);
    osc.stop(now + 0.75);

    const wash = this.context.createBufferSource();
    wash.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1800, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + 0.9);
    const washGain = this.context.createGain();
    washGain.gain.setValueAtTime(0.22, now);
    washGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    wash.connect(filter).connect(washGain).connect(this.bus);
    wash.start(now);
    wash.stop(now + 1);

    sounded('jump');
  }

  /** Arriving: a two-note chime up, and the wash behind it settling. */
  arrival(): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    for (const [hz, at, level] of [
      [392, 0, 0.16],
      [588, 0.09, 0.13],
    ] as const) {
      const osc = this.context.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = hz;
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.linearRampToValueAtTime(level, now + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.55);
      osc.connect(gain).connect(this.bus);
      osc.start(now + at);
      osc.stop(now + at + 0.6);
    }
    sounded('arrival');
  }

  /**
   * Coming alongside: clamps, then the hull settling against them.
   *
   * Two mechanical knocks and a long low creak. The creak is a sawtooth
   * detuned against itself through a lowpass, which is what makes it read
   * as something under load rather than as a note.
   */
  land(): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    this.clamp(now, 0.3);
    this.clamp(now + 0.14, 0.24);

    const creak = this.context.createOscillator();
    creak.type = 'sawtooth';
    creak.frequency.setValueAtTime(58, now + 0.2);
    creak.frequency.linearRampToValueAtTime(49, now + 1.1);
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now + 0.2);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.45);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    creak.connect(filter).connect(gain).connect(this.bus);
    creak.start(now + 0.2);
    creak.stop(now + 1.3);
    sounded('land');
  }

  /** Letting go: the clamps release, upward rather than down. */
  launch(): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    this.clamp(now, 0.26);

    const release = this.context.createOscillator();
    release.type = 'triangle';
    release.frequency.setValueAtTime(70, now + 0.08);
    release.frequency.exponentialRampToValueAtTime(190, now + 0.5);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, now + 0.08);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    release.connect(gain).connect(this.bus);
    release.start(now + 0.08);
    release.stop(now + 0.65);
    sounded('launch');
  }

  stop(): void {
    this.stopped = true;
    this.endSpool(false);
  }

  /** One mechanical knock: filtered noise with a very fast decay. */
  private clamp(at: number, level: number): void {
    const source = this.context.createBufferSource();
    source.buffer = this.noise;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 180;
    filter.Q.value = 1.6;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    source.connect(filter).connect(gain).connect(this.bus);
    source.start(at);
    source.stop(at + 0.14);
  }
}

/**
 * The one set of hull sounds for the session.
 *
 * Shared, like the mix: landing is heard by the flight view on its way out
 * and arriving by whatever comes up next, and a spool held by one instance
 * while another is asked to release it would hang a rising tone in the air.
 *
 * Returns nothing until the mix exists, which is until a captain has
 * touched something: a browser will not sound a note before a gesture, and
 * building a context to play into silence is worse than staying quiet.
 */
let shared: FlightAudio | undefined;

export function flightAudio(): FlightAudio | undefined {
  if (!existingMix()) return undefined;
  shared ??= new FlightAudio(sharedMix());
  return shared;
}
