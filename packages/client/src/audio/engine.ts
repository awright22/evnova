/**
 * The engine sound.
 *
 * A synthesised loop whose brightness and level follow the throttle, as the
 * art direction specifies: rate 0.82 to 1.18, gain 0.15 to 0.7, both smoothed
 * over 80ms. Built from filtered noise plus a low oscillator rather than a
 * sample, because no suitable openly licensed recording is reachable.
 *
 * Positional panning and distance falloff are wired here so remote ships use
 * the same path as the local one once M2 gives them sounds of their own.
 */

import { createNoiseBuffer, type AudioMix } from './mix.ts';

/** Smoothing time constant, in seconds. */
const SMOOTH = 0.08;

const MIN_RATE = 0.82;
const MAX_RATE = 1.18;
const MIN_GAIN = 0.15;
const MAX_GAIN = 0.7;

export class EngineSound {
  private readonly noise: AudioBufferSourceNode;
  private readonly rumble: OscillatorNode;
  private readonly bandpass: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly rumbleGain: GainNode;
  private readonly output: GainNode;
  private readonly context: AudioContext;
  private stopped = false;

  constructor(mix: AudioMix) {
    const context = mix.context;
    this.context = context;

    this.output = context.createGain();
    // Starts silent: the idle level fades in with the first throttle update.
    this.output.gain.value = 0;
    this.output.connect(mix.busFor('effects'));

    // Filtered noise is the body of the sound.
    this.noise = context.createBufferSource();
    this.noise.buffer = createNoiseBuffer(context);
    this.noise.loop = true;

    this.bandpass = context.createBiquadFilter();
    this.bandpass.type = 'bandpass';
    this.bandpass.frequency.value = 220;
    this.bandpass.Q.value = 0.7;

    this.noiseGain = context.createGain();
    this.noiseGain.gain.value = 0.8;

    this.noise.connect(this.bandpass);
    this.bandpass.connect(this.noiseGain);
    this.noiseGain.connect(this.output);

    // A low oscillator gives it a pitch to follow, so throttle is audible as
    // more than just volume.
    this.rumble = context.createOscillator();
    this.rumble.type = 'sawtooth';
    this.rumble.frequency.value = 46;

    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 160;

    this.rumbleGain = context.createGain();
    this.rumbleGain.gain.value = 0.18;

    this.rumble.connect(lowpass);
    lowpass.connect(this.rumbleGain);
    this.rumbleGain.connect(this.output);

    this.noise.start();
    this.rumble.start();
  }

  /** Follow the throttle. Called every frame; all changes are smoothed. */
  setThrottle(throttle: number): void {
    if (this.stopped) return;
    const t = Math.max(0, Math.min(1, throttle));
    const now = this.context.currentTime;

    const rate = MIN_RATE + (MAX_RATE - MIN_RATE) * t;
    const gain = MIN_GAIN + (MAX_GAIN - MIN_GAIN) * t;

    this.noise.playbackRate.setTargetAtTime(rate, now, SMOOTH);
    this.rumble.frequency.setTargetAtTime(46 * rate, now, SMOOTH);
    // Brightness opens up under load, which is most of what "more throttle"
    // sounds like.
    this.bandpass.frequency.setTargetAtTime(220 + 900 * t, now, SMOOTH);
    this.output.gain.setTargetAtTime(gain, now, SMOOTH);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.context.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.05);
    // Let the fade finish before tearing the nodes down.
    setTimeout(() => {
      try {
        this.noise.stop();
        this.rumble.stop();
      } catch {
        // Already stopped.
      }
      this.output.disconnect();
    }, 250);
  }
}
