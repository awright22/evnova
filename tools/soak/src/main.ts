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
import { traderBrain } from '@marque/bot/brains/trader.ts';
import { wanderBrain } from '@marque/bot/brains/wander.ts';
import { TICK_RATE } from '@marque/shared';

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
  port: number;
  outDir: string;
  fight: boolean;
  trade: boolean;
  economyTimeScale: number;
  warmupSeconds: number;
  startingSystem: string;
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
      port: { type: 'string', default: '2578' },
      out: { type: 'string', default: 'artifacts/soak' },
      // A fight is the heaviest thing a room does: rounds in flight, hit
      // tests against every hull, and stats re-derived as modules are lost.
      fight: { type: 'boolean', default: false },
      // Trading bots, which is what the economy milestone's soak is for.
      trade: { type: 'boolean', default: false },
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
    port: Number(values.port),
    outDir: resolve(REPO_ROOT, values.out),
    fight: values.fight === true,
    trade: values.trade === true,
    economyTimeScale: Number(values['economy-scale']),
    warmupSeconds: Number(values.warmup),
    startingSystem: values['start-system'],
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

  // A soak starts from a clean world. Reusing the database carried every
  // earlier run's captains and ledger rows into this run's report, which made
  // "total marks by category" the sum of every soak ever run here.
  const soakDb = resolve(options.outDir, 'soak.db');
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(`${soakDb}${suffix}`, { force: true });
  }

  console.log(
    `Soak: ${options.bots} bots, ${options.minutes} min, ${options.latency}ms simulated latency`,
  );

  const server = await startServer({
    port: options.port,
    latencyMs: options.latency,
    // A soak runs the world hard; it does so in its own database.
    databaseUrl: soakDb,
    economyTimeScale: options.economyTimeScale,
    ...(options.trade ? { startingSystem: options.startingSystem } : {}),
  });
  const bots: Bot[] = [];
  const samples: Sample[] = [];

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
              account: options.trade,
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
      const brain = options.trade
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
          callsign: options.trade
            ? `Soak ${stamp}-${String(i + 1).padStart(2, '0')}`
            : `Soak-${String(i + 1).padStart(2, '0')}`,
          brain,
          account: options.trade,
          systemId: options.trade ? options.startingSystem : 'parity',
          ...(options.trade ? { onJumped: follow(i, brain) } : {}),
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
        ...(options.trade ? { economy: await fetchEconomy(options.port) } : {}),
      });
      process.stdout.write(`  t+${atSeconds}s\r`);
    }

    const report = buildReport(options, samples);
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

function buildReport(options: Options, samples: readonly Sample[]): string {
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
        `${b.pendingInputs} | ${b.inputsSent} | ${b.shipsSeen} |`,
    )
    .join('\n');

  const expectedInputs = Math.round(options.minutes * 60 * TICK_RATE);
  const economy = options.trade ? economySections(options, samples) : '';

  return `# Soak report

Generated by \`pnpm sim\`. This file is overwritten each run.

## Run

| Setting | Value |
|---|---|
| Bots | ${options.bots} |
| Duration | ${options.minutes} minute(s) |
| Simulated latency | ${options.latency} ms round trip |
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

${economy}## Clients at the end of the run

Drift is the SDK's own reconcile-correction telemetry, classified by the SDK's
own \`classifyDrift\`. A persistent EMA means the client and server simulations
genuinely disagree; spikes that decay are network jitter.

| callsign | brain | status | drift ema | drift peak | rtt | jitter | pending | sent | ships |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
${botRows}

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
