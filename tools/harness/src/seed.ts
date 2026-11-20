/**
 * Captains with a history, for the capture session.
 *
 * Some screens only exist for a captain who has already done something: a
 * chain's last choice is not posted to anybody who has not run six beats of
 * it, and no reasonable amount of flying inside a screenshot run will get
 * there. So this writes those captains before the server starts, using the
 * server's own services rather than raw SQL — a seeded world that the real
 * code would also have produced, and nothing in the game has to know that
 * the capture harness exists.
 *
 * It runs as its own process, with the same environment the game server is
 * given, so `config` reads the same values it will read in a moment. It
 * prints one JSON object on stdout: callsign to device token, which the
 * harness puts in the browser's storage so the client joins as that captain
 * instead of opening a new account.
 *
 *   tsx tools/harness/src/seed.ts '[{"callsign":"Audit","chainDone":"daughters-audit"}]'
 *
 * `runSeed` below is the way to call it: a process of its own, with the
 * environment the server will be given, because `config` is read once at
 * import and a harness cannot change its own after it has imported anything.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { spawnGroup } from './index.ts';

import { CHARTERS, beltOf, content, placeAll, type Charter } from '@marque/shared';

import { Accounts } from '@marque/server/src/accounts.ts';
import { openStore, schema } from '@marque/server/src/db/index.ts';
import { Convoys } from '@marque/server/src/world/Convoys.ts';
import { Exchange } from '@marque/server/src/world/Exchange.ts';
import { Ledger } from '@marque/server/src/world/Ledger.ts';
import { Market } from '@marque/server/src/world/Market.ts';
import { PilotStore } from '@marque/server/src/world/PilotStore.ts';
import { Standings } from '@marque/server/src/world/Standings.ts';
import { Yard } from '@marque/server/src/world/Yard.ts';

/** This file, for running it as a script. */
const HERE = fileURLToPath(import.meta.url);

/** A captain to write, and what they should already have behind them. */
export interface SeedSpec {
  readonly callsign: string;
  /**
   * Set the purse to exactly this, through the ledger.
   *
   * For checks where the size of a captain's purse is the subject — margin,
   * affordability — and the server's one starting figure cannot give two
   * captains different ones.
   */
  readonly marks?: number;
  /**
   * Marks owed to the Prize Court, which posts them.
   *
   * For a check or a capture whose subject is what happens to a posted
   * captain: patrols answer for them from the first instant, rather than
   * the harness having to earn it by shooting something first.
   */
  readonly composition?: number;
  /** Standing with each charter. Applied directly, not through a shift. */
  readonly standing?: Partial<Record<Charter, number>>;
  /** Park them at this berth's coordinates, so landing lands here. */
  readonly at?: string;
  /**
   * Park them beside a rock in this system's belt instead.
   *
   * A belt is thousands of units off the berths, which is the point of it
   * and also four minutes of a screenshot run. A capture of a belt is of
   * the belt, not of the journey.
   */
  readonly atBelt?: string;
  /** Mark every beat of this chain answered, so its ending is waiting. */
  readonly chainDone?: string;
  /** Goods in the hold, by commodity id. */
  readonly cargo?: Record<string, number>;
  /**
   * Shares to hold, by ticker.
   *
   * Bought through the Exchange rather than written into the holdings
   * table, so the pools, the ledger and the captain's purse are the ones
   * those shares would really have left behind. A late-game session needs
   * a portfolio, and a portfolio that does not add up is not one.
   */
  readonly holdings?: Record<string, number>;
  /** Draughts on this captain's books, by name. */
  readonly designs?: readonly string[];
  /**
   * A hull built and taken out, by catalogue draught id.
   *
   * For a check whose subject is not building: a harness that has to earn
   * its way into the right hull spends its run on the Yard and the Moorings
   * and then has three minutes left for the thing it is named after.
   */
  readonly flying?: string;
  /**
   * Take the flown hull's engines out before anybody connects.
   *
   * For a check whose subject is what happens to a hull that cannot run.
   * How one comes to be in that state is combat's business and is tested
   * where the damage lands.
   */
  readonly crippled?: boolean;
  /**
   * The berth this captain last landed at, which is where they wake.
   *
   * Written straight to the row. Landing is proved by its own harnesses; a
   * check about what happens after a loss should not have to fly across a
   * system first to establish where home is.
   */
  readonly lastBerth?: string;
  /** Hulls already on this captain's books, parked at a berth. */
  readonly parked?: readonly { readonly draught: string; readonly at: string }[];
  /**
   * Callsigns to open a convoy with, this captain leading.
   *
   * They must be seeded too, and earlier in the list: a convoy is a row
   * about two captains and both have to exist.
   */
  readonly convoyWith?: readonly string[];
  /** Callsigns this captain has asked, who have not answered. */
  readonly convoyAsked?: readonly string[];
}

