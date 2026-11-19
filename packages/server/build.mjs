/**
 * Production server bundle.
 *
 * esbuild resolves the workspace `@marque/shared` source and bundles it in,
 * so the output is a single file that runs under plain Node with only runtime
 * dependencies installed.
 */

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm(new URL('./dist/', import.meta.url), { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Native and optional dependencies stay external: they are installed
  // alongside the bundle in the container image.
  packages: 'external',
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`server bundle: ${(bytes / 1024).toFixed(0)} kB`);
