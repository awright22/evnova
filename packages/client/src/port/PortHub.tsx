/**
 * The port hub.
 *
 * Landed, every screen is the ship's terminal connected to the berth. This is
 * the hub: the vista, who owns the place, what it will sell you, and the way
 * back out.
 *
 * Services the berth offers but the game has not built yet are listed as
 * facts about the port rather than as controls, because a button that does
 * nothing is worse than no button.
 */

import { useCallback, useMemo, useEffect, useRef, useState } from 'react';

import { content, placeAll } from '@marque/shared';

import type { ChartPort, ChartSystem } from '../map/galaxy.ts';
import { PortVista } from './PortVista.tsx';
import './port.css';

/**
 * The houses a berth keeps. A house that is not trading yet says so in the
 * berth's own words: the captain is told the floor is shut, not which
 * milestone opens it.
 */
const SERVICE_LABELS: Record<string, { name: string; trading: boolean }> = {
  staple: { name: 'the Staple', trading: true },
  bourse: { name: 'the Bourse', trading: false },
  factor: { name: 'the Factor', trading: false },
  yard: { name: 'the Yard', trading: true },
  moorings: { name: 'the Moorings', trading: true },
  repair: { name: 'Repairs', trading: true },
};

export interface PortHubState {
  readonly system: ChartSystem;
  readonly port: ChartPort;
  readonly marks: number;
  readonly propellant: number;
  readonly propellantCapacity: number;
  readonly ordnance: number;
  /** Marks the Prize Court has against this captain, 0 when not posted. */
  readonly composition: number;
  /** True while the berth's market is open to this captain. */
  readonly hasStaple: boolean;
  /** How many of the captain's hulls are tied up at this berth. */
  readonly mooredHere: number;
  /**
   * What this berth charges for a unit of each, 0 when it keeps no Staple.
   *
   * Both are commodities, so their price is the berth's and moves with its
   * stock: a row that said only "fill the tanks" was hiding the number that
   * decides whether to.
   */
  readonly propellantAsk: number;
  readonly ordnanceAsk: number;
  readonly structure: number;
  readonly draught: string;
  readonly busy: boolean;
  readonly notice: string | undefined;
}

export interface PortHubProps {
  readonly state: PortHubState;
  onBuy: (service: 'repair' | 'propellant' | 'ordnance' | 'composition') => void;
  onLaunch: () => void;
  onOpenChart: () => void;
  onOpenStaple: () => void;
  onOpenYard: () => void;
  onOpenMoorings: () => void;
  /** True while this berth keeps a Yard. */
  readonly hasYard: boolean;
  readonly hasMoorings: boolean;
}

