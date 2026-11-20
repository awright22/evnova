/**
 * The audio audit.
 *
 * Spec section 3: "You can't hear audio either, so check it by measurement:
 * loudness-normalize every file, confirm every row in the feedback table has
 * a sound mapped, and log which sound events fire during a scripted session."
 *
 * There are no files — every sound in the game is synthesised, because no
 * openly licensed audio that fits the direction is reachable from the build
 * environment and the spec's stated fallback is to make it in code — so the
 * first clause has nothing to normalise. The second is a unit test:
 * `packages/client/src/audio/log.test.ts` parses the feedback table out of
 * `docs/ART_DIRECTION.md` and fails if a row has no sound.
 *
 * This is the third. It drives a real browser through a scripted session and
 * reads back what the client actually played, which is the only way to tell
 * a sound that is wired from a sound that is merely written.
 *
 *   pnpm audio
 *
 * Writes `artifacts/audio.json` and prints a table. A sound the session did
 * not reach is reported rather than failed: a dividend falls on the world's
 * own clock and a write-off needs somebody willing to do it, and neither
 * belongs in the exit code of a five-minute run. What does fail it is a
 * sound the session *should* have reached and did not.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Playwright from 'playwright';

import { findChromium, LAUNCH_ARGS } from '@marque/shots/browser';
import { sleep, start, waitForHttp, type ManagedProcess } from '@marque/shots/processes';
import { requirePortFree } from '@marque/harness';
import { runSeed } from '@marque/harness/seed';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const SERVER_PORT = 2578;
const PREVIEW_PORT = 4174;
const CALLSIGN = 'Ear to the Hull';

/**
 * What a session that flies, fights, trades and travels should reach.
 *
 * Anything here that does not sound fails the run. The rest of the sounds
 * are still logged — they are just not things a five-minute scripted
 * session can be relied on to cause.
 */
const EXPECTED = [
  'engine',
  'thruster',
  'gun',
  'lock',
  'hover',
  'select',
  'stamp',
  'spool',
  'jump',
  'arrival',
  'land',
  'launch',
] as const;

/**
 * Sounds a session like this one cannot be relied on to cause.
 *
 * Listed so the report says why each is absent rather than leaving a
 * reader to wonder. A dividend falls on the world's own clock; a write-off
 * needs somebody willing to do it; a boarding needs a hull adrift. These
 * are covered by the verify harnesses and by the feedback-table test, not
 * by five minutes of flying.
 */
const OUT_OF_REACH: Record<string, string> = {
  dividend: "the Bourse pays on the world's clock, not on a captain's action",
  commission: 'a Factor pays on delivery, which is a voyage of its own',
  claim: 'needs the captain to be written off',
  boarded: 'needs a hull adrift alongside',
  posted: 'needs the Prize Court to post the captain',
  explosionLarge: 'needs a freighter to go up',
  explosionSmall: 'needs a hull to go up',
  moduleDisabled: 'needs a module shot off something',
  missile: 'the seeded draught carries no rack',
  turret: 'the seeded draught carries no turret',
  beam: 'the seeded draught carries no beam',
  intercept: 'needs point defense and something to intercept',
  filled: 'needs a standing order to fill on the market tick',
  called: 'needs a short position to be closed out',
  confirm: 'needs a convoy to dissolve',
  refused: 'needs a counter to decline something',
  contact: 'needs another captain to arrive while this one is watching',
  chat: "needs another captain to say something: a captain's own line is not a notice",
  shieldHit: 'needs a round to land',
  hullHit: 'needs a round to land through shields',
};

interface Heard {
  readonly name: string;
  readonly at: number;
}

/**
 * A screen the voyage had to reach.
 *
 * This is the only harness that flies a browser through a whole voyage, so
 * it carries the screen checks too. It was the first thing to notice that
 * a captain who landed could never launch again: the verify harnesses fly
 * the bot client, which has no screens, and the capture harness lands for
 * a photograph and never leaves.
 */
interface Check {
  readonly name: string;
  readonly passed: boolean;
}

const checks: Check[] = [];

