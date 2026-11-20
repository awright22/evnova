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
import { runSeed } from '@marque/harness/seed';

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

    // A throwaway database, so a capture never depends on what an earlier
    // run left behind. Accounts opened here are gone when the server exits.
    const scratchDb = resolve(options.outDir, 'capture.db');
    await rm(scratchDb, { force: true });
    await rm(`${scratchDb}-wal`, { force: true });
    await rm(`${scratchDb}-shm`, { force: true });
    const worldEnv = {
      PORT: String(options.serverPort),
      NODE_ENV: 'development',
      DATABASE_URL: scratchDb,
      // Enough to build with. Several screens are of the Yard and the
      // Moorings, and a captain on a new captain's float can only ever be
      // photographed looking at a bill they cannot pay.
      STARTING_MARKS: '4000000',
      // One screen is the admin page, which is shut unless the server was
      // told whose it is. Named here rather than per screen: the server is
      // started once for the whole run, so every screen shares its
      // configuration, and a callsign nobody is seeded as opens nothing.
      ADMIN_CALLSIGNS: 'Harbourmaster',
    };

    // Every screen that names a captain must name a different one. A
    // callsign is unique on the Register, so the second screen to ask for
    // one is refused at sign-up and lands on the Register instead of the
    // sky — which reads as a selector timeout three screens later and says
    // nothing about why.
    const claimed = new Map<string, string>();
    for (const screen of screens) {
      const names = [
        ...(screen.seed ? [screen.seed.callsign] : []),
        ...(screen.companions ?? []).map((companion) => companion.seed.callsign),
        ...(() => {
          const asked = new URLSearchParams((screen.path ?? '').split('?')[1] ?? '').get(
            'callsign',
          );
          return asked === null ? [] : [asked];
        })(),
      ];
      for (const name of names) {
        const taken = claimed.get(name.toLowerCase());
        if (taken !== undefined && taken !== screen.name) {
          throw new Error(
            `"${name}" is named by both ${taken} and ${screen.name}; a callsign is unique`,
          );
        }
        claimed.set(name.toLowerCase(), screen.name);
      }
    }

    // 2. Captains with a history, for the screens that only exist once
    //    something has already happened — a chain's last choice is not
    //    posted to anybody who has not run six beats of it. Written before
    //    the server opens the file, with the environment the server will
    //    read, so the seeded world is the one the game would have made.
    const specs = screens.flatMap((screen) => [
      // Companions first: a convoy's invitation names a captain, and the
      // captain has to exist before anybody can name them.
      ...(screen.companions ?? []).map((companion) => companion.seed),
      ...(screen.seed ? [screen.seed] : []),
    ]);
    const tokens = new Map<string, string>();
    if (specs.length > 0) {
      console.log(`Seeding ${specs.length} captain(s)...`);
      for (const [callsign, token] of Object.entries(await runSeed(specs, worldEnv))) {
        tokens.set(callsign, token);
      }
    }

    // 3. Game server, on its own port so a running dev server is untouched,
    // and on a throwaway database so a capture never depends on what an
    // earlier run left behind. Accounts opened here are gone when it exits.
    console.log('Starting game server...');
    const server = start('game server', 'pnpm', ['exec', 'tsx', 'src/main.ts'], {
      cwd: resolve(REPO_ROOT, 'packages/server'),
      env: worldEnv,
    });
    processes.push(server);
    await waitForHttp(server, `http://127.0.0.1:${options.serverPort}/matchmake/`);

    // 4. Static preview of the built client.
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

    // 5. Capture.
    const executablePath = findChromium();
    const browser = await playwright.chromium.launch({
      args: [...LAUNCH_ARGS],
      ...(executablePath ? { executablePath } : {}),
    });

    const captured: { name: string; file: string; description: string }[] = [];

    /** Screens the run could not take, reported at the end. */

    const missed: { name: string; why: string }[] = [];

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
        const token = screen.seed ? tokens.get(screen.seed.callsign) : undefined;
        if (screen.seed && token === undefined) {
          throw new Error(`no device token was seeded for "${screen.seed.callsign}"`);
        }

        // Bring any companions online first and leave them there: a screen
        // about two captains cannot be photographed from one page.
        const held: Playwright.BrowserContext[] = [];
        for (const companion of screen.companions ?? []) {
          const theirToken = tokens.get(companion.seed.callsign);
          if (theirToken === undefined) {
            throw new Error(`no device token was seeded for "${companion.seed.callsign}"`);
          }
          // Only the ones with something to do need a browser at all.
          if (!companion.act) continue;
          held.push(
            await openCompanion(browser, baseUrl, companion.seed.callsign, theirToken, companion.act, options),
          );
        }

        // A screen that cannot be captured is reported and the run goes on.
        // A capture run is twenty minutes of flying; losing the other
        // twenty-nine screens because one of them did not find anybody to
        // shoot at is not a trade worth making.
        let file: string | undefined;
        try {
          file = await capture(browser, baseUrl, screen, options, token);
        } catch (error) {
          missed.push({
            name: screen.name,
            why: error instanceof Error ? error.message.split('\n')[0]! : String(error),
          });
          console.warn(`  ! ${screen.name} was not captured: ${missed.at(-1)?.why ?? ''}`);
        } finally {
          for (const context of held) await context.close();
        }
        if (file === undefined) continue;
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
    if (missed.length > 0) {
      console.warn(`${missed.length} not captured:`);
      for (const miss of missed) console.warn(`  ${miss.name}: ${miss.why}`);
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled(processes.map((proc) => proc.stop()));
  }
}

