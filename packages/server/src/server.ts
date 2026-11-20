/**
 * Server definition.
 *
 * Kept separate from `main.ts` so tests and tools can import the room map
 * without starting a listener.
 */

import { defineRoom, defineServer } from '@colyseus/core';

import { world } from './world/World.ts';

import { config } from './config.ts';
import { routes } from './routes.ts';
import {
  SystemRoom,
  refreshEveryBourse,
  regrowEveryBelt,
  scanEveryLane,
} from './rooms/SystemRoom.ts';

// The Bourse moves on the world's own clock, not on a captain's action, so
// the rooms are told when it has. Registered here because the World does not
// know about rooms and the rooms do not know about each other.
world().onBourseTick = (_dividends, book) => {
  refreshEveryBourse(book);
};

// Patrols look at the traffic, and worked rock comes back, on the same
// cadence the world moves on.
world().onEconomyTick = (hours) => {
  scanEveryLane();
  regrowEveryBelt(hours);
};

export const server = defineServer({
  rooms: {
    /**
     * One room per system.
     *
     * Matched on `systemId`, so a captain joins the room for the system their
     * row says they are in. Without the filter, `joinOrCreate` matches any
     * live room of this name: a captain bound for Parity could be put into
     * whichever system happened to have a room open, and since persisting a
     * captain writes the room's system back to their row, that silently moved
     * them across the galaxy.
     */
    system: defineRoom(SystemRoom).filterBy(['systemId']),
  },

  routes,

  /**
   * Origin allowlist. Empty means any origin, which is only ever the case in
   * local development: production config always names the client's origin.
   */
  ...(config.allowedOrigins.length > 0
    ? {
        verifyClient: (info: { origin?: string }) =>
          typeof info.origin === 'string' && config.allowedOrigins.includes(info.origin),
      }
    : {}),
});

export type GameServer = typeof server;
