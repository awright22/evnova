/**
 * The one audio mix.
 *
 * Built on the first sound and kept for the session. The flight view used to
 * make its own and close it on unmount, which was fine while flying was the
 * only thing that made a noise — the stamp happens on the port screens,
 * where that view is long gone, and a second context per screen is both
 * wasteful and a second set of volumes to keep in step.
 *
 * Browsers refuse to start audio without a gesture. Every caller here is
 * already one: a key press in flight, a click on a stamp.
 */

import { AudioMix } from './mix.ts';

let mix: AudioMix | undefined;

/** The mix, made if it does not exist yet. */
export function sharedMix(): AudioMix {
  mix ??= new AudioMix();
  return mix;
}

/** The mix if it has been made, without making one. */
export function existingMix(): AudioMix | undefined {
  return mix;
}
