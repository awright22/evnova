/**
 * A mask's outline, as loops with a position along each.
 *
 * Marching squares over the pixel centres gives a closed polyline per loop —
 * the hull's outer edge, and the edge of every hole in it. Walking each loop
 * gives an arc length to every pixel on the edge, so anything that wants to
 * run *along* the hull rather than across the image — panel plates breaking
 * every so far along the plating, a stripe following the deck edge — has a
 * coordinate to run along that has nothing to do with the cell grid.
 */

export interface Outline {
  /** For each pixel on the inside edge, how far along its loop it sits, in pixels; otherwise -1. */
  readonly arc: Float32Array;
  /** For each pixel on the inside edge, which loop it belongs to; otherwise -1. */
  readonly loop: Int32Array;
  /** Each loop's length in pixels. */
  readonly lengths: readonly number[];
}

/**
 * Which edges a 2×2 block's case connects. Edges are 0 top, 1 right, 2
 * bottom, 3 left; corners are top-left 1, top-right 2, bottom-right 4,
 * bottom-left 8. The two saddles join the inside diagonally, so a hull one
 * pixel thick at a corner stays one piece.
 */
const SEGMENTS: readonly (readonly [number, number])[][] = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [[0, 1], [2, 3]],
  [[0, 2]],
  [[3, 2]],
  [[2, 3]],
  [[0, 2]],
  [[3, 0], [1, 2]],
  [[1, 2]],
  [[3, 1]],
  [[0, 1]],
  [[3, 0]],
  [],
];

export function traceOutline(mask: Uint8Array, width: number, height: number): Outline {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;

  // Edge ids: a horizontal edge joins pixel (x, y) to (x + 1, y); a vertical
  // one joins (x, y) to (x, y + 1).
  const hEdge = (x: number, y: number): number => (y * width + x) * 2;
  const vEdge = (x: number, y: number): number => (y * width + x) * 2 + 1;

  const segA: number[] = [];
  const segB: number[] = [];
  const touching = new Map<number, number[]>();
  const link = (edge: number, segment: number): void => {
    const list = touching.get(edge);
    if (list) list.push(segment);
    else touching.set(edge, [segment]);
  };

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const code =
        (inside(x, y) ? 1 : 0) |
        (inside(x + 1, y) ? 2 : 0) |
        (inside(x + 1, y + 1) ? 4 : 0) |
        (inside(x, y + 1) ? 8 : 0);
      for (const [from, to] of SEGMENTS[code]!) {
        const edgeOf = (side: number): number =>
          side === 0 ? hEdge(x, y) : side === 1 ? vEdge(x + 1, y) : side === 2 ? hEdge(x, y + 1) : vEdge(x, y);
        const index = segA.length;
        const a = edgeOf(from);
        const b = edgeOf(to);
        segA.push(a);
        segB.push(b);
        link(a, index);
        link(b, index);
      }
    }
  }

  const pointOf = (edge: number): [number, number] => {
    const cell = edge >> 1;
    const x = cell % width;
    const y = (cell - x) / width;
    return edge & 1 ? [x + 0.5, y + 1] : [x + 1, y + 0.5];
  };

  const arc = new Float32Array(width * height).fill(-1);
  const loop = new Int32Array(width * height).fill(-1);
  const lengths: number[] = [];
  const used = new Uint8Array(segA.length);

  // The inside pixel on an edge: the edge always separates one inside pixel
  // from one outside one.
  const insidePixelOf = (edge: number): number => {
    const cell = edge >> 1;
    const x = cell % width;
    const y = (cell - x) / width;
    if (edge & 1) return inside(x, y) ? cell : (y + 1) * width + x;
    return inside(x, y) ? cell : y * width + x + 1;
  };

  for (let start = 0; start < segA.length; start++) {
    if (used[start]) continue;
    const loopIndex = lengths.length;
    let length = 0;
    let segment = start;
    // Walk out of the start segment's second edge and keep going until the
    // walk comes back to the edge it began on.
    const firstEdge = segA[start]!;
    let edge = segB[start]!;
    let previous = pointOf(firstEdge);
    const markEdge = (at: number, s: number): void => {
      const pixel = insidePixelOf(at);
      if (arc[pixel]! < 0) {
        arc[pixel] = s;
        loop[pixel] = loopIndex;
      }
    };
    markEdge(firstEdge, 0);
    for (let guard = 0; guard < segA.length + 1; guard++) {
      used[segment] = 1;
      const point = pointOf(edge);
      length += Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      previous = point;
      markEdge(edge, length);
      if (edge === firstEdge) break;
      const next = touching.get(edge)?.find((candidate) => candidate !== segment && !used[candidate]);
      if (next === undefined) break;
      segment = next;
      edge = segA[next] === edge ? segB[next]! : segA[next]!;
    }
    lengths.push(length);
  }

  return { arc, loop, lengths };
}
