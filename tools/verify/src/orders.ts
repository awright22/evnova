/**
 * M8's check for standing orders and short selling.
 *
 * A limit order on a constant-product pool is not a resting order anybody
 * crosses: it is an instruction the Bourse carries out on each market tick,
 * walking the curve as far as the limit allows and no further. A short is
 * borrowing, held to a margin, and closed out by the Bourse itself when the
 * margin goes — which has to happen whether or not the captain is there.
 *
 * None of that can be proved by a unit test: every piece of it is the market
 * tick, the ledger and the captain's row agreeing across several seconds of
 * world time. The clock is run at six hundred times, so a twenty-second
 * market tick comes round every thirty milliseconds.
 *
 *   pnpm verify:orders
 */

import { ColyseusSDK, type Room } from '@colyseus/sdk';
import {
  SERVER_MESSAGES,
  SystemState,
  loadContent,
  type Listing,
  type MarginState,
  type OrderLine,
  type PlaceOrderIntent,
} from '@marque/shared';
import { requirePortFree, spawnGroup, stopGroup } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { REPO_ROOT, sleep } from './harness.ts';

const PORT = 2598;

/** The one berth with a Bourse, a Staple and a Yard in the same hall. */
const BERTH = 'the-bourse';
const SYSTEM = 'parity';

/** A listing to trade. Kessler Carriage, which earns on freight. */
const TICKER = 'KSC';

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
  landedPort: string;
}

interface Board {
  listings: Listing[];
  orders: OrderLine[];
  margin: MarginState;
}

interface Captain {
  readonly room: Room<unknown, SystemState>;
  purse: Purse | undefined;
  board: Board | undefined;
  /** Every `order` push, in order: fills and liquidations arrive here. */
  readonly told: { kind: string; ticker: string; shares: number; total: number }[];
  /**
   * Marks that arrived for reasons that have nothing to do with an order.
   *
   * The Bourse pays dividends on the world's clock, and this harness runs
   * the world at six hundred times, so a captain who holds eight shares for
   * a second of wall clock is paid several times over. Netting these out is
   * the difference between checking that an order cost what it said and
   * checking that nothing else happened to the captain meanwhile — and the
   * second is not a thing a market is supposed to guarantee.
   */
  dividends: number;
}

async function connect(
  sdk: ColyseusSDK,
  deviceToken: string,
): Promise<Captain> {
  const room: Room<unknown, SystemState> = await sdk.joinOrCreate<SystemState>(
    'system',
    { deviceToken, systemId: SYSTEM },
    SystemState,
  );

  const captain: Captain = { room, purse: undefined, board: undefined, told: [], dividends: 0 };

  for (const type of SERVER_MESSAGES) room.onMessage(type, () => undefined);
  room.onMessage('purse', (payload) => (captain.purse = payload as Purse));
  room.onMessage('bourse', (payload) => (captain.board = payload as Board));
  room.onMessage('order', (payload) =>
    captain.told.push(payload as { kind: string; ticker: string; shares: number; total: number }),
  );
  room.onMessage(
    'dividend',
    (payload) => (captain.dividends += (payload as { marks: number }).marks),
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

/** The listing as this captain last saw it. */
function quoteOf(captain: Captain): Listing | undefined {
  return captain.board?.listings.find((row) => row.ticker === TICKER);
}

/** One of their orders, by id. */
function orderOf(captain: Captain, id: string): OrderLine | undefined {
  return captain.board?.orders.find((row) => row.id === id);
}

/** Wait until a condition holds, or give up. Market ticks arrive fast here. */
async function until(
  holds: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holds()) return true;
    await sleep(60);
  }
  return holds();
}

