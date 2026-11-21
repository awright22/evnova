/**
 * The flight scene.
 *
 * Owns the Pixi display list: the backdrop, the system star, its ports, a
 * sprite per ship with its engine plume, and the beams held off their mounts.
 * Reads positions through one idiom —
 * `predict.value(instance, field)` — which covers the local hull, which is
 * actively reconciled, and remote hulls, which are interpolated.
 */

import { Container, Graphics, Sprite, type Renderer } from 'pixi.js';
import {
  clamp,
  mountsOf,
  placeAll,
  wrapAngle,
  type Blueprint,
  type ModuleDef,
  type Mount,
  type SystemDef,
} from '@marque/shared';

import { createBackdrop, type Backdrop } from './backdrop.ts';
import { Camera, PX_PER_UNIT } from './camera.ts';
import {
  approachLevel,
  beamRipple,
  beamSegment,
  easeEmphasis,
  easeExit,
  motion,
  type BeamFrame,
} from './beams.ts';
import { mix, palette, parseHex } from './palette.ts';
import { planetTexture, starTexture } from './planet.ts';
import { rockShape, rockWear, type RockShape } from './rock.ts';
import { hullBakery, type Bakery } from './hull/bakery.ts';
import {
  freighterAllegiance,
  hullArtOf,
  lookOf,
  sceneLightOf,
  type Allegiance,
  type HullArt,
  type ModuleRect,
  type Nozzle,
} from './hull/hullArt.ts';
import { createLitHull, type LitHull, type SceneLight } from './hull/litHull.ts';
import type { HullBook } from './hulls.ts';
import { renderShipArt, TEXTURE_PX_PER_UNIT, type ShipArt } from './shipTexture.ts';

/**
 * `?hulls=tiles` draws hulls with the old tile renderer, for comparison while
 * the sculpted one is judged against it.
 */
const TILE_HULLS =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('hulls') === 'tiles';

/** What the scene needs of a hull's art, whichever renderer drew it. */
interface ShipGeometry {
  readonly lengthUnits: number;
  readonly widthUnits: number;
  readonly nozzles: readonly Nozzle[];
  readonly moduleRects: readonly ModuleRect[];
}

export type { BeamFrame } from './beams.ts';

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

/** A rock in a belt, as the wire gives it. */
export interface RockFrame {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly left: number;
  readonly whole: number;
  readonly seed: number;
}

/** What the scene needs to know about one ship this frame. */
export interface ShipFrame {
  readonly id: string;
  readonly blueprint: string;
  /** A built hull's grid, as a share code; empty for a catalogue draught. */
  readonly hull: string;
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
  /** A patrol of the Prize Court. */
  readonly patrol: boolean;
  /** Posted by the Prize Court. */
  readonly posted: boolean;
  /** A company freighter, which flies its berth's charter livery. */
  readonly freighter: boolean;
  readonly isTarget: boolean;
  readonly writtenOff: boolean;
}

interface ShipNode {
  readonly root: Container;
  readonly plume: Graphics;
  readonly art: ShipGeometry;
  /** The lit hull; absent when the tile renderer is drawing. */
  readonly lit: LitHull | undefined;
  /** Intact hit points per module, so damage can be drawn as a fraction. */
  readonly maxHp: readonly number[];
  lastThrottle: number;
}

/**
 * A beam's animation state, which the wire does not carry.
 *
 * The entry on the wire is only there while the trigger is down, so the rise
 * and fall have to be kept here, along with the last geometry the wire gave:
 * a beam that has just been let go has to have somewhere to fall from.
 */
interface BeamNode {
  /** 0..1, advanced linearly and eased when it is drawn. */
  level: number;
  /** True when the entry was still on the wire this frame. */
  holding: boolean;
  readonly owner: string;
  readonly mount: number;
  angle: number;
  length: number;
  hitting: boolean;
}

/**
 * The soft surround of a beam, as passes of width and alpha.
 *
 * An additive stroke has no falloff of its own, so the edge is three passes
 * narrowing toward the core — the same trick the plume's throat uses, and the
 * bloom the art direction allows a weapon. Drawn rather than filtered: a blur
 * pass per beam would cost a render target in a scene budgeted for a screen
 * full of hulls.
 */
