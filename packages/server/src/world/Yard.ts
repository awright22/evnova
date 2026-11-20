/**
 * The Yard: designs, hulls, and what it costs to put one together.
 *
 * The authority on what a captain owns. A build is one transaction covering
 * the design's validity, the materials, the marks and the hull itself, so a
 * crash between them is not a state the world can be in — and a build that
 * cannot be paid for changes nothing at all.
 *
 * Nothing here trusts the client. A design arrives as placements and is
 * validated, costed and charged here from the same shared functions the
 * editor used to quote it, so a captain who sends the server a design their
 * editor would have refused is refused too.
 */

import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import {
  ShareCodeError,
  buildCost,
  content,
  decodeShareCode,
  encodeShareCode,
  placeAll,
  splitBill,
  validateDesign,
  type LicenceId,
  type Placement,
  type Problem,
} from '@marque/shared';

import { schema, type Store } from '../db/index.ts';
import { InsufficientMarks, type Ledger } from './Ledger.ts';
import { TradeRefused, type Market } from './Market.ts';
import type { Pilot } from './PilotStore.ts';

/** Why a build or a refit was refused. */
export type YardRefusal =
  | 'invalid-design'
  | 'no-such-design'
  | 'no-such-ship'
  | 'not-owned'
  | 'cannot-afford'
  | 'out-of-stock'
  | 'too-many-designs'
  | 'too-many-ships'
  | 'no-such-licence'
  | 'licence-held'
  | 'not-parked-here'
  | 'already-flying-it'
  | 'bad-share-code'
  | 'unknown-fitting'
  | 'unknown-captain'
  | 'give-to-self';

export class YardRefused extends Error {
  constructor(
    readonly reason: YardRefusal,
    /** Validation problems, when the design is the thing that was wrong. */
    readonly problems: readonly Problem[] = [],
  ) {
    super(reason);
    this.name = 'YardRefused';
  }
}

export interface SavedDesign {
  readonly id: string;
  readonly name: string;
  readonly placements: Placement[];
}

export interface OwnedShip {
  readonly id: string;
  readonly name: string;
  readonly placements: Placement[];
  /** Where it is parked, or empty while it is the hull being flown. */
  readonly portId: string;
  readonly systemId: string;
  readonly moduleHp: number[];
}

/** What a build actually cost. */
export interface BuildReceipt {
  readonly shipId: string;
  readonly marks: number;
  readonly premium: number;
  readonly refund: number;
  /** Materials taken from the hold, and materials the yard had to buy. */
  readonly fromHold: Record<string, number>;
  readonly bought: Record<string, number>;
  readonly materialsCost: number;
  readonly marksAfter: number;
}

/** How many of each a captain may keep, so one account cannot fill the table. */
const MAX_DESIGNS = 40;
const MAX_SHIPS = 12;

