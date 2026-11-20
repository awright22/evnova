/**
 * Music.
 *
 * Spec section 4: an ambient bed per region and a combat layer that
 * crossfades in and out; music ducks under alerts; sparse and patient,
 * ambient electronics with bowed strings and low piano; no orchestral
 * bombast.
 *
 * Synthesised, like the rest of the audio, because openly licensed music
 * that fits this direction is not reachable from the build environment and
 * the spec's stated fallback is to make it in code. That turns out to suit
 * the brief: sparse and patient is what synthesis is good at, and a bed that
 * is generated rather than looped never arrives at the same bar twice.
 *
 * How it is put together, from the bottom:
 *
 * - A **drone**: three detuned oscillators on the root and the fifth,
 *   through a lowpass that breathes on a slow LFO. Always sounding. This is
 *   the only continuous layer, and it is most of what a captain hears.
 * - **Bowed strings**: a sawtooth pair through a bandpass with a two-second
 *   attack and a long release, one note at a time, chosen from the region's
 *   scale, at intervals of eight to twenty seconds. They do not resolve.
 * - **Low piano**: a struck tone — sine fundamental, two quiet partials, a
 *   touch of filtered noise for the hammer — two or three octaves below
 *   middle, struck rarely and never in a rhythm.
 * - A **combat layer**: a low pulse on the beat, a minor second against the
 *   root, and the drone's filter opened up. Crossfaded over two seconds, so
 *   a fight that starts and stops does not switch anything on and off.
 *
 * Notes are scheduled ahead against the audio clock rather than played from
 * a timer, because a timer in a browser tab is not a metronome. A quarter of
 * a second of lookahead is enough that a slow frame cannot be heard.
 */

import { Rng } from '@marque/shared';

import { musicIs } from './log.ts';
import type { AudioMix } from './mix.ts';

/** How far ahead notes are scheduled, and how often the scheduler looks. */
const LOOKAHEAD_S = 1.5;
const TICK_MS = 250;

/**
 * How long the combat layer takes to come in and to go out.
 *
 * The art direction's figures: in over 1.5s, out over 4s. Asymmetric on
 * purpose — a fight should arrive before the captain has worked out that
 * one has, and should not leave the moment the last hostile drifts out of
 * range, because it usually drifts back.
 *
 * These are the times to arrive, and `setTargetAtTime` is exponential, so
 * each is divided by three: three time constants is ~95% of the way there.
 */
const FADE_IN_S = 1.5 / 3;
const FADE_OUT_S = 4 / 3;

/**
 * The duck, as the art direction sets it: 6 dB down over 120ms, recovering
 * over 400ms. 6 dB is a halving of amplitude.
 */
const DUCK_GAIN = 0.5;
const DUCK_DOWN_S = 0.12;
const DUCK_UP_S = 0.4;

export type Region = 'home-roads' | 'concessions' | 'marque';

interface RegionVoice {
  /** The root, in Hz. Low: everything else is built up from here. */
  readonly root: number;
  /**
   * The scale, as semitone offsets from the root.
   *
   * Each region gets a different one, and none of them is major: the world
   * is not pleased to see anybody.
   */
  readonly scale: readonly number[];
  /** Where the drone's lowpass sits, and how far it breathes. */
  readonly cutoff: number;
  readonly sweep: number;
  /** Seconds between bowed entries, as a range. */
  readonly bowEvery: readonly [number, number];
  /** Seconds between struck notes, as a range. A wider range is sparser. */
  readonly strikeEvery: readonly [number, number];
}

/**
 * The three regions, as three characters.
 *
 * The Home Roads are settled and solvent: a minor scale with a major sixth
 * in it, the warmest thing here. The Concessions are contested and
 * arithmetical: Dorian, open fifths, nothing warm. The Marque is lawless:
 * Phrygian with a flat second, the drone darker and the strings further
 * apart, because there is less out there.
 */
const VOICES: Record<Region, RegionVoice> = {
  'home-roads': {
    root: 55, // A1
    scale: [0, 3, 5, 7, 9, 12, 15],
    cutoff: 460,
    sweep: 180,
    bowEvery: [9, 17],
    strikeEvery: [11, 26],
  },
  concessions: {
    root: 49, // G1
    scale: [0, 2, 3, 7, 9, 10, 12],
    cutoff: 380,
    sweep: 140,
    bowEvery: [10, 20],
    strikeEvery: [14, 32],
  },
  marque: {
    root: 44, // F1
    scale: [0, 1, 3, 5, 7, 8, 10],
    cutoff: 300,
    sweep: 110,
    bowEvery: [13, 26],
    strikeEvery: [18, 44],
  },
};

