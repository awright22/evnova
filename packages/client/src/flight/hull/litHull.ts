/**
 * A baked hull, lit as it is drawn.
 *
 * The bake (`bake.ts`) produces a hull's material once per draught: colour,
 * normal and height, occlusion, shine, glow and livery weights. This uploads
 * those maps and draws them through a shader that lights them from the
 * system's star — from wherever the star actually lies relative to this hull,
 * turned into the hull's own frame, so the light stays where the star is while
 * the ship turns under it. A picture lit once would carry its highlight round
 * with it.
 *
 * The shader also does what the bake cannot know: whose hull it is. Livery is
 * painted from per-hull colours over the baked bands and stripes, the seal is
 * struck from a texture chosen per hull, and the Unlettered get no paint at
 * all on darker gunmetal. One texture set, many owners.
 */

import {
  BufferImageSource,
  GlProgram,
  Mesh,
  MeshGeometry,
  Shader,
  Texture,
  UniformGroup,
  type TextureSource,
} from 'pixi.js';

import type { HullBake } from './bake.ts';

const VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}
`;

const FRAGMENT = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uBase;
uniform sampler2D uShape;
uniform sampler2D uPaint;
uniform sampler2D uSeal;

uniform vec4 uColor;
uniform vec3 uLight;
uniform vec3 uSun;
uniform vec3 uAmbient;
uniform vec3 uRim;
uniform vec3 uLiveryA;
uniform vec3 uLiveryB;
uniform float uLiveryOn;
uniform vec3 uMetal;
uniform float uWreck;
uniform vec2 uTexel;
uniform float uHeightRange;
uniform vec4 uSealSpot;
uniform float uSealOn;
uniform vec3 uSealInk;

void main() {
  // Every fetch happens on every fragment, outside any branch that varies
  // across the quad: a mip level is chosen from screen-space derivatives, and
  // those are undefined inside divergent control flow.
  vec4 base = texture(uBase, vUV);
  vec4 shape = texture(uShape, vUV);
  vec4 paint = texture(uPaint, vUV);
  vec2 sealAt = (vUV - uSealSpot.xy) / uSealSpot.zw;
  float ink = texture(uSeal, clamp(sealAt * 0.5 + 0.5, 0.0, 1.0)).a;

  vec3 n = vec3(shape.rg * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  float h = shape.b;
  float ao = shape.a;

  // Paint over metal: the bake says where, this hull says what colour.
  float la = paint.b * uLiveryOn;
  float lb = paint.a * uLiveryOn;
  vec3 albedo = base.rgb * uMetal;
  albedo = mix(albedo, uLiveryA, la);
  albedo = mix(albedo, uLiveryB, lb);
  float struck = uSealOn * ink * step(dot(sealAt, sealAt), 1.0);
  albedo = mix(albedo, uSealInk, struck * 0.92);

  // Short shadows: walk toward the star over the height field, and darken
  // where something stands taller than the ray.
  float across = length(uLight.xy);
  vec2 toward = across > 1e-4 ? uLight.xy / across : vec2(1.0, 0.0);
  float rise = uLight.z / max(across, 1e-3);
  float shadow = 1.0;
  for (int i = 1; i <= 12; i++) {
    float run = float(i) * 2.0;
    float above = texture(uShape, vUV + toward * uTexel * run).b - (h + rise * run / uHeightRange);
    shadow = min(shadow, 1.0 - 0.7 * clamp(above * 30.0, 0.0, 1.0));
  }

  float ndl = max(dot(n, uLight), 0.0);
  vec3 halfway = normalize(uLight + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, halfway), 0.0), 36.0) * paint.r * (1.0 - 0.5 * max(la, lb));

  // Rims: warm on the edges turned to the star, cool on the edges turned
  // away, so a hull's far side still parts from the void.
  float steep = 1.0 - n.z;
  float flatLength = length(n.xy);
  vec2 flat2 = flatLength > 1e-4 ? n.xy / flatLength : vec2(0.0);
  float facing = dot(flat2, toward);
  float warmRim = pow(steep, 1.4) * max(facing, 0.0);
  float coolRim = pow(steep, 1.8) * max(-facing, 0.0);

  vec3 lit = albedo * (uAmbient * ao + uSun * ndl * shadow * (0.6 + 0.4 * ao))
    + uSun * (spec * shadow + warmRim * 0.5 * shadow)
    + uRim * coolRim * 0.55;

  float glow = paint.g * (1.0 - uWreck);
  vec3 colour = mix(lit, base.rgb * 1.4, glow);
  colour *= 1.0 - 0.62 * uWreck;

  // Premultiplied, and through the mesh's own tint and alpha so a hull can
  // fade like anything else on the stage.
  finalColor = vec4(colour, 1.0) * base.a * uColor;
}
`;

let program: GlProgram | undefined;
function hullProgram(): GlProgram {
  program ??= GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'marque-hull' });
  return program;
}

/** The maps of one baked hull, on the GPU, shared by every hull flying that draught. */
export interface HullMaterial {
  readonly base: TextureSource;
  readonly shape: TextureSource;
  readonly paint: TextureSource;
  readonly bake: HullBake;
  destroy(): void;
}

function upload(pixels: Uint8ClampedArray, width: number, height: number): TextureSource {
  return new BufferImageSource({
    resource: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
    width,
    height,
    format: 'rgba8unorm',
    alphaMode: 'no-premultiply-alpha',
    autoGenerateMipmaps: true,
    scaleMode: 'linear',
  });
}

