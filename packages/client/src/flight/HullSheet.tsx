/**
 * The hull sheet.
 *
 * Every draught the game ships with, and a handful of awkward grids a captain
 * could lay out in the Loft, pushed through the same texture pipeline the
 * flight view uses and set out side by side at the flight view's own scale.
 * It exists because a renderer cannot be judged from its code: this is what
 * a captain sees, laid out so two renderers can be compared hull by hull.
 *
 * Reached by URL and joins no room:
 *
 *   /?hulls=sheet&zoom=1
 *   /?hulls=sheet&zoom=3&columns=tiles,sculpted
 *
 * `zoom` is the flight camera's zoom, so 1 is what a captain sees with the
 * camera at rest and 3 is the closest it comes. One offscreen renderer draws
 * every hull; each is extracted into its own canvas at the display's density,
 * so the sheet is as sharp as the flight view on the same screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { autoDetectRenderer, Container, Rectangle, Sprite, type Renderer } from 'pixi.js';
import { CELL_METRES, content, type Blueprint, type ModuleDef } from '@marque/shared';

import { PX_PER_UNIT } from './camera.ts';
import { bakeHull } from './hull/bake.ts';
import { hullArtOf, lookOf, sceneLight, type Allegiance, type HullArt } from './hull/hullArt.ts';
import { createLitHull } from './hull/litHull.ts';
import { LOFT_TESTS } from './hullSheetTests.ts';
import { palette } from './palette.ts';
import { renderShipArt, TEXTURE_PX_PER_UNIT } from './shipTexture.ts';
import './hullSheet.css';

/** A way of drawing a hull, and the turn it is drawn at. */
interface Column {
  readonly key: string;
  readonly label: string;
  /** Radians. The flight view turns a hull; a renderer has to survive it. */
  readonly turn: number;
  readonly draw: (renderer: Renderer, blueprint: Blueprint, modules: ReadonlyMap<string, ModuleDef>) => Container;
}

/** Turned far enough that a grid drawn as tiles shows it, as a hull in flight does. */
const TURNED = (-35 * Math.PI) / 180;

function tiles(turn: number, label: string, key: string): Column {
  return {
    key,
    label,
    turn,
    draw: (renderer, blueprint, modules) => {
      const art = renderShipArt(renderer, blueprint, modules);
      const sprite = new Sprite(art.texture);
      sprite.anchor.set(art.anchorX, art.anchorY);
      sprite.scale.set(PX_PER_UNIT / TEXTURE_PX_PER_UNIT);
      sprite.rotation = turn;
      const holder = new Container();
      holder.addChild(sprite);
      return holder;
    },
  };
}

/**
 * One bake per hull, however many columns draw it: a bake is the expensive
 * part, and every sculpted column draws the same material differently lit
 * and differently dressed.
 */
const baked = new Map<string, HullArt>();
function artFor(blueprint: Blueprint, modules: ReadonlyMap<string, ModuleDef>): HullArt {
  let art = baked.get(blueprint.id);
  if (!art) {
    art = hullArtOf(bakeHull(blueprint, modules), blueprint, modules);
    baked.set(blueprint.id, art);
  }
  return art;
}

/** Up and to the left of the sheet, the way a picture is lit. Radians, from hull to star. */
const STAR_FORE_PORT = (-135 * Math.PI) / 180;
/** Astern and to starboard: the side a captain usually sees in a chase. */
const STAR_AFT = (160 * Math.PI) / 180;

function sculpted(
  key: string,
  label: string,
  turn: number,
  star: number,
  dress: (blueprint: Blueprint) => Allegiance,
): Column {
  return {
    key,
    label,
    turn,
    draw: (_renderer, blueprint, modules) => {
      const art = artFor(blueprint, modules);
      const p = palette();
      const hull = createLitHull(art.material, art.anchor, sceneLight(0xfff1dc, p.nebulaHomeRoads));
      hull.light(star, turn);
      hull.look(lookOf(dress(blueprint), p));
      hull.mesh.scale.set(PX_PER_UNIT / art.texturePxPerUnit);
      hull.mesh.rotation = turn;
      const holder = new Container();
      holder.addChild(hull.mesh);
      return holder;
    },
  };
}

const captain = (blueprint: Blueprint): Allegiance => ({ kind: 'captain', paint: blueprint.paint });

const COLUMNS: Readonly<Record<string, Column>> = {
  tiles: tiles(0, 'Tiles', 'tiles'),
  'tiles-turned': tiles(TURNED, 'Tiles, turned', 'tiles-turned'),
  sculpted: sculpted('sculpted', 'Captain', 0, STAR_FORE_PORT, captain),
  'sculpted-turned': sculpted('sculpted-turned', 'Captain, turned', TURNED, STAR_FORE_PORT, captain),
  'sculpted-aft': sculpted('sculpted-aft', 'Star astern', 0, STAR_AFT, captain),
  company: sculpted('company', 'Company', 0, STAR_FORE_PORT, () => ({ kind: 'company', charter: 'thirty' })),
  court: sculpted('court', 'Prize Court', 0, STAR_FORE_PORT, () => ({ kind: 'court' })),
  unlettered: sculpted('unlettered', 'Unlettered', 0, STAR_FORE_PORT, () => ({ kind: 'unlettered' })),
};

