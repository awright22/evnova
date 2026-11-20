import { describe, expect, it } from 'vitest';

import { content } from '../content/load.ts';

import {
  CHARTERS,
  berthAccepts,
  decayStanding,
  isCharter,
  openingStandings,
  shiftStanding,
  standingDiscount,
  standingName,
} from './standing.ts';

const { tuning } = content();

describe('company standing', () => {
  it('opens a captain as nobody in particular', () => {
    const opening = openingStandings(tuning);
    for (const charter of CHARTERS) expect(opening[charter]).toBe(tuning.standing.opening);
    expect(standingName(opening.kessler, tuning)).toBe('Unknown');
  });

  it('a gain with one charter is a loss with the others', () => {
    const after = shiftStanding(openingStandings(tuning), 'kessler', 100, tuning);
    expect(after.kessler).toBe(100);
    expect(after.thirty).toBeLessThan(0);
    expect(after.reprisal).toBeLessThan(0);
    // And the rivals lose less than the friend gains, or taking a side would
    // be strictly worse than doing nothing.
    expect(Math.abs(after.thirty)).toBeLessThan(after.kessler);
  });

  it('and a loss with one is a small gain with the others', () => {
    const after = shiftStanding(openingStandings(tuning), 'reprisal', -200, tuning);
    expect(after.reprisal).toBe(-200);
    expect(after.kessler).toBeGreaterThan(0);
    expect(after.thirty).toBeGreaterThan(0);
  });

  it('never leaves the band, however hard it is pushed', () => {
    let standings = openingStandings(tuning);
    for (let i = 0; i < 200; i++) standings = shiftStanding(standings, 'thirty', 500, tuning);
    expect(standings.thirty).toBe(tuning.standing.ceiling);
    expect(standings.kessler).toBe(tuning.standing.floor);

    for (let i = 0; i < 400; i++) standings = shiftStanding(standings, 'thirty', -500, tuning);
    expect(standings.thirty).toBe(tuning.standing.floor);
  });

  it('there is no standing in which every company is pleased', () => {
    // The whole point of three charters. Work at it however long you like.
    let standings = openingStandings(tuning);
    for (let i = 0; i < 300; i++) {
      for (const charter of CHARTERS) standings = shiftStanding(standings, charter, 40, tuning);
    }
    const liked = CHARTERS.filter((charter) => standings[charter] > tuning.standing.discountAbove);
    expect(liked.length).toBeLessThan(3);
  });

  it('drifts back toward nothing when a captain stops dealing', () => {
    const friendly = shiftStanding(openingStandings(tuning), 'kessler', 600, tuning);
    const later = decayStanding(friendly, 24 * 30, tuning);
    expect(later.kessler).toBeLessThan(friendly.kessler);
    expect(later.kessler).toBeGreaterThanOrEqual(0);
    // A grudge fades the same way.
    expect(later.thirty).toBeLessThanOrEqual(0);
    expect(later.thirty).toBeGreaterThan(friendly.thirty);
  });

  it('never decays past nothing, however long it is left', () => {
    let standings = shiftStanding(openingStandings(tuning), 'reprisal', 800, tuning);
    for (let i = 0; i < 500; i++) standings = decayStanding(standings, 24, tuning);
    for (const charter of CHARTERS) expect(standings[charter]).toBe(0);
  });

  it('closes a berth to a captain far enough out of favour', () => {
    expect(berthAccepts(0, tuning)).toBe(true);
    expect(berthAccepts(tuning.standing.refusedBelow + 1, tuning)).toBe(true);
    expect(berthAccepts(tuning.standing.refusedBelow, tuning)).toBe(false);
    expect(berthAccepts(tuning.standing.floor, tuning)).toBe(false);
  });

  it('pays a regular something off the spread, and never more than it', () => {
    expect(standingDiscount(0, tuning)).toBe(0);
    expect(standingDiscount(tuning.standing.discountAbove, tuning)).toBe(0);
    expect(standingDiscount(tuning.standing.ceiling, tuning)).toBeCloseTo(
      tuning.standing.maxDiscount,
      6,
    );

    // Invariant 1 is the bar: a discount that beat the Staple's own spread
    // would make buying and selling back at one berth profitable for a
    // favoured captain, which is exactly what the invariant forbids.
    expect(tuning.standing.maxDiscount).toBeLessThan(tuning.market.spread);
  });

  it('reads as something a captain can understand', () => {
    const { floor, ceiling } = tuning.standing;
    expect(standingName(floor, tuning)).toBe('Barred');
    expect(standingName(0, tuning)).toBe('Unknown');
    // Not "a friend of the House": the House is Kessler & Daughters by
    // name, and this reads against all three charters.
    expect(standingName(ceiling, tuning)).toBe('A friend of the charter');
    expect(standingName(ceiling, tuning)).not.toMatch(/house/i);

    // Every step is reachable and the names never repeat out of order.
    const seen: string[] = [];
    for (let value = floor; value <= ceiling; value += 25) {
      const name = standingName(value, tuning);
      if (seen.at(-1) !== name) seen.push(name);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('says something other than Unknown either side of nothing', () => {
    // The old table called everything from -40 to +39 "Unknown", which is
    // most of a captain's first week — and the hub printed it in danger red
    // at -40, so the colour said trouble and the word said nobody has an
    // opinion.
    expect(standingName(-40, tuning)).not.toBe('Unknown');
    expect(standingName(40, tuning)).not.toBe('Unknown');
    expect(standingName(-200, tuning)).not.toBe(standingName(-40, tuning));
    expect(standingName(200, tuning)).not.toBe(standingName(40, tuning));
    // And nothing is still nothing.
    expect(standingName(0, tuning)).toBe('Unknown');
  });

  it('knows a charter from an independent', () => {
    expect(isCharter('kessler')).toBe(true);
    expect(isCharter('independent')).toBe(false);
    expect(isCharter('unlettered')).toBe(false);
  });
});
