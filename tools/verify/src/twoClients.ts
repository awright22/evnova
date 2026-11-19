/**
 * Two browser clients fly together.
 *
 * M1's acceptance check. Opens two real browser clients against one server,
 * flies both, and holds them to the spec's network-feel targets: each client
 * predicts its own hull without diverging, and each one sees the other move.
 *
 *   pnpm verify
 *   pnpm verify -- --latency 150
 */

import { parseArgs } from 'node:util';

import {
  CHROMIUM,
  LAUNCH_ARGS,
  loadPlaywright,
  sleep,
  startStack,
} from './harness.ts';

interface ClientReport {
  readonly name: string;
  readonly status: string;
  readonly driftEma: number;
  readonly rtt: number;
  readonly contacts: number;
  readonly speed: number;
  /** How far the other hull was seen to move, in world units. */
  readonly remoteTravel: number;
  readonly consoleErrors: readonly string[];
}

function options(): { latency: number; seconds: number; width: number; height: number } {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      latency: { type: 'string', default: '150' },
      seconds: { type: 'string', default: '12' },
      // Two Pixi clients on one machine share a renderer. Where that machine
      // has no GPU, a full-size viewport starves both frame loops and the
      // reconciler reads corrections that say nothing about the network. The
      // check is about netcode, so it runs at a small viewport by default.
      width: { type: 'string', default: '640' },
      height: { type: 'string', default: '360' },
    },
  });
  return {
    latency: Number(values.latency),
    seconds: Number(values.seconds),
    width: Number(values.width),
    height: Number(values.height),
  };
}

/** Read the debug hook the flight view exposes under `?debug=1`. */
const TELEMETRY = `(function () {
  var m = window.marqueDebug;
  if (!m) return null;
  var t = m.telemetry();
  var r = m.readout();
  return { status: t ? t.status : 'none', driftEma: t ? t.driftEma : -1,
           rtt: r.rtt, contacts: r.contacts, speed: r.speed };
})()`;

/** Positions of every hull the page can currently see, keyed by callsign. */
const REMOTES = `(function () {
  var m = window.marqueDebug;
  if (!m || !m.ships) return [];
  return m.ships();
})()`;

