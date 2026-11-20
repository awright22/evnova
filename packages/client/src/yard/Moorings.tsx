/**
 * The Moorings.
 *
 * Every hull a captain owns, where it is, and what state it is in. A hull tied
 * up at this berth can be taken out; one lying in another system is listed with
 * where to go and find it, because that is the whole cost of owning several —
 * a cruiser at Careenage is no use to you at Ostrand.
 *
 * Nothing here is authoritative. The server decides whether a swap is allowed;
 * this shows what it will say yes to.
 */

import { useMemo } from 'react';

import {
  boundsOf,
  content,
  deriveStats,
  placeAll,
  type Placement,
} from '@marque/shared';

import './moorings.css';

export interface MooredHull {
  readonly id: string;
  readonly name: string;
  readonly placements: Placement[];
  /** Empty while this is the hull being flown. */
  readonly portId: string;
  readonly systemId: string;
}

export interface MooringsProps {
  readonly hulls: readonly MooredHull[];
  /** The hull being flown, which may be a starter draught with no row. */
  readonly flyingId: string;
  readonly flyingName: string;
  readonly portId: string;
  readonly berthName: string;
  readonly busy: boolean;
  readonly notice: string | undefined;
  onSwitch: (id: string) => void;
  onClose: () => void;
}

export function Moorings({
  hulls,
  flyingId,
  flyingName,
  portId,
  berthName,
  busy,
  notice,
  onSwitch,
  onClose,
}: MooringsProps): React.JSX.Element {
  const { modules, tuning, systems } = content();

  /**
   * The hulls, sorted the way a captain reads them: the one being flown
   * first, then what is tied up here, then everything elsewhere.
   */
  const rows = useMemo(() => {
    const described = hulls.map((hull) => {
      const placed = placeAll(hull.placements, modules);
      const stats = placed.length > 0 ? deriveStats(placed, tuning) : undefined;
      const bounds = placed.length > 0 ? boundsOf(placed) : undefined;
      const flying = hull.portId === '';
      const here = !flying && hull.portId === portId;

      return {
        ...hull,
        flying,
        here,
        fittings: hull.placements.length,
        span: bounds ? Math.max(bounds.width, bounds.height) : 0,
        mass: stats?.totalMass ?? 0,
        hold: stats?.cargoCapacity ?? 0,
        shield: stats?.shieldCapacity ?? 0,
        where: flying
          ? 'Under way'
          : here
            ? `Alongside, ${berthName}`
            : berthOf(systems, hull.systemId, hull.portId),
      };
    });

    return described.sort((a, b) => {
      const rank = (row: typeof a): number => (row.flying ? 0 : row.here ? 1 : 2);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
  }, [hulls, modules, tuning, systems, portId, berthName]);

  const parked = rows.filter((row) => row.here).length;

  return (
    <main className="moorings">
      <section className="moorings__panel panel">
        <header className="panel-header">
          <h2>The Moorings</h2>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </header>

        <p className="moorings__lede micro">
          {rows.length === 0
            ? `You own no hulls. You fly the ${flyingName}, which is not yours to leave anywhere.`
            : parked > 0
              ? `${parked} tied up at ${berthName}. A hull lying elsewhere has to be fetched.`
              : `Nothing of yours is tied up at ${berthName}.`}
        </p>

        {rows.length === 0 ? (
          // The starter is the one hull a captain does not own: it came with
          // the ticket. Saying so is better than an empty table.
          <p className="moorings__none">
            Build one at a Yard and it will be moored where you built it.
          </p>
        ) : (
          <table className="moorings__table">
            <thead>
              <tr>
                <th scope="col">Hull</th>
                <th scope="col">Where</th>
                <th scope="col" className="moorings__figure">
                  Fittings
                </th>
                <th scope="col" className="moorings__figure">
                  Mass
                </th>
                <th scope="col" className="moorings__figure">
                  Hold
                </th>
                <th scope="col" className="moorings__figure">
                  Shield
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.flying ? 'moorings__row--flying' : undefined}>
                  <th scope="row">
                    <span className="moorings__name">{row.name}</span>
                    <span className="micro">{row.span} cells across</span>
                  </th>
                  <td>{row.where}</td>
                  <td className="moorings__figure data">{row.fittings}</td>
                  <td className="moorings__figure data">{Math.round(row.mass)}</td>
                  <td className="moorings__figure data">{row.hold}</td>
                  <td className="moorings__figure data">{Math.round(row.shield)}</td>
                  <td className="moorings__figure">
                    {row.flying ? (
                      <span className="micro">Flying</span>
                    ) : (
                      <button
                        type="button"
                        // A plain button, not the amber one: this is a row
                        // action repeated down a list, and a column of amber
                        // dilutes it as the player's signal colour.
                        className="button"
                        disabled={busy || !row.here}
                        title={
                          row.here
                            ? `Take out the ${row.name}`
                            : `The ${row.name} is at ${row.where}`
                        }
                        onClick={() => onSwitch(row.id)}
                      >
                        Take it out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/*
          The hull being flown is listed above only once it has a row. A
          captain still in the draught their account opened with owns nothing,
          so what they are flying is said here instead of being left out.
        */}
        {flyingId === '' && rows.length > 0 && (
          <p className="moorings__lede micro">
            You are flying the {flyingName}, which came with the ticket and is not yours
            to leave anywhere.
          </p>
        )}

        {notice !== undefined && <p className="moorings__notice">{notice}</p>}
      </section>
    </main>
  );
}

/** Where a parked hull is, in words a captain can navigate by. */
function berthOf(
  systems: ReturnType<typeof content>['systems'],
  systemId: string,
  portId: string,
): string {
  const system = systems.get(systemId);
  const port = system?.ports.find((candidate) => candidate.id === portId);
  if (!system) return 'Elsewhere';
  return port ? `${port.name}, ${system.name}` : system.name;
}
