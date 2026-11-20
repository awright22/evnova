/**
 * Screenshot harness.
 *
 * Builds the client, starts the game server and a static preview of the build,
 * then captures every screen in `screens.ts` to `artifacts/shots/`, with a
 * manifest describing what each file is.
 *
 * Look and motion cannot be judged from code: this is how they get judged.
 *
 *   pnpm shots
 *   pnpm shots -- --only boot-linked --viewport 1920x1080
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Type-only: erased at build time, so Playwright stays an optional runtime
// dependency that the harness imports dynamically and degrades without.
import type * as Playwright from 'playwright';

import { findChromium, LAUNCH_ARGS } from './browser.ts';
import { SCREENS, type Screen } from './screens.ts';
import { sleep, start, waitForHttp, type ManagedProcess } from './processes.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

interface Options {
  outDir: string;
  viewport: { width: number; height: number };
  scale: number;
  only: string | undefined;
  serverPort: number;
  previewPort: number;
  keepBuild: boolean;
}

/**
 * Arguments after the runner's own. `pnpm run x -- --flag` forwards the bare
 * `--` separator too, and Node's parseArgs reads it as end-of-options, so it is
 * dropped here.
 */
function cliArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--');
}

function parseOptions(): Options {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      out: { type: 'string', default: 'artifacts/shots' },
      viewport: { type: 'string', default: '1440x900' },
      scale: { type: 'string', default: '2' },
      only: { type: 'string' },
      'server-port': { type: 'string', default: '2577' },
      'preview-port': { type: 'string', default: '4173' },
      'keep-build': { type: 'boolean', default: false },
    },
  });

  const match = /^(\d+)x(\d+)$/.exec(values.viewport);
  if (!match) throw new Error(`--viewport must look like 1440x900`);

  return {
    outDir: resolve(REPO_ROOT, values.out),
    viewport: { width: Number(match[1]), height: Number(match[2]) },
    scale: Number(values.scale),
    only: values.only,
    serverPort: Number(values['server-port']),
    previewPort: Number(values['preview-port']),
    keepBuild: values['keep-build'] === true,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();

  const playwright = await importPlaywright();
  if (!playwright) return;

  // `--only` takes one name or a comma-separated list, so a change to two
  // screens does not mean recapturing all of them.
  const wanted = (options.only ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const screens = wanted.length > 0
    ? SCREENS.filter((screen) => wanted.includes(screen.name))
    : SCREENS;

  if (screens.length === 0) {
    throw new Error(
      `no screen named "${options.only ?? ''}". Known: ${SCREENS.map((s) => s.name).join(', ')}`,
    );
  }

  const unknown = wanted.filter((name) => !SCREENS.some((screen) => screen.name === name));
  if (unknown.length > 0) {
    throw new Error(
      `no screen named "${unknown.join('", "')}". ` +
        `Known: ${SCREENS.map((s) => s.name).join(', ')}`,
    );
  }

  // Clear only what is about to be recaptured: wiping the directory on a
  // `--only` run threw away every other screen, so a single-screen run left
  // the gallery with one picture in it.
  if (wanted.length === 0) {
    await rm(options.outDir, { recursive: true, force: true });
  } else {
    for (const screen of screens) {
      await rm(resolve(options.outDir, `${screen.name}.png`), { force: true });
    }
  }
  await mkdir(options.outDir, { recursive: true });

  const processes: ManagedProcess[] = [];

  try {
    // 1. Build the client against the capture server's address, so the
    //    captured interface is the production build, not the dev server.
    if (!options.keepBuild) {
      console.log('Building client...');
      const build = start(
        'client build',
        'pnpm',
        ['--filter', '@marque/client', 'run', 'build'],
        {
          cwd: REPO_ROOT,
          env: { MARQUE_SERVER_URL: `ws://127.0.0.1:${options.serverPort}` },
        },
      );
      const code = await new Promise<number>((done) =>
        build.child.on('exit', (exit) => done(exit ?? 1)),
      );
      if (code !== 0) throw new Error(`client build failed:\n${build.output()}`);
    }

    // 2. Game server, on its own port so a running dev server is untouched,
    // and on a throwaway database so a capture never depends on what an
    // earlier run left behind. Accounts opened here are gone when it exits.
    console.log('Starting game server...');
    const scratchDb = resolve(options.outDir, 'capture.db');
    await rm(scratchDb, { force: true });
    await rm(`${scratchDb}-wal`, { force: true });
    await rm(`${scratchDb}-shm`, { force: true });
    const server = start('game server', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: resolve(REPO_ROOT, 'packages/server'),
      env: {
        PORT: String(options.serverPort),
        NODE_ENV: 'development',
        DATABASE_URL: scratchDb,
        // Enough to build with. Several screens are of the Yard and the
        // Moorings, and a captain on a new captain's float can only ever be
        // photographed looking at a bill they cannot pay.
        STARTING_MARKS: '4000000',
      },
    });
    processes.push(server);
    await waitForHttp(server, `http://127.0.0.1:${options.serverPort}/matchmake/`);

    // 3. Static preview of the built client.
    console.log('Starting client preview...');
    const preview = start(
      'client preview',
      'pnpm',
      ['exec', 'vite', 'preview', '--port', String(options.previewPort), '--strictPort'],
      { cwd: resolve(REPO_ROOT, 'packages/client') },
    );
    processes.push(preview);
    const baseUrl = `http://127.0.0.1:${options.previewPort}`;
    await waitForHttp(preview, baseUrl);

    // 4. Capture.
    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
      args: [...LAUNCH_ARGS],
      ...(executablePath ? { executablePath } : {}),
    });

    const captured: { name: string; file: string; description: string }[] = [];

    // Bot traffic, so flight captures show a system with other hulls in it
    // rather than one ship alone.
    const wantBots = Math.max(0, ...screens.map((screen) => screen.bots ?? 0));
    let bots: ManagedProcess | undefined;
    if (wantBots > 0) {
      console.log(`Flying ${wantBots} bot(s) for traffic...`);
      bots = start(
        'bot traffic',
        'pnpm',
        [
          'exec', 'tsx', 'tools/bot/src/main.ts',
          '--bots', String(wantBots),
          '--seconds', '600',
          '--brain', 'wander',
          '--endpoint', `ws://127.0.0.1:${options.serverPort}`,
          '--quiet',
        ],
        { cwd: REPO_ROOT },
      );
      processes.push(bots);
      // Give them time to join and spread out.
      await sleep(6000);
    }

    try {
      for (const screen of screens) {
        const file = await capture(browser, baseUrl, screen, options);
        captured.push({ name: screen.name, file, description: screen.description });
        console.log(`  captured ${screen.name}`);
      }
    } finally {
      await browser.close();
    }

    const manifest = {
      capturedAt: new Date().toISOString(),
      viewport: options.viewport,
      deviceScaleFactor: options.scale,
      screens: captured,
    };
    await writeFile(
      resolve(options.outDir, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    console.log(`\n${captured.length} screen(s) captured to ${options.outDir}`);
  } finally {
    await Promise.allSettled(processes.map((proc) => proc.stop()));
  }
}

