import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEEDBACK_SOUNDS, SOUND_NAMES, type SoundName } from './log.ts';

/**
 * The feedback table's event column, read out of the art direction.
 *
 * Spec section 3: "confirm every row in the feedback table has a sound
 * mapped". Read from the document rather than copied here, so a row added
 * to the table without a sound fails this and a sound mapped to a row that
 * no longer exists fails it too.
 */
function feedbackRows(): string[] {
  const doc = readFileSync(
    resolve(import.meta.dirname, '../../../../docs/ART_DIRECTION.md'),
    'utf8',
  );
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith('| Event |'));
  expect(start, 'the feedback table is not in docs/ART_DIRECTION.md').toBeGreaterThan(-1);

  const rows: string[] = [];
  // Past the header and its rule.
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('|')) break;
    const event = line.split('|')[1]?.trim() ?? '';
    if (event !== '') rows.push(event.replace(/\*\*/g, ''));
  }
  return rows;
}

describe('the feedback table', () => {
  const rows = feedbackRows();

  it('has the rows the spec names as a minimum', () => {
    // Spec section 4 lists these by name. The table has more; it may never
    // have fewer.
    for (const required of [
      'Thrust',
      'Turn',
      'Fire gun',
      'Hit dealt',
      'Hit taken on shields',
      'Hit taken on hull',
      'Module disabled',
      'Ship written off',
      'Target acquired',
      'Jump spool',
      'Jump',
      'Arrival',
      'Land',
      'Launch',
      'Buy at the Staple',
      'Sell at the Staple',
      'Insufficient funds',
      'Order filled at the Bourse',
      'Dividend received',
      'Commission accepted',
      'Commission complete',
      'Chat message',
      'Player enters system',
    ]) {
      expect(rows, `the table has no row for "${required}"`).toContain(required);
    }
  });

  it('maps every row to a sound', () => {
    for (const row of rows) {
      const sounds = FEEDBACK_SOUNDS[row];
      expect(sounds, `no sound is mapped to "${row}"`).toBeDefined();
    }
  });

  it('maps no sound to a row that is not in the table', () => {
    for (const row of Object.keys(FEEDBACK_SOUNDS)) {
      expect(rows, `"${row}" has a sound but is not a row of the table`).toContain(row);
    }
  });

  it('plays something for every row the table says makes a noise', () => {
    for (const row of rows) {
      const sounds = FEEDBACK_SOUNDS[row] ?? [];
      // The one row that is deliberately silent says so in the table.
      if (row === 'Taken out on the range') {
        expect(sounds).toEqual([]);
        continue;
      }
      expect(sounds.length, `"${row}" maps to no sound`).toBeGreaterThan(0);
    }
  });

  it('uses the sounds the client can actually make', () => {
    const reported = new Set<SoundName>(SOUND_NAMES);
    for (const [row, sounds] of Object.entries(FEEDBACK_SOUNDS)) {
      for (const sound of sounds) {
        expect(reported.has(sound), `"${row}" maps to "${sound}", which is not a sound`).toBe(
          true,
        );
      }
    }
  });

  it('leaves no sound unused, so a name cannot rot in the list', () => {
    const mapped = new Set(Object.values(FEEDBACK_SOUNDS).flat());
    for (const sound of SOUND_NAMES) {
      expect(mapped.has(sound), `"${sound}" answers no row of the table`).toBe(true);
    }
  });
});
