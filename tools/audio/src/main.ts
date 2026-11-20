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
  'chat',
] as const;

interface Heard {
  readonly name: string;
  readonly at: number;
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
  try {
    await page.waitForSelector('.hud', { timeout: 30_000 });
  } catch (error) {
    // What the page is actually showing says more than the selector does.
    const body = (await page.locator('body').innerText()).slice(0, 400);
    throw new Error(
      `the session never reached the sky.\nOn screen:\n${body}\n`
        + (problems.length > 0 ? `Errors:\n  ${problems.slice(0, 5).join('\n  ')}` : ''),
      { cause: error },
    );
  }
  await page.waitForTimeout(1200);

  // 1. The gesture that starts the audio, and the engine with it.
  console.log('  flying');
  await page.focus('body');
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(400);

  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1800);
  await page.keyboard.up('ArrowUp');

  // 2. Turning, which is the manoeuvring jets.
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(500);
    await page.keyboard.up(key);
    await page.waitForTimeout(500);
  }

  // 3. Marking a contact and firing on it. The mark is the lock; the
  //    trigger is the gun, and whatever it hits is a hit.
  console.log('  marking and firing');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2500);
  await page.keyboard.up('Space');

  // 4. Saying something, which another captain's client would tick at.
  //    Here the tick is this captain's own: the chat path is the same, and
  //    the alternative is a second browser for one sound.
  console.log('  chat');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.type('Testing the hull.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 5. Hovering and pressing, which every control in the game answers.
  console.log('  controls');
  await page.keyboard.press('KeyM');
  await page.waitForSelector('.chart', { timeout: 20_000 });
  await page.waitForTimeout(400);
  const lane = page.locator('.chart__lane-link').first();
  if (await lane.count() > 0) {
    await lane.hover();
    await page.waitForTimeout(250);
    await lane.click();
    await page.waitForTimeout(600);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 6. The lane: spool, release, arrive.
  console.log('  jumping');
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(9000);

  // 7. Alongside, and the floor: a stamp that takes and one that is
  //    refused.
  console.log('  landing and trading');
  await page.waitForSelector('.hud__travel', { timeout: 30_000 });
  await page.keyboard.press('KeyL');
  await page.waitForSelector('.port', { timeout: 30_000 });
  await page.waitForTimeout(600);

  const floor = page.locator('.port__service-list button:text("Open the floor")');
  if (await floor.count() > 0) {
    await floor.first().click();
    await page.waitForSelector('.staple__table', { timeout: 20_000 });
    await page.waitForTimeout(400);
    await page.locator('.staple__row:first-child .staple__order').first().click();
    await page.waitForTimeout(900);
    // A sell, so the other half of the stamp path runs too.
    const sell = page.locator('.staple__row .staple__order:not([disabled])').nth(1);
    if (await sell.count() > 0) {
      await sell.click();
      await page.waitForTimeout(700);
    }
    await page.locator('button:text("Back to the berth")').first().click();
    await page.waitForTimeout(500);
  }

  // 8. Launching again, which is the clamps letting go.
  console.log('  launching');
  const launch = page.locator('button:text("Launch")').first();
  if (await launch.count() > 0) {
    await launch.click();
    await page.waitForTimeout(2500);
  }

  const log = await page.evaluate(() => {
    const audio = (globalThis as { __marqueAudio?: { heard: Heard[] } }).__marqueAudio;
    return audio?.heard ?? [];
  });

  if (problems.length > 0) {
    console.warn(`  page errors:\n    ${problems.slice(0, 5).join('\n    ')}`);
  }
  await context.close();
  return log;
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

  await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
  await writeFile(
    resolve(REPO_ROOT, 'artifacts/audio.json'),
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        events: heard.length,
        counts: Object.fromEntries([...counts.entries()].sort()),
        expected: EXPECTED,
        missing,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${heard.length} event(s) logged to artifacts/audio.json`);

  if (missing.length > 0) process.exitCode = 1;
}

await main();
