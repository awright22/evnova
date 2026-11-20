/**
 * M8's check for the range: a draught flown and fought before it is bought.
 *
 * The whole point of a range is that nothing on it is real, so that is what
 * this measures. A captain's marks, cargo, hull, standing, composition and
 * position are read before they go out, and read again after they come back
 * from a fight they lost — and every figure has to be the one they left with.
 *
 *   pnpm verify:range
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  content,
  isAimedAt,
  placeAll,
  turnToward,
  type Placement,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fly, profileOf } from './control.ts';
import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2599;
const SYSTEM = 'parity';
const BERTH = 'the-bourse';

/** The draught taken out on the range: armed, so there is a fight in it. */
const UNDER_TEST = 'force-majeure';
/** And what is put up against it after the first pass. */
const OTHER_SPAR = 'fair-wear-and-tear';

const CARGO = { ice: 9 };

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

interface Purse {
  marks: number;
  draught: string;
  composition: number;
  landedPort: string;
  system: string;
}

interface Captain {
  readonly room: Room<unknown, SystemState>;
  purse: Purse | undefined;
  market: { listings: { commodityId: string; carried: number }[] } | undefined;
  moorings: { ships: { name: string }[] } | undefined;
  range: { flying: string; against: string; problems: string[] } | undefined;
}

function listen(room: Room<unknown, SystemState>): Captain {
  const captain: Captain = {
    room,
    purse: undefined,
    market: undefined,
    moorings: undefined,
    range: undefined,
  };
  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('purse', (payload) => (captain.purse = payload as Purse));
  room.onMessage(
    'market',
    (payload) =>
      (captain.market = payload as { listings: { commodityId: string; carried: number }[] }),
  );
  room.onMessage('yard', (payload) => (captain.moorings = payload as { ships: { name: string }[] }));
  room.onMessage(
    'range',
    (payload) => (captain.range = payload as { flying: string; against: string; problems: string[] }),
  );
  return captain;
}

async function refusal(sent: Promise<unknown>): Promise<string> {
  try {
    await sent;
    return '';
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'unknown';
  }
}

