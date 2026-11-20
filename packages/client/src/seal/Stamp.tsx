/**
 * The stamp.
 *
 * Spec section 4: confirming a purchase, a build, a trade or a commission
 * stamps the document, and this is the game's signature interaction. The
 * sequence is the art direction's, to the millisecond:
 *
 *   press   0–70ms    the control depresses 2px and darkens; the paper
 *                     shifts 1px down
 *   strike  70–120ms  the impression appears at 108% and no alpha, settling
 *                     to 100% and full alpha over 50ms; a 1px amber rim
 *                     flashes for one frame at its edge
 *   settle  120–200ms the paper rises back; the impression's edge softens as
 *                     the ink spreads, and a 1px debossed shadow appears
 *   rest    200–260ms the confirmed line fades from the amber wash back to
 *                     its resting surface
 *
 * The intent goes to the server on the press, not on the strike: a captain
 * should not wait two hundred milliseconds for their order to be sent. What
 * the sequence confirms is that the order was given.
 *
 * Under reduced motion the press and the paper's shift are dropped, the
 * impression simply fades over 120ms, and the thud still plays. The stamp is
 * never skipped: it is the confirmation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { playStamp } from '../audio/stamp.ts';
import { motionIsReduced } from '../shell/settings.ts';
import { Seal } from './Seal.tsx';
import './stamp.css';

/** The four phases, in the order they run. */
type Phase = 'rest' | 'press' | 'strike' | 'settle' | 'struck' | 'lifting';

const PRESS_MS = 70;
const STRIKE_MS = 50;
const SETTLE_MS = 80;
/**
 * How long a line stamp stays before it lifts.
 *
 * A document stays stamped: the mark is the record. A row does not — ten
 * rows with ten seals on them is a table nobody can read, and the row's own
 * figures have already moved. Long enough to be seen, and gone.
 */
const LINGER_MS = 900;
const LIFT_MS = 400;

export function Stamp({
  issuer,
  children,
  busy = false,
  disabled = false,
  title,
  size = 72,
  issuerName,
  className = 'button button--primary',
  paper,
  onStamp,
}: {
  /** Whose seal is struck. The id seeds the mark and picks the livery. */
  readonly issuer: string;
  /** The words on the control. */
  readonly children: React.ReactNode;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  /** How big the impression is struck. Smaller on a line than on a bill. */
  readonly size?: number;
  /**
   * The issuer's name, set round the rim at document size.
   *
   * Only where the mark is big enough to carry it: on a line stamp the name
   * would be four pixels tall and the rim would be all text.
   */
  readonly issuerName?: string;
  /** The control's own classes, for a stamp that is a row's button. */
  readonly className?: string;
  /**
   * The document being stamped, which shifts 1px under the press.
   *
   * Optional: where a screen has no paper to speak of the control presses on
   * its own, which is the same sequence without the page moving.
   */
  readonly paper?: React.RefObject<HTMLElement | null>;
  onStamp: () => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('rest');
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clear, [clear]);

  const strike = useCallback(() => {
    if (busy || disabled) return;
    clear();

    const reduced = motionIsReduced();
    const sheet = paper?.current;

    // The order goes now. The sequence is what says it was given, not what
    // decides whether to give it.
    onStamp();

    if (reduced) {
      playStamp();
      setPhase('struck');
      // A line's mark still lifts: reduced motion asks for less movement,
      // not for a table that fills up with seals.
      if (size < 40) {
        timers.current.push(
          window.setTimeout(() => setPhase('lifting'), LINGER_MS),
          window.setTimeout(() => setPhase('rest'), LINGER_MS + LIFT_MS),
        );
      }
      return;
    }

    setPhase('press');
    sheet?.classList.add('paper--pressed');

    timers.current.push(
      window.setTimeout(() => {
        playStamp();
        setPhase('strike');
      }, PRESS_MS),
      window.setTimeout(() => {
        setPhase('settle');
        sheet?.classList.remove('paper--pressed');
      }, PRESS_MS + STRIKE_MS),
      window.setTimeout(() => {
        setPhase('struck');
      }, PRESS_MS + STRIKE_MS + SETTLE_MS),
    );

    // A mark on a line lifts; a mark on a document stays.
    if (size < 40) {
      const struck = PRESS_MS + STRIKE_MS + SETTLE_MS;
      timers.current.push(
        window.setTimeout(() => setPhase('lifting'), struck + LINGER_MS),
        window.setTimeout(() => setPhase('rest'), struck + LINGER_MS + LIFT_MS),
      );
    }
  }, [busy, clear, disabled, onStamp, paper, size]);

  const showing =
    phase === 'strike' || phase === 'settle' || phase === 'struck' || phase === 'lifting';
  // A line stamp lands on the corner of its own control, where the row is. A
  // document stamp lands above it, over the paper — and out of the way of
  // the panel edge a ticket's own scroll would otherwise clip it against.
  const where = size >= 40 ? 'above' : 'corner';

  return (
    <span className={`stamp stamp--${phase} stamp--${where}`}>
      <button
        type="button"
        className={`${className} stamp__control`}
        disabled={disabled || busy}
        title={title}
        onClick={strike}
      >
        {children}
      </button>

      {showing && (
        <span className="stamp__impression" aria-hidden="true">
          <Seal issuer={issuer} name={issuerName} size={size} />
        </span>
      )}
    </span>
  );
}
