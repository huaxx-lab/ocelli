import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The Lab builds two artifacts from one source tree:
 *
 *   `vite build`          -> dist/          standalone page (dev + review)
 *   `node tools/build-plugin.mjs`
 *                         -> dist/plugin/  a DSH Cordis client plugin bundle
 *
 * Keeping them in one config means the avatar core can never drift between
 * the standalone page and the in-GUI page.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        // The standalone Lab page.
        'avatar-lab': resolve(__dirname, 'avatar-lab.html'),
      },
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
