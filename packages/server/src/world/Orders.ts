/**
 * Standing orders on the Bourse, and the margin behind a short.
 *
 * There is no order book here. A listing trades against a constant-product
 * pool, so a limit order is not something another captain crosses — it is an
 * instruction the Bourse carries out on each market tick, walking the curve
 * as far as the limit allows and no further. A large order therefore fills in
 * pieces over several ticks as the house trader walks the price back toward
 * fair value, which is exactly what it would look like against a thin book.
 *
 * The same pass closes out shorts that have run out of margin. A captain who
 * is short owes shares, and the Bourse wants to see they could buy their way
 * out: when their equity falls below the maintenance level it buys back for
 * them, at whatever the market is, with whatever they have. That has to work
 * while they are offline, which is why it runs here on the tick rather than
 * anywhere a captain's session can reach.
 */

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { content } from '@marque/shared';

import { schema, type Store } from '../db/index.ts';
import { BourseRefused, type Exchange, type Fill } from './Exchange.ts';
import type { Ledger } from './Ledger.ts';
import type { Pilot } from './PilotStore.ts';

/** Why an order was refused. */
export type OrderRefusal =
  | 'no-such-listing'
  | 'no-such-order'
  | 'nothing-to-trade'
  | 'limit-out-of-range'
  | 'too-many-orders'
  | 'not-holding'
  | 'short-capped';

export class OrderRefused extends Error {
  constructor(readonly reason: OrderRefusal) {
    super(reason);
    this.name = 'OrderRefused';
  }
}

/** An order as the interface draws it. */
export interface OrderLine {
  readonly id: string;
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  /** Shares still wanted. */
  readonly shares: number;
  /** Shares filled so far. */
  readonly filled: number;
  /** Marks paid or received so far, fees included. */
  readonly settled: number;
  /** The limit, in marks a share. */
  readonly limit: number;
  readonly short: boolean;
  readonly state: 'open' | 'filled' | 'cancelled';
  readonly reason: string;
  readonly placedAt: number;
}

/** What one market tick did to a captain's orders and positions. */
export interface TickReport {
  /** Orders that moved, by account, so a captain can be told. */
  readonly fills: {
    readonly accountId: string;
    readonly ticker: string;
    readonly side: 'buy' | 'sell';
    readonly shares: number;
    readonly total: number;
    readonly done: boolean;
  }[];
  /** Positions the Bourse closed out, by account. */
  readonly liquidations: {
    readonly accountId: string;
    readonly ticker: string;
    readonly shares: number;
    readonly total: number;
    /** Shares still owed afterwards, when they could not buy back the lot. */
    readonly left: number;
  }[];
}

/** How many open orders one captain may keep, so one account cannot fill the table. */
const MAX_OPEN = 12;

/** Hundredths of a mark, which is how a limit is stored. */
const HUNDREDTHS = 100;

export class Orders {
  constructor(
    private readonly store: Store,
    private readonly exchange: Exchange,
    private readonly ledger: Ledger,
  ) {}

  /**
   * Place a standing order.
   *
   * Nothing is charged and nothing is reserved: the order is an instruction,
   * and whether the captain can pay for it is decided when it fills. A buy
   * they can no longer afford is closed with a reason they can read rather
   * than left to fill at a price they cannot meet.
   */
  place(
    pilot: Pilot,
    request: {
      ticker: string;
      side: 'buy' | 'sell';
      shares: number;
      /** Marks a share. */
      limit: number;
      short?: boolean;
    },
    now: number,
  ): OrderLine {
    const { companies } = content();
    if (!companies.has(request.ticker)) throw new OrderRefused('no-such-listing');
    if (!Number.isFinite(request.shares) || Math.trunc(request.shares) < 1) {
      throw new OrderRefused('nothing-to-trade');
    }
    if (!Number.isFinite(request.limit) || request.limit <= 0 || request.limit > 1_000_000) {
      throw new OrderRefused('limit-out-of-range');
    }

    return this.store.transaction(() => {
      const open = this.store.db
        .select({ count: sql<number>`count(*)` })
        .from(schema.orders)
        .where(and(eq(schema.orders.accountId, pilot.accountId), eq(schema.orders.state, 'open')))
        .get();
      if ((open?.count ?? 0) >= MAX_OPEN) throw new OrderRefused('too-many-orders');

      const row = {
        id: randomUUID(),
        accountId: pilot.accountId,
        ticker: request.ticker,
        side: request.side,
        shares: Math.trunc(request.shares),
        filled: 0,
        settled: 0,
        limitHundredths: Math.max(1, Math.round(request.limit * HUNDREDTHS)),
        short: request.side === 'sell' && request.short === true,
        state: 'open',
        reason: '',
        placedAt: Math.round(now),
        closedAt: 0,
      };

      this.store.db.insert(schema.orders).values(row).run();
      return toLine(row);
    });
  }

