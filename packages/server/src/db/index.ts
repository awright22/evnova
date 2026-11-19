/**
 * The database connection.
 *
 * SQLite through Drizzle, opened once per process. Write-ahead logging is on
 * so a reader never blocks the simulation, and foreign keys are enforced so a
 * pilot row cannot outlive its account.
 *
 * Economic actions are single transactions. `transaction()` here is the only
 * way they are written, so "it fully applies or it doesn't happen" is a
 * property of the code rather than a convention.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './schema.ts';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

export interface Store {
  readonly db: Db;
  readonly raw: Database.Database;
  /** Run a function inside one transaction. It fully applies or it does not. */
  transaction<T>(run: () => T): T;
  /** Back the file up, keeping a fixed number of daily snapshots. */
  snapshot(toPath: string): void;
  close(): void;
}

export function openStore(url: string): Store {
  const file = url === ':memory:' ? url : url.replace(/^file:/, '');

  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const raw = new Database(file);

  // Write-ahead logging: a reader never blocks a writer, which matters when a
  // snapshot runs while the world is ticking.
  raw.pragma('journal_mode = WAL');
  // Durability without an fsync per write. A crash can lose the last
  // transaction, which is what the few-seconds position flush already allows.
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  // Fail fast rather than hanging the tick if something else holds the lock.
  raw.pragma('busy_timeout = 4000');

  migrate(raw);

  return {
    db: drizzle(raw, { schema }),
    raw,
    transaction<T>(run: () => T): T {
      return raw.transaction(run)();
    },
    snapshot(toPath: string): void {
      mkdirSync(dirname(toPath), { recursive: true });
      // better-sqlite3's backup is online: it does not stop the world.
      raw.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    },
    close(): void {
      raw.close();
    },
  };
}

/**
 * Apply any migrations the file has not seen.
 *
 * The version lives in the database rather than in a filename, so a file that
 * has been copied between machines still knows what it is.
 */
function migrate(raw: Database.Database): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  const row = raw.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  const current = row ? Number(row.value) : 0;

  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `database is at schema version ${current}, but this build understands ${CURRENT_SCHEMA_VERSION}. ` +
        'Run a newer build, or restore an older snapshot.',
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  const apply = raw.transaction(() => {
    for (const migration of pending) {
      raw.exec(migration.up);
      raw
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(migration.version));
    }
  });
  apply();

  console.log(
    `database migrated from schema ${current} to ${pending[pending.length - 1]!.version}`,
  );
}

export { schema };
