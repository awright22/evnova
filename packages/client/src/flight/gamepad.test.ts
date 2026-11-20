import { describe, expect, it } from 'vitest';

import { ACTIONS, type Action } from '../shell/settings.ts';
import { PAD_CONTROLS, asked, mergeIntents } from './gamepad.ts';
import type { FlightIntent } from './input.ts';

const REST: FlightIntent = {
  turn: 0,
  thrust: 0,
  brake: false,
  firePrimary: false,
  fireSecondary: false,
};

describe('the pad layout', () => {
  it('names a control for every action a captain can be asked to press', () => {
    for (const action of ACTIONS) {
      expect(PAD_CONTROLS[action as Action], action).toBeTruthy();
    }
  });
});

describe('merging the two hands', () => {
  it('leaves the keyboard alone when no pad is connected', () => {
    const keys: FlightIntent = { ...REST, turn: -1, thrust: 1 };
    expect(mergeIntents(keys, undefined)).toBe(keys);
  });

  it('takes the pad when the keys are idle', () => {
    const pad: FlightIntent = { ...REST, turn: 1, thrust: 1, firePrimary: true };
    expect(mergeIntents(REST, pad)).toEqual(pad);
  });

  it('lets the keys win the turn when both are pushing', () => {
    const keys: FlightIntent = { ...REST, turn: -1 };
    const pad: FlightIntent = { ...REST, turn: 1 };
    expect(mergeIntents(keys, pad).turn).toBe(-1);
  });

  it('takes a burn or a shot from whichever hand asked', () => {
    const keys: FlightIntent = { ...REST, firePrimary: true };
    const pad: FlightIntent = { ...REST, thrust: 1, brake: true, fireSecondary: true };
    const merged = mergeIntents(keys, pad);
    expect(merged.thrust).toBe(1);
    expect(merged.brake).toBe(true);
    expect(merged.firePrimary).toBe(true);
    expect(merged.fireSecondary).toBe(true);
  });

  it('keeps thrust an integer the simulation can step with', () => {
    const merged = mergeIntents({ ...REST, thrust: 1 }, { ...REST, thrust: 1 });
    expect(merged.thrust).toBe(1);
  });
});

describe('asked', () => {
  it('drains both readers rather than short-circuiting one of them', () => {
    let keyboardReads = 0;
    let padReads = 0;
    const keyboard = (): boolean => {
      keyboardReads += 1;
      return true;
    };
    const pad = (): boolean => {
      padReads += 1;
      return true;
    };
    expect(asked(keyboard(), pad())).toBe(true);
    expect(keyboardReads).toBe(1);
    // The point of the helper: a press on the pad is not left queued because
    // the keyboard also fired this frame.
    expect(padReads).toBe(1);
  });
});
