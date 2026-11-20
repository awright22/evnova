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
import { factorBrain } from './brains/factor.ts';
import { traderBrain } from './brains/trader.ts';
import { hunterBrain } from './brains/hunter.ts';
import { wanderBrain } from './brains/wander.ts';

interface RunnerOptions {
  endpoint: string;
  bots: number;
  seconds: number;
  brain: string;
  /** Open an account per bot, which a trading brain needs. */
  account: boolean;
  systemId: string;
  draught: string | undefined;
  quiet: boolean;
  /** The callsign the hunter brain goes after. */
  hunt: string | undefined;
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
      account: { type: 'boolean', default: false },
      system: { type: 'string', default: 'parity' },
      draught: { type: 'string' },
      quiet: { type: 'boolean', default: false },
      hunt: { type: 'string' },
    },
  });

  const bots = Number(values.bots);
  const seconds = Number(values.seconds);
  if (!Number.isInteger(bots) || bots < 1) throw new Error(`--bots must be a positive integer`);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--seconds must be positive`);
  if (values.brain === 'hunter' && (values.hunt ?? '') === '') {
    throw new Error('--brain hunter needs --hunt <callsign>');
  }

  return {
    endpoint: values.endpoint,
    bots,
    seconds,
    brain: values.brain,
    // Trading needs a captain's row whether or not it was asked for.
    account:
      values.account === true ||
      values.brain === 'trader' ||
      values.brain === 'router' ||
      values.brain === 'factor',
    systemId: values.system,
    draught: values.draught,
    quiet: values.quiet === true,
    hunt: values.hunt,
  };
}

/** The shipped designs, cycled through when no draught is named. */
const DRAUGHTS = ['prudent-return', 'force-majeure', 'fair-wear-and-tear'] as const;

function makeBrain(kind: string, index: number, hunt: string | undefined): BotBrain {
  switch (kind) {
    case 'circle':
      // Alternate direction so bots do not stack into one orbit.
      return circleBrain(index % 2 === 0 ? 1 : -1);
    case 'wander':
      return wanderBrain({ seed: `bot-${index}` });
    case 'fighter':
      return fighterBrain(`bot-${index}`);
    case 'trader':
      return traderBrain({ seed: `bot-${index}` });
    case 'router':
      // Held to one system, so it works the same berths over and over. This
      // is the brain that decays a route.
      return traderBrain({ seed: `bot-${index}`, stay: true, lot: 20 });
    case 'factor':
      // Works the commission board: takes what is posted, buys what it has
      // to carry, flies it where it is wanted and lands.
      return factorBrain({ seed: `bot-${index}` });
    case 'hunter':
      // One named hull, until it is a wreck. The caller has already been
      // told it needs a callsign.
      return hunterBrain(hunt!);
    default:
      throw new Error(
        'unknown brain "' + kind + '" (expected: circle, wander, fighter, trader, '
          + 'router, factor, hunter)',
      );
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
    'marks'.padStart(8),
    'orders'.padStart(7),
    'refused'.padStart(8),
    'work'.padStart(6),
    'done'.padStart(6),
    'late'.padStart(6),
    'why'.padEnd(26),
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
      String(row.marks).padStart(8),
      String(row.trades).padStart(7),
      String(row.refusedTrades).padStart(8),
      String(row.commissionsTaken).padStart(6),
      String(row.commissionsDone).padStart(6),
      String(row.commissionsFailed).padStart(6),
      (row.lastRefusal || (row.landedAt ? `at ${row.landedAt}` : '')).padEnd(26),
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
        // Unique per run: the Register refuses a callsign it already holds,
        // and a soak is run over and over against one database.
        callsign: options.account
          ? `Bot ${Date.now().toString(36).slice(-4)}-${String(i + 1).padStart(2, '0')}`
          : `Bot-${String(i + 1).padStart(2, '0')}`,
        brain: makeBrain(options.brain, i, options.hunt),
        account: options.account,
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
