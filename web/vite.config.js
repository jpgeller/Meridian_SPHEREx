import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  build: {
    target: 'es2022', // main.js uses top-level await
    chunkSizeWarningLimit: 2600, // Aladin Lite (with its wasm core) is ~2.4 MB on its own
    rollupOptions: {
      output: {
        // Aladin in its own chunk: it is ~95% of the bundle and never changes, so a redeploy
        // of our code leaves it cached in the judges' browsers instead of re-downloading 2.4 MB.
        // Vite 8 (rolldown) requires the function form here; the object form is rejected.
        manualChunks: (id) => (id.includes('node_modules/aladin-lite') ? 'aladin' : undefined),
      },
    },
  },
});
