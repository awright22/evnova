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
function berth(portId: string): { systemId: string; x: number; y: number } {
  for (const system of content().systems.values()) {
    const port = system.ports.find((candidate) => candidate.id === portId);
    if (port) return { systemId: system.id, x: port.x, y: port.y };
  }
  throw new Error(`no berth called "${portId}"`);
}

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

  const tokens: Record<string, string> = {};
  const now = Date.now();

  for (const spec of specs) {
    const opened = accounts.signUp({ callsign: spec.callsign, inviteCode: '' });
    tokens[opened.account.callsign] = opened.deviceToken;
    const accountId = opened.account.id;

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
      // it and the landing prompt reads the way it does in play.
      pilot.x = where.x + 90;
      pilot.y = where.y + 60;
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
