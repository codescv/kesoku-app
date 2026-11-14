import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Guard so external C/JS formatters never split minified regex literals: after the build has
// been written, prepend a `clang-format off` marker to every .js / .mjs file in the output
// directory (bundled chunks and copied public assets alike). Runs on disk in `closeBundle` so it
// also sees code that core build plugins inject at the very end of `generateBundle`.
const FORMAT_GUARD = '/* clang-format off */\n';
function formatterGuard(): Plugin {
  let outDir = 'dist';
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.m?js$/.test(e.name) ? [full] : [];
    });
  return {
    name: 'kesoku-formatter-guard',
    apply: 'build',
    enforce: 'post',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      for (const file of walk(outDir)) {
        const src = readFileSync(file, 'utf8');
        if (!src.startsWith(FORMAT_GUARD)) writeFileSync(file, FORMAT_GUARD + src);
      }
    },
  };
}

// Relay dev target for `pnpm dev` (proxy /ws, /auth, /pair, /local-media to a local relay).
const RELAY = process.env.KESOKU_RELAY_DEV ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), formatterGuard()],
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
