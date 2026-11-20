/**
 * The world service.
 *
 * Owns the database, accounts, captains and — from M4 — the economy, the
 * exchange, missions and the Gazette. It runs on its own clock and keeps
 * ticking whether or not any room exists, which is what makes prices move
 * overnight and freight redistribute while nobody is online.
 *
 * The clock is injected so the soak can run a month of world time in minutes.
 */

import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { content } from '@marque/shared';

import { Accounts } from '../accounts.ts';
import { config } from '../config.ts';
import { openStore, type Store } from '../db/index.ts';
import { ChatLog } from './ChatLog.ts';
import { Exchange } from './Exchange.ts';
import { Standings } from './Standings.ts';
import { Gazette } from './Gazette.ts';
import { Ledger } from './Ledger.ts';
import { Freight } from './Freight.ts';
import { Market } from './Market.ts';
import { Yard } from './Yard.ts';
import { PilotStore } from './PilotStore.ts';

/** Time, injected. Real time in production; accelerated in the soak. */
export interface WorldClock {
  now(): number;
}

export const SYSTEM_CLOCK: WorldClock = { now: () => Date.now() };

/**
 * How often changed captains are written.
 *
 * This is exactly how much of a captain's position a hard kill can cost, so
 * it is the number the persistence check measures against rather than a
 * threshold written out separately. Two seconds against the fastest shipped
 * draught is a few hundred units of travel — inside the spec's "at most a few
 * seconds" with room to spare, and cheap: a flush is a handful of integer
 * columns per captain who has moved.
 */
export const FLUSH_INTERVAL_MS = 2000;

/**
 * How often the economy drifts.
 *
 * The interval only decides how smooth the drift is; how far it moves comes
 * from the clock, so changing this does not change the economy.
 */
const ECONOMY_INTERVAL_MS = 10_000;

/** How often a daily snapshot is considered. */
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

export class World {
  readonly store: Store;
  readonly accounts: Accounts;
  readonly pilots: PilotStore;
  readonly ledger: Ledger;
  readonly market: Market;
  readonly freight: Freight;
  readonly yard: Yard;
  readonly exchange: Exchange;
  readonly standings: Standings;
  readonly gazette = new Gazette();
  readonly chat = new ChatLog();

  private flushTimer: NodeJS.Timeout | undefined;
  private economyTimer: NodeJS.Timeout | undefined;
  /** When the economy was last drifted, so a gap is caught up rather than lost. */
  private lastEconomyAt = 0;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private lastSnapshotDay = '';
  /** When the Bourse last ticked, so an accelerated clock ticks it faster. */
  private lastBourseAt = 0;

  /**
   * Called after a market tick, so rooms can push the new prices out.
   *
   * The World does not know about rooms, and should not: it hands the event
   * to whoever registered, which is the server's wiring rather than this
   * class's business.
   */
  onBourseTick: ((dividends: { ticker: string; marks: number }[]) => void) | undefined;

  constructor(
    readonly clock: WorldClock = SYSTEM_CLOCK,
    databaseUrl: string = config.databaseUrl,
  ) {
    this.store = openStore(databaseUrl);
    this.accounts = new Accounts(this.store);
    this.pilots = new PilotStore(this.store);
    this.ledger = new Ledger(this.store);
    this.market = new Market(this.store, this.ledger);
    this.freight = new Freight(this.market);
    this.yard = new Yard(this.store, this.ledger, this.market);
    this.standings = new Standings(this.store);
    this.exchange = new Exchange(this.store, this.ledger);
    // The Staple and the Yard credit companies for what actually leaves a
    // stockpile and what is actually spent on fittings, so they need the
    // Bourse. Set after construction because the Exchange needs the ledger,
    // which they also hold.
    this.market.exchange = this.exchange;
    this.market.standings = this.standings;
    this.yard.exchange = this.exchange;
    this.freight.exchange = this.exchange;
    this.exchange.seed();
    this.lastEconomyAt = this.clock.now();
    this.lastBourseAt = this.clock.now();
  }

  /** Start the background work: flushing and snapshots. */
  start(): void {
    this.flushTimer ??= setInterval(() => {
      try {
        this.pilots.flush();
      } catch (error) {
        // A failed flush must not stop the world: the next one will try again.
        console.error('flushing captains failed:', error);
      }
    }, FLUSH_INTERVAL_MS);

    this.economyTimer ??= setInterval(() => this.tickEconomy(), ECONOMY_INTERVAL_MS);

    this.snapshotTimer ??= setInterval(() => this.maybeSnapshot(), SNAPSHOT_INTERVAL_MS);
    // Take one at startup so a fresh deployment has a restore point.
    this.maybeSnapshot();
  }

