/**
 * The flight scene.
 *
 * Owns the Pixi display list: the backdrop, the system star, its ports, and a
 * sprite per ship with its engine plume. Reads positions through one idiom —
 * `predict.value(instance, field)` — which covers the local hull, which is
 * actively reconciled, and remote hulls, which are interpolated.
 */

import { Container, Graphics, Sprite, type Renderer } from 'pixi.js';
import { clamp, type Blueprint, type ModuleDef, type SystemDef } from '@marque/shared';

import { createBackdrop, type Backdrop } from './backdrop.ts';
import { Camera, PX_PER_UNIT } from './camera.ts';
import { palette, parseHex } from './palette.ts';
import { planetTexture, starTexture } from './planet.ts';
import { renderShipArt, TEXTURE_PX_PER_UNIT, type ShipArt } from './shipTexture.ts';

/** What the scene needs to know about one ship this frame. */
export interface ShipFrame {
  readonly id: string;
  readonly blueprint: string;
  readonly callsign: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  /** Velocity, for the camera's look-ahead and zoom. */
  readonly vx: number;
  readonly vy: number;
  /** 0..1, drives the plume. */
  readonly throttle: number;
  readonly isSelf: boolean;
}

interface ShipNode {
  readonly root: Container;
  readonly hull: Sprite;
  readonly plume: Graphics;
  readonly art: ShipArt;
  lastThrottle: number;
}

export class Scene {
  readonly root = new Container();
  readonly camera: Camera;

  private readonly worldLayer = new Container();
  private readonly shipLayer = new Container();
  private readonly backdrop: Backdrop;
  /** Advances with real time, so plume turbulence runs at a fixed rate. */
  private elapsedMs = 0;

  private readonly ships = new Map<string, ShipNode>();
  private readonly art = new Map<string, ShipArt>();

