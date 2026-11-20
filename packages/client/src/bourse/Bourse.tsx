/**
 * The Bourse.
 *
 * A trading floor as a ledger page, in the idiom of the Staple and the
 * Moorings: dense columns of tabular figures read downward, not a shop. Four
 * regions, which are the four things spec section 10 asks for, plus the
 * Gazette beside the charts and the Register under it.
 *
 *   the market    every listing, its quote, its move since the last tick and
 *                 what the captain holds. The column to read down.
 *   the company   the selected listing: its quote against fair value, what it
 *                 earns, its float, and its price history as a chart.
 *   the ticket    buy or sell, with the impact shown before anything is
 *                 confirmed: the parcel's cost, the average a share, and
 *                 where the quote ends up.
 *   the book      the captain's holdings with cost basis, unrealised gain and
 *                 dividends drawn, totalled.
 *
 * Nothing here is authoritative. Every figure in the ticket is this client's
 * own arithmetic over the same pure pool functions the server trades with, so
 * the preview matches what the Bourse will do without the client ever being
 * trusted to decide it. The server fills what it can and answers with what it
 * actually did.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  affordableShares,
  quoteBuy,
  quoteSell,
  type Headline,
  type Listing,
  type Pool,
  type ShareQuote,
  type Standing,
} from '@marque/shared';

// EB Garamond is loaded where an in-world document renders, not in the entry
// point. The Gazette is one; nothing else on this screen uses it.
import '@fontsource/eb-garamond/latin-400.css';

import { formatQuote, PriceChart } from './chart.tsx';
import './bourse.css';

export interface BourseProps {
  readonly listings: readonly Listing[];
  readonly news: readonly Headline[];
  readonly standings: readonly Standing[];
  readonly marks: number;
  readonly berthName: string;
  readonly busy: boolean;
  readonly notice: string | undefined;
  /** Tuning the ticket needs for its preview. Pass straight to the pool functions. */
  readonly feeRate: number;
  readonly maxPoolFraction: number;
  onTrade: (side: 'buy' | 'sell', ticker: string, shares: number) => void;
  onClose: () => void;
}

/** Parcel sizes a captain actually deals in, rather than only a free field. */
const PARCELS = [10, 100, 1000] as const;

/** How long a dividend stays marked on its row, in milliseconds. */
const DIVIDEND_BADGE_MS = 6000;

/** How often the Gazette's ages are redrawn. */
const AGE_TICK_MS = 30_000;

// --- Arithmetic, all pure ------------------------------------------------

/**
 * The pool behind a listing, reconstructed from what the listing carries.
 *
 * A listing gives the quote and the shares the pool will part with, not the
 * pool itself — and it should not, because a client has no business holding
 * the exchange's reserves. The two invert cleanly: `available` is a fixed
 * fraction of the pool's shares, and the quote is its marks over its shares.
 * The reconstruction is exact to the mark except for the floor taken when
 * `available` was computed, which moves a preview by a mark at most on any
 * parcel worth previewing.
 */
export function poolOf(listing: Listing, maxPoolFraction: number): Pool {
  const shares =
    maxPoolFraction > 0
      ? Math.max(1, Math.round(listing.available / maxPoolFraction))
      : Math.max(1, listing.available);
  return { shares, marks: Math.max(1, Math.round(listing.price * shares)) };
}

/** The move since the last market tick, as a fraction of the old quote. */
export function moveOf(price: number, previous: number): number {
  if (!(previous > 0)) return 0;
  return (price - previous) / previous;
}

/** Which bound stops a purchase, so the field can say so before it is tried. */
export type BuyBound = 'pool' | 'cap' | 'marks';

export interface BuyLimit {
  readonly max: number;
  readonly bound: BuyBound;
  /** What the pool will part with in one order. */
  readonly available: number;
  /** Shares the captain may still take before the holding cap. */
  readonly room: number;
  /** Shares their marks cover. */
  readonly affordable: number;
}

/**
 * The most shares a captain may buy, and what stops them.
 *
 * Three bounds apply at once: the pool will only sell a fraction of its
 * shares in one order, a captain may not hold more than a share of the float,
 * and marks run out. The binding one is named so the ticket can explain the
 * ceiling rather than just enforce it.
 */
