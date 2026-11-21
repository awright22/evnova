/**
 * A blueprint, baked into a hull.
 *
 * The grid is the ship's mechanics, not its look (spec section 4). This turns
 * a blueprint into the material of a sculpted hull seen from above — colour,
 * height and normal, occlusion, and which pixels are metal, paint and glow —
 * once per draught. It does not light anything: the light comes from the
 * system's star, wherever the star is relative to the hull and whichever way
 * the hull is turned, so it is applied as the hull is drawn (`litHull.ts`).
 *
 * The steps, in order:
 *
 *   1. Skin. The occupancy becomes polygons: each cell's square with its
 *      exposed corners chamfered (more steeply at the bow), a fairing in every
 *      inner corner, a pod on a neck for a single cell standing out on its
 *      own, and the drawn shape of a wedge, nose or fin. They are rasterised
 *      into a mask, the mask into an exact distance field, and the field is
 *      smoothed. The outline is that field's zero level, never a cell edge.
 *   2. Depth. Height rises from the edge in a bevel, then up a gentle slope
 *      to a deck, so a narrow hull grows a spine. Plates are bands of the
 *      distance field broken at intervals along the outline, so their seams
 *      follow the hull's contours.
 *   3. Fittings by role: nacelles and bell nozzles, barrels and turret
 *      housings, launcher boxes, emitters, container bulges, a canopy with
 *      lit glazing. Internals are only hinted at: vents, hatches, conduits.
 *   4. Paint: neutral metal, plate by plate a shade apart; livery bands and a
 *      contour stripe sized to about a fifth of the hull; a registry stencil;
 *      a spot reserved for the seal.
 *   5. Normals from the height, occlusion from where the height dips below
 *      its surroundings, and the colour bled outward so the edges survive
 *      mipmapping.
 *
 * Pure: no DOM, no renderer, deterministic in the blueprint. That is what
 * lets it be tested, and what would let it run off the main thread.
 */

import { boundsOf, placeAll, type Blueprint, type ModuleDef, type PlacedModule } from '@marque/shared';

import { blur, nearestSite } from './distance.ts';
import { traceOutline } from './outline.ts';
import { shapeOutline, type Point } from './shapes.ts';
import { STENCIL_ROWS, stencilDots } from './stencil.ts';

/** Texture pixels per grid cell. Sharp at the flight camera's closest zoom. */
export const BAKE_PX_PER_CELL = 64;

/** Room round the grid for nozzles, barrels and fins that stand proud of it. */
const MARGIN_CELLS = 1.1;

/** The height the height channel spans, in cells: a domed hull with a turret on it. */
const HEIGHT_RANGE_CELLS = 1.5;

/** Livery as a share of the hull's surface: about a fifth, never a flood. */
export const LIVERY_SHARE = 0.2;

// --- Shape -------------------------------------------------------------------

/** Chamfer on an exposed corner, in cells: deeper forward, so the bow tapers. */
const CHAMFER_FORE = 0.42;
const CHAMFER_AFT = 0.32;
/** An engine's aft corners carry its nozzle, so they are barely cut. */
const CHAMFER_ENGINE_AFT = 0.1;
/**
 * A fairing in an inner corner, in cells along each leg. Half a cell, so that
 * on a staircase it meets the half-cell chamfer on the next corner out and the
 * steps become one straight raked line.
 */
const FAIRING = 0.5;
/** A corner that is one step of a staircase is cut to meet the fairings either side of it. */
const CHAMFER_STEP = 0.5;
/** Smoothing of the distance field, in cells: a pressed edge, not a pixel one. */
const SKIN_SMOOTH = 0.035;
/** The prow's rake: how fast its faces open out going aft, per unit forward. */
const PROW_RAKE = 0.62;
/** The narrowest a prow's tip is drawn, in cells either side of the keel. */
const PROW_TIP = 0.3;
/** The furthest the rake cuts into the bow's corners, in cells. */
const PROW_BITE = 0.9;
/** The most of any one cell the prow's rake may take away. */
const PROW_MAX_CLIP = 0.45;
/** A soft dome over the deck toward the keel, in cells. */
const CROWN_HEIGHT = 0.3;

// --- Depth -------------------------------------------------------------------

/**
 * The hull's section, from the edge inward, in cells: a steep rounded chine,
 * a raked side, then the deck. A hard-surface section rather than a pillow:
 * the facets take the light differently, so which side faces the star shows,
 * and the creases between them catch it.
 */
const CHINE_WIDTH = 0.12;
const CHINE_HEIGHT = 0.12;
const SIDE_WIDTH = 0.62;
const SIDE_RISE = 0.24;
/** Where the chine's wear shows, in cells from the edge. */
const BEVEL_WIDTH = CHINE_WIDTH + 0.1;
/** Distance-field levels where one band of plating ends and the next begins, in cells. */
const PLATE_BANDS = [CHINE_WIDTH, CHINE_WIDTH + SIDE_WIDTH];
/** Plate length along the outline on the raked side, in cells. Never a whole cell. */
const PLATE_LENGTHS = [0, 1.2];
const SEAM_DEPTH = 0.035;

/** Cargo lanes to a cell of bay breadth: never one, so lanes never sit on the rows. */
const LANES_PER_CELL = 1.45;
/** Clearance round a bay's containers, and between them, in cells. */
const CARGO_INSET = 0.1;
const CONTAINER_GAP = 0.06;
/** A container's height above the deck, in cells; a stacked one is twice that. */
const CONTAINER_HEIGHT = 0.11;

// --- Colour (sRGB, 0..1) -------------------------------------------------------

type Rgb = readonly [number, number, number];

const METAL: Rgb = [0.5, 0.53, 0.57];
const DARK_METAL: Rgb = [0.34, 0.36, 0.4];
const GUNMETAL: Rgb = [0.4, 0.43, 0.47];
const NOZZLE: Rgb = [0.22, 0.24, 0.27];
const NACELLE: Rgb = [0.42, 0.44, 0.48];
const NOZZLE_RIM: Rgb = [0.56, 0.58, 0.61];
const GLASS: Rgb = [0.09, 0.12, 0.17];
const CONTAINER: Rgb = [0.56, 0.54, 0.48];
const WINDOW_GLOW: Rgb = [1, 0.86, 0.62];
const THROAT_GLOW: Rgb = [1, 0.76, 0.42];
const VENT_GLOW: Rgb = [1, 0.58, 0.28];
const SHIELD_GLOW: Rgb = [0.55, 0.78, 1];
const LENS_GLOW: Rgb = [0.72, 0.9, 1];
const CUTTER_GLOW: Rgb = [1, 0.7, 0.36];

// --- Output ------------------------------------------------------------------

export interface HullNozzle {
  /** Mouth centre, in grid cells. */
  readonly x: number;
  readonly y: number;
  /** Half the mouth's width, in cells. */
  readonly halfWidth: number;
}

export interface HullBake {
  readonly width: number;
  readonly height: number;
  readonly pxPerCell: number;
  /** Texture pixel at grid coordinate (0, 0). */
  readonly originX: number;
  readonly originY: number;
  /** RGB colour and coverage, not premultiplied. */
  readonly base: Uint8ClampedArray;
  /** Normal x and y (as 0.5 + n / 2), height, and occlusion. */
  readonly shape: Uint8ClampedArray;
  /** Shine, glow, primary livery weight, secondary livery weight. */
  readonly paint: Uint8ClampedArray;
  /** Pixels of height that a full height channel stands for. */
  readonly heightRangePx: number;
  /** Where the seal is struck, in texture pixels, or undefined on a hull too slight for one. */
  readonly seal: { readonly x: number; readonly y: number; readonly radius: number } | undefined;
  readonly nozzles: readonly HullNozzle[];
  /** Livery's measured share of the hull, for the tests and the sheet. */
  readonly liveryShare: number;
  readonly registry: string;
}

// --- Small helpers -----------------------------------------------------------

