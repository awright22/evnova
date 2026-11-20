/**
 * Server lifecycle for the soak run.
 *
 * The soak starts its own server on its own port so it never disturbs a dev
 * server, and reads tick metrics from the server's own `/metrics` route rather
 * than scraping logs.
 */

import { type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signalGroup, spawnGroup, stopGroup } from '@marque/harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

export interface TickStats {
  readonly samples: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly over33Ms: number;
}

export interface ServerMetrics {
  readonly uptimeSeconds: number;
  readonly rooms: number;
  readonly clients: number;
  readonly entities: number;
  readonly tick: TickStats;
}

const EMPTY_TICK: TickStats = {
  samples: 0,
  meanMs: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
  maxMs: 0,
  over33Ms: 0,
};

export interface RunningServer {
  stop: () => Promise<void>;
}

export async function startServer(options: {
  port: number;
  latencyMs: number;
  /** A throwaway database, so a soak never writes into the real world. */
  databaseUrl?: string;
  /**
   * How much faster the economy runs than the clock.
   *
   * A soak at real time proves only that a brand-new world sits at its
   * targets, which it does by construction. The spec asks for accelerated
   * time; this is where it is asked for.
   */
  economyTimeScale?: number;
  /**
   * Where the soak's captains open their accounts.
   *
   * Parity is the opening system for a player, and it is a finance hub: both
   * its berths only consume, so there is no glut in it to buy and a trading
   * bot correctly does nothing there. A soak about the economy starts its
   * captains where goods are made.
   */
  startingSystem?: string;
  /**
   * Marks a captain opens with.
   *
   * A run about what captains do with money needs them to have some: an
   * investor on a new captain's float can buy a share or two and nothing
   * else, which measures nothing.
   */
  startingMarks?: number;
}): Promise<RunningServer> {
  const child: ChildProcess = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(options.port),
      NODE_ENV: 'development',
      ...(options.databaseUrl !== undefined ? { DATABASE_URL: options.databaseUrl } : {}),
      ...(options.economyTimeScale !== undefined
        ? { ECONOMY_TIME_SCALE: String(options.economyTimeScale) }
        : {}),
      ...(options.startingSystem !== undefined
        ? { STARTING_SYSTEM: options.startingSystem }
        : {}),
      ...(options.startingMarks !== undefined
        ? { STARTING_MARKS: String(options.startingMarks) }
        : {}),
      ...(options.latencyMs > 0 ? { COLYSEUS_LATENCY: String(options.latencyMs) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const record = (chunk: Buffer): void => {
    log += chunk.toString();
    if (log.length > 64_000) log = log.slice(-32_000);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const response = await fetch(`http://127.0.0.1:${options.port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return {
          stop: () => stopGroup(child, { timeoutMs: 5000 }),
        };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  signalGroup(child, 'SIGKILL');
  throw new Error(`server did not become healthy in time:\n${log}`);
}

/** Read the server's metrics, aggregated across every live room. */
/** Where one commodity stands across the Reach, as the server reports it. */
export interface CommodityReport {
  commodityId: string;
  name: string;
  basePrice: number;
  floor: number;
  ceiling: number;
  low: number;
  high: number;
  mean: number;
  berths: number;
  stock: number;
  atFloor: number;
  atCeiling: number;
  empty: number;
  full: number;
}

export interface BerthReport {
  portId: string;
  systemId: string;
  goods: { commodityId: string; stock: number; target: number; price: number }[];
}

/** One listing's pool, as `/economy` reports it. */
export interface ListingReport {
  readonly ticker: string;
  readonly product: number;
  readonly price: number;
  /** Smoothed earnings a tick, and what was banked in the last one. */
  readonly earnings: number;
  readonly period: number;
}

/** Commissions grouped by template and outcome, as `/economy` reports them. */
export interface CommissionReport {
  readonly templateId: string;
  readonly kind: string;
  readonly state: string;
  readonly count: number;
}

export interface EconomyReport {
  /** Every listing's pool, for invariant 3 over a whole run. */
  readonly listings?: readonly ListingReport[];
  /** Shares captains hold, all told. */
  readonly sharesHeld?: { readonly total: number };
  commodities: CommodityReport[];
  berths: BerthReport[];
  /** Every commission taken this run, by template and outcome. */
  commissions?: readonly CommissionReport[];
  ledger: {
    categories: { category: string; total: number; count: number }[];
    net: number;
    heldByCaptains: number;
    captains: number;
    /** What every hold is carrying, and what it is worth at base price. */
    cargoUnits: number;
    cargoValue: number;
  };
}

/** The economy, aggregate and read-only. */
export async function fetchEconomy(port: number): Promise<EconomyReport> {
  const response = await fetch(`http://127.0.0.1:${port}/economy`, {
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.json()) as EconomyReport;
}

export async function fetchMetrics(port: number): Promise<ServerMetrics> {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    uptimeSeconds: number;
    rooms: number;
    clients: number;
    entities: number;
    perRoom: { tick: TickStats }[];
  };

  // One room per system. Report the busiest room's tick, since that is the one
  // the budget applies to.
  const worst = body.perRoom.reduce<TickStats>(
    (acc, room) => (room.tick.p99Ms > acc.p99Ms ? room.tick : acc),
    EMPTY_TICK,
  );

  return {
    uptimeSeconds: body.uptimeSeconds,
    rooms: body.rooms,
    clients: body.clients,
    entities: body.entities,
    tick: worst,
  };
}
