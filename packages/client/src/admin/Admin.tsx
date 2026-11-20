/**
 * The admin page.
 *
 * Spec section 12: behind the server's own configuration, showing ledger
 * totals by category, prices and stockpiles, and hot reload of tuning data.
 * Not a game screen — it is reached at `?admin=1` and has nothing to do with
 * flying — so it is its own page rather than another panel in the port.
 *
 * It names no captain. An operator looking at the shape of an economy has no
 * business reading anybody's purse, and a page that could would be a page
 * worth stealing a token for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ALL_CATEGORIES, categoryLabel, isFaucet, isTransfer } from '@marque/shared';

import { useScroller } from '../shell/scroller.ts';

import './admin.css';

interface LedgerRow {
  readonly category: string;
  readonly total: number;
  readonly count: number;
}

interface CommodityRow {
  readonly commodityId: string;
  readonly name: string;
  readonly stock: number;
  readonly mean: number;
  readonly low: number;
  readonly high: number;
  readonly atFloor: number;
  readonly atCeiling: number;
  readonly empty: number;
  readonly full: number;
}

interface BerthRow {
  readonly portId: string;
  readonly systemId: string;
  readonly goods: readonly {
    commodityId: string;
    stock: number;
    target: number;
    price: number;
  }[];
}

interface ListingRow {
  readonly ticker: string;
  readonly price: number;
  readonly product: number;
  readonly earnings: number;
}

interface AdminState {
  readonly ledger: {
    readonly categories: readonly LedgerRow[];
    readonly net: number;
    readonly heldByCaptains: number;
  };
  readonly commodities: readonly CommodityRow[];
  readonly berths: readonly BerthRow[];
  readonly listings: readonly ListingRow[];
  readonly tuning: unknown;
  readonly server: {
    readonly economyTimeScale: number;
    readonly startingSystem: string;
    readonly invite: boolean;
  };
}

export function Admin({
  endpoint,
  deviceToken,
}: {
  readonly endpoint: string;
  readonly deviceToken: string | undefined;
}): React.JSX.Element {
  // Each of these tables runs past its panel and cut its last row in half.
  const ledgerScroll = useScroller();
  const goodsScroll = useScroller();
  const listingsScroll = useScroller();
  const stockpilesScroll = useScroller();

  const [state, setState] = useState<AdminState | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string | undefined>(undefined);

  const read = useCallback(async () => {
    if (deviceToken === undefined) {
      setRefused('This device is not on the Register.');
      return;
    }
    try {
      const response = await fetch(`${endpoint}/admin/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceToken }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        setRefused(body.message ?? 'Refused.');
        return;
      }
      const body = (await response.json()) as AdminState;
      setRefused(undefined);
      setState(body);
      setDraft(JSON.stringify(body.tuning, null, 2));
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error));
    }
  }, [deviceToken, endpoint]);

  useEffect(() => {
    void read();
  }, [read]);

  const apply = useCallback(async () => {
    if (deviceToken === undefined) return;
    setApplying(true);
    setApplied(undefined);
    try {
      const tuning: unknown = JSON.parse(draft);
      const response = await fetch(`${endpoint}/admin/tuning`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceToken, tuning }),
      });
      const body = (await response.json()) as { applied: boolean; message?: string };
      setApplied(
        body.applied
          ? 'In force. What is already built keeps the figures it was built with.'
          : (body.message ?? 'Refused.'),
      );
      if (body.applied) await read();
    } catch (error) {
      setApplied(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  }, [deviceToken, draft, endpoint, read]);

  /** Faucets, sinks and transfers in the order the protocol declares them. */
  const ledger = useMemo(() => {
    if (!state) return [];
    const byCategory = new Map(state.ledger.categories.map((row) => [row.category, row]));
    return ALL_CATEGORIES.map((category) => ({
      category,
      label: categoryLabel(category),
      kind: isTransfer(category) ? 'transfer' : isFaucet(category) ? 'faucet' : 'sink',
      total: byCategory.get(category)?.total ?? 0,
      count: byCategory.get(category)?.count ?? 0,
    }));
  }, [state]);

  if (refused !== undefined) {
    return (
      <main className="admin admin--refused">
        <div className="panel admin__refusal">
          <h1>Not your page</h1>
          <p>{refused}</p>
          <p className="micro">
            An operator is named in the server&apos;s own configuration, under
            ADMIN_CALLSIGNS. Nothing else opens it.
          </p>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="admin">
        <div className="panel admin__refusal">
          <h1>Reading the books</h1>
        </div>
      </main>
    );
  }

  const reconciles = state.ledger.net === state.ledger.heldByCaptains;

  return (
    <main className="admin" aria-label="Administration">
      <header className="admin__head panel">
        <h1>The books</h1>
        <dl className="admin__server">
          <div>
            <dt className="label">Economy runs at</dt>
            <dd className="data">×{state.server.economyTimeScale}</dd>
          </div>
          <div>
            <dt className="label">Opening system</dt>
            <dd className="data">{state.server.startingSystem}</dd>
          </div>
          <div>
            <dt className="label">Invite</dt>
            <dd className="data">{state.server.invite ? 'required' : 'open'}</dd>
          </div>
        </dl>
        <button type="button" className="button" onClick={() => void read()}>
          Read again
        </button>
      </header>

      <section className="panel admin__ledger" aria-label="The ledger">
        <header className="panel-header">
          <h2>Ledger</h2>
          <span className={`micro ${reconciles ? 'admin__ok' : 'admin__bad'}`}>
            {reconciles
              ? 'Faucets less sinks equals what captains hold'
              : 'Out by ' + (state.ledger.net - state.ledger.heldByCaptains).toLocaleString()}
          </span>
        </header>
        <div className="admin__scroll" ref={ledgerScroll.ref} data-more={ledgerScroll.more}>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Kind</th>
              <th scope="col" className="admin__figure">
                Marks
              </th>
              <th scope="col" className="admin__figure">
                Postings
              </th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((row) => (
              <tr key={row.category}>
                <th scope="row">{row.label}</th>
                <td className={`admin__kind admin__kind--${row.kind}`}>{row.kind}</td>
                <td className="admin__figure data">{row.total.toLocaleString()}</td>
                <td className="admin__figure data">{row.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Faucets less sinks</th>
              <td />
              <td className="admin__figure data">{state.ledger.net.toLocaleString()}</td>
              <td />
            </tr>
            <tr>
              <th scope="row">Held by captains</th>
              <td />
              <td className="admin__figure data">
                {state.ledger.heldByCaptains.toLocaleString()}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
        </div>
      </section>

      <section className="panel admin__prices" aria-label="Prices">
        <header className="panel-header">
          <h2>Goods</h2>
          <span className="micro">{state.commodities.length} across the Reach</span>
        </header>
        <div className="admin__scroll" ref={goodsScroll.ref} data-more={goodsScroll.more}>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Good</th>
              <th scope="col" className="admin__figure">
                In stock
              </th>
              <th scope="col" className="admin__figure">
                Spread
              </th>
              <th scope="col" className="admin__figure">
                Mean
              </th>
              <th scope="col" className="admin__figure">
                Clamped
              </th>
            </tr>
          </thead>
          <tbody>
            {state.commodities.map((row) => (
              <tr key={row.commodityId}>
                <th scope="row">{row.name}</th>
                <td className="admin__figure data">{Math.round(row.stock).toLocaleString()}</td>
                <td className="admin__figure data">
                  {row.low.toFixed(2)}–{row.high.toFixed(2)}
                </td>
                <td className="admin__figure data">{row.mean.toFixed(2)}</td>
                <td className="admin__figure data">
                  {row.atFloor + row.atCeiling > 0 ? (
                    <span className="admin__bad">
                      {row.atFloor} at the floor, {row.atCeiling} at the ceiling
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="panel admin__listings" aria-label="Listings">
        <header className="panel-header">
          <h2>Listings</h2>
          <span className="micro">{state.listings.length} companies</span>
        </header>
        <div className="admin__scroll" ref={listingsScroll.ref} data-more={listingsScroll.more}>
        <table className="admin__table">
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col" className="admin__figure">
                Quote
              </th>
              <th scope="col" className="admin__figure">
                Earnings a tick
              </th>
              <th scope="col" className="admin__figure">
                Pool product
              </th>
            </tr>
          </thead>
          <tbody>
            {state.listings.map((row) => (
              <tr key={row.ticker}>
                <th scope="row">{row.ticker}</th>
                <td className="admin__figure data">{row.price.toFixed(2)}</td>
                <td className="admin__figure data">{Math.round(row.earnings).toLocaleString()}</td>
                <td className="admin__figure data">{Math.round(row.product).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </section>

      <section className="panel admin__berths" aria-label="Stockpiles">
        <header className="panel-header">
          <h2>Stockpiles</h2>
          <span className="micro">{state.berths.length} berths</span>
        </header>
        <div className="admin__scroll" ref={stockpilesScroll.ref} data-more={stockpilesScroll.more}>
          {state.berths.map((berth) => (
            <div key={berth.portId} className="admin__berth">
              <h3>
                {berth.portId}
                <span className="micro"> {berth.systemId}</span>
              </h3>
              <ul className="admin__piles">
                {berth.goods.map((pile) => (
                  <li key={pile.commodityId}>
                    <span className="label">{pile.commodityId}</span>
                    <span className="data">
                      {Math.round(pile.stock).toLocaleString()}/
                      {Math.round(pile.target).toLocaleString()}
                      <span className="micro"> {pile.price.toFixed(2)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="panel admin__tuning" aria-label="Tuning">
        <header className="panel-header">
          <h2>Tuning</h2>
          <span className="micro">In memory only. A restart goes back to what is committed.</span>
        </header>
        <textarea
          className="admin__editor"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="admin__apply">
          <button
            type="button"
            className="button button--primary"
            disabled={applying}
            onClick={() => void apply()}
          >
            {applying ? 'Putting it in force' : 'Put it in force'}
          </button>
          {applied !== undefined && <p className="admin__applied micro">{applied}</p>}
        </div>
      </section>
    </main>
  );
}
