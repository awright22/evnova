/**
 * The convoy.
 *
 * Who sails with this captain, where each of them is, and the three things a
 * captain does about it: ask somebody along, answer an ask, and leave. The
 * where column is the widest thing on the screen because answering "where is
 * everybody" is the whole reason a convoy exists.
 *
 * A captain sailing alone sees this screen more often than anybody else, so
 * it is written for them first: what a convoy is, in the words the Register
 * would use, and the field to open one. An empty table would be a worse
 * answer than a sentence.
 *
 * Nothing here is authoritative. The server owns the convoy, refuses what it
 * will not have and pushes the state back; this screen states what it was
 * told and what it is about to ask for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ConvoyInviteIntent, type ConvoyMemberLine, type ConvoyState } from '@marque/shared';

import './convoy.css';

export interface ConvoyProps {
  readonly convoy: ConvoyState;
  readonly busy: boolean;
  readonly notice: string | undefined;
  onInvite: (callsign: string) => void;
  onAnswer: (fleetId: string, accept: boolean) => void;
  onLeave: () => void;
  onRemove: (callsign: string) => void;
  onClose: () => void;
}

/**
 * How often the asks' ages are redrawn.
 *
 * Half a minute: the labels step in minutes, and a screen that repaints every
 * second to change nothing is an idle animation by another name.
 */
const AGE_TICK_MS = 30_000;

// --- The parts that are only arithmetic ----------------------------------

/**
 * The longest callsign the Register will take.
 *
 * Read off the intent's own schema rather than written down a second time
 * here, so the field and the server refuse the same thing and a change to the
 * protocol cannot leave a stale number in the client.
 */
export const CALLSIGN_LIMIT: number = ConvoyInviteIntent.shape.callsign.maxLength ?? 20;

/** Whether what has been typed is worth sending, by the server's own rule. */
export function askable(draft: string): boolean {
  return ConvoyInviteIntent.safeParse({ callsign: draft.trim() }).success;
}

/**
 * How long ago, phrased as the Gazette phrases it.
 *
 * Takes an elapsed span rather than two timestamps: the server's clock and
 * this client's need not agree, so the caller measures the span against
 * something it can trust and this only writes it down.
 */
export function sinceLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Where a member is, in words a captain can navigate by.
 *
 * A captain who is not connected is not nowhere: the push carries no system
 * for them because there is nothing to carry, and saying so is the honest
 * reading. Same phrasing as the Moorings, where a hull is either under way or
 * alongside a named berth.
 */
export function whereLabel(member: ConvoyMemberLine): string {
  // Somebody who has not answered is not in the convoy yet, and where they
  // happen to be is not the convoy's business until they are.
  if (member.state === 'invited') return 'Asked, not yet answered';
  if (!member.online) return 'Not on the link';
  if (member.portName !== '') {
    return member.systemName === ''
      ? `Alongside ${member.portName}`
      : `Alongside ${member.portName}, ${member.systemName}`;
  }
  return member.systemName === '' ? 'Under way' : `Under way in ${member.systemName}`;
}

/**
 * The line under an ask: which convoy, and how long it has been waiting.
 *
 * A convoy is named after whoever opened it, so an ask from Sarkissian whose
 * convoy is "Sarkissian's convoy" would print the same name twice. The name
 * is only worth the line when it says something the asker's own does not.
 */
export function askMarks(from: string, name: string, since: string): readonly string[] {
  const implied = `${from}'s convoy`.toLowerCase();
  const marks: string[] = [];
  if (name !== '' && name.toLowerCase() !== implied) marks.push(name);
  marks.push(since);
  return marks;
}

/** What a row is marked with: whose line it is, and who opened the convoy. */
export function rowMarks(member: ConvoyMemberLine): readonly string[] {
  const marks: string[] = [];
  if (member.isSelf) marks.push('You');
  if (member.isLeader) marks.push('Opened it');
  return marks;
}

/**
 * The reading order: who opened it, then everybody sailing, then the asks.
 *
 * The push already arrives ordered, but it is ordered by when each captain
 * joined, which the line does not carry — so the client cannot reproduce that
 * order and must not half-reproduce it. Sorting on what is actually in hand
 * keeps the list stable while captains come and go: a member logging out
 * must not make the list jump under the cursor.
 */
export function orderMembers(
  members: readonly ConvoyMemberLine[],
): readonly ConvoyMemberLine[] {
  const rank = (member: ConvoyMemberLine): number =>
    member.isLeader ? 0 : member.state === 'member' ? 1 : 2;
  // Within a group, the order they joined in — the same order the server
  // keeps, so the list does not rearrange itself when a push arrives.
  return [...members].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.joinedAt - b.joinedAt ||
      a.callsign.localeCompare(b.callsign),
  );
}

/** What the invite field is for, if it is for anything. */
export type AskState =
  /** Room to ask, with the berths left over once this captain is counted. */
  | { readonly kind: 'open'; readonly free: number }
  | { readonly kind: 'full'; readonly limit: number }
  /** Somebody else opened this convoy, so asking is not this captain's to do. */
  | { readonly kind: 'not-yours' };

