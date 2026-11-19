/**
 * Procedural ship rendering.
 *
 * One system draws every module tile in one style, so any design a captain
 * builds looks intentional: a dark outline, interior panel lines on a fixed
 * grid, a lit top-left edge and shaded bottom-right, and a per-type detail
 * pass — lit windows on a bridge, a glowing nozzle on an engine, banding on a
 * tank.
 *
 * Each blueprint renders once into a texture. Damage draws as overlays on top
 * rather than re-rendering the hull.
 */

import { Container, Graphics, RenderTexture, type Renderer, type Texture } from 'pixi.js';
import {
  CELL_METRES,
  boundsOf,
  centreOfMass,
  placeAll,
  type Blueprint,
  type ModuleDef,
  type PlacedModule,
} from '@marque/shared';

import { darken, lighten, mix, palette, parseHex, tintBy } from './palette.ts';

/** Texture pixels per grid cell. Drawn large and scaled down, so edges stay crisp. */
export const PX_PER_CELL = 24;

/** Texture pixels per world unit. */
export const TEXTURE_PX_PER_UNIT = PX_PER_CELL / CELL_METRES;

/** Panel lines sit on this grid, in texture pixels. */
const PANEL_GRID = 8;

/** Margin around the hull so glows and nozzles are not clipped. */
const MARGIN = PX_PER_CELL;

/** Where an engine's exhaust leaves the hull, in world units from the centre of mass. */
export interface Nozzle {
  readonly x: number;
  readonly y: number;
  /** Half-height of the nozzle mouth, in world units. */
  readonly halfWidth: number;
}

export interface ShipArt {
  readonly texture: Texture;
  /**
   * Where the centre of mass sits in the texture, normalised 0..1. The sprite
   * anchors here, because the simulation's position is the centre of mass and
   * the hull rotates about it.
   */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Hull extent in world units, for the radar and for camera framing. */
  readonly lengthUnits: number;
  readonly widthUnits: number;
  /** One per engine, so a two-engine hull shows two plumes. */
  readonly nozzles: readonly Nozzle[];
  /**
   * Each module's rectangle in world units from the centre of mass, so damage
   * overlays can be drawn on the module that actually took the hit without
   * re-rendering the hull.
   */
  readonly moduleRects: readonly ModuleRect[];
}

/** A module's footprint in world units, relative to the centre of mass. */
export interface ModuleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ShipArtOptions {
  /** The system star's tint, applied as scene lighting. */
  readonly lightTint?: number;
  /** Direction the star lies in, in radians, for the lit rim. */
  readonly lightAngle?: number;
}

/**
 * Render a blueprint to a texture.
 *
 * Call once per design, not per ship: the result is shared by every hull flying
 * that draught.
 */
