/**
 * The chat overlay.
 *
 * Quiet by default: the last few lines sit above the gauges and fade, so a
 * captain flying sees conversation without it taking the screen. Enter opens
 * the composer, which takes focus so the ship stops answering the keyboard,
 * Tab moves between the global channel and this system, Esc closes it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CHAT_MAX_LENGTH, type ChatLine } from '@marque/shared';

import './chat.css';

/** Lines shown while the composer is shut. Opening it shows the whole log. */
const RESTING_LINES = 5;

/** How long a line stays up with the composer shut, in milliseconds. */
const RESTING_LIFETIME_MS = 22_000;

export interface ChatOverlayProps {
  readonly lines: readonly ChatLine[];
  /** The system the captain is in, so its own channel can be named. */
  readonly systemName: string;
  /** False while landed, where the keyboard is the port's. */
  readonly captureKeys: boolean;
  onSay: (channel: 'global' | 'system', body: string) => void;
  /** Told when the composer opens or shuts, so flight can ignore the keyboard. */
  onComposingChange?: (composing: boolean) => void;
}

export function ChatOverlay({
  lines,
  systemName,
  captureKeys,
  onSay,
  onComposingChange,
}: ChatOverlayProps): React.JSX.Element {
  const [composing, setComposing] = useState(false);
  const [channel, setChannel] = useState<'global' | 'system'>('global');
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => performance.now());

  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  /**
   * When each line reached this captain.
   *
   * A line fades from when it was seen, not from the timestamp the server put
   * on it: those clocks need not agree, and a captain who has just connected
   * should not watch the backlog vanish because it was said a minute ago.
   */
  const seenAt = useRef(new Map<string, number>());
  const arrived = performance.now();
  for (const line of lines) {
    if (!seenAt.current.has(line.id)) seenAt.current.set(line.id, arrived);
  }
  // Drop what is no longer in the log, so the map cannot grow without bound.
  if (seenAt.current.size > lines.length) {
    const live = new Set(lines.map((line) => line.id));
    for (const id of seenAt.current.keys()) {
      if (!live.has(id)) seenAt.current.delete(id);
    }
  }

  const close = useCallback(() => {
    setComposing(false);
    setDraft('');
  }, []);

  // Enter opens the composer from anywhere the captain is flying.
  useEffect(() => {
    if (!captureKeys) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (composing || event.key !== 'Enter' || event.repeat) return;
      // Not while something else is taking typing, such as the Register.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      setComposing(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [captureKeys, composing]);

  useEffect(() => {
    onComposingChange?.(composing);
    if (composing) inputRef.current?.focus();
  }, [composing, onComposingChange]);

  // Shut the composer when the keyboard stops being ours, such as on landing.
  useEffect(() => {
    if (!captureKeys) close();
  }, [captureKeys, close]);

  // A slow tick, only while lines could still be fading. Nothing runs when
  // the log is empty or the composer is open.
  useEffect(() => {
    if (composing || lines.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [composing, lines.length]);

  useEffect(() => {
    if (composing) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [composing, lines]);

  const shown = useMemo(() => {
    if (composing) return lines;
    return lines
      .filter((line) => now - (seenAt.current.get(line.id) ?? now) < RESTING_LIFETIME_MS)
      .slice(-RESTING_LINES);
  }, [composing, lines, now]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const body = draft.trim();
      if (body !== '') onSay(channel, body);
      close();
    },
    [channel, close, draft, onSay],
  );

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        setChannel((current) => (current === 'global' ? 'system' : 'global'));
      }
    },
    [close],
  );

  if (shown.length === 0 && !composing) return <></>;

  return (
    <div className={`chat${composing ? ' chat--open' : ''}`}>
      <div className="chat__log" ref={logRef} role="log" aria-label="Chat">
        {shown.map((line) => (
          <p key={line.id} className={`chat__line chat__line--${line.channel}`}>
            {line.channel === 'global' && <span className="chat__origin">{line.system}</span>}
            <span className="chat__who">{line.callsign}</span>
            <span className="chat__body">{line.body}</span>
          </p>
        ))}
      </div>

      {composing && (
        <form className="chat__composer panel" onSubmit={submit}>
          <button
            type="button"
            className={`chat__channel chat__channel--${channel}`}
            onClick={() => setChannel((c) => (c === 'global' ? 'system' : 'global'))}
            title="Tab to change channel"
          >
            {channel === 'global' ? 'The Reach' : systemName}
          </button>
          <input
            ref={inputRef}
            className="chat__input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            onBlur={close}
            maxLength={CHAT_MAX_LENGTH}
            autoComplete="off"
            aria-label="Say something"
          />
          <span className="micro chat__hint">Tab channel &middot; Esc close</span>
        </form>
      )}
    </div>
  );
}