export function askState(convoy: ConvoyState): AskState {
  if (convoy.id !== '' && !convoy.isLeader) return { kind: 'not-yours' };
  /*
   * The captain reading this counts against the limit before the convoy
   * exists, because the first ask opens it with them already in it. An ask
   * that has not been answered counts too: the server checks the limit
   * against every row it holds, so a berth is taken the moment it is offered
   * rather than when it is taken up.
   */
  const taken = Math.max(1, convoy.members.length);
  if (taken >= convoy.limit) return { kind: 'full', limit: convoy.limit };
  return { kind: 'open', free: convoy.limit - taken };
}

// --- The screen ----------------------------------------------------------

export function Convoy({
  convoy,
  busy,
  notice,
  onInvite,
  onAnswer,
  onLeave,
  onRemove,
  onClose,
}: ConvoyProps): React.JSX.Element {
  const screen = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState('');
  const [leaving, setLeaving] = useState(false);

  const inConvoy = convoy.id !== '';
  const rows = useMemo(() => orderMembers(convoy.members), [convoy.members]);
  const ask = askState(convoy);
  const sailing = convoy.members.filter((member) => member.state === 'member').length;
  const pending = convoy.members.length - sailing;

  /**
   * The clock the asks are aged against.
   *
   * `at` is the server's wall clock, which this client's need not agree with,
   * so ages are measured from the newest ask this client has seen: the real
   * time since it arrived, plus the server's own spacing between it and the
   * older ones. Same idiom as the Gazette.
   */
  const anchor = useRef<{ at: number; perf: number } | undefined>(undefined);
  const [now, setNow] = useState(() => performance.now());
  const newest = convoy.invitations.reduce((latest, line) => Math.max(latest, line.at), 0);
  if (newest > 0 && (anchor.current === undefined || newest > anchor.current.at)) {
    anchor.current = { at: newest, perf: performance.now() };
  }

  useEffect(() => {
    if (convoy.invitations.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [convoy.invitations.length]);

  const ageOf = useCallback(
    (at: number): number => {
      const since = anchor.current;
      if (!since) return 0;
      return now - since.perf + (since.at - at);
    },
    [now],
  );

  // The screen takes the keyboard on arrival, so Escape reaches this element
  // rather than whatever was focused behind it.
  useEffect(() => {
    screen.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Escape backs out of the confirmation before it closes the screen: a
      // captain who opened it by accident should not have to pick between two
      // consequences to get out of one.
      if (leaving) {
        setLeaving(false);
        return;
      }
      onClose();
    },
    [leaving, onClose],
  );

  const submit = useCallback(
    (event: React.FormEvent): void => {
      event.preventDefault();
      const callsign = draft.trim();
      if (busy || !askable(callsign)) return;
      onInvite(callsign);
    },
    [busy, draft, onInvite],
  );

  /*
   * The field clears when the ask lands on the board, and not before.
   *
   * Most refusals here are a misspelt callsign, and clearing on send makes a
   * captain retype the whole of it to fix one letter.
   */
  useEffect(() => {
    const asked = draft.trim().toLowerCase();
    if (asked === '') return;
    if (convoy.members.some((member) => member.callsign.toLowerCase() === asked)) {
      setDraft('');
    }
  }, [convoy.members, draft]);

  // Nothing to dissolve once it is gone, however it went.
  useEffect(() => {
    if (!inConvoy) setLeaving(false);
  }, [inConvoy]);

  return (
    <main
      className="convoy"
      ref={screen}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Convoy"
    >
      <section className="convoy__panel panel">
        <header className="panel-header">
          <h2>Convoy</h2>
          <div className="convoy__head-right">
            {inConvoy && (
              <span className="micro">
                {convoy.name} &middot; {sailing} of {convoy.limit}
                {pending > 0 && ` · ${pending} asked`}
              </span>
            )}
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="convoy__body">
          {/* --- Who is sailing, or what sailing together is for --------- */}
          {!inConvoy && (
            <div className="convoy__alone">
              <span className="label">Sailing alone</span>
              <p className="convoy__lede">
                Captains who sail in convoy keep company: each of you sees where the
                others are, on the radar and on the chart, and a commission taken by one
                can go on the convoy&rsquo;s books for any of you to finish. Nothing is
                signed — a convoy is an arrangement, not a charter, and anybody may leave
                at any hour.
              </p>
            </div>
          )}

          {inConvoy && rows.length > 0 && (
            <table className="convoy__table">
              <thead>
                <tr>
                  <th scope="col">Captain</th>
                  <th scope="col">Where</th>
                  {convoy.isLeader && (
                    <th scope="col">
                      <span className="visually-hidden">What you may do</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((member) => {
                  const marks = rowMarks(member);
                  return (
                    <tr
                      key={member.callsign}
                      className={[
                        member.isSelf ? 'convoy__row--self' : '',
                        member.state === 'invited' ? 'convoy__row--asked' : '',
                      ]
                        .filter((part) => part !== '')
                        .join(' ')}
                    >
                      <th scope="row">
                        <span className="convoy__who">
                          <span
                            className={`dot convoy__dot convoy__dot--${
                              member.state === 'invited'
                                ? 'asked'
                                : member.online
                                  ? 'on'
                                  : 'off'
                            }`}
                            aria-hidden="true"
                          />
                          <span className="convoy__callsign">{member.callsign}</span>
                        </span>
                        {marks.length > 0 && (
                          <span className="micro convoy__marks">{marks.join(' · ')}</span>
                        )}
                      </th>
                      <td className="convoy__where">{whereLabel(member)}</td>
                      {convoy.isLeader && (
                        <td className="convoy__act">
                          {!member.isSelf && (
                            <button
                              type="button"
                              // A plain button: this is a row action repeated
                              // down a list, and a column of amber dilutes it
                              // as the player's signal colour.
                              className="button convoy__put-out"
                              disabled={busy}
                              title={
                                member.state === 'invited'
                                  ? `Take back the ask to ${member.callsign}`
                                  : `Put ${member.callsign} out of the convoy`
                              }
                              onClick={() => onRemove(member.callsign)}
                            >
                              {member.state === 'invited' ? 'Take it back' : 'Put them out'}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* --- Asks waiting on this captain ----------------------------- */}
          {convoy.invitations.length > 0 && (
            <section className="convoy__asks">
              <div className="convoy__asks-head">
                <span className="label">Asked of you</span>
                {inConvoy && (
                  <span className="micro">You would have to leave this convoy first</span>
                )}
              </div>
              <ul className="convoy__ask-list">
                {convoy.invitations.map((line) => (
                  <li key={line.fleetId} className="convoy__ask">
                    <span className="convoy__ask-who">
                      <span className="convoy__callsign">
                        {line.from === '' ? line.name : line.from}
                      </span>
                      <span className="micro convoy__marks">
                        {askMarks(line.from, line.name, sinceLabel(ageOf(line.at))).join(
                          ' · ',
                        )}
                      </span>
                    </span>
                    <span className="convoy__ask-acts">
                      <button
                        type="button"
                        className="button"
                        disabled={busy || inConvoy}
                        onClick={() => onAnswer(line.fleetId, true)}
                      >
                        Sail with them
                      </button>
                      <button
                        type="button"
                        className="button convoy__decline"
                        disabled={busy}
                        onClick={() => onAnswer(line.fleetId, false)}
                      >
                        Decline
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* --- Asking somebody along ------------------------------------ */}
          {ask.kind !== 'not-yours' && (
            <form className="convoy__form" onSubmit={submit}>
              <label className="label" htmlFor="convoy-callsign">
                Ask a captain to sail with you
              </label>
              <div className="convoy__form-row">
                <input
                  id="convoy-callsign"
                  className="convoy__field"
                  type="text"
                  value={draft}
                  disabled={busy || ask.kind === 'full'}
                  maxLength={CALLSIGN_LIMIT}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Callsign"
                  aria-describedby="convoy-ask-hint"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="button button--primary"
                  disabled={busy || ask.kind === 'full' || !askable(draft)}
                >
                  Ask
                </button>
              </div>
              <p className="convoy__hint" id="convoy-ask-hint">
                {ask.kind === 'full'
                  ? `A convoy will not take another hull: ${ask.limit} is the whole of it, and an ask nobody has answered still holds a berth.`
                  : inConvoy
                    ? `Room for ${ask.free} more. They answer whenever they are next on the link.`
                    : 'Asking opens the convoy. They answer whenever they are next on the link.'}
              </p>
            </form>
          )}

          {/* --- Leaving -------------------------------------------------- */}
          {inConvoy &&
            (leaving ? (
              <div
                className="convoy__confirm"
                role="group"
                aria-label="Leaving dissolves the convoy"
              >
                <p className="convoy__consequence">
                  You opened this convoy, so leaving dissolves it: the others will be
                  sailing alone, and any commission on its books comes off.
                </p>
                <div className="convoy__confirm-acts">
                  <button
                    type="button"
                    className="button convoy__dissolve"
                    // Lower and heavier than an ordinary press, per the
                    // feedback table's last row.
                    data-weight="destructive"
                    disabled={busy}
                    onClick={() => {
                      setLeaving(false);
                      onLeave();
                    }}
                  >
                    Dissolve it
                  </button>
                  <button type="button" className="button" onClick={() => setLeaving(false)}>
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <footer className="convoy__foot">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    if (convoy.isLeader) {
                      setLeaving(true);
                      return;
                    }
                    onLeave();
                  }}
                >
                  Leave the convoy
                </button>
                <span className="convoy__hint">
                  {convoy.isLeader
                    ? 'You opened it, so leaving dissolves it.'
                    : 'You can be asked along again afterwards.'}
                </span>
              </footer>
            ))}

          {/* Spoken as well as shown: a refusal that only appears is missed. */}
          {notice !== undefined && (
            <p className="convoy__notice" role="status">
              {notice}
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
