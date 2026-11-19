/**
 * Opening an account, or moving one to this device.
 *
 * A callsign and a shared invite code open an account. The recovery phrase it
 * returns is shown once, because it is the only way back if this device is
 * lost, and it is never stored here — keeping it would defeat what it
 * protects against.
 */

import { useCallback, useState } from 'react';

import { recover, saveAccount, signUp, type NewAccount, type StoredAccount } from './account.ts';
import './register.css';

export interface RegisterProps {
  readonly httpBase: string;
  onSignedIn: (account: StoredAccount) => void;
}

type Tab = 'open' | 'recover';

export function Register({ httpBase, onSignedIn }: RegisterProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('open');
  const [callsign, setCallsign] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [issued, setIssued] = useState<NewAccount | undefined>(undefined);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(undefined);

      const work =
        tab === 'open'
          ? signUp(httpBase, { callsign, inviteCode })
          : recover(httpBase, { callsign, recoveryPhrase: phrase });

      void work
        .then((account) => {
          saveAccount(account);
          setIssued(account);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'The Register declined.');
        })
        .finally(() => setBusy(false));
    },
    [busy, callsign, httpBase, inviteCode, phrase, tab],
  );

  // The phrase is shown once, on its own screen, with nothing else to click.
  if (issued) {
    return (
      <main className="register">
        <div className="register__panel panel">
          <header className="panel-header">
            <h1>Entered on the Register</h1>
            <span className="micro">{issued.callsign}</span>
          </header>

          <div className="register__body">
            <p className="register__lead">
              This is your recovery phrase. It is the only way to move this account to another
              device, it is not stored anywhere, and it will not be shown again.
            </p>

            <p className="register__phrase data">{issued.recoveryPhrase}</p>

            <p className="micro register__warning">
              Write it down before continuing.
            </p>
          </div>

          <footer className="register__footer">
            <button
              type="button"
              className="button button--primary"
              onClick={() => onSignedIn(issued)}
            >
              I have written it down
            </button>
          </footer>
        </div>
      </main>
    );
  }

  return (
    <main className="register">
      <form className="register__panel panel" onSubmit={submit}>
        <header className="panel-header">
          <h1>Marque</h1>
          <span className="micro">The Register</span>
        </header>

        <div className="register__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'open'}
            className={tab === 'open' ? 'register__tab is-active' : 'register__tab'}
            onClick={() => setTab('open')}
          >
            Open an account
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'recover'}
            className={tab === 'recover' ? 'register__tab is-active' : 'register__tab'}
            onClick={() => setTab('recover')}
          >
            Move one here
          </button>
        </div>

        <div className="register__body">
          <label className="register__field">
            <span className="label">Callsign</span>
            <input
              className="register__input"
              name="callsign"
              value={callsign}
              onChange={(event) => setCallsign(event.target.value)}
              maxLength={20}
              autoComplete="off"
              autoFocus
              required
            />
          </label>

          {tab === 'open' ? (
            <label className="register__field">
              <span className="label">Invite code</span>
              <input
                className="register__input"
                name="inviteCode"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                autoComplete="off"
              />
              <span className="micro">Shared by whoever runs this server.</span>
            </label>
          ) : (
            <label className="register__field">
              <span className="label">Recovery phrase</span>
              <input
                className="register__input"
                name="recoveryPhrase"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
                required
              />
              <span className="micro">The six words you were given. Case does not matter.</span>
            </label>
          )}

          {error !== undefined && <p className="register__error">{error}</p>}
        </div>

        <footer className="register__footer">
          <button type="submit" className="button button--primary" disabled={busy || !callsign}>
            {busy ? 'Filing…' : tab === 'open' ? 'File for an Open Ticket' : 'Move the account here'}
          </button>
        </footer>
      </form>
    </main>
  );
}
