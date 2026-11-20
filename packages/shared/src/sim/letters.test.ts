import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';
import { openingStandings, shiftStanding, type Charter } from './standing.ts';

import {
  contrabandIn,
  isContraband,
  letterLapsed,
  mayHoldLetter,
  monopolyHolder,
  prizePremium,
  raidIsLawful,
} from './letters.ts';

const { tuning } = content();

/** A captain well in with one charter and therefore out with the others. */
function favouredBy(charter: Charter): Record<Charter, number> {
  return shiftStanding(openingStandings(tuning), charter, 500, tuning);
}

describe('monopoly goods', () => {
  it('knows who holds what', () => {
    expect(monopolyHolder('leaf', tuning)).toBe('kessler');
    expect(monopolyHolder('alloy', tuning)).toBe('thirty');
    expect(monopolyHolder('ordnance', tuning)).toBe('reprisal');
  });

  it('leaves every other good alone, everywhere', () => {
    // Spec section 19: there are no other illegal goods. Worth asserting,
    // because a second contraband rule is the kind of thing that creeps in.
    const standings = openingStandings(tuning);
    for (const commodity of content().commodities.keys()) {
      if (monopolyHolder(commodity, tuning) !== undefined) continue;
      for (const region of ['home-roads', 'concessions', 'marque']) {
        expect(isContraband(commodity, region, standings, tuning)).toBe(false);
      }
    }
  });

  it('binds only in the Home Roads', () => {
    const standings = openingStandings(tuning);
    expect(isContraband('leaf', 'home-roads', standings, tuning)).toBe(true);
    expect(isContraband('leaf', 'concessions', standings, tuning)).toBe(false);
    expect(isContraband('leaf', 'marque', standings, tuning)).toBe(false);
  });

  it('is not smuggling for a captain the holder trusts', () => {
    expect(isContraband('leaf', 'home-roads', favouredBy('kessler'), tuning)).toBe(false);
    // But their standing with Kessler does not licence the Thirty's alloy.
    expect(isContraband('alloy', 'home-roads', favouredBy('kessler'), tuning)).toBe(true);
  });

  it('finds everything in a hold a patrol would take', () => {
    const hold = new Map([
      ['leaf', 20],
      ['alloy', 5],
      ['grain', 100],
      ['ice', 0],
    ]);
    const found = contrabandIn(hold, 'home-roads', openingStandings(tuning), tuning);
    expect(found.map((row) => row.commodityId).sort()).toEqual(['alloy', 'leaf']);
    expect(found.find((row) => row.commodityId === 'leaf')?.holder).toBe('kessler');

    // Nothing at all outside the Home Roads.
    expect(contrabandIn(hold, 'marque', openingStandings(tuning), tuning)).toHaveLength(0);
  });
});

describe('letters of marque', () => {
  it('is issued only to a captain the charter already trusts', () => {
    expect(mayHoldLetter(0, tuning)).toBe(false);
    expect(mayHoldLetter(tuning.letters.requiresStanding, tuning)).toBe(true);
  });

  it('lapses when the issuer stops trusting the holder', () => {
    expect(letterLapsed(tuning.letters.requiresStanding, tuning)).toBe(false);
    expect(letterLapsed(tuning.letters.lapsesBelow - 1, tuning)).toBe(true);
    // There is room between being issued one and losing it, or it would
    // lapse on the day it was bought.
    expect(tuning.letters.lapsesBelow).toBeLessThan(tuning.letters.requiresStanding);
  });

  it('licenses the other two charters, outside the Home Roads only', () => {
    expect(raidIsLawful('reprisal', 'kessler', 'marque')).toBe(true);
    expect(raidIsLawful('reprisal', 'thirty', 'concessions')).toBe(true);
    // Not the issuer.
    expect(raidIsLawful('reprisal', 'reprisal', 'marque')).toBe(false);
    // Not in the Home Roads, where all three answer to the same courts.
    expect(raidIsLawful('reprisal', 'kessler', 'home-roads')).toBe(false);
    // And not at all without one.
    expect(raidIsLawful(undefined, 'kessler', 'marque')).toBe(false);
  });

  it('pays a premium on prize cargo at the issuer, and nowhere else', () => {
    expect(prizePremium('kessler', 'kessler', tuning)).toBeCloseTo(tuning.letters.prizePremium, 6);
    expect(prizePremium('kessler', 'thirty', tuning)).toBe(0);
    expect(prizePremium('kessler', 'neutral', tuning)).toBe(0);
    expect(prizePremium(undefined, 'kessler', tuning)).toBe(0);
  });

  it('a capture staged between friends loses money', () => {
    // Spec section 19 turns on this: a destroyed hull spills half its hold,
    // so the pair are down half the cargo and up only the premium on what
    // was scooped. The premium has to stay well under that half or the whole
    // arrangement is a mint.
    const spilled = 0.5;
    const recovered = spilled * (1 + tuning.letters.prizePremium);
    expect(recovered).toBeLessThan(1);
    expect(tuning.letters.prizePremium).toBeLessThan(spilled);
  });
});
