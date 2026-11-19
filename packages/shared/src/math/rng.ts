/**
 * Seeded pseudo-random generators.
 *
 * Simulation and economy code never calls `Math.random()`: every random draw
 * comes from one of these, seeded from world state, so a soak run at
 * accelerated time reproduces exactly.
 */

/** Hash a string into a 32-bit seed. Stable across runs and platforms. */
export function hashSeed(text: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * sfc32: small, fast, and good enough for gameplay. Period is at least 2^32,
 * which is ample for per-entity and per-tick draws.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
    // Spread one 32-bit seed across the four words.
    this.a = (s ^ 0x9e3779b9) >>> 0;
    this.b = (Math.imul(s, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0;
    this.c = (Math.imul(s ^ 0x27d4eb2f, 0x165667b1) ^ 0x9e3779b9) >>> 0;
    this.d = (s + 0x6d2b79f5) >>> 0;
    // Discard a few rounds so low-entropy seeds decorrelate.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.d = (this.d + 1) >>> 0;
    const next = (t + this.d) >>> 0;
    this.c = (this.c + next) >>> 0;
    return next;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x100000000;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = items[i]!;
      const b = items[j]!;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }
}
