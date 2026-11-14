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
  },
});