export function renderShipArt(
  renderer: Renderer,
  blueprint: Blueprint,
  catalogue: ReadonlyMap<string, ModuleDef>,
  options: ShipArtOptions = {},
): ShipArt {
  const modules = placeAll(blueprint.placements, catalogue);
  const bounds = boundsOf(modules);
  const com = centreOfMass(modules);

  const width = bounds.width * PX_PER_CELL + MARGIN * 2;
  const height = bounds.height * PX_PER_CELL + MARGIN * 2;

  const [primaryHex, secondaryHex] = blueprint.paint;
  const primary = parseHex(primaryHex) ?? 0x8d98a9;
  const secondary = parseHex(secondaryHex) ?? 0x5c6777;
  // The renderer derives the third shade: panel lines are the paint, darkened.
  const panelLine = darken(primary, 0.45);

  const lightTint = options.lightTint;
  const paint = lightTint === undefined ? primary : tintBy(primary, lightTint, 0.3);
  const accent = lightTint === undefined ? secondary : tintBy(secondary, lightTint, 0.3);

  const container = new Container();

  // Draw in two passes so every outline sits above every fill: a hull reads as
  // one machine rather than a pile of separate tiles.
  const fills = new Graphics();
  const details = new Graphics();
  container.addChild(fills, details);

  for (const module of modules) {
    const x = (module.placement.x - bounds.minX) * PX_PER_CELL + MARGIN;
    const y = (module.placement.y - bounds.minY) * PX_PER_CELL + MARGIN;
    const w = module.width * PX_PER_CELL;
    const h = module.height * PX_PER_CELL;

    drawModuleBody(fills, x, y, w, h, module, paint, accent, panelLine);
    drawModuleDetail(details, x, y, w, h, module, paint, accent);
  }

  const texture = RenderTexture.create({
    width,
    height,
    antialias: true,
    resolution: 1,
  });
  renderer.render({ container, target: texture });
  container.destroy({ children: true });

  // Exhaust leaves the aft face of each engine, measured from the centre of
  // mass because that is what the sprite is anchored to and what the hull
  // rotates about.
  const nozzles: Nozzle[] = modules
    .filter((module) => module.def.type === 'engine')
    .map((module) => ({
      x: (module.placement.x - com.x) * CELL_METRES,
      y: (module.centreY - com.y) * CELL_METRES,
      halfWidth: (module.height * CELL_METRES) / 2.6,
    }));

  const moduleRects: ModuleRect[] = modules.map((module) => ({
    x: (module.placement.x - com.x) * CELL_METRES,
    y: (module.placement.y - com.y) * CELL_METRES,
    width: module.width * CELL_METRES,
    height: module.height * CELL_METRES,
  }));

  return {
    texture,
    moduleRects,
    anchorX: ((com.x - bounds.minX) * PX_PER_CELL + MARGIN) / width,
    anchorY: ((com.y - bounds.minY) * PX_PER_CELL + MARGIN) / height,
    lengthUnits: bounds.width * CELL_METRES,
    widthUnits: bounds.height * CELL_METRES,
    nozzles,
  };
}

/** Base plate, panel lines and edge shading, identical for every module type. */
function drawModuleBody(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  module: PlacedModule,
  paint: number,
  accent: number,
  panelLine: number,
): void {
  const type = module.def.type;

  // Structural parts take the primary paint; fittings take the accent, so the
  // hull reads as a frame with equipment mounted on it.
  const structural = type === 'hull' || type === 'armour' || type === 'bridge';
  const base = structural ? paint : mix(paint, accent, 0.65);
  const plate = type === 'armour' ? darken(base, 0.12) : base;

  g.rect(x, y, w, h).fill({ color: plate });

  // Panel lines on a fixed grid, so a two-cell module and a six-cell one look
  // like the same shipyard built them.
  for (let px = x + PANEL_GRID; px < x + w; px += PANEL_GRID) {
    g.moveTo(px, y + 1).lineTo(px, y + h - 1);
  }
  for (let py = y + PANEL_GRID; py < y + h; py += PANEL_GRID) {
    g.moveTo(x + 1, py).lineTo(x + w - 1, py);
  }
  g.stroke({ width: 1, color: panelLine, alpha: 0.5 });

  // Lit top-left edge, shaded bottom-right: one light direction for the whole
  // hull, so the shape is readable at a glance.
  g.moveTo(x, y + h).lineTo(x, y).lineTo(x + w, y);
  g.stroke({ width: 1, color: lighten(plate, 0.28), alpha: 0.9 });

  g.moveTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h);
  g.stroke({ width: 1, color: darken(plate, 0.4), alpha: 0.9 });

  // The outline that makes the silhouette read against space.
  g.rect(x, y, w, h).stroke({ width: 2, color: darken(plate, 0.62), alignment: 1 });
}

