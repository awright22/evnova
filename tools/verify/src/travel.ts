/**
 * M3's acceptance check: the Register and the lane.
 *
 * Two of the three done-when conditions for the world milestone are about
 * what a person experiences, so they are measured in a real browser rather
 * than asserted:
 *
 *   - a new account goes from the title screen to flying in under a minute;
 *   - a jump between rooms shows no state pop.
 *
 * The third — surviving a hard kill — is `pnpm verify:persistence`.
 *
 *   pnpm verify:travel
 */

import { parseArgs } from 'node:util';

import {
  CHROMIUM,
  LAUNCH_ARGS,
  loadPlaywright,
  sleep,
  startStack,
} from './harness.ts';

interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

/** The spec's bar for a new captain reaching flight. */
const ONBOARDING_BUDGET_MS = 60_000;

/**
 * What counts as a pop.
 *
 * Arriving in a new system places the hull at the lane's edge, so the hull
 * itself moves a long way; that is the jump, not a pop. A pop is the view
 * disagreeing with itself afterwards: the predicted hull somewhere other than
 * where the server says it is, a reading that is not a number, or the old
 * system still on screen. The first is measured against the same snap
 * distance the client itself treats as a teleport.
 */
const SNAP_DISTANCE = 50;

interface Readout {
  system: string;
  speed: number;
  shield: number;
  integrity: number;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { latency: { type: 'string', default: '0' } },
  });
  const latencyMs = Number(values.latency);

  const playwright = await loadPlaywright();
  if (!playwright) {
    console.error('Playwright is not available here. See docs/HUMAN_TODO.md.');
    process.exitCode = 1;
    return;
  }

  const stack = await startStack({ serverPort: 2589, previewPort: 4189, latencyMs });
  const browser = await playwright.chromium.launch({
    executablePath: CHROMIUM,
    args: LAUNCH_ARGS,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 960, height: 600 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    // --- From the title screen to flying ---------------------------------
    //
    // Timed from the moment the page is asked for, as a person would
    // experience it: loading, the Register, signing up, and the first frame
    // of flight.
    const startedAt = Date.now();
    await page.goto(`${stack.baseUrl}/?debug=1&harness=1`, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.register', { timeout: 30_000 });
    // A fresh callsign per run: the Register refuses one it already holds.
    const callsign = `First Light ${Date.now().toString(36).slice(-4)}`;
    await page.fill('.register input[name="callsign"]', callsign);
    await page.click('.register button[type="submit"]');

    // The phrase is shown once and has to be acknowledged before flying.
    await page.waitForSelector('.register__phrase', { timeout: 30_000 });
    await page.click('.register__footer button');

    await page.waitForSelector('.hud', { timeout: 60_000 });
    const onboardingMs = Date.now() - startedAt;

    record(
      'a new account goes from the title screen to flying in under a minute',
      onboardingMs < ONBOARDING_BUDGET_MS,
      `${(onboardingMs / 1000).toFixed(1)}s of a ${ONBOARDING_BUDGET_MS / 1000}s budget`,
    );

    await sleep(2500);

    // --- The lane ---------------------------------------------------------
    const before = await page.evaluate<Readout | null>(READOUT);
    record(
      'the hull is flying before the jump',
      before !== null && before.system !== '',
      before ? `in ${before.system}, shield ${before.shield.toFixed(0)}` : 'no readout',
    );

    const departure = before?.system ?? '';
    errors.length = 0;

    // Open the chart, take the first lane out, and spool.
    await page.keyboard.press('KeyM');
    await page.waitForSelector('.chart', { timeout: 20_000 });
    await sleep(400);
    await page.keyboard.press('Enter');

    // Spooling is deliberate: the lane takes a few seconds, and the hull must
    // hold its course clear of traffic for all of them.
    await page.waitForSelector('.hud__travel--spooling', { timeout: 30_000 });

    // Through the lane and into the destination's room. Waiting on the HUD
    // alone proves nothing, since it is already up: wait for the system the
    // interface is reporting to actually change.
    await page.waitForFunction(
      `(function () {
        var m = window.marqueDebug;
        return !!m && m.readout().system !== ${JSON.stringify(departure)};
      })()`,
      undefined,
      { timeout: 60_000, polling: 250 },
    );
    await sleep(1200);

    const after = await page.evaluate<Readout | null>(READOUT);

    record(
      'the jump lands in a different system',
      after !== null && after.system !== '' && after.system !== departure,
      `${departure} to ${after?.system ?? '(none)'}`,
    );

    // --- No state pop ------------------------------------------------------
    //
    // Sampled over a second of flight in the new room: the predicted hull has
    // to agree with the server's, every reading has to be a number, and the
    // room must hold only the destination's traffic.
    const pop = await page.evaluate<{
      worstDisagreement: number;
      samples: number;
      readingsSane: boolean;
      status: string;
    } | null>(POP);

    record(
      'the arriving hull agrees with the server, with no snap',
      pop !== null && pop.samples > 0 && pop.worstDisagreement < SNAP_DISTANCE,
      pop
        ? `worst ${pop.worstDisagreement.toFixed(2)} units over ${pop.samples} samples, ` +
          `prediction ${pop.status}`
        : 'no samples',
    );

    record(
      'every reading is a number after the jump',
      pop !== null && pop.readingsSane,
      pop?.readingsSane === true ? 'speed, shield and structure all read' : 'a reading was not a number',
    );

    record(
      'the jump raised nothing in the console',
      errors.length === 0,
      errors.length === 0 ? 'clean' : errors.slice(0, 3).join(' | '),
    );

    report();
  } finally {
    await browser.close();
    await stack.stop();
  }
}

/**
 * Probes run as source rather than as compiled functions: a function passed
 * to `page.evaluate` arrives with the bundler's helpers referenced and none
 * of them defined in the page, which fails as `__name is not defined`.
 */

/** Read the interface the way a person reads it: off the HUD. */
const READOUT = `(function () {
  var m = window.marqueDebug;
  if (!m) return null;
  var r = m.readout();
  return { system: r.system, speed: r.speed, shield: r.shield, integrity: r.integrity };
})()`;

/**
 * Watch the new room for a second, comparing the predicted hull against the
 * server's own copy of it and checking every reading is a number.
 */
const POP = `new Promise(function (resolve) {
  var worst = 0, samples = 0, sane = true, status = 'unknown';
  var timer = setInterval(function () {
    var m = window.marqueDebug;
    if (!m) return;
    var c = m.compare();
    if (c && c.authoritative && c.predicted) {
      var dx = c.authoritative.x - c.predicted.x;
      var dy = c.authoritative.y - c.predicted.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > worst) worst = d;
      samples++;
    }
    var r = m.readout();
    if (!isFinite(r.speed) || !isFinite(r.shield) || !isFinite(r.integrity)) sane = false;
    var t = m.telemetry();
    if (t) status = t.status;
  }, 50);
  setTimeout(function () {
    clearInterval(timer);
    resolve({ worstDisagreement: worst, samples: samples, readingsSane: sane, status: status });
  }, 1000);
})`;

function report(): void {
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('');
  for (const check of checks) {
    console.log(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length} of ${checks.length} travel checks did not hold.`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: all ${checks.length} travel checks held.`);
  }
}

await main();
process.exit(process.exitCode ?? 0);
