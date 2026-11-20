/**
 * Performance capture.
 *
 * The spec's reference scene is 30 ships, 300 projectiles and 3,000 particles
 * at 1080p, holding 60 fps with no frame-time spike over 33 ms. Rendering
 * arrives in M1, so this reports the half that exists now: the cost of the
 * shared simulation step at the scene's entity count, which is the floor every
 * frame has to fit inside.
 *
 *   pnpm perf
 *   pnpm perf -- --ships 30 --seconds 20
 *
 * Reports percentiles, not an average: an average hides exactly the spikes the
 * spec calls bugs.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { captureFrames as browserFrames, type FrameCapture, type LoadMeasure } from './browser.ts';
import {
  Rng,
  SPIKE_PROFILE,
  TICK_RATE,
  createFlightBody,
  seekPoint,
  stepFlight,
  stepTiming,
  type FlightBody,
  type FlightCommand,
} from '@marque/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

interface Options {
  ships: number;
  seconds: number;
  outDir: string;
  skipBrowser: boolean;
  bots: number;
  width: number;
  height: number;
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
      ships: { type: 'string', default: '30' },
      seconds: { type: 'string', default: '20' },
      out: { type: 'string', default: 'artifacts/perf' },
      'skip-browser': { type: 'boolean', default: false },
      bots: { type: 'string', default: '5' },
      width: { type: 'string', default: '1920' },
      height: { type: 'string', default: '1080' },
    },
  });
  return {
    ships: Number(values.ships),
    seconds: Number(values.seconds),
    outDir: resolve(REPO_ROOT, values.out),
    skipBrowser: values['skip-browser'] === true,
    bots: Number(values.bots),
    width: Number(values.width),
    height: Number(values.height),
  };
}

interface Percentiles {
  readonly samples: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (f: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(f * sorted.length) - 1))] ?? 0;
  return {
    samples: sorted.length,
    meanMs: sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: sorted.at(-1) ?? 0,
  };
}

async function main(): Promise<void> {
  const options = parseOptions();
  await mkdir(options.outDir, { recursive: true });

  const timing = stepTiming();
  const rng = new Rng('perf-scene');

  // A fleet spread across a system, each ship flying to its own point, so the
  // step takes its realistic branch mix rather than a uniform best case.
  const bodies: FlightBody[] = [];
  const targets: { x: number; y: number }[] = [];
  for (let i = 0; i < options.ships; i++) {
    const body = createFlightBody(rng.range(-4000, 4000), rng.range(-4000, 4000), rng.range(-Math.PI, Math.PI));
    body.vx = rng.range(-200, 200);
    body.vy = rng.range(-200, 200);
    bodies.push(body);
    targets.push({ x: rng.range(-4000, 4000), y: rng.range(-4000, 4000) });
  }

  const totalSteps = Math.round(options.seconds * TICK_RATE);
  const stepTimes: number[] = [];

  // Warm up so the JIT has compiled the hot path before anything is recorded.
  for (let i = 0; i < 300; i++) runOneStep(bodies, targets, timing);

  for (let step = 0; step < totalSteps; step++) {
    const startedAt = performance.now();
    runOneStep(bodies, targets, timing);
    stepTimes.push(performance.now() - startedAt);
  }

  const stats = percentiles(stepTimes);
  const perShipUs = (stats.meanMs * 1000) / options.ships;
  const budgetMs = 1000 / 60;
  const headroom = (stats.p99Ms / budgetMs) * 100;

  // The client half: real frames from the real flight view.
  let frames: FrameCapture | undefined;
  if (!options.skipBrowser) {
    console.log('Capturing browser frame times (builds the client and flies it)...');
    try {
      frames = await browserFrames({
      serverPort: 2582,
      previewPort: 4182,
      bots: options.bots,
      seconds: Math.min(20, options.seconds),
      width: options.width,
      height: options.height,
      });
    } catch (error) {
      // The simulation half is measured and worth reporting even when the
      // browser half cannot run: a tool that throws away twenty seconds of
      // numbers because a selector timed out is a tool nobody runs twice.
      console.error(
        `Browser capture failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
      process.exitCode = 1;
    }
  }

  const report = `# Performance capture

Generated by \`pnpm perf\`. This file is overwritten each run.

## Scene

| Setting | Value |
|---|---|
| Ships stepped | ${options.ships} |
| Duration | ${options.seconds}s of simulated time |
| Fixed steps | ${totalSteps} at ${TICK_RATE} Hz |
| Sub-steps per step | ${timing.subSteps} (${(1 / timing.subDt).toFixed(0)} Hz integration) |

## Simulation step cost

One fixed step advancing every ship, including the steering each NPC pilot runs.

| Measure | Value |
|---|---|
| mean | ${stats.meanMs.toFixed(4)} ms |
| p50 | ${stats.p50Ms.toFixed(4)} ms |
| p95 | ${stats.p95Ms.toFixed(4)} ms |
| p99 | ${stats.p99Ms.toFixed(4)} ms |
| max | ${stats.maxMs.toFixed(4)} ms |
| per ship | ${perShipUs.toFixed(2)} µs |
| p99 as a share of a 60 fps frame | ${headroom.toFixed(2)}% |

${frames ? renderFrameSection(frames) : '## Client frame times\n\nNot captured: Playwright was unavailable.\n'}
## Every budget in section 3

| Budget | Where it is measured | This run |
|---|---|---|
| 60 fps at 1080p, 30 ships / 300 rounds / 3,000 particles | here | ${
    frames
      ? frames.softwareRendered
        ? 'software rasterisation; see above'
        : `${frames.fps.toFixed(1)} fps`
      : 'not captured'
  } |
| No frame over 33 ms | here | ${frames ? `${frames.over33Ms} over` : 'not captured'} |
| Local ship responds on the next frame | \`pnpm verify:control\` | run separately |
| No rubber-banding at 150 ms and 2% loss | \`pnpm sim\` | run separately |
| Server tick under 4 ms, 12 players and 40 NPCs | \`pnpm sim\` | run separately |
| Under 5 MB before the title screen | here | ${
    frames?.load ? `${(frames.load.bytes / 1_000_000).toFixed(2)} MB` : 'not captured'
  } |
| Every feedback row has a sound | \`pnpm test\` | run separately |
| What a scripted session sounds | \`pnpm audio\` | run separately |

## Not yet measured

| Measure | Arrives with |
|---|---|
| Verification on real integrated graphics | needs a machine with a GPU |
`;

  const path = resolve(options.outDir, 'report.md');
  await writeFile(path, report);

  console.log(`Simulation step, ${options.ships} ships:`);
  console.log(`  mean ${stats.meanMs.toFixed(4)}ms  p99 ${stats.p99Ms.toFixed(4)}ms  max ${stats.maxMs.toFixed(4)}ms`);
  console.log(`  ${perShipUs.toFixed(2)}µs per ship, p99 is ${headroom.toFixed(2)}% of a 60fps frame`);
  console.log(`Report written to ${path}`);

  if (stats.p99Ms > budgetMs) {
    console.error('FAIL: the simulation step alone exceeds a 60 fps frame budget.');
    process.exitCode = 1;
  }

  if (frames) {
    console.log(
      `\nBrowser frames, ${frames.ships} ship(s) at ${frames.viewport.width}x${frames.viewport.height}:`,
    );
    console.log(
      `  ${frames.fps.toFixed(1)} fps  p50 ${frames.p50Ms.toFixed(1)}ms  p95 ${frames.p95Ms.toFixed(1)}ms  p99 ${frames.p99Ms.toFixed(1)}ms`,
    );
    console.log(`  renderer: ${frames.renderer}`);
    if (frames.softwareRendered) {
      console.log(
        '  NOTE: software rasterisation, no GPU. These numbers are a floor, not the budget.',
      );
    }
  }
}

function renderFrameSection(f: FrameCapture): string {
  const verdict = f.softwareRendered
    ? `**Software rasterisation — no GPU is present on this machine.** These numbers
are a worst case and cannot be compared against the spec's 60 fps budget, which
assumes integrated graphics. They are still useful as a regression signal: a
change that makes this number worse makes the real one worse too.`
    : f.fps >= 58
      ? 'Holds 60 fps.'
      : `**Below 60 fps.** The budget is not met on this machine.`;

  return `## Client frame times

The real flight view, flying, with bot traffic in the system.

| Setting | Value |
|---|---|
| Viewport | ${f.viewport.width} x ${f.viewport.height} |
| Ships on screen | ${f.ships} |
| Rounds in the air, at most | ${f.rounds} |
| Particles alive, at most | ${f.particles} |
| Frames measured | ${f.frames} |
| Renderer | \`${f.renderer}\` |

The spec's reference scene is 30 ships, 300 projectiles and 3,000 particles.
${sceneVerdict(f)}

| Measure | Value |
|---|---|
| fps | ${f.fps.toFixed(1)} |
| mean | ${f.meanMs.toFixed(2)} ms |
| p50 | ${f.p50Ms.toFixed(2)} ms |
| p95 | ${f.p95Ms.toFixed(2)} ms |
| p99 | ${f.p99Ms.toFixed(2)} ms |
| max | ${f.maxMs.toFixed(2)} ms |
| frames over 33 ms | ${f.over33Ms} |

${verdict}

${f.load ? renderLoadSection(f.load) : ''}`;
}

/** How close the measured scene came to the one the spec budgets. */
function sceneVerdict(f: FrameCapture): string {
  const short: string[] = [];
  if (f.ships < 30) short.push(`${f.ships} ships of 30`);
  if (f.rounds < 300) short.push(`${f.rounds} rounds of 300`);
  if (f.particles < 3000) short.push(`${f.particles} particles of 3,000`);
  if (short.length === 0) return 'This capture reached it.';
  return (
    `This capture reached ${short.join(', ')}: the sky holds what the bots and `
    + 'the room actually put in it. Raise `--bots` to fill it out.'
  );
}

