/**
 * Soak run.
 *
 * Starts a server, flies a fleet of bots against it through the real protocol,
 * and writes a report to `artifacts/soak/`. The report is the artifact: it is
 * what says whether the world holds together under load.
 *
 *   pnpm sim
 *   pnpm sim -- --bots 12 --minutes 5 --latency 150
 *
 * The economy sections arrive with the systems they measure: the ledger and
 * commodity prices in M4, the exchange in M6. The report names them as not yet
 * measured rather than omitting them, so a reader can tell the difference
 * between "stable" and "not yet checked".
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Bot, type BotBrain, type BotTelemetry } from '@marque/bot/bot.ts';
import { circleBrain } from '@marque/bot/brains/circle.ts';
import { fighterBrain } from '@marque/bot/brains/fighter.ts';
import { exploiterBrain } from '@marque/bot/brains/exploiter.ts';
import { investorBrain } from '@marque/bot/brains/investor.ts';
import { factorBrain } from '@marque/bot/brains/factor.ts';
import { traderBrain } from '@marque/bot/brains/trader.ts';
import { wanderBrain } from '@marque/bot/brains/wander.ts';
import { TICK_RATE, content } from '@marque/shared';

import { requirePortFree } from '@marque/harness';

import {
  fetchEconomy,
  fetchMetrics,
  startServer,
  type EconomyReport,
  type ServerMetrics,
} from './server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

interface Options {
  bots: number;
  minutes: number;
  latency: number;
  /** Fraction of each bot's input frames to hold back a step, 0 to 1. */
  loss: number;
  port: number;
  outDir: string;
  fight: boolean;
  trade: boolean;
  invest: boolean;
  /** Bots that work the Factor's board instead of trading on their own account. */
  factor: boolean;
  economyTimeScale: number;
  warmupSeconds: number;
  startingSystem: string;
  restSeconds: number;
}

/**
 * Arguments after the runner's own. `pnpm run x -- --flag` forwards the bare
 * `--` separator too, and Node's parseArgs reads it as end-of-options, so it is
 * dropped here.
 */
function cliArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--');
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      bots: { type: 'string', default: '10' },
      minutes: { type: 'string', default: '2' },
      latency: { type: 'string', default: '150' },
      // Spec section 3 budgets no visible rubber-banding at 150ms and 2%
      // packet loss. `Bot`'s own comment says what this models: a WebSocket
      // runs over TCP, so a lost packet is a retransmission and everything
      // behind it waits. Head-of-line blocking, not a lost message.
      loss: { type: 'string', default: '2' },
      port: { type: 'string', default: '2578' },
      out: { type: 'string', default: 'artifacts/soak' },
      // A fight is the heaviest thing a room does: rounds in flight, hit
      // tests against every hull, and stats re-derived as modules are lost.
      fight: { type: 'boolean', default: false },
      // Trading bots, which is what the economy milestone's soak is for.
      trade: { type: 'boolean', default: false },
      // Honest traders, honest investors and exploiters in one run, so the
      // three can be compared at the end.
      invest: { type: 'boolean', default: false },
      factor: { type: 'boolean', default: false },
      // A month of world time in a couple of minutes.
      'economy-scale': { type: 'string', default: '900' },
      // Seconds to let the world drift before the bots arrive. A brand-new
      // world sits exactly at its targets, so bots that start immediately
      // find no glut anywhere and correctly decide not to trade.
      warmup: { type: 'string', default: '150' },
      // Ostrand makes Ore and Ice at Ballast and consumes Alloy and Machinery
      // at Dunnage: two berths in one system with opposite appetites, which
      // is a route a bot can actually work.
      'start-system': { type: 'string', default: 'ostrand' },
      // Seconds to keep watching after the bots leave. The spec's bar is that
      // a route worked hard decays and a rested one recovers, and the second
      // half of that can only be seen once nobody is working it.
      rest: { type: 'string', default: '120' },
    },
  });

  const bots = Number(values.bots);
  const minutes = Number(values.minutes);
  if (!Number.isInteger(bots) || bots < 1) throw new Error('--bots must be a positive integer');
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--minutes must be positive');

  return {
    bots,
    minutes,
    latency: Number(values.latency),
    loss: Number(values.loss) / 100,
    port: Number(values.port),
    outDir: resolve(REPO_ROOT, values.out),
    fight: values.fight === true,
    trade: values.trade === true,
    invest: values.invest === true,
    factor: values.factor === true,
    economyTimeScale: Number(values['economy-scale']),
    warmupSeconds: Number(values.warmup),
    startingSystem: values['start-system'],
    restSeconds: Number(values.rest),
  };
}

