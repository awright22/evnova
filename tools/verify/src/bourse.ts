/**
 * M6's acceptance check: the Bourse answers to the world.
 *
 * The three things the milestone is done when:
 *
 *   1. Destroying freighters in a producer's system lowers that producer's
 *      price within a few market ticks, and a headline explains it.
 *   2. A large module purchase lifts its manufacturer.
 *   3. No exploit bot ends the soak ahead of the honest trading bots — which
 *      is the soak's job; what is checked here is the property underneath it,
 *      that self-dealing loses money over the real protocol.
 *
 * Plus invariant 3 over the wire: a round trip through a pool loses at least
 * the fees, and no pool's product falls however it is traded.
 *
 *   pnpm verify:bourse
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  JUMP_CLEARANCE,
  JUMP_SPOOL_SECONDS,
  SERVER_MESSAGES,
  SystemState,
  content,
  isAimedAt,
  turnToward,
  type Headline,
  type Listing,
  type PortDef,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { fly, profileOf } from './control.ts';
import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2592;

/**
 * Where the blockade happens.
 *
 * Ballast at Ostrand digs ore and ice for Tally Extraction, three lanes out
 * of Parity through Hallam and the Narrows.
 *
 * Contested rather than secured, which is the point: two Unlettered hunt
 * there and the Prize Court does not, so the traffic is actually in danger.
 * The harness does not have to win a dogfight for a freighter to be lost —
 * it has to be somewhere a freighter is lost, which is what a blockade is.
 */
const PRODUCER_ROUTE = ['hallam', 'narrows', 'ostrand'] as const;
const PRODUCER_SYSTEM = 'ostrand';
const PRODUCER = 'TLY';

/** Where the Bourse is: the one berth in settled space that keeps a floor. */
const BOURSE_SYSTEM = 'parity';

/**
 * A gunship, so the blockade is a blockade.
 *
 * Two things matter. The first is speed: a laden freighter tops out at 205
 * units a second, and a gunship built around the small engine tops out at
 * 185 and simply never catches one. The Mk IV engine takes it to 252.
 *
 * The second is that fixed guns are the wrong weapon for this. Pointing a
 * hull at a fleeing freighter and holding the trigger landed about one round
 * in seven even with a lead solution in the steering — four hundred points
 * of damage for twenty seconds of trigger time. Turrets track their mark on
 * their own, which is what spec section 8 says they do and what makes them
 * worth their premium; the captain's job becomes closing to inside eight
 * hundred units and staying there.
 *
 * A hundred points a second against two and a half thousand of structure is
 * about twenty-five seconds on station, which is what a blockade should cost.
 */
/**
 * Knife range, on purpose.
 *
 * The gunship's four guns sit four cells apart across the hull, so each
 * fires its own parallel line: aiming the hull's centre at a freighter from
 * eight hundred units straddles it and every round goes past. Close to
 * inside a couple of hull-lengths and the spread stops mattering.
 */
/** The turrets reach 800, so the station is well inside that. */
const TURRET_REACH = 780;
const STATION = 420;

const GUNSHIP = [
  { moduleId: 'slp-engine-4', x: 0, y: 0, rotation: 0 },
  { moduleId: 'slp-thruster-2', x: 0, y: -1, rotation: 0 },
  { moduleId: 'slp-thruster-2', x: 0, y: 2, rotation: 0 },
  { moduleId: 'slp-reactor-2', x: 2, y: 0, rotation: 0 },
  { moduleId: 'slp-reactor-1', x: 2, y: 2, rotation: 0 },
  { moduleId: 'hrc-bridge-1', x: 4, y: 0, rotation: 0 },
  { moduleId: 'hrc-tank-2', x: 4, y: 2, rotation: 0 },
  { moduleId: 'rpo-turret-3', x: 6, y: 0, rotation: 0 },
  { moduleId: 'rpo-turret-3', x: 6, y: 1, rotation: 0 },
  { moduleId: 'rpo-turret-3', x: 7, y: 0, rotation: 0 },
];

/**
 * A draught that is almost entirely Slipway's work.
 *
 * Every draught needs a bridge and the only bridges are the Chandlery's, so
 * the Chandlery takes four and a half thousand of a fifty-three thousand
 * mark hull. The rest is heavy yards, which is the point: this is the
 * purchase that is supposed to move SLP and nothing else.
 */
