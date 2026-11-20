/**
 * M8's boarding check: a hull that cannot run is a prize.
 *
 * Three captains on one server, through the real protocol. Boarding is the
 * only thing in the game that moves goods out of one account and into
 * another without either captain agreeing to it, which makes it the one
 * place where getting the conditions wrong is theft — so the conditions are
 * the subject here, one refusal at a time, and then the transfer itself.
 *
 * How a hull comes to be adrift is combat's business and is checked where
 * the damage lands; this one is seeded with its engine already out, which is
 * also what a captain who logged out crippled looks like on arrival.
 *
 * The prize here is a captain. A freighter's consignment goes the same way
 * through the same transaction, and the soak's factor bots take those.
 *
 *   pnpm verify:boarding
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  BOARDING_RANGE,
  BOARDING_SPEED,
  SERVER_MESSAGES,
  SystemState,
  turnToward,
  type BoardIntent,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { brakeTo, fly, flyTo, profileOf } from './control.ts';
import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2596;

/**
 * Contested space, with one berth that keeps a Staple.
 *
 * Not secured: boarding a captain's hull posts a composition, and a Home
 * Roads berth refuses a posted captain — which would mean the boarder could
 * not be taken alongside afterwards and their hold could never be counted.
 * Contested posts the composition and still takes them in, so both halves
 * can be checked in one run. The Marque would post nothing at all.
 */
const SYSTEM = 'lindqvist';
const BERTH = 'respondentia';

/** What the prize is carrying, and in what lots. */
const ICE = 30;
const LEAF = 5;

/** What a boarding answers with: the lots that actually came across. */
interface TakenLots {
  taken: { commodityId: string; units: number }[];
}

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
  composition: number;
  landedPort: string;
}

/** One connected captain, with whatever the server last told them. */
interface Captain {
  readonly callsign: string;
  readonly room: Room<unknown, SystemState>;
  purse: Purse | undefined;
  market: { listings: { commodityId: string; carried: number }[] } | undefined;
  /** Every `scanned` line, in order: boarding reports itself through them. */
  readonly scanned: { kind: string; text: string }[];
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
    market: undefined,
    scanned: [],
  };

  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('purse', (payload) => (captain.purse = payload as Purse));
  room.onMessage(
    'market',
    (payload) =>
      (captain.market = payload as { listings: { commodityId: string; carried: number }[] }),
  );
  room.onMessage('scanned', (payload) =>
    captain.scanned.push(payload as { kind: string; text: string }),
  );

  return captain;
}

/** The reason a refusal carried, or empty if it was not refused at all. */
async function refusal(sent: Promise<unknown>): Promise<string> {
  try {
    await sent;
    return '';
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'unknown';
  }
}

/** What a captain is carrying, by commodity, from the berth's own counting. */
function held(captain: Captain, commodityId: string): number {
  return captain.market?.listings.find((row) => row.commodityId === commodityId)?.carried ?? 0;
}

