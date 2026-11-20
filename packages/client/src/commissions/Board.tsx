/**
 * The Factor's board.
 *
 * What this berth is paying for, and what the captain already has in hand.
 * Both on one screen, because a board a captain cannot read their own work
 * against is half a screen: the first question anybody asks at a counter is
 * whether they can take another job.
 *
 * Nothing here is authoritative. The server rebuilds the offer from its own
 * board when a commission is taken, so what is shown is the quote and not
 * the contract.
 */

import { useMemo, useState } from 'react';

import type { CommissionOffer, HeldCommissionLine } from '@marque/shared';

import './board.css';

/**
 * An offer as the server posts it.
 *
 * The server's own type, not a copy of it. A copy drifted once already: the
 * rows in hand were pushed with their terms nested and every figure in the
 * third column came out undefined, which typechecked perfectly and only
 * showed up in a capture with a commission in it.
 */
export type BoardOffer = CommissionOffer;

/** One in hand, with the clock it is against. */
export type HeldOffer = HeldCommissionLine;

/** A finished chain, and the two ways out of it. */
export interface ChainEnding {
  readonly chain: string;
  readonly name: string;
  readonly charter: string;
  readonly choices: readonly {
    readonly id: string;
    readonly choice: string;
    readonly pay: number;
    readonly favours: boolean;
  }[];
}

export interface BoardProps {
  readonly offers: readonly BoardOffer[];
  readonly held: readonly HeldOffer[];
  readonly berthName: string;
  /** Present only at the one berth where this chain can be settled. */
  readonly ending: ChainEnding | undefined;
  /** The convoy this captain sails in, if any, so work can be shared with it. */
  readonly convoyName: string | undefined;
  readonly busy: boolean;
  readonly notice: string | undefined;
  onTake: (id: string) => void;
  onAbandon: (id: string) => void;
  onShare: (id: string, shared: boolean) => void;
  onChooseEnding: (chain: string, ending: string, name: string) => void;
  onClose: () => void;
}

/** What each kind of work is, in a word a captain can scan a column by. */
const KINDS: Record<string, string> = {
  delivery: 'Carriage',
  passengers: 'Passage',
  bounty: 'Bounty',
  escort: 'Escort',
  smuggling: 'Running',
};

const CHARTERS: Record<string, string> = {
  kessler: 'Kessler & Daughters',
  thirty: 'The Thirty',
  reprisal: 'The Reprisal Company',
};

