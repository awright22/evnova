/**
 * The screens to capture.
 *
 * One entry per screen or state. A screen with a designed failure state gets an
 * entry for each, because those are exactly the states that rot unnoticed.
 */

import type { Page } from 'playwright';

export interface Screen {
  readonly name: string;
  readonly description: string;
  /** Path appended to the client's base URL. */
  readonly path?: string;
  /** Prepare the page before it loads, e.g. block the server to force a state. */
  readonly setup?: (page: Page) => Promise<void>;
  /** Wait for this selector before capturing. */
  readonly settle?: string;
  /** Extra settle time in ms, for animations that have no end selector. */
  readonly settleMs?: number;
  /** Drive the page before capturing: hold keys, wait, fly somewhere. */
  readonly act?: (page: Page) => Promise<void>;
  /** Bot traffic to fly in the same system during this capture. */
  readonly bots?: number;
}

/** Hold a key for a while, so the capture catches the ship actually moving. */
async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

export const SCREENS: readonly Screen[] = [
  {
    name: 'flight-at-rest',
    description: 'The flight view on arrival: backdrop, star, the hull and the HUD at rest.',
    path: '/?callsign=Prudent%20Return',
    settle: '.hud',
    settleMs: 1200,
    bots: 3,
  },
  {
    name: 'flight-under-burn',
    description: 'Under full burn: plume extended, camera led and zoomed out, speed up.',
    path: '/?callsign=Full%20Burn',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await hold(page, 'ArrowUp', 2600);
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'flight-turning',
    description: 'Burning into a turn, which is the hardest case for prediction.',
    path: '/?callsign=Hard%20Over',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1400);
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'draught-force-majeure',
    description: 'Force Majeure under burn: two engines, four thrusters, no hold.',
    path: '/?draught=force-majeure&callsign=Force%20Majeure',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2200);
    },
  },
  {
    name: 'draught-fair-wear-and-tear',
    description: 'Fair Wear and Tear under burn: five bays, one large engine, visibly slower to answer.',
    path: '/?draught=fair-wear-and-tear&callsign=Fair%20Wear',
    settle: '.hud',
    settleMs: 400,
    bots: 3,
    act: async (page) => {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(2200);
    },
  },
  {
    name: 'combat',
    description: 'A fight: rounds in flight, shield ripples, the mark bracketed and the lead indicator up.',
    path: '/?callsign=Free%20Captain',
    settle: '.hud',
    settleMs: 2500,
    bots: 2,
    act: async (page) => {
      // Mark the nearest hull, then hold the trigger while closing on it, so
      // the capture catches rounds in flight rather than an empty sky.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      await page.keyboard.down('Space');
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(3500);
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'register',
    description:
      'The Register: where a new captain is entered, and the one screen a player sees before flying.',
    // No callsign, so the real sign-up screen shows rather than being skipped.
    path: '/',
    settle: '.register',
    settleMs: 500,
  },
  {
    name: 'register-phrase',
    description: 'The recovery phrase, shown once. The only copy the captain gets.',
    path: '/',
    settle: '.register',
    settleMs: 400,
    act: async (page) => {
      await page.fill('.register input[name="callsign"]', 'Quiet Returns');
      await page.click('.register button[type="submit"]');
      await page.waitForSelector('.register__phrase', { timeout: 20_000 });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'chart',
    description: 'The chart of the Reach: lanes, reachable systems, the cost of a jump.',
    path: '/?callsign=Chart%20Reader',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.keyboard.press('KeyM');
      await page.waitForSelector('.chart', { timeout: 20_000 });
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'jump-spool',
    description: 'Spooling for a lane: the travel banner filling while the hull holds course.',
    path: '/?callsign=Lane%20Bound',
    settle: '.hud',
    settleMs: 900,
    bots: 2,
    act: async (page) => {
      await page.keyboard.press('KeyM');
      await page.waitForSelector('.chart', { timeout: 20_000 });
      await page.waitForTimeout(400);
      // Enter spools for the selected system and closes the chart.
      await page.keyboard.press('Enter');
      await page.waitForSelector('.hud__travel--spooling', { timeout: 20_000 });
      // Partway through the spool, so the bar reads as a wait with an end.
      await page.waitForTimeout(1800);
    },
  },
  {
    name: 'port-hub',
    description: 'Alongside: the berth\'s terminal, its services and what they cost.',
    path: '/?callsign=Alongside',
    settle: '.hud',
    settleMs: 900,
    act: async (page) => {
      await page.waitForSelector('.hud__travel', { timeout: 20_000 });
      await page.keyboard.press('KeyL');
      await page.waitForSelector('.port', { timeout: 20_000 });
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'boot-unreachable',
    description: 'The terminal when the server does not answer: a designed state, not an error dump.',
    setup: async (page) => {
      // A captain who already has an account, so the Register is skipped and
      // the capture lands on the state this screen is actually about.
      await page.addInitScript(() => {
        localStorage.setItem('marque.deviceToken', 'capture-device-token');
        localStorage.setItem('marque.callsign', 'Last Known');
      });
      await page.route('**/matchmake/**', (route) => route.abort('connectionrefused'));
    },
    settle: '.boot__failure',
    settleMs: 400,
  },
  {
    name: 'register-refused',
    description: 'The Register when the server will not take the callsign: the refusal is in the form.',
    path: '/',
    settle: '.register',
    settleMs: 400,
    act: async (page) => {
      // A callsign the server already holds, so the refusal is the real one.
      await page.fill('.register input[name="callsign"]', 'Alongside');
      await page.click('.register button[type="submit"]');
      await page.waitForTimeout(1200);
    },
  },
];
