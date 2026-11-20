/**
 * The database schema.
 *
 * SQLite through Drizzle. Marks, cargo, Propellant and share quantities are
 * integers everywhere: money is never a float, and a rounding error in a
 * ledger is a bug that compounds.
 *
 * Tables arrive with the milestone that needs them. These are M3's.
 */

import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
    /**
     * The last berth this captain was alongside, which survives launching.
     *
     * Spec section 8: a captain whose hull is written off wakes at the last
     * berth they landed at. `landed_port_id` cannot answer that, because it
     * is cleared on launch and a hull is only ever written off in flight.
     */
    lastPortId: text('last_port_id').notNull().default(''),

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
    /**
     * The charter whose letter of marque this captain holds, or empty.
     *
     * A letter is a company's instrument rather than a possession: it lapses
     * on its own when standing with the issuer falls, so this is written as
     * often as it is read.
     */
    letter: text('letter').notNull().default(''),

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
    /**
     * How many of those units were scooped from a wreck.
     *
     * Prize cargo sells at a premium at the issuer's berths, and spec section
     * 19 is specific that only cargo taken off a destroyed hull counts — so
     * the hold has to remember where its contents came from. Never more than
     * `units`.
     */
    prize: integer('prize').notNull().default(0),
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
/**
 * A listed company's market state.
 *
 * The pool is the whole order book: its shares and marks are the exchange's,
 * not any captain's, so nothing here is part of the player credit total. The
 * smoothed earnings figure is what fair value is derived from, and the period
 * figure accumulates between market ticks.
 */
export const listings = sqliteTable('listings', {
  ticker: text('ticker').primaryKey(),
  /** Shares the pool holds and will sell. */
  poolShares: integer('pool_shares').notNull(),
  /** Marks the pool holds and will pay out. */
  poolMarks: integer('pool_marks').notNull(),
  /** Earnings a tick, smoothed, which fair value is a multiple of. */
  smoothedEarnings: real('smoothed_earnings').notNull(),
  /** Earnings banked since the last market tick, folded in at the next one. */
  periodEarnings: real('period_earnings').notNull().default(0),
  /** Earnings set aside for the next dividend. */
  undistributed: real('undistributed').notNull().default(0),
  /** The quoted price a tick ago, so the interface can show the move. */
  previousPrice: real('previous_price').notNull(),
  /** Recent prices as a JSON array, oldest first, for the chart. */
  history: text('history').notNull().default('[]'),
  /** Market ticks since the listing opened, for the dividend cadence. */
  ticks: integer('ticks').notNull().default(0),
});

/** What a captain holds in one company. */
export const holdings = sqliteTable(
  'holdings',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ticker: text('ticker').notNull(),
    /**
     * Shares held, or owed where it is negative.
     *
     * A short is a holding of less than nothing: the captain sold shares they
     * did not have and has to buy them back. One column rather than two,
     * because a captain is long or short a listing and never both, and
     * because every rule that caps a position should cap it either way round.
     */
    shares: integer('shares').notNull().default(0),
    /**
     * Total marks paid for the shares still held, fees included.
     *
     * Reduced proportionally on a sale rather than by the sale's proceeds, so
     * it stays the cost of what remains and a partial sale cannot make the
     * basis negative. On a short it is what the sale brought in, which is the
     * figure the gain is measured against the other way round.
     */
    costBasis: integer('cost_basis').notNull().default(0),
    /** Dividends received on this listing, all told. */
    dividends: integer('dividends').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.ticker] })],
);

/**
 * Standing orders on the Bourse.
 *
 * A limit order is not a resting order somebody else crosses: there is no
 * book here, only the pool's curve. It is an instruction to trade along that
 * curve on each market tick, as far as the limit allows and no further, until
 * it is filled or withdrawn. That is why `shares` falls as it fills: what is
 * left on the row is what is still wanted.
 */
export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    ticker: text('ticker').notNull(),
    /** 'buy' or 'sell'. */
    side: text('side').notNull(),
    /** Shares still wanted. */
    shares: integer('shares').notNull(),
    /** Shares filled so far, for the interface and the history. */
    filled: integer('filled').notNull().default(0),
    /** Marks received or paid so far, fees included. */
    settled: integer('settled').notNull().default(0),
    /**
     * The limit, in hundredths of a mark a share.
     *
     * Hundredths because a share can be worth less than a mark — the value
     * floor is four tenths of one — and a whole-mark limit would be no limit
     * at all down there. Integers because everything the database holds about
     * money is an integer.
     */
    limitHundredths: integer('limit_hundredths').notNull(),
    /** A sell that may take the captain short, rather than only selling what they hold. */
    short: integer('short', { mode: 'boolean' }).notNull().default(false),
    /** 'open', 'filled', 'cancelled'. */
    state: text('state').notNull().default('open'),
    /** Why it closed, in the captain's own words where there are any. */
    reason: text('reason').notNull().default(''),
    placedAt: integer('placed_at').notNull(),
    closedAt: integer('closed_at').notNull().default(0),
  },
  (table) => [
    index('orders_open').on(table.state, table.ticker),
    index('orders_account').on(table.accountId, table.state),
  ],
);

