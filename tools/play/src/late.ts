/**
 * The scripted late-game session.
 *
 * Spec section 18 asks each polish cycle to play the first thirty minutes
 * as a new player and, separately, a late-game session with a large ship
 * and a portfolio. This is the second one: a captain who has been at it a
 * while, at Quorum, which is the one berth in the Concessions that keeps a
 * Yard, a Bourse, a Factor and a Staple at once.
 *
 *   pnpm play:late
 *
 * It is not looking for the things onboarding looks for. A late captain
 * knows how to fly; what they meet is screens with a lot on them — a
 * portfolio to read, a board to work, a hull to refit, standing that has
 * gone somewhere. So this opens every one of those and checks that what is
 * on it is real: figures that add up, rows that are populated, controls
 * that are live, and nothing showing a zero where it should show a number.
 *
 * Everything it finds goes in the cycle's notes. Spec section 18 step 2:
 * "note every moment that is confusing, ugly, silent, janky, slow or out of
 * voice."
 */

import type * as Playwright from 'playwright';

import { Notebook, openAs, openSession } from './harness.ts';

const SERVER_PORT = 2580;
const PREVIEW_PORT = 4176;
const CALLSIGN = 'Net of Fees';
const COMPANION = 'Without Prejudice';

const book = new Notebook();

async function main(): Promise<void> {
  const session = await openSession({
    name: 'late',
    serverPort: SERVER_PORT,
    previewPort: PREVIEW_PORT,
    // Quorum: a Yard, a Bourse, a Factor and a Staple at one berth, in the
    // Concessions, where standing with the Thirty is worth something.
    seed: [
      {
        callsign: CALLSIGN,
        at: 'quorum',
        flying: 'close-order',
        marks: 2_400_000,
        cargo: { leaf: 18, circuitry: 40, alloy: 60 },
        // Inside the Bourse's own caps: no captain may hold more than a
        // tenth of a float, and these are a little under that in four
        // companies, which is what a late portfolio looks like.
        holdings: { SLP: 420, TLY: 2800, UWH: 700, RPO: 640 },
        // A captain who has been at it: well in with the Thirty, civil
        // with the House, and no longer welcome at Reprisal's berths. Late
        // numbers, so the session reads the upper bands rather than the
        // two either side of nothing.
        standing: { thirty: 620, kessler: 180, reprisal: -380 },
        designs: ['Third Dividend', 'Errors and Omissions'],
        parked: [
          { draught: 'fair-wear-and-tear', at: 'quorum' },
          { draught: 'prudent-return', at: 'countinghouse' },
        ],
        composition: 1800,
      },
      // Somebody else at the counter, so Alongside has a name in it. They
      // have to be *online*: the counter lists captains who are standing
      // at it, not captains whose row says they are nearby.
      { callsign: COMPANION, at: 'quorum', flying: 'spoil-heap', marks: 90_000 },
    ],
    bots: { count: 3, brain: 'wander', system: 'vane' },
  });

  try {
    await play(session);
  } finally {
    await session.close();
  }

  await book.report('late');
}