async function main(): Promise<void> {
  await requirePortFree(PORT, 'a game server');

  const dir = mkdtempSync(join(tmpdir(), 'marque-orders-'));
  const worldEnv = {
    PORT: String(PORT),
    DATABASE_URL: join(dir, 'world.db'),
    SNAPSHOT_DIR: join(dir, 'snapshots'),
    NODE_ENV: 'development',
    INVITE_CODE: '',
    STARTING_SYSTEM: SYSTEM,
    STARTING_MARKS: '2000000',
    // A market tick every thirty milliseconds of real time, so an order that
    // waits for the next one waits for the next frame.
    // Fast enough that an order fills while a harness is watching, slow
    // enough that the harness can see it happen.
    //
    // At 600 a market tick lands every 33ms, and a short opened against a
    // moving price was filled, carried, margin-called and bought back inside
    // one 15-second window — so `until(held < 0)` looked, found nothing, and
    // reported a position that had never been carried. A tick every third of
    // a second still gives dozens of ticks per check.
    ECONOMY_TIME_SCALE: '60',
  };

  const tokens = await runSeed(
    [
      { callsign: 'Limit Order', at: BERTH },
      // A thin purse on purpose: margin is only a rule where it binds, and
      // against two million marks a short of the largest position the cap
      // allows is still covered many times over.
      { callsign: 'Short Measure', at: BERTH, marks: 3000 },
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
    const trader = await connect(sdk, tokens['Limit Order']!);
    const bear = await connect(sdk, tokens['Short Measure']!);
    await sleep(800);

    await refusal(trader.room.request('land', { port: BERTH }));
    await refusal(bear.room.request('land', { port: BERTH }));
    await sleep(2500);

    record(
      'both captains are alongside the berth that keeps a Bourse',
      trader.purse?.landedPort === BERTH && bear.purse?.landedPort === BERTH,
      `${trader.purse?.landedPort ?? 'nowhere'} and ${bear.purse?.landedPort ?? 'nowhere'}`,
    );

    const opening = quoteOf(trader);
    record(
      'and the board quotes the listing they are going to trade',
      opening !== undefined && opening.price > 0,
      `${TICKER} at ${opening?.price.toFixed(2) ?? 'nothing'}`,
    );
    if (!opening) throw new Error('no quote to trade against');

    // --- An order the price has not come to -----------------------------

    const low = Number(((quoteOf(trader)?.price ?? opening.price) * 0.5).toFixed(2));
    const resting = await trader.room.request<PlaceOrderIntent, OrderLine>('place-order', {
      side: 'buy',
      ticker: TICKER,
      shares: 50,
      limit: low,
    });

    record(
      'an order can be left with the Bourse without anything being charged',
      resting.state === 'open' && resting.shares === 50,
      `${resting.shares} ${TICKER} at ${resting.limit}`,
    );

    const marksAfterPlacing = trader.purse?.marks ?? 0;
    await sleep(1200);
    record(
      'and it waits, because the price is nowhere near it',
      orderOf(trader, resting.id)?.state === 'open' &&
        orderOf(trader, resting.id)?.filled === 0,
      `after many market ticks: ${orderOf(trader, resting.id)?.state ?? 'gone'}, ` +
        `${orderOf(trader, resting.id)?.filled ?? 0} filled`,
    );

    record(
      'and nothing is held back while it waits',
      (trader.purse?.marks ?? 0) === marksAfterPlacing,
      `${marksAfterPlacing} marks, unchanged`,
    );

    const withdrawn = await refusal(
      trader.room.request('cancel-order', { id: resting.id }),
    );
    record('it can be withdrawn', withdrawn === '', withdrawn || 'withdrawn');
    record(
      'and withdrawing it twice is refused',
      (await refusal(trader.room.request('cancel-order', { id: resting.id }))) ===
        'no-such-order',
      'the second withdrawal',
    );

    // --- An order the price has already passed ---------------------------

    const marksBefore = trader.purse?.marks ?? 0;
    const high = Number(((quoteOf(trader)?.price ?? opening.price) * 1.02).toFixed(2));
    const filling = await trader.room.request<PlaceOrderIntent, OrderLine>('place-order', {
      side: 'buy',
      ticker: TICKER,
      shares: 2_000_000,
      limit: high,
    });

    const moved = await until(() => (orderOf(trader, filling.id)?.filled ?? 0) > 0, 15_000);
    const after = orderOf(trader, filling.id);
    record(
      'an order whose limit the price has already passed fills on the next tick',
      moved && (after?.filled ?? 0) > 0,
      `${after?.filled ?? 0} of ${filling.shares} filled`,
    );

    record(
      'and it fills only as far as the limit, leaving the rest standing',
      after !== undefined && after.filled > 0 && after.shares > 0 && after.state === 'open',
      `${after?.filled ?? 0} filled, ${after?.shares ?? 0} still wanted, ` +
        `quote now ${quoteOf(trader)?.price.toFixed(2) ?? '?'} against a limit of ${high}`,
    );

    // What the order paid, not where the market has got to since.
    //
    // This used to read the live quote, which at six hundred times the
    // world's clock is a different market by the time it is read: KSC opens
    // at 8.20, the limit is set at 8.36, eight shares fill, and the house
    // trader then walks the quote to 19.95 on its own while the rest of the
    // order sits unfilled because the limit is binding exactly as it should.
    // The check was reporting the house trader's work as a limit violation.
    //
    // The limit is a promise about the price the captain pays, so that is
    // what is measured: settled marks over shares filled, which carries the
    // Bourse's fee on top and is rounded up per fill.
    // Reckoned in whole marks, because that is the only kind there are.
    //
    // Eight shares at a limit of 8.36 is 66.88, and a pool that cannot
    // charge fractions charges 67, then a mark of fee on top: 8.5 a share
    // against a limit of 8.36. Comparing an average price to the limit calls
    // that a violation. Comparing what was settled against what the limit
    // permits once everything is rounded up does not, and is the same
    // statement about the same promise.
    const feeRate = loadContent().tuning.exchange.feeRate;
    const filledShares = after?.filled ?? 0;
    // Rounding is charged per fill, not per order: an order that fills over
    // nine market ticks rounds its principal up nine times and its fee up
    // nine times. Two marks of slack a fill covers both.
    const ticksFilled = trader.told.filter(
      (line) => line.kind === 'filled' && line.ticker === TICKER,
    ).length;
    const permitted =
      Math.ceil(high * filledShares * (1 + feeRate)) + 2 * Math.max(1, ticksFilled);
    record(
      'and it paid no more than the limit, fee and rounding included',
      filledShares > 0 && (after?.settled ?? 0) <= permitted,
      `${after?.settled ?? 0} marks for ${filledShares} shares over ${ticksFilled} fill(s) ` +
        `against ${permitted} permitted at a limit of ${high} plus a ` +
        `${(feeRate * 100).toFixed(1)}% fee; quote now ` +
        `${quoteOf(trader)?.price.toFixed(2) ?? '?'}`,
    );

    // Withdrawn before the purse is counted: the order goes on filling every
    // tick, so `settled` is a moving figure and comparing it against a purse
    // read a moment later compares two different instants.
    await refusal(trader.room.request('cancel-order', { id: filling.id }));
    await sleep(1200);
    const settled = orderOf(trader, filling.id);

    // Every figure that bears on this, not just the two that disagree. A
    // mismatch here is either a ledger fault or a reading taken at the wrong
    // instant, and "58 against 68" cannot tell you which.
    const fillNotices = trader.told.filter(
      (line) => line.kind === 'filled' && line.ticker === TICKER,
    );
    const noticed = fillNotices.reduce((sum, line) => sum + line.total, 0);
    const gone = marksBefore - (trader.purse?.marks ?? 0);
    // The shares bought start earning the moment they are held, and the
    // world is running at six hundred times, so by the time the purse is
    // read the Bourse has already paid on them. That is income, not a
    // discount on the order: net it out and the two figures are the same.
    const cost = gone + trader.dividends;
    record(
      'the marks it cost actually left the purse',
      (trader.purse?.marks ?? 0) < marksBefore && cost === (settled?.settled ?? -1),
      `${gone} marks gone (${marksBefore} to ${trader.purse?.marks ?? 0}) plus ` +
        `${trader.dividends} paid back as dividends is ${cost}, against ` +
        `${settled?.settled ?? 0} settled over ${settled?.filled ?? 0} shares; ` +
        `${fillNotices.length} fill notice(s) totalling ${noticed}`,
    );

    record(
      'and the shares it bought are on the captain’s books',
      (quoteOf(trader)?.held ?? 0) === (settled?.filled ?? -1),
      `${quoteOf(trader)?.held ?? 0} held against ${settled?.filled ?? 0} filled`,
    );

    record(
      'the captain is told what the floor did for them',
      trader.told.some((line) => line.kind === 'filled' && line.ticker === TICKER),
      trader.told.map((line) => `${line.kind} ${line.shares}`).join(', ') || 'nothing said',
    );

    // --- Selling short ---------------------------------------------------

    const bearQuote = quoteOf(bear);
    record(
      'a captain holding nothing cannot simply sell',
      (await refusal(
        bear.room.request('bourse', { side: 'sell', ticker: TICKER, shares: 10 }),
      )) === 'not-holding',
      `holding ${bearQuote?.held ?? 0}`,
    );

    // The whole of what the cap allows, which is far more than this purse
    // could ever buy back. The order is accepted — leaving one always is —
    // and the Bourse refuses to carry it out, which is where the margin
    // actually bites.
    const cap = bearQuote?.holdingCap ?? 0;
    // The quote read fresh. The world runs at six hundred times here, so a
    // price taken thirty seconds of wall clock ago is five hours old and the
    // first version of this set its limits against a market that had moved.
    const overreach = await bear.room.request<PlaceOrderIntent, OrderLine>('place-order', {
      side: 'sell',
      ticker: TICKER,
      shares: cap,
      limit: Number(((quoteOf(bear)?.price ?? 1) * 0.5).toFixed(2)),
      short: true,
    });

    const stopped = await until(
      () => orderOf(bear, overreach.id)?.state === 'cancelled',
      15_000,
    );
    const refused = orderOf(bear, overreach.id);
    record(
      'and a short with nothing standing behind it is refused by the Bourse',
      stopped && refused?.reason === 'Not enough margin behind it',
      `${cap} shares at ${bearQuote?.price.toFixed(2) ?? '?'} against a purse of ` +
        `${bear.purse?.marks ?? 0}: ${refused?.state ?? 'gone'}` +
        `${refused?.reason ? ` (${refused.reason})` : ''}`,
    );

    record(
      'and nothing of it went through',
      (quoteOf(bear)?.held ?? 0) === 0 && (refused?.filled ?? -1) === 0,
      `${quoteOf(bear)?.held ?? 0} on the books, ${refused?.filled ?? 0} filled`,
    );

    const purseBefore = bear.purse?.marks ?? 0;

    // A short this purse can carry, worked out from what the Bourse says it
    // wants rather than from a fixed slice of the holding cap.
    //
    // The fixed slice was 30% of the cap, which is a number that only works
    // at the price the fixture was written against. KSC opens at 8.20 and
    // the house trader walks it to 19.95 before this runs, at which point
    // 30% of a 1,000-share cap wants 2,992 marks of margin against a purse
    // of 2,975 and the Bourse refuses — correctly, and for a reason that has
    // nothing to do with what this check is about.
    //
    // Eight tenths of the largest short the equity covers: comfortably
    // inside the initial margin, and still large enough that the cargo
    // purchase further down takes the captain through the maintenance line,
    // which is what the liquidation checks need.
    const live = quoteOf(bear)?.price ?? 1;
    const initial = bear.board?.margin.initial ?? 0.5;
    const equity = bear.board?.margin.equity ?? purseBefore;
    const covers = Math.floor(equity / Math.max(0.01, live * initial));
    const size = Math.max(1, Math.min(cap, Math.floor(covers * 0.8)));
    console.log(
      `    [short] ${size} shares at ${live.toFixed(2)}: wants ` +
        `${Math.ceil(size * live * initial)} of ${equity} equity at an initial of ${initial}`,
    );
    const shortOrder = await bear.room.request<PlaceOrderIntent, OrderLine>('place-order', {
      side: 'sell',
      ticker: TICKER,
      shares: size,
      limit: Number(((quoteOf(bear)?.price ?? 1) * 0.8).toFixed(2)),
      short: true,
    });

    const sold = await until(() => (quoteOf(bear)?.held ?? 0) < 0, 15_000);
    const shortLine = orderOf(bear, shortOrder.id);
    record(
      'but a short the purse does cover goes through, and fills like any order',
      sold,
      `${shortLine?.filled ?? 0} sold short; the order reads ` +
        `${shortLine?.state ?? 'gone'}${shortLine?.reason ? ` (${shortLine.reason})` : ''}`,
    );

    record(
      'the position is carried against them',
      (quoteOf(bear)?.held ?? 0) < 0,
      `${quoteOf(bear)?.held ?? 0} on the books`,
    );

    record(
      'and the proceeds are in their purse',
      (bear.purse?.marks ?? 0) > purseBefore,
      `${purseBefore} marks before, ${bear.purse?.marks ?? 0} after`,
    );

    record(
      'the Bourse shows what the short is worth and what stands behind it',
      (bear.board?.margin.owed ?? 0) > 0 && (bear.board?.margin.equity ?? 0) > 0,
      `equity ${bear.board?.margin.equity ?? 0} against ${bear.board?.margin.owed ?? 0} owed, ` +
        `wanted at ${bear.board?.margin.initial ?? 0} and closed out at ` +
        `${bear.board?.margin.maintenance ?? 0}`,
    );

    await refusal(bear.room.request('cancel-order', { id: shortOrder.id }));

    // --- The margin goes --------------------------------------------------

    // The Bourse can only see what is on its own books: marks, and shares.
    // A captain who takes the proceeds of a short and puts them into a hold
    // has the same net worth and nothing left to answer the short with,
    // which is exactly what a maintenance level is for. Leaf is the dearest
    // thing a Staple sells, so a hold of it absorbs a purse quickly.
    const owedBefore = -(quoteOf(bear)?.held ?? 0);
    const spentFrom = bear.purse?.marks ?? 0;
    for (let i = 0; i < 8; i++) {
      await refusal(bear.room.request('staple', { side: 'buy', commodity: 'leaf', units: 4 }));
      await sleep(80);
      if ((bear.purse?.marks ?? 0) < 400) break;
    }
    record(
      'a captain can tie their marks up in cargo while they are short',
      (bear.purse?.marks ?? 0) < spentFrom,
      `${spentFrom} marks before the hold was filled, ${bear.purse?.marks ?? 0} after`,
    );

    const closed = await until(
      () => bear.told.some((line) => line.kind === 'liquidated'),
      25_000,
    );
    record(
      'and a short with nothing left behind it is closed out by the Bourse itself',
      closed,
      bear.told
        .filter((line) => line.kind === 'liquidated')
        .map((line) => `${line.shares} bought back for ${line.total}`)
        .join('; ') || 'never closed',
    );

    record(
      'and the position is smaller than it was',
      -(quoteOf(bear)?.held ?? 0) < owedBefore,
      `${owedBefore} owed before, ${-(quoteOf(bear)?.held ?? 0)} after`,
    );

    record(
      'the captain is never left owing marks they do not have',
      (bear.purse?.marks ?? -1) >= 0,
      `${bear.purse?.marks ?? -1} marks`,
    );

    await Promise.all([trader.room.leave(), bear.room.leave()]);
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
  console.log('\n=== M8: standing orders and selling short ===\n');
  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