async function capture(
  browser: Playwright.Browser,
  baseUrl: string,
  screen: Screen,
  options: Options,
): Promise<string> {
  const context = await browser.newContext({
    viewport: options.viewport,
    deviceScaleFactor: options.scale,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
  });

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    if (screen.setup) await screen.setup(page);

    await page.goto(`${baseUrl}${screen.path ?? '/'}`, { waitUntil: 'networkidle' });
    if (screen.settle) await page.waitForSelector(screen.settle, { timeout: 20_000 });
    // Settle first, then act: the ship has to exist before it can be flown.
    if (screen.settleMs) await sleep(screen.settleMs);
    if (screen.act) {
      await page.focus('body');
      await screen.act(page);
    }

    const file = `${screen.name}.png`;
    await page.screenshot({ path: resolve(options.outDir, file) });

    if (consoleErrors.length > 0) {
      // Not fatal to the capture, but the spec forbids raw error text and
      // unhandled failures, so they must be visible in the run output.
      console.warn(`  ! ${screen.name} logged ${consoleErrors.length} console error(s):`);
      for (const error of consoleErrors.slice(0, 5)) console.warn(`    ${error}`);
    }

    return file;
  } finally {
    await context.close();
  }
}

/** Playwright is optional: a clear message beats a module-not-found stack. */
async function importPlaywright(): Promise<typeof Playwright | undefined> {
  try {
    return await import('playwright');
  } catch {
    console.error(
      [
        'pnpm shots needs Playwright and a Chromium build.',
        '',
        'Install them once:',
        '  pnpm --filter @marque/shots exec playwright install chromium',
        '',
        'Or point the harness at an existing Chromium:',
        '  MARQUE_CHROMIUM=/path/to/chrome pnpm shots',
      ].join('\n'),
    );
    process.exitCode = 1;
    return undefined;
  }
}

await main();