/**
 * Another captain, online and left there.
 *
 * Returns its context so the caller can close it once the capture is taken:
 * a companion held open past its screen would still be standing at the berth
 * when the next one is photographed.
 */
async function openCompanion(
  browser: Playwright.Browser,
  baseUrl: string,
  callsign: string,
  deviceToken: string,
  act: (page: Playwright.Page) => Promise<void>,
  options: Options,
): Promise<Playwright.BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.addInitScript(
    ([name, token]: [string, string]) => {
      try {
        localStorage.setItem('marque.callsign', name);
        localStorage.setItem('marque.deviceToken', token);
      } catch {
        // Storage disabled: this captain stays on the Register, and the
        // screen that wanted them says so rather than lying about it.
      }
    },
    [callsign, deviceToken] as [string, string],
  );

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await act(page);
  return context;
}

async function capture(
  browser: Playwright.Browser,
  baseUrl: string,
  screen: Screen,
  options: Options,
  /** A seeded captain's device token, for a screen that joins as one. */
  deviceToken?: string,
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
    // A seeded captain's credentials, put where the client keeps its own, so
    // the page joins as them rather than opening a new account. Set before
    // the first navigation, because the client reads storage as it boots.
    if (deviceToken !== undefined && screen.seed) {
      const callsign = screen.seed.callsign;
      await page.addInitScript(
        ([name, token]: [string, string]) => {
          try {
            localStorage.setItem('marque.callsign', name);
            localStorage.setItem('marque.deviceToken', token);
          } catch {
            // Storage disabled: the capture lands on the Register and says so.
          }
        },
        [callsign, deviceToken] as [string, string],
      );
    }

    if (screen.setup) await screen.setup(page);

    await page.goto(`${baseUrl}${screen.path ?? '/'}`, { waitUntil: 'networkidle' });
    if (screen.settle) await page.waitForSelector(screen.settle, { timeout: 20_000 });
    // Settle first, then act: the ship has to exist before it can be flown.
    if (screen.settleMs) await sleep(screen.settleMs);
    if (screen.act) {
      await page.focus('body');
      await screen.act(page);
    }

    let file = `${screen.name}.png`;
    if (screen.frames) {
      // A run of frames, for motion. The act above has set it going; this
      // follows it through.
      for (let i = 0; i < screen.frames.count; i++) {
        const frame = `${screen.name}-${String(i + 1).padStart(2, '0')}.png`;
        await page.screenshot({ path: resolve(options.outDir, frame) });
        if (i === 0) file = frame;
        if (i + 1 < screen.frames.count) await sleep(screen.frames.everyMs);
      }
    } else {
      await page.screenshot({ path: resolve(options.outDir, file) });
    }

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