  /**
   * Drift the economy by however long has actually passed.
   *
   * Measured from the clock rather than assumed from the interval, so a
   * server that was asleep, throttled or stopped catches up instead of losing
   * the time, and the soak's accelerated clock moves the world a month in
   * seconds without changing anything here.
   */
  tickEconomy(): void {
    const now = this.clock.now();
    const hours = ((now - this.lastEconomyAt) / 3_600_000) * config.economyTimeScale;
    if (hours <= 0) return;
    this.lastEconomyAt = now;

    try {
      this.market.drift(hours, now);
      // Then the Reach's own freighters even it out, which is what keeps a
      // berth that only eats something from running out for good.
      this.freight.run(hours, now);
      this.tickBourse(now);
      // An old grudge and an old favour both fade, at the same measured rate
      // the rest of the world moves at.
      this.standings.decayAll(hours, now);
    } catch (error) {
      // A failed drift must not stop the world; the next one covers the gap,
      // because the elapsed time is measured and not assumed.
      this.lastEconomyAt = now - (hours / config.economyTimeScale) * 3_600_000;
      console.error('drifting the economy failed:', error);
    }
  }

  /**
   * Move the Bourse on, if a market tick's worth of time has passed.
   *
   * Driven from the same measured clock as the economy, so the soak's
   * accelerated time moves prices as fast as it moves stockpiles and a month
   * of market ticks happens in a month of simulated time rather than in a
   * month of real seconds.
   */
  private tickBourse(now: number): void {
    const { tickSeconds } = content().tuning.exchange;
    const elapsed = ((now - this.lastBourseAt) / 1000) * config.economyTimeScale;
    const due = Math.floor(elapsed / tickSeconds);
    if (due <= 0) return;

    this.lastBourseAt = now;
    const paid: { ticker: string; marks: number }[] = [];
    // Capped: a server that was stopped for a week should not run a thousand
    // market ticks in one pass and reprice the whole Bourse in a frame.
    const runs = Math.min(due, 20);
    for (let i = 0; i < runs; i++) {
      // The last pass takes whatever is left and publishes the headlines, so
      // a catch-up reads as one period of trading rather than as one busy
      // tick followed by a run of empty ones.
      const result = this.exchange.tick(now, { of: runs - i });
      this.gazette.report(result.events, result.dividends, now);
      paid.push(...result.dividends);
    }
    this.onBourseTick?.(paid);
  }

  /**
   * One snapshot a day, keeping the configured number.
   *
   * `VACUUM INTO` is an online copy, so this does not stop the simulation. It
   * refuses to write over an existing file, and the day already taken is only
   * remembered in memory, so a server restarted later the same day used to
   * fail here every time and leave the day's backup frozen at whatever the
   * first boot held. The copy goes to a temporary name and is renamed over
   * the day's file: one file per day, always the freshest, and never a
   * half-written file standing in as the backup.
   */
  private maybeSnapshot(): void {
    if (config.databaseUrl === ':memory:') return;

    const day = new Date(this.clock.now()).toISOString().slice(0, 10);
    if (day === this.lastSnapshotDay) return;
    this.lastSnapshotDay = day;

    const target = join(config.snapshotDir, `marque-${day}.db`);
    const scratch = join(config.snapshotDir, `marque-${day}.writing.db`);

    try {
      rmSync(scratch, { force: true });
      this.store.snapshot(scratch);
      renameSync(scratch, target);
      this.pruneSnapshots();
    } catch (error) {
      rmSync(scratch, { force: true });
      console.error('snapshot failed:', error);
    }
  }

  private pruneSnapshots(): void {
    try {
      const files = readdirSync(config.snapshotDir)
        .filter((name) => /^marque-\d{4}-\d{2}-\d{2}\.db$/.test(name))
        .sort();
      for (const stale of files.slice(0, Math.max(0, files.length - config.snapshotKeep))) {
        rmSync(join(config.snapshotDir, stale), { force: true });
      }
    } catch (error) {
      console.error('pruning snapshots failed:', error);
    }
  }

  /** Write everything and close. Called on graceful shutdown. */
  shutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.economyTimer) clearInterval(this.economyTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.flushTimer = undefined;
    this.snapshotTimer = undefined;

    const written = this.pilots.flush();
    if (written > 0) console.log(`wrote ${written} captain(s) on shutdown`);
    this.store.close();
  }
}

/** The world, created once per process. */
let instance: World | undefined;

export function world(): World {
  instance ??= new World();
  return instance;
}

/** Replace the world, for tests. */
export function setWorld(next: World | undefined): void {
  instance = next;
}
