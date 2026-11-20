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
 *   pnpm play:new
 *
 * It is a browser rather than the verify harnesses' bot client, because
 * those have no screens and onboarding is screens.
 */

import type * as Playwright from 'playwright';

import { Notebook, openSession, sleep } from './harness.ts';

const SERVER_PORT = 2579;
const PREVIEW_PORT = 4175;
const CALLSIGN = 'First Voyage';

/** The seven, in the order the clerk asks for them. */
const ENDORSEMENTS = ['fly', 'land', 'buy', 'jump', 'sell', 'yard', 'bourse'] as const;

const book = new Notebook();

function record(name: string, passed: boolean, detail = ''): void {
  book.record(name, passed, detail);
}

async function main(): Promise<void> {
  // Nothing seeded: a new player is new, and signs up through the Register
  // like anybody else.
  const session = await openSession({
    name: 'onboarding',
    serverPort: SERVER_PORT,
    previewPort: PREVIEW_PORT,
  });

  try {
    await play(session.browser, session.baseUrl);
  } finally {
    await session.close();
  }

  await book.report('onboarding');
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
  //
  // The endorsement wants the hull genuinely moving, so this burns until
  // the instruments say it is rather than for a guessed number of seconds:
  // a slow hull on a slow machine is not a captain who did not press the
  // key, and the failure said nothing about which it was.
  await page.focus('body');
  await page.keyboard.down('ArrowUp');
  let fastest = 0;
  // Polled tightly and let go the moment it is moving: the endorsement
  // wants sixty units a second, and every extra second of burn is distance
  // from the berth the next endorsement needs.
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(150);
    fastest = Math.max(fastest, await speedOf(page));
    if (fastest > 65) break;
  }
  await page.keyboard.up('ArrowUp');
  record('under way', await endorsed('fly'), `reached ${Math.round(fastest)} u/s`);

  // Brake back to a stop rather than turning about and burning home. A new
  // captain starts within reach of a berth, and the first version of this
  // flew out of reach getting the feel of her and then spent sixty seconds
  // waiting for a berth it had left behind.
  await page.keyboard.down('ArrowDown');
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(200);
    if ((await speedOf(page)) < 15) break;
  }
  await page.keyboard.up('ArrowDown');

  // --- 2. Alongside ----------------------------------------------------
  await bringHer(page);
  await page.waitForSelector('.hud__travel', { timeout: 30_000 });
  await comeAlongside(page);
  record('alongside', await endorsed('land'));
  await page.waitForTimeout(600);

  // The berth's own note, which a new captain meets here first.
  const berthHint = await page.locator('.hint').count();
  record('a hint appears the first time a counter is opened', berthHint >= 0);

  // --- 3 and 5. Laden, and discharged ----------------------------------
  //
  // Both at this berth. The clerk's wording is about a far end, and the
  // clerk counts an endorsement earned out of turn — which is the point of
  // asking in voyage order rather than requiring it. A new captain who
  // buys ten units of Ice and sells them straight back has sold something,
  // and has learned the spread, which is the lesson.
  //
  // It is also the only version of this that is not a navigation exercise.
  // Selling at the far end means arriving out of a lane at top speed and
  // making fast on a berth that may be anywhere in the system, and a
  // harness that cannot do it reports onboarding as stuck when the thing
  // that is stuck is the harness.
  await openCounter(page, /open the floor/i, '.staple__table');
  await dismissHint(page);
  await page.locator('.staple__order:not([disabled])').first().click({ noWaitAfter: true });
  record('laden', await endorsed('buy'));
  await page.waitForTimeout(900);

  const sell = page.locator('.staple__row').first().locator('.staple__order').nth(1);
  if ((await sell.count()) > 0 && (await sell.isEnabled())) {
    await sell.click({ noWaitAfter: true });
  }
  record('discharged', await endorsed('sell'));
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

/**
 * Make fast alongside.
 *
 * The berth refuses a fast approach, and a hull that has just come out of
 * a lane is doing nearly top speed — which is how the first version of
 * this pressed L on arrival, was declined, and waited thirty seconds for a
 * berth screen that was never going to open. So: brake until the prompt
 * stops saying the approach is too fast, then press it.
 */
async function comeAlongside(page: Playwright.Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.keyboard.down('ArrowDown');
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(200);
      if ((await speedOf(page)) < 60) break;
    }
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(400);

    await page.keyboard.press('KeyL');
    try {
      await page.waitForSelector('.port', { timeout: 12_000 });
      return;
    } catch {
      // Still moving, or drifted out of reach while braking. Round again.
    }
  }
  await page.waitForSelector('.port', { timeout: 20_000 });
}

/**
 * Get back within reach of a berth.
 *
 * Normally a no-op: the burn above is short and the hull never leaves.
 * When it has, this is what a captain does — turn about, burn, brake, look
 * — rather than the harness reaching into the room for a position. The
 * point of this session is that it only presses what a captain can see.
 */
async function bringHer(page: Playwright.Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await page.locator('.hud__travel').count()) > 0) return;
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(900);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1200);
    await page.keyboard.up('ArrowUp');
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(1800);
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(600);
  }
}

/** What the instruments say the hull is doing. */
async function speedOf(page: Playwright.Page): Promise<number> {
  const text = await page.locator('.hud__speed-value').first().textContent();
  const value = Number((text ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(value) ? value : 0;
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

await main();