/** What the title screen cost, against the spec's 5 MB. */
function renderLoadSection(load: LoadMeasure): string {
  const mb = load.bytes / 1_000_000;
  const verdict =
    mb <= 5
      ? `**${mb.toFixed(2)} MB**, inside the 5 MB budget.`
      : `**${mb.toFixed(2)} MB — over the 5 MB budget.**`;

  const rows = load.biggest
    .map((entry) => {
      const name = entry.url.split('/').pop() ?? entry.url;
      return `| \`${name}\` | ${(entry.bytes / 1000).toFixed(1)} kB |`;
    })
    .join('\n');

  return `## Load

Spec section 3 budgets under 5 MB transferred before the title screen is
interactive. Measured from a cold browser context, counting every response
body the page asked for before its doors could be pressed.

| Measure | Value |
|---|---|
| Transferred | ${(load.bytes / 1000).toFixed(0)} kB |
| Requests | ${load.requests} |
| To interactive | ${load.msToInteractive} ms |

${verdict}

| Largest | Size |
|---|---:|
${rows}

`;
}

function runOneStep(
  bodies: readonly FlightBody[],
  targets: readonly { x: number; y: number }[],
  timing: ReturnType<typeof stepTiming>,
): void {
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]!;
    const target = targets[i]!;
    const intent: FlightCommand = seekPoint(body, target.x, target.y, SPIKE_PROFILE);
    stepFlight(body, intent, SPIKE_PROFILE, timing);
  }
}

await main();
