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

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Bot, type BotTelemetry } from '@marque/bot/bot.ts';
import { circleBrain } from '@marque/bot/brains/circle.ts';
import { wanderBrain } from '@marque/bot/brains/wander.ts';
import { TICK_RATE } from '@marque/shared';

import { startServer, fetchMetrics, type ServerMetrics } from './server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

interface Options {
  bots: number;
  minutes: number;
  latency: number;
  port: number;
  outDir: string;
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
  };
}

/** One sample of the whole world, taken on a schedule through the run. */
interface Sample {
  readonly atSeconds: number;
  readonly server: ServerMetrics;
  readonly bots: readonly BotTelemetry[];
}

async function main(): Promise<void> {
  const options = parseOptions();
  await mkdir(options.outDir, { recursive: true });

  console.log(
    `Soak: ${options.bots} bots, ${options.minutes} min, ${options.latency}ms simulated latency`,
  );

  const server = await startServer({ port: options.port, latencyMs: options.latency });
  const bots: Bot[] = [];
  const samples: Sample[] = [];

  try {
    // Half fly a fixed turn-and-burn, which is the hardest steady state for
    // prediction; half wander, which exercises braking and arrival.
    for (let i = 0; i < options.bots; i++) {
      const brain = i % 2 === 0 ? circleBrain(i % 4 === 0 ? 1 : -1) : wanderBrain({ seed: `soak-${i}` });
      bots.push(
        await Bot.connect({
          endpoint: `ws://127.0.0.1:${options.port}`,
          callsign: `Soak-${String(i + 1).padStart(2, '0')}`,
          brain,
          systemId: 'soak',
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

  return `# Soak report

Generated by \`pnpm sim\`. This file is overwritten each run.

## Run

| Setting | Value |
|---|---|
| Bots | ${options.bots} |
| Duration | ${options.minutes} minute(s) |
| Simulated latency | ${options.latency} ms round trip |
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

## Clients at the end of the run

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
| Total marks over time by ledger category | M4, with the ledger |
| Price range of every commodity, and time at clamp limits | M4, with the Staple |
| Price range of every stock, and pool invariants | M6, with the Bourse |
| Exploit bots versus honest trading bots | M6 |
`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