/** Where a berth is, and which system it is in. */
function berth(portId: string): { id: string; systemId: string; x: number; y: number } {
  for (const system of content().systems.values()) {
    const port = system.ports.find((candidate) => candidate.id === portId);
    if (port) return { id: port.id, systemId: system.id, x: port.x, y: port.y };
  }
  throw new Error(`no berth called "${portId}"`);
}

/**
 * How far apart two captains seeded at one berth stand.
 *
 * Close enough that a party can be put across from one to the other without
 * flying anywhere — boarding reaches a hundred and fifty units — and far
 * enough that they are two hulls rather than one point.
 */
const SPACING = 70;

export function seed(databaseUrl: string, specs: readonly SeedSpec[]): Record<string, string> {
  const store = openStore(databaseUrl);
  const accounts = new Accounts(store);
  const pilots = new PilotStore(store);
  const standings = new Standings(store);
  const convoys = new Convoys(store);
  // The game's own services, so a seeded world is one the real code would
  // also have produced rather than a set of rows that happen to look right.
  const ledger = new Ledger(store);
  const market = new Market(store, ledger);
  const yard = new Yard(store, ledger, market);
  const exchange = new Exchange(store, ledger);

  const tokens: Record<string, string> = {};
  /** How many captains have already been set down at each berth. */
  const atBerth = new Map<string, number>();
  const now = Date.now();

  for (const spec of specs) {
    const opened = accounts.signUp({ callsign: spec.callsign, inviteCode: '' });
    tokens[opened.account.callsign] = opened.deviceToken;
    const accountId = opened.account.id;

    if (spec.marks !== undefined) {
      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      const delta = Math.round(spec.marks) - pilot.marks;
      if (delta !== 0) {
        ledger.post(
          {
            accountId,
            delta,
            category: delta > 0 ? 'starting-balance' : 'trade-fee',
            reason: 'Seeded purse',
          },
          pilot,
        );
      }
    }

    if (spec.composition !== undefined) {
      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      pilot.composition = Math.max(0, Math.round(spec.composition));
      pilots.touch(accountId);
      pilots.flush();
    }

    if (spec.standing) {
      // Written as a set rather than shifted: a shift is zero-sum, and a
      // seeded captain is a starting condition, not a career.
      store.transaction(() => {
        for (const charter of CHARTERS) {
          const value = spec.standing?.[charter];
          if (value === undefined) continue;
          store.db
            .insert(schema.standings)
            .values({ accountId, charter, value, updatedAt: now })
            .onConflictDoUpdate({
              target: [schema.standings.accountId, schema.standings.charter],
              set: { value, updatedAt: now },
            })
            .run();
        }
      });
      void standings.of(accountId);
    }

    if (spec.at !== undefined) {
      const where = berth(spec.at);
      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      pilot.systemId = where.systemId;
      // A little off the berth, so the hull is alongside rather than inside
      // it and the landing prompt reads the way it does in play — and spaced
      // around it, because two captains seeded at one berth used to be at
      // exactly the same point, where a gun has no line to draw and a round
      // spawns inside what it was fired at.
      const nth = atBerth.get(where.id) ?? 0;
      atBerth.set(where.id, nth + 1);
      const around = nth * ((Math.PI * 2) / 5);
      pilot.x = where.x + 90 + Math.cos(around) * SPACING * nth;
      pilot.y = where.y + 60 + Math.sin(around) * SPACING * nth;
      pilots.touch(accountId);
      pilots.flush();
    }

    if (spec.atBelt !== undefined) {
      const system = content().systems.get(spec.atBelt);
      if (!system) throw new Error(`no system called "${spec.atBelt}"`);
      const rocks = beltOf(system);
      const rock = rocks[0];
      if (!rock) throw new Error(`${spec.atBelt} has no belt`);

      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      pilot.systemId = system.id;
      // Just outside the rock, pointed at it: within a rig's reach and
      // clear of the rock itself.
      const bearing = Math.atan2(rock.y, rock.x);
      pilot.x = rock.x + Math.cos(bearing) * (rock.radius + 150);
      pilot.y = rock.y + Math.sin(bearing) * (rock.radius + 150);
      pilot.angle = bearing + Math.PI;
      pilots.touch(accountId);
      pilots.flush();
    }

    for (const [commodityId, units] of Object.entries(spec.cargo ?? {})) {
      market.adjustCargo(accountId, commodityId, units);
    }

    for (const [ticker, shares] of Object.entries(spec.holdings ?? {})) {
      if (shares < 1) continue;
      // The Bourse lists its companies when the world opens, and the world
      // has not opened yet: this is a database with a schema and nothing
      // in it. Listing them is idempotent, so asking twice costs nothing.
      exchange.seed();
      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      // A parcel at a time, because the Exchange caps how much of a pool
      // one order may take — the same cap a captain trades against.
      let left = Math.round(shares);
      let tries = 0;
      while (left > 0 && tries < 40) {
        tries += 1;
        const parcel = Math.min(left, Math.max(1, Math.ceil(shares / 8)));
        let fill;
        try {
          fill = exchange.trade({ pilot, side: 'buy', ticker, shares: parcel });
        } catch (error) {
          // The Bourse refuses what a captain would be refused: no captain
          // may hold more than a tenth of a float, and the pool will not
          // sell more than a quarter of itself at once. A seed that asks
          // for too much gets what the market would actually have given it
          // and says so, rather than failing the whole run.
          const why = (error as { reason?: string }).reason ?? String(error);
          console.warn(
            `  ${spec.callsign}: the Bourse stopped at ${Math.round(shares) - left} `
              + `of ${Math.round(shares)} ${ticker} (${why})`,
          );
          break;
        }
        if (fill.shares < 1) break;
        left -= fill.shares;
      }
      pilots.touch(accountId);
      pilots.flush();
    }

    for (const name of spec.designs ?? []) {
      // A plain hull: the capture is of a list of names, not of a grid.
      yard.saveDesign(accountId, { name, placements: [] }, now);
    }

    if (spec.flying !== undefined) {
      const draught = content().blueprints.get(spec.flying);
      if (!draught) throw new Error(`no draught called "${spec.flying}"`);

      // Written straight in rather than built: the Yard's bill, its stock
      // and its materials are another check's subject, and paying them here
      // would make this one depend on them.
      store.db
        .insert(schema.ships)
        .values({
          id: randomUUID(),
          accountId,
          name: draught.name,
          placements: JSON.stringify(draught.placements),
          // No berth: a hull with nowhere written on it is the one being flown.
          portId: null,
          systemId: pilots.load(accountId)?.systemId ?? '',
          moduleHp: JSON.stringify(
            placeAll(draught.placements, content().modules).map((module) =>
              spec.crippled === true && module.def.type === 'engine' ? 0 : module.def.hitPoints,
            ),
          ),
          builtAt: now,
        })
        .run();
    }

    if (spec.lastBerth !== undefined) {
      const where = berth(spec.lastBerth);
      const pilot = pilots.load(accountId);
      if (!pilot) throw new Error(`${spec.callsign} has no captain`);
      pilot.lastPortId = where.id;
      pilots.touch(accountId);
      pilots.flush();
    }

    for (const hull of spec.parked ?? []) {
      const draught = content().blueprints.get(hull.draught);
      if (!draught) throw new Error(`no draught called "${hull.draught}"`);
      const where = berth(hull.at);
      store.db
        .insert(schema.ships)
        .values({
          id: randomUUID(),
          accountId,
          name: draught.name,
          placements: JSON.stringify(draught.placements),
          portId: where.id,
          systemId: where.systemId,
          moduleHp: JSON.stringify(
            placeAll(draught.placements, content().modules).map((module) => module.def.hitPoints),
          ),
          builtAt: now,
        })
        .run();
    }

    const toAsk = [...(spec.convoyWith ?? []), ...(spec.convoyAsked ?? [])];
    if (toAsk.length > 0) {
      // The invitation itself names them, and the view it returns carries
      // their account id, so there is nothing to look up.
      let convoyId = '';
      for (const callsign of toAsk) {
        convoyId = convoys.invite(accountId, callsign, now).id;
      }
      for (const callsign of spec.convoyWith ?? []) {
        const them = convoys
          .view(convoyId)
          .members.find(
            (member) => member.callsign.toLowerCase() === callsign.trim().toLowerCase(),
          );
        if (!them) throw new Error(`no captain called "${callsign}"`);
        convoys.accept(them.accountId, convoyId, now);
      }
    }

    if (spec.chainDone !== undefined) {
      const chain = content().commissions.chains.find(
        (candidate) => candidate.id === spec.chainDone,
      );
      if (!chain) throw new Error(`no chain called "${spec.chainDone}"`);

      store.transaction(() => {
        chain.steps.forEach((step, index) => {
          store.db
            .insert(schema.commissions)
            .values({
              id: randomUUID(),
              accountId,
              templateId: chain.id,
              chainId: chain.id,
              step: index,
              kind: step.kind,
              state: 'done',
              terms: JSON.stringify({
                templateId: chain.id,
                kind: step.kind,
                charter: chain.charter,
                title: step.title,
                brief: step.brief,
                pay: step.basePay,
                standing: 0,
                hours: step.hours,
                units: step.units,
                commodityId: step.commodity ?? '',
                fromPortId: '',
                toPortId: step.toPort ?? '',
                toSystemId: step.toSystem ?? '',
                target: '',
              }),
              takenAt: now - (chain.steps.length - index) * 3_600_000,
              dueAt: 0,
              settledAt: now - (chain.steps.length - index - 1) * 3_600_000,
            })
            .run();
        });
      });
    }
  }

  store.close();
  return tokens;
}

