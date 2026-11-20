/**
 * Gamepad input.
 *
 * Spec section 13: every screen works by keyboard alone, and flight works by
 * gamepad too. A pad produces the same `FlightIntent` a keyboard does and the
 * same edge counts, so the frame loop merges the two and never knows which
 * hand the captain used.
 *
 * The standard mapping, as a browser reports it: the left stick turns, the
 * triggers burn and brake, the face buttons fire and act. Nothing here is
 * bindable yet — a pad's buttons are already named by the hardware, and
 * rebinding them is the smaller half of the problem.
 */

import type { Action } from '../shell/settings.ts';
import type { FlightIntent } from './input.ts';

/**
 * How far a stick must move before it counts.
 *
 * A worn stick rests a little off centre, and a hull that drifts to port
 * while nobody is touching it is a hull somebody will think is broken.
 */
const DEADZONE = 0.25;

/** A trigger is analogue; this is where it reads as pressed. */
const TRIGGER = 0.4;

/** The standard layout's button indices, named for what they do here. */
const BUTTON = {
  firePrimary: 0,
  fireSecondary: 1,
  land: 2,
  cycleTarget: 3,
  board: 4,
  chart: 8,
  jump: 9,
  brake: 6,
  thrust: 7,
} as const;

/**
 * What does each action on a pad, in the words on the hardware.
 *
 * The settings screen shows this rather than letting a captain rebind it:
 * a pad's buttons are already named by the thing in their hands, and the
 * standard layout is the layout every pad reports.
 */
export const PAD_CONTROLS: Record<Action, string> = {
  turnLeft: 'Left stick, to port',
  turnRight: 'Left stick, to starboard',
  thrust: 'Right trigger',
  brake: 'Left trigger',
  firePrimary: 'Bottom face button',
  fireSecondary: 'Right face button',
  cycleTarget: 'Top face button',
  land: 'Left face button',
  board: 'Left shoulder',
  chart: 'Select',
  jump: 'Start',
};

/** The name of the first connected pad, or nothing. */
export function connectedPad(): string | undefined {
  try {
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return pad.id;
    }
  } catch {
    // No gamepad support in this context.
  }
  return undefined;
}

export class GamepadInput {
  /** Which edge buttons were down last sample, so a hold is not a stream. */
  private readonly wasDown = new Set<number>();

  private cycleRequests = 0;
  private landRequests = 0;
  private boardRequests = 0;
  private chartRequests = 0;
  private jumpRequests = 0;

  /** The first pad the browser is reporting, or nothing. */
  private pad(): Gamepad | undefined {
    try {
      for (const pad of navigator.getGamepads()) {
        if (pad && pad.connected) return pad;
      }
    } catch {
      // No gamepad support in this context.
    }
    return undefined;
  }

  /**
   * Sample the pad, or nothing when there is none.
   *
   * Returns `undefined` rather than a resting intent so the caller can tell
   * "no pad" from "a pad being held still", and leave the keyboard alone.
   */
  sample(): FlightIntent | undefined {
    const pad = this.pad();
    if (!pad) return undefined;

    const down = (index: number): boolean => {
      const button = pad.buttons[index];
      if (!button) return false;
      return button.pressed || button.value > TRIGGER;
    };

    // Edges, counted once per press.
    const edge = (index: number, bump: () => void): void => {
      if (down(index)) {
        if (!this.wasDown.has(index)) {
          this.wasDown.add(index);
          bump();
        }
      } else {
        this.wasDown.delete(index);
      }
    };

    edge(BUTTON.cycleTarget, () => this.cycleRequests++);
    edge(BUTTON.land, () => this.landRequests++);
    edge(BUTTON.board, () => this.boardRequests++);
    edge(BUTTON.chart, () => this.chartRequests++);
    edge(BUTTON.jump, () => this.jumpRequests++);

    const stick = pad.axes[0] ?? 0;
    const turn: -1 | 0 | 1 =
      stick < -DEADZONE ? -1 : stick > DEADZONE ? 1 : 0;

    return {
      turn,
      thrust: down(BUTTON.thrust) ? 1 : 0,
      brake: down(BUTTON.brake),
      firePrimary: down(BUTTON.firePrimary),
      fireSecondary: down(BUTTON.fireSecondary),
    };
  }

  takeCycleRequests(): number {
    const count = this.cycleRequests;
    this.cycleRequests = 0;
    return count;
  }

  takeLandRequest(): boolean {
    const asked = this.landRequests > 0;
    this.landRequests = 0;
    return asked;
  }

  takeBoardRequest(): boolean {
    const asked = this.boardRequests > 0;
    this.boardRequests = 0;
    return asked;
  }

  takeChartRequest(): boolean {
    const asked = this.chartRequests > 0;
    this.chartRequests = 0;
    return asked;
  }

  takeJumpRequest(): boolean {
    const asked = this.jumpRequests > 0;
    this.jumpRequests = 0;
    return asked;
  }
}

/**
 * Both hands at once.
 *
 * Whichever is asking for something wins: a captain with a thumb on the
 * stick and a finger on the arrow key is one captain, and the hull should
 * do what either of them says rather than what the last frame decided.
 */
export function mergeIntents(
  keyboard: FlightIntent,
  pad: FlightIntent | undefined,
): FlightIntent {
  if (!pad) return keyboard;
  return {
    turn: keyboard.turn !== 0 ? keyboard.turn : pad.turn,
    thrust: keyboard.thrust === 1 || pad.thrust === 1 ? 1 : 0,
    brake: keyboard.brake || pad.brake,
    firePrimary: keyboard.firePrimary || pad.firePrimary,
    fireSecondary: keyboard.fireSecondary || pad.fireSecondary,
  };
}

/**
 * Did either hand ask for this?
 *
 * Both arguments are evaluated before the call, which is the point: the
 * edge readers clear themselves when read, so `a || b` would leave a pad
 * press queued on any frame the keyboard also fired, and it would arrive
 * one frame later as a second command nobody gave.
 */
export function asked(keyboard: boolean, pad: boolean): boolean {
  return keyboard || pad;
}
