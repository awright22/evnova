import { describe, expect, it } from 'vitest';

import { encodeShareCode, type Blueprint, type ModuleDef, type Tuning } from '@marque/shared';

import { HullBook } from './hulls.ts';

const CATALOGUE = new Map<string, Blueprint>([
  [
    'prudent-return',
    {
      id: 'prudent-return',
      name: 'Prudent Return',
      licence: 'open-ticket',
      placements: [{ moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 }],
      paint: ['#8D98A9', '#5C6777'],
    },
  ],
]);

const MODULES = new Map<string, ModuleDef>([
  ['hrc-bridge-1', {} as ModuleDef],
  ['hrc-hull-1', {} as ModuleDef],
]);

// Only the liveries are read, so the rest of tuning is not built here.
const TUNING = {
  yard: { liveries: [['#111111', '#222222'], ['#333333', '#444444']] },
} as unknown as Tuning;

function book(): HullBook {
  return new HullBook(CATALOGUE, MODULES, TUNING);
}

const BUILT = {
  name: 'Bonded Runner',
  placements: [
    { moduleId: 'hrc-bridge-1', x: 0, y: 0, rotation: 0 as const },
    { moduleId: 'hrc-hull-1', x: 0, y: 2, rotation: 0 as const },
  ],
};

describe('the hull book', () => {
  it('reads a catalogue draught straight through', () => {
    const hulls = book();
    expect(hulls.get('prudent-return')?.name).toBe('Prudent Return');
    expect(hulls.has('prudent-return')).toBe(true);
    expect(hulls.learnedCount).toBe(0);
  });

  it('knows nothing of a built hull until it is learned', () => {
    const hulls = book();
    expect(hulls.get('ship-1')).toBeUndefined();
    hulls.learn('ship-1', encodeShareCode(BUILT));
    expect(hulls.get('ship-1')?.placements).toEqual(BUILT.placements);
    expect(hulls.has('ship-1')).toBe(true);
  });

  it('learns a hull once however many times it is seen', () => {
    const hulls = book();
    const code = encodeShareCode(BUILT);
    const first = hulls.learn('ship-1', code);
    for (let i = 0; i < 100; i++) hulls.learn('ship-1', code);
    expect(hulls.learn('ship-1', code)).toBe(first);
    expect(hulls.learnedCount).toBe(1);
  });

  it('takes the callsign over the name in the code', () => {
    // The code's name is what the design was called; what the hull is called
    // now is on its state, and that is what a contact should read as.
    const hulls = book();
    hulls.learn('ship-1', encodeShareCode(BUILT), 'Short Measure');
    expect(hulls.get('ship-1')?.name).toBe('Short Measure');
  });

  it('paints a built hull from its id, the same way every time', () => {
    const code = encodeShareCode(BUILT);
    const one = book();
    const two = book();
    one.learn('ship-7', code);
    two.learn('ship-7', code);
    expect(one.get('ship-7')?.paint).toEqual(two.get('ship-7')?.paint);
    // And two hulls of the same design are not forced to look alike.
    one.learn('ship-8', code);
    expect(one.get('ship-8')?.paint).toBeDefined();
  });

  it('refuses a hull naming a fitting this build lacks, rather than drawing holes', () => {
    const hulls = book();
    const exotic = encodeShareCode({
      name: 'Exotic',
      placements: [{ moduleId: 'from-a-later-version', x: 0, y: 0, rotation: 0 }],
    });
    expect(hulls.learn('ship-2', exotic)).toBeUndefined();
    expect(hulls.get('ship-2')).toBeUndefined();
  });

  it('attempts a bad code once, not once a frame', () => {
    const hulls = book();
    // A code that cannot decode at all.
    expect(hulls.learn('ship-3', 'rubbish!!!')).toBeUndefined();
    expect(hulls.learn('ship-3', 'rubbish!!!')).toBeUndefined();
    expect(hulls.learnedCount).toBe(0);
  });

  it('treats an empty code as a catalogue lookup', () => {
    const hulls = book();
    expect(hulls.learn('prudent-return', '')?.name).toBe('Prudent Return');
    expect(hulls.learn('nothing-like-it', '')).toBeUndefined();
    expect(hulls.learnedCount).toBe(0);
  });
});