/** A semitone offset from a root, in Hz. */
function step(root: number, semitones: number): number {
  return root * 2 ** (semitones / 12);
}

export class Music {
  private readonly context: AudioContext;

  /** Everything joins here, and this is what ducks. */
  private readonly out: GainNode;

  /** The bed and the fight, crossfaded against each other. */
  private readonly bedGain: GainNode;
  private readonly combatGain: GainNode;

  /** The drone's filter, which the fight opens up. */
  private readonly droneFilter: BiquadFilterNode;
  private readonly droneOscillators: OscillatorNode[] = [];
  private readonly droneLfo: OscillatorNode;
  private readonly combatOscillator: OscillatorNode;
  private readonly combatOscGain: GainNode;

  private readonly noise: AudioBuffer;
  private rng: Rng;
  private voice: RegionVoice;
  private region: Region;

  /** Audio-clock times the next bowed entry and the next strike are due. */
  private bowAt = 0;
  private strikeAt = 0;
  /** The combat pulse's own clock, in beats. */
  private pulseAt = 0;

  private timer: number | undefined;
  private fighting = false;
  private stopped = false;

  constructor(mix: AudioMix, region: Region = 'home-roads') {
    this.context = mix.context;
    this.region = region;
    this.voice = VOICES[region];
    // Seeded by region, so each region always sounds like itself. Which bar
    // it is on when a captain arrives is down to the clock, so it is never
    // the same arrival twice.
    this.rng = new Rng(`music:${region}`);

    const now = this.context.currentTime;

    this.out = this.context.createGain();
    this.out.gain.value = 1;
    this.out.connect(mix.busFor('music'));

    this.bedGain = this.context.createGain();
    this.bedGain.gain.value = 1;
    this.bedGain.connect(this.out);

    this.combatGain = this.context.createGain();
    this.combatGain.gain.value = 0;
    this.combatGain.connect(this.out);

    // --- The drone ------------------------------------------------------

    this.droneFilter = this.context.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = this.voice.cutoff;
    this.droneFilter.Q.value = 0.9;
    this.droneFilter.connect(this.bedGain);

    // Breathing, not wobbling: a twenty-three second period is slow enough
    // that it reads as the room rather than as an effect.
    this.droneLfo = this.context.createOscillator();
    this.droneLfo.frequency.value = 1 / 23;
    const lfoDepth = this.context.createGain();
    lfoDepth.gain.value = this.voice.sweep;
    this.droneLfo.connect(lfoDepth).connect(this.droneFilter.frequency);
    this.droneLfo.start(now);

    // Root, root a shade sharp, and the fifth. The detune is what makes it
    // a pad rather than an organ.
    for (const [semitones, cents, level] of [
      [0, -4, 0.09],
      [0, 5, 0.075],
      [7, 2, 0.055],
      [12, -7, 0.03],
    ] as const) {
      const osc = this.context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = step(this.voice.root, semitones);
      osc.detune.value = cents;
      const gain = this.context.createGain();
      gain.gain.value = level;
      osc.connect(gain).connect(this.droneFilter);
      osc.start(now);
      this.droneOscillators.push(osc);
    }

    // --- The fight ------------------------------------------------------
    //
    // One held note a minor second above the root, which is the whole of the
    // tension. It is always running and always connected; what changes is
    // the gain on the layer it feeds.
    this.combatOscillator = this.context.createOscillator();
    this.combatOscillator.type = 'sawtooth';
    this.combatOscillator.frequency.value = step(this.voice.root, 13);
    this.combatOscGain = this.context.createGain();
    this.combatOscGain.gain.value = 0.035;
    const combatFilter = this.context.createBiquadFilter();
    combatFilter.type = 'lowpass';
    combatFilter.frequency.value = 700;
    this.combatOscillator
      .connect(this.combatOscGain)
      .connect(combatFilter)
      .connect(this.combatGain);
    this.combatOscillator.start(now);

    this.noise = hammerNoise(this.context);

    this.bowAt = now + 4;
    this.strikeAt = now + 9;
    this.pulseAt = now;

    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
    musicIs({ started: true, region, fighting: false });
  }