export function PortHub({
  state,
  onBuy,
  onLaunch,
  onOpenChart,
  onOpenStaple,
  onOpenYard,
  onOpenMoorings,
  hasYard,
  hasMoorings,
}: PortHubProps): React.JSX.Element {
  const launchRef = useRef<HTMLButtonElement | null>(null);
  const [focusMoved, setFocusMoved] = useState(false);

  // Land with the focus on the way out: the commonest thing a captain does at
  // a berth is leave it.
  useEffect(() => {
    if (!focusMoved) {
      launchRef.current?.focus();
      setFocusMoved(true);
    }
  }, [focusMoved]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.target instanceof HTMLButtonElement) return;
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        onLaunch();
      }
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        onOpenChart();
      }
    },
    [onLaunch, onOpenChart],
  );

  const hurt = state.structure < 0.999;
  const tanksShort = state.propellant < state.propellantCapacity;

  // A magazine is only worth filling on a hull with something that empties
  // it. Offering it to a draught carrying nothing but a fixed gun is the
  // berth selling a service the hull cannot use.
  const firesOrdnance = useMemo(() => {
    const { blueprints, modules } = content();
    const blueprint = [...blueprints.values()].find(
      (candidate) => candidate.name === state.draught || candidate.id === state.draught,
    );
    if (!blueprint) return false;
    return placeAll(blueprint.placements, modules).some(
      (module) => (module.def.weapon?.ammoPerShot ?? 0) > 0,
    );
  }, [state.draught]);

  return (
    <main className="port" onKeyDown={onKeyDown} tabIndex={-1}>
      <PortVista port={state.port} system={state.system} />

      <div className="port__terminal">
        <header className="port__head panel">
          <div>
            <h1 className="port__name">{state.port.name}</h1>
            <p className="micro">
              {state.system.name} &middot; {ownerName(state.port.owner)}
            </p>
          </div>
          <dl className="port__purse">
            <div>
              <dt className="label">Marks</dt>
              <dd className="data port__marks">{state.marks.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="label">Draught</dt>
              <dd className="data">{state.draught}</dd>
            </div>
          </dl>
        </header>

        <section className="port__description panel">
          <p>{state.port.description}</p>
        </section>

        <section className="port__services panel">
          <header className="panel-header">
            <h2>This berth</h2>
            {state.notice !== undefined && <span className="port__notice">{state.notice}</span>}
          </header>

          <div className="port__service-list">
            {state.port.services.includes('repair') && (
              <ServiceRow
                name="Repairs"
                detail={
                  hurt
                    ? `Structure at ${Math.round(state.structure * 100)}%`
                    : 'The hull is sound'
                }
                action="Put it right"
                disabled={!hurt || state.busy}
                onAction={() => onBuy('repair')}
              />
            )}

            <ServiceRow
              name="Propellant"
              detail={
                `${state.propellant} of ${state.propellantCapacity} aboard` +
                (state.propellantAsk > 0 ? ` · ${state.propellantAsk} a unit here` : '')
              }
              action="Fill the tanks"
              disabled={!tanksShort || state.busy}
              onAction={() => onBuy('propellant')}
            />

            {state.composition > 0 && (
              <ServiceRow
                name="Composition"
                detail={`The Prize Court has ${state.composition.toLocaleString()} marks against you`}
                action="Settle it"
                disabled={state.busy || state.marks < state.composition}
                onAction={() => onBuy('composition')}
              />
            )}

            {hasYard && (
              <ServiceRow
                name="the Yard"
                detail="Draw a draught, build it, or refit what you fly"
                action="Open the Yard"
                disabled={state.busy}
                onAction={onOpenYard}
              />
            )}

            {state.hasStaple && (
              <ServiceRow
                name="the Staple"
                detail="Commodities, bought and sold by the unit"
                action="Open the floor"
                disabled={state.busy}
                onAction={onOpenStaple}
              />
            )}

            {hasMoorings && (
              <ServiceRow
                name="the Moorings"
                detail={
                  state.mooredHere > 0
                    ? `${state.mooredHere} of your hulls tied up here`
                    : 'Where your hulls lie, and which you are in'
                }
                action="Walk the moorings"
                disabled={state.busy}
                onAction={onOpenMoorings}
              />
            )}

            {firesOrdnance && (
              <ServiceRow
                name="Ordnance"
                detail={
                  `${state.ordnance} units in the magazine` +
                  (state.ordnanceAsk > 0 ? ` · ${state.ordnanceAsk} a unit here` : '')
                }
                action="Take on more"
                disabled={state.busy}
                onAction={() => onBuy('ordnance')}
              />
            )}
          </div>

          <footer className="port__offers">
            <span className="label">Also at this berth</span>
            <ul>
              {state.port.services
                // Repairs and the Staple have rows of their own above.
                .filter(
                  (service) =>
                    service !== 'repair' && service !== 'staple' && service !== 'yard',
                )
                .map((service) => {
                  const label = SERVICE_LABELS[service];
                  return (
                    <li key={service}>
                      <span>{label?.name ?? service}</span>
                      {label?.trading === false && (
                        <span className="micro">floor shut</span>
                      )}
                    </li>
                  );
                })}
            </ul>
          </footer>
        </section>

        <footer className="port__actions">
          <button type="button" className="button" onClick={onOpenChart}>
            Chart <span className="micro">M</span>
          </button>
          <button
            type="button"
            className="button button--primary"
            ref={launchRef}
            onClick={onLaunch}
            disabled={state.busy}
          >
            Launch <span className="micro">L</span>
          </button>
        </footer>
      </div>
    </main>
  );
}

function ServiceRow({
  name,
  detail,
  action,
  disabled,
  onAction,
}: {
  name: string;
  detail: string;
  action: string;
  disabled: boolean;
  onAction: () => void;
}): React.JSX.Element {
  return (
    <div className="port__service">
      <div>
        <span className="port__service-name">{name}</span>
        <span className="micro">{detail}</span>
      </div>
      <button type="button" className="button" disabled={disabled} onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function ownerName(owner: string): string {
  switch (owner) {
    case 'kessler':
      return 'Kessler & Daughters';
    case 'thirty':
      return 'The Thirty';
    case 'reprisal':
      return 'The Reprisal Company';
    case 'unlettered':
      return 'Unlettered';
    default:
      return 'Independent';
  }
}
