/**
 * HTTP routes.
 *
 * `/health` is the liveness probe the container host needs. `/metrics` reports
 * tick percentiles so the soak run can hold the server to its budget without
 * scraping logs.
 */

import { createEndpoint, createRouter } from '@colyseus/core';

import { metricsReport } from './metrics.ts';

export const routes = createRouter({
  health: createEndpoint('/health', { method: 'GET' }, () =>
    Promise.resolve({ status: 'ok', at: new Date().toISOString() }),
  ),

  metrics: createEndpoint('/metrics', { method: 'GET' }, () =>
    Promise.resolve(metricsReport()),
  ),
});
