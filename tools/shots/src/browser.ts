/**
 * Chromium discovery.
 *
 * Playwright normally manages its own browser download, but some environments
 * ship one already. Prefer an explicit path, then the environment's known
 * location, then whatever Playwright resolves for itself.
 */

import { existsSync } from 'node:fs';

/** Locations to try, in order, before falling back to Playwright's own. */
const CANDIDATES = [
  process.env.MARQUE_CHROMIUM,
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
] as const;

export function findChromium(): string | undefined {
  for (const candidate of CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Launch flags.
 *
 * `--no-sandbox` is required in containers. The GPU flags keep rendering
 * deterministic across machines so a capture diff reflects a real change rather
 * than a different driver.
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
] as const;
