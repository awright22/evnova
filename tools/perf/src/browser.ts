/**
 * Browser frame-time capture.
 *
 * Measures the real flight view: builds the client, starts a server and bot
 * traffic, flies the ship, and records the interval between presented frames.
 * Reports percentiles rather than an average, because the spec treats a spike
 * over 33 ms as a bug and an average hides exactly those.
 */

// Type-only: erased at build time, so Playwright stays an optional runtime
// dependency the capture imports dynamically and degrades without.
import type * as Playwright from 'playwright';
import { type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signalGroup, spawnGroup } from '@marque/harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

export interface FrameCapture {
  readonly frames: number;
  readonly seconds: number;
  readonly fps: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly over33Ms: number;
  readonly renderer: string;
  readonly softwareRendered: boolean;
  readonly ships: number;
  readonly viewport: { width: number; height: number };
  /** Rounds in the air and particles alive, at the end of the measurement. */
  readonly rounds: number;
  readonly particles: number;
  /** What the title screen cost to reach, in bytes over the wire. */
  readonly load: LoadMeasure | undefined;
}

/**
 * What it takes to get to the title screen.
 *
 * Spec section 3 budgets under 5 MB transferred before the title screen is
 * interactive, with everything else streaming in behind it. Measured from a
 * cold context so nothing is served from a cache the first visitor will not
 * have.
 */
export interface LoadMeasure {
  readonly bytes: number;
  readonly requests: number;
  readonly msToInteractive: number;
  /** The largest few, so a regression says what grew. */
  readonly biggest: readonly { url: string; bytes: number }[];
}

export interface BrowserPerfOptions {
  readonly serverPort: number;
  readonly previewPort: number;
  readonly bots: number;
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
}

