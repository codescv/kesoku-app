import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relay dev target for `pnpm dev` (proxy /ws, /auth, /pair, /local-media to a local relay).
const RELAY = process.env.KESOKU_RELAY_DEV ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/ws': { target: RELAY.replace(/^http/, 'ws'), ws: true },
      '/auth': RELAY,
      '/pair': RELAY,
      '/healthz': RELAY,
      '/local-media': RELAY,
    },
  },
  preview: { host: '127.0.0.1' },
});