export function Board({
  offers,
  held,
  berthName,
  ending,
  convoyName,
  busy,
  notice,
  onTake,
  onAbandon,
  onShare,
  onChooseEnding,
  onClose,
}: BoardProps): React.JSX.Element {
  const [reading, setReading] = useState<string | undefined>(undefined);
  const [intending, setIntending] = useState<string | undefined>(undefined);

  const chosen = useMemo(
    () => offers.find((offer) => offer.id === reading) ?? offers[0],
    [offers, reading],
  );

  return (
    <main className="board">
      <section className="board__panel panel">
        <header className="panel-header">
          <h2>The Factor</h2>
          <div className="board__head-right">
            <span className="micro">{berthName}</span>
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {ending !== undefined && (
          <section className="board__ending">
            <div className="board__ending-head">
              <span className="label">The last of it</span>
              <h3>{ending.name}</h3>
              <p className="board__ending-lede">
                Everything that was asked has been carried, and the house is waiting on one
                more thing: what you are going to say. It is said here, and{' '}
                {CHARTERS[ending.charter] ?? 'the house'} will not ask twice.
              </p>
            </div>

            <ul className="board__choices">
              {ending.choices.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    className={`board__choice${
                      choice.id === intending ? ' board__choice--on' : ''
                    }`}
                    aria-pressed={choice.id === intending}
                    disabled={busy}
                    onClick={() => setIntending(choice.id)}
                  >
                    <span className="board__choice-text">{choice.choice}</span>
                    <span className="board__choice-foot micro">
                      <span className="data">{choice.pay.toLocaleString()} marks</span>
                      <span
                        className={
                          choice.favours ? 'board__with' : 'board__against'
                        }
                      >
                        {choice.favours
                          ? `${CHARTERS[ending.charter] ?? 'The house'} will thank you for it`
                          : `${CHARTERS[ending.charter] ?? 'The house'} will not forget it`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="board__ending-foot">
              <button
                type="button"
                className="button button--primary"
                disabled={busy || intending === undefined}
                onClick={() => {
                  if (intending === undefined) return;
                  onChooseEnding(ending.chain, intending, ending.name);
                  setIntending(undefined);
                }}
              >
                Set your hand to it
              </button>
              <span className="micro">
                A chain ends once. The other two houses read the Gazette the same hour.
              </span>
            </div>
          </section>
        )}

        <div className="board__columns">
          {/* --- What is posted ------------------------------------------- */}
          <div className="board__posted">
            <span className="label">Posted here</span>
            {offers.length === 0 ? (
              <p className="board__none">
                Nothing is posted. A Factor writes the board up through the day; come back
                later, or try a berth with more traffic.
              </p>
            ) : (
              <ul className="board__list">
                {offers.map((offer) => (
                  <li key={offer.id}>
                    <button
                      type="button"
                      className={`board__offer${
                        offer.id === chosen?.id ? ' board__offer--on' : ''
                      }`}
                      onClick={() => setReading(offer.id)}
                    >
                      <span className="board__offer-title">{offer.title}</span>
                      <span className="board__offer-foot micro">
                        <span>{KINDS[offer.kind] ?? offer.kind}</span>
                        <span className="data">{offer.pay.toLocaleString()}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- The one being read --------------------------------------- */}
          <div className="board__reading">
            {chosen === undefined ? (
              <p className="board__none">Nothing to read.</p>
            ) : (
              <>
                <h3>{chosen.title}</h3>
                <p className="board__brief">{chosen.brief}</p>

                <dl className="board__terms">
                  <div>
                    <dt className="label">Pays</dt>
                    <dd className="data">{chosen.pay.toLocaleString()} marks</dd>
                  </div>
                  <div>
                    <dt className="label">Posted by</dt>
                    <dd>{chosen.charter ? CHARTERS[chosen.charter] : 'the berth'}</dd>
                  </div>
                  {chosen.units > 0 && (
                    <div>
                      <dt className="label">To carry</dt>
                      <dd className="data">{chosen.units} units</dd>
                    </div>
                  )}
                  {chosen.toSystemId !== '' && (
                    <div>
                      <dt className="label">To</dt>
                      <dd>{chosen.toPortName ?? chosen.toPortId}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="label">Within</dt>
                    <dd>
                      {chosen.hours > 0 ? `${Math.round(chosen.hours)} hours` : 'no deadline'}
                    </dd>
                  </div>
                </dl>

                <div className="board__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy}
                    onClick={() => onTake(chosen.id)}
                  >
                    Take it on
                  </button>
                  <span className="micro">
                    The terms are fixed when you take it, not when you deliver.
                  </span>
                </div>
              </>
            )}
          </div>

          {/* --- What is already in hand ---------------------------------- */}
          <div className="board__held">
            <span className="label">In hand</span>
            {held.length === 0 ? (
              <p className="board__none">You are carrying no commissions.</p>
            ) : (
              <ul className="board__list">
                {held.map((row) => (
                  <li key={row.id} className="board__carried">
                    <span className="board__offer-title">{row.title}</span>
                    <span className="board__offer-foot micro">
                      <span>{KINDS[row.kind] ?? row.kind}</span>
                      <span className="data">{row.pay.toLocaleString()}</span>
                    </span>
                    {row.toSystemId !== '' && (
                      <span className="board__carried-to">
                        to {row.toPortName ?? row.toPortId}
                      </span>
                    )}
                    {/*
                      Somebody else's, shared with the convoy. There is
                      nothing to give up — it is not this captain's to give —
                      so the row says whose it is and stops there.
                    */}
                    {row.holder !== '' ? (
                      <span className="board__carried-to">{row.holder}’s, shared</span>
                    ) : (
                      <div className="board__carried-acts">
                        <button
                          type="button"
                          className="button board__give-up"
                          disabled={busy}
                          onClick={() => onAbandon(row.id)}
                        >
                          Give it up
                        </button>
                        {convoyName !== undefined && (
                          <button
                            type="button"
                            className={`button board__give-up${
                              row.shared ? ' board__shared' : ''
                            }`}
                            disabled={busy}
                            aria-pressed={row.shared}
                            onClick={() => onShare(row.id, !row.shared)}
                          >
                            {row.shared ? 'On the books' : 'Share it'}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {notice !== undefined && <p className="board__notice">{notice}</p>}
      </section>
    </main>
  );
}