function record(name: string, passed: boolean): void {
  checks.push({ name, passed });
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}`);
}

async function main(): Promise<void> {
  const playwright = (await import('playwright')) as typeof Playwright;
  const processes: ManagedProcess[] = [];

  try {
    console.log('Building client...');
    const build = start('client build', 'pnpm', ['--filter', '@marque/client', 'run', 'build'], {
      cwd: REPO_ROOT,
      env: { MARQUE_SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}` },
    });
    const code = await new Promise<number>((done) =>
      build.child.on('exit', (exit) => done(exit ?? 1)),
    );
    if (code !== 0) throw new Error(`client build failed:\n${build.output()}`);

    // A throwaway database, cleared first: the last run's captain is still
    // in the old one, and a callsign is unique on the Register.
    const scratchDb = resolve(REPO_ROOT, 'artifacts/audio.db');
    await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${scratchDb}${suffix}`, { force: true });
    }
    const worldEnv = {
      PORT: String(SERVER_PORT),
      NODE_ENV: 'development',
      DATABASE_URL: scratchDb,
      STARTING_MARKS: '400000',
    };

    // A captain with a gun, cargo to sell and a berth to come alongside.
    console.log('Seeding the captain...');
    const tokens = await runSeed(
      [
        {
          callsign: CALLSIGN,
          at: 'the-bourse',
          flying: 'force-majeure',
          cargo: { ice: 20 },
        },
      ],
      worldEnv,
    );
    const deviceToken = tokens[CALLSIGN];
    if (deviceToken === undefined) throw new Error(`no device token seeded for ${CALLSIGN}`);

    // Nothing of an earlier run may still be listening.
    await requirePortFree(SERVER_PORT, 'a game server');
    await requirePortFree(PREVIEW_PORT, 'a client preview');

    console.log('Starting game server...');
    const server = start('game server', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: resolve(REPO_ROOT, 'packages/server'),
      env: worldEnv,
    });
    processes.push(server);
    await waitForHttp(server, `http://127.0.0.1:${SERVER_PORT}/matchmake/`);

    console.log('Starting client preview...');
    const preview = start(
      'client preview',
      'pnpm',
      ['exec', 'vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
      { cwd: resolve(REPO_ROOT, 'packages/client') },
    );
    processes.push(preview);
    const baseUrl = `http://127.0.0.1:${PREVIEW_PORT}`;
    await waitForHttp(preview, baseUrl);

    // Something to shoot at and somebody to say something, so the session
    // reaches the rows that need another hull in the sky.
    console.log('Flying bots...');
    const bots = start(
      'bot traffic',
      'pnpm',
      [
        'exec', 'tsx', 'tools/bot/src/main.ts',
        '--bots', '2',
        '--seconds', '600',
        '--brain', 'wander',
        '--system', 'parity',
        '--endpoint', `ws://127.0.0.1:${SERVER_PORT}`,
        '--quiet',
      ],
      { cwd: REPO_ROOT },
    );
    processes.push(bots);
    await sleep(5000);

    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
      args: [
        ...LAUNCH_ARGS,
        // Web Audio in a headless browser will not start without this, and
        // a context that never resumes reports nothing.
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
      ...(executablePath ? { executablePath } : {}),
    });

    const heard = await listen(browser, baseUrl, deviceToken);
    await browser.close();

    await report(heard);
  } finally {
    await Promise.allSettled(processes.map((proc) => proc.stop()));
  }
}

