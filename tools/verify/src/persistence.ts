/**
 * Persistence survives a restart.
 *
 * M3's acceptance check: killing the server process mid-session and starting
 * it again loses at most a few seconds of position, and no marks or cargo.
 *
 *   pnpm verify:persistence
 */

import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  ShipInput,
  SystemState,
  content,
  deriveStats,
  placeAll,
} from '@marque/shared';

import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2588;

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/** Start a server against a given database file and wait for it to answer. */
async function startServer(databaseUrl: string): Promise<ChildProcess> {
  const child = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'development',
      INVITE_CODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (log += d.toString()));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return child;
    } catch {
      // not yet
    }
    await sleep(300);
  }
  child.kill('SIGKILL');
  throw new Error(`server never became healthy:\n${log}`);
}

function stop(child: ChildProcess, graceful: boolean): Promise<void> {
  return stopGroup(child, { graceful });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'marque-persist-'));
  const databaseUrl = join(dir, 'world.db');

  console.log(`Using ${databaseUrl}`);
  await requirePortFree(PORT, 'a game server');
  console.log('Starting the server...');
  let server = await startServer(databaseUrl);
  // How much the running server can cost a captain, read from the server
  // itself rather than from a constant this file keeps its own copy of.
  const health = (await (
    await fetch(`http://127.0.0.1:${PORT}/health`)
  ).json()) as { flushIntervalMs?: number };
  const flushIntervalMs = health.flushIntervalMs ?? 4000;

  console.log(`Server up (flushing every ${flushIntervalMs} ms). Opening an account...`);

  try {
    // --- Open an account over HTTP ---------------------------------------
    const signUp = await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: 'Carvalho', inviteCode: '' }),
    });
    const account = (await signUp.json()) as {
      callsign: string;
      deviceToken: string;
      recoveryPhrase: string;
    };

    record(
      'opening an account returns a device token and a recovery phrase, once',
      signUp.ok && account.deviceToken.length > 20 && account.recoveryPhrase.split(' ').length === 6,
      `callsign ${account.callsign}, phrase of ${account.recoveryPhrase.split(' ').length} words`,
    );

    // The same callsign cannot be taken twice.
    const duplicate = await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign: 'carvalho', inviteCode: '' }),
    });
    record(
      'a callsign already on the Register is refused',
      duplicate.status === 409,
      `status ${duplicate.status}`,
    );

    console.log('Account opened. Joining and flying...');

    // --- Fly somewhere ----------------------------------------------------
    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
      'system',
      { deviceToken: account.deviceToken },
      SystemState,
    );
    for (const type of SERVER_MESSAGES) {
      room.onMessage(type, () => undefined);
    }

    const ship = await waitForShip(room);
    const input = room.input({ type: ShipInput });

    // Burn for a few seconds so the hull is somewhere distinctive.
    for (let i = 0; i < 160; i++) {
      input.data.thrust = 1;
      input.data.turn = i < 40 ? 1 : 0;
      input.send();
      await sleep(16);
    }
    input.data.thrust = 0;
    input.data.turn = 0;
    for (let i = 0; i < 5; i++) {
      input.send();
      await sleep(16);
    }

    // Let the room's persist cadence and the world's flush both run.
    await sleep(5000);

    const before = { x: ship.x, y: ship.y, callsign: ship.callsign };
    record(
      'the hull actually moved before the kill',
      Math.hypot(before.x, before.y) > 0,
      `at ${before.x.toFixed(0)}, ${before.y.toFixed(0)}`,
    );

    console.log('Flown. Killing the process without warning...');

    // --- Kill the process outright ---------------------------------------
    // Not a graceful shutdown: SIGKILL, as if the host had pulled the plug.
    await stop(server, false);
    await sleep(500);

    // --- Start it again and come back ------------------------------------
    console.log('Starting it again...');
    server = await startServer(databaseUrl);
    console.log('Back up. Reconnecting...');

    const sdk2 = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const room2: Room<unknown, SystemState> = await sdk2.joinOrCreate<SystemState>(
      'system',
      { deviceToken: account.deviceToken },
      SystemState,
    );
    for (const type of SERVER_MESSAGES) {
      room2.onMessage(type, () => undefined);
    }
    const ship2 = await waitForShip(room2);
    // Long enough for the state to settle. The hull is flying while this
    // runs, and it keeps the velocity it was persisted with, so this time
    // counts toward what the check allows.
    const settleMs = 600;
    await sleep(settleMs);

    const drift = Math.hypot(ship2.x - before.x, ship2.y - before.y);

    // What a hard kill costs is a flush interval of travel — the hull's row
    // is at most that old — plus the travel since it came back, because it
    // is restored under way and the settle above is time in flight. Both are
    // computed from the real interval and the draught's own top speed rather
    // than written out as a number that drifts away from the truth.
    //
    // The settle used to be left out, which made this check pass on a hull
    // that happened to be turning and fail on one flying straight.
    const topSpeed = deriveStats(
      placeAll(content().blueprints.get(content().tuning.start.draught)!.placements, content().modules),
      content().tuning,
    ).profile.topSpeed;
    const allowed = ((flushIntervalMs + settleMs) / 1000) * topSpeed * 1.5;

    record(
      'the hull comes back where it was, within a few seconds of travel',
      drift < allowed,
      `${drift.toFixed(0)} units from where it was left, allowing ${allowed.toFixed(0)}`,
    );
    record(
      'the captain comes back as themselves',
      ship2.callsign === before.callsign,
      `${ship2.callsign}`,
    );

    // --- The device token still works, and a wrong one does not ----------
    let refused = false;
    try {
      const sdk3 = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
      await sdk3.joinOrCreate('system', { deviceToken: 'not-a-real-token' }, SystemState);
    } catch {
      refused = true;
    }
    record('a device token the Register never issued is refused', refused, refused ? 'refused' : 'ACCEPTED');

    await room2.leave();
    report();
  } finally {
    await stop(server, true);
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
    console.error(`\nFAIL: ${failed.length} of ${checks.length} persistence checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} persistence checks held.`);
  }
}

function waitForShip(room: Room<unknown, SystemState>, timeoutMs = 15_000) {
  const existing = room.state.ships.get(room.sessionId);
  if (existing) return Promise.resolve(existing);
  return new Promise<NonNullable<ReturnType<typeof room.state.ships.get>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error('the server never created a hull for this session'));
    }, timeoutMs);
    const poll = setInterval(() => {
      const ship = room.state.ships.get(room.sessionId);
      if (ship) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(ship);
      }
    }, 16);
  });
}

await main();

// The SDK keeps sockets and timers alive after a room closes, so the check
// ends deliberately rather than waiting for an event loop that will not drain.
process.exit(process.exitCode ?? 0);