export function uploadHull(bake: HullBake): HullMaterial {
  const base = upload(bake.base, bake.width, bake.height);
  const shape = upload(bake.shape, bake.width, bake.height);
  const paint = upload(bake.paint, bake.width, bake.height);
  return {
    base,
    shape,
    paint,
    bake,
    destroy: () => {
      base.destroy();
      shape.destroy();
      paint.destroy();
    },
  };
}

/** Elevation of the star's light above the plane of the system, in radians. */
const LIGHT_ELEVATION = (38 * Math.PI) / 180;

export interface HullLook {
  /** Primary and secondary livery, 0..1 RGB; ignored when `marked` is false. */
  readonly livery: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** False for a hull that carries no markings at all. */
  readonly marked: boolean;
  /** Multiplies the metal: 1,1,1 for bare plating, lower for gunmetal. */
  readonly metal: readonly [number, number, number];
  /** The seal to strike, and its ink, or undefined for none. */
  readonly seal: { readonly texture: Texture; readonly ink: readonly [number, number, number] } | undefined;
}

export interface LitHull {
  readonly mesh: Mesh<MeshGeometry, Shader>;
  /**
   * Point the light. `bearing` is the direction from the hull to the star in
   * world radians; `heading` is the hull's own rotation.
   */
  light(bearing: number, heading: number): void;
  look(look: HullLook): void;
  /** 0 for a sound hull, 1 for a write-off: darker, and nothing glows. */
  wreck(amount: number): void;
  destroy(): void;
}

/** Scene light: the star's tint, the fill in shadow, and the region's cool rim. */
export interface SceneLight {
  readonly sun: readonly [number, number, number];
  readonly ambient: readonly [number, number, number];
  readonly rim: readonly [number, number, number];
}

const EMPTY_SEAL = Texture.WHITE;

/**
 * Build a drawable, lit hull from an uploaded material.
 *
 * The mesh is a quad in texture pixels with its origin at `anchor`, so it
 * rotates about the centre of mass as the simulation does; scale it from
 * texture pixels to the world.
 */
export function createLitHull(
  material: HullMaterial,
  anchor: { readonly x: number; readonly y: number },
  scene: SceneLight,
): LitHull {
  const { bake } = material;
  const x0 = -anchor.x;
  const y0 = -anchor.y;
  const x1 = bake.width - anchor.x;
  const y1 = bake.height - anchor.y;
  const geometry = new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });

  const seal = bake.seal;
  const uniforms = new UniformGroup({
    uLight: { value: new Float32Array([0.6, -0.4, 0.62]), type: 'vec3<f32>' },
    uSun: { value: new Float32Array(scene.sun), type: 'vec3<f32>' },
    uAmbient: { value: new Float32Array(scene.ambient), type: 'vec3<f32>' },
    uRim: { value: new Float32Array(scene.rim), type: 'vec3<f32>' },
    uLiveryA: { value: new Float32Array([0.7, 0.7, 0.7]), type: 'vec3<f32>' },
    uLiveryB: { value: new Float32Array([0.4, 0.4, 0.4]), type: 'vec3<f32>' },
    uLiveryOn: { value: 1, type: 'f32' },
    uMetal: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uWreck: { value: 0, type: 'f32' },
    uTexel: { value: new Float32Array([1 / bake.width, 1 / bake.height]), type: 'vec2<f32>' },
    uHeightRange: { value: bake.heightRangePx, type: 'f32' },
    uSealSpot: {
      value: new Float32Array(
        seal
          ? [seal.x / bake.width, seal.y / bake.height, seal.radius / bake.width, seal.radius / bake.height]
          : [0, 0, 1, 1],
      ),
      type: 'vec4<f32>',
    },
    uSealOn: { value: 0, type: 'f32' },
    uSealInk: { value: new Float32Array([0.2, 0.2, 0.2]), type: 'vec3<f32>' },
  });

  const shader = new Shader({
    glProgram: hullProgram(),
    resources: {
      uBase: material.base,
      uShape: material.shape,
      uPaint: material.paint,
      uSeal: EMPTY_SEAL.source,
      hull: uniforms,
    },
  });

  const mesh = new Mesh({ geometry, shader });
  const values = uniforms.uniforms as {
    uLight: Float32Array;
    uLiveryA: Float32Array;
    uLiveryB: Float32Array;
    uLiveryOn: number;
    uMetal: Float32Array;
    uWreck: number;
    uSealOn: number;
    uSealInk: Float32Array;
  };

  return {
    mesh,
    light: (bearing, heading) => {
      const local = bearing - heading;
      const flat = Math.cos(LIGHT_ELEVATION);
      values.uLight[0] = Math.cos(local) * flat;
      values.uLight[1] = Math.sin(local) * flat;
      values.uLight[2] = Math.sin(LIGHT_ELEVATION);
    },
    look: (look) => {
      values.uLiveryA.set(look.livery[0]);
      values.uLiveryB.set(look.livery[1]);
      values.uLiveryOn = look.marked ? 1 : 0;
      values.uMetal.set(look.metal);
      if (look.seal && seal) {
        shader.resources.uSeal = look.seal.texture.source;
        values.uSealInk.set(look.seal.ink);
        values.uSealOn = 1;
      } else {
        values.uSealOn = 0;
      }
    },
    wreck: (amount) => {
      values.uWreck = amount;
    },
    destroy: () => {
      mesh.destroy();
      geometry.destroy();
      shader.destroy();
    },
  };
}
