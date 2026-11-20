/**
 * The database schema.
 *
 * SQLite through Drizzle. Marks, cargo, Propellant and share quantities are
 * integers everywhere: money is never a float, and a rounding error in a
 * ledger is a bug that compounds.
 *
 * Tables arrive with the milestone that needs them. These are M3's.
 */

import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * An account.
 *
 * A captain is a callsign plus a device token, gated by a shared invite code.
 * Neither the token nor the recovery phrase is stored: only a hash, so a copy
 * of the database does not let anyone fly someone else's hull.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    callsign: text('callsign').notNull(),
    /** Lowercased, for a case-insensitive uniqueness check. */
    callsignKey: text('callsign_key').notNull(),
    /** SHA-256 of the device token. The token itself is high-entropy random. */
    deviceTokenHash: text('device_token_hash').notNull(),
    /** scrypt of the recovery phrase, which is words and so lower entropy. */
    recoveryHash: text('recovery_hash').notNull(),
    recoverySalt: text('recovery_salt').notNull(),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('accounts_callsign_key').on(table.callsignKey),
    index('accounts_device_token').on(table.deviceTokenHash),
  ],
);

/**
 * A captain's state in the world.
 *
 * One row per account. Position and hull damage are fast-changing and flush on
 * a timer and at shutdown; everything else is written in the transaction that
 * changes it.
 */
export const pilots = sqliteTable(
  'pilots',
  {
    accountId: text('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),

    /** Marks. An integer, always. */
    marks: integer('marks').notNull().default(0),

    /** Where the hull is. */
    systemId: text('system_id').notNull(),
    x: integer('x').notNull().default(0),
    y: integer('y').notNull().default(0),
    /** Facing in milliradians, so the column stays an integer. */
    angleMrad: integer('angle_mrad').notNull().default(0),

    /** Set while landed, which takes the hull out of the simulation. */
    landedPortId: text('landed_port_id'),

    /** The draught being flown. */
    blueprintId: text('blueprint_id').notNull(),
    /** Per-module hit points, as JSON, so a damaged hull survives a restart. */
    moduleHp: text('module_hp').notNull().default('[]'),
    shield: integer('shield').notNull().default(0),

    /** Units of Ordnance aboard. */
    ammo: integer('ammo').notNull().default(0),

    /** Units of Propellant aboard. Jump fuel, and a commodity from M4. */
    propellant: integer('propellant').notNull().default(0),

    /** Hull licence held, which caps what can be built. */
    licence: text('licence').notNull().default('open-ticket'),

    /** Composition owed to the Prize Court. Non-zero means posted. */
    composition: integer('composition').notNull().default(0),

    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('pilots_system').on(table.systemId)],
);

/**
 * The ledger.
 *
 * Append-only. Every mark created or destroyed is a row here with a category,
 * so the change in total marks always equals faucets minus sinks and the admin
 * page can show where the money went.
 */
export const ledger = sqliteTable(
  'ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Positive for a faucet, negative for a sink. Always an integer. */
    delta: integer('delta').notNull(),
    category: text('category').notNull(),
    /** What it was for, in the voice the captain reads. */
    reason: text('reason').notNull(),
    /** The balance after this row, so the history reconciles without a scan. */
    balance: integer('balance').notNull(),
    at: integer('at').notNull(),
  },
  (table) => [
    index('ledger_account').on(table.accountId, table.at),
    index('ledger_category').on(table.category),
  ],
);

/**
 * What each berth is holding.
 *
 * One row per berth per commodity, because the invariants are about integers
 * and an integer in a column can be constrained, summed and checked. A berth
 * with no row for a commodity has not been opened yet, and is seeded at its
 * target the first time anyone asks.
 */
export const stockpiles = sqliteTable(
  'stockpiles',
  {
    portId: text('port_id').notNull(),
    commodityId: text('commodity_id').notNull(),
    /** Units on hand. Never negative, never past capacity. */
    stock: integer('stock').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.portId, table.commodityId] }),
    index('stockpiles_commodity').on(table.commodityId),
  ],
);

/**
 * What a captain is carrying.
 *
 * A row per captain per commodity, dropped when it reaches nothing, so the
 * table holds only real cargo and a sum over it is the hold's contents.
 */
export const cargo = sqliteTable(
  'cargo',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    commodityId: text('commodity_id').notNull(),
    /** Units aboard. Never negative. */
    units: integer('units').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.commodityId] })],
);