/** One sample of the whole world, taken on a schedule through the run. */
interface Sample {
  readonly atSeconds: number;
  readonly server: ServerMetrics;
  readonly bots: readonly BotTelemetry[];
  /** Only taken on a trading run, where it is the point of the exercise. */
  readonly economy?: EconomyReport;
}

async function main(): Promise<void> {
  const options = parseOptions();
  await mkdir(options.outDir, { recursive: true });

  // One soak at a time. Two sharing a port means one of them is measuring a
  // world the other is also trading in, and both write the same report.
  await requirePortFree(options.port, 'a game server or another soak');

  // A soak starts from a clean world. Reusing the database carried every
  // earlier run's captains and ledger rows into this run's report, which made
  // "total marks by category" the sum of every soak ever run here.
  const soakDb = resolve(options.outDir, 'soak.db');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${soakDb}${suffix}`, { force: true });
  }

  console.log(
    `Soak: ${options.bots} bots, ${options.minutes} min, ${options.latency}ms simulated latency, `
      + `${(options.loss * 100).toFixed(1)}% of input frames stalled`,
  );

  const server = await startServer({
    port: options.port,
    latencyMs: options.latency,
    // A soak runs the world hard; it does so in its own database.
    databaseUrl: soakDb,
    economyTimeScale: options.economyTimeScale,
    ...(options.trade ? { startingSystem: options.startingSystem } : {}),
    // An investor with a new captain's float can buy a share or two and
    // nothing else, which measures nothing. Spending is what this run is
    // about, so they open with enough to spend.
    ...(options.invest ? { startingMarks: 3_000_000 } : {}),
  });
  const bots: Bot[] = [];
  const samples: Sample[] = [];
  /** The world as the bots left it, and after it had time to recover. */
  let restedFrom: EconomyReport | undefined;
  let restedTo: EconomyReport | undefined;

  // Let the world run before anyone arrives in it. Without this the bots
  // reach their first berth while every stockpile is still exactly at target,
  // find nothing worth buying anywhere, and the run measures an economy that
  // has not happened yet.
  if (options.trade && options.warmupSeconds > 0) {
    const worldHours = (options.warmupSeconds * options.economyTimeScale) / 3600;
    console.log(
      `Letting the world run for ${options.warmupSeconds}s ` +
        `(${worldHours.toFixed(0)}h of world time)...`,
    );
    await sleep(options.warmupSeconds * 1000);
  }

  try {
    // Trading: most work a circuit across systems, and a quarter are held to
    // one, which is what decays a route. Otherwise half fly a fixed
    // turn-and-burn, the hardest steady state for prediction, and half
    // wander, which exercises braking and arrival.
    const stamp = Date.now().toString(36).slice(-4);

    /**
     * Follow a captain through a lane.
     *
     * A jump moves the captain to another room, and the hull in the old one
     * is gone: a bot that stayed would predict against a ship the server no
     * longer has and report it as divergence. The browser follows by
     * reconnecting; so does this, as the same captain.
     */
    const follow = (index: number, brain: BotBrain) =>
      (systemId: string, deviceToken: string | undefined): void => {
        void (async () => {
          const old = bots[index];
          if (!old) return;
          try {
            await old.leave();
          } catch {
            // Already gone.
          }
          try {
            bots[index] = await Bot.connect({
              endpoint: `ws://127.0.0.1:${options.port}`,
              callsign: old.telemetry.callsign,
              brain,
              deviceToken,
              account: options.trade || options.invest || options.factor,
              inputStall: options.loss,
              systemId,
              onJumped: follow(index, brain),
            });
          } catch (error) {
            console.error(`bot ${index + 1} could not follow to ${systemId}:`, error);
          }
        })();
      };

    for (let i = 0; i < options.bots; i++) {
      const hammers = options.trade && i % 4 === 0;
      // With `--invest` the run is three populations at once: honest traders
      // hauling cargo, honest investors reading the Bourse, and exploiters
      // trying what the invariants forbid. The comparison between them at the
      // end is the point — spec section 15's invariant 6 says the exploiters
      // must not come out ahead.
      const role = options.invest ? (i % 3 === 2 ? 'exploiter' : i % 3 === 1 ? 'investor' : 'trader') : 'trader';
      // Each one leans toward a different kind of work, so a run covers the
      // board rather than every bot queueing for the same best-paying line.
      const LEANS = ['delivery', 'passengers', 'smuggling', 'escort'] as const;
      const brain = options.factor
        ? factorBrain({ seed: `soak-${i}`, leans: LEANS[i % LEANS.length] })
        : options.invest
        ? role === 'exploiter'
          ? exploiterBrain(`soak-${i}`)
          : role === 'investor'
            ? investorBrain(`soak-${i}`)
            : traderBrain({ seed: `soak-${i}`, stay: false, lot: 10 })
        : options.trade
          ? traderBrain({ seed: `soak-${i}`, stay: hammers, lot: hammers ? 20 : 10 })
          : options.fight
            ? fighterBrain(`soak-${i}`)
            : i % 2 === 0
              ? circleBrain(i % 4 === 0 ? 1 : -1)
              : wanderBrain({ seed: `soak-${i}` });

      bots.push(
        await Bot.connect({
          endpoint: `ws://127.0.0.1:${options.port}`,
          // A trading bot opens an account, and the Register refuses a
          // callsign it already holds, so the run stamps its own.
          callsign:
            options.trade || options.invest || options.factor
              ? `Soak ${stamp}-${String(i + 1).padStart(2, '0')}`
              : `Soak-${String(i + 1).padStart(2, '0')}`,
          brain,
          account: options.trade || options.invest || options.factor,
          inputStall: options.loss,
          systemId: options.trade || options.factor ? options.startingSystem : 'parity',
          ...(options.trade || options.factor ? { onJumped: follow(i, brain) } : {}),
        }),
      );
    }
    console.log(`${bots.length} bots flying.`);

    const startedAt = Date.now();
    const endAt = startedAt + options.minutes * 60_000;
    const sampleEvery = 10_000;

    while (Date.now() < endAt) {
      await sleep(Math.min(sampleEvery, endAt - Date.now()));
      const atSeconds = Math.round((Date.now() - startedAt) / 1000);
      samples.push({
        atSeconds,
        server: await fetchMetrics(options.port),
        bots: bots.map((bot) => bot.telemetry),
        ...(options.trade || options.invest || options.factor
          ? { economy: await fetchEconomy(options.port) }
          : {}),
      });
      process.stdout.write(`  t+${atSeconds}s\r`);
    }

    // --- The rest ---------------------------------------------------------
    //
    // Everyone leaves, and the world is watched a while longer. Decay is what
    // the bots did to the berths they worked; recovery is what freight and
    // the berths' own production do once they stop.
    if (options.trade && options.restSeconds > 0) {
      restedFrom = samples.at(-1)?.economy;

      console.log(`\nBots away; watching the world rest for ${options.restSeconds}s...`);
      await Promise.allSettled(bots.map((bot) => bot.leave()));
      bots.length = 0;

      const restEnd = Date.now() + options.restSeconds * 1000;
      while (Date.now() < restEnd) {
        await sleep(Math.min(10_000, restEnd - Date.now()));
        restedTo = await fetchEconomy(options.port);
      }
    }

    const report = buildReport(options, samples, restedFrom, restedTo);
    const path = resolve(options.outDir, 'report.md');
    await writeFile(path, report);
    console.log(`\nReport written to ${path}`);

    const verdict = assess(samples);
    for (const line of verdict.lines) console.log(line);
    if (!verdict.pass) process.exitCode = 1;
  } finally {
    await Promise.allSettled(bots.map((bot) => bot.leave()));
    await server.stop();
  }
}

