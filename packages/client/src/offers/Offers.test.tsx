/**
 * The offers counter's arithmetic and wording.
 *
 * Only the pure parts: what a parcel list comes to, whether an offer can be
 * met out of this hold and purse, how a standing offer reads from each side of
 * it, the marks-after figure, and how long an offer has been standing. The
 * markup is judged from a capture, not from assertions.
 */

import { describe, expect, it } from 'vitest';

import type { TradeOfferLine } from '@marque/shared';

import {
  formatMarks,
  parcelsOf,
  purseAfter,
  readOffer,
  signedMarks,
  sinceLabel,
  surveyOffer,
  totalUnits,
  unitsPhrase,
  type Draft,
  type HoldLine,
} from './Offers.tsx';

const HOLD: readonly HoldLine[] = [
  { commodityId: 'leaf', name: 'Leaf', units: 40 },
  { commodityId: 'ore', name: 'Ore', units: 18 },
  { commodityId: 'ice', name: 'Ice', units: 1 },
];

/** A draft of an offer, defaulted to one that is sound. */
function drafted(overrides: Partial<Draft> = {}): Draft {
  return {
    callsign: 'Prudent Return',
    marks: 1_200,
    cargo: [{ commodityId: 'leaf', units: 12 }],
    design: '',
    ...overrides,
  };
}

/** An offer as the server pushes it. */
function offered(overrides: Partial<TradeOfferLine> = {}): TradeOfferLine {
  return {
    id: 'offer-1',
    from: 'Net of Fees',
    to: 'Prudent Return',
    mine: true,
    marks: 1_200,
    cargo: [{ commodityId: 'leaf', name: 'Leaf', units: 12 }],
    designName: '',
    offeredAt: 1_000_000,
    ...overrides,
  };
}

describe('parcelsOf', () => {
  it('keeps the hold order and drops what was not picked', () => {
    expect(parcelsOf({ ore: 4, leaf: 12 }, HOLD)).toEqual([
      { commodityId: 'leaf', name: 'Leaf', units: 12 },
      { commodityId: 'ore', name: 'Ore', units: 4 },
    ]);
  });

  it('clamps a parcel to what is aboard', () => {
    expect(parcelsOf({ leaf: 500 }, HOLD)).toEqual([
      { commodityId: 'leaf', name: 'Leaf', units: 40 },
    ]);
  });

  // The hold moves under this screen: a captain can sell at the Staple in
  // another window between picking a parcel and sending it.
  it('drops a good the hold no longer carries', () => {
    expect(parcelsOf({ leaf: 12 }, [{ commodityId: 'ore', name: 'Ore', units: 5 }])).toEqual(
      [],
    );
  });

  it('never carries a fraction or a negative into an offer', () => {
    expect(parcelsOf({ leaf: 2.7, ore: -4 }, HOLD)).toEqual([
      { commodityId: 'leaf', name: 'Leaf', units: 2 },
    ]);
  });
});

describe('totalUnits', () => {
  it('totals a parcel list', () => {
    expect(totalUnits(parcelsOf({ leaf: 12, ore: 4, ice: 1 }, HOLD))).toBe(17);
  });

  it('is nothing when nothing is picked', () => {
    expect(totalUnits(parcelsOf({}, HOLD))).toBe(0);
  });
});

describe('surveyOffer', () => {
  it('passes an offer the hold and purse can meet', () => {
    const survey = surveyOffer(drafted(), HOLD, 5_000);
    expect(survey.ok).toBe(true);
    expect(survey.reason).toBeUndefined();
  });

  it('refuses an offer with nobody to hand it to', () => {
    expect(surveyOffer(drafted({ callsign: '' }), HOLD, 5_000).fault).toBe('no-captain');
  });

  it('refuses more units than are aboard, and names the figure', () => {
    const survey = surveyOffer(
      drafted({ cargo: [{ commodityId: 'ore', units: 30 }] }),
      HOLD,
      5_000,
    );
    expect(survey.ok).toBe(false);
    expect(survey.fault).toBe('short-cargo');
    expect(survey.reason).toBe('You are carrying 18 units of Ore, not 30.');
  });

  it('counts a single unit as a unit', () => {
    const survey = surveyOffer(
      drafted({ cargo: [{ commodityId: 'ice', units: 4 }] }),
      HOLD,
      5_000,
    );
    expect(survey.reason).toBe('You are carrying 1 unit of Ice, not 4.');
  });

  it('refuses a good the hold does not carry at all', () => {
    const survey = surveyOffer(
      drafted({ cargo: [{ commodityId: 'grain', units: 2 }] }),
      HOLD,
      5_000,
    );
    expect(survey.fault).toBe('short-cargo');
    expect(survey.reason).toBe('You are carrying 0 units of grain, not 2.');
  });

  // Negative marks are the offering captain paying, so the purse is the bound.
  it('refuses marks the purse cannot promise', () => {
    const survey = surveyOffer(drafted({ marks: -9_000 }), HOLD, 4_200);
    expect(survey.fault).toBe('short-marks');
    expect(survey.reason).toBe('You hold 4,200 marks and cannot promise 9,000.');
  });

  it('allows paying exactly what the purse holds', () => {
    expect(surveyOffer(drafted({ marks: -4_200 }), HOLD, 4_200).ok).toBe(true);
  });

  it('refuses an offer with nothing in it', () => {
    const survey = surveyOffer(drafted({ cargo: [], marks: 0 }), HOLD, 5_000);
    expect(survey.fault).toBe('nothing-offered');
  });

  // Goods for nothing is a gift, and nothing for marks is asking to be paid.
  // Both are offers somebody might mean to make.
  it('allows a gift and allows asking for marks', () => {
    expect(surveyOffer(drafted({ marks: 0 }), HOLD, 5_000).ok).toBe(true);
    expect(surveyOffer(drafted({ cargo: [] }), HOLD, 5_000).ok).toBe(true);
  });

  it('allows a draught on its own', () => {
    expect(
      surveyOffer(drafted({ cargo: [], marks: 0, design: 'draught-7' }), HOLD, 5_000).ok,
    ).toBe(true);
  });

  it('reports the cargo fault ahead of the marks fault', () => {
    const survey = surveyOffer(
      drafted({ cargo: [{ commodityId: 'ore', units: 30 }], marks: -9_000 }),
      HOLD,
      10,
    );
    expect(survey.fault).toBe('short-cargo');
  });
});

