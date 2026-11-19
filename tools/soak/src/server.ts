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
}): Promise<RunningServer> {
  const child: ChildProcess = spawnGroup('pnpm', ['exec', 'tsx', 'src/main.ts'], {
    cwd: resolve(REPO_ROOT, 'packages/server'),
    env: {
      ...process.env,
      PORT: String(options.port),
      NODE_ENV: 'development',
      ...(options.databaseUrl !== undefined ? { DATABASE_URL: options.databaseUrl } : {}),
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
