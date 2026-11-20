/**
 * Offers alongside.
 *
 * Two captains landed at the same berth hand each other marks, cargo and
 * draughts. An offer is one-sided with a price: these goods, for these marks,
 * where the price is what the receiving captain pays and a negative figure is
 * the offering captain paying them instead. A swap is two offers.
 *
 * Two halves. The left is the ticket, in the Bourse's idiom: every figure the
 * offer will move is on the page before anything is sent — what leaves the
 * hold, which draught goes with it, which way the marks run, and what the
 * purse comes to afterwards. The right is what is open either way, with
 * anything waiting on this captain first, because that is the only thing on
 * the screen somebody else is standing at a berth waiting for.
 *
 * A half with nothing in it is not drawn. Nobody alongside is the ordinary
 * state of this screen and it gets one statement; nothing open gets a line at
 * the foot; and the panel is the width of what it is carrying.
 *
 * Nothing here is authoritative. The guards are the server's own, run again on
 * this side so that a captain is told why a control is shut rather than being
 * let press it and read a refusal back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { OffersState, TradeOfferLine } from '@marque/shared';

import { Stamp } from '../seal/Stamp.tsx';

import './offers.css';

/** A commodity aboard, as the parcel picker needs it. */
export interface HoldLine {
  readonly commodityId: string;
  readonly name: string;
  readonly units: number;
}

/** A draught on this captain's books. */
export interface DesignLine {
  readonly id: string;
  readonly name: string;
}

/**
 * An offer as it is sent.
 *
 * The same shape the ticket surveys, so what is checked is exactly what goes
 * across rather than a parallel description of it.
 */
export interface Draft {
  readonly callsign: string;
  /** What the receiving captain pays. Negative is this captain paying them. */
  readonly marks: number;
  readonly cargo: readonly { readonly commodityId: string; readonly units: number }[];
  /** A draught's id, or empty for none. */
  readonly design: string;
}

export interface OffersProps {
  readonly state: OffersState;
  /** What this captain is carrying, for the parcel picker. */
  readonly hold: readonly HoldLine[];
  /** Draughts on this captain's books, for the draught picker. */
  readonly designs: readonly DesignLine[];
  readonly marks: number;
  readonly berthName: string;
  /** Whose berth it is: the seal struck when an offer is taken up. */
  readonly owner: string;
  readonly busy: boolean;
  readonly notice: string | undefined;
  onOffer: (offer: Draft) => void;
  onAnswer: (id: string, accept: boolean) => void;
  onClose: () => void;
}

// --- Arithmetic and wording, all pure ------------------------------------

/** Which seat an offer is read from: the one who made it, or the one it is for. */
export type Side = 'offering' | 'receiving';

/** A parcel the picker has settled on, with the name to print. */
export interface Parcel {
  readonly commodityId: string;
  readonly name: string;
  readonly units: number;
}

/** Marks, to the mark, with the separators a ledger uses. */
export function formatMarks(marks: number): string {
  return Math.round(marks).toLocaleString();
}

