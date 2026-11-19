/**
 * Server definition.
 *
 * Kept separate from `main.ts` so tests and tools can import the room map
 * without starting a listener.
 */

import { defineRoom, defineServer } from '@colyseus/core';

import { config } from './config.ts';
import { SystemRoom } from './rooms/SystemRoom.ts';

export const server = defineServer({
  rooms: {
    system: defineRoom(SystemRoom),
  },

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