/** Take a captain alongside and wait for the berth to count their hold. */
async function landAndCount(captain: Captain, berthId: string): Promise<string> {
  const reason = await refusal(captain.room.request('land', { port: berthId }));
  if (reason !== '') return reason;
  await sleep(4000);
  return '';
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-boarding-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '40000',
  };

  // The prize flies a mining draught with its engine out and a hold worth
  // taking. The two boarders fly what every captain starts with, which holds
  // twenty units — less than the prize is carrying, so one boarding cannot
  // take the lot and what a hold will not take stays where it is.
  const tokens = await runSeed(
    [
      { callsign: 'Press Gang', at: BERTH },
      { callsign: 'Tender', at: BERTH },
      {
        callsign: 'Lame Duck',
        at: BERTH,
        flying: 'spoil-heap',
        crippled: true,
        cargo: { ice: ICE, leaf: LEAF },
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
    const gang = await connect(sdk, 'Press Gang', tokens['Press Gang']!);
    const tender = await connect(sdk, 'Tender', tokens['Tender']!);
    // Last, so its arrival protection is still running for the next check.
    const duck = await connect(sdk, 'Lame Duck', tokens['Lame Duck']!);
    await sleep(400);

    const duckId = [...duck.room.state.ships].find(
      ([, ship]) => ship.callsign === 'Lame Duck',
    )?.[0];
    record(
      'all three captains are in the same sky',
      duckId !== undefined && gang.room.state.ships.has(duckId),
      `${gang.room.state.ships.size} hulls, the prize ${duckId ? 'among them' : 'missing'}`,
    );
    if (duckId === undefined) throw new Error('the prize never arrived');

    // --- What a hull with no engine looks like ---------------------------

    const prize = gang.room.state.ships.get(duckId)!;
    record(
      'a hull whose engine is out arrives adrift',
      prize.adrift,
      prize.adrift ? 'adrift on arrival' : 'arrived under power it does not have',
    );

    const self = gang.room.state.ships.get(gang.room.sessionId);
    record(
      'and a hull whose engine is running does not',
      self !== undefined && !self.adrift,
      self ? `Press Gang adrift=${String(self.adrift)}` : 'no hull',
    );

    // --- Arrival protection ----------------------------------------------

    // Before anything else, because it lasts two seconds: a captain who
    // reconnects crippled must have a moment before somebody takes their
    // cargo, which is the whole point of the protection.
    const protectedReason = await refusal(gang.room.request('board', { id: duckId }));
    record(
      'a hull that has only just arrived cannot be boarded',
      protectedReason === 'target-protected',
      protectedReason === '' ? 'boarded anyway' : `refused: ${protectedReason}`,
    );

    await sleep(2500);

    // --- The conditions --------------------------------------------------

    record(
      'nobody boards their own hull',
      (await refusal(gang.room.request('board', { id: gang.room.sessionId }))) ===
        'unknown-target',
      'own session id',
    );

    record(
      'nothing is boarded that nobody is flying',
      (await refusal(gang.room.request('board', { id: 'no-such-hull' }))) === 'unknown-target',
      'a session id that is not there',
    );

    record(
      'a hull that can still run is not a prize',
      (await refusal(duck.room.request('board', { id: gang.room.sessionId }))) === 'not-adrift',
      'the prize tried to board the boarder',
    );

    // --- Out of reach ----------------------------------------------------

    const profile = profileOf(gang.room);
    const flying = profile ? fly(gang.room, profile) : undefined;
    if (!flying || !profile) throw new Error('could not take the controls');

    const bearing = prize.angle + Math.PI / 2;
    const runUp = 520;
    const away = await flyTo(
      gang.room,
      flying,
      profile,
      prize.x + Math.cos(bearing) * runUp,
      prize.y + Math.sin(bearing) * runUp,
      40,
      90_000,
    );
    const me = gang.room.state.ships.get(gang.room.sessionId)!;
    const standoff = Math.hypot(prize.x - me.x, prize.y - me.y);
    record(
      'the boarder can stand off from the prize',
      away && standoff > BOARDING_RANGE,
      `${Math.round(standoff)} units out, boarding reaches ${BOARDING_RANGE}`,
    );

    record(
      'and out of reach is out of reach, however adrift the prize is',
      (await refusal(gang.room.request('board', { id: duckId }))) === 'out-of-range',
      `at ${Math.round(standoff)} units`,
    );

    // --- Closing too fast ------------------------------------------------

    // Straight at it under full thrust, asking the whole way in. A party
    // cannot cross between two hulls passing at two hundred a second, and
    // the refusal has to come from the closing speed rather than from the
    // range, so the asking starts only once it is inside reach.
    let fastRefusal = '';
    let fastAt = 0;
    const until = Date.now() + 40_000;
    while (Date.now() < until && fastRefusal === '') {
      const here = gang.room.state.ships.get(gang.room.sessionId);
      if (!here) break;
      const toward = Math.atan2(prize.y - here.y, prize.x - here.x);
      const range = Math.hypot(prize.x - here.x, prize.y - here.y);
      const closing = Math.hypot(prize.vx - here.vx, prize.vy - here.vy);

      flying.input.data.turn = turnToward(here, toward, profile);
      flying.input.data.thrust = 1;
      flying.input.data.brake = false;
      flying.input.data.firePrimary = false;
      flying.input.data.fireSecondary = false;
      flying.commit();

      if (range <= BOARDING_RANGE && closing > BOARDING_SPEED) {
        fastAt = closing;
        fastRefusal = await refusal(gang.room.request('board', { id: duckId }));
      }
      await sleep(16);
    }

    record(
      'a party cannot cross between two hulls closing fast',
      fastRefusal === 'too-fast-to-board',
      fastAt > 0
        ? `closing at ${Math.round(fastAt)} a second, over the ${BOARDING_SPEED} allowed: ` +
          `${fastRefusal === '' ? 'never refused' : fastRefusal}`
        : 'never got inside reach at speed',
    );

    // --- Alongside and slowed --------------------------------------------

    const stopped = await brakeTo(gang.room, flying, BOARDING_SPEED / 2, 30_000);
    const near = await flyTo(
      gang.room,
      flying,
      profile,
      prize.x,
      prize.y,
      BOARDING_RANGE * 0.6,
      60_000,
    );
    await brakeTo(gang.room, flying, BOARDING_SPEED / 2, 30_000);
    const alongside = gang.room.state.ships.get(gang.room.sessionId)!;
    const finalRange = Math.hypot(prize.x - alongside.x, prize.y - alongside.y);
    const finalClosing = Math.hypot(prize.vx - alongside.vx, prize.vy - alongside.vy);
    record(
      'and the boarder can come alongside and match speeds',
      stopped && near && finalRange <= BOARDING_RANGE && finalClosing <= BOARDING_SPEED,
      `${Math.round(finalRange)} units apart, closing at ${Math.round(finalClosing)}`,
    );

    const taken = await gang.room.request<BoardIntent, TakenLots>('board', { id: duckId });

    record(
      'then a party goes across and takes what it can carry',
      taken.taken.length > 0,
      taken.taken.map((lot) => `${lot.units} ${lot.commodityId}`).join(', ') || 'nothing',
    );

    record(
      'the biggest lot first, so a boarder takes the one thing worth taking',
      taken.taken[0]?.commodityId === 'ice',
      `first lot was ${taken.taken[0]?.commodityId ?? 'none'}, against ice ${ICE} and leaf ${LEAF}`,
    );

    record(
      'and no more than the bays will hold',
      taken.taken.reduce((sum, lot) => sum + lot.units, 0) === 20,
      `${taken.taken.reduce((sum, lot) => sum + lot.units, 0)} units into 20 bays`,
    );

    record(
      'in whole units, because cargo is integers',
      taken.taken.every((lot) => Number.isInteger(lot.units)),
      taken.taken.map((lot) => String(lot.units)).join(', '),
    );

    // --- Who is told what ------------------------------------------------

    await sleep(600);
    const toldBoarder = gang.scanned.find((line) => line.kind === 'boarded');
    record(
      'the boarder is told what came across, by name',
      toldBoarder !== undefined && /Ice/.test(toldBoarder.text),
      toldBoarder?.text ?? 'nothing said',
    );

    const toldPrize = duck.scanned.find((line) => line.kind === 'boarded-by');
    record(
      'and the captain who was boarded is told who did it',
      toldPrize !== undefined && toldPrize.text.includes('Press Gang'),
      toldPrize?.text ?? 'nothing said',
    );

    record(
      'and the Prize Court posts the boarder, because it weighs this like any other violence',
      (gang.purse?.composition ?? 0) > 0,
      `a composition of ${gang.purse?.composition ?? 0} marks against Press Gang`,
    );

    // --- A full hold -----------------------------------------------------

    record(
      'a full hold cannot take another prize',
      (await refusal(gang.room.request('board', { id: duckId }))) === 'no-room-in-hold',
      'twenty units in twenty bays',
    );

    // --- The second boarder ----------------------------------------------

    // Tender never took the controls, so it is still where it was seeded,
    // which is where the prize is: the rest of the hold goes across without
    // anybody having to fly anywhere.
    const second = await tender.room.request<BoardIntent, TakenLots>('board', { id: duckId });
    record(
      'what one hold would not take is still there for the next',
      second.taken.reduce((sum, lot) => sum + lot.units, 0) === ICE + LEAF - 20,
      second.taken.map((lot) => `${lot.units} ${lot.commodityId}`).join(', ') || 'nothing',
    );

    record(
      'and a boarder with room takes every lot, not just the best one',
      second.taken.length === 2,
      `${second.taken.length} lot(s)`,
    );

    record(
      'a hull stripped bare has nothing left worth taking',
      (await refusal(tender.room.request('board', { id: duckId }))) === 'nothing-aboard',
      'third boarding of the same hull',
    );

    // --- Conservation ----------------------------------------------------

    // Counted by the berths, which is the only place a hold is read in play.
    const landings = await Promise.all([
      landAndCount(duck, BERTH),
      landAndCount(gang, BERTH),
      landAndCount(tender, BERTH),
    ]);
    record(
      'every captain can be taken alongside afterwards, posted or not',
      landings.every((reason) => reason === ''),
      landings.map((reason, i) => `${['prize', 'boarder', 'second'][i]}: ${reason || 'alongside'}`)
        .join('; '),
    );

    const totals = (id: string): number =>
      held(duck, id) + held(gang, id) + held(tender, id);
    record(
      'and not one unit was made or lost in the taking',
      totals('ice') === ICE && totals('leaf') === LEAF,
      `ice ${totals('ice')} of ${ICE}, leaf ${totals('leaf')} of ${LEAF} — ` +
        `prize ${held(duck, 'ice')}/${held(duck, 'leaf')}, ` +
        `boarder ${held(gang, 'ice')}/${held(gang, 'leaf')}, ` +
        `second ${held(tender, 'ice')}/${held(tender, 'leaf')}`,
    );

    record(
      'the prize is carrying nothing at all',
      held(duck, 'ice') === 0 && held(duck, 'leaf') === 0,
      `${held(duck, 'ice')} ice, ${held(duck, 'leaf')} leaf`,
    );

    record(
      'the boarder is carrying the lot it took',
      held(gang, 'ice') === 20,
      `${held(gang, 'ice')} ice`,
    );

    await Promise.all([duck.room.leave(), gang.room.leave(), tender.room.leave()]);
  } catch (error) {
    // A throw here is a result, not a crash: the checks already recorded say
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
  console.log('\n=== M8: boarding a hull that cannot run ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
