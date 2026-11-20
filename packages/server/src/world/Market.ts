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
  driftStock,
  netRate,
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

/** What a trade actually did. */
export interface TradeResult {
  readonly units: number;
  readonly marks: number;
  readonly marksAfter: number;
  readonly carried: number;
  readonly stock: number;
}

export class Market {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
  ) {}

  // --- Reading ------------------------------------------------------------

  /** Every commodity a berth trades, with what it would cost right now. */
  listingsFor(port: PortDef, accountId: string): Listing[] {
    const { commodities, tuning } = content();
    const held = this.cargoOf(accountId);

    return [...commodities.values()].map((commodity) => {
      const pile = this.pileOf(port, commodity);
      const sell = quote('buy', 1, pile, commodity, tuning);
      const buy = quote('sell', 1, pile, commodity, tuning);

      return {
        commodityId: commodity.id,
        name: commodity.name,
        tier: commodity.tier,
        // A berth with nothing left still quotes, so the interface can show
        // why it cannot sell rather than showing a blank.
        ask: sell.units > 0 ? sell.marks : Math.ceil(unitPrice(0, pile, commodity, tuning)),
        bid: buy.units > 0 ? buy.marks : 0,
        stock: pile.stock,
        capacity: pile.capacity,
        pressure: pressure(pile),
        carried: held.get(commodity.id) ?? 0,
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

      const priced = quote(options.side, possible, pile, commodity, tuning);
      if (priced.units <= 0) {
        throw new TradeRefused(options.side === 'buy' ? 'out-of-stock' : 'berth-full');
      }

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
      const held = options.side === 'buy' ? carried + priced.units : carried - priced.units;
      this.writeCargo(options.pilot.accountId, commodity.id, held);

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
   * Move cargo without money changing hands.
   *
   * Scooping a canister, losing part of a hold when a hull is written off,
   * and freight arriving all go through here, so nothing else writes the
   * cargo table. Returns what the hold now holds.
   */
  adjustCargo(accountId: string, commodityId: string, delta: number): number {
    return this.store.transaction(() => {
      const carried = this.cargoOf(accountId).get(commodityId) ?? 0;
      const next = Math.max(0, carried + Math.trunc(delta));
      this.writeCargo(accountId, commodityId, next);
      return next;
    });
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

          for (const commodity of commodities.values()) {
            const rate = netRate(port, commodity.id);
            if (rate === 0) continue;

            const pile = this.pileOf(port, commodity);
            const next = Math.round(driftStock(pile, rate, hours));
            if (next !== pile.stock) this.writeStock(port.id, commodity.id, next, now);
          }
        }
      }
    });
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

  private writeCargo(accountId: string, commodityId: string, units: number): void {
    const value = Math.max(0, Math.round(units));

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
      .values({ accountId, commodityId, units: value })
      .onConflictDoUpdate({
        target: [schema.cargo.accountId, schema.cargo.commodityId],
        set: { units: value },
      })
      .run();
  }
}