const BEAM_SURROUND = [
  { width: 8, alpha: 0.06 },
  { width: 4.5, alpha: 0.11 },
  { width: 2.6, alpha: 0.28 },
] as const;

/** Core width in pixels at full level, before heft and the ripple. */
const BEAM_CORE_PX = 1.9;

/**
 * Damage a beam deals per second at the reference weight.
 *
 * A lance built as a weapon and a yard's plate cutter on a mount are both
 * beams, and a captain should be able to see which one is on them. The number
 * is only a divisor for the drawn width — what the beam actually does is the
 * server's, out of the module data.
 */
const BEAM_REFERENCE_DAMAGE = 40;

/**
 * Segments the core is drawn in.
 *
 * Enough for the wander to read along a beam that crosses the screen, few
 * enough that a hull holding two of them costs about what one missile's trail
 * costs.
 */
const BEAM_SEGMENTS = 12;

/** How far the grid overlay's outlines sit inside each module, in world units. */
const GRID_INSET = 0.5;

export class Scene {
  readonly root = new Container();
  readonly camera: Camera;

  private readonly worldLayer = new Container();
  private readonly shipLayer = new Container();
  /** One Graphics for every round, canister and overlay: far fewer draw calls. */
  private readonly rockLayer = new Graphics();
  private readonly rockShapes = new Map<string, RockShape>();
  /** Where this frame's beams land, in world units, for the rocks under them. */
  private readonly beamHits: { x: number; y: number }[] = [];
  private readonly roundLayer = new Graphics();
  /** Beams draw over hulls and rounds, under the brackets and readouts. */
  private readonly beamLayer = new Graphics();
  private readonly overlayLayer = new Graphics();
  private readonly backdrop: Backdrop;
  /** Advances with real time, so plume turbulence runs at a fixed rate. */
  private elapsedMs = 0;