export class Yard {
  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly market: Market,
  ) {}

  // --- Designs ------------------------------------------------------------

  designsOf(accountId: string): SavedDesign[] {
    return this.store.db
      .select()
      .from(schema.designs)
      .where(eq(schema.designs.accountId, accountId))
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        placements: JSON.parse(row.placements) as Placement[],
      }));
  }

  /** Save a design, or replace one of this captain's by id. */
  saveDesign(
    accountId: string,
    design: { id?: string; name: string; placements: Placement[] },
    now: number,
  ): SavedDesign {
    return this.store.transaction(() => {
      if (design.id !== undefined) {
        const existing = this.store.db
          .select({ id: schema.designs.id })
          .from(schema.designs)
          .where(and(eq(schema.designs.id, design.id), eq(schema.designs.accountId, accountId)))
          .get();
        if (!existing) throw new YardRefused('no-such-design');

        this.store.db
          .update(schema.designs)
          .set({
            name: design.name,
            placements: JSON.stringify(design.placements),
            updatedAt: now,
          })
          .where(eq(schema.designs.id, design.id))
          .run();

        return { id: design.id, name: design.name, placements: design.placements };
      }

      const count = this.store.db
        .select({ total: sql<number>`COUNT(*)` })
        .from(schema.designs)
        .where(eq(schema.designs.accountId, accountId))
        .get();
      if ((count?.total ?? 0) >= MAX_DESIGNS) throw new YardRefused('too-many-designs');

      const id = randomUUID();
      this.store.db
        .insert(schema.designs)
        .values({
          id,
          accountId,
          name: design.name,
          placements: JSON.stringify(design.placements),
          createdAt: now,
          updatedAt: now,
        })
        .run();

      return { id, name: design.name, placements: design.placements };
    });
  }

  /**
   * Read a draught code onto a captain's books.
   *
   * A code is a claim, not a draught. It may name fittings this Register does
   * not list — written against a later version, or simply made up — so every
   * placement is checked against the catalogue before anything is saved. It is
   * deliberately *not* checked against the captain's warrant: a captain may
   * keep a draught they cannot yet build, which is half the point of being
   * given one.
   */
  importDesign(accountId: string, code: string, name: string | undefined, now: number): SavedDesign {
    const { modules } = content();

    let design;
    try {
      design = decodeShareCode(code);
    } catch (error) {
      if (error instanceof ShareCodeError) throw new YardRefused('bad-share-code');
      throw error;
    }

    const unknown = design.placements.find((placement) => !modules.has(placement.moduleId));
    if (unknown) throw new YardRefused('unknown-fitting');

    return this.saveDesign(
      accountId,
      { name: (name ?? design.name).trim() || design.name, placements: [...design.placements] },
      now,
    );
  }

  /**
   * Hand a draught to another captain.
   *
   * It is copied, not moved: the giver keeps theirs. The recipient need not be
   * online, or in this system, or at a port — a draught is paper.
   */
  giveDesign(
    from: string,
    designId: string,
    toCallsign: string,
    now: number,
  ): { design: SavedDesign; toAccountId: string; toCallsign: string } {
    const design = this.store.db
      .select()
      .from(schema.designs)
      .where(and(eq(schema.designs.id, designId), eq(schema.designs.accountId, from)))
      .get();
    if (!design) throw new YardRefused('no-such-design');

    const recipient = this.store.db
      .select({ id: schema.accounts.id, callsign: schema.accounts.callsign })
      .from(schema.accounts)
      .where(eq(schema.accounts.callsignKey, toCallsign.trim().toLowerCase()))
      .get();
    if (!recipient) throw new YardRefused('unknown-captain');
    if (recipient.id === from) throw new YardRefused('give-to-self');

    const placements = JSON.parse(design.placements) as Placement[];
    const saved = this.saveDesign(recipient.id, { name: design.name, placements }, now);
    return { design: saved, toAccountId: recipient.id, toCallsign: recipient.callsign };
  }

  /** A draught as a code a captain can paste to somebody. */
  shareCode(accountId: string, designId: string): string {
    const row = this.store.db
      .select()
      .from(schema.designs)
      .where(and(eq(schema.designs.id, designId), eq(schema.designs.accountId, accountId)))
      .get();
    if (!row) throw new YardRefused('no-such-design');
    return encodeShareCode({
      name: row.name,
      placements: JSON.parse(row.placements) as Placement[],
    });
  }

  deleteDesign(accountId: string, designId: string): void {
    const removed = this.store.db
      .delete(schema.designs)
      .where(and(eq(schema.designs.id, designId), eq(schema.designs.accountId, accountId)))
      .run();
    if (removed.changes === 0) throw new YardRefused('no-such-design');
  }

  // --- Hulls --------------------------------------------------------------

  shipsOf(accountId: string): OwnedShip[] {
    return this.store.db
      .select()
      .from(schema.ships)
      .where(eq(schema.ships.accountId, accountId))
      .all()
      .map(toOwnedShip);
  }

  /** Hulls parked at one berth, which is what the hangar there shows. */
  shipsAt(accountId: string, portId: string): OwnedShip[] {
    return this.store.db
      .select()
      .from(schema.ships)
      .where(and(eq(schema.ships.accountId, accountId), eq(schema.ships.portId, portId)))
      .all()
      .map(toOwnedShip);
  }

  /** The hull being flown, which is the one with nowhere parked. */
  flying(accountId: string): OwnedShip | undefined {
    const row = this.store.db
      .select()
      .from(schema.ships)
      .where(and(eq(schema.ships.accountId, accountId), isNull(schema.ships.portId)))
      .get();
    return row ? toOwnedShip(row) : undefined;
  }

  /**
   * Write a hull's damage back to its row.
   *
   * Called as a captain's hull is persisted, so a built hull carries its
   * dents between sessions and between hulls: park a holed cruiser, fly the
   * shuttle for a week, and the cruiser is still holed.
   *
   * Scoped to the owner, so a hull id from elsewhere touches nothing.
   */
  recordDamage(accountId: string, shipId: string, moduleHp: readonly number[]): void {
    this.store.db
      .update(schema.ships)
      .set({ moduleHp: JSON.stringify(moduleHp.map((hp) => Math.max(0, Math.round(hp)))) })
      .where(and(eq(schema.ships.id, shipId), eq(schema.ships.accountId, accountId)))
      .run();
  }

  // --- Licences -----------------------------------------------------------

  /**
   * Buy a hull licence.
   *
   * Only upward: the ladder is ranked in data, and a captain pays the full
   * cost of the warrant they are moving to with no credit for the one they
   * hold. A warrant is paper from a company court, not a trade-in.
   *
   * One transaction, like everything else that moves marks. The pilot row is
   * updated in the same breath as the ledger entry, so a crash cannot leave a
   * captain charged for a warrant they do not hold.
   */
  buyLicence(pilot: Pilot, licenceId: string): { licence: LicenceId; cost: number; marks: number } {
    const { licences } = content();
    const wanted = licences.get(licenceId as LicenceId);
    if (!wanted) throw new YardRefused('no-such-licence');

    const held = licences.get(pilot.licence as LicenceId);
    if (held && wanted.rank <= held.rank) throw new YardRefused('licence-held');

    return this.store.transaction(() => {
      let marks = pilot.marks;
      if (wanted.cost > 0) {
        try {
          marks = this.ledger.post(
            {
              accountId: pilot.accountId,
              delta: -wanted.cost,
              category: 'licence-purchase',
              reason: `${wanted.name} issued`,
            },
            pilot,
          );
        } catch (error) {
          if (error instanceof InsufficientMarks) throw new YardRefused('cannot-afford');
          throw error;
        }
      }

      this.store.db
        .update(schema.pilots)
        .set({ licence: licenceId })
        .where(eq(schema.pilots.accountId, pilot.accountId))
        .run();
      pilot.licence = licenceId;

      return { licence: licenceId as LicenceId, cost: wanted.cost, marks };
    });
  }

  // --- The Moorings -------------------------------------------------------

  /**
   * Take out a hull moored at this berth, leaving the current one in its place.
   *
   * A swap, in one transaction: the hull being flown is tied up here and the
   * chosen one is let go. Both rows move together, because a moment in which
   * a captain owns two hulls with nowhere parked — or none — is a moment in
   * which `hullFor` cannot say what they are flying.
   *
   * A captain flying the starter draught owns no hull row at all, so there is
   * nothing to park: the shuttle is not theirs to leave anywhere. Taking a
   * built hull out for the first time simply unmoors it.
   */
  switchTo(
    accountId: string,
    shipId: string,
    portId: string,
  ): { shipId: string; name: string; parked?: string } {
    return this.store.transaction(() => {
      const wanted = this.ownedShip(accountId, shipId);
      if (!wanted) throw new YardRefused('no-such-ship');
      // `portId` reads as empty, not null, once a row is in hand.
      if (wanted.portId === '') throw new YardRefused('already-flying-it');
      if (wanted.portId !== portId) throw new YardRefused('not-parked-here');

      const current = this.flying(accountId);
      if (current) {
        this.store.db
          .update(schema.ships)
          .set({ portId })
          .where(eq(schema.ships.id, current.id))
          .run();
      }

      this.store.db
        .update(schema.ships)
        .set({ portId: null })
        .where(eq(schema.ships.id, wanted.id))
        .run();

      return {
        shipId: wanted.id,
        name: wanted.name,
        ...(current ? { parked: current.name } : {}),
      };
    });
  }

  // --- Building -----------------------------------------------------------

  /**
   * Build a hull, or refit the one being flown.
   *
   * One transaction: the design is validated, the materials are taken from
   * the hold and the rest bought from this berth at its own prices, the marks
   * are posted, and the hull is written. Anything refused leaves all of it
   * untouched.
   *
   * `refitting` names a hull to change rather than add; without it this is a
   * new hull, parked where it was built.
   */
  build(options: {
    pilot: Pilot;
    portId: string;
    systemId: string;
    name: string;
    placements: Placement[];
    refitting?: string;
    now: number;
  }): BuildReceipt {
    const { modules, tuning, licences, systems } = content();
    const port = systems
      .get(options.systemId)
      ?.ports.find((candidate) => candidate.id === options.portId);
    if (!port) throw new YardRefused('no-such-ship');

    const licence = licences.get(options.pilot.licence as LicenceId);
    if (!licence) throw new YardRefused('invalid-design');

    const placed = placeAll(options.placements, modules);
    const check = validateDesign(placed, licence, tuning);
    if (!check.valid) throw new YardRefused('invalid-design', check.problems);

    return this.store.transaction(() => {
      const previous = options.refitting
        ? this.ownedShip(options.pilot.accountId, options.refitting)
        : undefined;
      if (options.refitting && !previous) throw new YardRefused('no-such-ship');

      const cost = buildCost(options.placements, modules, tuning, previous?.placements ?? []);
      const split = splitBill(cost.bill, this.market.cargoOf(options.pilot.accountId));

      // Materials from the hold first, then whatever is left bought here at
      // this berth's own prices. A yard that could conjure parts would make
      // the commodity economy decorative.
      let materialsCost = 0;
      const bought: Record<string, number> = {};
      for (const [commodityId, units] of split.missing) {
        let filled;
        try {
          filled = this.market.fill({
            port,
            commodityId,
            units,
            pilot: options.pilot,
            now: options.now,
          });
        } catch (error) {
          // The yard answers in its own refusals. A captain who cannot pay
          // for the parts is told they cannot afford the hull, not handed
          // the Staple's error from inside a build.
          if (error instanceof TradeRefused) {
            throw new YardRefused(
              error.reason === 'cannot-afford' ? 'cannot-afford' : 'out-of-stock',
            );
          }
          throw error;
        }
        if (filled.units < units) throw new YardRefused('out-of-stock');
        materialsCost += filled.marks;
        bought[commodityId] = filled.units;
      }

      const fromHold: Record<string, number> = {};
      for (const [commodityId, units] of split.fromHold) {
        this.market.adjustCargo(options.pilot.accountId, commodityId, -units);
        fromHold[commodityId] = units;
      }

      let marksAfter = options.pilot.marks;
      if (cost.marks > 0) {
        try {
          marksAfter = this.ledger.post(
            {
              accountId: options.pilot.accountId,
              delta: -cost.marks,
              // A new hull is a hull; a refit is fittings.
              category: previous ? 'module-purchase' : 'hull-purchase',
              reason: `${previous ? 'Refit' : 'Built'} ${options.name} at ${port.name}`,
            },
            options.pilot,
          );
        } catch (error) {
          if (error instanceof InsufficientMarks) throw new YardRefused('cannot-afford');
          throw error;
        }
      } else if (cost.refund > 0) {
        // A refit that strips more than it adds pays the captain back.
        marksAfter = this.ledger.post(
          {
            accountId: options.pilot.accountId,
            delta: Math.min(cost.refund, cost.refund - cost.modules - cost.premium),
            category: 'refit-refund',
            reason: `Refit ${options.name} at ${port.name}`,
          },
          options.pilot,
        );
      }

      // Hit points for the hull as it now stands. A hull leaves the yard
      // sound: a refit that touches a module replaces it, and paying a yard
      // to fit a plate that arrives already dented is not a thing.
      const moduleHp = placed.map((module) => module.def.hitPoints);

      const shipId = previous?.id ?? randomUUID();
      if (previous) {
        this.store.db
          .update(schema.ships)
          .set({
            name: options.name,
            placements: JSON.stringify(options.placements),
            moduleHp: JSON.stringify(moduleHp),
          })
          .where(eq(schema.ships.id, previous.id))
          .run();
      } else {
        const count = this.store.db
          .select({ total: sql<number>`COUNT(*)` })
          .from(schema.ships)
          .where(eq(schema.ships.accountId, options.pilot.accountId))
          .get();
        if ((count?.total ?? 0) >= MAX_SHIPS) throw new YardRefused('too-many-ships');

        this.store.db
          .insert(schema.ships)
          .values({
            id: shipId,
            accountId: options.pilot.accountId,
            name: options.name,
            placements: JSON.stringify(options.placements),
            portId: options.portId,
            systemId: options.systemId,
            moduleHp: JSON.stringify(moduleHp),
            builtAt: options.now,
          })
          .run();
      }

      return {
        shipId,
        marks: cost.marks,
        premium: cost.premium,
        refund: cost.refund,
        fromHold,
        bought,
        materialsCost,
        marksAfter,
      };
    });
  }

  private ownedShip(accountId: string, shipId: string): OwnedShip | undefined {
    const row = this.store.db
      .select()
      .from(schema.ships)
      .where(and(eq(schema.ships.id, shipId), eq(schema.ships.accountId, accountId)))
      .get();
    return row ? toOwnedShip(row) : undefined;
  }
}

function toOwnedShip(row: typeof schema.ships.$inferSelect): OwnedShip {
  return {
    id: row.id,
    name: row.name,
    placements: JSON.parse(row.placements) as Placement[],
    portId: row.portId ?? '',
    systemId: row.systemId,
    moduleHp: JSON.parse(row.moduleHp) as number[],
  };
}
