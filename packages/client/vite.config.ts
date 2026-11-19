import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Client build.
 *
 * The server URL and the deploy base path are build configuration, because the
 * client ships to GitHub Pages as static files while the server runs on its own
 * host. Both have development defaults so a clean clone runs with no setup.
 */
export default defineConfig(({ mode }) => ({
  base: process.env.MARQUE_BASE ?? '/',
  define: {
    __SERVER_URL__: JSON.stringify(
      process.env.MARQUE_SERVER_URL ?? 'ws://127.0.0.1:2567',
    ),
    __BUILD_VERSION__: JSON.stringify(process.env.MARQUE_VERSION ?? `dev-${mode}`),
  },
  plugins: [react()],
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2023',
    sourcemap: true,
    // The spec budgets under 5 MB transferred before the title screen is
    // interactive. Warn well before that so regressions are visible.
    chunkSizeWarningLimit: 900,
  },
}));
