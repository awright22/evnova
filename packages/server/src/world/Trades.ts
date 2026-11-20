/**
 * Trade between captains, alongside at the same berth.
 *
 * Spec section 12: marks, cargo and draughts change hands when two captains
 * are landed at the same port. An offer is one-sided with a price — "this
 * cargo and this draught, for these marks" — and a swap is two offers. That
 * costs a second click and saves the whole apparatus of a two-sided
 * negotiation, which is a lot of screen for a case nobody asked for.
 *
 * Both halves are applied in one transaction, and everything about both
 * captains is checked at the moment of acceptance rather than at the moment
 * of offering: the offerer may have sold the cargo, spent the marks or left
 * the berth since, and a trade that half-applies is worse than one that is
 * refused.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';

import { content, type Placement } from '@marque/shared';

import { schema, type Store } from '../db/index.ts';
import type { Ledger } from './Ledger.ts';
import type { Market } from './Market.ts';
import type { Yard } from './Yard.ts';
import type { Pilot } from './PilotStore.ts';

export type OfferRefusal =
  | 'no-such-captain'
  | 'trade-with-yourself'
  | 'not-landed'
  | 'not-at-the-same-berth'
  | 'nothing-offered'
  | 'no-such-design'
  | 'not-enough-cargo'
  | 'not-enough-marks'
  | 'no-room-in-hold'
  | 'no-such-offer'
  | 'too-many-offers'
  | 'unknown-commodity';

export class OfferRefused extends Error {
  constructor(readonly reason: OfferRefusal) {
    super(reason);
    this.name = 'OfferRefused';
  }
}

/** A parcel of one good, as an offer lists it. */
export interface TradeCargo {
  readonly commodityId: string;
  readonly units: number;
}

/** What one captain is putting up, and what they want for it. */
export interface TradeTerms {
  readonly marks: number;
  readonly cargo: readonly TradeCargo[];
  readonly designId: string;
}

/** An offer as either captain reads it. */
export interface TradeOffer {
  readonly id: string;
  readonly fromId: string;
  readonly from: string;
  readonly toId: string;
  readonly to: string;
  readonly portId: string;
  /** What the receiving captain pays. Negative means the offerer is paying. */
  readonly marks: number;
  readonly cargo: readonly { commodityId: string; name: string; units: number }[];
  readonly designId: string;
  readonly designName: string;
  readonly offeredAt: number;
}

/** How many offers one captain may have outstanding at a berth. */
const MAX_OPEN = 4;

