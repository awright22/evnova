/**
 * A draught's art, ready to fly.
 *
 * The bake (`bake.ts`) knows a hull in grid cells and texture pixels; the
 * flight scene knows world units measured from the centre of mass, because
 * that is the point the simulation moves and turns. This joins them: the
 * baked material on the GPU, the centre of mass in texture pixels for the
 * mesh to turn about, and the nozzles and module rectangles in world units
 * for the plume, the damage marks and the grid overlay.
 *
 * It also decides how a hull is dressed — whose livery, whose seal — from who
 * is flying it, which the bake cannot know and the scene should not have to.
 */

import { CanvasSource, Texture } from 'pixi.js';
import {
  CELL_METRES,
  boundsOf,
  centreOfMass,
  placeAll,
  sealGeometry,
  sealOf,
  type Blueprint,
  type ModuleDef,
  type PortOwner,
  type SystemDef,
} from '@marque/shared';

import { darken, mix, nebulaFor, palette, parseHex, rgb, type Palette } from '../palette.ts';
import type { HullBake } from './bake.ts';
import { uploadHull, type HullLook, type HullMaterial, type SceneLight } from './litHull.ts';

/** Where an engine's exhaust leaves the hull, in world units from the centre of mass. */
export interface Nozzle {
  readonly x: number;
  readonly y: number;
  /** Half the mouth's width, in world units. */
  readonly halfWidth: number;
}

/** A module's footprint in world units, relative to the centre of mass. */
export interface ModuleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HullArt {
  readonly material: HullMaterial;
  /** The centre of mass in texture pixels: the point the mesh turns about. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** Texture pixels per world unit. */
  readonly texturePxPerUnit: number;
  /** The grid's extent in world units, for the radar, the brackets and the shield. */
  readonly lengthUnits: number;
  readonly widthUnits: number;
  /** One per bell, so a twin-nozzle nacelle shows two plumes. */
  readonly nozzles: readonly Nozzle[];
  /** In placement order, the order the wire's module hit points come in. */
  readonly moduleRects: readonly ModuleRect[];
}

/**
 * Put a bake on the GPU and measure it against the simulation.
 *
 * The centre of mass is the simulation's, from the same derivation the
 * server uses, so the drawn hull turns about exactly the point the hitbox
 * does.
 */
export function hullArtOf(
  bake: HullBake,
  blueprint: Blueprint,
  catalogue: ReadonlyMap<string, ModuleDef>,
): HullArt {
  const modules = placeAll(blueprint.placements, catalogue);
  const bounds = boundsOf(modules);
  const com = centreOfMass(modules);
  const P = bake.pxPerCell;

  return {
    material: uploadHull(bake),
    anchor: { x: bake.originX + com.x * P, y: bake.originY + com.y * P },
    texturePxPerUnit: P / CELL_METRES,
    lengthUnits: bounds.width * CELL_METRES,
    widthUnits: bounds.height * CELL_METRES,
    nozzles: bake.nozzles.map((nozzle) => ({
      x: (nozzle.x - com.x) * CELL_METRES,
      y: (nozzle.y - com.y) * CELL_METRES,
      halfWidth: nozzle.halfWidth * CELL_METRES,
    })),
    moduleRects: modules.map((module) => ({
      x: (module.placement.x - com.x) * CELL_METRES,
      y: (module.placement.y - com.y) * CELL_METRES,
      width: module.width * CELL_METRES,
      height: module.height * CELL_METRES,
    })),
  };
}

// --- Light --------------------------------------------------------------------

const unit = (colour: number): [number, number, number] => {
  const [r, g, b] = rgb(colour);
  return [r / 255, g / 255, b / 255];
};

/**
 * The light a system's star gives its hulls.
 *
 * The sun is the star's own light tint, raised so its brightest channel is
 * full: a red dwarf's hulls are lit red, not lit dimly. The fill in shadow is
 * a little of the region's nebula over a dark neutral, and the cool rim that
 * parts a hull's far side from the void is that nebula's hue.
 */
export function sceneLightOf(system: SystemDef, p: Palette = palette()): SceneLight {
  return sceneLight(parseHex(system.star.lightTint) ?? 0xffffff, nebulaFor(system.region, p));
}

/** The same, from a star's tint and a nebula's hue. */
export function sceneLight(starTint: number, nebulaHue: number): SceneLight {
  const tint = unit(starTint);
  const peak = Math.max(...tint, 1e-3);
  const sun = tint.map((channel) => channel / peak) as [number, number, number];
  const nebula = unit(nebulaHue);
  const ambient = nebula.map((channel) => 0.1 + channel * 0.1) as [number, number, number];
  const rim = nebula.map((channel) => 0.15 + channel * 0.6) as [number, number, number];
  return { sun, ambient, rim };
}

// --- Dress ----------------------------------------------------------------------

/** Who is flying a hull, as far as its paint is concerned. */
export type Allegiance =
  | { readonly kind: 'captain'; readonly paint: readonly string[] }
  | { readonly kind: 'company'; readonly charter: 'kessler' | 'thirty' | 'reprisal' }
  | { readonly kind: 'court' }
  | { readonly kind: 'unlettered' }
  /** A freighter in a system no charter holds a berth in: the registry's plain dress. */
  | { readonly kind: 'registry' };

