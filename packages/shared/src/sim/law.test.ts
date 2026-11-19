import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { berthRefusesPosted, compositionForDamage, compositionForWriteOff } from './law.ts';

const { law } = content().tuning;

/**
 * Spec section 19 and the M3 security rules: attacking lawful traffic in the
 * Home Roads gets you posted, the Concessions barely notice, and the Marque
 * is nobody's. These tests pin that ordering to the shipped data, so a tuning
 * change that inverts it fails here rather than in play.
 */
describe('the Prize Court', () => {
  it('charges most where law reaches and nothing where it does not', () => {
    const secured = compositionForDamage(100, 'secured', law);
    const contested = compositionForDamage(100, 'contested', law);
    const lawless = compositionForDamage(100, 'lawless', law);

    expect(secured).toBeGreaterThan(contested);
    expect(contested).toBeGreaterThan(0);
    expect(lawless).toBe(0);
  });

  it('strikes a composition in whole marks', () => {
    for (const lost of [1, 3, 7, 13, 97]) {
      const struck = compositionForDamage(lost, 'contested', law);
      expect(Number.isInteger(struck)).toBe(true);
    }
  });

  it('charges nothing for a hit that took no structure', () => {
    expect(compositionForDamage(0, 'secured', law)).toBe(0);
    expect(compositionForDamage(-5, 'secured', law)).toBe(0);
  });

  it('treats writing a hull off as a heavier matter than damaging it', () => {
    // A hull written off costs more than a hull merely shot at, whatever the
    // damage: otherwise the cheapest way out of a fight would be to finish it.
    expect(compositionForWriteOff('secured', law)).toBeGreaterThan(
      compositionForDamage(100, 'secured', law),
    );
    expect(compositionForWriteOff('lawless', law)).toBe(0);
  });

  it('closes the Home Roads to a posted captain and nowhere else', () => {
    expect(berthRefusesPosted('secured', law)).toBe(true);
    expect(berthRefusesPosted('contested', law)).toBe(false);
    expect(berthRefusesPosted('lawless', law)).toBe(false);
  });

  it('leaves a posted captain somewhere to pay', () => {
    // Every berth refusing them would strand a captain with no way to settle,
    // so at least one security level has to keep taking their money.
    const levels = ['secured', 'contested', 'lawless'] as const;
    const open = levels.filter((level) => !berthRefusesPosted(level, law));
    expect(open.length).toBeGreaterThan(0);
  });
});
