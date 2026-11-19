/**
 * The space backdrop.
 *
 * Three parallax star layers, a dust layer and a nebula field in the region's
 * hue. Every layer is generated once into a wrapping tile and drawn as a
 * tiling sprite, so an unbounded starfield costs five draw calls however far
 * the ship travels.
 *
 * The nebula is value noise, domain-warped and screen-blended — never a linear
 * gradient, which is on the avoid list and reads as a web page rather than
 * space.
 */

import { Container, Texture, TilingSprite } from 'pixi.js';
import { Rng } from '@marque/shared';

import { palette, rgb } from './palette.ts';

const STAR_TILE = 1024;
const NEBULA_TILE = 512;

interface LayerSpec {
  readonly count: number;
  readonly parallax: number;
  readonly alpha: number;
  readonly maxSize: number;
  readonly flare: boolean;
}

/** Back to front. Closer layers are fewer, brighter and move more. */
const STAR_LAYERS: readonly LayerSpec[] = [
  { count: 900, parallax: 0.08, alpha: 0.35, maxSize: 1, flare: false },
  { count: 400, parallax: 0.18, alpha: 0.6, maxSize: 2, flare: false },
  { count: 120, parallax: 0.35, alpha: 0.9, maxSize: 2, flare: true },
];

const DUST: LayerSpec = { count: 260, parallax: 0.65, alpha: 0.25, maxSize: 1, flare: false };

export interface Backdrop {
  readonly view: Container;
  /** Move the backdrop to match the camera. */
  update(cameraX: number, cameraY: number, zoom: number, width: number, height: number): void;
  destroy(): void;
}

export function createBackdrop(region: string, seed: string): Backdrop {
  const view = new Container();
  view.label = 'backdrop';

  const nebula = new TilingSprite({
    texture: nebulaTexture(region, seed),
    width: 1,
    height: 1,
  });
  // Screen blending keeps the nebula behind the stars in feel: it lifts the
  // black rather than painting over it.
  nebula.blendMode = 'screen';
  nebula.alpha = 0.22;
  view.addChild(nebula);

  const layers: { sprite: TilingSprite; parallax: number; scale: number }[] = [];

  for (const [index, spec] of STAR_LAYERS.entries()) {
    const sprite = new TilingSprite({
      texture: starTexture(spec, `${seed}:stars:${index}`),
      width: 1,
      height: 1,
    });
    sprite.alpha = spec.alpha;
    view.addChild(sprite);
    layers.push({ sprite, parallax: spec.parallax, scale: 1 });
  }

  const dust = new TilingSprite({
    texture: starTexture(DUST, `${seed}:dust`),
    width: 1,
    height: 1,
  });
  dust.alpha = DUST.alpha;
  dust.blendMode = 'add';
  view.addChild(dust);
  layers.push({ sprite: dust, parallax: DUST.parallax, scale: 1 });

  return {
    view,

    update(cameraX, cameraY, zoom, width, height): void {
      // The backdrop is drawn in screen space and scrolled, so it never has to
      // move a sprite per star.
      nebula.width = width;
      nebula.height = height;
      nebula.tileScale.set(zoom * 4);
      nebula.tilePosition.set(-cameraX * 0.5 * zoom, -cameraY * 0.5 * zoom);

      for (const layer of layers) {
        layer.sprite.width = width;
        layer.sprite.height = height;
        layer.sprite.tileScale.set(zoom);
        layer.sprite.tilePosition.set(
          -cameraX * layer.parallax * zoom,
          -cameraY * layer.parallax * zoom,
        );
      }
    },

    destroy(): void {
      view.destroy({ children: true });
    },
  };
}

