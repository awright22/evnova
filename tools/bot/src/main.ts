/**
 * Bot runner.
 *
 * Spawns bots against a running server, flies them for a while, then reports
 * the SDK's own netcode telemetry and exits non-zero if any client's
 * prediction diverged from the server. That makes this the automated form of
 * the networking check: run it with `COLYSEUS_LATENCY` set on the server to
 * prove the stack holds up under latency.
 *
 *   pnpm bot --bots 2 --seconds 20 --brain circle
 */

import { parseArgs } from 'node:util';

import { Bot, type BotBrain, type BotTelemetry } from './bot.ts';
import { circleBrain } from './brains/circle.ts';
import { fighterBrain } from './brains/fighter.ts';
import { wanderBrain } from './brains/wander.ts';

interface RunnerOptions {
  endpoint: string;
  bots: number;
  seconds: number;
  brain: string;
  systemId: string;
  draught: string | undefined;
  quiet: boolean;
}

function parseOptions(argv: readonly string[]): RunnerOptions {
  const { values } = parseArgs({
    // `pnpm run x -- --flag` forwards the bare `--` separator, which Node's
    // parseArgs reads as end-of-options. Drop it.
    args: argv.filter((arg) => arg !== '--'),
    options: {
      endpoint: { type: 'string', default: 'ws://127.0.0.1:2567' },
      bots: { type: 'string', default: '2' },
      seconds: { type: 'string', default: '20' },
      brain: { type: 'string', default: 'circle' },
      system: { type: 'string', default: 'parity' },
      draught: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
  });

  const bots = Number(values.bots);
  const seconds = Number(values.seconds);
  if (!Number.isInteger(bots) || bots < 1) throw new Error(`--bots must be a positive integer`);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--seconds must be positive`);

  return {
    endpoint: values.endpoint,
    bots,
    seconds,
    brain: values.brain,
    systemId: values.system,
    draught: values.draught,
    quiet: values.quiet === true,
  };
}

/** The shipped designs, cycled through when no draught is named. */
const DRAUGHTS = ['prudent-return', 'force-majeure', 'fair-wear-and-tear'] as const;

function makeBrain(kind: string, index: number): BotBrain {
  switch (kind) {
    case 'circle':
      // Alternate direction so bots do not stack into one orbit.
      return circleBrain(index % 2 === 0 ? 1 : -1);
    case 'wander':
      return wanderBrain({ seed: `bot-${index}` });
    case 'fighter':
      return fighterBrain(`bot-${index}`);
    default:
      throw new Error(`unknown brain "${kind}" (expected: circle, wander, fighter)`);
  }
}

function formatTable(rows: readonly BotTelemetry[]): string {
  const header = [
    'callsign'.padEnd(12),
    'brain'.padEnd(8),
    'status'.padEnd(10),
    'drift ema'.padStart(10),
    'drift peak'.padStart(11),
    'rtt ms'.padStart(8),
    'jitter'.padStart(7),
    'pending'.padStart(8),
    'sent'.padStart(7),
    'ships'.padStart(6),
  ].join(' ');

  const lines = rows.map((row) =>
    [
      row.callsign.padEnd(12),
      row.brain.padEnd(8),
      row.status.padEnd(10),
      row.driftEma.toFixed(4).padStart(10),
      row.driftPeak.toFixed(4).padStart(11),
      row.rtt.toFixed(1).padStart(8),
      row.jitter.toFixed(1).padStart(7),
      String(row.pendingInputs).padStart(8),
      String(row.inputsSent).padStart(7),
      String(row.shipsSeen).padStart(6),
    ].join(' '),
  );

  return [header, '-'.repeat(header.length), ...lines].join('\n');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  console.log(
    `Connecting ${options.bots} bot(s) to ${options.endpoint} ` +
      `(brain: ${options.brain}, ${options.seconds}s)`,
  );

  const bots: Bot[] = [];
  try {
    for (let i = 0; i < options.bots; i++) {
      const bot = await Bot.connect({
        endpoint: options.endpoint,
        callsign: `Bot-${String(i + 1).padStart(2, '0')}`,
        brain: makeBrain(options.brain, i),
        systemId: options.systemId,
        // With no draught named, bots spread across the shipped designs so a
        // system shows contrasting hulls rather than a row of identical ones.
        blueprint: options.draught ?? DRAUGHTS[i % DRAUGHTS.length]!,
      });
      bots.push(bot);
    }

    console.log(`All ${bots.length} bot(s) flying.`);

    const deadline = Date.now() + options.seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(5000, deadline - Date.now()));
      if (!options.quiet) {
        console.log(`\n[t+${options.seconds - Math.ceil((deadline - Date.now()) / 1000)}s]`);
        console.log(formatTable(bots.map((bot) => bot.telemetry)));
      }
    }

    const final = bots.map((bot) => bot.telemetry);
    console.log('\n=== Final netcode report ===');
    console.log(formatTable(final));

    const diverging = final.filter((row) => row.status === 'diverging');
    const starved = final.filter((row) => row.steps === 0);

    if (starved.length > 0) {
      console.error(
        `\nFAIL: ${starved.length} bot(s) never ran a simulation step: ` +
          starved.map((r) => r.callsign).join(', '),
      );
      process.exitCode = 1;
      return;
    }

    if (diverging.length > 0) {
      console.error(
        `\nFAIL: prediction diverged for ${diverging.length} bot(s): ` +
          diverging.map((r) => `${r.callsign} (ema ${r.driftEma.toFixed(4)})`).join(', '),
      );
      process.exitCode = 1;
      return;
    }

    console.log('\nPASS: every client stayed matched or within jitter.');
  } finally {
    await Promise.allSettled(bots.map((bot) => bot.leave()));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