/** A signed figure, so a fall reads as one without its colour. */
export function signedMarks(marks: number): string {
  const rounded = Math.round(marks);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toLocaleString()}`;
}

/** "12 units of Leaf", and "1 unit of Ice". Units are whole; a half unit is a bug. */
export function unitsPhrase(units: number, name: string): string {
  const whole = Math.round(units);
  return `${whole.toLocaleString()} ${whole === 1 ? 'unit' : 'units'} of ${name}`;
}

/**
 * The parcels the picker has actually settled on.
 *
 * Clamped against the hold rather than trusted, because the hold moves under
 * this screen: a captain can sell at the Staple in another window, or have an
 * offer of their own taken up, between typing a figure and sending it. Lines
 * the hold no longer carries drop out, and the hold's order is kept so the
 * manifest reads in the same order as the picker above it.
 *
 * The protocol takes at most sixteen parcels and there are ten commodities, so
 * a full hold cannot overflow an offer.
 */
export function parcelsOf(
  picked: Readonly<Record<string, number>>,
  hold: readonly HoldLine[],
): readonly Parcel[] {
  const parcels: Parcel[] = [];
  for (const line of hold) {
    const asked = Math.floor(picked[line.commodityId] ?? 0);
    const units = Math.min(Math.max(0, asked), Math.max(0, Math.floor(line.units)));
    if (units > 0) parcels.push({ commodityId: line.commodityId, name: line.name, units });
  }
  return parcels;
}

/** What a parcel list comes to, in units. */
export function totalUnits(parcels: readonly { readonly units: number }[]): number {
  return parcels.reduce((sum, parcel) => sum + Math.round(parcel.units), 0);
}

/** Why an offer cannot be sent. One at a time: a captain fixes one thing. */
export type Fault = 'no-captain' | 'short-cargo' | 'short-marks' | 'nothing-offered';

export interface Survey {
  readonly ok: boolean;
  readonly fault: Fault | undefined;
  /** What to print beside the shut control. Undefined when there is no fault. */
  readonly reason: string | undefined;
}

const SOUND: Survey = { ok: true, fault: undefined, reason: undefined };

/**
 * Whether an offer can be met out of this hold and this purse.
 *
 * The server checks all of this and is the authority on it. It is checked here
 * so the ticket can name the fault: a greyed button that does not say what is
 * wrong is a worse screen than one that lets the captain press it.
 *
 * An offer of nothing for marks is sound — that is a captain asking to be paid
 * — and so is an offer of goods for nothing, which is a gift. Only an offer
 * with nothing in it at all and no marks either way is empty.
 */
export function surveyOffer(
  draft: Draft,
  hold: readonly HoldLine[],
  purse: number,
): Survey {
  if (draft.callsign === '') {
    return {
      ok: false,
      fault: 'no-captain',
      reason: 'Choose which captain the offer is for.',
    };
  }

  for (const parcel of draft.cargo) {
    const line = hold.find((aboard) => aboard.commodityId === parcel.commodityId);
    const aboard = Math.max(0, Math.floor(line?.units ?? 0));
    if (parcel.units > aboard) {
      const name = line?.name ?? parcel.commodityId;
      return {
        ok: false,
        fault: 'short-cargo',
        reason: `You are carrying ${formatMarks(aboard)} ${aboard === 1 ? 'unit' : 'units'} of ${name}, not ${formatMarks(parcel.units)}.`,
      };
    }
  }

  if (draft.marks < 0 && -draft.marks > purse) {
    return {
      ok: false,
      fault: 'short-marks',
      reason: `You hold ${formatMarks(purse)} marks and cannot promise ${formatMarks(-draft.marks)}.`,
    };
  }

  if (totalUnits(draft.cargo) === 0 && draft.design === '' && draft.marks === 0) {
    return {
      ok: false,
      fault: 'nothing-offered',
      reason: 'The offer is empty. Put cargo, a draught or marks into it.',
    };
  }

  return SOUND;
}

/** What the purse comes to if an offer is taken up, from one side of it. */
export function purseAfter(purse: number, price: number, side: Side): number {
  return Math.round(side === 'offering' ? purse + price : purse - price);
}

/** An open offer as one side of it reads. */
export interface Reading {
  /** True when it is waiting on this captain to answer. */
  readonly inbound: boolean;
  /** The other captain. */
  readonly counterparty: string;
  /** "You are offering Prudent Return", or "Prudent Return is offering you". */
  readonly opening: string;
  /** What changes hands, in the order a manifest lists it. */
  readonly goods: readonly string[];
  /** "You pay", "You are paid", or "No marks either way". */
  readonly payLabel: string;
  /** The figure under that label, unsigned: the label carries the direction. */
  readonly payFigure: number;
}

/**
 * An offer, read from the seat of the captain looking at it.
 *
 * The line carries the price as the receiving captain's payment whichever way
 * it is going, which is the right thing to put on the wire and the wrong thing
 * to put on a screen: a captain reads their own purse, not the protocol's
 * convention. Both directions are resolved here into one plain statement of
 * who pays whom, so neither half of the screen has to reason about the sign.
 */
export function readOffer(line: TradeOfferLine): Reading {
  const counterparty = line.mine ? line.to : line.from;
  const goods = line.cargo.map((parcel) => unitsPhrase(parcel.units, parcel.name));
  if (line.designName !== '') goods.push(`the draught ${line.designName}`);

  // Positive is marks arriving in this captain's purse, either way round.
  const delta = line.mine ? line.marks : -line.marks;

  return {
    inbound: !line.mine,
    counterparty,
    opening: line.mine
      ? `You are offering ${counterparty}`
      : `${counterparty} is offering you`,
    goods,
    payLabel: delta > 0 ? 'You are paid' : delta < 0 ? 'You pay' : 'No marks either way',
    payFigure: Math.abs(Math.round(delta)),
  };
}

/**
 * How long an offer has been standing.
 *
 * Seconds are printed for the first minute, which no other screen bothers
 * with: an offer is a live negotiation with somebody standing at the same
 * berth, and the difference between ten seconds and fifty is the difference
 * between waiting and being ignored. Everything floors rather than rounds, so
 * the docket never claims more time has passed than has.
 */
export function sinceLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


// --- The screen ----------------------------------------------------------

/** Which captain the marks run to. The protocol's sign is derived from it. */
type Payer = 'them' | 'you';

/** The protocol's ceiling on a price, so the field cannot write a refusal. */
const PRICE_CAP = 1_000_000_000;

/** How often the dockets' ages are redrawn. */
const AGE_TICK_MS = 15_000;

export function Offers({
  state,
  hold,
  designs,
  marks,
  berthName,
  owner,
  busy,
  notice,
  onOffer,
  onAnswer,
  onClose,
}: OffersProps): React.JSX.Element {
  const counter = useRef<HTMLElement | null>(null);
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [design, setDesign] = useState('');
  const [payer, setPayer] = useState<Payer>('them');
  const [price, setPrice] = useState('');

  const { alongside, offers } = state;
  /** Room left in the bays, for an inbound parcel that may not fit in them. */
  const room = Math.max(0, state.holdCapacity - state.holdUsed);

  // The chosen captain and draught are clamped to what is still there: a
  // captain launches, and a draught can be sold out from under the picker.
  const chosen = alongside.includes(to) ? to : (alongside[0] ?? '');
  const held = designs.some((entry) => entry.id === design) ? design : '';

  const parcels = useMemo(() => parcelsOf(picked, hold), [picked, hold]);
  const figure = Math.min(PRICE_CAP, Number.parseInt(price === '' ? '0' : price, 10) || 0);

  const draft = useMemo<Draft>(
    () => ({
      callsign: chosen,
      marks: payer === 'them' ? figure : -figure,
      cargo: parcels.map((parcel) => ({
        commodityId: parcel.commodityId,
        units: parcel.units,
      })),
      design: held,
    }),
    [chosen, figure, held, parcels, payer],
  );

  const aboard = totalUnits(hold);
  const makeable = alongside.length > 0;

  const reset = useCallback((): void => {
    setPicked({});
    setDesign('');
    setPrice('');
    setPayer('them');
  }, []);

  /**
   * An offer of this captain's appearing is the receipt.
   *
   * The ticket is not cleared when the intent is sent, because an intent can
   * be refused and a captain should not have to pick the parcel out again to
   * find out why. It clears when the berth comes back with the offer actually
   * standing, which is also when the docket for it arrives on the right.
   */
  const sent = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const mine = new Set(offers.filter((line) => line.mine).map((line) => line.id));
    const before = sent.current;
    sent.current = mine;
    if (before === undefined) return;
    for (const id of mine) {
      if (!before.has(id)) {
        reset();
        return;
      }
    }
  }, [offers, reset]);

  /**
   * The dockets' clock.
   *
   * `offeredAt` is the server's wall clock and this client's need not agree
   * with it, so ages are measured from the newest offer this client has seen:
   * real time elapsed since it arrived, plus the server's own spacing between
   * it and the older ones. The same idiom as the Gazette and the chat overlay.
   */
  const anchor = useRef<{ at: number; perf: number } | undefined>(undefined);
  const [now, setNow] = useState(() => performance.now());
  const newest = offers.reduce((latest, line) => Math.max(latest, line.offeredAt), 0);
  if (newest > 0 && (anchor.current === undefined || newest > anchor.current.at)) {
    anchor.current = { at: newest, perf: performance.now() };
  }

  useEffect(() => {
    if (offers.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [offers.length]);

  const ageOf = useCallback(
    (line: TradeOfferLine): number => {
      const since = anchor.current;
      if (since === undefined) return 0;
      return now - since.perf + (since.at - line.offeredAt);
    },
    [now],
  );

  // Landed screens take the keyboard on arrival: the chart overlay stops
  // listening while a port screen is up, so Escape has to reach this element.
  useEffect(() => {
    counter.current?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    },
    [onClose],
  );

  const inbound = useMemo(
    () => offers.filter((line) => !line.mine).sort((a, b) => b.offeredAt - a.offeredAt),
    [offers],
  );
  const outbound = useMemo(
    () => offers.filter((line) => line.mine).sort((a, b) => b.offeredAt - a.offeredAt),
    [offers],
  );

  /**
   * Which regions the screen has anything to put in.
   *
   * Nobody alongside and nothing open is the ordinary state of standing at a
   * quiet berth, and it gets one statement at the width of the statement. In
   * the two states between, the half with nothing in it is dropped rather
   * than left standing empty: a column of nothing beside a full one reads as
   * a screen that failed to load, and a panel sizes to what it holds.
   */
  const open = offers.length > 0;
  const shape = makeable
    ? open
      ? 'both'
      : 'ticket'
    : open
      ? 'open'
      : 'alone';

  return (
    <main
      className="offers"
      ref={counter}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Offers alongside"
    >
      <section className={`offers__panel panel offers__panel--${shape}`}>
        <header className="panel-header">
          <div className="offers__title">
            <h2>Offers alongside</h2>
            <span className="micro">{berthName}</span>
          </div>
          <div className="offers__head-right">
            <dl className="offers__purse">
              <div>
                <dt className="label">Marks</dt>
                <dd className="data offers__marks">{formatMarks(marks)}</dd>
              </div>
              <div>
                <dt className="label">Aboard</dt>
                <dd className="data">{formatMarks(aboard)}</dd>
              </div>
              <div>
                <dt className="label">Draughts</dt>
                <dd className="data">{formatMarks(designs.length)}</dd>
              </div>
            </dl>
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {notice !== undefined && (
          <p className="offers__notice" role="status">
            {notice}
          </p>
        )}

        {shape === 'alone' ? (
          <p className="offers__lede">
            Nobody else is alongside at {berthName}. Marks, cargo and draughts change
            hands in person, so there is nobody to offer anything to and nothing open
            either way. This page fills in as soon as another captain is landed here
            with you.
          </p>
        ) : (
          <>
            {!makeable && (
              <p className="offers__lede">
                Nobody else is alongside at {berthName}, so there is nobody to write a
                new offer to. What stands below stands until it is answered.
              </p>
            )}

            <div className="offers__columns">
              {makeable && (
                <Ticket
                  draft={draft}
                  parcels={parcels}
                  hold={hold}
                  designs={designs}
                  marks={marks}
                  alongside={alongside}
                  chosen={chosen}
                  held={held}
                  payer={payer}
                  price={price}
                  busy={busy}
                  onTo={setTo}
                  onPicked={setPicked}
                  onDesign={setDesign}
                  onPayer={setPayer}
                  onPrice={setPrice}
                  onSend={onOffer}
                />
              )}

              {open && (
                <section className="offers__open" aria-label="Offers open">
                  <span className="label">Offers open</span>

                  <div className="offers__groups">
                    {inbound.length > 0 && (
                      <div className="offers__group">
                        <span className="micro offers__group-head offers__group-head--on">
                          Waiting on you
                        </span>
                        <ul className="offers__list">
                          {inbound.map((line) => (
                            <Docket
                              key={line.id}
                              line={line}
                              age={ageOf(line)}
                              marks={marks}
                              owner={owner}
                              room={room}
                              busy={busy}
                              onAnswer={onAnswer}
                            />
                          ))}
                        </ul>
                      </div>
                    )}

                    {outbound.length > 0 && (
                      <div className="offers__group">
                        <span className="micro offers__group-head">Out and waiting</span>
                        <ul className="offers__list">
                          {outbound.map((line) => (
                            <Docket
                              key={line.id}
                              line={line}
                              age={ageOf(line)}
                              marks={marks}
                              owner={owner}
                              room={room}
                              busy={busy}
                              onAnswer={onAnswer}
                            />
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>

            {makeable && !open && (
              <p className="offers__quiet">
                <span className="label">Offers open</span>
                Nothing is open either way, in or out. One stands here from the moment
                it is sent until it is answered or taken back.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}

// --- Writing one up ------------------------------------------------------

interface TicketProps {
  readonly draft: Draft;
  readonly parcels: readonly Parcel[];
  readonly hold: readonly HoldLine[];
  readonly designs: readonly DesignLine[];
  readonly marks: number;
  readonly alongside: readonly string[];
  readonly chosen: string;
  readonly held: string;
  readonly payer: Payer;
  readonly price: string;
  readonly busy: boolean;
  onTo: (callsign: string) => void;
  onPicked: (next: (was: Record<string, number>) => Record<string, number>) => void;
  onDesign: (id: string) => void;
  onPayer: (payer: Payer) => void;
  onPrice: (price: string) => void;
  onSend: (draft: Draft) => void;
}

/**
 * The order ticket: who it is for, what goes into it, and what it will do.
 *
 * Every figure the offer moves is on the page before the button can be
 * pressed. Where it cannot be pressed, the line beside it says which of the
 * four things is wrong rather than leaving a captain to guess at a grey
 * control.
 */
function Ticket({
  draft,
  parcels,
  hold,
  designs,
  marks,
  alongside,
  chosen,
  held,
  payer,
  price,
  busy,
  onTo,
  onPicked,
  onDesign,
  onPayer,
  onPrice,
  onSend,
}: TicketProps): React.JSX.Element {
  const survey = surveyOffer(draft, hold, marks);
  const after = purseAfter(marks, draft.marks, 'offering');
  const units = totalUnits(parcels);

  return (
    <section className="offers__make" aria-label="Make an offer">
      <span className="label">Make an offer</span>

      <div className="offers__field">
        <span className="label" id="offers-to">
          Hand it to
        </span>
        <div className="offers__chips" role="group" aria-labelledby="offers-to">
          {alongside.map((callsign) => (
            <button
              key={callsign}
              type="button"
              className={`offers__chip${callsign === chosen ? ' offers__chip--on' : ''}`}
              aria-pressed={callsign === chosen}
              onClick={() => onTo(callsign)}
            >
              {callsign}
            </button>
          ))}
        </div>
      </div>

      <div className="offers__field">
        <div className="offers__field-head">
          <span className="label">Out of your hold</span>
          {parcels.length > 0 && (
            <button type="button" className="offers__chip" onClick={() => onPicked(() => ({}))}>
              Take it all back
            </button>
          )}
        </div>

        {hold.length === 0 ? (
          <p className="offers__none">
            Your hold is empty. There is nothing aboard to hand across.
          </p>
        ) : (
          <table className="offers__hold">
            <thead>
              <tr>
                <th scope="col">Good</th>
                <th scope="col" className="offers__num">
                  Aboard
                </th>
                <th scope="col" className="offers__num">
                  Offering
                </th>
                <th scope="col">
                  <span className="visually-hidden">All of it</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hold.map((line) => {
                const carried = Math.max(0, Math.floor(line.units));
                const asked =
                  parcels.find((parcel) => parcel.commodityId === line.commodityId)?.units ?? 0;
                const write = (value: number): void => {
                  onPicked((was) => ({
                    ...was,
                    [line.commodityId]: Math.min(carried, Math.max(0, value)),
                  }));
                };
                return (
                  <tr
                    key={line.commodityId}
                    className={asked > 0 ? 'offers__row--on' : undefined}
                  >
                    <th scope="row" className="offers__good">
                      {line.name}
                    </th>
                    <td className="offers__num data">{formatMarks(carried)}</td>
                    <td className="offers__num">
                      <input
                        className="offers__units data"
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        aria-label={`Units of ${line.name} to offer`}
                        placeholder="0"
                        value={asked === 0 ? '' : String(asked)}
                        onChange={(event) => {
                          const digits = event.target.value.replace(/[^0-9]/g, '');
                          write(digits === '' ? 0 : Number.parseInt(digits, 10));
                        }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="offers__chip offers__all"
                        disabled={asked === carried}
                        title={`Offer all ${formatMarks(carried)} units of ${line.name}`}
                        onClick={() => write(carried)}
                      >
                        All
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="offers__field">
        <span className="label" id="offers-draught">
          A draught off your books
        </span>
        {designs.length === 0 ? (
          <p className="offers__none">
            No draughts on your books. The Loft writes one when you lay out a hull of
            your own.
          </p>
        ) : (
          <>
            <div
              className="offers__chips offers__chips--wrap"
              role="group"
              aria-labelledby="offers-draught"
            >
              <button
                type="button"
                className={`offers__chip${held === '' ? ' offers__chip--on' : ''}`}
                aria-pressed={held === ''}
                onClick={() => onDesign('')}
              >
                None
              </button>
              {designs.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`offers__chip${held === entry.id ? ' offers__chip--on' : ''}`}
                  aria-pressed={held === entry.id}
                  onClick={() => onDesign(entry.id)}
                >
                  {entry.name}
                </button>
              ))}
            </div>
            <p className="offers__aside">
              A draught is a copy of the plans. Handing one over leaves yours on your
              books.
            </p>
          </>
        )}
      </div>

      <div className="offers__field">
        <span className="label" id="offers-price">
          The price
        </span>
        <div className="offers__pricing">
          <div className="offers__chips" role="group" aria-labelledby="offers-price">
            {(
              [
                ['them', 'They pay'],
                ['you', 'You pay'],
              ] as const
            ).map(([option, text]) => (
              <button
                key={option}
                type="button"
                className={`offers__chip${payer === option ? ' offers__chip--on' : ''}`}
                aria-pressed={payer === option}
                disabled={option === 'you' && marks === 0}
                title={
                  option === 'you' && marks === 0
                    ? 'You hold no marks to promise'
                    : undefined
                }
                onClick={() => onPayer(option)}
              >
                {text}
              </button>
            ))}
          </div>
          <input
            id="offers-marks"
            className="offers__figure data"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label="Marks"
            placeholder="0"
            value={price}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '');
              onPrice(digits === '' ? '' : String(Math.min(PRICE_CAP, Number.parseInt(digits, 10))));
            }}
          />
          <span className="micro">marks</span>
        </div>
        <p className="offers__aside">
          Leave it at nothing for a gift. Set it against yourself and you are paying
          them to take it.
        </p>
      </div>

      <dl className="offers__preview">
        <div>
          <dt className="label">Leaves your hold</dt>
          <dd>
            <span className="data">
              {units === 0 ? 'Nothing' : `${formatMarks(units)} ${units === 1 ? 'unit' : 'units'}`}
            </span>
            {parcels.length > 0 && (
              <span className="offers__manifest">
                {parcels
                  .map((parcel) => `${parcel.name} ${formatMarks(parcel.units)}`)
                  .join(' · ')}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="label">Off your books</dt>
          <dd>
            <span className="data">
              {held === ''
                ? 'No draught'
                : (designs.find((entry) => entry.id === held)?.name ?? held)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="label">The price</dt>
          <dd>
            <span className="data offers__total">{formatMarks(Math.abs(draft.marks))}</span>
            <span className="offers__manifest">
              {draft.marks === 0
                ? 'neither way'
                : draft.marks > 0
                  ? 'they pay you'
                  : 'you pay them'}
            </span>
          </dd>
        </div>
        <div>
          <dt className="label">Your marks after</dt>
          <dd>
            {/* A purse cannot go below nothing. Where the price is more than
                this captain holds, the figure is not a figure at all and the
                line beside the shut button says so instead. */}
            <span
              className={`data offers__total${
                survey.fault === 'short-marks'
                  ? ''
                  : draft.marks > 0
                    ? ' offers__total--gain'
                    : draft.marks < 0
                      ? ' offers__total--loss'
                      : ''
              }`}
            >
              {survey.fault === 'short-marks' ? '\u2014' : formatMarks(after)}
            </span>
            <span className="offers__manifest">
              {draft.marks === 0 ? 'unchanged' : `${signedMarks(draft.marks)} on this offer`}
            </span>
          </dd>
        </div>
      </dl>

      <p className="offers__aside">
        An offer runs one way: you hand these over, and marks come back. For a swap, ask{' '}
        {chosen === '' ? 'the other captain' : chosen} for an offer of their own.
      </p>

      <div className="offers__confirm">
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !survey.ok}
          aria-describedby="offers-why"
          onClick={() => onSend(draft)}
        >
          {busy ? 'With the berth' : chosen === '' ? 'Send it across' : `Send it to ${chosen}`}
        </button>
        <span id="offers-why" className="offers__why">
          {survey.reason ??
            'Nothing moves until they answer. You can take it back until they do.'}
        </span>
      </div>
    </section>
  );
}

// --- One open offer ------------------------------------------------------

interface DocketProps {
  readonly line: TradeOfferLine;
  readonly age: number;
  readonly marks: number;
  /** Whose berth it is, for the seal struck when it is taken up. */
  readonly owner: string;
  /** Room left in the hull's bays, for an inbound parcel that may not fit. */
  readonly room: number;
  readonly busy: boolean;
  onAnswer: (id: string, accept: boolean) => void;
}

/**
 * An offer standing, as the captain looking at it reads it.
 *
 * Both directions use the same docket, because the figures a captain wants
 * are the same either way: what is in it, what it costs them, and what their
 * purse comes to. What differs is the answer at the foot.
 */
function Docket({
  line,
  age,
  marks,
  owner,
  room,
  busy,
  onAnswer,
}: DocketProps): React.JSX.Element {
  const reading = readOffer(line);
  const side: Side = reading.inbound ? 'receiving' : 'offering';
  const after = purseAfter(marks, line.marks, side);
  // An offer asking more than the purse holds cannot be taken up, and the
  // server will say so. Saying it here saves the captain the refusal.
  const short = reading.inbound && line.marks > marks;
  // And neither can one carrying more than the bays will take.
  const arriving = line.cargo.reduce((sum, parcel) => sum + parcel.units, 0);
  const overfull = reading.inbound && arriving > room;

  return (
    <li
      className={`offers__docket${reading.inbound ? ' offers__docket--inbound' : ''}`}
    >
      <div className="offers__docket-head">
        <p className="offers__reading">{reading.opening}</p>
        <span className="micro">{sinceLabel(age)}</span>
      </div>

      <ul className="offers__goods">
        {reading.goods.length === 0 ? (
          <li className="offers__goods-none">Nothing but marks</li>
        ) : (
          reading.goods.map((phrase, index) => (
            <li key={`${line.id}-${String(index)}`}>{phrase}</li>
          ))
        )}
      </ul>

      <dl className="offers__docket-figures">
        <div>
          <dt className="label">{reading.payLabel}</dt>
          <dd className="data">{formatMarks(reading.payFigure)}</dd>
        </div>
        <div>
          <dt className="label">Your marks after</dt>
          <dd
            className={`data${
              short
                ? ''
                : after < marks
                  ? ' offers__total--loss'
                  : after > marks
                    ? ' offers__total--gain'
                    : ''
            }`}
          >
            {/* A purse cannot go below nothing, so an offer that cannot be
                met shows no figure; the line under it says how far short. */}
            {short ? '—' : formatMarks(after)}
          </dd>
        </div>
      </dl>

      {short && (
        <p className="offers__short">
          You hold {formatMarks(marks)} marks and this asks {formatMarks(line.marks)}.
        </p>
      )}

      {overfull && !short && (
        <p className="offers__short">
          {arriving.toLocaleString()} units will not go aboard: the bays have room for{' '}
          {room.toLocaleString()}.
        </p>
      )}

      <div className="offers__docket-actions">
        {reading.inbound ? (
          <>
            {/*
              Taking an offer up is the trade being struck, and spec section
              4 stamps a trade like any other document. Sending one is not:
              nothing has moved until the other captain answers.
            */}
            <Stamp
              issuer={owner}
              className="button"
              size={30}
              disabled={busy || short || overfull}
              onStamp={() => onAnswer(line.id, true)}
            >
              Take it up
            </Stamp>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => onAnswer(line.id, false)}
            >
              Turn it down
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => onAnswer(line.id, false)}
          >
            Take it back
          </button>
        )}
      </div>
    </li>
  );
}
