// Bundle the relay into a single ESM file. Heavy SDKs and `ws` stay external (installed via `pnpm deploy --prod`).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  external: ['firebase-admin', 'firebase-admin/*', '@google-cloud/storage', 'ws'],
  banner: {
    js: [
      "import { createRequire as __kesokuCreateRequire } from 'node:module';",
      'const require = __kesokuCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
