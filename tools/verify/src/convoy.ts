/**
 * M7's acceptance check: two captains sail together and trade.
 *
 * Two real clients on one server, through the real protocol. A convoy is
 * the one thing in the game where what one captain does changes another
 * captain's screen, and a trade is the one thing that moves marks and cargo
 * between two accounts — neither can be proved by a unit test, because both
 * are about two sessions agreeing.
 *
 *   pnpm verify:convoy
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  content,
  type ConvoyState,
  type OffersState,
  type PortDef,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2593;

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/** A captain's purse, as the server pushes it. */
interface Purse {
  marks: number;
  landedPort: string;
}

/** One connected captain, with whatever the server last told them. */
interface Captain {
  readonly callsign: string;
  readonly room: Room<unknown, SystemState>;
  purse: Purse | undefined;
  convoy: ConvoyState | undefined;
  offers: OffersState | undefined;
  commissions: { held: { id: string; shared: boolean; holder: string }[] } | undefined;
}

/** Open an account and join the opening system as them. */
async function connect(sdk: ColyseusSDK, callsign: string): Promise<Captain> {
  const account = (await (
    await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign, inviteCode: '' }),
    })
  ).json()) as { deviceToken: string };

  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken: account.deviceToken, systemId: content().tuning.start.system },
    SystemState,
  );

  const captain: Captain = {
    callsign,
    room,
    purse: undefined,
    convoy: undefined,
    offers: undefined,
    commissions: undefined,
  };

  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('purse', (payload) => (captain.purse = payload as Purse));
  room.onMessage('convoy', (payload) => (captain.convoy = payload as ConvoyState));
  room.onMessage('offers', (payload) => (captain.offers = payload as OffersState));
  room.onMessage(
    'commissions',
    (payload) =>
      (captain.commissions = payload as {
        held: { id: string; shared: boolean; holder: string }[];
      }),
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

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-convoy-'));
  const server = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: join(dir, 'world.db'),
      SNAPSHOT_DIR: join(dir, 'snapshots'),
      NODE_ENV: 'development',
      INVITE_CODE: '',
      // Enough to buy a hold with, so the trade half has something to move.
      STARTING_MARKS: '200000',
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

    const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`);
    const one = await connect(sdk, 'Fair Wind');
    const two = await connect(sdk, 'Slack Water');
    const three = await connect(sdk, 'Lee Helm');
    await sleep(1500);

    const system = content().systems.get(one.room.state.systemId)!;
    // The berth a new captain is set down beside, which is the one they can
    // reach without flying anywhere.
    const berth: PortDef = system.ports[0]!;

    // --- A convoy --------------------------------------------------------

    record(
      'a captain who sails alone is told so, not left guessing',
      one.convoy !== undefined && one.convoy.id === '' && one.convoy.members.length === 0,
      one.convoy ? `id "${one.convoy.id}", ${one.convoy.members.length} members` : 'no convoy push',
    );

    await one.room.request('convoy-invite', { callsign: 'Slack Water' });
    await sleep(900);

    record(
      'an invitation reaches the captain it was made to',
      two.convoy?.invitations.length === 1 && two.convoy.invitations[0]?.from === 'Fair Wind',
      `${two.convoy?.invitations.length ?? 0} waiting, from ${two.convoy?.invitations[0]?.from ?? '—'}`,
    );

    record(
      'and shows on the asking captain’s own screen as unanswered',
      one.convoy?.members.some((member) => member.callsign === 'Slack Water' && member.state === 'invited') === true,
      one.convoy?.members.map((m) => `${m.callsign}:${m.state}`).join(', ') ?? 'nothing',
    );

    const selfInvite = await refusal(
      one.room.request('convoy-invite', { callsign: 'Fair Wind' }),
    );
    record(
      'a captain cannot ask themselves',
      selfInvite === 'cannot-invite-yourself',
      selfInvite || 'it was allowed',
    );

    const twice = await refusal(one.room.request('convoy-invite', { callsign: 'Slack Water' }));
    record('the same captain cannot be asked twice', twice === 'already-invited', twice || 'it was allowed');

    const fleetId = two.convoy?.invitations[0]?.fleetId ?? '';
    await two.room.request('convoy-answer', { fleet: fleetId, accept: true });
    await sleep(900);

    record(
      'taking it up puts both captains in it, on both screens',
      one.convoy?.members.filter((m) => m.state === 'member').length === 2 &&
        two.convoy?.members.filter((m) => m.state === 'member').length === 2,
      `${one.convoy?.members.length ?? 0} and ${two.convoy?.members.length ?? 0}`,
    );

    record(
      'and says where each of them is',
      one.convoy?.members.every((member) => member.systemId === system.id) === true,
      one.convoy?.members.map((m) => `${m.callsign}@${m.systemName || '—'}`).join(', ') ?? 'nothing',
    );

    record(
      'the captain who opened it is marked as having opened it, and only they',
      one.convoy?.isLeader === true && two.convoy?.isLeader === false,
      `one ${String(one.convoy?.isLeader)}, two ${String(two.convoy?.isLeader)}`,
    );

    const notLeader = await refusal(two.room.request('convoy-invite', { callsign: 'Lee Helm' }));
    record(
      'a member cannot ask anybody into it',
      notLeader === 'not-the-leader',
      notLeader || 'it was allowed',
    );

    const taken = await refusal(three.room.request('convoy-invite', { callsign: 'Slack Water' }));
    record(
      'nor can a stranger ask away a captain who already sails with somebody',
      taken === 'already-in-a-convoy',
      taken || 'it was allowed',
    );

    // --- Work on its books -----------------------------------------------

    await one.room.request('land', { port: berth.id });
    await two.room.request('land', { port: berth.id });
    await sleep(3000);

    const board = (
      one.commissions as unknown as { board: { id: string }[] } | undefined
    )?.board;
    const offer = board?.[0];
    if (offer) {
      await one.room.request('take-commission', { id: offer.id });
      await sleep(700);
      await one.room.request('share-commission', { id: (one.commissions?.held[0]?.id ?? ''), shared: true });
      await sleep(900);

      record(
        'a commission put on the convoy’s books appears in the other captain’s hand',
        two.commissions?.held.some((row) => row.holder === 'Fair Wind' && row.shared) === true,
        two.commissions?.held.map((row) => `${row.holder || 'mine'}:${String(row.shared)}`).join(', ') ?? 'nothing',
      );
    } else {
      record('a commission could be taken to share', false, 'the berth posted nothing');
    }

    const strangerShare = await refusal(
      three.room.request('share-commission', { id: 'not-a-commission', shared: true }),
    );
    record(
      'a commission nobody holds cannot be put on any books',
      strangerShare === 'no-such-commission',
      strangerShare || 'it was allowed',
    );

    // --- Alongside, and an offer -----------------------------------------

    await sleep(600);
    record(
      'a captain alongside sees who else is standing there',
      one.offers?.alongside.includes('Slack Water') === true,
      one.offers?.alongside.join(', ') || 'nobody',
    );

    record(
      'and what they are carrying, and what is on their books',
      one.offers !== undefined && Array.isArray(one.offers.hold) && Array.isArray(one.offers.designs),
      one.offers ? `${one.offers.hold.length} goods, ${one.offers.designs.length} draughts` : 'no push',
    );

    // Buy a hold, so there is something to hand over.
    await one.room.request('staple', { side: 'buy', commodity: 'ore', units: 20 });
    await sleep(900);

    record(
      'the hold the offers counter shows is the hold that was just bought',
      one.offers?.hold.some((row) => row.commodityId === 'ore' && row.units === 20) === true,
      one.offers?.hold.map((row) => `${row.commodityId} ${row.units}`).join(', ') || 'empty',
    );

    const beforeOne = one.purse?.marks ?? 0;
    const beforeTwo = two.purse?.marks ?? 0;

    await one.room.request('trade-offer', {
      callsign: 'Slack Water',
      marks: 4_000,
      cargo: [{ commodityId: 'ore', units: 20 }],
      design: '',
    });
    await sleep(900);

    record(
      'an offer reaches the captain it was made to, and reads from their side',
      two.offers?.offers.length === 1 && two.offers.offers[0]?.mine === false,
      two.offers ? `${two.offers.offers.length} open, mine=${String(two.offers.offers[0]?.mine)}` : 'no push',
    );

    record(
      'and stays on the offering captain’s screen as theirs',
      one.offers?.offers.length === 1 && one.offers.offers[0]?.mine === true,
      one.offers ? `${one.offers.offers.length} open, mine=${String(one.offers.offers[0]?.mine)}` : 'no push',
    );

    const notYours = await refusal(
      three.room.request('trade-answer', { id: two.offers?.offers[0]?.id ?? '', accept: true }),
    );
    record(
      'a captain it was not made to cannot take it',
      notYours === 'no-such-offer',
      notYours || 'it was allowed',
    );

    await two.room.request('trade-answer', { id: two.offers?.offers[0]?.id ?? '', accept: true });
    await sleep(1200);

    record(
      'taking it up moves the marks, both ways and in whole marks',
      (one.purse?.marks ?? 0) - beforeOne === 4_000 && beforeTwo - (two.purse?.marks ?? 0) === 4_000,
      `offerer ${(one.purse?.marks ?? 0) - beforeOne}, receiver ${beforeTwo - (two.purse?.marks ?? 0)}`,
    );

    record(
      'and moves the cargo with them',
      two.offers?.hold.some((row) => row.commodityId === 'ore' && row.units === 20) === true &&
        one.offers?.hold.some((row) => row.commodityId === 'ore') !== true,
      `receiver ${two.offers?.hold.map((r) => `${r.commodityId} ${r.units}`).join(', ') || 'empty'}; ` +
        `offerer ${one.offers?.hold.map((r) => `${r.commodityId} ${r.units}`).join(', ') || 'empty'}`,
    );

    record(
      'and closes it on both screens',
      one.offers?.offers.length === 0 && two.offers?.offers.length === 0,
      `${one.offers?.offers.length ?? -1} and ${two.offers?.offers.length ?? -1}`,
    );

    const gone = await refusal(
      two.room.request('trade-answer', { id: two.room.sessionId, accept: true }),
    );
    record('an offer cannot be taken twice', gone === 'no-such-offer', gone || 'it was allowed');

    // An offer to a captain who is not alongside anything.
    const underWay = await refusal(
      one.room.request('trade-offer', {
        callsign: 'Lee Helm',
        marks: 1,
        cargo: [],
        design: '',
      }),
    );
    if (underWay === '') {
      const theirOffer = one.offers?.offers.find((row) => row.to === 'Lee Helm')?.id ?? '';
      const refused = await refusal(
        three.room.request('trade-answer', { id: theirOffer, accept: true }),
      );
      record(
        'an offer cannot be taken up by a captain who is not alongside',
        refused === 'not-landed' || refused === 'not-at-the-same-berth',
        refused || 'it was allowed',
      );
    } else {
      record('an offer could be made to a captain under way', false, underWay);
    }

    // --- Leaving ---------------------------------------------------------

    await one.room.request('convoy-leave', { callsign: '' });
    await sleep(900);

    record(
      'the captain who opened it leaving dissolves it, on everybody’s screen',
      one.convoy?.id === '' && two.convoy?.id === '',
      `one "${one.convoy?.id ?? '?'}", two "${two.convoy?.id ?? '?'}"`,
    );

    record(
      'and takes the shared work off the other captain’s hands',
      two.commissions?.held.every((row) => row.holder === '') === true,
      two.commissions?.held.map((row) => row.holder || 'mine').join(', ') || 'nothing in hand',
    );

    await one.room.leave();
    await two.room.leave();
    await three.room.leave();
  } finally {
    await stopGroup(server, { timeoutMs: 5000 });
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.passed);
  console.log('\n=== M7: convoys and trade between captains ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
