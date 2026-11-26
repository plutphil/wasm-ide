import { defineConfig } from 'vite';

// SharedArrayBuffer (used for interactive stdin) needs cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { headers: isolation },
  preview: { headers: isolation },
  // keep import.meta.url intact so the toolchain can find its .wasm files
  optimizeDeps: { exclude: ['@yowasp/clang'], esbuildOptions: { target: 'esnext' } },
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 100000 },
});
