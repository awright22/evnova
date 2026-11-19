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
    /** Blueprint this ship is flying, for rendering and stat derivation. */
    blueprint: t.string().default(''),

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
    /** Server time the hull was written off, for the wreck to linger. */
    destroyedAt: t.uint32().default(0),
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
    canisters: t.map(CanisterState),
  },
  'SystemState',
);
export type SystemState = SchemaType<typeof SystemState>;

export { ArraySchema, MapSchema };
