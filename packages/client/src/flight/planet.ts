/**
 * Procedural planets and stars.
 *
 * A port is a lit sphere with a softened terminator, two octaves of surface
 * noise, an atmospheric rim lit by the system star, and night-side lights where
 * people live. Generated into a canvas once per port, never a photograph.
 */

import { Texture } from 'pixi.js';
import { Rng } from '@marque/shared';

import { darken, lighten, mix, palette, parseHex, rgb } from './palette.ts';

export interface PlanetOptions {
  readonly seed: string;
  readonly diameterPx: number;
  readonly surface: string;
  readonly accent: string;
  /** Direction the star lies in, radians. */
  readonly lightAngle: number;
  readonly lightTint: string;
  /** Night-side settlement lights. */
  readonly inhabited: boolean;
}

export function planetTexture(options: PlanetOptions): Texture {
  const size = Math.max(64, Math.round(options.diameterPx));
  // A margin for the atmosphere halo, which extends past the disc.
  const pad = Math.round(size * 0.12);
  const canvas = document.createElement('canvas');
  canvas.width = size + pad * 2;
  canvas.height = size + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');

  const rng = new Rng(options.seed);
  const radius = size / 2;
  const cx = radius + pad;
  const cy = radius + pad;

  const surface = parseHex(options.surface) ?? 0x8fa2b8;
  const accent = parseHex(options.accent) ?? 0x5e86b8;
  const tint = parseHex(options.lightTint) ?? 0xdce8f5;

  const lx = Math.cos(options.lightAngle);
  const ly = Math.sin(options.lightAngle);

  // Two octaves of value noise over the disc, sampled per pixel.
  const coarse = field(rng, 10);
  const fine = field(rng, 22);

  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  const lit = mix(surface, tint, 0.22);
  const shadow = darken(surface, 0.86);
  const [nr, ng, nb] = rgb(mix(accent, 0xffd9a0, 0.5));

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const dx = (x - cx) / radius;
      const dy = (y - cy) / radius;
      const d2 = dx * dx + dy * dy;
      const index = (y * canvas.width + x) * 4;

      if (d2 > 1) {
        // Outside the disc: a thin atmospheric rim, brightest on the lit limb.
        const d = Math.sqrt(d2);
        const halo = Math.max(0, 1 - (d - 1) / 0.12);
        if (halo > 0) {
          const facing = Math.max(0, dx * lx + dy * ly);
          const [ar, ag, ab] = rgb(mix(accent, tint, 0.4));
          data[index] = ar;
          data[index + 1] = ag;
          data[index + 2] = ab;
          data[index + 3] = Math.round(halo * halo * (0.25 + facing * 0.65) * 190);
        }
        continue;
      }

      // Surface normal of a sphere, for the terminator.
      const dz = Math.sqrt(Math.max(0, 1 - d2));
      const lambert = dx * lx + dy * ly + dz * 0.35;
      // Soften the terminator rather than letting it fall to a hard edge.
      const light = Math.max(0, Math.min(1, (lambert + 0.18) / 1.1));
      const softened = light * light * (3 - 2 * light);

      const n =
        sample(coarse, 10, (dx + 1) / 2, (dy + 1) / 2) * 0.68 +
        sample(fine, 22, (dx + 1) / 2, (dy + 1) / 2) * 0.32;

      const base = mix(shadow, lit, softened);
      const shaded = mix(base, n > 0.52 ? lighten(base, 0.16) : darken(base, 0.14), 0.75);
      const [r, g, b] = rgb(shaded);

      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;

      // Night-side lights, thickest just past the terminator where towns sit.
      if (options.inhabited && softened < 0.24) {
        const density = (0.24 - softened) / 0.24;
        if (n > 0.62 && rng.next() < density * 0.1) {
          data[index] = Math.min(255, data[index] + nr * 0.7);
          data[index + 1] = Math.min(255, data[index + 1]! + ng * 0.7);
          data[index + 2] = Math.min(255, data[index + 2]! + nb * 0.7);
        }
      }

      // Limb darkening, so the disc reads as a sphere.
      const limb = 1 - Math.pow(Math.sqrt(d2), 6) * 0.35;
      data[index] = Math.round(data[index] * limb);
      data[index + 1] = Math.round(data[index + 1]! * limb);
      data[index + 2] = Math.round(data[index + 2]! * limb);
    }
  }

  ctx.putImageData(image, 0, 0);
  return Texture.from(canvas);
}

/** The system star: a hot core, a corona falloff and a faint bloom. */
export function starTexture(options: {
  diameterPx: number;
  colour: string;
  coronaColour: string;
}): Texture {
  const size = Math.max(64, Math.round(options.diameterPx));
  // The corona extends past the disc, but every pixel of it is additively
  // blended every frame, so the halo is kept tight rather than generous.
  const pad = Math.round(size * 0.45);
  const canvas = document.createElement('canvas');
  canvas.width = size + pad * 2;
  canvas.height = size + pad * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const core = options.colour;
  const corona = options.coronaColour;

  // Corona: a radial falloff, additive over space.
  const glow = ctx.createRadialGradient(cx, cy, size * 0.42, cx, cy, size * 0.5 + pad);
  glow.addColorStop(0, hexToRgba(corona, 0.55));
  glow.addColorStop(0.25, hexToRgba(corona, 0.18));
  glow.addColorStop(0.6, hexToRgba(corona, 0.05));
  glow.addColorStop(1, hexToRgba(corona, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Disc, with a slightly hotter centre.
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  disc.addColorStop(0, '#ffffff');
  disc.addColorStop(0.55, core);
  disc.addColorStop(1, corona);
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();

  return Texture.from(canvas);
}

function hexToRgba(hex: string, alpha: number): string {
  const value = parseHex(hex) ?? palette().amber;
  const [r, g, b] = rgb(value);
  return `rgba(${r},${g},${b},${alpha})`;
}

function field(rng: Rng, size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = rng.next();
  return out;
}

function sample(f: Float32Array, size: number, u: number, v: number): number {
  const fx = Math.max(0, Math.min(0.999, u)) * size;
  const fy = Math.max(0, Math.min(0.999, v)) * size;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = f[y0 * size + x0] ?? 0;
  const b = f[y0 * size + x1] ?? 0;
  const c = f[y1 * size + x0] ?? 0;
  const d = f[y1 * size + x1] ?? 0;
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
