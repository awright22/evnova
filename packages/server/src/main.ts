/**
 * Server entry point.
 *
 * Start with `pnpm dev` (watch mode) or `pnpm --filter @marque/server start`
 * against a production build. Set `COLYSEUS_LATENCY` to a round-trip
 * millisecond figure to exercise the netcode under simulated latency; the
 * framework reads it and delays both directions.
 */

import { listen } from '@colyseus/tools';

import { config } from './config.ts';
import { server } from './server.ts';
import { world } from './world/World.ts';

// The world owns the database, accounts and captains, and keeps ticking
// whether or not a room exists. It starts before the listener so a client
// cannot arrive before persistence is ready.
const game = world();
game.start();

const started = await listen(server, config.port);

const latency = process.env.COLYSEUS_LATENCY;
console.log(
  [
    `Marque server listening on :${config.port}`,
    `  environment    ${config.nodeEnv}`,
    `  origins        ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'any (development)'}`,
    `  invite gate    ${config.inviteCode ? 'on' : 'off'}`,
    `  database       ${config.databaseUrl}`,
    latency ? `  latency sim    ${latency} ms round trip` : null,
  ]
    .filter((line) => line !== null)
    .join('\n'),
);

/**
 * Graceful shutdown.
 *
 * Rooms drain first, which runs every captain's `onLeave` and writes their
 * hull state; then the world flushes whatever is still dirty and closes the
 * database. A kill in the middle costs at most the last few seconds of
 * position, which is what the spec allows.
 */
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void started
      .gracefullyShutdown()
      .catch((error: unknown) => console.error('shutdown failed:', error))
      .finally(() => {
        game.shutdown();
        process.exit(0);
      });
  });
}