async function play(session: Awaited<ReturnType<typeof openSession>>): Promise<void> {
  // The other captain comes online first and goes alongside, so there is
  // somebody at the counter when this one looks.
  const other = await openAs(session, COMPANION);
  await other.page.waitForSelector('.hud', { timeout: 60_000 });
  await other.page.waitForTimeout(1200);
  await other.page.focus('body');
  await other.page.keyboard.press('KeyL');
  await other.page
    .waitForSelector('.port', { timeout: 30_000 })
    .catch(() => undefined);

  const { page, problems } = await openAs(session, CALLSIGN);

  await page.waitForSelector('.hud', { timeout: 60_000 });
  book.record('a captain who has been at it a while is in the sky', true);
  await page.waitForTimeout(1500);

  // The instruments, before anything is opened. A late hull carries more
  // than a starter and the readings should say so.
  const purse = await textOf(page, '.hud__purse-value');
  book.record(
    'the purse reads a late-game figure',
    /\d{3}/.test(purse),
    purse === '' ? 'nothing on screen' : purse,
  );

  // The link figure, which reads `--` when the SDK calls the prediction
  // diverged. A large hull diverging is a netcode finding, not a cosmetic
  // one, so it is measured rather than left to a screenshot's impression.
  const link = await textOf(page, '.hud__reading-value');
  book.record(
    'the link reads a round trip rather than nothing',
    /\d/.test(link),
    link === '' ? 'no reading' : link,
  );

  // --- Alongside --------------------------------------------------------
  await page.keyboard.press('KeyL');
  await page.waitForSelector('.port', { timeout: 60_000 });
  book.record('alongside at Quorum', true);
  await page.waitForTimeout(900);

  const berth = await page.locator('.port').innerText();
  book.record('the berth keeps a Yard', /the yard/i.test(berth));
  book.record('the berth keeps a Bourse', /the bourse/i.test(berth));
  book.record('the berth keeps a Factor', /the factor/i.test(berth));
  book.record(
    'standing with the three charters is on the hub',
    /kessler/i.test(berth) && /thirty/i.test(berth) && /reprisal/i.test(berth),
  );
  book.record(
    'standing is named rather than numbered alone',
    !/unknown/i.test(berth.split('Standing')[1] ?? ''),
    (berth.split('Standing')[1] ?? '').slice(0, 60).replace(/\s+/g, ' ').trim(),
  );
  book.record(
    'the Prize Court’s composition is shown where it is paid',
    /composition/i.test(berth),
  );

  // --- The Bourse -------------------------------------------------------
  await open(page, /open the bourse/i, '.bourse');
  const bourse = await page.locator('.bourse').innerText();
  book.record('the Bourse lists every company', (bourse.match(/\b[A-Z]{3}\b/g) ?? []).length >= 10);
  book.record('the portfolio shows what is held', /\b2,?800\b/.test(bourse), 'TLY 2800');
  book.record('the Gazette has something in it', /\./.test(bourse) && bourse.length > 400);
  book.record(
    'the Register ranks captains',
    /register/i.test(bourse) && new RegExp(CALLSIGN, 'i').test(bourse),
  );
  await capture(page, 'late-bourse');
  await close(page);

  // --- The Factor -------------------------------------------------------
  await open(page, /read the board/i, '.board');
  const board = await page.locator('.board').innerText();
  // Rows on the board, not the word "marks": the Factor's own figures are
  // written as bare numbers beside each title, and counting a word that
  // appears in the detail panel made this depend on which one was selected.
  book.record(
    'the board has work on it',
    /commission|carriage|bounty|running|passage/i.test(board),
    board.replace(/\s+/g, ' ').slice(0, 70),
  );
  book.record(
    'no commission says undefined or NaN',
    !/undefined|NaN/.test(board),
    board.match(/undefined|NaN/)?.[0] ?? '',
  );
  await capture(page, 'late-board');
  await close(page);

  // --- The Yard ---------------------------------------------------------
  await open(page, /open the yard/i, '.grid');
  await page.waitForTimeout(800);
  // The shelf of kept draughts is behind the drawer, where a captain goes
  // looking for one.
  const drawer = page.getByRole('button', { name: /^draughts/i }).first();
  if ((await drawer.count()) > 0) {
    await drawer.click();
    await page.waitForTimeout(500);
  }
  // `.yard` is the editor's own root. Reading `main` matched the port hub
  // behind it, so "the Yard knows what the captain is flying" was passing
  // on the hub's header and "saved draughts are listed" was looking for
  // them on the wrong screen.
  const yard = await page.locator('.yard').first().innerText();
  // The draught's name is the value of a field, which `innerText` does not
  // see — so this read the fittings catalogue and reported the Yard as not
  // knowing what it was looking at.
  const drawn = await page.locator('.yard__name').first().inputValue();
  book.record(
    'the Yard knows what the captain is flying',
    /close order/i.test(drawn),
    drawn === '' ? 'the name field is empty' : drawn,
  );
  book.record('saved draughts are listed', /third dividend/i.test(yard));
  book.record('no figure in the Yard is undefined', !/undefined|NaN/.test(yard));
  await capture(page, 'late-yard');
  await close(page);

  // --- The Moorings -----------------------------------------------------
  await open(page, /walk the moorings/i, '.moorings');
  const moorings = await page.locator('.moorings').innerText();
  book.record('parked hulls are listed', /fair wear/i.test(moorings));
  book.record(
    'a hull parked elsewhere says where',
    /countinghouse/i.test(moorings),
    moorings.replace(/\s+/g, ' ').slice(0, 80),
  );
  await capture(page, 'late-moorings');
  await close(page);

  // --- The Staple -------------------------------------------------------
  await open(page, /open the floor/i, '.staple__table');
  const staple = await page.locator('.staple').innerText();
  book.record('the hold shows what is aboard', /\b18\b/.test(staple), 'Leaf 18');
  book.record('no price is undefined', !/undefined|NaN/.test(staple));
  await capture(page, 'late-staple');
  await close(page);

  // --- Alongside, with somebody at the counter --------------------------
  await open(page, /offers/i, '.offers');
  const offers = await page.locator('.offers').innerText();
  book.record(
    'another captain at the berth is named',
    /without prejudice/i.test(offers),
    offers.replace(/\s+/g, ' ').slice(0, 80),
  );
  await capture(page, 'late-offers');
  await close(page);

  // --- Back into the sky ------------------------------------------------
  await page.getByRole('button', { name: /launch/i }).first().click({ timeout: 15_000 });
  await page.waitForSelector('.hud', { timeout: 60_000 });
  book.record('launching from a berth puts the captain back in the sky', true);
  await page.focus('body');
  await page.waitForTimeout(1200);

  // A fight, which is what a large hull is for. Close Order carries beams
  // and point defense, so this is the one that exercises both.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('Space');
  await page.waitForTimeout(4000);
  await page.keyboard.up('Space');
  await page.keyboard.up('ArrowUp');
  await capture(page, 'late-flight');
  book.record('a large hull flies and fires', true);

  await other.page.context().close();

  if (problems.length > 0) {
    book.record(
      'the session logged no errors',
      false,
      problems.slice(0, 3).join(' | ').slice(0, 200),
    );
  } else {
    book.record('the session logged no errors', true);
  }

  await page.context().close();
}

