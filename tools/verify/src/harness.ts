/**
 * Shared plumbing for browser acceptance checks.
 *
 * These checks drive the real client in a real browser against a real server,
 * because the things they verify — that two captains see each other fly, that
 * a new player can get through onboarding — cannot be proven from unit tests.
 */

// Type-only: erased at build time, so Playwright stays an optional runtime
// dependency these checks import dynamically and degrade without.
import type * as Playwright from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

export interface Stack {
  readonly baseUrl: string;
  readonly serverPort: number;
  stop: () => Promise<void>;
}

/** Build the client, start the server and a static preview of the build. */
export async function startStack(options: {
  serverPort: number;
  previewPort: number;
  latencyMs?: number;
}): Promise<Stack> {
  const procs: ChildProcess[] = [];

  const stop = async (): Promise<void> => {
    for (const proc of procs) {
      if (proc.exitCode !== null) continue;
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 4000);
      try {
        await once(proc, 'exit');
      } finally {
        clearTimeout(timer);
      }
    }
  };

  try {
    await run('pnpm', ['--filter', '@marque/client', 'run', 'build'], REPO_ROOT, {
      MARQUE_SERVER_URL: `ws://127.0.0.1:${options.serverPort}`,
    });

    procs.push(
      quiet('pnpm', ['exec', 'tsx', 'src/main.ts'], resolve(REPO_ROOT, 'packages/server'), {
        PORT: String(options.serverPort),
        ...(options.latencyMs ? { COLYSEUS_LATENCY: String(options.latencyMs) } : {}),
      }),
    );
    await waitFor(`http://127.0.0.1:${options.serverPort}/health`);

    procs.push(
      quiet(
        'pnpm',
        ['exec', 'vite', 'preview', '--port', String(options.previewPort), '--strictPort'],
        resolve(REPO_ROOT, 'packages/client'),
      ),
    );
    const baseUrl = `http://127.0.0.1:${options.previewPort}`;
    await waitFor(baseUrl);

    return { baseUrl, serverPort: options.serverPort, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function loadPlaywright(): Promise<typeof Playwright | undefined> {
  try {
    return await import('playwright');
  } catch {
    console.error('These checks need Playwright. Install it and run again.');
    return undefined;
  }
}

export const CHROMIUM =
  process.env.MARQUE_CHROMIUM ?? '/opt/pw-browsers/chromium';

export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

function quiet(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): ChildProcess {
  return spawn(cmd, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const child = spawn(cmd, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${err}`);
}

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status > 0) return;
    } catch {
      // not yet
    }
    await sleep(400);
  }
  throw new Error(`${url} never answered`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