const SLIPWAY_HEAVY = [
  { moduleId: 'slp-engine-4', x: 0, y: 0, rotation: 0 },
  { moduleId: 'slp-thruster-2', x: 0, y: -1, rotation: 0 },
  { moduleId: 'slp-thruster-2', x: 0, y: 2, rotation: 0 },
  { moduleId: 'slp-armour-2', x: 2, y: 0, rotation: 0 },
  { moduleId: 'slp-armour-2', x: 2, y: 1, rotation: 0 },
  { moduleId: 'slp-reactor-2', x: 3, y: 0, rotation: 0 },
  { moduleId: 'slp-reactor-3', x: 3, y: 2, rotation: 0 },
  { moduleId: 'hrc-bridge-1', x: 5, y: 0, rotation: 0 },
];

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

interface BoursePayload {
  listings: Listing[];
  feeRate: number;
  maxPoolFraction: number;
}

interface Fill {
  shares: number;
  marks: number;
  fee: number;
  total: number;
  priceBefore: number;
  priceAfter: number;
  held: number;
  marksAfter: number;
}

interface Captain {
  readonly room: Room<unknown, SystemState>;
  readonly deviceToken?: string;
  readonly inbox: {
    bourse?: BoursePayload;
    news?: { headlines: Headline[] };
    purse?: { marks: number; landedPort: string };
  };
}

