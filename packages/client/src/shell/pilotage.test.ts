import { describe, expect, it } from 'vitest';

import {
  ENDORSEMENTS,
  ENDORSEMENT_TEXT,
  FRESH_TICKET,
  HINTS,
  HINT_TEXT,
  current,
  endorse,
} from './pilotage.ts';

describe('the provisional ticket', () => {
  it('covers everything the spec asks a first session to cover', () => {
    // Spec section 13: flying, landing, buying cargo, jumping, selling,
    // visiting the shipyard and opening the exchange.
    expect([...ENDORSEMENTS]).toEqual(['fly', 'land', 'buy', 'jump', 'sell', 'yard', 'bourse']);
  });

  it('asks for them in the order a voyage happens', () => {
    let ticket = FRESH_TICKET;
    const asked: string[] = [];
    for (let i = 0; i < ENDORSEMENTS.length; i += 1) {
      const next = current(ticket);
      expect(next, 'ran out of endorsements early').toBeDefined();
      asked.push(next!);
      ticket = endorse(ticket, next!);
    }
    expect(asked).toEqual([...ENDORSEMENTS]);
  });

  it('counts an endorsement earned out of turn', () => {
    // A captain who opens the Bourse at their first berth has opened the
    // Bourse. It is just not the line being asked for.
    const ticket = endorse(FRESH_TICKET, 'bourse');
    expect(ticket.done).toContain('bourse');
    expect(current(ticket)).toBe('fly');
  });

  it('endorses the same thing only once', () => {
    const once = endorse(FRESH_TICKET, 'fly');
    const twice = endorse(once, 'fly');
    expect(twice).toBe(once);
    expect(twice.done).toEqual(['fly']);
  });

  it('confirms the ticket when the last one is added', () => {
    let ticket = FRESH_TICKET;
    for (const id of ENDORSEMENTS) ticket = endorse(ticket, id);
    expect(ticket.confirmed).toBe(true);
    expect(current(ticket)).toBeUndefined();
  });

  it('asks for nothing once it has been waived', () => {
    const waived = { ...endorse(FRESH_TICKET, 'fly'), confirmed: true };
    expect(current(waived)).toBeUndefined();
  });

  it('writes every endorsement, with something to do', () => {
    for (const id of ENDORSEMENTS) {
      const text = ENDORSEMENT_TEXT[id];
      expect(text.heading, id).toBeTruthy();
      expect(text.instruction.length, id).toBeGreaterThan(20);
      // The voice: no exclamation marks, and nothing is impressed by anyone.
      expect(text.instruction, id).not.toMatch(/!/);
    }
  });
});

describe('the hints', () => {
  it('writes one for every system that has one', () => {
    for (const key of HINTS) {
      const text = HINT_TEXT[key];
      expect(text.heading, key).toBeTruthy();
      // Three or four lines: enough to say what the counter is for and the
      // one thing looking at it will not tell you.
      expect(text.body.length, key).toBeGreaterThan(120);
      expect(text.body, key).not.toMatch(/!/);
    }
  });

  it('uses the in-world words, not the plain ones', () => {
    const all = Object.values(HINT_TEXT)
      .map((text) => `${text.heading} ${text.body}`)
      .join(' ');
    // Whole words: "commission" is the in-world term and contains "mission".
    for (const plain of [
      'credits',
      'stock exchange',
      'commodity market',
      'blueprint',
      'shipyard',
      'hangar',
      'mission',
      'leaderboard',
      'wanted',
      'pirates',
      'fleet',
    ]) {
      expect(all, `uses the plain word "${plain}"`).not.toMatch(
        new RegExp(`\\b${plain}\\b`, 'i'),
      );
    }
  });
});

describe('what the capture harness starts a page with', () => {
  it('is every endorsement and every hint, so no note sits over a screen', () => {
    // tools/shots/src/main.ts writes this list into storage before each
    // capture. It is listed there rather than imported, because that file is
    // typechecked for Node; this is what keeps the two from drifting.
    const experienced = [
      'fly', 'land', 'buy', 'jump', 'sell', 'yard', 'bourse',
      'staple', 'moorings', 'factor', 'chart', 'offers', 'convoy',
      'register', 'range', 'boarding',
    ];
    // Deduped: `yard` and `bourse` are both an endorsement and a hint.
    const mine = [...new Set([...ENDORSEMENTS, ...HINTS])].sort();
    expect(mine).toEqual([...new Set(experienced)].sort());
  });
});
