/**
 * A struck seal.
 *
 * The geometry is shared and deterministic in the issuer's id — see
 * `@marque/shared`'s `seal.ts` — so the same institution always strikes the
 * same mark, on a document, on port chrome or on a hull. This draws it.
 *
 * Struck, not illustrated: flat lines in the issuer's livery colour, no
 * gradient, no bevel, no wax, and no glyph anywhere inside the rim. At
 * document size the rim carries the issuer's name on a circular path.
 */

import { useId } from 'react';

import { sealGeometry, sealOf } from '@marque/shared';

import './seal.css';

/** The livery an issuer strikes in. Anything unlisted strikes in the rule. */
const LIVERY: Record<string, string> = {
  kessler: 'var(--livery-kessler)',
  thirty: 'var(--livery-thirty)',
  reprisal: 'var(--livery-reprisal)',
  unlettered: 'var(--livery-unlettered)',
};

/**
 * The ink an issuer strikes in.
 *
 * A house strikes in its livery. A berth that answers to nobody strikes in
 * plain type colour — it has no livery, which is the point of it, and a mark
 * nobody can see is not a mark.
 */
export function liveryOf(issuer: string): string {
  return LIVERY[issuer] ?? 'var(--text-secondary)';
}

export function Seal({
  issuer,
  name,
  size = 44,
  className,
}: {
  /** The issuer's id, which is both the seed and the livery. */
  readonly issuer: string;
  /** Set on the rim at document size. Omit for chrome and decals. */
  readonly name?: string;
  readonly size?: number;
  readonly className?: string;
}): React.JSX.Element {
  const design = sealOf(issuer);
  const geometry = sealGeometry(design);
  const ink = liveryOf(issuer);
  const pathId = useId();

  // The rim sits inside the box by its own stroke, so nothing is clipped.
  const radius = 50 - 2;
  const rim = name !== undefined ? radius - 9 : radius;

  const toPoints = (points: readonly { x: number; y: number }[]): string =>
    points.map((point) => `${(50 + point.x * rim).toFixed(2)},${(50 + point.y * rim).toFixed(2)}`)
      .join(' ');

  return (
    <svg
      className={`seal${className ? ` ${className}` : ''}`}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={name !== undefined ? `${name}'s seal` : 'a seal'}
      style={{ color: ink }}
    >
      {name !== undefined && (
        <>
          <defs>
            <path
              id={pathId}
              fill="none"
              d={`M 50 ${50 - radius + 3.4} A ${radius - 3.4} ${radius - 3.4} 0 1 1 ${49.9} ${
                50 - radius + 3.4
              }`}
            />
          </defs>
          <circle className="seal__rim seal__rim--outer" cx="50" cy="50" r={radius} />
          <text className="seal__name">
            <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
              {name}
            </textPath>
          </text>
        </>
      )}

      <circle className="seal__rim" cx="50" cy="50" r={rim} />

      {geometry.rings.map((ring) => (
        <circle
          key={ring}
          className="seal__ring"
          cx="50"
          cy="50"
          r={(ring * rim).toFixed(2)}
        />
      ))}

      {geometry.ticks.map((tick) => (
        <line
          key={tick.angle}
          className="seal__tick"
          x1={(50 + Math.cos(tick.angle) * tick.from * rim).toFixed(2)}
          y1={(50 + Math.sin(tick.angle) * tick.from * rim).toFixed(2)}
          x2={(50 + Math.cos(tick.angle) * tick.to * rim).toFixed(2)}
          y2={(50 + Math.sin(tick.angle) * tick.to * rim).toFixed(2)}
        />
      ))}

      {geometry.paths.map((path, index) =>
        path.closed ? (
          <polygon key={index} className="seal__device" points={toPoints(path.points)} />
        ) : (
          <polyline key={index} className="seal__device seal__device--open" points={toPoints(path.points)} />
        ),
      )}
    </svg>
  );
}