interface Verdict {
  pass: boolean;
  lines: string[];
}

function assess(samples: readonly Sample[]): Verdict {
  const last = samples.at(-1);
  if (!last) return { pass: false, lines: ['FAIL: no samples were taken.'] };

  const lines: string[] = [];
  let pass = true;

  const worstTick = Math.max(...samples.map((s) => s.server.tick.p99Ms));
  const spikes = last.server.tick.over33Ms;
  const diverging = last.bots.filter((bot) => bot.status === 'diverging');

  // The spec budgets an average tick under 4ms. p99 is the stricter read.
  if (worstTick > 4) {
    pass = false;
    lines.push(`FAIL: worst p99 server tick ${worstTick.toFixed(2)}ms exceeds the 4ms budget.`);
  } else {
    lines.push(`PASS: worst p99 server tick ${worstTick.toFixed(2)}ms, inside the 4ms budget.`);
  }

  if (spikes > 0) {
    pass = false;
    lines.push(`FAIL: ${spikes} tick(s) over 33ms. Frame-time spikes over 33ms are bugs.`);
  } else {
    lines.push('PASS: no tick exceeded 33ms.');
  }

  if (diverging.length > 0) {
    pass = false;
    lines.push(
      `FAIL: prediction diverged for ${diverging.map((b) => b.callsign).join(', ')}.`,
    );
  } else {
    lines.push('PASS: every client stayed matched or within jitter.');
  }

  return { pass, lines };
}

