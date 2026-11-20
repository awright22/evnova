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
import { FLUSH_INTERVAL_MS, world } from './world/World.ts';
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

const BerthBody = z.object({
  deviceToken: z.string().min(1).max(400),
});

/** Map an auth failure onto an HTTP status and a line a captain can read. */
const AUTH_STATUS: Record<string, { status: number; message: string }> = {
  'bad-invite': { status: 403, message: 'That invite code is not current.' },
  'callsign-taken': { status: 409, message: 'That callsign is on the Register already.' },
  'callsign-invalid': { status: 400, message: 'That callsign cannot be entered on the Register.' },
  'unknown-account': { status: 404, message: 'No such callsign on the Register.' },
  'bad-token': { status: 401, message: 'This device is not on the Register.' },
  'wrong-system': { status: 409, message: 'That captain is not in this system.' },
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
  /**
   * Liveness, plus the one durability figure worth knowing about a running
   * server: how much of a captain's position a hard kill can cost. Reported
   * rather than assumed, so an operator and the persistence check read it off
   * the process they are actually talking to.
   */
  health: createEndpoint('/health', { method: 'GET' }, () =>
    Promise.resolve({
      status: 'ok',
      at: new Date().toISOString(),
      flushIntervalMs: FLUSH_INTERVAL_MS,
    }),
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

  /**
   * Where a captain is.
   *
   * Rooms are matched on their system, so the client has to know which system
   * to ask for before it joins. The authority is the captain's own row, which
   * only the server can read, so it is answered here rather than guessed from
   * anything the client has kept.
   *
   * A POST because the device token is a credential: it has no business in a
   * URL, a referrer or an access log.
   */
  berth: createEndpoint('/account/berth', { method: 'POST', body: BerthBody }, (ctx) => {
    try {
      const account = world().accounts.signIn(ctx.body.deviceToken);
      const pilot = world().pilots.load(account.id);
      if (!pilot) return Promise.resolve(authFailure(new AuthError('unknown-account')));
      return Promise.resolve(
        json({ systemId: pilot.systemId, landedPort: pilot.landedPortId ?? '' }),
      );
    } catch (error) {
      return Promise.resolve(authFailure(error));
    }
  }),

  /**
   * The economy, for the soak's report and the admin page.
   *
   * Read-only and aggregate: prices and stock across the Reach, and the
   * ledger's totals by category. It names no captain, so it gives away
   * nothing about anyone; it is the shape of the world, not its people.
   */
  economy: createEndpoint('/economy', { method: 'GET' }, () => {
    const world_ = world();
    const categories = world_.ledger.totals();
    const held = world_.store.raw
      .prepare('SELECT COALESCE(SUM(marks), 0) AS total FROM pilots')
      .get() as { total: number };
    const captains = world_.store.raw
      .prepare('SELECT COUNT(*) AS total FROM pilots')
      .get() as { total: number };

    // What is in every hold, valued at base price. Marks alone understate a
    // captain in the middle of a run: the cargo they are carrying was bought
    // with marks and is worth something, and a report that ignored it would
    // call every trading bot a loss-maker for being mid-voyage.
    const holds = world_.store.raw
      .prepare('SELECT commodity_id AS id, SUM(units) AS units FROM cargo GROUP BY commodity_id')
      .all() as { id: string; units: number }[];
    const { commodities } = content();
    const cargoValue = holds.reduce(
      (sum, row) => sum + row.units * (commodities.get(row.id)?.basePrice ?? 0),
      0,
    );
    const cargoUnits = holds.reduce((sum, row) => sum + row.units, 0);

    return Promise.resolve(
      json({
        commodities: world_.market.survey(),
        berths: world_.market.berthSurvey(),
        // Every pool's product and quote, so the soak can check invariant 3
        // over a whole run rather than over one function call, and say
        // whether any listing ran to nothing or without bound.
        listings: world_.exchange.products(),
        // What captains hold in shares, valued at the quote. Counted apart
        // from marks and cargo because a captain's wealth can sit in any of
        // the three and a report that missed one would call them poor.
        sharesHeld: world_.store.raw
          .prepare('SELECT COALESCE(SUM(shares), 0) AS total FROM holdings')
          .get() as { total: number },
        ledger: {
          categories,
          // Faucets minus sinks. Invariant 4 says this equals the marks every
          // captain holds, so reporting both means the soak can check it.
          net: categories.reduce((sum, row) => sum + row.total, 0),
          heldByCaptains: held.total,
          captains: captains.total,
          cargoUnits,
          cargoValue,
        },
      }),
    );
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