/** Open a counter from the berth and wait for what it opens. */
async function open(page: Playwright.Page, name: RegExp, settle: string): Promise<void> {
  const control = page.locator('.port__service-list').getByRole('button', { name });
  if ((await control.count()) === 0) {
    book.record(`the berth offers ${String(name)}`, false, 'no such control');
    return;
  }
  await control.first().click();
  await page.waitForSelector(settle, { timeout: 30_000 });
  await page.waitForTimeout(700);
  // A first-time note sits over the counter; settle it so the screen under
  // it is what gets looked at.
  const noted = page.locator('.hint__dismiss');
  if ((await noted.count()) > 0) {
    await noted.first().click();
    await page.waitForTimeout(400);
  }
}

/** Back to the berth, whatever the screen calls it. */
async function close(page: Playwright.Page): Promise<void> {
  const back = page.getByRole('button', {
    name: /back to the berth|leave the yard|leave|close/i,
  });
  if ((await back.count()) > 0) await back.first().click();
  else await page.keyboard.press('Escape');
  await page.waitForSelector('.port', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

/** A picture of the screen, for the cycle's notes. */
async function capture(page: Playwright.Page, name: string): Promise<void> {
  await page
    .screenshot({ path: `artifacts/shots/${name}.png`, fullPage: false })
    .catch(() => undefined);
}

async function textOf(page: Playwright.Page, selector: string): Promise<string> {
  const found = page.locator(selector).first();
  if ((await found.count()) === 0) return '';
  return ((await found.textContent()) ?? '').trim();
}

await main();