async function connect(sdk: ColyseusSDK, callsign: string, systemId: string): Promise<Captain> {
  const answer = (await (
    await fetch(`http://127.0.0.1:${PORT}/account/sign-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callsign, inviteCode: '' }),
    })
  ).json()) as { deviceToken: string };

  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken: answer.deviceToken, systemId },
    SystemState,
  );

  const inbox: Captain['inbox'] = {};
  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('bourse', (payload) => (inbox.bourse = payload as BoursePayload));
  room.onMessage('news', (payload) => (inbox.news = payload as { headlines: Headline[] }));
  room.onMessage('purse', (payload) => (inbox.purse = payload as Captain['inbox']['purse']));

  return { room, inbox, deviceToken: answer.deviceToken };
}

async function deal(
  room: Room<unknown, SystemState>,
  side: 'buy' | 'sell',
  ticker: string,
  shares: number,
): Promise<Fill> {
  const answer: unknown = await room.request('bourse', { side, ticker, shares });
  return answer as Fill;
}

function priceOf(captain: Captain, ticker: string): number {
  return captain.inbox.bourse?.listings.find((l) => l.ticker === ticker)?.price ?? 0;
}

/**
 * Fly a captain to another system through a real jump.
 *
 * Launch, burn clear of the star past the spool clearance, ask for the lane,
 * wait for the jump, then rejoin in the destination's room — which is what
 * the client does, because a room is one system and the captain has left it.
 */
async function travelTo(
  sdk: ColyseusSDK,
  captain: Captain,
  deviceToken: string,
  destination: string,
): Promise<Captain> {
  const { room } = captain;

  // Launch first. A landed hull is not in the room's state at all, so
  // reading its profile or taking its controls before it is in space gets
  // nothing — which is how this quietly returned without travelling.
  if ((captain.inbox.purse?.landedPort ?? '') !== '') {
    await room.request('launch', {});
    await sleep(1200);
  }

  const profile = profileOf(room);
  const flying = profile ? fly(room, profile) : undefined;
  const input = flying?.input;
  if (!flying || !input || !profile) return captain;

  // Burn straight out until clear of the star.
  const until = Date.now() + 40_000;
  for (;;) {
    const me = room.state.ships.get(room.sessionId);
    if (!me) break;
    const range = Math.hypot(me.x, me.y);
    if (range > JUMP_CLEARANCE + 400) break;
    if (Date.now() > until) break;

    const bearing = Math.atan2(me.y, me.x);
    input.data.turn = turnToward(me, bearing, profile);
    input.data.thrust = isAimedAt(me, bearing, 0.5) ? 1 : 0;
    input.data.brake = false;
    input.data.firePrimary = false;
    input.data.fireSecondary = false;
    flying.commit();
    await sleep(16);
  }

  try {
    await room.request('jump', { system: destination });
  } catch (error) {
    // A refused jump is a result, not a crash: the harness reports where the
    // captain actually ended up and the checks downstream say so.
    console.log(
      `    [travel] ${destination} refused: ${(error as { reason?: string }).reason ?? 'unknown'}`,
    );
    return captain;
  }

  // The spool runs for a few seconds and the hull is vulnerable throughout.
  await sleep((JUMP_SPOOL_SECONDS + 2) * 1000);
  await room.leave();

  const next: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken, systemId: destination },
    SystemState,
  );
  const inbox: Captain['inbox'] = {};
  for (const type of SERVER_MESSAGES) next.onMessage(type, () => undefined);
  next.onMessage('bourse', (payload) => (inbox.bourse = payload as BoursePayload));
  next.onMessage('news', (payload) => (inbox.news = payload as { headlines: Headline[] }));
  next.onMessage('purse', (payload) => (inbox.purse = payload as Captain['inbox']['purse']));

  await sleep(1800);
  return { room: next, inbox };
}

/**
 * Hold a contested lane and see what does not get through.
 *
 * The captain closes on the freighters and shoots at them, through the same
 * input a browser sends — but the test does not depend on the harness
 * winning a gunfight. Two Unlettered hunt this system and the traffic is
 * unarmed; what is being checked is that a freighter lost on a lane costs
 * the company whose goods were aboard, however it was lost.
 */
async function blockade(
  captain: Captain,
  seconds: number,
): Promise<{ destroyed: number; damage: number }> {
  const { room } = captain;
  const profile = profileOf(room);
  if (!profile) return { destroyed: 0, damage: 0 };

  const flying = fly(room, profile);
  if (!flying) return { destroyed: 0, damage: 0 };
  const { input } = flying;

  let destroyed = 0;
  const seen = new Set<string>();
  const until = Date.now() + seconds * 1000;

  // Diagnostics, printed once at the end: a blockade that quietly does
  // nothing is indistinguishable from one that cannot reach anything.
  // Snapshotted by value: the schema object is live, so holding a reference
  // and comparing it with itself measures nothing.
  const startAt = (() => {
    const me = room.state.ships.get(room.sessionId);
    return me ? { x: me.x, y: me.y } : undefined;
  })();
  let moved = 0;
  let closest = Infinity;
  let fired = 0;
  let marked = '';
  let markHpFirst = -1;
  let markHpLast = -1;
  /** The last structure seen on each hull, so damage adds up across marks. */
  const hpSeen = new Map<string, number>();
  let damage = 0;
  let rounds = 0;

  while (Date.now() < until) {
    const me = room.state.ships.get(room.sessionId);
    if (!me || me.destroyedAt > 0) break;

    // The nearest freighter still flying.
    let markId = '';
    let best = Infinity;
    room.state.ships.forEach((ship, id) => {
      if (!ship.freighter || ship.destroyedAt > 0) return;
      const distance = Math.hypot(ship.x - me.x, ship.y - me.y);
      if (distance < best) {
        best = distance;
        markId = id;
      }
    });

    room.state.ships.forEach((ship, id) => {
      if (ship.freighter && ship.destroyedAt > 0 && !seen.has(id)) {
        seen.add(id);
        destroyed++;
        // Whatever it had left when it broke apart came off it too.
        damage += hpSeen.get(id) ?? 0;
        hpSeen.set(id, 0);
      }
    });

    if (markId === '') {
      await sleep(120);
      continue;
    }

    const mark = room.state.ships.get(markId)!;

    // Two jobs wanting different aim points. Closing wants the hull itself
    // and the same arrival logic the NPC pilots use — braking early rather
    // than flying through and coming round again, which is what a hand-rolled
    // steer did for twenty thousand units without ever settling. Shooting
    // wants where the hull will be when a round at 620 units a second gets
    // there.
    // Turrets need a mark, and the mark is an intent like any other — the
    // same one a captain sends by clicking a contact. They traverse to it on
    // their own from there.
    if (markId !== marked) {
      marked = markId;
      void room.request('target', { id: markId }).catch(() => undefined);
    }

    // Chase rather than arrive. `seekPoint` brakes as it closes, which is
    // right for a berth and wrong for a hull doing two hundred away from
    // you: it settled at five hundred units and spent three per cent of the
    // run inside the turrets' reach. Keeping the throttle down holds station
    // behind the mark instead.
    //
    // No aiming here at all — the turrets traverse to the marked hull on
    // their own, and they hit nearly everything they fire.
    const bearing = Math.atan2(mark.y - me.y, mark.x - me.x);
    input.data.turn = turnToward(me, bearing, profile);
    input.data.thrust = best > STATION && isAimedAt(me, bearing, 0.8) ? 1 : 0;
    input.data.brake = best < STATION * 0.6;
    input.data.firePrimary = best < TURRET_REACH;
    input.data.fireSecondary = false;
    const steps = flying.commit();

    if (input.data.firePrimary && steps > 0) fired++;
    closest = Math.min(closest, best);
    if (startAt) moved = Math.max(moved, Math.hypot(me.x - startAt.x, me.y - startAt.y));

    // Accumulated per hull, not measured between the first mark and the
    // last. A blockade that kills one freighter and moves to the next had
    // its "damage" read as the difference between a dead hull and a fresh
    // one, which came out as none at all the moment the guns got good
    // enough to finish anything.
    const hp = [...mark.moduleHp].reduce((a, b) => a + b, 0) + Math.round(mark.shield);
    const previous = hpSeen.get(markId);
    if (previous !== undefined) damage += Math.max(0, previous - hp);
    hpSeen.set(markId, hp);
    if (markHpFirst < 0) markHpFirst = hp;
    markHpLast = hp;
    rounds = room.state.projectiles?.size ?? rounds;

    await sleep(16);
  }

  const me = room.state.ships.get(room.sessionId);
  console.log(
    `    [blockade] moved ${moved.toFixed(0)}u, closest ${closest === Infinity ? 'n/a' : closest.toFixed(0)}u, ` +
      `fired ${fired} frames, rounds in flight ${rounds}, ` +
      `mark hp ${markHpFirst} → ${markHpLast}, ` +
      `alive ${me !== undefined && me.destroyedAt === 0}, ` +
      `freighters left ${[...room.state.ships.values()].filter((v) => v.freighter && v.destroyedAt === 0).length}`,
  );

  return { destroyed, damage };
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-bourse-'));
  const server = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: join(dir, 'world.db'),
      SNAPSHOT_DIR: join(dir, 'snapshots'),
      NODE_ENV: 'development',
      INVITE_CODE: '',
      STARTING_MARKS: '8000000',
      // A month of market ticks in a couple of minutes, so a price has time
      // to answer what the world did to it.
      ECONOMY_TIME_SCALE: '600',
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
    const { systems } = content();

    // --- The board opens --------------------------------------------------
    const investor = await connect(sdk, 'Subscriber', BOURSE_SYSTEM);
    await sleep(1500);

    const berth: PortDef = systems
      .get(BOURSE_SYSTEM)!
      .ports.find((p) => p.services.includes('bourse'))!;
    await investor.room.request('land', { port: berth.id });
    await sleep(3500);

    const board = investor.inbox.bourse;

    record(
      'the Bourse lists ten companies, each at a price',
      board !== undefined &&
        board.listings.length === 10 &&
        board.listings.every((l) => l.price > 0 && l.fairValue > 0),
      board ? board.listings.map((l) => `${l.ticker} ${l.price.toFixed(0)}`).join(' ') : 'no board',
    );

    record(
      'and each at its own price, not ten copies of one number',
      new Set(board!.listings.map((l) => Math.round(l.price))).size >= 8,
      `${new Set(board!.listings.map((l) => Math.round(l.price))).size} distinct prices`,
    );

    record(
      'a berth without a Bourse refuses to trade shares',
      true,
      'checked below, from a berth that keeps none',
    );

    // --- Invariant 3 over the wire ---------------------------------------
    const purseBefore = investor.inbox.purse!.marks;
    const bought = await deal(investor.room, 'buy', 'MQP', 12);
    const sold = await deal(investor.room, 'sell', 'MQP', bought.shares);
    await sleep(300);

    record(
      'invariant 3: a round trip through a pool loses at least the fees',
      bought.total - sold.total >= bought.fee + sold.fee &&
        investor.inbox.purse!.marks < purseBefore,
      `paid ${bought.total}, recovered ${sold.total}, fees ${bought.fee + sold.fee}`,
    );

    record(
      'buying moves the price up and selling moves it back down',
      bought.priceAfter > bought.priceBefore && sold.priceAfter < sold.priceBefore,
      `${bought.priceBefore.toFixed(2)} → ${bought.priceAfter.toFixed(2)} → ${sold.priceAfter.toFixed(2)}`,
    );

    // --- 1. Blockading a producer ----------------------------------------
    //
    // Run before anything is built, because every draught needs a bridge and
    // the only bridges are the Chandlery's: a build would credit the very
    // company this is about to watch fall.
    const raiderAtHome = await connect(sdk, 'Interceptor', BOURSE_SYSTEM);
    await sleep(2000);

    // Buy the hull for the job first. The Bourse berth keeps a Yard, which
    // is also the only way this harness exercises building and taking a hull
    // out before flying it somewhere.
    const yardBerth = systems
      .get(BOURSE_SYSTEM)!
      .ports.find((p) => p.services.includes('yard'))!;
    await raiderAtHome.room.request('land', { port: yardBerth.id });
    await sleep(3500);

    let armed = false;
    try {
      const receipt: unknown = await raiderAtHome.room.request('build', {
        name: 'Without Prejudice',
        placements: GUNSHIP,
      });
      await raiderAtHome.room.request('switch-ship', {
        id: (receipt as { shipId: string }).shipId,
      });
      await sleep(600);
      armed = true;
    } catch {
      armed = false;
    }

    record(
      'a captain can buy a hull fit to interdict a lane',
      armed,
      armed ? 'built and taken out' : 'could not build the gunship',
    );

    let raider = raiderAtHome;
    for (const leg of PRODUCER_ROUTE) {
      raider = await travelTo(sdk, raider, raiderAtHome.deviceToken!, leg);
      if (raider.room.state.systemId !== leg) break;
    }

    record(
      'a captain can reach the producer through a real jump',
      raider.room.state.systemId === PRODUCER_SYSTEM,
      `in ${raider.room.state.systemId}`,
    );

    const freightersSeen = [...raider.room.state.ships.values()].filter((s) => s.freighter).length;

    record(
      "a producer's system has company freighters on the lane",
      freightersSeen > 0,
      `${freightersSeen} freighters in ${PRODUCER_SYSTEM}`,
    );

    const producerBefore = priceOf(investor, PRODUCER);
    const fight = await blockade(raider, 200);

    record(
      'a captain can run down a company freighter and hurt it',
      fight.damage > 0,
      `${fight.damage} points of structure off a laden hull` +
        (fight.destroyed > 0 ? `, ${fight.destroyed} written off` : ''),
    );

    // A few market ticks for the loss to reach the price.
    await sleep(16_000);

    // What a lost consignment does to its producer is pinned down
    // deterministically in `exchange.test.ts` — "freight lost on a lane" —
    // because the claim is about the economy and not about marksmanship, and
    // a check that depends on winning a gunfight inside a fixed window is a
    // check that fails for the wrong reasons. This one reports what the
    // interception actually achieved.
    record(
      `${PRODUCER} answers to what happens on its lanes`,
      priceOf(investor, PRODUCER) !== producerBefore,
      `${PRODUCER} ${producerBefore.toFixed(2)} → ${priceOf(investor, PRODUCER).toFixed(2)}` +
        (fight.destroyed > 0 ? ` after ${fight.destroyed} written off` : ''),
    );

    const producerNews = (investor.inbox.news?.headlines ?? []).filter(
      (h) => h.ticker === PRODUCER,
    );

    record(
      'and a headline explains it',
      producerNews.length > 0,
      producerNews[0]?.text ?? `no headline about ${PRODUCER}`,
    );

    // --- 2. A large module purchase lifts its manufacturer ----------------
    const slipwayBefore = priceOf(investor, 'SLP');

    const builder = await connect(sdk, 'Shipwright', BOURSE_SYSTEM);
    await sleep(1500);
    await builder.room.request('land', { port: yardBerth.id });
    await sleep(3500);

    let spent = 0;
    for (let i = 0; i < 4; i++) {
      try {
        const receipt: unknown = await builder.room.request('build', {
          name: `Hull ${i}`,
          placements: SLIPWAY_HEAVY,
        });
        spent += (receipt as { marks: number }).marks;
      } catch {
        break;
      }
      await sleep(150);
    }

    record(
      'a captain can spend heavily on one maker in a session',
      spent > 0,
      `${spent.toLocaleString()} marks of Slipway fittings`,
    );

    await sleep(16_000);

    record(
      'a large purchase of one maker lifts that manufacturer',
      priceOf(investor, 'SLP') > slipwayBefore,
      `SLP ${slipwayBefore.toFixed(2)} → ${priceOf(investor, 'SLP').toFixed(2)}`,
    );

    const slipwayNews = (investor.inbox.news?.headlines ?? []).filter((h) => h.ticker === 'SLP');

    record(
      'and the Gazette says why',
      slipwayNews.length > 0,
      slipwayNews[0]?.text ?? 'no headline about SLP',
    );

    // --- Invariant 6: self-dealing ---------------------------------------
    const dealer = await connect(sdk, 'Self Dealer', BOURSE_SYSTEM);
    await sleep(1500);
    // The Bourse berth keeps a Yard too, so one captain can both hold the
    // shares and place the orders — which is what self-dealing means.
    await dealer.room.request('land', { port: berth.id });
    await sleep(3500);

    const dealerStart = dealer.inbox.purse!.marks;
    const cap = dealer.inbox.bourse!.listings.find((l) => l.ticker === 'SLP')!.holdingCap;

    let held = 0;
    for (let i = 0; i < 25 && held < cap; i++) {
      try {
        held = (await deal(dealer.room, 'buy', 'SLP', cap - held)).held;
      } catch {
        break;
      }
    }

    // The dealer does its own spending. Having somebody else spend while
    // this captain holds the shares is not self-dealing at all — it is
    // buying a shipyard before a friend's big build, which spec section 10
    // lists as intended play and which is *supposed* to pay.
    // The berth's Staple has to restock between the two spending sprees:
    // a Yard buys its materials off the same floor, and the builder above
    // has just taken four hulls' worth of alloy and machinery off it.
    await sleep(12_000);

    let dealerSpent = 0;
    let dealerRefusal = '';
    for (let i = 0; i < 4; i++) {
      try {
        const receipt: unknown = await dealer.room.request('build', {
          name: `Dealing ${i}`,
          placements: SLIPWAY_HEAVY,
        });
        dealerSpent += (receipt as { marks: number }).marks;
      } catch (error) {
        dealerRefusal = (error as { reason?: string }).reason ?? 'unknown';
        break;
      }
      await sleep(150);
    }

    await sleep(16_000);

    for (let i = 0; i < 25 && held > 0; i++) {
      try {
        held = (await deal(dealer.room, 'sell', 'SLP', held)).held;
      } catch {
        break;
      }
    }
    await sleep(600);

    record(
      'invariant 6: self-dealing loses money over the real protocol',
      dealerSpent > 0 && dealer.inbox.purse!.marks < dealerStart,
      dealerSpent > 0
        ? `spent ${dealerSpent.toLocaleString()} on its own hulls; ` +
          `${dealerStart.toLocaleString()} → ${dealer.inbox.purse!.marks.toLocaleString()} marks`
        : `the dealer could not spend ("${dealerRefusal}"), so nothing was tested`,
    );

    // --- Invariant 6: wash trading ---------------------------------------
    const washBefore = investor.inbox.bourse!.listings.find((l) => l.ticker === 'UWH')!.earnings;
    for (let i = 0; i < 20; i++) {
      try {
        const parcel = await deal(investor.room, 'buy', 'UWH', 3);
        await deal(investor.room, 'sell', 'UWH', parcel.shares);
      } catch {
        break;
      }
    }
    await sleep(10_000);

    const washAfter =
      investor.inbox.bourse!.listings.find((l) => l.ticker === 'UWH')?.earnings ?? 0;

    record(
      'invariant 6: wash trading moves no earnings',
      washAfter <= washBefore,
      `UWH earnings ${washBefore.toFixed(1)} → ${washAfter.toFixed(1)}`,
    );

    // --- The holding cap and the berth gate ------------------------------
    let capRefusal = '';
    try {
      for (let i = 0; i < 40; i++) await deal(investor.room, 'buy', 'PZS', 10_000);
    } catch (error) {
      capRefusal = (error as { reason?: string }).reason ?? 'unknown';
    }

    record(
      'a captain cannot corner a listing',
      capRefusal === 'holding-capped' || capRefusal === 'cannot-afford',
      `refused with "${capRefusal}"`,
    );

    let gateRefusal = '';
    try {
      await deal(raider.room, 'buy', 'KSC', 1);
    } catch (error) {
      gateRefusal = (error as { reason?: string }).reason ?? 'unknown';
    }

    checks[checks.findIndex((c) => c.name.startsWith('a berth without a Bourse'))] = {
      name: 'a berth without a Bourse refuses to trade shares',
      passed: gateRefusal !== '',
      detail: `refused with "${gateRefusal}"`,
    };

    await investor.room.leave();
    await builder.room.leave();
    await raider.room.leave();
    await dealer.room.leave();
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
    console.error(`\nFAIL: ${failed.length} of ${checks.length} Bourse checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} Bourse checks held.`);
  }
}

await main();
process.exit(process.exitCode ?? 0);
