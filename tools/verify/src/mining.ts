/**
 * M8's mining check: a captain cuts rock and carries it away.
 *
 * Through the real protocol, with a real hull built in a real Yard. What a
 * unit test cannot show is the whole of it joined up: a rig fitted, a belt
 * in the sky where the system data says it is, a held trigger, fractions of
 * a unit adding up, and cargo in the hold that the Staple will buy.
 *
 *   pnpm verify:mining
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  LANDING_RANGE,
  LANDING_SPEED,
  PROJECTILE_KIND,
  SERVER_MESSAGES,
  SystemState,
  beltOf,
  content,
  isAimedAt,
  mountsOf,
  placeAll,
  decodeShareCode,
  turnToward,
  validateDesign,
  type Placement,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { brakeTo, fly, flyTo, profileOf } from './control.ts';
import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2595;

/**
 * A system with rock in it, close to a berth, and contested rather than
 * lawless.
 *
 * Bitter End has the only Yard beside a belt, and the first version of this
 * built its hull there — and then lost it, because Bitter End is the Marque
 * and a mining draught carries no gun and no shield. That is the right
 * design and the wrong place to check cutting from. The hull is seeded here
 * instead; building one is `verify:yard`'s subject.
 */
const SYSTEM = 'lindqvist';
const BERTH = 'respondentia';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/**
 * The shipped mining draught.
 *
 * A draught the Register already lists rather than one the harness draws:
 * a check that invents a grid is really checking whether I can draw one.
 */
