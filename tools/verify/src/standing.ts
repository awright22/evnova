/**
 * M7's other acceptance check: standing has consequences at a berth.
 *
 * The rules are unit-tested; what cannot be is that a captain actually
 * meets them. Three captains are written into the world before it starts —
 * one a company trusts, one it does not know, one it has barred — and each
 * lands at the same Kessler berth and is told what that is worth.
 *
 *   pnpm verify:standing
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  content,
  standingDiscount,
  standingName,
  type PortDef,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed, type SeedSpec } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2594;

/** A Kessler berth that keeps a Staple, which is where the money shows. */
const BERTH = 'demurrage';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

interface Listing {
  commodityId: string;
  ask: number;
  bid: number;
}

interface Watcher {
  readonly callsign: string;
  readonly room: Room<unknown, SystemState>;
  market: { port: string; listings: Listing[] } | undefined;
  standing: { standings: Record<string, number>; names: Record<string, string> } | undefined;
  landed: boolean;
  refusal: string;
}

async function connect(sdk: ColyseusSDK, callsign: string, token: string): Promise<Watcher> {
  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken: token, systemId: 'hallam' },
    SystemState,
  );

  const watcher: Watcher = {
    callsign,
    room,
    market: undefined,
    standing: undefined,
    landed: false,
    refusal: '',
  };

  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage(
    'market',
    (payload) => (watcher.market = payload as { port: string; listings: Listing[] }),
  );
  room.onMessage(
    'standing',
    (payload) =>
      (watcher.standing = payload as {
        standings: Record<string, number>;
        names: Record<string, string>;
      }),
  );

  return watcher;
}

/** Try to be taken alongside, and remember what was said if it was refused. */
async function land(watcher: Watcher, berth: string): Promise<void> {
  try {
    await watcher.room.request('land', { port: berth });
    watcher.landed = true;
  } catch (error) {
    watcher.refusal = (error as { reason?: string }).reason ?? 'unknown';
  }
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(joinPath(tmpdir(), 'marque-standing-'));
  const databaseUrl = joinPath(dir, 'world.db');
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: databaseUrl,
    SNAPSHOT_DIR: joinPath(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: 'hallam',
    STARTING_MARKS: '200000',
  };

  const { tuning } = content();
  const specs: SeedSpec[] = [
    { callsign: 'A Friend', standing: { kessler: 950 }, at: BERTH },
    { callsign: 'A Stranger', standing: { kessler: 0 }, at: BERTH },
    {
      callsign: 'Persona Non Grata',
      standing: { kessler: tuning.standing.refusedBelow - 50 },
      at: BERTH,
    },
  ];
  const tokens = await runSeed(specs, worldEnv);

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
    const friend = await connect(sdk, 'A Friend', tokens['A Friend'] ?? '');
    const stranger = await connect(sdk, 'A Stranger', tokens['A Stranger'] ?? '');
    const barred = await connect(sdk, 'Persona Non Grata', tokens['Persona Non Grata'] ?? '');
    await sleep(1500);

    const system = content().systems.get('hallam')!;
    const berth: PortDef = system.ports.find((port) => port.id === BERTH)!;
    record(
      'the berth under test belongs to a company and keeps a Staple',
      berth.owner === 'kessler' && berth.services.includes('staple'),
      `${berth.name}: ${berth.owner}, ${berth.services.join(', ')}`,
    );

    await land(friend, BERTH);
    await land(stranger, BERTH);
    await land(barred, BERTH);
    await sleep(3000);

    // --- Who is let in ---------------------------------------------------

    record(
      'a company takes a captain it trusts alongside',
      friend.landed,
      friend.landed ? 'alongside' : `refused: ${friend.refusal}`,
    );

    record(
      'and one it merely does not know',
      stranger.landed,
      stranger.landed ? 'alongside' : `refused: ${stranger.refusal}`,
    );

    record(
      'and shuts its berth to one it has barred, with a reason that says why',
      !barred.landed && barred.refusal === 'barred-here',
      barred.landed ? 'it let them in' : `refused: ${barred.refusal}`,
    );

    // --- What it is worth ------------------------------------------------

    record(
      'a captain is told where they stand, in words as well as figures',
      friend.standing?.names.kessler === standingName(950, tuning) &&
        stranger.standing?.names.kessler === standingName(0, tuning),
      `friend "${friend.standing?.names.kessler ?? '—'}", ` +
        `stranger "${stranger.standing?.names.kessler ?? '—'}"`,
    );

    // Leaf, because marks are integers: a 2.75% shading of a 34-mark unit
    // is less than a mark and `ceil` eats it, so a cheap good quoted by the
    // unit cannot show the rule at all. The shading is real on the parcel
    // either way — `trade` applies it to the whole order — but a check that
    // reads the screen has to read a figure the screen can carry.
    const GOOD = 'leaf';
    const askOf = (who: Watcher): number =>
      who.market?.listings.find((row) => row.commodityId === GOOD)?.ask ?? 0;
    const bidOf = (who: Watcher): number =>
      who.market?.listings.find((row) => row.commodityId === GOOD)?.bid ?? 0;

    record(
      'the berth charges a trusted captain less for the same good',
      askOf(friend) > 0 && askOf(stranger) > 0 && askOf(friend) < askOf(stranger),
      `friend ${askOf(friend)}, stranger ${askOf(stranger)} a unit of Leaf`,
    );

    record(
      'and pays them more for it',
      bidOf(friend) > bidOf(stranger),
      `friend ${bidOf(friend)}, stranger ${bidOf(stranger)} a unit of Leaf`,
    );

    // The shading is the rule's, not a coincidence of rounding.
    const expected = standingDiscount(950, tuning);
    const actual = askOf(stranger) > 0 ? 1 - askOf(friend) / askOf(stranger) : 0;
    record(
      'and the shading is the fraction the Register says it is',
      Math.abs(actual - expected) < 0.005,
      `${(actual * 100).toFixed(2)}% against a rule of ${(expected * 100).toFixed(2)}%`,
    );

    record(
      'but never enough to make a round trip free: invariant 1 holds for a friend',
      bidOf(friend) < askOf(friend),
      `bid ${bidOf(friend)} against ask ${askOf(friend)}`,
    );

    // And the figure on the screen is the figure the counter charges.
    const paid = await friend.room.request<
      { side: string; commodity: string; units: number },
      { marks: number }
    >('staple', { side: 'buy', commodity: GOOD, units: 1 });
    record(
      'and what the screen quotes is what the counter charges',
      Math.abs(paid.marks - askOf(friend)) <= 1,
      `quoted ${askOf(friend)}, charged ${paid.marks}`,
    );

    // --- What work it is shown -------------------------------------------

    const friendBoard = (await friend.room.request('take-commission', { id: 'nothing' }).catch(
      (error: unknown) => (error as { reason?: string }).reason,
    )) as string;
    record(
      'the Factor still answers a captain it trusts, with a typed refusal',
      friendBoard === 'no-such-commission',
      String(friendBoard),
    );

    await friend.room.leave();
    await stranger.room.leave();
    await barred.room.leave();
  } finally {
    await stopGroup(server, { timeoutMs: 5000 });
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.passed);
  console.log('\n=== M7: what standing is worth at a berth ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
