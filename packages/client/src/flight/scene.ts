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
import { mix, palette, parseHex } from './palette.ts';
import { planetTexture, starTexture } from './planet.ts';
import { renderShipArt, TEXTURE_PX_PER_UNIT, type ShipArt } from './shipTexture.ts';

/** A round in flight, reckoned forward from its spawn. */
export interface ProjectileFrame {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly kind: number;
  readonly isMine: boolean;
}

/** Spilled cargo drifting in space. */
export interface CanisterFrame {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly inReach: boolean;
}

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
  /** Hit points per module, so damage draws on the module that took it. */
  readonly moduleHp: readonly number[];
  /** Current shields as a fraction of capacity, for the bubble. */
  readonly shieldFraction: number;
  readonly hostile: boolean;
  readonly isTarget: boolean;
  readonly writtenOff: boolean;
}

interface ShipNode {
  readonly root: Container;
  readonly hull: Sprite;
  readonly plume: Graphics;
  readonly art: ShipArt;
  /** Intact hit points per module, so damage can be drawn as a fraction. */
  readonly maxHp: readonly number[];
  lastThrottle: number;
}

export class Scene {
  readonly root = new Container();
  readonly camera: Camera;

  private readonly worldLayer = new Container();
  private readonly shipLayer = new Container();
  /** One Graphics for every round, canister and overlay: far fewer draw calls. */
  private readonly roundLayer = new Graphics();
  private readonly overlayLayer = new Graphics();
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
    this.worldLayer.addChild(this.shipLayer, this.roundLayer, this.overlayLayer);
    this.roundLayer.blendMode = 'add';
  }

  /** Put an effects layer into world space, above hulls and rounds. */
  attachEffects(view: Container): void {
    this.worldLayer.addChild(view);
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

    const blueprint = this.blueprints.get(frame.blueprint);
    const maxHp = blueprint
      ? blueprint.placements.map((placement) => this.modules.get(placement.moduleId)?.hitPoints ?? 1)
      : [];

    const node: ShipNode = { root, hull, plume, art, maxHp, lastThrottle: 0 };
    this.ships.set(frame.id, node);
    return node;
  }

  /** Update every ship, then the camera, then the backdrop. */
  update(
    frames: readonly ShipFrame[],
    self: ShipFrame | undefined,
    topSpeed: number,
    dtMs: number,
    rounds: readonly ProjectileFrame[] = [],
    canisters: readonly CanisterFrame[] = [],
  ): void {
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

    this.drawRounds(rounds, canisters);
    this.drawOverlays(frames, self);

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

  /** Rounds and canisters, all into one Graphics. */
  private drawRounds(
    rounds: readonly ProjectileFrame[],
    canisters: readonly CanisterFrame[],
  ): void {
    const p = palette();
    const g = this.roundLayer;
    g.clear();

    for (const round of rounds) {
      const x = round.x * PX_PER_UNIT;
      const y = round.y * PX_PER_UNIT;
      const cos = Math.cos(round.angle);
      const sin = Math.sin(round.angle);

      // A missile is a bright head with a long trail; a gun round is a short
      // tracer. The trail is drawn as a tapering ribbon behind the head.
      const missile = round.kind === 2;
      const length = (missile ? 26 : 16) * PX_PER_UNIT * 0.5;
      const colour = missile ? p.danger : round.isMine ? p.amberBright : p.amber;

      const segments = 8;
      for (let i = 0; i < segments; i++) {
        const t0 = i / segments;
        const t1 = (i + 1) / segments;
        const width = (1 - t0) * (missile ? 3 : 2);
        g.moveTo(x - cos * length * t0, y - sin * length * t0)
          .lineTo(x - cos * length * t1, y - sin * length * t1)
          .stroke({ width, color: colour, alpha: (1 - t0) * 0.7 });
      }

      g.circle(x, y, missile ? 3 : 2).fill({ color: mixToWhite(colour), alpha: 0.95 });
    }

    for (const canister of canisters) {
      const x = canister.x * PX_PER_UNIT;
      const y = canister.y * PX_PER_UNIT;
      const size = 3 * PX_PER_UNIT;
      g.rect(x - size / 2, y - size / 2, size, size).stroke({
        width: 1.5,
        color: canister.inReach ? p.amberBright : p.textMuted,
        alpha: canister.inReach ? 1 : 0.7,
      });
    }
  }

  /**
   * Damage, shields and the target bracket.
   *
   * Drawn in world space so they move with the hull, into one Graphics so the
   * cost does not scale with the number of modules on screen.
   */
  private drawOverlays(frames: readonly ShipFrame[], self: ShipFrame | undefined): void {
    const p = palette();
    const g = this.overlayLayer;
    g.clear();

    for (const frame of frames) {
      const node = this.ships.get(frame.id);
      if (!node || frame.writtenOff) continue;

      const cos = Math.cos(frame.angle);
      const sin = Math.sin(frame.angle);
      const originX = frame.x * PX_PER_UNIT;
      const originY = frame.y * PX_PER_UNIT;

      // Damage: scorch past half, a vented hole at zero.
      node.art.moduleRects.forEach((rect, index) => {
        const hp = frame.moduleHp[index];
        if (hp === undefined) return;
        const full = node.maxHp[index] ?? 1;
        const fraction = full > 0 ? hp / full : 1;
        if (fraction > 0.5) return;

        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const wx = originX + (cx * cos - cy * sin) * PX_PER_UNIT;
        const wy = originY + (cx * sin + cy * cos) * PX_PER_UNIT;
        const size = Math.min(rect.width, rect.height) * PX_PER_UNIT * 0.5;

        if (fraction <= 0) {
          // Disabled: a dark hole with a lit rim, venting.
          g.circle(wx, wy, size * 0.8).fill({ color: 0x05070b, alpha: 0.85 });
          g.circle(wx, wy, size * 0.8).stroke({ width: 1.5, color: p.danger, alpha: 0.8 });
        } else {
          g.circle(wx, wy, size * (1.1 - fraction)).fill({ color: 0x0a0c10, alpha: 0.5 });
        }
      });

      // Shield bubble, only while it is carrying something.
      if (frame.shieldFraction > 0.02) {
        const radius = Math.max(node.art.lengthUnits, node.art.widthUnits) * 0.62 * PX_PER_UNIT;
        g.circle(originX, originY, radius).stroke({
          width: 1,
          color: p.shield,
          alpha: 0.12 + 0.22 * frame.shieldFraction,
        });
      }

      // The mark: a bracket, and hostiles read red whatever their paint.
      if (frame.isTarget || (frame.hostile && !frame.isSelf)) {
        const radius = Math.max(node.art.lengthUnits, node.art.widthUnits) * 0.75 * PX_PER_UNIT;
        const colour = frame.hostile ? p.danger : p.amber;
        const alpha = frame.isTarget ? 1 : 0.45;
        const arm = radius * 0.4;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const cx = originX + sx * radius;
          const cy = originY + sy * radius;
          g.moveTo(cx - sx * arm, cy).lineTo(cx, cy).lineTo(cx, cy - sy * arm);
        }
        g.stroke({ width: frame.isTarget ? 2 : 1, color: colour, alpha });
      }
    }

    // Lead indicator: where to aim so a fixed gun's round and the mark meet.
    const mark = frames.find((f) => f.isTarget);
    if (self && mark && this.leadPointOf) {
      const lead = this.leadPointOf(self, mark);
      if (lead) {
        const lx = lead.x * PX_PER_UNIT;
        const ly = lead.y * PX_PER_UNIT;
        g.circle(lx, ly, 5).stroke({ width: 1.5, color: p.amber, alpha: 0.9 });
        g.moveTo(lx - 9, ly).lineTo(lx - 4, ly);
        g.moveTo(lx + 4, ly).lineTo(lx + 9, ly);
        g.moveTo(lx, ly - 9).lineTo(lx, ly - 4);
        g.moveTo(lx, ly + 4).lineTo(lx, ly + 9);
        g.stroke({ width: 1, color: p.amber, alpha: 0.7 });
      }
    }
  }

  /** Supplied by the flight loop, which knows the hull's muzzle velocity. */
  leadPointOf:
    | ((self: ShipFrame, mark: ShipFrame) => { x: number; y: number } | undefined)
    | undefined;

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

/** Push a colour toward white, for the hot head of a round. */
function mixToWhite(colour: number): number {
  return mix(colour, 0xffffff, 0.55);
}