/**
 * What each charter thinks of a captain.
 *
 * One row per captain per charter rather than three columns on the pilot,
 * because the set of charters is content: spec section 19 fixes it at three
 * today, and a row is the shape that does not need a migration if that ever
 * reads differently.
 */
export const standings = sqliteTable(
  'standings',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    charter: text('charter').notNull(),
    value: real('value').notNull().default(0),
    /** When it last moved, so decay is measured and not assumed. */
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.charter] })],
);

/**
 * A commission a captain has actually taken.
 *
 * What a berth is *offering* is not here: a board is derived from the berth,
 * the hour and the captain's standing, so nothing is written down until
 * somebody takes a job. What is written down is the terms as they were when
 * it was taken, because a Factor does not get to change them afterwards.
 */
export const commissions = sqliteTable(
  'commissions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The template it came from, or the chain's id for a chain beat. */
    templateId: text('template_id').notNull(),
    /** Empty for a one-off; the chain's id when this is a beat of one. */
    chainId: text('chain_id').notNull().default(''),
    step: integer('step').notNull().default(0),
    kind: text('kind').notNull(),
    /** 'taken', 'done' or 'failed'. */
    state: text('state').notNull().default('taken'),
    /** The terms as agreed, frozen: units, where, what, what it pays. */
    terms: text('terms').notNull(),
    takenAt: integer('taken_at').notNull(),
    /** When it is too late, or 0 for work with no deadline. */
    dueAt: integer('due_at').notNull().default(0),
    settledAt: integer('settled_at').notNull().default(0),
    /**
     * The convoy this is on the books of, or empty.
     *
     * A shared commission is still one commission: any member may discharge
     * it, and it pays once, to whoever does. Copying it per member would
     * multiply the faucet by the size of the convoy for the same work.
     */
    sharedFleetId: text('shared_fleet_id').notNull().default(''),
    /** Who actually discharged it, when that was not the captain who took it. */
    settledBy: text('settled_by').notNull().default(''),
  },
  (table) => [
    index('commissions_account').on(table.accountId),
    index('commissions_shared').on(table.sharedFleetId),
  ],
);

/**
 * A fleet: captains who fly together.
 *
 * Flat rather than hierarchical. There is a leader because somebody has to
 * be able to disband it and because an invitation has to come from
 * somewhere, but a fleet is a list of people, not a rank structure — spec
 * section 12 asks for friends who can see each other and share work, and
 * nothing more.
 */
export const fleets = sqliteTable('fleets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  leaderId: text('leader_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
});