/** A wrapping tile of stars, drawn once into a canvas. */
function starTexture(spec: LayerSpec, seed: string): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TILE;
  canvas.height = STAR_TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');

  const rng = new Rng(seed);
  const p = palette();
  const [wr, wg, wb] = rgb(p.textPrimary);

  for (let i = 0; i < spec.count; i++) {
    const x = rng.range(0, STAR_TILE);
    const y = rng.range(0, STAR_TILE);
    const size = rng.next() < 0.82 ? 1 : spec.maxSize;
    // Stars are not all white: a slight spread reads as depth.
    const warmth = rng.range(-0.12, 0.12);
    const r = Math.round(wr * (1 + warmth));
    const g = Math.round(wg);
    const b = Math.round(wb * (1 - warmth));
    const brightness = rng.range(0.5, 1);

    ctx.fillStyle = `rgba(${r},${g},${b},${brightness})`;
    ctx.fillRect(x, y, size, size);

    // The nearest layer gets a faint cross flare on its brightest points.
    if (spec.flare && brightness > 0.86) {
      ctx.fillStyle = `rgba(${r},${g},${b},${brightness * 0.28})`;
      ctx.fillRect(x - 2, y, 5, 1);
      ctx.fillRect(x, y - 2, 1, 5);
    }
  }

  return Texture.from(canvas);
}

/**
 * A wrapping nebula tile: two octaves of value noise, domain-warped, tinted to
 * the region hue.
 */
function nebulaTexture(region: string, seed: string): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = NEBULA_TILE;
  canvas.height = NEBULA_TILE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');

  const rng = new Rng(`${seed}:nebula`);
  const coarse = noiseField(rng, 8);
  const fine = noiseField(rng, 16);
  const warp = noiseField(rng, 4);

  const p = palette();
  const hue =
    region === 'concessions'
      ? p.nebulaConcessions
      : region === 'marque'
        ? p.nebulaMarque
        : p.nebulaHomeRoads;
  const [hr, hg, hb] = rgb(hue);

  const image = ctx.createImageData(NEBULA_TILE, NEBULA_TILE);
  const data = image.data;

  for (let y = 0; y < NEBULA_TILE; y++) {
    for (let x = 0; x < NEBULA_TILE; x++) {
      const u = x / NEBULA_TILE;
      const v = y / NEBULA_TILE;

      // Domain warp: sample the field at a position pushed around by another
      // field. This is what stops it looking like blurred noise.
      const wu = u + (sampleWrapped(warp, 4, u, v) - 0.5) * 0.35;
      const wv = v + (sampleWrapped(warp, 4, v, u) - 0.5) * 0.35;

      const value =
        sampleWrapped(coarse, 8, wu, wv) * 0.65 + sampleWrapped(fine, 16, wu, wv) * 0.35;

      // Push the midtones down so the field is mostly empty space with a few
      // dense regions, rather than an even haze.
      const density = Math.max(0, value - 0.42) / 0.58;
      const shaped = density * density;

      const index = (y * NEBULA_TILE + x) * 4;
      data[index] = hr;
      data[index + 1] = hg;
      data[index + 2] = hb;
      data[index + 3] = Math.round(shaped * 255);
    }
  }

  ctx.putImageData(image, 0, 0);
  return Texture.from(canvas);
}

/** A wrapping grid of random values, for bilinear sampling. */
function noiseField(rng: Rng, size: number): Float32Array {
  const field = new Float32Array(size * size);
  for (let i = 0; i < field.length; i++) field[i] = rng.next();
  return field;
}

/** Bilinear sample of a wrapping field, with smoothstep interpolation. */
function sampleWrapped(field: Float32Array, size: number, u: number, v: number): number {
  const fx = ((u % 1) + 1) % 1 * size;
  const fy = ((v % 1) + 1) % 1 * size;

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = (x0 + 1) % size;
  const y1 = (y0 + 1) % size;

  const tx = smoothstep(fx - x0);
  const ty = smoothstep(fy - y0);

  const a = field[y0 * size + x0] ?? 0;
  const b = field[y0 * size + x1] ?? 0;
  const c = field[y1 * size + x0] ?? 0;
  const d = field[y1 * size + x1] ?? 0;

  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