  /**
   * Move to another region's bed.
   *
   * The drone's pitches and the filter glide over four seconds rather than
   * cutting: arriving somewhere is a change of character, not a change of
   * track, and a hyperjump already has enough going on.
   */
  setRegion(region: Region): void {
    if (region === this.region || this.stopped) return;
    this.region = region;
    this.voice = VOICES[region];
    this.rng = new Rng(`music:${region}`);

    const now = this.context.currentTime;
    const semitones = [0, 0, 7, 12];
    this.droneOscillators.forEach((osc, index) => {
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setTargetAtTime(
        step(this.voice.root, semitones[index] ?? 0),
        now,
        1.4,
      );
    });
    this.droneFilter.frequency.cancelScheduledValues(now);
    this.droneFilter.frequency.setTargetAtTime(this.voice.cutoff, now, 1.4);
    this.combatOscillator.frequency.setTargetAtTime(step(this.voice.root, 13), now, 1.4);
    musicIs({ region });
  }

  /**
   * Whether a fight is on.
   *
   * Called with whatever the flight view knows: a hostile within reach, or
   * shots in the air. It crossfades, so it can be called every frame.
   */
  setFighting(fighting: boolean): void {
    if (fighting === this.fighting || this.stopped) return;
    this.fighting = fighting;
    musicIs({ fighting });
    const now = this.context.currentTime;

    // Equal-power would be the textbook crossfade; this is two layers of one
    // piece rather than two pieces, so they simply trade places and the bed
    // never goes all the way out.
    const over = fighting ? FADE_IN_S : FADE_OUT_S;
    this.bedGain.gain.cancelScheduledValues(now);
    this.bedGain.gain.setTargetAtTime(fighting ? 0.55 : 1, now, over);
    this.combatGain.gain.cancelScheduledValues(now);
    this.combatGain.gain.setTargetAtTime(fighting ? 1 : 0, now, over);
    // The bed's filter opens under a fight, which is most of why it reads as
    // one: the same drone, with the lid off.
    this.droneFilter.frequency.cancelScheduledValues(now);
    this.droneFilter.frequency.setTargetAtTime(
      fighting ? this.voice.cutoff * 2.2 : this.voice.cutoff,
      now,
      over,
    );
  }

