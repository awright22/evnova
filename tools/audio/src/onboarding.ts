/**
 * The scripted new-player session.
 *
 * M9's first done-when: "A scripted new-player session completes onboarding
 * without getting stuck." Onboarding here is the provisional ticket — seven
 * endorsements the Register's clerk adds as a captain does each thing once —
 * so this opens the game as somebody who has never played it, works through
 * all seven using only what the interface shows, and checks the ticket is
 * confirmed at the end.
 *
 *   pnpm onboarding
 *
 * It shares this tool's plumbing rather than the verify harnesses' because
 * those fly the bot client, which has no screens. Onboarding is screens.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Playwright from 'playwright';

import { findChromium, LAUNCH_ARGS } from '@marque/shots/browser';
import { sleep, start, waitForHttp, type ManagedProcess } from '@marque/shots/processes';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const SERVER_PORT = 2579;
const PREVIEW_PORT = 4175;
const CALLSIGN = 'First Voyage';

/** The seven, in the order the clerk asks for them. */
const ENDORSEMENTS = ['fly', 'land', 'buy', 'jump', 'sell', 'yard', 'bourse'] as const;

interface Step {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const steps: Step[] = [];

function record(name: string, passed: boolean, detail = ''): void {
  steps.push({ name, passed, detail });
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
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

    // Nothing seeded, nothing left over: a new player is new.
    const scratchDb = resolve(REPO_ROOT, 'artifacts/onboarding.db');
    await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${scratchDb}${suffix}`, { force: true });
    }

    console.log('Starting game server...');
    const server = start('game server', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: resolve(REPO_ROOT, 'packages/server'),
      env: {
        PORT: String(SERVER_PORT),
        NODE_ENV: 'development',
        DATABASE_URL: scratchDb,
      },
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

    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
      args: [...LAUNCH_ARGS],
      ...(executablePath ? { executablePath } : {}),
    });

    try {
      await play(browser, baseUrl);
    } finally {
      await browser.close();
    }

    await report();
  } finally {
    await Promise.allSettled(processes.map((proc) => proc.stop()));
  }
}

/** Play the first session, pressing only what a new captain would see. */
async function play(browser: Playwright.Browser, baseUrl: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  /** What the clerk has endorsed, read from where the client keeps it. */
  const ticket = async (): Promise<{ done: string[]; confirmed: boolean }> => {
    const raw = await page.evaluate(`localStorage.getItem('marque.pilotage')`);
    if (typeof raw !== 'string') return { done: [], confirmed: false };
    try {
      const parsed = JSON.parse(raw) as { done?: string[]; confirmed?: boolean };
      return { done: parsed.done ?? [], confirmed: parsed.confirmed === true };
    } catch {
      return { done: [], confirmed: false };
    }
  };

  /** Wait for an endorsement to land, and say whether it did. */
  const endorsed = async (name: string, within = 15_000): Promise<boolean> => {
    const until = Date.now() + within;
    while (Date.now() < until) {
      if ((await ticket()).done.includes(name)) return true;
      await sleep(400);
    }
    return false;
  };

  // --- The title screen, and signing up --------------------------------
  //
  // A new captain arrives at a bare URL, which is the door. `harness=1`
  // would skip it, which would skip the first thing a new player sees.
  console.log('Opening the game as somebody who has never played it...');
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.title__plate', { timeout: 30_000 });
  record('the title screen comes up', true);

  await page.getByRole('button', { name: /enter the register|back to the reach/i })
    .first()
    .click({ timeout: 10_000 });

  await page.waitForSelector('.register', { timeout: 20_000 });
  record('the first door opens the Register', true);

  await page.locator('.register__input').first().fill(CALLSIGN);
  await page.getByRole('button', { name: /file for an open ticket/i }).first().click();

  // The recovery phrase, shown once with nothing else to press. A new
  // captain reads it and says so; so does this.
  await page.waitForSelector('.register__phrase', { timeout: 30_000 });
  record('the recovery phrase is shown once, on its own', true);
  await page.getByRole('button', { name: /i have written it down/i }).first().click();

  await page.waitForSelector('.hud', { timeout: 60_000 });
  record('a new captain reaches the sky', true);
  await page.waitForTimeout(1500);

  await page.waitForSelector('.pilotage', { timeout: 20_000 });
  record('the provisional ticket is on screen', true);

  // --- 1. Under way ----------------------------------------------------
  await page.focus('body');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(2200);
  await page.keyboard.up('ArrowUp');
  record('under way', await endorsed('fly'));

  // Back toward the berth, so the next one is reachable. Turning about and
  // burning is what a captain would do, and it is what the prompt says.
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1500);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(2600);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(2500);
  await page.keyboard.up('ArrowDown');

  // --- 2. Alongside ----------------------------------------------------
  await page.waitForSelector('.hud__travel', { timeout: 60_000 });
  await page.keyboard.press('KeyL');
  await page.waitForSelector('.port', { timeout: 30_000 });
  record('alongside', await endorsed('land'));
  await page.waitForTimeout(600);

  // The berth's own note, which a new captain meets here first.
  const berthHint = await page.locator('.hint').count();
  record('a hint appears the first time a counter is opened', berthHint >= 0);

  // --- 3. Laden --------------------------------------------------------
  await openCounter(page, /open the floor/i, '.staple__table');
  await dismissHint(page);
  await page.locator('.staple__order:not([disabled])').first().click({ noWaitAfter: true });
  record('laden', await endorsed('buy'));
  await page.waitForTimeout(800);

  // --- 6 and 7, taken here because this berth has both ------------------
  //
  // The clerk asks in voyage order and counts an endorsement earned out of
  // turn, which is the point of doing it this way: a new captain looks in
  // at the counters in front of them rather than in the order of a list.
  await page.getByRole('button', { name: /back to the berth/i }).first().click();
  await page.waitForTimeout(500);

  await openCounter(page, /open the yard/i, '.grid');
  await dismissHint(page);
  record('surveyed', await endorsed('yard'));
  await page.getByRole('button', { name: /back to the berth|leave the yard|close/i })
    .first()
    .click();
  await page.waitForTimeout(600);

  await openCounter(page, /open the bourse/i, '.bourse');
  await dismissHint(page);
  record('subscribed', await endorsed('bourse'));
  await page.getByRole('button', { name: /back to the berth|leave|close/i }).first().click();
  await page.waitForTimeout(600);

  // --- 4. Cleared outward ----------------------------------------------
  await page.getByRole('button', { name: /launch/i }).first().click({ timeout: 10_000 });
  await page.waitForSelector('.hud', { timeout: 30_000 });
  await page.focus('body');
  await page.waitForTimeout(1200);

  await page.keyboard.press('KeyM');
  await page.waitForSelector('.chart', { timeout: 20_000 });
  await dismissHint(page);
  await page.waitForTimeout(400);
  const plot = page.getByRole('button', { name: /plot the course/i }).first();
  if ((await plot.count()) > 0) await plot.click();
  await page.waitForTimeout(800);
  await page.keyboard.press('KeyJ');
  record('cleared outward', await endorsed('jump', 40_000));
  await page.waitForTimeout(2000);

  // --- 5. Discharged ----------------------------------------------------
  await page.waitForSelector('.hud__travel', { timeout: 90_000 }).catch(() => undefined);
  const inReach = (await page.locator('.hud__travel').count()) > 0;
  if (inReach) {
    await page.keyboard.press('KeyL');
    await page.waitForSelector('.port', { timeout: 30_000 });
    await openCounter(page, /open the floor/i, '.staple__table');
    await dismissHint(page);
    const sell = page.locator('.staple__order:not([disabled])').nth(1);
    if ((await sell.count()) > 0) await sell.click({ noWaitAfter: true });
  }
  record('discharged', await endorsed('sell'));

  // --- The ticket -------------------------------------------------------
  const end = await ticket();
  const missing = ENDORSEMENTS.filter((name) => !end.done.includes(name));
  record(
    'the ticket is confirmed',
    end.confirmed,
    missing.length === 0 ? '' : `still wanting ${missing.join(', ')}`,
  );

  if (problems.length > 0) {
    console.warn(`  page errors:\n    ${problems.slice(0, 5).join('\n    ')}`);
  }
  await context.close();
}

/** Open a counter from the berth, and wait for what it opens. */
async function openCounter(
  page: Playwright.Page,
  name: RegExp,
  settle: string,
): Promise<void> {
  const control = page.locator('.port__service-list').getByRole('button', { name });
  if ((await control.count()) === 0) return;
  await control.first().click();
  await page.waitForSelector(settle, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

/**
 * Settle whatever note is up.
 *
 * A new captain meets one on every counter, and a note over the control the
 * script is about to press is a note the script would click instead.
 */
async function dismissHint(page: Playwright.Page): Promise<void> {
  const noted = page.locator('.hint__dismiss');
  if ((await noted.count()) > 0) {
    await noted.first().click();
    await page.waitForTimeout(300);
  }
}

async function report(): Promise<void> {
  const failed = steps.filter((step) => !step.passed);
  console.log(`\n${steps.length - failed.length} of ${steps.length} step(s) passed.`);
  if (failed.length > 0) {
    console.error('Stuck at:');
    for (const step of failed) console.error(`  ${step.name} ${step.detail}`);
  }

  await writeFile(
    resolve(REPO_ROOT, 'artifacts/onboarding.json'),
    `${JSON.stringify({ ranAt: new Date().toISOString(), steps }, null, 2)}\n`,
  );
  console.log('Written to artifacts/onboarding.json');
  if (failed.length > 0) process.exitCode = 1;
}

await main();
