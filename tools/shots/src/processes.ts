/**
 * Child process helpers for the capture session.
 *
 * The harness starts the game server and a static preview of the built client,
 * captures, then tears both down. Keeping that here means `main.ts` reads as a
 * list of screens rather than process plumbing.
 */

import { type ChildProcess } from 'node:child_process';

import { spawnGroup, stopGroup } from '@marque/harness';

export interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly output: () => string;
  stop: () => Promise<void>;
}

export function start(
  name: string,
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): ManagedProcess {
  const child = spawnGroup(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const record = (chunk: Buffer): void => {
    log += chunk.toString();
    // Keep the tail only: these logs exist to explain a failure.
    if (log.length > 64_000) log = log.slice(-32_000);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  return {
    name,
    child,
    output: () => log,
    stop: () => stopGroup(child, { timeoutMs: 5000 }),
  };
}

/** Poll an HTTP endpoint until it answers, or give up with the process log. */
export async function waitForHttp(
  managed: ManagedProcess,
  url: string,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (managed.child.exitCode !== null) {
      throw new Error(`${managed.name} exited early:\n${managed.output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      // Any answer means the listener is up; 404 is fine for a probe path.
      if (response.status > 0) return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }

  throw new Error(`${managed.name} did not answer at ${url} in ${timeoutMs}ms:\n${managed.output()}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
