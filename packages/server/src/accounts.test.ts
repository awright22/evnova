import { beforeEach, describe, expect, it } from 'vitest';

import { Accounts, AuthError, normaliseCallsign } from './accounts.ts';
import { openStore, type Store } from './db/index.ts';

// The config is read once at import, so these tests run against whatever the
// environment set. They only rely on the invite gate being open by default.
let store: Store;
let accounts: Accounts;

beforeEach(() => {
  store = openStore(':memory:');
  accounts = new Accounts(store);
});

describe('signing up', () => {
  it('creates an account and a captain in one transaction', () => {
    const result = accounts.signUp({ callsign: 'Mehta', inviteCode: '' });
    expect(result.account.callsign).toBe('Mehta');
    expect(result.deviceToken.length).toBeGreaterThan(30);
    expect(result.recoveryPhrase.split(' ')).toHaveLength(6);

    const pilot = store.raw
      .prepare('SELECT * FROM pilots WHERE account_id = ?')
      .get(result.account.id) as { blueprint_id: string } | undefined;
    expect(pilot?.blueprint_id).toBe('prudent-return');
  });

  it('refuses a callsign that is already taken, whatever its case', () => {
    accounts.signUp({ callsign: 'Carvalho', inviteCode: '' });
    expect(() => accounts.signUp({ callsign: 'carvalho', inviteCode: '' })).toThrow(AuthError);
    expect(() => accounts.signUp({ callsign: '  CARVALHO ', inviteCode: '' })).toThrow(AuthError);
  });

  it('refuses a callsign that normalises to nothing', () => {
    for (const bad of ['', '   ', '!!!', '\u0000']) {
      expect(() => accounts.signUp({ callsign: bad, inviteCode: '' })).toThrow(AuthError);
    }
  });

  it('never stores the device token or the recovery phrase', () => {
    const result = accounts.signUp({ callsign: 'Leung', inviteCode: '' });
    const row = store.raw
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(result.account.id) as Record<string, unknown>;

    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(result.deviceToken);
    for (const word of result.recoveryPhrase.split(' ')) {
      // A single word could appear in a hash by chance; the whole phrase must not.
      expect(serialised).not.toContain(result.recoveryPhrase);
      void word;
    }
  });

  it('gives every captain a different token and phrase', () => {
    const a = accounts.signUp({ callsign: 'Bello', inviteCode: '' });
    const b = accounts.signUp({ callsign: 'Whitlock', inviteCode: '' });
    expect(a.deviceToken).not.toBe(b.deviceToken);
    expect(a.recoveryPhrase).not.toBe(b.recoveryPhrase);
  });
});

describe('signing in', () => {
  it('accepts the token it issued', () => {
    const created = accounts.signUp({ callsign: 'Sarkissian', inviteCode: '' });
    const signedIn = accounts.signIn(created.deviceToken);
    expect(signedIn.id).toBe(created.account.id);
    expect(signedIn.callsign).toBe('Sarkissian');
  });

  it('refuses a token it did not issue', () => {
    accounts.signUp({ callsign: 'van der Meer', inviteCode: '' });
    for (const bad of ['', 'not-a-token', 'x'.repeat(43)]) {
      expect(() => accounts.signIn(bad)).toThrow(AuthError);
    }
  });
});

describe('recovery', () => {
  it('moves the account to a new device and issues a new phrase', () => {
    const created = accounts.signUp({ callsign: 'Adeyemi', inviteCode: '' });
    const recovered = accounts.recover({
      callsign: 'Adeyemi',
      recoveryPhrase: created.recoveryPhrase,
    });

    expect(recovered.account.id).toBe(created.account.id);
    expect(recovered.deviceToken).not.toBe(created.deviceToken);
    expect(recovered.recoveryPhrase).not.toBe(created.recoveryPhrase);

    // The new device works.
    expect(accounts.signIn(recovered.deviceToken).id).toBe(created.account.id);
  });

  it('retires the old device token, so a stolen phrase cannot be used twice', () => {
    const created = accounts.signUp({ callsign: 'Okonjo', inviteCode: '' });
    accounts.recover({ callsign: 'Okonjo', recoveryPhrase: created.recoveryPhrase });

    expect(() => accounts.signIn(created.deviceToken)).toThrow(AuthError);
    expect(() =>
      accounts.recover({ callsign: 'Okonjo', recoveryPhrase: created.recoveryPhrase }),
    ).toThrow(AuthError);
  });

  it('accepts the phrase however it was typed back', () => {
    const created = accounts.signUp({ callsign: 'Tolliver', inviteCode: '' });
    const messy = `  ${created.recoveryPhrase.toUpperCase().replace(/ /g, '   ')}  `;
    expect(() => accounts.recover({ callsign: 'Tolliver', recoveryPhrase: messy })).not.toThrow();
  });

  it('refuses a wrong phrase and an unknown callsign', () => {
    accounts.signUp({ callsign: 'Lindqvist', inviteCode: '' });
    expect(() =>
      accounts.recover({ callsign: 'Lindqvist', recoveryPhrase: 'ballast ballast ballast ballast ballast ballast' }),
    ).toThrow(AuthError);
    expect(() =>
      accounts.recover({ callsign: 'Nobody', recoveryPhrase: 'ballast ballast ballast ballast ballast ballast' }),
    ).toThrow(AuthError);
  });
});

describe('callsign normalisation', () => {
  it('strips what the Register cannot print', () => {
    expect(normaliseCallsign('  Mrs.  Kessler  ')).toBe('Mrs Kessler');
    expect(normaliseCallsign("O'Hare-Smith")).toBe("O'Hare-Smith");
    expect(normaliseCallsign('drop<script>')).toBe('dropscript');
    expect(normaliseCallsign('a'.repeat(60))).toHaveLength(20);
  });
});
