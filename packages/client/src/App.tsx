/**
 * Boot screen.
 *
 * M0's client: establishes the design tokens, connects to the server, and shows
 * the system roster. The flight view replaces the roster in M1; the connection
 * states and the shell around them stay.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  BUILD_VERSION,
  SERVER_URL,
  connect,
  explainFailure,
  type ConnectionStatus,
} from './net/connection.ts';
import './styles/boot.css';

interface RosterEntry {
  readonly sessionId: string;
  readonly callsign: string;
  readonly speed: number;
  readonly isSelf: boolean;
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>({ kind: 'connecting' });
  const [roster, setRoster] = useState<readonly RosterEntry[]>([]);
  const [attempt, setAttempt] = useState(0);
  const roomRef = useRef<ConnectionStatus | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'connecting' });

    void connect({ callsign: 'Observer' }).then((result) => {
      if (cancelled) {
        if (result.kind === 'connected') void result.room.leave();
        return;
      }
      roomRef.current = result;
      setStatus(result);
    });

    return () => {
      cancelled = true;
      const current = roomRef.current;
      if (current?.kind === 'connected') void current.room.leave();
      roomRef.current = undefined;
    };
  }, [attempt]);

  // Poll the synchronised state for the roster. M1 drives this from the
  // render loop instead; a 4 Hz read is plenty for a text list.
  useEffect(() => {
    if (status.kind !== 'connected') {
      setRoster([]);
      return;
    }
    const { room } = status;
    const read = (): void => {
      const entries: RosterEntry[] = [];
      room.state.ships.forEach((ship, sessionId) => {
        entries.push({
          sessionId,
          callsign: ship.callsign,
          speed: Math.hypot(ship.vx, ship.vy),
          isSelf: sessionId === room.sessionId,
        });
      });
      entries.sort((a, b) => a.callsign.localeCompare(b.callsign));
      setRoster(entries);
    };
    read();
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [status]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <main className="boot">
      <div className="boot__frame panel">
        <header className="panel-header">
          <div className="boot__brand">
            <h1 className="boot__title">Marque</h1>
            <span className="micro">Ship&apos;s terminal</span>
          </div>
          <StatusBadge status={status} />
        </header>

        <div className="boot__body">
          {status.kind === 'connecting' && (
            <p className="boot__message">Opening the link.</p>
          )}

          {status.kind === 'failed' && <Failure status={status} onRetry={retry} />}

          {status.kind === 'connected' && <Roster entries={roster} />}
        </div>

        <footer className="boot__footer">
          <Field label="Terminal" value={SERVER_URL} />
          <Field label="Build" value={BUILD_VERSION} />
        </footer>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }): React.JSX.Element {
  const tone =
    status.kind === 'connected' ? 'ok' : status.kind === 'connecting' ? 'wait' : 'bad';
  const text =
    status.kind === 'connected' ? 'Linked' : status.kind === 'connecting' ? 'Linking' : 'No link';

  return (
    <span className={`boot__badge boot__badge--${tone}`}>
      <span className="dot" />
      <span className="micro">{text}</span>
    </span>
  );
}

function Failure({
  status,
  onRetry,
}: {
  status: Extract<ConnectionStatus, { kind: 'failed' }>;
  onRetry: () => void;
}): React.JSX.Element {
  const { heading, body, retry } = explainFailure(status.reason);
  return (
    <div className="boot__failure">
      <h2>{heading}</h2>
      <p className="boot__message">{body}</p>
      <p className="boot__detail">
        <span className="micro boot__detail-label">Detail</span>
        <span className="boot__detail-text">{status.detail}</span>
      </p>
      {retry && (
        <button type="button" className="button button--primary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function Roster({ entries }: { entries: readonly RosterEntry[] }): React.JSX.Element {
  if (entries.length === 0) {
    return <p className="boot__message">Linked. No hulls in this system.</p>;
  }

  return (
    <table className="boot__roster">
      <thead>
        <tr>
          <th className="label">Callsign</th>
          <th className="label boot__roster-num">Speed</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.sessionId} className={entry.isSelf ? 'is-self' : undefined}>
            <td>
              {entry.callsign}
              {entry.isSelf && <span className="micro boot__you">you</span>}
            </td>
            <td className="boot__roster-num data">{entry.speed.toFixed(0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="boot__field">
      <span className="label">{label}</span>
      <span className="data boot__field-value">{value}</span>
    </div>
  );
}
