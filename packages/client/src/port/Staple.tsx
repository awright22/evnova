/**
 * The Staple: a berth's commodity market.
 *
 * One row per commodity, with what the berth charges, what it pays, how much
 * it is holding against what it wants, and how much the captain has aboard.
 * Prices come from the server with every answer it gives, so a row never
 * shows a number the berth would not honour.
 */

import { useCallback, useMemo, useState } from 'react';

import type { StapleState } from '../game/GameClient.ts';
import { Stamp } from '../seal/Stamp.tsx';
import './staple.css';

export interface StapleProps {
  readonly state: StapleState;
  readonly marks: number;
  readonly notice: string | undefined;
  readonly busy: boolean;
  onTrade: (side: 'buy' | 'sell', commodity: string, units: number) => void;
  onClose: () => void;
}

/** Sizes a captain actually trades in, rather than a free-text box. */
const LOTS = [1, 10, 50] as const;

export function Staple({
  state,
  marks,
  notice,
  busy,
  onTrade,
  onClose,
}: StapleProps): React.JSX.Element {
  const [lot, setLot] = useState<number>(10);

  const room = Math.max(0, state.holdCapacity - state.holdUsed);
  /**
   * More aboard than the bays hold.
   *
   * Reachable by refitting into a smaller hull with a full hold, and the
   * figure read as a plain "118 of 36" with nothing to say about it. The
   * berth already refuses more, so this is the line that says why.
   */
  const overladen = state.holdUsed > state.holdCapacity;

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  // The berth's own stock tells the captain which way it is leaning, which is
  // the whole reason to look at a market rather than at a price.
  const rows = useMemo(
    () =>
      state.listings.map((listing) => ({
        ...listing,
        standing:
          listing.pressure > 0.25
            ? ('glut' as const)
            : listing.pressure < -0.25
              ? ('short' as const)
              : ('even' as const),
      })),
    [state.listings],
  );

  return (
    <main className="staple" onKeyDown={onKeyDown} tabIndex={-1}>
      <section className="staple__panel panel">
        <header className="panel-header">
          <h2>the Staple</h2>
          <div className="staple__hold">
            <span className="label">Hold</span>
            <span className={`data${overladen ? ' is-loss' : ''}`}>
              {state.holdUsed} of {state.holdCapacity}
            </span>
            {overladen && (
              <span className="micro staple__overladen">
                Over her bays. Sell something or shift it to another hull.
              </span>
            )}
            <span className="label">Marks</span>
            <span className="data staple__marks">{marks.toLocaleString()}</span>
          </div>
        </header>

        {notice !== undefined && (
          <p className="staple__notice" role="status">
            {notice}
          </p>
        )}

        <div className="staple__lots" role="group" aria-label="Units per order">
          <span className="label">Lot</span>
          {LOTS.map((size) => (
            <button
              key={size}
              type="button"
              className={`staple__lot${lot === size ? ' staple__lot--on' : ''}`}
              onClick={() => setLot(size)}
            >
              {size}
            </button>
          ))}
        </div>

        <table className="staple__table">
          <thead>
            <tr>
              <th scope="col">Good</th>
              <th scope="col" className="staple__num">
                Buy
              </th>
              <th scope="col" className="staple__num">
                Sell
              </th>
              <th scope="col" className="staple__num">
                Berth
              </th>
              <th scope="col" className="staple__num">
                Aboard
              </th>
              <th scope="col">
                <span className="visually-hidden">Orders</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.commodityId} className={`staple__row staple__row--${row.standing}`}>
                <th scope="row" className="staple__good">
                  <span className="staple__good-stack">
                    <span className="staple__name">{row.name}</span>
                    <span className="micro">{row.tier}</span>
                  </span>
                </th>
                <td className="staple__num data">{row.ask.toLocaleString()}</td>
                <td className="staple__num data">{row.bid.toLocaleString()}</td>
                <td className="staple__num">
                  <span className="data">{row.stock.toLocaleString()}</span>
                  <span className={`staple__standing staple__standing--${row.standing}`}>
                    {row.standing === 'glut' ? 'glut' : row.standing === 'short' ? 'short' : 'even'}
                  </span>
                </td>
                <td className="staple__num data">{row.carried.toLocaleString()}</td>
                <td className="staple__orders">
                  <div className="staple__order-pair">
                    {/*
                      An order at a Staple is a document like any other, so
                      it is stamped: the berth's own seal, struck small
                      because a row is a line and not a bill.
                    */}
                    <Stamp
                      issuer={state.owner}
                      className="button staple__order"
                      size={30}
                      disabled={busy || row.stock < 1 || room < 1 || marks < row.ask}
                      onStamp={() => onTrade('buy', row.commodityId, lot)}
                    >
                      Buy
                    </Stamp>
                    <Stamp
                      issuer={state.owner}
                      className="button staple__order"
                      size={30}
                      disabled={busy || row.carried < 1}
                      onStamp={() => onTrade('sell', row.commodityId, lot)}
                    >
                      Sell
                    </Stamp>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <footer className="staple__footer">
          <span className="micro">
            A berth charges more for what it is short of and pays less for what it has too much
            of. Large orders move the price against you.
          </span>
          <button type="button" className="button" onClick={onClose}>
            Back to the berth
          </button>
        </footer>
      </section>
    </main>
  );
}
