/**
 * Hover and select, for every control in the game.
 *
 * Spec section 4 asks for interface sounds for hover, select, confirm,
 * error, purchase and sale, "kept quiet and consistent". Consistent is the
 * hard part: a sound wired into each screen is a sound that is missing from
 * the next screen somebody writes.
 *
 * So it is delegated. Two listeners on the document, matching any enabled
 * button, which means a control added later is already wired. The
 * exceptions are the ones that have a voice of their own: a stamp control
 * is the stamp, and a slider dragged across its range is not forty presses.
 *
 * Nothing here plays until the mix exists, which is until a captain has
 * touched something. A browser will not sound a note before a gesture, and
 * the first gesture is the one that builds the mix.
 */

import { playNotice } from './notices.ts';
import { existingMix } from './shared.ts';

/** How close together two hovers can be before the second is dropped. */
const HOVER_GAP_MS = 60;

/** Controls that make their own noise, and must not also make this one. */
function hasOwnVoice(element: Element): boolean {
  return element.classList.contains('stamp__control');
}

/** The button an event landed on, if it landed on one that is live. */
function controlFor(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined;
  const control = target.closest<HTMLElement>(
    'button, [role="button"], a[href], summary',
  );
  if (!control) return undefined;
  if (control instanceof HTMLButtonElement && control.disabled) return undefined;
  if (control.getAttribute('aria-disabled') === 'true') return undefined;
  return control;
}

/**
 * Listen for hovers and presses across the whole interface.
 *
 * Returns the function that stops listening. Called once, from `main.tsx`.
 */
export function listenToControls(target: Document = document): () => void {
  let lastHover = 0;
  let lastHovered: Element | undefined;

  const hover = (event: PointerEvent): void => {
    if (!existingMix()) return;
    const control = controlFor(event.target);
    if (!control || hasOwnVoice(control)) {
      lastHovered = undefined;
      return;
    }
    // Moving within one control is one hover. Without this, crossing a
    // button that holds a label and a figure ticks twice.
    if (control === lastHovered) return;
    lastHovered = control;

    const now = performance.now();
    if (now - lastHover < HOVER_GAP_MS) return;
    lastHover = now;
    playNotice('hover');
  };

  const press = (event: MouseEvent): void => {
    if (!existingMix()) return;
    const control = controlFor(event.target);
    if (!control || hasOwnVoice(control)) return;
    // A control that states a consequence gets the heavier one. Marked in
    // the markup rather than guessed at from its text: a button called
    // "Dissolve it" is destructive and a button called "Dismiss" is not,
    // and no amount of reading the label tells them apart reliably.
    playNotice(control.dataset.weight === 'destructive' ? 'confirm' : 'select');
  };

  target.addEventListener('pointerover', hover, { capture: true, passive: true });
  target.addEventListener('click', press, { capture: true, passive: true });
  return () => {
    target.removeEventListener('pointerover', hover, { capture: true });
    target.removeEventListener('click', press, { capture: true });
  };
}
