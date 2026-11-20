/**
 * Settings.
 *
 * Spec section 13: key and gamepad bindings, the four volume controls,
 * graphics quality, interface scale, reduced motion, and a colour-vision-safe
 * palette. Everything is kept in one object, written to this device's storage,
 * and applied by setting attributes and custom properties on the root — so a
 * screen never reads a setting, it just inherits the consequences.
 *
 * Nothing here is authoritative about anything in the world. A setting
 * changes how a captain sees and hears the game and nothing else, which is
 * why it lives on the device rather than on the account.
 */

import { DEFAULT_VOLUMES, type Volumes } from '../audio/mix.ts';
import { existingMix } from '../audio/shared.ts';

/** Everything a captain can be asked to press. */
export const ACTIONS = [
  'turnLeft',
  'turnRight',
  'thrust',
  'brake',
  'firePrimary',
  'fireSecondary',
  'cycleTarget',
  'land',
  'board',
  'chart',
  'jump',
] as const;

export type Action = (typeof ACTIONS)[number];

/** What each action is called on the settings screen, in this world's words. */
export const ACTION_NAMES: Record<Action, string> = {
  turnLeft: 'Turn to port',
  turnRight: 'Turn to starboard',
  thrust: 'Burn',
  brake: 'Brake',
  firePrimary: 'Fire guns',
  fireSecondary: 'Fire racks',
  cycleTarget: 'Mark the next contact',
  land: 'Come alongside',
  board: 'Put a party across',
  chart: 'Open the chart',
  jump: 'Spool the lane',
};

/**
 * Two keys per action: the arrows a captain reaches for first and the letters
 * their other hand is already on. Both are bindable.
 */
export type Binding = readonly [string, string];

export const DEFAULT_BINDINGS: Record<Action, Binding> = {
  turnLeft: ['ArrowLeft', 'KeyA'],
  turnRight: ['ArrowRight', 'KeyD'],
  thrust: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  firePrimary: ['Space', ''],
  fireSecondary: ['ShiftLeft', 'ShiftRight'],
  cycleTarget: ['Tab', ''],
  land: ['KeyL', ''],
  board: ['KeyB', ''],
  chart: ['KeyM', ''],
  jump: ['KeyJ', ''],
};

export interface Settings {
  readonly volumes: Volumes;
  /** Multiplies every type size and gap. */
  readonly scale: number;
  /** `system` follows the browser; the other two override it either way. */
  readonly motion: 'system' | 'reduced' | 'full';
  /** `safe` trades the livery hues for ones that survive colour blindness. */
  readonly palette: 'livery' | 'safe';
  /** `plain` scales effects down. It never scales gameplay down. */
  readonly quality: 'full' | 'plain';
  readonly bindings: Record<Action, Binding>;
}

export const DEFAULT_SETTINGS: Settings = {
  volumes: DEFAULT_VOLUMES,
  scale: 1,
  motion: 'system',
  palette: 'livery',
  quality: 'full',
  bindings: DEFAULT_BINDINGS,
};

const KEY = 'marque.settings';

/** The narrowest and widest the interface may be scaled. */
export const SCALE_RANGE = { min: 0.85, max: 1.3 } as const;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return merge(JSON.parse(raw) as Partial<Settings>);
  } catch {
    // Storage disabled, or a setting written by a build that has moved on.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Nothing to be done, and nothing worth telling a captain about: the
    // setting still applies for this session.
  }
}

/**
 * Put the settings in force.
 *
 * Attributes and custom properties on the root, so every screen inherits
 * them without reading anything, and the mix if one has been built — it is
 * not built until the first sound, and building one here would mean an
 * audio context before the captain has touched anything.
 */
export function applySettings(settings: Settings): void {
  const root = document.documentElement;
  root.style.setProperty('--scale', String(clampScale(settings.scale)));
  root.dataset.motion = settings.motion;
  root.dataset.palette = settings.palette;
  root.dataset.quality = settings.quality;
  existingMix()?.setVolumes(settings.volumes);
}

/** Whether motion should be held back, by the setting or by the browser. */
export function motionIsReduced(): boolean {
  try {
    const setting = document.documentElement.dataset.motion;
    if (setting === 'reduced') return true;
    if (setting === 'full') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(SCALE_RANGE.max, Math.max(SCALE_RANGE.min, scale));
}

/** A stored object, filled in from the defaults wherever it is short. */
function merge(stored: Partial<Settings>): Settings {
  const bindings: Record<Action, Binding> = { ...DEFAULT_BINDINGS };
  for (const action of ACTIONS) {
    const pair = stored.bindings?.[action];
    if (Array.isArray(pair) && pair.length === 2) {
      bindings[action] = [String(pair[0] ?? ''), String(pair[1] ?? '')];
    }
  }

  return {
    volumes: { ...DEFAULT_VOLUMES, ...(stored.volumes ?? {}) },
    scale: clampScale(stored.scale ?? 1),
    motion: stored.motion === 'reduced' || stored.motion === 'full' ? stored.motion : 'system',
    palette: stored.palette === 'safe' ? 'safe' : 'livery',
    quality: stored.quality === 'plain' ? 'plain' : 'full',
    bindings,
  };
}
