/**
 * The convoy screen's arithmetic.
 *
 * Only the pure parts: the reading order of the rows, the words for where a
 * captain is, what the invite field is for, and how an ask's age is phrased.
 * The markup is judged from a capture, not from assertions.
 */

import { describe, expect, it } from 'vitest';

import { ConvoyInviteIntent, type ConvoyMemberLine, type ConvoyState } from '@marque/shared';

import {
  CALLSIGN_LIMIT,
  askMarks,
  askState,
  askable,
  orderMembers,
  rowMarks,
  sinceLabel,
  whereLabel,
} from './Convoy.tsx';

/** A member line as the server pushes one. */
function member(overrides: Partial<ConvoyMemberLine> = {}): ConvoyMemberLine {
  return {
    callsign: 'Leung',
    state: 'member',
    isLeader: false,
    isSelf: false,
    systemId: 'hallam',
    systemName: 'Hallam',
    portId: '',
    portName: '',
    online: true,
    ...overrides,
  };
}

/** A convoy push. Empty id and no members is a captain sailing alone. */
function convoyOf(overrides: Partial<ConvoyState> = {}): ConvoyState {
  return {
    id: '',
    name: '',
    isLeader: false,
    members: [],
    invitations: [],
    limit: 8,
    ...overrides,
  };
}

describe('orderMembers', () => {
  it('reads leader first, then those sailing, then the asks', () => {
    const rows = orderMembers([
      member({ callsign: 'Whitlock', state: 'invited' }),
      member({ callsign: 'Bello' }),
      member({ callsign: 'Sarkissian', isLeader: true }),
      member({ callsign: 'Adeyemi', state: 'invited' }),
      member({ callsign: 'Mehta' }),
    ]);

    expect(rows.map((row) => row.callsign)).toEqual([
      'Sarkissian',
      'Bello',
      'Mehta',
      'Adeyemi',
      'Whitlock',
    ]);
  });

  it('does not reorder when a member goes off the link', () => {
    const before = [
      member({ callsign: 'Sarkissian', isLeader: true }),
      member({ callsign: 'Mehta' }),
      member({ callsign: 'Bello' }),
    ];
    const after = before.map((row) =>
      row.callsign === 'Mehta'
        ? member({ callsign: 'Mehta', online: false, systemId: '', systemName: '' })
        : row,
    );

    expect(orderMembers(after).map((row) => row.callsign)).toEqual(
      orderMembers(before).map((row) => row.callsign),
    );
  });

  it('leaves the pushed array alone', () => {
    const pushed = [member({ callsign: 'Bello' }), member({ callsign: 'Adeyemi' })];
    orderMembers(pushed);
    expect(pushed.map((row) => row.callsign)).toEqual(['Bello', 'Adeyemi']);
  });
});

describe('whereLabel', () => {
  it('names the berth and the system when a captain is alongside', () => {
    expect(whereLabel(member({ portId: 'demurrage', portName: 'Demurrage' }))).toBe(
      'Alongside Demurrage, Hallam',
    );
  });

  it('says under way, with the system, when a captain is flying', () => {
    expect(whereLabel(member())).toBe('Under way in Hallam');
  });

  it('still says under way when the system is not known here', () => {
    expect(whereLabel(member({ systemId: '', systemName: '' }))).toBe('Under way');
  });

  it('reads a captain who is not connected as not connected, not as nowhere', () => {
    const label = whereLabel(
      member({ online: false, systemId: '', systemName: '', portId: '', portName: '' }),
    );
    expect(label).toBe('Not on the link');
  });

  it('does not report where somebody who has not answered is', () => {
    const label = whereLabel(
      member({ state: 'invited', portId: 'demurrage', portName: 'Demurrage' }),
    );
    expect(label).toBe('Asked, not yet answered');
  });
});

describe('rowMarks', () => {
  it('marks the captain reading it and the one who opened it', () => {
    expect(rowMarks(member({ isSelf: true, isLeader: true }))).toEqual(['You', 'Opened it']);
    expect(rowMarks(member({ isSelf: true }))).toEqual(['You']);
    expect(rowMarks(member({ isLeader: true }))).toEqual(['Opened it']);
    expect(rowMarks(member())).toEqual([]);
  });
});