/**
 * What the economy did, which is what the economy milestone's soak is for.
 *
 * The spec asks for the price range of every commodity, time spent at clamp
 * limits, and total marks over time by ledger category, and sets the bar:
 * credit growth inside a band, no price sitting at a clamp for long, no stock
 * running to zero or without bound.
 */
function economySections(options: Options, samples: readonly Sample[]): string {
  const withEconomy = samples.filter((sample) => sample.economy !== undefined);
  const last = withEconomy.at(-1)?.economy;
  const first = withEconomy.at(0)?.economy;
  if (!last || !first) return '';

  // How many samples each commodity spent pinned at a clamp, anywhere.
  const clampedSamples = new Map<string, number>();
  for (const sample of withEconomy) {
    for (const row of sample.economy?.commodities ?? []) {
      if (row.atFloor + row.atCeiling > 0) {
        clampedSamples.set(row.commodityId, (clampedSamples.get(row.commodityId) ?? 0) + 1);
      }
    }
  }

  const priceRows = last.commodities
    .map((row) => {
      const clamped = clampedSamples.get(row.commodityId) ?? 0;
      const share = withEconomy.length > 0 ? (clamped / withEconomy.length) * 100 : 0;
      return (
        `| ${row.name} | ${row.basePrice} | ${row.low}–${row.high} | ${row.mean} | ` +
        `${row.floor}/${row.ceiling} | ${row.atFloor}/${row.atCeiling} | ` +
        `${share.toFixed(0)}% | ${row.stock.toLocaleString()} | ${row.empty}/${row.full} |`
      );
    })
    .join('\n');

  const categories = new Map<string, { total: number; count: number }>();
  for (const row of last.ledger.categories) categories.set(row.category, row);

  const ledgerRows = [...categories.entries()]
    .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
    .map(([name, row]) => `| ${name} | ${row.total.toLocaleString()} | ${row.count} |`)
    .join('\n');

  // Net worth, not just marks: a captain halfway through a voyage is holding
  // cargo they paid for, and counting only the purse calls that a loss.
  const worthNow = last.ledger.heldByCaptains + last.ledger.cargoValue;
  const worthBefore = first.ledger.heldByCaptains + first.ledger.cargoValue;
  const grew = worthNow - worthBefore;
  const perCaptain = last.ledger.captains > 0 ? grew / last.ledger.captains : 0;
  const reconciles = last.ledger.net === last.ledger.heldByCaptains;

  // Invariant 3 over the run: a pool's product is at least what it opened
  // at, for every listing.
  const openedWith = new Map((first.listings ?? []).map((row) => [row.ticker, row]));
  const poolsFallen = (last.listings ?? []).filter(
    (row) => row.product < (openedWith.get(row.ticker)?.product ?? 0),
  ).length;
  const atFloor = (last.listings ?? []).filter((row) => row.price <= 2.001).length;

  const listingRows = (last.listings ?? [])
    .map((row) => {
      const was = openedWith.get(row.ticker);
      const fell = row.product < (was?.product ?? 0);
      return (
        `| ${row.ticker} | ${row.price.toFixed(2)} | ${(was?.price ?? 0).toFixed(2)} | ` +
        `${Math.round(row.earnings ?? 0).toLocaleString()} | ${Math.round(row.period ?? 0).toLocaleString()} | ` +
        `${Math.round(row.product).toLocaleString()} | ${Math.round(was?.product ?? 0).toLocaleString()} | ` +
        `${fell ? '**fell**' : 'held'} |`
      );
    })
    .join('\n');

  // Net worth by strategy. Marks plus shares at the quote: a captain's
  // wealth can sit in either, and counting only the purse would call an
  // investor halfway through a position a pauper.
  const worthOf = (bot: { marks: number; sharesWorth?: number }): number =>
    bot.marks + (bot.sharesWorth ?? 0);

  const byStrategy = new Map<string, number[]>();
  for (const bot of samples.at(-1)?.bots ?? []) {
    const list = byStrategy.get(bot.brain) ?? [];
    list.push(worthOf(bot));
    byStrategy.set(bot.brain, list);
  }

  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };

  const strategyRows = [...byStrategy.entries()]
    .sort((a, b) => median(b[1]) - median(a[1]))
    .map(
      ([name, worths]) =>
        `| ${name} | ${worths.length} | ${Math.round(median(worths)).toLocaleString()} | ` +
        `${Math.round(Math.max(...worths)).toLocaleString()} | ` +
        `${Math.round(Math.min(...worths)).toLocaleString()} |`,
    )
    .join('\n');

  const exploiters = byStrategy.get('exploiter') ?? [];
  const honest = [...byStrategy.entries()]
    .filter(([name]) => name !== 'exploiter')
    .flatMap(([, worths]) => worths);
  const honestMedian = median(honest);
  const exploitersAhead = exploiters.filter((worth) => worth > honestMedian).length;
  const exploitVerdict =
    exploiters.length === 0 || honest.length === 0
      ? 'not run (use --invest)'
      : Math.max(...exploiters) > Math.max(...honest)
        ? `**the exploiter is ahead** (${Math.round(Math.max(...exploiters)).toLocaleString()} against ${Math.round(Math.max(...honest)).toLocaleString()})`
        : `honest ahead (${Math.round(Math.max(...honest)).toLocaleString()} against ${Math.round(Math.max(...exploiters)).toLocaleString()})`;

  const tradedBots = (samples.at(-1)?.bots ?? []).filter((bot) => bot.trades > 0);
  const totalOrders = tradedBots.reduce((sum, bot) => sum + bot.trades, 0);
  const refusedOrders = tradedBots.reduce((sum, bot) => sum + bot.refusedTrades, 0);

  const traderRows = (samples.at(-1)?.bots ?? [])
    .map((bot) => `| ${bot.callsign} | ${bot.marks.toLocaleString()} | ${bot.trades} | ${bot.refusedTrades} | ${bot.lastRefusal || '—'} |`)
    .join('\n');

  return `## The economy

The world ran at ${options.economyTimeScale}x, so ${options.minutes} minute(s) of
soak is about ${((options.minutes * 60 * options.economyTimeScale) / 86_400).toFixed(1)}
day(s) of world time.

### Prices

A price sitting at a clamp means the band is doing the work the stockpile
should be. The spec's bar is that no price sits at one for long.

| Good | base | range now | mean | floor/ceiling | berths at each | samples clamped | stock in the Reach | empty/full berths |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${priceRows}

### Honest captains against exploiters

Spec section 15's invariant 6 says self-dealing loses money and that wash
trading moves no earnings. The exploiter bot spends the whole run trying
both, plus churning a berth's Staple, against honest traders hauling cargo
and honest investors reading the Bourse. The bar is that it does not come
out ahead of them.

| Strategy | captains | median worth | best | worst |
|---|---:|---:|---:|---:|
${strategyRows}

| Measure | Value |
|---|---|
| Exploiters ahead of the honest median | ${exploitersAhead === 0 ? 'none' : `**${exploitersAhead}**`} |
| Best exploiter against the best honest captain | ${exploitVerdict} |

### The Bourse

Invariant 3 says a pool's product never falls. Over a run that means every
listing's product is at least what it opened at, and no quote has run to
nothing or without bound.

| Listing | quote now | at the start | earnings a tick | last tick | product now | product at the start | held |
|---|---:|---:|---:|---:|---:|---:|---:|
${listingRows}

| Measure | Value |
|---|---|
| Pools whose product fell | ${poolsFallen === 0 ? 'none' : `**${poolsFallen}**`} |
| Listings at the value floor | ${atFloor} of ${(last.listings ?? []).length} |
| Shares held by captains | ${(last.sharesHeld?.total ?? 0).toLocaleString()} |

### Marks

Invariant 4 says the marks every captain holds equals faucets minus sinks.

| Measure | Value |
|---|---|
| Held by captains | ${last.ledger.heldByCaptains.toLocaleString()} |
| Faucets minus sinks | ${last.ledger.net.toLocaleString()} |
| Reconciles | ${reconciles ? 'yes' : '**NO**'} |
| Captains | ${last.ledger.captains} |
| In their holds | ${last.ledger.cargoUnits.toLocaleString()} units, worth ${last.ledger.cargoValue.toLocaleString()} at base |
| Net worth now | ${worthNow.toLocaleString()} |
| Change over the run | ${grew >= 0 ? '+' : ''}${grew.toLocaleString()} (${perCaptain >= 0 ? '+' : ''}${perCaptain.toFixed(0)} each) |

| Category | Total | Postings |
|---|---:|---:|
${ledgerRows}

### Traders

${totalOrders} order(s) sent, ${refusedOrders} refused.

| callsign | marks | orders | refused | last refusal |
|---|---:|---:|---:|---|
${traderRows}

`;
}