/** Drive one session and read back what it played. */
async function listen(
  browser: Playwright.Browser,
  baseUrl: string,
  deviceToken: string,
): Promise<readonly Heard[]> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  // The seeded captain's credentials, where the client keeps its own. The
  // callsign alone is not enough: the captain already exists, so signing up
  // under it is refused and the page sits on the Register.
  await page.addInitScript(
    ([name, token]: [string, string]) => {
      try {
        localStorage.setItem('marque.callsign', name);
        localStorage.setItem('marque.deviceToken', token);
        // Nothing to be told: a hint over the screen would be clicked by
        // the script below and counted as a press that nobody made.
        localStorage.setItem('marque.pilotage', JSON.stringify({ done: [], confirmed: true }));
        localStorage.setItem(
          'marque.hints',
          JSON.stringify(['staple', 'yard', 'moorings', 'bourse', 'factor', 'chart',
            'offers', 'convoy', 'register', 'range', 'boarding']),
        );
      } catch {
        // Storage disabled: the page lands on the Register and the run
        // fails with a selector timeout, which is the truth.
      }
    },
    [CALLSIGN, deviceToken] as [string, string],
  );

  // `harness=1` publishes the room for the flying below and turns the full
  // audio log on; `callsign` joins as the seeded captain.
  await page.goto(`${baseUrl}/?harness=1&callsign=${encodeURIComponent(CALLSIGN)}`, {
    waitUntil: 'networkidle',
  });
  await sky(page, problems, 'at the start');
  record('a captain who signs in is in the sky', true);
  await page.waitForTimeout(1200);

  // The order matters. A captain who jumps first arrives in the middle of
  // a system with no berth in reach, and the landing half of the session
  // never happens — which is how the first version of this failed.

  // 1. The gesture that starts the audio. The seeded captain is alongside
  //    a berth already, so this is also the approach.
  console.log('  waking the audio');
  await page.focus('body');
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(600);

  // 2. Alongside: the clamps, and the hull settling against them.
  console.log('  landing');
  await page.keyboard.press('KeyL');
  await page.waitForSelector('.port', { timeout: 30_000 });
  record('coming alongside opens the berth', true);
  await page.waitForTimeout(800);

  // 3. The floor: hovering, pressing, and the stamp twice — bought and
  //    sold, which are the two rows the table gives the stamp.
  console.log('  trading');
  const floor = page
    .locator('.port__service-list')
    .getByRole('button', { name: /open the floor/i });
  if (await floor.count() > 0) {
    await floor.first().hover();
    await page.waitForTimeout(250);
    await floor.first().click();
    await page.waitForSelector('.staple__table', { timeout: 20_000 });
    await page.waitForTimeout(500);

    const orders = page.locator('.staple__order:not([disabled])');
    const howMany = Math.min(3, await orders.count());
    for (let i = 0; i < howMany; i += 1) {
      await orders.nth(i).click({ noWaitAfter: true });
      await page.waitForTimeout(700);
    }
    await page.getByRole('button', { name: /back to the berth/i }).first().click();
    await page.waitForTimeout(600);
  }

  // 4. The clamps letting go.
  console.log('  launching');
  // By role and name, not by `:text()`. The control reads "Launch L" — the
  // key hint is a span inside it — and `:text("Launch")` found nothing, so
  // the first version of this quietly stayed at the berth and failed
  // thirty seconds later waiting for a sky it had never asked for.
  const launch = page.getByRole('button', { name: /launch/i }).first();
  await launch.click({ timeout: 10_000 });
  await page.waitForTimeout(3000);
  await sky(page, problems, 'after launching');
  record('launching puts the captain back in the sky', true);
  await page.focus('body');

  // 5. Under way, and turning: the engine loop and the manoeuvring jets.
  console.log('  flying');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1800);
  await page.keyboard.up('ArrowUp');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(450);
    await page.keyboard.up(key);
    await page.waitForTimeout(450);
  }

  // 6. Marking a contact and firing on it.
  console.log('  marking and firing');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2500);
  await page.keyboard.up('Space');

  // 7. Saying something. The tick belongs to a line somebody else sent —
  //    a captain's own words are not news to them — so this exercises the
  //    composer rather than the notice.
  console.log('  chat');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.keyboard.type('Testing the hull.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 8. The chart: a lane hovered, a course plotted, then spooled and taken.
  //    The lane link only picks a system out; plotting is its own control,
  //    and the first version of this clicked the first and never the
  //    second, so J opened the chart again and nothing ever spooled.
  console.log('  plotting');
  await page.keyboard.press('KeyM');
  await page.waitForSelector('.chart', { timeout: 20_000 });
  await page.waitForTimeout(500);
  const lane = page.locator('.chart__lane-link').first();
  if (await lane.count() > 0) {
    await lane.hover();
    await page.waitForTimeout(300);
    await lane.click();
    await page.waitForTimeout(500);
  }
  // Which system the chart is actually offering, not just that a button is
  // there. The lane check downstream reported `parity -> parity` twice with
  // no way to tell whether the jump failed or the course was plotted for the
  // system the captain was already in.
  const chosen = await page.locator('.chart__detail h3').first().textContent().catch(() => null);
  const plot = page.getByRole('button', { name: /plot the course/i }).first();
  const plotted = (await plot.count()) > 0;
  if (plotted) {
    await plot.click();
    await page.waitForTimeout(900);
  } else {
    await page.keyboard.press('Escape');
  }
  record(
    `a course can be plotted from the chart (${chosen ?? 'nothing chosen'})`,
    plotted,
  );
  await page.waitForTimeout(400);

  console.log('  jumping');
  const before = await page.evaluate(`(function () {
    var h = window.__marqueHarness;
    return h ? h.room.state.systemId : '';
  })()`);
  await page.keyboard.press('KeyJ');
  // Waited for, not timed.
  //
  // This was a flat fourteen seconds — four of spool, the lane, and the
  // arrival on the far side — which is about right on an idle machine and
  // not enough on one that has been building clients and driving browsers
  // all evening. It failed once that way, reporting `parity -> parity`, and
  // a check that fails because the box was busy says nothing about the game.
  let after = String(before);
  const laneBy = Date.now() + 45_000;
  while (Date.now() < laneBy) {
    await page.waitForTimeout(500);
    after = String(
      await page.evaluate(`(function () {
        var h = window.__marqueHarness;
        return h ? h.room.state.systemId : '';
      })()`),
    );
    if (after !== '' && after !== String(before)) break;
  }
  record(
    `a plotted lane takes the captain somewhere else (${String(before)} -> ${String(after)})`,
    after !== '' && after !== before,
  );

  const log = await page.evaluate(() => {
    const audio = (globalThis as { __marqueAudio?: { heard: Heard[] } }).__marqueAudio;
    return audio?.heard ?? [];
  });

  // The bed is a state, not an event, so it is read rather than counted.
  const bed = await page.evaluate(() => {
    const audio = (
      globalThis as { __marqueAudio?: { music?: { started: boolean; region: string } } }
    ).__marqueAudio;
    return audio?.music ?? { started: false, region: '' };
  });
  record(
    `the region's bed is playing (${bed.region === '' ? 'nowhere' : bed.region})`,
    bed.started,
  );

  if (problems.length > 0) {
    console.warn(`  page errors:\n    ${problems.slice(0, 5).join('\n    ')}`);
  }
  await context.close();
  return log;
}

