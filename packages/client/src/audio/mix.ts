/**
 * The audio mix.
 *
 * Four buses — master, music, effects and interface — each with its own volume
 * setting, as the spec requires. Everything is synthesised in Web Audio:
 * openly licensed audio sources are not reachable from the build environment
 * (see `docs/HUMAN_TODO.md`), and the spec's stated fallback is to make it in
 * code.
 *
 * Browsers will not start audio without a gesture, so the context is created
 * lazily and resumed on the first input.
 */

export type BusName = 'music' | 'effects' | 'interface';

export interface Volumes {
  readonly master: number;
  readonly music: number;
  readonly effects: number;
  readonly interface: number;
}

export const DEFAULT_VOLUMES: Volumes = {
  master: 0.7,
  music: 0.5,
  effects: 0.8,
  interface: 0.6,
};

export class AudioMix {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly buses: Record<BusName, GainNode>;
  private volumes: Volumes = DEFAULT_VOLUMES;

  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });

    this.master = this.context.createGain();
    this.master.gain.value = DEFAULT_VOLUMES.master;
    this.master.connect(this.context.destination);

    const bus = (level: number): GainNode => {
      const node = this.context.createGain();
      node.gain.value = level;
      node.connect(this.master);
      return node;
    };

    this.buses = {
      music: bus(DEFAULT_VOLUMES.music),
      effects: bus(DEFAULT_VOLUMES.effects),
      interface: bus(DEFAULT_VOLUMES.interface),
    };
  }

  /** The node a sound should connect to. */
  busFor(name: BusName): GainNode {
    return this.buses[name];
  }

  setVolumes(volumes: Partial<Volumes>): void {
    this.volumes = { ...this.volumes, ...volumes };
    const now = this.context.currentTime;
    // Ramp rather than jump: a volume slider should not click.
    this.master.gain.setTargetAtTime(this.volumes.master, now, 0.02);
    this.buses.music.gain.setTargetAtTime(this.volumes.music, now, 0.02);
    this.buses.effects.gain.setTargetAtTime(this.volumes.effects, now, 0.02);
    this.buses.interface.gain.setTargetAtTime(this.volumes.interface, now, 0.02);
  }

  get currentVolumes(): Volumes {
    return this.volumes;
  }

  /**
   * Resume the context. Browsers block audio until a gesture, so this is
   * called from the first key press rather than at startup.
   */
  async unlock(): Promise<void> {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  get running(): boolean {
    return this.context.state === 'running';
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/**
 * A looping noise buffer.
 *
 * Shared by the engine and, later, by hull-impact and shield sounds. Generated
 * once: a couple of seconds of noise is enough to loop without an audible
 * period.
 */
export function createNoiseBuffer(context: AudioContext, seconds = 2): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  // Brown-ish noise: integrating white noise puts the energy low, which is
  // what an engine sounds like. Plain white noise reads as static.
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }

  // Taper the seam so the loop point is inaudible.
  const fade = Math.min(2000, Math.floor(length / 20));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] = data[i]! * t;
    data[length - 1 - i] = data[length - 1 - i]! * t;
  }

  return buffer;
}