function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b + 0x632be59b), 0xc2b2ae35);
  h = Math.imul(h ^ (c + 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** The hull's height at a distance in from its edge, in cells: chine, side, deck. */
function sectionAt(d: number): number {
  if (d <= 0) return 0;
  if (d < CHINE_WIDTH) {
    const t = d / CHINE_WIDTH;
    return CHINE_HEIGHT * Math.sqrt(t * (2 - t));
  }
  const t = Math.min(1, (d - CHINE_WIDTH) / SIDE_WIDTH);
  // The side eases into the deck over its last stretch, so the crease is
  // pressed rather than cut.
  const eased = t < 0.85 ? t / 0.925 : 1 - ((1 - t) * (1 - t)) / (0.15 * 2 * 0.925);
  return CHINE_HEIGHT + SIDE_RISE * Math.min(1, eased);
}

/** Value noise in [0, 1], smooth, for grime and wear. */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash3(xi, yi, seed);
  const b = hash3(xi + 1, yi, seed);
  const c = hash3(xi, yi + 1, seed);
  const d = hash3(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}


/** Signed distance to a convex polygon given counter-clockwise or clockwise; approximate outside corners. */
function sdConvex(px: number, py: number, poly: readonly Point[], ccw: boolean): number {
  let worst = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.hypot(ex, ey) || 1;
    // Outward normal.
    const nx = ccw ? ey / len : -ey / len;
    const ny = ccw ? -ex / len : ex / len;
    const d = (px - ax) * nx + (py - ay) * ny;
    if (d > worst) worst = d;
  }
  return worst;
}

function isCcw(poly: readonly Point[]): boolean {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    area += ax * by - bx * ay;
  }
  // A positive shoelace sum is counter-clockwise in the mathematical sense,
  // whatever it looks like on a screen whose y grows downward — and that sense
  // is the one the outward normal in `sdConvex` is written for.
  return area > 0;
}

function sdRoundBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - hx + r;
  const qy = Math.abs(py - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

// --- The bake ----------------------------------------------------------------

type Role =
  | 'bridge' | 'hull' | 'armour' | 'engine' | 'thruster' | 'reactor' | 'shield' | 'weapon'
  | 'turret' | 'rack' | 'beam' | 'defense' | 'mining' | 'cargo' | 'tank'
  | 'wedge' | 'nose' | 'fin';

/** A pod's streamlined body, in cells. `fine` is the end drawn finer: +1 forward, -1 aft. */
interface PodBody {
  readonly cx: number;
  readonly cy: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly fine: 1 | -1;
}

/** Fraction of a pod's length its fine end tapers over. */
const POD_FINE = 0.42;

/** A pod's half-width at a point along its length, in cells; 0 off either end. */
function podHalfAt(body: PodBody, gx: number): number {
  const length = body.halfLength * 2;
  // u runs from the blunt end (0) to the fine end (1).
  const u = ((gx - body.cx) * body.fine + body.halfLength) / length;
  if (u <= 0 || u >= 1) return 0;
  const cap = body.halfWidth / length;
  if (u < cap) {
    const t = (cap - u) / cap;
    return body.halfWidth * Math.sqrt(Math.max(0, 1 - t * t));
  }
  if (u > 1 - POD_FINE) {
    const t = (u - (1 - POD_FINE)) / POD_FINE;
    return body.halfWidth * Math.max(0.12, Math.pow(Math.max(0, 1 - Math.pow(t, 1.6)), 0.6));
  }
  return body.halfWidth;
}

/** A pod's outline as a convex polygon. */
function podOutline(body: PodBody): Point[] {
  const steps = 24;
  const upper: Point[] = [];
  const lower: Point[] = [];
  for (let k = 0; k <= steps; k++) {
    const u = 0.002 + (0.996 * k) / steps;
    const gx = body.cx + (u * body.halfLength * 2 - body.halfLength) * body.fine;
    const half = podHalfAt(body, gx);
    upper.push([gx, body.cy - half]);
    lower.push([gx, body.cy + half]);
  }
  return [...upper, ...lower.reverse()];
}

function roleOf(def: ModuleDef): Role {
  return def.shape ?? def.type;
}

export function bakeHull(
  blueprint: Blueprint,
  catalogue: ReadonlyMap<string, ModuleDef>,
  pxPerCell = BAKE_PX_PER_CELL,
): HullBake {
  const P = pxPerCell;
  const modules = placeAll(blueprint.placements, catalogue);
  const bounds = boundsOf(modules);
  const seed = hashString(`${blueprint.id}:${blueprint.placements.length}`);

  const W = Math.ceil((bounds.width + MARGIN_CELLS * 2) * P);
  const H = Math.ceil((bounds.height + MARGIN_CELLS * 2) * P);
  const originX = (MARGIN_CELLS - bounds.minX) * P;
  const originY = (MARGIN_CELLS - bounds.minY) * P;
  const N = W * H;

  /** Grid cell to texture pixel. */
  const toPx = (cx: number): number => originX + cx * P;
  const toPy = (cy: number): number => originY + cy * P;

  // --- Occupancy -------------------------------------------------------------

  const gridW = bounds.width;
  const occupant = new Int32Array(bounds.width * bounds.height).fill(-1);
  modules.forEach((module, index) => {
    for (let dx = 0; dx < module.width; dx++) {
      for (let dy = 0; dy < module.height; dy++) {
        const gx = module.placement.x + dx - bounds.minX;
        const gy = module.placement.y + dy - bounds.minY;
        occupant[gy * gridW + gx] = index;
      }
    }
  });
  const at = (cx: number, cy: number): number => {
    const gx = cx - bounds.minX;
    const gy = cy - bounds.minY;
    if (gx < 0 || gy < 0 || gx >= bounds.width || gy >= bounds.height) return -1;
    return occupant[gy * gridW + gx]!;
  };

  const roles = modules.map((module) => roleOf(module.def));

  /** A single-cell fitting standing out on its own: drawn as a pod on a neck. */
  const podParent = new Map<number, readonly [number, number]>();
  modules.forEach((module, index) => {
    if (module.width !== 1 || module.height !== 1) return;
    if (roles[index] === 'wedge' || roles[index] === 'nose' || roles[index] === 'fin') return;
    const { x, y } = module.placement;
    const neighbours = (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const
    ).filter(([dx, dy]) => {
      // A fin beside a pod is the pod's wing, not a second thing it hangs from.
      const neighbour = at(x + dx, y + dy);
      return neighbour >= 0 && roles[neighbour] !== 'fin';
    });
    if (neighbours.length === 1) podParent.set(index, neighbours[0]!);
  });

  /** Occupied, for shaping a neighbour's corners: a pod hangs off its neck, so it does not count. */
  const solid = (cx: number, cy: number): boolean => {
    const occupantIndex = at(cx, cy);
    return occupantIndex >= 0 && !podParent.has(occupantIndex);
  };

  // --- Skin polygons, in cell coordinates ------------------------------------

  /** The body: cell squares and fairings. Raked at the prow. */
  const polygons: Point[][] = [];
  /** Pods and shaped sections, already drawn the shape they mean to be: never raked. */
  const freePolygons: Point[][] = [];
  const podBodies = new Map<number, PodBody>();

  const addCellSquare = (cx: number, cy: number, module: PlacedModule, role: Role): void => {
    const exposed = (dx: number, dy: number): boolean =>
      !solid(cx + dx, cy) && !solid(cx, cy + dy) && !solid(cx + dx, cy + dy);
    // One step of a staircase: the edge carries on a row over and a cell in.
    const step = (dx: number, dy: number): boolean =>
      solid(cx - dx, cy + dy) || solid(cx + dx, cy - dy);
    const engine = role === 'engine';
    const cut = (dx: number, dy: number): number => {
      if (!exposed(dx, dy)) return 0;
      if (step(dx, dy)) return CHAMFER_STEP;
      return dx > 0 ? CHAMFER_FORE : engine ? CHAMFER_ENGINE_AFT : CHAMFER_AFT;
    };
    const ap = cut(-1, -1);
    const fp = cut(1, -1);
    const fs = cut(1, 1);
    const as = cut(-1, 1);
    void module;
    const x0 = cx;
    const x1 = cx + 1;
    const y0 = cy;
    const y1 = cy + 1;
    const poly: Point[] = [];
    // Clockwise on screen from the aft-port corner.
    if (ap > 0) poly.push([x0, y0 + ap], [x0 + ap, y0]);
    else poly.push([x0, y0]);
    if (fp > 0) poly.push([x1 - fp, y0], [x1, y0 + fp]);
    else poly.push([x1, y0]);
    if (fs > 0) poly.push([x1, y1 - fs], [x1 - fs, y1]);
    else poly.push([x1, y1]);
    if (as > 0) poly.push([x0 + as, y1], [x0, y1 - as]);
    else poly.push([x0, y1]);
    polygons.push(poly);
  };

  const addShaped = (module: PlacedModule, role: 'wedge' | 'nose' | 'fin'): void => {
    const { x, y, rotation } = module.placement;
    freePolygons.push(shapeOutline(role, x, y, module.width, module.height, rotation));
  };

  /**
   * A pod: a streamlined body, always long along the flight axis whichever
   * side it hangs from, its fine end forward (or outward, for one standing off
   * the bow or stern), on a short pylon to the hull.
   */
  const addPod = (index: number, toward: readonly [number, number]): void => {
    const { x, y } = modules[index]!.placement;
    let body: PodBody;
    if (toward[0] === 0) {
      const outward = -toward[1];
      body = { cx: x + 0.5, cy: y + 0.5 + outward * 0.1, halfLength: 0.45, halfWidth: 0.24, fine: 1 };
      const edge = y + 0.5 + toward[1] * 0.56;
      freePolygons.push([
        [x + 0.31, Math.min(edge, body.cy)],
        [x + 0.69, Math.min(edge, body.cy)],
        [x + 0.69, Math.max(edge, body.cy)],
        [x + 0.31, Math.max(edge, body.cy)],
      ]);
    } else {
      const outward = -toward[0] as 1 | -1;
      const edge = x + 0.5 + toward[0] * 0.5;
      body = { cx: edge + outward * 0.46, cy: y + 0.5, halfLength: 0.5, halfWidth: 0.27, fine: outward };
      // A boom back into the parent, so a pod off a raked bow still meets
      // the hull it hangs from.
      const root = edge - outward * 0.9;
      freePolygons.push([
        [Math.min(edge, root), y + 0.5 - 0.17],
        [Math.max(edge, root), y + 0.5 - 0.17],
        [Math.max(edge, root), y + 0.5 + 0.17],
        [Math.min(edge, root), y + 0.5 + 0.17],
      ]);
    }
    podBodies.set(index, body);
    freePolygons.push(podOutline(body));
  };

  modules.forEach((module, index) => {
    const role = roles[index]!;
    if (role === 'wedge' || role === 'nose' || role === 'fin') {
      addShaped(module, role);
      return;
    }
    const parent = podParent.get(index);
    if (parent) {
      addPod(index, parent);
      return;
    }
    for (let dx = 0; dx < module.width; dx++) {
      for (let dy = 0; dy < module.height; dy++) {
        addCellSquare(module.placement.x + dx, module.placement.y + dy, module, role);
      }
    }
  });

  // Fairings: an empty cell with solid neighbours on two sides that meet at a
  // corner gets that corner filled, so a step reads as one raked line.
  for (let cy = bounds.minY; cy < bounds.minY + bounds.height; cy++) {
    for (let cx = bounds.minX; cx < bounds.minX + bounds.width; cx++) {
      if (at(cx, cy) >= 0) continue;
      const north = solid(cx, cy - 1);
      const south = solid(cx, cy + 1);
      const east = solid(cx + 1, cy);
      const west = solid(cx - 1, cy);
      const g = FAIRING;
      if (north && east) polygons.push([[cx + 1 - g, cy], [cx + 1, cy], [cx + 1, cy + g]]);
      if (east && south) polygons.push([[cx + 1, cy + 1 - g], [cx + 1, cy + 1], [cx + 1 - g, cy + 1]]);
      if (south && west) polygons.push([[cx + g, cy + 1], [cx, cy + 1], [cx, cy + 1 - g]]);
      if (west && north) polygons.push([[cx, cy + g], [cx, cy], [cx + g, cy]]);
    }
  }

  // --- Rasterise the skin ----------------------------------------------------

  const mask = new Uint8Array(N);
  const rasterise = (poly: readonly Point[]): void => {
    const pixels = poly.map(([u, v]) => [toPx(u), toPy(v)] as Point);
    const ccw = isCcw(pixels);
    let minPx = Infinity;
    let maxPx = -Infinity;
    let minPy = Infinity;
    let maxPy = -Infinity;
    for (const [px, py] of pixels) {
      minPx = Math.min(minPx, px);
      maxPx = Math.max(maxPx, px);
      minPy = Math.min(minPy, py);
      maxPy = Math.max(maxPy, py);
    }
    for (let py = Math.max(0, Math.floor(minPy)); py < Math.min(H, Math.ceil(maxPy)); py++) {
      for (let px = Math.max(0, Math.floor(minPx)); px < Math.min(W, Math.ceil(maxPx)); px++) {
        if (sdConvex(px + 0.5, py + 0.5, pixels, ccw) <= 0) mask[py * W + px] = 1;
      }
    }
  };
  for (const poly of polygons) rasterise(poly);

  // The prow: the forward end tapers. Two raked faces converge on the bow,
  // clipping a flat bow into a prow. The tip keeps most of the hull's breadth
  // at the bow, so the rake never eats more than three quarters of a cell into
  // a fitting — hits still resolve on the grid, and the drawing should not
  // stray far from it.
  let maskArea = 0;
  let centreSum = 0;
  let bowPx = -1;
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const x = i % W;
    maskArea += 1;
    centreSum += (i - x) / W;
    bowPx = Math.max(bowPx, x);
  }
  const keelY = maskArea > 0 ? centreSum / maskArea : H / 2;
  let bowHalf = 0;
  for (let y = 0; y < H; y++) {
    for (let x = Math.max(0, bowPx - Math.round(0.35 * P)); x <= bowPx; x++) {
      if (mask[y * W + x]) bowHalf = Math.max(bowHalf, Math.abs(y + 0.5 - keelY));
    }
  }
  // A bow that is the broadest part of the hull — a hammerhead — is not a
  // prow and is left as it is.
  let midHalf = 0;
  {
    let sternPx = W;
    for (let i = 0; i < N; i++) if (mask[i]) sternPx = Math.min(sternPx, i % W);
    const from = sternPx + (bowPx - sternPx) * 0.3;
    const to = sternPx + (bowPx - sternPx) * 0.7;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const x = i % W;
      if (x >= from && x <= to) midHalf = Math.max(midHalf, Math.abs((i - x) / W + 0.5 - keelY));
    }
  }
  const raked = bowHalf <= midHalf * 1.05;
  const tipHalf = Math.max(PROW_TIP * P, bowHalf - PROW_BITE * P);
  const prowLimit = (x: number): number => (raked ? tipHalf + (bowPx + 1 - x) * PROW_RAKE : Number.POSITIVE_INFINITY);
  // The rake never takes most of a cell: hits resolve on the grid, and a
  // cell the drawing has thrown away would be hit in empty space.
  const cellOfPixel = (i: number): number => {
    const x = i % W;
    const gx = Math.floor((x + 0.5 - originX) / P) - bounds.minX;
    const gy = Math.floor(((i - x) / W + 0.5 - originY) / P) - bounds.minY;
    return gx < 0 || gy < 0 || gx >= bounds.width || gy >= bounds.height ? -1 : gy * gridW + gx;
  };
  const cellPixels = new Float32Array(bounds.width * bounds.height);
  const cellClipped = new Float32Array(bounds.width * bounds.height);
  const clips = (i: number): boolean => {
    const x = i % W;
    return Math.abs((i - x) / W + 0.5 - keelY) > prowLimit(x + 0.5);
  };
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    const cell = cellOfPixel(i);
    if (cell < 0) continue;
    cellPixels[cell] = cellPixels[cell]! + 1;
    if (clips(i)) cellClipped[cell] = cellClipped[cell]! + 1;
  }
  for (let i = 0; i < N; i++) {
    if (!mask[i] || !clips(i)) continue;
    const cell = cellOfPixel(i);
    if (cell >= 0 && cellClipped[cell]! > cellPixels[cell]! * PROW_MAX_CLIP) continue;
    mask[i] = 0;
  }
  /** How much of a pixel the prow leaves standing, inset by `inset` pixels. */
  const prowCover = (x: number, y: number, inset = 0): number =>
    maskArea > 0 && raked ? clamp01(prowLimit(x) - inset - Math.abs(y - keelY) + 0.5) : 1;
  for (const poly of freePolygons) rasterise(poly);

  const outline = traceOutline(mask, W, H);
  const nearest = nearestSite(W, H, (i) => outline.arc[i]! >= 0);
  const rawField = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = nearest.distance[i]!;
    rawField[i] = mask[i] ? -(d + 0.5) : d - 0.5;
  }
  const field = blur(rawField, W, H, SKIN_SMOOTH * P);

  // --- Hull height, coverage and plating -------------------------------------

  const cover = new Float32Array(N);
  const depth = new Float32Array(N);
  const height = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const sd = field[i]!;
    cover[i] = clamp01(0.5 - sd);
    const d = Math.max(0, -sd) / P;
    depth[i] = d;
    height[i] = sectionAt(d) * P;
  }

  // The crown: a soft dome over the deck toward the keel, from the depth
  // smoothed so it rounds over the middle rather than meeting in a roof
  // ridge, and only where the deck begins, so the side keeps its rake.
  let deepest = 0;
  for (let i = 0; i < N; i++) deepest = Math.max(deepest, depth[i]!);
  const deckFrom = CHINE_WIDTH + SIDE_WIDTH;
  if (deepest > deckFrom) {
    const smoothDepth = blur(depth, W, H, 0.6 * P);
    for (let i = 0; i < N; i++) {
      if (cover[i]! <= 0) continue;
      const t = clamp01((smoothDepth[i]! - deckFrom * 0.6) / (deepest - deckFrom * 0.6));
      height[i] = height[i]! + CROWN_HEIGHT * P * Math.pow(t, 0.8) * smoothstep(deckFrom * 0.7, deckFrom * 1.3, depth[i]!) * cover[i]!;
    }
  }

  // Plates: a band of the distance field, broken every so far along the
  // outline near the edge — so the seams run across the plating there — and
  // at irregular frames along the length in the deep middle of a broad hull.
  // Lengths are adjusted per loop so the breaks divide it evenly.
  const plateOf = new Int32Array(N).fill(-1);
  // Strakes: seams along the deck parallel to the keel, either side of it,
  // at offsets that are never a whole number of cells.
  const strakeGap = 0.9 + 0.35 * hash3(seed, 17, 1);
  const deckFrames: number[] = [];
  {
    let along = -0.4 * hash3(seed, 19, 1);
    for (let k = 0; along < bounds.width + 2; k++) {
      deckFrames.push(along);
      along += 1.25 + 0.6 * hash3(seed, 23, k);
    }
  }
  for (let i = 0; i < N; i++) {
    if (cover[i]! < 0.5) continue;
    const site = nearest.site[i]!;
    if (site < 0) continue;
    const loopIndex = outline.loop[site]!;
    const u = outline.arc[site]!;
    const d = depth[i]!;
    let band = 0;
    while (band < 2 && d >= PLATE_BANDS[band]!) band++;
    let piece = 0;
    if (band === 2) {
      // The deck: frames across it and strakes along it, square to the hull.
      const x = i % W;
      const y = (i - x) / W;
      const along = (x - originX) / P - bounds.minX;
      let frame = 0;
      while (frame < deckFrames.length - 1 && deckFrames[frame + 1]! <= along) frame++;
      const strake = Math.floor((y + 0.5 - keelY) / (strakeGap * P) + 0.5);
      piece = 10000 + frame * 64 + (strake + 32);
    } else if (band === 1 && loopIndex >= 0) {
      const nominal = PLATE_LENGTHS[1]! * P;
      const loopLength = outline.lengths[loopIndex]!;
      const count = Math.max(1, Math.round(loopLength / nominal));
      const phase = hash3(loopIndex, band, seed) * (loopLength / count);
      piece = Math.floor(((u + phase) % loopLength) / (loopLength / count));
    }
    plateOf[i] = (loopIndex + 1) * 100000 + band * 1000 + piece;
  }

  const seamRaw = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const plate = plateOf[i]!;
      if (plate < 0) continue;
      const right = plateOf[i + 1]!;
      const down = plateOf[i + W]!;
      if ((right >= 0 && right !== plate) || (down >= 0 && down !== plate)) seamRaw[i] = 1;
    }
  }
  const seam = blur(seamRaw, W, H, 0.8);
  let seamPeak = 0;
  for (let i = 0; i < N; i++) seamPeak = Math.max(seamPeak, seam[i]!);
  const seamScale = seamPeak > 0 ? 1 / seamPeak : 0;

  // --- Colour layers ----------------------------------------------------------

  const red = new Float32Array(N);
  const green = new Float32Array(N);
  const blue = new Float32Array(N);
  const shine = new Float32Array(N);
  const glow = new Float32Array(N);
  const liveryA = new Float32Array(N);
  const liveryB = new Float32Array(N);
  const occlusionExtra = new Float32Array(N);
  /** Fitting coverage: where livery must not paint and the seal must not go. */
  const fitted = new Float32Array(N);
  /** Detail on the plating (vents, hatches): the seal avoids it. */
  const detailed = new Float32Array(N);

  const grimeSeed = seed ^ 0x5bd1e995;
  for (let i = 0; i < N; i++) {
    if (cover[i]! <= 0) continue;
    const x = i % W;
    const y = (i - x) / W;
    const plate = plateOf[i]!;
    const tone = plate >= 0 ? (hash3(plate, seed, 7) - 0.5) * 0.1 : 0;
    const warmth = plate >= 0 ? (hash3(plate, seed, 11) - 0.5) * 0.03 : 0;
    const grime = (valueNoise(x / (0.9 * P), y / (0.9 * P), grimeSeed) - 0.5) * 0.08;
    const wear = depth[i]! < BEVEL_WIDTH ? (1 - depth[i]! / BEVEL_WIDTH) * 0.05 : 0;
    const s = seam[i]! * seamScale;
    const value = (1 + tone + grime + wear) * (1 - 0.28 * s);
    red[i] = METAL[0] * value + warmth;
    green[i] = METAL[1] * value;
    blue[i] = METAL[2] * value - warmth;
    shine[i] = 0.5;
    height[i] = height[i]! - SEAM_DEPTH * P * s;
  }

  // --- Painting helpers --------------------------------------------------------

  /** Visit a box of pixels in grid-cell coordinates. */
  const each = (
    cx0: number,
    cy0: number,
    cx1: number,
    cy1: number,
    visit: (i: number, gx: number, gy: number) => void,
  ): void => {
    const px0 = Math.max(0, Math.floor(toPx(cx0)));
    const px1 = Math.min(W, Math.ceil(toPx(cx1)));
    const py0 = Math.max(0, Math.floor(toPy(cy0)));
    const py1 = Math.min(H, Math.ceil(toPy(cy1)));
    for (let py = py0; py < py1; py++) {
      for (let px = px0; px < px1; px++) {
        visit(py * W + px, (px + 0.5 - originX) / P, (py + 0.5 - originY) / P);
      }
    }
  };

  /** Paint a fitting's surface: coverage from its distance (cells), height above ground (cells), colour. */
  const fit = (
    i: number,
    sdCells: number,
    heightCells: number,
    colour: Rgb,
    gloss: number,
    options: { glow?: number; glowColour?: Rgb; recess?: number } = {},
  ): void => {
    const c = clamp01(0.5 - sdCells * P);
    if (c <= 0) return;
    const h = heightCells * P;
    const blended = height[i]! * (1 - c) + Math.max(height[i]!, h) * c;
    height[i] = blended;
    const colourNow = options.glow && options.glowColour ? options.glowColour : colour;
    red[i] = red[i]! * (1 - c) + colourNow[0] * c;
    green[i] = green[i]! * (1 - c) + colourNow[1] * c;
    blue[i] = blue[i]! * (1 - c) + colourNow[2] * c;
    shine[i] = shine[i]! * (1 - c) + gloss * c;
    glow[i] = glow[i]! * (1 - c) + (options.glow ?? 0) * c;
    occlusionExtra[i] = Math.max(occlusionExtra[i]!, (options.recess ?? 0) * c);
    cover[i] = Math.max(cover[i]!, c);
    fitted[i] = Math.max(fitted[i]!, c);
  };

  /** Cut detail into the plating: a groove (negative depth, cells) and a tint. */
  const groove = (i: number, amount: number, depthCells: number, darken = 0.3): void => {
    if (amount <= 0 || cover[i]! < 0.5) return;
    height[i] = height[i]! - depthCells * P * amount;
    const k = 1 - darken * amount;
    red[i] = red[i]! * k;
    green[i] = green[i]! * k;
    blue[i] = blue[i]! * k;
    detailed[i] = Math.max(detailed[i]!, amount);
  };

  /** The highest the hull stands under a footprint, in cells: a fitting sits on top of it. */
  const deckUnder = (gx0: number, gy0: number, gx1: number, gy1: number): number => {
    let top = 0;
    each(gx0, gy0, gx1, gy1, (i) => {
      if (cover[i]! > 0.5) top = Math.max(top, height[i]!);
    });
    return top / P;
  };

  /** Coverage of a groove line of the given half-width, from a distance in cells. */
  const line = (d: number, halfWidth: number): number => clamp01(halfWidth * P + 0.5 - Math.abs(d) * P);

  // --- Internals: vents, hatches, conduits -------------------------------------

  const engines: PlacedModule[] = [];
  const reactors: PlacedModule[] = [];

  modules.forEach((module, index) => {
    const role = roles[index]!;
    const { x, y } = module.placement;
    const w = module.width;
    const h = module.height;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = (salt: number): number => hash3(index, salt, seed);

    if (role === 'engine') engines.push(module);
    if (role === 'reactor') reactors.push(module);

    if (role === 'reactor') {
      // A vent grille, slats across the hull, faintly hot.
      const gx0 = x + w * 0.22;
      const gx1 = x + w * 0.78;
      const gy0 = y + h * 0.24;
      const gy1 = y + h * 0.76;
      const pitch = 0.11;
      each(gx0, gy0, gx1, gy1, (i, gx) => {
        const phase = ((gx - gx0) / pitch) % 1;
        const slot = smoothstep(0.62, 0.72, phase) * (1 - smoothstep(0.9, 1, phase));
        groove(i, slot, 0.05, 0.55);
        if (slot > 0.3) {
          glow[i] = Math.max(glow[i]!, 0.22 * slot);
          red[i] = red[i]! * 0.5 + VENT_GLOW[0] * 0.5 * slot;
          green[i] = green[i]! * 0.5 + VENT_GLOW[1] * 0.5 * slot;
          blue[i] = blue[i]! * 0.5 + VENT_GLOW[2] * 0.5 * slot;
        }
      });
      each(gx0 - 0.03, gy0 - 0.03, gx1 + 0.03, gy1 + 0.03, (i, gx, gy) => {
        const d = sdRoundBox(gx, gy, (gx0 + gx1) / 2, (gy0 + gy1) / 2, (gx1 - gx0) / 2, (gy1 - gy0) / 2, 0.04);
        groove(i, line(d, 0.012), 0.025, 0.35);
      });
    } else if (role === 'tank') {
      // Filler hatches: a round cap with a ring, one per cell or so.
      const caps = Math.max(1, Math.round((w * h) / 2));
      for (let k = 0; k < caps; k++) {
        const hx = x + w * (0.3 + 0.4 * r(10 + k));
        const hy = y + h * ((k + 0.5) / caps);
        each(hx - 0.25, hy - 0.25, hx + 0.25, hy + 0.25, (i, gx, gy) => {
          const d = Math.hypot(gx - hx, gy - hy);
          groove(i, line(d - 0.15, 0.014), 0.03, 0.4);
          if (d < 0.135) height[i] = height[i]! + 0.025 * P * (1 - d / 0.135);
          detailed[i] = Math.max(detailed[i]!, d < 0.17 ? 1 : 0);
        });
      }
    } else if (role === 'shield') {
      // An emitter boss: a low hexagon with a faint ring of light.
      each(cx - 0.3, cy - 0.3, cx + 0.3, cy + 0.3, (i, gx, gy) => {
        const qx = Math.abs(gx - cx);
        const qy = Math.abs(gy - cy);
        const hex = Math.max(qx * 0.866 + qy * 0.5, qy) - 0.19;
        if (hex < 0) height[i] = height[i]! + 0.05 * P * clamp01(-hex * 12);
        groove(i, line(hex, 0.012), 0.03, 0.4);
        const ring = line(hex + 0.05, 0.01);
        if (ring > 0) {
          glow[i] = Math.max(glow[i]!, 0.35 * ring);
          red[i] = red[i]! * (1 - ring) + SHIELD_GLOW[0] * ring;
          green[i] = green[i]! * (1 - ring) + SHIELD_GLOW[1] * ring;
          blue[i] = blue[i]! * (1 - ring) + SHIELD_GLOW[2] * ring;
        }
        detailed[i] = Math.max(detailed[i]!, hex < 0.02 ? 1 : 0);
      });
    } else if (role === 'hull' && r(1) < 0.4) {
      // An access hatch now and then on bare plating.
      const hx = x + 0.25 + 0.5 * r(2);
      const hy = y + 0.25 + 0.5 * r(3);
      const hw = 0.13;
      const hh = 0.09;
      each(hx - 0.2, hy - 0.2, hx + 0.2, hy + 0.2, (i, gx, gy) => {
        const d = sdRoundBox(gx, gy, hx, hy, hw, hh, 0.025);
        groove(i, line(d, 0.011), 0.025, 0.35);
      });
    } else if (role === 'armour') {
      // A heavier plate: proud of the hull, with a line of fasteners.
      each(x, y, x + w, y + h, (i, gx, gy) => {
        const d = sdRoundBox(gx, gy, cx, cy, w / 2 - 0.08, h / 2 - 0.08, 0.06);
        if (d < 0) height[i] = height[i]! + 0.03 * P * clamp01(-d * 10);
        const along = Math.abs(gy - cy) - (h / 2 - 0.16);
        const dots = Math.abs(((gx - x) / 0.14) % 1 - 0.5) < 0.18 && Math.abs(along) < 0.02;
        if (dots) {
          red[i] = red[i]! * 0.82;
          green[i] = green[i]! * 0.82;
          blue[i] = blue[i]! * 0.82;
        }
      });
    }
  });

  // Conduits: a pair of clamped pipes across the gap from each reactor to the
  // engine behind it, where the two share rows. A hint of plumbing, not a line
  // drawn the length of the deck.
  for (const reactor of reactors) {
    for (const engine of engines) {
      const rowTop = Math.max(reactor.placement.y, engine.placement.y);
      const rowBottom = Math.min(reactor.placement.y + reactor.height, engine.placement.y + engine.height);
      if (rowBottom - rowTop < 0.6) continue;
      const fromX = reactor.placement.x + 0.15;
      const toX = engine.placement.x + engine.width - 0.12;
      if (fromX - toX < 0.3 || fromX - toX > 2.2) continue;
      const midY = (rowTop + rowBottom) / 2;
      for (const offset of [-0.12, 0.12]) {
        const py0 = midY + offset;
        each(toX - 0.05, py0 - 0.08, fromX + 0.05, py0 + 0.08, (i, gx, gy) => {
          if (depth[i]! < 0.22) return;
          const d = sdSegment(gx, gy, toX, py0, fromX, py0, 0.04);
          if (d > 0.01) return;
          const c = clamp01(0.5 - d * P);
          const across = clamp01(-d / 0.04);
          const clamp = Math.abs((((gx - toX) / 0.32) % 1) - 0.5) > 0.42;
          height[i] = height[i]! + (0.05 + (clamp ? 0.012 : 0)) * P * Math.sqrt(across) * c;
          const tone: Rgb = clamp ? GUNMETAL : DARK_METAL;
          red[i] = red[i]! * (1 - c) + tone[0] * 1.3 * c;
          green[i] = green[i]! * (1 - c) + tone[1] * 1.3 * c;
          blue[i] = blue[i]! * (1 - c) + tone[2] * 1.3 * c;
          shine[i] = shine[i]! * (1 - c) + 0.6 * c;
          detailed[i] = Math.max(detailed[i]!, c);
        });
      }
    }
  }

  // --- Fittings by role ---------------------------------------------------------

  const nozzles: HullNozzle[] = [];

  modules.forEach((module, index) => {
    const role = roles[index]!;
    const { x, y } = module.placement;
    const w = module.width;
    const h = module.height;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const deckAt = deckUnder(x, y, x + w, y + h);
    const foreOpen = (() => {
      for (let dy = 0; dy < h; dy++) if (at(x + w, y + dy) >= 0) return false;
      return true;
    })();
    const aftOpen = (() => {
      for (let dy = 0; dy < h; dy++) if (at(x - 1, y + dy) >= 0) return false;
      return true;
    })();
    const pod = podParent.get(index);
    const podBody = podBodies.get(index);

    if (podBody) {
      // The pod's body, round in section: the hull's own section is too low
      // and too flat on something this slender.
      const b = podBody;
      each(b.cx - b.halfLength - 0.04, b.cy - b.halfWidth - 0.04, b.cx + b.halfLength + 0.04, b.cy + b.halfWidth + 0.04, (i, gx, gy) => {
        const half = podHalfAt(b, gx);
        const off = Math.abs(gy - b.cy);
        const sd = half > 0 ? Math.max(off - half, Math.abs(gx - b.cx) - b.halfLength) : 1;
        const round = half > 0 ? Math.sqrt(Math.max(0, 1 - (off / half) ** 2)) : 0;
        fit(i, sd, 0.04 + half * 0.95 * round, METAL, 0.58);
      });
    }

    switch (role) {
      case 'engine': {
        // A nacelle along the thrust axis for each bell, faired into the hull
        // forward, banded where it meets the bell, and ending aft in a bell
        // nozzle that flares as it stands proud of the stern.
        const bells = Math.max(1, Math.min(3, Math.round(h)));
        const lane = h / bells;
        const radius = Math.min(0.42, lane * 0.4);
        const base = deckAt * 0.7;
        const foreX = x + w - 0.06;
        const fairing = Math.min(0.5, w * 0.5);
        for (let b = 0; b < bells; b++) {
          const by = y + lane * (b + 0.5);
          each(x - 0.02, by - radius - 0.04, foreX + 0.04, by + radius + 0.04, (i, gx, gy) => {
            const taper = 1 - 0.7 * smoothstep(foreX - fairing, foreX, gx);
            const r = radius * taper;
            const off = Math.abs(gy - by);
            const sd = Math.max(off - r, gx - foreX, x - gx);
            const round = Math.sqrt(Math.max(0, 1 - (off / r) ** 2));
            const aft = gx - x;
            const band = aft < 0.34 && Math.abs(((aft / 0.11) % 1) - 0.5) > 0.36 ? 1 : 0;
            const tone: Rgb = band ? DARK_METAL : NACELLE;
            fit(i, sd, base + r * 0.85 * round - band * 0.012, tone, 0.62);
          });
          const length = aftOpen ? 0.46 : 0.14;
          const start = x + 0.04;
          const mouth = start - length;
          const r0 = radius * 0.74;
          const r1 = radius * 0.95;
          each(mouth - 0.05, by - r1 - 0.05, start + 0.05, by + r1 + 0.05, (i, gx, gy) => {
            const t = clamp01((start - gx) / length);
            const half = r0 + (r1 - r0) * t * t;
            const off = Math.abs(gy - by);
            const d = Math.max(off - half, gx - start, mouth - gx);
            const round = Math.sqrt(Math.max(0, 1 - (off / half) ** 2));
            const throat = t > 0.93 && off < half * 0.7;
            const lip = t > 0.88 && !throat;
            fit(i, d, base * 0.8 + half * 0.82 * round, lip ? NOZZLE_RIM : NOZZLE, 0.75, {
              glow: throat ? 0.9 * smoothstep(0.93, 1, t) : 0,
              glowColour: THROAT_GLOW,
              recess: throat ? 0.4 : 0,
            });
          });
          nozzles.push({ x: mouth, y: by, halfWidth: r1 * 0.85 });
        }
        break;
      }

      case 'thruster': {
        // A small jet: on a pod it points outward; set into the hull it is a
        // recessed ring.
        const out = pod ? ([-pod[0], -pod[1]] as const) : ([0, cy < 0 ? -1 : 1] as const);
        const jx = podBody ? (out[0] !== 0 ? podBody.cx + out[0] * podBody.halfLength * 0.82 : podBody.cx - 0.08) : cx;
        const jy = podBody ? (out[1] !== 0 ? podBody.cy + out[1] * podBody.halfWidth * 0.5 : podBody.cy) : cy;
        each(jx - 0.25, jy - 0.25, jx + 0.25, jy + 0.25, (i, gx, gy) => {
          const d = Math.hypot(gx - jx, gy - jy);
          fit(i, d - 0.13, deckAt + 0.06, NOZZLE, 0.7);
          if (d < 0.1) {
            const c = clamp01((0.1 - d) * P);
            glow[i] = Math.max(glow[i]!, 0.35 * c);
            red[i] = red[i]! * (1 - c) + THROAT_GLOW[0] * c * 0.8;
            green[i] = green[i]! * (1 - c) + THROAT_GLOW[1] * c * 0.8;
            blue[i] = blue[i]! * (1 - c) + THROAT_GLOW[2] * c * 0.8;
            occlusionExtra[i] = Math.max(occlusionExtra[i]!, 0.3 * c);
          }
        });
        break;
      }

      case 'bridge': {
        // A canopy across the forward half, glazed on its forward face.
        const ox0 = x + w * 0.35;
        const ox1 = x + w - 0.08;
        const half = h / 2 - 0.16;
        // The canopy follows the prow: it stands on the deck, inside the rake.
        const inset = 0.22 * P;
        const raked = (i: number, d: number): number => {
          const px = (i % W) + 0.5;
          const py = Math.floor(i / W) + 0.5;
          const keep = prowCover(px, py, inset);
          return keep >= 1 ? d : Math.max(d, (0.5 - keep) / P);
        };
        each(ox0 - 0.05, y, ox1 + 0.05, y + h, (i, gx, gy) => {
          const d = raked(i, sdRoundBox(gx, gy, (ox0 + ox1) / 2, cy, (ox1 - ox0) / 2, half, Math.min(0.3, half)));
          const lift = 0.12 * clamp01(-d * 6) + 0.04;
          fit(i, d, deckAt + lift, METAL, 0.5);
        });
        const panes = Math.max(3, Math.round(h * 2.5));
        const glassX0 = ox1 - 0.2;
        each(glassX0, y, ox1, y + h, (i, gx, gy) => {
          const d = raked(i, sdRoundBox(gx, gy, (glassX0 + ox1) / 2 - 0.02, cy, 0.08, half - 0.08, 0.06));
          if (d > 0.01) return;
          const slot = ((gy - (cy - half)) / ((half * 2) / panes)) % 1;
          const mullion = slot < 0.12 || slot > 0.88;
          fit(i, d, deckAt + 0.17, mullion ? GLASS : WINDOW_GLOW, 0.9, {
            glow: mullion ? 0 : 0.85,
            glowColour: WINDOW_GLOW,
          });
        });
        break;
      }

      case 'weapon': {
        // A barrel on a mount, laid along the hull and out past the bow.
        const barrels = w >= 2 && h >= 2 ? 2 : 1;
        const radius = 0.065 + 0.018 * (module.def.tier - 1) + (w >= 3 ? 0.02 : 0);
        const mx0 = x + 0.08;
        const mx1 = x + Math.min(w, 0.72);
        each(mx0 - 0.05, y + 0.1, mx1 + 0.05, y + h - 0.1, (i, gx, gy) => {
          const d = sdRoundBox(gx, gy, (mx0 + mx1) / 2, cy, (mx1 - mx0) / 2, Math.min(0.26, h / 2 - 0.12), 0.06);
          fit(i, d, deckAt + 0.1, GUNMETAL, 0.55);
        });
        const muzzle = x + w + (foreOpen ? 0.62 : 0.3);
        for (let b = 0; b < barrels; b++) {
          const by = barrels === 1 ? cy : y + h * (b === 0 ? 0.32 : 0.68);
          each(x + 0.1, by - 0.2, muzzle + 0.12, by + 0.2, (i, gx, gy) => {
            const d = sdSegment(gx, gy, x + 0.3, by, muzzle, by, radius);
            const brake = gx > muzzle - 0.09 ? sdSegment(gx, gy, muzzle - 0.09, by, muzzle, by, radius * 1.35) : d;
            const dd = Math.min(d, brake);
            const across = clamp01(1 - Math.abs(gy - by) / (radius * 1.35));
            fit(i, dd, deckAt + 0.14 + 0.06 * Math.sqrt(across), GUNMETAL, 0.65);
          });
        }
        break;
      }

      case 'turret': {
        // A round housing on top of the hull, its barrel forward.
        const radius = Math.min(w, h) * 0.38;
        const dome = 0.2 + 0.08 * Math.sqrt(Math.min(w, h));
        each(cx - radius - 0.1, cy - radius - 0.1, cx + radius + 0.1, cy + radius + 0.1, (i, gx, gy) => {
          const d = Math.hypot(gx - cx, gy - cy);
          const round = Math.sqrt(Math.max(0, 1 - (d / radius) ** 2));
          fit(i, d - radius, deckAt + 0.05 + dome * round, GUNMETAL, 0.6);
          // A ring where the housing turns on its base.
          if (Math.abs(d - radius * 0.86) < 0.015) groove(i, 1, 0.02, 0.35);
        });
        const barrels = Math.min(w, h) >= 2 ? 2 : 1;
        const br = 0.05 + 0.02 * Math.min(w, h);
        const reach = cx + radius + 0.55;
        for (let b = 0; b < barrels; b++) {
          const by = barrels === 1 ? cy : cy + (b === 0 ? -1 : 1) * radius * 0.28;
          each(cx, by - 0.2, reach + 0.1, by + 0.2, (i, gx, gy) => {
            const d = sdSegment(gx, gy, cx + radius * 0.3, by, reach, by, br);
            const across = clamp01(1 - Math.abs(gy - by) / br);
            fit(i, d, deckAt + 0.05 + dome * 0.85 + 0.04 * Math.sqrt(across), GUNMETAL, 0.65);
          });
        }
        break;
      }

      case 'rack': {
        // A launcher box with its tube mouths forward.
        const bx0 = x + 0.1;
        const bx1 = x + w - 0.08;
        const by0 = y + 0.12;
        const by1 = y + h - 0.12;
        each(bx0 - 0.05, by0 - 0.05, bx1 + 0.05, by1 + 0.05, (i, gx, gy) => {
          const d = sdRoundBox(gx, gy, (bx0 + bx1) / 2, (by0 + by1) / 2, (bx1 - bx0) / 2, (by1 - by0) / 2, 0.07);
          fit(i, d, deckAt + 0.16 + 0.03 * clamp01(-d * 8), GUNMETAL, 0.5);
        });
        const columns = Math.max(1, Math.round(w * 1.5));
        const rows = Math.max(2, Math.round(h * 2));
        for (let ci = 0; ci < columns; ci++) {
          for (let ri = 0; ri < rows; ri++) {
            const tx = bx1 - 0.14 - ci * 0.22;
            const ty = by0 + ((by1 - by0) * (ri + 0.5)) / rows;
            const tr = Math.min(0.075, ((by1 - by0) / rows) * 0.36);
            each(tx - tr - 0.02, ty - tr - 0.02, tx + tr + 0.02, ty + tr + 0.02, (i, gx, gy) => {
              const d = Math.hypot(gx - tx, gy - ty) - tr;
              if (d < 0) {
                const c = clamp01(-d * P);
                height[i] = height[i]! - 0.05 * P * c;
                red[i] = red[i]! * (1 - 0.7 * c);
                green[i] = green[i]! * (1 - 0.7 * c);
                blue[i] = blue[i]! * (1 - 0.7 * c);
                occlusionExtra[i] = Math.max(occlusionExtra[i]!, 0.5 * c);
              }
            });
          }
        }
        break;
      }

      case 'beam':
      case 'mining': {
        // An emitter housing ending in a lens; a mining rig adds a cutter jaw.
        const hx0 = x + 0.1;
        const hx1 = x + w - 0.04;
        const half = Math.min(h / 2 - 0.12, 0.3);
        each(hx0 - 0.05, cy - half - 0.05, hx1 + 0.1, cy + half + 0.05, (i, gx, gy) => {
          const taper = smoothstep(hx1 - 0.35, hx1, gx);
          const d = sdRoundBox(gx, gy, (hx0 + hx1) / 2, cy, (hx1 - hx0) / 2, half * (1 - 0.35 * taper), 0.08);
          fit(i, d, deckAt + 0.15, GUNMETAL, 0.6);
        });
        const lensX = hx1 - 0.02;
        const lensR = half * 0.55;
        each(lensX - lensR - 0.05, cy - lensR - 0.05, lensX + lensR + 0.05, cy + lensR + 0.05, (i, gx, gy) => {
          const d = Math.hypot((gx - lensX) * 1.6, gy - cy) - lensR;
          fit(i, d, deckAt + 0.19, role === 'beam' ? LENS_GLOW : CUTTER_GLOW, 0.9, {
            glow: 0.7,
            glowColour: role === 'beam' ? LENS_GLOW : CUTTER_GLOW,
          });
        });
        if (role === 'mining') {
          for (const side of [-1, 1]) {
            each(hx1 - 0.1, cy - half - 0.2, hx1 + 0.45, cy + half + 0.2, (i, gx, gy) => {
              const d = sdSegment(gx, gy, hx1 - 0.05, cy + side * half * 0.8, hx1 + 0.36, cy + side * half * 0.35, 0.045);
              fit(i, d, deckAt + 0.14, GUNMETAL, 0.6);
            });
          }
        }
        break;
      }

      case 'defense': {
        // A low dome with a stub of twin barrels.
        const radius = Math.min(w, h) * 0.3;
        each(cx - radius - 0.3, cy - radius - 0.1, cx + radius + 0.4, cy + radius + 0.1, (i, gx, gy) => {
          const d = Math.hypot(gx - cx, gy - cy);
          const round = Math.sqrt(Math.max(0, 1 - (d / radius) ** 2));
          fit(i, d - radius, deckAt + 0.04 + 0.12 * round, GUNMETAL, 0.6);
          for (const side of [-1, 1]) {
            const dd = sdSegment(gx, gy, cx, cy + side * 0.05, cx + radius + 0.22, cy + side * 0.05, 0.03);
            fit(i, dd, deckAt + 0.15, GUNMETAL, 0.65);
          }
        });
        break;
      }

      default:
        break;
    }
  });

  // Cargo: containers stacked in lanes along each bay. A bay is a connected
  // run of cargo cells; its lanes are narrower than a cell and its containers
  // shorter or longer than one, so nothing in the stack keeps the grid's
  // pitch. Some stand two high, and every one stays inside the skin.
  const cargoBay = new Int32Array(bounds.width * bounds.height).fill(-1);
  const bays: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
  for (let gy = 0; gy < bounds.height; gy++) {
    for (let gx = 0; gx < bounds.width; gx++) {
      const start = gy * gridW + gx;
      const occupantIndex = occupant[start]!;
      if (occupantIndex < 0 || roles[occupantIndex] !== 'cargo' || cargoBay[start]! >= 0) continue;
      const bay = { minX: gx, minY: gy, maxX: gx, maxY: gy };
      const queue = [start];
      cargoBay[start] = bays.length;
      while (queue.length > 0) {
        const cell = queue.pop()!;
        const cx = cell % gridW;
        const cy = (cell - cx) / gridW;
        bay.minX = Math.min(bay.minX, cx);
        bay.maxX = Math.max(bay.maxX, cx);
        bay.minY = Math.min(bay.minY, cy);
        bay.maxY = Math.max(bay.maxY, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bounds.width || ny >= bounds.height) continue;
          const next = ny * gridW + nx;
          const nextOccupant = occupant[next]!;
          if (nextOccupant < 0 || roles[nextOccupant] !== 'cargo' || cargoBay[next]! >= 0) continue;
          cargoBay[next] = bays.length;
          queue.push(next);
        }
      }
      bays.push(bay);
    }
  }
  const inBay = (cx: number, cy: number, bay: number): boolean => {
    const gx = cx - bounds.minX;
    const gy = cy - bounds.minY;
    return gx >= 0 && gy >= 0 && gx < bounds.width && gy < bounds.height && cargoBay[gy * gridW + gx] === bay;
  };

  const containerTones: readonly Rgb[] = [CONTAINER, [0.47, 0.5, 0.54], [0.56, 0.5, 0.45], [0.42, 0.46, 0.44]];
  let containerIndex = 0;
  bays.forEach((bay, bayIndex) => {
    const top = bay.minY + bounds.minY + CARGO_INSET;
    const bottom = bay.maxY + bounds.minY + 1 - CARGO_INSET;
    const lanes = Math.max(1, Math.round((bay.maxY - bay.minY + 1) * LANES_PER_CELL));
    const pitch = (bottom - top) / lanes;
    for (let lane = 0; lane < lanes; lane++) {
      const ly0 = top + lane * pitch + CONTAINER_GAP / 2;
      const ly1 = top + (lane + 1) * pitch - CONTAINER_GAP / 2;
      const rowA = Math.floor(ly0);
      const rowB = Math.floor(ly1 - 1e-6);
      const open = (cx: number): boolean => inBay(cx, rowA, bayIndex) && inBay(cx, rowB, bayIndex);
      let cx = bay.minX + bounds.minX;
      while (cx <= bay.maxX + bounds.minX) {
        if (!open(cx)) {
          cx++;
          continue;
        }
        const runStart = cx;
        while (cx <= bay.maxX + bounds.minX && open(cx)) cx++;
        let sx = runStart + CARGO_INSET;
        const runEnd = cx - CARGO_INSET;
        while (runEnd - sx > 0.3) {
          let length = 0.55 + 0.8 * hash3(containerIndex, lane, seed);
          if (runEnd - sx - length < 0.42) length = runEnd - sx;
          const sx0 = sx;
          const sx1 = sx + length;
          const pick = containerTones[Math.floor(hash3(containerIndex, 5, seed) * containerTones.length)]!;
          const value = 0.9 + 0.18 * hash3(containerIndex, 9, seed);
          const tone: Rgb = [pick[0] * value, pick[1] * value, pick[2] * value];
          const stacked = hash3(containerIndex, 13, seed) < 0.22 ? CONTAINER_HEIGHT : 0;
          const deck = deckUnder(sx0, ly0, sx1, ly1);
          const midY = (ly0 + ly1) / 2;
          each(sx0 - 0.04, ly0 - 0.04, sx1 + 0.04, ly1 + 0.04, (i, gx, gy) => {
            const box = sdRoundBox(gx, gy, (sx0 + sx1) / 2, midY, (sx1 - sx0) / 2, (ly1 - ly0) / 2, 0.04);
            // Inside the skin, clear of the chine.
            const d = Math.max(box, CHINE_WIDTH + 0.04 - depth[i]!);
            const crown = clamp01(-box * 9);
            const corrugation = 0.005 * Math.sin(((gx - sx0) / 0.09) * Math.PI * 2);
            const end = gx - sx0 < 0.06 || sx1 - gx < 0.06;
            const shade: Rgb = end ? [tone[0] * 0.8, tone[1] * 0.8, tone[2] * 0.8] : tone;
            fit(i, d, deck + 0.05 + stacked + CONTAINER_HEIGHT * crown + corrugation, shade, 0.32);
          });
          containerIndex++;
          sx = sx1 + CONTAINER_GAP;
        }
      }
    }
  });

  // --- Livery -------------------------------------------------------------------

  let hullMinX = Infinity;
  let hullMaxX = -Infinity;
  let hullArea = 0;
  for (let i = 0; i < N; i++) {
    if (cover[i]! < 0.5) continue;
    const x = i % W;
    hullMinX = Math.min(hullMinX, x);
    hullMaxX = Math.max(hullMaxX, x);
  }
  const hullLength = Math.max(1, hullMaxX - hullMinX);
  for (let i = 0; i < N; i++) hullArea += Math.min(cover[i]!, 1 - fitted[i]!) * (depth[i]! > 0 ? 1 : 0);

  const bandCentres = [hullMaxX - hullLength * 0.34, hullMaxX - hullLength * 0.7];
  const paintFor = (scale: number, write: boolean): number => {
    const bandHalf = ((0.4 * scale) / 2) * P;
    const stripeIn = 0.36;
    const stripeOut = stripeIn + Math.min(0.3, 0.1 * scale);
    let painted = 0;
    for (let i = 0; i < N; i++) {
      if (depth[i]! <= 0) continue;
      const bare = Math.min(cover[i]!, 1 - fitted[i]!);
      if (bare <= 0 || glow[i]! > 0.05) continue;
      const x = i % W;
      let band = 0;
      for (const centre of bandCentres) band = Math.max(band, clamp01(bandHalf + 0.5 - Math.abs(x - centre)));
      const d = depth[i]!;
      const stern = smoothstep(hullMinX + hullLength * 0.08, hullMinX + hullLength * 0.16, x);
      const stripe = clamp01((d - stripeIn) * P + 0.5) * clamp01((stripeOut - d) * P + 0.5) * stern;
      const a = band * bare;
      const b = Math.max(0, stripe - band) * bare;
      painted += Math.max(a, b);
      if (write) {
        liveryA[i] = a;
        liveryB[i] = b;
      }
    }
    return hullArea > 0 ? painted / hullArea : 0;
  };
  let scale = 1;
  for (let iteration = 0; iteration < 5; iteration++) {
    const share = paintFor(scale, false);
    if (share <= 0) break;
    scale = Math.min(3, Math.max(0.2, scale * (LIVERY_SHARE / share)));
  }
  const liveryShare = paintFor(scale, true);

  // --- Registry stencil ------------------------------------------------------------

  const prefix = ({ 'open-ticket': 'OT', 'frigate-warrant': 'FW', 'cruiser-warrant': 'CW', 'capital-charter': 'CC' } as const)[
    blueprint.licence
  ];
  const registry = `${prefix} ${String(1000 + (seed % 9000))}`;
  const dots = stencilDots(registry);
  const dot = 0.024 * P;
  const textWidth = (Math.max(...dots.map((d) => d.x)) + 1) * dot;
  const textHeight = STENCIL_ROWS * dot;
  let registryAt: { x: number; y: number } | undefined;
  for (const fraction of [0.22, 0.3, 0.42, 0.55]) {
    const tx = Math.round(hullMinX + hullLength * fraction);
    // From the port edge inward until the text sits on clear deck.
    for (let ty = 0; ty < H - textHeight; ty++) {
      const probe = (px: number, py: number): boolean => {
        const i = Math.min(H - 1, Math.max(0, Math.round(py))) * W + Math.min(W - 1, Math.max(0, Math.round(px)));
        return (
          depth[i]! > 0.34 &&
          fitted[i]! < 0.05 &&
          detailed[i]! < 0.05 &&
          glow[i]! < 0.05 &&
          liveryA[i]! < 0.05 &&
          liveryB[i]! < 0.05
        );
      };
      let clear = true;
      for (let py = ty - 2; py <= ty + textHeight + 2 && clear; py += 2) {
        for (let px = tx - 2; px <= tx + textWidth + 2 && clear; px += 2) {
          if (!probe(px, py)) clear = false;
        }
      }
      if (clear) {
        registryAt = { x: tx, y: ty };
        break;
      }
    }
    if (registryAt) break;
  }
  if (registryAt) {
    for (const d of dots) {
      const x0 = registryAt.x + d.x * dot;
      const y0 = registryAt.y + d.y * dot;
      for (let py = Math.floor(y0); py < Math.ceil(y0 + dot); py++) {
        for (let px = Math.floor(x0); px < Math.ceil(x0 + dot); px++) {
          const cx = clamp01(Math.min(px + 1, x0 + dot) - Math.max(px, x0));
          const cy = clamp01(Math.min(py + 1, y0 + dot) - Math.max(py, y0));
          const i = py * W + px;
          liveryB[i] = Math.max(liveryB[i]!, cx * cy);
          liveryA[i] = liveryA[i]! * (1 - cx * cy);
          detailed[i] = 1;
        }
      }
    }
  }

  // --- Seal spot ----------------------------------------------------------------

  let seal: HullBake['seal'];
  {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const d = depth[i]!;
      if (d < 0.3 || fitted[i]! > 0.02 || detailed[i]! > 0.05 || glow[i]! > 0.05) continue;
      const x = i % W;
      const along = (x - hullMinX) / hullLength;
      const score = d - 0.25 * Math.abs(along - 0.45);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) {
      const radius = Math.min(0.4, depth[best]! * 0.75) * P;
      if (radius >= 0.18 * P) {
        const sx = best % W;
        seal = { x: sx + 0.5, y: (best - sx) / W + 0.5, radius };
        // The seal is struck on bare metal: no band under it.
        const r2 = (radius * 1.1) ** 2;
        for (let py = Math.floor(seal.y - radius * 1.1); py <= Math.ceil(seal.y + radius * 1.1); py++) {
          for (let px = Math.floor(seal.x - radius * 1.1); px <= Math.ceil(seal.x + radius * 1.1); px++) {
            if ((px + 0.5 - seal.x) ** 2 + (py + 0.5 - seal.y) ** 2 > r2) continue;
            const i = py * W + px;
            liveryA[i] = 0;
            liveryB[i] = 0;
          }
        }
      }
    }
  }

  // --- Normals, occlusion, packing -------------------------------------------------

  const heightBlur = blur(height, W, H, 0.09 * P);
  const base = new Uint8ClampedArray(N * 4);
  const shape = new Uint8ClampedArray(N * 4);
  const paint = new Uint8ClampedArray(N * 4);
  const heightRangePx = HEIGHT_RANGE_CELLS * P;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const c = cover[i]!;
      if (c <= 1 / 255) {
        // Outside: carry the nearest edge's colour outward, so mipmaps do not
        // pull a dark fringe in from transparent black.
        const site = nearest.site[i]!;
        const from = site >= 0 ? site : i;
        base[o] = Math.round(red[from]! * 255);
        base[o + 1] = Math.round(green[from]! * 255);
        base[o + 2] = Math.round(blue[from]! * 255);
        base[o + 3] = 0;
        shape[o] = 128;
        shape[o + 1] = 128;
        shape[o + 2] = 0;
        shape[o + 3] = 255;
        continue;
      }
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < W - 1 ? x + 1 : W - 1;
      const yu = (y > 0 ? y - 1 : 0) * W;
      const yd = (y < H - 1 ? y + 1 : H - 1) * W;
      const yc = y * W;
      const gx =
        (height[yu + xr]! + 2 * height[yc + xr]! + height[yd + xr]! - height[yu + xl]! - 2 * height[yc + xl]! - height[yd + xl]!) / 8;
      const gy =
        (height[yd + xl]! + 2 * height[yd + x]! + height[yd + xr]! - height[yu + xl]! - 2 * height[yu + x]! - height[yu + xr]!) / 8;
      const len = Math.hypot(gx, gy, 1);
      const nx = -gx / len;
      const ny = -gy / len;
      const cavity = Math.max(0, heightBlur[i]! - height[i]!) / (0.08 * P);
      const occlusion = clamp01(1 - 0.55 * cavity) * (1 - 0.45 * occlusionExtra[i]!);

      base[o] = Math.round(clamp01(red[i]!) * 255);
      base[o + 1] = Math.round(clamp01(green[i]!) * 255);
      base[o + 2] = Math.round(clamp01(blue[i]!) * 255);
      base[o + 3] = Math.round(clamp01(c) * 255);
      shape[o] = Math.round((nx * 0.5 + 0.5) * 255);
      shape[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      shape[o + 2] = Math.round(clamp01(height[i]! / heightRangePx) * 255);
      shape[o + 3] = Math.round(Math.max(0.3, occlusion) * 255);
      paint[o] = Math.round(clamp01(shine[i]!) * 255);
      paint[o + 1] = Math.round(clamp01(glow[i]!) * 255);
      paint[o + 2] = Math.round(clamp01(liveryA[i]!) * 255);
      paint[o + 3] = Math.round(clamp01(liveryB[i]!) * 255);
    }
  }

  return {
    width: W,
    height: H,
    pxPerCell: P,
    originX,
    originY,
    base,
    shape,
    paint,
    heightRangePx,
    seal,
    nozzles,
    liveryShare,
    registry,
  };
}