export function buyLimit(
  listing: Listing,
  marks: number,
  feeRate: number,
  maxPoolFraction: number,
): BuyLimit {
  const pool = poolOf(listing, maxPoolFraction);
  const available = Math.max(0, listing.available);
  const room = Math.max(0, listing.holdingCap - listing.held);
  const affordable = affordableShares(pool, marks, feeRate, maxPoolFraction);
  const bound: BuyBound =
    room <= affordable && room <= available
      ? 'cap'
      : affordable <= available
        ? 'marks'
        : 'pool';

  return {
    max: Math.min(available, room, affordable),
    bound,
    available,
    room,
    affordable,
  };
}

/** One line of the captain's book. */
export interface Holding {
  readonly ticker: string;
  readonly name: string;
  readonly shares: number;
  readonly costBasis: number;
  /** Marks a share paid, over the whole position. */
  readonly averageCost: number;
  readonly price: number;
  /** The position at the quote now. */
  readonly value: number;
  readonly gain: number;
  readonly gainFraction: number;
  readonly dividends: number;
}

/**
 * The book, derived from the same listings the market column draws.
 *
 * A company the captain has sold out of but drew dividends from stays on the
 * page: the dividends are a fact about their year, and dropping the row would
 * lose them.
 */
export function holdingsOf(listings: readonly Listing[]): readonly Holding[] {
  return listings
    .filter((listing) => listing.held > 0 || listing.dividends > 0)
    .map((listing) => {
      const value = listing.held * listing.price;
      const gain = value - listing.costBasis;
      return {
        ticker: listing.ticker,
        name: listing.name,
        shares: listing.held,
        costBasis: listing.costBasis,
        averageCost: listing.held > 0 ? listing.costBasis / listing.held : 0,
        price: listing.price,
        value,
        gain,
        gainFraction: listing.costBasis > 0 ? gain / listing.costBasis : 0,
        dividends: listing.dividends,
      };
    })
    .sort((a, b) => b.value - a.value || a.ticker.localeCompare(b.ticker));
}

/** What the book comes to. */
export interface Book {
  readonly costBasis: number;
  readonly value: number;
  readonly gain: number;
  readonly gainFraction: number;
  readonly dividends: number;
}

export function bookOf(holdings: readonly Holding[]): Book {
  const costBasis = holdings.reduce((sum, row) => sum + row.costBasis, 0);
  const value = holdings.reduce((sum, row) => sum + row.value, 0);
  return {
    costBasis,
    value,
    gain: value - costBasis,
    gainFraction: costBasis > 0 ? (value - costBasis) / costBasis : 0,
    dividends: holdings.reduce((sum, row) => sum + row.dividends, 0),
  };
}

/** Marks, to the mark, with the separators a ledger uses. */
export function formatMarks(marks: number): string {
  return Math.round(marks).toLocaleString();
}

/** A signed move. Never colour alone: the sign carries it too. */
export function formatPercent(fraction: number, places = 1): string {
  const shown = Number((fraction * 100).toFixed(places));
  if (shown === 0) return `${(0).toFixed(places)}%`;
  return `${shown > 0 ? '+' : '-'}${Math.abs(fraction * 100).toFixed(places)}%`;
}

/** An unsigned rate, such as the fee: 0.005 reads as 0.5%. */
export function formatRate(fraction: number, places = 1): string {
  return `${(fraction * 100).toFixed(places).replace(/\.0$/, '')}%`;
}

/** How long ago a headline was filed, in the Gazette's words. */
export function ageLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// --- The screen ----------------------------------------------------------

type SortKey = 'ticker' | 'name' | 'price' | 'move' | 'held';

/** An order sent and not yet answered, kept so the fill can be reported. */
interface Sent {
  readonly side: 'buy' | 'sell';
  readonly ticker: string;
  readonly heldBefore: number;
  readonly costBefore: number;
  readonly marksBefore: number;
  acknowledged: boolean;
}

/** What the Bourse actually did, once it has answered. */
interface Fill {
  readonly side: 'buy' | 'sell';
  readonly ticker: string;
  readonly shares: number;
  /** Marks that moved, or 0 when the purse cannot be read for it. */
  readonly marks: number;
}

