/**
 * The provisional ticket, on screen.
 *
 * A card in the corner with one endorsement on it: the one the Register's
 * clerk is waiting for. Not a modal, not a pointer drawn over the interface,
 * and never in the way of flying — it sits where the HUD is not and says one
 * thing at a time.
 *
 * It is paperwork, so it reads as paperwork: a count, a heading, a line of
 * instruction, and a button that waives the rest.
 */

import { useEffect, useState } from 'react';

import {
  ENDORSEMENTS,
  ENDORSEMENT_TEXT,
  current,
  type Endorsement,
  type Pilotage as Ticket,
} from './pilotage.ts';
import './pilotage.css';

export function Pilotage({
  ticket,
  where,
  onWaive,
}: {
  readonly ticket: Ticket;
  /** Where the captain is standing, so the card asks for something they can do. */
  readonly where: 'sky' | 'berth';
  onWaive: () => void;
}): React.JSX.Element | null {
  const asking = current(ticket, where);

  /**
   * The endorsement just added, held for a moment.
   *
   * Without this the card changes under the captain the instant they do the
   * thing, and nothing ever says they did it. With it, the line they
   * completed is struck through for a beat and then the next one comes up.
   */
  const [struck, setStruck] = useState<Endorsement | undefined>(undefined);
  const [showing, setShowing] = useState(asking);
  useEffect(() => {
    if (asking === showing) return undefined;
    // Something was endorsed: show it struck, then move on.
    setStruck(showing);
    const timer = window.setTimeout(() => {
      setStruck(undefined);
      setShowing(asking);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [asking, showing]);

  if (ticket.confirmed && struck === undefined) return null;

  const shown = struck ?? showing;
  if (shown === undefined) return null;
  const text = ENDORSEMENT_TEXT[shown];

  return (
    <aside
      className={`pilotage panel${struck === undefined ? '' : ' pilotage--struck'}`}
      aria-live="polite"
      aria-label="Your ticket"
    >
      <header className="pilotage__head">
        <span className="label">Open Ticket, provisional</span>
        <span className="micro pilotage__count">
          {ticket.done.length} of {ENDORSEMENTS.length} endorsed
        </span>
      </header>

      <h2 className="pilotage__heading">{text.heading}</h2>
      <p className="pilotage__instruction">{text.instruction}</p>
      {text.keys !== undefined && <p className="micro pilotage__keys">{text.keys}</p>}

      <footer className="pilotage__foot">
        <button type="button" className="button pilotage__waive" onClick={onWaive}>
          Waive the rest
        </button>
      </footer>
    </aside>
  );
}