/** The per-type pass: what makes a bridge look like a bridge. */
function drawModuleDetail(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  module: PlacedModule,
  paint: number,
  accent: number,
): void {
  const p = palette();

  switch (module.def.type) {
    case 'bridge': {
      // Lit windows, facing forward, which is +x.
      const glass = mix(p.amberBright, 0xffffff, 0.35);
      const inset = 5;
      const paneH = Math.max(3, (h - inset * 2 - 4) / 2);
      for (let i = 0; i < 2; i++) {
        g.rect(x + w - inset - 6, y + inset + i * (paneH + 4), 6, paneH).fill({
          color: glass,
          alpha: 0.9,
        });
      }
      g.rect(x + w - inset - 7, y + inset - 1, 8, h - inset * 2 + 2).stroke({
        width: 1,
        color: darken(p.amberDim, 0.3),
        alpha: 0.8,
      });
      break;
    }

    case 'engine': {
      // Nozzle on the aft face, which is -x, with a hot throat.
      const nozzleW = 7;
      const inset = 4;
      g.rect(x + 1, y + inset, nozzleW, h - inset * 2).fill({ color: darken(paint, 0.72) });
      g.rect(x + 1, y + inset + 2, 3, h - inset * 2 - 4).fill({
        color: p.amberBright,
        alpha: 0.85,
      });
      g.rect(x + 1, y + inset, nozzleW, h - inset * 2).stroke({
        width: 1,
        color: darken(paint, 0.5),
      });
      break;
    }

    case 'thruster': {
      // A small outboard jet. Square, like everything else.
      const inset = 6;
      g.rect(x + inset, y + inset, w - inset * 2, h - inset * 2).fill({
        color: darken(paint, 0.6),
      });
      g.rect(x + inset + 2, y + inset + 2, w - inset * 2 - 4, h - inset * 2 - 4).fill({
        color: p.amberDim,
        alpha: 0.7,
      });
      break;
    }

    case 'reactor': {
      // A containment ring with a core that reads as lit.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = Math.min(w, h) / 2 - 5;
      g.circle(cx, cy, r).stroke({ width: 2, color: darken(accent, 0.45) });
      g.circle(cx, cy, r * 0.5).fill({ color: p.amber, alpha: 0.55 });
      g.circle(cx, cy, r * 0.5).stroke({ width: 1, color: p.amberBright, alpha: 0.8 });
      break;
    }

    case 'cargo': {
      // Hatch seams and a corner stencil: it is a bonded container.
      const inset = 5;
      g.rect(x + inset, y + inset, w - inset * 2, h - inset * 2).stroke({
        width: 1,
        color: darken(accent, 0.3),
        alpha: 0.9,
      });
      g.moveTo(x + w / 2, y + inset).lineTo(x + w / 2, y + h - inset);
      g.stroke({ width: 2, color: darken(accent, 0.5), alpha: 0.9 });
      g.rect(x + inset + 2, y + inset + 2, 4, 4).fill({ color: accent, alpha: 0.8 });
      break;
    }

    case 'tank': {
      // Banding across the short axis, like a pressure vessel.
      const along = w >= h;
      const bands = 3;
      for (let i = 1; i <= bands; i++) {
        const t = i / (bands + 1);
        if (along) {
          g.moveTo(x + w * t, y + 3).lineTo(x + w * t, y + h - 3);
        } else {
          g.moveTo(x + 3, y + h * t).lineTo(x + w - 3, y + h * t);
        }
      }
      g.stroke({ width: 2, color: darken(accent, 0.42), alpha: 0.85 });
      break;
    }

    case 'armour': {
      // A chamfered plate, so plating reads as deliberately heavier.
      const c = 6;
      g.moveTo(x + c, y + 2)
        .lineTo(x + w - 2, y + 2)
        .lineTo(x + w - 2, y + h - c)
        .lineTo(x + w - c, y + h - 2)
        .lineTo(x + 2, y + h - 2)
        .lineTo(x + 2, y + c)
        .closePath();
      g.stroke({ width: 2, color: lighten(paint, 0.12), alpha: 0.55 });
      break;
    }

    case 'shield': {
      // Emitter: a broken ring, so it does not read as a reactor.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = Math.min(w, h) / 2 - 6;
      for (let i = 0; i < 4; i++) {
        const a0 = (i * Math.PI) / 2 + 0.25;
        const a1 = a0 + Math.PI / 2 - 0.5;
        // Move to the arc's start: `arc` otherwise joins it to the previous
        // sub-path with a chord.
        g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r).arc(cx, cy, r, a0, a1);
      }
      g.stroke({ width: 2, color: p.shield, alpha: 0.75 });
      break;
    }

    case 'hull':
      // Deliberately plain: hull sections are the quiet space between fittings.
      break;

    default:
      break;
  }
}
