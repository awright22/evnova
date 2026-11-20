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
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnGroup, stopGroup } from '@marque/harness';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

export interface Stack {
  readonly baseUrl: string;
  readonly serverPort: number;
  /** Everything the stack's processes have said, for a failing run to print. */
  log: () => string;
  stop: () => Promise<void>;
}

/** Build the client, start the server and a static preview of the build. */
export async function startStack(options: {
  serverPort: number;
  previewPort: number;
  latencyMs?: number;
  /**
   * Where the world lives for this run. Defaults to a throwaway file: a
   * verification that reads or writes the repository's own database depends
   * on whatever earlier runs left behind, and leaves its own captains in it.
   */
  databaseUrl?: string;
}): Promise<Stack> {
  const procs: ChildProcess[] = [];
  const scratch = options.databaseUrl ?? join(mkdtempSync(join(tmpdir(), 'marque-verify-')), 'world.db');

  const stop = async (): Promise<void> => {
    for (const proc of procs) await stopGroup(proc, { timeoutMs: 4000 });
  };

  try {
    await run('pnpm', ['--filter', '@marque/client', 'run', 'build'], REPO_ROOT, {
      MARQUE_SERVER_URL: `ws://127.0.0.1:${options.serverPort}`,
    });

    procs.push(
      quiet('pnpm', ['exec', 'tsx', 'src/main.ts'], resolve(REPO_ROOT, 'packages/server'), {
        PORT: String(options.serverPort),
        DATABASE_URL: scratch,
        SNAPSHOT_DIR: join(dirname(scratch), 'snapshots'),
        NODE_ENV: 'development',
        INVITE_CODE: '',
        ...(options.latencyMs ? { COLYSEUS_LATENCY: String(options.latencyMs) } : {}),
      }),
    );
    await waitFor(`http://127.0.0.1:${options.serverPort}/health`);

    procs.push(
      quiet(
        'pnpm',
        [
          'exec',
          'vite',
          'preview',
          '--port',
          String(options.previewPort),
          '--strictPort',
          // Bound to IPv4 on purpose.
          //
          // Left to itself vite binds `localhost`, which on this container
          // resolves to 127.0.0.1 and on a GitHub runner resolves to ::1
          // first — so the preview came up, said "Local:
          // http://localhost:4186/", and the harness's fetch of
          // `http://127.0.0.1:4186` was answered by nothing. Two CI jobs
          // spent a minute each waiting for a server that was already
          // running on the other stack.
          '--host',
          '127.0.0.1',
        ],
        resolve(REPO_ROOT, 'packages/client'),
      ),
    );
    const baseUrl = `http://127.0.0.1:${options.previewPort}`;
    await waitFor(baseUrl);

    return { baseUrl, serverPort: options.serverPort, log: () => stackLog(procs), stop };
  } catch (error) {
    // Say what the processes said.
    //
    // `waitFor` can only report that a port never answered, which is true and
    // useless: it is the same message whether the server crashed on boot, the
    // preview could not find a build, or the port was taken. CI spent a
    // minute waiting for `http://127.0.0.1:4186` and then said exactly that,
    // and there was nothing else in the log to go on.
    const why = error instanceof Error ? error.message : String(error);
    const said = stackLog(procs);
    await stop();
    throw new Error(`${why}\n\nWhat the processes said:\n${said}`, { cause: error });
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

/**
 * Where Chromium is, if this machine ships one.
 *
 * `undefined` means "let Playwright use the browser it installed itself",
 * which is what a CI runner has. Asserting `/opt/pw-browsers/chromium`
 * unconditionally is a claim about *this* container: on a runner the path
 * does not exist and the launch fails with `executable doesn't exist`,
 * which is what the two browser jobs did the first time they got far
 * enough to try. The path has to be checked, not assumed.
 */
export const CHROMIUM: string | undefined = [
  process.env.MARQUE_CHROMIUM,
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
].find((candidate) => candidate !== undefined && candidate !== '' && existsSync(candidate));

export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

/**
 * Start a process whose output is kept but not printed.
 *
 * Discarding it outright, as this did, makes every failure in the stack
 * opaque: the harness reports what the client saw and nothing about why the
 * server said it. The log is held so a failing run can print it.
 */
function quiet(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): ChildProcess {
  const child = spawnGroup(cmd, [...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const keep = (chunk: Buffer): void => {
    log += chunk.toString();
    // Bounded: a long run must not accumulate a server's whole output.
    if (log.length > 64_000) log = log.slice(-32_000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  logs.set(child, () => log);

  return child;
}

/** Output held per process, for `stackLog()`. */
const logs = new WeakMap<ChildProcess, () => string>();

/** Everything the stack's processes have said, for a failing run to print. */
export function stackLog(procs: readonly ChildProcess[]): string {
  return procs
    .map((proc, index) => `--- process ${index + 1} ---\n${logs.get(proc)?.() ?? '(no output)'}`)
    .join('\n');
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
