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
    settle: '.hud',
    settleMs: 1200,
    bots: 3,
  },
  {
    name: 'flight-under-burn',
    description: 'Under full burn: plume extended, camera led and zoomed out, speed up.',
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
    name: 'boot-unreachable',
    description: 'The terminal when the server does not answer: a designed state, not an error dump.',
    setup: async (page) => {
      await page.route('**/matchmake/**', (route) => route.abort('connectionrefused'));
    },
    settle: '.boot__failure',
    settleMs: 400,
  },
];
