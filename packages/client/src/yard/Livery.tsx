/**
 * The livery: the two colours a captain's hulls are painted in.
 *
 * Spec section 4: the hull is neutral metal, livery is bands, stripes and the
 * seal over about a fifth of it, and players pick two paint colours. A
 * captain picks them here, from the colours the yards keep, and sees them on
 * the draught on the board the way the flight view will draw it. The choice
 * is the captain's rather than one hull's: every hull they fly wears it.
 */

import { useEffect, useState } from 'react';
import type { Blueprint } from '@marque/shared';

import { HullPreview } from '../flight/hull/HullPreview.tsx';

export interface Paint {
  readonly id: string;
  readonly name: string;
  readonly hex: string;
}

/** How long the board has to stand still before the preview is baked again. */
const SETTLE_MS = 400;

export function Livery({
  paints,
  chosen,
  draught,
  busy,
  onPick,
}: {
  readonly paints: readonly Paint[];
  /** The captain's colours, or undefined while they fly whatever the yard painted. */
  readonly chosen: readonly [string, string] | undefined;
  /** The draught on the board, painted as it stands. */
  readonly draught: Blueprint | undefined;
  readonly busy: boolean;
  onPick: (bands: string, stripe: string) => void;
}): React.JSX.Element {
  // The preview follows the board once it settles: a bake per placement
  // would keep the oven full while the captain is still laying fittings.
  const [shown, setShown] = useState(draught);
  useEffect(() => {
    const timer = setTimeout(() => setShown(draught), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draught]);

  const bands = chosen?.[0] ?? shown?.paint[0] ?? paints[0]!.hex;
  const stripe = chosen?.[1] ?? shown?.paint[1] ?? paints[1]!.hex;
  const nameOf = (hex: string): string => paints.find((paint) => paint.hex === hex)?.name ?? hex;

  return (
    <div className="yard__livery panel">
      <header className="panel-header">
        <h2>Livery</h2>
        <span className="micro">{chosen ? 'Your colours' : 'As the yard painted her'}</span>
      </header>

      {shown !== undefined && shown.placements.length > 0 && (
        <HullPreview
          blueprint={shown}
          dress={{ kind: 'captain', paint: [bands, stripe] }}
          width={256}
          height={120}
          label={`${shown.name} in ${nameOf(bands)} and ${nameOf(stripe)}`}
        />
      )}

      <Swatches
        label="Bands"
        paints={paints}
        selected={chosen?.[0]}
        busy={busy}
        onPick={(hex) => onPick(hex, stripe)}
      />
      <Swatches
        label="Stripe"
        paints={paints}
        selected={chosen?.[1]}
        busy={busy}
        onPick={(hex) => onPick(bands, hex)}
      />
    </div>
  );
}

function Swatches({
  label,
  paints,
  selected,
  busy,
  onPick,
}: {
  readonly label: string;
  readonly paints: readonly Paint[];
  readonly selected: string | undefined;
  readonly busy: boolean;
  onPick: (hex: string) => void;
}): React.JSX.Element {
  return (
    <div className="yard__swatches" role="radiogroup" aria-label={label}>
      <span className="label">{label}</span>
      <div className="yard__swatch-row">
        {paints.map((paint) => (
          <button
            key={paint.id}
            type="button"
            role="radio"
            aria-checked={selected === paint.hex}
            className={`yard__swatch${selected === paint.hex ? ' yard__swatch--chosen' : ''}`}
            style={{ background: paint.hex }}
            title={paint.name}
            aria-label={paint.name}
            disabled={busy}
            onClick={() => onPick(paint.hex)}
          />
        ))}
      </div>
    </div>
  );
}
