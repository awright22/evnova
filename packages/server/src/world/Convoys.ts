/**
 * Convoys: captains sailing together.
 *
 * Spec section 12 asks for fleets — invite friends, see each other on the
 * radar and the map, share commissions. In a setting where every loss is
 * somebody's insurance claim, ships travelling together for mutual
 * protection are a convoy, so that is what a captain reads.
 *
 * A convoy is a row and a set of member rows; an invitation is a member row
 * in the `invited` state rather than a message, so an invite survives both
 * captains logging out and there is nothing to deliver twice. One convoy per
 * captain: a captain with a pending invitation is not yet in it, so they may
 * hold several invitations and exactly one membership.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';

import { schema, type Store } from '../db/index.ts';

/** Why a convoy intent was refused, in the protocol's own words. */
export type ConvoyRefusal =
  | 'no-such-captain'
  | 'already-in-a-convoy'
  | 'not-in-a-convoy'
  | 'not-invited'
  | 'already-invited'
  | 'convoy-full'
  | 'not-the-leader'
  | 'cannot-invite-yourself';

export class ConvoyRefused extends Error {
  constructor(readonly reason: ConvoyRefusal) {
    super(reason);
    this.name = 'ConvoyRefused';
  }
}

/** One captain's place in a convoy. */
export interface ConvoyMember {
  readonly accountId: string;
  readonly callsign: string;
  readonly state: 'member' | 'invited';
  readonly isLeader: boolean;
  readonly joinedAt: number;
}

/** A convoy as anybody in it reads it. */
export interface ConvoyView {
  readonly id: string;
  readonly name: string;
  readonly leaderId: string;
  readonly members: readonly ConvoyMember[];
}

/** An invitation waiting on a captain. */
export interface ConvoyInvitation {
  readonly fleetId: string;
  readonly name: string;
  readonly from: string;
  readonly at: number;
}

/**
 * How many may sail together.
 *
 * Bounded because a convoy shares one commission between all of them and is
 * drawn on everybody's radar: both are fine for a handful and neither is
 * fine for a hundred.
 */
export const CONVOY_LIMIT = 8;

export class Convoys {
  constructor(private readonly store: Store) {}

  /** The convoy this captain is in, or undefined. */
  of(accountId: string): ConvoyView | undefined {
    const row = this.store.db
      .select({ fleetId: schema.fleetMembers.fleetId })
      .from(schema.fleetMembers)
      .where(
        and(
          eq(schema.fleetMembers.accountId, accountId),
          eq(schema.fleetMembers.state, 'member'),
        ),
      )
      .get();
    return row ? this.view(row.fleetId) : undefined;
  }

  /** Just the account ids, for the hot paths that only need to mark a hull. */
  memberIds(accountId: string): readonly string[] {
    return this.of(accountId)?.members.filter((m) => m.state === 'member').map((m) => m.accountId)
      ?? [];
  }

  /** Everything waiting on this captain's answer. */
  invitations(accountId: string): ConvoyInvitation[] {
    const rows = this.store.db
      .select({
        fleetId: schema.fleetMembers.fleetId,
        joinedAt: schema.fleetMembers.joinedAt,
        name: schema.fleets.name,
        leaderId: schema.fleets.leaderId,
      })
      .from(schema.fleetMembers)
      .innerJoin(schema.fleets, eq(schema.fleets.id, schema.fleetMembers.fleetId))
      .where(
        and(
          eq(schema.fleetMembers.accountId, accountId),
          eq(schema.fleetMembers.state, 'invited'),
        ),
      )
      .all();
    if (rows.length === 0) return [];

    const names = this.callsigns(rows.map((row) => row.leaderId));
    return rows.map((row) => ({
      fleetId: row.fleetId,
      name: row.name,
      from: names.get(row.leaderId) ?? '',
      at: row.joinedAt,
    }));
  }

