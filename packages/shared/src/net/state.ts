/**
 * Synchronised room state.
 *
 * Field types are chosen for the wire: `float32` for continuous values that the
 * client interpolates, and the smallest integer that fits for everything else.
 * A Schema holds at most 63 fields, so anything that grows goes on a child.
 */

import { MapSchema, schema, t, type SchemaType } from '@colyseus/schema';

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
  },
  'ShipState',
);
export type ShipState = SchemaType<typeof ShipState>;

/** The state of one star system room. */
export const SystemState = schema(
  {
    /** Content id of the system this room simulates. */
    systemId: t.string().default(''),
    /** Server tick index, so clients can reason about simulation age. */
    tick: t.uint32().default(0),
    ships: t.map(ShipState),
  },
  'SystemState',
);
export type SystemState = SchemaType<typeof SystemState>;

export { MapSchema };
