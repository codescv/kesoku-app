#!/usr/bin/env node
// Zero native addons guarantee: scan installed packages for compiled `.node` binaries, `binding.gyp`,
// or node-gyp build hooks. Dev-only prebuilt toolchain executables (esbuild / rollup platform
// packages) ship as plain executables, not Node addons, and are therefore not flagged.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const store = join(root, 'node_modules', '.pnpm');
const offenders = [];
let scanned = 0;

function walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (e.name === '.bin') continue;
      walk(p, depth + 1);
    } else if (e.isFile()) {
      scanned++;
      if (e.name.endsWith('.node') || e.name === 'binding.gyp') offenders.push(p);
      else if (e.name === 'package.json' && depth <= 4) {
        try {
          const pkg = JSON.parse(readFileSync(p, 'utf8'));
          const scripts = pkg.scripts ?? {};
          const hook = [scripts.install, scripts.postinstall, scripts.preinstall].filter(Boolean).join(' ');
          if (/node-gyp|prebuild-install|node-pre-gyp|cmake-js/.test(hook)) offenders.push(`${p} (${hook})`);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

if (!existsSync(store)) {
  console.error('node_modules/.pnpm not found — run pnpm install first');
  process.exit(1);
}
walk(store);
const ws = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
if (!/onlyBuiltDependencies:\s*\[\]/.test(ws)) offenders.push('pnpm-workspace.yaml must keep onlyBuiltDependencies: []');
if (offenders.length) {
  console.error(`✗ native addon artifacts found (${offenders.length}):\n` + offenders.map((o) => '  - ' + o).join('\n'));
  process.exit(1);
}
console.log(`✓ zero native addons (${scanned} files scanned)`);
void statSync;
