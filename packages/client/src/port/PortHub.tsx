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

import { CHARTERS, content, placeAll } from '@marque/shared';

import type { ChartPort, ChartSystem } from '../map/galaxy.ts';
import { PortVista } from './PortVista.tsx';
import './port.css';

/**
 * The houses a berth keeps. A house that is not trading yet says so in the
 * berth's own words: the captain is told the floor is shut, not which
 * milestone opens it.
 */
/**
 * The charters, as a captain reads them.
 *
 * Named here rather than taken from content because these three are fixed by
 * spec section 19 and the port's `owner` is the plain key, not a label.
 */
const CHARTER_NAMES: Record<string, string> = {
  kessler: 'Kessler & Daughters',
  thirty: 'The Thirty',
  reprisal: 'The Reprisal Company',
  neutral: 'Independent',
  unlettered: 'the Unlettered',
};

/** Services the hub gives a row of its own, so the footer does not repeat them. */
const ROWED_ABOVE = new Set(['repair', 'staple', 'yard', 'bourse', 'moorings', 'factor']);

const SERVICE_LABELS: Record<string, { name: string; trading: boolean }> = {
  staple: { name: 'the Staple', trading: true },
  bourse: { name: 'the Bourse', trading: true },
  factor: { name: 'the Factor', trading: true },
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
  /** Other captains standing at this berth, for the offers row to say so. */
  readonly alongside: number;
  /** How many sail with this captain, and how many asks are unanswered. */
  readonly convoy: number;
  readonly convoyAsks: number;
  /** How many commissions are posted here, for the row to say so. */
  readonly posted: number;
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
  /** Settings: the shell's screen, reachable from alongside. */
  onOpenSettings: () => void;
  onOpenStaple: () => void;
  onOpenYard: () => void;
  onOpenMoorings: () => void;
  onOpenBourse: () => void;
  onOpenBoard: () => void;
  onOpenOffers: () => void;
  onOpenConvoy: () => void;
  /** True while this berth keeps a Yard. */
  readonly hasYard: boolean;
  readonly hasMoorings: boolean;
  readonly hasBourse: boolean;
  readonly hasFactor: boolean;
  /** Where this captain stands with the three charters, once it is known. */
  readonly standing: { standings: Record<string, number>; names: Record<string, string> } | undefined;
}

export function PortHub({
  state,
  onBuy,
  onLaunch,
  onOpenChart,
  onOpenSettings,
  onOpenStaple,
  onOpenYard,
  onOpenMoorings,
  onOpenBourse,
  onOpenBoard,
  onOpenOffers,
  onOpenConvoy,
  hasYard,
  hasMoorings,
  hasBourse,
  hasFactor,
  standing,
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

  // What this berth keeps that has no row of its own above. Everything the
  // hub already offers is filtered out, so at a full berth this is empty and
  // the section it heads is not drawn at all.
  const alsoHere = state.port.services.filter((service) => !ROWED_ABOVE.has(service));
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
                detail="Draw a draught, build it, or refit"
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

            {hasFactor && (
              <ServiceRow
                name="the Factor"
                detail={
                  state.posted > 0
                    ? `${state.posted} commissions posted`
                    : 'Work posted by the companies and by the berth'
                }
                action="Read the board"
                disabled={state.busy}
                onAction={onOpenBoard}
              />
            )}

            {/*
              Always here, not a berth service: anybody alongside can hand
              something to anybody else alongside, and a berth has no say in
              it. The row says who is standing here so a captain alone does
              not open an empty counter.
            */}
            <ServiceRow
              name="Alongside"
              detail={
                state.alongside > 0
                  ? `${state.alongside} other ${state.alongside === 1 ? 'captain' : 'captains'} here`
                  : 'Hand marks, cargo or a draught over'
              }
              action="Offers"
              disabled={state.busy}
              onAction={onOpenOffers}
            />

            <ServiceRow
              name="Convoy"
              // Short enough for one line: `.micro` shouts, and a sentence
              // that wraps in it reads as two lines of shouting.
              detail={
                state.convoy > 0 ? `${state.convoy} sailing with you` : 'Sail with other captains'
              }
              action={state.convoyAsks > 0 ? `${state.convoyAsks} waiting` : 'Open it'}
              disabled={state.busy}
              onAction={onOpenConvoy}
            />

            {hasBourse && (
              <ServiceRow
                name="the Bourse"
                detail="The ten listed companies, and the Gazette"
                action="Open the Bourse"
                disabled={state.busy}
                onAction={onOpenBourse}
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

          {standing !== undefined && (
            <section className="port__standing panel">
              <header className="panel-header">
                <h2>Standing</h2>
                <span className="micro">{CHARTER_NAMES[state.port.owner] ?? 'Independent'}</span>
              </header>
              <ul className="port__charters">
                {CHARTERS.map((charter) => {
                  const value = standing.standings[charter] ?? 0;
                  const here = charter === state.port.owner;
                  return (
                    <li
                      key={charter}
                      className={here ? 'port__charter port__charter--here' : 'port__charter'}
                    >
                      <span>{CHARTER_NAMES[charter]}</span>
                      <span className="port__charter-reading">
                        <span className={value < 0 ? 'is-loss' : value > 0 ? 'is-gain' : undefined}>
                          {standing.names[charter] ?? 'Unknown'}
                        </span>
                        <span className="data micro">
                          {value > 0 ? '+' : ''}
                          {Math.round(value)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/*
            A heading that means "and these as well" needs something to say
            as well. At a berth where everything it would list already has a
            row above, the filter empties it and the capture showed a labelled
            box with nothing in it — which reads as content that failed to
            load rather than as a berth that keeps nothing else.
          */}
          {alsoHere.length > 0 && (
            <footer className="port__offers">
              <span className="label">Also at this berth</span>
              <ul>
                {alsoHere.map((service) => {
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
          )}
        </section>

        <footer className="port__actions">
          <button type="button" className="button" onClick={onOpenChart}>
            Chart <span className="micro">M</span>
          </button>
          {/*
            Alongside is where a captain has a moment: settings are reachable
            from here rather than from the flight view, where pressing the
            wrong thing costs a hull.
          */}
          <button type="button" className="button" onClick={onOpenSettings}>
            Settings
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
