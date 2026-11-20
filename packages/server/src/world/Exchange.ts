/**
 * The Bourse.
 *
 * Ten listed companies, each trading against a constant-product pool so that
 * a quote always exists however few captains are online. The pool maths is in
 * `@marque/shared`, deterministic and tested against invariant 3; this owns
 * the state around it: who holds what, what each company has earned, when the
 * house trader runs and when dividends fall.
 *
 * **Earnings are the whole design.** Spec section 10 is explicit that
 * earnings come only from events that are costly to fake, and that gross
 * trade volume never counts. So nothing here is credited on a captain *doing*
 * something — it is credited when something actually leaves a stockpile, when
 * marks are actually spent on fittings, when freight actually arrives. A
 * captain who buys and sells the same parcel back and forth moves no earnings
 * at all, which is what makes invariant 6 hold.
 *
 * **Whose marks.** A pool's marks are the exchange's, not a captain's. Only
 * the captain's leg of a trade touches the ledger — marks leave them to buy
 * and reach them on a sale — so the pool is a reservoir outside the player
 * credit total and invariant 4 is unaffected by the house trader moving a
 * price.
 */

import { and, eq, sql } from 'drizzle-orm';

import {
  affordableShares,
  content,
  fairValue,
  houseTrade,
  price,
  quoteBuy,
  quoteSell,
  sellableShares,
  smooth,
  type CompanyDef,
  type Listing,
  type Pool,
} from '@marque/shared';

import { schema, type Store } from '../db/index.ts';
import { InsufficientMarks, type Ledger } from './Ledger.ts';
import type { Pilot } from './PilotStore.ts';

/** Why a share trade was refused. */
export type BourseRefusal =
  | 'no-such-listing'
  | 'cannot-afford'
  | 'not-holding'
  | 'holding-capped'
  | 'market-too-thin'
  | 'nothing-to-trade';

export class BourseRefused extends Error {
  constructor(readonly reason: BourseRefusal) {
    super(reason);
    this.name = 'BourseRefused';
  }
}

/** What a trade actually did, which is what the ticket reports back. */
export interface Fill {
  readonly ticker: string;
  readonly side: 'buy' | 'sell';
  readonly shares: number;
  /** Marks the pool took or paid, before the fee. */
  readonly marks: number;
  readonly fee: number;
  /** What the captain paid or received, fee included. */
  readonly total: number;
  readonly averagePrice: number;
  readonly priceBefore: number;
  readonly priceAfter: number;
  readonly held: number;
  readonly marksAfter: number;
}

/** An earnings event, as the Gazette will report it. */
export interface EarningsEvent {
  readonly ticker: string;
  readonly marks: number;
  /** Which rule credited it, so a headline can say what happened. */
  readonly kind: 'goods-sold' | 'modules-sold' | 'freight' | 'salvage' | 'insurance';
  /** Where it happened, when that is known and worth printing. */
  readonly where?: string;
  /** What it was, when that is worth printing: a commodity, a region. */
  readonly what?: string;
}

export class Exchange {
  /**
   * Earnings banked since the last market tick, by ticker.
   *
   * Held in memory and flushed to the row at each tick rather than written on
   * every sale: a busy berth credits a producer several times a second, and
   * each of those would otherwise be its own write.
   */
  private readonly pending = new Map<string, number>();