  private readonly ships = new Map<string, ShipNode>();
  private readonly art = new Map<string, ShipArt>();
  /** Baked hulls on this renderer, one per draught, shared by every hull flying it. */
  private readonly hullArt = new Map<string, HullArt>();
  private readonly bakery: Bakery;
  /** The star's light on the hulls: its tint, the fill in shadow, the region's rim. */
  private readonly light: SceneLight;
  /** Beams that are up or still fading, keyed by their wire key. */
  private readonly beamNodes = new Map<string, BeamNode>();
  /** Mounts per draught, resolved once: a flying hull's grid cannot change. */
  private readonly mountBooks = new Map<string, readonly Mount[]>();
  /** Reused index from hull id to this frame's pose, so beams cost no scan. */
  private readonly poses = new Map<string, ShipFrame>();

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
    private readonly blueprints: HullBook,
    private readonly modules: ReadonlyMap<string, ModuleDef>,
    private readonly reducedMotion: boolean,
  ) {
    this.camera = new Camera(reducedMotion);
    this.bakery = hullBakery(modules);
    this.light = sceneLightOf(system);
    // The draughts the game ships with fly in every system: have them out of
    // the oven before the first one jumps in.
    if (!TILE_HULLS) this.bakery.prepare(blueprints.catalogueDraughts());

    this.backdrop = createBackdrop(system.region, system.id);
    this.root.addChild(this.backdrop.view);
    this.root.addChild(this.worldLayer);

    this.buildSystem();
    // Rocks are furniture: under the hulls, over the backdrop, and not
    // additive — a rock is a thing in the way, not a thing giving off light.
    this.worldLayer.addChild(
      this.rockLayer,
      this.shipLayer,
      this.roundLayer,
      this.beamLayer,
      this.overlayLayer,
    );
    this.roundLayer.blendMode = 'add';
    this.beamLayer.blendMode = 'add';
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

  /**
   * A draught's baked hull on this renderer, or undefined while the bakery
   * still has it in the oven: the hull is drawn from the frame it is ready.
   */
  private hullArtFor(blueprint: Blueprint): HullArt | undefined {
    const cached = this.hullArt.get(blueprint.id);
    if (cached) return cached;
    const bake = this.bakery.get(blueprint);
    if (!bake) return undefined;
    const art = hullArtOf(bake, blueprint, this.modules);
    this.hullArt.set(blueprint.id, art);
    return art;
  }

  /**
   * Who a hull flies for, as far as its paint goes. A patrol is the Prize
   * Court's; any other hostile is Unlettered; a freighter is its berth's
   * charter's; everyone else is a captain in their own colours.
   */
  private allegianceOf(frame: ShipFrame, blueprint: Blueprint): Allegiance {
    if (frame.patrol) return { kind: 'court' };
    if (frame.hostile) return { kind: 'unlettered' };
    if (frame.freighter) return freighterAllegiance(this.system, frame.id);
    return { kind: 'captain', paint: blueprint.paint };
  }

  private nodeFor(frame: ShipFrame): ShipNode | undefined {
    const existing = this.ships.get(frame.id);
    if (existing) return existing;

    const blueprint = this.blueprints.get(frame.blueprint);
    if (!blueprint) return undefined;

    const root = new Container();
    const plume = new Graphics();
    let art: ShipGeometry;
    let lit: LitHull | undefined;

    if (TILE_HULLS) {
      const tiles = this.artFor(frame.blueprint);
      if (!tiles) return undefined;
      const hull = new Sprite(tiles.texture);
      hull.anchor.set(tiles.anchorX, tiles.anchorY);
      // Textures are drawn at a larger scale than the world, so they stay
      // crisp when the camera zooms.
      hull.scale.set(PX_PER_UNIT / TEXTURE_PX_PER_UNIT);
      root.addChild(plume, hull);
      art = tiles;
    } else {
      const sculpted = this.hullArtFor(blueprint);
      if (!sculpted) return undefined;
      lit = createLitHull(sculpted.material, sculpted.anchor, this.light);
      lit.look(lookOf(this.allegianceOf(frame, blueprint)));
      lit.mesh.scale.set(PX_PER_UNIT / sculpted.texturePxPerUnit);
      // The plume sits under the hull so the nozzle overlaps it.
      root.addChild(plume, lit.mesh);
      art = sculpted;
    }
    this.shipLayer.addChild(root);

    const maxHp = blueprint.placements.map((placement) => this.modules.get(placement.moduleId)?.hitPoints ?? 1);

    const node: ShipNode = { root, plume, art, lit, maxHp, lastThrottle: 0 };
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
    beams: readonly BeamFrame[] = [],
    rocks: readonly RockFrame[] = [],
  ): void {
    this.elapsedMs += dtMs;
    const seen = new Set<string>();

    for (const frame of frames) {
      const node = this.nodeFor(frame);
      if (!node) continue;
      seen.add(frame.id);

      node.root.position.set(frame.x * PX_PER_UNIT, frame.y * PX_PER_UNIT);
      node.root.rotation = frame.angle;
      // The star is at the origin: light each hull from where it actually
      // lies, in the hull's own frame, so the highlight stays put as it turns.
      node.lit?.light(Math.atan2(-frame.y, -frame.x), frame.angle);
      node.lit?.wreck(frame.writtenOff ? 1 : 0);
      this.drawPlume(node, frame.throttle, dtMs);
    }

    for (const [id, node] of this.ships) {
      if (seen.has(id)) continue;
      node.lit?.destroy();
      node.root.destroy({ children: true });
      this.ships.delete(id);
    }

    // Beams before rocks, though rocks are under them: a rock being cut is
    // drawn differently, and only the beams know where they land. The layers
    // are separate objects, so what is drawn first is not what is on top.
    this.drawBeams(beams, frames, dtMs);
    this.drawRocks(rocks);
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
  /**
   * The belt.
   *
   * Rocks never move and never appear, so this would be a build-once layer
   * if they did not wear: one is redrawn when a rig has been at it, and the
   * cheapest way to keep that honest is to rebuild the lot each frame. A
   * dozen lumpy polygons is less work than one ship.
   *
   * Each is lit from the star at the origin, like the berths are, and the
   * bare ones read smaller and duller so a captain can see from across the
   * belt which somebody has already worked.
   */
  private drawRocks(rocks: readonly RockFrame[]): void {
    /** A grey at a given brightness, which is all a rock is. */
    const shade = (colour: number, level: number): number =>
      mix(0x000000, colour, clamp(level, 0, 1));

    const g = this.rockLayer;
    g.clear();
    if (rocks.length === 0) return;

    const p = palette();

    for (const rock of rocks) {
      const shape = this.rockShapeFor(rock);
      const wear = rockWear(rock.left, rock.whole);
      const x = rock.x * PX_PER_UNIT;
      const y = rock.y * PX_PER_UNIT;
      const step = (Math.PI * 2) / shape.radii.length;

      // The body, as the lumpy outline the seed gives it.
      shape.radii.forEach((radius, index) => {
        const bearing = index * step;
        const px = x + Math.cos(bearing) * radius * wear.scale * PX_PER_UNIT;
        const py = y + Math.sin(bearing) * radius * wear.scale * PX_PER_UNIT;
        if (index === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath().fill({ color: shade(p.hull, 0.27 * wear.tint), alpha: 1 });

      // The lit edge: an arc on the side facing the star, which is what
      // makes a flat polygon read as a thing with a far side.
      const lit = shape.radii.length;
      for (let index = 0; index < lit; index += 1) {
        const bearing = index * step;
        const toStar = Math.abs(wrapAngle(bearing - shape.lightAngle));
        if (toStar > Math.PI / 2) continue;

        const next = (index + 1) % lit;
        const r0 = shape.radii[index]! * wear.scale * PX_PER_UNIT;
        const r1 = shape.radii[next]! * wear.scale * PX_PER_UNIT;
        g.moveTo(x + Math.cos(bearing) * r0, y + Math.sin(bearing) * r0)
          .lineTo(x + Math.cos(bearing + step) * r1, y + Math.sin(bearing + step) * r1)
          .stroke({
            width: 2,
            color: shade(p.hull, 0.8 * wear.tint),
            // Brightest where it faces the star, falling off to the terminator.
            alpha: 0.85 * Math.cos(toStar),
          });
      }

      // A rig at work throws the cut face into relief.
      if (this.cutting(rock)) {
        g.circle(x, y, rock.radius * wear.scale * PX_PER_UNIT * 1.12).stroke({
          width: 1,
          color: p.amberDim,
          alpha: 0.5,
        });
      }
    }
  }

  /** Whether one of this frame's beams is landing on this rock. */
  private cutting(rock: RockFrame): boolean {
    for (const hit of this.beamHits) {
      if (Math.hypot(hit.x - rock.x, hit.y - rock.y) <= rock.radius * 1.4) return true;
    }
    return false;
  }

  /** A rock's outline, worked out once and kept: rocks do not change shape. */
  private rockShapeFor(rock: RockFrame): RockShape {
    const cached = this.rockShapes.get(rock.id);
    if (cached) return cached;
    const shape = rockShape(rock.seed, rock.radius, rock.x, rock.y);
    this.rockShapes.set(rock.id, shape);
    return shape;
  }

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
   * Held beams, all into one Graphics.
   *
   * A beam is state rather than an event: its entry exists for as long as the
   * trigger is down, so there is nothing to spawn and nothing to expire. The
   * line is rebuilt from the owner's pose every frame — which is what keeps it
   * welded to a mount while the hull turns — and the only thing carried
   * between frames is how far through its rise or fall it is.
   */
  private drawBeams(
    beams: readonly BeamFrame[],
    frames: readonly ShipFrame[],
    dtMs: number,
  ): void {
    const g = this.beamLayer;
    g.clear();
    this.beamHits.length = 0;
    if (beams.length === 0 && this.beamNodes.size === 0) return;

    this.poses.clear();
    for (const frame of frames) this.poses.set(frame.id, frame);

    // Anything still on the wire is marked below; what is left unmarked was
    // let go this tick and starts falling.
    for (const node of this.beamNodes.values()) node.holding = false;

    for (const beam of beams) {
      let node = this.beamNodes.get(beam.id);
      if (!node) {
        node = {
          level: 0,
          holding: true,
          owner: beam.owner,
          mount: beam.mount,
          angle: beam.angle,
          length: beam.length,
          hitting: beam.hitting,
        };
        this.beamNodes.set(beam.id, node);
      }
      node.holding = true;
      node.angle = beam.angle;
      node.length = beam.length;
      node.hitting = beam.hitting;
    }

    // Up on the arriving step and down on the leaving one. A weapon comes on
    // faster than it goes off, so the tail reads as the trigger coming up
    // rather than as a dropped frame.
    const { instant, quick } = motion();

    for (const [id, node] of this.beamNodes) {
      node.level = approachLevel(
        node.level,
        node.holding ? 1 : 0,
        dtMs,
        node.holding ? instant : quick,
      );
      if (!node.holding && node.level <= 0) {
        this.beamNodes.delete(id);
        continue;
      }

      // A hull with no pose this tick has nothing to hang a beam off, which
      // is what a shooter leaving the system looks like from here.
      const owner = this.poses.get(node.owner);
      if (!owner) {
        this.beamNodes.delete(id);
        continue;
      }

      const mount = this.mountsFor(owner.blueprint)[node.mount];
      if (mount) this.strokeBeam(g, mount, owner, node);
    }
  }

  /**
   * One beam: a soft surround, a living core, and a flare where it lands.
   *
   * Everything is drawn into the layer's single Graphics and scaled by the
   * node's level, so appearing and disappearing cost no display objects and
   * no allocation.
   */
  private strokeBeam(g: Graphics, mount: Mount, owner: ShipFrame, node: BeamNode): void {
    // Rising on the emphasis curve and falling on the exit curve, which is
    // what those tokens are for. The length is never animated: growing it
    // would read as a round travelling, which is the one thing a beam must
    // not look like.
    const level = node.holding ? easeEmphasis(node.level) : easeExit(node.level);
    if (level <= 0.01) return;

    const p = palette();
    const seg = beamSegment(mount, owner, node.angle, node.length);

    // Where it lands, for the rocks drawn under it: a rig's line stopping
    // on a rock is the only way the scene knows which one is being worked.
    if (node.hitting) this.beamHits.push({ x: seg.tipX, y: seg.tipY });

    const x0 = seg.muzzleX * PX_PER_UNIT;
    const y0 = seg.muzzleY * PX_PER_UNIT;
    const x1 = seg.tipX * PX_PER_UNIT;
    const y1 = seg.tipY * PX_PER_UNIT;

    // The captain's own beam is the bright amber all of their own fire is; a
    // hostile's is red, as its bracket is. A round gets no such distinction
    // because it is on screen for a tenth of a second, but a beam is held for
    // as long as somebody keeps it there, and one held on you is the most
    // important thing in the view.
    const colour = owner.isSelf ? p.amberBright : owner.hostile ? p.danger : p.amber;
    const core = mixToWhite(colour);

    // Heavier weapons draw heavier, within a narrow band: enough to tell a
    // lance from a cutter, not enough for either to stop looking like a beam.
    const heft = clamp(
      (mount.def.weapon?.damage ?? BEAM_REFERENCE_DAMAGE) / BEAM_REFERENCE_DAMAGE,
      0.85,
      1.3,
    );

    for (const pass of BEAM_SURROUND) {
      g.moveTo(x0, y0)
        .lineTo(x1, y1)
        .stroke({ width: pass.width * heft * level, color: colour, alpha: pass.alpha * level });
    }

    // The core in segments, so its width can wander along the length. Frozen
    // under reduced motion: the texture stays, the travel goes.
    const elapsed = this.reducedMotion ? 0 : this.elapsedMs;
    // Two mounts on one hull are offset in the wave, so a pair of beams does
    // not pulse in lockstep.
    const phase = mount.offsetY;
    for (let i = 0; i < BEAM_SEGMENTS; i++) {
      const t0 = i / BEAM_SEGMENTS;
      const t1 = (i + 1) / BEAM_SEGMENTS;
      const wave = beamRipple((t0 + t1) / 2, elapsed, phase);
      // The width wanders a little and the brightness a good deal more. At a
      // core this thin a tenth of a pixel cannot be seen, and a tenth of an
      // alpha can: widening it enough to read would make a bar rather than a
      // beam, so the variation is carried mostly by the light.
      const width = BEAM_CORE_PX * heft * level * wave;
      const alpha = clamp(0.95 * level * (1 + (wave - 1) * 3), 0, 1);
      g.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
        .lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
        .stroke({ width, color: core, alpha });
    }

    // Bloom at the muzzle, where the power goes in.
    for (let ring = 2; ring >= 1; ring--) {
      g.circle(x0, y0, 2.4 * ring * heft * level).fill({ color: colour, alpha: 0.13 * level });
    }

    if (!node.hitting) return;

    // Where it lands, while it is actually on a hull: brighter and wider than
    // the line, so holding a beam on something looks different from sweeping
    // it past. The flare breathes with the same wave as the core.
    const flare = 6.5 * heft * level * beamRipple(1, elapsed, phase);
    for (let ring = 3; ring >= 1; ring--) {
      g.circle(x1, y1, flare * (ring / 3)).fill({ color: colour, alpha: 0.13 * level });
    }
    g.circle(x1, y1, BEAM_CORE_PX * 1.4 * heft * level).fill({ color: core, alpha: 0.9 * level });
  }

  /**
   * The owner's mounts, in the order the simulation numbers them.
   *
   * `BeamState.mount` indexes `mountsOf`, which both sides derive from the
   * same blueprint and the same catalogue, so resolving it here agrees with
   * the server by construction rather than by a second convention.
   */
  private mountsFor(blueprintId: string): readonly Mount[] {
    const cached = this.mountBooks.get(blueprintId);
    if (cached) return cached;

    const blueprint = this.blueprints.get(blueprintId);
    const mounts = blueprint ? mountsOf(placeAll(blueprint.placements, this.modules)) : [];
    this.mountBooks.set(blueprintId, mounts);
    return mounts;
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

      // The grid, in one of the two places it shows (the Loft is the other):
      // faint over a marked hull or one carrying damage, so a captain can read
      // which module took the hit.
      const damaged = node.maxHp.some((full, index) => (frame.moduleHp[index] ?? full) < full);
      if (frame.isTarget || damaged) this.drawGrid(g, node, frame, cos, sin, originX, originY);

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

  /**
   * A hull's modules as faint outlines, turned with it, inset so neighbours
   * read as separate. A module that has taken damage is outlined in the danger
   * colour and filled in proportion to what it has lost.
   */
  private drawGrid(
    g: Graphics,
    node: ShipNode,
    frame: ShipFrame,
    cos: number,
    sin: number,
    originX: number,
    originY: number,
  ): void {
    const p = palette();
    const at = (x: number, y: number): [number, number] => [
      originX + (x * cos - y * sin) * PX_PER_UNIT,
      originY + (x * sin + y * cos) * PX_PER_UNIT,
    ];
    node.art.moduleRects.forEach((rect, index) => {
      const full = node.maxHp[index] ?? 1;
      const hp = frame.moduleHp[index] ?? full;
      const lost = full > 0 ? clamp(1 - hp / full, 0, 1) : 0;
      const x0 = rect.x + GRID_INSET;
      const y0 = rect.y + GRID_INSET;
      const x1 = rect.x + rect.width - GRID_INSET;
      const y1 = rect.y + rect.height - GRID_INSET;
      const points = [...at(x0, y0), ...at(x1, y0), ...at(x1, y1), ...at(x0, y1)];
      if (lost > 0) {
        g.poly(points).fill({ color: p.danger, alpha: 0.06 + 0.22 * lost });
        g.poly(points).stroke({ width: 1, color: p.danger, alpha: 0.35 + 0.35 * lost });
      } else {
        g.poly(points).stroke({ width: 1, color: p.textSecondary, alpha: frame.isTarget ? 0.2 : 0.12 });
      }
    });
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
    for (const node of this.ships.values()) {
      node.lit?.destroy();
      node.root.destroy({ children: true });
    }
    this.ships.clear();
    for (const art of this.art.values()) art.texture.destroy(true);
    this.art.clear();
    for (const art of this.hullArt.values()) art.material.destroy();
    this.hullArt.clear();
    this.beamNodes.clear();
    this.mountBooks.clear();
    this.poses.clear();
    this.backdrop.destroy();
    this.root.destroy({ children: true });
  }
}

/** Push a colour toward white, for the hot head of a round. */
function mixToWhite(colour: number): number {
  return mix(colour, 0xffffff, 0.55);
}
