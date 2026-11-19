/**
 * Server entry point.
 *
 * Start with `pnpm dev` (watch mode) or `pnpm --filter @manifest/server start`
 * against a production build. Set `COLYSEUS_LATENCY` to a round-trip
 * millisecond figure to exercise the netcode under simulated latency; the
 * framework reads it and delays both directions.
 */

import { listen } from '@colyseus/tools';

import { config } from './config.ts';
import { server } from './server.ts';

const started = await listen(server, config.port);

const latency = process.env.COLYSEUS_LATENCY;
console.log(
  [
    `Manifest server listening on :${config.port}`,
    `  environment    ${config.nodeEnv}`,
    `  origins        ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'any (development)'}`,
    `  invite gate    ${config.inviteCode ? 'on' : 'off'}`,
    latency ? `  latency sim    ${latency} ms round trip` : null,
  ]
    .filter((line) => line !== null)
    .join('\n'),
);

/** Graceful shutdown: drain rooms before the process exits. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void started.gracefullyShutdown().then(() => process.exit(0));
  });
}
