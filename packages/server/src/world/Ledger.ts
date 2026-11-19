/**
 * The ledger.
 *
 * The only way marks move. Nothing else writes a balance: a change is a row
 * with a category and a reason, written in the same transaction as the
 * balance it changes, so the two can never disagree and the admin page can
 * always answer where the money went.
 *
 * Marks are integers. A rounding error in a ledger is a bug that compounds.
 */

import { eq, sql } from 'drizzle-orm';

import { schema, type Store } from '../db/index.ts';
import type { LedgerCategory } from '@marque/shared';
import type { Pilot } from './PilotStore.ts';

export class InsufficientMarks extends Error {
  constructor(
    readonly short: number,
    readonly needed: number,
  ) {
    super(`short by ${short} marks`);
    this.name = 'InsufficientMarks';
  }
}

export interface Posting {
  readonly accountId: string;
  /** Positive for a faucet, negative for a sink. Rounded to an integer. */
  readonly delta: number;
  readonly category: LedgerCategory;
  readonly reason: string;
}

export class Ledger {
  constructor(private readonly store: Store) {}

  /**
   * Move marks.
   *
   * One transaction: the row and the balance land together or neither does.
   * A sink that would take a captain below zero is refused rather than
   * clamped, because a balance that silently stops at zero hides a bug.
   */
  post(posting: Posting, pilot?: Pilot): number {
    const delta = Math.trunc(posting.delta);
    if (delta === 0) return pilot?.marks ?? this.balanceOf(posting.accountId);

    return this.store.transaction(() => {
      const row = this.store.db
        .select({ marks: schema.pilots.marks })
        .from(schema.pilots)
        .where(eq(schema.pilots.accountId, posting.accountId))
        .get();

      if (!row) throw new Error(`no captain for account ${posting.accountId}`);

      const next = row.marks + delta;
      if (next < 0) throw new InsufficientMarks(-next, Math.abs(delta));

      this.store.db
        .update(schema.pilots)
        .set({ marks: next, updatedAt: Date.now() })
        .where(eq(schema.pilots.accountId, posting.accountId))
        .run();

      this.store.db
        .insert(schema.ledger)
        .values({
          accountId: posting.accountId,
          delta,
          category: posting.category,
          reason: posting.reason,
          balance: next,
          at: Date.now(),
        })
        .run();

      // Keep the in-memory captain in step, so the next read is not stale.
      if (pilot) pilot.marks = next;
      return next;
    });
  }

  balanceOf(accountId: string): number {
    return (
      this.store.db
        .select({ marks: schema.pilots.marks })
        .from(schema.pilots)
        .where(eq(schema.pilots.accountId, accountId))
        .get()?.marks ?? 0
    );
  }

  /** Totals by category, for the admin page and the soak report. */
  totals(): { category: string; total: number; count: number }[] {
    return this.store.db
      .select({
        category: schema.ledger.category,
        total: sql<number>`sum(${schema.ledger.delta})`,
        count: sql<number>`count(*)`,
      })
      .from(schema.ledger)
      .groupBy(schema.ledger.category)
      .all();
  }

  /** A captain's recent history, newest first. */
  history(accountId: string, limit = 50): (typeof schema.ledger.$inferSelect)[] {
    return this.store.db
      .select()
      .from(schema.ledger)
      .where(eq(schema.ledger.accountId, accountId))
      .orderBy(sql`${schema.ledger.at} DESC, ${schema.ledger.id} DESC`)
      .limit(limit)
      .all();
  }
}
