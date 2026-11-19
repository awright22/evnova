/**
 * Server definition.
 *
 * Kept separate from `main.ts` so tests and tools can import the room map
 * without starting a listener.
 */

import { defineRoom, defineServer } from '@colyseus/core';

import { config } from './config.ts';
import { routes } from './routes.ts';
import { SystemRoom } from './rooms/SystemRoom.ts';

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
