/**
 * Every stylesheet in this client is global, so block names are one shared
 * namespace.
 *
 * A collision does not fail loudly: the element silently takes the other
 * screen's rules, and the symptom turns up somewhere else entirely. It has
 * happened twice. The Bourse's price chart called itself `chart`, which the
 * galaxy map owns, and drew a full-screen overlay across the figures. Then
 * the Bourse's ranking list called itself `register`, which the sign-up
 * screen owns, and handed it `align-content: start` — so the Register sat at
 * the top of the viewport with two thirds of the screen empty under it, in a
 * file that said `place-items: center` and meant it.
 *
 * Both took a capture to notice and a while to find. This is cheaper.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every `.css` under the client's source, by path. */
function stylesheets(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) stylesheets(path, found);
    else if (entry.endsWith('.css')) found.push(path);
  }
  return found;
}

/**
 * The block each rule in a file belongs to: the first class of a selector
 * that starts a line, with its element and modifier suffixes removed.
 */
function blocksIn(css: string): Set<string> {
  const blocks = new Set<string>();
  for (const [, name] of css.matchAll(/^\.([a-zA-Z][\w-]*)/gm)) {
    if (name === undefined) continue;
    const block = name.split('__')[0]?.split('--')[0];
    if (block !== undefined && block !== '') blocks.add(block);
  }
  return blocks;
}

describe('the stylesheet namespace', () => {
  it('gives every block name one owner', () => {
    const owners = new Map<string, string[]>();
    for (const path of stylesheets(SRC)) {
      const file = path.slice(SRC.length);
      for (const block of blocksIn(readFileSync(path, 'utf8'))) {
        owners.set(block, [...(owners.get(block) ?? []), file]);
      }
    }

    // `base.css` is the shared layer every screen draws on, so a name it
    // defines is meant to be used elsewhere; a *second definition* of one of
    // its names is still a collision, and that is what this catches.
    const shared = [...owners]
      .filter(([, files]) => files.length > 1)
      .map(([block, files]) => `${block}: ${files.sort().join(', ')}`);

    expect(shared).toEqual([]);
  });
});