describe('purseAfter', () => {
  it('pays the offering captain the price', () => {
    expect(purseAfter(5_000, 1_200, 'offering')).toBe(6_200);
  });

  it('charges the receiving captain the price', () => {
    expect(purseAfter(5_000, 1_200, 'receiving')).toBe(3_800);
  });

  it('turns both ways round when the offerer is the one paying', () => {
    expect(purseAfter(5_000, -1_200, 'offering')).toBe(3_800);
    expect(purseAfter(5_000, -1_200, 'receiving')).toBe(6_200);
  });

  it('leaves the purse alone for a gift', () => {
    expect(purseAfter(5_000, 0, 'offering')).toBe(5_000);
  });

  it('never lands on a fraction', () => {
    expect(Number.isInteger(purseAfter(5_000.4, 1_200.3, 'offering'))).toBe(true);
  });
});

describe('readOffer', () => {
  it('reads one of this captain’s own offers outward', () => {
    const reading = readOffer(offered());
    expect(reading.inbound).toBe(false);
    expect(reading.counterparty).toBe('Prudent Return');
    expect(reading.opening).toBe('You are offering Prudent Return');
    expect(reading.goods).toEqual(['12 units of Leaf']);
    expect(reading.payLabel).toBe('You are paid');
    expect(reading.payFigure).toBe(1_200);
  });

  it('reads the same offer inward from the other seat', () => {
    const reading = readOffer(offered({ mine: false }));
    expect(reading.inbound).toBe(true);
    expect(reading.counterparty).toBe('Net of Fees');
    expect(reading.opening).toBe('Net of Fees is offering you');
    expect(reading.payLabel).toBe('You pay');
    expect(reading.payFigure).toBe(1_200);
  });

  // A negative price is the offering captain paying, so the labels swap.
  it('swaps who pays when the price runs the other way', () => {
    expect(readOffer(offered({ marks: -800 })).payLabel).toBe('You pay');
    expect(readOffer(offered({ marks: -800 })).payFigure).toBe(800);
    expect(readOffer(offered({ mine: false, marks: -800 })).payLabel).toBe('You are paid');
  });

  it('says so plainly when no marks change hands', () => {
    expect(readOffer(offered({ marks: 0 })).payLabel).toBe('No marks either way');
    expect(readOffer(offered({ mine: false, marks: 0 })).payLabel).toBe(
      'No marks either way',
    );
  });

  it('lists a draught after the cargo', () => {
    expect(readOffer(offered({ designName: 'Fair Wear and Tear' })).goods).toEqual([
      '12 units of Leaf',
      'the draught Fair Wear and Tear',
    ]);
  });

  it('carries no goods for an offer that is only marks', () => {
    expect(readOffer(offered({ cargo: [], designName: '' })).goods).toEqual([]);
  });
});

describe('unitsPhrase', () => {
  it('counts units and the one unit', () => {
    expect(unitsPhrase(12, 'Leaf')).toBe('12 units of Leaf');
    expect(unitsPhrase(1, 'Ice')).toBe('1 unit of Ice');
    expect(unitsPhrase(0, 'Ore')).toBe('0 units of Ore');
  });
});

describe('formatMarks and signedMarks', () => {
  it('never prints a fraction', () => {
    expect(formatMarks(1_200.6)).toBe('1,201');
    expect(signedMarks(-1_200.4)).toBe('-1,200');
  });

  it('signs a figure so the direction survives without colour', () => {
    expect(signedMarks(1_200)).toBe('+1,200');
    expect(signedMarks(-1_200)).toBe('-1,200');
    expect(signedMarks(0)).toBe('0');
  });
});

describe('sinceLabel', () => {
  // Seconds matter: an offer is a live negotiation with somebody standing at
  // the same berth, and ten seconds reads very differently from fifty.
  it('counts the first minute in seconds', () => {
    expect(sinceLabel(0)).toBe('just now');
    expect(sinceLabel(9_000)).toBe('just now');
    expect(sinceLabel(12_000)).toBe('12s ago');
    expect(sinceLabel(59_900)).toBe('59s ago');
  });

  it('floors rather than rounds, so it never claims time that has not passed', () => {
    expect(sinceLabel(119_000)).toBe('1m ago');
    expect(sinceLabel(120_000)).toBe('2m ago');
  });

  it('steps up to hours and days', () => {
    expect(sinceLabel(60 * 60_000)).toBe('1h ago');
    expect(sinceLabel(23 * 60 * 60_000)).toBe('23h ago');
    expect(sinceLabel(25 * 60 * 60_000)).toBe('1d ago');
  });

  // A client clock behind the server's would otherwise print a negative age.
  it('treats a clock running backwards as just now', () => {
    expect(sinceLabel(-5_000)).toBe('just now');
  });
});