  /** Events since the last tick, which the Gazette turns into headlines. */
  private readonly events: EarningsEvent[] = [];

  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
  ) {}

  /**
   * Open the Bourse, if it is not already open.
   *
   * A listing's opening price follows from its opening earnings through
   * `fairValue`, so it starts at what it is worth rather than at a number
   * written beside it and then lurching on the first tick.
   */
  seed(): void {
    const { companies, tuning } = content();
    const existing = new Set(
      this.store.db.select({ ticker: schema.listings.ticker }).from(schema.listings).all()
        .map((row) => row.ticker),
    );

    this.store.transaction(() => {
      for (const company of companies.values()) {
        if (existing.has(company.ticker)) continue;

        const opening = fairValue(
          company.openingEarnings,
          tuning.exchange.multiple,
          tuning.exchange.valueFloor,
          company.float,
        );
        const poolMarks = Math.max(1, Math.round(company.poolShares * opening));

        this.store.db
          .insert(schema.listings)
          .values({
            ticker: company.ticker,
            poolShares: company.poolShares,
            poolMarks,
            smoothedEarnings: company.openingEarnings,
            periodEarnings: 0,
            undistributed: 0,
            previousPrice: opening,
            history: JSON.stringify([opening]),
            ticks: 0,
          })
          .run();
      }
    });
  }

  // --- Earnings -----------------------------------------------------------

  /**
   * Credit a company for something that actually happened.
   *
   * Called from the Staple when goods leave a stockpile, from the Yard when
   * marks are spent on fittings or a premium is taken, and from the freight
   * service when a run arrives. Never called on a captain's gross turnover.
   */
  credit(event: EarningsEvent): void {
    if (event.marks === 0) return;
    if (!content().companies.has(event.ticker)) return;

    this.pending.set(event.ticker, (this.pending.get(event.ticker) ?? 0) + event.marks);
    this.events.push(event);
  }

  /**
   * Which company earns when this commodity leaves this berth.
   *
   * A charter's berths are shared between its companies — Daughters'
   * Provision earns on Grain at a Kessler berth and the Chandlery earns on
   * Circuitry at the same one — so the rule matches on the owner *and* the
   * good, and a good nobody claims credits nobody.
   */
  producerOf(portOwner: string, commodityId: string): string | undefined {
    for (const company of content().companies.values()) {
      if (company.ports !== portOwner) continue;
      for (const rule of company.earns) {
        if (rule.kind === 'goods-sold' && rule.commodities.includes(commodityId as never)) {
          return company.ticker;
        }
      }
    }
    return undefined;
  }

  /** Which company earns when marks are spent on this maker's fittings. */
  makerOf(manufacturer: string): string | undefined {
    for (const company of content().companies.values()) {
      for (const rule of company.earns) {
        if (rule.kind === 'modules-sold' && rule.manufacturer === manufacturer) {
          return company.ticker;
        }
      }
    }
    return undefined;
  }

  /** Which company carries freight in this region. */
  carrierOf(region: string): string | undefined {
    for (const company of content().companies.values()) {
      for (const rule of company.earns) {
        if (rule.kind === 'freight' && rule.regions.includes(region as never)) {
          return company.ticker;
        }
      }
    }
    return undefined;
  }

  /** The company with a given rule kind and no further discriminator. */
  private soleHolderOf(kind: 'insurance' | 'salvage'): string | undefined {
    for (const company of content().companies.values()) {
      if (company.earns.some((rule) => rule.kind === kind)) return company.ticker;
    }
    return undefined;
  }

  get insurer(): string | undefined {
    return this.soleHolderOf('insurance');
  }

  get salvor(): string | undefined {
    return this.soleHolderOf('salvage');
  }

  // --- The market tick ----------------------------------------------------

  /**
   * One market tick: fold earnings, move the price, pay any dividend.
   *
   * Returns the events that led to it, so the Gazette can explain the moves
   * while they are still moving.
   */
  tick(now: number): { events: EarningsEvent[]; dividends: { ticker: string; marks: number }[] } {
    const { companies, tuning } = content();
    const { exchange } = tuning;

    const banked = new Map(this.pending);
    const events = [...this.events];
    this.pending.clear();
    this.events.length = 0;

    const dividends: { ticker: string; marks: number }[] = [];

    this.store.transaction(() => {
      for (const company of companies.values()) {
        const row = this.rowFor(company.ticker);
        if (!row) continue;

        // 1. Fold this period's earnings into the smoothed figure. A single
        //    enormous build does not reprice a company for good; a sustained
        //    change does move it.
        const earned = banked.get(company.ticker) ?? 0;
        // Never below its going concern: a company that sells nothing this
        // week still owns its yards, its berths and its contracts, and a
        // listing that decays to the value floor and then spikes many times
        // over on one order is not a market anybody can read.
        const smoothed = Math.max(
          company.openingEarnings * exchange.earningsFloor,
          smooth(row.smoothedEarnings, earned, exchange.smoothing),
        );

        // 2. The house trader moves the price part of the way toward fair
        //    value, along the curve, which is what makes a price respond to
        //    the world when nobody is trading.
        const pool: Pool = { shares: row.poolShares, marks: row.poolMarks };
        const value = fairValue(smoothed, exchange.multiple, exchange.valueFloor, company.float);
        const moved = houseTrade(pool, value, exchange.houseRate);

        const history = (JSON.parse(row.history) as number[]).concat(price(moved));
        if (history.length > exchange.historyKeep) {
          history.splice(0, history.length - exchange.historyKeep);
        }

        const ticks = row.ticks + 1;
        // Earnings set aside toward the next dividend. Only what was actually
        // earned, so a company that earns nothing pays nothing.
        let undistributed = row.undistributed + Math.max(0, earned);

        this.store.db
          .update(schema.listings)
          .set({
            poolShares: moved.shares,
            poolMarks: moved.marks,
            smoothedEarnings: smoothed,
            periodEarnings: earned,
            previousPrice: price(pool),
            history: JSON.stringify(history),
            ticks,
            undistributed,
          })
          .where(eq(schema.listings.ticker, company.ticker))
          .run();

        if (ticks % exchange.dividendEvery === 0 && undistributed > 0) {
          const paid = this.payDividend(company, undistributed, exchange.dividendFraction, now);
          if (paid > 0) dividends.push({ ticker: company.ticker, marks: paid });
          undistributed -= paid;
          this.store.db
            .update(schema.listings)
            .set({ undistributed: Math.max(0, undistributed) })
            .where(eq(schema.listings.ticker, company.ticker))
            .run();
        }
      }
    });

    return { events, dividends };
  }

  /**
   * Pay a dividend on player-held shares.
   *
   * Only on shares captains actually hold: the pool's own shares earn nothing,
   * because paying the exchange out of the exchange would be a sum that always
   * balances and never means anything. A captain holding a thousandth of the
   * float receives a thousandth of the distribution.
   */
  private payDividend(
    company: CompanyDef,
    undistributed: number,
    fraction: number,
    now: number,
  ): number {
    const pot = Math.floor(undistributed * fraction);
    if (pot <= 0) return 0;

    const held = this.store.db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.ticker, company.ticker), sql`${schema.holdings.shares} > 0`))
      .all();
    if (held.length === 0) return 0;

    let paid = 0;
    for (const holding of held) {
      // Against the float, not against what other captains hold: a dividend
      // should not go up because everyone else sold.
      const share = Math.floor((pot * holding.shares) / company.float);
      if (share <= 0) continue;

      const pilot = this.store.db
        .select()
        .from(schema.pilots)
        .where(eq(schema.pilots.accountId, holding.accountId))
        .get();
      if (!pilot) continue;

      this.ledger.post({
        accountId: holding.accountId,
        delta: share,
        category: 'dividend',
        reason: `${company.name} dividend`,
      });

      this.store.db
        .update(schema.holdings)
        .set({ dividends: holding.dividends + share })
        .where(
          and(
            eq(schema.holdings.accountId, holding.accountId),
            eq(schema.holdings.ticker, company.ticker),
          ),
        )
        .run();

      paid += share;
    }

    void now;
    return paid;
  }

  // --- Trading ------------------------------------------------------------

  /**
   * Buy or sell shares against a company's pool.
   *
   * One transaction covering the pool, the holding and the ledger, so a trade
   * fully applies or does not happen. Nothing here trusts the client: the
   * price is read from the pool as it stands, not from whatever the ticket
   * last showed.
   */
  trade(options: {
    pilot: Pilot;
    side: 'buy' | 'sell';
    ticker: string;
    shares: number;
  }): Fill {
    const { companies, tuning } = content();
    const { exchange } = tuning;

    const company = companies.get(options.ticker);
    if (!company) throw new BourseRefused('no-such-listing');
    if (options.shares < 1) throw new BourseRefused('nothing-to-trade');

    return this.store.transaction(() => {
      const row = this.rowFor(options.ticker);
      if (!row) throw new BourseRefused('no-such-listing');

      const pool: Pool = { shares: row.poolShares, marks: row.poolMarks };
      const holding = this.holdingOf(options.pilot.accountId, options.ticker);

      if (options.side === 'buy') {
        const cap = Math.floor(company.float * exchange.holdingCap);
        if (holding.shares >= cap) throw new BourseRefused('holding-capped');

        const wanted = Math.min(options.shares, cap - holding.shares);
        const affordable = affordableShares(
          pool,
          options.pilot.marks,
          exchange.feeRate,
          exchange.maxPoolFraction,
        );
        const shares = Math.min(wanted, affordable);
        if (shares < 1) {
          // Told apart so the interface can say the right thing, and on the
          // right test: the market is thin when the *pool* can serve nobody,
          // not when this captain happens to be poor.
          const offered = sellableShares(pool, exchange.maxPoolFraction);
          throw new BourseRefused(offered < 1 ? 'market-too-thin' : 'cannot-afford');
        }

        const quote = quoteBuy(pool, shares, exchange.feeRate, exchange.maxPoolFraction);

        let marksAfter: number;
        try {
          marksAfter = this.ledger.post(
            {
              accountId: options.pilot.accountId,
              delta: -quote.marks,
              category: 'share-purchase',
              reason: `${quote.shares} ${company.ticker} on the Bourse`,
            },
            options.pilot,
          );
          if (quote.fee > 0) {
            marksAfter = this.ledger.post(
              {
                accountId: options.pilot.accountId,
                delta: -quote.fee,
                category: 'trade-fee',
                reason: `Bourse fee on ${company.ticker}`,
              },
              options.pilot,
            );
          }
        } catch (error) {
          if (error instanceof InsufficientMarks) throw new BourseRefused('cannot-afford');
          throw error;
        }

        this.writePool(options.ticker, quote.after);
        this.writeHolding(options.pilot.accountId, options.ticker, {
          shares: holding.shares + quote.shares,
          costBasis: holding.costBasis + quote.total,
          dividends: holding.dividends,
        });

        return {
          ticker: options.ticker,
          side: 'buy' as const,
          shares: quote.shares,
          marks: quote.marks,
          fee: quote.fee,
          total: quote.total,
          averagePrice: quote.averagePrice,
          priceBefore: quote.priceBefore,
          priceAfter: quote.priceAfter,
          held: holding.shares + quote.shares,
          marksAfter,
        };
      }

      // --- Selling ---------------------------------------------------------
      if (holding.shares < 1) throw new BourseRefused('not-holding');
      const shares = Math.min(options.shares, holding.shares);
      const quote = quoteSell(pool, shares, exchange.feeRate);
      if (quote.total <= 0) throw new BourseRefused('market-too-thin');

      // The proceeds and the fee are posted separately rather than netted:
      // the fee is destroyed, not paid to anyone, and a ledger that showed
      // only the net could not tell the soak report how much the Bourse has
      // taken out of the world.
      let marksAfter = this.ledger.post(
        {
          accountId: options.pilot.accountId,
          delta: quote.marks,
          category: 'share-sale',
          reason: `${quote.shares} ${company.ticker} on the Bourse`,
        },
        options.pilot,
      );
      if (quote.fee > 0) {
        marksAfter = this.ledger.post(
          {
            accountId: options.pilot.accountId,
            delta: -quote.fee,
            category: 'trade-fee',
            reason: `Bourse fee on ${company.ticker}`,
          },
          options.pilot,
        );
      }

      this.writePool(options.ticker, quote.after);
      // The basis falls with the shares, not with the proceeds, so what is
      // left is still what the remaining shares cost.
      const remaining = holding.shares - quote.shares;
      this.writeHolding(options.pilot.accountId, options.ticker, {
        shares: remaining,
        costBasis: remaining === 0
          ? 0
          : Math.round((holding.costBasis * remaining) / holding.shares),
        dividends: holding.dividends,
      });

      return {
        ticker: options.ticker,
        side: 'sell' as const,
        shares: quote.shares,
        marks: quote.marks,
        fee: quote.fee,
        total: quote.total,
        averagePrice: quote.averagePrice,
        priceBefore: quote.priceBefore,
        priceAfter: quote.priceAfter,
        held: remaining,
        marksAfter,
      };
    });
  }

  // --- Reading ------------------------------------------------------------

  /** Every listing, as the interface draws it for this captain. */
  listingsFor(accountId: string | undefined): Listing[] {
    const { companies, tuning } = content();
    const held = new Map<string, typeof schema.holdings.$inferSelect>();
    if (accountId !== undefined) {
      for (const row of this.store.db
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, accountId))
        .all()) {
        held.set(row.ticker, row);
      }
    }

    const out: Listing[] = [];
    for (const company of companies.values()) {
      const row = this.rowFor(company.ticker);
      if (!row) continue;

      const pool: Pool = { shares: row.poolShares, marks: row.poolMarks };
      const mine = held.get(company.ticker);

      out.push({
        ticker: company.ticker,
        name: company.name,
        parent: company.parent,
        sector: company.sector,
        description: company.description,
        price: price(pool),
        fairValue: fairValue(
          row.smoothedEarnings,
          tuning.exchange.multiple,
          tuning.exchange.valueFloor,
          company.float,
        ),
        earnings: row.smoothedEarnings,
        previous: row.previousPrice,
        history: JSON.parse(row.history) as number[],
        float: company.float,
        holdingCap: Math.floor(company.float * tuning.exchange.holdingCap),
        held: mine?.shares ?? 0,
        costBasis: mine?.costBasis ?? 0,
        dividends: mine?.dividends ?? 0,
        available: Math.floor(pool.shares * tuning.exchange.maxPoolFraction),
        poolShares: pool.shares,
        poolMarks: pool.marks,
      });
    }
    return out;
  }

  /** What a captain's shares are worth at the quoted price, for the standings. */
  portfolioValue(accountId: string): number {
    let total = 0;
    for (const row of this.store.db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, accountId))
      .all()) {
      const listing = this.rowFor(row.ticker);
      if (!listing) continue;
      total += Math.floor(row.shares * price({ shares: listing.poolShares, marks: listing.poolMarks }));
    }
    return total;
  }

  /** Every pool's product, for the soak report's invariant check. */
  products(): { ticker: string; product: number; price: number }[] {
    return this.store.db
      .select()
      .from(schema.listings)
      .all()
      .map((row) => ({
        ticker: row.ticker,
        product: row.poolShares * row.poolMarks,
        price: price({ shares: row.poolShares, marks: row.poolMarks }),
      }));
  }

  // --- Rows ---------------------------------------------------------------

  private rowFor(ticker: string): typeof schema.listings.$inferSelect | undefined {
    return this.store.db
      .select()
      .from(schema.listings)
      .where(eq(schema.listings.ticker, ticker))
      .get();
  }

  private holdingOf(
    accountId: string,
    ticker: string,
  ): { shares: number; costBasis: number; dividends: number } {
    const row = this.store.db
      .select()
      .from(schema.holdings)
      .where(and(eq(schema.holdings.accountId, accountId), eq(schema.holdings.ticker, ticker)))
      .get();
    return row ?? { shares: 0, costBasis: 0, dividends: 0 };
  }

  private writePool(ticker: string, pool: Pool): void {
    this.store.db
      .update(schema.listings)
      .set({ poolShares: pool.shares, poolMarks: pool.marks })
      .where(eq(schema.listings.ticker, ticker))
      .run();
  }

  private writeHolding(
    accountId: string,
    ticker: string,
    next: { shares: number; costBasis: number; dividends: number },
  ): void {
    this.store.db
      .insert(schema.holdings)
      .values({ accountId, ticker, ...next })
      .onConflictDoUpdate({
        target: [schema.holdings.accountId, schema.holdings.ticker],
        set: next,
      })
      .run();
  }
}
