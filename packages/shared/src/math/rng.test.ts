import { describe, expect, it } from 'vitest';

import { hashSeed, Rng } from './rng.ts';

describe('Rng', () => {
  it('reproduces the same sequence from the same seed', () => {
    const a = new Rng('world-42');
    const b = new Rng('world-42');
    const left = Array.from({ length: 50 }, () => a.next());
    const right = Array.from({ length: 50 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('gives different sequences for different seeds', () => {
    const a = new Rng('world-42');
    const b = new Rng('world-43');
    expect(a.next()).not.toBe(b.next());
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('covers both ends of an integer range', () => {
    const rng = new Rng('ints');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(rng.int(-1, 1));
    expect([...seen].sort()).toEqual([-1, 0, 1]);
  });

  it('shuffles deterministically and keeps every element', () => {
    const source = Array.from({ length: 20 }, (_, i) => i);
    const a = new Rng('shuffle').shuffle([...source]);
    const b = new Rng('shuffle').shuffle([...source]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(source);
  });

  it('hashes seeds stably', () => {
    expect(hashSeed('Thresher')).toBe(hashSeed('Thresher'));
    expect(hashSeed('Thresher')).not.toBe(hashSeed('thresher'));
  });

  it('spreads low-entropy seeds', () => {
    // Adjacent numeric seeds must not produce correlated first draws.
    const first = Array.from({ length: 8 }, (_, i) => new Rng(i).next());
    const unique = new Set(first.map((v) => Math.floor(v * 16)));
    expect(unique.size).toBeGreaterThan(3);
  });
});
