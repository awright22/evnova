/**
 * The admin page, and what it refuses.
 *
 * Spec section 12 puts it behind the server's own configuration, so the
 * first thing to prove is that it is shut: a captain who is not named in
 * `ADMIN_CALLSIGNS` gets the same answer as a device that is not on the
 * Register at all, because a page that told them apart would be a way to
 * find out who the operators are.
 *
 * Then the part that makes it worth having: tuning changed without a
 * restart, and a figure that the world is actually running on a moment
 * later.
 *
 *   pnpm verify:admin
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import { SERVER_MESSAGES, SystemState, content } from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2600;
const SYSTEM = 'parity';
const BERTH = 'the-bourse';

/** The callsign the server is told to trust, and one it is not. */
const OPERATOR = 'Harbourmaster';
const CAPTAIN = 'Nobody In Particular';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** Whatever the server said, as a line that can be printed. */
function said(answer: Answer): string {
  const message = answer.body.message;
  return typeof message === 'string' ? message : '';
}

async function post(path: string, body: unknown): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON answer is itself a result.
  }
  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-admin-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '80000',
    ADMIN_CALLSIGNS: OPERATOR,
  };

  const tokens = await runSeed(
    [
      { callsign: OPERATOR, at: BERTH },
      { callsign: CAPTAIN, at: BERTH },
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

    // --- What it refuses ---------------------------------------------------

    const noToken = await post('/admin/state', { deviceToken: 'not-a-token' });
    record(
      'a device that is not on the Register is refused',
      noToken.status === 403,
      `${noToken.status}: ${said(noToken)}`,
    );

    const notAdmin = await post('/admin/state', { deviceToken: tokens[CAPTAIN] });
    record(
      'and so is a captain the server was not told to trust',
      notAdmin.status === 403,
      `${notAdmin.status}: ${said(notAdmin)}`,
    );

    record(
      'and the two are told apart by nothing at all',
      noToken.status === notAdmin.status &&
        JSON.stringify(noToken.body) === JSON.stringify(notAdmin.body),
      'the same status and the same words either way',
    );

    const theirTuning = await post('/admin/tuning', {
      deviceToken: tokens[CAPTAIN],
      tuning: content().tuning,
    });
    record(
      'and a captain cannot put tuning in force',
      theirTuning.status === 403,
      `${theirTuning.status}: ${said(theirTuning)}`,
    );

    // --- What it shows ------------------------------------------------------

    const state = await post('/admin/state', { deviceToken: tokens[OPERATOR] });
    record(
      'an operator named in the configuration is let in',
      state.status === 200,
      `${state.status}`,
    );

    const ledger = state.body.ledger as { categories: unknown[]; net: number } | undefined;
    record(
      'and is shown the ledger by category',
      Array.isArray(ledger?.categories) && ledger.categories.length > 0,
      `${ledger?.categories.length ?? 0} categories, netting ${ledger?.net ?? 0}`,
    );

    record(
      'and prices, stockpiles and listings',
      Array.isArray(state.body.commodities) &&
        (state.body.commodities as unknown[]).length > 0 &&
        Array.isArray(state.body.berths) &&
        (state.body.berths as unknown[]).length > 0 &&
        Array.isArray(state.body.listings) &&
        (state.body.listings as unknown[]).length > 0,
      `${(state.body.commodities as unknown[])?.length ?? 0} goods, ` +
        `${(state.body.berths as unknown[])?.length ?? 0} berths, ` +
        `${(state.body.listings as unknown[])?.length ?? 0} listings`,
    );

    record(
      'and the tuning the world is running on',
      typeof state.body.tuning === 'object' && state.body.tuning !== null,
      Object.keys((state.body.tuning as Record<string, unknown>) ?? {})
        .slice(0, 5)
        .join(', '),
    );

    // The one thing an operator must not be handed: anybody's name.
    const whole = JSON.stringify(state.body).toLowerCase();
    record(
      'and nobody’s name, because the shape of an economy is not its people',
      !whole.includes(OPERATOR.toLowerCase()) && !whole.includes('nobody in particular'),
      'no callsign anywhere in the answer',
    );

    // --- Tuning that will not do --------------------------------------------

    const before = content().tuning.ports.landingFee;
    const nonsense = await post('/admin/tuning', {
      deviceToken: tokens[OPERATOR],
      tuning: { ...content().tuning, ports: { ...content().tuning.ports, landingFee: 'free' } },
    });
    record(
      'tuning that will not validate is refused, with the path that is wrong',
      nonsense.status === 400 &&
        typeof nonsense.body.message === 'string' &&
        nonsense.body.message.includes('landingFee'),
      said(nonsense).split('\n').slice(0, 2).join(' ').trim(),
    );

    const unchanged = await post('/admin/state', { deviceToken: tokens[OPERATOR] });
    const stillThere = (unchanged.body.tuning as { ports?: { landingFee?: number } } | undefined)
      ?.ports?.landingFee;
    record(
      'and the world goes on running on the last good figures',
      stillThere === before,
      `a landing fee of ${stillThere ?? 'nothing'}, which is what it was`,
    );

    // --- Tuning that does ---------------------------------------------------

    const raised = before + 777;
    const applied = await post('/admin/tuning', {
      deviceToken: tokens[OPERATOR],
      tuning: { ...content().tuning, ports: { ...content().tuning.ports, landingFee: raised } },
    });
    record(
      'tuning that validates is put in force without a restart',
      applied.status === 200 && applied.body.applied === true,
      `${applied.status}`,
    );

    // And the world is actually running on it: a captain who lands now pays
    // the new fee. Nothing else would prove the reload was more than storage.
    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
      'system',
      { deviceToken: tokens[CAPTAIN], systemId: SYSTEM },
      SystemState,
    );
    let purse: { marks: number; landedPort: string } | undefined;
    for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
    room.onMessage('purse', (payload) => (purse = payload as typeof purse));
    await sleep(1200);

    const marksBefore = purse?.marks ?? 0;
    try {
      await room.request('land', { port: BERTH });
    } catch {
      // A refusal is its own result below.
    }
    await sleep(3500);

    record(
      'and a captain landing a moment later pays the figure that was just set',
      marksBefore - (purse?.marks ?? 0) === raised,
      `${marksBefore - (purse?.marks ?? 0)} marks taken against the ${raised} just set ` +
        `(it was ${before})`,
    );

    await room.leave();
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
  console.log('\n=== M8: the admin page ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