const DEFAULT_COLUMNS = ['tiles', 'tiles-turned'];

/** Room around each hull in its cell, in CSS pixels. */
const PAD = 18;

interface RowData {
  readonly blueprint: Blueprint;
  readonly canvases: readonly HTMLCanvasElement[];
}

export function HullSheet(): React.JSX.Element {
  const { zoom, wanted } = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      zoom: Math.max(0.5, Math.min(4, Number(params.get('zoom') ?? '1') || 1)),
      wanted: (params.get('columns') ?? DEFAULT_COLUMNS.join(','))
        .split(',')
        .map((key) => COLUMNS[key.trim()])
        .filter((column): column is Column => column !== undefined),
    };
  }, []);

  const [rows, setRows] = useState<readonly RowData[]>([]);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const built = useRef(false);

  useEffect(() => {
    if (built.current) return;
    built.current = true;

    let renderer: Renderer | undefined;
    void (async () => {
      try {
        const { blueprints, modules } = content();
        const hulls: Blueprint[] = [...blueprints.values(), ...LOFT_TESTS];
        const density = window.devicePixelRatio || 1;

        renderer = await autoDetectRenderer({
          preference: 'webgl',
          antialias: false,
          backgroundAlpha: 0,
          width: 16,
          height: 16,
        });

        // Every cell in a column is the same size, so a hull's length reads
        // against its neighbours' and two columns line up row for row.
        const drawn = hulls.map((blueprint) =>
          wanted.map((column) => {
            const view = column.draw(renderer!, blueprint, modules);
            view.scale.set(zoom);
            const bounds = view.getLocalBounds();
            return { view, bounds };
          }),
        );

        const width =
          Math.ceil(
            Math.max(...drawn.flat().map(({ bounds }) => bounds.width * zoom)),
          ) +
          PAD * 2;

        const laidOut: RowData[] = drawn.map((variants, index) => {
          const height =
            Math.ceil(Math.max(...variants.map(({ bounds }) => bounds.height * zoom))) + PAD * 2;
          const canvases = variants.map(({ view, bounds }) => {
            // Centre the hull's drawn extent in the cell, wherever its
            // anchor — the centre of mass — happens to sit.
            const stage = new Container();
            stage.addChild(view);
            view.position.set(
              width / 2 - (bounds.x + bounds.width / 2) * zoom,
              height / 2 - (bounds.y + bounds.height / 2) * zoom,
            );
            const canvas = renderer!.extract.canvas({
              target: stage,
              frame: new Rectangle(0, 0, width, height),
              resolution: density,
              clearColor: palette().void,
            }) as HTMLCanvasElement;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            stage.destroy({ children: true });
            return canvas;
          });
          return { blueprint: hulls[index]!, canvases };
        });

        setRows(laidOut);
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        renderer?.destroy();
      }
    })();
  }, [wanted, zoom]);

  const cellPx = CELL_METRES * PX_PER_UNIT * zoom;

  return (
    <div
      className="hull-sheet"
      data-ready={rows.length > 0 || failure !== undefined ? 'true' : 'false'}
    >
      <header className="hull-sheet__header">
        <h1>Hull sheet</h1>
        <p className="micro">
          Flight camera zoom {zoom}× · one cell is {cellPx.toFixed(0)}px · every hull through the
          renderer the flight view uses
        </p>
      </header>
      {failure !== undefined && <p className="hull-sheet__failure">{failure}</p>}
      <div
        className="hull-sheet__grid"
        style={{ gridTemplateColumns: `minmax(12rem, auto) repeat(${wanted.length}, auto)` }}
      >
        <span />
        {wanted.map((column) => (
          <span key={column.key} className="hull-sheet__column label">
            {column.label}
          </span>
        ))}
        {rows.map((row) => (
          <SheetRow key={row.blueprint.id} row={row} />
        ))}
      </div>
    </div>
  );
}

function SheetRow({ row }: { row: RowData }): React.JSX.Element {
  const holder = useRef<HTMLDivElement[]>([]);
  useEffect(() => {
    row.canvases.forEach((canvas, index) => {
      const cell = holder.current[index];
      if (cell && canvas.parentElement !== cell) cell.replaceChildren(canvas);
    });
  }, [row]);

  return (
    <>
      <div className="hull-sheet__name">
        <span className="hull-sheet__title">{row.blueprint.name}</span>
        <span className="micro">{row.blueprint.id}</span>
      </div>
      {row.canvases.map((_, index) => (
        <div
          key={index}
          className="hull-sheet__cell"
          ref={(node) => {
            if (node) holder.current[index] = node;
          }}
        />
      ))}
    </>
  );
}
