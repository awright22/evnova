/**
 * The Staple: what every berth is holding, and what it costs.
 *
 * The authority on stock. Nothing else writes a stockpile, and every trade is
 * one transaction covering the berth's stock, the captain's hold and the
 * ledger row, so a crash between them is not a state the world can be in.
 *
 * Stock drifts on the world's injected clock, including while nobody is
 * online, which is what makes a route decay when it is overused and recover
 * when it is rested. The drift is deterministic: it is a function of elapsed
 * hours, not of how often the tick happened to run.
 */

import { and, eq, sql } from 'drizzle-orm';

import {
  capacityFor,
  content,
  isCharter,
  prizePremium,
  type Charter,
  driftStock,
  netRate,
  workingRate,
  openingPile,
  pressure,
  quote,
  targetStock,
  unitPrice,
  type CommodityDef,
  type PortDef,
  type Side,
  type Stockpile,
} from '@marque/shared';

import { schema, type Store } from '../db/index.ts';
import type { Exchange } from './Exchange.ts';
import type { Standings } from './Standings.ts';
import { InsufficientMarks, type Ledger } from './Ledger.ts';
import type { Pilot } from './PilotStore.ts';

/** Why a trade was refused. The room turns these into typed rejections. */
export type TradeRefusal =
  | 'no-such-commodity'
  | 'no-such-market'
  | 'nothing-to-trade'
  | 'out-of-stock'
  | 'berth-full'
  | 'hold-full'
  | 'not-carrying'
  | 'cannot-afford';

export class TradeRefused extends Error {
  constructor(readonly reason: TradeRefusal) {
    super(reason);
    this.name = 'TradeRefused';
  }
}

/** One line of a berth's Staple, as the interface shows it. */
export interface Listing {
  readonly commodityId: string;
  readonly name: string;
  readonly tier: string;
  /** What a unit costs to buy now, in whole marks. */
  readonly ask: number;
  /** And what the berth pays for one, in whole marks. */
  readonly bid: number;
  /** Units on hand. */
  readonly stock: number;
  readonly capacity: number;
  /** How far from target, as a fraction: positive is a glut. */
  readonly pressure: number;
  /** Units the captain is carrying. */
  readonly carried: number;
}

/** Where one commodity stands across the whole Reach. */
export interface CommoditySurvey {
  readonly commodityId: string;
  readonly name: string;
  readonly basePrice: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly low: number;
  readonly high: number;
  readonly mean: number;
  /** Berths that trade it. */
  readonly berths: number;
  /** Units of it in the Reach. */
  readonly stock: number;
  /** Berths quoting the clamp rather than a price. */
  readonly atFloor: number;
  readonly atCeiling: number;
  /** Berths with none left, and berths that can hold no more. */
  readonly empty: number;
  readonly full: number;
}

/** One berth's holding of the goods it moves. */
export interface BerthSurvey {
  readonly portId: string;
  readonly systemId: string;
  readonly goods: {
    commodityId: string;
    stock: number;
    target: number;
    price: number;
  }[];
}

/** What a trade actually did. */
export interface TradeResult {
  readonly units: number;
  readonly marks: number;
  readonly marksAfter: number;
  readonly carried: number;
  readonly stock: number;
}

export class Market {
  /**
   * The Bourse, once the world has one.
   *
   * Set after construction rather than injected, because the Exchange and
   * this service both hold the ledger and the World builds them in one pass.
   * Optional so a test can exercise this service without an exchange behind
   * it; an earnings event with nobody listening is simply not reported.
   */
  exchange: Exchange | undefined;

