/**
 * The application shell.
 *
 * Connects to the server, then hands the room to the flight view. Every
 * failure has a designed state: the interface never shows a white screen or
 * raw error text.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { FlightView } from './flight/FlightView.tsx';
import {
  BUILD_VERSION,
  SERVER_URL,
  connect,
  explainFailure,
  type ConnectionStatus,
} from './net/connection.ts';
import './styles/boot.css';

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const current = useRef<ConnectionStatus | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'connecting' });

    // A draught can be named in the URL, so the contrasting designs can be
    // flown and compared without a shipyard, which arrives in M5.
    const params = new URLSearchParams(window.location.search);
    const blueprint = params.get('draught') ?? undefined;
    const callsign = params.get('callsign') ?? 'Free Captain';

    void connect({ callsign, ...(blueprint ? { blueprint } : {}) }).then((result) => {
      if (cancelled) {
        if (result.kind === 'connected') void result.room.leave();
        return;
      }
      current.current = result;
      setStatus(result);
    });

    return () => {
      cancelled = true;
      const open = current.current;
      if (open?.kind === 'connected') void open.room.leave();
      current.current = undefined;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (status.kind === 'connected') {
    return <FlightView room={status.room} />;
  }

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
          {status.kind === 'connecting' ? (
            <p className="boot__message">Opening the link.</p>
          ) : (
            <Failure status={status} onRetry={retry} />
          )}
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
  const tone = status.kind === 'connecting' ? 'wait' : 'bad';
  const text = status.kind === 'connecting' ? 'Linking' : 'No link';
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

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="boot__field">
      <span className="label">{label}</span>
      <span className="data boot__field-value">{value}</span>
    </div>
  );
}
