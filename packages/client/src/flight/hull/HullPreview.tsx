/**
 * A hull, drawn small, the way it will fly.
 *
 * The Yard shows a captain what their colours will look like on the draught
 * in front of them, and the only honest picture of that is the flight view's
 * own: the same bake, the same lit material, the same paint rule. One
 * offscreen renderer serves every preview on the page; each draw is
 * extracted into the preview's own canvas, so nothing here holds a WebGL
 * context per component.
 */

import { useEffect, useRef } from 'react';
import { autoDetectRenderer, Container, Rectangle, type Renderer } from 'pixi.js';
import { content, type Blueprint } from '@marque/shared';

import { palette } from '../palette.ts';
import { bakeKey, hullBakery } from './bakery.ts';
import { hullArtOf, lookOf, sceneLight, type Allegiance, type HullArt } from './hullArt.ts';
import { createLitHull } from './litHull.ts';

let rendering: Promise<Renderer> | undefined;
function previewRenderer(): Promise<Renderer> {
  rendering ??= autoDetectRenderer({
    preference: 'webgl',
    antialias: false,
    backgroundAlpha: 0,
    width: 16,
    height: 16,
  });
  return rendering;
}

/** Materials kept on the preview renderer, most recently drawn last. */
const KEEP = 6;
const kept = new Map<string, HullArt>();
function artFor(blueprint: Blueprint): HullArt | undefined {
  const key = bakeKey(blueprint);
  const ready = kept.get(key);
  if (ready) {
    kept.delete(key);
    kept.set(key, ready);
    return ready;
  }
  const { modules } = content();
  const bake = hullBakery(modules).get(blueprint);
  if (!bake) return undefined;
  const art = hullArtOf(bake, blueprint, modules);
  kept.set(key, art);
  while (kept.size > KEEP) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.get(oldest)?.material.destroy();
    kept.delete(oldest);
  }
  return art;
}

/** Up and to the left, the way a picture is lit. Radians, from hull to star. */
const STAR = (-135 * Math.PI) / 180;
/** How often to look again while the bakery still has the hull in the oven. */
const WAIT_MS = 120;

export function HullPreview({
  blueprint,
  dress,
  width,
  height,
  label,
}: {
  readonly blueprint: Blueprint;
  readonly dress: Allegiance;
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** What the picture shows, for anyone who cannot see it. */
  readonly label: string;
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const dressKey = JSON.stringify(dress);
  const key = bakeKey(blueprint);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const draw = async (): Promise<void> => {
      const renderer = await previewRenderer();
      if (cancelled) return;
      const art = artFor(blueprint);
      if (!art) {
        // A grid the bakery refused stays refused; it has said why on the console.
        if (hullBakery(content().modules).failure(blueprint) !== undefined) return;
        timer = setTimeout(() => void draw(), WAIT_MS);
        return;
      }
      const { bake } = art.material;
      const hull = createLitHull(art.material, art.anchor, sceneLight(0xfff1dc, palette().nebulaHomeRoads));
      hull.light(STAR, 0);
      hull.look(lookOf(dress));
      const scale = Math.min(width / bake.width, height / bake.height);
      hull.mesh.scale.set(scale);
      hull.mesh.position.set(
        width / 2 - (bake.width / 2 - art.anchor.x) * scale,
        height / 2 - (bake.height / 2 - art.anchor.y) * scale,
      );
      const stage = new Container();
      stage.addChild(hull.mesh);
      const canvas = renderer.extract.canvas({
        target: stage,
        frame: new Rectangle(0, 0, width, height),
        resolution: window.devicePixelRatio || 1,
        clearColor: [0, 0, 0, 0],
      }) as HTMLCanvasElement;
      hull.destroy();
      stage.destroy();
      if (cancelled || !holder.current) return;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      holder.current.replaceChildren(canvas);
    };

    void draw();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // The blueprint and dress are read through their keys: a new object for
    // the same grid and the same colours is not a new picture.
  }, [key, dressKey, width, height]);

  return <div className="hull-preview" ref={holder} role="img" aria-label={label} style={{ width, height }} />;
}
