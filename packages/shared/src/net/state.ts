/**
 * Synchronised room state.
 *
 * Field types are chosen for the wire: `float32` for continuous values that the
 * client interpolates, and the smallest integer that fits for everything else.
 * A Schema holds at most 63 fields, so anything that grows goes on a child.
 */

import { ArraySchema, MapSchema, schema, t, type SchemaType } from '@colyseus/schema';

/** One ship in a star system, player-flown or NPC. */
export const ShipState = schema(
  {
    // --- Flight, mirrored by the client reconciler ------------------------
    x: t.float32().default(0),
    y: t.float32().default(0),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    angle: t.float32().default(0),
    angVel: t.float32().default(0),

    // --- Identity ---------------------------------------------------------
    callsign: t.string().default(''),
    /**
     * Draught this hull is flying, for rendering and stat derivation.
     *
     * For an NPC or a captain who has never built, this names a draught in
     * the content catalogue and `hull` is empty. For a hull built in a Yard it
     * is the hull's own id, which the catalogue has never heard of, and the
     * placements arrive in `hull` instead.
     */
    blueprint: t.string().default(''),
    /**
     * A built hull's placements, as a share code.
     *
     * A custom hull cannot be drawn from an id: nothing in the client's
     * catalogue describes it. Rather than a second nested schema for module
     * grids, the grid travels in the same deterministic encoding captains
     * paste to each other, which the client already decodes. The field never
     * changes over a hull's life, so it costs its bytes once on arrival
     * rather than every patch.
     */
    hull: t.string().default(''),

    // --- Combat -----------------------------------------------------------
    /** Current shield points. Absorbs damage before the hull does. */
    shield: t.float32().default(0),
    /**
     * Hit points per placement, indexed as the blueprint lists them. A module
     * at zero is disabled, not removed: its contribution to the ship's stats
     * is gone but it still occupies its cells.
     */
    moduleHp: t.array('uint16'),
    /** Session or NPC id this ship has selected, for turrets and the interface. */
    target: t.string().default(''),
    /** Role, so the client can colour hostiles without trusting them to say so. */
    hostile: t.boolean().default(false),
    /** A patrol of the Prize Court, so a contact can be named for what it is. */
    patrol: t.boolean().default(false),
    /**
     * A company freighter: unarmed, laden, and somebody's livelihood.
     *
     * On the state because a captain should be able to tell what they are
     * looking at before they shoot it — and because what it is carrying is
     * deliberately *not* here, so deciding to intercept one is a decision
     * made without knowing whether it was worth it.
     */
    freighter: t.boolean().default(false),
    /** Posted by the Prize Court: patrols answer for this hull. */
    posted: t.boolean().default(false),
    /** Server time the hull was written off, for the wreck to linger. */
    destroyedAt: t.uint32().default(0),

    // --- Travel -----------------------------------------------------------
    /** System being spooled for, or empty. The hull keeps flying while it spools. */
    jumpTo: t.string().default(''),
    /** 0..1 through the spool, so the client can draw it without a timer of its own. */
    jumpProgress: t.float32().default(0),
    /** Port being landed at, or empty. */
    landingAt: t.string().default(''),
    landingProgress: t.float32().default(0),
    /** Server time the arrival protection ends. */
    protectedUntil: t.uint32().default(0),
  },
  'ShipState',
);
export type ShipState = SchemaType<typeof ShipState>;

/**
 * A round in flight.
 *
 * Position and velocity are written once at spawn and not updated per tick:
 * a round travels in a straight line (or turns at a known rate, for a
 * missile), so clients reckon it forward from its birth and the wire carries
 * one add and one remove per shot instead of a stream of positions.
 */
export const ProjectileState = schema(
  {
    x: t.float32().default(0),
    y: t.float32().default(0),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    /** Who fired it, so a hull cannot shoot itself and the kill is attributed. */
    owner: t.string().default(''),
    /** Kind index: 0 gun, 1 turret, 2 missile. Drives the client's art. */
    kind: t.uint8().default(0),
    /** Room clock time the round was fired, in ms. */
    bornAt: t.uint32().default(0),
    /** How long the round lives, in ms, from its range and speed. */
    lifeMs: t.uint16().default(0),
    /** Missiles only: the hull being chased. */
    target: t.string().default(''),
  },
  'ProjectileState',
);
export type ProjectileState = SchemaType<typeof ProjectileState>;

/**
 * A beam being held on something.
 *
 * Not a projectile: there is no flight to reckon forward, and the length
 * changes every tick as the mark moves. One entry per firing mount, added
 * when the trigger goes down and removed when it comes up, with its angle
 * and reach patched while it is there.
 */
export const BeamState = schema(
  {
    /** The hull it comes from, so the client draws it off that hull's muzzle. */
    owner: t.string().default(''),
    /** Which mount on that hull, so two beams do not come out of one place. */
    mount: t.uint8().default(0),
    /** Where it points, in world radians. */
    angle: t.float32().default(0),
    /** How far it reaches before it stops: its range, or whatever it hit. */
    length: t.float32().default(0),
    /** True while it is actually on something, for the impact end of it. */
    hitting: t.boolean().default(false),
  },
  'BeamState',
);
export type BeamState = SchemaType<typeof BeamState>;

/** Cargo spilled by a written-off hull, which anyone can scoop. */
export const CanisterState = schema(
  {
    x: t.float32().default(0),
    y: t.float32().default(0),
    vx: t.float32().default(0),
    vy: t.float32().default(0),
    commodity: t.string().default(''),
    units: t.uint16().default(0),
    bornAt: t.uint32().default(0),
  },
  'CanisterState',
);
export type CanisterState = SchemaType<typeof CanisterState>;

/** The state of one star system room. */
export const SystemState = schema(
  {
    /** Content id of the system this room simulates. */
    systemId: t.string().default(''),
    /** Server tick index, so clients can reason about simulation age. */
    tick: t.uint32().default(0),
    ships: t.map(ShipState),
    projectiles: t.map(ProjectileState),
    beams: t.map(BeamState),
    canisters: t.map(CanisterState),
  },
  'SystemState',
);
export type SystemState = SchemaType<typeof SystemState>;

export { ArraySchema, MapSchema };