/**
 * Seed a world in a process of its own, and return callsign to device token.
 *
 * The environment has to be the one the server will read, so the seeded
 * world is the one the real code would have produced in it.
 */
export async function runSeed(
  specs: readonly SeedSpec[],
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const seeder = spawnGroup('pnpm', ['exec', 'tsx', HERE, JSON.stringify(specs)], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  seeder.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
  seeder.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()));

  const code = await new Promise<number>((done) =>
    seeder.on('exit', (exit) => done(exit ?? 1)),
  );
  if (code !== 0) throw new Error(`seeding failed:\n${out}`);

  // The tokens are the last line; migration notices come out above them.
  const last = out.trim().split('\n').at(-1) ?? '{}';
  try {
    return JSON.parse(last) as Record<string, string>;
  } catch {
    throw new Error(`seeding printed no tokens:\n${out}`);
  }
}

// Run as a script: the specs arrive as one JSON argument, the tokens leave as
// one JSON line, and anything else goes to stderr so stdout stays parseable.
if (process.argv[1]?.endsWith('seed.ts')) {
  const [, , json] = process.argv;
  if (!json) {
    console.error('usage: tsx src/seed.ts \'[{"callsign":"..."}]\'');
    process.exit(2);
  }
  const specs = JSON.parse(json) as SeedSpec[];
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(seed(url, specs))}\n`);
}