describe('askMarks', () => {
  it('does not print the asker’s name twice', () => {
    expect(askMarks('Sarkissian', "Sarkissian's convoy", '9m ago')).toEqual(['9m ago']);
  });

  it('keeps a convoy name that says something else', () => {
    expect(askMarks('Sarkissian', 'The long way round', '9m ago')).toEqual([
      'The long way round',
      '9m ago',
    ]);
  });

  it('copes with a push that carries no asker', () => {
    expect(askMarks('', "Bello's convoy", 'just now')).toEqual([
      "Bello's convoy",
      'just now',
    ]);
  });
});

describe('askState', () => {
  it('offers the field to a captain sailing alone, counting them in', () => {
    // The first ask opens the convoy with the asking captain already in it,
    // so seven of the eight berths are what is actually on offer.
    expect(askState(convoyOf())).toEqual({ kind: 'open', free: 7 });
  });

  it('counts asks nobody has answered against the limit, as the server does', () => {
    const convoy = convoyOf({
      id: 'f1',
      isLeader: true,
      members: [
        member({ callsign: 'Sarkissian', isLeader: true, isSelf: true }),
        member({ callsign: 'Mehta' }),
        member({ callsign: 'Adeyemi', state: 'invited' }),
      ],
    });
    expect(askState(convoy)).toEqual({ kind: 'open', free: 5 });
  });

  it('says a full convoy is full rather than letting the ask fail', () => {
    const eight = Array.from({ length: 8 }, (_unused, index) =>
      member({ callsign: `Captain ${index}`, isLeader: index === 0 }),
    );
    expect(askState(convoyOf({ id: 'f1', isLeader: true, members: eight }))).toEqual({
      kind: 'full',
      limit: 8,
    });
  });

  it('is full when the last free berth is held by an unanswered ask', () => {
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      member({
        callsign: `Captain ${index}`,
        isLeader: index === 0,
        state: index === 7 ? 'invited' : 'member',
      }),
    );
    expect(askState(convoyOf({ id: 'f1', isLeader: true, members: rows })).kind).toBe('full');
  });

  it('offers no field to a member of somebody else’s convoy', () => {
    const convoy = convoyOf({
      id: 'f1',
      isLeader: false,
      members: [
        member({ callsign: 'Sarkissian', isLeader: true }),
        member({ callsign: 'Mehta', isSelf: true }),
      ],
    });
    expect(askState(convoy)).toEqual({ kind: 'not-yours' });
  });
});

describe('askable', () => {
  it('refuses nothing and whitespace', () => {
    expect(askable('')).toBe(false);
    expect(askable('   ')).toBe(false);
  });

  it('takes a callsign, trimmed', () => {
    expect(askable('  Sarkissian  ')).toBe(true);
  });

  it('refuses more than the Register will take', () => {
    expect(askable('a'.repeat(CALLSIGN_LIMIT))).toBe(true);
    expect(askable('a'.repeat(CALLSIGN_LIMIT + 1))).toBe(false);
  });

  it('refuses exactly what the intent refuses', () => {
    for (const draft of ['', ' ', 'Bello', 'a'.repeat(21)]) {
      expect(askable(draft)).toBe(
        ConvoyInviteIntent.safeParse({ callsign: draft.trim() }).success,
      );
    }
  });
});

describe('sinceLabel', () => {
  it('phrases an age the way the Gazette does', () => {
    expect(sinceLabel(0)).toBe('just now');
    expect(sinceLabel(44_000)).toBe('just now');
    expect(sinceLabel(60_000)).toBe('1m ago');
    expect(sinceLabel(14 * 60_000)).toBe('14m ago');
    expect(sinceLabel(90 * 60_000)).toBe('1h ago');
    expect(sinceLabel(30 * 60 * 60_000)).toBe('1d ago');
  });

  it('reads a clock that disagrees with the server as just now', () => {
    // The anchor can put an ask marginally in the future when the two clocks
    // differ. "in 2 seconds" would be a fault report; "just now" is the truth.
    expect(sinceLabel(-5_000)).toBe('just now');
  });
});