export async function captureFrames(
  options: BrowserPerfOptions,
): Promise<FrameCapture | undefined> {
  let playwright: typeof Playwright;
  try {
    playwright = await import('playwright');
  } catch {
    console.error('Browser capture needs Playwright. Skipping that section.');
    return undefined;
  }

  const procs: ChildProcess[] = [];
  const kill = async (): Promise<void> => {
    for (const proc of procs) {
      if (proc.exitCode === null) {
        signalGroup(proc, 'SIGTERM');
        const timer = setTimeout(() => signalGroup(proc, 'SIGKILL'), 4000);
        try {
          await once(proc, 'exit');
        } finally {
          clearTimeout(timer);
        }
      }
    }
  };

  try {
    await run('pnpm', ['--filter', '@marque/client', 'run', 'build'], REPO_ROOT, {
      MARQUE_SERVER_URL: `ws://127.0.0.1:${options.serverPort}`,
    });

    procs.push(
      spawnQuiet('pnpm', ['exec', 'tsx', 'src/main.ts'], resolve(REPO_ROOT, 'packages/server'), {
        PORT: String(options.serverPort),
      }),
    );
    await waitFor(`http://127.0.0.1:${options.serverPort}/health`);

    procs.push(
      spawnQuiet(
        'pnpm',
        ['exec', 'vite', 'preview', '--port', String(options.previewPort), '--strictPort'],
        resolve(REPO_ROOT, 'packages/client'),
      ),
    );
    const baseUrl = `http://127.0.0.1:${options.previewPort}`;
    await waitFor(baseUrl);

    if (options.bots > 0) {
      procs.push(
        spawnQuiet(
          'pnpm',
          [
            'exec', 'tsx', 'tools/bot/src/main.ts',
            '--bots', String(options.bots),
            '--seconds', String(options.seconds + 120),
            // Fighters, not wanderers: the spec's reference scene is 30
            // ships, 300 projectiles and 3,000 particles, and a sky full of
            // hulls politely not shooting is not that scene.
            '--brain', 'fighter',
            '--endpoint', `ws://127.0.0.1:${options.serverPort}`,
            '--quiet',
          ],
          REPO_ROOT,
        ),
      );
      await sleep(6000);
    }

    const browser = await playwright.chromium.launch({
      executablePath: process.env.MARQUE_CHROMIUM ?? '/opt/pw-browsers/chromium',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });

    try {
      // The load budget first, in a context of its own: it is about what a
      // first visitor downloads, and a context that has already been to the
      // title screen is not one.
      const load = await measureLoad(browser, baseUrl, options);

      // Device scale factor 1: the budget is 1080p, not a retina multiple of it.
      const page = await browser.newPage({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: 1,
      });

      // `harness=1` goes straight into the game rather than the title
      // screen, and `callsign` opens an account on arrival: without one the
      // client has nobody to be and lands on the Register, which has no
      // flight view to measure and no `.hud` to wait for. `debug` publishes
      // the scene counts this reads back.
      await page.goto(`${baseUrl}/?harness=1&debug=1&callsign=Rate%20Card`, {
        waitUntil: 'networkidle',
      });
      await page.waitForSelector('.hud', { timeout: 30_000 });
      // Let textures generate and the link settle before measuring.
      await sleep(3000);

      // These probes are passed as source strings, not functions. The tool runs
      // through esbuild, which rewrites function bindings to reference a `__name`
      // helper that does not exist inside the page.
      const renderer = String(
        await page.evaluate(`(function () {
          var c = document.createElement('canvas');
          var gl = c.getContext('webgl2') || c.getContext('webgl');
          if (!gl) return 'none';
          var dbg = gl.getExtension('WEBGL_debug_renderer_info');
          return String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        })()`),
      );

      // Fly for the whole measurement, and fire the whole time: the scene
      // the spec budgets has rounds and particles in it, and a capture of
      // an empty sky measures the backdrop.
      await page.focus('body');
      await page.keyboard.press('Tab');
      await page.keyboard.down('ArrowUp');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('Space');

      // The scene's peaks are sampled inside the loop, not read once at the
      // end: a single instant after twenty seconds says what happened to be
      // in the sky then, and the budget is about what the renderer coped
      // with while the frames were being drawn.
      const result = await page.evaluate<{
        intervals: number[];
        rounds: number;
        fx: number;
      }>(`(function () {
        var ms = ${options.seconds * 1000};
        return new Promise(function (done) {
          var intervals = [];
          var rounds = 0;
          var fx = 0;
          var last = performance.now();
          var start = last;
          function tick() {
            var now = performance.now();
            intervals.push(now - last);
            last = now;
            var d = window.marqueDebug;
            if (d) {
              var c = d.combat();
              if (c.rounds > rounds) rounds = c.rounds;
              if (c.fx > fx) fx = c.fx;
            }
            if (now - start < ms) requestAnimationFrame(tick);
            else done({ intervals: intervals, rounds: rounds, fx: fx });
          }
          requestAnimationFrame(tick);
        });
      })()`);

      await page.keyboard.up('ArrowUp');
      await page.keyboard.up('ArrowRight');
      await page.keyboard.up('Space');

      const ships = Number(
        await page.evaluate(`(function () {
          var v = document.querySelectorAll('.hud__reading-value');
          return v.length > 1 ? Number(v[1].textContent || '0') : 0;
        })()`),
      );

      // Drop the first few frames: they include texture upload, not steady state.
      const intervals = result.intervals.slice(5);
      const sorted = [...intervals].sort((a, b) => a - b);
      const at = (f: number): number =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(f * sorted.length) - 1))] ?? 0;
      const total = intervals.reduce((sum, v) => sum + v, 0);

      return {
        frames: intervals.length,
        seconds: total / 1000,
        fps: intervals.length / (total / 1000),
        meanMs: total / intervals.length,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        maxMs: sorted.at(-1) ?? 0,
        over33Ms: intervals.filter((v) => v > 33).length,
        renderer,
        softwareRendered: /swiftshader|llvmpipe|software/i.test(renderer),
        ships: ships + 1,
        viewport: { width: options.width, height: options.height },
        rounds: result.rounds,
        particles: result.fx,
        load,
      };
    } finally {
      await browser.close();
    }
  } finally {
    await kill();
  }
}

/**
 * What reaching the title screen costs, over the wire.
 *
 * Counted from the response bodies rather than from the build output: a
 * build lists everything it produced, and what matters is what a browser
 * actually asks for before the title screen is there to press.
 */
async function measureLoad(
  browser: Playwright.Browser,
  baseUrl: string,
  options: BrowserPerfOptions,
): Promise<LoadMeasure | undefined> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    const sizes = new Map<string, number>();
    page.on('response', (response) => {
      void response
        .body()
        .then((body) => sizes.set(response.url(), body.length))
        .catch(() => undefined);
    });

    const startedAt = Date.now();
    await page.goto(baseUrl, { waitUntil: 'load' });
    // Interactive means the doors are on screen and can be pressed.
    await page.waitForSelector('.title__doors button', { timeout: 30_000 });
    const msToInteractive = Date.now() - startedAt;
    // Responses resolve their bodies a tick behind the event.
    await sleep(500);

    const entries = [...sizes.entries()].map(([url, bytes]) => ({ url, bytes }));
    return {
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      requests: entries.length,
      msToInteractive,
      biggest: entries.sort((a, b) => b.bytes - a.bytes).slice(0, 8),
    };
  } catch {
    // A load that cannot be measured is reported as unmeasured rather than
    // failing the whole capture, which is mostly about frame times.
    return undefined;
  } finally {
    await context.close();
  }
}

function spawnQuiet(
  cmd: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): ChildProcess {
  return spawnGroup(cmd, [...args], {
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
  const child = spawnGroup(cmd, [...args], {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