  /**
   * World objects with their radius, for culling. A star or a port off the
   * side of the screen still costs fill if it is submitted, and the star's
   * corona is larger than the viewport.
   */
  private readonly cullable: { node: Sprite; x: number; y: number; radius: number }[] = [];

  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: Renderer,
    private readonly system: SystemDef,
    private readonly blueprints: ReadonlyMap<string, Blueprint>,
    private readonly modules: ReadonlyMap<string, ModuleDef>,
    reducedMotion: boolean,
  ) {
    this.camera = new Camera(reducedMotion);

    this.backdrop = createBackdrop(system.region, system.id);
    this.root.addChild(this.backdrop.view);
    this.root.addChild(this.worldLayer);

    this.buildSystem();
    this.worldLayer.addChild(this.shipLayer);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** The star sits at the system's origin and lights everything from there. */
  private buildSystem(): void {
    const star = new Sprite(
      starTexture({
        diameterPx: this.system.star.radius * 2 * PX_PER_UNIT,
        colour: this.system.star.colour,
        coronaColour: this.system.star.coronaColour,
      }),
    );
    star.anchor.set(0.5);
    star.position.set(0, 0);
    star.blendMode = 'add';
    this.worldLayer.addChild(star);
    this.cullable.push({
      node: star,
      x: 0,
      y: 0,
      radius: this.system.star.radius * 1.5,
    });

    for (const port of this.system.ports) {
      // Each port is lit from the star, which is at the origin.
      const lightAngle = Math.atan2(-port.y, -port.x);
      const sprite = new Sprite(
        planetTexture({
          seed: `${this.system.id}:${port.id}`,
          diameterPx: port.radius * 2 * PX_PER_UNIT,
          surface: port.surfaceColour,
          accent: port.accentColour,
          lightAngle,
          lightTint: this.system.star.lightTint,
          inhabited: true,
        }),
      );
      sprite.anchor.set(0.5);
      sprite.position.set(port.x * PX_PER_UNIT, port.y * PX_PER_UNIT);
      this.worldLayer.addChild(sprite);
      this.cullable.push({ node: sprite, x: port.x, y: port.y, radius: port.radius * 1.25 });
    }
  }

  /** Texture for a draught, rendered once and shared by every hull flying it. */
  private artFor(blueprintId: string): ShipArt | undefined {
    const cached = this.art.get(blueprintId);
    if (cached) return cached;

    const blueprint = this.blueprints.get(blueprintId);
    if (!blueprint) return undefined;

    const art = renderShipArt(this.renderer, blueprint, this.modules, {
      lightTint: parseHex(this.system.star.lightTint) ?? 0xffffff,
    });
    this.art.set(blueprintId, art);
    return art;
  }

  private nodeFor(frame: ShipFrame): ShipNode | undefined {
    const existing = this.ships.get(frame.id);
    if (existing) return existing;

    const art = this.artFor(frame.blueprint);
    if (!art) return undefined;

    const root = new Container();
    const plume = new Graphics();
    const hull = new Sprite(art.texture);
    hull.anchor.set(art.anchorX, art.anchorY);
    // Textures are drawn at a larger scale than the world, so they stay crisp
    // when the camera zooms.
    hull.scale.set(PX_PER_UNIT / TEXTURE_PX_PER_UNIT);

    // The plume sits under the hull so the nozzle overlaps it.
    root.addChild(plume, hull);
    this.shipLayer.addChild(root);

    const node: ShipNode = { root, hull, plume, art, lastThrottle: 0 };
    this.ships.set(frame.id, node);
    return node;
  }

  /** Update every ship, then the camera, then the backdrop. */
  update(frames: readonly ShipFrame[], self: ShipFrame | undefined, topSpeed: number, dtMs: number): void {
    this.elapsedMs += dtMs;
    const seen = new Set<string>();

    for (const frame of frames) {
      const node = this.nodeFor(frame);
      if (!node) continue;
      seen.add(frame.id);

      node.root.position.set(frame.x * PX_PER_UNIT, frame.y * PX_PER_UNIT);
      node.root.rotation = frame.angle;
      this.drawPlume(node, frame.throttle, dtMs);
    }

    for (const [id, node] of this.ships) {
      if (seen.has(id)) continue;
      node.root.destroy({ children: true });
      this.ships.delete(id);
    }

    if (self) {
      this.camera.update(self.x, self.y, self.vx, self.vy, topSpeed, dtMs);
    }

    const { x, y, zoom, shakeX, shakeY } = this.camera.state;

    // Cull world objects outside the view. Submitting the star's corona when
    // it is off screen costs more fill than everything else in the scene.
    const halfW = this.width / 2 / (PX_PER_UNIT * zoom);
    const halfH = this.height / 2 / (PX_PER_UNIT * zoom);
    for (const item of this.cullable) {
      item.node.renderable =
        Math.abs(item.x - x) - item.radius < halfW && Math.abs(item.y - y) - item.radius < halfH;
    }

    this.worldLayer.scale.set(zoom);
    this.worldLayer.position.set(
      this.width / 2 - x * PX_PER_UNIT * zoom + shakeX,
      this.height / 2 - y * PX_PER_UNIT * zoom + shakeY,
    );
    this.backdrop.update(x * PX_PER_UNIT, y * PX_PER_UNIT, zoom, this.width, this.height);
  }

  /**
   * The engine plume, scaled by throttle.
   *
   * Drawn rather than sprited because its length changes every frame, and a
   * handful of triangles is cheaper than restretching a texture.
   */
  private drawPlume(node: ShipNode, throttle: number, dtMs: number): void {
    // Smooth the throttle so the plume does not pop between input frames.
    const target = clamp(throttle, 0, 1);
    const blend = 1 - Math.exp(-dtMs / 90);
    node.lastThrottle += (target - node.lastThrottle) * blend;
    const t = node.lastThrottle;

    const p = palette();
    const plume = node.plume;
    plume.clear();

    plume.blendMode = 'add';

    for (const nozzle of node.art.nozzles) {
      const aft = nozzle.x * PX_PER_UNIT;
      const across = nozzle.y * PX_PER_UNIT;
      const halfWidth = nozzle.halfWidth * PX_PER_UNIT;

      if (t < 0.02) {
        // A banked idle glow, so an engine never looks switched off.
        plume.circle(aft, across, halfWidth * 0.5).fill({ color: p.amberDim, alpha: 0.3 });
        continue;
      }

      // Length scales with throttle, per the art direction's plume recipe,
      // with a 12 Hz flutter so the flame is alive rather than a static cone.
      const flutter = 1 + Math.sin((this.elapsedMs / 1000) * 12 * Math.PI * 2 + across) * 0.06;
      const length = (18 + 46 * t) * (PX_PER_UNIT / 2) * flutter;

      // Bloom at the throat. An additive fill has no falloff of its own, so a
      // single circle reads as a flat disc with a visible edge; stacking a few
      // with decreasing alpha approximates the gradient cheaply.
      for (let ring = 3; ring >= 1; ring--) {
        plume.circle(aft - halfWidth * 0.2, across, halfWidth * (0.45 * ring)).fill({
          color: p.amber,
          alpha: 0.05 * t,
        });
      }

      // Outer, cooler envelope.
      plume
        .moveTo(aft, across - halfWidth)
        .lineTo(aft - length, across)
        .lineTo(aft, across + halfWidth)
        .closePath()
        .fill({ color: p.amber, alpha: 0.32 * t });

      // Hot core.
      plume
        .moveTo(aft, across - halfWidth * 0.45)
        .lineTo(aft - length * 0.62, across)
        .lineTo(aft, across + halfWidth * 0.45)
        .closePath()
        .fill({ color: p.amberBright, alpha: 0.85 * t });
    }
  }

  destroy(): void {
    for (const node of this.ships.values()) node.root.destroy({ children: true });
    this.ships.clear();
    for (const art of this.art.values()) art.texture.destroy(true);
    this.art.clear();
    this.backdrop.destroy();
    this.root.destroy({ children: true });
  }
}
