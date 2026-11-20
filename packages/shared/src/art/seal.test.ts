import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { DEVICES, POINTS, sealGeometry, sealOf } from './seal.ts';

describe('seals', () => {
  it('strikes the same mark for an issuer every time', () => {
    expect(sealOf('kessler')).toEqual(sealOf('kessler'));
    expect(sealGeometry(sealOf('kessler'))).toEqual(sealGeometry(sealOf('kessler')));
  });

  it('and a different one for a different issuer', () => {
    const marks = new Set(
      ['kessler', 'thirty', 'reprisal', 'prize-court', 'unlettered'].map((id) =>
        JSON.stringify(sealOf(id)),
      ),
    );
    expect(marks.size).toBe(5);
  });

  it('gives every company and charter a mark of its own', () => {
    const { companies } = content();
    const ids = [...companies.keys(), 'kessler', 'thirty', 'reprisal'];
    const marks = new Set(ids.map((id) => JSON.stringify(sealOf(id))));
    // A collision would mean two institutions striking the same seal, which
    // is the one thing a seal may not do.
    expect(marks.size).toBe(ids.length);
  });

  it('builds every device out of the shapes the art direction names', () => {
    for (const id of ['kessler', 'thirty', 'reprisal', 'KSC', 'UWH', 'SLP']) {
      expect(DEVICES).toContain(sealOf(id).device);
    }
  });

  it('repeats a device only in ways that close on themselves', () => {
    for (let i = 0; i < 200; i++) {
      const design = sealOf(`issuer-${i}`);
      expect(POINTS % design.repeats).toBe(0);
      // Never a single shape: one device off the centre reads as an
      // accident rather than as a die somebody cut.
      expect(design.repeats).toBeGreaterThan(1);
      expect(sealGeometry(design).paths).toHaveLength(design.repeats);
    }
  });

  it('keeps every line inside the rim', () => {
    for (let i = 0; i < 200; i++) {
      const geometry = sealGeometry(sealOf(`issuer-${i}`));
      for (const path of geometry.paths) {
        for (const point of path.points) {
          expect(Math.hypot(point.x, point.y)).toBeLessThan(1);
        }
      }
      for (const ring of geometry.rings) expect(ring).toBeLessThan(1);
      for (const tick of geometry.ticks) expect(tick.to).toBeLessThanOrEqual(1);
    }
  });

  it('and leaves the centre clear, because a seal carries no monogram', () => {
    for (let i = 0; i < 200; i++) {
      const geometry = sealGeometry(sealOf(`issuer-${i}`));
      const nearest = Math.min(
        ...geometry.paths.flatMap((path) =>
          path.points.map((point) => Math.hypot(point.x, point.y)),
        ),
      );
      // Something is always struck away from dead centre: a device drawn
      // through the middle would read as a glyph.
      expect(nearest).toBeGreaterThan(0.02);
    }
  });

  it('draws a device large enough to read and small enough not to crowd the rim', () => {
    for (let i = 0; i < 200; i++) {
      const design = sealOf(`issuer-${i}`);
      expect(design.reach).toBeGreaterThanOrEqual(0.52);
      expect(design.reach).toBeLessThanOrEqual(0.74);
    }
  });
});