/**
 * What the bots did to the berths they worked, while they worked them.
 *
 * The first half of the spec's bar: a route hammered sees its margin decay.
 * Buying a berth's glut costs more with every unit taken, so the price a
 * captain pays there climbs across the run and the margin that drew them
 * closes behind them.
 */
/**
 * What the Factor's board actually paid out, by template.
 *
 * Milestone 7 asks that every commission template completes end to end under
 * bots. `Commissions.test.ts` proves all nineteen exhaustively against a real
 * database — taken, answered, paid, reconciled — because a run of any length
 * cannot: most templates are a charter's own work and need standing a bot
 * earns over hours, and the one brain that works a board does not hunt, so
 * bounties are never taken whatever its standing.
 *
 * What this says is which of them went all the way through the real protocol
 * in *this* run: the board the server built, the intent, the flight, the
 * landing and the Factor's verdict. It is the other half of that pair.
 */
function commissionSection(options: Options, samples: readonly Sample[]): string {
  if (!options.factor) return '';

  const rows = samples.at(-1)?.economy?.commissions ?? [];
  if (rows.length === 0) {
    return `## Commissions

Nothing was taken off a board this run.

`;
  }

  const byTemplate = new Map<string, { kind: string; done: number; failed: number; open: number }>();
  for (const row of rows) {
    const entry = byTemplate.get(row.templateId) ?? {
      kind: row.kind,
      done: 0,
      failed: 0,
      open: 0,
    };
    if (row.state === 'done') entry.done += row.count;
    else if (row.state === 'failed') entry.failed += row.count;
    else entry.open += row.count;
    byTemplate.set(row.templateId, entry);
  }

  const { commissions } = content();
  const everyTemplate = commissions.templates.map((template) => template.id).sort();
  const answered = everyTemplate.filter((id) => (byTemplate.get(id)?.done ?? 0) > 0);
  const untouched = everyTemplate.filter((id) => !byTemplate.has(id));

  // What a bot could have taken at all. A board only posts a charter's own
  // work to a captain that charter already trusts, and this brain does not
  // hunt, so the rest were never on offer to it.
  const reachable = commissions.templates.filter(
    (template) => template.kind !== 'bounty' && (template.requiresStanding ?? 0) === 0,
  );

  const lines = [...byTemplate]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([id, entry]) =>
        `| ${id} | ${entry.kind} | ${entry.done} | ${entry.failed} | ${entry.open} |`,
    )
    .join('\n');

  return `## Commissions

| Template | Kind | Answered | Failed | In hand |
|---|---|---:|---:|---:|
${lines}

| Measure | Value |
|---|---|
| Templates answered through the protocol | ${answered.length} of ${reachable.length} a bot could take |
| Of all nineteen | ${answered.length} |
| Taken but not finished when the run ended | ${
    [...byTemplate].filter(([, entry]) => entry.open > 0 && entry.done === 0).length
  } |
| Never taken this run | ${untouched.length === 0 ? 'none' : untouched.join(', ')} |

Every template is proved end to end — taken, answered, paid and reconciled
against the ledger — by \`packages/server/src/world/Commissions.test.ts\`. A
board posts a charter's own work only to a captain it already trusts, and
the brain that works a board does not hunt, so a run of any length reaches
${reachable.length} of the ${everyTemplate.length}.

`;
}

