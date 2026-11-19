/**
 * The screens to capture.
 *
 * One entry per screen or state. A screen with a designed failure state gets an
 * entry for each, because those are exactly the states that rot unnoticed.
 *
 * `setup` runs before the capture and can block routes, stub state or drive the
 * interface. `settle` is a selector the harness waits for, so captures never
 * race a transition.
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
}

export const SCREENS: readonly Screen[] = [
  {
    name: 'boot-linked',
    description: 'Boot screen with a live link to the server and a system roster.',
    settle: '.boot__roster, .boot__message',
    settleMs: 400,
  },
  {
    name: 'boot-unreachable',
    description: 'Boot screen when the server does not answer: a designed state, not an error dump.',
    setup: async (page) => {
      // Fail the websocket and the matchmaking request, so the client takes
      // its unreachable path rather than timing out slowly.
      await page.route('**/matchmake/**', (route) => route.abort('connectionrefused'));
    },
    settle: '.boot__failure',
    settleMs: 400,
  },
];
