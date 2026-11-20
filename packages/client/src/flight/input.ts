/**
 * Keyboard input.
 *
 * Reads the physical key so the controls work on any layout, and holds a
 * simple pressed-set rather than edge events: flight input is sampled once per
 * fixed step, not driven by the browser's key-repeat.
 *
 * Bindings become rebindable in M9; the defaults here are the ones the spec
 * names.
 */

export interface FlightIntent {
  /** -1 left, 0 hold, 1 right. */
  readonly turn: -1 | 0 | 1;
  /** 1 to burn the main engine. */
  readonly thrust: 0 | 1;
  /** Turn retrograde and burn to a stop. */
  readonly brake: boolean;
  /** Fire fixed guns and turrets. */
  readonly firePrimary: boolean;
  /** Fire missile racks. */
  readonly fireSecondary: boolean;
}

const TURN_LEFT = new Set(['ArrowLeft', 'KeyA']);
const TURN_RIGHT = new Set(['ArrowRight', 'KeyD']);
const THRUST = new Set(['ArrowUp', 'KeyW']);
const BRAKE = new Set(['ArrowDown', 'KeyS']);
const FIRE_PRIMARY = new Set(['Space']);
const FIRE_SECONDARY = new Set(['ShiftLeft', 'ShiftRight']);

/** Pressed once rather than held: these are edges, not states. */
const CYCLE_TARGET = 'Tab';
const LAND = 'KeyL';
const BOARD = 'KeyB';
const CHART = 'KeyM';
const JUMP = 'KeyJ';

/** Keys the game consumes, so the page does not also scroll or tab away. */
const CONSUMED = new Set([
  ...TURN_LEFT,
  ...TURN_RIGHT,
  ...THRUST,
  ...BRAKE,
  ...FIRE_PRIMARY,
  CYCLE_TARGET,
  LAND,
  BOARD,
  CHART,
  JUMP,
]);

export class KeyboardInput {
  private readonly pressed = new Set<string>();
  /** Edge-triggered presses, drained by the frame loop. */
  private cycleRequests = 0;
  private landRequests = 0;
  private boardRequests = 0;
  private chartRequests = 0;
  private jumpRequests = 0;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;
  private readonly onBlur: () => void;

  constructor(target: Window = window) {
    this.onKeyDown = (event) => {
      // Never swallow a key while the captain is typing somewhere.
      if (isTextEntry(event.target)) return;
      if (CONSUMED.has(event.code)) event.preventDefault();
      // Cycling the mark is an edge: holding Tab should not spin through
      // every hull in the system.
      if (event.code === CYCLE_TARGET && !event.repeat) this.cycleRequests++;
      if (event.code === LAND && !event.repeat) this.landRequests++;
      if (event.code === BOARD && !event.repeat) this.boardRequests++;
      if (event.code === CHART && !event.repeat) this.chartRequests++;
      if (event.code === JUMP && !event.repeat) this.jumpRequests++;
      this.pressed.add(event.code);
    };
    this.onKeyUp = (event) => {
      this.pressed.delete(event.code);
    };
    // Losing focus with a key held would leave the ship burning forever.
    this.onBlur = () => this.pressed.clear();

    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    this.target = target;
  }

  private readonly target: Window;

  /**
   * Drop every held key.
   *
   * Called when something else takes the keyboard, such as the chat composer
   * opening: a key held at that moment has no keyup to clear it while the
   * captain types, and the ship would burn through the whole conversation.
   */
  releaseAll(): void {
    this.pressed.clear();
  }

  /** Sample the current intent. Called once per fixed step. */
  sample(): FlightIntent {
    const left = anyPressed(this.pressed, TURN_LEFT);
    const right = anyPressed(this.pressed, TURN_RIGHT);
    // Both keys held cancel out, rather than the later one winning.
    const turn: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;

    return {
      turn,
      thrust: anyPressed(this.pressed, THRUST) ? 1 : 0,
      brake: anyPressed(this.pressed, BRAKE),
      firePrimary: anyPressed(this.pressed, FIRE_PRIMARY),
      fireSecondary: anyPressed(this.pressed, FIRE_SECONDARY),
    };
  }

  /** How many times the captain asked for the next mark since the last call. */
  takeCycleRequests(): number {
    const count = this.cycleRequests;
    this.cycleRequests = 0;
    return count;
  }

  /** True when the captain asked to be taken alongside since the last call. */
  takeLandRequest(): boolean {
    const asked = this.landRequests > 0;
    this.landRequests = 0;
    return asked;
  }

  /** True when the captain asked to put a party aboard something. */
  takeBoardRequest(): boolean {
    const asked = this.boardRequests > 0;
    this.boardRequests = 0;
    return asked;
  }

  /** True when the captain asked for the chart. */
  takeChartRequest(): boolean {
    const asked = this.chartRequests > 0;
    this.chartRequests = 0;
    return asked;
  }

  /** True when the captain asked to jump since the last call. */
  takeJumpRequest(): boolean {
    const asked = this.jumpRequests > 0;
    this.jumpRequests = 0;
    return asked;
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }
}

function anyPressed(pressed: ReadonlySet<string>, keys: ReadonlySet<string>): boolean {
  for (const key of keys) if (pressed.has(key)) return true;
  return false;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}
