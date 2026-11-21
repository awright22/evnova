/**
 * Exact Euclidean distance, and which site is nearest.
 *
 * Felzenszwalb and Huttenlocher's two-pass transform ("Distance Transforms of
 * Sampled Functions", 2012): a lower envelope of parabolas down each column,
 * then along each row. Linear in the number of pixels, exact rather than the
 * chamfer approximation, and it carries the nearest site through both passes
 * for free — which is what lets a hull's panel plates follow its outline.
 */

const FAR = 1e20;

/**
 * One row or column of the transform.
 *
 * `f` holds 0 at a site and FAR elsewhere on the first pass, and the squared
 * distances from the first pass on the second. Writes squared distances to
 * `d` and the index of the winning parabola to `arg`.
 */
function pass(
  f: Float64Array,
  n: number,
  d: Float64Array,
  arg: Int32Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
    arg[q] = v[k]!;
  }
}

export interface Nearest {
  /** Distance in pixels from each pixel to its nearest site. */
  readonly distance: Float32Array;
  /** Index (`y * width + x`) of that site, or -1 when there are no sites. */
  readonly site: Int32Array;
}

/**
 * Distance from every pixel to the nearest pixel where `isSite` is true.
 */
export function nearestSite(
  width: number,
  height: number,
  isSite: (index: number) => boolean,
): Nearest {
  const size = width * height;
  const columnSq = new Float64Array(size);
  const columnY = new Int32Array(size);

  const longest = Math.max(width, height);
  const f = new Float64Array(longest);
  const d = new Float64Array(longest);
  const arg = new Int32Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);

  // Down each column.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = isSite(y * width + x) ? 0 : FAR;
    pass(f, height, d, arg, v, z);
    for (let y = 0; y < height; y++) {
      columnSq[y * width + x] = d[y]!;
      columnY[y * width + x] = arg[y]!;
    }
  }

  const distance = new Float32Array(size);
  const site = new Int32Array(size);

  // Along each row, over the column results.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) f[x] = columnSq[row + x]!;
    pass(f, width, d, arg, v, z);
    for (let x = 0; x < width; x++) {
      const sq = d[x]!;
      if (sq >= FAR / 2) {
        distance[row + x] = Number.POSITIVE_INFINITY;
        site[row + x] = -1;
        continue;
      }
      const sx = arg[x]!;
      distance[row + x] = Math.sqrt(sq);
      site[row + x] = columnY[row + sx]! * width + sx;
    }
  }

  return { distance, site };
}

/**
 * Gaussian blur of a float field, separable, clamped at the edges.
 *
 * Used to smooth the hull's distance field — which turns pixel corners on a
 * chamfer into a pressed edge — to soften grooves into seams, and to round a
 * hull's crown. A narrow blur is a true Gaussian; a wide one is three box
 * passes with running sums (Wells, "Efficient synthesis of Gaussian filters
 * by cascaded uniform filters", 1986), which costs the same at any width and
 * is within a few percent of the Gaussian it stands in for.
 */
export function blur(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0) return field.slice();
  if (sigma > WIDE_SIGMA) return boxGauss(field, width, height, sigma);
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w;
    total += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / total;

  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const xi = Math.min(width - 1, Math.max(0, x + i));
        sum += field[row + xi]! * kernel[i + radius]!;
      }
      temp[row + x] = sum;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const yi = Math.min(height - 1, Math.max(0, y + i));
        sum += temp[yi * width + x]! * kernel[i + radius]!;
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

/** Beyond this, in pixels, a blur is done as box passes rather than a kernel. */
const WIDE_SIGMA = 3;

/** Widths of three box passes that together approximate a Gaussian. */
function boxWidths(sigma: number): number[] {
  const passes = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const lowerCount = Math.round(
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4),
  );
  return Array.from({ length: passes }, (_, i) => (i < lowerCount ? lower : upper));
}

function boxGauss(field: Float32Array, width: number, height: number, sigma: number): Float32Array {
  const a = field.slice();
  const b = new Float32Array(width * height);
  for (const size of boxWidths(sigma)) {
    const r = (size - 1) / 2;
    boxPass(a, b, width, height, r, 1, width);
    boxPass(b, a, height, width, r, width, 1);
  }
  return a;
}

/**
 * One box pass along lines of `length` samples `step` apart, `lines` of them
 * `stride` apart, with the ends clamped.
 */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  lines: number,
  length: number,
  r: number,
  stride: number,
  step: number,
): void {
  const scale = 1 / (2 * r + 1);
  const last = length - 1;
  for (let line = 0; line < lines; line++) {
    const start = line * stride;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[start + Math.min(last, Math.max(0, i)) * step]!;
    for (let k = 0; k < length; k++) {
      dst[start + k * step] = sum * scale;
      sum +=
        src[start + Math.min(last, k + r + 1) * step]! - src[start + Math.max(0, k - r) * step]!;
    }
  }
}