  /** Withdraw an order. Only the captain who placed it may. */
  cancel(accountId: string, orderId: string, now: number): OrderLine {
    return this.store.transaction(() => {
      const row = this.store.db
        .select()
        .from(schema.orders)
        .where(and(eq(schema.orders.id, orderId), eq(schema.orders.accountId, accountId)))
        .get();
      if (!row || row.state !== 'open') throw new OrderRefused('no-such-order');

      this.store.db
        .update(schema.orders)
        .set({ state: 'cancelled', reason: 'Withdrawn', closedAt: Math.round(now) })
        .where(eq(schema.orders.id, orderId))
        .run();

      return toLine({ ...row, state: 'cancelled', reason: 'Withdrawn' });
    });
  }

  /** A captain's orders, newest first: the open ones, then what has closed. */
  of(accountId: string, limit = 20): OrderLine[] {
    return this.store.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.accountId, accountId))
      .orderBy(sql`${schema.orders.state} = 'open' DESC, ${schema.orders.placedAt} DESC`)
      .limit(limit)
      .all()
      .map(toLine);
  }

  /**
   * One pass: fill what the curve allows, then close out what cannot be held.
   *
   * In that order, because a fill can be what puts a captain under: an order
   * that adds to a short should be measured by the same tick that decides
   * whether the short can stay open.
   */
  tick(now: number): TickReport {
    return { fills: this.fillOrders(now), liquidations: this.liquidate(now) };
  }

  private fillOrders(now: number): TickReport['fills'] {
    const open = this.store.db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.state, 'open'))
      // Oldest first, so an order that has been waiting is served before one
      // placed this minute — the only fairness a pool can offer, since there
      // is no queue at a price.
      .orderBy(schema.orders.placedAt)
      .all();

    const fills: TickReport['fills'] = [];

    for (const row of open) {
      const marks = this.ledger.balanceOf(row.accountId);
      let fill: Fill | undefined;
      try {
        fill = this.exchange.trade({
          pilot: { accountId: row.accountId, marks },
          side: row.side === 'buy' ? 'buy' : 'sell',
          ticker: row.ticker,
          shares: row.shares,
          limit: row.limitHundredths / HUNDREDTHS,
          short: row.short,
        });
      } catch (error) {
        if (!(error instanceof BourseRefused)) {
          // Anything else is a fault, and a faulty order must not stop the
          // market for everybody else: it is logged where somebody will see
          // it and closed, rather than thrown through the world's tick.
          console.error(`[orders] ${row.id} (${row.ticker}) could not be filled:`, error);
          this.close(row.id, 'cancelled', 'Withdrawn by the Bourse', now);
          continue;
        }
        // The price has simply not come to them yet, which is the ordinary
        // state of an order and not a reason to close it.
        if (error.reason === 'limit-not-reached' || error.reason === 'market-too-thin') continue;
        this.close(row.id, 'cancelled', refusalText(error.reason), now);
        fills.push({
          accountId: row.accountId,
          ticker: row.ticker,
          side: row.side === 'buy' ? 'buy' : 'sell',
          shares: 0,
          total: 0,
          done: true,
        });
        continue;
      }

      const left = row.shares - fill.shares;
      this.store.db
        .update(schema.orders)
        .set({
          shares: Math.max(0, left),
          filled: row.filled + fill.shares,
          settled: row.settled + fill.total,
          ...(left <= 0
            ? { state: 'filled', reason: 'Filled', closedAt: Math.round(now) }
            : {}),
        })
        .where(eq(schema.orders.id, row.id))
        .run();

      fills.push({
        accountId: row.accountId,
        ticker: row.ticker,
        side: row.side === 'buy' ? 'buy' : 'sell',
        shares: fill.shares,
        total: fill.total,
        done: left <= 0,
      });
    }

    return fills;
  }

  /**
   * Close out shorts that have run out of margin.
   *
   * Bought back at market with whatever the captain has. If they cannot
   * afford the whole position they buy back what they can and the rest
   * stands, to be tried again on the next tick: no debt is ever created, and
   * a captain who has been wiped out is wiped out rather than left owing the
   * Bourse money it could never collect.
   */
  private liquidate(now: number): TickReport['liquidations'] {
    const { exchange } = content().tuning;
    const closed: TickReport['liquidations'] = [];

    for (const seller of this.exchange.shortSellers()) {
      if (seller.owed <= 0) continue;
      if (seller.equity >= Math.ceil(seller.owed * exchange.maintenanceRate)) continue;

      const positions = this.store.db
        .select()
        .from(schema.holdings)
        .where(
          and(eq(schema.holdings.accountId, seller.accountId), sql`${schema.holdings.shares} < 0`),
        )
        .all();

      for (const position of positions) {
        const marks = this.ledger.balanceOf(seller.accountId);
        try {
          const fill = this.exchange.trade({
            pilot: { accountId: seller.accountId, marks },
            side: 'buy',
            ticker: position.ticker,
            shares: -position.shares,
          });
          // Only a buy-back that actually bought something is worth telling
          // anybody about. A captain with nothing left is tried again on
          // every tick, and saying so every time would be a notice a second
          // for as long as they are under water.
          if (fill.shares > 0) {
            closed.push({
              accountId: seller.accountId,
              ticker: position.ticker,
              shares: fill.shares,
              total: fill.total,
              left: Math.max(0, -position.shares - fill.shares),
            });
          }
        } catch (error) {
          if (!(error instanceof BourseRefused)) {
            console.error(
              `[orders] could not close out ${position.ticker} for ${seller.accountId}:`,
              error,
            );
          }
          // Nothing left to buy with, or a market too thin to buy in. The
          // position stands, silently, and the next tick tries again: a
          // captain who cannot pay is told once by the buy-back that did
          // happen, not once a tick for ever.

        }
      }
    }

    void now;
    return closed;
  }

  private close(id: string, state: 'cancelled' | 'filled', reason: string, now: number): void {
    this.store.db
      .update(schema.orders)
      .set({ state, reason, closedAt: Math.round(now) })
      .where(eq(schema.orders.id, id))
      .run();
  }
}

/** What to tell a captain whose order could not be carried out. */
function refusalText(reason: string): string {
  switch (reason) {
    case 'cannot-afford':
      return 'Not enough marks to settle it';
    case 'holding-capped':
      return 'That would pass the holding cap';
    case 'short-capped':
      return 'That would pass what may be sold short';
    case 'margin-short':
      return 'Not enough margin behind it';
    case 'not-holding':
      return 'The shares are no longer held';
    default:
      return 'Withdrawn by the Bourse';
  }
}

function toLine(row: typeof schema.orders.$inferSelect): OrderLine {
  return {
    id: row.id,
    ticker: row.ticker,
    side: row.side === 'buy' ? 'buy' : 'sell',
    shares: row.shares,
    filled: row.filled,
    settled: row.settled,
    limit: row.limitHundredths / HUNDREDTHS,
    short: row.short,
    state: row.state === 'filled' ? 'filled' : row.state === 'cancelled' ? 'cancelled' : 'open',
    reason: row.reason,
    placedAt: row.placedAt,
  };
}