function decaySection(options: Options, samples: readonly Sample[]): string {
  const traded = samples.filter((sample) => sample.economy !== undefined);
  const first = traded.at(0)?.economy;
  const last = traded.at(-1)?.economy;
  if (!first || !last) return '';

  const before = new Map(first.berths.map((berth) => [berth.portId, berth]));
  const rows: string[] = [];

  for (const berth of last.berths) {
    if (berth.systemId !== options.startingSystem) continue;
    const was = before.get(berth.portId);
    if (!was) continue;

    for (const good of berth.goods) {
      const had = was.goods.find((candidate) => candidate.commodityId === good.commodityId);
      if (!had || had.price === good.price) continue;

      const moved = ((good.price - had.price) / had.price) * 100;
      rows.push(
        `| ${berth.portId} | ${good.commodityId} | ${had.price} | ${good.price} | ` +
          `${moved >= 0 ? '+' : ''}${moved.toFixed(1)}% | ` +
          `${had.stock.toLocaleString()} | ${good.stock.toLocaleString()} |`,
      );
    }
  }

  if (rows.length === 0) return '';

  return `### Decay

The berths the bots worked, from the first sample to the last. A price that
rose is a margin that closed: every unit bought out of a glut costs more than
the one before it, so a route worked hard pays less each time it is run.

| berth | good | price at the start | price at the end | moved | stock then | stock now |
|---|---|---:|---:|---:|---:|---:|
${rows.join('\n')}

`;
}

