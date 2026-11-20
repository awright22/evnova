/**
 * The stamp.
 *
 * A low thud with twelve milliseconds of paper and mechanism ahead of it, on
 * the interface bus, as the art direction's feedback table asks. Synthesised
 * like everything else here: the paper is filtered noise, the mechanism a
 * short click, and the thud a low sine with a fast decay and a touch of
 * pitch drop, which is what gives it its weight.
 *
 * It plays on the strike frame, and it plays under reduced motion too: the
 * sequence can be shortened but the stamp is the confirmation and is never
 * silent.
 */

import { sounded } from './log.ts';
import { sharedMix } from './shared.ts';

/** Noise, made once and reused: a buffer per stamp would allocate per click. */
let paper: AudioBuffer | undefined;

function paperBuffer(context: AudioContext): AudioBuffer {
  if (paper && paper.sampleRate === context.sampleRate) return paper;

  const length = Math.round(context.sampleRate * 0.05);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic rather than random: the same rustle every time is a
  // mechanism, and a different one every time is a mouth.
  let seed = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  paper = buffer;
  return buffer;
}

/** Strike the seal: paper, mechanism, thud. */
export function playStamp(): void {
  let mix;
  try {
    mix = sharedMix();
  } catch {
    // No audio on this device or in this context. The stamp is still struck.
    return;
  }

  const context = mix.context;
  void mix.unlock();
  const bus = mix.busFor('interface');
  const now = context.currentTime;
  sounded('stamp');

  // 1. Paper and mechanism: twelve milliseconds of bright noise ahead of the
  //    strike, so the thud lands on something rather than out of nothing.
  const rustle = context.createBufferSource();
  rustle.buffer = paperBuffer(context);
  const rustleFilter = context.createBiquadFilter();
  rustleFilter.type = 'bandpass';
  rustleFilter.frequency.value = 2600;
  rustleFilter.Q.value = 0.7;
  const rustleGain = context.createGain();
  rustleGain.gain.setValueAtTime(0.0001, now);
  rustleGain.gain.exponentialRampToValueAtTime(0.16, now + 0.004);
  rustleGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.012);
  rustle.connect(rustleFilter).connect(rustleGain).connect(bus);
  rustle.start(now);
  rustle.stop(now + 0.06);

  const struck = now + 0.012;

  // 2. The thud: a low sine dropping a fourth as it decays, which is what a
  //    weight landing on a desk does.
  const body = context.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(96, struck);
  body.frequency.exponentialRampToValueAtTime(58, struck + 0.09);
  const bodyGain = context.createGain();
  bodyGain.gain.setValueAtTime(0.0001, struck);
  bodyGain.gain.exponentialRampToValueAtTime(0.5, struck + 0.006);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, struck + 0.22);
  body.connect(bodyGain).connect(bus);
  body.start(struck);
  body.stop(struck + 0.26);

  // 3. The contact: a short mid click so the thud has an edge and does not
  //    read as a drum.
  const knock = context.createBufferSource();
  knock.buffer = paperBuffer(context);
  const knockFilter = context.createBiquadFilter();
  knockFilter.type = 'lowpass';
  knockFilter.frequency.value = 900;
  const knockGain = context.createGain();
  knockGain.gain.setValueAtTime(0.0001, struck);
  knockGain.gain.exponentialRampToValueAtTime(0.22, struck + 0.003);
  knockGain.gain.exponentialRampToValueAtTime(0.0001, struck + 0.05);
  knock.connect(knockFilter).connect(knockGain).connect(bus);
  knock.start(struck);
  knock.stop(struck + 0.08);
}