function rigHull(): Placement[] {
  const base = content().blueprints.get('spoil-heap');
  if (!base) throw new Error('the mining draught is missing');
  return [...base.placements];
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-mining-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '400000',
  };

  const tokens = await runSeed(
    [{ callsign: 'Spoil Heap', at: BERTH, flying: 'spoil-heap' }],
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
    const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
      'system',
      { deviceToken: tokens['Spoil Heap'], systemId: SYSTEM },
      SystemState,
    );

    let purse: { marks: number; landedPort: string } | undefined;
    let market: { listings: { commodityId: string; carried: number }[] } | undefined;
    let scanned: { kind: string; text: string } | undefined;
    for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
    room.onMessage('purse', (payload) => (purse = payload as typeof purse));
    room.onMessage('market', (payload) => (market = payload as typeof market));
    room.onMessage('scanned', (payload) => (scanned = payload as typeof scanned));

    await sleep(2000);

    // --- The belt --------------------------------------------------------

    const system = content().systems.get(SYSTEM)!;
    const expected = beltOf(system);

    record(
      'the system the data gives a belt to has one in the sky',
      room.state.asteroids.size === expected.length && expected.length > 0,
      `${room.state.asteroids.size} rocks against ${expected.length} in the data`,
    );

    const live = [...room.state.asteroids].map(([id, rock]) => ({ id, rock }));
    record(
      'and every rock is where the system says it is, whole',
      live.every((entry) => {
        const want = expected.find((rock) => rock.id === entry.id);
        return (
          want !== undefined &&
          Math.abs(want.x - entry.rock.x) < 1 &&
          Math.abs(want.y - entry.rock.y) < 1 &&
          entry.rock.left === entry.rock.whole
        );
      }),
      `${live.length} checked`,
    );

    record(
      'and it holds a raw good, which is the only thing rock holds',
      live.every((entry) => content().commodities.get(entry.rock.commodity)?.tier === 'raw'),
      [...new Set(live.map((entry) => entry.rock.commodity))].join(', '),
    );

    // --- A hull that can cut ---------------------------------------------

    const berth = system.ports.find((port) => port.id === BERTH) ?? system.ports[0]!;

    const spawned = room.state.ships.get(room.sessionId);
    const away = spawned
      ? Math.hypot(berth.x - spawned.x, berth.y - spawned.y)
      : Number.POSITIVE_INFINITY;
    record(
      'a captain wakes within reach of the berth they were last at',
      away <= berth.radius + 420,
      `${Math.round(away)} units from ${berth.name}, which reaches ${berth.radius + 420}`,
    );

    let landed = '';
    try {
      await room.request('land', { port: berth.id });
      landed = 'alongside';
    } catch (error) {
      landed = `refused: ${(error as { reason?: string }).reason ?? 'unknown'}`;
    }
    record('and can be taken alongside it', landed === 'alongside', landed);
    await sleep(3500);

    record(
      'alongside the berth nearest the belt',
      purse?.landedPort === berth.id,
      `at ${purse?.landedPort ?? 'nowhere'}`,
    );

    const design = rigHull();
    record(
      'the mining draught the Register lists is one it would pass',
      (() => {
        const licence = content().licences.get('open-ticket')!;
        return validateDesign(placeAll(design, content().modules), licence, content().tuning)
          .problems.length === 0;
      })(),
      'spoil-heap',
    );

    await sleep(1500);
    await room.request('launch', {});
    await sleep(2500);

    const self = room.state.ships.get(room.sessionId);
    record('and the hull is in the sky', self !== undefined, self ? 'flying' : 'nothing there');
    if (!self) throw new Error('the hull never launched');

    const fitted = placeAll(design, content().modules);
    const rig = mountsOf(fitted).find((mount) => mount.kind === PROJECTILE_KIND.mining);
    record('the Register reads the rig as a rig', rig !== undefined, rig ? 'mining mount' : 'none');
    if (!rig) throw new Error('no rig on the hull');

    // And the hull the server is actually flying is the one that was built:
    // a check that reads the draught it drew rather than the hull in the sky
    // would pass with the starter shuttle underneath it.
    const flown =
      self.hull !== '' ? decodeShareCode(self.hull).placements : (
        content().blueprints.get(self.blueprint)?.placements ?? []
      );
    const flownMounts = mountsOf(placeAll([...flown], content().modules));
    record(
      'and the hull in the sky is the one with the rig on it',
      flownMounts.some((mount) => mount.kind === PROJECTILE_KIND.mining),
      `${self.hull === '' ? `draught ${self.blueprint}` : 'a built hull'} with ` +
        `${flownMounts.length} mount(s): ${flownMounts.map((m) => m.def.id).join(', ') || 'none'}`,
    );

    // --- Cutting ---------------------------------------------------------

    const profile = profileOf(room);
    const flying = profile ? fly(room, profile) : undefined;
    if (!flying || !profile) throw new Error('could not take the controls');

    // The nearest rock worth sitting on. Flying to it is the point: a belt
    // that cannot be reached is scenery.
    const me0 = room.state.ships.get(room.sessionId)!;
    const rock = [...live]
      .filter((entry) => entry.rock.left > 50)
      .sort(
        (a, b) =>
          Math.hypot(a.rock.x - me0.x, a.rock.y - me0.y) -
          Math.hypot(b.rock.x - me0.x, b.rock.y - me0.y),
      )[0]!;

    const range = content().modules.get('slp-rig-1')!.weapon!.range;
    // Close enough that the rock is wide in view: at the far edge of a rig's
    // reach a rock subtends a quarter of a radian and a hull that wanders by
    // that much is off it, which is why a captain sits on a rock rather than
    // sniping at one.
    const standoff = rock.rock.radius + range * 0.25;

    const out = Math.hypot(rock.rock.x - me0.x, rock.rock.y - me0.y);
    const reached = await flyTo(
      room,
      flying,
      profile,
      rock.rock.x,
      rock.rock.y,
      standoff,
      240_000,
    );
    record(
      'a captain can reach the belt from the berth they started at',
      reached,
      `${Math.round(out)} units out, at ${Math.round(profile.topSpeed)} a second: ` +
        (reached ? 'alongside the rock' : 'never got there'),
    );

    const before =
      market?.listings.find((row) => row.commodityId === rock.rock.commodity)?.carried ?? 0;
    const rockBefore = rock.rock.left;

    // Hold the trigger, pointed at the rock. The rig cuts at units a second,
    // so a few seconds of it is a few units: enough to be sure of.
    const until = Date.now() + 12_000;
    let sawBeam = false;
    let aimedSteps = 0;
    let hitSteps = 0;
    let lastLength = 0;
    while (Date.now() < until) {
      const me = room.state.ships.get(room.sessionId);
      if (!me) break;
      const bearing = Math.atan2(rock.rock.y - me.y, rock.rock.x - me.x);
      const aimed = isAimedAt(me, bearing, 0.25);
      if (aimed) aimedSteps += 1;

      flying.input.data.turn = turnToward(me, bearing, profile);
      flying.input.data.thrust = 0;
      // Not braking: the brake kills the turn as well as the drift, and a
      // hull that has already stopped has nothing to brake.
      flying.input.data.brake = false;
      // Held whatever the aim, because a rig that only fires when perfectly
      // lined up is a check on the harness's steering rather than on the rig.
      flying.input.data.firePrimary = true;
      flying.input.data.fireSecondary = false;
      flying.commit();
      for (const beam of room.state.beams.values()) {
        sawBeam = true;
        if (beam.hitting) hitSteps += 1;
        lastLength = beam.length;
      }
      await sleep(16);
    }

    record(
      'the hull can be brought round onto the rock and held there',
      aimedSteps > 30,
      `${aimedSteps} steps on the mark`,
    );

    flying.input.data.firePrimary = false;
    flying.commit();
    await sleep(1200);

    const alive = (room.state.ships.get(room.sessionId)?.destroyedAt ?? 0) === 0;
    record(
      'the hull survived long enough to cut anything',
      alive,
      alive ? 'intact' : 'written off: a mining draught carries no gun',
    );

    record('holding the trigger on a rock puts a beam on the wire', sawBeam, String(sawBeam));

    record(
      'and the beam actually lands on the rock',
      hitSteps > 0,
      `on the rock for ${hitSteps} of the steps it was held, reaching ${Math.round(lastLength)}`,
    );

    record(
      'the rock has less in it than it did',
      rock.rock.left < rockBefore,
      `${rockBefore} down to ${rock.rock.left}`,
    );

    // Watch for a write-off for the whole of the way home.
    //
    // Every belt in the Reach is in contested or lawless space, which is the
    // spec's design — rock is on the frontier — so an unarmed rig with a
    // full hold is exactly what a raider wants. The check above only covers
    // the cutting. When the captain was killed on the run home instead, this
    // harness reported "74770 units from Respondentia and the flight timed
    // out", or a distance of -1 because the ship was not in the state at
    // all, or a landing "refused: not-owned" — three descriptions of a
    // symptom and none of the cause.
    let lostGoingHome = false;
    const watching = setInterval(() => {
      const hull = room.state.ships.get(room.sessionId);
      if (!hull || hull.destroyedAt > 0) lostGoingHome = true;
    }, 250);

    // Back to the berth, which is where the hold is counted.
    // Well inside the berth's reach rather than at the edge of it: a hull
    // that stops at the tolerance and then coasts has to still be in reach
    // when it gets there.
    const home = await flyTo(room, flying, profile, berth.x, berth.y, berth.radius + 180, 300_000);
    // In reach is not the same as slow enough: `flyTo` stops steering once
    // the mark is inside its tolerance, and a berth refuses a hull that
    // arrives at a hundred a second.
    await brakeTo(room, flying, LANDING_SPEED / 2, 30_000);

    clearInterval(watching);

    const me = room.state.ships.get(room.sessionId);
    const away2 = me ? Math.hypot(berth.x - me.x, berth.y - me.y) : -1;
    if (lostGoingHome) {
      record(
        'the laden hull got home without being taken',
        false,
        'written off on the way back, with the ore aboard — every check below '
          + 'this one is about that and not about mining',
      );
    }
    record(
      'and can fly the cargo back to the berth it came from',
      home && away2 >= 0 && away2 <= berth.radius + LANDING_RANGE,
      `${Math.round(away2)} units from ${berth.name}, which takes a hull at ` +
        `${berth.radius + LANDING_RANGE}` + (home ? '' : ' — and the flight timed out'),
    );

    let back = '';
    try {
      await room.request('land', { port: berth.id });
      back = 'alongside';
    } catch (error) {
      back = `refused: ${(error as { reason?: string }).reason ?? 'unknown'}`;
    }
    record('and can carry it back to a berth', back === 'alongside', back);
    await sleep(3500);
    const after = market?.listings.find((row) => row.commodityId === rock.rock.commodity)?.carried
      ?? 0;

    record(
      'and the captain is carrying what came out of it',
      after > before,
      `${before} units aboard before, ${after} after`,
    );

    record(
      'in whole units, because cargo is integers',
      Number.isInteger(after),
      String(after),
    );

    record(
      'and what the rock lost is what the hold gained',
      rockBefore - rock.rock.left === after - before,
      `rock lost ${rockBefore - rock.rock.left}, hold gained ${after - before}`,
    );

    void scanned;
    await room.leave();
  } catch (error) {
    // A throw here is a result, not a crash. The checks already recorded say
    // how far it got, and losing them to a stack trace is how a harness
    // stops being able to tell you anything.
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
  console.log('\n=== M8: cutting rock ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
