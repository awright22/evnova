/**
 * A hint, the first time a system is used.
 *
 * Spec section 13: once the ticket is confirmed, a contextual hint appears
 * the first time each system is used. It appears once per device and then
 * never again, it never blocks the screen it is about, and Esc or the button
 * is enough to be rid of it.
 *
 * The text is in `pilotage.ts` with the rest of it. These are the longest
 * strings in the game and the only place where the interface explains
 * itself, so they are written in the same voice as everything else: what
 * this counter is for, and the one thing about it that looking at it will
 * not tell you.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  HINT_TEXT,
  hintSeen,
  hintsSeen,
  settleHint,
  watchHints,
  type HintKey,
} from './pilotage.ts';
import './pilotage.css';

/**
 * Whether this hint is still owed, and how to settle it.
 *
 * A hook rather than a component so a screen can put the note where it
 * belongs rather than wherever a wrapper would land it. It reads the shared
 * store, so two screens mounting the same hint agree about it.
 */
export function useHint(key: HintKey, ready = true): { show: boolean; dismiss: () => void } {
  const seen = useSyncExternalStore(watchHints, hintsSeen, hintsSeen);
  const dismiss = useCallback(() => settleHint(key), [key]);
  return { show: ready && !seen.includes(key), dismiss };
}

/** Whether a hint has already been settled, for a screen that waits on one. */
export function alreadyHinted(key: HintKey): boolean {
  return hintSeen(key);
}

export function Hint({
  which,
  ready = true,
}: {
  readonly which: HintKey;
  /** False while the screen is not really open yet, so nothing flashes. */
  readonly ready?: boolean;
}): React.JSX.Element | null {
  const { show, dismiss } = useHint(which, ready);

  // Esc closes it, and does not reach the screen underneath: a captain
  // pressing Esc at a hint means the hint.
  useEffect(() => {
    if (!show) return undefined;
    const take = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', take, { capture: true });
    return () => window.removeEventListener('keydown', take, { capture: true });
  }, [show, dismiss]);

  if (!show) return null;
  const text = HINT_TEXT[which];

  return (
    <aside className="hint panel" role="note" aria-label={text.heading}>
      <div className="hint__body">
        <h2 className="hint__heading">{text.heading}</h2>
        <p className="hint__text">{text.body}</p>
      </div>
      <button type="button" className="button hint__dismiss" onClick={dismiss}>
        Noted
      </button>
    </aside>
  );
}
