/**
 * Plumbing for a scripted play session.
 *
 * Spec section 18 asks each polish cycle to play the first thirty minutes
 * as a new player and, separately, a late-game session with a large ship
 * and a portfolio. Both are real browsers against a real server, so both
 * need the same six steps: build the client, clear a scratch database,
 * seed whoever has to exist, start the server, start a preview of the
 * build, and open a page.
 *
 * Kept here so a session reads as what the player does rather than as
 * process management, and so a fix to one is a fix to both.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Playwright from 'playwright';

import { findChromium, LAUNCH_ARGS } from '@marque/shots/browser';
import { sleep, start, waitForHttp, type ManagedProcess } from '@marque/shots/processes';
import { requirePortFree } from '@marque/harness';
import { runSeed, type SeedSpec } from '@marque/harness/seed';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');

export { sleep };

export interface SessionOptions {
  /** A name for the scratch database and the report. */
  readonly name: string;
  readonly serverPort: number;
  readonly previewPort: number;
  /** Captains written into the world before the server opens the file. */
  readonly seed?: readonly SeedSpec[];
  /** Extra environment for the server, e.g. a larger opening float. */
  readonly env?: Record<string, string>;
  /** Traffic, so the sky is not empty. */
  readonly bots?: { readonly count: number; readonly brain: string; readonly system: string };
}

export interface Session {
  readonly browser: Playwright.Browser;
  readonly baseUrl: string;
  /** Device tokens for the seeded captains, by callsign. */
  readonly tokens: ReadonlyMap<string, string>;
  close: () => Promise<void>;
}

/** Build, seed, start and open. The caller gets a browser and a URL. */
export async function openSession(options: SessionOptions): Promise<Session> {
  const playwright = (await import('playwright')) as typeof Playwright;
  const processes: ManagedProcess[] = [];

  const stop = async (): Promise<void> => {
    await Promise.allSettled(processes.map((proc) => proc.stop()));
  };

  try {
    console.log('Building client...');
    const build = start('client build', 'pnpm', ['--filter', '@marque/client', 'run', 'build'], {
      cwd: REPO_ROOT,
      env: { MARQUE_SERVER_URL: `ws://127.0.0.1:${options.serverPort}` },
    });
    const code = await new Promise<number>((done) =>
      build.child.on('exit', (exit) => done(exit ?? 1)),
    );
    if (code !== 0) throw new Error(`client build failed:\n${build.output()}`);

    // A throwaway database, cleared first: a callsign is unique on the
    // Register, so the last run's captain would refuse this one's sign-up.
    const scratchDb = resolve(REPO_ROOT, `artifacts/${options.name}.db`);
    await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${scratchDb}${suffix}`, { force: true });
    }

    const worldEnv = {
      PORT: String(options.serverPort),
      NODE_ENV: 'development',
      DATABASE_URL: scratchDb,
      ...options.env,
    };

    const tokens = new Map<string, string>();
    if (options.seed && options.seed.length > 0) {
      console.log(`Seeding ${options.seed.length} captain(s)...`);
      for (const [callsign, token] of Object.entries(await runSeed(options.seed, worldEnv))) {
        tokens.set(callsign, token);
      }
    }

    // Nothing of an earlier run may still be listening: a stale preview
    // turns into a timeout three steps later and a stack trace about the
    // wrong thing.
    await requirePortFree(options.serverPort, 'a game server');
    await requirePortFree(options.previewPort, 'a client preview');

    console.log('Starting game server...');
    const server = start('game server', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: resolve(REPO_ROOT, 'packages/server'),
      env: worldEnv,
    });
    processes.push(server);
    await waitForHttp(server, `http://127.0.0.1:${options.serverPort}/matchmake/`);

    console.log('Starting client preview...');
    const preview = start(
      'client preview',
      'pnpm',
      [
        'exec',
        'vite',
        'preview',
        '--port',
        String(options.previewPort),
        '--strictPort',
        // IPv4, explicitly: vite otherwise binds `localhost`, which
        // resolves to ::1 first on some machines, and every harness
        // here then waits on 127.0.0.1 for a server already running
        // on the other stack. See `tools/verify/src/harness.ts`.
        '--host',
        '127.0.0.1',
      ],
      { cwd: resolve(REPO_ROOT, 'packages/client') },
    );
    processes.push(preview);
    const baseUrl = `http://127.0.0.1:${options.previewPort}`;
    await waitForHttp(preview, baseUrl);

    if (options.bots && options.bots.count > 0) {
      console.log(`Flying ${options.bots.count} bot(s)...`);
      processes.push(
        start(
          'bot traffic',
          'pnpm',
          [
            'exec', 'tsx', 'tools/bot/src/main.ts',
            '--bots', String(options.bots.count),
            '--seconds', '1200',
            '--brain', options.bots.brain,
            '--system', options.bots.system,
            '--endpoint', `ws://127.0.0.1:${options.serverPort}`,
            '--quiet',
          ],
          { cwd: REPO_ROOT },
        ),
      );
      await sleep(5000);
    }

    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
      args: [...LAUNCH_ARGS, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
      ...(executablePath ? { executablePath } : {}),
    });

    return {
      browser,
      baseUrl,
      tokens,
      close: async () => {
        await browser.close().catch(() => undefined);
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A page signed in as a seeded captain, straight into the game. */
export async function openAs(
  session: Session,
  callsign: string,
  options: { readonly harness?: boolean; readonly debug?: boolean } = {},
): Promise<{ page: Playwright.Page; problems: string[] }> {
  const token = session.tokens.get(callsign);
  if (token === undefined) throw new Error(`no device token was seeded for "${callsign}"`);

  const context = await session.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  await page.addInitScript(
    ([name, device]: [string, string]) => {
      try {
        localStorage.setItem('marque.callsign', name);
        localStorage.setItem('marque.deviceToken', device);
      } catch {
        // Storage disabled: the page lands on the Register and says so.
      }
    },
    [callsign, token] as [string, string],
  );

  const params = new URLSearchParams({ callsign });
  if (options.harness !== false) params.set('harness', '1');
  if (options.debug === true) params.set('debug', '1');
  await page.goto(`${session.baseUrl}/?${params.toString()}`, { waitUntil: 'networkidle' });
  return { page, problems };
}

/** One thing the session looked at, and whether it was right. */
export interface Note {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export class Notebook {
  private readonly notes: Note[] = [];

  record(name: string, passed: boolean, detail = ''): void {
    this.notes.push({ name, passed, detail });
    console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }

  get failures(): readonly Note[] {
    return this.notes.filter((note) => !note.passed);
  }

  /** Print the tally, write the file, and set the exit code. */
  async report(name: string): Promise<void> {
    const failed = this.failures;
    console.log(`\n${this.notes.length - failed.length} of ${this.notes.length} check(s) passed.`);
    if (failed.length > 0) {
      console.error('Went wrong:');
      for (const note of failed) console.error(`  ${note.name} ${note.detail}`);
    }
    await mkdir(resolve(REPO_ROOT, 'artifacts'), { recursive: true });
    await writeFile(
      resolve(REPO_ROOT, `artifacts/${name}.json`),
      `${JSON.stringify({ ranAt: new Date().toISOString(), notes: this.notes }, null, 2)}\n`,
    );
    console.log(`Written to artifacts/${name}.json`);
    if (failed.length > 0) process.exitCode = 1;
  }
}
