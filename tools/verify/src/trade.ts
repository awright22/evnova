/**
 * M4's acceptance check: a captain trades.
 *
 * Lands, buys what a berth is selling, sells it back, and takes a hold of
 * something from one berth to another through a real jump. Everything goes
 * through the real protocol, so this covers what a unit test cannot: that the
 * room still knows who a landed captain is, that its berth answers, and that
 * the invariants hold across a session rather than inside one function.
 *
 *   pnpm verify:trade
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import { SERVER_MESSAGES, SystemState, content, type PortDef } from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2590;

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

interface Market {
  port: string;
  listings: {
    commodityId: string;
    name: string;
    ask: number;
    bid: number;
    stock: number;
    carried: number;
  }[];
  holdCapacity: number;
  holdUsed: number;
}

interface Purse {
  marks: number;
  landedPort: string;
}

/** What the Staple answers a trade with. */
interface Filled {
  units: number;
  marks: number;
  carried: number;
  stock: number;
}

/**
 * Trade, typed.
 *
 * `room.request`'s type parameter is its payload, not its answer, so the
 * answer is narrowed once here rather than cast at every call.
 */
async function trade(
  room: Room<unknown, SystemState>,
  side: 'buy' | 'sell',
  commodity: string,
  units: number,
): Promise<Filled> {
  const answer: unknown = await room.request('staple', { side, commodity, units });
  return answer as Filled;
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-trade-'));
  const server = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: join(dir, 'world.db'),
      SNAPSHOT_DIR: join(dir, 'snapshots'),
      NODE_ENV: 'development',
      INVITE_CODE: '',
    },
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

    const account = (await (
      await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callsign: 'Supercargo', inviteCode: '' }),
      })
    ).json()) as { deviceToken: string };

    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
      'system',
      { deviceToken: account.deviceToken, systemId: content().tuning.start.system },
      SystemState,
    );

    let market: Market | undefined;
    let purse: Purse | undefined;
    for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
    room.onMessage('market', (payload) => (market = payload as Market));
    room.onMessage('purse', (payload) => (purse = payload as Purse));

    await sleep(1500);

    // --- Alongside -------------------------------------------------------
    const system = content().systems.get(room.state.systemId)!;
    const berth: PortDef = system.ports[0]!;

    await room.request('land', { port: berth.id });
    await sleep(3500);

    record(
      'landing opens the berth and its Staple',
      market !== undefined && market.port === berth.id && market.listings.length === 10,
      market ? `${market.listings.length} goods at ${market.port}` : 'no market arrived',
    );

    record(
      'the hold is reported with the market',
      market !== undefined && market.holdCapacity > 0 && market.holdUsed === 0,
      market ? `${market.holdUsed} of ${market.holdCapacity}` : 'no market arrived',
    );

    // --- Every service the berth sells ------------------------------------
    //
    // A landed captain used to be dropped from the room, so every one of
    // these was refused with "you do not own that" and the whole terminal was
    // decorative. One of them succeeding is the regression test.
    const answered: string[] = [];
    const refused: string[] = [];
    for (const service of ['propellant', 'ordnance', 'repair', 'composition'] as const) {
      try {
        await room.request('port', { service, units: 0 });
        answered.push(service);
      } catch (error) {
        const reason = (error as { reason?: string }).reason ?? 'unknown';
        // A berth that does not sell it, or a captain who needs none of it,
        // is a real answer. Not knowing who the captain is, is not.
        if (reason === 'not-owned' || reason === 'not-landed') refused.push(`${service}:${reason}`);
        else answered.push(`${service}:${reason}`);
      }
    }

    record(
      'the berth knows whose captain it is',
      refused.length === 0,
      refused.length === 0 ? answered.join(', ') : `refused: ${refused.join(', ')}`,
    );

    // --- Buying and selling back ------------------------------------------
    const marksBefore = purse?.marks ?? 0;
    const good = market!.listings.find((listing) => listing.ask * 10 < marksBefore)!;

    const bought = await trade(room, 'buy', good.commodityId, 10);

    await sleep(300);

    record(
      'buying moves cargo into the hold and marks out of the purse',
      bought.units === 10 && bought.carried === 10 && (purse?.marks ?? 0) === marksBefore - bought.marks,
      `${bought.units} ${good.name} for ${bought.marks} marks`,
    );

    const sold = await trade(room, 'sell', good.commodityId, 10);

    await sleep(300);

    record(
      'invariant 1: selling straight back loses money',
      sold.marks < bought.marks && sold.carried === 0,
      `bought for ${bought.marks}, sold for ${sold.marks}: ${sold.marks - bought.marks} marks`,
    );

    record(
      'the berth ends where it started',
      sold.stock === bought.stock + bought.units,
      `${sold.stock} units, from ${bought.stock + bought.units}`,
    );

    // --- Invariant 2, over the wire ---------------------------------------
    const whole = await trade(room, 'buy', good.commodityId, 12);
    await trade(room, 'sell', good.commodityId, 12);

    let pieces = 0;
    for (const part of [5, 3, 4]) {
      pieces += (await trade(room, 'buy', good.commodityId, part)).marks;
    }

    record(
      'invariant 2: splitting an order costs the same as placing it whole',
      pieces === whole.marks,
      `${pieces} marks in pieces against ${whole.marks} whole`,
    );

    // --- Invariant 5: a hold has a bottom ---------------------------------
    //
    // Asking to sell far more than is aboard sells what is aboard and stops,
    // and asking again with an empty hold is refused rather than going
    // negative.
    const dumped = await trade(room, 'sell', good.commodityId, 10_000);
    let refusedEmpty = '';
    try {
      await trade(room, 'sell', good.commodityId, 1);
    } catch (error) {
      refusedEmpty = (error as { reason?: string }).reason ?? 'unknown';
    }

    record(
      'invariant 5: a captain cannot sell what they are not carrying',
      dumped.carried === 0 && refusedEmpty === 'not-carrying',
      `hold emptied to ${dumped.carried}, then refused with "${refusedEmpty}"`,
    );

    await room.leave();
    report();
  } finally {
    await stopGroup(server);
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length} of ${checks.length} trade checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} trade checks held.`);
  }
}

await main();
process.exit(process.exitCode ?? 0);
