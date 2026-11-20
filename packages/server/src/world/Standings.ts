/**
 * What the three charters think of each captain.
 *
 * The rules are in `@marque/shared` and are pure; this holds the values, and
 * is the one place that decides when they move. Everything that moves a
 * standing is something the captain did that the company could see: goods
 * bought at its berths, its hulls destroyed, its commissions answered,
 * contraband carried through its space.
 *
 * Standing is read far more often than it is written — every landing, every
 * price, every commission board — so it is cached per captain and written
 * through.
 */

import { eq } from 'drizzle-orm';

import {
  CHARTERS,
  berthAccepts,
  content,
  decayStanding,
  openingStandings,
  shiftStanding,
  standingDiscount,
  type Charter,
  type Standings as StandingSet,
} from '@marque/shared';

import { schema, type Store } from '../db/index.ts';

export class Standings {
  private readonly cache = new Map<string, StandingSet>();

  constructor(private readonly store: Store) {}

  /** Everything the charters think of this captain. */
  of(accountId: string): StandingSet {
    const cached = this.cache.get(accountId);
    if (cached) return cached;

    const rows = this.store.db
      .select()
      .from(schema.standings)
      .where(eq(schema.standings.accountId, accountId))
      .all();

    const set = openingStandings(content().tuning);
    for (const row of rows) {
      if ((CHARTERS as readonly string[]).includes(row.charter)) {
        set[row.charter as Charter] = row.value;
      }
    }
    this.cache.set(accountId, set);
    return set;
  }

  /**
   * Move a captain's standing with one charter, and against the others.
   *
   * Returns what the charters think afterwards, so a caller that wants to
   * tell the captain does not have to read it back.
   */
  shift(accountId: string, charter: Charter, delta: number, now: number): StandingSet {
    if (delta === 0) return this.of(accountId);

    const next = shiftStanding(this.of(accountId), charter, delta, content().tuning);
    this.write(accountId, next, now);
    return next;
  }

  /**
   * Drift every captain's standing back toward nothing.
   *
   * Called from the world's economy tick with the hours that have passed, so
   * an old grudge and an old favour both fade at the same measured rate the
   * rest of the world moves at.
   */
  decayAll(hours: number, now: number): void {
    if (hours <= 0) return;

    const accounts = this.store.db
      .selectDistinct({ accountId: schema.standings.accountId })
      .from(schema.standings)
      .all();

    this.store.transaction(() => {
      for (const row of accounts) {
        const next = decayStanding(this.of(row.accountId), hours, content().tuning);
        this.write(row.accountId, next, now);
      }
    });
  }

  /** Whether a berth belonging to this charter will take a captain alongside. */
  accepts(accountId: string, charter: Charter | undefined): boolean {
    if (charter === undefined) return true;
    return berthAccepts(this.of(accountId)[charter], content().tuning);
  }

  /** What standing is worth off a berth's spread, as a fraction. */
  discount(accountId: string, charter: Charter | undefined): number {
    if (charter === undefined) return 0;
    return standingDiscount(this.of(accountId)[charter], content().tuning);
  }

  private write(accountId: string, next: StandingSet, now: number): void {
    this.cache.set(accountId, next);
    this.store.transaction(() => {
      for (const charter of CHARTERS) {
        this.store.db
          .insert(schema.standings)
          .values({ accountId, charter, value: next[charter], updatedAt: now })
          .onConflictDoUpdate({
            target: [schema.standings.accountId, schema.standings.charter],
            set: { value: next[charter], updatedAt: now },
          })
          .run();
      }
    });
  }

  /** Forget a captain's cached standing, so the next read comes off the row. */
  release(accountId: string): void {
    this.cache.delete(accountId);
  }
}
