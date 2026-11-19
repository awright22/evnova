/**
 * The galaxy chart.
 *
 * Shows every system the Reach has, the lanes between them, and which of them
 * this hull can reach in one jump. Works by keyboard alone: arrows move
 * between reachable systems, Enter spools, Escape closes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { REGION_NAMES, SECURITY_NAMES, type Chart, type ChartSystem } from './galaxy.ts';
import './map.css';

export interface GalaxyMapProps {
  readonly chart: Chart;
  /** Where the hull is now. */
  readonly currentSystem: string;
  /** Systems one jump away. */
  readonly reachable: readonly string[];
  /** Propellant aboard, and what a jump costs, so the cost is visible. */
  readonly propellant: number;
  readonly jumpCost: number;
  /** Why the last jump was refused, if it was. */
  readonly refusal: string | undefined;
  /** The course already plotted, so the chart opens on it. */
  readonly course: string | undefined;
  onJump: (systemId: string) => void;
  /** Note the destination without spooling, so J can spool for it later. */
  onPlot: (systemId: string) => void;
  onClose: () => void;
}

export function GalaxyMap({
  chart,
  currentSystem,
  reachable,
  propellant,
  jumpCost,
  refusal,
  course,
  onJump,
  onPlot,
  onClose,
}: GalaxyMapProps): React.JSX.Element {
  const here = chart.byId.get(currentSystem);
  const reachableSet = useMemo(() => new Set(reachable), [reachable]);

  const [selected, setSelected] = useState<string>(
    () => course ?? reachable[0] ?? currentSystem,
  );
  const frameRef = useRef<HTMLDivElement | null>(null);

  // Keep the selection on something the hull can actually reach.
  useEffect(() => {
    if (!reachableSet.has(selected)) setSelected(reachable[0] ?? currentSystem);
  }, [reachable, reachableSet, selected, currentSystem]);

  useEffect(() => {
    frameRef.current?.focus();
  }, []);

  const bounds = useMemo(() => {
    const xs = chart.systems.map((s) => s.mapX);
    const ys = chart.systems.map((s) => s.mapY);
    const pad = 70;
    return {
      minX: Math.min(...xs) - pad,
      minY: Math.min(...ys) - pad,
      width: Math.max(...xs) - Math.min(...xs) + pad * 2,
      height: Math.max(...ys) - Math.min(...ys) + pad * 2,
    };
  }, [chart]);

  /** Move the selection to the reachable system furthest in a direction. */
  const step = useCallback(
    (dx: number, dy: number) => {
      const from = chart.byId.get(selected) ?? here;
      if (!from) return;
      const options = reachable
        .map((id) => chart.byId.get(id))
        .filter((system): system is ChartSystem => system !== undefined)
        .filter((system) => system.id !== selected);
      if (options.length === 0) return;

      const best = options.reduce<{ system: ChartSystem; score: number } | undefined>(
        (carry, system) => {
          const vx = system.mapX - from.mapX;
          const vy = system.mapY - from.mapY;
          const length = Math.hypot(vx, vy) || 1;
          // Favour the direction asked for, then nearness.
          const alignment = (vx / length) * dx + (vy / length) * dy;
          if (alignment <= 0.2) return carry;
          const score = alignment - length / 2000;
          return !carry || score > carry.score ? { system, score } : carry;
        },
        undefined,
      );

      if (best) setSelected(best.system.id);
    },
    [chart, here, reachable, selected],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        case 'Enter':
          event.preventDefault();
          if (reachableSet.has(selected)) onJump(selected);
          break;
        case 'j':
        case 'J':
          event.preventDefault();
          if (reachableSet.has(selected)) onPlot(selected);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          step(-1, 0);
          break;
        case 'ArrowRight':
          event.preventDefault();
          step(1, 0);
          break;
        case 'ArrowUp':
          event.preventDefault();
          step(0, -1);
          break;
        case 'ArrowDown':
          event.preventDefault();
          step(0, 1);
          break;
        case 'Tab': {
          event.preventDefault();
          const index = reachable.indexOf(selected);
          const next = reachable[(index + (event.shiftKey ? -1 : 1) + reachable.length) % reachable.length];
          if (next) setSelected(next);
          break;
        }
        default:
          break;
      }
    },
    [onClose, onJump, onPlot, reachable, reachableSet, selected, step],
  );

  const chosen = chart.byId.get(selected);
  const affordable = propellant >= jumpCost;

  return (
    <div
      className="chart"
      ref={frameRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label="Galaxy chart"
    >
      <div className="chart__panel panel">
        <header className="panel-header">
          <h2>The Reach</h2>
          <span className="micro">
            Arrows to choose &middot; Enter to spool &middot; J to plot &middot; Esc to close
          </span>
        </header>

        <div className="chart__body">
          <svg
            className="chart__svg"
            viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
            role="img"
            aria-label="Chart of the Reach"
          >
            {/* Lanes first, so systems sit on top of them. */}
            <g className="chart__lanes">
              {chart.systems.flatMap((system) =>
                system.links
                  // Draw each lane once.
                  .filter((link) => link > system.id)
                  .map((link) => {
                    const other = chart.byId.get(link);
                    if (!other) return null;
                    const live =
                      (system.id === currentSystem && reachableSet.has(link)) ||
                      (link === currentSystem && reachableSet.has(system.id));
                    return (
                      <line
                        key={`${system.id}-${link}`}
                        x1={system.mapX}
                        y1={system.mapY}
                        x2={other.mapX}
                        y2={other.mapY}
                        className={live ? 'chart__lane chart__lane--live' : 'chart__lane'}
                      />
                    );
                  }),
              )}
            </g>

            <g>
              {chart.systems.map((system) => {
                const isHere = system.id === currentSystem;
                const canReach = reachableSet.has(system.id);
                const isSelected = system.id === selected;
                return (
                  <g
                    key={system.id}
                    className={[
                      'chart__system',
                      `chart__system--${system.region}`,
                      isHere ? 'is-here' : '',
                      canReach ? 'is-reachable' : '',
                      isSelected ? 'is-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => canReach && setSelected(system.id)}
                    onDoubleClick={() => canReach && onJump(system.id)}
                  >
                    {isSelected && <circle cx={system.mapX} cy={system.mapY} r={16} className="chart__halo" />}
                    <circle cx={system.mapX} cy={system.mapY} r={isHere ? 8 : 5.5} className="chart__dot" />
                    {isHere && (
                      <circle cx={system.mapX} cy={system.mapY} r={13} className="chart__here" />
                    )}
                    <text x={system.mapX} y={system.mapY - 16} className="chart__label">
                      {system.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>

          <aside className="chart__detail">
            {chosen ? (
              <>
                <h3>{chosen.name}</h3>
                <p className="chart__region">
                  {REGION_NAMES[chosen.region]} &middot; {SECURITY_NAMES[chosen.security]}
                </p>
                <p className="chart__description">{chosen.description}</p>

                {chosen.ports.length > 0 && (
                  <>
                    <span className="label">Berths</span>
                    <ul className="chart__ports">
                      {chosen.ports.map((port) => (
                        <li key={port.id}>
                          <span className="chart__port-name">{port.name}</span>
                          <span className="micro">{port.services.join(' · ')}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {/* Where you can go on from there: a route is planned a lane
                    at a time, so the next lanes belong on the same panel. */}
                {chosen.links.length > 0 && (
                  <>
                    <span className="label">Lanes out</span>
                    <ul className="chart__lanes-out">
                      {chosen.links.map((link) => {
                        const other = chart.byId.get(link);
                        if (!other) return null;
                        return (
                          <li key={link}>
                            <button
                              type="button"
                              className="chart__lane-link"
                              onClick={() => setSelected(link)}
                            >
                              {other.name}
                            </button>
                            <span className={`chart__pip chart__pip--${other.region}`} />
                            <span className="micro">{SECURITY_NAMES[other.security]}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="chart__description">Nowhere selected.</p>
            )}
          </aside>
        </div>

        <footer className="chart__footer">
          <div className="chart__cost">
            <span className="label">Propellant</span>
            <span className={affordable ? 'data' : 'data chart__short'}>
              {propellant} / {jumpCost} needed
            </span>
          </div>
          {refusal !== undefined && <span className="chart__refusal">{refusal}</span>}
          <div className="chart__actions">
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="button"
              disabled={!reachableSet.has(selected)}
              onClick={() => onPlot(selected)}
            >
              Plot the course
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={!reachableSet.has(selected) || !affordable}
              onClick={() => onJump(selected)}
            >
              Spool for {chosen?.name ?? '—'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