/**
 * What the berths the bots worked did afterwards.
 *
 * The spec's bar for this milestone: a route hammered sees its margin decay,
 * and a rested route recovers. The first half is what the bots did while they
 * were here; this is the second, measured once they have gone.
 */
function recoverySection(
  options: Options,
  from?: EconomyReport,
  to?: EconomyReport,
): string {
  if (!from || !to) return '';

  const before = new Map(from.berths.map((berth) => [berth.portId, berth]));
  const rows: string[] = [];

  for (const berth of to.berths) {
    if (berth.systemId !== options.startingSystem) continue;
    const was = before.get(berth.portId);
    if (!was) continue;

    for (const good of berth.goods) {
      const had = was.goods.find((candidate) => candidate.commodityId === good.commodityId);
      if (!had) continue;

      const towards = Math.abs(good.stock - good.target) - Math.abs(had.stock - had.target);
      rows.push(
        `| ${berth.portId} | ${good.commodityId} | ${had.stock.toLocaleString()} | ` +
          `${good.stock.toLocaleString()} | ${good.target.toLocaleString()} | ` +
          `${had.price} | ${good.price} | ` +
          `${towards < 0 ? 'toward target' : towards > 0 ? 'away from target' : 'unchanged'} |`,
      );
    }
  }

  if (rows.length === 0) return '';

  return `### Recovery

The berths the bots worked, as they left them and after ${options.restSeconds}s
of nobody trading — about ${((options.restSeconds * options.economyTimeScale) / 3600).toFixed(0)}
hours of world time. Recovery is the stock moving back towards what the berth
wants, which is freight and the berth's own production undoing the trade. A
berth that makes a good naturally sits above its target and drifts further
until freight carries the surplus off, so "away from target" on something a
berth produces is the world working, not failing.

| berth | good | stock then | stock now | target | price then | price now | |
|---|---|---:|---:|---:|---:|---:|---|
${rows.join('\n')}

`;
}

