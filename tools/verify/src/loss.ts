/**
 * The check for losing a hull: spec section 8's whole paragraph.
 *
 * "The ship and its cargo are lost. Credits, blueprints, shares and other
 * parked ships are kept. Insurance pays back half the ship's credit cost. The
 * player wakes at the last port they landed at, with a free starter ship if
 * they own nothing else."
 *
 * Every clause of that is about two things agreeing — the hull in the sky and
 * the rows behind it — so none of it can be proved by a unit test alone. One
 * captain shoots two others down: one who owns nothing else, who is given a
 * starter draught, and one with a hull waiting where they wake, who is put
 * into that instead.
 *
 *   pnpm verify:loss
 *
 * `MARQUE_LOSS_TRACE=1` prints the range, the target's structure and the
 * rounds in flight every two seconds, which is how the two reasons a hull
 * would not go down were found: a gun pressed against its mark has no line
 * to draw, and a round that lands on a module already wrecked used to do
 * nothing at all. `MARQUE_LOSS_LIMIT` shortens the time it will spend
 * trying.
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  buildCost,
  content,
  isAimedAt,
  turnToward,
  type ClaimState,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fly, flyTo, profileOf } from './control.ts';
import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2597;

/**
 * Two berths in the Marque.
 *
 * Two, because "wakes at the last berth they landed at" cannot be told apart
 * from "wakes where they were" in a system with only one.
 *
 * The Marque, because law reaching nowhere is what makes the run repeatable:
 * in secured or contested space the first kill posts the captain who made it
 * and patrols come for them, and the run then depends on whether a patrol
 * reaches the gunner before the gunner reaches the second target. Out here
 * nothing is posted, which spec section 11 says in as many words, and that
 * is itself worth checking.
 */
const SYSTEM = 'satos-error';
/** Where they die. */
const AWAY = 'tret';
/** Where they last put in, and so where they wake. */
const HOME = 'manifest';

/** The hull both targets are flying when they lose it. */
const LOST = 'spoil-heap';
/** What one of them has waiting at home. */
const SPARE = 'short-measure';

const CARGO = 12;

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
  readonly callsign: string;
  readonly room: Room<unknown, SystemState>;
  purse: Purse | undefined;
  claim: ClaimState | undefined;
  woke: { id: string; port: string; system: string } | undefined;
  landed: string;
  moorings: { ships: { name: string; portId: string }[]; flyingName: string } | undefined;
  market: { listings: { commodityId: string; carried: number }[] } | undefined;
}

