/**
 * Process handling shared by the tools that start a server.
 *
 * Every one of them starts the server through `pnpm exec`, which means the
 * server is a grandchild: `child.kill()` signals the wrapper and leaves the
 * server listening. A leaked server is not a quiet failure — the next run's
 * health check finds it, decides the server is up, and then runs every
 * assertion against the wrong process with the wrong database, failing
 * somewhere far from the cause. So the tools start a process group and signal
 * the group.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';

/**
 * Start a process in its own group.
 *
 * Takes the same options as `spawn`, with `detached` forced on: a caller that
 * turned it off would reintroduce the leak this module exists to prevent.
 */
export function spawnGroup(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, args, { ...options, detached: true });
}

/** Signal a whole process group, falling back to the child alone. */
export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // No group, or it is already gone. Fall through to the child itself.
  }
  try {
    child.kill(signal);
  } catch {
    // Nothing left to signal.
  }
}

/**
 * Stop a process and everything it started.
 *
 * Asks politely, then insists. Resolves once the process has actually gone,
 * so a caller can rely on its port being free afterwards.
 */
export async function stopGroup(
  child: ChildProcess,
  options: { graceful?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalGroup(child, options.graceful === false ? 'SIGKILL' : 'SIGTERM');
  const timer = setTimeout(
    () => signalGroup(child, 'SIGKILL'),
    options.timeoutMs ?? 8000,
  );
  try {
    await once(child, 'exit');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refuse to run against a server this process did not start.
 *
 * Returns nothing when the port is free, and throws otherwise. Call it before
 * spawning: it turns "the assertions all failed strangely" into one sentence
 * naming the real problem.
 */
export async function requirePortFree(port: number, what = 'a server'): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    return;
  }
  throw new Error(
    `something is already listening on :${port}. That is probably ${what} left ` +
      `by an earlier run; stop it and try again.`,
  );
}