  /**
   * What the charters think of each captain, once the world has it.
   *
   * The Staple reads it twice: a berth belonging to a company a captain is
   * barred from will not trade with them at all, and a regular pays a little
   * less than a stranger.
   */
  standings: Standings | undefined;

  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
  ) {}

  // --- Reading ------------------------------------------------------------

  /** Every commodity a berth trades, with what it would cost right now. */
  listingsFor(port: PortDef, pilot: { accountId: string; letter: string }): Listing[] {
    const { commodities, tuning } = content();
    const held = this.cargoOf(pilot.accountId);

    // What this captain's standing is worth here. The same figure `trade`
    // charges by: a quote that did not carry it showed a favoured captain
    // the list price and then charged them less, which is the consequence
    // of standing made invisible at the one place it is felt.
    const favour = isCharter(port.owner)
      ? (this.standings?.discount(pilot.accountId, port.owner) ?? 0)
      : 0;
    const premium = prizePremium(pilot.letter as Charter | undefined, port.owner, tuning);

    return [...commodities.values()].map((commodity) => {
      const pile = this.pileOf(port, commodity);
      const sell = quote('buy', 1, pile, commodity, tuning);
      const buy = quote('sell', 1, pile, commodity, tuning);
      const carried = held.get(commodity.id) ?? 0;

      // And what a prize is worth, on the share of this parcel that came off
      // a wreck — the same share `trade` works out.
      const prizeShare =
        premium > 0 && carried > 0
          ? Math.min(1, this.prizeOf(pilot.accountId, commodity.id) / carried)
          : 0;
      const bonus = prizeShare * premium;

      const list = sell.units > 0 ? sell.marks : Math.ceil(unitPrice(0, pile, commodity, tuning));

      return {
        commodityId: commodity.id,
        name: commodity.name,
        tier: commodity.tier,
        // A berth with nothing left still quotes, so the interface can show
        // why it cannot sell rather than showing a blank.
        ask: favour > 0 ? Math.ceil(list * (1 - favour)) : list,
        bid: buy.units > 0 ? Math.floor(buy.marks * (1 + favour + bonus)) : 0,
        stock: pile.stock,
        capacity: pile.capacity,
        pressure: pressure(pile),
        carried,
      };
    });
  }

  /** What a captain is carrying, by commodity. */
  cargoOf(accountId: string): Map<string, number> {
    const rows = this.store.db
      .select({ commodityId: schema.cargo.commodityId, units: schema.cargo.units })
      .from(schema.cargo)
      .where(eq(schema.cargo.accountId, accountId))
      .all();

    return new Map(rows.map((row) => [row.commodityId, row.units]));
  }

  /** Total units in a captain's hold, which is what the cargo bays limit. */
  cargoUnits(accountId: string): number {
    const row = this.store.db
      .select({ total: sql<number>`COALESCE(SUM(${schema.cargo.units}), 0)` })
      .from(schema.cargo)
      .where(eq(schema.cargo.accountId, accountId))
      .get();
    return row?.total ?? 0;
  }

  /** A berth's holding of one commodity, seeded at its target if new. */
  pileOf(port: PortDef, commodity: CommodityDef): Stockpile {
    const { tuning } = content();
    const row = this.store.db
      .select({ stock: schema.stockpiles.stock })
      .from(schema.stockpiles)
      .where(
        and(
          eq(schema.stockpiles.portId, port.id),
          eq(schema.stockpiles.commodityId, commodity.id),
        ),
      )
      .get();

    if (!row) return openingPile(port, commodity, tuning);

    return {
      stock: row.stock,
      target: targetStock(port, commodity, tuning),
      capacity: capacityFor(port, commodity, tuning),
    };
  }

  // --- Trading ------------------------------------------------------------

  /**
   * Buy from or sell to a berth.
   *
   * One transaction over three things: the berth's stock, the captain's hold
   * and the ledger. `holdCapacity` is the hull's own limit, which the caller
   * derives from its cargo bays — the market does not know what a ship is.
   */
  trade(options: {
    side: Side;
    port: PortDef;
    commodityId: string;
    units: number;
    pilot: Pilot;
    holdCapacity: number;
    now: number;
    /** False when the goods go into the tanks or the magazine, not the hold. */
    intoHold?: boolean;
  }): TradeResult {
    const { commodities, tuning } = content();
    const commodity = commodities.get(options.commodityId);
    if (!commodity) throw new TradeRefused('no-such-commodity');
    if (!options.port.services.includes('staple')) throw new TradeRefused('no-such-market');

    const wanted = Math.trunc(options.units);
    if (wanted <= 0) throw new TradeRefused('nothing-to-trade');

    return this.store.transaction(() => {
      const pile = this.pileOf(options.port, commodity);
      const carried = this.cargoOf(options.pilot.accountId).get(commodity.id) ?? 0;

      // How many units are actually possible, before pricing any of them.
      let possible = wanted;
      if (options.side === 'buy') {
        const room = Math.max(0, options.holdCapacity - this.cargoUnits(options.pilot.accountId));
        if (room <= 0) throw new TradeRefused('hold-full');
        if (pile.stock <= 0) throw new TradeRefused('out-of-stock');
        possible = Math.min(possible, room, pile.stock);
      } else {
        if (carried <= 0) throw new TradeRefused('not-carrying');
        if (pile.stock >= pile.capacity) throw new TradeRefused('berth-full');
        possible = Math.min(possible, carried, pile.capacity - pile.stock);
      }

      const quoted = quote(options.side, possible, pile, commodity, tuning);
      if (quoted.units <= 0) {
        throw new TradeRefused(options.side === 'buy' ? 'out-of-stock' : 'berth-full');
      }

      // A regular pays a little less and is paid a little more. Half the
      // spread at the very most, so a favoured captain still loses on a round
      // trip at one berth: invariant 1 does not have an exception for being
      // liked.
      const favour = isCharter(options.port.owner)
        ? (this.standings?.discount(options.pilot.accountId, options.port.owner) ?? 0)
        : 0;

      // Prize cargo fetches more at the berths of the charter that licensed
      // the taking of it, on the share of the parcel that actually came off
      // a wreck. Spec section 19 keeps the premium well under the half of a
      // hold lost when a hull is destroyed, so staging a capture loses money.
      let prizeBonus = 0;
      if (options.side === 'sell') {
        const premium = prizePremium(
          options.pilot.letter as Charter | undefined,
          options.port.owner,
          tuning,
        );
        if (premium > 0) {
          const prizeHeld = this.prizeOf(options.pilot.accountId, commodity.id);
          const share = carried > 0 ? Math.min(1, prizeHeld / carried) : 0;
          prizeBonus = share * premium;
        }
      }
      const priced =
        favour > 0 || prizeBonus > 0
          ? {
              ...quoted,
              marks:
                options.side === 'buy'
                  ? Math.ceil(quoted.marks * (1 - favour))
                  : Math.floor(quoted.marks * (1 + favour + prizeBonus)),
            }
          : quoted;

      // Marks first: a refusal here must leave the berth and the hold alone,
      // and the transaction would roll them back anyway.
      let marksAfter: number;
      try {
        marksAfter = this.ledger.post(
          {
            accountId: options.pilot.accountId,
            delta: options.side === 'buy' ? -priced.marks : priced.marks,
            category: options.side === 'buy' ? 'cargo-purchase' : 'cargo-sale',
            reason:
              `${priced.units} ${commodity.name} ` +
              `${options.side === 'buy' ? 'bought at' : 'sold at'} ${options.port.name}`,
          },
          options.pilot,
        );
      } catch (error) {
        if (error instanceof InsufficientMarks) throw new TradeRefused('cannot-afford');
        throw error;
      }

      this.writeStock(options.port.id, commodity.id, priced.stockAfter, options.now);

      // Dealing with a company's berth is how a captain becomes known to it.
      // Per unit, not per mark, so hauling bulk earns standing at the same
      // rate as hauling luxuries and a captain cannot buy regard outright.
      if (isCharter(options.port.owner)) {
        this.standings?.shift(
          options.pilot.accountId,
          options.port.owner,
          priced.units * tuning.standing.perTradeUnit,
          options.now,
        );
      }

      // The producer earns when goods actually leave its berth's stockpile to
      // a buyer — spec section 10's one costly-to-fake event for a producer.
      // Only on a purchase: a captain *selling* into a berth is adding to the
      // pile, not taking from it, and crediting both directions is exactly
      // the wash trade the rule exists to rule out.
      if (options.side === 'buy') {
        const ticker = this.exchange?.producerOf(options.port.owner, commodity.id);
        if (ticker !== undefined) {
          this.exchange?.credit({
            ticker,
            marks: priced.marks,
            kind: 'goods-sold',
            where: options.port.name,
            what: commodity.id,
          });
        }
      }

      // Into the hold unless the caller is filling tanks or a magazine, which
      // the hull carries elsewhere and counts separately.
      const held =
        options.intoHold === false
          ? carried
          : options.side === 'buy'
            ? carried + priced.units
            : carried - priced.units;
      if (options.intoHold !== false) {
        this.writeCargo(options.pilot.accountId, commodity.id, held);
      }

      return {
        units: priced.units,
        marks: priced.marks,
        marksAfter,
        carried: held,
        stock: priced.stockAfter,
      };
    });
  }

  /**
   * Buy a commodity into something other than the hold.
   *
   * Propellant goes into the tanks and Ordnance into the magazine, but both
   * are bought from the berth's own stock at the berth's own price: spec
   * section 9 says jump fuel is bought at ports like any other commodity.
   * The caller moves it into whatever carries it; this moves the stock and
   * the marks, in one transaction.
   */
  fill(options: {
    port: PortDef;
    commodityId: string;
    units: number;
    pilot: Pilot;
    now: number;
  }): TradeResult {
    return this.trade({
      side: 'buy',
      port: options.port,
      commodityId: options.commodityId,
      units: options.units,
      pilot: options.pilot,
      // The tanks are not the hold, so the hold's limit does not apply: the
      // caller has already checked what the tanks will take.
      holdCapacity: Number.MAX_SAFE_INTEGER,
      now: options.now,
      intoHold: false,
    });
  }

  /**
   * Move cargo without money changing hands.
   *
   * Scooping a canister, losing part of a hold when a hull is written off,
   * and freight arriving all go through here, so nothing else writes the
   * cargo table. Returns what the hold now holds.
   */
  adjustCargo(
    accountId: string,
    commodityId: string,
    delta: number,
    options: { prize?: boolean } = {},
  ): number {
    return this.store.transaction(() => {
      const carried = this.cargoOf(accountId).get(commodityId) ?? 0;
      const held = Math.max(0, carried + Math.trunc(delta));
      const wasPrize = this.prizeOf(accountId, commodityId);

      // Prize units are the ones taken off a wreck, and only those sell at a
      // letter's premium. Adding prize cargo adds to the count; taking any
      // cargo out takes the prize share with it pro rata, because a hold
      // does not keep its contents in labelled boxes.
      const prize =
        delta > 0 && options.prize === true
          ? wasPrize + Math.trunc(delta)
          : carried > 0
            ? Math.round((wasPrize * held) / carried)
            : 0;

      this.writeCargo(accountId, commodityId, held, Math.min(held, prize));
      return held;
    });
  }

  /** How many units of this good in a captain's hold came off a wreck. */
  prizeOf(accountId: string, commodityId: string): number {
    const row = this.store.db
      .select({ prize: schema.cargo.prize })
      .from(schema.cargo)
      .where(and(eq(schema.cargo.accountId, accountId), eq(schema.cargo.commodityId, commodityId)))
      .get();
    return row?.prize ?? 0;
  }

  /**
   * Move a berth's stock without anyone paying for it.
   *
   * Freight arriving and freight leaving. Bounded by nothing and capacity, so
   * a caller cannot drive a berth negative or past what it can hold.
   */
  adjustStock(port: PortDef, commodity: CommodityDef, delta: number, now: number): number {
    const pile = this.pileOf(port, commodity);
    const next = Math.max(0, Math.min(pile.capacity, pile.stock + Math.trunc(delta)));
    if (next !== pile.stock) this.writeStock(port.id, commodity.id, next, now);
    return next;
  }

  // --- The clock ----------------------------------------------------------

  /**
   * Drift every berth's stock by the hours that have passed.
   *
   * Runs whether or not anyone is online, which is what makes an overused
   * route decay and a rested one recover. Written in one transaction so a
   * half-drifted galaxy is not a state anything can read.
   */
  drift(hours: number, now: number): void {
    if (hours <= 0) return;
    const { commodities, systems } = content();

    this.store.transaction(() => {
      for (const system of systems.values()) {
        for (const port of system.ports) {
          if (!port.services.includes('staple')) continue;

          // Read the whole berth once. Every line's rate depends on what the
          // berth has on hand at the start of the interval, so they are all
          // worked out against the same reading rather than against each
          // other's leavings — otherwise the order of this loop would decide
          // which line got the Ore.
          const before = new Map<string, number>();
          for (const commodity of commodities.values()) {
            before.set(commodity.id, this.pileOf(port, commodity).stock);
          }
          const stockOf = (id: string): number => before.get(id) ?? 0;

          for (const commodity of commodities.values()) {
            if (netRate(port, commodity.id) === 0) continue;
            const rate = workingRate(port, commodity, hours, stockOf, commodities);
            if (rate === 0) continue;

            const pile = this.pileOf(port, commodity);
            const next = Math.round(driftStock(pile, rate, hours));
            if (next !== pile.stock) this.writeStock(port.id, commodity.id, next, now);
          }
        }
      }
    });
  }

  /**
   * The whole economy in one shape, for the soak's report and the admin page.
   *
   * Per commodity: where its price sits across every berth that trades it,
   * how many of those berths are pinned at a clamp, and how much of it exists
   * in the Reach. The spec asks the soak to show that no price sits at a
   * clamp for long and no stock runs to zero or without bound, and this is
   * the measurement that answers both.
   */
  survey(): CommoditySurvey[] {
    const { commodities, systems, tuning } = content();
    const out: CommoditySurvey[] = [];

    for (const commodity of commodities.values()) {
      const band = tuning.market.bands[commodity.tier];
      const floor = commodity.basePrice * band.min;
      const ceiling = commodity.basePrice * band.max;

      let low = Infinity;
      let high = -Infinity;
      let sum = 0;
      let berths = 0;
      let stock = 0;
      let atFloor = 0;
      let atCeiling = 0;
      let empty = 0;
      let full = 0;

      for (const system of systems.values()) {
        for (const port of system.ports) {
          if (!port.services.includes('staple')) continue;

          const pile = this.pileOf(port, commodity);
          const price = unitPrice(pile.stock, pile, commodity, tuning);

          berths++;
          stock += pile.stock;
          sum += price;
          low = Math.min(low, price);
          high = Math.max(high, price);

          // Within a tenth of a mark of the clamp counts as sitting on it.
          if (price <= floor + 0.1) atFloor++;
          if (price >= ceiling - 0.1) atCeiling++;
          if (pile.stock === 0) empty++;
          if (pile.stock >= pile.capacity) full++;
        }
      }

      out.push({
        commodityId: commodity.id,
        name: commodity.name,
        basePrice: commodity.basePrice,
        floor: Math.round(floor),
        ceiling: Math.round(ceiling),
        low: berths > 0 ? Math.round(low) : 0,
        high: berths > 0 ? Math.round(high) : 0,
        mean: berths > 0 ? Math.round(sum / berths) : 0,
        berths,
        stock,
        atFloor,
        atCeiling,
        empty,
        full,
      });
    }

    return out;
  }

  /**
   * Every berth's holding of the goods it actually moves.
   *
   * Per-berth rather than per-commodity, because route decay is a fact about
   * one berth: a berth worked hard runs down and its prices rise, and a berth
   * left alone recovers. The aggregate survey cannot show that, since a
   * shortage at one berth and a glut at another cancel out in a range.
   *
   * Only the goods a berth makes or eats are reported: the rest sit at their
   * baseline and would triple the size of this for nothing.
   */
  berthSurvey(): BerthSurvey[] {
    const { commodities, systems, tuning } = content();
    const out: BerthSurvey[] = [];

    for (const system of systems.values()) {
      for (const port of system.ports) {
        if (!port.trade) continue;

        const moves = new Set([
          ...Object.keys(port.trade.produces),
          ...Object.keys(port.trade.consumes),
        ]);

        const goods: BerthSurvey['goods'] = [];
        for (const id of moves) {
          const commodity = commodities.get(id);
          if (!commodity) continue;
          const pile = this.pileOf(port, commodity);
          goods.push({
            commodityId: id,
            stock: pile.stock,
            target: pile.target,
            price: Math.round(unitPrice(pile.stock, pile, commodity, tuning)),
          });
        }

        out.push({ portId: port.id, systemId: system.id, goods });
      }
    }

    return out;
  }

  // --- Writing ------------------------------------------------------------

  private writeStock(portId: string, commodityId: string, stock: number, now: number): void {
    const value = Math.max(0, Math.round(stock));
    this.store.db
      .insert(schema.stockpiles)
      .values({ portId, commodityId, stock: value, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.stockpiles.portId, schema.stockpiles.commodityId],
        set: { stock: value, updatedAt: now },
      })
      .run();
  }

  private writeCargo(
    accountId: string,
    commodityId: string,
    units: number,
    prize = 0,
  ): void {
    const value = Math.max(0, Math.round(units));
    const taken = Math.max(0, Math.min(value, Math.round(prize)));

    if (value === 0) {
      this.store.db
        .delete(schema.cargo)
        .where(
          and(eq(schema.cargo.accountId, accountId), eq(schema.cargo.commodityId, commodityId)),
        )
        .run();
      return;
    }

    this.store.db
      .insert(schema.cargo)
      .values({ accountId, commodityId, units: value, prize: taken })
      .onConflictDoUpdate({
        target: [schema.cargo.accountId, schema.cargo.commodityId],
        set: { units: value, prize: taken },
      })
      .run();
  }
}
