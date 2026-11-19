/**
 * The client-to-server input packet.
 *
 * Flat primitives only: this is what Colyseus buffers per client, hands to the
 * server step, and replays on the client during reconciliation. Everything the
 * shared step function reads has to live here, or prediction will diverge.
 *
 * Range sanitising is declared on the server at `defineInput` and applied to
 * every decoded frame in place, so a client that encodes `turn: 127` gets a
 * legal value rather than a speed hack.
 */

import { schema, t, type SchemaType } from '@colyseus/schema';

export const ShipInput = schema(
  {
    /** -1 turn left, 0 hold, 1 turn right. */
    turn: t.int8<-1 | 0 | 1>().default(0),
    /** 1 to burn the main engine. */
    thrust: t.uint8<0 | 1>().default(0),
    /** Turn retrograde and burn to a stop. */
    brake: t.boolean().default(false),
    /** Fire fixed guns and turrets. */
    firePrimary: t.boolean().default(false),
    /** Fire missile racks. */
    fireSecondary: t.boolean().default(false),
  },
  'ShipInput',
);

export type ShipInput = SchemaType<typeof ShipInput>;

/** The legal domain of every input field, for the server's sanitiser. */
export const SHIP_INPUT_SANITIZE = {
  turn: [-1, 1],
  thrust: [0, 1],
} as const;
