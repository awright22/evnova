/**
 * The hull on the grid.
 *
 * Drawn as SVG rather than canvas: the editor is a drawing with a few dozen
 * rectangles and some text, it has to stay crisp at any zoom, and every cell
 * needs to be something a pointer can hit without hit-testing it by hand.
 *
 * The module colours are the same ones the flight view paints hulls with, so
 * a draught on the grid and the ship that comes out of it read as the same
 * object.
 */

import { useMemo } from 'react';

import { rotatedFootprint, type ModuleDef, type Placement, type Problem } from '@marque/shared';

export interface GridProps {
  readonly placements: readonly Placement[];
  readonly modules: ReadonlyMap<string, ModuleDef>;
  readonly selection: readonly number[];
  readonly problems: readonly Problem[];
  /** The module about to be placed, drawn under the pointer. */
  readonly ghost: { placement: Placement; def: ModuleDef; valid: boolean } | undefined;
  readonly mirror: boolean;
  onCellDown: (x: number, y: number, index: number | undefined, additive: boolean) => void;
  onCellMove: (x: number, y: number) => void;
  onCellUp: () => void;
}

/**
 * Cells of margin around the hull, so there is somewhere to extend it.
 *
 * Kept tight. Six cells each way meant a starter draught of eight by five
 * drew into a twenty-by-seventeen board and sat as a small patch in the
 * middle of an empty field — the board re-fits as fittings are placed, so the
 * margin only has to be enough to aim at, not enough to finish in.
 */
const MARGIN = 3;

/**
 * The smallest board, in cells.
 *
 * Without it a draught of one fitting would be magnified until a single
 * module filled the screen, which reads as a different interface rather than
 * a zoomed-in one.
 */
const MIN_SPAN = 11;

/** How a module's type reads at a glance. */
const TYPE_FILL: Record<string, string> = {
  bridge: 'var(--amber-dim)',
  hull: 'var(--rule-strong)',
  armour: 'var(--hull)',
  engine: 'var(--amber)',
  thruster: 'var(--amber-dim)',
  reactor: 'var(--caution)',
  shield: 'var(--shield)',
  weapon: 'var(--danger)',
  turret: 'var(--danger-dim)',
  rack: 'var(--danger-dim)',
  cargo: 'var(--rule)',
  tank: 'var(--livery-reprisal)',
};