async function connect(
  sdk: ColyseusSDK,
  callsign: string,
  deviceToken: string,
): Promise<Captain> {
  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken, systemId: SYSTEM },
    SystemState,
  );

  const captain: Captain = {
    callsign,
    room,
    purse: undefined,
    claim: undefined,
    woke: undefined,
    landed: '',
    moorings: undefined,
    market: undefined,
  };

  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('purse', (payload) => (captain.purse = payload as Purse));
  room.onMessage('claim', (payload) => (captain.claim = payload as ClaimState));
  room.onMessage(
    'respawned',
    (payload) => (captain.woke = payload as { id: string; port: string; system: string }),
  );
  room.onMessage('landed', (payload) => (captain.landed = (payload as { port: string }).port));
  room.onMessage(
    'yard',
    (payload) =>
      (captain.moorings = payload as {
        ships: { name: string; portId: string }[];
        flyingName: string;
      }),
  );
  room.onMessage(
    'market',
    (payload) =>
      (captain.market = payload as { listings: { commodityId: string; carried: number }[] }),
  );

  return captain;
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-loss-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '20000',
  };

  const tokens = await runSeed(
    [
      // A turret hull, because a turret comes round on its own: an aim gate
      // in a harness checks the harness's steering, not the guns.
      { callsign: 'Reprisal', at: AWAY, flying: 'fair-wear-and-tear' },
      {
        callsign: 'Act of God',
        at: AWAY,
        flying: LOST,
        lastBerth: HOME,
        cargo: { ice: CARGO },
      },
      {
        callsign: 'Prudent Return',
        at: AWAY,
        flying: LOST,
        lastBerth: HOME,
        parked: [{ draught: SPARE, at: HOME }],
      },
    ],
    worldEnv,
  );

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
    const gunner = await connect(sdk, 'Reprisal', tokens['Reprisal']!);
    const alone = await connect(sdk, 'Act of God', tokens['Act of God']!);
    const provident = await connect(sdk, 'Prudent Return', tokens['Prudent Return']!);
    await sleep(3000);

    const profile = profileOf(gunner.room);
    const flying = profile ? fly(gunner.room, profile) : undefined;
    if (!flying || !profile) throw new Error('could not take the controls');

    /** Shoot a hull until it is written off, and say whether it went. */
    const sink = async (target: Captain, timeoutMs: number): Promise<boolean> => {
      const id = target.room.sessionId;
      await gunner.room.request('target', { id });

      // Stand off before opening fire. A round spawns at the muzzle and
      // travels, so a gun pressed against what it is shooting at has no line
      // to draw: the first version of this sat on top of its mark and put
      // twenty rounds a second through empty space.
      const mark = gunner.room.state.ships.get(id);
      if (mark) {
        const bearing = Math.atan2(mark.y, mark.x);
        await flyTo(
          gunner.room,
          flying,
          profile,
          mark.x + Math.cos(bearing) * 600,
          mark.y + Math.sin(bearing) * 600,
          80,
          120_000,
        );
      }

      const reach = content().modules.get('rpo-turret-1')!.weapon!.range;
      let traced = 0;
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const me = gunner.room.state.ships.get(gunner.room.sessionId);
        const them = gunner.room.state.ships.get(id);
        if (!me) return false;
        // Gone from the sky altogether, which is a wreck that finished
        // burning while this loop was running.
        if (!them) return true;
        if (them.destroyedAt > 0) return true;

        const bearing = Math.atan2(them.y - me.y, them.x - me.x);
        const range = Math.hypot(them.x - me.x, them.y - me.y);
        // Keep it roughly bows-on, because a turret's arc is half the sky and
        // not all of it, and keep inside reach. The trigger stays down: the
        // mount does the pointing.
        flying.input.data.turn = turnToward(me, bearing, profile);
        flying.input.data.thrust =
          range > reach * 0.5 && isAimedAt(me, bearing, 0.5) ? 1 : 0;
        flying.input.data.brake = range < reach * 0.35;
        flying.input.data.firePrimary = range <= reach;
        flying.input.data.fireSecondary = false;
        flying.commit();
        if (process.env.MARQUE_LOSS_TRACE === '1' && Date.now() - traced > 2000) {
          traced = Date.now();
          const hp = [...them.moduleHp].reduce((sum, v) => sum + v, 0);
          console.log(
            `  range ${Math.round(range)} reach ${reach} firing=${String(range <= reach)} ` +
              `their hp ${hp} shield ${Math.round(them.shield)} ` +
              `rounds ${gunner.room.state.projectiles.size} ` +
              `protected ${them.protectedUntil} ships ${gunner.room.state.ships.size}`,
          );
        }
        await sleep(16);
      }
      return false;
    };

    // --- The captain who owns nothing else -------------------------------

    const cargoBefore =
      alone.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? CARGO;
    const marksBefore = alone.purse?.marks ?? 0;
    const canistersBefore = gunner.room.state.canisters.size;

    const limit = Number(process.env.MARQUE_LOSS_LIMIT ?? 150_000);
    const sank = await sink(alone, limit);
    record(
      'a hull that takes enough fire is written off',
      sank,
      sank ? 'Act of God is a wreck' : 'never went down',
    );
    if (!sank) throw new Error('the target survived, so there is nothing to settle');

    // The second one goes now rather than after the first captain's
    // paperwork is checked: the gunner has to stay alive for both, and out
    // here there is always something else in the sky.
    const spareSank = await sink(provident, limit);

    await sleep(1500);

    const { blueprints, modules, tuning } = content();
    const lost = blueprints.get(LOST)!;
    const worth = buildCost(lost.placements, modules, tuning).modules;
    const due = Math.floor(worth * tuning.yard.claimFraction);

    record(
      'insurance settles half what the hull’s fittings cost',
      alone.claim?.claim === due,
      `settled ${alone.claim?.claim ?? 0} against half of ${worth}, which is ${due}`,
    );

    record(
      'and the claim is the figure the captain is actually paid',
      alone.claim !== undefined && alone.claim.marks === marksBefore + alone.claim.claim,
      `${marksBefore} marks before, ${alone.claim?.marks ?? 0} after a claim of ` +
        `${alone.claim?.claim ?? 0}`,
    );

    record(
      'the cargo is lost, and part of it drops where the hull came apart',
      alone.claim !== undefined &&
        alone.claim.spilled > 0 &&
        alone.claim.spilled < CARGO &&
        alone.claim.spilled + alone.claim.lost === CARGO,
      `${alone.claim?.spilled ?? 0} of ${cargoBefore} adrift, ${alone.claim?.lost ?? 0} gone`,
    );

    record(
      'and the canisters are really in the sky for somebody to scoop',
      gunner.room.state.canisters.size > canistersBefore,
      `${canistersBefore} canisters before, ${gunner.room.state.canisters.size} after`,
    );

    record(
      'the hull comes off the captain’s books',
      alone.claim?.stillOwned === 0,
      `${alone.claim?.stillOwned ?? -1} hulls left`,
    );

    // --- Where they wake --------------------------------------------------

    const woke = Date.now() + 20_000;
    while (Date.now() < woke && alone.woke === undefined) await sleep(100);
    await sleep(1500);

    record(
      'the captain wakes at the last berth they put in at, not where they died',
      alone.woke?.port === HOME && alone.landed === HOME,
      `woke at ${alone.woke?.port ?? 'nowhere'}, alongside ${alone.landed || 'nothing'} — ` +
        `they died off ${AWAY}`,
    );

    record(
      'and owning nothing else, they are given a starter draught',
      alone.purse?.draught === blueprints.get(tuning.start.draught)?.name,
      `flying ${alone.purse?.draught ?? 'nothing'}`,
    );

    record(
      'and the marks the claim settled are in their purse',
      (alone.purse?.marks ?? 0) >= marksBefore + due - content().tuning.ports.landingFee,
      `${alone.purse?.marks ?? 0} marks, against ${marksBefore} before the loss`,
    );

    record(
      'and the hold is empty, because it went with the hull',
      (alone.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? -1) === 0,
      `${alone.market?.listings.find((row) => row.commodityId === 'ice')?.carried ?? -1} units ` +
        'of Ice aboard',
    );

    record(
      'and the written-off hull is not in the moorings',
      alone.moorings !== undefined &&
        !alone.moorings.ships.some((hull) => hull.name === lost.name),
      `${alone.moorings?.ships.length ?? 0} hull(s): ` +
        (alone.moorings?.ships.map((hull) => hull.name).join(', ') || 'none'),
    );

    // --- The captain with a hull waiting ----------------------------------

    record(
      'a second hull goes the same way',
      spareSank,
      spareSank ? 'Prudent Return is a wreck' : 'never went down',
    );

    if (spareSank) {
      const until = Date.now() + 25_000;
      while (Date.now() < until && provident.woke === undefined) await sleep(100);
      await sleep(1500);

      record(
        'a captain with a hull waiting where they wake is put into that one',
        provident.purse?.draught === blueprints.get(SPARE)?.name,
        `flying ${provident.purse?.draught ?? 'nothing'}, not the starter draught`,
      );

      record(
        'and their other hull survived the one they lost',
        provident.claim?.stillOwned === 1,
        `${provident.claim?.stillOwned ?? -1} hull(s) still on the books`,
      );

      record(
        'and they wake alongside it',
        provident.woke?.port === HOME && provident.landed === HOME,
        `woke at ${provident.woke?.port ?? 'nowhere'}, alongside ${provident.landed || 'nothing'}`,
      );
    }

    // --- The one who did the shooting -------------------------------------

    // Spec section 11: the Prize Court's writ does not run in the Marque.
    // Two captains shot out of the sky and nothing to answer for.
    record(
      'and nothing is posted for either of them, because this is the Marque',
      (gunner.purse?.composition ?? 0) === 0 &&
        (gunner.room.state.ships.get(gunner.room.sessionId)?.posted ?? false) === false,
      `a composition of ${gunner.purse?.composition ?? 0} marks against Reprisal`,
    );
    await Promise.all([gunner.room.leave(), alone.room.leave(), provident.room.leave()]);
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
  console.log('\n=== Losing a hull ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
