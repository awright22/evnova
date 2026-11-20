/**
 * The Yard's editor.
 *
 * Pick a fitting, put it on the grid, and watch what it does to the hull.
 * Everything a captain needs to decide is on one screen: what the draught
 * weighs and how it will fly, what is wrong with it and where, and what it
 * will cost to build — in marks and in materials, against what is in the hold
 * and what this berth can supply.
 *
 * Nothing here is authoritative. The same validation and costing run on the
 * server, which is what actually charges; this is the quote.
 */

import { useCallback, useMemo, useReducer, useState } from 'react';

import {
  boundsOf,
  buildCost,
  content,
  deriveStats,
  placeAll,
  shortModuleName,
  splitBill,
  stocksModule,
  validateDesign,
  type LicenceId,
  type ModuleDef,
  type Placement,
  type Problem,
} from '@marque/shared';

import type { StapleState } from '../game/GameClient.ts';
import { Grid } from './Grid.tsx';
import { cellsCovered, designReducer, emptyDesign, type DesignAction } from './design.ts';
import './yard.css';

export interface EditorProps {
  /** The hull being flown, which a refit starts from. */
  readonly flying: readonly Placement[];
  /**
   * Its id in the Moorings, or empty for a draught that was never built.
   *
   * This decides whether Build is a refit or a new hull, and therefore what
   * the bill is: a refit credits the fittings already aboard, a new hull is
   * paid for whole. Without it the editor quoted every first build as a refit
   * of the starter and under-charged by the value of a whole shuttle.
   */
  readonly flyingId: string;
  readonly flyingName: string;
  readonly licence: string;
  readonly marks: number;
  /** The highest tier this berth's Yard stocks from each maker. */
  readonly stock: Partial<Record<string, number>>;
  readonly berthName: string;
  /** The warrant ladder, lowest first. */
  readonly licences: readonly {
    id: string;
    name: string;
    cost: number;
    maxModules: number;
    maxExtent: number;
    held: boolean;
    behind: boolean;
  }[];
  /** The berth's market, for what materials cost here. */
  readonly staple: StapleState | undefined;
  /** What the captain is carrying, by commodity. */
  readonly hold: ReadonlyMap<string, number>;
  readonly notice: string | undefined;
  /** Problems the server found, which outrank anything shown here. */
  readonly serverProblems: readonly Problem[];
  readonly busy: boolean;
  onBuild: (name: string, placements: readonly Placement[], refitting: boolean) => void;
  onSave: (name: string, placements: readonly Placement[]) => void;
  onBuyLicence: (id: string) => void;
  /** Encode the current draught as a code to paste. */
  onExport: (name: string, placements: readonly Placement[]) => string;
  onImport: (code: string) => void;
  onClose: () => void;
}

/** Fittings grouped the way a captain thinks about them. */
const GROUPS: { readonly label: string; readonly types: readonly string[] }[] = [
  { label: 'Command', types: ['bridge'] },
  { label: 'Structure', types: ['hull', 'armour'] },
  { label: 'Drive', types: ['engine', 'thruster', 'reactor'] },
  { label: 'Defence', types: ['shield'] },
  { label: 'Armament', types: ['weapon', 'turret', 'rack'] },
  { label: 'Hold', types: ['cargo', 'tank'] },
];

