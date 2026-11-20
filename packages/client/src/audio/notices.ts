/**
 * Notices: the sounds that are not a fight and not a stamp.
 *
 * A party coming aboard a prize, the Hall settling a claim, an order the
 * Bourse carried out while the captain was somewhere else, and a position it
 * closed for them. Each one is a thing that happens *to* a captain rather
 * than something they pressed, so each gets a sound of its own on the
 * interface bus — the feedback table asks for two channels out of visual,
 * audio and motion, and a notice a captain is not looking at has only one.
 *
 * Synthesised like everything else here, and deliberately short: these can
 * land in the middle of a fight.
 */

import { sharedMix } from './shared.ts';

export type Notice = 'boarded' | 'claim' | 'filled' | 'called';

/** Noise for the textures, made once. */
let grain: AudioBuffer | undefined;

function grainBuffer(context: AudioContext): AudioBuffer {
  if (grain && grain.sampleRate === context.sampleRate) return grain;
  const length = Math.round(context.sampleRate * 0.4);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x6d2b79f5;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  grain = buffer;
  return buffer;
}

export function playNotice(notice: Notice): void {
  let mix;
  try {
    mix = sharedMix();
  } catch {
    return;
  }

  const context = mix.context;
  void mix.unlock();
  const bus = mix.busFor('interface');
  const now = context.currentTime;

  /** A short tone at `hz`, starting at `at`, over `length`. */
  const tone = (hz: number, at: number, length: number, level: number, type: OscillatorType = 'sine'): void => {
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, at);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(bus);
    osc.start(at);
    osc.stop(at + length + 0.02);
  };

  /** Filtered noise, for the things that are not tones. */
  const texture = (at: number, length: number, hz: number, level: number, q = 0.8): void => {
    const source = context.createBufferSource();
    source.buffer = grainBuffer(context);
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hz;
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(filter).connect(gain).connect(bus);
    source.start(at);
    source.stop(at + length + 0.05);
  };

  switch (notice) {
    case 'boarded':
      // A hatch, boots on a deck, and a crate going down: three events in
      // two hundred milliseconds, which is what boarding sounds like from
      // the other hull's bridge.
      texture(now, 0.07, 420, 0.22, 1.4);
      texture(now + 0.08, 0.05, 1500, 0.1, 2);
      tone(74, now + 0.16, 0.14, 0.34);
      texture(now + 0.16, 0.08, 260, 0.16, 1.1);
      return;

    case 'claim':
      // Paper, and one low tone. The Hall does not celebrate.
      texture(now, 0.09, 2300, 0.12, 0.7);
      tone(146, now + 0.05, 0.4, 0.22, 'triangle');
      return;

    case 'filled':
      // A crisp click and a note up: an order carried out is good news and
      // is allowed to sound like it, briefly.
      texture(now, 0.02, 2600, 0.14, 1.6);
      tone(660, now + 0.01, 0.07, 0.17);
      tone(880, now + 0.06, 0.1, 0.14);
      return;

    case 'called':
      // Two tones down, and no thud: a position closed out is not an order
      // the captain gave, and it should not sound like one.
      tone(392, now, 0.12, 0.22, 'triangle');
      tone(294, now + 0.1, 0.22, 0.2, 'triangle');
      return;
  }
}
