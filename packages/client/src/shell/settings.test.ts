import { describe, expect, it } from 'vitest';

import { ACTIONS, DEFAULT_BINDINGS, DEFAULT_SETTINGS, SCALE_RANGE } from './settings.ts';
import { keyName } from './Settings.tsx';

describe('settings', () => {
  it('binds every action a captain can take', () => {
    for (const action of ACTIONS) {
      const pair = DEFAULT_BINDINGS[action];
      expect(pair, `${action} has no binding`).toBeDefined();
      expect(pair[0], `${action} has no first key`).not.toBe('');
    }
  });

  it('and binds no key to two actions', () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        if (code === '') continue;
        expect(seen.get(code), `${code} is on ${seen.get(code) ?? ''} as well`).toBeUndefined();
        seen.set(code, action);
      }
    }
  });

  it('opens on figures a captain would recognise', () => {
    expect(DEFAULT_SETTINGS.scale).toBe(1);
    expect(DEFAULT_SETTINGS.motion).toBe('system');
    expect(DEFAULT_SETTINGS.palette).toBe('livery');
    expect(DEFAULT_SETTINGS.quality).toBe('full');
    for (const level of Object.values(DEFAULT_SETTINGS.volumes)) {
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the interface scale within a range that still reads', () => {
    expect(SCALE_RANGE.min).toBeGreaterThan(0.5);
    expect(SCALE_RANGE.max).toBeLessThan(2);
  });

  it('names keys the way a captain would say them', () => {
    expect(keyName('KeyL')).toBe('L');
    expect(keyName('ArrowLeft')).toBe('←');
    expect(keyName('ShiftLeft')).toBe('Left shift');
    expect(keyName('Space')).toBe('Space');
    expect(keyName('')).toBe('—');
  });
});
