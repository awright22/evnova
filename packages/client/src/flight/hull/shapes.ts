/**
 * The drawn shape of a silhouette section.
 *
 * A wedge, a nose or a fin occupies whole cells to the simulation — it is hit,
 * weighed and counted like any hull section — and only changes the outline a
 * hull is drawn with. The bake rasterises these outlines into the skin and the
 * Loft draws them over the cells they occupy, so a captain laying one down
 * sees which way it points before it is ever flown.
 *
 * All in grid cells, from the placement's corner, after rotation.
 */

import type { Rotation } from '@marque/shared';

export type Shape = 'wedge' | 'nose' | 'fin';
export type Point = readonly [number, number];

/** A fin standing out to starboard from its port edge, swept aft: rotation 0, in a unit cell. */
const STARBOARD_FIN: readonly Point[] = [
  [0.06, 0],
  [0.92, 0],
  [0.36, 0.95],
  [-0.06, 0.95],
];

const turn = ([u, v]: Point, rotation: Rotation): Point => {
  const t = (rotation * Math.PI) / 180;
  const du = u - 0.5;
  const dv = v - 0.5;
  return [0.5 + du * Math.cos(t) - dv * Math.sin(t), 0.5 + du * Math.sin(t) + dv * Math.cos(t)];
};

/**
 * The outline a shaped section draws, as a convex polygon in grid cells.
 *
 * `width` and `height` are the footprint after rotation.
 *
 * - A wedge keeps three corners of its cell; rotation picks the raked one:
 *   0 fore-port, 90 fore-starboard, 180 aft-starboard, 270 aft-port.
 * - A nose is a prow across its whole footprint, pointing 0 forward,
 *   90 starboard, 180 aft, 270 port.
 * - A fin is a swept blade: 0 stands out to starboard from its port edge and
 *   180 to port from its starboard edge, both swept aft; 90 and 270 are the
 *   same blade turned.
 */
export function shapeOutline(
  shape: Shape,
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: Rotation,
): Point[] {
  if (shape === 'wedge') {
    const corners: Point[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const cut = { 0: 1, 90: 2, 180: 3, 270: 0 }[rotation];
    return corners.filter((_, i) => i !== cut).map(([u, v]) => [x + u, y + v] as Point);
  }
  if (shape === 'nose') {
    const pointing = ({ 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] } as const)[rotation];
    const along = pointing[0] !== 0;
    const length = along ? width : height;
    const breadth = along ? height : width;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const steps = 12;
    const left: Point[] = [];
    const right: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // An ogive: full breadth at the root, drawn in to a fine point.
      const half = (breadth / 2) * Math.pow(1 - Math.pow(t, 1.8), 0.75) + (t > 0.98 ? 0.03 : 0);
      const a = -length / 2 + t * length;
      const ax = cx + pointing[0] * a;
      const ay = cy + pointing[1] * a;
      left.push([ax - pointing[1] * half, ay + pointing[0] * half]);
      right.push([ax + pointing[1] * half, ay - pointing[0] * half]);
    }
    return [...left, ...right.reverse()];
  }
  const local =
    rotation === 0
      ? STARBOARD_FIN
      : rotation === 180
        ? STARBOARD_FIN.map(([u, v]) => [u, 1 - v] as Point)
        : STARBOARD_FIN.map((point) => turn(point, rotation));
  return local.map(([u, v]) => [x + u, y + v] as Point);
}

/**
 * The rotation that draws a shaped section as its own mirror image fore and
 * aft, which is the way the Loft's mirror flips a placement.
 */
export function mirroredRotation(shape: Shape | undefined, rotation: Rotation): Rotation {
  switch (shape) {
    case 'wedge':
      return ({ 0: 270, 90: 180, 180: 90, 270: 0 } as const)[rotation];
    case 'nose':
      return ({ 0: 180, 90: 90, 180: 0, 270: 270 } as const)[rotation];
    case 'fin':
      return ({ 0: 0, 90: 270, 180: 180, 270: 90 } as const)[rotation];
    default:
      return rotation;
  }
}
