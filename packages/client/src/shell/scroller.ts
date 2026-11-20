/**
 * Whether a scroller has more below it than it is showing.
 *
 * A panel whose content runs past its edge cuts its last row in half, which
 * reads as a layout fault rather than as more below. The honest fix is to
 * fade the bottom edge — but only when there is something there to fade,
 * and CSS cannot tell an overflowing scroller from a full one. So the
 * element answers for itself, and the stylesheet keys off the answer.
 *
 * Only the bottom. Tables here keep a sticky header, which already covers
 * the top edge with an opaque row; fading that would hide the thing holding
 * the column names.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Below the last row by less than this and the scroller counts as at rest. */
const SETTLED_PX = 2;

export interface Scroller {
  /** Put this on the scrolling element. */
  readonly ref: (node: HTMLElement | null) => void;
  /** `'below'` while content continues past the bottom edge, else `'none'`. */
  readonly more: 'below' | 'none';
}

export function useScroller(): Scroller {
  const [more, setMore] = useState<'below' | 'none'>('none');
  const held = useRef<HTMLElement | null>(null);
  const stop = useRef<(() => void) | undefined>(undefined);

  const measure = useCallback((node: HTMLElement) => {
    const left = node.scrollHeight - node.clientHeight - node.scrollTop;
    setMore(left > SETTLED_PX ? 'below' : 'none');
  }, []);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      if (node === held.current) return;
      stop.current?.();
      stop.current = undefined;
      held.current = node;
      if (!node) {
        setMore('none');
        return;
      }

      const again = (): void => measure(node);
      again();

      // Three things change the answer: the captain scrolls, the panel is
      // resized, and the content itself grows or shrinks — a company listed,
      // a filter narrowing the rows. The last needs the content watched as
      // well as the box, because a box that has not moved can still have
      // more in it.
      node.addEventListener('scroll', again, { passive: true });
      const sizes = new ResizeObserver(again);
      sizes.observe(node);
      for (const child of node.children) sizes.observe(child);
      stop.current = () => {
        node.removeEventListener('scroll', again);
        sizes.disconnect();
      };
    },
    [measure],
  );

  useEffect(() => () => stop.current?.(), []);

  return { ref, more };
}