function buildReport(
  options: Options,
  samples: readonly Sample[],
  restedFrom?: EconomyReport,
  restedTo?: EconomyReport,
): string {
  const last = samples.at(-1);
  const verdict = assess(samples);

  const tickRows = samples
    .map(
      (s) =>
        `| ${s.atSeconds} | ${s.server.clients} | ${s.server.entities} | ` +
        `${s.server.tick.meanMs.toFixed(3)} | ${s.server.tick.p50Ms.toFixed(3)} | ` +
        `${s.server.tick.p95Ms.toFixed(3)} | ${s.server.tick.p99Ms.toFixed(3)} | ` +
        `${s.server.tick.maxMs.toFixed(2)} | ${s.server.tick.over33Ms} |`,
    )
    .join('\n');

  const botRows = (last?.bots ?? [])
    .map(
      (b) =>
        `| ${b.callsign} | ${b.brain} | ${b.status} | ${b.driftEma.toFixed(4)} | ` +
        `${b.driftPeak.toFixed(4)} | ${b.rtt.toFixed(0)} | ${b.jitter.toFixed(1)} | ` +
        `${b.pendingInputs} | ${b.inputsSent} | ${b.inputsStalled} | ${b.shipsSeen} |`,
    )
    .join('\n');

  const expectedInputs = Math.round(options.minutes * 60 * TICK_RATE);
  const economy = options.trade
    ? economySections(options, samples) +
      decaySection(options, samples) +
      recoverySection(options, restedFrom, restedTo)
    : options.invest
      ? economySections(options, samples)
      : '';

  return `# Soak report

Generated by \`pnpm sim\`. This file is overwritten each run.

## Run

| Setting | Value |
|---|---|
| Bots | ${options.bots} |
| Duration | ${options.minutes} minute(s) |
| Simulated latency | ${options.latency} ms round trip |
| Input frames stalled a step | ${(options.loss * 100).toFixed(1)}% |
| Scenario | ${options.fight ? 'fighting: every bot marks and shoots' : 'flying: no weapons fired'} |
| Server tick rate | ${TICK_RATE} Hz |
| Expected inputs per bot | ~${expectedInputs} |
| Samples | ${samples.length}, every 10s |

## Verdict

${verdict.lines.map((line) => `- ${line}`).join('\n')}

## Server tick

The spec budgets an average tick under 4 ms with 12 players and 40 NPCs in one
system, and treats any frame-time spike over 33 ms as a bug.

| t+s | clients | entities | mean | p50 | p95 | p99 | max | >33ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${tickRows}

${economy}${commissionSection(options, samples)}## Clients at the end of the run

Drift is the SDK's own reconcile-correction telemetry, classified by the SDK's
own \`classifyDrift\`. A persistent EMA means the client and server simulations
genuinely disagree; spikes that decay are network jitter.

| callsign | brain | status | drift ema | drift peak | rtt | jitter | pending | sent | stalled | ships |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
${botRows}

## Network feel

Spec section 3: at 150 ms latency and 2% packet loss there is no visible
rubber-banding in normal flight, and remote ships move smoothly. This run was
at ${options.latency} ms round trip with ${(options.loss * 100).toFixed(1)}% of
each client's input frames held back a step and sent with the next one.

Rubber-banding is what a correction looks like from the pilot's seat, so it is
read off the correction itself: \`drift ema\` is the SDK's own smoothed
reconcile-correction magnitude, and \`status\` is the SDK's own verdict on it.
A client that is correcting by less than the tolerance is a client whose hull
is where the captain put it.

| Measure | Value |
|---|---|
| Clients diverging | ${(last?.bots ?? []).filter((b) => b.status === 'diverging').length} of ${(last?.bots ?? []).length} |
| Worst drift EMA | ${Math.max(0, ...(last?.bots ?? []).map((b) => b.driftEma)).toFixed(4)} |
| Worst drift peak | ${Math.max(0, ...(last?.bots ?? []).map((b) => b.driftPeak)).toFixed(4)} |
| Input frames stalled | ${(last?.bots ?? []).reduce((sum, b) => sum + b.inputsStalled, 0)} |

## Not yet measured

These sections arrive with the systems they measure. They are listed so a reader
can tell "not yet checked" from "checked and stable".

| Measure | Arrives with |
|---|---|
| Bandwidth per client | M1, once the flight view sets the real patch payload |
${options.trade ? '' : '| Total marks over time by ledger category | M4; run `pnpm sim -- --trade` |'}
| Price range of every commodity, and time at clamp limits | M4, with the Staple |
| Price range of every stock, and pool invariants | M6, with the Bourse |
| Exploit bots versus honest trading bots | M6 |
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