  /**
   * Duck under an alert.
   *
   * The spec asks for it by name. Down fast, back slowly: the point is that
   * the alert is heard, not that the music is noticed going away.
   */
  duck(): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(DUCK_GAIN, now + DUCK_DOWN_S);
    this.out.gain.linearRampToValueAtTime(1, now + DUCK_DOWN_S + DUCK_UP_S);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    musicIs({ started: false, fighting: false });
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    const now = this.context.currentTime;
    // Faded rather than cut: a drone that stops dead is a click.
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.4);
    for (const osc of [...this.droneOscillators, this.droneLfo, this.combatOscillator]) {
      osc.stop(now + 2.5);
    }
  }

  /** Put every note that falls inside the lookahead on the clock. */
  private schedule(): void {
    if (this.stopped) return;
    const until = this.context.currentTime + LOOKAHEAD_S;

    while (this.bowAt < until) {
      this.bow(this.bowAt);
      const [low, high] = this.voice.bowEvery;
      this.bowAt += this.rng.range(low, high);
    }

    while (this.strikeAt < until) {
      this.strike(this.strikeAt);
      const [low, high] = this.voice.strikeEvery;
      this.strikeAt += this.rng.range(low, high);
    }

    // The fight's pulse keeps its own time whether or not anyone is
    // fighting, so coming into a fight lands on the beat rather than
    // starting a new one.
    while (this.pulseAt < until) {
      if (this.fighting) this.pulse(this.pulseAt);
      this.pulseAt += 60 / 76;
    }
  }

  /**
   * One bowed note.
   *
   * A sawtooth pair a few cents apart through a bandpass, with a long
   * attack and a longer release. The pair is the bow: one sawtooth is a
   * synthesiser, two slightly apart is something being drawn across
   * something else.
   */
  private bow(at: number): void {
    const semitones = this.rng.pick(this.voice.scale);
    // Two or three octaves up from the drone, which is where a cello and a
    // viola actually sit against a bass that low.
    const octave = this.rng.next() < 0.55 ? 24 : 36;
    const hz = step(this.voice.root, semitones + octave);
    const length = this.rng.range(5.5, 9.5);
    const level = this.rng.range(0.05, 0.085);

    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hz * 1.8;
    filter.Q.value = 1.6;

    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    // Two seconds of attack. Anything faster has an edge on it, and an edge
    // is the one thing this must not have.
    gain.gain.linearRampToValueAtTime(level, at + 2);
    gain.gain.setValueAtTime(level, at + length * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    filter.connect(gain).connect(this.bedGain);

    for (const cents of [-6, 7]) {
      const osc = this.context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz;
      osc.detune.value = cents;
      const voice = this.context.createGain();
      voice.gain.value = 0.5;
      osc.connect(voice).connect(filter);
      osc.start(at);
      osc.stop(at + length + 0.1);
    }
  }

  /**
   * One struck note, low.
   *
   * A sine fundamental with two quiet partials and a hammer: filtered noise,
   * fifteen milliseconds of it. The partials are what stop it reading as a
   * test tone, and the hammer is what makes it a piano rather than a bell.
   */
  private strike(at: number): void {
    const semitones = this.rng.pick(this.voice.scale);
    const hz = step(this.voice.root, semitones + 12);
    const length = this.rng.range(3.5, 6);
    const level = this.rng.range(0.07, 0.11);

    const body = this.context.createGain();
    body.gain.setValueAtTime(0.0001, at);
    body.gain.linearRampToValueAtTime(level, at + 0.012);
    body.gain.exponentialRampToValueAtTime(0.0001, at + length);
    body.connect(this.bedGain);

    for (const [partial, share] of [
      [1, 1],
      [2, 0.22],
      [3, 0.08],
    ] as const) {
      const osc = this.context.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz * partial;
      const gain = this.context.createGain();
      gain.gain.value = share;
      osc.connect(gain).connect(body);
      osc.start(at);
      osc.stop(at + length + 0.05);
    }

    const hammer = this.context.createBufferSource();
    hammer.buffer = this.noise;
    const thud = this.context.createBiquadFilter();
    thud.type = 'bandpass';
    thud.frequency.value = hz * 4;
    thud.Q.value = 0.7;
    const hammerGain = this.context.createGain();
    hammerGain.gain.setValueAtTime(level * 0.35, at);
    hammerGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    hammer.connect(thud).connect(hammerGain).connect(this.bedGain);
    hammer.start(at);
    hammer.stop(at + 0.1);
  }

  /**
   * One beat of the fight.
   *
   * A short low sine with a fast decay. No snare, no cymbal, nothing on top:
   * the spec rules out bombast, and a fight here should read as pressure
   * rather than as a drum kit arriving.
   */
  private pulse(at: number): void {
    const osc = this.context.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(step(this.voice.root, -12) * 1.5, at);
    osc.frequency.exponentialRampToValueAtTime(step(this.voice.root, -12), at + 0.1);
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.16, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain).connect(this.combatGain);
    osc.start(at);
    osc.stop(at + 0.4);
  }
}

/** A short noise burst for the piano's hammer, made once per context. */
let hammer: AudioBuffer | undefined;

function hammerNoise(context: AudioContext): AudioBuffer {
  if (hammer && hammer.sampleRate === context.sampleRate) return hammer;
  const length = Math.round(context.sampleRate * 0.08);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // A small deterministic generator rather than Math.random: the hammer
  // should be the same hammer every time, so a strike is one sound and not
  // a family of them.
  let seed = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = ((seed / 0xffffffff) * 2 - 1) * (1 - i / length);
  }
  hammer = buffer;
  return buffer;
}

/** The one music engine for the session, like the mix. */
let playing: Music | undefined;

export function startMusic(mix: AudioMix, region: Region): Music {
  if (playing) {
    playing.setRegion(region);
    return playing;
  }
  playing = new Music(mix, region);
  return playing;
}

/** The engine if there is one, without starting it. */
export function currentMusic(): Music | undefined {
  return playing;
}

export function stopMusic(): void {
  playing?.stop();
  playing = undefined;
}

/** Whether a region id from the galaxy data is one this has a bed for. */
export function isRegion(id: string): id is Region {
  return id === 'home-roads' || id === 'concessions' || id === 'marque';
}