/**
 * Wait for the sky, and say what is on the screen if it never comes.
 *
 * A selector timeout names the selector and nothing else, which in a
 * session this long is the least useful sentence available. The berth's own
 * notice line usually says exactly why the captain is still standing on it.
 */
async function sky(
  page: Playwright.Page,
  problems: readonly string[],
  when: string,
): Promise<void> {
  try {
    await page.waitForSelector('.hud', { timeout: 30_000 });
  } catch (error) {
    const body = (await page.locator('body').innerText()).slice(0, 600);
    throw new Error(
      `never reached the sky ${when}.\nOn screen:\n${body}\n`
        + (problems.length > 0 ? `Errors:\n  ${problems.slice(0, 5).join('\n  ')}` : ''),
      { cause: error },
    );
  }
}

/** Print the log, write it, and decide the exit code. */
async function report(heard: readonly Heard[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const event of heard) counts.set(event.name, (counts.get(event.name) ?? 0) + 1);

  console.log('\nSounds heard during the session:');
  const names = [...counts.keys()].sort();
  for (const name of names) {
    console.log(`  ${name.padEnd(16)} ${String(counts.get(name) ?? 0).padStart(5)}`);
  }

  const missing = EXPECTED.filter((name) => !counts.has(name));
  if (missing.length > 0) {
    console.error(`\nExpected but never heard: ${missing.join(', ')}`);
  }

  const absent = Object.entries(OUT_OF_REACH).filter(([name]) => !counts.has(name));
  if (absent.length > 0) {
    console.log('\nNot reached by this session, and why:');
    for (const [name, why] of absent) console.log(`  ${name.padEnd(16)} ${why}`);
  }

  await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
  await writeFile(
    resolve(REPO_ROOT, 'artifacts/audio.json'),
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        events: heard.length,
        counts: Object.fromEntries([...counts.entries()].sort()),
        checks,
        expected: EXPECTED,
        missing,
        notReached: Object.fromEntries(
          Object.entries(OUT_OF_REACH).filter(([name]) => !counts.has(name)),
        ),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${heard.length} event(s) logged to artifacts/audio.json`);

  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    console.error(`\nThe voyage failed ${failed.length} check(s):`);
    for (const check of failed) console.error(`  ${check.name}`);
  }

  if (missing.length > 0 || failed.length > 0) process.exitCode = 1;
}

await main();
