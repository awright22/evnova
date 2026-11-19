/**
 * HTTP routes.
 *
 * `/health` is the liveness probe the container host needs. `/metrics` reports
 * tick percentiles so the soak run can hold the server to its budget without
 * scraping logs.
 */

import { createEndpoint, createRouter } from '@colyseus/core';
import { z } from 'zod';

import { AuthError } from './accounts.ts';
import { metricsReport } from './metrics.ts';
import { world } from './world/World.ts';
import { content, deriveStats, placeAll } from '@marque/shared';

/** What a sign-up or recovery returns. Shown once, then stored by the client. */
const SignUpBody = z.object({
  callsign: z.string().min(1).max(40),
  inviteCode: z.string().max(200).default(''),
});

const RecoverBody = z.object({
  callsign: z.string().min(1).max(40),
  recoveryPhrase: z.string().min(1).max(400),
});

/** Map an auth failure onto an HTTP status and a line a captain can read. */
const AUTH_STATUS: Record<string, { status: number; message: string }> = {
  'bad-invite': { status: 403, message: 'That invite code is not current.' },
  'callsign-taken': { status: 409, message: 'That callsign is on the Register already.' },
  'callsign-invalid': { status: 400, message: 'That callsign cannot be entered on the Register.' },
  'unknown-account': { status: 404, message: 'No such callsign on the Register.' },
  'bad-token': { status: 401, message: 'This device is not on the Register.' },
  'bad-recovery': { status: 401, message: 'That recovery phrase does not match.' },
};

/** JSON with an explicit status, so a refusal is a status and not a surprise. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authFailure(error: unknown): Response {
  if (error instanceof AuthError) {
    const mapped = AUTH_STATUS[error.reason] ?? { status: 400, message: 'Refused.' };
    return json({ error: error.reason, message: mapped.message }, mapped.status);
  }
  throw error;
}

export const routes = createRouter({
  health: createEndpoint('/health', { method: 'GET' }, () =>
    Promise.resolve({ status: 'ok', at: new Date().toISOString() }),
  ),

  metrics: createEndpoint('/metrics', { method: 'GET' }, () =>
    Promise.resolve(metricsReport()),
  ),

  /**
   * Open an account.
   *
   * Returns the device token and the recovery phrase once. Neither is ever
   * returned again: the client stores the token and shows the phrase to the
   * captain exactly once.
   */
  signUp: createEndpoint('/account/sign-up', { method: 'POST', body: SignUpBody }, (ctx) => {
    try {
      const result = world().accounts.signUp(ctx.body);
      return Promise.resolve(
        json({
          callsign: result.account.callsign,
          deviceToken: result.deviceToken,
          recoveryPhrase: result.recoveryPhrase,
        }),
      );
    } catch (error) {
      return Promise.resolve(authFailure(error));
    }
  }),

  /** Move an account to this device with its recovery phrase. */
  recover: createEndpoint('/account/recover', { method: 'POST', body: RecoverBody }, (ctx) => {
    try {
      const result = world().accounts.recover(ctx.body);
      return Promise.resolve(
        json({
          callsign: result.account.callsign,
          deviceToken: result.deviceToken,
          recoveryPhrase: result.recoveryPhrase,
        }),
      );
    } catch (error) {
      return Promise.resolve(authFailure(error));
    }
  }),

  /** The galaxy, for the chart. Static content, so it is cacheable. */
  galaxy: createEndpoint('/galaxy', { method: 'GET' }, () => {
    const { systems } = content();
    return Promise.resolve({
      systems: [...systems.values()].map((system) => ({
        id: system.id,
        name: system.name,
        region: system.region,
        security: system.security,
        description: system.description,
        mapX: system.mapX,
        mapY: system.mapY,
        links: system.links,
        ports: system.ports.map((port) => ({
          id: port.id,
          name: port.name,
          owner: port.owner,
          services: port.services,
          description: port.description,
        })),
      })),
    });
  }),

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