export function Editor({
  flying,
  flyingId,
  flyingName,
  licence,
  marks,
  stock,
  berthName,
  licences: ladder,
  staple,
  hold,
  notice,
  serverProblems,
  busy,
  onBuild,
  onSave,
  onBuyLicence,
  onExport,
  onImport,
  onClose,
}: EditorProps): React.JSX.Element {
  const { modules, tuning, licences } = content();

  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof emptyDesign>, action: DesignAction) =>
      designReducer(current, action, modules),
    emptyDesign(flying),
  );

  const [picked, setPicked] = useState<ModuleDef | undefined>(undefined);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [hover, setHover] = useState<{ x: number; y: number } | undefined>(undefined);
  const [name, setName] = useState(flyingName);
  /** Show the whole catalogue, including what this berth cannot supply. */
  const [showAll, setShowAll] = useState(false);
  /** The share-code drawer: closed, showing a code, or taking one. */
  const [sharing, setSharing] = useState<'off' | 'out' | 'in'>('off');
  const [incoming, setIncoming] = useState('');

  const held = licences.get(licence as LicenceId) ?? [...licences.values()][0]!;

  // --- What the draught is ------------------------------------------------

  const placed = useMemo(
    () => placeAll(state.placements, modules),
    [state.placements, modules],
  );
  const stats = useMemo(() => deriveStats(placed, tuning), [placed, tuning]);
  const survey = useMemo(
    () => validateDesign(placed, held, tuning),
    [placed, held, tuning],
  );

  const flown = useMemo(() => {
    const before = placeAll(flying, modules);
    return before.length > 0 ? deriveStats(before, tuning) : undefined;
  }, [flying, modules, tuning]);

  /**
   * A refit changes a hull the captain owns; anything else is a new hull.
   *
   * The starter draught is not owned — it came with the ticket — so a captain
   * who has never built is buying their first hull outright even though the
   * grid opens on what they are flying.
   */
  const refitting = flyingId !== '';
  const creditedAgainst = useMemo(() => (refitting ? flying : []), [refitting, flying]);

  const cost = useMemo(
    () => buildCost(state.placements, modules, tuning, creditedAgainst),
    [state.placements, modules, tuning, creditedAgainst],
  );

  const split = useMemo(() => splitBill(cost.bill, hold), [cost.bill, hold]);

  /** What the yard would have to buy here, and what that comes to. */
  const purchase = useMemo(() => {
    const lines: { commodityId: string; name: string; units: number; marks: number }[] = [];
    let total = 0;
    let unavailable = false;

    for (const [commodityId, units] of split.missing) {
      const listing = staple?.listings.find((row) => row.commodityId === commodityId);
      const price = listing?.ask ?? 0;
      const available = listing?.stock ?? 0;
      if (available < units) unavailable = true;

      const marksFor = price * units;
      total += marksFor;
      lines.push({
        commodityId,
        name: listing?.name ?? commodityId,
        units,
        marks: marksFor,
      });
    }

    return { lines, total, unavailable };
  }, [split.missing, staple]);

  const owed = cost.marks + purchase.total;
  const problems = serverProblems.length > 0 ? serverProblems : survey.problems;

  /**
   * How many cells the draught spans at its widest, against the warrant's cap.
   *
   * The same `boundsOf` the validator measures with, so the number shown here
   * and the number in a "covers 8 cells across" problem cannot disagree.
   */
  const extent = useMemo(() => {
    if (placed.length === 0) return 0;
    const bounds = boundsOf(placed);
    return Math.max(bounds.width, bounds.height);
  }, [placed]);

  /** The next warrant up, which is the only one worth offering. */
  const nextWarrant = useMemo(
    () => ladder.find((rung) => !rung.held && !rung.behind),
    [ladder],
  );

  // --- Working the grid ---------------------------------------------------

  const ghost = useMemo(() => {
    if (!picked || !hover) return undefined;
    const placement: Placement = { moduleId: picked.id, x: hover.x, y: hover.y, rotation };

    const taken = new Set<string>();
    for (const existing of state.placements) {
      const def = modules.get(existing.moduleId);
      if (def) for (const cell of cellsCovered(existing, def)) taken.add(cell);
    }
    const valid = !cellsCovered(placement, picked).some((cell) => taken.has(cell));

    return { placement, def: picked, valid };
  }, [picked, hover, rotation, state.placements, modules]);

  const onCellDown = useCallback(
    (x: number, y: number, index: number | undefined, additive: boolean) => {
      if (picked) {
        dispatch({
          kind: 'place',
          placement: { moduleId: picked.id, x, y, rotation },
          def: picked,
        });
        return;
      }

      if (index === undefined) {
        dispatch({ kind: 'select', indices: [] });
        return;
      }

      const next = additive
        ? state.selection.includes(index)
          ? state.selection.filter((candidate) => candidate !== index)
          : [...state.selection, index]
        : [index];
      dispatch({ kind: 'select', indices: next });
    },
    [picked, rotation, state.selection],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      const key = event.key.toLowerCase();

      if (key === 'escape') {
        event.preventDefault();
        if (picked) setPicked(undefined);
        else onClose();
        return;
      }
      if (key === 'r') {
        event.preventDefault();
        if (picked) setRotation((turn) => ((turn + 90) % 360) as 0 | 90 | 180 | 270);
        else dispatch({ kind: 'rotate', indices: state.selection });
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        event.preventDefault();
        dispatch({ kind: 'remove', indices: state.selection });
        return;
      }
      if (key === 'm') {
        event.preventDefault();
        dispatch({ kind: 'mirror', on: !state.mirror });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        dispatch({ kind: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'c') {
        event.preventDefault();
        dispatch({ kind: 'copy' });
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === 'v' && hover) {
        event.preventDefault();
        dispatch({ kind: 'paste', at: hover });
      }
    },
    [picked, state.selection, state.mirror, hover, onClose],
  );

  return (
    <main className="yard" onKeyDown={onKeyDown} tabIndex={-1}>
      <section className="yard__fittings panel">
        <header className="panel-header">
          <h2>Fittings</h2>
          <button
            type="button"
            className={`yard__scope micro${showAll ? ' yard__scope--on' : ''}`}
            onClick={() => setShowAll((on) => !on)}
            title={
              showAll
                ? `Showing the whole Register. ${berthName} cannot supply the greyed fittings.`
                : `Showing only what ${berthName} stocks.`
            }
          >
            {showAll ? 'Everywhere' : 'In stock'}
          </button>
        </header>

        <div className="yard__catalogue">
          {GROUPS.map((group) => {
            const inGroup = [...modules.values()]
              .filter((def) => group.types.includes(def.type))
              .filter((def) => showAll || stocksModule(stock, def));
            if (inGroup.length === 0) return null;

            return (
              <div key={group.label} className="yard__group">
                <span className="label">{group.label}</span>
                {inGroup.map((def) => {
                  const here = stocksModule(stock, def);
                  return (
                    <button
                      key={def.id}
                      type="button"
                      // A fitting this berth cannot supply is shown, not
                      // hidden: a captain should be able to see what exists
                      // and go and find it. It just cannot be picked.
                      disabled={!here}
                      className={`yard__fitting${picked?.id === def.id ? ' yard__fitting--on' : ''}${
                        here ? '' : ' yard__fitting--elsewhere'
                      }`}
                      title={
                        here
                          ? def.description
                          : `${berthName} does not stock this. Tier ${def.tier} ${
                              tuning.manufacturers[def.manufacturer] ?? def.manufacturer
                            }.`
                      }
                      onClick={() => setPicked(picked?.id === def.id ? undefined : def)}
                    >
                      <span className="yard__fitting-name">
                        {/*
                          The name needs a box of its own to be clipped with
                          an ellipsis: a bare text node in a flex row has none,
                          so it was pushing the maker tag off the end and both
                          were cut mid-word.
                        */}
                        <span className="yard__fitting-what">
                          {shortModuleName(
                            def.name,
                            tuning.manufacturers[def.manufacturer] ?? def.manufacturer,
                          )}
                        </span>
                        <span className="yard__maker">
                          {def.manufacturer}
                          {def.tier > 1 ? ` ${'I'.repeat(def.tier)}` : ''}
                        </span>
                      </span>
                      <span className="yard__fitting-figures">
                        <span className="data">{def.cost.toLocaleString()}</span>
                        <span className="micro">
                          {def.footprint.width}×{def.footprint.height}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      <section className="yard__board">
        <header className="yard__board-head panel">
          <input
            className="yard__name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            aria-label="Draught name"
          />
          <div className="yard__tools">
            <button
              type="button"
              className={`button${state.mirror ? ' button--primary' : ''}`}
              onClick={() => dispatch({ kind: 'mirror', on: !state.mirror })}
            >
              Mirror
            </button>
            <button
              type="button"
              className="button"
              disabled={state.past.length === 0}
              onClick={() => dispatch({ kind: 'undo' })}
            >
              Undo
            </button>
            <button
              type="button"
              className="button"
              disabled={state.future.length === 0}
              onClick={() => dispatch({ kind: 'redo' })}
            >
              Redo
            </button>
            <button
              type="button"
              className={`button${sharing !== 'off' ? ' button--primary' : ''}`}
              onClick={() => setSharing((open) => (open === 'off' ? 'out' : 'off'))}
              title="Copy this draught as a code, or read one in"
            >
              Code
            </button>
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {sharing !== 'off' && (
          <div className="yard__share panel">
            <div className="yard__share-tabs">
              <button
                type="button"
                className={`yard__share-tab${sharing === 'out' ? ' yard__share-tab--on' : ''}`}
                onClick={() => setSharing('out')}
              >
                Write one out
              </button>
              <button
                type="button"
                className={`yard__share-tab${sharing === 'in' ? ' yard__share-tab--on' : ''}`}
                onClick={() => setSharing('in')}
              >
                Read one in
              </button>
            </div>

            {sharing === 'out' ? (
              <>
                {/*
                  Read-only and selected on focus: the point of this field is
                  to be copied, and a captain who edits a code has broken its
                  checksum without being told why.
                */}
                <textarea
                  className="yard__code"
                  readOnly
                  rows={3}
                  value={state.placements.length > 0 ? onExport(name, state.placements) : ''}
                  onFocus={(event) => event.currentTarget.select()}
                  aria-label="This draught as a code"
                />
                <p className="micro">
                  Anyone who reads this has the draught exactly. It carries no hull, no
                  fittings and no marks — they still have to build it.
                </p>
              </>
            ) : (
              <>
                <textarea
                  className="yard__code"
                  rows={3}
                  value={incoming}
                  onChange={(event) => setIncoming(event.target.value)}
                  placeholder="Paste a draught code"
                  aria-label="A draught code to read in"
                />
                <div className="yard__share-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || incoming.trim() === ''}
                    onClick={() => {
                      onImport(incoming);
                      setIncoming('');
                    }}
                  >
                    Read it
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <Grid
          placements={state.placements}
          modules={modules}
          selection={state.selection}
          problems={problems}
          ghost={ghost}
          mirror={state.mirror}
          onCellDown={onCellDown}
          onCellMove={(x, y) => setHover({ x, y })}
          onCellUp={() => undefined}
        />

        <footer className="yard__hint micro">
          {picked
            ? `Placing ${shortModuleName(
                picked.name,
                tuning.manufacturers[picked.manufacturer] ?? picked.manufacturer,
              )} · R to turn it · Esc to put it down`
            : 'Click a fitting to place it · R turns the selection · M mirrors · Del removes'}
        </footer>
      </section>

      <section className="yard__readout">
        <div className="yard__survey panel">
          <header className="panel-header">
            <h2>Survey</h2>
            <span className={survey.valid ? 'yard__verdict yard__verdict--ok' : 'yard__verdict'}>
              {survey.valid ? 'Passes' : `${problems.length} to answer`}
            </span>
          </header>

          {problems.length === 0 ? (
            <p className="micro">Nothing outstanding.</p>
          ) : (
            <ul className="yard__problems">
              {problems.map((problem) => (
                <li key={`${problem.code}-${problem.placements.join(',')}`}>{problem.message}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="yard__warrant panel">
          <header className="panel-header">
            <h2>Warrant</h2>
            <span className="micro">{held.name}</span>
          </header>

          <p className="micro">
            {held.maxModules} fittings, {held.maxExtent} cells across. This draught:{' '}
            <span className={state.placements.length > held.maxModules ? 'yard__short' : 'data'}>
              {state.placements.length}
            </span>{' '}
            in{' '}
            <span className={extent > held.maxExtent ? 'yard__short' : 'data'}>{extent}</span>.
          </p>

          {nextWarrant === undefined ? (
            <p className="micro">Nothing further is issued.</p>
          ) : (
            <div className="yard__warrant-next">
              <span className="label">{nextWarrant.name}</span>
              <span className="micro">
                {nextWarrant.maxModules} fittings, {nextWarrant.maxExtent} across
              </span>
              <button
                type="button"
                // Plain: Build is the amber action of this screen, and a
                // second amber button beside it competes for the same eye.
                className="button"
                disabled={busy || marks < nextWarrant.cost}
                onClick={() => onBuyLicence(nextWarrant.id)}
                title={
                  marks < nextWarrant.cost
                    ? `${(nextWarrant.cost - marks).toLocaleString()} marks short`
                    : `Take out a ${nextWarrant.name}`
                }
              >
                {nextWarrant.cost.toLocaleString()}
              </button>
            </div>
          )}
        </div>

        <div className="yard__stats panel">
          <header className="panel-header">
            <h2>Handling</h2>
          </header>
          <dl>
            <Reading name="Mass" value={stats.totalMass} was={flown?.totalMass} unit="t" />
            <Reading
              name="Top speed"
              value={stats.profile.topSpeed}
              was={flown?.profile.topSpeed}
              unit="u/s"
            />
            <Reading
              name="Acceleration"
              value={stats.profile.thrustAccel}
              was={flown?.profile.thrustAccel}
              unit="u/s²"
            />
            <Reading
              name="Turn"
              value={stats.profile.maxTurnRate}
              was={flown?.profile.maxTurnRate}
              unit="rad/s"
              decimals={2}
            />
            <Reading
              name="Power"
              value={stats.powerOutput - stats.powerDraw}
              was={flown ? flown.powerOutput - flown.powerDraw : undefined}
            />
            <Reading name="Shield" value={stats.shieldCapacity} was={flown?.shieldCapacity} />
            <Reading name="Hold" value={stats.cargoCapacity} was={flown?.cargoCapacity} />
            <Reading
              name="Tanks"
              value={stats.propellantCapacity}
              was={flown?.propellantCapacity}
            />
          </dl>
        </div>

        <div className="yard__cost panel">
          <header className="panel-header">
            <h2>The bill</h2>
            <span className={`data${marks < owed ? ' yard__short' : ''}`}>
              {owed.toLocaleString()}
            </span>
          </header>

          <dl className="yard__cost-lines">
            <div>
              <dt>Fittings</dt>
              <dd className="data">{cost.modules.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Insurance</dt>
              <dd className="data">{cost.premium.toLocaleString()}</dd>
            </div>
            {cost.refund > 0 && (
              <div>
                <dt>Stripped</dt>
                <dd className="data yard__refund">-{cost.refund.toLocaleString()}</dd>
              </div>
            )}
            {purchase.total > 0 && (
              <div>
                <dt>Materials bought here</dt>
                <dd className="data">{purchase.total.toLocaleString()}</dd>
              </div>
            )}
          </dl>

          {cost.bill.size > 0 && (
            <>
              <span className="label">Materials</span>
              <ul className="yard__materials">
                {[...cost.bill].map(([commodityId, units]) => {
                  const fromHold = split.fromHold.get(commodityId) ?? 0;
                  const buying = purchase.lines.find((line) => line.commodityId === commodityId);
                  const listing = staple?.listings.find((row) => row.commodityId === commodityId);
                  const short = buying !== undefined && (listing?.stock ?? 0) < buying.units;

                  return (
                    <li key={commodityId} className={short ? 'yard__material--short' : undefined}>
                      <span>{listing?.name ?? commodityId}</span>
                      <span className="data">{units}</span>
                      <span className="micro">
                        {fromHold > 0 && `${fromHold} aboard`}
                        {fromHold > 0 && buying ? ' · ' : ''}
                        {buying &&
                          (short
                            ? `only ${listing?.stock ?? 0} here`
                            : `${buying.units} at ${listing?.ask ?? 0}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {notice !== undefined && <p className="yard__notice">{notice}</p>}

          <div className="yard__actions">
            <button
              type="button"
              className="button"
              disabled={busy || state.placements.length === 0}
              onClick={() => onSave(name, state.placements)}
            >
              Keep the draught
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || !survey.valid || marks < owed || purchase.unavailable}
              // A greyed button with no reason beside it is a dead end. The
              // bill already turns red when it cannot be met; this says by
              // how much, and names the other two reasons it can be refused.
              title={
                !survey.valid
                  ? `${problems.length} to answer before this can be built`
                  : marks < owed
                    ? `${(owed - marks).toLocaleString()} marks short`
                    : purchase.unavailable
                      ? `${berthName} cannot supply all the materials`
                      : refitting
                        ? `Refit the ${flyingName}`
                        : `Build the ${name}`
              }
              onClick={() => onBuild(name, state.placements, refitting)}
            >
              {refitting ? 'Refit' : 'Build'}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * One figure, with what it was before.
 *
 * The delta is the point: a captain is not choosing a number, they are
 * choosing a change, and a panel that shows only the new value makes them
 * hold the old one in their head.
 */
function Reading({
  name,
  value,
  was,
  unit,
  decimals = 0,
}: {
  name: string;
  value: number;
  was: number | undefined;
  unit?: string;
  decimals?: number;
}): React.JSX.Element {
  const delta = was === undefined ? 0 : value - was;
  const shown = Math.abs(delta) >= (decimals > 0 ? 0.005 : 0.5);

  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <span className="data">{value.toFixed(decimals)}</span>
        {unit !== undefined && <span className="micro">{unit}</span>}
        {shown && (
          <span className={`yard__delta${delta > 0 ? ' yard__delta--up' : ' yard__delta--down'}`}>
            {delta > 0 ? '+' : ''}
            {delta.toFixed(decimals)}
          </span>
        )}
      </dd>
    </div>
  );
}