/**
 * Designs a captain has saved.
 *
 * The placements are JSON because a design is read and written whole and
 * never queried by its parts. A design is not a ship: it is a drawing, and
 * costs nothing until it is built.
 */
export const designs = sqliteTable(
  'designs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Placements as JSON: `[{ moduleId, x, y, rotation }]`. */
    placements: text('placements').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('designs_account').on(table.accountId)],
);

/**
 * Hulls a captain owns.
 *
 * Each is parked at the berth it was left at, and exactly one is being flown.
 * The pilot row still carries the hull that is in the air, because that is
 * what the simulation reads every tick; this table is the hangar.
 */
export const ships = sqliteTable(
  'ships',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Placements as JSON, frozen at the moment it was built or refitted. */
    placements: text('placements').notNull(),
    /** Where it is parked. Null while it is the hull being flown. */
    portId: text('port_id'),
    systemId: text('system_id').notNull(),
    /** Per-module hit points, as JSON, so a parked hull keeps its damage. */
    moduleHp: text('module_hp').notNull().default('[]'),
    builtAt: integer('built_at').notNull(),
  },
  (table) => [index('ships_account').on(table.accountId)],
);

/** Schema version, so a migration knows what it is upgrading. */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const CURRENT_SCHEMA_VERSION = 5;

/**
 * Migrations, applied in order.
 *
 * Kept as plain SQL rather than generated files: the schema is small, the
 * statements are readable, and a migration that can be read in the same place
 * as the table it changes is a migration that gets reviewed.
 */
export const MIGRATIONS: readonly { version: number; up: string }[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        callsign TEXT NOT NULL,
        callsign_key TEXT NOT NULL,
        device_token_hash TEXT NOT NULL,
        recovery_hash TEXT NOT NULL,
        recovery_salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_callsign_key ON accounts (callsign_key);
      CREATE INDEX IF NOT EXISTS accounts_device_token ON accounts (device_token_hash);

      CREATE TABLE IF NOT EXISTS pilots (
        account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
        marks INTEGER NOT NULL DEFAULT 0,
        system_id TEXT NOT NULL,
        x INTEGER NOT NULL DEFAULT 0,
        y INTEGER NOT NULL DEFAULT 0,
        angle_mrad INTEGER NOT NULL DEFAULT 0,
        landed_port_id TEXT,
        blueprint_id TEXT NOT NULL,
        module_hp TEXT NOT NULL DEFAULT '[]',
        shield INTEGER NOT NULL DEFAULT 0,
        ammo INTEGER NOT NULL DEFAULT 0,
        licence TEXT NOT NULL DEFAULT 'open-ticket',
        composition INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pilots_system ON pilots (system_id);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Propellant is jump fuel and, from M4, a commodity like any other.
    version: 2,
    up: `
      ALTER TABLE pilots ADD COLUMN propellant INTEGER NOT NULL DEFAULT 60;
    `,
  },
  {
    // Every mark created or destroyed gets a row with a category.
    version: 3,
    up: `
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        delta INTEGER NOT NULL,
        category TEXT NOT NULL,
        reason TEXT NOT NULL,
        balance INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, at);
      CREATE INDEX IF NOT EXISTS ledger_category ON ledger (category);
    `,
  },
  {
    // The economy: what each berth holds, and what each captain carries.
    // Both are integers with a CHECK, because invariant 5 says no cargo count
    // goes negative and a constraint is worth more than a convention.
    version: 4,
    up: `
      CREATE TABLE IF NOT EXISTS stockpiles (
        port_id TEXT NOT NULL,
        commodity_id TEXT NOT NULL,
        stock INTEGER NOT NULL CHECK (stock >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (port_id, commodity_id)
      );
      CREATE INDEX IF NOT EXISTS stockpiles_commodity ON stockpiles (commodity_id);

      CREATE TABLE IF NOT EXISTS cargo (
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        commodity_id TEXT NOT NULL,
        units INTEGER NOT NULL CHECK (units > 0),
        PRIMARY KEY (account_id, commodity_id)
      );
    `,
  },
  {
    // The shipyard: designs a captain has drawn, and hulls they own.
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS designs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        placements TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS designs_account ON designs (account_id);

      CREATE TABLE IF NOT EXISTS ships (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        placements TEXT NOT NULL,
        port_id TEXT,
        system_id TEXT NOT NULL,
        module_hp TEXT NOT NULL DEFAULT '[]',
        built_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ships_account ON ships (account_id);
    `,
  },
];