async function main(): Promise<void> {
  const opts = options();
  const playwright = await loadPlaywright();
  if (!playwright) {
    process.exitCode = 1;
    return;
  }

  console.log(
    `Two browser clients, ${opts.seconds}s, ${opts.latency}ms simulated latency.`,
  );

  const stack = await startStack({
    serverPort: 2583,
    previewPort: 4183,
    latencyMs: opts.latency,
  });

  const browser = await playwright.chromium.launch({
    executablePath: CHROMIUM,
    args: LAUNCH_ARGS,
  });

  try {
    const names = ['Client A', 'Client B'];
    const pages = await Promise.all(
      names.map(async () => {
        const context = await browser.newContext({
          viewport: { width: opts.width, height: opts.height },
          deviceScaleFactor: 1,
        });
        return context.newPage();
      }),
    );

    const errors: string[][] = [[], []];
    pages.forEach((page, i) => {
      page.on('console', (m) => {
        if (m.type() === 'error') errors[i]!.push(m.text());
      });
      page.on('pageerror', (e) => errors[i]!.push(e.message));
    });

    await Promise.all(
      pages.map((page) =>
        page.goto(`${stack.baseUrl}/?debug=1`, { waitUntil: 'networkidle' }),
      ),
    );
    await Promise.all(pages.map((page) => page.waitForSelector('.hud', { timeout: 30_000 })));
    // Let both links settle before measuring.
    await sleep(4000);

    // Record where each client sees the other hull, before anyone moves.
    const before = await Promise.all(pages.map((page) => page.evaluate(REMOTES)));

    // Fly both, in different directions, for the measurement window.
    await pages[0]!.focus('body');
    await pages[0]!.keyboard.down('ArrowUp');
    await pages[1]!.focus('body');
    await pages[1]!.keyboard.down('ArrowUp');
    await pages[1]!.keyboard.down('ArrowRight');

    await sleep(opts.seconds * 1000);

    const after = await Promise.all(pages.map((page) => page.evaluate(REMOTES)));
    const telemetry = await Promise.all(pages.map((page) => page.evaluate(TELEMETRY)));

    await pages[0]!.keyboard.up('ArrowUp');
    await pages[1]!.keyboard.up('ArrowUp');
    await pages[1]!.keyboard.up('ArrowRight');

    const reports: ClientReport[] = names.map((name, i) => {
      const t = telemetry[i] as {
        status: string;
        driftEma: number;
        rtt: number;
        contacts: number;
        speed: number;
      } | null;
      return {
        name,
        status: t?.status ?? 'none',
        driftEma: t?.driftEma ?? -1,
        rtt: t?.rtt ?? -1,
        contacts: t?.contacts ?? -1,
        speed: t?.speed ?? -1,
        remoteTravel: travelOfOthers(
          before[i] as RemoteSample[],
          after[i] as RemoteSample[],
        ),
        consoleErrors: errors[i]!,
      };
    });

    report(reports);

    const failures: string[] = [];
    for (const r of reports) {
      if (r.status === 'diverging') {
        failures.push(`${r.name}: prediction diverged (ema ${r.driftEma.toFixed(4)})`);
      }
      if (r.contacts < 1) {
        failures.push(`${r.name}: never saw the other hull (contacts ${r.contacts})`);
      }
      if (r.speed <= 1) {
        failures.push(`${r.name}: never got moving (speed ${r.speed.toFixed(1)})`);
      }
      if (r.remoteTravel < 50) {
        failures.push(
          `${r.name}: the other hull barely moved on screen (${r.remoteTravel.toFixed(1)} units)`,
        );
      }
      if (r.consoleErrors.length > 0) {
        failures.push(`${r.name}: ${r.consoleErrors.length} console error(s)`);
      }
    }

    if (failures.length > 0) {
      console.error('\nFAIL');
      for (const line of failures) console.error(`  ${line}`);
      process.exitCode = 1;
    } else {
      console.log('\nPASS: both clients predicted cleanly and saw each other fly.');
    }
  } finally {
    await browser.close();
    await stack.stop();
  }
}

interface RemoteSample {
  id: string;
  x: number;
  y: number;
  isSelf: boolean;
}

/** How far the hulls this client does NOT control were seen to travel. */
function travelOfOthers(before: RemoteSample[], after: RemoteSample[]): number {
  if (!Array.isArray(before) || !Array.isArray(after)) return 0;
  const start = new Map(before.filter((s) => !s.isSelf).map((s) => [s.id, s]));
  let total = 0;
  for (const sample of after) {
    if (sample.isSelf) continue;
    const from = start.get(sample.id);
    if (!from) continue;
    total += Math.hypot(sample.x - from.x, sample.y - from.y);
  }
  return total;
}

function report(reports: readonly ClientReport[]): void {
  const header = [
    'client'.padEnd(10),
    'status'.padEnd(10),
    'drift ema'.padStart(10),
    'rtt'.padStart(8),
    'contacts'.padStart(9),
    'speed'.padStart(8),
    'remote moved'.padStart(13),
    'errors'.padStart(7),
  ].join(' ');
  console.log(`\n${header}`);
  console.log('-'.repeat(header.length));
  for (const r of reports) {
    console.log(
      [
        r.name.padEnd(10),
        r.status.padEnd(10),
        r.driftEma.toFixed(4).padStart(10),
        r.rtt.toFixed(0).padStart(8),
        String(r.contacts).padStart(9),
        r.speed.toFixed(0).padStart(8),
        r.remoteTravel.toFixed(0).padStart(13),
        String(r.consoleErrors.length).padStart(7),
      ].join(' '),
    );
  }
}

await main();

// The SDK keeps sockets and timers alive after a room closes, so the check
// ends deliberately rather than waiting for an event loop that will not drain.
process.exit(process.exitCode ?? 0);
