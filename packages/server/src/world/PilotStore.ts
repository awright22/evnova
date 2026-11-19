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
  blueprintId: string;
  moduleHp: number[];
  shield: number;
  ammo: number;
  propellant: number;
  licence: string;
  /** Owed to the Prize Court. Non-zero means posted. */
  composition: number;
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
      blueprintId: row.pilot.blueprintId,
      moduleHp: parseHp(row.pilot.moduleHp),
      shield: row.pilot.shield,
      ammo: row.pilot.ammo,
      propellant: row.pilot.propellant,
      licence: row.pilot.licence,
      composition: row.pilot.composition,
    };

    this.loaded.set(accountId, pilot);
    return pilot;
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
            marks: Math.max(0, Math.round(pilot.marks)),
            systemId: pilot.systemId,
            x: Math.round(pilot.x),
            y: Math.round(pilot.y),
            angleMrad: Math.round(pilot.angle * 1000),
            landedPortId: pilot.landedPortId ?? null,
            blueprintId: pilot.blueprintId,
            moduleHp: JSON.stringify(pilot.moduleHp.map((hp) => Math.max(0, Math.round(hp)))),
            shield: Math.max(0, Math.round(pilot.shield)),
            ammo: Math.max(0, Math.round(pilot.ammo)),
            propellant: Math.max(0, Math.round(pilot.propellant)),
            licence: pilot.licence,
            composition: Math.max(0, Math.round(pilot.composition)),
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