export function Bourse({
  listings,
  news,
  standings,
  marks,
  berthName,
  busy,
  notice,
  feeRate,
  maxPoolFraction,
  onTrade,
  onClose,
}: BourseProps): React.JSX.Element {
  const [selected, setSelected] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'ticker',
    descending: false,
  });
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [parcel, setParcel] = useState('');
  const [feed, setFeed] = useState<'all' | 'company'>('all');
  const [fill, setFill] = useState<Fill | undefined>(undefined);
  const [dividend, setDividend] = useState<{ ticker: string; marks: number } | undefined>(
    undefined,
  );

  const rows = useMemo(() => {
    const ordered = [...listings].sort((a, b) => {
      const by = (listing: Listing): number | string => {
        switch (sort.key) {
          case 'price':
            return listing.price;
          case 'move':
            return moveOf(listing.price, listing.previous);
          case 'held':
            return listing.held;
          case 'name':
            return listing.name;
          case 'ticker':
            return listing.ticker;
        }
      };
      const left = by(a);
      const right = by(b);
      const order =
        typeof left === 'string' && typeof right === 'string'
          ? left.localeCompare(right)
          : Number(left) - Number(right);
      return sort.descending ? -order : order;
    });
    return ordered;
  }, [listings, sort]);

  const current = listings.find((listing) => listing.ticker === selected) ?? rows[0];

  // The ticket is specific to a side and a company, so a parcel typed for one
  // does not carry over to another, and a reported fill belongs to the order
  // that caused it.
  useEffect(() => {
    setParcel('');
    setFill(undefined);
  }, [current?.ticker, side]);

  const holdings = useMemo(() => holdingsOf(listings), [listings]);
  const book = useMemo(() => bookOf(holdings), [holdings]);

  /**
   * The Gazette's clock.
   *
   * `at` is the server's wall clock and this client's need not agree with it,
   * so ages are measured from the newest headline this client has seen: the
   * real time elapsed since it arrived, plus the server's own spacing between
   * it and the older ones. Same idiom as the chat overlay, which fades a line
   * from when it was seen rather than from when it was said.
   */
  const anchor = useRef<{ at: number; perf: number } | undefined>(undefined);
  const [now, setNow] = useState(() => performance.now());
  const newest = news.reduce((latest, headline) => Math.max(latest, headline.at), 0);
  if (newest > 0 && (anchor.current === undefined || newest > anchor.current.at)) {
    anchor.current = { at: newest, perf: performance.now() };
  }

  useEffect(() => {
    if (news.length === 0) return;
    const timer = setInterval(() => setNow(performance.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [news.length]);

  const ageOf = useCallback(
    (headline: Headline): number => {
      const since = anchor.current;
      if (!since) return 0;
      return now - since.perf + (since.at - headline.at);
    },
    [now],
  );

  /** An order sent to the floor, so its answer can be reported as a fill. */
  const sent = useRef<Sent | undefined>(undefined);

  useEffect(() => {
    const order = sent.current;
    if (!order) return;
    // The parent has taken the order; wait for it to come back.
    if (busy) {
      order.acknowledged = true;
      return;
    }
    const listing = listings.find((candidate) => candidate.ticker === order.ticker);
    const moved = listing ? Math.abs(listing.held - order.heldBefore) : 0;
    // A parent that answers without ever raising `busy` is recognised by the
    // holding changing, or by a notice arriving to say it was refused.
    if (!order.acknowledged && moved === 0 && notice === undefined) return;

    sent.current = undefined;
    if (!listing || moved === 0) return;
    setFill({
      side: order.side,
      ticker: order.ticker,
      shares: moved,
      // Buying, the cost basis rises by exactly what was paid. Selling, the
      // basis falls by the basis of the shares that left, which is not the
      // proceeds, so the purse is read instead.
      marks:
        order.side === 'buy'
          ? Math.max(0, listing.costBasis - order.costBefore)
          : Math.max(0, marks - order.marksBefore),
    });
  }, [busy, listings, marks, notice]);

  /**
   * Dividends landing while the screen is open.
   *
   * A listing carries the total drawn from each company, not a payment log, so
   * a payment is recognised as that total going up. The first pass only takes
   * a reading: everything already drawn before the screen opened is history,
   * not news.
   */
  const drawn = useRef<Map<string, number> | undefined>(undefined);
  useEffect(() => {
    const before = drawn.current;
    const after = new Map(listings.map((listing) => [listing.ticker, listing.dividends]));
    drawn.current = after;
    if (!before) return;

    for (const [ticker, total] of after) {
      const was = before.get(ticker) ?? total;
      if (total > was) {
        setDividend({ ticker, marks: total - was });
        return;
      }
    }
  }, [listings]);

  useEffect(() => {
    if (!dividend) return;
    const timer = setTimeout(() => setDividend(undefined), DIVIDEND_BADGE_MS);
    return () => clearTimeout(timer);
  }, [dividend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      // Arrows walk the market column, unless something is taking typing.
      if (event.target instanceof HTMLInputElement) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (rows.length === 0) return;
      event.preventDefault();
      const at = rows.findIndex((listing) => listing.ticker === current?.ticker);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))];
      if (next) setSelected(next.ticker);
    },
    [current?.ticker, onClose, rows],
  );

  const send = useCallback(
    (ticker: string, shares: number) => {
      const listing = listings.find((candidate) => candidate.ticker === ticker);
      if (!listing || shares < 1) return;
      sent.current = {
        side,
        ticker,
        heldBefore: listing.held,
        costBefore: listing.costBasis,
        marksBefore: marks,
        acknowledged: false,
      };
      setFill(undefined);
      onTrade(side, ticker, shares);
    },
    [listings, marks, onTrade, side],
  );

  const gazette = useMemo(() => {
    const ordered = [...news].sort((a, b) => b.at - a.at);
    if (feed === 'all' || !current) return ordered;
    return ordered.filter((headline) => headline.ticker === current.ticker);
  }, [current, feed, news]);

  return (
    <main
      className="bourse"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="the Bourse"
    >
      <header className="bourse__head panel">
        <div className="bourse__title">
          <h1>the Bourse</h1>
          <span className="micro">{berthName}</span>
        </div>

        <dl className="bourse__purse">
          <div>
            <dt className="label">Marks</dt>
            <dd className="data bourse__marks">{formatMarks(marks)}</dd>
          </div>
          <div>
            <dt className="label">Shares at quote</dt>
            <dd className="data">{formatMarks(book.value)}</dd>
          </div>
          <div>
            <dt className="label">Unrealised</dt>
            <dd className={`data ${toneOf(book.gain)}`}>
              {book.gain === 0 ? formatMarks(0) : signed(book.gain)}
            </dd>
          </div>
          <div>
            <dt className="label">Dividends drawn</dt>
            <dd className="data">{formatMarks(book.dividends)}</dd>
          </div>
        </dl>

        <button type="button" className="button" onClick={onClose}>
          Leave the floor
        </button>
      </header>

      <section className="bourse__market panel" aria-label="Listings">
        <header className="panel-header">
          <h2>Listings</h2>
          <span className="micro">{listings.length} companies</span>
        </header>

        <div className="bourse__scroll">
          {listings.length === 0 ? (
            <p className="bourse__empty">
              The floor is quoting nothing. No company is listed here.
            </p>
          ) : (
            <Market
              rows={rows}
              selected={current?.ticker ?? ''}
              sort={sort}
              onSort={setSort}
              onSelect={setSelected}
            />
          )}
        </div>

        <footer className="bourse__terms">
          <dl>
            <div>
              <dt className="label">Fee an order</dt>
              <dd className="data">{formatRate(feeRate)}</dd>
            </div>
            <div>
              <dt className="label">A pool will part with</dt>
              <dd className="data">{formatRate(maxPoolFraction)}</dd>
            </div>
          </dl>
          <p className="micro">
            Each stock trades against a pool of shares and marks, so a quote
            always exists. Every market tick the house trader moves each quote a
            step toward fair value; your own orders push it the other way.
          </p>
        </footer>
      </section>

      {current ? (
        <>
          <section className="bourse__company panel" aria-label={current.name}>
            <Company
              listing={current}
              news={news}
              onReadGazette={() => setFeed('company')}
            />
          </section>

          <section className="bourse__ticket panel" aria-label="Order">
            <Ticket
              listing={current}
              marks={marks}
              busy={busy}
              notice={notice}
              fill={fill}
              feeRate={feeRate}
              maxPoolFraction={maxPoolFraction}
              side={side}
              parcel={parcel}
              onSide={setSide}
              onParcel={setParcel}
              onSend={send}
            />
          </section>
        </>
      ) : (
        <section className="bourse__company panel">
          <header className="panel-header">
            <h2>The floor</h2>
          </header>
          <p className="bourse__empty">
            Nothing is listed at {berthName}, so there is nothing to quote and
            nothing to buy.
          </p>
        </section>
      )}

      <section className="bourse__book panel" aria-label="Your holdings">
        <header className="panel-header">
          <h2>Your book</h2>
          <span className="micro">
            {holdings.length === 0
              ? 'Nothing held'
              : `${holdings.length} ${holdings.length === 1 ? 'company' : 'companies'}`}
          </span>
        </header>
        <div className="bourse__scroll bourse__scroll--wide">
          <Portfolio
            holdings={holdings}
            book={book}
            filled={fill?.ticker}
            dividend={dividend}
            onSelect={setSelected}
          />
        </div>
      </section>

      <section className="bourse__gazette panel" aria-label="the Gazette">
        <header className="panel-header">
          <h2>the Gazette</h2>
          <div className="bourse__tabs" role="group" aria-label="What the Gazette shows">
            <button
              type="button"
              className={`bourse__tab${feed === 'all' ? ' bourse__tab--on' : ''}`}
              aria-pressed={feed === 'all'}
              onClick={() => setFeed('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`bourse__tab${feed === 'company' ? ' bourse__tab--on' : ''}`}
              aria-pressed={feed === 'company'}
              disabled={!current}
              onClick={() => setFeed('company')}
            >
              {current?.ticker ?? 'Company'}
            </button>
          </div>
        </header>

        <div className="bourse__scroll">
          {gazette.length === 0 ? (
            <p className="bourse__empty">
              {feed === 'company' && current
                ? `The Gazette has printed nothing about ${current.name}. It prints what moves earnings, and nothing has.`
                : 'The Gazette has printed nothing yet. It files a line whenever something moves a company’s earnings.'}
            </p>
          ) : (
            <ol className="gazette">
              {gazette.map((headline) => (
                <li
                  key={headline.id}
                  className={`gazette__item gazette__item--${headline.direction}${
                    current && headline.ticker === current.ticker
                      ? ' gazette__item--selected'
                      : ''
                  }`}
                >
                  <p className="gazette__text">{headline.text}</p>
                  <p className="gazette__meta micro">
                    <span>{headline.ticker === '' ? 'The floor' : headline.ticker}</span>
                    <span>{ageLabel(ageOf(headline))}</span>
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="bourse__register panel" aria-label="the Register">
        <header className="panel-header">
          <h2>the Register</h2>
          <span className="micro">By net worth</span>
        </header>
        <div className="bourse__scroll">
          <Register standings={standings} />
        </div>
      </section>
    </main>
  );
}

// --- The market column ---------------------------------------------------

interface MarketProps {
  readonly rows: readonly Listing[];
  readonly selected: string;
  readonly sort: { key: SortKey; descending: boolean };
  onSort: (sort: { key: SortKey; descending: boolean }) => void;
  onSelect: (ticker: string) => void;
}

const COLUMNS: readonly { key: SortKey; head: string; figure: boolean }[] = [
  { key: 'name', head: 'Company', figure: false },
  { key: 'price', head: 'Quote', figure: true },
  { key: 'move', head: 'Move', figure: true },
  { key: 'held', head: 'Held', figure: true },
];

function Market({ rows, selected, sort, onSort, onSelect }: MarketProps): React.JSX.Element {
  return (
    <table className="market">
      <thead>
        <tr>
          {COLUMNS.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={column.figure ? 'market__figure' : undefined}
              aria-sort={
                sort.key === column.key
                  ? sort.descending
                    ? 'descending'
                    : 'ascending'
                  : 'none'
              }
            >
              <button
                type="button"
                className="market__sort"
                title={`Sort by ${column.head.toLowerCase()}`}
                onClick={() =>
                  onSort({
                    key: column.key,
                    // Figures are most useful largest first; names are not.
                    descending:
                      sort.key === column.key ? !sort.descending : column.figure,
                  })
                }
              >
                {column.head}
                <span className="market__caret" aria-hidden="true">
                  {sort.key === column.key ? (sort.descending ? '▾' : '▴') : ''}
                </span>
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((listing) => {
          const move = moveOf(listing.price, listing.previous);
          return (
            <tr
              key={listing.ticker}
              className={`market__row${
                listing.ticker === selected ? ' market__row--on' : ''
              }`}
              onClick={() => onSelect(listing.ticker)}
            >
              <th scope="row">
                <button
                  type="button"
                  className="market__pick"
                  aria-current={listing.ticker === selected}
                  onClick={() => onSelect(listing.ticker)}
                >
                  <span className="market__ticker">{listing.ticker}</span>
                  <span className="market__name">{listing.name}</span>
                  <span className="market__sector micro">{listing.sector}</span>
                </button>
              </th>
              <td className="market__figure data">{formatQuote(listing.price)}</td>
              <td className={`market__figure data ${toneOf(move)}`}>
                {formatPercent(move)}
              </td>
              <td className="market__figure data">
                {listing.held > 0 ? (
                  formatMarks(listing.held)
                ) : (
                  <span className="market__none">&mdash;</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- The selected company ------------------------------------------------

interface CompanyProps {
  readonly listing: Listing;
  readonly news: readonly Headline[];
  onReadGazette: () => void;
}

function Company({ listing, news, onReadGazette }: CompanyProps): React.JSX.Element {
  const move = moveOf(listing.price, listing.previous);
  const against = moveOf(listing.price, listing.fairValue);
  const filed = news.filter((headline) => headline.ticker === listing.ticker).length;

  return (
    <>
      <header className="panel-header">
        <div className="company__title">
          <h2>
            <span className="company__ticker">{listing.ticker}</span>
            {listing.name}
          </h2>
          <span className="micro">
            {listing.parent} &middot; {listing.sector}
          </span>
        </div>
        <button type="button" className="button company__read" onClick={onReadGazette}>
          {filed === 0
            ? 'Nothing in the Gazette'
            : `${filed} in the Gazette`}
        </button>
      </header>

      <div className="company__body">
        <p className="company__description">{listing.description}</p>

        <dl className="company__figures">
          <div>
            <dt className="label">Quote</dt>
            <dd className="data company__quote">{formatQuote(listing.price)}</dd>
          </div>
          <div>
            <dt className="label">Since last tick</dt>
            <dd className={`data company__quote ${toneOf(move)}`}>
              {formatPercent(move)}
            </dd>
          </div>
          <div>
            <dt className="label">Fair value</dt>
            <dd className="data">
              {formatQuote(listing.fairValue)}
              <span className="company__note micro">
                quote {against >= 0 ? 'above' : 'below'} by{' '}
                {formatPercent(Math.abs(against))}
              </span>
            </dd>
          </div>
          <div>
            <dt className="label">Earnings a tick</dt>
            <dd className="data">{formatMarks(listing.earnings)}</dd>
          </div>
          <div>
            <dt className="label">Float</dt>
            <dd className="data">
              {formatMarks(listing.float)}
              <span className="company__note micro">
                one captain may hold {formatMarks(listing.holdingCap)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="label">You hold</dt>
            <dd className="data">
              {listing.held > 0 ? formatMarks(listing.held) : '—'}
              <span className="company__note micro">
                {listing.held > 0
                  ? `worth ${formatMarks(listing.held * listing.price)} marks`
                  : 'nothing yet'}
              </span>
            </dd>
          </div>
        </dl>

        <PriceChart
          history={listing.history}
          price={listing.price}
          fairValue={listing.fairValue}
          name={listing.name}
        />
      </div>
    </>
  );
}

// --- The order ticket ----------------------------------------------------

interface TicketProps {
  readonly listing: Listing;
  readonly marks: number;
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly fill: Fill | undefined;
  readonly feeRate: number;
  readonly maxPoolFraction: number;
  readonly side: 'buy' | 'sell';
  readonly parcel: string;
  onSide: (side: 'buy' | 'sell') => void;
  onParcel: (parcel: string) => void;
  onSend: (ticker: string, shares: number) => void;
}

function Ticket({
  listing,
  marks,
  busy,
  notice,
  fill,
  feeRate,
  maxPoolFraction,
  side,
  parcel,
  onSide,
  onParcel,
  onSend,
}: TicketProps): React.JSX.Element {
  const pool = poolOf(listing, maxPoolFraction);
  const limit = buyLimit(listing, marks, feeRate, maxPoolFraction);
  const ceiling = side === 'buy' ? limit.max : listing.held;

  const asked = Number.parseInt(parcel === '' ? '0' : parcel, 10);
  const shares = Math.min(ceiling, Math.max(0, Number.isFinite(asked) ? asked : 0));

  const quote: ShareQuote =
    side === 'buy'
      ? quoteBuy(pool, shares, feeRate, maxPoolFraction)
      : quoteSell(pool, shares, feeRate);
  const impact = moveOf(quote.priceAfter, quote.priceBefore);

  const write = (value: number): void => {
    onParcel(value < 1 ? '' : String(Math.min(ceiling, value)));
  };

  return (
    <>
      <header className="panel-header">
        <h2>Order</h2>
        <div className="ticket__sides" role="group" aria-label="Side">
          {(['buy', 'sell'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`ticket__side${side === option ? ' ticket__side--on' : ''}`}
              aria-pressed={side === option}
              onClick={() => onSide(option)}
            >
              {option === 'buy' ? 'Buy' : 'Sell'}
            </button>
          ))}
        </div>
      </header>

      <div className="ticket__body">
        <div className="ticket__entry">
          <label className="label" htmlFor="ticket-shares">
            Shares
          </label>
          <input
            id="ticket-shares"
            className="ticket__field data"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={parcel}
            disabled={ceiling < 1}
            aria-describedby="ticket-ceiling"
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '');
              if (digits === '') {
                onParcel('');
                return;
              }
              write(Number.parseInt(digits, 10));
            }}
          />
          <div className="ticket__parcels">
            {PARCELS.map((size) => (
              <button
                key={size}
                type="button"
                className="ticket__parcel"
                disabled={size > ceiling}
                onClick={() => write(size)}
              >
                {size.toLocaleString()}
              </button>
            ))}
            <button
              type="button"
              className="ticket__parcel"
              disabled={ceiling < 1}
              title={
                side === 'buy'
                  ? 'The most the pool, the cap and your marks allow'
                  : 'Everything you hold'
              }
              onClick={() => write(ceiling)}
            >
              Max
            </button>
          </div>
        </div>

        <p id="ticket-ceiling" className="ticket__ceiling micro">
          {side === 'buy'
            ? limit.max < 1
              ? boundNothing(limit, listing)
              : `${formatMarks(limit.max)} at most: ${boundReason(limit, listing)}`
            : listing.held > 0
              ? `${formatMarks(listing.held)} at most, which is all you hold`
              : `You hold no ${listing.ticker} to sell`}
        </p>

        <dl className="ticket__preview">
          <div>
            <dt className="label">{side === 'buy' ? 'Parcel costs' : 'Parcel pays'}</dt>
            <dd className="data ticket__total">{formatMarks(quote.total)}</dd>
          </div>
          <div>
            <dt className="label">Average a share</dt>
            <dd className="data">
              {quote.shares > 0 ? formatQuote(quote.averagePrice) : '—'}
            </dd>
          </div>
          <div>
            <dt className="label">Fee, destroyed</dt>
            <dd className="data">{formatMarks(quote.fee)}</dd>
          </div>
          <div>
            <dt className="label">Quote ends at</dt>
            <dd className="data">
              {formatQuote(quote.priceAfter)}
              <span className={`ticket__impact micro ${toneOf(impact)}`}>
                {formatPercent(impact, 2)}
              </span>
            </dd>
          </div>
        </dl>

        {/*
          The filled order, which is the receipt: the ticket collapses to one
          line saying what the floor actually did, which need not be what was
          asked for. It slides into the book below it.
        */}
        {fill && fill.ticker === listing.ticker && (
          <p className="ticket__fill" role="status">
            <span className="dot" aria-hidden="true" />
            {fill.side === 'buy' ? 'Bought' : 'Sold'} {formatMarks(fill.shares)}{' '}
            {fill.ticker}
            {fill.marks > 0 &&
              ` ${fill.side === 'buy' ? 'for' : 'at'} ${formatMarks(fill.marks)} marks, ${formatQuote(fill.marks / fill.shares)} a share`}
          </p>
        )}

        {notice !== undefined && (
          <p className="ticket__notice" role="status">
            {notice}
          </p>
        )}

        <div className="ticket__confirm">
          <button
            type="button"
            className="button button--primary"
            disabled={busy || shares < 1 || shares > ceiling}
            onClick={() => onSend(listing.ticker, shares)}
          >
            {side === 'buy' ? 'Buy' : 'Sell'} {shares > 0 ? formatMarks(shares) : ''}{' '}
            {listing.ticker}
          </button>
          <span className="micro">
            {side === 'buy'
              ? 'Marks leave your purse when the floor answers.'
              : 'The fee comes out of the proceeds.'}
          </span>
        </div>
      </div>
    </>
  );
}

/** Why the ceiling is where it is, in one clause. */
function boundReason(limit: BuyLimit, listing: Listing): string {
  switch (limit.bound) {
    case 'cap':
      return `one captain may hold ${formatMarks(listing.holdingCap)} and you hold ${formatMarks(listing.held)}`;
    case 'marks':
      return 'that is what your marks cover';
    case 'pool':
      return 'that is what the pool will part with in one order';
  }
}

/** The same, when the answer is none at all. */
function boundNothing(limit: BuyLimit, listing: Listing): string {
  switch (limit.bound) {
    case 'cap':
      return `You hold the cap of ${formatMarks(listing.holdingCap)} already`;
    case 'marks':
      return 'Your marks will not cover one share';
    case 'pool':
      return 'The pool has nothing to sell until the next tick';
  }
}

// --- The book ------------------------------------------------------------

interface PortfolioProps {
  readonly holdings: readonly Holding[];
  readonly book: Book;
  /** A ticker just traded, marked while its receipt is up. */
  readonly filled: string | undefined;
  readonly dividend: { ticker: string; marks: number } | undefined;
  onSelect: (ticker: string) => void;
}

function Portfolio({
  holdings,
  book,
  filled,
  dividend,
  onSelect,
}: PortfolioProps): React.JSX.Element {
  if (holdings.length === 0) {
    return (
      <p className="bourse__empty">
        You hold no shares. A parcel bought on the floor is entered here with
        what it cost, what it is worth now, and anything it has paid you.
      </p>
    );
  }

  return (
    <table className="book">
      <thead>
        <tr>
          <th scope="col">Company</th>
          <th scope="col" className="book__figure">
            Shares
          </th>
          <th scope="col" className="book__figure">
            Cost
          </th>
          <th scope="col" className="book__figure">
            Average
          </th>
          <th scope="col" className="book__figure">
            Quote
          </th>
          <th scope="col" className="book__figure">
            Value
          </th>
          <th scope="col" className="book__figure">
            Unrealised
          </th>
          <th scope="col" className="book__figure">
            Dividends
          </th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((row) => (
          <tr
            key={row.ticker}
            className={`book__row${row.ticker === filled ? ' book__row--filled' : ''}`}
            onClick={() => onSelect(row.ticker)}
          >
            <th scope="row">
              <button type="button" className="book__pick" onClick={() => onSelect(row.ticker)}>
                <span className="book__ticker">{row.ticker}</span>
                <span className="book__name">{row.name}</span>
              </button>
            </th>
            <td className="book__figure data">{formatMarks(row.shares)}</td>
            <td className="book__figure data">{formatMarks(row.costBasis)}</td>
            <td className="book__figure data">
              {row.shares > 0 ? formatQuote(row.averageCost) : '—'}
            </td>
            <td className="book__figure data">{formatQuote(row.price)}</td>
            <td className="book__figure data">{formatMarks(row.value)}</td>
            <td className={`book__figure data ${toneOf(row.gain)}`}>
              {signed(row.gain)}
              <span className="book__note micro">{formatPercent(row.gainFraction)}</span>
            </td>
            <td className="book__figure data">
              {formatMarks(row.dividends)}
              {dividend?.ticker === row.ticker && (
                <span className="book__paid micro">
                  +{formatMarks(dividend.marks)} paid
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Totals</th>
          <td />
          <td className="book__figure data">{formatMarks(book.costBasis)}</td>
          <td />
          <td />
          <td className="book__figure data">{formatMarks(book.value)}</td>
          <td className={`book__figure data ${toneOf(book.gain)}`}>
            {signed(book.gain)}
            <span className="book__note micro">{formatPercent(book.gainFraction)}</span>
          </td>
          <td className="book__figure data">{formatMarks(book.dividends)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

// --- The Register --------------------------------------------------------

function Register({ standings }: { readonly standings: readonly Standing[] }): React.JSX.Element {
  const ranked = [...standings].sort(
    (a, b) => b.worth - a.worth || a.callsign.localeCompare(b.callsign),
  );

  if (ranked.length === 0) {
    return (
      <p className="bourse__empty">
        No captain has been valued yet. The Register ranks by marks, shares at
        the quote and hulls at what they cost to build.
      </p>
    );
  }

  return (
    <ol className="register">
      {ranked.map((standing, index) => (
        <li
          key={standing.callsign}
          className={`register__line${standing.isSelf ? ' register__line--self' : ''}`}
        >
          <span className="register__rank data">{index + 1}</span>
          <span className="register__who">
            <span className="register__callsign">{standing.callsign}</span>
            <span className="register__parts micro">
              {formatMarks(standing.marks)} marks &middot;{' '}
              {formatMarks(standing.shares)} in shares &middot;{' '}
              {formatMarks(standing.hulls)} in hulls
            </span>
          </span>
          <span className="register__worth data">{formatMarks(standing.worth)}</span>
        </li>
      ))}
    </ol>
  );
}

// --- Shared trimmings ----------------------------------------------------

/** Gain, loss or neither, as a class. Colour never carries it alone. */
function toneOf(value: number): string {
  if (value > 0) return 'is-gain';
  if (value < 0) return 'is-loss';
  return 'is-flat';
}

/** A signed figure, so a loss reads as one without its colour. */
function signed(marks: number): string {
  const rounded = Math.round(marks);
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '-'}${Math.abs(rounded).toLocaleString()}`;
}