export function Grid({
  placements,
  modules,
  selection,
  problems,
  ghost,
  mirror,
  onCellDown,
  onCellMove,
  onCellUp,
}: GridProps): React.JSX.Element {
  const selected = useMemo(() => new Set(selection), [selection]);

  // Every placement index a problem points at, and every loose cell one
  // highlights, so the grid can mark the trouble where it is.
  const flagged = useMemo(() => {
    const byIndex = new Set<number>();
    const byCell = new Set<string>();
    for (const problem of problems) {
      for (const index of problem.placements) byIndex.add(index);
      for (const cell of problem.cells ?? []) byCell.add(cell);
    }
    return { byIndex, byCell };
  }, [problems]);

  // The drawing's extent: the hull, the ghost and a margin to build into.
  const bounds = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;

    const consider = (placement: Placement, def: ModuleDef): void => {
      const { width, height } = rotatedFootprint(def, placement.rotation);
      minX = Math.min(minX, placement.x);
      minY = Math.min(minY, placement.y);
      maxX = Math.max(maxX, placement.x + width);
      maxY = Math.max(maxY, placement.y + height);
    };

    for (const placement of placements) {
      const def = modules.get(placement.moduleId);
      if (def) consider(placement, def);
    }
    if (ghost) consider(ghost.placement, ghost.def);

    // Grown about its own centre to the minimum, so a small draught sits in
    // the middle of the board rather than against one corner of it.
    const grow = (low: number, high: number): { start: number; span: number } => {
      const span = Math.max(high - low + MARGIN * 2, MIN_SPAN);
      return { start: low - (span - (high - low)) / 2, span };
    };

    const across = grow(minX, maxX);
    const down = grow(minY, maxY);

    return { minX: across.start, minY: down.start, width: across.span, height: down.span };
  }, [placements, modules, ghost]);

  /**
   * Which cell a pointer event is over, in grid coordinates.
   *
   * Through the element's own screen transform rather than by dividing the
   * viewBox by the bounding box. The board keeps its aspect ratio and is
   * centred in whatever space the column gives it, so whenever the two
   * aspects differ there is a letterbox the simple arithmetic knows nothing
   * about: clicks landed a cell or two off, and further off the wider the
   * window got. `getScreenCTM` accounts for the scale and the centring
   * together, because it is the same transform the browser drew with.
   */
  const cellAt = (event: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const svg = event.currentTarget;
    const screen = svg.getScreenCTM?.();

    if (screen) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(screen.inverse());
      return { x: Math.floor(point.x), y: Math.floor(point.y) };
    }

    // No transform to be had, which happens in a headless DOM. Fall back to
    // the flat mapping, which is right whenever the aspects do match.
    const rect = svg.getBoundingClientRect();
    const scale = bounds.width / rect.width;
    return {
      x: Math.floor((event.clientX - rect.left) * scale + bounds.minX),
      y: Math.floor((event.clientY - rect.top) * scale + bounds.minY),
    };
  };

  /** The topmost module covering a cell, if any. */
  const indexAt = (x: number, y: number): number | undefined => {
    for (let index = placements.length - 1; index >= 0; index--) {
      const placement = placements[index]!;
      const def = modules.get(placement.moduleId);
      if (!def) continue;
      const { width, height } = rotatedFootprint(def, placement.rotation);
      if (x >= placement.x && x < placement.x + width && y >= placement.y && y < placement.y + height) {
        return index;
      }
    }
    return undefined;
  };

  return (
    <svg
      className="grid"
      viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`}
      role="application"
      aria-label="Draught grid"
      onPointerDown={(event) => {
        const { x, y } = cellAt(event);
        onCellDown(x, y, indexAt(x, y), event.shiftKey);
      }}
      onPointerMove={(event) => {
        const { x, y } = cellAt(event);
        onCellMove(x, y);
      }}
      onPointerUp={onCellUp}
      onPointerLeave={onCellUp}
    >
      <defs>
        <pattern id="grid-cells" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="var(--rule-faint)" strokeWidth="0.03" />
        </pattern>
      </defs>

      <rect
        x={bounds.minX}
        y={bounds.minY}
        width={bounds.width}
        height={bounds.height}
        fill="url(#grid-cells)"
      />

      {/* The centre line, which is what mirroring works across. */}
      <line
        x1={0}
        y1={bounds.minY}
        x2={0}
        y2={bounds.minY + bounds.height}
        stroke={mirror ? 'var(--amber-dim)' : 'var(--rule)'}
        strokeWidth="0.05"
        strokeDasharray="0.4 0.3"
      />

      {/* Cells a problem points at but no module occupies: a blocked lane. */}
      {[...flagged.byCell].map((cell) => {
        const [x, y] = cell.split(',').map(Number);
        return (
          <rect
            key={`flag-${cell}`}
            x={x}
            y={y}
            width={1}
            height={1}
            className="grid__blocked"
          />
        );
      })}

      {placements.map((placement, index) => {
        const def = modules.get(placement.moduleId);
        if (!def) return null;
        const { width, height } = rotatedFootprint(def, placement.rotation);

        const classes = ['grid__module'];
        if (selected.has(index)) classes.push('grid__module--selected');
        if (flagged.byIndex.has(index)) classes.push('grid__module--problem');

        return (
          <g key={`${index}-${placement.moduleId}`} className={classes.join(' ')}>
            <rect
              x={placement.x}
              y={placement.y}
              width={width}
              height={height}
              fill={TYPE_FILL[def.type] ?? 'var(--rule)'}
            />
            <title>{def.name}</title>
          </g>
        );
      })}

      {ghost && (
        <rect
          className={`grid__ghost${ghost.valid ? '' : ' grid__ghost--blocked'}`}
          x={ghost.placement.x}
          y={ghost.placement.y}
          width={rotatedFootprint(ghost.def, ghost.placement.rotation).width}
          height={rotatedFootprint(ghost.def, ghost.placement.rotation).height}
        />
      )}
    </svg>
  );
}