export class Trades {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly market: Market,
    private readonly yard: Yard,
  ) {}

  /**
   * Put an offer to another captain.
   *
   * Checked against what the offerer actually has, so an offer that was
   * never deliverable is refused at the counter rather than when the other
   * captain reaches for it. It is checked again on acceptance all the same.
   */
  offer(
    from: Pilot,
    toCallsign: string,
    terms: TradeTerms,
    now: number,
  ): TradeOffer {
    if (from.landedPortId === undefined) throw new OfferRefused('not-landed');

    const them = this.store.db
      .select({ id: schema.accounts.id, callsign: schema.accounts.callsign })
      .from(schema.accounts)
      .where(eq(schema.accounts.callsignKey, toCallsign.trim().toLowerCase()))
      .get();
    if (!them) throw new OfferRefused('no-such-captain');
    if (them.id === from.accountId) throw new OfferRefused('trade-with-yourself');

    const cargo = this.cleanCargo(terms.cargo);
    const marks = Math.trunc(terms.marks);
    if (cargo.length === 0 && terms.designId === '' && marks === 0) {
      throw new OfferRefused('nothing-offered');
    }

    // What the offerer is putting up has to be theirs now.
    const hold = this.market.cargoOf(from.accountId);
    for (const parcel of cargo) {
      if ((hold.get(parcel.commodityId) ?? 0) < parcel.units) {
        throw new OfferRefused('not-enough-cargo');
      }
    }

    let designName = '';
    if (terms.designId !== '') {
      const design = this.store.db
        .select({ name: schema.designs.name })
        .from(schema.designs)
        .where(
          and(
            eq(schema.designs.id, terms.designId),
            eq(schema.designs.accountId, from.accountId),
          ),
        )
        .get();
      if (!design) throw new OfferRefused('no-such-design');
      designName = design.name;
    }

    // A captain paying rather than charging has to have it.
    if (marks < 0 && from.marks < -marks) throw new OfferRefused('not-enough-marks');

    const open = this.store.db
      .select({ id: schema.trades.id })
      .from(schema.trades)
      .where(
        and(eq(schema.trades.fromId, from.accountId), eq(schema.trades.state, 'offered')),
      )
      .all();
    if (open.length >= MAX_OPEN) throw new OfferRefused('too-many-offers');

    const id = randomUUID();
    this.store.db
      .insert(schema.trades)
      .values({
        id,
        fromId: from.accountId,
        toId: them.id,
        portId: from.landedPortId,
        state: 'offered',
        marks,
        cargo: JSON.stringify(cargo),
        designId: terms.designId,
        designName,
        offeredAt: now,
      })
      .run();

    return this.read(id);
  }

  /**
   * Take an offer up.
   *
   * Everything is rechecked here, because everything may have changed since
   * it was made. One transaction: marks, cargo and the draught all move, or
   * none of them do.
   */
  accept(
    to: Pilot,
    offerId: string,
    from: Pilot | undefined,
    holdCapacity: number,
    now: number,
  ): TradeOffer {
    const row = this.store.db
      .select()
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.id, offerId),
          eq(schema.trades.toId, to.accountId),
          eq(schema.trades.state, 'offered'),
        ),
      )
      .get();
    if (!row) throw new OfferRefused('no-such-offer');

    if (to.landedPortId === undefined) throw new OfferRefused('not-landed');
    if (to.landedPortId !== row.portId) throw new OfferRefused('not-at-the-same-berth');
    // The other captain must still be alongside: a trade is handing
    // something over, not posting it.
    if (!from || from.landedPortId !== row.portId) {
      throw new OfferRefused('not-at-the-same-berth');
    }

    const cargo = JSON.parse(row.cargo) as TradeCargo[];
    const { commodities } = content();

    const fromHold = this.market.cargoOf(from.accountId);
    for (const parcel of cargo) {
      if ((fromHold.get(parcel.commodityId) ?? 0) < parcel.units) {
        throw new OfferRefused('not-enough-cargo');
      }
    }

    // Room for it. The receiving captain's bays are the limit, and a trade
    // that overfills a hold is the same hole as a purchase that does.
    const units = cargo.reduce((sum, parcel) => sum + parcel.units, 0);
    if (units > 0) {
      if (this.market.cargoUnits(to.accountId) + units > holdCapacity) {
        throw new OfferRefused('no-room-in-hold');
      }
    }

    // Marks, both ways round.
    if (row.marks > 0 && to.marks < row.marks) throw new OfferRefused('not-enough-marks');
    if (row.marks < 0 && from.marks < -row.marks) throw new OfferRefused('not-enough-marks');

    let placements: Placement[] | undefined;
    let designName = row.designName;
    if (row.designId !== '') {
      const design = this.store.db
        .select()
        .from(schema.designs)
        .where(
          and(eq(schema.designs.id, row.designId), eq(schema.designs.accountId, row.fromId)),
        )
        .get();
      if (!design) throw new OfferRefused('no-such-design');
      placements = JSON.parse(design.placements) as Placement[];
      designName = design.name;
    }

    this.store.transaction(() => {
      // Marks first: it is the half that can refuse on its own.
      if (row.marks !== 0) {
        this.ledger.post(
          {
            accountId: to.accountId,
            delta: -row.marks,
            category: 'captain-trade',
            reason: `Traded with ${this.callsign(row.fromId)}`,
          },
          to,
        );
        this.ledger.post(
          {
            accountId: row.fromId,
            delta: row.marks,
            category: 'captain-trade',
            reason: `Traded with ${this.callsign(row.toId)}`,
          },
          from,
        );
      }

      for (const parcel of cargo) {
        this.market.adjustCargo(from.accountId, parcel.commodityId, -parcel.units);
        this.market.adjustCargo(to.accountId, parcel.commodityId, parcel.units);
      }

      if (placements) {
        this.yard.saveDesign(to.accountId, { name: designName, placements }, now);
      }

      this.store.db
        .update(schema.trades)
        .set({ state: 'accepted', closedAt: now })
        .where(eq(schema.trades.id, row.id))
        .run();
    });

    return {
      id: row.id,
      fromId: row.fromId,
      from: this.callsign(row.fromId),
      toId: row.toId,
      to: this.callsign(row.toId),
      portId: row.portId,
      marks: row.marks,
      cargo: cargo.map((parcel) => ({
        commodityId: parcel.commodityId,
        name: commodities.get(parcel.commodityId)?.name ?? parcel.commodityId,
        units: parcel.units,
      })),
      designId: row.designId,
      designName,
      offeredAt: row.offeredAt,
    };
  }

  /** Turn one down, or take one back. Either captain may close an offer. */
  close(accountId: string, offerId: string, now: number): TradeOffer {
    const offer = this.read(offerId);
    const mine = offer.fromId === accountId;
    if (!mine && offer.toId !== accountId) throw new OfferRefused('no-such-offer');

    const closed = this.store.db
      .update(schema.trades)
      .set({ state: mine ? 'withdrawn' : 'declined', closedAt: now })
      .where(and(eq(schema.trades.id, offerId), eq(schema.trades.state, 'offered')))
      .run();
    if (closed.changes === 0) throw new OfferRefused('no-such-offer');
    return offer;
  }

  /** Everything open either way for this captain. */
  openFor(accountId: string): TradeOffer[] {
    const rows = this.store.db
      .select({ id: schema.trades.id })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.state, 'offered'),
          or(eq(schema.trades.toId, accountId), eq(schema.trades.fromId, accountId)),
        ),
      )
      .all();
    return rows.map((row) => this.read(row.id));
  }

  /**
   * Close every offer this captain has open.
   *
   * Called when they launch: an offer is a conversation at a counter, and a
   * captain who has left the berth is not having it any more.
   */
  closeAllFor(accountId: string, now: number): number {
    const closed = this.store.db
      .update(schema.trades)
      .set({ state: 'lapsed', closedAt: now })
      .where(
        and(
          eq(schema.trades.state, 'offered'),
          or(eq(schema.trades.toId, accountId), eq(schema.trades.fromId, accountId)),
        ),
      )
      .run();
    return closed.changes;
  }

  /** One offer, named and priced the way a screen needs it. */
  read(offerId: string): TradeOffer {
    const row = this.store.db
      .select()
      .from(schema.trades)
      .where(eq(schema.trades.id, offerId))
      .get();
    if (!row) throw new OfferRefused('no-such-offer');

    const { commodities } = content();
    const cargo = (JSON.parse(row.cargo) as TradeCargo[]).map((parcel) => ({
      commodityId: parcel.commodityId,
      name: commodities.get(parcel.commodityId)?.name ?? parcel.commodityId,
      units: parcel.units,
    }));

    return {
      id: row.id,
      fromId: row.fromId,
      from: this.callsign(row.fromId),
      toId: row.toId,
      to: this.callsign(row.toId),
      portId: row.portId,
      marks: row.marks,
      cargo,
      designId: row.designId,
      designName: row.designName,
      offeredAt: row.offeredAt,
    };
  }

  /** Whole units of goods that exist, with the duplicates folded together. */
  private cleanCargo(cargo: readonly TradeCargo[]): TradeCargo[] {
    const { commodities } = content();
    const totals = new Map<string, number>();

    for (const parcel of cargo) {
      const units = Math.trunc(parcel.units);
      if (units <= 0) continue;
      if (!commodities.has(parcel.commodityId)) throw new OfferRefused('unknown-commodity');
      totals.set(parcel.commodityId, (totals.get(parcel.commodityId) ?? 0) + units);
    }

    return [...totals].map(([commodityId, units]) => ({ commodityId, units }));
  }

  private callsign(accountId: string): string {
    const row = this.store.db
      .select({ callsign: schema.accounts.callsign })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    return row?.callsign ?? '';
  }
}