/** Gunmetal: the plating the Unlettered fly, a shade darker and colder than the yards'. */
const GUNMETAL: readonly [number, number, number] = [0.62, 0.66, 0.72];
const BARE: readonly [number, number, number] = [1, 1, 1];

function charterColour(charter: 'kessler' | 'thirty' | 'reprisal', p: Palette): number {
  switch (charter) {
    case 'kessler':
      return p.liveryKessler;
    case 'thirty':
      return p.liveryThirty;
    case 'reprisal':
      return p.liveryReprisal;
  }
}

/**
 * How a hull is dressed.
 *
 * Spec section 4's paint rule: neutral metal, with livery as bands, stripes
 * and the seal. A captain flies their two paint colours and no seal — a
 * captain is not an institution. A company freighter flies its charter's
 * livery and seal; a Prize Court patrol, the Court's seal on registry white.
 * The Unlettered fly no markings at all, on darker gunmetal.
 */
export function lookOf(allegiance: Allegiance, p: Palette = palette()): HullLook {
  switch (allegiance.kind) {
    case 'captain': {
      const primary = parseHex(allegiance.paint[0] ?? '') ?? p.hull;
      const secondary = parseHex(allegiance.paint[1] ?? '') ?? darken(primary, 0.45);
      return { livery: [unit(primary), unit(secondary)], marked: true, metal: BARE, seal: undefined };
    }
    case 'company': {
      const primary = charterColour(allegiance.charter, p);
      return {
        livery: [unit(primary), unit(darken(primary, 0.5))],
        marked: true,
        metal: BARE,
        seal: { texture: sealTexture(allegiance.charter), ink: unit(primary) },
      };
    }
    case 'court':
      return {
        livery: [unit(mix(p.textPrimary, p.liveryKessler, 0.35)), unit(p.ruleStrong)],
        marked: true,
        metal: BARE,
        seal: { texture: sealTexture('prize-court'), ink: unit(p.rule) },
      };
    case 'unlettered':
      return { livery: [unit(p.liveryUnlettered), unit(p.liveryUnlettered)], marked: false, metal: GUNMETAL, seal: undefined };
    case 'registry':
      return { livery: [unit(p.hull), unit(p.textSecondary)], marked: true, metal: BARE, seal: undefined };
  }
}

const CHARTERS = new Set<PortOwner>(['kessler', 'thirty', 'reprisal']);

/**
 * Whose freighter this is: one of the charters holding a berth in the
 * system, chosen by the hull's id so a contested system's traffic is mixed
 * and the same freighter always flies the same colours.
 */
export function freighterAllegiance(system: SystemDef, hullId: string): Allegiance {
  const charters = [...new Set(system.ports.map((port) => port.owner).filter((owner) => CHARTERS.has(owner)))]
    .sort() as ('kessler' | 'thirty' | 'reprisal')[];
  if (charters.length === 0) return { kind: 'registry' };
  let h = 0x811c9dc5;
  for (let i = 0; i < hullId.length; i++) h = Math.imul(h ^ hullId.charCodeAt(i), 0x01000193);
  return { kind: 'company', charter: charters[(h >>> 0) % charters.length]! };
}

// --- Seals ------------------------------------------------------------------------

/** Pixels across a seal decal's texture. Mipmapped down to the few it shows at. */
const SEAL_TEXTURE_PX = 128;

const seals = new Map<string, Texture>();

/**
 * An issuer's seal as a decal: the shared geometry, struck in white on clear
 * so the shader can ink it in any colour.
 *
 * At hull size a seal is a few pixels across, so the device is filled where
 * it closes and every line is heavy: a struck mark, not a drawing of one.
 */
export function sealTexture(issuer: string): Texture {
  const cached = seals.get(issuer);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = SEAL_TEXTURE_PX;
  canvas.height = SEAL_TEXTURE_PX;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D context to strike a seal with');

  const half = SEAL_TEXTURE_PX / 2;
  const rim = half * 0.88;
  const geometry = sealGeometry(sealOf(issuer));
  context.strokeStyle = '#fff';
  context.fillStyle = '#fff';
  context.lineJoin = 'miter';
  context.lineCap = 'butt';

  context.lineWidth = half * 0.12;
  context.beginPath();
  context.arc(half, half, rim, 0, Math.PI * 2);
  context.stroke();

  context.lineWidth = half * 0.07;
  for (const ring of geometry.rings) {
    context.beginPath();
    context.arc(half, half, ring * rim, 0, Math.PI * 2);
    context.stroke();
  }
  context.lineWidth = half * 0.08;
  for (const tick of geometry.ticks) {
    context.beginPath();
    context.moveTo(half + Math.cos(tick.angle) * tick.from * rim, half + Math.sin(tick.angle) * tick.from * rim);
    context.lineTo(half + Math.cos(tick.angle) * tick.to * rim, half + Math.sin(tick.angle) * tick.to * rim);
    context.stroke();
  }
  context.lineWidth = half * 0.1;
  for (const path of geometry.paths) {
    context.beginPath();
    path.points.forEach((point, index) => {
      const x = half + point.x * rim;
      const y = half + point.y * rim;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    if (path.closed) {
      context.closePath();
      context.fill();
    } else {
      context.stroke();
    }
  }

  const texture = new Texture({
    source: new CanvasSource({ resource: canvas, autoGenerateMipmaps: true, scaleMode: 'linear' }),
  });
  seals.set(issuer, texture);
  return texture;
}
