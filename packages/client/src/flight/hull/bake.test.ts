import { describe, expect, it } from 'vitest';
import { boundsOf, content, placeAll, type Blueprint } from '@marque/shared';

import { LOFT_TESTS } from '../hullSheetTests.ts';
import { bakeHull, LIVERY_SHARE } from './bake.ts';

/** Coarser than the game's bake, so the suite stays quick; the rules do not depend on it. */
const PX = 24;

const { blueprints, modules } = content();
const hulls: Blueprint[] = [...blueprints.values(), ...LOFT_TESTS];

describe('bakeHull', () => {
  it('is deterministic in the blueprint', () => {
    const blueprint = blueprints.get('force-majeure')!;
    const a = bakeHull(blueprint, modules, PX);
    const b = bakeHull(blueprint, modules, PX);
    expect(Buffer.from(a.base).equals(Buffer.from(b.base))).toBe(true);
    expect(Buffer.from(a.shape).equals(Buffer.from(b.shape))).toBe(true);
    expect(Buffer.from(a.paint).equals(Buffer.from(b.paint))).toBe(true);
    expect(a.registry).toBe(b.registry);
  });

  for (const blueprint of hulls) {
    describe(blueprint.id, () => {
      const bake = bakeHull(blueprint, modules, PX);
      const placed = placeAll(blueprint.placements, modules);
      const bounds = boundsOf(placed);
      const coverAt = (px: number, py: number): number => bake.base[(py * bake.width + px) * 4 + 3]! / 255;

      it('sizes its maps to the grid and its margin', () => {
        expect(bake.width).toBeGreaterThan(bounds.width * PX);
        expect(bake.height).toBeGreaterThan(bounds.height * PX);
        for (const map of [bake.base, bake.shape, bake.paint]) {
          expect(map.length).toBe(bake.width * bake.height * 4);
        }
      });

      it('throws no cell away: hits resolve on the grid, so every cell is drawn', () => {
        for (const module of placed) {
          for (let dx = 0; dx < module.width; dx++) {
            for (let dy = 0; dy < module.height; dy++) {
              const x0 = Math.round(bake.originX + (module.placement.x + dx) * PX);
              const y0 = Math.round(bake.originY + (module.placement.y + dy) * PX);
              let covered = 0;
              for (let py = y0; py < y0 + PX; py++) {
                for (let px = x0; px < x0 + PX; px++) covered += coverAt(px, py);
              }
              const share = covered / (PX * PX);
              expect(share, `${module.def.id} at ${module.placement.x + dx},${module.placement.y + dy}`).toBeGreaterThan(0.3);
            }
          }
        }
      });

      it('stands only a little proud of its cells', () => {
        let drawn = 0;
        for (let i = 3; i < bake.base.length; i += 4) drawn += bake.base[i]! / 255;
        const cells = placed.reduce((sum, module) => sum + module.width * module.height, 0);
        // Nozzles, barrels and fairings stand out past the grid; chamfers and
        // the prow cut into it. Neither by much.
        expect(drawn / (cells * PX * PX)).toBeGreaterThan(0.75);
        expect(drawn / (cells * PX * PX)).toBeLessThan(1.6);
      });

      it('paints livery over about a fifth of the hull, never a flood', () => {
        expect(bake.liveryShare).toBeGreaterThan(LIVERY_SHARE - 0.06);
        expect(bake.liveryShare).toBeLessThan(LIVERY_SHARE + 0.06);
      });

      it('gives every engine a nozzle per bell', () => {
        const bells = placed
          .filter((module) => module.def.type === 'engine')
          .reduce((sum, module) => sum + Math.max(1, Math.min(3, Math.round(module.height))), 0);
        expect(bake.nozzles).toHaveLength(bells);
      });

      it('carries a registry number in the stencil', () => {
        expect(bake.registry).toMatch(/^(OT|FW|CW|CC) \d{4}$/);
      });

      it('keeps every dot of the registry it painted', () => {
        // Something painted after the stencil — the seal's bare disc once —
        // must not eat into it. Measured at the game's own bake size, where
        // a dot is more than a pixel across.
        const full = bakeHull(blueprint, modules);
        const box = full.registryBox;
        if (box === undefined) return;
        let inked = 0;
        for (let py = Math.floor(box.y); py < Math.ceil(box.y + box.height); py++) {
          for (let px = Math.floor(box.x); px < Math.ceil(box.x + box.width); px++) {
            inked += full.paint[(py * full.width + px) * 4 + 3]! / 255;
          }
        }
        const dotArea = (box.width / (Math.round(box.width / (box.height / 7)))) ** 2;
        expect(inked / (box.dots * dotArea)).toBeGreaterThan(0.85);
      });
    });
  }
});