  /**
   * Ask a captain to sail with you, opening a convoy if you are not in one.
   *
   * The convoy comes into being with its first invitation rather than as a
   * separate act, because a convoy of one is not a thing a captain wants and
   * "make a convoy, then invite somebody" is the same intent in two steps.
   */
  invite(accountId: string, callsign: string, now: number): ConvoyView {
    const them = this.store.db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.callsignKey, callsign.trim().toLowerCase()))
      .get();
    if (!them) throw new ConvoyRefused('no-such-captain');
    if (them.id === accountId) throw new ConvoyRefused('cannot-invite-yourself');

    const mine = this.of(accountId);
    if (mine && mine.leaderId !== accountId) throw new ConvoyRefused('not-the-leader');

    const theirs = this.of(them.id);
    if (theirs) throw new ConvoyRefused('already-in-a-convoy');

    return this.store.transaction(() => {
      const fleetId = mine?.id ?? randomUUID();
      if (!mine) {
        const callsignOf = this.callsigns([accountId]).get(accountId) ?? 'a captain';
        this.store.db
          .insert(schema.fleets)
          .values({
            id: fleetId,
            name: `${callsignOf}'s convoy`,
            leaderId: accountId,
            createdAt: now,
          })
          .run();
        this.store.db
          .insert(schema.fleetMembers)
          .values({ fleetId, accountId, state: 'member', joinedAt: now })
          .run();
      }

      const existing = this.store.db
        .select({ state: schema.fleetMembers.state })
        .from(schema.fleetMembers)
        .where(
          and(
            eq(schema.fleetMembers.fleetId, fleetId),
            eq(schema.fleetMembers.accountId, them.id),
          ),
        )
        .get();
      if (existing) throw new ConvoyRefused('already-invited');

      const count = this.view(fleetId).members.length;
      if (count >= CONVOY_LIMIT) throw new ConvoyRefused('convoy-full');

      this.store.db
        .insert(schema.fleetMembers)
        .values({ fleetId, accountId: them.id, state: 'invited', joinedAt: now })
        .run();

      return this.view(fleetId);
    });
  }

  /** Take an invitation up. Every other invitation this captain holds lapses. */
  accept(accountId: string, fleetId: string, now: number): ConvoyView {
    const invited = this.store.db
      .select({ state: schema.fleetMembers.state })
      .from(schema.fleetMembers)
      .where(
        and(
          eq(schema.fleetMembers.fleetId, fleetId),
          eq(schema.fleetMembers.accountId, accountId),
          eq(schema.fleetMembers.state, 'invited'),
        ),
      )
      .get();
    if (!invited) throw new ConvoyRefused('not-invited');
    if (this.of(accountId)) throw new ConvoyRefused('already-in-a-convoy');

    const members = this.view(fleetId).members.filter((row) => row.state === 'member');
    if (members.length >= CONVOY_LIMIT) throw new ConvoyRefused('convoy-full');

    return this.store.transaction(() => {
      this.store.db
        .update(schema.fleetMembers)
        .set({ state: 'member', joinedAt: now })
        .where(
          and(
            eq(schema.fleetMembers.fleetId, fleetId),
            eq(schema.fleetMembers.accountId, accountId),
          ),
        )
        .run();

      // Any other invitation is now moot: one convoy per captain.
      this.store.db
        .delete(schema.fleetMembers)
        .where(
          and(
            eq(schema.fleetMembers.accountId, accountId),
            ne(schema.fleetMembers.fleetId, fleetId),
          ),
        )
        .run();

      return this.view(fleetId);
    });
  }

  /** Turn one down. */
  decline(accountId: string, fleetId: string): void {
    const removed = this.store.db
      .delete(schema.fleetMembers)
      .where(
        and(
          eq(schema.fleetMembers.fleetId, fleetId),
          eq(schema.fleetMembers.accountId, accountId),
          eq(schema.fleetMembers.state, 'invited'),
        ),
      )
      .run();
    if (removed.changes === 0) throw new ConvoyRefused('not-invited');
  }

  /**
   * Leave, or disband if you are the one holding it together.
   *
   * The leader leaving dissolves the convoy rather than handing it on: a
   * convoy is an arrangement between captains who agreed to it, and the
   * quiet reassignment of one to somebody who did not ask for it is worse
   * than making everybody arrange it again.
   */
  leave(accountId: string): { disbanded: boolean; fleetId: string } {
    const convoy = this.of(accountId);
    if (!convoy) throw new ConvoyRefused('not-in-a-convoy');

    return this.store.transaction(() => {
      if (convoy.leaderId === accountId) {
        this.unshareAll(convoy.id);
        this.store.db.delete(schema.fleets).where(eq(schema.fleets.id, convoy.id)).run();
        return { disbanded: true, fleetId: convoy.id };
      }

      this.store.db
        .delete(schema.fleetMembers)
        .where(
          and(
            eq(schema.fleetMembers.fleetId, convoy.id),
            eq(schema.fleetMembers.accountId, accountId),
          ),
        )
        .run();
      return { disbanded: false, fleetId: convoy.id };
    });
  }

  /** Put somebody out of it. The leader's prerogative, and only theirs. */
  remove(accountId: string, targetId: string): ConvoyView {
    const convoy = this.of(accountId);
    if (!convoy) throw new ConvoyRefused('not-in-a-convoy');
    if (convoy.leaderId !== accountId) throw new ConvoyRefused('not-the-leader');
    if (targetId === accountId) throw new ConvoyRefused('cannot-invite-yourself');

    this.store.db
      .delete(schema.fleetMembers)
      .where(
        and(
          eq(schema.fleetMembers.fleetId, convoy.id),
          eq(schema.fleetMembers.accountId, targetId),
        ),
      )
      .run();
    return this.view(convoy.id);
  }

  /** A convoy by id, members and invitations together, leader first. */
  view(fleetId: string): ConvoyView {
    const fleet = this.store.db
      .select()
      .from(schema.fleets)
      .where(eq(schema.fleets.id, fleetId))
      .get();
    if (!fleet) throw new ConvoyRefused('not-in-a-convoy');

    const rows = this.store.db
      .select()
      .from(schema.fleetMembers)
      .where(eq(schema.fleetMembers.fleetId, fleetId))
      .all();

    const names = this.callsigns(rows.map((row) => row.accountId));
    const members = rows
      .map((row) => ({
        accountId: row.accountId,
        callsign: names.get(row.accountId) ?? '',
        state: row.state === 'invited' ? ('invited' as const) : ('member' as const),
        isLeader: row.accountId === fleet.leaderId,
        joinedAt: row.joinedAt,
      }))
      .sort((a, b) => {
        if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1;
        if (a.state !== b.state) return a.state === 'member' ? -1 : 1;
        return a.joinedAt - b.joinedAt || a.callsign.localeCompare(b.callsign);
      });

    return { id: fleet.id, name: fleet.name, leaderId: fleet.leaderId, members };
  }

  /** Take every shared commission off a convoy's books. */
  private unshareAll(fleetId: string): void {
    this.store.db
      .update(schema.commissions)
      .set({ sharedFleetId: '' })
      .where(eq(schema.commissions.sharedFleetId, fleetId))
      .run();
  }

  private callsigns(ids: readonly string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const rows = this.store.db
      .select({ id: schema.accounts.id, callsign: schema.accounts.callsign })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, [...new Set(ids)]))
      .all();
    return new Map(rows.map((row) => [row.id, row.callsign]));
  }
}