/** Wait for a condition, or give up. */
async function until(holds: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holds()) return true;
    await sleep(60);
  }
  return holds();
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-range-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '50000',
  };

  const tokens = await runSeed(
    [
      {
        callsign: 'Trials',
        at: BERTH,
        flying: 'prudent-return',
        cargo: CARGO,
        standing: { kessler: 40 },
      },
    ],
    worldEnv,
  );
  const token = tokens['Trials']!;

  const server = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: { ...process.env, ...worldEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  server.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (log += d.toString()));

  try {
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`server exited early:\n${log}`);
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`server never became healthy:\n${log}`);
      await sleep(300);
    }

    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);

    // --- What the captain has before they go out -------------------------

    const before = listen(
      await sdk.joinOrCreate<SystemState>(
        'system',
        { deviceToken: token, systemId: SYSTEM },
        SystemState,
      ),
    );
    await sleep(600);
    await refusal(before.room.request('land', { port: BERTH }));
    await sleep(3000);

    const marksBefore = before.purse?.marks ?? 0;
    const draughtBefore = before.purse?.draught ?? '';
    const cargoBefore =
      before.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? -1;
    const hullsBefore = before.moorings?.ships.length ?? -1;

    record(
      'a captain at a Yard has marks, cargo and a hull of their own',
      marksBefore > 0 && cargoBefore === CARGO.ice && draughtBefore !== '',
      `${marksBefore} marks, ${cargoBefore} units of Ice, flying ${draughtBefore}, ` +
        `${hullsBefore} hull(s) on the books`,
    );

    await before.room.leave();
    await sleep(400);

    // --- Out on the range -------------------------------------------------

    const { blueprints, modules } = content();
    const design: Placement[] = [...blueprints.get(UNDER_TEST)!.placements];

    const range = listen(
      await sdk.create<SystemState>(
        'range',
        { deviceToken: token, systemId: SYSTEM, placements: design },
        SystemState,
      ),
    );
    await sleep(1500);

    record(
      'a draught can be taken out without being paid for',
      range.range !== undefined && range.range.problems.length === 0,
      range.range
        ? `flying as ${range.range.flying} against ${range.range.against}`
        : 'the range said nothing',
    );

    const mine = range.room.state.ships.get(range.room.sessionId);
    record(
      'and it is in the sky, built as drawn',
      mine !== undefined && mine.moduleHp.length === placeAll(design, modules).length,
      mine
        ? `${mine.moduleHp.length} fittings against ${placeAll(design, modules).length} drawn`
        : 'nothing there',
    );

    const spars = [...range.room.state.ships].filter(([id]) => id !== range.room.sessionId);
    record(
      'with something up against it',
      spars.length > 0 && spars.every(([, ship]) => ship.hostile),
      `${spars.length} sparring hull(s): ${spars.map(([, s]) => s.callsign).join(', ')}`,
    );

    // --- A fight ----------------------------------------------------------

    const profile = profileOf(range.room);
    const flying = profile ? fly(range.room, profile) : undefined;
    if (!flying || !profile) throw new Error('could not take the controls on the range');

    const markId = spars[0]![0];
    await refusal(range.room.request('target', { id: markId }));

    const hpOf = (id: string): number => {
      const ship = range.room.state.ships.get(id);
      return ship ? [...ship.moduleHp].reduce((sum, hp) => sum + hp, 0) : 0;
    };
    const markBefore = hpOf(markId);

    const until2 = Date.now() + 60_000;
    let hurt = 0;
    while (Date.now() < until2) {
      const me = range.room.state.ships.get(range.room.sessionId);
      const mark = range.room.state.ships.get(markId);
      if (!me) break;
      if (!mark || mark.destroyedAt > 0) {
        hurt = markBefore;
        break;
      }

      const bearing = Math.atan2(mark.y - me.y, mark.x - me.x);
      const reach = Math.hypot(mark.x - me.x, mark.y - me.y);
      flying.input.data.turn = turnToward(me, bearing, profile);
      flying.input.data.thrust = reach > 700 && isAimedAt(me, bearing, 0.4) ? 1 : 0;
      flying.input.data.brake = reach < 400;
      flying.input.data.firePrimary = isAimedAt(me, bearing, 0.08);
      flying.input.data.fireSecondary = false;
      flying.commit();

      hurt = Math.max(hurt, markBefore - hpOf(markId));
      if (hurt > 0 && me.destroyedAt > 0) break;
      await sleep(16);
    }

    record(
      'a captain can fight in it, and what they hit is hurt by it',
      hurt > 0,
      `${hurt} points off a sparring hull`,
    );

    // --- Losing it ---------------------------------------------------------

    // Hands off. Two armed hulls against one, and whatever happens out here
    // costs nothing — which is the thing worth proving.
    flying.input.data.firePrimary = false;
    flying.input.data.thrust = 0;
    flying.input.data.turn = 0;
    flying.commit();

    // Say what is happening to the hull while this waits.
    //
    // "Survived, which this check needed it not to" does not distinguish a
    // hull that is too tough from sparring partners that never close, and
    // the difference is the difference between a balance finding and a
    // broken fixture.
    const own = (): { shield: number; hp: number } => {
      const ship = range.room.state.ships.get(range.room.sessionId);
      let hp = 0;
      for (const point of ship?.moduleHp ?? []) hp += point;
      return { shield: ship?.shield ?? 0, hp };
    };
    const opened = own();
    let said = Date.now();
    const lost = await until(() => {
      if (Date.now() - said > 20_000) {
        said = Date.now();
        const now = own();
        const me = range.room.state.ships.get(range.room.sessionId);
        const spars = [...range.room.state.ships]
          .filter(([id]) => id !== range.room.sessionId)
          .map(([, ship]) => {
            let hp = 0;
            for (const point of ship.moduleHp) hp += point;
            const away = Math.round(Math.hypot(ship.x - (me?.x ?? 0), ship.y - (me?.y ?? 0)));
            const gone = ship.destroyedAt > 0 ? ' WRECK' : '';
            return `${away}u hp ${hp} shield ${Math.round(ship.shield)}${gone}`;
          });
        console.log(
          `    [range] shield ${Math.round(now.shield)}, structure ${now.hp} ` +
            `(opened at ${Math.round(opened.shield)}/${opened.hp}), ` +
            `rounds ${range.room.state.projectiles?.size ?? -1}; ` +
            `spars: ${spars.join(' | ')}`,
        );
      }
      return (range.room.state.ships.get(range.room.sessionId)?.destroyedAt ?? 0) > 0;
    }, 90_000);
    const ended = own();
    record(
      'the hull can be lost out there',
      lost,
      lost
        ? 'written off on the range'
        : `survived: shield ${Math.round(opened.shield)} to ${Math.round(ended.shield)}, ` +
          `structure ${opened.hp} to ${ended.hp} over 90s`,
    );

    const mended = await until(() => {
      const ship = range.room.state.ships.get(range.room.sessionId);
      return ship !== undefined && ship.destroyedAt === 0;
    }, 20_000);
    record(
      'and the range hands back a sound hull rather than a claim',
      mended,
      mended ? 'flying again' : 'never came back',
    );

    // --- Changing the opposition -------------------------------------------

    const swapped = await refusal(range.room.request('spar', { against: OTHER_SPAR }));
    await sleep(800);
    const now = [...range.room.state.ships].filter(([id]) => id !== range.room.sessionId);
    record(
      'and something else can be put up against it',
      swapped === '' &&
        now.length > 0 &&
        now.every(([, ship]) => ship.callsign === blueprints.get(OTHER_SPAR)?.name),
      swapped === ''
        ? `${now.length} × ${now[0]?.[1].callsign ?? 'nothing'}`
        : `refused: ${swapped}`,
    );

    record(
      'and a draught the Register does not list is refused',
      (await refusal(range.room.request('spar', { against: 'no-such-draught' }))) ===
        'unknown-draught',
      'a draught id nobody has heard of',
    );

    await range.room.leave();
    await sleep(600);

    // --- A grid the warrant will not carry ---------------------------------

    // Twenty of one fitting, which no Open Ticket covers. The range checks a
    // design exactly as the counter does, so a captain finds out here rather
    // than in the sky.
    const overlarge: Placement[] = Array.from({ length: 20 }, (_, i) => ({
      moduleId: 'slp-armour-1',
      x: i * 2,
      y: 0,
      rotation: 0 as const,
    }));
    const refusedRange = listen(
      await sdk.create<SystemState>(
        'range',
        { deviceToken: token, systemId: SYSTEM, placements: overlarge },
        SystemState,
      ),
    );
    await sleep(1200);
    record(
      'a grid the warrant will not carry never leaves the ground',
      (refusedRange.range?.problems.length ?? 0) > 0 &&
        refusedRange.room.state.ships.size === 0,
      `${refusedRange.range?.problems.length ?? 0} problem(s), ` +
        `${refusedRange.room.state.ships.size} hull(s) in the sky`,
    );
    await refusedRange.room.leave();
    await sleep(600);

    // --- Back, with everything they left with -------------------------------

    const after = listen(
      await sdk.joinOrCreate<SystemState>(
        'system',
        { deviceToken: token, systemId: SYSTEM },
        SystemState,
      ),
    );
    await sleep(3500);

    record(
      'the captain comes back to the berth they left',
      after.purse?.landedPort === BERTH && after.purse?.system === SYSTEM,
      `alongside ${after.purse?.landedPort ?? 'nothing'} in ${after.purse?.system ?? 'nowhere'}`,
    );

    record(
      'with the marks they left with, to the mark',
      after.purse?.marks === marksBefore,
      `${marksBefore} before, ${after.purse?.marks ?? -1} after`,
    );

    record(
      'and the hull they left in',
      after.purse?.draught === draughtBefore &&
        (after.moorings?.ships.length ?? -1) === hullsBefore,
      `${after.purse?.draught ?? 'nothing'} against ${draughtBefore}, ` +
        `${after.moorings?.ships.length ?? -1} hull(s) against ${hullsBefore}`,
    );

    record(
      'and the cargo still in its bays',
      (after.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? -1) ===
        cargoBefore,
      `${after.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? -1} units ` +
        `against ${cargoBefore}`,
    );

    record(
      'and nothing to answer to the Prize Court for',
      (after.purse?.composition ?? -1) === 0,
      `a composition of ${after.purse?.composition ?? -1} marks`,
    );

    await after.room.leave();
  } catch (error) {
    record(
      'the run finished without throwing',
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await stopGroup(server, { timeoutMs: 5000 });
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.passed);
  console.log('\n=== M8: the range ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
