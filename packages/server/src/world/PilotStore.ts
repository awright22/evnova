/**
 * Captains, in memory and on disk.
 *
 * A pilot row is the truth about a captain between sessions: where their hull
 * is, what it is flying, what it is carrying and what it owes. Rooms read and
 * write through here, so a captain who jumps between systems keeps their
 * damage, their ammunition and their marks.
 *
 * Position and hull damage change constantly, so they are flushed on a timer
 * and at shutdown — the spec allows losing a few seconds of position. Marks
 * and anything else economic are written in the transaction that changes
 * them, never on a timer.
 */

import { eq } from 'drizzle-orm';

import { schema, type Store } from '../db/index.ts';

/** A captain as the simulation sees them. */
export interface Pilot {
  readonly accountId: string;
  readonly callsign: string;
  marks: number;
  systemId: string;
  x: number;
  y: number;
  angle: number;
  /** Set while landed, which takes the hull out of the simulation. */
  landedPortId: string | undefined;
  /**
   * The last berth this captain was alongside, kept after launching.
   *
   * Where they wake if their hull is written off. Empty for a captain who
   * has never landed anywhere, who wakes where they started.
   */
  lastPortId: string;
  blueprintId: string;
  moduleHp: number[];
  shield: number;
  ammo: number;
  propellant: number;
  licence: string;
  /** The charter whose letter of marque this captain holds, or empty. */
  letter: string;
  /** Owed to the Prize Court. Non-zero means posted. */
  composition: number;
  /** The captain's two colours, "#rrggbb #rrggbb", or empty for the yard's. */
  paint: string;
}

export class PilotStore {
  /** Captains currently loaded, by account id. */
  private readonly loaded = new Map<string, Pilot>();
  private readonly dirty = new Set<string>();

  constructor(private readonly store: Store) {}

  /** Load a captain, or return the copy already in memory. */
  load(accountId: string): Pilot | undefined {
    const cached = this.loaded.get(accountId);
    if (cached) return cached;

    const row = this.store.db
      .select({
        pilot: schema.pilots,
        callsign: schema.accounts.callsign,
      })
      .from(schema.pilots)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.pilots.accountId))
      .where(eq(schema.pilots.accountId, accountId))
      .get();

    if (!row) return undefined;

    const pilot: Pilot = {
      accountId,
      callsign: row.callsign,
      marks: row.pilot.marks,
      systemId: row.pilot.systemId,
      x: row.pilot.x,
      y: row.pilot.y,
      angle: row.pilot.angleMrad / 1000,
      landedPortId: row.pilot.landedPortId ?? undefined,
      lastPortId: row.pilot.lastPortId,
      blueprintId: row.pilot.blueprintId,
      moduleHp: parseHp(row.pilot.moduleHp),
      shield: row.pilot.shield,
      ammo: row.pilot.ammo,
      propellant: row.pilot.propellant,
      licence: row.pilot.licence,
      letter: row.pilot.letter,
      composition: row.pilot.composition,
      paint: row.pilot.paint,
    };

    this.loaded.set(accountId, pilot);
    return pilot;
  }

  /**
   * The in-memory copy, if this captain is loaded, without loading them.
   *
   * For code that has to keep a loaded captain in step after writing their
   * row — the ledger — but must not pull every offline captain it touches
   * into memory to do it.
   */
  cached(accountId: string): Pilot | undefined {
    return this.loaded.get(accountId);
  }

  /** Mark a captain as changed, so the next flush writes them. */
  touch(accountId: string): void {
    this.dirty.add(accountId);
  }

  get online(): number {
    return this.loaded.size;
  }

  /** Every loaded captain, for the Register and for chat. */
  all(): Iterable<Pilot> {
    return this.loaded.values();
  }

  /**
   * Every captain on the books, online or not.
   *
   * For the leaderboard, which would be a strange board if it only listed
   * whoever happened to be flying. Read straight from the database and
   * overlaid with the in-memory marks of anyone currently loaded, because a
   * captain who has been spending this minute has not been flushed yet.
   */
  everyone(): { accountId: string; callsign: string; marks: number }[] {
    const rows = this.store.db
      .select({
        accountId: schema.accounts.id,
        callsign: schema.accounts.callsign,
        marks: schema.pilots.marks,
      })
      .from(schema.accounts)
      .innerJoin(schema.pilots, eq(schema.pilots.accountId, schema.accounts.id))
      .all();

    return rows.map((row) => ({
      ...row,
      marks: this.loaded.get(row.accountId)?.marks ?? row.marks,
    }));
  }

  /**
   * Write every changed captain.
   *
   * One transaction for the batch: a flush either lands or it does not, so a
   * crash mid-write cannot leave one captain saved and another half-saved.
   */
  flush(): number {
    if (this.dirty.size === 0) return 0;

    const toWrite = [...this.dirty]
      .map((id) => this.loaded.get(id))
      .filter((pilot): pilot is Pilot => pilot !== undefined);

    this.dirty.clear();
    if (toWrite.length === 0) return 0;

    const now = Date.now();
    this.store.transaction(() => {
      for (const pilot of toWrite) {
        this.store.db
          .update(schema.pilots)
          .set({
            // Marks are deliberately not written here. Every mark a captain
            // gains or loses goes through the ledger, which writes the row
            // itself and updates this copy when it has one. A dividend or a
            // liquidation settled for a captain who happens to be online
            // touches the row and not the copy — and a flush that wrote this
            // copy's figure back would quietly erase it.
            systemId: pilot.systemId,
            x: Math.round(pilot.x),
            y: Math.round(pilot.y),
            angleMrad: Math.round(pilot.angle * 1000),
            landedPortId: pilot.landedPortId ?? null,
            lastPortId: pilot.lastPortId,
            blueprintId: pilot.blueprintId,
            moduleHp: JSON.stringify(pilot.moduleHp.map((hp) => Math.max(0, Math.round(hp)))),
            shield: Math.max(0, Math.round(pilot.shield)),
            ammo: Math.max(0, Math.round(pilot.ammo)),
            propellant: Math.max(0, Math.round(pilot.propellant)),
            licence: pilot.licence,
            letter: pilot.letter,
            composition: Math.max(0, Math.round(pilot.composition)),
            paint: pilot.paint,
            updatedAt: now,
          })
          .where(eq(schema.pilots.accountId, pilot.accountId))
          .run();
      }
    });

    return toWrite.length;
  }

  /**
   * Drop a captain from memory, writing them first.
   *
   * Called when their grace window expires, not when they disconnect: a
   * captain who reconnects inside the window resumes the hull they left.
   */
  release(accountId: string): void {
    this.dirty.add(accountId);
    this.flush();
    this.loaded.delete(accountId);
  }
}

/** Hull damage is stored as JSON. A corrupt value means an intact hull. */
function parseHp(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === 'number' && value >= 0);
  } catch {
    return [];
  }
}
