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
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        proc.kill('SIGTERM');
        const timer = setTimeout(() => proc.kill('SIGKILL'), 4000);
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
            '--seconds', String(options.seconds + 60),
            '--brain', 'wander',
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
      // Device scale factor 1: the budget is 1080p, not a retina multiple of it.
      const page = await browser.newPage({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: 1,
      });

      await page.goto(baseUrl, { waitUntil: 'networkidle' });
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

      // Fly for the whole measurement, so the capture covers the scene moving
      // rather than a static one.
      await page.focus('body');
      await page.keyboard.down('ArrowUp');
      await page.keyboard.down('ArrowRight');

      const result: { intervals: number[] } = await page.evaluate(`(function () {
        var ms = ${options.seconds * 1000};
        return new Promise(function (done) {
          var intervals = [];
          var last = performance.now();
          var start = last;
          function tick() {
            var now = performance.now();
            intervals.push(now - last);
            last = now;
            if (now - start < ms) requestAnimationFrame(tick);
            else done({ intervals: intervals });
          }
          requestAnimationFrame(tick);
        });
      })()`);

      await page.keyboard.up('ArrowUp');
      await page.keyboard.up('ArrowRight');

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
      };
    } finally {
      await browser.close();
    }
  } finally {
    await kill();
  }
}

function spawnQuiet(
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