export const fleetMembers = sqliteTable(
  'fleet_members',
  {
    fleetId: text('fleet_id')
      .notNull()
      .references(() => fleets.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 'member' or 'invited'. An invitation is a row, not a message. */
    state: text('state').notNull().default('member'),
    joinedAt: integer('joined_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fleetId, table.accountId] }),
    index('fleet_members_account').on(table.accountId),
  ],
);

/**
 * An offer from one captain to another, alongside at the same berth.
 *
 * One-sided with a price: "this cargo, this draught, for these marks". A
 * swap is two offers, which costs a second click and saves the whole
 * apparatus of a two-sided negotiation that nobody was asking for. The row
 * is the offer; accepting it applies both halves in one transaction and
 * closes it.
 */
export const trades = sqliteTable(
  'trades',
  {
    id: text('id').primaryKey(),
    fromId: text('from_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Where it was made. Both must still be here when it is taken. */
    portId: text('port_id').notNull(),
    /** 'offered', 'accepted', 'declined', 'withdrawn' or 'lapsed'. */
    state: text('state').notNull().default('offered'),
    /** What the receiving captain pays. Negative is the offerer paying. */
    marks: integer('marks').notNull().default(0),
    /** `[{ commodityId, units }]`, moving from the offerer to the receiver. */
    cargo: text('cargo').notNull().default('[]'),
    designId: text('design_id').notNull().default(''),
    designName: text('design_name').notNull().default(''),
    offeredAt: integer('offered_at').notNull(),
    closedAt: integer('closed_at').notNull().default(0),
  },
  (table) => [
    index('trades_to').on(table.toId, table.state),
    index('trades_from').on(table.fromId, table.state),
  ],
);

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const CURRENT_SCHEMA_VERSION = 13;

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
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS listings (
        ticker TEXT PRIMARY KEY,
        pool_shares INTEGER NOT NULL,
        pool_marks INTEGER NOT NULL,
        smoothed_earnings REAL NOT NULL,
        period_earnings REAL NOT NULL DEFAULT 0,
        undistributed REAL NOT NULL DEFAULT 0,
        previous_price REAL NOT NULL,
        history TEXT NOT NULL DEFAULT '[]',
        ticks INTEGER NOT NULL DEFAULT 0,
        CHECK (pool_shares > 0),
        CHECK (pool_marks > 0)
      );

      CREATE TABLE IF NOT EXISTS holdings (
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        shares INTEGER NOT NULL DEFAULT 0,
        cost_basis INTEGER NOT NULL DEFAULT 0,
        dividends INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ticker),
        CHECK (shares >= 0),
        CHECK (cost_basis >= 0)
      );
      CREATE INDEX IF NOT EXISTS holdings_ticker ON holdings (ticker);
    `,
  },
  {
    version: 7,
    up: `
      CREATE TABLE IF NOT EXISTS standings (
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        charter TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, charter)
      );
    `,
  },
  {
    version: 8,
    up: `
      ALTER TABLE pilots ADD COLUMN letter TEXT NOT NULL DEFAULT '';
      ALTER TABLE cargo ADD COLUMN prize INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 9,
    up: `
      CREATE TABLE IF NOT EXISTS commissions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        template_id TEXT NOT NULL,
        chain_id TEXT NOT NULL DEFAULT '',
        step INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'taken',
        terms TEXT NOT NULL,
        taken_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL DEFAULT 0,
        settled_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS commissions_account ON commissions (account_id);
    `,
  },
  {
    version: 10,
    up: `
      CREATE TABLE IF NOT EXISTS fleets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        leader_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_members (
        fleet_id TEXT NOT NULL REFERENCES fleets (id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (fleet_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS fleet_members_account ON fleet_members (account_id);
    `,
  },
  {
    version: 11,
    up: `
      ALTER TABLE commissions ADD COLUMN shared_fleet_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE commissions ADD COLUMN settled_by TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS commissions_shared ON commissions (shared_fleet_id);

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        port_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'offered',
        marks INTEGER NOT NULL DEFAULT 0,
        cargo TEXT NOT NULL DEFAULT '[]',
        design_id TEXT NOT NULL DEFAULT '',
        design_name TEXT NOT NULL DEFAULT '',
        offered_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS trades_to ON trades (to_id, state);
      CREATE INDEX IF NOT EXISTS trades_from ON trades (from_id, state);
    `,
  },
  {
    version: 12,
    up: `
      ALTER TABLE pilots ADD COLUMN last_port_id TEXT NOT NULL DEFAULT '';

      -- Anybody alongside right now has their berth recorded; everybody else
      -- gets it the next time they land, which is before they can be written
      -- off there anyway.
      UPDATE pilots SET last_port_id = landed_port_id WHERE landed_port_id IS NOT NULL;
    `,
  },
  {
    version: 13,
    up: `
      -- A holding may now be less than nothing: a captain who sells shares
      -- they do not have owes them. SQLite cannot drop a CHECK, so the table
      -- is rebuilt without the one that said a position is always long.
      -- \`cost_basis\` keeps its check: for a short it is what the sale
      -- brought in, which is still a positive number of marks.
      CREATE TABLE holdings_signed (
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        shares INTEGER NOT NULL DEFAULT 0,
        cost_basis INTEGER NOT NULL DEFAULT 0,
        dividends INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, ticker),
        CHECK (cost_basis >= 0)
      );
      INSERT INTO holdings_signed (account_id, ticker, shares, cost_basis, dividends)
        SELECT account_id, ticker, shares, cost_basis, dividends FROM holdings;
      DROP TABLE holdings;
      ALTER TABLE holdings_signed RENAME TO holdings;
      CREATE INDEX IF NOT EXISTS holdings_ticker ON holdings (ticker);

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        shares INTEGER NOT NULL,
        filled INTEGER NOT NULL DEFAULT 0,
        settled INTEGER NOT NULL DEFAULT 0,
        limit_hundredths INTEGER NOT NULL,
        short INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'open',
        reason TEXT NOT NULL DEFAULT '',
        placed_at INTEGER NOT NULL,
        closed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS orders_open ON orders (state, ticker);
      CREATE INDEX IF NOT EXISTS orders_account ON orders (account_id, state);
    `,
  },
];
