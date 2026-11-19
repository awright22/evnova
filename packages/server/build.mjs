/**
 * Production server bundle.
 *
 * esbuild resolves the workspace `@marque/shared` source and bundles it in,
 * so the output is a single file that runs under plain Node with only runtime
 * dependencies installed.
 */

import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';

/**
 * Third-party runtime dependencies, which the image installs beside the
 * bundle. Read from the manifest rather than listed here, so adding one
 * cannot leave the bundle quietly trying to inline a native module.
 *
 * Workspace packages are deliberately NOT external: they are TypeScript
 * source with no build of their own, so Node could not load them from
 * node_modules. They are bundled in, which is the whole point of this step.
 */
const manifest = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);
const external = Object.keys(manifest.dependencies ?? {}).filter(
  (name) => !name.startsWith('@marque/'),
);

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
  external,
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
console.log(`server bundle: ${(bytes / 1024).toFixed(0)} kB`);
