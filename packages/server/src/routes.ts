/**
 * HTTP routes.
 *
 * `/health` is the liveness probe the container host needs. `/metrics` reports
 * tick percentiles so the soak run can hold the server to its budget without
 * scraping logs.
 */

import { createEndpoint, createRouter } from '@colyseus/core';

import { metricsReport } from './metrics.ts';
import { content, deriveStats, placeAll } from '@marque/shared';

export const routes = createRouter({
  health: createEndpoint('/health', { method: 'GET' }, () =>
    Promise.resolve({ status: 'ok', at: new Date().toISOString() }),
  ),

  metrics: createEndpoint('/metrics', { method: 'GET' }, () =>
    Promise.resolve(metricsReport()),
  ),

  /**
   * Derived handling for every shipped draught, as the server computes it.
   * A client deriving different numbers from the same data is the first thing
   * to check when prediction drifts, so the comparison is one request away.
   */
  draughts: createEndpoint('/draughts', { method: 'GET' }, () => {
    const { blueprints, modules, tuning } = content();
    return Promise.resolve(
      Object.fromEntries(
        [...blueprints].map(([id, bp]) => [
          id,
          deriveStats(placeAll(bp.placements, modules), tuning).profile,
        ]),
      ),
    );
  }),
});
